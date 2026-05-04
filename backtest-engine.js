'use strict';

const { computeSignal } = require('./signal-engine');

// ── Aggregate 1m bars → 15m bars ──────────────────────────────────────────────
function aggregate15m(bars1m) {
  const result = [];
  for (let i = 0; i + 14 < bars1m.length; i += 15) {
    const slice = bars1m.slice(i, i + 15);
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

// ── Market regime detection ───────────────────────────────────────────────────
/**
 * Classify market regime at bar `i` using ATR ratio and trend displacement.
 * Returns 'trending' | 'ranging' | 'volatile' | 'unknown'
 */
function detectRegime(bars, i, period = 14) {
  if (i < period * 2) return 'unknown';

  const slice = bars.slice(Math.max(0, i - period * 2), i + 1);
  const tr = slice.map((b, j) =>
    j === 0 ? b.high - b.low :
    Math.max(b.high - b.low,
             Math.abs(b.high - slice[j-1].close),
             Math.abs(b.low  - slice[j-1].close))
  );

  const recent = tr.slice(-period);
  const prev   = tr.slice(-period * 2, -period);
  if (recent.length < period || prev.length < period) return 'unknown';

  const recentATR = recent.reduce((a, b) => a + b, 0) / period;
  const prevATR   = prev.reduce((a, b) => a + b, 0) / period;
  const atrRatio  = prevATR > 0 ? recentATR / prevATR : 1;

  // Price displacement from 20-bar mean (trend strength proxy)
  const closes20  = bars.slice(Math.max(0, i - 19), i + 1).map(b => b.close);
  const sma20     = closes20.reduce((a, b) => a + b, 0) / closes20.length;
  const trendDisp = Math.abs(bars[i].close - sma20) / (recentATR * 3 + 0.001);

  if (atrRatio > 1.5)                        return 'volatile';
  if (atrRatio < 0.75 && trendDisp < 0.5)   return 'ranging';
  return 'trending';
}

// ── Forward-resolve outcome for a signal bar ──────────────────────────────────
/**
 * Slippage model:
 *   TP is shifted further away by `slippage` (harder to reach — realistic fill).
 *   SL is shifted closer to close by `slippage` (easier to trigger).
 */
function resolveOutcome(bars, sigIdx, direction, tp1, sl, maxBars = 80, slippage = 0) {
  // Shift levels to reflect realistic execution
  const tp1Adj = direction === 'LONG' ? tp1 + slippage : tp1 - slippage;
  const slAdj  = direction === 'LONG' ? sl  - slippage : sl  + slippage;

  for (let j = sigIdx + 1; j < Math.min(sigIdx + maxBars + 1, bars.length); j++) {
    const { open, high, low } = bars[j];
    if (direction === 'LONG') {
      if (open >= tp1Adj) return 'WIN';
      if (open <= slAdj)  return 'LOSS';
      if (high >= tp1Adj) return 'WIN';
      if (low  <= slAdj)  return 'LOSS';
    } else {
      if (open <= tp1Adj) return 'WIN';
      if (open >= slAdj)  return 'LOSS';
      if (low  <= tp1Adj) return 'WIN';
      if (high >= slAdj)  return 'LOSS';
    }
  }
  return 'BE';
}

// ── Performance metrics ───────────────────────────────────────────────────────
function calcMetrics(trades, slPts) {
  const n = trades.length;
  if (n === 0) return { winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, tradeCount: 0 };

  const wins   = trades.filter(t => t === 'WIN').length;
  const losses = trades.filter(t => t === 'LOSS').length;
  const winRate = wins / n;

  const grossWin  = wins   * slPts;
  const grossLoss = losses * slPts;
  const profitFactor = grossLoss === 0
    ? (grossWin > 0 ? 9.99 : 0)
    : grossWin / grossLoss;

  const returns = trades.map(t => t === 'WIN' ? 1 : t === 'LOSS' ? -1 : 0);
  const mean     = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sharpe   = variance === 0 ? 0 : mean / Math.sqrt(variance);

  let peak = 0, equity = 0, maxDd = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    winRate,
    profitFactor: +profitFactor.toFixed(3),
    sharpe:       +sharpe.toFixed(3),
    maxDrawdown:  +maxDd.toFixed(2),
    tradeCount:   n,
  };
}

// ── Enhanced metrics with regime / setup / style breakdowns ──────────────────
/**
 * Full analysis of a signalLog (array of {outcome, regime, setup, tradeStyle, ...}).
 * Returns base metrics + per-dimension breakdowns + streak data + regime consistency.
 */
function calcEnhancedMetrics(signalLog, slPts) {
  const trades = signalLog.map(r => r.outcome);
  const base   = calcMetrics(trades, slPts);

  // ── Per-regime breakdown ──
  const byRegime = {};
  for (const reg of ['trending', 'ranging', 'volatile', 'unknown']) {
    const sub = signalLog.filter(r => r.regime === reg).map(r => r.outcome);
    byRegime[reg] = sub.length > 0 ? calcMetrics(sub, slPts) : null;
  }

  // ── Per-setup breakdown ──
  const setupBuckets = {};
  for (const r of signalLog) {
    const k = r.setup || 'unknown';
    (setupBuckets[k] = setupBuckets[k] || []).push(r.outcome);
  }
  const bySetup = {};
  for (const [k, v] of Object.entries(setupBuckets)) bySetup[k] = calcMetrics(v, slPts);

  // ── Per-style breakdown ──
  const styleBuckets = {};
  for (const r of signalLog) {
    const k = r.tradeStyle || 'unknown';
    (styleBuckets[k] = styleBuckets[k] || []).push(r.outcome);
  }
  const byStyle = {};
  for (const [k, v] of Object.entries(styleBuckets)) byStyle[k] = calcMetrics(v, slPts);

  // ── Streak analysis ──
  let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
  for (const r of signalLog) {
    if (r.outcome === 'WIN')  { curW++; curL = 0; maxWinStreak  = Math.max(maxWinStreak,  curW); }
    else if (r.outcome === 'LOSS') { curL++; curW = 0; maxLossStreak = Math.max(maxLossStreak, curL); }
    else { curW = 0; curL = 0; }
  }

  // ── Cross-regime consistency (lower stdev of win rates = more robust) ──
  const regimeWRs = Object.values(byRegime)
    .filter(m => m && m.tradeCount >= 5)
    .map(m => m.winRate);
  let regimeConsistency = 1.0;
  if (regimeWRs.length > 1) {
    const mean = regimeWRs.reduce((a, b) => a + b, 0) / regimeWRs.length;
    const stdev = Math.sqrt(regimeWRs.reduce((a, b) => a + (b - mean) ** 2, 0) / regimeWRs.length);
    regimeConsistency = Math.max(0, +(1 - stdev * 4).toFixed(3));
  }

  return {
    ...base,
    byRegime,
    bySetup,
    byStyle,
    maxWinStreak,
    maxLossStreak,
    regimeConsistency,
  };
}

// ── Internal backtest (explicit cooldown, no auto-tune recursion) ─────────────
function _runBacktest(bars1m, params, opts = {}) {
  const warmup     = opts.warmup     ?? 60;
  const maxResolve = opts.maxResolve ?? 80;
  const cooldown   = opts.cooldown   ?? 1;
  const slippage   = opts.slippage   ?? 0;
  const slPts      = params.slPts    ?? 25;

  const n      = bars1m.length;
  const all15m = aggregate15m(bars1m);
  const signalLog = [];
  let lastSigIdx = -Infinity;

  for (let i = warmup; i < n - maxResolve; i++) {
    if (i - lastSigIdx < cooldown) continue;

    const htfSlice = all15m.slice(0, Math.floor(i / 15) + 1);
    if (htfSlice.length < 10) continue;

    const signal = computeSignal(bars1m.slice(0, i + 1), htfSlice, params);
    if (!signal) continue;

    const regime  = detectRegime(bars1m, i);
    const outcome = resolveOutcome(bars1m, i, signal.direction, signal.tp1, signal.sl,
                                   maxResolve, slippage);

    signalLog.push({
      bar:       i,
      timestamp: bars1m[i].timestamp,
      ...signal,
      outcome,
      regime,
    });
    lastSigIdx = i;
  }

  const metrics = calcEnhancedMetrics(signalLog, slPts);
  return { trades: signalLog.map(r => r.outcome), metrics, signalLog };
}

// ── Auto-tune cooldown to hit a target trade count ────────────────────────────
/**
 * Binary-search for the cooldown value that produces closest to `targetTrades`.
 * Returns the optimal cooldown integer.
 */
function autoTuneCooldown(bars1m, params, targetTrades = 250, opts = {}) {
  // Quick probe with cooldown=0 to know the upper bound of possible trades
  const probe = _runBacktest(bars1m, params, { ...opts, cooldown: 0 });
  if (probe.metrics.tradeCount <= targetTrades) return 0;

  // Binary search: more cooldown → fewer trades
  let lo = 1, hi = Math.max(1, Math.floor(bars1m.length / targetTrades));
  let best = { cooldown: 1, diff: Infinity };

  for (let iter = 0; iter < 12 && lo <= hi; iter++) {
    const mid = Math.round((lo + hi) / 2);
    const { metrics } = _runBacktest(bars1m, params, { ...opts, cooldown: mid });
    const diff = Math.abs(metrics.tradeCount - targetTrades);
    if (diff < best.diff) { best = { cooldown: mid, diff }; }

    if (metrics.tradeCount > targetTrades) lo = mid + 1;
    else if (metrics.tradeCount < targetTrades) hi = mid - 1;
    else break;
  }

  return best.cooldown;
}

// ── Walk-forward validation ───────────────────────────────────────────────────
/**
 * Split bars into `nWindows` equal segments and test params on each independently.
 * Returns per-window metrics + consistency score across windows.
 * High consistency = strategy is robust across different time periods.
 */
function runWalkForward(bars1m, params, opts = {}) {
  const nWindows  = opts.nWindows  ?? 5;
  const cooldown  = opts.cooldown  ?? 1;
  const slippage  = opts.slippage  ?? 0;
  const minBars   = opts.minBars   ?? 300;

  const windowSize = Math.floor(bars1m.length / nWindows);
  const windows    = [];

  for (let w = 0; w < nWindows; w++) {
    const start = w * windowSize;
    // Overlap slightly for regime continuity — each window has extra tail for resolve
    const end   = Math.min(start + windowSize + 100, bars1m.length);
    const slice = bars1m.slice(start, end);
    if (slice.length < minBars) continue;

    const { metrics } = _runBacktest(slice, params, { cooldown, slippage });
    windows.push({
      window: w + 1,
      from:   slice[0]?.timestamp,
      to:     slice[slice.length - 1]?.timestamp,
      ...metrics,
    });
  }

  if (windows.length === 0) return { windows: [], consistency: 0, avgWinRate: 0, avgSharpe: 0 };

  const viable  = windows.filter(w => w.tradeCount >= 5);
  if (viable.length === 0) return { windows, consistency: 0, avgWinRate: 0, avgSharpe: 0 };

  const winRates  = viable.map(w => w.winRate);
  const sharpes   = viable.map(w => w.sharpe);
  const avgWR     = winRates.reduce((a, b) => a + b, 0) / viable.length;
  const avgSharpe = sharpes.reduce((a, b) => a + b, 0)  / viable.length;

  const variance  = winRates.reduce((a, b) => a + (b - avgWR) ** 2, 0) / viable.length;
  const stdev     = Math.sqrt(variance);
  const consistency = Math.max(0, +(1 - stdev * 5).toFixed(3));

  return {
    windows,
    consistency,
    avgWinRate: +avgWR.toFixed(3),
    avgSharpe:  +avgSharpe.toFixed(3),
  };
}

// ── Public backtest entry point ───────────────────────────────────────────────
/**
 * Run a backtest over historical 1m bars.
 * @param {Array}  bars1m  - 1m OHLCV bars, oldest first
 * @param {Object} params  - strategy parameters
 * @param {Object} opts
 *   @param {number}  warmup        - warm-up bars (default 60)
 *   @param {number}  maxResolve    - bars to look forward for outcome (default 80)
 *   @param {number}  cooldown      - minimum bars between signals (default 1)
 *   @param {number}  targetTrades  - if set, auto-tune cooldown to reach this count
 *   @param {number}  slippage      - execution slippage in price points (default 0.5)
 *   @param {boolean} walkForward   - also run walk-forward validation (default false)
 *   @param {number}  nWindows      - walk-forward windows (default 5)
 * @returns {{ trades, metrics, signalLog, cooldownUsed, walkForward? }}
 */
function runBacktest(bars1m, params, opts = {}) {
  const slippage = opts.slippage ?? 0.5;    // realistic MNQ/NQ execution cost
  const innerOpts = {
    warmup:     opts.warmup     ?? 60,
    maxResolve: opts.maxResolve ?? 80,
    slippage,
  };

  // Resolve cooldown
  let cooldown = opts.cooldown ?? 1;
  if (opts.targetTrades !== undefined && opts.cooldown === undefined) {
    cooldown = autoTuneCooldown(bars1m, params, opts.targetTrades, innerOpts);
  }

  let result = _runBacktest(bars1m, params, { ...innerOpts, cooldown });
  result.cooldownUsed = cooldown;
  result.slippageUsed = slippage;

  // If minSignals quota not met, progressively relax minScore and retry
  if (opts.minSignals && result.metrics.tradeCount < opts.minSignals) {
    for (const scoreFloor of [10, 8, 6]) {
      if (result.metrics.tradeCount >= opts.minSignals) break;
      const relaxedParams = { ...params, minScore: Math.min(params.minScore ?? 12, scoreFloor), relaxed: true };
      const cd = autoTuneCooldown(bars1m, relaxedParams, opts.targetTrades ?? opts.minSignals, innerOpts);
      const retry = _runBacktest(bars1m, relaxedParams, { ...innerOpts, cooldown: cd });
      if (retry.metrics.tradeCount > result.metrics.tradeCount) {
        result = retry;
        result.cooldownUsed = cd;
        result.slippageUsed = slippage;
        result.quotaRelaxed = true;
      }
    }
  }

  if (opts.walkForward) {
    result.walkForward = runWalkForward(bars1m, params, {
      nWindows:  opts.nWindows ?? 5,
      cooldown:  result.cooldownUsed,
      slippage,
      minBars:   opts.minBars ?? 300,
    });
  }

  return result;
}

module.exports = {
  runBacktest,
  runWalkForward,
  aggregate15m,
  resolveOutcome,
  detectRegime,
  calcMetrics,
  calcEnhancedMetrics,
  autoTuneCooldown,
};
