'use strict';

const WINDOW    = 60;   // last N resolved trades to analyse
const MIN_SAMPLE = 10;  // minimum trades needed before adjusting thresholds

/**
 * Compute per-setup score delta based on recent win rates.
 *   win rate ≥ 70 % → lower threshold by 2  (setup is hot, capture more signals)
 *   win rate ≤ 40 % → raise  threshold by 4  (setup is cold, be more selective)
 *   40–70 %         → no change
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
    if      (wr >= 0.70) deltas[setup] = -2;
    else if (wr <= 0.40) deltas[setup] = +4;
  }
  return deltas;
}

/**
 * Current market regime based on the last 15 resolved trades.
 * trending → recent win rate ≥ 60 %
 * choppy   → recent win rate ≤ 38 %
 * mixed    → in between
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
  return wr >= 0.60 ? 'trending' : wr <= 0.38 ? 'choppy' : 'mixed';
}

/**
 * Return the adjusted minimum score for a given setup type.
 * Choppy regime adds a further +2 penalty across all setups.
 */
function getAdaptiveMinScore(db, setup, baseMin = 16) {
  try {
    const deltas = computeAdaptiveDeltas(db);
    const regime = getMarketRegime(db);
    const delta  = (deltas[setup] ?? 0) + (regime === 'choppy' ? 2 : 0);
    return Math.max(12, Math.min(28, baseMin + delta));
  } catch {
    return baseMin;
  }
}

/**
 * Full learning stats for the /api/learning endpoint.
 */
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
    adaptiveDeltas: computeAdaptiveDeltas(db),
    regime:         getMarketRegime(db),
    windowTrades:   WINDOW,
  };
}

module.exports = { getAdaptiveMinScore, getLearningStats, getMarketRegime };
