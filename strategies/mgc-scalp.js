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
// MGC tick = $0.10, point = $1. Minimum ATR ~$2 (2 points)
const ATR_MIN_PTS = 2.0;
const MIN_BAR_GAP = 8; // 8 × 5m = 40 min cooldown for gold scalp

let lastSignalBar = -999;

/**
 * Evaluate MGC gold scalp setup.
 *
 * @param {object[]} bars     - 5m primary bars (MGC/GC prices in USD)
 * @param {object[]} htfBars  - 15m bars
 * @param {object[]} htf2Bars - 1h bars (optional, improves scoring)
 * @param {object}   cfg
 * @param {number}   barIdx
 */
function evaluate(bars, htfBars, htf2Bars, cfg = {}, barIdx = null) {
  const MIN_BARS = 40;
  if (bars.length < MIN_BARS || htfBars.length < 20) return null;

  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Session filter: only London/NY overlap and NY open for gold scalping ──────
  const sess = getSessionInfo(last.timestamp);
  if (!sess.isLondonNY && !sess.isNYOpen && !sess.isMidDay) return null;
  // Skip extremely low-quality sessions
  if (sess.quality < 0.65) return null;

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
    const hist = histogram[n], histPrev = histogram[n - 1];
    const macdOk = isBull
      ? hist != null && hist > (histPrev ?? -Infinity)
      : hist != null && hist < (histPrev ?? Infinity);
    if (!macdOk) continue;

    // ── ATR confirms enough movement for scalp target ────────────────────────
    // We need at least 1.0 ATR of room
    const scalTgt = 1.0 * atr;
    if (scalTgt < ATR_MIN_PTS) continue;

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

    // ── Take-profit ──────────────────────────────────────────────────────────
    const tp1 = isBull ? entry + 0.5 * atr : entry - 0.5 * atr; // partial
    const tp2 = isBull ? entry + 1.0 * atr : entry - 1.0 * atr; // primary
    const tp3 = isBull ? entry + 1.5 * atr : entry - 1.5 * atr; // extended

    const rr = +(scalTgt / rawRisk).toFixed(2);
    if (rr < 1.2) continue; // scalp must have meaningful RR

    // ── S/R distance check ───────────────────────────────────────────────────
    const srDist = srDistanceAtr(tp2, bars, atr, 40);
    // Don't need large room for scalp, but can't enter if S/R is right at target
    if (srDist < 0.5) continue;

    // ── Confidence score ─────────────────────────────────────────────────────
    const confidence = scoreSignal({
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

    if (confidence < THRESHOLDS.MGC_SCALP) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

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
      rr,
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3,
      score:         Math.round(confidence / 4),
      setup:         'MGC Scalp',
      htf_bias:      htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `VWAP/EMA pullback rejected ${dir === 'LONG' ? 'bullish' : 'bearish'}, ${sess.name} session, ATR=${atr.toFixed(2)}, target=${scalTgt.toFixed(2)} pts`,
      indicators: {
        atr:   +atr.toFixed(2),
        vwap:  +vwap.toFixed(2),
        ema9:  +ema9.toFixed(2),
        ema21: +ema21.toFixed(2),
        rsi:   rsi != null ? +rsi.toFixed(1) : null,
        htfBias, htf2Bias,
        scalTgt: +scalTgt.toFixed(2),
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
