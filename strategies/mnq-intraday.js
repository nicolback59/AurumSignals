'use strict';

/**
 * STRATEGY 1 — MNQ INTRADAY
 *
 * Objective: High-probability intraday MNQ moves avoiding chop.
 * Primary TF:  5-minute bars
 * HTF:         15-minute bars (htfBars)
 * HTF2:        1-hour bars   (htf2Bars)
 * EMA stack:   9 / 21 / 50
 * Filters:     VWAP bias, ATR minimum, no chop, session
 * Entry:       pullback to VWAP or EMA zone + bullish/bearish confirmation candle
 * SL:          beyond recent swing + 0.5 ATR buffer
 * TP:          1.5R / 2R / 2.5R
 * Min confidence: 70
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

// Minimum ATR in MNQ points for intraday to be worth trading
const ATR_MIN_PTS = 8;
// Cooldown: minimum bars between signals on this strategy
const MIN_BAR_GAP = 12; // 12 × 5m = 60 min

let lastSignalBar = -999;

/**
 * Evaluate MNQ intraday setup on confirmed bars.
 *
 * @param {object[]} bars    - 5m primary bars (last = most recent confirmed)
 * @param {object[]} htfBars - 15m bars
 * @param {object[]} htf2Bars - 1h bars
 * @param {object}   cfg     - { instrument?, cooldownBars? }
 * @param {number}   barIdx  - current absolute bar index (for backtest cooldown)
 * @returns {object|null} signal or null
 */
function evaluate(bars, htfBars, htf2Bars, cfg = {}, barIdx = null) {
  const MIN_BARS = 60;
  if (bars.length < MIN_BARS || htfBars.length < 30) return null;

  // Backtest cooldown
  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Indicators ───────────────────────────────────────────────────────────────
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);

  const atrArr  = calcAtr(bars, 14);
  const atr     = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return null;

  const vwapArr = calcVwap(bars);
  const vwap    = vwapArr[n];

  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema50Arr = ema(closes, 50);
  const ema9  = ema9Arr[n];
  const ema21 = ema21Arr[n];
  const ema50 = ema50Arr[n];

  // ── No-trade filters ─────────────────────────────────────────────────────────
  if (isChoppingAroundVwap(bars, vwapArr, 8, 4)) return null;

  const sess = getSessionInfo(last.timestamp);
  // Skip dead sessions
  if (sess.quality < 0.50) return null;

  // ── HTF bias ──────────────────────────────────────────────────────────────────
  const htfBias  = calcHtfBias(htfBars, 9, 21);
  const htf2Bias = htf2Bars && htf2Bars.length >= 21 ? calcHtfBias(htf2Bars, 9, 21) : 0;

  // ── Determine direction candidates ───────────────────────────────────────────
  // EMA9 > EMA21 is sufficient — EMA50 alignment is scored, not required as a gate.
  // HTF must not be directly opposed (neutral is fine).
  const directions = [];
  if (ema9 > ema21 && htfBias >= 0)  directions.push('LONG');
  if (ema9 < ema21 && htfBias <= 0)  directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack score ─────────────────────────────────────────────────────
    // Allow partial stack (1) — full stack (2) gives higher confidence score.
    const esScore = emaStackScore(closes, 9, 21, 50, dir);
    if (esScore < 1) continue;

    // ── Pullback detection ──────────────────────────────────────────────────
    // Price must have recently touched the VWAP, EMA9, or EMA21 zone.
    // Wider lookback (10 bars = 50 min) and tolerance (0.5 ATR) for live scanning.
    const tolerance = 0.5 * atr;
    const pulledToVwap = hadPullbackToLevel(bars, vwap, tolerance, dir, 10);
    const pulledTo9    = hadPullbackToLevel(bars, ema9, tolerance, dir, 10);
    const pulledTo21   = hadPullbackToLevel(bars, ema21, tolerance, dir, 10);
    if (!pulledToVwap && !pulledTo9 && !pulledTo21) continue;

    // ── Pullback held (EMA support not broken) ──────────────────────────────
    const recentSlice = bars.slice(-4, -1);
    if (isBull) {
      if (recentSlice.some(b => b.close < ema21 - 0.35 * atr)) continue;
    } else {
      if (recentSlice.some(b => b.close > ema21 + 0.35 * atr)) continue;
    }

    // ── Confirmation candle ─────────────────────────────────────────────────
    const confirmed = isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25);
    if (!confirmed) continue;

    // ── RSI filter ──────────────────────────────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 75) continue; // overbought
      if (!isBull && rsi <= 25) continue; // oversold
    }

    // ── MACD momentum alignment ──────────────────────────────────────────────
    // Histogram must be on the correct side — requiring it to accelerate was
    // blocking strong steady trends where histogram is flat but clearly positive.
    const { histogram } = calcMacd(closes);
    const hist = histogram[n];
    const macdAligned = isBull ? (hist != null && hist > 0) : (hist != null && hist < 0);
    if (!macdAligned) continue;

    // ── Stop-loss ────────────────────────────────────────────────────────────
    const swLow  = recentSwingLow(bars, 10);
    const swHigh = recentSwingHigh(bars, 10);
    const entry  = last.close;
    let sl, rawRisk;

    if (isBull) {
      sl      = Math.min(swLow, ema21) - 0.5 * atr;
      rawRisk = entry - sl;
    } else {
      sl      = Math.max(swHigh, ema21) + 0.5 * atr;
      rawRisk = sl - entry;
    }

    // Risk must be at least ATR_MIN_PTS and not enormous
    if (rawRisk < ATR_MIN_PTS || rawRisk > 4 * atr) continue;

    // ── Take-profit levels ───────────────────────────────────────────────────
    const tp1 = isBull ? entry + 1.5 * rawRisk : entry - 1.5 * rawRisk;
    const tp2 = isBull ? entry + 2.0 * rawRisk : entry - 2.0 * rawRisk;
    const tp3 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
    const rr  = +(rawRisk > 0 ? (1.5 * rawRisk / rawRisk) : 0).toFixed(2);

    // ── Confidence score ─────────────────────────────────────────────────────
    const srDist = srDistanceAtr(entry, bars, atr, 50);
    const confidence = scoreSignal({
      direction: dir,
      bars,
      htfBias, htf2Bias,
      hasHtf2: htf2Bars != null && htf2Bars.length >= 21,
      vwapVal: vwap,
      emaStackVal: esScore,
      atr, atrMin: ATR_MIN_PTS,
      rr: 1.5,
      srDistanceAtr: srDist,
      timestamp: last.timestamp,
    });

    if (confidence < THRESHOLDS.MNQ_INTRADAY) continue;

    // ── HTF conflict block ───────────────────────────────────────────────────
    // Both HTFs must not be against us
    if (isBull  && htfBias === -1 && htf2Bias === -1) continue;
    if (!isBull && htfBias ===  1 && htf2Bias ===  1) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

    return {
      instrument:    'MNQ',
      strategy_name: 'MNQ_INTRADAY',
      trade_style:   'intraday',
      timeframe:     '5m',
      direction:     dir,
      entry:         +entry.toFixed(2),
      sl:            +sl.toFixed(2),
      tp1:           +tp1.toFixed(2),
      tp2:           +tp2.toFixed(2),
      tp3:           +tp3.toFixed(2),
      rr:            +(1.5).toFixed(2),
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3,
      score:         Math.round(confidence / 4), // legacy compat
      setup:         'MNQ Intraday',
      htf_bias:      htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `EMA9/21 ${dir} (stack=${esScore}), pullback held, ${dir === 'LONG' ? 'bullish' : 'bearish'} candle, HTF aligned`,
      indicators: {
        atr:   +atr.toFixed(2),
        vwap:  +vwap.toFixed(2),
        ema9:  +ema9.toFixed(2),
        ema21: +ema21.toFixed(2),
        ema50: +ema50.toFixed(2),
        rsi:   rsi != null ? +rsi.toFixed(1) : null,
        htfBias, htf2Bias,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  return null;
}

/** Reset cooldown state (used between backtest runs) */
function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MNQ_INTRADAY' };
