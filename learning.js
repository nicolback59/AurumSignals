'use strict';

const WINDOW     = 300;  // last N resolved trades to analyse
const MIN_SAMPLE = 5;    // minimum trades before adjusting

// ── Per-strategy learned threshold bounds ─────────────────────────────────────
// Thresholds evolve after every backtest cycle.
// Low win rate → raise (be more selective). High win rate → lower (cast wider net).

const THRESHOLD_BOUNDS = {
  MNQ_INTRADAY: { min: 58, max: 80, default: 68 },
  MNQ_SWING:    { min: 62, max: 82, default: 72 },
  MNQ_50PT:     { min: 65, max: 84, default: 78 },
  MGC_SCALP:    { min: 54, max: 78, default: 65 },
  MGC_INTRADAY: { min: 52, max: 75, default: 63 },
};

// ── Learned threshold persistence ─────────────────────────────────────────────

function getLearnedThresholds(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE instrument = 'THRESHOLDS'"
    ).get();
    if (row) {
      const stored = JSON.parse(row.params_json);
      // Merge stored with defaults so new strategies always have a value
      const defaults = {};
      for (const [k, b] of Object.entries(THRESHOLD_BOUNDS)) defaults[k] = b.default;
      return { ...defaults, ...stored };
    }
  } catch {}
  const defaults = {};
  for (const [k, b] of Object.entries(THRESHOLD_BOUNDS)) defaults[k] = b.default;
  return defaults;
}

function getLearnedThreshold(db, strategyName, fallback) {
  const all = getLearnedThresholds(db);
  return all[strategyName] ?? fallback;
}

/**
 * Adjust per-strategy confidence thresholds based on backtest win rates.
 *
 * Learning rules:
 *   WR < 35%  → +4 pts  (very poor — tighten hard)
 *   WR < 45%  → +3 pts  (poor — tighten)
 *   WR < 52%  → +1 pt   (below average — nudge up)
 *   WR 52–58% → no change
 *   WR 58–65% → -1 pt   (decent — slightly lower to get more signals)
 *   WR 65–72% → -2 pts  (good — lower threshold)
 *   WR > 72%  → -3 pts  (excellent — cast wider net)
 *
 * @param {object} db
 * @param {object} btMetricsByStrategy - { strategyName: { winRate, tradeCount } }
 * @returns {{ thresholds, changes }}
 */
function updateLearnedThresholds(db, btMetricsByStrategy) {
  const current = getLearnedThresholds(db);
  const changes = {};

  for (const [strat, metrics] of Object.entries(btMetricsByStrategy)) {
    const bounds = THRESHOLD_BOUNDS[strat];
    if (!bounds) continue;
    if ((metrics.tradeCount ?? 0) < MIN_SAMPLE) continue;

    const wr     = metrics.winRate ?? 0;
    const thresh = current[strat] ?? bounds.default;
    let delta    = 0;

    if      (wr < 0.35) delta = +4;
    else if (wr < 0.45) delta = +3;
    else if (wr < 0.52) delta = +1;
    else if (wr >= 0.72) delta = -3;
    else if (wr >= 0.65) delta = -2;
    else if (wr >= 0.58) delta = -1;

    if (delta !== 0) {
      const newVal = Math.max(bounds.min, Math.min(bounds.max, thresh + delta));
      changes[strat] = {
        from:   thresh,
        to:     newVal,
        wr:     +(wr * 100).toFixed(1),
        trades: metrics.tradeCount,
        delta,
      };
      current[strat] = newVal;
    }
  }

  if (Object.keys(changes).length > 0) {
    db.prepare(`
      INSERT INTO strategy_params (instrument, params_json, updated_at, version)
      VALUES ('THRESHOLDS', ?, datetime('now'), 1)
      ON CONFLICT(instrument) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = excluded.updated_at,
        version     = version + 1
    `).run(JSON.stringify(current));
  }

  return { thresholds: current, changes };
}

// ── Aggregate backtest win rates (last N runs) ────────────────────────────────
/**
 * Compute per-strategy win rates from backtest_trades for the last N runs
 * of the given instrument. Used to seed learning before live trade data builds up.
 */
function getBacktestWinRates(db, instrument, lastNRuns = 3) {
  try {
    const rows = db.prepare(`
      SELECT t.strategy_name,
             COUNT(*)                                            AS total,
             SUM(CASE WHEN t.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM   backtest_trades t
      WHERE  t.instrument = ?
        AND  t.run_id IN (
          SELECT id FROM backtest_runs
          WHERE  instrument = ?
          ORDER  BY run_at DESC
          LIMIT  ?
        )
      GROUP  BY t.strategy_name
      HAVING total >= ?
    `).all(instrument, instrument, lastNRuns, MIN_SAMPLE);

    const result = {};
    for (const r of rows) {
      result[r.strategy_name] = {
        winRate:    r.total > 0 ? r.wins / r.total : 0,
        tradeCount: r.total,
      };
    }
    return result;
  } catch {
    return {};
  }
}

// ── Per-setup adaptive deltas (live signals) ──────────────────────────────────

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
    if      (wr >= 0.70) deltas[setup] = -2;
    else if (wr <= 0.40) deltas[setup] = +4;
  }
  return deltas;
}

// ── Per-style adaptive deltas (live signals) ──────────────────────────────────

function computeAdaptiveDeltasByStyle(db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT s.setup, s.trade_style, o.result
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now', '-30 days')
      ORDER  BY s.received_at DESC
      LIMIT  ?
    `).all(WINDOW);
  } catch {
    return {};
  }

  if (rows.length < MIN_SAMPLE) return {};

  const byStyleSetup = {};
  for (const r of rows) {
    const k = `${r.trade_style || 'unknown'}::${r.setup || 'unknown'}`;
    if (!byStyleSetup[k]) byStyleSetup[k] = { wins: 0, total: 0 };
    byStyleSetup[k].total++;
    if (r.result === 'WIN') byStyleSetup[k].wins++;
  }

  const deltas = {};
  for (const [key, { wins, total }] of Object.entries(byStyleSetup)) {
    if (total < MIN_SAMPLE) continue;
    const wr = wins / total;
    if      (wr >= 0.70) deltas[key] = -2;
    else if (wr <= 0.40) deltas[key] = +4;
  }
  return deltas;
}

// ── Market regime (last 15 resolved trades) ───────────────────────────────────

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
  return wr >= 0.60 ? 'trending' : wr <= 0.38 ? 'choppy' : 'mixed';
}

// ── Adaptive min-score (fixed to work on 0-100 confidence scale) ──────────────
/**
 * Returns the adjusted minimum confidence for a given setup/style.
 *
 * Previously broken: was capping output at 28 even when called with 0-100 scale values.
 * Now detects scale automatically and returns values in the same range.
 *
 * @param {object} db
 * @param {string} setup
 * @param {string|number} style
 * @param {number} baseMin  - base threshold (0-100 confidence scale OR legacy 0-25 scale)
 */
function getAdaptiveMinScore(db, setup, style, baseMin = 16) {
  if (typeof style === 'number') { baseMin = style; style = undefined; }

  try {
    const setupDeltas = computeAdaptiveDeltas(db);
    const styleDeltas = style ? computeAdaptiveDeltasByStyle(db) : {};
    const regime      = getMarketRegime(db);

    const setupDelta  = setupDeltas[setup] ?? 0;
    const styleKey    = style ? `${style}::${setup}` : null;
    const styleDelta  = styleKey ? (styleDeltas[styleKey] ?? 0) : 0;

    const combinedDelta = Math.max(setupDelta, styleDelta);
    const regimeDelta   = regime === 'choppy' ? 2 : 0;

    // Auto-detect scale: confidence 0-100 vs legacy 0-25
    if (baseMin > 30) {
      // 0-100 confidence scale — scale up delta proportionally
      const scaledDelta = (combinedDelta + regimeDelta) * 3;
      return Math.max(50, Math.min(85, Math.round(baseMin + scaledDelta)));
    }
    return Math.max(12, Math.min(28, baseMin + combinedDelta + regimeDelta));
  } catch {
    return baseMin;
  }
}

// ── Per-style performance stats ───────────────────────────────────────────────

function getStylePerformance(db) {
  try {
    return db.prepare(`
      SELECT s.trade_style,
             COUNT(*)                                                        AS total,
             SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)               AS wins,
             ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100,1) AS win_pct
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= datetime('now','-30 days')
      GROUP  BY s.trade_style
      ORDER  BY win_pct DESC
    `).all();
  } catch {
    return [];
  }
}

// ── Full learning stats for /api/learning ─────────────────────────────────────

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

  // Also pull backtest win rates by strategy for the last 5 runs
  const btByStrategy = {};
  try {
    const btRows = db.prepare(`
      SELECT t.strategy_name,
             COUNT(*)                                            AS total,
             SUM(CASE WHEN t.outcome='WIN' THEN 1 ELSE 0 END)  AS wins
      FROM   backtest_trades t
      WHERE  t.run_id IN (
        SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 5
      )
      GROUP  BY t.strategy_name
    `).all();
    for (const r of btRows) {
      btByStrategy[r.strategy_name] = {
        total:   r.total,
        wins:    r.wins,
        win_pct: r.total > 0 ? +(r.wins / r.total * 100).toFixed(1) : 0,
      };
    }
  } catch {}

  return {
    bySetup,
    bySession,
    byHtf,
    byStyle:            getStylePerformance(db),
    adaptiveDeltas:     computeAdaptiveDeltas(db),
    learnedThresholds:  getLearnedThresholds(db),
    btByStrategy,
    regime:             getMarketRegime(db),
    windowTrades:       WINDOW,
  };
}

module.exports = {
  getAdaptiveMinScore,
  getLearnedThreshold,
  getLearnedThresholds,
  updateLearnedThresholds,
  getBacktestWinRates,
  getLearningStats,
  getMarketRegime,
  getStylePerformance,
  computeAdaptiveDeltas,
  computeAdaptiveDeltasByStyle,
  THRESHOLD_BOUNDS,
};
