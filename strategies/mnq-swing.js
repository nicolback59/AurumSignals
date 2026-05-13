'use strict';

/**
 * STRATEGY 2 — MNQ SWING
 *
 * Objective: Capture multi-hour/multi-day MNQ directional moves.
 * Primary TF:  1-hour bars  (bars)
 * HTF:         4-hour bars  (htfBars)
 * HTF2:        Daily bars   (htf2Bars)
 * EMA stack:   9 / 21 on 1h; 50 / 200 on daily
 * Filters:     ADX ≥ 20, EMA 50 above/below 200 on daily, market structure
 * Entry:       pullback into value on 1h, retest holds, momentum confirms
 * SL:          beyond swing structure + 1 ATR
 * TP:          2R / 2.5R / 3R
 * Min confidence: 75
 */

const {
  ema, calcAtr, calcVwap, calcRsi, calcMacd, calcAdx,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  detectMarketStructure,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
  hadPullbackToLevel,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const ATR_MIN_PTS = 15; // minimum 1h ATR in MNQ points
const MIN_BAR_GAP = 4;  // 4 × 1h = 4 hours minimum between signals
const MIN_RR      = 2.0;

let lastSignalBar = -999;

/**
 * Evaluate MNQ swing setup.
 *
 * @param {object[]} bars     - 1h primary bars
 * @param {object[]} htfBars  - 4h bars
 * @param {object[]} htf2Bars - Daily bars
 * @param {object}   cfg
 * @param {number}   barIdx
 */
function evaluate(bars, htfBars, htf2Bars, cfg = {}, barIdx = null) {
  const MIN_BARS = 60;
  if (bars.length < MIN_BARS) return null;
  if (!htf2Bars || htf2Bars.length < 30) return null;

  const curIdx = barIdx ?? bars.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = bars.length - 1;
  const last = bars[n];

  // ── Indicators ───────────────────────────────────────────────────────────────
  const closes = bars.map(b => b.close);
  const atrArr = calcAtr(bars, 14);
  const atr    = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return null;

  const vwapArr = calcVwap(bars);
  const vwap    = vwapArr[n];

  // Daily trend — use EMA50 only (EMA200 needs 200 daily bars; we only have ~60).
  // Use the 4h bars as the macro HTF instead.
  const dlyCloses = htf2Bars.map(b => b.close);
  const dly21Arr  = ema(dlyCloses, 21);
  const dn        = dlyCloses.length - 1;
  const dly21     = dly21Arr[dn];
  const dlyClose  = htf2Bars[dn].close;

  // Macro bias: price above/below daily EMA21
  const dailyBull = dly21 != null && dlyClose > dly21;
  const dailyBear = dly21 != null && dlyClose < dly21;

  if (!dailyBull && !dailyBear) return null;

  // 1h EMA 9/21
  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema9  = ema9Arr[n];
  const ema21 = ema21Arr[n];

  // ADX on 1h (trend strength) — soft gate, just screen out flat chop
  const { adx: adxArr } = calcAdx(bars, 14);
  const adx = adxArr[n];
  if (adx != null && adx < 8) return null; // extremely flat, skip

  // ── Market structure on 1h ───────────────────────────────────────────────────
  const struct = detectMarketStructure(bars, 30);

  // ── HTF biases ───────────────────────────────────────────────────────────────
  const htfBias  = calcHtfBias(htfBars && htfBars.length >= 21 ? htfBars : bars, 9, 21);
  const htf2Bias = dailyBull ? 1 : dailyBear ? -1 : 0;

  const sess = getSessionInfo(last.timestamp);
  if (sess.quality < 0.50) return null;

  // ── Direction candidates ─────────────────────────────────────────────────────
  const directions = [];
  if (dailyBull && ema9 > ema21 && (struct === 'BULL' || struct === 'UNCLEAR'))  directions.push('LONG');
  if (dailyBear && ema9 < ema21 && (struct === 'BEAR' || struct === 'UNCLEAR'))  directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack on 1h ─────────────────────────────────────────────────────
    const esScore = emaStackScore(closes, 9, 21, 21, dir); // 9/21 only on swing
    if (esScore < 1) continue;

    // ── Pullback into value ──────────────────────────────────────────────────
    const tolerance = 0.8 * atr;
    const pulledToVwap = hadPullbackToLevel(bars, vwap, tolerance, dir, 12);
    const pulledTo21   = hadPullbackToLevel(bars, ema21, tolerance, dir, 12);
    if (!pulledToVwap && !pulledTo21) continue;

    // ── Retest holds ─────────────────────────────────────────────────────────
    const recentSlice = bars.slice(-3, -1);
    if (isBull && recentSlice.some(b => b.close < ema21 - 0.3 * atr)) continue;
    if (!isBull && recentSlice.some(b => b.close > ema21 + 0.3 * atr)) continue;

    // ── Confirmation candle ──────────────────────────────────────────────────
    if (!(isBull ? isBullishCandle(last, 0.30) : isBearishCandle(last, 0.30))) continue;

    // ── Momentum ─────────────────────────────────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    const { histogram } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    // Soft MACD filter: only block if strongly counter-trend (accelerating against)
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull
        ? (hist < 0 && hist < histPrev)
        : (hist > 0 && hist > histPrev);
      if (stronglyAgainst) continue;
    }

    // ── Stop-loss ────────────────────────────────────────────────────────────
    const swLow  = recentSwingLow(bars, 12);
    const swHigh = recentSwingHigh(bars, 12);
    const entry  = last.close;
    let sl, rawRisk;

    if (isBull) {
      sl      = Math.min(swLow, ema21) - 1.0 * atr;
      rawRisk = entry - sl;
    } else {
      sl      = Math.max(swHigh, ema21) + 1.0 * atr;
      rawRisk = sl - entry;
    }

    if (rawRisk < ATR_MIN_PTS || rawRisk > 6 * atr) continue;

    // ── Take-profit levels ────────────────────────────────────────────────────
    const tp1 = isBull ? entry + 2.0 * rawRisk : entry - 2.0 * rawRisk;
    const tp2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
    const tp3 = isBull ? entry + 3.0 * rawRisk : entry - 3.0 * rawRisk;

    // ── Risk/reward gate ─────────────────────────────────────────────────────
    const rr = +(2.0).toFixed(2);
    if (rr < MIN_RR) continue;

    // ── Near key S/R? ────────────────────────────────────────────────────────
    const srDist = srDistanceAtr(entry, bars, atr, 60);
    if (srDist < 0.3) continue; // only block if sitting exactly on S/R

    // ── Confidence score ─────────────────────────────────────────────────────
    const confidence = scoreSignal({
      direction: dir,
      bars,
      htfBias: htfBias,
      htf2Bias,
      hasHtf2: true,
      vwapVal: vwap,
      emaStackVal: esScore,
      atr, atrMin: ATR_MIN_PTS,
      rr: 2.0,
      srDistanceAtr: srDist,
      timestamp: last.timestamp,
    });

    if (confidence < THRESHOLDS.MNQ_SWING) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

    return {
      instrument:    'MNQ',
      strategy_name: 'MNQ_SWING',
      trade_style:   'swing',
      timeframe:     '1h',
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
      setup:         'MNQ Swing',
      htf_bias:      htf2Bias === 1 ? 'BULL' : htf2Bias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `Daily EMA50/200 ${isBull ? 'bull' : 'bear'} alignment, 1h pullback held ${isBull ? 'above' : 'below'} EMA21, momentum confirms`,
      indicators: {
        atr:     +atr.toFixed(2),
        vwap:    +vwap.toFixed(2),
        ema9:    +ema9.toFixed(2),
        ema21:   +ema21.toFixed(2),
        dly21:   dly21  != null ? +dly21.toFixed(2)  : null,
        adx:     adx    != null ? +adx.toFixed(1)    : null,
        rsi:     rsi    != null ? +rsi.toFixed(1)    : null,
        struct, htfBias, htf2Bias,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  return null;
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MNQ_SWING' };
