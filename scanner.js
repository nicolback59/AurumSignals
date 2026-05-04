'use strict';

const Database              = require('better-sqlite3');
const path                  = require('path');
const fs                    = require('fs');
const { computeSignal }     = require('./signal-engine');
const { getAdaptiveMinScore, getMarketRegime } = require('./learning');
const { runBacktest }       = require('./backtest-engine');
const {
  getParams, saveBacktestRun, saveBacktestDetails,
  proposeRevision, evaluateShadow, multiObjectiveScore,
} = require('./strategy-params');
const { runFullOptimizationCycle } = require('./strategy-optimizer');

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH        = process.env.DB_PATH           || path.join(__dirname, 'signals.db');
const NTFY_URL       = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC     = process.env.NTFY_TOPIC        || '';
const NTFY_TOKEN     = process.env.NTFY_TOKEN        || '';
// Twelvedata — requires TWELVEDATA_API_KEY (free tier: 800 req/day, 8 req/min)
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY  || '';
const SYMBOL         = process.env.SCANNER_SYMBOL     || 'NQ';     // NQ futures (same price as MNQ)
const SYMBOL_MGC     = process.env.SCANNER_SYMBOL_MGC || 'GC';     // Gold futures (same price as MGC)
const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL     || '60')  * 1000;
const COOLDOWN       = parseInt(process.env.SCANNER_COOLDOWN  || '1');
const RTH_ONLY       = process.env.SCANNER_RTH_ONLY === 'true';
const BASE_SCORE     = parseInt(process.env.SCANNER_MIN_SCORE || '12');
const DAILY_MIN_LIVE = parseInt(process.env.DAILY_MIN_LIVE    || '10');  // min live signals/day per instrument
const DAILY_MIN_BT   = parseInt(process.env.DAILY_MIN_BT      || '50');  // min backtest trades/run per instrument

// Backtest symbols (Twelvedata)
const BT_SYMBOLS = {
  MNQ: process.env.SCANNER_BT_MNQ || 'NQ',
  MGC: process.env.SCANNER_BT_MGC || 'GC',
};

// Backtest schedule
const BT_INTERVAL_H  = parseFloat(process.env.BACKTEST_INTERVAL_H  || '4');
const BT_BARS        = parseInt(process.env.BACKTEST_BARS           || '10000');
const OPT_INTERVAL_H = parseFloat(process.env.OPTIMIZER_INTERVAL_H || '12');
const BT_SLIPPAGE    = parseFloat(process.env.BT_SLIPPAGE           || '0.5');
const BT_TARGET_TRADES = parseInt(process.env.BT_TARGET_TRADES      || '350');

// ── Database ──────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

// ── Schema migration: adds forced column + fixes grade constraint ──────────────
{
  const cols = db.pragma('table_info(signals)').map(c => c.name);
  if (!cols.includes('forced')) {
    console.log('[migrate] Upgrading signals table…');
    try {
      db.exec(`DROP TABLE IF EXISTS _signals_bak`);
      db.exec(`ALTER TABLE signals RENAME TO _signals_bak`);
      db.exec(`CREATE TABLE signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL DEFAULT 'NQ1!', timeframe TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
        grade TEXT CHECK(grade IN ('A+','A','B')),
        setup TEXT, entry REAL, sl REAL, tp1 REAL, tp2 REAL, tp3 REAL,
        score INTEGER, win_prob_tp1 INTEGER, win_prob_tp2 INTEGER, win_prob_tp3 INTEGER,
        htf_bias TEXT, session TEXT, trade_style TEXT, instrument TEXT, rr REAL,
        raw_payload TEXT, forced INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`INSERT INTO signals SELECT *, 0 FROM _signals_bak`);
      db.exec(`DROP TABLE _signals_bak`);
      console.log('[migrate] Done');
    } catch (err) {
      console.error('[migrate] Failed:', err.message);
      try { db.exec(`ALTER TABLE _signals_bak RENAME TO signals`); } catch (_) {}
    }
  }
}

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, entry, sl, tp1, tp2, tp3,
     score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
     trade_style, instrument, rr, raw_payload, forced)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
     @trade_style, @instrument, @rr, @raw_payload, @forced)
`);

const upsertPrice = db.prepare(`
  INSERT INTO market_snapshots (symbol, price, open_price, change_pct, high_24h, low_24h, snapped_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(symbol) DO UPDATE SET
    price      = excluded.price,
    open_price = excluded.open_price,
    change_pct = excluded.change_pct,
    high_24h   = excluded.high_24h,
    low_24h    = excluded.low_24h,
    snapped_at = excluded.snapped_at
`);

const insertOutcome = db.prepare(`
  INSERT OR IGNORE INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts)
  VALUES (?, ?, ?, ?, ?)
`);

const getPendingSignals = db.prepare(`
  SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument
  FROM signals s
  LEFT JOIN outcomes o ON o.signal_id = s.id
  WHERE o.id IS NULL
    AND s.entry IS NOT NULL AND s.sl IS NOT NULL AND s.tp1 IS NOT NULL
    AND s.received_at <= datetime('now', '-3 minutes')
    AND s.received_at >= datetime('now', '-4 hours')
    AND s.instrument = ?
  ORDER BY s.received_at ASC
`);

// ── ntfy push notifications ───────────────────────────────────────────────────
function sendNtfy(s) {
  if (!NTFY_TOPIC) return;
  const arrow    = s.direction === 'LONG' ? '▲' : '▼';
  const priority = s.grade === 'A+' ? 'urgent' : 'high';
  const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';
  const body = [
    s.setup        ? `Setup:   ${s.setup}`              : null,
    s.tradeStyle   ? `Style:   ${s.tradeStyle}`         : null,
    s.entry != null? `Entry:   ${s.entry}`              : null,
    s.sl    != null? `SL:      ${s.sl}`                 : null,
    s.tp1   != null? `TP1:     ${s.tp1}`                : null,
    s.tp2   != null? `TP2:     ${s.tp2}`                : null,
    s.tp3   != null? `TP3:     ${s.tp3}`                : null,
    s.rr    != null? `RR:      ${s.rr}`                 : null,
    s.score != null? `Score:   ${s.score}`              : null,
    s.win_prob_tp1 != null ? `Win%:  ${s.win_prob_tp1}%`: null,
    s.session      ? `Session: ${s.session}`            : null,
  ].filter(Boolean).join('\n');
  const headers = {
    'Content-Type': 'text/plain',
    'Title':    `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker ?? s.instrument}`,
    'Priority': priority,
    'Tags':     tags,
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy]', err.message));
}

// ── Market data (Twelvedata — twelvedata.com, free tier: 800 req/day) ────────
function twelvedataInterval(timeframe) {
  return timeframe.startsWith('1M') ? '1min' : '15min';
}

async function fetchTwelvedataBars(symbol, interval, outputsize) {
  if (!TWELVEDATA_KEY) throw new Error('TWELVEDATA_API_KEY env var not set');
  const url = `https://api.twelvedata.com/time_series`
    + `?symbol=${encodeURIComponent(symbol)}&interval=${interval}`
    + `&outputsize=${outputsize}&timezone=UTC&apikey=${TWELVEDATA_KEY}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'NQ-Signal-Pro/3.0' } });
  if (!res.ok) throw new Error(`Twelvedata ${res.status}: ${symbol}`);
  const json = await res.json();
  if (json.status === 'error') throw new Error(`Twelvedata: ${json.message}`);
  const values = json.values ?? [];
  // Twelvedata returns newest-first; reverse for chronological order
  return values.reverse().map(v => ({
    timestamp: new Date(v.datetime.replace(' ', 'T') + 'Z').toISOString(),
    open:   parseFloat(v.open),
    high:   parseFloat(v.high),
    low:    parseFloat(v.low),
    close:  parseFloat(v.close),
    volume: parseFloat(v.volume ?? '0'),
  })).filter(b => !isNaN(b.open) && !isNaN(b.close));
}

async function fetchBarsForSymbol(symbol, timeframe, limit) {
  const interval = twelvedataInterval(timeframe);
  const bars = await fetchTwelvedataBars(symbol, interval, Math.min(limit, 5000));
  return bars.slice(-limit);
}

// Historical fetch for backtests — free tier supports up to 5000 bars per request
async function fetchAllBars(symbol, timeframe, maxBars) {
  const interval = twelvedataInterval(timeframe);
  const outputsize = Math.min(maxBars, 5000);
  const bars = await fetchTwelvedataBars(symbol, interval, outputsize);
  return bars.slice(-maxBars);
}

function savePrice(symbol, bars) {
  if (!bars || bars.length < 2) return;
  const last  = bars[bars.length - 1];
  const first = bars[0];
  const chg   = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
  const high  = Math.max(...bars.map(b => b.high));
  const low   = Math.min(...bars.map(b => b.low));
  upsertPrice.run(symbol, last.close, first.open, +chg.toFixed(3), high, low);
}

// ── Cooldown tracking (per instrument) ───────────────────────────────────────
const lastSignalTimes = { MNQ: 0, MGC: 0 };
let scanCount = 0;

// ── Daily signal quota tracking (resets at UTC midnight) ─────────────────────
const dailyQuota = {
  MNQ: { date: '', live: 0, bt: 0 },
  MGC: { date: '', live: 0, bt: 0 },
};

function todayUTC() { return new Date().toISOString().slice(0, 10); }

function _resetIfNewDay(inst) {
  const q = dailyQuota[inst];
  if (q.date !== todayUTC()) { q.date = todayUTC(); q.live = 0; q.bt = 0; }
  return q;
}

function getDailyLive(inst)      { return _resetIfNewDay(inst).live; }
function incDailyLive(inst)      { _resetIfNewDay(inst).live++; }
function getDailyBt(inst)        { return _resetIfNewDay(inst).bt; }
function addDailyBt(inst, n)     { _resetIfNewDay(inst).bt += n; }

// Seed quota from DB on startup so restarts mid-day don't lose the count
function seedDailyQuota() {
  const today = todayUTC();
  for (const inst of ['MNQ', 'MGC']) {
    const row = db.prepare(
      `SELECT COUNT(*) n FROM signals WHERE instrument=? AND date(received_at)=?`
    ).get(inst, today);
    if (row?.n) { dailyQuota[inst].date = today; dailyQuota[inst].live = row.n; }
  }
}

// ── Auto-resolve pending outcomes against fresh bars ──────────────────────────
function autoResolveOutcomes(bars1m, instrument) {
  const pending = getPendingSignals.all(instrument);
  if (!pending.length) return;

  for (const sig of pending) {
    const sigTime    = new Date(sig.received_at).getTime();
    const futureBars = bars1m.filter(b => new Date(b.timestamp).getTime() > sigTime);
    if (futureBars.length < 2) continue;

    let resolved = null;
    let exitBar  = null;
    for (const bar of futureBars) {
      if (sig.direction === 'LONG') {
        if (bar.high >= sig.tp1) { resolved = { result: 'WIN',  exitPrice: sig.tp1 }; exitBar = bar; break; }
        if (bar.low  <= sig.sl)  { resolved = { result: 'LOSS', exitPrice: sig.sl  }; exitBar = bar; break; }
      } else {
        if (bar.low  <= sig.tp1) { resolved = { result: 'WIN',  exitPrice: sig.tp1 }; exitBar = bar; break; }
        if (bar.high >= sig.sl)  { resolved = { result: 'LOSS', exitPrice: sig.sl  }; exitBar = bar; break; }
      }
    }

    if (resolved) {
      const pnlPts = sig.direction === 'LONG'
        ? resolved.exitPrice - sig.entry
        : sig.entry - resolved.exitPrice;
      insertOutcome.run(sig.id, resolved.result, resolved.exitPrice,
        exitBar?.timestamp ?? new Date().toISOString(), +pnlPts.toFixed(2));
      console.log(`[${ts()}] AUTO-RESOLVE #${sig.id} ${instrument}: ${sig.direction} → ${resolved.result} (${+pnlPts.toFixed(2)} pts)`);
    }
  }
}

// ── Per-instrument signal scan ────────────────────────────────────────────────
// relaxed=true: Grade B mode (score≥8), skips cooldown + adaptive suppression,
// stores signal in DB for learning but does NOT send ntfy push.
async function scanInstrument(symbol, instrument, bars1m, bars15m, { relaxed = false } = {}) {
  const barMs = 60_000;

  // Normal mode respects cooldown; forced/relaxed mode bypasses it
  if (!relaxed && Date.now() - (lastSignalTimes[instrument] ?? 0) < COOLDOWN * barMs) return;

  const signal = computeSignal(bars1m, bars15m, {
    rthOnly:    RTH_ONLY,
    minScore:   relaxed ? 8 : BASE_SCORE,
    relaxed,
    instrument,
  });
  if (!signal) return;

  // Normal mode: apply adaptive score suppression
  if (!relaxed) {
    const minScore = getAdaptiveMinScore(db, signal.setup, signal.tradeStyle, BASE_SCORE);
    if (signal.score < minScore) {
      console.log(`[${ts()}] Suppressed ${instrument} ${signal.setup} (score=${signal.score} < adaptive=${minScore})`);
      return;
    }
  }

  if (!relaxed) lastSignalTimes[instrument] = Date.now();
  incDailyLive(instrument);

  const info = insertSignal.run({
    ticker:       signal.ticker,
    timeframe:    signal.timeframe,
    direction:    signal.direction,
    grade:        signal.grade,
    setup:        signal.setup,
    entry:        signal.entry,
    sl:           signal.sl,
    tp1:          signal.tp1,
    tp2:          signal.tp2,
    tp3:          signal.tp3,
    score:        signal.score,
    win_prob_tp1: signal.win_prob_tp1,
    win_prob_tp2: signal.win_prob_tp2,
    win_prob_tp3: signal.win_prob_tp3,
    htf_bias:     signal.htf_bias,
    session:      signal.session,
    trade_style:  signal.tradeStyle,
    instrument:   signal.instrument,
    rr:           signal.rr,
    raw_payload:  JSON.stringify({ ...signal, forced: relaxed }),
    forced:       relaxed ? 1 : 0,
  });

  const minScoreLog = relaxed ? 8 : getAdaptiveMinScore(db, signal.setup, signal.tradeStyle, BASE_SCORE);
  const modeTag     = relaxed ? ' [LEARNING]' : '';
  console.log(
    `[${ts()}] SIGNAL${modeTag} #${info.lastInsertRowid} | ${instrument} ${signal.direction} ${signal.grade} | ` +
    `${signal.setup} [${signal.tradeStyle}] | score=${signal.score}/${minScoreLog} | ` +
    `entry=${signal.entry} | rr=${signal.rr} | daily=${getDailyLive(instrument)}/${DAILY_MIN_LIVE}`
  );

  // B-grade (learning/forced) signals: skip ntfy — they are for system learning only
  if (signal.grade !== 'B') sendNtfy(signal);
}

// ── Live scan — both MNQ and MGC in parallel ──────────────────────────────────
async function scan() {
  scanCount++;
  try {
    const [mnqBars1m, mnqBars15m, mgcBars1m, mgcBars15m] = await Promise.all([
      fetchBarsForSymbol(SYMBOL,     '1Min',  120),
      fetchBarsForSymbol(SYMBOL,     '15Min',  60),
      fetchBarsForSymbol(SYMBOL_MGC, '1Min',  120),
      fetchBarsForSymbol(SYMBOL_MGC, '15Min',  60),
    ]);

    if (mnqBars1m.length >= 2) savePrice(SYMBOL,     mnqBars1m);
    if (mgcBars1m.length >= 2) savePrice(SYMBOL_MGC, mgcBars1m);

    const mnqReady = mnqBars1m.length >= 60 && mnqBars15m.length >= 30;
    const mgcReady = mgcBars1m.length >= 60 && mgcBars15m.length >= 30;

    if (!mnqReady && !mgcReady) {
      console.log(`[${ts()}] Waiting for bars (MNQ: ${mnqBars1m.length} 1m, MGC: ${mgcBars1m.length} 1m)`);
      return;
    }

    // Normal (strict) scan
    await Promise.all([
      mnqReady ? scanInstrument(SYMBOL,     'MNQ', mnqBars1m, mnqBars15m) : Promise.resolve(),
      mgcReady ? scanInstrument(SYMBOL_MGC, 'MGC', mgcBars1m, mgcBars15m) : Promise.resolve(),
    ]);

    // Quota-aware relaxed fallback — if daily quota is behind, try Grade-B scan
    // Spread relaxed attempts across the day; only fire one per 90-min window
    const ninetyMin = 90 * 60_000;
    await Promise.all([
      (mnqReady && getDailyLive('MNQ') < DAILY_MIN_LIVE &&
        Date.now() - (lastSignalTimes['MNQ'] ?? 0) > ninetyMin)
        ? scanInstrument(SYMBOL,     'MNQ', mnqBars1m, mnqBars15m, { relaxed: true })
        : Promise.resolve(),
      (mgcReady && getDailyLive('MGC') < DAILY_MIN_LIVE &&
        Date.now() - (lastSignalTimes['MGC'] ?? 0) > ninetyMin)
        ? scanInstrument(SYMBOL_MGC, 'MGC', mgcBars1m, mgcBars15m, { relaxed: true })
        : Promise.resolve(),
    ]);

    if (mnqReady) autoResolveOutcomes(mnqBars1m, 'MNQ');
    if (mgcReady) autoResolveOutcomes(mgcBars1m, 'MGC');

  } catch (err) {
    console.error(`[${ts()}] Scan error:`, err.message);
  }
}

// ── Hourly quota enforcement — guarantees daily minimums ─────────────────────
// Runs every 2 hours. If an instrument is below its daily quota it forces a
// dedicated relaxed scan regardless of the 90-min window used in scan().
async function runQuotaEnforcementScan() {
  const instruments = [
    { symbol: SYMBOL,     inst: 'MNQ' },
    { symbol: SYMBOL_MGC, inst: 'MGC' },
  ];

  const behind = instruments.filter(({ inst }) => getDailyLive(inst) < DAILY_MIN_LIVE);
  if (behind.length === 0) return;

  console.log(`[${ts()}] QUOTA CHECK: behind on [${behind.map(x => x.inst).join(', ')}] — running enforcement scan`);

  try {
    for (const { symbol, inst } of behind) {
      const [bars1m, bars15m] = await Promise.all([
        fetchBarsForSymbol(symbol, '1Min',  120),
        fetchBarsForSymbol(symbol, '15Min',  60),
      ]);
      if (bars1m.length < 60 || bars15m.length < 30) continue;
      savePrice(symbol, bars1m);
      // Force up to (DAILY_MIN_LIVE - current) signals to hit quota
      const needed = DAILY_MIN_LIVE - getDailyLive(inst);
      for (let attempt = 0; attempt < needed; attempt++) {
        await scanInstrument(symbol, inst, bars1m, bars15m, { relaxed: true });
      }
    }
  } catch (err) {
    console.error(`[${ts()}] Quota enforcement error:`, err.message);
  }
}

// ── Quick backtest cycle (revision check only) ────────────────────────────────
async function runBacktestCycle(instrument, triggeredBy = 'scheduled') {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] BACKTEST START: ${instrument} (${symbol}, up to ${BT_BARS} bars, target ${BT_TARGET_TRADES} trades)`);

    const pendingShadow = db.prepare(
      `SELECT id FROM strategy_revisions WHERE instrument=? AND status='shadow' LIMIT 1`
    ).get(instrument);

    if (pendingShadow) {
      const barsForShadow = await fetchAllBars(symbol, '1Min', BT_BARS);
      if (barsForShadow.length >= 100) {
        savePrice(symbol, barsForShadow);
        const result = evaluateShadow(db, instrument, barsForShadow, { slippage: BT_SLIPPAGE });
        if (result?.promoted) {
          console.log(`[${ts()}] REVISION PROMOTED: ${instrument} ${(result.before*100).toFixed(1)}% → ${(result.after*100).toFixed(1)}%`);
        } else if (result) {
          console.log(`[${ts()}] Shadow discarded for ${instrument}`);
        }
      }
      return;
    }

    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 100) {
      console.log(`[${ts()}] BACKTEST SKIP: insufficient bars (${bars1m.length})`);
      return;
    }

    savePrice(symbol, bars1m);

    const params = getParams(db, instrument);
    let result = runBacktest(bars1m, params, {
      targetTrades: BT_TARGET_TRADES,
      minSignals:   DAILY_MIN_BT,
      slippage:     BT_SLIPPAGE,
      walkForward:  true,
    });

    // If still below daily minimum, retry once with relaxed minScore
    if (result.metrics.tradeCount < DAILY_MIN_BT) {
      console.log(`[${ts()}] BACKTEST QUOTA: ${instrument} only ${result.metrics.tradeCount} trades — retrying with relaxed params`);
      const relaxedParams = { ...params, minScore: Math.min(params.minScore ?? 12, 8) };
      const retry = runBacktest(bars1m, relaxedParams, {
        targetTrades: BT_TARGET_TRADES,
        slippage:     BT_SLIPPAGE,
        walkForward:  true,
      });
      if (retry.metrics.tradeCount >= result.metrics.tradeCount) result = retry;
    }

    const { metrics } = result;
    metrics.barsScanned = bars1m.length;
    addDailyBt(instrument, metrics.tradeCount);

    const runId = saveBacktestRun(db, instrument, params, metrics, triggeredBy);

    // Store all trades (WIN + LOSS + BE) up to 200 — full dataset for learning
    const allTrades = result.signalLog.slice(0, 200);
    if (allTrades.length > 0) {
      const insTrade = db.prepare(`
        INSERT INTO backtest_trades
          (run_id, instrument, bar_idx, timestamp, direction, setup, trade_style, regime, entry, sl, tp1, outcome, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (const t of allTrades) {
          insTrade.run(runId, instrument, t.bar ?? null, t.timestamp ?? null, t.direction,
            t.setup ?? null, t.tradeStyle ?? null, t.regime ?? null,
            t.entry ?? null, t.sl ?? null, t.tp1 ?? null, t.outcome, t.score ?? null);
        }
      })();
    }

    saveBacktestDetails(db, runId, {
      byRegime:               metrics.byRegime,
      byStyle:                metrics.byStyle,
      bySetup:                metrics.bySetup,
      walkForwardConsistency: result.walkForward?.consistency ?? null,
      walkForwardAvgWR:       result.walkForward?.avgWinRate  ?? null,
      maxWinStreak:           metrics.maxWinStreak,
      maxLossStreak:          metrics.maxLossStreak,
      slippageUsed:           result.slippageUsed,
      cooldownUsed:           result.cooldownUsed,
      multiObjScore:          multiObjectiveScore(metrics),
    });

    console.log(
      `[${ts()}] BACKTEST DONE: ${instrument} | ` +
      `trades=${metrics.tradeCount} (cd=${result.cooldownUsed}) | ` +
      `win=${(metrics.winRate*100).toFixed(1)}% | sharpe=${metrics.sharpe} | ` +
      `pf=${metrics.profitFactor} | dd=${metrics.maxDrawdown}R | ` +
      `consistency=${(metrics.regimeConsistency ?? 1).toFixed(2)} | ` +
      `wf=${result.walkForward?.consistency ?? 'n/a'} | run#${runId}`
    );

    const best = proposeRevision(db, instrument, bars1m, runId,
      { cooldown: result.cooldownUsed, slippage: BT_SLIPPAGE });
    if (best) {
      console.log(
        `[${ts()}] SHADOW CANDIDATE: ${instrument} ` +
        `win ${(metrics.winRate*100).toFixed(1)}% → ${(best.metrics.winRate*100).toFixed(1)}% ` +
        `score=${best.score}`
      );
    }

  } catch (err) {
    console.error(`[${ts()}] Backtest error (${instrument}):`, err.message);
  }
}

// ── Full optimizer cycle (less frequent, deeper search) ──────────────────────
async function runOptimizerCycle(instrument) {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] OPTIMIZER START: ${instrument}`);
    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 500) return;

    savePrice(symbol, bars1m);

    const report = await runFullOptimizationCycle(db, instrument, bars1m, {
      targetTrades:  BT_TARGET_TRADES,
      slippage:      BT_SLIPPAGE,
    });

    console.log(report.summary);
    console.log(
      `[${ts()}] OPTIMIZER DONE: ${instrument} | ` +
      `live=${(report.liveWinRate*100).toFixed(1)}% | ` +
      `atTarget=${report.atTarget} | ` +
      `promoted=${report.globalPromoted} | ` +
      `wf-consistency=${report.walkForwardConsistency ?? 'n/a'}`
    );

  } catch (err) {
    console.error(`[${ts()}] Optimizer error (${instrument}):`, err.message);
  }
}

function ts() { return new Date().toISOString(); }

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('NQ Signal Pro V3 — Enhanced Scanner + Backtesting Framework');
console.log(`Live symbols: MNQ=${SYMBOL} MGC=${SYMBOL_MGC} | Scan: every ${SCAN_INTERVAL/1000}s | Cooldown: ${COOLDOWN}min/instrument | Base score: ${BASE_SCORE} | RTH-only: ${RTH_ONLY}`);
console.log(`Backtests: every ${BT_INTERVAL_H}h | Bars: ${BT_BARS} | Target: ${BT_TARGET_TRADES} trades | Slippage: ${BT_SLIPPAGE}pts`);
console.log(`Optimizer: every ${OPT_INTERVAL_H}h | Instruments: MNQ (scalp/intraday/swing), MGC (scalp)`);
if (!NTFY_TOPIC) console.warn('WARNING: NTFY_TOPIC not set — push notifications disabled');
if (!TWELVEDATA_KEY) console.warn('WARNING: TWELVEDATA_API_KEY not set — market data unavailable');
console.log(`Market data: Twelvedata | Daily quotas: live=${DAILY_MIN_LIVE}/instrument, bt=${DAILY_MIN_BT}/run`);

// Seed daily counters from DB (handles mid-day restarts)
seedDailyQuota();

// Warmup on startup (staggered to avoid rate-limiting)
setTimeout(() => runBacktestCycle('MNQ', 'startup'),   5_000);
setTimeout(() => runBacktestCycle('MGC', 'startup'),  35_000);
setTimeout(() => runOptimizerCycle('MNQ'), 120_000);
setTimeout(() => runOptimizerCycle('MGC'), 180_000);
setTimeout(() => runQuotaEnforcementScan(),  300_000);   // first quota check 5 min after startup

// Live scan
scan();
setInterval(scan, SCAN_INTERVAL);

// Quick backtest cycles
const BT_MS  = BT_INTERVAL_H  * 3_600_000;
setInterval(() => runBacktestCycle('MNQ'), BT_MS);
setInterval(() => runBacktestCycle('MGC'), BT_MS + BT_MS / 2);

// Full optimizer cycles
const OPT_MS = OPT_INTERVAL_H * 3_600_000;
setInterval(() => runOptimizerCycle('MNQ'), OPT_MS);
setInterval(() => runOptimizerCycle('MGC'), OPT_MS + OPT_MS / 3);

// Quota enforcement — every 2 hours, forces Grade-B signals if daily quota is behind
setInterval(runQuotaEnforcementScan, 2 * 3_600_000);
