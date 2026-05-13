'use strict';

/**
 * BACKTEST ENGINE — uses the exact same strategy functions as the live scanner.
 *
 * No separate logic exists here. All signal detection is delegated to strategy-engine.js,
 * which in turn calls the four individual strategy modules.
 *
 * This file only handles:
 *   • Iterating through historical bars in chronological order
 *   • Building per-bar slices of multi-TF arrays without lookahead
 *   • Resolving each signal's outcome (WIN / LOSS / BE) from future bars
 *   • Computing performance metrics and breakdowns
 *   • Walk-forward validation
 */

const {
  evaluateAll,
  resetAllStrategies,
  buildBarSetsFrom1m,
} = require('./strategy-engine');

const {
  aggregate1mTo5m, aggregate5mTo15m, aggregate5mTo30m, aggregate5mTo45m,
  aggregate5mTo1h, aggregate1hTo4h, aggregate1hToDaily,
} = require('./strategies/shared-indicators');

// ── Market regime detection ───────────────────────────────────────────────────

/**
 * Multi-factor regime classifier.
 *
 * Factors:
 *   1. ATR expansion ratio (recent vs previous window) — volatility state
 *   2. Directional efficiency (net displacement / gross path) — trend strength
 *   3. Higher-high / lower-low count — structural confirmation
 *
 * Regimes:
 *   volatile  — ATR expansion ≥ 1.5×  (news, event, spike)
 *   trending  — strong directional efficiency + structural HH/LL sequence
 *   ranging   — low volatility, low directional efficiency
 *   choppy    — moderate volatility, no clear direction
 */
function detectRegime(bars, i, period = 14) {
  if (i < period * 2) return 'unknown';

  const slice = bars.slice(Math.max(0, i - period * 2), i + 1);
  const tr = slice.map((b, j) =>
    j === 0 ? b.high - b.low :
    Math.max(b.high - b.low,
             Math.abs(b.high - slice[j - 1].close),
             Math.abs(b.low  - slice[j - 1].close))
  );
  const recent = tr.slice(-period);
  const prev   = tr.slice(-period * 2, -period);
  if (recent.length < period || prev.length < period) return 'unknown';

  const recentATR = recent.reduce((a, b) => a + b, 0) / period;
  const prevATR   = prev.reduce((a, b) => a + b, 0)   / period;
  const atrRatio  = prevATR > 0 ? recentATR / prevATR : 1;

  // Directional efficiency: |net move| / sum(|bar moves|)
  const recentBars = bars.slice(Math.max(0, i - period + 1), i + 1);
  const netMove    = Math.abs(recentBars[recentBars.length - 1].close - recentBars[0].close);
  const grossMove  = recentBars.reduce((s, b, j) =>
    j === 0 ? s : s + Math.abs(b.close - recentBars[j - 1].close), 0);
  const dirEfficiency = grossMove > 0 ? netMove / grossMove : 0;

  // Higher-highs / lower-lows count over recent window
  let hhCount = 0, llCount = 0;
  for (let k = 1; k < recentBars.length; k++) {
    if (recentBars[k].high  > recentBars[k - 1].high)  hhCount++;
    if (recentBars[k].low   < recentBars[k - 1].low)   llCount++;
  }
  const structuralTrend = (hhCount > period * 0.6) || (llCount > period * 0.6);

  if (atrRatio > 1.5) return 'volatile';
  if (dirEfficiency > 0.45 && structuralTrend) return 'trending';
  if (atrRatio < 0.75 && dirEfficiency < 0.30) return 'ranging';
  return 'choppy';
}

// ── Outcome resolution ────────────────────────────────────────────────────────

/**
 * Resolve a signal to WIN / LOSS / BE by scanning future 5m bars.
 * Slippage shifts TP further away and SL closer (realistic execution).
 */
function resolveOutcome(bars5m, sigIdx, direction, tp1, sl, maxBars = 60, slippage = 0) {
  const tp1Adj = direction === 'LONG' ? tp1 + slippage : tp1 - slippage;
  const slAdj  = direction === 'LONG' ? sl  - slippage : sl  + slippage;

  for (let j = sigIdx + 1; j < Math.min(sigIdx + maxBars + 1, bars5m.length); j++) {
    const { open, high, low } = bars5m[j];
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

// ── Base metrics ──────────────────────────────────────────────────────────────

function calcMetrics(signalLog) {
  const n = signalLog.length;
  if (n === 0) return {
    winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0,
    tradeCount: 0, avgWin: 0, avgLoss: 0, largestWin: 0, largestLoss: 0,
  };

  const wins   = signalLog.filter(t => t.outcome === 'WIN');
  const losses = signalLog.filter(t => t.outcome === 'LOSS');

  const winRate  = wins.length / n;

  // Use actual R-multiples based on rr field; default to 1.5R / 1.0R
  const grossWin  = wins.reduce((s, t) => s + (t.pnlPts ?? (t.rr ?? 1.5)), 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPts ?? 1), 0);

  const profitFactor = grossLoss === 0
    ? (grossWin > 0 ? 9.99 : 0)
    : +(grossWin / grossLoss).toFixed(3);

  const returns = signalLog.map(t => t.pnlR ?? (t.outcome === 'WIN' ? (t.rr ?? 1.5) : t.outcome === 'LOSS' ? -1 : 0));
  const mean     = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sharpe   = variance === 0 ? 0 : +(mean / Math.sqrt(variance)).toFixed(3);

  // Max drawdown in R-multiples
  let peak = 0, equity = 0, maxDd = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const avgWin  = wins.length   > 0 ? +(grossWin / wins.length).toFixed(2)   : 0;
  const avgLoss = losses.length > 0 ? +(grossLoss / losses.length).toFixed(2) : 0;
  const largestWin  = wins.length   > 0 ? +Math.max(...wins.map(t => t.pnlPts ?? (t.rr ?? 1.5))).toFixed(2)   : 0;
  const largestLoss = losses.length > 0 ? +Math.max(...losses.map(t => Math.abs(t.pnlPts ?? 1))).toFixed(2) : 0;

  // Total return in price points
  const totalReturn = +(signalLog.reduce((sum, t) => sum + (t.pnlPts ?? 0), 0)).toFixed(2);

  // Average R:R across winning trades
  const avgRR = wins.length > 0
    ? +(wins.reduce((s, t) => s + (t.rr ?? 1.5), 0) / wins.length).toFixed(2)
    : 0;

  return {
    winRate:       +winRate.toFixed(4),
    profitFactor,
    sharpe,
    maxDrawdown:   +maxDd.toFixed(2),
    totalReturn,
    avgRR,
    tradeCount:    n,
    avgWin, avgLoss, largestWin, largestLoss,
  };
}

// ── Enhanced metrics with per-strategy / direction / session / regime ─────────

function calcEnhancedMetrics(signalLog) {
  const base = calcMetrics(signalLog);

  const groupBy = (key) => {
    const buckets = {};
    for (const r of signalLog) {
      const k = r[key] ?? 'unknown';
      (buckets[k] = buckets[k] || []).push(r);
    }
    const result = {};
    for (const [k, v] of Object.entries(buckets)) result[k] = calcMetrics(v);
    return result;
  };

  const byStrategy  = groupBy('strategy_name');
  const byDirection = groupBy('direction');
  const byRegime    = groupBy('regime');
  const bySession   = groupBy('session');
  const byStyle     = groupBy('trade_style');

  // Best / worst session
  let bestSession = null, worstSession = null;
  let bestWR = -1, worstWR = 2;
  for (const [sess, m] of Object.entries(bySession)) {
    if (m.tradeCount >= 5) {
      if (m.winRate > bestWR)  { bestWR = m.winRate;  bestSession  = sess; }
      if (m.winRate < worstWR) { worstWR = m.winRate; worstSession = sess; }
    }
  }

  // Streak analysis
  let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
  let avgDurationBars = 0;
  for (const r of signalLog) {
    if (r.outcome === 'WIN')  { curW++; curL = 0; maxWinStreak  = Math.max(maxWinStreak,  curW); }
    else if (r.outcome === 'LOSS') { curL++; curW = 0; maxLossStreak = Math.max(maxLossStreak, curL); }
    else { curW = 0; curL = 0; }
    avgDurationBars += r.durationBars ?? 0;
  }
  if (signalLog.length > 0) avgDurationBars = +(avgDurationBars / signalLog.length).toFixed(1);

  // Cross-regime consistency
  const regimeWRs = Object.values(byRegime).filter(m => m.tradeCount >= 5).map(m => m.winRate);
  let regimeConsistency = 1.0;
  if (regimeWRs.length > 1) {
    const mean  = regimeWRs.reduce((a, b) => a + b, 0) / regimeWRs.length;
    const stdev = Math.sqrt(regimeWRs.reduce((a, b) => a + (b - mean) ** 2, 0) / regimeWRs.length);
    regimeConsistency = Math.max(0, +(1 - stdev * 4).toFixed(3));
  }

  // Long vs short win rates (convenience getters)
  const longWinRate  = byDirection['LONG']?.winRate  ?? null;
  const shortWinRate = byDirection['SHORT']?.winRate ?? null;
  const longCount    = byDirection['LONG']?.tradeCount  ?? 0;
  const shortCount   = byDirection['SHORT']?.tradeCount ?? 0;

  // Per-session compact summary (name → {winRate, tradeCount, totalReturn})
  const sessionSummary = {};
  for (const [sess, m] of Object.entries(bySession)) {
    sessionSummary[sess] = {
      winRate:     m.winRate,
      tradeCount:  m.tradeCount,
      totalReturn: m.totalReturn ?? 0,
      profitFactor: m.profitFactor,
    };
  }

  return {
    ...base,
    byStrategy, byDirection, byRegime, bySession, byStyle,
    maxWinStreak, maxLossStreak,
    avgDurationBars,
    bestSession, worstSession,
    regimeConsistency,
    // Derived convenience fields
    longWinRate, shortWinRate, longCount, shortCount,
    sessionSummary,
  };
}

// ── Internal backtest core ────────────────────────────────────────────────────

function _runBacktest(bars1m, instrument, opts = {}) {
  const warmup5m   = opts.warmup5m   ?? 80;
  const maxResolve = opts.maxResolve ?? 60;  // 5m bars to look forward (60 × 5m = 5h)
  const slippage   = opts.slippage   ?? 0;
  // Default cooldown matches live scanner default of 10 min (2 × 5m bars).
  // Previously 1, which inflated backtest signal count vs live by up to 2×.
  const cooldown5m = opts.cooldown5m ?? 2;

  // ── Pre-aggregate all timeframes once ───────────────────────────────────────
  const bars5m  = aggregate1mTo5m(bars1m);
  const bars15m = aggregate5mTo15m(bars5m);
  const bars30m = aggregate5mTo30m(bars5m);  // MGC confluence layer
  const bars45m = aggregate5mTo45m(bars5m);  // MGC confluence layer
  const bars1h  = aggregate5mTo1h(bars5m);
  const bars4h  = aggregate1hTo4h(bars1h);
  const barsDly = aggregate1hToDaily(bars1h);

  const n5m = bars5m.length;
  const signalLog = [];

  // Track last signal bar index per strategy to enforce per-strategy cooldowns
  const lastSigByStrategy = {};

  resetAllStrategies();

  for (let i = warmup5m; i < n5m - maxResolve; i++) {
    // Build slices of each TF array up to the current confirmed bar
    const slc5m = bars5m.slice(0, i + 1);
    const j15   = Math.floor((i + 1) / 3);
    const j30   = Math.floor((i + 1) / 6);
    const j45   = Math.floor((i + 1) / 9);
    const j1h   = Math.floor((i + 1) / 12);
    const j4h   = Math.floor((i + 1) / 48);
    const jDly  = Math.floor((i + 1) / 78);

    const slc15m = bars15m.slice(0, Math.max(1, j15));
    const slc30m = bars30m.slice(0, Math.max(1, j30));
    const slc45m = bars45m.slice(0, Math.max(1, j45));
    const slc1h  = bars1h.slice(0,  Math.max(1, j1h));
    const slc4h  = bars4h.slice(0,  Math.max(1, j4h));
    const slcDly = barsDly.slice(0, Math.max(1, Math.min(jDly, barsDly.length)));

    const barSets = instrument === 'MGC'
      ? { bars5mMgc: slc5m, bars15mMgc: slc15m, bars30mMgc: slc30m, bars45mMgc: slc45m, bars1hMgc: slc1h }
      : { bars5m: slc5m, bars15m: slc15m, bars1h: slc1h, bars4h: slc4h, barsDly: slcDly };

    const signals = evaluateAll(barSets, { instrument, barIdx: i });

    for (const sig of signals) {
      const strat = sig.strategy_name;

      // Enforce per-strategy cooldown
      const lastIdx = lastSigByStrategy[strat] ?? -Infinity;
      const stratCooldown = strat === 'MNQ_SWING' ? cooldown5m * 12 : cooldown5m;
      if (i - lastIdx < stratCooldown) continue;

      // Resolve outcome from future 5m bars
      let resolvedBars, resolvedIdx;
      if (strat === 'MNQ_SWING') {
        // Swing resolves on 1h bars
        resolvedBars = bars1h;
        resolvedIdx  = j1h;
      } else {
        resolvedBars = bars5m;
        resolvedIdx  = i;
      }

      const outcome = resolveOutcome(
        resolvedBars, resolvedIdx, sig.direction, sig.tp1, sig.sl,
        strat === 'MNQ_SWING' ? 24 : maxResolve, slippage
      );

      // Compute P&L in points
      const risk    = sig.direction === 'LONG' ? sig.entry - sig.sl : sig.sl - sig.entry;
      const reward  = sig.direction === 'LONG' ? sig.tp1 - sig.entry : sig.entry - sig.tp1;
      const pnlPts  = outcome === 'WIN' ? +reward.toFixed(2) : outcome === 'LOSS' ? +(-risk).toFixed(2) : 0;
      const pnlR    = outcome === 'WIN' ? sig.rr ?? 1.5 : outcome === 'LOSS' ? -1 : 0;

      // Actual bars to resolution (scanned in resolveOutcome above)
      const durationBars = (() => {
        const startIdx = strat === 'MNQ_SWING' ? j1h : i;
        const fwdBars  = strat === 'MNQ_SWING' ? bars1h : bars5m;
        const cap      = strat === 'MNQ_SWING' ? 24 : maxResolve;
        const tp1adj = sig.direction === 'LONG' ? sig.tp1 + slippage : sig.tp1 - slippage;
        const slAdj  = sig.direction === 'LONG' ? sig.sl  - slippage : sig.sl  + slippage;
        for (let d = 1; d <= cap; d++) {
          const b = fwdBars[startIdx + d];
          if (!b) break;
          if (sig.direction === 'LONG') {
            if (b.open >= tp1adj || b.high >= tp1adj || b.open <= slAdj || b.low <= slAdj) return d;
          } else {
            if (b.open <= tp1adj || b.low  <= tp1adj || b.open >= slAdj || b.high >= slAdj) return d;
          }
        }
        return cap;
      })();

      const regime  = detectRegime(bars5m, i);

      // ET hour for DNA timing analysis
      const tsBar   = bars5m[i].timestamp;
      let hourEt    = null;
      try {
        const etParts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', hour: '2-digit', hour12: false,
        }).formatToParts(new Date(tsBar));
        hourEt = parseInt(etParts.find(p => p.type === 'hour').value);
      } catch {}

      signalLog.push({
        bar:       i,
        timestamp: tsBar,
        strategy_name: strat,
        direction: sig.direction,
        entry:     sig.entry,
        sl:        sig.sl,
        tp1:       sig.tp1,
        rr:        sig.rr,
        confidence: sig.confidence,
        outcome,
        pnlPts,
        pnlR,
        regime,
        session:     sig.session,
        trade_style: sig.trade_style,
        htf_bias:    sig.htf_bias,
        hour_et:     hourEt,
        durationBars,
        // Legacy compat
        setup:      sig.setup,
        tradeStyle: sig.trade_style,
        score:      sig.score,
      });

      lastSigByStrategy[strat] = i;
    }
  }

  const metrics = calcEnhancedMetrics(signalLog);
  return { trades: signalLog.map(r => r.outcome), metrics, signalLog };
}

// ── Walk-forward validation ───────────────────────────────────────────────────

function runWalkForward(bars1m, instrument, opts = {}) {
  const nWindows = opts.nWindows ?? 5;
  const slippage = opts.slippage ?? 0;
  const minBars  = opts.minBars  ?? 1500; // min 1m bars per window

  const windowSize = Math.floor(bars1m.length / nWindows);
  const windows    = [];

  for (let w = 0; w < nWindows; w++) {
    const start = w * windowSize;
    const end   = Math.min(start + windowSize + 300, bars1m.length);
    const slice = bars1m.slice(start, end);
    if (slice.length < minBars) continue;

    const { metrics } = _runBacktest(slice, instrument, { slippage });
    windows.push({
      window: w + 1,
      from:   slice[0]?.timestamp,
      to:     slice[slice.length - 1]?.timestamp,
      ...metrics,
    });
  }

  if (!windows.length) return { windows: [], consistency: 0, avgWinRate: 0, avgSharpe: 0 };

  const viable   = windows.filter(w => w.tradeCount >= 5);
  if (!viable.length) return { windows, consistency: 0, avgWinRate: 0, avgSharpe: 0 };

  const winRates  = viable.map(w => w.winRate);
  const sharpes   = viable.map(w => w.sharpe);
  const avgWR     = winRates.reduce((a, b) => a + b, 0) / viable.length;
  const avgSharpe = sharpes.reduce((a, b) => a + b, 0)  / viable.length;
  const variance  = winRates.reduce((a, b) => a + (avgWR - b) ** 2, 0) / viable.length;
  const stdev     = Math.sqrt(variance);
  const consistency = Math.max(0, +(1 - stdev * 5).toFixed(3));

  return {
    windows,
    consistency,
    avgWinRate: +avgWR.toFixed(3),
    avgSharpe:  +avgSharpe.toFixed(3),
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run a full backtest over historical 1m bars.
 *
 * @param {object[]} bars1m      - 1m OHLCV bars, oldest first
 * @param {object}   params      - legacy params (slippage, targetTrades)
 * @param {object}   opts
 * @param {string}   [opts.instrument] - 'MNQ' | 'MGC' | null (all)
 * @param {number}   [opts.slippage]   - execution slippage in price points (default 0.5)
 * @param {boolean}  [opts.walkForward] - run walk-forward validation
 * @param {number}   [opts.nWindows]   - walk-forward windows (default 5)
 * @returns {{ trades, metrics, signalLog, walkForward? }}
 */
function runBacktest(bars1m, params = {}, opts = {}) {
  const slippage   = opts.slippage ?? params.slippage ?? 0.5;
  const instrument = opts.instrument ?? params.instrument ?? null;

  const result = _runBacktest(bars1m, instrument, {
    slippage,
    warmup5m:   opts.warmup5m   ?? 80,
    maxResolve: opts.maxResolve ?? 60,
    cooldown5m: opts.cooldown5m ?? 1,
  });

  result.slippageUsed = slippage;
  result.cooldownUsed = opts.cooldown5m ?? 2;
  // Audit fields: surfaced in reports to explain live/backtest divergence
  result.divergenceAudit = {
    cooldown5mUsed: result.cooldownUsed,
    slippageUsed:   slippage,
    warmup5mUsed:   opts.warmup5m ?? 80,
    maxResolve:     opts.maxResolve ?? 60,
    note: result.cooldownUsed < 2
      ? 'WARNING: cooldown < 2 bars — backtest may produce more signals than live (live default = 2 bars / 10 min)'
      : 'Cooldown matches live default (2 bars = 10 min)',
  };

  if (opts.walkForward) {
    result.walkForward = runWalkForward(bars1m, instrument, {
      nWindows: opts.nWindows ?? 5,
      slippage,
      minBars:  opts.minBars ?? 1500,
    });
  }

  return result;
}

module.exports = {
  runBacktest,
  runWalkForward,
  resolveOutcome,
  detectRegime,
  calcMetrics,
  calcEnhancedMetrics,
};
