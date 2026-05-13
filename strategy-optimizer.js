'use strict';

/**
 * strategy-optimizer.js
 *
 * Orchestrates the full backtesting + optimization pipeline:
 *   1. Fetch bars and run baseline backtest (targeting 250 trades via auto-tune)
 *   2. Generate 50 candidates (perturbation + crossover + random restart)
 *   3. Run walk-forward validation on the best candidates
 *   4. Select winner by multi-objective score (win rate + Sharpe + regime consistency)
 *   5. Persist results; promote if improvement passes safeguards
 *
 * Called by scanner.js on each backtest cycle.
 */

const { runBacktest, runWalkForward, calcEnhancedMetrics } = require('./backtest-engine');
const {
  getParams, saveParams,
  getStyleParams, saveStyleParams,
  saveBacktestRun, saveBacktestDetails, saveRevision,
  generateCandidates, crossoverParams,
  multiObjectiveScore, validateImprovement,
  DEFAULT_PARAMS_BY_STYLE, SAFEGUARDS,
} = require('./strategy-params');
const { loadDNA, getDNAGuidance } = require('./strategy-dna');

// ── Optimization options ──────────────────────────────────────────────────────
const DEFAULT_OPT_OPTS = {
  targetTrades:     250,    // per-cycle trade count goal for statistical significance
  slippage:         0.5,    // realistic per-side execution cost in points
  walkForwardWins:  5,      // walk-forward windows
  minBarsPerWindow: 400,    // minimum bars for a valid walk-forward window
  styles:           null,   // null = all styles, or ['scalp','intraday','swing']
};

// ── Baseline + enhanced metrics for a single run ─────────────────────────────
function runBaselineBacktest(bars1m, params, opts) {
  return runBacktest(bars1m, params, {
    targetTrades: opts.targetTrades,
    slippage:     opts.slippage,
    walkForward:  true,
    nWindows:     opts.walkForwardWins,
    minBars:      opts.minBarsPerWindow,
  });
}

// ── DNA-guided candidate augmentation ────────────────────────────────────────
/**
 * Blend standard perturbation candidates with DNA-guided variants.
 * DNA guidance biases ATR floor and confidence threshold toward winning conditions.
 * Returns an augmented candidate array (extras appended to the standard list).
 */
function augmentCandidatesWithDNA(baseParams, instrument, db, count) {
  const extras = [];
  try {
    const dna = loadDNA(db, instrument);
    if (!dna) return extras;
    const guidance = getDNAGuidance(dna, instrument);

    // Threshold hint from DNA top combos
    if (guidance.thresholdHint != null) {
      extras.push({ ...baseParams, minConfidence: guidance.thresholdHint });
    }

    // Regime-tuned ATR variants
    for (const hint of (guidance.regimeHints ?? []).slice(0, 2)) {
      const v = { ...baseParams };
      if (hint.regime === 'trending' && hint.winRate > 0.63) {
        v.atrMin = Math.max((baseParams.atrMin ?? 1.0) * 0.90, 0.4);
      } else if (hint.regime === 'volatile' && hint.winRate > 0.63) {
        v.atrMin = Math.min((baseParams.atrMin ?? 1.0) * 1.10, 3.5);
      }
      if (v.atrMin !== baseParams.atrMin) extras.push(v);
    }

    // Session-sensitive threshold relaxation for strongest sessions
    for (const sess of (guidance.bestSessions ?? []).slice(0, 1)) {
      if (sess.winRate > 0.67) {
        extras.push({ ...baseParams, minConfidence: Math.max((baseParams.minConfidence ?? 60) - 2, 54) });
      }
    }
  } catch {}
  return extras.slice(0, count);
}

// ── Per-style optimization ────────────────────────────────────────────────────
/**
 * Optimize params specifically for one trade style (scalp/intraday/swing).
 * Returns { bestParams, bestMetrics, candidates, baselineMetrics }.
 */
function optimizeStyle(bars1m, instrument, style, db, opts) {
  const styleKey    = `${instrument}_${style.toUpperCase()}`;
  const baseParams  = getStyleParams(db, instrument, style);
  const baseline    = runBaselineBacktest(bars1m, baseParams, opts);
  const baseMetrics = baseline.metrics;

  const candidates = generateCandidates(baseParams, instrument, SAFEGUARDS.perturbTrials);
  // Append DNA-guided extras for richer exploration
  const styleExtras = augmentCandidatesWithDNA(baseParams, instrument, db, 3);
  if (styleExtras.length > 0) candidates.push(...styleExtras);

  const evaluated = candidates.map(p => {
    const r = runBacktest(bars1m, p, {
      cooldown:  baseline.cooldownUsed ?? 1,
      slippage:  opts.slippage,
    });
    return { params: p, metrics: r.metrics, score: multiObjectiveScore(r.metrics) };
  });

  // Breed elites
  evaluated.sort((a, b) => b.score - a.score);
  const elites = evaluated.slice(0, SAFEGUARDS.eliteCount);
  for (let k = 0; k < 5; k++) {
    const p1 = elites[Math.floor(Math.random() * elites.length)].params;
    const p2 = elites[Math.floor(Math.random() * elites.length)].params;
    if (p1 === p2) continue;
    const child = crossoverParams(p1, p2);
    const r = runBacktest(bars1m, child, { cooldown: baseline.cooldownUsed ?? 1, slippage: opts.slippage });
    evaluated.push({ params: child, metrics: r.metrics, score: multiObjectiveScore(r.metrics) });
  }
  evaluated.sort((a, b) => b.score - a.score);

  const best = evaluated[0];

  // Walk-forward validation on the winner only
  if (best && validateImprovement(baseMetrics, best.metrics)) {
    const wf = runWalkForward(bars1m, best.params, {
      nWindows: opts.walkForwardWins,
      cooldown: baseline.cooldownUsed ?? 1,
      slippage: opts.slippage,
      minBars:  opts.minBarsPerWindow,
    });
    best.walkForward = wf;
    // Discount score if walk-forward consistency is poor
    if (wf.consistency < 0.4) {
      best.score = best.score * 0.7;
    }
  }

  return {
    styleKey,
    style,
    baseParams,
    baselineMetrics: baseMetrics,
    cooldownUsed:    baseline.cooldownUsed,
    best:            best ?? null,
    totalCandidates: evaluated.length,
  };
}

// ── Main per-instrument optimization cycle ────────────────────────────────────
/**
 * Run the full optimization pipeline for one instrument.
 * Persists results to DB and returns a summary report.
 *
 * @param {Object}   db         - better-sqlite3 instance
 * @param {string}   instrument - 'MNQ' | 'MGC'
 * @param {Array}    bars1m     - 1m OHLCV bars (ideally 8 000 – 15 000)
 * @param {Object}   [opts]     - override DEFAULT_OPT_OPTS
 * @returns {Object} report
 */
async function runFullOptimizationCycle(db, instrument, bars1m, opts = {}) {
  const o = { ...DEFAULT_OPT_OPTS, ...opts };
  const startMs = Date.now();

  // ── Phase 1: Baseline with current live params ───────────────────────────
  const liveParams   = getParams(db, instrument);
  const liveBaseline = runBaselineBacktest(bars1m, liveParams, o);
  const liveMetrics  = liveBaseline.metrics;

  const liveRunId = saveBacktestRun(db, instrument, liveParams, {
    ...liveMetrics, barsScanned: bars1m.length,
  }, 'optimizer');

  saveBacktestDetails(db, liveRunId, {
    byRegime:                liveMetrics.byRegime,
    byStyle:                 liveMetrics.byStyle,
    bySetup:                 liveMetrics.bySetup,
    walkForwardConsistency:  liveBaseline.walkForward?.consistency ?? null,
    walkForwardAvgWR:        liveBaseline.walkForward?.avgWinRate  ?? null,
    maxWinStreak:            liveMetrics.maxWinStreak,
    maxLossStreak:           liveMetrics.maxLossStreak,
    slippageUsed:            liveBaseline.slippageUsed,
    cooldownUsed:            liveBaseline.cooldownUsed,
    multiObjScore:           multiObjectiveScore(liveMetrics),
  });

  // ── Phase 2: Global instrument-level optimisation ────────────────────────
  const globalCandidates = generateCandidates(liveParams, instrument, SAFEGUARDS.perturbTrials);
  // Augment with DNA-guided variants (up to 5 extras based on winning patterns)
  const dnaExtras = augmentCandidatesWithDNA(liveParams, instrument, db, 5);
  if (dnaExtras.length > 0) {
    globalCandidates.push(...dnaExtras);
  }
  const globalEvaluated  = globalCandidates.map(p => {
    const r = runBacktest(bars1m, p, {
      cooldown: liveBaseline.cooldownUsed ?? 1,
      slippage: o.slippage,
    });
    return { params: p, metrics: r.metrics, score: multiObjectiveScore(r.metrics) };
  });

  globalEvaluated.sort((a, b) => b.score - a.score);

  // Elite crossover
  const elites = globalEvaluated.slice(0, SAFEGUARDS.eliteCount);
  for (let k = 0; k < 5; k++) {
    const p1 = elites[Math.floor(Math.random() * elites.length)].params;
    const p2 = elites[Math.floor(Math.random() * elites.length)].params;
    if (p1 === p2) continue;
    const child = crossoverParams(p1, p2);
    const r = runBacktest(bars1m, child, { cooldown: liveBaseline.cooldownUsed ?? 1, slippage: o.slippage });
    globalEvaluated.push({ params: child, metrics: r.metrics, score: multiObjectiveScore(r.metrics) });
  }
  globalEvaluated.sort((a, b) => b.score - a.score);

  const globalBest = globalEvaluated[0];
  let   globalPromoted = false;

  if (globalBest && validateImprovement(liveMetrics, globalBest.metrics)) {
    // Walk-forward check before promoting
    const wf = runWalkForward(bars1m, globalBest.params, {
      nWindows: o.walkForwardWins, cooldown: liveBaseline.cooldownUsed ?? 1,
      slippage: o.slippage, minBars: o.minBarsPerWindow,
    });

    // Only promote if walk-forward consistency is acceptable
    if (wf.consistency >= 0.35) {
      saveRevision(db, instrument, liveParams, globalBest.params,
        liveMetrics, globalBest.metrics, liveRunId, 'shadow');
      globalPromoted = true;
    }
  }

  // Log optimization run
  try {
    db.prepare(`
      INSERT INTO optimization_runs
        (instrument, trade_style, candidates_tested, best_win_rate, best_sharpe,
         best_consistency, best_multi_obj, best_params_json, baseline_win_rate, promoted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      instrument, null,
      globalEvaluated.length,
      globalBest?.metrics.winRate    ?? 0,
      globalBest?.metrics.sharpe     ?? 0,
      globalBest?.metrics.regimeConsistency ?? 0,
      globalBest?.score              ?? 0,
      JSON.stringify(globalBest?.params ?? {}),
      liveMetrics.winRate,
      globalPromoted ? 1 : 0,
    );
  } catch { /* optimization_runs table may not exist on older DBs */ }

  // ── Phase 3: Per-style optimisation ─────────────────────────────────────
  const stylesToOptimize = o.styles ??
    (instrument === 'MGC' ? ['scalp'] : ['scalp', 'intraday', 'swing']);
  const styleResults = {};

  for (const style of stylesToOptimize) {
    const sr = optimizeStyle(bars1m, instrument, style, db, o);
    styleResults[style] = sr;

    if (sr.best && validateImprovement(sr.baselineMetrics, sr.best.metrics)) {
      saveStyleParams(db, instrument, style, sr.best.params);

      try {
        db.prepare(`
          INSERT INTO optimization_runs
            (instrument, trade_style, candidates_tested, best_win_rate, best_sharpe,
             best_consistency, best_multi_obj, best_params_json, baseline_win_rate, promoted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          instrument, style,
          sr.totalCandidates,
          sr.best.metrics.winRate    ?? 0,
          sr.best.metrics.sharpe     ?? 0,
          sr.best.metrics.regimeConsistency ?? 0,
          sr.best.score              ?? 0,
          JSON.stringify(sr.best.params),
          sr.baselineMetrics.winRate,
          1,
        );
      } catch {}
    }
  }

  // ── Build and return summary report ─────────────────────────────────────
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  return generateOptimizationReport({
    instrument,
    bars:          bars1m.length,
    elapsed,
    liveMetrics,
    cooldownUsed:  liveBaseline.cooldownUsed,
    walkForward:   liveBaseline.walkForward,
    globalBest,
    globalPromoted,
    styleResults,
    targetTrades:  o.targetTrades,
  });
}

// ── Report builder ────────────────────────────────────────────────────────────
function generateOptimizationReport(data) {
  const {
    instrument, bars, elapsed, liveMetrics, cooldownUsed,
    walkForward, globalBest, globalPromoted, styleResults, targetTrades,
  } = data;

  const pct = v => `${(v * 100).toFixed(1)}%`;
  const wr  = liveMetrics.winRate;
  const gap = 0.75 - wr;

  const lines = [
    `──── OPTIMIZATION REPORT: ${instrument} ────────────────────────`,
    `Bars: ${bars} | Trades: ${liveMetrics.tradeCount} (target: ${targetTrades}) | Cooldown: ${cooldownUsed}`,
    `Elapsed: ${elapsed}s`,
    ``,
    `BASELINE  win=${pct(wr)}  sharpe=${liveMetrics.sharpe}  pf=${liveMetrics.profitFactor}  dd=${liveMetrics.maxDrawdown}R`,
    `          regime-consistency=${(liveMetrics.regimeConsistency ?? 1).toFixed(2)}  multi-obj=${multiObjectiveScore(liveMetrics)}`,
    gap > 0 ? `          ⚠ Gap to 75% live target: +${pct(gap)} needed` : `          ✓ At or above 75% live target`,
    ``,
    `REGIME BREAKDOWN`,
    ...Object.entries(liveMetrics.byRegime ?? {}).filter(([, m]) => m).map(
      ([reg, m]) => `  ${reg.padEnd(9)}: win=${pct(m.winRate)}  n=${m.tradeCount}`
    ),
    ``,
    `STYLE BREAKDOWN`,
    ...Object.entries(liveMetrics.byStyle ?? {}).filter(([, m]) => m).map(
      ([sty, m]) => `  ${sty.padEnd(9)}: win=${pct(m.winRate)}  n=${m.tradeCount}`
    ),
    ``,
    `SETUP BREAKDOWN`,
    ...Object.entries(liveMetrics.bySetup ?? {}).filter(([, m]) => m).map(
      ([stp, m]) => `  ${stp.padEnd(11)}: win=${pct(m.winRate)}  n=${m.tradeCount}`
    ),
    ``,
    `WALK-FORWARD  consistency=${walkForward?.consistency ?? 'n/a'}  avg-wr=${walkForward ? pct(walkForward.avgWinRate) : 'n/a'}`,
    ...(walkForward?.windows ?? []).map(
      w => `  W${w.window}: win=${pct(w.winRate)}  n=${w.tradeCount}  sharpe=${w.sharpe}`
    ),
    ``,
    `GLOBAL SEARCH  ${globalBest ? `best-wr=${pct(globalBest.metrics.winRate)} (Δ${pct(globalBest.metrics.winRate - wr)})  score=${globalBest.score}  promoted=${globalPromoted}` : 'no improvement found'}`,
    ``,
    `PER-STYLE SEARCH`,
    ...Object.entries(styleResults).map(([sty, sr]) =>
      `  ${sty}: baseline=${pct(sr.baselineMetrics.winRate)} → best=${sr.best ? pct(sr.best.metrics.winRate) : 'n/a'} ${sr.best ? `(Δ${pct(sr.best.metrics.winRate - sr.baselineMetrics.winRate)}) n=${sr.best.metrics.tradeCount}` : ''}`
    ),
    `────────────────────────────────────────────────────────────────`,
  ];

  return {
    summary: lines.join('\n'),
    instrument,
    liveWinRate:    liveMetrics.winRate,
    targetWinRate:  0.75,
    atTarget:       wr >= 0.75,
    tradeCount:     liveMetrics.tradeCount,
    cooldownUsed,
    walkForwardConsistency: walkForward?.consistency ?? null,
    globalPromoted,
    styleResults: Object.fromEntries(
      Object.entries(styleResults).map(([sty, sr]) => [sty, {
        baselineWR: sr.baselineMetrics.winRate,
        bestWR:     sr.best?.metrics.winRate ?? null,
        improved:   sr.best ? validateImprovement(sr.baselineMetrics, sr.best.metrics) : false,
      }])
    ),
  };
}

module.exports = { runFullOptimizationCycle, generateOptimizationReport, optimizeStyle };
