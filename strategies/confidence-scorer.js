'use strict';

const {
  calcRsi, calcMacd, detectMarketStructure, getSessionInfo,
} = require('./shared-indicators');

// ── Per-strategy minimum confidence thresholds ────────────────────────────────
// RESEARCH_THRESHOLDS — minimum to generate a signal candidate for backtest/learning.
// These stay lenient so the system keeps training on signal quality.
const RESEARCH_THRESHOLDS = {
  MNQ_INTRADAY: 70,  // raised from 65 — v3.0 quality-focused filter
  MGC_SCALP:    55,
};

// LIVE_THRESHOLDS — minimum raw confidence to fire a live ntfy alert.
// Signals below this are stored for backtest/research but do NOT send a
// live notification.  Keep close to RESEARCH_THRESHOLDS — the quant scorer
// second gate (STRONG_A_THRESHOLD) is the real quality filter for live alerts.
const LIVE_THRESHOLDS = {
  MNQ_INTRADAY: 72,  // 2 pts above research min (70) — quant scorer handles quality
  MGC_SCALP:    60,  // 5 pts above research min (55) — quant scorer handles quality
};

// Back-compat alias used by strategies as their internal filter gate
const THRESHOLDS = RESEARCH_THRESHOLDS;

/**
 * Score a potential signal from 0–114 (capped at 100).
 *
 * Factor breakdown (max 114 pts, capped 100):
 *   1. HTF alignment          0–20
 *   2. VWAP alignment         0–15
 *   3. EMA stack quality      0–15
 *   4. ATR strength           0–10
 *   5. Momentum (RSI+MACD)    0–10
 *   6. Market structure       0–10
 *   7. Risk/reward ratio      0–10
 *   8. Distance to S/R        0–5
 *   9. Session quality        0–5
 *  10. Strategy DNA match     0–8
 *  11. Opening candle bias    -4–+5  (net adjustment, not strictly bounded)
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
 * @param {number}   [p.dnaScore]       0–100 DNA pattern match score (50 = neutral)
 * @param {number}   [p.openingCandleAdj] pre-computed opening candle adjustment (-4 to +5)
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

  // ── 10. Strategy DNA match (0–8) ────────────────────────────────────────────
  // DNA score 50 = neutral (0 pts). Each 6.25 pts above 50 → +1 pt (max +8 at score 100).
  // DNA score below 50 contributes 0 (negative bias is handled via gate adjustment elsewhere).
  if (p.dnaScore != null) {
    const dnaBoost = Math.round(Math.max(0, Math.min(8, (p.dnaScore - 50) / 6.25)));
    score += dnaBoost;
  }

  // ── 11. Opening candle / power-hour bias (-4 to +5) ─────────────────────────
  // Pre-computed by scanner/backtest using opening-candle.js getOpeningCandleAdjustment().
  // Positive = signal aligns with session open direction (continuation bias).
  // Negative = signal opposes session open direction (counter-trend / fakeout risk).
  // Only applied when statistical accuracy ≥ 54% over ≥ 15 session opens.
  if (p.openingCandleAdj != null && p.openingCandleAdj !== 0) {
    score += p.openingCandleAdj;
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
  const win_prob_tp4 = Math.round(win_prob_tp1 * 0.50);
  return { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4 };
}

module.exports = { scoreSignal, deriveGradeAndProbs, THRESHOLDS, LIVE_THRESHOLDS, RESEARCH_THRESHOLDS };
