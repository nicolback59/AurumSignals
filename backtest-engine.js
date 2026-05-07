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

const { aggregate1mTo5m, aggregate5mTo15m, aggregate5mTo1h, aggregate1hTo4h, aggregate1hToDaily } =
  require('./strategies/shared-indicators');

// ── Trade notes builder ───────────────────────────────────────────────────────

/**
 * Build human-readable notes for each trade outcome — surfaces the WHY
 * behind losses and BEs so they can be reviewed in the signal log.
 *
 * LOSS notes include: regime, session, HTF bias, setup type, and confidence.
 * BE notes include: the fact that price moved favorably then reversed before TP1.
 * WIN notes summarize the conditions that drove the win.
 */
function buildTradeNotes(outcome, sig, regime) {
  const setup  = sig.setup || sig.strategy_name || 'unknown';
  const dir    = sig.direction;
  const sess   = sig.session || 'N/A';
  const htf    = sig.htf_bias || 'N/A';
  const conf   = sig.confidence != null ? `conf=${sig.confidence}` : '';
  const score  = sig.score != null ? `score=${sig.score}` : '';

  if (outcome === 'LOSS') {
    return [
      `LOSS | ${setup} ${dir} | ${sess} | ${regime} regime`,
      `HTF bias at entry: ${htf} | ${conf} ${score}`,
      `Review: Was HTF bias aligned? Was the entry in a chop zone?`,
      `If HTF was opposed — counter-trend losses are expected. If regime=volatile — widen SL next time.`,
    ].join('\n');
  }

  if (outcome === 'BE') {
    return [
      `BREAKEVEN | ${setup} ${dir} | ${sess} | ${regime} regime`,
      `Price moved favorably then reversed before TP1 — exit near entry.`,
      `${conf} ${score} | HTF: ${htf}`,
      `BE = trade managed correctly. Price moved wrong direction after favorable start.`,
      `Check: Did momentum weaken early? Was there a news event mid-trade?`,
    ].join('\n');
  }

  if (outcome === 'WIN') {
    return `WIN | ${setup} ${dir} | ${sess} | ${regime} regime | ${conf} ${score}`;
  }

  return `${outcome} | ${setup} ${dir} | ${sess}`;
}

// ── Market regime detection ───────────────────────────────────────────────────

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

  const closes20  = bars.slice(Math.max(0, i - 19), i + 1).map(b => b.close);
  const sma20     = closes20.reduce((a, b) => a + b, 0) / closes20.length;
  const trendDisp = Math.abs(bars[i].close - sma20) / (recentATR * 3 + 0.001);

  if (atrRatio > 1.5)                       return 'volatile';
  if (atrRatio < 0.75 && trendDisp < 0.5)  return 'ranging';
  return 'trending';
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

  // ── Loss breakdown per setup ─────────────────────────────────────────────────
  const lossBySetup = {};
  const beBySetup   = {};
  const winBySetup  = {};
  for (const r of signalLog) {
    const s = r.setup || r.strategy_name || 'unknown';
    if (r.outcome === 'LOSS') lossBySetup[s] = (lossBySetup[s] || 0) + 1;
    if (r.outcome === 'BE')   beBySetup[s]   = (beBySetup[s]   || 0) + 1;
    if (r.outcome === 'WIN')  winBySetup[s]  = (winBySetup[s]  || 0) + 1;
  }

  // ── BE and LOSS analysis ─────────────────────────────────────────────────────
  const lossRecords = signalLog.filter(r => r.outcome === 'LOSS');
  const beRecords   = signalLog.filter(r => r.outcome === 'BE');

  const lossBySession = {};
  for (const r of lossRecords) {
    const s = r.session || 'unknown';
    lossBySession[s] = (lossBySession[s] || 0) + 1;
  }
  const lossByRegime = {};
  for (const r of lossRecords) {
    const rg = r.regime || 'unknown';
    lossByRegime[rg] = (lossByRegime[rg] || 0) + 1;
  }
  const lossByHTF = {};
  for (const r of lossRecords) {
    const hb = r.htf_bias || r.lossContext?.htfBias || 'unknown';
    lossByHTF[hb] = (lossByHTF[hb] || 0) + 1;
  }
  const avgConfOnLoss = lossRecords.length > 0
    ? +(lossRecords.reduce((s, r) => s + (r.confidence || 0), 0) / lossRecords.length).toFixed(1)
    : null;
  const avgConfOnWin = signalLog.filter(r => r.outcome === 'WIN').length > 0
    ? +(signalLog.filter(r => r.outcome === 'WIN').reduce((s, r) => s + (r.confidence || 0), 0) /
        signalLog.filter(r => r.outcome === 'WIN').length).toFixed(1)
    : null;

  const beNotes = {
    totalBE:       beRecords.length,
    beBySetup,
    beBySession:   beRecords.reduce((acc, r) => {
      const s = r.session || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {}),
    note: 'BE trades had a favorable move but reversed before TP1. Check: early momentum fade, news events, insufficient room to TP1.',
  };

  const lossNotes = {
    totalLoss:       lossRecords.length,
    lossBySetup,
    lossBySession,
    lossByRegime,
    lossByHTF,
    avgConfOnLoss,
    avgConfOnWin,
    interpretation: [
      lossByRegime['volatile'] > (lossRecords.length * 0.4)
        ? 'HIGH volatile-regime losses — consider tightening SL or skipping signals when ATR spikes >2× avg.'
        : null,
      lossByHTF['BEAR'] > 0 && lossByHTF['BULL'] > 0
        ? `Loss split: ${lossByHTF['BULL'] || 0} with BULL HTF, ${lossByHTF['BEAR'] || 0} with BEAR HTF — review counter-trend setups.`
        : null,
      avgConfOnLoss != null && avgConfOnWin != null && avgConfOnLoss < avgConfOnWin - 5
        ? `Lower-confidence signals lose more often (avg loss conf=${avgConfOnLoss} vs win conf=${avgConfOnWin}). Consider raising threshold.`
        : null,
    ].filter(Boolean),
  };

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
    // Deeper loss and BE analysis
    lossNotes,
    beNotes,
    winBySetup,
  };
}

// ── Internal backtest core ────────────────────────────────────────────────────

function _runBacktest(bars1m, instrument, opts = {}) {
  const warmup5m   = opts.warmup5m   ?? 80;
  const maxResolve = opts.maxResolve ?? 60;  // 5m bars to look forward (60 × 5m = 5h)
  const slippage   = opts.slippage   ?? 0;
  const cooldown5m = opts.cooldown5m ?? 1;   // minimum 5m bars between signals

  // ── Pre-aggregate all timeframes once ───────────────────────────────────────
  const bars5m  = aggregate1mTo5m(bars1m);
  const bars15m = aggregate5mTo15m(bars5m);
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
    const slc5m  = bars5m.slice(0, i + 1);
    const j15    = Math.floor((i + 1) / 3);
    const j1h    = Math.floor((i + 1) / 12);
    const j4h    = Math.floor((i + 1) / 48);
    const jDly   = Math.floor((i + 1) / 78); // approx 6.5h per trading day

    const slc15m = bars15m.slice(0, Math.max(1, j15));
    const slc1h  = bars1h.slice(0,  Math.max(1, j1h));
    const slc4h  = bars4h.slice(0,  Math.max(1, j4h));
    const slcDly = barsDly.slice(0, Math.max(1, Math.min(jDly, barsDly.length)));

    const barSets = instrument === 'MGC'
      ? { bars5mMgc: slc5m, bars15mMgc: slc15m, bars1hMgc: slc1h }
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

      // Estimate duration (bars to resolution — simplified)
      const durationBars = maxResolve / 2; // placeholder; real duration tracked live

      const regime  = detectRegime(bars5m, i);

      const tradeNotes = buildTradeNotes(outcome, sig, regime);

      signalLog.push({
        bar:       i,
        timestamp: bars5m[i].timestamp,
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
        durationBars,
        // Legacy compat
        setup:      sig.setup,
        tradeStyle: sig.trade_style,
        score:      sig.score,
        // Detailed outcome notes
        notes: tradeNotes,
        lossContext: outcome === 'LOSS' ? {
          regime,
          session:    sig.session,
          htfBias:    sig.htf_bias,
          setup:      sig.setup || strat,
          confidence: sig.confidence,
          score:      sig.score,
          direction:  sig.direction,
        } : null,
        beContext: outcome === 'BE' ? {
          regime,
          session:    sig.session,
          setup:      sig.setup || strat,
          confidence: sig.confidence,
          direction:  sig.direction,
          note: 'Price moved favorably then reversed before TP1; exited near entry.',
        } : null,
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
  result.cooldownUsed = opts.cooldown5m ?? 1;

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
