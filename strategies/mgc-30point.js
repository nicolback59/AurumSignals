'use strict';

/**
 * STRATEGY 6 — MGC 30-POINT SETUPS
 *
 * Objective: Capture ~30 MGC point moves with defined risk.
 * Primary TF:  5-minute bars
 * HTF:         15-minute bars
 * HTF2:        1-hour bars (optional bias confirmation)
 * Session:     London open, London/NY overlap, NY open (active liquidity)
 * Setup modes:
 *   A) Consolidation breakout — tight range 6-10 bars → strong expansion candle
 *   B) EMA9/21 momentum continuation — price pulls back and resumes
 * SL:          recent swing + 0.35 ATR
 * TP:          TP1=10pts / TP2=20pts / TP3=30pts (fixed points on top of risk)
 * Min confidence: 60
 */

const {
  ema, calcAtr, calcVwap, calcRsi, calcMacd,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  hadPullbackToLevel, isChoppingAroundVwap,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
  detectConsolidation,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const TARGET_PTS  = 30;
const ATR_MIN_PTS = 1.8;  // MGC needs at least 1.8pts ATR per 5m bar
const MIN_BAR_GAP = 6;    // 6 × 5m = 30 min cooldown

let lastSignalBar = -999;

function evaluate(bars, htfBars, htf2Bars, cfg = {}, barIdx = null) {
  const MIN_BARS = 40;
  if (bars.length < MIN_BARS || !htfBars || htfBars.length < 20) return null;

  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Session filter ────────────────────────────────────────────────────────
  const sess = getSessionInfo(last.timestamp);
  if (!sess.isLondonNY && !sess.isNYOpen && !sess.isMidDay && !sess.isLondon) return null;
  if (sess.quality < 0.40) return null;

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

  // ── HTF bias ──────────────────────────────────────────────────────────────
  const htfBias  = calcHtfBias(htfBars, 9, 21);
  const htf2Bias = htf2Bars && htf2Bars.length >= 20 ? calcHtfBias(htf2Bars, 9, 21) : 0;

  // ── Mode A: Consolidation breakout ───────────────────────────────────────
  const consolResult = (() => {
    try {
      const priorBars = bars.slice(0, -1);
      const c = detectConsolidation(priorBars, 8, 14);
      if (!c.isConsolidating) return null;
      if (c.rangeHigh - c.rangeLow > 2.0 * atr) return null; // too wide
      return c;
    } catch { return null; }
  })();

  // ── Direction candidates ──────────────────────────────────────────────────
  const directions = [];

  if (consolResult) {
    // Mode A: breakout from consolidation
    if (last.close > consolResult.rangeHigh && htfBias >= 0) directions.push({ dir: 'LONG',  mode: 'breakout' });
    if (last.close < consolResult.rangeLow  && htfBias <= 0) directions.push({ dir: 'SHORT', mode: 'breakout' });
  }

  // Mode B: EMA momentum continuation
  if (ema9 > ema21 && htfBias >= 0 && last.close > ema21 - 0.25 * atr) directions.push({ dir: 'LONG',  mode: 'momentum' });
  if (ema9 < ema21 && htfBias <= 0 && last.close < ema21 + 0.25 * atr) directions.push({ dir: 'SHORT', mode: 'momentum' });

  for (const { dir, mode } of directions) {
    const isBull = dir === 'LONG';

    if (mode === 'momentum') {
      // EMA stack — must be at least partial
      const esScore = emaStackScore(closes, 9, 21, 21, dir);
      if (esScore < 1) continue;

      // Pullback to VWAP or EMA zone
      const tol = 0.5 * atr;
      const pullback = hadPullbackToLevel(bars, vwap, tol, dir, 12)
                    || hadPullbackToLevel(bars, ema9,  tol, dir, 12)
                    || hadPullbackToLevel(bars, ema21, tol, dir, 12);
      if (!pullback) continue;
    }

    // Confirmation candle
    if (!(isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25))) continue;

    // RSI: avoid extremes
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 78) continue;
      if (!isBull && rsi <= 22) continue;
    }

    // MACD soft filter
    const { histogram } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
      if (stronglyAgainst) continue;
    }

    // ── SL/TP ─────────────────────────────────────────────────────────────
    const swLow  = recentSwingLow(bars, 8);
    const swHigh = recentSwingHigh(bars, 8);
    const entry  = last.close;
    let sl, rawRisk;

    if (isBull) {
      sl      = Math.min(swLow, ema21) - 0.35 * atr;
      rawRisk = entry - sl;
    } else {
      sl      = Math.max(swHigh, ema21) + 0.35 * atr;
      rawRisk = sl - entry;
    }

    if (rawRisk < ATR_MIN_PTS * 0.4 || rawRisk > 3 * atr) continue;

    // Fixed point targets + adaptive R:R targets (use larger of the two)
    const tp1 = isBull ? entry + Math.max(10, 0.8 * rawRisk)  : entry - Math.max(10, 0.8 * rawRisk);
    const tp2 = isBull ? entry + Math.max(20, 1.5 * rawRisk)  : entry - Math.max(20, 1.5 * rawRisk);
    const tp3 = isBull ? entry + Math.max(TARGET_PTS, 2.0 * rawRisk) : entry - Math.max(TARGET_PTS, 2.0 * rawRisk);
    const rr  = +(rawRisk > 0 ? Math.max(TARGET_PTS, 2.0 * rawRisk) / rawRisk : 0).toFixed(2);

    if (rr < 0.8) continue;

    const srDist = srDistanceAtr(tp1, bars, atr, 40);
    if (srDist < 0.25) continue;

    // ── Confidence ───────────────────────────────────────────────────────
    const esScoreVal = emaStackScore(closes, 9, 21, 21, dir);
    const confidence = scoreSignal({
      direction:     dir,
      bars,
      htfBias,
      htf2Bias,
      hasHtf2:       htf2Bars != null && htf2Bars.length >= 20,
      vwapVal:       vwap,
      emaStackVal:   esScoreVal,
      atr,
      atrMin:        ATR_MIN_PTS,
      rr:            rr >= 2 ? rr : 1.5,
      srDistanceAtr: srDist,
      timestamp:     last.timestamp,
    });

    if (confidence < THRESHOLDS.MGC_30PT) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

    return {
      instrument:    'MGC',
      strategy_name: 'MGC_30PT',
      trade_style:   'scalp',
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
      setup:         'MGC Scalp 30pt',
      htf_bias:      htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `MGC ${mode} ${dir} — target=${TARGET_PTS}pts, SL=${+sl.toFixed(2)}, HTF=${htfBias >= 0 ? 'bull/neut' : 'bear'}, rr=${rr}`,
      indicators: {
        atr:   +atr.toFixed(2),
        vwap:  +vwap.toFixed(2),
        ema9:  +ema9.toFixed(2),
        ema21: +ema21.toFixed(2),
        rsi:   rsi != null ? +rsi.toFixed(1) : null,
        htfBias, htf2Bias,
        mode,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  return null;
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, TARGET_PTS, STRATEGY_NAME: 'MGC_30PT' };
