'use strict';

const { computeSignal } = require('./signal-engine');

// ── Aggregate 1m bars → N-minute bars ─────────────────────────────────────────
function aggregateNm(bars1m, n) {
  const result = [];
  for (let i = 0; i + n - 1 < bars1m.length; i += n) {
    const slice = bars1m.slice(i, i + n);
    result.push({
      timestamp: slice[0].timestamp,
      open:      slice[0].open,
      high:      Math.max(...slice.map(b => b.high)),
      low:       Math.min(...slice.map(b => b.low)),
      close:     slice[slice.length - 1].close,
      volume:    slice.reduce((s, b) => s + (b.volume || 0), 0),
    });
  }
  return result;
}

// Keep aggregate15m as a convenience alias
function aggregate15m(bars1m) { return aggregateNm(bars1m, 15); }

// ── Multi-TP outcome resolver with slippage ───────────────────────────────────
/**
 * Resolve trade outcome forward from sigIdx.
 * TP checks come before SL checks within the same bar (limit vs stop convention).
 * Slippage applied to entry fill and SL only (TP uses limit orders).
 *
 * Returns: { result:'WIN'|'LOSS'|'BE', rMultiple, tpHit:1|2|3|null, barsHeld }
 */
function resolveOutcomeMultiTP(bars, sigIdx, direction, entry, sl, tp1, tp2, tp3, slipPts, maxBars) {
  // Adverse slippage: entry fill is worse, SL exit is worse
  const adjSL = direction === 'LONG' ? sl - slipPts : sl + slipPts;

  for (let j = sigIdx + 1; j < Math.min(sigIdx + maxBars + 1, bars.length); j++) {
    const { open, high, low } = bars[j];
    const barsHeld = j - sigIdx;

    if (direction === 'LONG') {
      // Gap checks first (handles overnight gaps, news spikes)
      if (open >= tp3) return { result: 'WIN',  rMultiple: 3.0,  tpHit: 3, barsHeld };
      if (open >= tp2) return { result: 'WIN',  rMultiple: 2.0,  tpHit: 2, barsHeld };
      if (open >= tp1) return { result: 'WIN',  rMultiple: 1.0,  tpHit: 1, barsHeld };
      if (open <= adjSL) return { result: 'LOSS', rMultiple: -1.0, tpHit: null, barsHeld };

      // Bar range: check TP levels first, then SL
      if (high >= tp3) return { result: 'WIN',  rMultiple: 3.0,  tpHit: 3, barsHeld };
      if (high >= tp2) return { result: 'WIN',  rMultiple: 2.0,  tpHit: 2, barsHeld };
      if (high >= tp1) return { result: 'WIN',  rMultiple: 1.0,  tpHit: 1, barsHeld };
      if (low  <= adjSL) return { result: 'LOSS', rMultiple: -1.0, tpHit: null, barsHeld };
    } else {
      if (open <= tp3) return { result: 'WIN',  rMultiple: 3.0,  tpHit: 3, barsHeld };
      if (open <= tp2) return { result: 'WIN',  rMultiple: 2.0,  tpHit: 2, barsHeld };
      if (open <= tp1) return { result: 'WIN',  rMultiple: 1.0,  tpHit: 1, barsHeld };
      if (open >= adjSL) return { result: 'LOSS', rMultiple: -1.0, tpHit: null, barsHeld };

      if (low  <= tp3) return { result: 'WIN',  rMultiple: 3.0,  tpHit: 3, barsHeld };
      if (low  <= tp2) return { result: 'WIN',  rMultiple: 2.0,  tpHit: 2, barsHeld };
      if (low  <= tp1) return { result: 'WIN',  rMultiple: 1.0,  tpHit: 1, barsHeld };
      if (high >= adjSL) return { result: 'LOSS', rMultiple: -1.0, tpHit: null, barsHeld };
    }
  }

  return { result: 'BE', rMultiple: 0.0, tpHit: null, barsHeld: maxBars };
}

// ── Legacy single-TP resolver (kept for backward compatibility) ───────────────
function resolveOutcome(bars, sigIdx, direction, tp1, sl, maxBars = 50) {
  for (let j = sigIdx + 1; j < Math.min(sigIdx + maxBars + 1, bars.length); j++) {
    const { open, high, low } = bars[j];
    if (direction === 'LONG') {
      if (open >= tp1) return 'WIN';
      if (open <= sl)  return 'LOSS';
      if (high >= tp1) return 'WIN';
      if (low  <= sl)  return 'LOSS';
    } else {
      if (open <= tp1) return 'WIN';
      if (open >= sl)  return 'LOSS';
      if (low  <= tp1) return 'WIN';
      if (high >= sl)  return 'LOSS';
    }
  }
  return 'BE';
}

// ── Market regime detector ────────────────────────────────────────────────────
/**
 * Classifies current market regime based on the recent lookback window.
 * Returns: 'trending' | 'ranging' | 'volatile' | 'mixed'
 */
function detectRegime(bars, idx, lookback = 60) {
  const start = Math.max(0, idx - lookback);
  const slice = bars.slice(start, idx + 1);
  if (slice.length < 20) return 'unknown';

  const n      = slice.length;
  const closes = slice.map(b => b.close);
  const highs  = slice.map(b => b.high);
  const lows   = slice.map(b => b.low);

  // ATR split: recent (last 10) vs full window
  const tr = (i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1])
    );
  };

  let shortTrSum = 0;
  for (let i = n - 10; i < n; i++) shortTrSum += tr(i);
  const shortAtr = shortTrSum / 10;

  let longTrSum = 0;
  for (let i = 1; i < n; i++) longTrSum += tr(i);
  const longAtr = longTrSum / (n - 1) || 1;

  // Linear regression slope (normalised by ATR)
  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope     = den > 0 ? num / den : 0;
  const slopeNorm = Math.abs(slope) / longAtr;
  const atrRatio  = shortAtr / longAtr;

  if (atrRatio > 1.35)   return 'volatile';
  if (slopeNorm > 0.09)  return 'trending';
  if (slopeNorm < 0.03 && atrRatio < 0.85) return 'ranging';
  return 'mixed';
}

// ── Enhanced performance metrics ──────────────────────────────────────────────
/**
 * Accepts trades as either:
 *   - string[]: legacy ['WIN','LOSS','BE',...]
 *   - object[]: [{result, rMultiple, tpHit, barsHeld, ...},...]
 */
function calcMetrics(trades, slPts) {
  const n = trades.length;
  if (n === 0) return {
    winRate: 0, tp1Rate: 0, tp2Rate: 0, tp3Rate: 0,
    profitFactor: 0, sharpe: 0, maxDrawdown: 0, tradeCount: 0,
    avgR: 0, expectancy: 0, wins: 0, losses: 0, bes: 0,
  };

  // Normalise to object format
  const norm = trades.map(t =>
    typeof t === 'string'
      ? { result: t, rMultiple: t === 'WIN' ? 1 : t === 'LOSS' ? -1 : 0, tpHit: t === 'WIN' ? 1 : null }
      : t
  );

  const wins   = norm.filter(t => t.result === 'WIN').length;
  const losses = norm.filter(t => t.result === 'LOSS').length;
  const bes    = norm.filter(t => t.result === 'BE').length;
  const winRate = wins / n;

  const tp1Hits = norm.filter(t => (t.tpHit ?? 0) >= 1).length;
  const tp2Hits = norm.filter(t => (t.tpHit ?? 0) >= 2).length;
  const tp3Hits = norm.filter(t => (t.tpHit ?? 0) >= 3).length;

  const rReturns  = norm.map(t => t.rMultiple ?? 0);
  const avgR      = rReturns.reduce((a, b) => a + b, 0) / n;
  const grossPos  = rReturns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossNeg  = Math.abs(rReturns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const pf        = grossNeg === 0 ? (grossPos > 0 ? 9.99 : 0) : grossPos / grossNeg;

  const mean     = avgR;
  const variance = rReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sharpe   = variance === 0 ? 0 : mean / Math.sqrt(variance);

  // Max drawdown (in R multiples)
  let peak = 0, equity = 0, maxDd = 0;
  for (const r of rReturns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    winRate,
    tp1Rate: tp1Hits / n,
    tp2Rate: tp2Hits / n,
    tp3Rate: tp3Hits / n,
    profitFactor: +pf.toFixed(3),
    sharpe:       +sharpe.toFixed(3),
    maxDrawdown:  +maxDd.toFixed(2),
    tradeCount:   n,
    avgR:         +avgR.toFixed(3),
    expectancy:   +(avgR * (slPts ?? 25)).toFixed(2),
    wins, losses, bes,
  };
}

// ── Composite fitness score ───────────────────────────────────────────────────
/**
 * Multi-objective ranking function used by the optimizer.
 * Blends win rate, Sharpe, drawdown control, trade count, and OOS divergence.
 * Returns 0–1 (higher = better).
 */
function compositeFitness(isM, oosM = null) {
  const wr     = isM.winRate;
  const sharpe = Math.max(0, Math.min(isM.sharpe, 3));
  const dd     = Math.max(0, Math.min(isM.maxDrawdown, 20));
  const trades = Math.min(isM.tradeCount, 250);

  // Primary fitness from in-sample metrics
  let fitness = wr * 0.50
    + (sharpe / 3)   * 0.22
    + (1 - dd / 20)  * 0.14
    + (trades / 250) * 0.14;

  // OOS integration: penalise overfitting, reward consistent out-of-sample perf
  if (oosM && oosM.tradeCount >= 15) {
    const divergence = Math.abs(wr - oosM.winRate);
    if (divergence > 0.10) {
      // Heavy penalty for overfitting: lose 3× the excess divergence
      fitness *= Math.max(0.40, 1 - (divergence - 0.10) * 3);
    }
    // Blend OOS win rate into the final score (35% weight)
    fitness = fitness * 0.65 + oosM.winRate * 0.35;
  }

  return Math.max(0, Math.min(fitness, 1));
}

// ── Regime-aware performance breakdown ───────────────────────────────────────
function regimeBreakdown(trades) {
  const map = {};
  for (const t of trades) {
    if (typeof t !== 'object') continue;
    const r = t.regime || 'unknown';
    if (!map[r]) map[r] = { wins: 0, losses: 0, bes: 0, total: 0 };
    map[r].total++;
    if (t.result === 'WIN')  map[r].wins++;
    if (t.result === 'LOSS') map[r].losses++;
    if (t.result === 'BE')   map[r].bes++;
  }
  // Annotate with win rate
  for (const k of Object.keys(map)) {
    const { wins, total } = map[k];
    map[k].winRate = total > 0 ? +(wins / total).toFixed(3) : 0;
  }
  return map;
}

// ── Style performance breakdown ───────────────────────────────────────────────
function styleBreakdown(trades) {
  const map = {};
  for (const t of trades) {
    if (typeof t !== 'object') continue;
    const s = t.tradeStyle || 'scalp';
    if (!map[s]) map[s] = { wins: 0, losses: 0, bes: 0, total: 0, totalR: 0 };
    map[s].total++;
    map[s].totalR += (t.rMultiple ?? 0);
    if (t.result === 'WIN')  map[s].wins++;
    if (t.result === 'LOSS') map[s].losses++;
    if (t.result === 'BE')   map[s].bes++;
  }
  for (const k of Object.keys(map)) {
    const { wins, total, totalR } = map[k];
    map[k].winRate = total > 0 ? +(wins / total).toFixed(3) : 0;
    map[k].avgR    = total > 0 ? +(totalR / total).toFixed(3) : 0;
  }
  return map;
}

// ── Main backtest function ────────────────────────────────────────────────────
/**
 * Run a walk-forward backtest over historical 1m bars.
 *
 * @param {Array}  bars1m  - 1-minute OHLCV bars, oldest first
 * @param {Object} params  - strategy parameters (same shape as computeSignal cfg)
 * @param {Object} opts
 *   @param {string}  opts.instrument  - 'MNQ' | 'MGC'
 *   @param {number}  opts.warmup      - bars before scanning starts (default 60)
 *   @param {number}  opts.maxResolve  - forward bars for outcome resolution (default 150)
 *   @param {number}  opts.cooldown    - bars between signals (default 1)
 *   @param {number}  opts.slipPts     - slippage per side in points (instrument-specific default)
 *   @param {number}  opts.htfPeriod   - HTF bar size in minutes (default 15)
 *   @param {number}  opts.splitRatio  - in-sample fraction for walk-forward (default 0.70)
 *
 * @returns {{ trades, metrics, signalLog, isMetrics, oosMetrics }}
 */
function runBacktest(bars1m, params, opts = {}) {
  const instrument  = opts.instrument  ?? 'MNQ';
  const warmup      = opts.warmup      ?? 60;
  const maxResolve  = opts.maxResolve  ?? 150;
  const cooldown    = opts.cooldown    ?? 1;
  const slipPts     = opts.slipPts     ?? (instrument === 'MGC' ? 0.1 : 0.25);
  const htfPeriod   = opts.htfPeriod   ?? 15;
  const splitRatio  = opts.splitRatio  ?? 0.70;

  const n      = bars1m.length;
  const allHtf = aggregateNm(bars1m, htfPeriod);
  const splitIdx = Math.floor(n * splitRatio);

  // Inner scan over a bar range [start, end)
  function scanSegment(start, end) {
    const trades    = [];
    const signalLog = [];
    let lastSigIdx  = -Infinity;

    for (let i = Math.max(warmup, start); i < end - maxResolve; i++) {
      if (i - lastSigIdx < cooldown) continue;

      const htfSlice = allHtf.slice(0, Math.floor(i / htfPeriod) + 1);
      if (htfSlice.length < 10) continue;

      const signal = computeSignal(bars1m.slice(0, i + 1), htfSlice, {
        ...params,
        instrument,
      });
      if (!signal) continue;

      const outcome = resolveOutcomeMultiTP(
        bars1m, i,
        signal.direction, signal.entry, signal.sl,
        signal.tp1, signal.tp2, signal.tp3,
        slipPts, maxResolve
      );

      const regime = detectRegime(bars1m, i);

      const record = {
        ...outcome,
        regime,
        setup:      signal.setup,
        tradeStyle: signal.tradeStyle,
        grade:      signal.grade,
        score:      signal.score,
      };

      trades.push(record);
      signalLog.push({
        bar: i, timestamp: bars1m[i].timestamp,
        ...signal, ...outcome, regime,
      });
      lastSigIdx = i;
    }

    return { trades, signalLog };
  }

  const { trades: isTrades, signalLog: isLog }    = scanSegment(0, splitIdx);
  const { trades: oosTrades, signalLog: oosLog }  = scanSegment(splitIdx, n);
  const allTrades = [...isTrades, ...oosTrades];

  const isMetrics  = calcMetrics(isTrades,  params.slPts ?? 25);
  const oosMetrics = calcMetrics(oosTrades, params.slPts ?? 25);
  const metrics    = calcMetrics(allTrades, params.slPts ?? 25);

  // Augment combined metrics with walk-forward data
  metrics.isWinRate   = isMetrics.winRate;
  metrics.oosWinRate  = oosMetrics.winRate;
  metrics.fitness     = compositeFitness(isMetrics, oosMetrics);
  metrics.barsScanned = n;
  metrics.regimes     = regimeBreakdown(allTrades);
  metrics.styles      = styleBreakdown(allTrades);

  return {
    trades: allTrades,
    metrics,
    signalLog: [...isLog, ...oosLog],
    isMetrics,
    oosMetrics,
  };
}

module.exports = {
  runBacktest,
  aggregate15m,
  aggregateNm,
  resolveOutcome,
  resolveOutcomeMultiTP,
  detectRegime,
  calcMetrics,
  compositeFitness,
  regimeBreakdown,
  styleBreakdown,
};
