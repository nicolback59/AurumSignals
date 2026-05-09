'use strict';

/**
 * STRATEGY 5 — MGC GOLD INTRADAY
 *
 * Objective: Broader gold intraday trend-following to generate more signals.
 * Primary TF:  5-minute bars (MGC/GC prices in USD)
 * HTF:         1-hour bars — htfBars (trend context)
 * Session:     London open through NY afternoon (broader than scalp)
 * EMA stack:   9 / 21 on primary
 * Filters:     1h HTF bias, ATR minimum, VWAP alignment
 * Entry:       EMA9/21 trend with pullback to EMA or VWAP zone
 * SL:          Recent swing + 0.4 ATR
 * TP:          1.0R / 1.5R / 2.0R
 * Min confidence: 65
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

const ATR_MIN_PTS = 1.5;  // slightly lower than scalp — still needs real movement
const MIN_BAR_GAP = 6;    // 6 × 5m = 30 min cooldown

let lastSignalBar = -999;

/**
 * Evaluate MGC gold scalp (intraday trend variant) setup.
 *
 * Multi-timeframe pyramid: 5m entry + 30m/45m intermediate + 1h macro.
 * Minimum 2 of the present HTF layers must agree before entry.
 *
 * @param {object[]} bars     - 5m primary bars
 * @param {object[]} htfBars  - 1h bars (macro trend)
 * @param {object[]} bars30m  - 30m bars (intermediate)
 * @param {object[]} bars45m  - 45m bars (intermediate)
 * @param {object}   cfg
 * @param {number}   barIdx
 */
function evaluate(bars, htfBars, bars30m, bars45m, cfg = {}, barIdx = null) {
  // Handle legacy callers
  if (bars30m && !Array.isArray(bars30m) && typeof bars30m === 'object') {
    cfg = bars30m; barIdx = bars45m ?? null; bars30m = []; bars45m = [];
  }
  const MIN_BARS = 50;
  if (bars.length < MIN_BARS || !htfBars || htfBars.length < 20) return null;

  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Session filter: broader than scalp — London open through NY afternoon ──
  const sess = getSessionInfo(last.timestamp);
  // Allow London, NY overlap, NY open, mid-day; skip only overnight/pre-market
  if (!sess.isLondonNY && !sess.isNYOpen && !sess.isMidDay && !sess.isLondon) return null;
  if (sess.quality < 0.45) return null;

  // ── Indicators ───────────────────────────────────────────────────────────────
  const closes = bars.map(b => b.close);
  const atrArr = calcAtr(bars, 14);
  const atr    = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return null;

  const vwapArr = calcVwap(bars);
  const vwap    = vwapArr[n];

  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema9  = ema9Arr[n];
  const ema21 = ema21Arr[n];

  // ── No-trade: choppy VWAP (slightly more lenient than scalp) ─────────────────
  if (isChoppingAroundVwap(bars, vwapArr, 6, 4)) return null;

  // ── HTF bias (1h) ─────────────────────────────────────────────────────────────
  const htfBias = calcHtfBias(htfBars, 9, 21);
  // Intraday requires at least neutral HTF
  if (htfBias === 0 && ema9 === ema21) return null; // pure neutrality — skip

  // ── Direction candidates ───────────────────────────────────────────────────────
  const directions = [];

  // LONG: EMA9 > EMA21 on 5m, HTF not bearish, price near/above VWAP
  if (ema9 > ema21 && htfBias >= 0 && last.close > ema21 - 0.3 * atr) {
    directions.push('LONG');
  }
  // SHORT: EMA9 < EMA21 on 5m, HTF not bullish, price near/below VWAP
  if (ema9 < ema21 && htfBias <= 0 && last.close < ema21 + 0.3 * atr) {
    directions.push('SHORT');
  }

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack score — allow partial (1) since this is intraday not strict scalp
    const esScore = emaStackScore(closes, 9, 21, 21, dir);
    if (esScore < 1) continue;

    // ── Pullback to any of: VWAP, EMA9, EMA21 ─────────────────────────────────
    const tolerance = 0.45 * atr;
    const pullVwap = hadPullbackToLevel(bars, vwap,  tolerance, dir, 8);
    const pull9    = hadPullbackToLevel(bars, ema9,  tolerance, dir, 8);
    const pull21   = hadPullbackToLevel(bars, ema21, tolerance, dir, 8);
    if (!pullVwap && !pull9 && !pull21) continue;

    // ── Pullback held (price didn't close hard through EMA21) ─────────────────
    const recentSlice = bars.slice(-3, -1);
    if (isBull && recentSlice.some(b => b.close < ema21 - 0.35 * atr)) continue;
    if (!isBull && recentSlice.some(b => b.close > ema21 + 0.35 * atr)) continue;

    // ── Confirmation candle (relaxed body ratio for intraday) ─────────────────
    if (!(isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25))) continue;

    // ── RSI — avoid extreme overbought/oversold ────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 75) continue;
      if (!isBull && rsi <= 25) continue;
    }

    // ── MACD momentum — histogram must be on the right side ──────────────────
    // Requiring acceleration (hist > histPrev) blocks strong steady trends.
    const { histogram } = calcMacd(closes);
    const hist = histogram[n];
    if (hist == null) continue;
    const macdOk = isBull ? hist > 0 : hist < 0;
    if (!macdOk) continue;

    // ── ADX — prefer trending market (ADX > 15) ────────────────────────────────
    let adxVal = null;
    try {
      const adxArr = calcAdx(bars, 14);
      adxVal = adxArr[n];
    } catch { /* ADX optional */ }
    // Don't block on ADX missing, but skip if clearly flat
    if (adxVal != null && adxVal < 12) continue;

    // ── Stop-loss ──────────────────────────────────────────────────────────────
    const swLow  = recentSwingLow(bars, 10);
    const swHigh = recentSwingHigh(bars, 10);
    const entry  = last.close;
    let sl, rawRisk;

    if (isBull) {
      sl      = Math.min(swLow, ema21) - 0.4 * atr;
      rawRisk = entry - sl;
    } else {
      sl      = Math.max(swHigh, ema21) + 0.4 * atr;
      rawRisk = sl - entry;
    }

    if (rawRisk < ATR_MIN_PTS * 0.5 || rawRisk > 3.5 * atr) continue;

    // ── Fixed MGC take-profit levels (pts from entry) ─────────────────────────
    // TP1=10, TP2=14, TP3=20, TP4=25
    const tp1 = isBull ? entry + 10 : entry - 10;
    const tp2 = isBull ? entry + 14 : entry - 14;
    const tp3 = isBull ? entry + 20 : entry - 20;
    const tp4 = isBull ? entry + 25 : entry - 25;

    // RR based on TP2 (primary target)
    const rr = +(rawRisk > 0 ? 14 / rawRisk : 0).toFixed(2);
    if (rr < 0.8) continue;

    // ── S/R distance check ─────────────────────────────────────────────────────
    const srDist = srDistanceAtr(tp2, bars, atr, 40);
    if (srDist < 0.3) continue;

    // ── 30m / 45m multi-timeframe confluence ─────────────────────────────────
    const b30mBias = (bars30m && bars30m.length >= 6)  ? calcHtfBias(bars30m, 9, 21) : null;
    const b45mBias = (bars45m && bars45m.length >= 5)  ? calcHtfBias(bars45m, 9, 21) : null;
    const expectedBias = isBull ? 1 : -1;

    const htfLayers = [
      { name: '30m', bias: b30mBias, present: b30mBias !== null },
      { name: '45m', bias: b45mBias, present: b45mBias !== null },
      { name: '1h',  bias: htfBias,  present: true },
    ];
    const presentLayers  = htfLayers.filter(l => l.present);
    const agreedLayers   = presentLayers.filter(l => l.bias === expectedBias);
    const conflictLayers = presentLayers.filter(l => l.bias !== 0 && l.bias !== expectedBias);

    const minAgree = presentLayers.length >= 2 ? 2 : 1;
    if (agreedLayers.length < minAgree) continue;
    if (conflictLayers.length > agreedLayers.length) continue;

    const confluenceBonus = (agreedLayers.length - minAgree) * 4;

    // ── Confidence score ───────────────────────────────────────────────────────
    const baseConfidence = scoreSignal({
      direction:     dir,
      bars,
      htfBias,
      htf2Bias:      b30mBias ?? 0,
      hasHtf2:       b30mBias !== null,
      vwapVal:       vwap,
      emaStackVal:   esScore,
      atr,
      atrMin:        ATR_MIN_PTS,
      rr:            1.5,
      srDistanceAtr: srDist,
      timestamp:     last.timestamp,
    });
    const confidence = Math.min(100, baseConfidence + confluenceBonus);

    if (confidence < THRESHOLDS.MGC_INTRADAY) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4 } = deriveGradeAndProbs(confidence);

    return {
      instrument:    'MGC',
      strategy_name: 'MGC_INTRADAY',
      trade_style:   'scalp',
      timeframe:     '5m',
      direction:     dir,
      entry:         +entry.toFixed(2),
      sl:            +sl.toFixed(2),
      tp1:           +tp1.toFixed(2),
      tp2:           +tp2.toFixed(2),
      tp3:           +tp3.toFixed(2),
      tp4:           +tp4.toFixed(2),
      rr,
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4,
      score:         Math.round(confidence / 4),
      setup:         'MGC Scalp',
      htf_bias:      htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `EMA9/21 scalp ${dir}, ${agreedLayers.map(l=>l.name).join('+')} confirmed (${agreedLayers.length}/${presentLayers.length} TFs), ADX=${adxVal != null ? adxVal.toFixed(1) : '?'}`,
      indicators: {
        atr:   +atr.toFixed(2),
        vwap:  +vwap.toFixed(2),
        ema9:  +ema9.toFixed(2),
        ema21: +ema21.toFixed(2),
        rsi:   rsi != null ? +rsi.toFixed(1) : null,
        adx:   adxVal != null ? +adxVal.toFixed(1) : null,
        htfBias,
        bias30m:       b30mBias,
        bias45m:       b45mBias,
        mtfAgreed:     agreedLayers.length,
        mtfPresent:    presentLayers.length,
        confluenceBonus,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  return null;
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MGC_INTRADAY' };
