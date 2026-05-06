'use strict';

const WINDOW     = 150;  // last N resolved trades to analyse (was 60 — more history = better adaptive thresholds)
const MIN_SAMPLE = 10;   // minimum trades needed before adjusting thresholds

// ── Per-setup adaptive deltas ─────────────────────────────────────────────────

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
    if      (wr >= 0.70) deltas[setup] = -2;   // hot setup: lower threshold
    else if (wr <= 0.40) deltas[setup] = +4;   // cold setup: raise threshold
  }
  return deltas;
}

// ── Per-style adaptive deltas ─────────────────────────────────────────────────

function computeAdaptiveDeltasByStyle(db) {
  // Uses raw_payload JSON if trade_style column not present (migration-safe)
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
    // Column doesn't exist yet — fall back to setup-only deltas
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

// ── Adaptive min-score (setup + style aware) ──────────────────────────────────
/**
 * Returns the adjusted minimum score for a given setup and optional trade style.
 * Choppy regime adds a further +2 penalty across all setups.
 * @param {Object} db
 * @param {string} setup       - e.g. 'OTE PB', 'STDV REV'
 * @param {string} [style]     - 'scalp' | 'intraday' | 'swing' | undefined
 * @param {number} [baseMin]   - base minimum score (default 16)
 */
function getAdaptiveMinScore(db, setup, style, baseMin = 16) {
  // Handle legacy 3-arg call: (db, setup, baseMin)
  if (typeof style === 'number') { baseMin = style; style = undefined; }

  try {
    const setupDeltas = computeAdaptiveDeltas(db);
    const styleDeltas = style ? computeAdaptiveDeltasByStyle(db) : {};
    const regime      = getMarketRegime(db);

    const setupDelta  = setupDeltas[setup] ?? 0;
    const styleKey    = style ? `${style}::${setup}` : null;
    const styleDelta  = styleKey ? (styleDeltas[styleKey] ?? 0) : 0;

    // Use the more conservative (larger) of the two deltas to avoid false positives
    const combinedDelta = Math.max(setupDelta, styleDelta);
    const regimeDelta   = regime === 'choppy' ? 2 : 0;

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

  return {
    bySetup,
    bySession,
    byHtf,
    byStyle:        getStylePerformance(db),
    adaptiveDeltas: computeAdaptiveDeltas(db),
    regime:         getMarketRegime(db),
    windowTrades:   WINDOW,
  };
}

module.exports = {
  getAdaptiveMinScore,
  getLearningStats,
  getMarketRegime,
  getStylePerformance,
  computeAdaptiveDeltas,
  computeAdaptiveDeltasByStyle,
};
