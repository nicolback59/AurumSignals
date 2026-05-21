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
  NEWS_IMPULSE:       'news_impulse',
  LOW_LIQUIDITY:      'low_liquidity_trap',
  LIQUIDITY_SWEEP:    'liquidity_sweep_failure',
  HTF_MISMATCH:       'htf_bias_mismatch',
  VWAP_FAILURE:       'vwap_failure',
  POOR_STOP:          'poor_stop_placement',
  REGIME_MISMATCH:    'regime_mismatch',
  POOR_TARGET:        'poor_target_quality',
  CONFIDENCE_ERROR:   'confidence_model_error',
  TIMING_LAG:         'timing_lag',
  SCANNER_DELAY:      'scanner_delay',
  DUPLICATE_EFFECT:   'duplicate_signal_side_effect',
  EXECUTION_DRIFT:    'execution_drift',
  MICROSTRUCTURE:     'microstructure_noise',
};

// Sessions near high-impact news windows (ET hours in minutes)
// 8:30 ET = NFP/CPI/PPI/Jobless, 10:00 ET = ISM/JOLTS, 14:00 ET = Fed decisions
const NEWS_RISK_SESSIONS = new Set(['PRE_MARKET', 'NY_OPEN', 'NY_OPEN_DRIVE']);

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
  const dir       = sig.direction   ?? '';
  const session   = (sig.session    ?? '').toUpperCase();
  const htfBias   = sig.htf_bias    ?? '';
  const conf      = sig.confidence  ?? null;
  const qScore    = sig.quant_score ?? null;
  const slDist    = sig.entry != null && sig.sl != null ? Math.abs(sig.entry - sig.sl) : null;

  // 1. Immediate rejection — price hit SL within 3 min of entry (bad timing / stale data)
  if (holdTimeMin != null && holdTimeMin < 3 && maePts != null && slDist != null && maePts > 0.6 * slDist) {
    return { category: CATEGORIES.TIMING_LAG, subcategory: 'immediate_rejection' };
  }

  // 2. Volatility spike — MAE far exceeded ATR (news shock / spike-out)
  if (maePts != null && atr != null && maePts > 2.0 * atr) {
    return { category: CATEGORIES.VOLATILITY_SPIKE, subcategory: 'atr_expansion' };
  }

  // 3. News impulse session — high-risk window where macro events dominate
  if (NEWS_RISK_SESSIONS.has(session) && result === 'LOSS') {
    return { category: CATEGORIES.NEWS_IMPULSE, subcategory: session.toLowerCase() };
  }

  // 4. HTF bias conflict — entered counter-trend
  if (dir === 'LONG' && (htfBias === 'BEAR' || htfBias === 'MIXED')) {
    return { category: CATEGORIES.HTF_MISMATCH, subcategory: 'counter_trend_long' };
  }
  if (dir === 'SHORT' && (htfBias === 'BULL' || htfBias === 'MIXED')) {
    return { category: CATEGORIES.HTF_MISMATCH, subcategory: 'counter_trend_short' };
  }

  // 5. Chop regime — entered in known chop
  if (CHOP_REGIMES.has(regime)) {
    return { category: CATEGORIES.CHOP_FAKEOUT, subcategory: regime };
  }

  // 6. Low liquidity session
  if (LOW_LIQ_SESSIONS.has(session)) {
    return { category: CATEGORIES.LOW_LIQUIDITY, subcategory: session.toLowerCase() };
  }

  // 7. Oversized stop — stop distance greatly exceeds ATR (stop will never hit cleanly)
  if (slDist != null && atr != null && slDist > 2.5 * atr) {
    return { category: CATEGORIES.POOR_STOP, subcategory: 'stop_too_wide' };
  }

  // 8. Liquidity sweep — price briefly exceeded SL then reversed (trap pattern)
  //    Proxy: MAE > SL distance but MFE was substantial (entered then swept)
  if (maePts != null && slDist != null && mfePts != null &&
      maePts > slDist && mfePts > 0.5 * slDist) {
    return { category: CATEGORIES.LIQUIDITY_SWEEP, subcategory: 'sl_sweep_reversal' };
  }

  // 9. Weak breakout — price moved partway then failed (30–70% of SL as MFE)
  if (mfePts != null && slDist != null && mfePts >= 0.3 * slDist && mfePts < 0.7 * slDist) {
    return { category: CATEGORIES.WEAK_BREAKOUT, subcategory: 'partial_move_failure' };
  }

  // 10. No follow-through — MFE tiny relative to SL distance (entered at exhaustion)
  if (mfePts != null && slDist != null && mfePts < 0.15 * slDist) {
    return { category: CATEGORIES.TREND_EXHAUSTION, subcategory: 'no_follow_through' };
  }

  // 11. Late entry — long hold time suggests entered too late in the move
  if (holdTimeMin != null && holdTimeMin > 180 && result === 'LOSS') {
    return { category: CATEGORIES.LATE_ENTRY, subcategory: `held_${Math.round(holdTimeMin)}min` };
  }

  // 12. Regime mismatch
  if (regime && regime !== 'unknown' && !['TREND_BULL', 'TREND_BEAR', 'NORMAL', 'EXPANSION'].includes(regime)) {
    return { category: CATEGORIES.REGIME_MISMATCH, subcategory: regime };
  }

  // 13. Weak momentum — low quant score signals poor setup quality
  if (qScore != null && qScore < 62) {
    return { category: CATEGORIES.CONFIDENCE_ERROR, subcategory: `low_quant_${qScore}` };
  }

  // 14. Low confidence threshold
  if (conf != null && conf < 65) {
    return { category: CATEGORIES.CONFIDENCE_ERROR, subcategory: `low_confidence_${conf}` };
  }

  // 15. Expired without reaching TP — target may be too wide or market moved away
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
      SELECT failure_category, failure_subcategory, session, regime, day_of_week, created_at
      FROM   loss_forensics
      WHERE  strategy_name = ?
      ORDER  BY created_at DESC
      LIMIT  ?
    `).all(strategyName, windowN);

    if (rows.length < 3) return null;

    // ── Category cluster ────────────────────────────────────────────────────────
    const byCategory = {};
    for (const r of rows) {
      byCategory[r.failure_category] = (byCategory[r.failure_category] ?? 0) + 1;
    }
    const catEntries    = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const [topCat, topCount] = catEntries[0];

    // ── Session cluster ─────────────────────────────────────────────────────────
    const bySession = {};
    for (const r of rows) {
      if (!r.session) continue;
      bySession[r.session] = (bySession[r.session] ?? 0) + 1;
    }
    const topSession = Object.entries(bySession).sort((a, b) => b[1] - a[1])[0];

    // ── Regime cluster ──────────────────────────────────────────────────────────
    const byRegime = {};
    for (const r of rows) {
      if (!r.regime) continue;
      byRegime[r.regime] = (byRegime[r.regime] ?? 0) + 1;
    }
    const topRegime = Object.entries(byRegime).sort((a, b) => b[1] - a[1])[0];

    // ── Day-of-week cluster ─────────────────────────────────────────────────────
    const byDow = {};
    const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const r of rows) {
      if (r.day_of_week == null) continue;
      byDow[r.day_of_week] = (byDow[r.day_of_week] ?? 0) + 1;
    }
    const topDow = Object.entries(byDow).sort((a, b) => b[1] - a[1])[0];

    // No strong pattern
    if (topCount < 3 && (!topSession || topSession[1] < 4) && (!topRegime || topRegime[1] < 4)) {
      return null;
    }

    const cluster = {
      strategy:  strategyName,
      total:     rows.length,
      patterns:  [],
    };

    // Category pattern
    if (topCount >= 3) {
      const last3 = rows.slice(0, 3).map(r => r.failure_category);
      const isConsecutive = last3.every(c => c === topCat);
      cluster.patterns.push({
        dimension: 'category',
        value:     topCat,
        count:     topCount,
        pct:       Math.round((topCount / rows.length) * 100),
        consecutive: isConsecutive ? 3 : 0,
      });
    }

    // Session pattern
    if (topSession && topSession[1] >= 3) {
      cluster.patterns.push({
        dimension: 'session',
        value:     topSession[0],
        count:     topSession[1],
        pct:       Math.round((topSession[1] / rows.length) * 100),
      });
    }

    // Regime pattern
    if (topRegime && topRegime[1] >= 3) {
      cluster.patterns.push({
        dimension: 'regime',
        value:     topRegime[0],
        count:     topRegime[1],
        pct:       Math.round((topRegime[1] / rows.length) * 100),
      });
    }

    // Day-of-week pattern
    if (topDow && topDow[1] >= 3) {
      cluster.patterns.push({
        dimension: 'day_of_week',
        value:     DOW_NAMES[Number(topDow[0])] ?? topDow[0],
        count:     topDow[1],
        pct:       Math.round((topDow[1] / rows.length) * 100),
      });
    }

    if (!cluster.patterns.length) return null;

    // Severity
    const hasCatConsecutive = cluster.patterns.find(p => p.dimension === 'category' && p.consecutive >= 3);
    const multiDimension    = cluster.patterns.length >= 2;
    cluster.type = hasCatConsecutive
      ? 'EDGE_DEGRADATION_WARNING'
      : multiDimension
        ? 'STRATEGY_REGIME_MISMATCH'
        : 'LOSS_CLUSTER_DETECTED';

    // Top-level summary for backwards-compat
    cluster.category  = cluster.patterns[0].value;
    cluster.count     = cluster.patterns[0].count;
    cluster.pct       = cluster.patterns[0].pct;
    cluster.consecutive = hasCatConsecutive?.consecutive ?? 0;

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
  const patterns = (cluster.patterns ?? [])
    .map(p => `${p.dimension}=${p.value}(${p.count}/${cluster.total} ${p.pct}%)`)
    .join(' ');
  return `${cluster.type} strategy=${cluster.strategy} ${patterns}${cluster.consecutive ? ` consecutive=${cluster.consecutive}` : ''}`;
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
