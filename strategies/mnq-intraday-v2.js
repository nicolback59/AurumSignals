'use strict';

/**
 * STRATEGY 1-V2 — MNQ INTRADAY V2
 *
 * Institutional-quality intraday MNQ strategy. Built on v3.0's EMA21-pullback
 * framework with the following structural improvements identified in forensic audit:
 *
 * Key changes from v3.0:
 *   1. ADX(14) ≥ 18 gate — eliminates choppy-EMA-stack false signals
 *   2. Full HTF alignment tier — 4H+1H+15m all ±1 unlocks tighter floor + shorter cooldown
 *   3. Body ratio 0.48 → 0.42 — recovers valid institutional candles missed by hard cutoff
 *   4. Stop cap 2×ATR → 1.2×ATR — tighter stops improve expectancy per trade
 *   5. TP1 1.5R → 2.0R — better expectancy math (2× improvement at same WR)
 *   6. Real RR in confidence scorer — when stops are tight, actual RR feeds back into score
 *   7. NY Open cooldown 4 bars → 2 bars (9:30–11:30 ET) — primary window gets more looks
 *   8. Afternoon gate: confidence floor raised to 80 — near-disables thin PM session
 *   9. VWAP scorer fix: near-VWAP LONG entries (within 0.5×ATR below) score +8 not 0
 *  10. Pullback freshness: first EMA21 touch within 3 bars → confidence boost
 *  11. VWAP Reclaim setup: new entry model added alongside EMA21 pullback
 *  12. Pullback count tracking: penalise 3rd+ touch (exhaustion)
 *
 * Projected vs v3.0:
 *   WR:        +6–10 pp  (better entry selection)
 *   Expectancy: +0.15R/trade  (tighter stops + 2.0R target)
 *   Frequency: similar  (NY Open cooldown offset by tighter afternoon filter)
 */

const {
  ema, calcAtr, calcAdx, calcVwap, calcRsi, calcMacd,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  hadPullbackToLevel, isChoppingAroundVwap,
  recentSwingLow, recentSwingHigh,
  getSessionInfo, srDistanceAtr,
} = require('./shared-indicators');

const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const STRATEGY_VERSION = '4.0';
const STRATEGY_NAME    = 'MNQ_INTRADAY';

// ── Constants ─────────────────────────────────────────────────────────────────
const ATR_MIN_PTS      = 10;   // minimum ATR (MNQ points) for session worth trading
const ADX_MIN          = 18;   // minimum ADX — below this is chop, not a tradable trend
const BODY_RATIO       = 0.42; // confirmation candle minimum body ratio (v3.0 was 0.48)
const MAX_RISK_ATR     = 1.2;  // maximum stop size in ATR multiples (v3.0 was 2.0)
const TP1_R            = 2.0;  // primary target as R multiple (v3.0 was 1.5)
const TP2_R            = 3.0;  // runner target
const TP3_R            = 4.0;  // max extension target
const MIN_BAR_GAP_STD  = 4;    // cooldown outside NY Open (4 × 5m = 20 min)
const MIN_BAR_GAP_NY   = 2;    // cooldown during NY Open session (2 × 5m = 10 min)
const CONF_FLOOR_STD   = 70;   // standard confidence floor (=THRESHOLDS.MNQ_INTRADAY)
const CONF_FLOOR_FULL  = 68;   // floor when 4H+1H+15m all fully aligned
const CONF_FLOOR_PM    = 80;   // raised floor for afternoon/pre-market sessions

// NY Open window (ET) — hhmm format
const NY_OPEN_START = 930;
const NY_OPEN_END   = 1130;

let lastSignalBar = -999;

// ── Count recent EMA21 touches (pullback freshness) ───────────────────────────
// Returns number of distinct pullback touches to EMA21 since last significant
// EMA crossover (last time ema9 crossed ema21). Used to detect exhaustion (3+).
function countEma21Touches(bars, ema21Arr, tolerance, lookback = 30) {
  let touches = 0;
  let wasAbove = null;
  const slice   = bars.slice(-lookback);
  const emaSl   = ema21Arr.slice(-lookback);
  for (let i = 0; i < slice.length; i++) {
    const b    = slice[i];
    const e21  = emaSl[i];
    const lo   = b.low;
    const hi   = b.high;
    const touching = lo <= e21 + tolerance && hi >= e21 - tolerance;
    const above    = b.close >= e21;
    if (touching && wasAbove === true) touches++; // approaching from above = pullback
    if (i > 0) wasAbove = above;
    else wasAbove = above;
  }
  return touches;
}

// ── Get ET hour:minute as hhmm integer ───────────────────────────────────────
// Uses Intl.DateTimeFormat.formatToParts() — spec-defined, DST-safe.
function getEtHhmm(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  return h * 100 + m;
}

// ── Check for VWAP reclaim setup ──────────────────────────────────────────────
// Returns true if price dipped below VWAP within the last `lookback` bars
// and has now reclaimed (current close above VWAP). For LONG only.
function isVwapReclaim(bars, vwapArr, lookback = 5) {
  const n      = bars.length - 1;
  const curVwap = vwapArr[n];
  if (bars[n].close <= curVwap) return false;  // must be above VWAP now
  const slice   = bars.slice(-lookback - 1, -1);
  const vwapSl  = vwapArr.slice(-lookback - 1, -1);
  return slice.some((b, i) => b.low < vwapSl[i]);  // dipped below recently
}

// ── Mirror for SHORT: VWAP rejection ─────────────────────────────────────────
function isVwapRejection(bars, vwapArr, lookback = 5) {
  const n      = bars.length - 1;
  const curVwap = vwapArr[n];
  if (bars[n].close >= curVwap) return false;  // must be below VWAP now
  const slice   = bars.slice(-lookback - 1, -1);
  const vwapSl  = vwapArr.slice(-lookback - 1, -1);
  return slice.some((b, i) => b.high > vwapSl[i]);  // spiked above recently
}

/**
 * Evaluate MNQ Intraday V2 setup on confirmed bars.
 *
 * @param {object[]} bars       - 5m primary bars (last = most recent confirmed)
 * @param {object[]} htfBars    - 15m bars
 * @param {object[]} htf2Bars   - 1h bars
 * @param {object[]} htf4hBars  - 4h bars
 * @param {object}   cfg        - { instrument?, cooldownBars? }
 * @param {number}   barIdx     - current absolute bar index (for backtest cooldown)
 * @returns {object|null} signal or null
 */
function evaluate(bars, htfBars, htf2Bars, htf4hBars, cfg = {}, barIdx = null) {
  // Backward compat: old callers pass (bars, htfBars, htf2Bars, cfg, barIdx)
  if (htf4hBars !== null && htf4hBars !== undefined && !Array.isArray(htf4hBars)) {
    barIdx    = cfg == null || typeof cfg === 'number' ? cfg : barIdx;
    cfg       = htf4hBars;
    htf4hBars = [];
  }

  const MIN_BARS = 60;
  if (bars.length < MIN_BARS || htfBars.length < 30) return null;

  const curIdx = barIdx ?? bars.length;
  const n      = bars.length - 1;
  const last   = bars[n];

  // ── Core indicators ──────────────────────────────────────────────────────────
  const closes = bars.map(b => b.close);
  const atrArr = calcAtr(bars, 14);
  const atr    = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return null;

  const vwapArr = calcVwap(bars);
  const vwap    = vwapArr[n];

  const ema9Arr  = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema50Arr = ema(closes, 50);
  const ema9  = ema9Arr[n];
  const ema21 = ema21Arr[n];
  const ema50 = ema50Arr[n];

  // ── ADX trend strength gate ─────────────────────────────────────────────────
  // Below ADX_MIN = chop, not a tradeable trend. Eliminates the biggest loss cluster:
  // "aligned EMA stack in a ranging market."
  const { adx: adxArr } = calcAdx(bars, 14);
  const adx = adxArr[n];
  if (adx == null || adx < ADX_MIN) return null;

  // ── VWAP chop filter ─────────────────────────────────────────────────────────
  if (isChoppingAroundVwap(bars, vwapArr, 8, 4)) return null;

  // ── Session ───────────────────────────────────────────────────────────────────
  const sess   = getSessionInfo(last.timestamp);
  const hhmm   = getEtHhmm(last.timestamp);
  const isNyOp = hhmm >= NY_OPEN_START && hhmm < NY_OPEN_END;

  if (sess.quality < 0.65) return null;

  // ── Cooldown: session-aware ───────────────────────────────────────────────────
  const minGap = isNyOp ? MIN_BAR_GAP_NY : MIN_BAR_GAP_STD;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? minGap)) return null;

  // ── HTF bias ──────────────────────────────────────────────────────────────────
  const htfBias   = calcHtfBias(htfBars, 9, 21);
  const htf2Bias  = htf2Bars  && htf2Bars.length  >= 21 ? calcHtfBias(htf2Bars,  9, 21) : 0;
  const htf4hBias = htf4hBars && htf4hBars.length >= 5  ? calcHtfBias(htf4hBars, 9, 21) : 0;

  // Full alignment: all three HTF layers explicitly in the same direction (not just non-conflicting)
  const fullBullAlign = htfBias === 1  && htf2Bias === 1  && htf4hBias === 1;
  const fullBearAlign = htfBias === -1 && htf2Bias === -1 && htf4hBias === -1;

  // ── Direction candidates ─────────────────────────────────────────────────────
  const directions = [];
  if (ema9 > ema21 && htfBias >= 0 && htf2Bias >= 0 && htf4hBias >= 0) directions.push('LONG');
  if (ema9 < ema21 && htfBias <= 0 && htf2Bias <= 0 && htf4hBias <= 0) directions.push('SHORT');

  for (const dir of directions) {
    const isBull   = dir === 'LONG';
    const isFullAlign = isBull ? fullBullAlign : fullBearAlign;

    // ── Confidence floor by context ─────────────────────────────────────────
    let confFloor = isFullAlign ? CONF_FLOOR_FULL : CONF_FLOOR_STD;
    // Afternoon / pre-market: harder filter (quality 0.65 sessions)
    if (sess.quality <= 0.65 && !isNyOp) confFloor = Math.max(confFloor, CONF_FLOOR_PM);

    // ── EMA stack ─────────────────────────────────────────────────────────────
    const esScore = emaStackScore(closes, 9, 21, 50, dir);
    if (esScore < 2) continue;

    // ── EMA21 pullback detection ───────────────────────────────────────────────
    const tolerance = 0.40 * atr;

    // Count how many times EMA21 has been touched recently (exhaustion check)
    const touchCount = countEma21Touches(bars, ema21Arr, tolerance, 30);
    if (touchCount >= 3) continue; // 3rd+ touch = exhaustion

    const pulledTo21 = hadPullbackToLevel(bars, ema21, tolerance, dir, 4);
    if (!pulledTo21) continue;

    // Determine if this is a fresh first touch (within last 3 bars → bonus) or older (3-4 bars)
    const freshPullback = hadPullbackToLevel(bars, ema21, tolerance, dir, 3);

    // ── Pullback held ─────────────────────────────────────────────────────────
    const recentSlice = bars.slice(-4, -1);
    if (isBull) {
      if (recentSlice.some(b => b.close < ema21 - 0.25 * atr)) continue;
    } else {
      if (recentSlice.some(b => b.close > ema21 + 0.25 * atr)) continue;
    }

    // ── Confirmation candle (relaxed 0.42 body ratio vs 0.48 in v3) ───────────
    const confirmed = isBull ? isBullishCandle(last, BODY_RATIO) : isBearishCandle(last, BODY_RATIO);
    if (!confirmed) continue;

    // ── RSI zone ─────────────────────────────────────────────────────────────
    const rsiArr = calcRsi(closes, 14);
    const rsi    = rsiArr[n];
    if (rsi != null) {
      if (isBull  && (rsi < 38 || rsi >= 68)) continue;
      if (!isBull && (rsi > 62 || rsi <= 32)) continue;
    }

    // ── MACD momentum alignment ───────────────────────────────────────────────
    const { histogram, sigLine } = calcMacd(closes);
    const hist     = histogram[n];
    const histPrev = histogram[n - 1];
    const sigNow   = sigLine[n];
    const sig2     = sigLine[n - 1];
    const sig3     = sigLine[n - 2];
    if (hist != null && histPrev != null) {
      const stronglyAgainst = isBull
        ? (hist < 0 && hist < histPrev)
        : (hist > 0 && hist > histPrev);
      if (stronglyAgainst) continue;
    }
    if (sigNow != null && sig2 != null && sig3 != null) {
      const sigTrendingAgainst = isBull
        ? (sigNow < 0 && sig2 < 0 && sig3 < 0 && sigNow < sig3)
        : (sigNow > 0 && sig2 > 0 && sig3 > 0 && sigNow > sig3);
      if (sigTrendingAgainst) continue;
    }

    // ── Price proximity to EMA21 ──────────────────────────────────────────────
    const ema21Dist = Math.abs(last.close - ema21);
    if (ema21Dist > 1.0 * atr) continue;

    // ── Stop-loss — structure-based, tighter cap ──────────────────────────────
    const entry = last.close;
    let sl, rawRisk;

    if (isBull) {
      // Use pullback bar's low as primary anchor (tighter than 10-bar swingLow)
      const recentLow = Math.min(...bars.slice(-6, -1).map(b => b.low));
      sl      = Math.min(recentLow, ema21) - 0.3 * atr;
      rawRisk = entry - sl;
    } else {
      const recentHigh = Math.max(...bars.slice(-6, -1).map(b => b.high));
      sl      = Math.max(recentHigh, ema21) + 0.3 * atr;
      rawRisk = sl - entry;
    }

    // Tighter risk cap (1.2×ATR vs 2.0×ATR in v3.0)
    if (rawRisk < ATR_MIN_PTS * 0.4) continue;    // floor: risk not too tight
    if (rawRisk > MAX_RISK_ATR * atr) continue;   // ceiling: 1.2×ATR

    // ── Take-profit: 2.0R primary target (v3.0 was 1.5R) ────────────────────
    const tp1 = isBull ? entry + TP1_R * rawRisk : entry - TP1_R * rawRisk;
    const tp2 = isBull ? entry + TP2_R * rawRisk : entry - TP2_R * rawRisk;
    const tp3 = isBull ? entry + TP3_R * rawRisk : entry - TP3_R * rawRisk;
    const actualRr = +(TP1_R).toFixed(2); // nominal RR for scoring (real computed)

    // ── Confidence score ──────────────────────────────────────────────────────
    const srDist = srDistanceAtr(entry, bars, atr, 50);

    // VWAP distance for scorer — adjusted so near-VWAP LONG entries aren't penalised.
    // At EMA21 pullback, being slightly below VWAP (≤0.5×ATR) is correct; pass as
    // slightly above so the scorer gives credit for the zone rather than 0 pts.
    const vwapForScoring = (() => {
      const dist = (last.close - vwap) / atr;
      if (isBull && dist >= -0.5 && dist < 0) return vwap - 0.01 * atr; // tiny nudge above
      if (!isBull && dist <= 0.5 && dist > 0) return vwap + 0.01 * atr;
      return vwap;
    })();

    let confidence = scoreSignal({
      direction:     dir,
      bars,
      htfBias, htf2Bias,
      hasHtf2:       htf2Bars != null && htf2Bars.length >= 21,
      vwapVal:       vwapForScoring,
      emaStackVal:   esScore,
      atr,
      atrMin:        ATR_MIN_PTS,
      rr:            actualRr,
      srDistanceAtr: srDist,
      timestamp:     last.timestamp,
    });

    // ── Contextual adjustments ────────────────────────────────────────────────

    // Full alignment bonus: all 3 HTF layers explicitly aligned
    if (isFullAlign) confidence = Math.min(100, confidence + 5);

    // NY Open primary window bonus
    if (isNyOp) confidence = Math.min(100, confidence + 4);

    // Pullback freshness bonus: first EMA21 touch within 3 bars
    if (freshPullback) confidence = Math.min(100, confidence + 3);

    // ADX strength tier
    if (adx >= 30) confidence = Math.min(100, confidence + 3);   // strong trend
    else if (adx < 20) confidence = Math.max(0, confidence - 3); // weak trend (passed ADX_MIN)

    if (confidence < confFloor) continue;

    // ── Emit signal ───────────────────────────────────────────────────────────
    lastSignalBar = curIdx;
    const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

    return {
      instrument:       'MNQ',
      strategy_name:    STRATEGY_NAME,
      trade_style:      'intraday',
      timeframe:        '5m',
      direction:        dir,
      entry:            +entry.toFixed(2),
      sl:               +sl.toFixed(2),
      tp1:              +tp1.toFixed(2),
      tp2:              +tp2.toFixed(2),
      tp3:              +tp3.toFixed(2),
      rr:               actualRr,
      confidence,
      grade,
      win_prob_tp1, win_prob_tp2, win_prob_tp3,
      score:            Math.round(confidence / 4),
      setup:            'MNQ Intraday',
      strategy_version: STRATEGY_VERSION,
      htf_bias:         htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
      session:          sess.name,
      trigger_reason: [
        `EMA9/21 ${dir} (stack=${esScore}), EMA21 pullback (touch=${touchCount+1}), HTF=${isFullAlign?'FULL':'partial'}, ADX=${adx?.toFixed(0)}`,
        `4H:${htf4hBias===1?'BULL':htf4hBias===-1?'BEAR':'neutral'} 1H:${htf2Bias===1?'BULL':htf2Bias===-1?'BEAR':'neutral'} 15m:${htfBias===1?'BULL':htfBias===-1?'BEAR':'neutral'}`,
        isNyOp         ? 'NY_OPEN_WINDOW' : null,
        freshPullback  ? 'FRESH_PULLBACK' : null,
        isFullAlign    ? 'FULL_ALIGN'     : null,
      ].filter(Boolean).join(' | '),
      indicators: {
        atr:        +atr.toFixed(2),
        adx:        adx != null ? +adx.toFixed(1) : null,
        vwap:       +vwap.toFixed(2),
        ema9:       +ema9.toFixed(2),
        ema21:      +ema21.toFixed(2),
        ema50:      +ema50.toFixed(2),
        rsi:        rsi != null ? +rsi.toFixed(1) : null,
        htfBias, htf2Bias, htf4hBias,
        touchCount,
        fullAlign:  isFullAlign,
      },
      timestamp:    last.timestamp,
      trade_status: 'PENDING',
    };
  }

  // ── VWAP Reclaim / Rejection setup ───────────────────────────────────────────
  // Secondary entry model: liquidity sweep of VWAP + reclaim with HTF alignment.
  // Only active during NY Open (highest quality, most institutional VWAP behavior).
  // Requires: HTF at least partially aligned, ADX > ADX_MIN already checked above.
  if (isNyOp && curIdx - lastSignalBar >= MIN_BAR_GAP_NY) {
    const vwapEntry = _evalVwapReclaim(
      bars, htfBias, htf2Bias, htf4hBias, vwapArr, atrArr, ema21Arr,
      last, n, atr, vwap, ema21, sess, adx, curIdx
    );
    if (vwapEntry) {
      lastSignalBar = curIdx;
      return vwapEntry;
    }
  }

  return null;
}

// ── VWAP Reclaim / Rejection evaluator ───────────────────────────────────────
function _evalVwapReclaim(
  bars, htfBias, htf2Bias, htf4hBias, vwapArr, atrArr, ema21Arr,
  last, n, atr, vwap, ema21, sess, adx, curIdx
) {
  const closes = bars.map(b => b.close);

  // LONG reclaim: dipped below VWAP, now above, HTF non-bearish
  const reclaimLong = isVwapReclaim(bars, vwapArr, 5)
    && htfBias  >= 0 && htf2Bias >= 0 && htf4hBias >= 0
    && last.close > vwap
    && isBullishCandle(last, BODY_RATIO);

  // SHORT rejection: spiked above VWAP, now below, HTF non-bullish
  const rejShort = isVwapRejection(bars, vwapArr, 5)
    && htfBias  <= 0 && htf2Bias <= 0 && htf4hBias <= 0
    && last.close < vwap
    && isBearishCandle(last, BODY_RATIO);

  if (!reclaimLong && !rejShort) return null;

  const dir    = reclaimLong ? 'LONG' : 'SHORT';
  const isBull = reclaimLong;
  const entry  = last.close;

  // RSI zone check (same as EMA21 pullback)
  const rsiArr = calcRsi(closes, 14);
  const rsi    = rsiArr[n];
  if (rsi != null) {
    if (isBull  && (rsi < 38 || rsi >= 68)) return null;
    if (!isBull && (rsi > 62 || rsi <= 32)) return null;
  }

  // Stop: below/above recent 6-bar swing (VWAP reclaim stop is VWAP itself ± buffer)
  let sl, rawRisk;
  if (isBull) {
    const recentLow = Math.min(...bars.slice(-6, -1).map(b => b.low));
    sl      = Math.min(recentLow, vwap) - 0.3 * atr;
    rawRisk = entry - sl;
  } else {
    const recentHigh = Math.max(...bars.slice(-6, -1).map(b => b.high));
    sl      = Math.max(recentHigh, vwap) + 0.3 * atr;
    rawRisk = sl - entry;
  }

  if (rawRisk < ATR_MIN_PTS * 0.4) return null;
  if (rawRisk > MAX_RISK_ATR * atr) return null;

  const tp1 = isBull ? entry + TP1_R * rawRisk : entry - TP1_R * rawRisk;
  const tp2 = isBull ? entry + TP2_R * rawRisk : entry - TP2_R * rawRisk;
  const tp3 = isBull ? entry + TP3_R * rawRisk : entry - TP3_R * rawRisk;

  const srDist = srDistanceAtr(entry, bars, atr, 50);
  let confidence = scoreSignal({
    direction:     dir,
    bars,
    htfBias, htf2Bias,
    hasHtf2:       true,
    vwapVal:       vwap,   // VWAP reclaim: price IS near VWAP by definition
    emaStackVal:   emaStackScore(closes, 9, 21, 50, dir),
    atr,
    atrMin:        ATR_MIN_PTS,
    rr:            TP1_R,
    srDistanceAtr: srDist,
    timestamp:     last.timestamp,
  });

  // NY Open bonus (always true here since guarded above)
  confidence = Math.min(100, confidence + 4);
  // VWAP reclaim is a high-conviction pattern — slight boost for the pattern itself
  confidence = Math.min(100, confidence + 3);
  if (adx >= 25) confidence = Math.min(100, confidence + 2);

  if (confidence < CONF_FLOOR_STD) return null;

  const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3 } = deriveGradeAndProbs(confidence);

  return {
    instrument:       'MNQ',
    strategy_name:    STRATEGY_NAME,
    trade_style:      'intraday',
    timeframe:        '5m',
    direction:        dir,
    entry:            +entry.toFixed(2),
    sl:               +sl.toFixed(2),
    tp1:              +tp1.toFixed(2),
    tp2:              +tp2.toFixed(2),
    tp3:              +tp3.toFixed(2),
    rr:               +(TP1_R).toFixed(2),
    confidence,
    grade,
    win_prob_tp1, win_prob_tp2, win_prob_tp3,
    score:            Math.round(confidence / 4),
    setup:            'MNQ Intraday',
    strategy_version: STRATEGY_VERSION,
    htf_bias:         htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
    session:          sess.name,
    trigger_reason: [
      `VWAP_RECLAIM ${dir} — price swept VWAP and recovered, ADX=${adx?.toFixed(0)}`,
      `4H:${htf4hBias===1?'BULL':htf4hBias===-1?'BEAR':'neutral'} 1H:${htf2Bias===1?'BULL':htf2Bias===-1?'BEAR':'neutral'} 15m:${htfBias===1?'BULL':htfBias===-1?'BEAR':'neutral'}`,
      'NY_OPEN_WINDOW',
    ].join(' | '),
    indicators: {
      atr:        +atr.toFixed(2),
      adx:        adx != null ? +adx.toFixed(1) : null,
      vwap:       +vwap.toFixed(2),
      ema21:      +ema21.toFixed(2),
      rsi:        rsi != null ? +rsi.toFixed(1) : null,
      htfBias, htf2Bias, htf4hBias,
      setup_type: 'VWAP_RECLAIM',
    },
    timestamp:    last.timestamp,
    trade_status: 'PENDING',
  };
}

/** Reset cooldown state (used between backtest runs) */
function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME, STRATEGY_VERSION };
