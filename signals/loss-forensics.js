'use strict';

/**
 * LOSS FORENSICS ENGINE — v1.0
 *
 * Classifies every losing or expired trade into a failure taxonomy,
 * writes structured forensic records, and detects recurring loss clusters.
 *
 * This is a core moat component — labeled proprietary failure data cannot
 * be replicated by competitors starting from scratch.
 */

const CLASSIFIER_VERSION = '1.0';

// ── Failure taxonomy ──────────────────────────────────────────────────────────

const CATEGORIES = {
  CHOP_FAKEOUT:       'chop_fakeout',
  WEAK_BREAKOUT:      'weak_breakout',
  LATE_ENTRY:         'late_entry',
  TREND_EXHAUSTION:   'trend_exhaustion',
  VOLATILITY_SPIKE:   'volatility_spike_stopout',
  LOW_LIQUIDITY:      'low_liquidity_trap',
  HTF_MISMATCH:       'htf_bias_mismatch',
  VWAP_FAILURE:       'vwap_failure',
  POOR_STOP:          'poor_stop_placement',
  REGIME_MISMATCH:    'regime_mismatch',
  POOR_TARGET:        'poor_target_quality',
  CONFIDENCE_ERROR:   'confidence_model_error',
  TIMING_LAG:         'timing_lag',
  MICROSTRUCTURE:     'microstructure_noise',
};

// Sessions classified as low-liquidity
const LOW_LIQ_SESSIONS = new Set([
  'OVERNIGHT', 'ASIAN', 'PRE_MARKET', 'WEEKEND', 'BLACKOUT',
]);

// Regimes where chop is the likely cause
const CHOP_REGIMES = new Set([
  'RANGE_CHOP', 'SOFT_CHOP', 'ranging',
]);

// ── MFE / MAE computation ─────────────────────────────────────────────────────

/**
 * Compute Maximum Favorable Excursion and Maximum Adverse Excursion
 * from the bars between signal time and exit time.
 *
 * @param {object[]} futureBars - bars after signal (chronological)
 * @param {object}   sig        - { entry, direction, received_at }
 * @param {object}   exitBar    - bar where outcome was resolved (may be null)
 * @returns {{ mfePts: number|null, maePts: number|null, holdTimeMin: number|null }}
 */
function computeMfeMae(futureBars, sig, exitBar) {
  if (!futureBars || futureBars.length === 0 || sig.entry == null) {
    return { mfePts: null, maePts: null, holdTimeMin: null };
  }

  const sigTimeMs  = new Date(sig.received_at).getTime();
  const exitTimeMs = exitBar ? new Date(exitBar.timestamp).getTime() : Infinity;
  const isBull     = sig.direction === 'LONG';

  let maxFav = 0;
  let maxAdv = 0;

  for (const b of futureBars) {
    const bMs = new Date(b.timestamp).getTime();
    if (bMs > exitTimeMs) break;
    if (b.high == null || b.low == null) continue;

    const fav = isBull ? b.high - sig.entry : sig.entry - b.low;
    const adv = isBull ? sig.entry - b.low  : b.high - sig.entry;
    if (fav > maxFav) maxFav = fav;
    if (adv > maxAdv) maxAdv = adv;
  }

  const holdTimeMin = exitBar
    ? +((exitTimeMs - sigTimeMs) / 60000).toFixed(1)
    : null;

  return {
    mfePts:      +maxFav.toFixed(2),
    maePts:      +maxAdv.toFixed(2),
    holdTimeMin,
  };
}

// ── Failure classifier ────────────────────────────────────────────────────────

/**
 * Classify the failure mode of a losing or expired trade.
 *
 * Priority order: most specific / actionable first.
 *
 * @param {object} sig      - signal DB row (direction, session, confidence, quant_score, htf_bias, strategy_name)
 * @param {string} result   - 'LOSS' | 'EXPIRED' | 'BE'
 * @param {object} ctx      - { mfePts, maePts, holdTimeMin, pnlPts, regime, atr }
 * @returns {{ category: string, subcategory: string }}
 */
function classifyFailure(sig, result, ctx = {}) {
  const { mfePts, maePts, holdTimeMin, pnlPts, regime, atr } = ctx;
  const dir       = sig.direction  ?? '';
  const session   = sig.session    ?? '';
  const htfBias   = sig.htf_bias   ?? '';
  const conf      = sig.confidence ?? null;
  const qScore    = sig.quant_score ?? null;
  const slDist    = sig.entry != null && sig.sl != null ? Math.abs(sig.entry - sig.sl) : null;

  // 1. Immediate rejection — price never moved in our favour
  if (holdTimeMin != null && holdTimeMin < 3 && maePts != null && slDist != null && maePts > 0.6 * slDist) {
    return { category: CATEGORIES.TIMING_LAG, subcategory: 'immediate_rejection' };
  }

  // 2. Volatility spike — MAE far exceeded ATR (news shock / spike-out)
  if (maePts != null && atr != null && maePts > 2.0 * atr) {
    return { category: CATEGORIES.VOLATILITY_SPIKE, subcategory: 'atm_expansion' };
  }

  // 3. HTF bias conflict — entered counter-trend
  if (dir === 'LONG' && (htfBias === 'BEAR' || htfBias === 'MIXED')) {
    return { category: CATEGORIES.HTF_MISMATCH, subcategory: 'counter_trend_long' };
  }
  if (dir === 'SHORT' && (htfBias === 'BULL' || htfBias === 'MIXED')) {
    return { category: CATEGORIES.HTF_MISMATCH, subcategory: 'counter_trend_short' };
  }

  // 4. Chop regime — entered in known chop
  if (CHOP_REGIMES.has(regime)) {
    return { category: CATEGORIES.CHOP_FAKEOUT, subcategory: regime };
  }

  // 5. Low liquidity session
  if (LOW_LIQ_SESSIONS.has(session?.toUpperCase())) {
    return { category: CATEGORIES.LOW_LIQUIDITY, subcategory: session.toLowerCase() };
  }

  // 6. No follow-through — MFE tiny relative to SL distance (entered at exhaustion)
  if (mfePts != null && slDist != null && mfePts < 0.15 * slDist) {
    return { category: CATEGORIES.TREND_EXHAUSTION, subcategory: 'no_follow_through' };
  }

  // 7. Weak momentum — low quant score signals poor setup quality
  if (qScore != null && qScore < 62) {
    return { category: CATEGORIES.CONFIDENCE_ERROR, subcategory: `quant_score_${qScore}` };
  }

  // 8. Low confidence threshold edge case
  if (conf != null && conf < 65) {
    return { category: CATEGORIES.CONFIDENCE_ERROR, subcategory: `confidence_${conf}` };
  }

  // 9. Regime mismatch (known mismatched regime types)
  if (regime && regime !== 'unknown' && !['TREND_BULL', 'TREND_BEAR', 'NORMAL', 'EXPANSION'].includes(regime)) {
    return { category: CATEGORIES.REGIME_MISMATCH, subcategory: regime };
  }

  // 10. Expired without reaching TP — target may be too wide
  if (result === 'EXPIRED') {
    return { category: CATEGORIES.POOR_TARGET, subcategory: 'expired_without_tp' };
  }

  // Default
  return { category: CATEGORIES.MICROSTRUCTURE, subcategory: 'unclassified' };
}

// ── Forensic writer ───────────────────────────────────────────────────────────

/**
 * Write a forensic record for a losing or expired trade.
 * Safe to call multiple times — idempotent on (signal_id) via OR IGNORE.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} sig      - signal DB row
 * @param {string} result   - 'LOSS' | 'EXPIRED' | 'BE'
 * @param {object} ctx      - { mfePts, maePts, holdTimeMin, pnlPts, regime, atr, futureBars, exitBar }
 * @returns {{ category: string, subcategory: string }|null}
 */
function writeLossForensic(db, sig, result, ctx = {}) {
  if (!['LOSS', 'EXPIRED', 'BE'].includes(result)) return null;

  try {
    const classification = classifyFailure(sig, result, ctx);

    // Extract day-of-week from signal timestamp
    const createdAt = new Date(sig.received_at ?? Date.now());
    const dayOfWeek = createdAt.getDay(); // 0=Sun

    // Extract regime from raw_payload if not passed directly
    let regime = ctx.regime ?? null;
    if (!regime && sig.raw_payload) {
      try {
        const raw = JSON.parse(sig.raw_payload);
        regime = raw?.meta?.regime ?? raw?.regime ?? null;
      } catch {}
    }

    db.prepare(`
      INSERT OR IGNORE INTO loss_forensics (
        signal_id, strategy_name, instrument, direction, result,
        failure_category, failure_subcategory, classifier_version,
        session, day_of_week, regime, htf_bias,
        confidence, quant_score, quant_grade,
        setup_type, hold_time_min, mfe_pts, mae_pts, pnl_pts,
        entry, sl, auto_flagged
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, 0
      )
    `).run(
      sig.id,
      sig.strategy_name ?? null,
      sig.instrument    ?? null,
      sig.direction     ?? null,
      result,
      classification.category,
      classification.subcategory ?? null,
      CLASSIFIER_VERSION,
      sig.session    ?? null,
      dayOfWeek,
      regime,
      sig.htf_bias   ?? null,
      sig.confidence ?? null,
      sig.quant_score ?? null,
      sig.quant_grade ?? null,
      sig.setup       ?? sig.setup_type ?? null,
      ctx.holdTimeMin ?? null,
      ctx.mfePts      ?? null,
      ctx.maePts      ?? null,
      ctx.pnlPts      ?? null,
      sig.entry ?? null,
      sig.sl    ?? null,
    );

    // Also write failure_reason to outcomes table for easy joins
    try {
      db.prepare(`UPDATE outcomes SET failure_reason = ? WHERE signal_id = ?`)
        .run(classification.category, sig.id);
    } catch {}

    return classification;
  } catch (err) {
    console.error(`[loss-forensics] write failed for signal ${sig.id}:`, err.message);
    return null;
  }
}

// ── Cluster detector ──────────────────────────────────────────────────────────

/**
 * Detect recurring failure patterns for a strategy.
 * Looks at the last `windowN` loss forensics records.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} strategyName
 * @param {number} [windowN=10]
 * @returns {object|null} cluster warning or null
 */
function detectClusters(db, strategyName, windowN = 10) {
  try {
    const rows = db.prepare(`
      SELECT failure_category, failure_subcategory, session, regime, created_at
      FROM   loss_forensics
      WHERE  strategy_name = ?
      ORDER  BY created_at DESC
      LIMIT  ?
    `).all(strategyName, windowN);

    if (rows.length < 3) return null;

    // Count by category
    const byCategory = {};
    for (const r of rows) {
      byCategory[r.failure_category] = (byCategory[r.failure_category] ?? 0) + 1;
    }

    const entries   = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const [topCat, topCount] = entries[0];

    if (topCount < 3) return null;

    const cluster = {
      type:      'LOSS_CLUSTER_DETECTED',
      strategy:  strategyName,
      category:  topCat,
      count:     topCount,
      total:     rows.length,
      pct:       Math.round((topCount / rows.length) * 100),
    };

    // Check for consecutive run (all same category in last 3)
    const last3 = rows.slice(0, 3).map(r => r.failure_category);
    if (last3.every(c => c === topCat)) {
      cluster.type = 'EDGE_DEGRADATION_WARNING';
      cluster.consecutive = 3;
    }

    return cluster;
  } catch {
    return null;
  }
}

/**
 * Get a plain-text cluster summary for logging.
 */
function formatClusterLog(cluster) {
  if (!cluster) return null;
  return `${cluster.type} strategy=${cluster.strategy} category=${cluster.category} count=${cluster.count}/${cluster.total} (${cluster.pct}%)${cluster.consecutive ? ` consecutive=${cluster.consecutive}` : ''}`;
}

/**
 * Get a forensics summary for a strategy over the last N days.
 * Used in reports and health dashboards.
 */
function getForensicsSummary(db, strategyName, days = 14) {
  try {
    const rows = db.prepare(`
      SELECT
        failure_category,
        COUNT(*)                        AS count,
        AVG(hold_time_min)              AS avg_hold,
        AVG(mfe_pts)                    AS avg_mfe,
        AVG(mae_pts)                    AS avg_mae,
        AVG(confidence)                 AS avg_conf,
        AVG(quant_score)                AS avg_quant
      FROM   loss_forensics
      WHERE  strategy_name = ?
        AND  created_at >= datetime('now', ?)
      GROUP  BY failure_category
      ORDER  BY count DESC
    `).all(strategyName, `-${days} days`);

    return rows;
  } catch {
    return [];
  }
}

module.exports = {
  classifyFailure,
  writeLossForensic,
  computeMfeMae,
  detectClusters,
  formatClusterLog,
  getForensicsSummary,
  CATEGORIES,
  CLASSIFIER_VERSION,
};
