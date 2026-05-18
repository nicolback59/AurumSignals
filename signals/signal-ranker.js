'use strict';

/**
 * SIGNAL RANKER — institutional tier scoring + session-adaptive gate
 *
 * Takes a raw strategy signal (already passed strategy-level confidence
 * filters) and produces an institutional tier rating:
 *
 *   S   — confidence ≥ 86  (highest conviction)
 *   A   — confidence ≥ 72
 *   B   — confidence ≥ 58
 *   IGNORE — confidence < 58
 *
 * Session-adaptive minimum tier (from market-clock):
 *   NY_OPEN / POWER_HOUR : B  (most permissive — peak liquidity)
 *   LONDON               : B
 *   NY_PRE               : A
 *   MIDDAY               : A
 *   NY_CLOSE             : A
 *   ASIAN                : S  (thin liquidity — highest bar only)
 *   OVERNIGHT            : IGNORE (no trades)
 *   BLACKOUT             : IGNORE
 *
 * The ranker also applies a session confidence modifier to the raw score
 * before tiering (e.g. NY_OPEN multiplies by 1.15, boosting borderline
 * signals; ASIAN multiplies by 0.80, making it harder to reach S).
 */

const { classifyNow }   = require('../clock/market-clock');
const { LIVE_THRESHOLDS } = require('../strategies/confidence-scorer');

// Tier thresholds (confidence 0–100)
const TIER_THRESHOLDS = {
  S:      86,
  A:      72,
  B:      58,
  IGNORE: 0,
};

// Tier order for comparison (higher index = higher requirement)
const TIER_ORDER = ['IGNORE', 'B', 'A', 'S'];

/**
 * Get the tier label for a given (adjusted) confidence score.
 */
function confidenceToTier(confidence) {
  if (confidence >= TIER_THRESHOLDS.S) return 'S';
  if (confidence >= TIER_THRESHOLDS.A) return 'A';
  if (confidence >= TIER_THRESHOLDS.B) return 'B';
  return 'IGNORE';
}

/**
 * Return true if `tier` meets or exceeds `minTier`.
 */
function tierMeetsMinimum(tier, minTier) {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minTier);
}

/**
 * Rank a signal and decide whether to accept it.
 *
 * Returns `liveGated: true` when the signal passes the session/tier gate but
 * falls below the per-strategy LIVE_THRESHOLDS.  Live-gated signals are stored
 * for backtest/research but must NOT fire a live ntfy notification.
 *
 * @param {object} sig     - raw strategy signal
 * @param {Date|null} [now] - optional override for testing
 * @returns {{
 *   accepted:           boolean,
 *   liveGated:          boolean,
 *   tier:               'S'|'A'|'B'|'IGNORE',
 *   adjustedConfidence: number,
 *   session:            string,
 *   sessionModifier:    number,
 *   minTier:            string,
 *   rejectReason:       string|null,
 * }}
 */
function rankSignal(sig, now = null) {
  const clock      = classifyNow(now);
  const session    = clock.session;
  const sessionMod = clock.meta?.confidenceModifier ?? 1.0;
  const minTier    = clock.meta?.minTier ?? 'IGNORE';

  // Hard blackout — never accept
  if (clock.isBlackout || minTier === 'IGNORE') {
    return {
      accepted:           false,
      liveGated:          false,
      tier:               'IGNORE',
      adjustedConfidence: 0,
      session,
      sessionModifier:    sessionMod,
      minTier,
      rejectReason:       `session ${session} — market blackout/IGNORE`,
    };
  }

  // Apply session modifier to raw confidence (floor 0, cap 100)
  const adjustedConfidence = Math.min(100, Math.max(0, Math.round(sig.confidence * sessionMod)));
  const tier = confidenceToTier(adjustedConfidence);

  if (!tierMeetsMinimum(tier, minTier)) {
    return {
      accepted:           false,
      liveGated:          false,
      tier,
      adjustedConfidence,
      session,
      sessionModifier:    sessionMod,
      minTier,
      rejectReason:       `tier ${tier} below session minimum ${minTier} (adj confidence ${adjustedConfidence})`,
    };
  }

  // Per-strategy live confidence gate — signal is accepted (stored) but live
  // ntfy is suppressed when raw confidence is below the strategy's live minimum.
  const liveMin  = LIVE_THRESHOLDS[sig.strategy_name] ?? 0;
  const liveGated = sig.confidence != null && sig.confidence < liveMin;

  return {
    accepted:           true,
    liveGated,
    tier,
    adjustedConfidence,
    session,
    sessionModifier:    sessionMod,
    minTier,
    rejectReason:       liveGated
      ? `confidence ${sig.confidence} below live minimum ${liveMin} for ${sig.strategy_name} (research only)`
      : null,
  };
}

module.exports = { rankSignal, confidenceToTier, tierMeetsMinimum, TIER_THRESHOLDS, TIER_ORDER };
