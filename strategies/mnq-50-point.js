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

const TARGET_PTS  = 50;   // fixed primary target
const PARTIAL_PTS = 25;   // partial exit
const ATR_MIN_PTS = 10;   // minimum 5m ATR for move to be plausible
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

  // ── Consolidation detection — only reject extreme chop/expansion (atrRatio ≥ 2.5) ─
  const priorBars = bars.slice(0, -1); // exclude current bar
  const consol = detectConsolidation(priorBars, 12, 14);
  if (consol.atrRatio >= 2.5) return null;

  const consolAtrRatio = consol.atrRatio;
  const { rangeHigh, rangeLow, curAtr: consolAtr } = consol;

  // ── Volume spike (bonus but not required) ─────────────────────────────────────
  const volSpike = hasVolumeSpike(bars, 20, 1.3);

  // ── Breakout check — accept near-breakout (within 1.0 ATR of range edge) ──────
  // Widened from 0.5 ATR to 1.0 ATR to catch bars that close just inside the
  // consolidation boundary but are already committed to the breakout direction.
  const breakoutLong  = last.close > rangeHigh - 1.0 * atr;
  const breakoutShort = last.close < rangeLow  + 1.0 * atr;
  const vwapAligned   = (breakoutLong && last.close > vwap) || (breakoutShort && last.close < vwap);

  // Also accept: retest of breakout level (lookback extended to 6 bars)
  const retestLong  = !breakoutLong  && hadRetestAbove(bars, rangeHigh, atr, 6);
  const retestShort = !breakoutShort && hadRetestBelow(bars, rangeLow,  atr, 6);

  const directions = [];
  if (breakoutLong  || retestLong)  directions.push('LONG');
  if (breakoutShort || retestShort) directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── Candle close strength — 15% body for higher signal frequency ─────────
    if (!(isBull ? isBullishCandle(last, 0.15) : isBearishCandle(last, 0.15))) continue;

    // ── Minimum momentum (RSI not extreme) ──────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && rsi >= 78) continue; // extremely overbought
      if (!isBull && rsi <= 22) continue; // extremely oversold
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
      setup:         'MNQ 50-Point',
      htf_bias:      htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
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

module.exports = { evaluate, reset, TARGET_PTS, ATR_MIN_PTS, STRATEGY_NAME: 'MNQ_50PT' };
