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
// Yahoo Finance symbols — no API key needed, free, real-time futures data
const SYMBOL         = process.env.SCANNER_SYMBOL     || 'NQ=F';   // NQ futures (same price as MNQ)
const SYMBOL_MGC     = process.env.SCANNER_SYMBOL_MGC || 'GC=F';   // Gold futures (same price as MGC)
const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL     || '60')  * 1000;
const COOLDOWN       = parseInt(process.env.SCANNER_COOLDOWN  || '1');
const RTH_ONLY       = process.env.SCANNER_RTH_ONLY === 'true';
const BASE_SCORE     = parseInt(process.env.SCANNER_MIN_SCORE || '12');

// Backtest symbols (Yahoo Finance)
const BT_SYMBOLS = {
  MNQ: process.env.SCANNER_BT_MNQ || 'NQ=F',
  MGC: process.env.SCANNER_BT_MGC || 'GC=F',
};

// Backtest schedule
const BT_INTERVAL_H  = parseFloat(process.env.BACKTEST_INTERVAL_H  || '4');
// Increased default from 3000 → 10000 bars for 250-trade statistical target
const BT_BARS        = parseInt(process.env.BACKTEST_BARS           || '10000');
// Full optimizer runs less frequently than quick revision checks
const OPT_INTERVAL_H = parseFloat(process.env.OPTIMIZER_INTERVAL_H || '12');
// Slippage assumption for backtests (per side, in price points)
const BT_SLIPPAGE    = parseFloat(process.env.BT_SLIPPAGE           || '0.5');
// Target trades per backtest cycle for statistical significance
const BT_TARGET_TRADES = parseInt(process.env.BT_TARGET_TRADES      || '250');

// ── Database ──────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, entry, sl, tp1, tp2, tp3,
     score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
     trade_style, instrument, rr, raw_payload)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
     @trade_style, @instrument, @rr, @raw_payload)
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

// ── Market data (Yahoo Finance — free, no API key) ────────────────────────────
function yahooInterval(timeframe) {
  return timeframe.startsWith('1M') ? '1m' : '15m';
}

async function fetchYahooBars(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
    + `?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'NQ-Signal-Pro/3.0' } });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}: ${symbol}`);
  const json   = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) return [];
  const ts    = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  return ts.map((t, i) => ({
    timestamp: new Date(t * 1000).toISOString(),
    open:   quote.open?.[i],
    high:   quote.high?.[i],
    low:    quote.low?.[i],
    close:  quote.close?.[i],
    volume: quote.volume?.[i] ?? 0,
  })).filter(b => b.open != null && b.close != null);
}

async function fetchBarsForSymbol(symbol, timeframe, limit) {
  const interval = yahooInterval(timeframe);
  const range    = interval === '1m' ? '2d' : '5d';
  const bars     = await fetchYahooBars(symbol, interval, range);
  return bars.slice(-limit);
}

// Historical fetch for backtests — Yahoo gives up to 7d of 1m data (~10k bars)
async function fetchAllBars(symbol, timeframe, maxBars) {
  const interval = yahooInterval(timeframe);
  const range    = interval === '1m' ? '7d' : '60d';
  const bars     = await fetchYahooBars(symbol, interval, range);
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

// ── Auto-resolve pending outcomes against fresh bars ──────────────────────────
function autoResolveOutcomes(bars1m, instrument) {
  const pending = getPendingSignals.all(instrument);
  if (!pending.length) return;

  for (const sig of pending) {
    const sigTime   = new Date(sig.received_at).getTime();
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
async function scanInstrument(symbol, instrument, bars1m, bars15m) {
  const barMs = 60_000;
  if (Date.now() - (lastSignalTimes[instrument] ?? 0) < COOLDOWN * barMs) return;

  const signal = computeSignal(bars1m, bars15m, {
    rthOnly:    RTH_ONLY,
    minScore:   BASE_SCORE,
    instrument,
  });
  if (!signal) return;

  const minScore = getAdaptiveMinScore(db, signal.setup, signal.tradeStyle, BASE_SCORE);
  if (signal.score < minScore) {
    console.log(`[${ts()}] Suppressed ${instrument} ${signal.setup} (score=${signal.score} < adaptive=${minScore})`);
    return;
  }

  lastSignalTimes[instrument] = Date.now();

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
    raw_payload:  JSON.stringify(signal),
  });

  console.log(
    `[${ts()}] SIGNAL #${info.lastInsertRowid} | ${instrument} ${signal.direction} ${signal.grade} | ` +
    `${signal.setup} [${signal.tradeStyle}] | score=${signal.score}/${minScore} | ` +
    `entry=${signal.entry} | rr=${signal.rr} | regime=${getMarketRegime(db)}`
  );
  sendNtfy(signal);
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

    await Promise.all([
      mnqReady ? scanInstrument(SYMBOL,     'MNQ', mnqBars1m, mnqBars15m) : Promise.resolve(),
      mgcReady ? scanInstrument(SYMBOL_MGC, 'MGC', mgcBars1m, mgcBars15m) : Promise.resolve(),
    ]);

    if (mnqReady) autoResolveOutcomes(mnqBars1m, 'MNQ');
    if (mgcReady) autoResolveOutcomes(mgcBars1m, 'MGC');

  } catch (err) {
    console.error(`[${ts()}] Scan error:`, err.message);
  }
}

// ── Quick backtest cycle (revision check only) ────────────────────────────────
async function runBacktestCycle(instrument, triggeredBy = 'scheduled') {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] BACKTEST START: ${instrument} (${symbol}, up to ${BT_BARS} bars, target ${BT_TARGET_TRADES} trades)`);

    // Evaluate any pending shadow revision first
    const pendingShadow = db.prepare(
      `SELECT id FROM strategy_revisions WHERE instrument=? AND status='shadow' LIMIT 1`
    ).get(instrument);

    if (pendingShadow) {
      const barsForShadow = await fetchAllBars(symbol, '1Min', BT_BARS);
      if (barsForShadow.length >= 100) {
        savePrice(symbol, barsForShadow);
        const result = evaluateShadow(db, instrument, barsForShadow,
          { slippage: BT_SLIPPAGE });
        if (result?.promoted) {
          console.log(`[${ts()}] REVISION PROMOTED: ${instrument} ${(result.before*100).toFixed(1)}% → ${(result.after*100).toFixed(1)}%`);
        } else if (result) {
          console.log(`[${ts()}] Shadow discarded for ${instrument}`);
        }
      }
      return; // one action per cycle
    }

    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 100) {
      console.log(`[${ts()}] BACKTEST SKIP: insufficient bars (${bars1m.length})`);
      return;
    }

    savePrice(symbol, bars1m);

    // Backtest with current params + 250-trade auto-tune + slippage
    const params = getParams(db, instrument);
    const result = runBacktest(bars1m, params, {
      targetTrades: BT_TARGET_TRADES,
      slippage:     BT_SLIPPAGE,
      walkForward:  true,
    });
    const { metrics } = result;
    metrics.barsScanned = bars1m.length;

    const runId = saveBacktestRun(db, instrument, params, metrics, triggeredBy);

    // Persist losing/BE trades for the journal (capped at 100 per run to limit growth)
    const lossTrades = result.signalLog.filter(t => t.outcome === 'LOSS' || t.outcome === 'BE').slice(0, 100);
    if (lossTrades.length > 0) {
      const insLoss = db.prepare(`
        INSERT INTO backtest_trades
          (run_id, instrument, bar_idx, timestamp, direction, setup, trade_style, regime, entry, sl, tp1, outcome, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (const t of lossTrades) {
          insLoss.run(runId, instrument, t.bar ?? null, t.timestamp ?? null, t.direction,
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

    // Propose better params
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
console.log('Market data: Yahoo Finance (free, no API key required)');

// Warmup on startup (staggered to avoid rate-limiting)
setTimeout(() => runBacktestCycle('MNQ', 'startup'),   5_000);
setTimeout(() => runBacktestCycle('MGC', 'startup'),  35_000);
// Full optimizer runs 2 minutes after startup to let quick backtest complete first
setTimeout(() => runOptimizerCycle('MNQ'), 120_000);
setTimeout(() => runOptimizerCycle('MGC'), 180_000);

// Live scan
scan();
setInterval(scan, SCAN_INTERVAL);

// Quick backtest cycles (shadow check + revision proposal)
const BT_MS  = BT_INTERVAL_H  * 3_600_000;
setInterval(() => runBacktestCycle('MNQ'), BT_MS);
setInterval(() => runBacktestCycle('MGC'), BT_MS + BT_MS / 2);

// Full optimizer cycles (less frequent, deeper 50-candidate genetic search)
const OPT_MS = OPT_INTERVAL_H * 3_600_000;
setInterval(() => runOptimizerCycle('MNQ'), OPT_MS);
setInterval(() => runOptimizerCycle('MGC'), OPT_MS + OPT_MS / 3);
