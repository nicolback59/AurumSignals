'use strict';

/**
 * STRATEGY 4 — MGC GOLD SCALPING (v2 — professional rebuild)
 *
 * Objective: High-consistency MGC scalp signals across all active sessions.
 *
 * Architecture:
 *   Execution TF : 3m (falls back to 5m if unavailable)
 *   Context TFs  : 15m, 30m, 45m, 1h
 *   Session scope: London, NY_PRE, NY open/continuation, Midday, AfterNoon, Asian
 *
 * Signal archetypes (regime-specific):
 *   continuation_pullback  — trend intact, price pulls back to EMA/VWAP
 *   vwap_reclaim           — price reclaims VWAP, continuation expected
 *   vwap_rejection         — price fails VWAP, breakdown expected
 *   sweep_reversal         — liquidity sweep below/above swing → reversal
 *   compression_breakout   — tight range resolves with momentum
 *   chop_mean_revert       — chop-specific: extreme RSI fade back to VWAP
 *
 * Regime gate:
 *   TREND_BULL / TREND_BEAR → continuation + VWAP archetypes
 *   COMPRESSION / NORMAL    → breakout archetype
 *   RANGE_CHOP              → chop_mean_revert only
 *   EXPANSION               → sweep_reversal + momentum continuation
 *
 * Quality layers:
 *   - Volatility regime (LOW / NORMAL / HIGH)
 *   - Chop score (0–1): penalises score, blocks pure chop
 *   - Exhaustion detection: blocks overextended entries
 *   - Prior day H/L proximity: avoids entering at major S/R
 *   - Multi-TF confluence (15m / 30m / 45m / 1h): requires ≥2 agreeing
 */

const {
  ema, calcAtr, calcVwap, calcRsi, calcMacd, calcAdx,
  calcHtfBias, emaStackScore,
  isBullishCandle, isBearishCandle,
  hadPullbackToLevel,
  recentSwingLow, recentSwingHigh,
  srDistanceAtr,
} = require('./shared-indicators');

const { getSessionInfoCompat } = require('../clock/market-clock');
const { scoreSignal, deriveGradeAndProbs, THRESHOLDS } = require('./confidence-scorer');

const STRATEGY_VERSION = '5.1';

const ATR_MIN_PTS = 2.0;  // raised from 1.5 — require real volatility
const MAX_RISK_PTS = 10;  // hard cap on SL distance — skip any setup requiring >10pt risk
const MIN_BAR_GAP = 1;          // 1-bar spam guard — adaptive-cooldown.js handles strategy timing
const TP = [10, 14, 20, 25];    // fixed MGC take-profit levels in points

let lastSignalBar = -999;

// ── Regime & context analysis ─────────────────────────────────────────────────

function classifyRegime(bars5m, bars15m) {
  if (bars5m.length < 20 || bars15m.length < 10) return 'UNKNOWN';

  const n = bars5m.length - 1;
  const closes5m  = bars5m.map(b => b.close);
  const closes15m = bars15m.map(b => b.close);

  // Directional efficiency over last 20 bars (net / gross movement)
  const slice = bars5m.slice(-20);
  let grossPath = 0;
  for (let i = 1; i < slice.length; i++) grossPath += Math.abs(slice[i].close - slice[i-1].close);
  const netMove    = Math.abs(slice[slice.length - 1].close - slice[0].close);
  const efficiency = grossPath > 0 ? netMove / grossPath : 0;

  // ATR compression vs recent average
  const atrArr = calcAtr(bars5m, 14);
  const curAtr = atrArr[n];
  const histAtr = atrArr.slice(-20, -1).filter(Boolean);
  const avgAtr  = histAtr.length ? histAtr.reduce((s, v) => s + v, 0) / histAtr.length : curAtr;
  const atrRatio = avgAtr > 0 ? curAtr / avgAtr : 1;

  // EMA slope on 15m
  const ema21_15 = ema(closes15m, 21);
  const m15n     = ema21_15.length - 1;
  const emaSlope = (ema21_15[m15n] != null && ema21_15[m15n - 4] != null)
    ? ema21_15[m15n] - ema21_15[m15n - 4]
    : 0;

  if (atrRatio < 0.60) return 'COMPRESSION';
  if (atrRatio > 2.00) return 'EXPANSION';
  if (efficiency > 0.45 && Math.abs(emaSlope) > curAtr * 0.25) {
    return emaSlope > 0 ? 'TREND_BULL' : 'TREND_BEAR';
  }
  if (efficiency < 0.22) return 'RANGE_CHOP';
  // Forensic finding: the 0.22–0.45 band was all classified NORMAL, allowing
  // continuation and breakout archetypes in indecisive / soft-chop conditions.
  // Split into SOFT_CHOP (weak) and NORMAL (borderline) to gate archetypes properly.
  if (efficiency < 0.35) return 'SOFT_CHOP';
  return 'NORMAL';
}

// ADX directional strength — requires ≥28 bars (2× period) for reliable reading
function getAdxValue(bars) {
  if (bars.length < 28) return null;
  const { adx } = calcAdx(bars, 14);
  return adx[bars.length - 1];
}

function getVolatilityRegime(bars, atr) {
  if (bars.length < 20) return 'NORMAL';
  const ranges = bars.slice(-20).map(b => b.high - b.low);
  const avgRange = ranges.reduce((s, v) => s + v, 0) / ranges.length;
  if (atr < avgRange * 0.60) return 'LOW';
  if (atr > avgRange * 1.60) return 'HIGH';
  return 'NORMAL';
}

function getChopScore(bars, vwapArr) {
  const lookback = Math.min(12, bars.length - 1);
  if (lookback < 4) return 0;

  const slice  = bars.slice(-lookback);
  const vSlice = vwapArr.slice(-lookback);

  // VWAP cross frequency
  let crosses = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevAbove = slice[i-1].close > vSlice[i-1];
    const nowAbove  = slice[i].close   > vSlice[i];
    if (prevAbove !== nowAbove) crosses++;
  }

  // Body overlap ratio
  let overlaps = 0;
  for (let i = 1; i < slice.length; i++) {
    const pLo = Math.min(slice[i-1].open, slice[i-1].close);
    const pHi = Math.max(slice[i-1].open, slice[i-1].close);
    const cLo = Math.min(slice[i].open,   slice[i].close);
    const cHi = Math.max(slice[i].open,   slice[i].close);
    if (cLo < pHi && cHi > pLo) overlaps++;
  }

  const crossScore   = Math.min(1, crosses   / 4);
  const overlapScore = Math.min(1, overlaps  / (slice.length - 1));
  return crossScore * 0.5 + overlapScore * 0.5;
}

function getVwapState(bars, vwapArr, lookback = 5) {
  const n = bars.length - 1;
  if (n < lookback) return 'UNKNOWN';

  // Count VWAP crosses in lookback
  let crosses = 0;
  for (let i = Math.max(1, n - lookback); i <= n; i++) {
    if (vwapArr[i] == null || vwapArr[i-1] == null) continue;
    const prev = bars[i-1].close > vwapArr[i-1];
    const cur  = bars[i].close   > vwapArr[i];
    if (prev !== cur) crosses++;
  }
  if (crosses >= 3) return 'CHOPPING';

  // Was above/below for majority of lookback
  const prevBars = bars.slice(-lookback - 1, -1);
  const prevVwap = vwapArr.slice(-lookback - 1, -1);
  const aboveCnt = prevBars.filter((b, i) => b.close > (prevVwap[i] ?? b.close)).length;
  const wasAbove = aboveCnt > prevBars.length / 2;
  const nowAbove = bars[n].close > vwapArr[n];

  // Two consecutive closes on the new side confirm acceptance — a single cross is noise
  const prevBar      = bars[n - 1];
  const prevBarAbove = vwapArr[n - 1] != null ? prevBar.close > vwapArr[n - 1] : nowAbove;
  if (!wasAbove && nowAbove && prevBarAbove)  return 'RECLAIMING';
  if (wasAbove  && !nowAbove && !prevBarAbove) return 'REJECTING';
  return nowAbove ? 'ABOVE' : 'BELOW';
}

function detectExhaustion(bars, atr, dir) {
  const n = bars.length - 1;
  const lookback = Math.min(8, n);
  const slice = bars.slice(-lookback);

  // Overextension: price moved > 5.5× ATR in direction without retracement
  const ext = dir === 'LONG'
    ? bars[n].close - Math.min(...slice.map(b => b.low))
    : Math.max(...slice.map(b => b.high)) - bars[n].close;
  if (ext > 5.5 * atr) return true;

  // Climactic wide candle (blowoff move)
  const last = bars[n];
  if (Math.abs(last.close - last.open) > 3.5 * atr) return true;

  return false;
}

function detectLiquiditySweep(bars, atr, dir) {
  const n = bars.length - 1;
  if (n < 4) return false;

  if (dir === 'LONG') {
    // Swept meaningfully below prior swing low (≥0.20×ATR), then recovered cleanly above it.
    // Raised from 0.05 — eliminates trivial 1-tick dips that dominate false sweep_reversal signals.
    const priorLow  = recentSwingLow(bars.slice(0, -2), 10);
    const sweepBar  = bars[n - 1];
    const curClose  = bars[n].close;
    return sweepBar.low < priorLow - 0.20 * atr && curClose > priorLow + 0.08 * atr;
  } else {
    const priorHigh = recentSwingHigh(bars.slice(0, -2), 10);
    const sweepBar  = bars[n - 1];
    const curClose  = bars[n].close;
    return sweepBar.high > priorHigh + 0.20 * atr && curClose < priorHigh - 0.08 * atr;
  }
}

function getPriorDayLevels(bars1h) {
  if (!bars1h || bars1h.length < 6) return null;
  // Use the oldest available 8-bar chunk as a proxy for prior day
  const chunk = bars1h.slice(0, Math.min(8, Math.floor(bars1h.length / 2)));
  if (!chunk.length) return null;
  return {
    high: Math.max(...chunk.map(b => b.high)),
    low:  Math.min(...chunk.map(b => b.low)),
  };
}

// ── Main evaluate ──────────────────────────────────────────────────────────────

/**
 * @param {object[]} bars3m    - 3m execution bars (may be empty → falls back to bars5m)
 * @param {object[]} bars5m    - 5m bars (context + execution fallback)
 * @param {object[]} bars15m   - 15m HTF bias
 * @param {object[]} bars1h    - 1h macro trend
 * @param {object[]} bars30m   - 30m MTF confluence
 * @param {object[]} bars45m   - 45m MTF confluence
 */
function evaluate(bars3m, bars5m, bars15m, bars1h, bars30m, bars45m, cfg = {}, barIdx = null) {
  // Backwards-compat: old callers pass (bars5m, bars15m, bars1h, bars30m, bars45m, cfg, barIdx)
  if (!Array.isArray(bars3m)) {
    [bars3m, bars5m, bars15m, bars1h, bars30m, bars45m, cfg, barIdx] =
      [[], bars3m, bars5m, bars15m, bars1h, bars30m, bars45m ?? {}, bars45m ?? null];
  }

  // Pick execution TF: prefer 3m when sufficient history exists
  const exec = bars3m.length >= 25 ? bars3m : bars5m;
  const MIN_EXEC = exec === bars3m ? 30 : 40;

  if (exec.length < MIN_EXEC || bars15m.length < 15 || bars5m.length < 30) return null;

  const curIdx = barIdx ?? exec.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const n    = exec.length - 1;
  const last = exec[n];

  // ── Session gate — lower threshold to include more sessions ─────────────────
  const sess = getSessionInfoCompat(last.timestamp);
  if (sess.isBlackout || sess.quality < 0.40) return null;
  // NY Open and Pre-market lack stable structure for scalp entries
  if (sess.name === 'NY_OPEN' || sess.name === 'NY_PRE') return null;

  // ── Core indicators ─────────────────────────────────────────────────────────
  const closes  = exec.map(b => b.close);
  const atrArr  = calcAtr(exec, 14);
  const atr     = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return null;

  const vwapArr = calcVwap(exec);
  const vwap    = vwapArr[n];
  const ema9Arr = ema(closes, 9);
  const ema21Arr= ema(closes, 21);
  const ema9    = ema9Arr[n];
  const ema21   = ema21Arr[n];
  if (!ema9 || !ema21 || !vwap) return null;

  const rsiArr  = calcRsi(closes, 14);
  const rsi     = rsiArr[n];
  const { histogram } = calcMacd(closes);
  const hist     = histogram[n];
  const histPrev = histogram[n - 1];

  // ── Context analysis ────────────────────────────────────────────────────────
  const regime    = classifyRegime(bars5m, bars15m);
  const chopScore = getChopScore(exec, vwapArr);
  const vwapState = getVwapState(exec, vwapArr);
  const volRegime = getVolatilityRegime(exec, atr);

  // Reject pure chaos: high volatility + extreme chop only
  if (volRegime === 'HIGH' && chopScore > 0.70) return null;

  // ── HTF biases ──────────────────────────────────────────────────────────────
  const htfBias   = calcHtfBias(bars15m, 9, 21);
  const htf1hBias = bars1h  && bars1h.length  >= 21 ? calcHtfBias(bars1h,  9, 21) : 0;
  const htf30mBias= bars30m && bars30m.length >= 6  ? calcHtfBias(bars30m, 9, 21) : null;
  const htf45mBias= bars45m && bars45m.length >= 5  ? calcHtfBias(bars45m, 9, 21) : null;

  // 15m EMA21 slope — used to distinguish SOFT_CHOP from healthy pullback in a 15m trend
  const ema21_15mArr = ema(bars15m.map(b => b.close), 21);
  const m15nSlope    = ema21_15mArr.length - 1;
  const htfEmaSlope  = (ema21_15mArr[m15nSlope] != null && ema21_15mArr[m15nSlope - 4] != null)
    ? ema21_15mArr[m15nSlope] - ema21_15mArr[m15nSlope - 4]
    : 0;

  const priorDay  = getPriorDayLevels(bars1h);

  // Chop threshold is tunable via std2 param (std2=2.2 → 0.70 default).
  // Higher std2 = stricter filter; lower = more permissive.
  const chopThreshEarly = Math.min(0.88, 0.55 + ((+(cfg.params?.std2 ?? 2.2)) - 1.5) * 0.20);
  const isChop    = chopScore > chopThreshEarly;
  // SOFT_CHOP regime: indecisive price action, restrict to reversal archetypes only.
  const isSoftChop = !isChop && regime === 'SOFT_CHOP';
  const rsiOB     = rsi != null && rsi > 76;
  const rsiOS     = rsi != null && rsi < 24;

  const adxVal    = getAdxValue(exec);

  // Displacement strength: current bar body vs average of prior 10 bars
  const dispStrength = displacementStrength(exec);

  // ── Tuneable param overrides (from optimizer / strategy-params) ───────────
  // These allow the optimizer worker to test parameter variations that
  // actually affect signal generation, not just metadata.
  const p = cfg.params ?? {};
  // maxRiskPts: tighter = fewer but higher-RR setups; PARAM_BOUNDS slPts 10–60
  const maxRiskPts  = Math.max(6, Math.min(14, +(p.slPts ?? MAX_RISK_PTS)));
  // confBoost: added to base confidence threshold; minScore=7 = no change
  const confBoost   = Math.max(0, Math.round((p.minScore ?? 7) - 7));
  // chopThresh: higher = stricter chop filter; std2=2.2 ≈ 0.70 default
  const chopThresh  = Math.min(0.88, 0.55 + ((+(p.std2 ?? 2.2)) - 1.5) * 0.20);
  // adxFloor: ADX minimum for trend-regime continuation entries; stdvLen=16 default
  const adxFloor    = Math.round(+(p.stdvLen ?? 12));
  // swingBars: lookback for swing high/low in SL placement; swingLook=12 ≈ 10 bars
  const swingBars   = Math.max(4, Math.min(25, Math.round(+(p.swingLook ?? 12))));
  // srMinAtr: minimum ATR distance to nearest S/R; swingL=5 = 0.35 ATR default
  const srMinAtr    = Math.max(0.15, 0.45 - (+(p.swingL ?? 5)) * 0.02);

  // ── Evaluation context object ───────────────────────────────────────────────
  const ctx = {
    exec, bars5m, bars15m, bars1h, n, last, closes, atr, vwap, vwapArr,
    ema9, ema21, ema9Arr, ema21Arr, rsi, rsiOB, rsiOS, hist, histPrev,
    regime, chopScore, vwapState, volRegime, htfBias, htf1hBias,
    htf30mBias, htf45mBias, priorDay, isChop, isSoftChop, adxVal, sess,
    dispStrength, htfEmaSlope,
    maxRiskPts, adxFloor, swingBars, srMinAtr,
  };

  // ── Try each archetype ──────────────────────────────────────────────────────
  const candidates = [];

  if (!isChop) {
    // SOFT_CHOP and RANGE_CHOP: only reversal-type setups (clear invalidation point).
    // Continuation and breakout archetypes have poor expectancy in indecisive regimes.
    if (!isSoftChop) {
      const cp = evalContinuationPullback(ctx);  if (cp) candidates.push(cp);
      const cb = evalCompressionBreakout(ctx);   if (cb) candidates.push(cb);
    }
    const vr = evalVwapReclaimReject(ctx);       if (vr) candidates.push(vr);
    const sw = evalSweepReversal(ctx);           if (sw) candidates.push(sw);
  } else {
    // Pure chop: only high-conviction mean-revert setups
    const mr = evalChopMeanRevert(ctx);          if (mr) candidates.push(mr);
  }

  if (candidates.length === 0) return null;

  // Pick highest raw score
  const best = candidates.reduce((a, b) => a.score > b.score ? a : b);

  // ── Multi-TF confluence gate — only block when ALL layers conflict ───────────
  const htfLayers = [
    { bias: htfBias,    present: true },
    { bias: htf1hBias,  present: bars1h  && bars1h.length  >= 21 },
    { bias: htf30mBias, present: htf30mBias !== null },
    { bias: htf45mBias, present: htf45mBias !== null },
  ];
  const expectedBias   = best.dir === 'LONG' ? 1 : -1;
  const presentLayers  = htfLayers.filter(l => l.present);
  const agreedLayers   = presentLayers.filter(l => l.bias === expectedBias);
  const conflictLayers = presentLayers.filter(l => l.bias !== 0 && l.bias !== expectedBias);
  const minAgree = best.minMtfAgree ?? 2; // per-archetype TF agreement threshold
  if (agreedLayers.length < minAgree) return null;
  // Also block when all non-neutral layers conflict
  if (conflictLayers.length >= presentLayers.length) return null;

  const confluenceBonus = (agreedLayers.length - minAgree) * 4;

  // ── Final confidence score ────────────────────────────────────────────────────
  const esScore = emaStackScore(closes, 9, 21, 21, best.dir);
  const baseConf = scoreSignal({
    direction: best.dir, bars: exec, htfBias, htf2Bias: htf1hBias,
    hasHtf2:  bars1h && bars1h.length >= 21,
    vwapVal:  vwap, emaStackVal: esScore,
    atr, atrMin: ATR_MIN_PTS,
    rr:       best.rr,
    srDistanceAtr: best.srDist ?? 1,
    timestamp: last.timestamp,
  });

  // Regime adjustment
  let regimeAdj = 0;
  if (regime === 'TREND_BULL' && best.dir === 'LONG')  regimeAdj = +6;
  if (regime === 'TREND_BEAR' && best.dir === 'SHORT') regimeAdj = +6;
  if (regime === 'RANGE_CHOP') regimeAdj = -8;
  if (volRegime === 'HIGH')    regimeAdj -= 4;
  if (volRegime === 'LOW')     regimeAdj -= 3;

  const chopPenalty = Math.round(chopScore * 10);

  // Exhaustion hard block (applied after archetype selection to avoid false pass)
  if (detectExhaustion(exec, atr, best.dir)) return null;

  const confidence = Math.min(100, Math.max(0,
    baseConf + confluenceBonus + regimeAdj + (best.bonus ?? 0) - chopPenalty,
  ));

  if (confidence < THRESHOLDS.MGC_SCALP + confBoost) return null;

  // Block entry within 0.2 ATR of prior day H/L (immediate S/R only)
  if (priorDay) {
    const e = last.close;
    if (Math.abs(e - priorDay.high) < 0.2 * atr) return null;
    if (Math.abs(e - priorDay.low)  < 0.2 * atr) return null;
  }

  lastSignalBar = curIdx;

  const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4 } = deriveGradeAndProbs(confidence);
  const isBull = best.dir === 'LONG';
  const entry  = last.close;

  return {
    instrument:    'MGC',
    strategy_name: 'MGC_SCALP',
    trade_style:   'scalp',
    timeframe:     exec === bars3m ? '3m' : '5m',
    direction:     best.dir,
    entry:         +entry.toFixed(2),
    sl:            +best.sl.toFixed(2),
    tp1:           +(isBull ? entry + TP[0] : entry - TP[0]).toFixed(2),
    tp2:           +(isBull ? entry + TP[1] : entry - TP[1]).toFixed(2),
    tp3:           +(isBull ? entry + TP[2] : entry - TP[2]).toFixed(2),
    tp4:           +(isBull ? entry + TP[3] : entry - TP[3]).toFixed(2),
    rr:            best.rr,
    confidence,
    grade,
    win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4,
    score:         Math.round(confidence / 4),
    setup:            'MGC Scalp',
    strategy_version: STRATEGY_VERSION,
    htf_bias:         htfBias === 1 ? 'BULL' : htfBias === -1 ? 'BEAR' : 'MIXED',
    session:       sess.name,
    trigger_reason: `${best.archetype} | regime:${regime}${isSoftChop ? '(soft)' : ''} | vwap:${vwapState} | vol:${volRegime} | adx:${adxVal != null ? adxVal.toFixed(1) : 'n/a'} | ${agreedLayers.length}/${presentLayers.length} TFs`,
    indicators: {
      atr:    +atr.toFixed(2),
      vwap:   +vwap.toFixed(2),
      ema9:   +ema9.toFixed(2),
      ema21:  +ema21.toFixed(2),
      rsi:    rsi != null ? +rsi.toFixed(1) : null,
      htfBias, htf1hBias, htf30mBias, htf45mBias,
      regime, vwapState, volRegime,
      chopScore:      +chopScore.toFixed(2),
      archetype:      best.archetype,
      mtfAgreed:      agreedLayers.length,
      confluenceBonus,
    },
    timestamp:    last.timestamp,
    trade_status: 'PENDING',
  };
}

// ── Displacement strength ──────────────────────────────────────────────────────
// Ratio of the current bar's body size to the average body over the prior 10 bars.
// Strong displacement (≥ 1.4×) indicates a decisive momentum move and earns an
// extra +4 bonus in continuation and VWAP archetypes.

function displacementStrength(bars) {
  const n = bars.length - 1;
  const bodies = bars.slice(-11, -1).map(b => Math.abs(b.close - b.open));
  const avgBody = bodies.reduce((s, v) => s + v, 0) / (bodies.length || 1) || 1;
  const curBody = Math.abs(bars[n].close - bars[n].open);
  return curBody / avgBody;
}

// ── Archetype evaluators ───────────────────────────────────────────────────────

function evalContinuationPullback(ctx) {
  const { exec, n, last, atr, vwap, vwapArr, ema9, ema21,
          regime, htfBias, htf1hBias, rsiOB, rsiOS, hist, histPrev, chopScore,
          adxVal, sess, dispStrength, htfEmaSlope } = ctx;

  if (regime === 'RANGE_CHOP') return null;

  // SOFT_CHOP: a trending market pulling back to EMA registers as SOFT_CHOP because the
  // 20-bar efficiency sees both the trend leg and the pullback leg. Allow continuation
  // only when the 15m EMA slope confirms the broader trend is still intact.
  const softChopOverride = regime === 'SOFT_CHOP';
  if (softChopOverride) {
    const htfTrending = Math.abs(htfEmaSlope ?? 0) > 0.25 * atr;
    if (!htfTrending || adxVal == null || adxVal < 18 || (dispStrength ?? 0) < 1.2) return null;
  }

  if (sess.quality < 0.58) return null;

  const trendRegime = regime === 'TREND_BULL' || regime === 'TREND_BEAR';
  if (trendRegime && adxVal != null && adxVal < (ctx.adxFloor ?? 16)) return null;

  const dirs = [];
  if (ema9 > ema21 && htfBias >= 0 && last.close >= vwap * 0.9985) dirs.push('LONG');
  if (ema9 < ema21 && htfBias <= 0 && last.close <= vwap * 1.0015) dirs.push('SHORT');

  for (const dir of dirs) {
    const isBull = dir === 'LONG';
    if (isBull && rsiOB) continue;
    if (!isBull && rsiOS) continue;

    // MIDDAY: gold doldrums — only trade when there is real directional conviction
    if (sess.name === 'MIDDAY' && (adxVal == null || adxVal < 22 || chopScore >= 0.42)) continue;
    // LONDON: carry the prior session's direction — only trade aligned with 1h bias
    if (sess.name === 'LONDON' && htf1hBias === 0) continue;
    if (sess.name === 'LONDON' && isBull  && htf1hBias < 0) continue;
    if (sess.name === 'LONDON' && !isBull && htf1hBias > 0) continue;

    // Forensic finding: 15-bar / 0.80×ATR lookback allowed stale 75-min-old pullbacks
    // as valid entry triggers.  Tightened to 10 bars (50 min on 5m / 30 min on 3m)
    // and 0.65×ATR tolerance for a cleaner, fresher pullback requirement.
    const tol    = 0.65 * atr;
    const pull9  = hadPullbackToLevel(exec, ema9,  tol, dir, 10);
    const pull21 = hadPullbackToLevel(exec, ema21, tol, dir, 10);
    const pullV  = hadPullbackToLevel(exec, vwap,  tol, dir, 10);
    // Proximity entry: current bar AT EMA21 right now is the highest-quality pullback signal
    const atEma21Now = isBull
      ? last.low  <= ema21 + 0.40 * atr && last.close > ema21 - 0.20 * atr
      : last.high >= ema21 - 0.40 * atr && last.close < ema21 + 0.20 * atr;
    if (!pull9 && !pull21 && !pullV && !atEma21Now) continue;

    // Retest holds — only check the most recent bar before entry
    const prevBar = exec[exec.length - 2];
    if (isBull  && prevBar.close < ema21 - 0.35 * atr) continue;
    if (!isBull && prevBar.close > ema21 + 0.35 * atr) continue;

    // Confirmation candle
    if (!(isBull ? isBullishCandle(last, 0.30) : isBearishCandle(last, 0.30))) continue;

    // MACD soft filter
    if (hist != null && histPrev != null) {
      const against = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
      if (against) continue;
    }

    const swLow  = recentSwingLow(exec, ctx.swingBars ?? 8);
    const swHigh = recentSwingHigh(exec, ctx.swingBars ?? 8);
    const sl     = isBull ? Math.min(swLow, ema21) - 0.3 * atr : Math.max(swHigh, ema21) + 0.3 * atr;
    const risk   = isBull ? last.close - sl : sl - last.close;
    if (risk < ATR_MIN_PTS * 0.4 || risk > (ctx.maxRiskPts ?? MAX_RISK_PTS)) continue;

    const rr     = +(14 / risk).toFixed(2);
    if (rr < 0.8) continue;

    const srDist = srDistanceAtr(isBull ? last.close + 14 : last.close - 14, exec, atr, 40);
    if (srDist < (ctx.srMinAtr ?? 0.35)) continue;

    const trendBonus = trendRegime ? 5 : 0;
    const adxBonus   = adxVal != null && adxVal >= 25 ? 3 : 0;
    // Displacement strength: strong momentum bar adds conviction to the continuation
    const dispBonus  = (dispStrength ?? 0) >= 1.4 ? 4 : 0;

    return {
      dir, sl, rr, srDist,
      archetype: 'continuation_pullback',
      bonus: trendBonus + adxBonus + dispBonus,
      ...(softChopOverride && { minMtfAgree: 3 }),
      score: rr * 10 + (pull9 ? 3 : 0) + (pull21 ? 2 : 0) + trendBonus + adxBonus + dispBonus,
    };
  }
  return null;
}

function evalVwapReclaimReject(ctx) {
  const { exec, n, last, atr, vwap, vwapArr, vwapState, htfBias, rsiOB, rsiOS, dispStrength } = ctx;

  if (vwapState === 'CHOPPING' || vwapState === 'ABOVE' || vwapState === 'BELOW' || vwapState === 'UNKNOWN') return null;

  const dir    = vwapState === 'RECLAIMING' ? 'LONG' : 'SHORT';
  const isBull = dir === 'LONG';

  if (isBull && htfBias < 0) return null;
  if (!isBull && htfBias > 0) return null;
  if (isBull && rsiOB) return null;
  if (!isBull && rsiOS) return null;

  // VWAP slope must confirm the transition — a falling VWAP while price reclaims = false reclaim
  const vwapSlope = vwapArr[n] - (vwapArr[n - 3] ?? vwapArr[n]);
  if (isBull  && vwapSlope < 0) return null;
  if (!isBull && vwapSlope > 0) return null;

  // Confirmation candle
  if (!(isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25))) return null;

  const swBars = Math.max(4, (ctx.swingBars ?? 8) - 2);
  const swLow  = recentSwingLow(exec, swBars);
  const swHigh = recentSwingHigh(exec, swBars);
  const sl     = isBull ? Math.min(swLow, vwap) - 0.3 * atr : Math.max(swHigh, vwap) + 0.3 * atr;
  const risk   = isBull ? last.close - sl : sl - last.close;
  if (risk < ATR_MIN_PTS * 0.4 || risk > (ctx.maxRiskPts ?? MAX_RISK_PTS)) return null;

  const rr     = +(14 / risk).toFixed(2);
  if (rr < 0.8) return null;

  const srDist = srDistanceAtr(isBull ? last.close + 14 : last.close - 14, exec, atr, 40);
  if (srDist < (ctx.srMinAtr ?? 0.35)) return null;

  // Displacement strength: strong momentum bar adds conviction to the VWAP reclaim/rejection
  const dispBonus = (dispStrength ?? 0) >= 1.4 ? 4 : 0;

  return {
    dir, sl, rr, srDist,
    archetype: isBull ? 'vwap_reclaim' : 'vwap_rejection',
    bonus: 5 + dispBonus,
    score: rr * 12 + srDist * 4 + dispBonus,
  };
}

function evalSweepReversal(ctx) {
  const { exec, n, last, atr, vwap, hist, histPrev, regime, chopScore } = ctx;

  // Sweeps in choppy regimes produce whipsaws — require directional structure
  if (regime === 'RANGE_CHOP' || regime === 'SOFT_CHOP') return null;
  if (chopScore > 0.58) return null;

  for (const dir of ['LONG', 'SHORT']) {
    if (!detectLiquiditySweep(exec, atr, dir)) continue;

    const isBull = dir === 'LONG';

    // Strong reversal candle after the sweep — raised threshold for quality
    if (!(isBull ? isBullishCandle(last, 0.48) : isBearishCandle(last, 0.48))) continue;

    // MACD turning in our direction
    if (hist != null && histPrev != null) {
      const turning = isBull ? hist > histPrev : hist < histPrev;
      if (!turning) continue;
    }

    const sweepBar = exec[n - 1];
    const sl = isBull
      ? sweepBar.low  - 0.25 * atr
      : sweepBar.high + 0.25 * atr;
    const risk = isBull ? last.close - sl : sl - last.close;
    if (risk < ATR_MIN_PTS * 0.4 || risk > (ctx.maxRiskPts ?? MAX_RISK_PTS)) continue;

    const rr     = +(14 / risk).toFixed(2);
    if (rr < 0.7) continue;

    const srDist = srDistanceAtr(isBull ? last.close + 14 : last.close - 14, exec, atr, 40);

    return {
      dir, sl, rr, srDist,
      archetype: 'sweep_reversal',
      bonus: 7,
      minMtfAgree: 2,
      score: rr * 14 + (srDist ?? 1) * 3,
    };
  }
  return null;
}

function evalCompressionBreakout(ctx) {
  const { exec, n, last, atr, vwap, htfBias, hist, histPrev, regime, sess } = ctx;

  if (regime !== 'COMPRESSION' && regime !== 'NORMAL') return null;

  // Breakouts in thin sessions (pre-market / close) fake out without volume support.
  if (sess.quality < 0.70) return null;

  const lookback = 8;
  if (exec.length < lookback + 5) return null;

  const priorBars = exec.slice(-lookback - 1, -1);
  const rangeHigh = Math.max(...priorBars.map(b => b.high));
  const rangeLow  = Math.min(...priorBars.map(b => b.low));
  const rangePts  = rangeHigh - rangeLow;

  // Needs to be a reasonably tight range — widened to allow more breakouts
  if (rangePts > atr * 3.5) return null;

  const brkLong  = last.close > rangeHigh;
  const brkShort = last.close < rangeLow;
  if (!brkLong && !brkShort) return null;

  const dir    = brkLong ? 'LONG' : 'SHORT';
  const isBull = dir === 'LONG';

  if (isBull && htfBias < 0) return null;
  if (!isBull && htfBias > 0) return null;

  // MACD soft filter — only block if strongly counter-trend
  if (hist != null && histPrev != null) {
    const against = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
    if (against) return null;
  }

  if (!(isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25))) return null;

  const sl   = isBull ? rangeLow - 0.2 * atr : rangeHigh + 0.2 * atr;
  const risk = isBull ? last.close - sl : sl - last.close;
  if (risk < ATR_MIN_PTS * 0.4 || risk > (ctx.maxRiskPts ?? MAX_RISK_PTS)) return null;

  const rr     = +(14 / risk).toFixed(2);
  if (rr < 0.7) return null;

  const srDist = srDistanceAtr(isBull ? last.close + 14 : last.close - 14, exec, atr, 40);

  return {
    dir, sl, rr, srDist,
    archetype: 'compression_breakout',
    bonus: regime === 'COMPRESSION' ? 6 : 2,
    score: rr * 10 + (2.0 - rangePts / atr) * 4,
  };
}

function evalChopMeanRevert(ctx) {
  const { exec, n, last, atr, vwap, rsi, rsiOB, rsiOS } = ctx;

  // Only fade extremes back toward VWAP
  const isBull = last.close < vwap && rsiOS;
  const isBear = last.close > vwap && rsiOB;
  if (!isBull && !isBear) return null;

  const dir = isBull ? 'LONG' : 'SHORT';

  // Rejection candle (wick spike + body close in reversal direction)
  if (!(isBull ? isBullishCandle(last, 0.40) : isBearishCandle(last, 0.40))) return null;

  // Prior bar was a spike
  const prevBar = exec[n - 1];
  const spikeLen = isBull ? prevBar.open - prevBar.low : prevBar.high - prevBar.open;
  if (spikeLen < 0.7 * atr) return null;

  const sl   = isBull ? exec[n-1].low  - 0.2 * atr : exec[n-1].high + 0.2 * atr;
  const risk = isBull ? last.close - sl : sl - last.close;
  if (risk < ATR_MIN_PTS * 0.3 || risk > (ctx.maxRiskPts ?? MAX_RISK_PTS)) return null;

  // Smaller target in chop (aim for VWAP, ~TP1)
  const rr = +(10 / risk).toFixed(2);
  if (rr < 0.6) return null;

  return {
    dir, sl, rr, srDist: 1,
    archetype: 'chop_mean_revert',
    bonus: -6,  // penalise chop setups — used only when nothing else fires
    score: rr * 7 + (rsiOS || rsiOB ? 8 : 0),
  };
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MGC_SCALP', STRATEGY_VERSION };
