'use strict';

const {
  calcRsi, calcMacd, detectMarketStructure, getSessionInfo,
} = require('./shared-indicators');

// ── Per-strategy minimum confidence thresholds ────────────────────────────────

const THRESHOLDS = {
  MNQ_INTRADAY: 60,  // lowered from 68 — more MNQ intraday signals
  MNQ_SWING:    63,  // lowered from 72
  MNQ_50PT:     68,  // lowered from 78
  MGC_SCALP:    62,  // lowered from 65
  MGC_INTRADAY: 60,  // kept as reference (strategy disabled)
};

/**
 * Score a potential signal from 0–100.
 *
 * Factor breakdown (max 100 pts):
 *   1. HTF alignment        0–20
 *   2. VWAP alignment       0–15
 *   3. EMA stack quality    0–15
 *   4. ATR strength         0–10
 *   5. Momentum (RSI+MACD)  0–10
 *   6. Market structure     0–10
 *   7. Risk/reward ratio    0–10
 *   8. Distance to S/R      0–5
 *   9. Session quality      0–5
 *
 * @param {object} p
 * @param {string}   p.direction        'LONG' | 'SHORT'
 * @param {object[]} p.bars             Primary TF bars (confirmed, last = current)
 * @param {number}   p.htfBias          1 = bull, -1 = bear, 0 = mixed
 * @param {number}   p.htf2Bias         same for higher HTF (pass 0 if not used)
 * @param {boolean}  p.hasHtf2          true if a second HTF is used for scoring
 * @param {number}   p.vwapVal          VWAP at current bar (null if not applicable)
 * @param {number}   p.emaStackVal      0 = none, 1 = partial, 2 = full stack
 * @param {number}   p.atr              current ATR value
 * @param {number}   p.atrMin           minimum ATR threshold for this strategy
 * @param {number}   p.rr               risk/reward ratio to primary target
 * @param {number}   p.srDistanceAtr    distance to nearest S/R in ATR units
 * @param {string}   p.timestamp        current bar timestamp
 * @returns {number} confidence score 0–100
 */
function scoreSignal(p) {
  const dir = p.direction;
  const isBull = dir === 'LONG';
  let score = 0;

  // ── 1. HTF alignment (0–20) ─────────────────────────────────────────────────
  const htfOk  = p.htfBias  === (isBull ? 1 : -1);
  const htf2Ok = p.hasHtf2 ? (p.htf2Bias === (isBull ? 1 : -1)) : null;

  if (htf2Ok === null) {
    score += htfOk ? 20 : 0;
  } else {
    if (htfOk && htf2Ok) score += 20;
    else if (htfOk || htf2Ok) score += 10;
  }

  // ── 2. VWAP alignment (0–15) ────────────────────────────────────────────────
  if (p.vwapVal != null && p.bars.length > 0) {
    const close    = p.bars[p.bars.length - 1].close;
    const atr      = p.atr || 1;
    const dist     = (close - p.vwapVal) / atr; // positive = above VWAP
    if (isBull) {
      if (dist > 0.5)       score += 15;  // well above VWAP
      else if (dist > -0.3) score += 8;   // near/at VWAP
    } else {
      if (dist < -0.5)      score += 15;  // well below VWAP
      else if (dist < 0.3)  score += 8;
    }
  }

  // ── 3. EMA stack quality (0–15) ─────────────────────────────────────────────
  score += Math.round((p.emaStackVal ?? 0) * 7.5); // 0→0, 1→8, 2→15

  // ── 4. ATR strength (0–10) ──────────────────────────────────────────────────
  const atrRatio = (p.atr || 0) / (p.atrMin || 1);
  if (atrRatio >= 2.5) score += 10;
  else if (atrRatio >= 1.5) score += 7;
  else if (atrRatio >= 1.0) score += 4;
  // below threshold → 0

  // ── 5. Momentum confirmation (0–10) ─────────────────────────────────────────
  if (p.bars.length >= 30) {
    const closes  = p.bars.map(b => b.close);
    const rsiArr  = calcRsi(closes, 14);
    const rsi     = rsiArr[rsiArr.length - 1];
    const { histogram } = calcMacd(closes);
    const hist     = histogram[histogram.length - 1];
    const histPrev = histogram[histogram.length - 2];

    let momPts = 0;
    if (isBull) {
      if (rsi != null && rsi >= 50 && rsi < 70) momPts += 5;
      if (hist != null && hist > 0 && hist > (histPrev ?? -Infinity)) momPts += 5;
    } else {
      if (rsi != null && rsi <= 50 && rsi > 30) momPts += 5;
      if (hist != null && hist < 0 && hist < (histPrev ?? Infinity)) momPts += 5;
    }
    score += momPts;
  }

  // ── 6. Market structure quality (0–10) ───────────────────────────────────────
  if (p.bars.length >= 20) {
    const struct   = detectMarketStructure(p.bars);
    const expected = isBull ? 'BULL' : 'BEAR';
    if (struct === expected)    score += 10;
    else if (struct === 'UNCLEAR') score += 4;
  }

  // ── 7. Risk/reward quality (0–10) ────────────────────────────────────────────
  const rr = p.rr ?? 0;
  if (rr >= 3)        score += 10;
  else if (rr >= 2.5) score += 8;
  else if (rr >= 2)   score += 6;
  else if (rr >= 1.5) score += 3;

  // ── 8. Distance to nearest S/R (0–5) ────────────────────────────────────────
  const srD = p.srDistanceAtr ?? 10;
  if (srD >= 4)       score += 5;
  else if (srD >= 2.5) score += 3;
  else if (srD >= 1.5) score += 1;

  // ── 9. Session quality (0–5) ────────────────────────────────────────────────
  if (p.timestamp) {
    const sess = getSessionInfo(p.timestamp);
    score += Math.round(sess.quality * 5);
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Convert confidence score to legacy grade ('A+' | 'A') and win probabilities.
 */
function deriveGradeAndProbs(confidence) {
  const grade = confidence >= 85 ? 'A+' : 'A';
  const base  = confidence / 100;
  const win_prob_tp1 = Math.round(Math.min(92, Math.max(35, base * 90 + 5)));
  const win_prob_tp2 = Math.round(win_prob_tp1 * 0.82);
  const win_prob_tp3 = Math.round(win_prob_tp1 * 0.65);
  return { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 };
}

module.exports = { scoreSignal, deriveGradeAndProbs, THRESHOLDS };
