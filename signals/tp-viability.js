'use strict';

/**
 * TP VIABILITY EVALUATOR
 *
 * Decides whether TP2 and TP3 are worth publishing for a given signal.
 * Win-rate is the primary criterion — a TP level is only shown if the
 * adjusted probability of reaching it clears its minimum threshold.
 *
 * Base probabilities come from deriveGradeAndProbs() (confidence-driven).
 * Contextual adjustments layer on top:
 *
 *   Factor             Range     Why it matters
 *   ─────────────────────────────────────────────────────────────────────
 *   Trade style        -15 / +10  Scalp targets rarely extend; swing designed for it
 *   Session            -30 / +12  After Hours kills follow-through; NY Open boosts it
 *   HTF bias           -8 /  +6   Opposing HTF = counter-trend = fades at TP1
 *   RR ratio           -8 /  +8   Higher RR = more structural room to run
 *   Market structure   -6 /  +5   Trending structure = continuation; unclear = chop
 *   ADX trend          -8 /  +8   Strong ADX = momentum continuation likely
 *
 * Thresholds (adjusted win probability %)
 *   TP2 shown if adjusted prob ≥ 50 %
 *   TP3 shown if adjusted prob ≥ 38 %
 */

const TP2_MIN_PROB = 50;
const TP3_MIN_PROB = 38;

// ── Session modifiers ─────────────────────────────────────────────────────────
// Covers both market-clock names (NY_OPEN) and shared-indicators names (NY Open ★)
const SESSION_MOD = {
  NY_OPEN:           +12,  'NY Open ★':   +12,
  POWER_HOUR:        +8,   'Power Hour':  +8,
  LONDON:            +5,   'London':      +5,
  NY_PRE:            +2,   'Pre-Market':  +2,
  MIDDAY:            -5,   'Midday':      -5,
  NY_CLOSE:          -3,   'Afternoon ✓': -3,
  ASIAN:             -20,  'After Hours': -20,
  OVERNIGHT:         -30,  'Overnight':   -30,
  BLACKOUT:          -50,
};

// ── Trade style base modifiers ────────────────────────────────────────────────
const STYLE_MOD = {
  swing:    +10,
  intraday:   0,
  scalp:    -15,
};

/**
 * Evaluate whether TP2 and TP3 are worth publishing for a given signal.
 *
 * Mutates nothing — callers decide what to do with the result.
 *
 * @param {object} signal - full strategy signal object
 * @returns {{
 *   tp2Viable:    boolean,
 *   tp3Viable:    boolean,
 *   tp2AdjProb:   number,   // 0–100 adjusted win probability for TP2
 *   tp3AdjProb:   number,
 *   factors:      string,   // compact log string, e.g. "style:intraday(0) session:NY_OPEN(+12) ..."
 * }}
 */
function evaluateTPViability(signal) {
  const {
    win_prob_tp2 = 0,
    win_prob_tp3 = 0,
    session      = '',
    htf_bias     = null,
    direction    = 'LONG',
    trade_style  = 'intraday',
    rr           = 0,
    indicators   = {},
  } = signal;

  const log = [];
  let tp2 = win_prob_tp2;
  let tp3 = win_prob_tp3;

  // ── 1. Trade style ────────────────────────────────────────────────────────────
  const styleMod = STYLE_MOD[trade_style] ?? 0;
  if (styleMod !== 0) {
    tp2 += styleMod; tp3 += styleMod;
    log.push(`style:${trade_style}(${_fmt(styleMod)})`);
  }

  // ── 2. Session ────────────────────────────────────────────────────────────────
  const sessMod = SESSION_MOD[session] ?? 0;
  if (sessMod !== 0) {
    tp2 += sessMod; tp3 += sessMod;
    log.push(`sess:${session}(${_fmt(sessMod)})`);
  }

  // ── 3. HTF bias alignment ─────────────────────────────────────────────────────
  if (htf_bias && htf_bias !== 'MIXED') {
    const aligned = (direction === 'LONG' && htf_bias === 'BULL') ||
                    (direction === 'SHORT' && htf_bias === 'BEAR');
    const biasMod = aligned ? +6 : -8;
    tp2 += biasMod; tp3 += biasMod;
    log.push(`htf:${htf_bias}(${_fmt(biasMod)})`);
  }

  // ── 4. RR quality ─────────────────────────────────────────────────────────────
  const rrVal = +rr || 0;
  let rrMod = 0;
  if      (rrVal >= 3.5) rrMod = +8;
  else if (rrVal >= 3.0) rrMod = +5;
  else if (rrVal >= 2.5) rrMod = +2;
  else if (rrVal <  1.5) rrMod = -8;
  if (rrMod !== 0) {
    tp2 += rrMod;
    tp3 += Math.round(rrMod * 1.2); // TP3 benefits more from high RR
    log.push(`rr:${rrVal}(${_fmt(rrMod)})`);
  }

  // ── 5. Market structure ───────────────────────────────────────────────────────
  const struct = indicators?.struct ?? null;
  if (struct && struct !== 'UNCLEAR') {
    const aligned = (direction === 'LONG' && struct === 'BULL') ||
                    (direction === 'SHORT' && struct === 'BEAR');
    const sMod = aligned ? +5 : -6;
    tp2 += sMod; tp3 += sMod;
    log.push(`struct:${struct}(${_fmt(sMod)})`);
  }

  // ── 6. ADX trend strength ─────────────────────────────────────────────────────
  const adx = indicators?.adx ?? null;
  if (adx != null) {
    let adxMod = 0;
    if      (adx >= 30) adxMod = +8;
    else if (adx >= 20) adxMod = +3;
    else if (adx <  15) adxMod = -8;
    if (adxMod !== 0) {
      tp2 += adxMod; tp3 += adxMod;
      log.push(`adx:${adx.toFixed(0)}(${_fmt(adxMod)})`);
    }
  }

  tp2 = Math.max(0, Math.min(100, Math.round(tp2)));
  tp3 = Math.max(0, Math.min(100, Math.round(tp3)));

  return {
    tp2Viable:  tp2 >= TP2_MIN_PROB,
    tp3Viable:  tp3 >= TP3_MIN_PROB,
    tp2AdjProb: tp2,
    tp3AdjProb: tp3,
    factors:    log.join(' ') || 'no adjustments',
  };
}

function _fmt(n) { return n >= 0 ? `+${n}` : `${n}`; }

module.exports = { evaluateTPViability, TP2_MIN_PROB, TP3_MIN_PROB };
