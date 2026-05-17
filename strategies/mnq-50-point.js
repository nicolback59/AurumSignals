'use strict';

/**
 * STRATEGY 3 — MNQ 50-POINT SETUPS
 *
 * Objective: Capture ~50 MNQ point moves with controlled risk.
 * Primary TF:  5-minute bars (bars)
 * HTF:         15-minute bars (htfBars)
 * Setup:       Tight consolidation → momentum breakout → 50-pt room available
 * Filters:     ATR must support 50-pt move, volume spike, strong candle close
 * Entry:       breakout above/below consolidation, or retest holds
 * SL:          behind breakout structure + 0.5 ATR (risk < 50 pts)
 * TP:          50 pts fixed, partial at 25 pts, trail after 35 pts
 * Min confidence: 80
 */

const {
  ema, calcAtr, calcVwap, calcRsi,
  calcHtfBias,
  isBullishCandle, isBearishCandle,
  detectConsolidation, hasVolumeSpike,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const STRATEGY_VERSION = '3.1';

const TARGET_PTS  = 50;   // fixed primary target
const PARTIAL_PTS = 25;   // partial exit
const ATR_MIN_PTS = 8;    // minimum 5m ATR for move to be plausible
const MIN_BAR_GAP = 1;    // 1 × 5m = 5 min spam guard — adaptive-cooldown.js handles strategy timing

let lastSignalBar = -999;

/**
 * Evaluate MNQ 50-point breakout setup.
 *
 * @param {object[]} bars     - 5m primary bars
 * @param {object[]} htfBars  - 15m bars
 * @param {object}   cfg
 * @param {number}   barIdx
 */
function evaluate(bars, htfBars, cfg = {}, barIdx = null) {
  const MIN_BARS = 25;
  if (bars.length < MIN_BARS || htfBars.length < 8) return null;

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

  const sess = getSessionInfo(last.timestamp);
  if (sess.quality < 0.20) return null; // only skip true dead-market sessions

  // ── HTF bias (15m) ────────────────────────────────────────────────────────────
  const htfBias = calcHtfBias(htfBars, 9, 21);

  // ── Consolidation detection — reject chop/expansion (atrRatio ≥ 2.5) ────────
  // Allow slightly noisier pre-breakout ranges for more signal frequency.
  const priorBars = bars.slice(0, -1); // exclude current bar
  const consol = detectConsolidation(priorBars, 12, 14);
  if (consol.atrRatio >= 2.5) return null;

  const consolAtrRatio = consol.atrRatio;
  const { rangeHigh, rangeLow, curAtr: consolAtr } = consol;

  // ── Volume spike (bonus but not required) ─────────────────────────────────────
  const volSpike = hasVolumeSpike(bars, 20, 1.3);

  // ── Breakout check — accept near-breakout (within 0.65 ATR of range edge) ────
  // Widened to catch near-breakout entries earlier.
  const breakoutLong  = last.close > rangeHigh - 0.65 * atr;
  const breakoutShort = last.close < rangeLow  + 0.65 * atr;
  const vwapAligned   = (breakoutLong && last.close > vwap) || (breakoutShort && last.close < vwap);

  // Also accept: retest of breakout level (lookback extended to 6 bars)
  const retestLong  = !breakoutLong  && hadRetestAbove(bars, rangeHigh, atr, 6);
  const retestShort = !breakoutShort && hadRetestBelow(bars, rangeLow,  atr, 6);

  const directions = [];
  if (breakoutLong  || retestLong)  directions.push('LONG');
  if (breakoutShort || retestShort) directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── Candle close strength — 20% body required for conviction ─────────────
    if (!(isBull ? isBullishCandle(last, 0.20) : isBearishCandle(last, 0.20))) continue;

    // ── Minimum momentum (RSI not extreme) ──────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 75) continue; // overbought — chase entries fail breakouts
      if (!isBull && rsi <= 25) continue; // oversold — avoid exhausted breakdowns
    }

    // ── Stop-loss (behind structure + 0.5 ATR) ──────────────────────────────
    const entry = last.close;
    let sl, rawRisk;

    if (isBull) {
      // Stop below the breakout level (consolidation high) or recent swing low
      const swLow = recentSwingLow(bars, 8);
      sl      = Math.min(rangeHigh - 0.5 * atr, swLow) - 0.5 * atr;
      rawRisk = entry - sl;
    } else {
      const swHigh = recentSwingHigh(bars, 8);
      sl      = Math.max(rangeLow + 0.5 * atr, swHigh) + 0.5 * atr;
      rawRisk = sl - entry;
    }

    // Risk bounds: at least 2 pts (not a dust stop), at most 1.2× target (60 pts)
    if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;
    const rrToTarget = TARGET_PTS / rawRisk;

    // ── 50-point room check ──────────────────────────────────────────────────
    // Check that the target has clear room before a major S/R level
    const tp1 = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
    const tp0 = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
    const tp2 = tp1; // same level — full target
    const tp3 = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

    const srDist = srDistanceAtr(isBull ? tp1 : tp1, bars, atr, 50);
    // Hard block if a major S/R level sits between entry and the 50-pt target.
    // A level within 1.0 ATR of the path to TP likely caps the move before it arrives.
    if (srDist < 1.0) continue;

    // ── Confidence score ─────────────────────────────────────────────────────
    const confidence = scoreSignal({
      direction: dir,
      bars,
      htfBias,
      htf2Bias: 0,
      hasHtf2: false,
      vwapVal: vwap,
      emaStackVal: vwapAligned ? 1 : 0,  // VWAP alignment is a scoring bonus, not a gate
      atr, atrMin: ATR_MIN_PTS,
      rr: rrToTarget,
      srDistanceAtr: srDist,
      timestamp: last.timestamp,
    });

    if (confidence < THRESHOLDS.MNQ_50PT) continue;

    lastSignalBar = curIdx;

    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

    const breakoutType = isBull
      ? (breakoutLong  ? 'breakout' : 'retest')
      : (breakoutShort ? 'breakdown' : 'retest');

    return {
      instrument:    'MNQ',
      strategy_name: 'MNQ_50PT',
      trade_style:   'intraday',
      timeframe:     '5m',
      direction:     dir,
      entry:         +entry.toFixed(2),
      sl:            +sl.toFixed(2),
      tp1:           +tp0.toFixed(2),   // partial at 25 pts shown as tp1
      tp2:           +tp1.toFixed(2),   // full 50 pts as tp2
      tp3:           +tp3.toFixed(2),   // extended target
      rr:            +rrToTarget.toFixed(2),
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3,
      score:         Math.round(confidence / 4),
      setup:            'MNQ 50-Point',
      strategy_version: STRATEGY_VERSION,
      htf_bias:         htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:       sess.name,
      trigger_reason: `Consolidation ${breakoutType} (range ${consol.rangePts?.toFixed(1)} pts), ATR expansion ×${consolAtrRatio.toFixed(2)}, 50-pt target clear`,
      indicators: {
        atr:         +atr.toFixed(2),
        vwap:        +vwap.toFixed(2),
        rangeHigh:   +rangeHigh.toFixed(2),
        rangeLow:    +rangeLow.toFixed(2),
        consolAtrRatio: +consolAtrRatio.toFixed(2),
        volSpike,
        rsi:         rsi != null ? +rsi.toFixed(1) : null,
        htfBias,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 2: VWAP Momentum Breakout
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.25) {
      const prevBar = bars[n - 1];
      const rsiArr2 = calcRsi(closes, 14);
      const rsi2    = rsiArr2[n];

      // LONG: fresh cross above VWAP, bullish candle, RSI 40-70, htfBias >= 0
      const longVwapMom = (
        last.close > vwap && prevBar && prevBar.close <= vwap &&
        isBullishCandle(last, 0.25) &&
        htfBias >= 0 &&
        rsi2 != null && rsi2 >= 40 && rsi2 <= 70
      );
      // SHORT: fresh cross below VWAP
      const shortVwapMom = (
        last.close < vwap && prevBar && prevBar.close >= vwap &&
        isBearishCandle(last, 0.25) &&
        htfBias <= 0 &&
        rsi2 != null && rsi2 >= 30 && rsi2 <= 60
      );

      for (const dir of (longVwapMom ? ['LONG'] : []).concat(shortVwapMom ? ['SHORT'] : [])) {
        const isBull = dir === 'LONG';
        const entry  = last.close;

        const tp0v = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
        const tp1v = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
        const tp3v = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

        // S/R check to target
        const srDistV = srDistanceAtr(tp1v, bars, atr, 50);
        if (srDistV < 0.8) continue;

        let sl, rawRisk;
        if (isBull) { sl = vwap - 1.2 * atr; rawRisk = entry - sl; }
        else         { sl = vwap + 1.2 * atr; rawRisk = sl - entry; }
        if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;

        const rrV = TARGET_PTS / rawRisk;
        const confidence = scoreSignal({
          direction: dir, bars, htfBias, htf2Bias: 0, hasHtf2: false,
          vwapVal: vwap, emaStackVal: 1,
          atr, atrMin: ATR_MIN_PTS, rr: rrV, srDistanceAtr: srDistV,
          timestamp: last.timestamp,
        });
        if (confidence < THRESHOLDS.MNQ_50PT) continue;

        lastSignalBar = curIdx;
        const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
        return {
          instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
          direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
          tp1: +tp0v.toFixed(2), tp2: +tp1v.toFixed(2), tp3: +tp3v.toFixed(2),
          rr: +rrV.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
          score: Math.round(confidence / 4),
          setup: 'VWAP Momentum', strategy_version: STRATEGY_VERSION,
          htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
          session: sess.name,
          trigger_reason: `VWAP momentum cross ${isBull ? 'above' : 'below'} — fresh cross with displacement candle, 50-pt target clear`,
          indicators: {
            atr: +atr.toFixed(2), vwap: +vwap.toFixed(2),
            rangeHigh: +rangeHigh.toFixed(2), rangeLow: +rangeLow.toFixed(2),
            consolAtrRatio: +consolAtrRatio.toFixed(2),
            volSpike, rsi: rsi2 != null ? +rsi2.toFixed(1) : null, htfBias,
          },
          timestamp: last.timestamp, trade_status: 'PENDING',
        };
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 3: Opening Drive Continuation
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.90) {
      // Require at least 6 bars for a drive measurement
      if (n >= 6) {
        const driveStart = bars[n - 6];
        const netMove    = last.close - driveStart.close;
        const isDriveLong  = netMove > 2 * atr && htfBias >= 0 && last.close > vwap;
        const isDriveShort = netMove < -2 * atr && htfBias <= 0 && last.close < vwap;

        // Pullback/pause: last bar not extending — within 1 ATR of bars[n-2].close
        const prevClose2 = bars[n - 2]?.close;
        const isPause    = prevClose2 != null && Math.abs(last.close - prevClose2) <= atr;

        for (const dir of (isDriveLong && isPause ? ['LONG'] : []).concat(isDriveShort && isPause ? ['SHORT'] : [])) {
          const isBull = dir === 'LONG';
          const entry  = last.close;
          let sl, rawRisk;
          if (isBull) {
            sl      = driveStart.low - 0.5 * atr;
            rawRisk = entry - sl;
          } else {
            sl      = driveStart.high + 0.5 * atr;
            rawRisk = sl - entry;
          }
          // Only if rawRisk < 60 pts
          if (rawRisk >= 60 || rawRisk < 2) continue;

          const tp0d = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
          const tp1d = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
          const tp3d = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;
          const rrD  = TARGET_PTS / rawRisk;

          const srDistD = srDistanceAtr(tp1d, bars, atr, 50);
          if (srDistD < 1.0) continue;

          const confidence = scoreSignal({
            direction: dir, bars, htfBias, htf2Bias: 0, hasHtf2: false,
            vwapVal: vwap, emaStackVal: 1,
            atr, atrMin: ATR_MIN_PTS, rr: rrD, srDistanceAtr: srDistD,
            timestamp: last.timestamp,
          });
          if (confidence < THRESHOLDS.MNQ_50PT) continue;

          lastSignalBar = curIdx;
          const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
          return {
            instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
            direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
            tp1: +tp0d.toFixed(2), tp2: +tp1d.toFixed(2), tp3: +tp3d.toFixed(2),
            rr: +rrD.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
            score: Math.round(confidence / 4),
            setup: 'Opening Drive', strategy_version: STRATEGY_VERSION,
            htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
            session: sess.name,
            trigger_reason: `Opening drive continuation ${isBull ? 'long' : 'short'} — ${Math.abs(netMove).toFixed(1)} pt drive with pause, HTF aligned`,
            indicators: {
              atr: +atr.toFixed(2), vwap: +vwap.toFixed(2),
              rangeHigh: +rangeHigh.toFixed(2), rangeLow: +rangeLow.toFixed(2),
              consolAtrRatio: +consolAtrRatio.toFixed(2),
              volSpike, rsi: null, htfBias,
            },
            timestamp: last.timestamp, trade_status: 'PENDING',
          };
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 4: Failed Breakdown / Failed Breakout Reversal
  // Price breaks below support (or above resistance) but immediately reverses —
  // a classic stop-hunt followed by a ~50-pt recovery move.
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.30) {
      const swLow5  = recentSwingLow(bars, 10);
      const swHigh5 = recentSwingHigh(bars, 10);
      const prevBar  = bars[n - 1];
      const prev2Bar = bars[n - 2];

      // LONG: prev bar wick broke below swLow5 but closed back above it; current bar bullish
      const failedBreakdownL = prevBar && prev2Bar &&
        prevBar.low < swLow5 - 0.1 * atr &&
        prevBar.close > swLow5 - 0.3 * atr &&
        last.close > prevBar.close &&
        isBullishCandle(last, 0.20) &&
        htfBias >= 0;

      // SHORT: prev bar wick broke above swHigh5 but closed back below; current bar bearish
      const failedBreakoutS  = prevBar && prev2Bar &&
        prevBar.high > swHigh5 + 0.1 * atr &&
        prevBar.close < swHigh5 + 0.3 * atr &&
        last.close < prevBar.close &&
        isBearishCandle(last, 0.20) &&
        htfBias <= 0;

      for (const dir of (failedBreakdownL ? ['LONG'] : []).concat(failedBreakoutS ? ['SHORT'] : [])) {
        const isBull = dir === 'LONG';
        const entry  = last.close;
        let sl, rawRisk;
        if (isBull) {
          sl      = prevBar.low - 0.5 * atr;
          rawRisk = entry - sl;
        } else {
          sl      = prevBar.high + 0.5 * atr;
          rawRisk = sl - entry;
        }
        if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;
        const rrFB = TARGET_PTS / rawRisk;

        const tp0fb = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
        const tp1fb = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
        const tp3fb = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

        const srDistFB = srDistanceAtr(tp1fb, bars, atr, 50);
        if (srDistFB < 0.8) continue;

        const rsiArrFB = calcRsi(closes, 14);
        const rsiFB    = rsiArrFB[n];
        if (rsiFB != null) {
          if (isBull  && rsiFB >= 75) continue;
          if (!isBull && rsiFB <= 25) continue;
        }

        const confidence = scoreSignal({
          direction: dir, bars, htfBias, htf2Bias: 0, hasHtf2: false,
          vwapVal: vwap, emaStackVal: vwap != null ? (isBull && last.close > vwap ? 1 : !isBull && last.close < vwap ? 1 : 0) : 0,
          atr, atrMin: ATR_MIN_PTS, rr: rrFB, srDistanceAtr: srDistFB,
          timestamp: last.timestamp,
        });
        if (confidence < THRESHOLDS.MNQ_50PT) continue;

        lastSignalBar = curIdx;
        const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
        return {
          instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
          direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
          tp1: +tp0fb.toFixed(2), tp2: +tp1fb.toFixed(2), tp3: +tp3fb.toFixed(2),
          rr: +rrFB.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
          score: Math.round(confidence / 4),
          setup: isBull ? 'Failed Breakdown Reversal' : 'Failed Breakout Reversal',
          strategy_version: STRATEGY_VERSION,
          htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
          session: sess.name,
          trigger_reason: `Failed ${isBull ? 'breakdown' : 'breakout'} — stop hunt beyond swing ${isBull ? 'low' : 'high'} rejected; price recovering with ${isBull ? 'bull' : 'bear'} candle`,
          indicators: {
            atr: +atr.toFixed(2), vwap: +vwap.toFixed(2), swLow5: +swLow5.toFixed(2), swHigh5: +swHigh5.toFixed(2),
            rsi: rsiFB != null ? +rsiFB.toFixed(1) : null, htfBias,
          },
          timestamp: last.timestamp, trade_status: 'PENDING',
        };
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 5: Power Hour Expansion (14:30–16:00 ET)
  // Late-session momentum expansion — often 50+ pts in 30–60 min
  // Requires clear HTF trend, VWAP aligned, ATR expanding
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.60) {
      // 'Afternoon ✓' is the session name from getSessionInfo() for 13:30–15:59 ET.
      // Power hour = last ~90 min of RTH (14:30+). Gate on hhmm for precision.
      const isPowerHour = sess.isAftNoon && sess.hhmm >= 1430;

      if (isPowerHour) {
        const ema9PH  = ema(closes, 9)[n];
        const ema21PH = ema(closes, 21)[n];
        const rsiPH   = calcRsi(closes, 14)[n];

        // LONG: uptrend (ema9 > ema21), above VWAP, RSI 45–65, fresh momentum
        const longPH  = ema9PH != null && ema21PH != null &&
                        ema9PH > ema21PH && last.close > vwap &&
                        rsiPH != null && rsiPH >= 45 && rsiPH <= 68 &&
                        htfBias >= 0 && isBullishCandle(last, 0.25);

        // SHORT: downtrend, below VWAP, RSI 32–55
        const shortPH = ema9PH != null && ema21PH != null &&
                        ema9PH < ema21PH && last.close < vwap &&
                        rsiPH != null && rsiPH >= 32 && rsiPH <= 55 &&
                        htfBias <= 0 && isBearishCandle(last, 0.25);

        for (const dir of (longPH ? ['LONG'] : []).concat(shortPH ? ['SHORT'] : [])) {
          const isBull = dir === 'LONG';
          const entry  = last.close;

          let sl, rawRisk;
          const swLowPH  = recentSwingLow(bars, 6);
          const swHighPH = recentSwingHigh(bars, 6);
          if (isBull) {
            sl      = Math.min(swLowPH, vwap) - 0.5 * atr;
            rawRisk = entry - sl;
          } else {
            sl      = Math.max(swHighPH, vwap) + 0.5 * atr;
            rawRisk = sl - entry;
          }
          if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;
          const rrPH = TARGET_PTS / rawRisk;

          const tp0ph = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
          const tp1ph = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
          const tp3ph = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

          const srDistPH = srDistanceAtr(tp1ph, bars, atr, 50);
          if (srDistPH < 0.8) continue;

          const confidence = scoreSignal({
            direction: dir, bars, htfBias, htf2Bias: 0, hasHtf2: false,
            vwapVal: vwap, emaStackVal: 1,
            atr, atrMin: ATR_MIN_PTS, rr: rrPH, srDistanceAtr: srDistPH,
            timestamp: last.timestamp,
          });
          if (confidence < THRESHOLDS.MNQ_50PT) continue;

          lastSignalBar = curIdx;
          const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
          return {
            instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
            direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
            tp1: +tp0ph.toFixed(2), tp2: +tp1ph.toFixed(2), tp3: +tp3ph.toFixed(2),
            rr: +rrPH.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
            score: Math.round(confidence / 4),
            setup: 'Power Hour Expansion', strategy_version: STRATEGY_VERSION,
            htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
            session: sess.name,
            trigger_reason: `Power hour ${isBull ? 'bull' : 'bear'} expansion — clear ${isBull ? 'uptrend' : 'downtrend'}, VWAP aligned, RSI mid-range, late-session momentum`,
            indicators: {
              atr: +atr.toFixed(2), vwap: +vwap.toFixed(2),
              ema9: ema9PH != null ? +ema9PH.toFixed(2) : null,
              ema21: ema21PH != null ? +ema21PH.toFixed(2) : null,
              rsi: rsiPH != null ? +rsiPH.toFixed(1) : null, htfBias,
            },
            timestamp: last.timestamp, trade_status: 'PENDING',
          };
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 6: Post-Liquidity Sweep Momentum (5m level sweep → recovery)
  // After a liquidity sweep (stop hunt) on 5m, price reverses and targets 50 pts
  // Requires: sweep of recent 5m swing low/high, recovery close, HTF aligned
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.30) {
      const swLowLS  = recentSwingLow(bars, 8);
      const swHighLS = recentSwingHigh(bars, 8);
      const prev1    = bars[n - 1];
      const prev2    = bars[n - 2];

      // LONG: prior bar swept below swLowLS (wick < swLow - 0.05*atr), closed back above; current bar bullish
      const sweepLong  = prev1 && prev2 &&
                         prev1.low < swLowLS - 0.05 * atr &&
                         prev1.close > swLowLS &&
                         last.close > prev1.close &&
                         isBullishCandle(last, 0.20) && htfBias >= 0;

      // SHORT: prior bar swept above swHighLS, closed back below; current bar bearish
      const sweepShort = prev1 && prev2 &&
                         prev1.high > swHighLS + 0.05 * atr &&
                         prev1.close < swHighLS &&
                         last.close < prev1.close &&
                         isBearishCandle(last, 0.20) && htfBias <= 0;

      for (const dir of (sweepLong ? ['LONG'] : []).concat(sweepShort ? ['SHORT'] : [])) {
        const isBull = dir === 'LONG';
        const entry  = last.close;

        let sl, rawRisk;
        if (isBull) {
          sl      = prev1.low - 0.4 * atr;
          rawRisk = entry - sl;
        } else {
          sl      = prev1.high + 0.4 * atr;
          rawRisk = sl - entry;
        }
        if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;
        const rrLS = TARGET_PTS / rawRisk;

        const tp0ls = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
        const tp1ls = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
        const tp3ls = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

        const srDistLS = srDistanceAtr(tp1ls, bars, atr, 50);
        if (srDistLS < 0.8) continue;

        const rsiLS = calcRsi(closes, 14)[n];
        if (rsiLS != null) {
          if (isBull  && rsiLS >= 75) continue;
          if (!isBull && rsiLS <= 25) continue;
        }

        const confidence = scoreSignal({
          direction: dir, bars, htfBias, htf2Bias: 0, hasHtf2: false,
          vwapVal: vwap, emaStackVal: (isBull && last.close > vwap) || (!isBull && last.close < vwap) ? 1 : 0,
          atr, atrMin: ATR_MIN_PTS, rr: rrLS, srDistanceAtr: srDistLS,
          timestamp: last.timestamp,
        });
        if (confidence < THRESHOLDS.MNQ_50PT) continue;

        lastSignalBar = curIdx;
        const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
        return {
          instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
          direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
          tp1: +tp0ls.toFixed(2), tp2: +tp1ls.toFixed(2), tp3: +tp3ls.toFixed(2),
          rr: +rrLS.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
          score: Math.round(confidence / 4),
          setup: 'Post-Liquidity Sweep Momentum', strategy_version: STRATEGY_VERSION,
          htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
          session: sess.name,
          trigger_reason: `Liquidity sweep ${isBull ? 'below' : 'above'} 5m swing ${isBull ? 'low' : 'high'} — stop hunt complete, momentum ${isBull ? 'long' : 'short'} targeting 50 pts`,
          indicators: {
            atr: +atr.toFixed(2), vwap: +vwap.toFixed(2),
            sweepBar: { low: +prev1.low.toFixed(2), high: +prev1.high.toFixed(2), close: +prev1.close.toFixed(2) },
            rsi: rsiLS != null ? +rsiLS.toFixed(1) : null, htfBias,
          },
          timestamp: last.timestamp, trade_status: 'PENDING',
        };
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 7: 15m Structure Break into 50-Point Expansion
  // The 15m chart (htfBars for this strategy) prints a clean structure break
  // (close above prior 15m swing high, or below prior 15m swing low) with
  // strong candle, while the 5m is in alignment — targets 50-pt expansion.
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.30 && htfBars.length >= 12) {
      const h15n    = htfBars.length - 1;
      const h15Last = htfBars[h15n];
      const h15Atr  = calcAtr(htfBars, 14)[h15n];

      if (h15Atr && h15Last) {
        // 15m swing levels over last 6 15m bars (= last 30m)
        const swHigh15 = Math.max(...htfBars.slice(-7, -1).map(b => b.high));
        const swLow15  = Math.min(...htfBars.slice(-7, -1).map(b => b.low));

        // Structure break: 15m bar closed decisively above prior swing high (bull)
        const breakBull15 = h15Last.close > swHigh15 + 0.1 * h15Atr &&
                            isBullishCandle(h15Last, 0.30) && htfBias >= 0;
        const breakBear15 = h15Last.close < swLow15  - 0.1 * h15Atr &&
                            isBearishCandle(h15Last, 0.30) && htfBias <= 0;

        // 5m must confirm: price above VWAP (bull) or below (bear), recent 5m candle strong
        const confirmBull = breakBull15 && last.close > vwap && isBullishCandle(last, 0.20);
        const confirmBear = breakBear15 && last.close < vwap && isBearishCandle(last, 0.20);

        for (const dir of (confirmBull ? ['LONG'] : []).concat(confirmBear ? ['SHORT'] : [])) {
          const isBull = dir === 'LONG';
          const entry  = last.close;

          // RSI not extreme
          const rsi15 = calcRsi(closes, 14)[n];
          if (rsi15 != null) {
            if (isBull  && rsi15 >= 78) continue;
            if (!isBull && rsi15 <= 22) continue;
          }

          let sl, rawRisk;
          if (isBull) {
            // Stop below the 15m structure break level
            sl      = swHigh15 - 0.5 * atr;
            rawRisk = entry - sl;
          } else {
            sl      = swLow15  + 0.5 * atr;
            rawRisk = sl - entry;
          }
          if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;
          const rrSB = TARGET_PTS / rawRisk;

          const tp0sb = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
          const tp1sb = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
          const tp3sb = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

          const srDistSB = srDistanceAtr(tp1sb, bars, atr, 50);
          if (srDistSB < 0.8) continue;

          const confidence = scoreSignal({
            direction: dir, bars, htfBias, htf2Bias: 0, hasHtf2: false,
            vwapVal: vwap, emaStackVal: 1,
            atr, atrMin: ATR_MIN_PTS, rr: rrSB, srDistanceAtr: srDistSB,
            timestamp: last.timestamp,
          });
          if (confidence < THRESHOLDS.MNQ_50PT) continue;

          lastSignalBar = curIdx;
          const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
          return {
            instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
            direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
            tp1: +tp0sb.toFixed(2), tp2: +tp1sb.toFixed(2), tp3: +tp3sb.toFixed(2),
            rr: +rrSB.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
            score: Math.round(confidence / 4),
            setup: '15m Structure Break', strategy_version: STRATEGY_VERSION,
            htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
            session: sess.name,
            trigger_reason: `15m structure break ${isBull ? 'above' : 'below'} prior swing ${isBull ? 'high' : 'low'} — clean displacement candle, 5m VWAP aligned, 50-pt expansion targeted`,
            indicators: {
              atr: +atr.toFixed(2), vwap: +vwap.toFixed(2),
              swHigh15: +swHigh15.toFixed(2), swLow15: +swLow15.toFixed(2),
              h15Atr: h15Atr != null ? +h15Atr.toFixed(2) : null,
              rsi: rsi15 != null ? +rsi15.toFixed(1) : null, htfBias,
            },
            timestamp: last.timestamp, trade_status: 'PENDING',
          };
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ARCHETYPE 8: HTF-Aligned Compression Breakout (Multi-TF Confluence)
  // Tight 5m compression (low ATR ratio) breaks with strong displacement candle
  // WHILE the 15m is also pointing in the same direction — stronger version of
  // Archetype 1 with explicit 15m HTF bias confirmation for higher RR setups.
  // ══════════════════════════════════════════════════════════════════════════
  {
    if (atr >= ATR_MIN_PTS && sess.quality >= 0.35 && htfBars.length >= 22) { // need 22 bars for EMA21
      // Require tight consolidation: atrRatio below 1.8 (tighter than Archetype 1's 2.5)
      const consol8 = detectConsolidation(bars.slice(0, -1), 10, 14);
      if (consol8.atrRatio < 1.8 && consol8.atrRatio >= 0.3) {
        const rng8H = consol8.rangeHigh;
        const rng8L = consol8.rangeLow;

        // 15m bias via EMA of htfBars
        const h15Closes = htfBars.map(b => b.close);
        const h15Ema9   = ema(h15Closes, 9)[htfBars.length - 1];
        const h15Ema21  = ema(h15Closes, 21)[htfBars.length - 1];
        const h15Bull   = h15Ema9 != null && h15Ema21 != null && h15Ema9 > h15Ema21;
        const h15Bear   = h15Ema9 != null && h15Ema21 != null && h15Ema9 < h15Ema21;

        // Breakout with strong close beyond range and 15m bias aligned
        const boBull = last.close > rng8H + 0.3 * atr && isBullishCandle(last, 0.30) &&
                       htfBias >= 0 && h15Bull;
        const boBear = last.close < rng8L - 0.3 * atr && isBearishCandle(last, 0.30) &&
                       htfBias <= 0 && h15Bear;

        for (const dir of (boBull ? ['LONG'] : []).concat(boBear ? ['SHORT'] : [])) {
          const isBull = dir === 'LONG';
          const entry  = last.close;

          const rsi8 = calcRsi(closes, 14)[n];
          if (rsi8 != null) {
            if (isBull  && rsi8 >= 78) continue;
            if (!isBull && rsi8 <= 22) continue;
          }

          let sl, rawRisk;
          if (isBull) {
            sl      = rng8H - 0.5 * atr;
            rawRisk = entry - sl;
          } else {
            sl      = rng8L + 0.5 * atr;
            rawRisk = sl - entry;
          }
          if (rawRisk < 2 || rawRisk > TARGET_PTS * 1.2) continue;
          const rr8 = TARGET_PTS / rawRisk;

          const tp08 = isBull ? entry + PARTIAL_PTS : entry - PARTIAL_PTS;
          const tp18 = isBull ? entry + TARGET_PTS  : entry - TARGET_PTS;
          const tp38 = isBull ? entry + TARGET_PTS * 1.4 : entry - TARGET_PTS * 1.4;

          const srDist8 = srDistanceAtr(tp18, bars, atr, 50);
          if (srDist8 < 1.0) continue;

          const confidence = scoreSignal({
            direction: dir, bars, htfBias, htf2Bias: (isBull && h15Bull) ? 1 : (!isBull && h15Bear) ? -1 : 0, hasHtf2: true,
            vwapVal: vwap, emaStackVal: (isBull && last.close > vwap) || (!isBull && last.close < vwap) ? 1 : 0,
            atr, atrMin: ATR_MIN_PTS, rr: rr8, srDistanceAtr: srDist8,
            timestamp: last.timestamp,
          });
          if (confidence < THRESHOLDS.MNQ_50PT) continue;

          lastSignalBar = curIdx;
          const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);
          return {
            instrument: 'MNQ', strategy_name: 'MNQ_50PT', trade_style: 'intraday', timeframe: '5m',
            direction: dir, entry: +entry.toFixed(2), sl: +sl.toFixed(2),
            tp1: +tp08.toFixed(2), tp2: +tp18.toFixed(2), tp3: +tp38.toFixed(2),
            rr: +rr8.toFixed(2), confidence, grade, win_prob_tp1, win_prob_tp2, win_prob_tp3,
            score: Math.round(confidence / 4),
            setup: 'HTF-Aligned Compression Breakout', strategy_version: STRATEGY_VERSION,
            htf_bias: htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
            session: sess.name,
            trigger_reason: `Tight 5m compression (atrRatio=${consol8.atrRatio.toFixed(2)}) breaks ${isBull ? 'above' : 'below'} with 15m EMA bias confirmed — dual-TF expansion signal`,
            indicators: {
              atr: +atr.toFixed(2), vwap: +vwap.toFixed(2),
              rangeHigh: +rng8H.toFixed(2), rangeLow: +rng8L.toFixed(2),
              consolAtrRatio: +consol8.atrRatio.toFixed(2),
              h15Ema9: h15Ema9 != null ? +h15Ema9.toFixed(2) : null,
              h15Ema21: h15Ema21 != null ? +h15Ema21.toFixed(2) : null,
              rsi: rsi8 != null ? +rsi8.toFixed(1) : null, htfBias,
            },
            timestamp: last.timestamp, trade_status: 'PENDING',
          };
        }
      }
    }
  }

  return null;
}

// ── Helper: had a retest hold above level in last N bars ─────────────────────

function hadRetestAbove(bars, level, atr, lookback = 4) {
  const slice = bars.slice(-lookback - 1, -1);
  // At least one bar's low touched the level from above and closed back above
  return slice.some(b => b.low <= level + 0.3 * atr && b.close >= level - 0.3 * atr);
}

function hadRetestBelow(bars, level, atr, lookback = 4) {
  const slice = bars.slice(-lookback - 1, -1);
  return slice.some(b => b.high >= level - 0.3 * atr && b.close <= level + 0.3 * atr);
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, TARGET_PTS, ATR_MIN_PTS, STRATEGY_NAME: 'MNQ_50PT', STRATEGY_VERSION };
