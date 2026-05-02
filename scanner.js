'use strict';

const Database            = require('better-sqlite3');
const path                = require('path');
const fs                  = require('fs');
const { computeSignal }   = require('./signal-engine');
const { getAdaptiveMinScore, getMarketRegime } = require('./learning');
const { runBacktest }     = require('./backtest-engine');
const { getParams, saveBacktestRun, proposeRevision, evaluateShadow } = require('./strategy-params');

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH        = process.env.DB_PATH          || path.join(__dirname, 'signals.db');
const NTFY_URL       = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC     = process.env.NTFY_TOPIC       || '';
const NTFY_TOKEN     = process.env.NTFY_TOKEN       || '';
const ALPACA_KEY     = process.env.ALPACA_KEY        || '';
const ALPACA_SECRET  = process.env.ALPACA_SECRET     || '';

// Live scanner symbols per instrument
const SYMBOLS = {
  MNQ: process.env.SCANNER_SYMBOL_MNQ || process.env.SCANNER_SYMBOL || '@NQ.C.0',
  MGC: process.env.SCANNER_SYMBOL_MGC || '@GC.C.0',
};

// Whether to scan each instrument live
const SCAN_MNQ = process.env.SCAN_MNQ !== 'false';
const SCAN_MGC = process.env.SCAN_MGC === 'true';   // opt-in for MGC live scan

const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL    || '60')  * 1000;
const COOLDOWN      = parseInt(process.env.SCANNER_COOLDOWN || '3');
const RTH_ONLY      = process.env.SCANNER_RTH_ONLY === 'true';
const BASE_SCORE    = parseInt(process.env.SCANNER_MIN_SCORE || '16');

// Backtest symbols and schedule
const BT_SYMBOLS = {
  MNQ: process.env.SCANNER_BT_MNQ || '@MNQ.C.0',
  MGC: process.env.SCANNER_BT_MGC || '@MGC.C.0',
};
const BT_INTERVAL_H = parseFloat(process.env.BACKTEST_INTERVAL_H || '2');   // ↓ from 4h to 2h
const BT_BARS       = parseInt(process.env.BACKTEST_BARS         || '15000'); // ↑ from 3000 to 15000

// ── Database ──────────────────────────────────────────────────────────────────
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

// Apply additive migrations for existing databases (safe to re-run; errors ignored)
function applyMigrations(database) {
  const migrations = [
    `ALTER TABLE signals ADD COLUMN instrument TEXT DEFAULT 'MNQ'`,
    `ALTER TABLE signals ADD COLUMN trade_style TEXT DEFAULT 'scalp'`,
    `ALTER TABLE backtest_runs ADD COLUMN is_win_rate REAL`,
    `ALTER TABLE backtest_runs ADD COLUMN oos_win_rate REAL`,
    `ALTER TABLE backtest_runs ADD COLUMN fitness REAL`,
  ];
  for (const sql of migrations) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }
}
applyMigrations(db);

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, instrument, timeframe, direction, grade, setup, trade_style,
     entry, sl, tp1, tp2, tp3, score,
     win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session, raw_payload)
  VALUES
    (@ticker, @instrument, @timeframe, @direction, @grade, @setup, @trade_style,
     @entry, @sl, @tp1, @tp2, @tp3, @score,
     @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session, @raw_payload)
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

// ── ntfy ──────────────────────────────────────────────────────────────────────
function sendNtfy(s) {
  if (!NTFY_TOPIC) return;
  const arrow    = s.direction === 'LONG' ? '▲' : '▼';
  const priority = s.grade === 'A+' ? 'urgent' : 'high';
  const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';
  const styleTag = s.tradeStyle ? ` [${s.tradeStyle}]` : '';
  const body = [
    s.instrument        ? `Instrument: ${s.instrument}${styleTag}` : null,
    s.setup             ? `Setup:   ${s.setup}`          : null,
    s.entry   != null   ? `Entry:   ${s.entry}`          : null,
    s.sl      != null   ? `SL:      ${s.sl}`             : null,
    s.tp1     != null   ? `TP1:     ${s.tp1}`            : null,
    s.tp2     != null   ? `TP2:     ${s.tp2}`            : null,
    s.tp3     != null   ? `TP3:     ${s.tp3}`            : null,
    s.score   != null   ? `Score:   ${s.score}`          : null,
    s.win_prob_tp1 != null ? `Win%:  ${s.win_prob_tp1}%` : null,
    s.session           ? `Session: ${s.session}`        : null,
  ].filter(Boolean).join('\n');
  const headers = {
    'Content-Type': 'text/plain',
    'Title': `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker}`,
    'Priority': priority,
    'Tags':     tags,
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy]', err.message));
}

// ── Market data (Alpaca) ──────────────────────────────────────────────────────
async function fetchBarsForSymbol(symbol, timeframe, limit) {
  const url = `https://data.alpaca.markets/v1beta1/futures/bars`
    + `?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
    },
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.bars?.[symbol] ?? []).map(b => ({
    timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

// Paginated fetch targeting up to maxBars (used by backtest for large datasets)
async function fetchAllBars(symbol, timeframe, maxBars) {
  let all = [], pageToken = null;
  while (all.length < maxBars) {
    const limit = Math.min(1000, maxBars - all.length);
    let url = `https://data.alpaca.markets/v1beta1/futures/bars`
      + `?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const res  = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    });
    if (!res.ok) break;
    const json = await res.json();
    const bars = (json.bars?.[symbol] ?? []).map(b => ({
      timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
    }));
    all.push(...bars);
    pageToken = json.next_page_token ?? null;
    if (!pageToken || bars.length === 0) break;
  }
  return all.slice(-maxBars);
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

// ── Per-instrument cooldown tracking ─────────────────────────────────────────
const lastSignalTime = { MNQ: 0, MGC: 0 };
let   scanCount = 0;

// ── Live signal scan for a single instrument ──────────────────────────────────
async function scanInstrument(instrument) {
  const symbol = SYMBOLS[instrument];
  if (!symbol || !ALPACA_KEY) return;

  try {
    const [bars1m, bars15m] = await Promise.all([
      fetchBarsForSymbol(symbol, '1Min',  120),
      fetchBarsForSymbol(symbol, '15Min',  60),
    ]);

    if (bars1m.length >= 2) savePrice(symbol, bars1m);

    if (bars1m.length < 60 || bars15m.length < 10) {
      console.log(`[${ts()}] [${instrument}] Waiting for bars (${bars1m.length} 1m, ${bars15m.length} 15m)`);
      return;
    }

    const barMs = 60_000;
    if (Date.now() - lastSignalTime[instrument] < COOLDOWN * barMs) return;

    const signal = computeSignal(bars1m, bars15m, {
      instrument,
      rthOnly: RTH_ONLY,
      minScore: 12,
    });
    if (!signal) return;

    const minScore = getAdaptiveMinScore(db, signal.setup, BASE_SCORE, signal.tradeStyle);
    if (signal.score < minScore) {
      console.log(`[${ts()}] [${instrument}] Suppressed ${signal.setup}/${signal.tradeStyle} ` +
                  `(score=${signal.score} < adaptive=${minScore})`);
      return;
    }

    lastSignalTime[instrument] = Date.now();

    const info = insertSignal.run({
      ticker:       signal.ticker,
      instrument:   signal.instrument,
      timeframe:    signal.timeframe,
      direction:    signal.direction,
      grade:        signal.grade,
      setup:        signal.setup,
      trade_style:  signal.tradeStyle ?? 'scalp',
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
      raw_payload:  JSON.stringify(signal),
    });

    console.log(
      `[${ts()}] SIGNAL #${info.lastInsertRowid} | [${instrument}] ${signal.direction} ${signal.grade} | ` +
      `${signal.setup} [${signal.tradeStyle}] | score=${signal.score}/${minScore} | ` +
      `entry=${signal.entry} | regime=${getMarketRegime(db)}`
    );
    sendNtfy(signal);

  } catch (err) {
    console.error(`[${ts()}] [${instrument}] Scan error:`, err.message);
  }
}

// ── Master live scan (all enabled instruments) ────────────────────────────────
async function scan() {
  scanCount++;
  const tasks = [];
  if (SCAN_MNQ) tasks.push(scanInstrument('MNQ'));
  if (SCAN_MGC) tasks.push(scanInstrument('MGC'));
  await Promise.allSettled(tasks);
}

// ── Backtest cycle ────────────────────────────────────────────────────────────
async function runBacktestCycle(instrument, triggeredBy = 'scheduled') {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol || !ALPACA_KEY) return;

  try {
    console.log(`[${ts()}] BACKTEST START: ${instrument} (${symbol}, target ${BT_BARS} bars)`);

    // First: evaluate any pending shadow revision
    const pendingShadow = db.prepare(
      `SELECT id FROM strategy_revisions WHERE instrument=? AND status='shadow' LIMIT 1`
    ).get(instrument);

    if (pendingShadow) {
      const barsForShadow = await fetchAllBars(symbol, '1Min', BT_BARS);
      if (barsForShadow.length >= 200) {
        savePrice(symbol, barsForShadow);
        const result = evaluateShadow(db, instrument, barsForShadow);
        if (result?.promoted) {
          console.log(
            `[${ts()}] REVISION PROMOTED: ${instrument} ` +
            `${(result.before*100).toFixed(1)}% → ${(result.after*100).toFixed(1)}% ` +
            `(fitness ${result.fitBefore?.toFixed(3)} → ${result.fitAfter?.toFixed(3)})`
          );
        } else if (result) {
          console.log(`[${ts()}] Shadow discarded for ${instrument}`);
        }
      }
      return;
    }

    // Fetch historical bars (targeting 250+ trades via large dataset)
    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 200) {
      console.log(`[${ts()}] BACKTEST SKIP: insufficient bars (${bars1m.length})`);
      return;
    }

    savePrice(symbol, bars1m);

    // Walk-forward backtest with current params
    const params = getParams(db, instrument);
    const { metrics, isMetrics, oosMetrics } = runBacktest(bars1m, params, {
      instrument,
      cooldown: 1,
    });
    metrics.barsScanned = bars1m.length;

    const runId = saveBacktestRun(db, instrument, params, metrics, triggeredBy);

    // Regime summary for logging
    const regimeSummary = Object.entries(metrics.regimes || {})
      .map(([r, m]) => `${r}:${(m.winRate*100).toFixed(0)}%`)
      .join(' ');

    console.log(
      `[${ts()}] BACKTEST DONE: ${instrument} | trades=${metrics.tradeCount} | ` +
      `IS=${(isMetrics.winRate*100).toFixed(1)}% OOS=${(oosMetrics.winRate*100).toFixed(1)}% | ` +
      `fitness=${metrics.fitness?.toFixed(3)} | sharpe=${metrics.sharpe} | ` +
      `bars=${bars1m.length} | regimes=[${regimeSummary}] | run#${runId}`
    );

    // Style summary
    const styleSummary = Object.entries(metrics.styles || {})
      .map(([s, m]) => `${s}:${(m.winRate*100).toFixed(0)}%(${m.total})`)
      .join(' ');
    if (styleSummary) console.log(`[${ts()}]   styles=[${styleSummary}]`);

    // Anti-overfitting alert
    if (isMetrics.winRate - oosMetrics.winRate > 0.12) {
      console.warn(
        `[${ts()}] OVERFITTING WARNING: ${instrument} IS=${(isMetrics.winRate*100).toFixed(1)}% ` +
        `but OOS=${(oosMetrics.winRate*100).toFixed(1)}% — divergence > 12%`
      );
    }

    // Propose better params via neighbourhood search (50 candidates)
    const best = proposeRevision(db, instrument, bars1m, runId);
    if (best) {
      console.log(
        `[${ts()}] SHADOW CANDIDATE: ${instrument} win_rate ` +
        `${(metrics.winRate*100).toFixed(1)}% → ${(best.metrics.winRate*100).toFixed(1)}% | ` +
        `fitness ${metrics.fitness?.toFixed(3)} → ${best.metrics.fitness?.toFixed(3)} | ` +
        `OOS ${(best.metrics.oosWinRate*100).toFixed(1)}%`
      );
    }

  } catch (err) {
    console.error(`[${ts()}] Backtest error (${instrument}):`, err.message);
  }
}

function ts() { return new Date().toISOString(); }

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('NQ Signal Pro V3 — Scanner + Backtest Engine');
console.log(`Live MNQ: ${SCAN_MNQ ? SYMBOLS.MNQ : 'disabled'} | MGC: ${SCAN_MGC ? SYMBOLS.MGC : 'disabled'}`);
console.log(`Scan: every ${SCAN_INTERVAL/1000}s | RTH-only: ${RTH_ONLY}`);
console.log(`Backtests: every ${BT_INTERVAL_H}h | Target bars: ${BT_BARS} | Instruments: MNQ, MGC`);
if (!ALPACA_KEY)  console.warn('WARNING: ALPACA_KEY not set — all market data disabled');
if (!NTFY_TOPIC)  console.warn('WARNING: NTFY_TOPIC not set — push notifications disabled');

// Warmup backtests on startup (staggered to avoid hammering Alpaca)
if (ALPACA_KEY) {
  setTimeout(() => runBacktestCycle('MNQ', 'startup'), 5_000);
  setTimeout(() => runBacktestCycle('MGC', 'startup'), 45_000);
}

// Live scans
scan();
setInterval(scan, SCAN_INTERVAL);

// Backtest cycles (MNQ and MGC staggered by half the interval)
const BT_MS = BT_INTERVAL_H * 3_600_000;
setInterval(() => runBacktestCycle('MNQ'), BT_MS);
setInterval(() => runBacktestCycle('MGC'), BT_MS + BT_MS / 2);
