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
 * Min confidence: 65
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

const STRATEGY_VERSION = '3.0';

// Minimum ATR in MNQ points for intraday to be worth trading
const ATR_MIN_PTS = 10;  // raised from 8 — sub-10pt ATR sessions lack follow-through
// Cooldown: minimum bars between signals on this strategy
const MIN_BAR_GAP = 4;  // 4 × 5m = 20 min spam guard — prevents cluster entries

let lastSignalBar = -999;

/**
 * Evaluate MNQ intraday setup on confirmed bars.
 *
 * @param {object[]} bars       - 5m primary bars (last = most recent confirmed)
 * @param {object[]} htfBars    - 15m bars
 * @param {object[]} htf2Bars   - 1h bars
 * @param {object[]} htf4hBars  - 4h bars (optional; old callers may pass cfg here)
 * @param {object}   cfg        - { instrument?, cooldownBars? }
 * @param {number}   barIdx     - current absolute bar index (for backtest cooldown)
 * @returns {object|null} signal or null
 */
function evaluate(bars, htfBars, htf2Bars, htf4hBars, cfg = {}, barIdx = null) {
  // Backward compat: old callers pass (bars, htfBars, htf2Bars, cfg, barIdx)
  // Detect by checking if htf4hBars is a plain object (cfg) rather than an array.
  if (htf4hBars !== null && htf4hBars !== undefined && !Array.isArray(htf4hBars)) {
    // shift args: htf4hBars is actually cfg, cfg is actually barIdx
    barIdx  = cfg == null || typeof cfg === 'number' ? cfg : barIdx;
    cfg     = htf4hBars;
    htf4hBars = [];
  }

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
  if (isChoppingAroundVwap(bars, vwapArr, 8, 4)) return null;  // restored — relaxed filter allowed too many chop signals

  const sess = getSessionInfo(last.timestamp);
  // Only trade high-quality sessions (London + NY Open). Pre-market and midday excluded.
  if (sess.quality < 0.65) return null;

  // ── HTF bias ──────────────────────────────────────────────────────────────────
  const htfBias   = calcHtfBias(htfBars, 9, 21);
  const htf2Bias  = htf2Bars  && htf2Bars.length  >= 21 ? calcHtfBias(htf2Bars,  9, 21) : 0;
  const htf4hBias = htf4hBars && htf4hBars.length >= 5  ? calcHtfBias(htf4hBars, 9, 21) : 0;

  // ── Determine direction candidates ───────────────────────────────────────────
  // All three HTF layers must be non-conflicting (neutral = 0 is allowed).
  // 4h is now a hard gate — strategy-engine.js passes bars4h so htf4hBias is live.
  // Trading against the 4h trend was the leading cause of losses in forensic review.
  const directions = [];
  if (ema9 > ema21 && htfBias >= 0 && htf2Bias >= 0 && htf4hBias >= 0) directions.push('LONG');
  if (ema9 < ema21 && htfBias <= 0 && htf2Bias <= 0 && htf4hBias <= 0) directions.push('SHORT');

  for (const dir of directions) {
    const isBull = dir === 'LONG';

    // ── EMA stack score ─────────────────────────────────────────────────────
    // Require full stack: EMA9 > EMA21 > EMA50 for LONG (vice versa for SHORT).
    // Partial stack (1) was allowing too many weak-trend entries.
    const esScore = emaStackScore(closes, 9, 21, 50, dir);
    if (esScore < 2) continue;

    // ── Pullback detection ──────────────────────────────────────────────────
    // Must have touched EMA21 specifically within 6 bars (true mean-reversion entry).
    // VWAP/EMA9 OR conditions were too loose — many low-quality touches passed.
    // Tighter 0.40×ATR tolerance requires a genuine tag of the mean.
    const tolerance  = 0.40 * atr;
    const pulledTo21 = hadPullbackToLevel(bars, ema21, tolerance, dir, 6);
    if (!pulledTo21) continue;

    // ── Pullback held (EMA21 support not broken) ──────────────────────────────
    const recentSlice = bars.slice(-4, -1);
    if (isBull) {
      if (recentSlice.some(b => b.close < ema21 - 0.25 * atr)) continue;
    } else {
      if (recentSlice.some(b => b.close > ema21 + 0.25 * atr)) continue;
    }

    // ── Confirmation candle ─────────────────────────────────────────────────
    // Raised body ratio from 0.35 → 0.48 — require decisive momentum candle,
    // not a doji or near-doji that passes a weak body check.
    const confirmed = isBull ? isBullishCandle(last, 0.48) : isBearishCandle(last, 0.48);
    if (!confirmed) continue;

    // ── RSI zone filter ─────────────────────────────────────────────────────
    // Require RSI in fresh-momentum zone, not just avoiding extremes.
    // LONG: RSI too weak (<38) = no momentum; too high (≥68) = overbought chase.
    // SHORT: RSI too strong (>62) = no momentum; too low (≤32) = oversold chase.
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && (rsi < 38 || rsi >= 68)) continue;
      if (!isBull && (rsi > 62 || rsi <= 32)) continue;
    }

    // ── MACD momentum alignment (soft filter) ───────────────────────────────
    // Block when: histogram strongly against (falling deeper on wrong side)
    // OR when signal line has been consistently negative for 3+ bars on a LONG
    // (persistent momentum divergence, not just a brief dip).
    const { histogram, sigLine } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    const sigNow   = sigLine[n];
    const sig2     = sigLine[n - 1];
    const sig3     = sigLine[n - 2];
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull
        ? (hist < 0 && hist < histPrev)   // falling deeper negative
        : (hist > 0 && hist > histPrev);  // rising deeper positive
      if (stronglyAgainst) continue;
    }
    // Persistent signal-line divergence: MACD signal trending hard against direction
    if (sigNow != null && sig2 != null && sig3 != null) {
      const sigTrendingAgainst = isBull
        ? (sigNow < 0 && sig2 < 0 && sig3 < 0 && sigNow < sig3)  // signal line falling for 3 bars
        : (sigNow > 0 && sig2 > 0 && sig3 > 0 && sigNow > sig3);
      if (sigTrendingAgainst) continue;
    }

    // ── Opening drive detection ──────────────────────────────────────────────
    // If within 30 minutes of session open AND price is moving strongly away from
    // VWAP (> 0.8 × ATR), this is an opening drive — boost trigger reason context.
    // Session open times (ET): NY_OPEN=930, LONDON=2300 (prev day), NY_PRE=800.
    let openingDriveNote = null;
    {
      const vwapDist = Math.abs(last.close - vwap);
      const d = new Date(last.timestamp);
      const nowHhmm = (d.getUTCHours() - 4) * 100 + d.getUTCMinutes(); // rough ET
      const sessName = (sess?.name ?? '').toUpperCase();
      // NY_OPEN window: 9:30–10:00 ET (930–1000 hhmm)
      // LONDON window: determined by whether sess.name is LONDON and within first 30 min
      const inOpeningWindow =
        (sessName === 'NY_OPEN'   && nowHhmm >= 930  && nowHhmm < 1000) ||
        (sessName === 'NY_PRE'    && nowHhmm >= 800  && nowHhmm < 830)  ||
        (sessName === 'LONDON'    && (nowHhmm >= 2300 || nowHhmm < 2330));
      if (inOpeningWindow && vwapDist > 0.8 * atr) {
        openingDriveNote = `opening_drive(+${Math.round(vwapDist / atr * 10) / 10}ATR)`;
      }
    }

    // ── Price proximity check — entry must be close to EMA21 ───────────────────
    // Tightened from 1.5x to 1.0x ATR: entry within 1 ATR of the mean.
    // Combined with the EMA21 pullback requirement above, this ensures entries
    // are genuine mean-reversion trades, not extended chases.
    const ema21Dist = Math.abs(last.close - ema21);
    if (ema21Dist > 1.0 * atr) continue;

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

    // Risk must be at least half of ATR_MIN_PTS and not overwide (cap at 2x ATR to protect expectancy)
    if (rawRisk < ATR_MIN_PTS * 0.5 || rawRisk > 2 * atr) continue;

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
    // Both HTFs conflicting against direction is a hard block (already excluded
    // above by htfBias >= 0 / htf2Bias >= 0 direction filter, kept for safety).
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
      trigger_reason: [
        `EMA9/21 ${dir} (stack=${esScore}), fresh pullback ≤6 bars, ${dir === 'LONG' ? 'bullish' : 'bearish'} candle, HTF aligned`,
        `4H:${htf4hBias === 1 ? 'BULL' : htf4hBias === -1 ? 'BEAR' : 'neutral'} 1H:${htf2Bias === 1 ? 'BULL' : htf2Bias === -1 ? 'BEAR' : 'neutral'} 15m:${htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'neutral'}`,
        openingDriveNote,
      ].filter(Boolean).join(' | '),
      indicators: {
        atr:       +atr.toFixed(2),
        vwap:      +vwap.toFixed(2),
        ema9:      +ema9.toFixed(2),
        ema21:     +ema21.toFixed(2),
        ema50:     +ema50.toFixed(2),
        rsi:       rsi != null ? +rsi.toFixed(1) : null,
        htfBias, htf2Bias, htf4hBias,
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
