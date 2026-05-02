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

// ── Forward-resolve outcome for a signal bar ──────────────────────────────────
function resolveOutcome(bars, sigIdx, direction, tp1, sl, maxBars = 50) {
  for (let j = sigIdx + 1; j < Math.min(sigIdx + maxBars + 1, bars.length); j++) {
    const { open, high, low } = bars[j];
    if (direction === 'LONG') {
      // Gap-open above TP1 = WIN
      if (open >= tp1) return 'WIN';
      // Gap-open below SL = LOSS
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

// ── Performance metrics ───────────────────────────────────────────────────────
function calcMetrics(trades, slPts) {
  const n = trades.length;
  if (n === 0) return { winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, tradeCount: 0 };

  const wins   = trades.filter(t => t === 'WIN').length;
  const losses = trades.filter(t => t === 'LOSS').length;
  const winRate = wins / n;

  const grossWin  = wins   * slPts;      // TP1 = 1R
  const grossLoss = losses * slPts;
  const profitFactor = grossLoss === 0 ? grossWin > 0 ? 9.99 : 0
                                       : grossWin / grossLoss;

  // Sharpe: mean R / stdev R  (per-trade R-multiples)
  const returns = trades.map(t => t === 'WIN' ? 1 : t === 'LOSS' ? -1 : 0);
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sharpe = variance === 0 ? 0 : mean / Math.sqrt(variance);

  // Max drawdown (running equity in R)
  let peak = 0, equity = 0, maxDd = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return { winRate, profitFactor: +profitFactor.toFixed(3), sharpe: +sharpe.toFixed(3),
           maxDrawdown: +maxDd.toFixed(2), tradeCount: n };
}

// ── Main backtest function ────────────────────────────────────────────────────
/**
 * Run a backtest over historical 1m bars.
 * @param {Array}  bars1m   - 1m OHLCV bars, oldest first
 * @param {Object} params   - strategy parameters (same shape as computeSignal config)
 * @param {Object} opts
 *   @param {number}  opts.warmup    - bars needed before scanning starts (default 60)
 *   @param {number}  opts.maxResolve - bars to look forward for outcome (default 50)
 *   @param {number}  opts.cooldown  - bars between signals during backtest (default 1)
 * @returns {{ trades, metrics, signalLog }}
 */
function runBacktest(bars1m, params, opts = {}) {
  const warmup     = opts.warmup     ?? 60;
  const maxResolve = opts.maxResolve ?? 50;
  const cooldown   = opts.cooldown   ?? 1;   // short cooldown accelerates learning

  const n       = bars1m.length;
  const all15m  = aggregate15m(bars1m);
  const trades  = [];
  const signalLog = [];
  let lastSigIdx = -Infinity;

  for (let i = warmup; i < n - maxResolve; i++) {
    if (i - lastSigIdx < cooldown) continue;

    // Slice of 15m bars available at this 1m bar
    const htfSlice = all15m.slice(0, Math.floor(i / 15) + 1);
    if (htfSlice.length < 10) continue;

    const signal = computeSignal(bars1m.slice(0, i + 1), htfSlice, params);
    if (!signal) continue;

    const outcome = resolveOutcome(bars1m, i, signal.direction, signal.tp1, signal.sl, maxResolve);
    trades.push(outcome);
    signalLog.push({ bar: i, timestamp: bars1m[i].timestamp, ...signal, outcome });
    lastSigIdx = i;
  }

  const metrics = calcMetrics(trades, params.slPts ?? 25);
  return { trades, metrics, signalLog };
}

module.exports = { runBacktest, aggregate15m, resolveOutcome, calcMetrics };
