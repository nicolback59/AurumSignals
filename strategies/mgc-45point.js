'use strict';

/**
 * STRATEGY 7 — MGC 45-POINT SETUPS
 *
 * Objective: Capture ~45 MGC point directional moves in established trends.
 * Primary TF:  5-minute bars
 * HTF:         1-hour bars (trend direction + entry timing)
 * HTF2:        daily/4h bars (macro bias — optional)
 * Session:     London/NY overlap and NY open only (needs strong volume)
 * Setup:       1h trend is established → 5m pulls back to EMA zone → momentum
 *              expansion candle signals resumption toward 45-pt target
 * SL:          recent swing + 0.4 ATR
 * TP:          TP1=15pts / TP2=30pts / TP3=45pts
 * Min confidence: 62
 */

const {
  ema, calcAtr, calcVwap, calcRsi, calcMacd, calcAdx,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  hadPullbackToLevel, isChoppingAroundVwap,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const TARGET_PTS  = 45;
const ATR_MIN_PTS = 2.2;  // needs decent range to reach 45pts within session
const MIN_BAR_GAP = 8;    // 8 × 5m = 40 min cooldown

let lastSignalBar = -999;

function evaluate(bars, htfBars, htf2Bars, cfg = {}, barIdx = null) {
  const MIN_BARS = 50;
  if (bars.length < MIN_BARS || !htfBars || htfBars.length < 20) return null;

  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Session: only active London/NY windows ─────────────────────────────
  const sess = getSessionInfo(last.timestamp);
  if (!sess.isLondonNY && !sess.isNYOpen && !sess.isLondon) return null;
  if (sess.quality < 0.50) return null;  // slightly stricter — 45pt needs good momentum

  // ── Indicators ────────────────────────────────────────────────────────────
  const closes = bars.map(b => b.close);
  const atrArr = calcAtr(bars, 14);
  const atr    = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return null;

  const vwapArr = calcVwap(bars);
  const vwap    = vwapArr[n];

  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema9     = ema9Arr[n];
  const ema21    = ema21Arr[n];

  if (isChoppingAroundVwap(bars, vwapArr, 5, 3)) return null;

  // ── HTF bias: 1h is primary trend filter for 45-pt setups ─────────────────
  const htfBias  = calcHtfBias(htfBars, 9, 21);
  const htf2Bias = htf2Bars && htf2Bars.length >= 20 ? calcHtfBias(htf2Bars, 9, 21) : 0;

  // HTF must have a clear directional bias — no MIXED entries for 45-pt targets
  if (htfBias === 0) return null;

  // ── ADX: trend strength on 5m (minimum trend present) ────────────────────
  let adxVal = null;
  try {
    const adxArr = calcAdx(bars, 14);
    adxVal = adxArr[n];
    if (adxVal != null && adxVal < 14) return null; // too flat
  } catch { /* optional */ }

  // ── Direction candidates ──────────────────────────────────────────────────
  const directions = [];
  if (ema9 > ema21 && htfBias === 1)  directions.push('LONG');
  if (ema9 < ema21 && htfBias === -1) directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // EMA stack score — require at least partial alignment
    const esScore = emaStackScore(closes, 9, 21, 21, dir);
    if (esScore < 1) continue;

    // Pullback to VWAP or EMA zone
    const tol = 0.55 * atr;
    const pullback = hadPullbackToLevel(bars, vwap,  tol, dir, 12)
                  || hadPullbackToLevel(bars, ema9,  tol, dir, 12)
                  || hadPullbackToLevel(bars, ema21, tol, dir, 12);
    if (!pullback) continue;

    // Pullback held — price did not close through EMA21
    const recentSlice = bars.slice(-3, -1);
    if (isBull && recentSlice.some(b => b.close < ema21 - 0.3 * atr)) continue;
    if (!isBull && recentSlice.some(b => b.close > ema21 + 0.3 * atr)) continue;

    // Confirmation candle (slightly stronger requirement for 45pt)
    if (!(isBull ? isBullishCandle(last, 0.30) : isBearishCandle(last, 0.30))) continue;

    // RSI filter
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 76) continue;
      if (!isBull && rsi <= 24) continue;
    }

    // MACD soft filter — only block if accelerating strongly against direction
    const { histogram } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
      if (stronglyAgainst) continue;
    }

    // ── SL/TP ─────────────────────────────────────────────────────────────
    const swLow  = recentSwingLow(bars, 10);
    const swHigh = recentSwingHigh(bars, 10);
    const entry  = last.close;
    let sl, rawRisk;

    if (isBull) {
      sl      = Math.min(swLow, ema21) - 0.40 * atr;
      rawRisk = entry - sl;
    } else {
      sl      = Math.max(swHigh, ema21) + 0.40 * atr;
      rawRisk = sl - entry;
    }

    if (rawRisk < ATR_MIN_PTS * 0.5 || rawRisk > 3.5 * atr) continue;

    // Fixed point targets
    const tp1 = isBull ? entry + Math.max(15, 1.0 * rawRisk) : entry - Math.max(15, 1.0 * rawRisk);
    const tp2 = isBull ? entry + Math.max(30, 1.8 * rawRisk) : entry - Math.max(30, 1.8 * rawRisk);
    const tp3 = isBull ? entry + Math.max(TARGET_PTS, 2.5 * rawRisk) : entry - Math.max(TARGET_PTS, 2.5 * rawRisk);
    const rr  = +(rawRisk > 0 ? Math.max(TARGET_PTS, 2.5 * rawRisk) / rawRisk : 0).toFixed(2);

    if (rr < 1.0) continue;

    const srDist = srDistanceAtr(tp1, bars, atr, 40);
    if (srDist < 0.25) continue;

    // ── Confidence ───────────────────────────────────────────────────────
    const confidence = scoreSignal({
      direction:     dir,
      bars,
      htfBias,
      htf2Bias,
      hasHtf2:       htf2Bars != null && htf2Bars.length >= 20,
      vwapVal:       vwap,
      emaStackVal:   esScore,
      atr,
      atrMin:        ATR_MIN_PTS,
      rr:            rr >= 2 ? rr : 2.0,
      srDistanceAtr: srDist,
      timestamp:     last.timestamp,
    });

    if (confidence < THRESHOLDS.MGC_45PT) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

    return {
      instrument:    'MGC',
      strategy_name: 'MGC_45PT',
      trade_style:   'intraday',
      timeframe:     '5m',
      direction:     dir,
      entry:         +entry.toFixed(2),
      sl:            +sl.toFixed(2),
      tp1:           +tp1.toFixed(2),
      tp2:           +tp2.toFixed(2),
      tp3:           +tp3.toFixed(2),
      rr,
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3,
      score:         Math.round(confidence / 4),
      setup:         'MGC Scalp 45pt',
      htf_bias:      htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `MGC 45pt ${dir} — 1h HTF=${htfBias > 0 ? 'BULL' : 'BEAR'}, EMA stack held, pullback confirmed, ADX=${adxVal != null ? adxVal.toFixed(1) : '?'}`,
      indicators: {
        atr:   +atr.toFixed(2),
        vwap:  +vwap.toFixed(2),
        ema9:  +ema9.toFixed(2),
        ema21: +ema21.toFixed(2),
        rsi:   rsi != null ? +rsi.toFixed(1) : null,
        adx:   adxVal != null ? +adxVal.toFixed(1) : null,
        htfBias, htf2Bias,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  return null;
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, TARGET_PTS, STRATEGY_NAME: 'MGC_45PT' };
