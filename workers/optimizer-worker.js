'use strict';

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');
const { runBacktest5m } = require('../backtest-engine');
const { getStyleParams, PARAM_BOUNDS } = require('../strategy-params');

const WORKER_NAME      = 'optimizer';
const STRATEGIES = [
  { name: 'MNQ_INTRADAY', instrument: 'MNQ', style: 'INTRADAY', symbols: ['MNQ1!', 'NQ=F', 'MNQ'] },
  { name: 'MGC_SCALP',    instrument: 'MGC', style: 'SCALP',    symbols: ['MGC1!', 'GC=F', 'MGC'] },
];
const MAX_RUNTIME_MS     = 110 * 60 * 1000;
const MIN_WIN_DELTA_PP   = 3.0;
const MIN_TRADES_90D     = 30;
const VARIATIONS_PER_RUN = 25;
const TUNABLE = ['slPts', 'minScore', 'stdvLen', 'std2', 'swingLook', 'swingL'];

const START_TIME = Date.now();

const db = openDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS optimizer_candidates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    strategy_name   TEXT NOT NULL,
    instrument      TEXT NOT NULL,
    params_json     TEXT NOT NULL,
    baseline_params TEXT NOT NULL,
    bt_wr_30d       REAL,
    bt_wr_90d       REAL,
    baseline_wr_30d REAL,
    baseline_wr_90d REAL,
    delta_wr_30d    REAL,
    delta_wr_90d    REAL,
    trade_count_30d INTEGER,
    trade_count_90d INTEGER,
    sharpe_30d      REAL,
    sharpe_90d      REAL,
    status          TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_at     TEXT,
    review_note     TEXT
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_opt_status ON optimizer_candidates(status, created_at DESC)`);

db.exec(`DELETE FROM optimizer_candidates WHERE created_at < datetime('now', '-30 days') AND status != 'pending_review'`);

heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

function loadBars(db, symbols, daysBack) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  for (const symbol of symbols) {
    const rows = db.prepare(
      `SELECT timestamp, open, high, low, close, volume FROM historical_bars WHERE symbol=? AND interval='5m' AND timestamp >= ? ORDER BY timestamp ASC`
    ).all(symbol, cutoff);
    if (rows.length >= 100) return rows;
  }
  return [];
}

function generateVariations(baseParams, count) {
  const variations = [];
  const intKeys = new Set(['slPts', 'minScore', 'stdvLen', 'swingLook', 'swingL', 'atrLen']);

  let attempts = 0;
  while (variations.length < count && attempts < count * 10) {
    attempts++;
    const candidate = { ...baseParams };
    const numToPerturb = 1 + Math.floor(Math.random() * 3);
    const keys = [...TUNABLE].sort(() => Math.random() - 0.5).slice(0, numToPerturb);

    for (const key of keys) {
      const bounds = PARAM_BOUNDS[key];
      if (!bounds || candidate[key] === undefined) continue;
      const factor = 1 + (Math.random() * 0.40 - 0.20);
      let val = candidate[key] * factor;
      val = Math.min(Math.max(val, bounds.min), bounds.max);
      if (intKeys.has(key)) val = Math.round(val);
      else val = +val.toFixed(3);
      candidate[key] = val;
    }

    const isDupe = JSON.stringify(candidate) === JSON.stringify(baseParams);
    if (!isDupe) variations.push(candidate);
  }
  return variations;
}

function scoreCandidate(params, bars30d, bars90d, baseline30, baseline90) {
  let res30, res90;
  const opts = { instrument: params.instrument, slippage: 0.5, alreadyAggregated5m: true };

  try { res30 = runBacktest5m(bars30d, params, opts); } catch (_) { return null; }
  try { res90 = runBacktest5m(bars90d, params, opts); } catch (_) { return null; }

  const wr30 = res30.metrics.winRate;
  const wr90 = res90.metrics.winRate;
  const tc90 = res90.metrics.tradeCount;

  if (tc90 < MIN_TRADES_90D) return null;
  if (wr30 * 100 - baseline30.wr < MIN_WIN_DELTA_PP) return null;
  if (wr90 * 100 - baseline90.wr < MIN_WIN_DELTA_PP) return null;

  return {
    bt_wr_30d:       +(wr30 * 100).toFixed(2),
    bt_wr_90d:       +(wr90 * 100).toFixed(2),
    delta_wr_30d:    +(wr30 * 100 - baseline30.wr).toFixed(2),
    delta_wr_90d:    +(wr90 * 100 - baseline90.wr).toFixed(2),
    trade_count_30d: res30.metrics.tradeCount,
    trade_count_90d: tc90,
    sharpe_30d:      res30.metrics.sharpe != null ? +res30.metrics.sharpe.toFixed(3) : null,
    sharpe_90d:      res90.metrics.sharpe != null ? +res90.metrics.sharpe.toFixed(3) : null,
  };
}

const summary = { strategies: {} };

for (const strat of STRATEGIES) {
  const { name, instrument, style, symbols } = strat;
  console.log(`[${WORKER_NAME}] Starting strategy: ${name}`);

  const bars30d = loadBars(db, symbols, 30);
  const bars90d = loadBars(db, symbols, 90);

  if (bars30d.length < 100) {
    console.log(`[${WORKER_NAME}] ${name}: insufficient 30d bars (${bars30d.length}) — skipping`);
    summary.strategies[name] = { skipped: true, reason: 'insufficient_30d_bars' };
    continue;
  }
  if (bars90d.length < 100) {
    console.log(`[${WORKER_NAME}] ${name}: insufficient 90d bars (${bars90d.length}) — skipping`);
    summary.strategies[name] = { skipped: true, reason: 'insufficient_90d_bars' };
    continue;
  }

  const baseParams = getStyleParams(db, instrument, style);
  const btOpts = { instrument, slippage: 0.5, alreadyAggregated5m: true };

  let base30res, base90res;
  try { base30res = runBacktest5m(bars30d, baseParams, btOpts); } catch (err) {
    console.log(`[${WORKER_NAME}] ${name}: baseline 30d backtest failed: ${err.message}`);
    summary.strategies[name] = { skipped: true, reason: 'baseline_bt_failed' };
    continue;
  }
  try { base90res = runBacktest5m(bars90d, baseParams, btOpts); } catch (err) {
    console.log(`[${WORKER_NAME}] ${name}: baseline 90d backtest failed: ${err.message}`);
    summary.strategies[name] = { skipped: true, reason: 'baseline_bt_failed' };
    continue;
  }

  const baseline30 = { wr: +(base30res.metrics.winRate * 100).toFixed(2) };
  const baseline90 = { wr: +(base90res.metrics.winRate * 100).toFixed(2) };

  console.log(`[${WORKER_NAME}] ${name}: baseline WR 30d=${baseline30.wr}% 90d=${baseline90.wr}%`);

  const variations = generateVariations(baseParams, VARIATIONS_PER_RUN);
  const passing = [];

  for (const variation of variations) {
    if (Date.now() - START_TIME > MAX_RUNTIME_MS) {
      console.log(`[${WORKER_NAME}] Hard timeout reached — graceful exit from variation loop`);
      break;
    }

    const scored = scoreCandidate(variation, bars30d, bars90d, baseline30, baseline90);
    if (scored) passing.push({ params: variation, scored });
  }

  passing.sort((a, b) => b.scored.delta_wr_90d - a.scored.delta_wr_90d);

  const topCandidates = passing.slice(0, 3);
  const insertStmt = db.prepare(`
    INSERT INTO optimizer_candidates
      (strategy_name, instrument, params_json, baseline_params,
       bt_wr_30d, bt_wr_90d, baseline_wr_30d, baseline_wr_90d,
       delta_wr_30d, delta_wr_90d, trade_count_30d, trade_count_90d,
       sharpe_30d, sharpe_90d)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  for (const { params, scored } of topCandidates) {
    insertStmt.run(
      name, instrument,
      JSON.stringify(params),
      JSON.stringify(baseParams),
      scored.bt_wr_30d, scored.bt_wr_90d,
      baseline30.wr, baseline90.wr,
      scored.delta_wr_30d, scored.delta_wr_90d,
      scored.trade_count_30d, scored.trade_count_90d,
      scored.sharpe_30d, scored.sharpe_90d
    );
  }

  console.log(`[${WORKER_NAME}] ${name}: ${passing.length} passing candidates, inserted top ${topCandidates.length}`);
  summary.strategies[name] = {
    skipped: false,
    variations_tested: variations.length,
    passing_count: passing.length,
    inserted_count: topCandidates.length,
    baseline_wr_30d: baseline30.wr,
    baseline_wr_90d: baseline90.wr,
  };
}

bumpCycle(db, WORKER_NAME);
heartbeat(db, WORKER_NAME, 'DONE', { ...summary, finishedAt: new Date().toISOString() });
console.log(`[${WORKER_NAME}] Done. Runtime: ${Math.round((Date.now() - START_TIME) / 1000)}s`);
process.exit(0);
