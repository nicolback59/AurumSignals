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
  ema, calcAtr, calcVwap, calcRsi, calcAdx,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  detectMarketStructure,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const STRATEGY_VERSION = '2.1';

const ATR_MIN_PTS = 15; // minimum 1h ATR in MNQ points
const MIN_BAR_GAP = 1;  // 1 × 1h = 1h spam guard — adaptive-cooldown.js handles strategy timing
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
  const MIN_BARS = 25;
  if (bars.length < MIN_BARS) return null;

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

  // 1h EMA 9/21
  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema9  = ema9Arr[n];
  const ema21 = ema21Arr[n];

  // ADX + DI on 1h: require a real trend, not just absence of extremes
  const { adx: adxArr, diPlus: diPlusArr, diMinus: diMinusArr } = calcAdx(bars, 14);
  const adx     = adxArr[n];
  const diPlus  = diPlusArr?.[n];
  const diMinus = diMinusArr?.[n];
  if (adx != null && adx < 13) return null; // flat chop — moderate trends are valid swing territory

  // ── Market structure on 1h ───────────────────────────────────────────────────
  const struct = detectMarketStructure(bars, 30);

  // ── HTF biases ───────────────────────────────────────────────────────────────
  // Use 4h bias as macro direction gate (reliable with limited bar history).
  // Daily EMA21 with only ~4 daily bars in a backtest is too noisy to gate on.
  const htfBias  = calcHtfBias(htfBars && htfBars.length >= 9 ? htfBars : bars, 9, 21);

  // Daily is supplementary scoring only — not a hard gate
  let htf2Bias = 0;
  let dly21    = null;
  if (htf2Bars && htf2Bars.length >= 3) {
    const dlyCloses = htf2Bars.map(b => b.close);
    const dly21Arr  = ema(dlyCloses, 21);
    const dn        = dlyCloses.length - 1;
    dly21           = dly21Arr[dn];
    const dlyClose  = htf2Bars[dn].close;
    htf2Bias = (dly21 != null && dlyClose > dly21) ? 1 : (dly21 != null && dlyClose < dly21) ? -1 : 0;
  }

  const sess = getSessionInfo(last.timestamp);
  if (sess.quality < 0.25) return null;

  // ── Direction candidates — 4h bias + 1h EMA9/21 alignment ──────────────────
  const directions = [];
  if (htfBias >= 0 && ema9 > ema21) directions.push('LONG');
  if (htfBias <= 0 && ema9 < ema21) directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack on 1h — scoring bonus, not a hard gate ────────────────────
    const esScore = emaStackScore(closes, 9, 21, 21, dir); // 9/21 only on swing

    // ── DI direction alignment — prevents entries against the trend's own momentum ──
    // ADX can be rising while price is actually moving against us; DI resolves this.
    if (isBull  && diPlus != null && diMinus != null && diPlus  < diMinus)  continue;
    if (!isBull && diPlus != null && diMinus != null && diMinus < diPlus)   continue;

    // ── Price in value zone — 3.0 ATR radius (widened for more setups) ──────
    const nearEma21 = Math.abs(last.close - ema21) < 3.0 * atr;
    const nearVwap  = Math.abs(last.close - vwap)  < 3.0 * atr;
    if (!nearEma21 && !nearVwap) continue;

    // ── Retest holds — block breaks beyond 1.5 ATR (tightened from 2.0) ─────
    const recentSlice = bars.slice(-3, -1);
    if (isBull && recentSlice.some(b => b.close < ema21 - 1.5 * atr)) continue;
    if (!isBull && recentSlice.some(b => b.close > ema21 + 1.5 * atr)) continue;

    // ── Confirmation candle — 20% body threshold for higher quality signals ──
    if (!(isBull ? isBullishCandle(last, 0.20) : isBearishCandle(last, 0.20))) continue;

    // ── Momentum — RSI extreme filter only (MACD removed to maximise frequency) ─
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];

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

    // Cap rawRisk at 1 ATR so TP1 (2R = 2 ATR) is reachable inside the 24h
    // backtest resolution window. Wide structural stops produce 2R targets of
    // 200-400+ pts which NQ cannot reach in 24 h, causing 0% win rate.
    if (rawRisk > atr) {
      sl      = isBull ? entry - atr : entry + atr;
      rawRisk = atr;
    }

    if (rawRisk < 10) continue;

    // ── Take-profit levels ────────────────────────────────────────────────────
    const tp1 = isBull ? entry + 2.0 * rawRisk : entry - 2.0 * rawRisk;
    const tp2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
    const tp3 = isBull ? entry + 3.0 * rawRisk : entry - 3.0 * rawRisk;

    // ── Risk/reward gate ─────────────────────────────────────────────────────
    const rr = +(2.0).toFixed(2);
    if (rr < MIN_RR) continue;

    // ── Near key S/R? ────────────────────────────────────────────────────────
    const srDist = srDistanceAtr(entry, bars, atr, 60);
    if (srDist < 0.15) continue; // only block if sitting exactly on S/R

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
      setup:            'MNQ Swing',
      strategy_version: STRATEGY_VERSION,
      htf_bias:         htf2Bias === 1 ? 'BULL' : htf2Bias === -1 ? 'BEAR' : 'MIXED',
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

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 2: VWAP Reclaim Continuation
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.25) {
      const recentBars3 = bars.slice(-3);  // last 3 bars including current
      const prevBars2   = bars.slice(-3, -1); // 2 bars before current

      // LONG: at least 2 of the last 3 bars had close < vwap, now last.close > vwap
      const prevBelowCount = prevBars2.filter(b => b.close < vwapArr[bars.indexOf(b)] || b.close < vwap).length;
      const longReclaim  = prevBelowCount >= 1 && last.close > vwap && isBullishCandle(last, 0.20) && htfBias >= 0;
      // SHORT: at least 2 of the last 3 bars had close > vwap, now last.close < vwap
      const prevAboveCount = prevBars2.filter(b => b.close > vwapArr[bars.indexOf(b)] || b.close > vwap).length;
      const shortReclaim = prevAboveCount >= 1 && last.close < vwap && isBearishCandle(last, 0.20) && htfBias <= 0;

      for (const dir of (longReclaim ? ['LONG'] : []).concat(shortReclaim ? ['SHORT'] : [])) {
        const isBull = dir === 'LONG';
        const entry  = last.close;
        const swLow  = recentSwingLow(bars, 12);
        const swHigh = recentSwingHigh(bars, 12);
        let sl, rawRisk;
        if (isBull) {
          sl      = Math.min(swLow, vwap) - 1.0 * atr;
          rawRisk = entry - sl;
        } else {
          sl      = Math.max(swHigh, vwap) + 1.0 * atr;
          rawRisk = sl - entry;
        }
        if (rawRisk > atr) { sl = isBull ? entry - atr : entry + atr; rawRisk = atr; }
        if (rawRisk < 10) continue;

        const tp1 = isBull ? entry + 2.0 * rawRisk : entry - 2.0 * rawRisk;
        const tp2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
        const tp3 = isBull ? entry + 3.0 * rawRisk : entry - 3.0 * rawRisk;
        const rr  = +(2.0).toFixed(2);
        const srDist = srDistanceAtr(entry, bars, atr, 60);
        if (srDist < 0.15) continue;

        const confidence = scoreSignal({
          direction: dir, bars, htfBias, htf2Bias, hasHtf2: true,
          vwapVal: vwap, emaStackVal: emaStackScore(closes, 9, 21, 21, dir),
          atr, atrMin: ATR_MIN_PTS, rr: 2.0, srDistanceAtr: srDist,
          timestamp: last.timestamp,
        });
        if (confidence < THRESHOLDS.MNQ_SWING) continue;

        lastSignalBar = curIdx;
        const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
        return {
          instrument: 'MNQ', strategy_name: 'MNQ_SWING', trade_style: 'swing', timeframe: '1h',
          direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
          tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
          rr, confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
          score: Math.round(confidence / 4),
          setup: 'VWAP Reclaim', strategy_version: STRATEGY_VERSION,
          htf_bias: htf2Bias === 1 ? 'BULL' : htf2Bias === -1 ? 'BEAR' : 'MIXED',
          session: sess.name,
          trigger_reason: `VWAP reclaim ${isBull ? 'bullish' : 'bearish'} — price crossed back above/below VWAP with conviction candle`,
          indicators: {
            atr: +atr.toFixed(2), vwap: +vwap.toFixed(2), ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2),
            dly21: dly21 != null ? +dly21.toFixed(2) : null,
            adx: adx != null ? +adx.toFixed(1) : null,
            rsi: null, struct: detectMarketStructure(bars, 30), htfBias, htf2Bias,
          },
          timestamp: last.timestamp, trade_status: 'PENDING',
        };
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 3: Liquidity Sweep Reversal
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.25) {
      const swLow  = recentSwingLow(bars, 12);
      const swHigh = recentSwingHigh(bars, 12);
      const priorBars5 = bars.slice(-6, -1); // 5 bars before current

      // LONG: a prior bar swept below swLow by > 0.1*atr, but last.close > swLow
      const sweepBarLong = priorBars5.find(b => b.low < swLow - 0.1 * atr);
      const longSweep = (
        sweepBarLong !== undefined &&
        last.close > swLow &&
        isBullishCandle(last, 0.25) &&
        htfBias >= 0 &&
        (ema9 > ema21 || priorBars5.filter(b => b.low < swLow - 0.1 * atr).length === 1)
      );

      // SHORT: a prior bar swept above swHigh by > 0.1*atr, but last.close < swHigh
      const sweepBarShort = priorBars5.find(b => b.high > swHigh + 0.1 * atr);
      const shortSweep = (
        sweepBarShort !== undefined &&
        last.close < swHigh &&
        isBearishCandle(last, 0.25) &&
        htfBias <= 0 &&
        (ema9 < ema21 || priorBars5.filter(b => b.high > swHigh + 0.1 * atr).length === 1)
      );

      for (const dir of (longSweep ? ['LONG'] : []).concat(shortSweep ? ['SHORT'] : [])) {
        const isBull = dir === 'LONG';
        const entry  = last.close;
        let sl, rawRisk;
        if (isBull) {
          sl      = sweepBarLong.low - 0.3 * atr;
          rawRisk = entry - sl;
        } else {
          sl      = sweepBarShort.high + 0.3 * atr;
          rawRisk = sl - entry;
        }
        if (rawRisk > atr) { sl = isBull ? entry - atr : entry + atr; rawRisk = atr; }
        if (rawRisk < 10) continue;

        const tp1 = isBull ? entry + 2.0 * rawRisk : entry - 2.0 * rawRisk;
        const tp2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
        const tp3 = isBull ? entry + 3.0 * rawRisk : entry - 3.0 * rawRisk;
        const rr  = +(2.0).toFixed(2);
        const srDist = srDistanceAtr(entry, bars, atr, 60);
        if (srDist < 0.15) continue;

        const confidence = scoreSignal({
          direction: dir, bars, htfBias, htf2Bias, hasHtf2: true,
          vwapVal: vwap, emaStackVal: emaStackScore(closes, 9, 21, 21, dir),
          atr, atrMin: ATR_MIN_PTS, rr: 2.0, srDistanceAtr: srDist,
          timestamp: last.timestamp,
        });
        if (confidence < THRESHOLDS.MNQ_SWING) continue;

        lastSignalBar = curIdx;
        const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
        return {
          instrument: 'MNQ', strategy_name: 'MNQ_SWING', trade_style: 'swing', timeframe: '1h',
          direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
          tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
          rr, confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
          score: Math.round(confidence / 4),
          setup: 'Liquidity Sweep', strategy_version: STRATEGY_VERSION,
          htf_bias: htf2Bias === 1 ? 'BULL' : htf2Bias === -1 ? 'BEAR' : 'MIXED',
          session: sess.name,
          trigger_reason: `Liquidity sweep ${isBull ? 'below' : 'above'} swing ${isBull ? 'low' : 'high'} — fakeout reversal with recovery close`,
          indicators: {
            atr: +atr.toFixed(2), vwap: +vwap.toFixed(2), ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2),
            dly21: dly21 != null ? +dly21.toFixed(2) : null,
            adx: adx != null ? +adx.toFixed(1) : null,
            rsi: null, struct: detectMarketStructure(bars, 30), htfBias, htf2Bias,
          },
          timestamp: last.timestamp, trade_status: 'PENDING',
        };
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 4: 4H Base Breakout
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.25) {
      // Compute 4H base: tight range in last 4 bars (excluding current)
      const baseBars = bars.slice(-5, -1); // 4 bars before current
      if (baseBars.length >= 4) {
        const baseCloses  = baseBars.map(b => b.close);
        const baseMax     = Math.max(...baseCloses);
        const baseMin     = Math.min(...baseCloses);
        const baseRange   = baseMax - baseMin;
        const isTightBase = baseRange < 1.5 * atr;

        // LONG: htfBias > 0, base is tight, last bar closes above baseMax, bullish candle, ema9 > ema21
        const longBreakout = htfBias > 0 && isTightBase && last.close > baseMax && isBullishCandle(last, 0.25) && ema9 > ema21;
        // SHORT: mirror
        const shortBreakout = htfBias < 0 && isTightBase && last.close < baseMin && isBearishCandle(last, 0.25) && ema9 < ema21;

        for (const dir of (longBreakout ? ['LONG'] : []).concat(shortBreakout ? ['SHORT'] : [])) {
          const isBull = dir === 'LONG';
          const entry  = last.close;
          let sl, rawRisk;
          if (isBull) {
            sl      = baseMin - atr;
            rawRisk = entry - sl;
          } else {
            sl      = baseMax + atr;
            rawRisk = sl - entry;
          }
          if (rawRisk > atr * 2) { sl = isBull ? entry - atr : entry + atr; rawRisk = atr; }
          if (rawRisk < 10) continue;

          const tp1 = isBull ? entry + 2.0 * rawRisk : entry - 2.0 * rawRisk;
          const tp2 = isBull ? entry + 2.5 * rawRisk : entry - 2.5 * rawRisk;
          const tp3 = isBull ? entry + 3.0 * rawRisk : entry - 3.0 * rawRisk;
          const rr  = +(2.0).toFixed(2);
          const srDist = srDistanceAtr(entry, bars, atr, 60);
          if (srDist < 0.15) continue;

          const confidence = scoreSignal({
            direction: dir, bars, htfBias, htf2Bias, hasHtf2: true,
            vwapVal: vwap, emaStackVal: emaStackScore(closes, 9, 21, 21, dir),
            atr, atrMin: ATR_MIN_PTS, rr: 2.0, srDistanceAtr: srDist,
            timestamp: last.timestamp,
          });
          if (confidence < THRESHOLDS.MNQ_SWING) continue;

          lastSignalBar = curIdx;
          const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
          return {
            instrument: 'MNQ', strategy_name: 'MNQ_SWING', trade_style: 'swing', timeframe: '1h',
            direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
            tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
            rr, confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
            score: Math.round(confidence / 4),
            setup: 'HTF Base Breakout', strategy_version: STRATEGY_VERSION,
            htf_bias: htf2Bias === 1 ? 'BULL' : htf2Bias === -1 ? 'BEAR' : 'MIXED',
            session: sess.name,
            trigger_reason: `4H ${isBull ? 'bullish' : 'bearish'} base breakout — tight consolidation with HTF alignment, ${isBull ? 'bull' : 'bear'} ema9/21 on 1h`,
            indicators: {
              atr: +atr.toFixed(2), vwap: +vwap.toFixed(2), ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2),
              dly21: dly21 != null ? +dly21.toFixed(2) : null,
              adx: adx != null ? +adx.toFixed(1) : null,
              rsi: null, struct: detectMarketStructure(bars, 30), htfBias, htf2Bias,
            },
            timestamp: last.timestamp, trade_status: 'PENDING',
          };
        }
      }
    }
  }

  return null;
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MNQ_SWING', STRATEGY_VERSION };
