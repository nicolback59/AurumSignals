'use strict';

/**
 * QUANT SCORER — multi-dimensional signal quality engine
 *
 * Every signal gets scored across 8 independent dimensions and receives a
 * composite grade.  The grade acts as a second-pass filter on top of the
 * per-strategy confidence gate.
 *
 * Sub-scores and budgets (total max = 100):
 *   regime     (0–18)
 *   volatility (0–14)
 *   trend      (0–18)
 *   liquidity  (0–14)
 *   session    (0–10)
 *   rr         (0–10)
 *   structure  (0–10)
 *   momentum   (0–6)
 *
 * Grade thresholds:
 *   S      : ≥ 85
 *   A      : ≥ 70
 *   B      : ≥ 54
 *   IGNORE : < 54
 *
 * Strong-A live threshold: 78
 *   A signals ≥ 78 are treated as live; 70–77 are research-only.
 */

const { detectMarketStructure } = require('./shared-indicators');

// ── Grade thresholds ──────────────────────────────────────────────────────────

const GRADE_THRESHOLDS = {
  S:      85,
  A:      70,
  B:      54,
  IGNORE: 0,
};

const STRONG_A_THRESHOLD = 74;   // A signals ≥ 74 fire live (lowered from 78 — backtest shows valid A-tier setups were research-gated)

// ── Sub-score: regime (0–18) ──────────────────────────────────────────────────

function _scoreRegime(regime, direction) {
  if (!regime) return 10; // default to NORMAL
  const r = regime.toUpperCase();
  if (r === 'TREND_BULL' || r === 'TREND_BEAR') {
    // Bonus only when regime aligns with trade direction
    const aligned = (r === 'TREND_BULL' && direction === 'LONG') ||
                    (r === 'TREND_BEAR' && direction === 'SHORT');
    return aligned ? 18 : 8;
  }
  if (r === 'EXPANSION')   return 14;
  if (r === 'NORMAL')      return 10;
  if (r === 'COMPRESSION') return 8;
  if (r === 'SOFT_CHOP')   return 4;
  if (r === 'RANGE_CHOP')  return 2;
  return 10; // unknown → NORMAL
}

// ── Sub-score: volatility (0–14) ──────────────────────────────────────────────

function _scoreVolatility(volRegime, atrRatio) {
  const vr = (volRegime ?? 'NORMAL').toUpperCase();
  if (vr === 'NORMAL') return 14;
  if (vr === 'HIGH') {
    // Distinguish acceptable HIGH from excessive
    return (atrRatio ?? 1) < 1.8 ? 10 : 5;
  }
  if (vr === 'LOW') return 4;
  return 14; // unknown → NORMAL
}

// ── Sub-score: trend (0–18) ───────────────────────────────────────────────────

function _scoreTrend(htfBiases, direction) {
  if (!htfBiases || htfBiases.length === 0) return 8;
  const expected = direction === 'LONG' ? 1 : -1;
  const present  = htfBiases.filter(h => h.present);
  if (present.length === 0) return 8;

  const aligned   = present.filter(h => h.bias === expected).length;
  const total     = present.length;
  const ratio     = aligned / total;

  if (ratio >= 1.0)   return 18;   // all aligned
  if (ratio >= 0.5)   return 13;   // majority
  if (ratio >= 0.25)  return 8;    // mixed
  return 3;                         // mostly conflicting
}

// ── Sub-score: liquidity (0–14) ───────────────────────────────────────────────

function _scoreLiquidity(sess) {
  const quality   = sess?.quality ?? 0.6;
  const sessName  = (sess?.name ?? '').toUpperCase();

  let score = Math.min(10, Math.round(quality * 10));
  if (sessName.includes('NY_OPEN') || sessName.includes('NY OPEN') || sessName === 'NY_OPEN')     score += 4;
  else if (sessName.includes('LONDON'))  score += 2;

  return Math.min(14, score);
}

// ── Sub-score: session (0–10) ─────────────────────────────────────────────────

function _scoreSession(sess) {
  const quality = sess?.quality ?? 0.6;
  return Math.min(10, Math.round(quality * 10));
}

// ── Sub-score: rr (0–10) ──────────────────────────────────────────────────────

function _scoreRR(rr) {
  const r = rr ?? 0;
  if (r >= 3.0) return 10;
  if (r >= 2.5) return 8;
  if (r >= 2.0) return 6;
  if (r >= 1.5) return 4;
  if (r >= 1.0) return 2;
  return 0;
}

// ── Sub-score: structure (0–10) ───────────────────────────────────────────────

function _scoreStructure(bars5m, direction) {
  if (!bars5m || bars5m.length < 20) return 5; // not enough data → neutral
  try {
    const struct   = detectMarketStructure(bars5m);
    const expected = direction === 'LONG' ? 'BULL' : 'BEAR';
    if (struct === expected)    return 10;
    if (struct === 'UNCLEAR')   return 5;
    return 2;  // opposite structure
  } catch {
    return 5;
  }
}

// ── Sub-score: momentum (0–6) ─────────────────────────────────────────────────

function _scoreMomentum(rsi, hist, histPrev, direction) {
  const isBull = direction === 'LONG';
  let pts = 0;

  // RSI in good zone (+3)
  if (rsi != null) {
    if (isBull  && rsi >= 50 && rsi < 72) pts += 3;
    if (!isBull && rsi <= 50 && rsi > 28) pts += 3;
  }

  // MACD histogram aligned and improving (+3)
  if (hist != null && histPrev != null) {
    const aligned   = isBull ? hist > 0   : hist < 0;
    const improving = isBull ? hist > histPrev : hist < histPrev;
    if (aligned && improving) pts += 3;
  }

  return Math.min(6, pts);
}

// ── Derive grade from total ───────────────────────────────────────────────────

function deriveQuantGrade(total) {
  if (total >= GRADE_THRESHOLDS.S) return 'S';
  if (total >= GRADE_THRESHOLDS.A) return 'A';
  if (total >= GRADE_THRESHOLDS.B) return 'B';
  return 'IGNORE';
}

// ── Main scoring function ─────────────────────────────────────────────────────

/**
 * Compute the multi-dimensional quant score for a signal.
 *
 * @param {object} sig  - signal object (must have .direction and .rr)
 * @param {object} ctx  - {
 *   regime, volRegime, atrRatio,
 *   sess: { quality, name },
 *   htfBiases: [{ bias, present }],
 *   bars5m,
 *   rsi, hist, histPrev
 * }
 * @returns {{
 *   subscores: { regime, volatility, trend, liquidity, session, rr, structure, momentum },
 *   total: number,
 *   grade: 'S'|'A'|'B'|'IGNORE',
 *   isLive: boolean,
 *   strongA: boolean,
 * }}
 */
function computeQuantScore(sig, ctx) {
  const dir = sig?.direction ?? 'LONG';
  const rr  = sig?.rr ?? 0;

  const {
    regime    = 'NORMAL',
    volRegime = 'NORMAL',
    atrRatio  = 1,
    sess      = {},
    htfBiases = [],
    bars5m    = [],
    rsi       = null,
    hist      = null,
    histPrev  = null,
  } = ctx ?? {};

  const subscores = {
    regime:     _scoreRegime(regime, dir),
    volatility: _scoreVolatility(volRegime, atrRatio),
    trend:      _scoreTrend(htfBiases, dir),
    liquidity:  _scoreLiquidity(sess),
    session:    _scoreSession(sess),
    rr:         _scoreRR(rr),
    structure:  _scoreStructure(bars5m, dir),
    momentum:   _scoreMomentum(rsi, hist, histPrev, dir),
  };

  const total = Object.values(subscores).reduce((s, v) => s + v, 0);
  const grade = deriveQuantGrade(total);

  // isLive: must be at least S-tier OR strong-A (A with score ≥ 78)
  const strongA = grade === 'A' && total >= STRONG_A_THRESHOLD;
  const isLive  = grade === 'S' || strongA;

  return { subscores, total, grade, isLive, strongA };
}

module.exports = { computeQuantScore, deriveQuantGrade, GRADE_THRESHOLDS, STRONG_A_THRESHOLD };
