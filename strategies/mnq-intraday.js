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

const STRATEGY_VERSION = '2.1';

// Minimum ATR in MNQ points for intraday to be worth trading
const ATR_MIN_PTS = 5;  // lowered from 8 — capture moves in moderate-volatility sessions
// Cooldown: minimum bars between signals on this strategy
const MIN_BAR_GAP = 2;  // 2 × 5m = 10 min spam guard — adaptive-cooldown.js handles strategy timing

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
  if (isChoppingAroundVwap(bars, vwapArr, 5, 3)) return null;  // relaxed from (8,4)

  const sess = getSessionInfo(last.timestamp);
  // Skip low-quality sessions (pre-market, overnight, thin midday)
  if (sess.quality < 0.35) return null;

  // ── HTF bias ──────────────────────────────────────────────────────────────────
  const htfBias  = calcHtfBias(htfBars, 9, 21);
  const htf2Bias = htf2Bars && htf2Bars.length >= 21 ? calcHtfBias(htf2Bars, 9, 21) : 0;

  // ── Determine direction candidates ───────────────────────────────────────────
  // Require 5m EMA stack AND at least one of the two HTFs to agree (not just neutral).
  // Counter-trend entries into mixed HTF environments have historically ~30% WR.
  const directions = [];
  if (ema9 > ema21 && htfBias >= 0 && (htfBias === 1 || htf2Bias === 1)) directions.push('LONG');
  if (ema9 < ema21 && htfBias <= 0 && (htfBias === -1 || htf2Bias === -1)) directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack score ─────────────────────────────────────────────────────
    // Allow partial stack (1) — full stack (2) gives higher confidence score.
    const esScore = emaStackScore(closes, 9, 21, 50, dir);
    if (esScore < 1) continue;

    // ── Pullback detection ──────────────────────────────────────────────────
    // Price must have recently touched the VWAP, EMA9, or EMA21 zone.
    const tolerance = 0.55 * atr;  // tightened from 0.7 — require tighter pullback
    const pulledToVwap = hadPullbackToLevel(bars, vwap, tolerance, dir, 15);
    const pulledTo9    = hadPullbackToLevel(bars, ema9, tolerance, dir, 15);
    const pulledTo21   = hadPullbackToLevel(bars, ema21, tolerance, dir, 15);
    if (!pulledToVwap && !pulledTo9 && !pulledTo21) continue;

    // ── Pullback held (EMA support not broken) ──────────────────────────────
    const recentSlice = bars.slice(-4, -1);
    if (isBull) {
      if (recentSlice.some(b => b.close < ema21 - 0.35 * atr)) continue;
    } else {
      if (recentSlice.some(b => b.close > ema21 + 0.35 * atr)) continue;
    }

    // ── Confirmation candle ─────────────────────────────────────────────────
    const confirmed = isBull ? isBullishCandle(last, 0.30) : isBearishCandle(last, 0.30);  // raised from 0.25
    if (!confirmed) continue;

    // ── RSI filter ──────────────────────────────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 70) continue; // overbought — avoid chasing
      if (!isBull && rsi <= 30) continue; // oversold — avoid chasing
    }

    // ── MACD momentum alignment (soft filter) ───────────────────────────────
    // MACD alignment is scored as a bonus in confidence-scorer.
    // Hard blocking caused too many missed setups; now only skip if strongly
    // counter-trend (histogram on wrong side AND accelerating against us).
    const { histogram } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull
        ? (hist < 0 && hist < histPrev)   // falling deeper negative
        : (hist > 0 && hist > histPrev);  // rising deeper positive
      if (stronglyAgainst) continue;
    }

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

    // Risk must be at least half of ATR_MIN_PTS and not enormous
    if (rawRisk < ATR_MIN_PTS * 0.5 || rawRisk > 5 * atr) continue;

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
      setup:            'MNQ Intraday',
      strategy_version: STRATEGY_VERSION,
      htf_bias:         htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
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

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MNQ_INTRADAY', STRATEGY_VERSION };
