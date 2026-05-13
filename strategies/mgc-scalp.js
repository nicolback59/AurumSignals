'use strict';

/**
 * STRATEGY 4 — MGC GOLD SCALPING
 *
 * Objective: Fast, high-probability gold scalp signals with tight risk.
 * Primary TF:  5-minute bars (or 1m aggregated to 5m) — bars
 * HTF:         15-minute bars — htfBars
 * HTF2:        1-hour bars   — htf2Bars
 * Session:     London/NY overlap (07:30–09:30 ET) and active NY (09:30–12:00 ET)
 * EMA stack:   9 / 21 on primary
 * Filters:     VWAP bias, ATR minimum, momentum
 * Entry:       VWAP/EMA pullback + rejection candle
 * SL:          tight structure-based + 0.3 ATR
 * TP:          1.0 ATR (partial at 0.5 ATR)
 * Min confidence: 72
 */

const {
  ema, calcAtr, calcVwap, calcRsi, calcMacd,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  hadPullbackToLevel, isChoppingAroundVwap,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

// Minimum ATR in MGC (micro gold) dollars per contract for scalp to make sense
// MGC tick = $0.10, point = $1. Lowered to 1.5 to capture more setups.
const ATR_MIN_PTS = 1.5;
const MIN_BAR_GAP = 5; // 5 × 5m = 25 min cooldown for gold scalp

let lastSignalBar = -999;

/**
 * Evaluate MGC gold scalp setup.
 *
 * Multi-timeframe pyramid (all from aggregated 5m source):
 *   bars     — 5m  (entry timing)
 *   htfBars  — 15m (short-term direction)
 *   bars30m  — 30m (intermediate confirmation)
 *   bars45m  — 45m (bridge between 30m and 1h)
 *   htf2Bars — 1h  (macro trend context)
 *
 * Confluence rule: at least 2 of the 4 HTF layers [15m, 30m, 45m, 1h] must
 * agree with the trade direction. More agreement → higher confidence bonus.
 *
 * @param {object[]} bars     - 5m primary bars
 * @param {object[]} htfBars  - 15m bars
 * @param {object[]} htf2Bars - 1h bars
 * @param {object[]} bars30m  - 30m bars (optional but strongly recommended)
 * @param {object[]} bars45m  - 45m bars (optional)
 * @param {object}   cfg
 * @param {number}   barIdx
 */
function evaluate(bars, htfBars, htf2Bars, bars30m, bars45m, cfg = {}, barIdx = null) {
  // Handle legacy callers that don't pass 30m/45m
  if (bars30m && !Array.isArray(bars30m) && typeof bars30m === 'object' && !bars30m.length) {
    cfg = bars30m; barIdx = bars45m ?? null; bars30m = []; bars45m = [];
  }
  const MIN_BARS = 40;
  if (bars.length < MIN_BARS || htfBars.length < 20) return null;

  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Session filter: London open + NY sessions for gold scalping ───────────────
  const sess = getSessionInfo(last.timestamp);
  if (!sess.isLondon && !sess.isLondonNY && !sess.isNYOpen && !sess.isMidDay && !sess.isAftNoon) return null;
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

  // ── No-trade: choppy VWAP ────────────────────────────────────────────────────
  if (isChoppingAroundVwap(bars, vwapArr, 8, 3)) return null;

  // ── HTF biases ───────────────────────────────────────────────────────────────
  const htfBias  = calcHtfBias(htfBars, 9, 21);
  const htf2Bias = htf2Bars && htf2Bars.length >= 21 ? calcHtfBias(htf2Bars, 9, 21) : 0;

  // ── Direction candidates ──────────────────────────────────────────────────────
  const directions = [];

  const aboveVwap = last.close > vwap;
  const belowVwap = last.close < vwap;

  // LONG: price above VWAP or reclaiming, EMA9 > EMA21, 15m agrees
  if ((aboveVwap || isReclaimingVwap(bars, vwapArr)) && ema9 > ema21 && htfBias >= 0) {
    directions.push('LONG');
  }
  // SHORT: price below VWAP or rejecting, EMA9 < EMA21, 15m agrees
  if ((belowVwap || isRejectingVwap(bars, vwapArr)) && ema9 < ema21 && htfBias <= 0) {
    directions.push('SHORT');
  }

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack on primary TF ─────────────────────────────────────────────
    const esScore = emaStackScore(closes, 9, 21, 21, dir);
    // Scalp allows partial stack (1) but prefers full
    if (esScore < 1) continue;

    // ── Pullback to VWAP, EMA9, or EMA21 ────────────────────────────────────
    const tolerance = 0.35 * atr;
    const pullVwap  = hadPullbackToLevel(bars, vwap,  tolerance, dir, 5);
    const pull9     = hadPullbackToLevel(bars, ema9,  tolerance, dir, 5);
    const pull21    = hadPullbackToLevel(bars, ema21, tolerance, dir, 5);
    if (!pullVwap && !pull9 && !pull21) continue;

    // ── Pullback held (didn't close through EMA21) ──────────────────────────
    const recentSlice = bars.slice(-3, -1);
    if (isBull && recentSlice.some(b => b.close < ema21 - 0.25 * atr)) continue;
    if (!isBull && recentSlice.some(b => b.close > ema21 + 0.25 * atr)) continue;

    // ── Rejection candle (confirmation) ─────────────────────────────────────
    if (!(isBull ? isBullishCandle(last, 0.35) : isBearishCandle(last, 0.35))) continue;

    // ── Momentum ─────────────────────────────────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 72) continue; // overbought
      if (!isBull && rsi <= 28) continue; // oversold
    }

    const { histogram } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    // Soft filter: only block if strongly counter-trend (accelerating against us)
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
      if (stronglyAgainst) continue;
    }

    // ── Stop-loss (tight, structure-based + 0.3 ATR) ─────────────────────────
    const swLow  = recentSwingLow(bars, 8);
    const swHigh = recentSwingHigh(bars, 8);
    const entry  = last.close;
    let sl, rawRisk;

    if (isBull) {
      sl      = Math.min(swLow, ema21) - 0.3 * atr;
      rawRisk = entry - sl;
    } else {
      sl      = Math.max(swHigh, ema21) + 0.3 * atr;
      rawRisk = sl - entry;
    }

    // Scalp stop must be tight
    if (rawRisk < ATR_MIN_PTS * 0.5 || rawRisk > 3 * atr) continue;

    // ── Fixed MGC take-profit levels (pts from entry) ────────────────────────
    // TP1=10, TP2=14, TP3=20, TP4=25
    const tp1 = isBull ? entry + 10 : entry - 10;
    const tp2 = isBull ? entry + 14 : entry - 14;
    const tp3 = isBull ? entry + 20 : entry - 20;
    const tp4 = isBull ? entry + 25 : entry - 25;

    // RR based on TP2 (primary target)
    const rr = +(rawRisk > 0 ? 14 / rawRisk : 0).toFixed(2);
    if (rr < 0.9) continue;

    // ── S/R distance check ───────────────────────────────────────────────────
    const srDist = srDistanceAtr(tp2, bars, atr, 40);
    if (srDist < 0.5) continue;

    // ── 30m / 45m multi-timeframe confluence ─────────────────────────────────
    // Count how many of the 4 HTF layers agree with direction.
    // Require at least 2/4 agreement. Each aligned TF adds a confidence bonus.
    const b30mBias = (bars30m && bars30m.length >= 6)  ? calcHtfBias(bars30m, 9, 21) : null;
    const b45mBias = (bars45m && bars45m.length >= 5)  ? calcHtfBias(bars45m, 9, 21) : null;
    const expectedBias = isBull ? 1 : -1;

    const htfLayers = [
      { name: '15m', bias: htfBias,   present: true },
      { name: '30m', bias: b30mBias,  present: b30mBias !== null },
      { name: '45m', bias: b45mBias,  present: b45mBias !== null },
      { name: '1h',  bias: htf2Bias,  present: htf2Bars != null && htf2Bars.length >= 21 },
    ];
    const presentLayers = htfLayers.filter(l => l.present);
    const agreedLayers  = presentLayers.filter(l => l.bias === expectedBias);
    const conflictLayers = presentLayers.filter(l => l.bias !== 0 && l.bias !== expectedBias);

    // Need at least 2 layers to agree (or 1 if only 1-2 are available)
    const minAgree = presentLayers.length >= 3 ? 2 : 1;
    if (agreedLayers.length < minAgree) continue;

    // Block if majority of present layers are explicitly against us
    if (conflictLayers.length > agreedLayers.length) continue;

    // Confluence bonus: each extra agreeing layer adds to confidence
    const confluenceBonus = (agreedLayers.length - minAgree) * 4; // +4 per extra aligned TF

    // ── Confidence score ─────────────────────────────────────────────────────
    const baseConfidence = scoreSignal({
      direction: dir,
      bars,
      htfBias,
      htf2Bias,
      hasHtf2: htf2Bars != null && htf2Bars.length >= 21,
      vwapVal: vwap,
      emaStackVal: esScore,
      atr, atrMin: ATR_MIN_PTS,
      rr,
      srDistanceAtr: srDist,
      timestamp: last.timestamp,
    });
    const confidence = Math.min(100, baseConfidence + confluenceBonus);

    if (confidence < THRESHOLDS.MGC_SCALP) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4 } = deriveGradeAndProbs(confidence);

    return {
      instrument:    'MGC',
      strategy_name: 'MGC_SCALP',
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
      trigger_reason: `VWAP/EMA scalp ${dir}, ${agreedLayers.map(l=>l.name).join('+')} aligned (${agreedLayers.length}/${presentLayers.length} TFs), ${sess.name}, ATR=${atr.toFixed(2)}`,
      indicators: {
        atr:   +atr.toFixed(2),
        vwap:  +vwap.toFixed(2),
        ema9:  +ema9.toFixed(2),
        ema21: +ema21.toFixed(2),
        rsi:   rsi != null ? +rsi.toFixed(1) : null,
        htfBias, htf2Bias,
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

// ── VWAP reclaim / rejection helpers ─────────────────────────────────────────

function isReclaimingVwap(bars, vwapArr, lookback = 3) {
  if (bars.length < lookback + 2) return false;
  const slice     = bars.slice(-lookback - 1, -1);
  const vwapSlice = vwapArr.slice(-lookback - 1, -1);
  // Was below VWAP recently, now above — reclaiming
  const wasBelow = slice.some((b, i) => b.close < vwapSlice[i]);
  const nowAbove  = bars[bars.length - 1].close > vwapArr[vwapArr.length - 1];
  return wasBelow && nowAbove;
}

function isRejectingVwap(bars, vwapArr, lookback = 3) {
  if (bars.length < lookback + 2) return false;
  const slice     = bars.slice(-lookback - 1, -1);
  const vwapSlice = vwapArr.slice(-lookback - 1, -1);
  const wasAbove = slice.some((b, i) => b.close > vwapSlice[i]);
  const nowBelow  = bars[bars.length - 1].close < vwapArr[vwapArr.length - 1];
  return wasAbove && nowBelow;
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MGC_SCALP' };
