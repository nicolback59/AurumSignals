'use strict';

const WINDOW     = 60;   // live trade window for setup analysis
const MIN_SAMPLE = 10;   // minimum trades before adjusting thresholds

// ── Live-trade adaptive deltas ────────────────────────────────────────────────
/**
 * Compute per-setup score delta based on recent live win rates.
 *   ≥ 72 % → lower threshold by 2  (setup is hot)
 *   ≤ 40 % → raise  threshold by 4  (setup is cold)
 *   40–72 %  → no change
 */
function computeAdaptiveDeltas(db) {
  const rows = db.prepare(`
    SELECT s.setup, o.result
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now', '-30 days')
    ORDER  BY s.received_at DESC
    LIMIT  ?
  `).all(WINDOW);

  if (rows.length < MIN_SAMPLE) return {};

  const bySetup = {};
  for (const r of rows) {
    const k = r.setup || 'unknown';
    if (!bySetup[k]) bySetup[k] = { wins: 0, total: 0 };
    bySetup[k].total++;
    if (r.result === 'WIN') bySetup[k].wins++;
  }

  const deltas = {};
  for (const [setup, { wins, total }] of Object.entries(bySetup)) {
    if (total < MIN_SAMPLE) continue;
    const wr = wins / total;
    if      (wr >= 0.72) deltas[setup] = -2;
    else if (wr <= 0.40) deltas[setup] = +4;
  }
  return deltas;
}

// ── Live-trade regime detection ───────────────────────────────────────────────
/**
 * Regime based on the last 15 resolved live trades.
 */
function getMarketRegime(db) {
  const recent = db.prepare(`
    SELECT o.result
    FROM   outcomes o
    JOIN   signals  s ON s.id = o.signal_id
    ORDER  BY s.received_at DESC
    LIMIT  15
  `).all();

  if (recent.length < 8) return 'unknown';
  const wr = recent.filter(r => r.result === 'WIN').length / recent.length;
  return wr >= 0.62 ? 'trending' : wr <= 0.38 ? 'choppy' : 'mixed';
}

// ── Backtest-driven regime estimation ─────────────────────────────────────────
/**
 * Use recent backtest OOS win rates to supplement live regime estimation.
 * If we have enough recent backtest data, blend it in.
 */
function getBacktestRegime(db) {
  const rows = db.prepare(`
    SELECT oos_win_rate
    FROM   backtest_runs
    WHERE  oos_win_rate IS NOT NULL
      AND  run_at >= datetime('now', '-24 hours')
    ORDER  BY run_at DESC
    LIMIT  6
  `).all();

  if (rows.length < 2) return null;

  const avgOos = rows.reduce((s, r) => s + r.oos_win_rate, 0) / rows.length;
  if (avgOos >= 0.62) return 'trending';
  if (avgOos <= 0.38) return 'choppy';
  return 'mixed';
}

// ── Trade-style adaptive deltas ───────────────────────────────────────────────
/**
 * Per-style win rates from recent live outcomes.
 * Returns deltas: { scalp: ±N, intraday: ±N, swing: ±N }
 */
function computeStyleDeltas(db) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT s.trade_style, o.result
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now', '-30 days')
      ORDER  BY s.received_at DESC
      LIMIT  ?
    `).all(WINDOW);
  } catch {
    return {};
  }

  if (!rows || rows.length < MIN_SAMPLE) return {};

  const byStyle = {};
  for (const r of rows) {
    const k = r.trade_style || 'scalp';
    if (!byStyle[k]) byStyle[k] = { wins: 0, total: 0 };
    byStyle[k].total++;
    if (r.result === 'WIN') byStyle[k].wins++;
  }

  const deltas = {};
  for (const [style, { wins, total }] of Object.entries(byStyle)) {
    if (total < MIN_SAMPLE) continue;
    const wr = wins / total;
    if      (wr >= 0.72) deltas[style] = -2;
    else if (wr <= 0.42) deltas[style] = +3;
  }
  return deltas;
}

// ── Adaptive min-score ────────────────────────────────────────────────────────
/**
 * Returns adjusted minimum score for a setup/style combination.
 * Blends live signal outcomes, backtest OOS regime, and style performance.
 */
function getAdaptiveMinScore(db, setup, baseMin = 16, tradeStyle = 'scalp') {
  try {
    const setupDeltas  = computeAdaptiveDeltas(db);
    const styleDeltas  = computeStyleDeltas(db);
    const liveRegime   = getMarketRegime(db);
    const btRegime     = getBacktestRegime(db);

    // Dominant regime (live regime takes precedence, backtest supplements)
    const regime = liveRegime !== 'unknown' ? liveRegime : (btRegime ?? 'unknown');

    const setupDelta  = setupDeltas[setup]      ?? 0;
    const styleDelta  = styleDeltas[tradeStyle] ?? 0;
    const regimeDelta = regime === 'choppy' ? +2 : regime === 'trending' ? -1 : 0;

    const combined = setupDelta + styleDelta + regimeDelta;
    return Math.max(12, Math.min(30, baseMin + combined));
  } catch {
    return baseMin;
  }
}

// ── Backtest trend analysis ────────────────────────────────────────────────────
/**
 * Analyse backtest history to surface learning trends.
 * Used by the /api/learning endpoint to show progress over time.
 */
function getBacktestTrends(db) {
  try {
    const byInstrument = db.prepare(`
      SELECT instrument,
             COUNT(*)                                    AS total_runs,
             ROUND(AVG(win_rate) * 100, 1)              AS avg_win_pct,
             ROUND(MAX(win_rate) * 100, 1)              AS best_win_pct,
             ROUND(AVG(oos_win_rate) * 100, 1)          AS avg_oos_pct,
             ROUND(AVG(fitness), 3)                     AS avg_fitness,
             SUM(trades_found)                          AS total_trades_tested,
             MAX(run_at)                                AS last_run_at
      FROM   backtest_runs
      GROUP  BY instrument
      ORDER  BY instrument
    `).all();

    const recent = db.prepare(`
      SELECT instrument, run_at, win_rate, oos_win_rate, fitness, trades_found, sharpe
      FROM   backtest_runs
      ORDER  BY run_at DESC
      LIMIT  20
    `).all();

    const revisions = db.prepare(`
      SELECT instrument,
             COUNT(*)                                              AS total,
             SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) AS discarded,
             SUM(CASE WHEN status = 'shadow'    THEN 1 ELSE 0 END) AS pending
      FROM   strategy_revisions
      GROUP  BY instrument
    `).all();

    return { byInstrument, recent, revisions };
  } catch {
    return { byInstrument: [], recent: [], revisions: [] };
  }
}

// ── Full learning stats ───────────────────────────────────────────────────────
function getLearningStats(db) {
  const bySetup = db.prepare(`
    SELECT s.setup,
           COUNT(*)                                                      AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)             AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END)             AS losses,
           ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now','-30 days')
    GROUP  BY s.setup
    ORDER  BY win_pct DESC
  `).all();

  const bySession = db.prepare(`
    SELECT s.session,
           COUNT(*)                                                      AS total,
           ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now','-30 days')
    GROUP  BY s.session
    ORDER  BY win_pct DESC
  `).all();

  const byHtf = db.prepare(`
    SELECT s.htf_bias,
           COUNT(*)                                                      AS total,
           ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now','-30 days')
    GROUP  BY s.htf_bias
    ORDER  BY win_pct DESC
  `).all();

  // Style breakdown from live signals (graceful if column missing)
  let byStyle = [];
  try {
    byStyle = db.prepare(`
      SELECT s.trade_style,
             COUNT(*)                                                      AS total,
             ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now','-30 days')
      GROUP  BY s.trade_style
      ORDER  BY win_pct DESC
    `).all();
  } catch {}

  // Instrument breakdown
  let byInstrument = [];
  try {
    byInstrument = db.prepare(`
      SELECT s.instrument,
             COUNT(*)                                                      AS total,
             ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now','-30 days')
      GROUP  BY s.instrument
      ORDER  BY win_pct DESC
    `).all();
  } catch {}

  return {
    bySetup,
    bySession,
    byHtf,
    byStyle,
    byInstrument,
    adaptiveDeltas: computeAdaptiveDeltas(db),
    styleDeltas:    computeStyleDeltas(db),
    regime:         getMarketRegime(db),
    btRegime:       getBacktestRegime(db),
    backtestTrends: getBacktestTrends(db),
    windowTrades:   WINDOW,
  };
}

module.exports = {
  getAdaptiveMinScore,
  getLearningStats,
  getMarketRegime,
  getBacktestRegime,
  getBacktestTrends,
  computeStyleDeltas,
};
