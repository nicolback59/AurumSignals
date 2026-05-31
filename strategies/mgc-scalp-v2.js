'use strict';

/**
 * STRATEGY 4 — MGC GOLD SCALPING (v6.0 — frequency + quality rebuild)
 *
 * What changed vs v5.4:
 *   1. ATR-scaled TPs (1.5/2.2/3.2/4.5 × ATR, clamped) — no more fixed 10/14/20/25
 *   2. ATR-adaptive max risk (2.5 × ATR, clamped 8–16 pts)
 *   3. London continuations enabled — TREND regime + ADX ≥ 20 + chopScore < 0.38
 *   4. NY_PRE unblocked for reversal archetypes (sweep, VWAP, fade)
 *   5. fade_extreme replaces chop_mean_revert — RSI ≤ 25/≥ 75, available in all regimes
 *   6. SOFT_CHOP continuation: require all 3 override conditions (was 2-of-3)
 *   7. MIDDAY relaxed: ADX ≥ 18, chopScore < 0.50 (was 22 / 0.42)
 *   8. Continuation minMtfAgree unified to 2 (was 1 for normal regime)
 *   9. VWAP reclaim/rejection gated by ADX ≥ 14 to prevent chop-in entries
 *  10. Sweep reversal chopScore tightened from 0.58 → 0.50
 *  11. Compression breakout range tightened from 3.5×ATR → 2.0×ATR (true compression only)
 *  12. Prior day S/R proximity expanded from 0.2 → 0.4×ATR
 *
 * Architecture:
 *   Execution TF : 3m (falls back to 5m if unavailable)
 *   Context TFs  : 15m, 30m, 45m, 1h
 *   Session scope: London, NY_PRE, NY open/continuation, Midday, AfterNoon, Asian
 *
 * Signal archetypes:
 *   continuation_pullback  — trend intact, price pulls back to EMA/VWAP
 *   vwap_reclaim           — price reclaims VWAP, continuation expected
 *   vwap_rejection         — price fails VWAP, breakdown expected
 *   sweep_reversal         — liquidity sweep below/above swing → reversal
 *   compression_breakout   — tight range resolves with momentum
 *   fade_extreme           — RSI extreme fade back toward VWAP (all regimes)
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

const STRATEGY_VERSION = '6.0';

const ATR_MIN_PTS = 2.0;
const MIN_BAR_GAP = 1;

let lastSignalBar = -999;

// ── ATR-scaled take-profit levels ─────────────────────────────────────────────
// Multipliers: T1=1.5×, T2=2.2×, T3=3.2×, T4=4.5× ATR, clamped to reasonable ranges.
// At ATR=4 pts (low vol):  T1=8, T2=12, T3=18, T4=24
// At ATR=6 pts (typical):  T1=9, T2=13, T3=19, T4=27
// At ATR=10 pts (high vol): T1=15, T2=22, T3=32, T4=45

function calcAtrTps(entry, dir, atr) {
  const t1 = Math.round(Math.max(8,  Math.min(16, atr * 1.5)));
  const t2 = Math.round(Math.max(12, Math.min(24, atr * 2.2)));
  const t3 = Math.round(Math.max(18, Math.min(34, atr * 3.2)));
  const t4 = Math.round(Math.max(24, Math.min(45, atr * 4.5)));
  const s  = dir === 'LONG' ? 1 : -1;
  return {
    tp1: +(entry + s * t1).toFixed(2),
    tp2: +(entry + s * t2).toFixed(2),
    tp3: +(entry + s * t3).toFixed(2),
    tp4: +(entry + s * t4).toFixed(2),
    tp1Pts: t1, tp2Pts: t2, tp3Pts: t3, tp4Pts: t4,
  };
}

// ── Regime & context analysis ─────────────────────────────────────────────────

function classifyRegime(bars5m, bars15m) {
  if (bars5m.length < 20 || bars15m.length < 10) return 'UNKNOWN';

  const n = bars5m.length - 1;
  const closes15m = bars15m.map(b => b.close);

  const slice = bars5m.slice(-20);
  let grossPath = 0;
  for (let i = 1; i < slice.length; i++) grossPath += Math.abs(slice[i].close - slice[i-1].close);
  const netMove    = Math.abs(slice[slice.length - 1].close - slice[0].close);
  const efficiency = grossPath > 0 ? netMove / grossPath : 0;

  const atrArr = calcAtr(bars5m, 14);
  const curAtr = atrArr[n];
  const histAtr = atrArr.slice(-20, -1).filter(Boolean);
  const avgAtr  = histAtr.length ? histAtr.reduce((s, v) => s + v, 0) / histAtr.length : curAtr;
  const atrRatio = avgAtr > 0 ? curAtr / avgAtr : 1;

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
  if (efficiency < 0.35) return 'SOFT_CHOP';
  return 'NORMAL';
}

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

  let crosses = 0;
  for (let i = 1; i < slice.length; i++) {
    const prevAbove = slice[i-1].close > vSlice[i-1];
    const nowAbove  = slice[i].close   > vSlice[i];
    if (prevAbove !== nowAbove) crosses++;
  }

  let overlaps = 0;
  for (let i = 1; i < slice.length; i++) {
    const pLo = Math.min(slice[i-1].open, slice[i-1].close);
    const pHi = Math.max(slice[i-1].open, slice[i-1].close);
    const cLo = Math.min(slice[i].open,   slice[i].close);
    const cHi = Math.max(slice[i].open,   slice[i].close);
    if (cLo < pHi && cHi > pLo) overlaps++;
  }

  return Math.min(1, crosses / 4) * 0.5 + Math.min(1, overlaps / (slice.length - 1)) * 0.5;
}

function getVwapState(bars, vwapArr, lookback = 5) {
  const n = bars.length - 1;
  if (n < lookback) return 'UNKNOWN';

  let crosses = 0;
  for (let i = Math.max(1, n - lookback); i <= n; i++) {
    if (vwapArr[i] == null || vwapArr[i-1] == null) continue;
    const prev = bars[i-1].close > vwapArr[i-1];
    const cur  = bars[i].close   > vwapArr[i];
    if (prev !== cur) crosses++;
  }
  if (crosses >= 3) return 'CHOPPING';

  const prevBars = bars.slice(-lookback - 1, -1);
  const prevVwap = vwapArr.slice(-lookback - 1, -1);
  const aboveCnt = prevBars.filter((b, i) => b.close > (prevVwap[i] ?? b.close)).length;
  const wasAbove = aboveCnt > prevBars.length / 2;
  const nowAbove = bars[n].close > vwapArr[n];

  if (!wasAbove && nowAbove)  return 'RECLAIMING';
  if (wasAbove  && !nowAbove) return 'REJECTING';
  return nowAbove ? 'ABOVE' : 'BELOW';
}

function detectExhaustion(bars, atr, dir) {
  const n = bars.length - 1;
  const lookback = Math.min(8, n);
  const slice = bars.slice(-lookback);

  const ext = dir === 'LONG'
    ? bars[n].close - Math.min(...slice.map(b => b.low))
    : Math.max(...slice.map(b => b.high)) - bars[n].close;
  if (ext > 5.5 * atr) return true;

  const last = bars[n];
  if (Math.abs(last.close - last.open) > 3.5 * atr) return true;

  return false;
}

function detectLiquiditySweep(bars, atr, dir) {
  const n = bars.length - 1;
  if (n < 4) return false;

  if (dir === 'LONG') {
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
  const chunk = bars1h.slice(0, Math.min(8, Math.floor(bars1h.length / 2)));
  if (!chunk.length) return null;
  return {
    high: Math.max(...chunk.map(b => b.high)),
    low:  Math.min(...chunk.map(b => b.low)),
  };
}

function displacementStrength(bars) {
  const n = bars.length - 1;
  const bodies = bars.slice(-11, -1).map(b => Math.abs(b.close - b.open));
  const avgBody = bodies.reduce((s, v) => s + v, 0) / (bodies.length || 1) || 1;
  const curBody = Math.abs(bars[n].close - bars[n].open);
  return curBody / avgBody;
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
  if (!Array.isArray(bars3m)) {
    [bars3m, bars5m, bars15m, bars1h, bars30m, bars45m, cfg, barIdx] =
      [[], bars3m, bars5m, bars15m, bars1h, bars30m, bars45m ?? {}, bars45m ?? null];
  }

  const exec    = bars3m.length >= 25 ? bars3m : bars5m;
  const MIN_EXEC = exec === bars3m ? 30 : 40;

  if (exec.length < MIN_EXEC || bars15m.length < 15 || bars5m.length < 30) return null;

  const curIdx = barIdx ?? exec.length;
  if (curIdx - lastSignalBar < (cfg.cooldownBars ?? MIN_BAR_GAP)) return null;

  const auditLog = cfg.auditLog;
  const ar = auditLog ? (r) => { auditLog.push(r); return null; } : () => null;

  const n    = exec.length - 1;
  const last = exec[n];

  // ── Session gate ─────────────────────────────────────────────────────────────
  // NY_PRE unblocked in v6.0 — reversal archetypes (sweep, VWAP, fade) can fire here
  const sess = getSessionInfoCompat(last.timestamp);
  if (sess.isBlackout || sess.quality < 0.40) return ar('session_quality');

  // ── Core indicators ─────────────────────────────────────────────────────────
  const closes  = exec.map(b => b.close);
  const atrArr  = calcAtr(exec, 14);
  const atr     = atrArr[n];
  if (!atr || atr < ATR_MIN_PTS) return ar('low_atr');

  const vwapArr = calcVwap(exec);
  const vwap    = vwapArr[n];
  const ema9Arr = ema(closes, 9);
  const ema21Arr= ema(closes, 21);
  const ema9    = ema9Arr[n];
  const ema21   = ema21Arr[n];
  if (!ema9 || !ema21 || !vwap) return ar('indicator_missing');
  const execBias = ema9 > ema21 ? 1 : ema9 < ema21 ? -1 : 0;

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

  if (volRegime === 'HIGH' && chopScore > 0.70) return ar('high_vol_chop');

  // ── HTF biases ──────────────────────────────────────────────────────────────
  const htfBias   = calcHtfBias(bars15m, 9, 21);
  const htf1hBias = bars1h  && bars1h.length  >= 21 ? calcHtfBias(bars1h,  9, 21) : 0;
  const htf30mBias= bars30m && bars30m.length >= 6  ? calcHtfBias(bars30m, 9, 21) : null;
  const htf45mBias= bars45m && bars45m.length >= 5  ? calcHtfBias(bars45m, 9, 21) : null;

  const ema21_15mArr = ema(bars15m.map(b => b.close), 21);
  const m15nSlope    = ema21_15mArr.length - 1;
  const htfEmaSlope  = (ema21_15mArr[m15nSlope] != null && ema21_15mArr[m15nSlope - 4] != null)
    ? ema21_15mArr[m15nSlope] - ema21_15mArr[m15nSlope - 4]
    : 0;

  const priorDay  = getPriorDayLevels(bars1h);

  const chopThreshEarly = Math.min(0.88, 0.55 + ((+(cfg.params?.std2 ?? 2.2)) - 1.5) * 0.20);
  const isChop    = chopScore > chopThreshEarly;
  const isSoftChop = !isChop && regime === 'SOFT_CHOP';
  const rsiOB     = rsi != null && rsi > 76;
  const rsiOS     = rsi != null && rsi < 24;

  const adxVal    = getAdxValue(exec);
  const dispStrength = displacementStrength(exec);

  // ── ATR-scaled TP levels ────────────────────────────────────────────────────
  const tp1Pts = Math.round(Math.max(8,  Math.min(16, atr * 1.5)));
  const tp2Pts = Math.round(Math.max(12, Math.min(24, atr * 2.2)));
  const tp3Pts = Math.round(Math.max(18, Math.min(34, atr * 3.2)));
  const tp4Pts = Math.round(Math.max(24, Math.min(45, atr * 4.5)));

  // ── ATR-adaptive max risk — scales between 8 and 16 pts (2.5× ATR) ──────────
  const p            = cfg.params ?? {};
  const adaptMaxRisk = Math.round(Math.max(8, Math.min(16, atr * 2.5)));
  const maxRiskPts   = Math.max(6, Math.min(adaptMaxRisk, +(p.slPts ?? adaptMaxRisk)));
  const confBoost    = Math.max(0, Math.round((p.minScore ?? 7) - 7));
  const chopThresh   = Math.min(0.88, 0.55 + ((+(p.std2 ?? 2.2)) - 1.5) * 0.20);
  const adxFloor     = Math.round(+(p.stdvLen ?? 12));
  const swingBars    = Math.max(4, Math.min(25, Math.round(+(p.swingLook ?? 12))));
  const srMinAtr     = Math.max(0.15, 0.45 - (+(p.swingL ?? 5)) * 0.02);

  const ctx = {
    exec, bars5m, bars15m, bars1h, n, last, closes, atr, vwap, vwapArr,
    ema9, ema21, ema9Arr, ema21Arr, rsi, rsiOB, rsiOS, hist, histPrev,
    regime, chopScore, vwapState, volRegime, htfBias, htf1hBias,
    htf30mBias, htf45mBias, priorDay, isChop, isSoftChop, adxVal, sess,
    dispStrength, htfEmaSlope,
    maxRiskPts, adxFloor, swingBars, srMinAtr,
    tp1Pts, tp2Pts, tp3Pts, tp4Pts,
  };

  // ── Try each archetype ──────────────────────────────────────────────────────
  const candidates = [];

  if (!isChop) {
    if (!isSoftChop) {
      const cp = evalContinuationPullback(ctx);  if (cp) candidates.push(cp);
      const cb = evalCompressionBreakout(ctx);   if (cb) candidates.push(cb);
    }
    const vr = evalVwapReclaimReject(ctx);       if (vr) candidates.push(vr);
    const sw = evalSweepReversal(ctx);           if (sw) candidates.push(sw);
  }
  // fade_extreme: available in all regimes — RSI extreme fade toward VWAP
  const fe = evalFadeExtreme(ctx);               if (fe) candidates.push(fe);

  if (candidates.length === 0) return ar('no_archetype');

  const best = candidates.reduce((a, b) => a.score > b.score ? a : b);

  // ── Multi-TF confluence gate ─────────────────────────────────────────────────
  const htfLayers = [
    { bias: execBias,   present: true },
    { bias: htfBias,    present: true },
    { bias: htf1hBias,  present: bars1h  && bars1h.length  >= 21 },
    { bias: htf30mBias, present: htf30mBias !== null },
    { bias: htf45mBias, present: htf45mBias !== null },
  ];
  const expectedBias   = best.dir === 'LONG' ? 1 : -1;
  const presentLayers  = htfLayers.filter(l => l.present);
  const agreedLayers   = presentLayers.filter(l => l.bias === expectedBias);
  const conflictLayers = presentLayers.filter(l => l.bias !== 0 && l.bias !== expectedBias);
  const minAgree = best.minMtfAgree ?? 2;
  if (agreedLayers.length < minAgree) return ar('mtf_insufficient');
  if (conflictLayers.length > agreedLayers.length) return ar('mtf_majority_conflict');

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

  let regimeAdj = 0;
  if (regime === 'TREND_BULL' && best.dir === 'LONG')  regimeAdj = +6;
  if (regime === 'TREND_BEAR' && best.dir === 'SHORT') regimeAdj = +6;
  if (regime === 'RANGE_CHOP') regimeAdj = -8;
  if (volRegime === 'HIGH')    regimeAdj -= 4;
  if (volRegime === 'LOW')     regimeAdj -= 3;

  const chopPenalty = Math.round(chopScore * 6);

  if (detectExhaustion(exec, atr, best.dir)) return ar('exhaustion');

  const confidence = Math.min(100, Math.max(0,
    baseConf + confluenceBonus + regimeAdj + (best.bonus ?? 0) - chopPenalty,
  ));

  if (confidence < THRESHOLDS.MGC_SCALP + confBoost) return ar('confidence_below');

  // Block entry within 0.4 ATR of prior day H/L (expanded from 0.2 in v5.4)
  if (priorDay) {
    const e = last.close;
    if (Math.abs(e - priorDay.high) < 0.4 * atr) return ar('prior_day_sr');
    if (Math.abs(e - priorDay.low)  < 0.4 * atr) return ar('prior_day_sr');
  }

  lastSignalBar = curIdx;

  const { grade, win_prob_tp1, win_prob_tp2, win_prob_tp3, win_prob_tp4 } = deriveGradeAndProbs(confidence);
  const isBull = best.dir === 'LONG';
  const entry  = last.close;
  const tps    = calcAtrTps(entry, best.dir, atr);

  return {
    instrument:    'MGC',
    strategy_name: 'MGC_SCALP',
    trade_style:   'scalp',
    timeframe:     exec === bars3m ? '3m' : '5m',
    direction:     best.dir,
    entry:         +entry.toFixed(2),
    sl:            +best.sl.toFixed(2),
    tp1:           tps.tp1,
    tp2:           tps.tp2,
    tp3:           tps.tp3,
    tp4:           tps.tp4,
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
      tp1Pts, tp2Pts, tp3Pts, tp4Pts,
    },
    timestamp:    last.timestamp,
    trade_status: 'PENDING',
  };
}

// ── Archetype evaluators ───────────────────────────────────────────────────────

function evalContinuationPullback(ctx) {
  const { exec, n, last, atr, vwap, vwapArr, ema9, ema21,
          regime, htfBias, htf1hBias, rsiOB, rsiOS, hist, histPrev, chopScore,
          adxVal, sess, dispStrength, htfEmaSlope, tp2Pts } = ctx;

  if (regime === 'RANGE_CHOP') return null;

  // SOFT_CHOP: allow continuation only when ALL 3 override conditions are met
  // (v6.0: was 2-of-3 in v5.4 — tightened to prevent false trend entries)
  const softChopOverride = regime === 'SOFT_CHOP';
  if (softChopOverride) {
    const htfTrending = Math.abs(htfEmaSlope ?? 0) > 0.25 * atr;
    const adxOk       = adxVal != null && adxVal >= 18;
    const dispOk      = (dispStrength ?? 0) >= 1.2;
    const condsMet    = (htfTrending ? 1 : 0) + (adxOk ? 1 : 0) + (dispOk ? 1 : 0);
    if (condsMet < 3) return null;
  }

  if (sess.quality < 0.58) return null;

  const trendRegime = regime === 'TREND_BULL' || regime === 'TREND_BEAR';
  if (trendRegime && adxVal != null && adxVal < (ctx.adxFloor ?? 16)) return null;

  const dirs = [];
  if (ema9 > ema21 && htfBias >= 0) dirs.push('LONG');
  if (ema9 < ema21 && htfBias <= 0) dirs.push('SHORT');

  for (const dir of dirs) {
    const isBull = dir === 'LONG';
    if (isBull && rsiOB) continue;
    if (!isBull && rsiOS) continue;

    // NY_PRE: continuation archetypes blocked — only reversals are valid here
    if (sess.name === 'NY_PRE') continue;

    // MIDDAY: relaxed in v6.0 — ADX ≥ 18 and chopScore < 0.50 (was 22 / 0.42)
    if (sess.name === 'MIDDAY' && (adxVal == null || adxVal < 18 || chopScore >= 0.50)) continue;

    // NY_OPEN: require directional clarity
    if (sess.name === 'NY_OPEN' && (adxVal == null || adxVal < 20 || chopScore >= 0.45)) continue;

    // LONDON: enabled in v6.0 — TREND regime only, ADX ≥ 20, chopScore < 0.38, strict HTF alignment
    if (sess.name === 'LONDON') {
      if (regime !== 'TREND_BULL' && regime !== 'TREND_BEAR') continue;
      if (adxVal == null || adxVal < 20) continue;
      if (chopScore >= 0.38) continue;
      if ((isBull && htfBias !== 1) || (!isBull && htfBias !== -1)) continue;
    }

    const tol    = 0.80 * atr;
    const pull9  = hadPullbackToLevel(exec, ema9,  tol, dir, 16);
    const pull21 = hadPullbackToLevel(exec, ema21, tol, dir, 16);
    const pullV  = hadPullbackToLevel(exec, vwap,  tol, dir, 16);
    const atEma21Now = isBull
      ? last.low  <= ema21 + 0.65 * atr && last.close > ema21 - 0.35 * atr
      : last.high >= ema21 - 0.65 * atr && last.close < ema21 + 0.35 * atr;
    const inEmaZone = isBull
      ? last.close >= ema21 - 0.20 * atr && last.close <= ema9 + 0.20 * atr && ema9 > ema21
      : last.close <= ema21 + 0.20 * atr && last.close >= ema9 - 0.20 * atr && ema9 < ema21;
    if (!pull9 && !pull21 && !pullV && !atEma21Now && !inEmaZone) continue;

    const prevBar = exec[exec.length - 2];
    if (isBull  && prevBar.close < ema21 - 0.35 * atr) continue;
    if (!isBull && prevBar.close > ema21 + 0.35 * atr) continue;

    if (!(isBull ? isBullishCandle(last, 0.30) : isBearishCandle(last, 0.30))) continue;

    if (hist != null && histPrev != null) {
      const against = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
      if (against) continue;
    }

    const swLow  = recentSwingLow(exec, ctx.swingBars ?? 8);
    const swHigh = recentSwingHigh(exec, ctx.swingBars ?? 8);
    const sl     = isBull ? Math.min(swLow, ema21) - 0.3 * atr : Math.max(swHigh, ema21) + 0.3 * atr;
    const risk   = isBull ? last.close - sl : sl - last.close;
    if (risk < ATR_MIN_PTS * 0.4 || risk > ctx.maxRiskPts) continue;

    const rr = +((tp2Pts ?? 14) / risk).toFixed(2);
    if (rr < 0.8) continue;

    const srDist = srDistanceAtr(isBull ? last.close + (tp2Pts ?? 14) : last.close - (tp2Pts ?? 14), exec, atr, 40);
    if (srDist < 0.20) continue;

    const trendBonus = trendRegime ? 5 : 0;
    const adxBonus   = adxVal != null && adxVal >= 25 ? 3 : 0;
    const dispBonus  = (dispStrength ?? 0) >= 1.4 ? 4 : 0;
    const londonBonus = sess.name === 'LONDON' ? 3 : 0;

    return {
      dir, sl, rr, srDist,
      archetype: 'continuation_pullback',
      // v6.0: minMtfAgree=2 for all cases (was 1 for non-softchop in v5.4)
      bonus: trendBonus + adxBonus + dispBonus + londonBonus,
      minMtfAgree: softChopOverride ? 2 : 2,
      score: rr * 10 + (pull9 ? 3 : 0) + (pull21 ? 2 : 0) + (inEmaZone ? 2 : 0) + trendBonus + adxBonus + dispBonus + londonBonus,
    };
  }
  return null;
}

function evalVwapReclaimReject(ctx) {
  const { exec, n, last, atr, vwap, vwapArr, vwapState, htfBias, rsiOB, rsiOS,
          dispStrength, adxVal, tp2Pts } = ctx;

  if (vwapState === 'CHOPPING' || vwapState === 'UNKNOWN') return null;

  // ADX floor: block in directionless conditions — reclaims in pure chop are false signals
  if (adxVal != null && adxVal < 14) return null;

  let dir;
  if (vwapState === 'RECLAIMING') {
    dir = 'LONG';
  } else if (vwapState === 'REJECTING') {
    dir = 'SHORT';
  } else if (vwapState === 'ABOVE') {
    if (vwapArr[n] == null) return null;
    if (last.low > vwapArr[n] + 0.30 * atr) return null;
    dir = 'LONG';
  } else if (vwapState === 'BELOW') {
    if (vwapArr[n] == null) return null;
    if (last.high < vwapArr[n] - 0.30 * atr) return null;
    dir = 'SHORT';
  } else {
    return null;
  }
  const isBull = dir === 'LONG';

  if (isBull && htfBias < 0) return null;
  if (!isBull && htfBias > 0) return null;
  if (isBull && rsiOB) return null;
  if (!isBull && rsiOS) return null;

  if (vwapState === 'RECLAIMING' || vwapState === 'REJECTING') {
    if (isBull  && last.close <= vwapArr[n] + 0.10 * atr) return null;
    if (!isBull && last.close >= vwapArr[n] - 0.10 * atr) return null;
  }

  if (!(isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25))) return null;

  const swBars = Math.max(4, (ctx.swingBars ?? 8) - 2);
  const swLow  = recentSwingLow(exec, swBars);
  const swHigh = recentSwingHigh(exec, swBars);
  const sl     = isBull ? Math.min(swLow, vwap) - 0.3 * atr : Math.max(swHigh, vwap) + 0.3 * atr;
  const risk   = isBull ? last.close - sl : sl - last.close;
  if (risk < ATR_MIN_PTS * 0.4 || risk > ctx.maxRiskPts) return null;

  const rr = +((tp2Pts ?? 14) / risk).toFixed(2);
  if (rr < 0.8) return null;

  const srDist = srDistanceAtr(isBull ? last.close + (tp2Pts ?? 14) : last.close - (tp2Pts ?? 14), exec, atr, 40);
  if (srDist < (ctx.srMinAtr ?? 0.35)) return null;

  const dispBonus = (dispStrength ?? 0) >= 1.4 ? 4 : 0;

  return {
    dir, sl, rr, srDist,
    archetype: isBull ? 'vwap_reclaim' : 'vwap_rejection',
    bonus: 5 + dispBonus,
    score: rr * 12 + srDist * 4 + dispBonus,
  };
}

function evalSweepReversal(ctx) {
  const { exec, n, last, atr, vwap, hist, histPrev, regime, chopScore, tp2Pts } = ctx;

  if (regime === 'RANGE_CHOP' || regime === 'SOFT_CHOP') return null;
  // Tightened chopScore threshold: 0.50 (was 0.58 in v5.4)
  if (chopScore > 0.50) return null;

  for (const dir of ['LONG', 'SHORT']) {
    if (!detectLiquiditySweep(exec, atr, dir)) continue;

    const isBull = dir === 'LONG';

    if (!(isBull ? isBullishCandle(last, 0.48) : isBearishCandle(last, 0.48))) continue;

    if (hist != null && histPrev != null) {
      const turning = isBull ? hist > histPrev : hist < histPrev;
      if (!turning) continue;
    }

    const sweepBar = exec[n - 1];
    const sl = isBull
      ? sweepBar.low  - 0.25 * atr
      : sweepBar.high + 0.25 * atr;
    const risk = isBull ? last.close - sl : sl - last.close;
    if (risk < ATR_MIN_PTS * 0.4 || risk > ctx.maxRiskPts) continue;

    const rr = +((tp2Pts ?? 14) / risk).toFixed(2);
    if (rr < 0.7) continue;

    const srDist = srDistanceAtr(isBull ? last.close + (tp2Pts ?? 14) : last.close - (tp2Pts ?? 14), exec, atr, 40);

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
  const { exec, n, last, atr, vwap, htfBias, hist, histPrev, regime, sess, tp2Pts } = ctx;

  if (regime !== 'COMPRESSION' && regime !== 'NORMAL') return null;
  if (sess.quality < 0.58) return null;
  // Block NY_PRE — breakouts require established liquidity structure
  if (sess.name === 'NY_PRE') return null;

  const lookback = 8;
  if (exec.length < lookback + 5) return null;

  const priorBars = exec.slice(-lookback - 1, -1);
  const rangeHigh = Math.max(...priorBars.map(b => b.high));
  const rangeLow  = Math.min(...priorBars.map(b => b.low));
  const rangePts  = rangeHigh - rangeLow;

  // Tightened in v6.0: true compression only (< 2×ATR vs old 3.5×ATR)
  if (rangePts > atr * 2.0) return null;

  const brkLong  = last.close > rangeHigh;
  const brkShort = last.close < rangeLow;
  if (!brkLong && !brkShort) return null;

  const dir    = brkLong ? 'LONG' : 'SHORT';
  const isBull = dir === 'LONG';

  if (isBull && htfBias < 0) return null;
  if (!isBull && htfBias > 0) return null;

  if (hist != null && histPrev != null) {
    const against = isBull ? (hist < 0 && hist < histPrev) : (hist > 0 && hist > histPrev);
    if (against) return null;
  }

  if (!(isBull ? isBullishCandle(last, 0.25) : isBearishCandle(last, 0.25))) return null;

  const sl   = isBull ? rangeLow - 0.2 * atr : rangeHigh + 0.2 * atr;
  const risk = isBull ? last.close - sl : sl - last.close;
  if (risk < ATR_MIN_PTS * 0.4 || risk > ctx.maxRiskPts) return null;

  const rr = +((tp2Pts ?? 14) / risk).toFixed(2);
  if (rr < 0.7) return null;

  const srDist = srDistanceAtr(isBull ? last.close + (tp2Pts ?? 14) : last.close - (tp2Pts ?? 14), exec, atr, 40);

  return {
    dir, sl, rr, srDist,
    archetype: 'compression_breakout',
    bonus: regime === 'COMPRESSION' ? 6 : 2,
    score: rr * 10 + (2.0 - rangePts / atr) * 4,
  };
}

// ── fade_extreme: replaces chop_mean_revert ────────────────────────────────────
// Fades RSI extremes (≤ 25 / ≥ 75) back toward VWAP in any regime.
// Lower threshold barrier than chop_mean_revert (was RSI < 30 + pure-chop gate + spike 0.7×ATR).
// Spike requirement relaxed to 0.5×ATR and available regardless of regime classification.

function evalFadeExtreme(ctx) {
  const { exec, n, last, atr, vwap, rsi } = ctx;

  const isBull = last.close < vwap && rsi != null && rsi <= 25;
  const isBear = last.close > vwap && rsi != null && rsi >= 75;
  if (!isBull && !isBear) return null;

  const dir = isBull ? 'LONG' : 'SHORT';

  if (!(isBull ? isBullishCandle(last, 0.40) : isBearishCandle(last, 0.40))) return null;

  // Prior bar must show a spike (wick in extreme direction) — relaxed to 0.5×ATR
  const prevBar  = exec[n - 1];
  const spikeLen = isBull
    ? Math.max(prevBar.open, prevBar.close) - prevBar.low
    : prevBar.high - Math.min(prevBar.open, prevBar.close);
  if (spikeLen < 0.5 * atr) return null;

  // Need meaningful distance to VWAP (the target)
  const distToVwap = Math.abs(last.close - vwap);
  if (distToVwap < 2.5) return null;

  const sl = isBull
    ? Math.min(prevBar.low, last.low)   - 0.2 * atr
    : Math.max(prevBar.high, last.high) + 0.2 * atr;
  const risk = isBull ? last.close - sl : sl - last.close;
  if (risk < ATR_MIN_PTS * 0.3 || risk > ctx.maxRiskPts) return null;

  // Target: VWAP (clamped to TP1–TP4 range so we always have a valid RR)
  const targetPts = Math.max(ctx.tp1Pts ?? 10, Math.min(distToVwap, ctx.tp4Pts ?? 25));
  const rr = +(targetPts / risk).toFixed(2);
  if (rr < 0.7) return null;

  return {
    dir, sl, rr, srDist: 1,
    archetype: 'fade_extreme',
    bonus: -3,
    minMtfAgree: 1,  // relaxed — RSI extreme is its own quality signal
    score: rr * 8 + (rsi <= 20 || rsi >= 80 ? 8 : 4),
  };
}

function reset() { lastSignalBar = -999; }

module.exports = { evaluate, reset, ATR_MIN_PTS, STRATEGY_NAME: 'MGC_SCALP', STRATEGY_VERSION };
