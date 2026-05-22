'use strict';

/**
 * BACKTEST DATA MINER
 *
 * Mines all stored backtest data to find the best-performing configurations
 * for MNQ_INTRADAY and MGC_SCALP, then optionally applies them live.
 *
 * Data sources:
 *   backtest_runs    — per-instrument run summaries (win_rate, PF, Sharpe, drawdown)
 *   backtest_details — JSON breakdowns by regime / style / setup
 *   backtest_trades  — individual trade records (strategy_name, setup, regime, confidence)
 *   optimization_runs — genetic optimizer results (best_params_json per style)
 *   signals + outcomes — live trading performance
 *
 * Outputs:
 *   - Segment analysis (setup × regime × confidence bucket)
 *   - Recency-weighted run rankings
 *   - Candidate configs (MNQ_INTRADAY_OPTIMIZED, MGC_SCALP_OPTIMIZED)
 *   - Applied changes to ai_thresholds and strategy_params (when apply=true)
 *   - Full JSON report stored in strategy_revisions
 */

const thresholdManager = require('./agents/threshold-manager');
const {
  getParams, getStyleParams, saveStyleParams, saveRevision,
  PARAM_BOUNDS, SAFEGUARDS, DEFAULT_PARAMS_BY_STYLE,
} = require('./strategy-params');

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGETS = {
  MNQ_INTRADAY: { instrument: 'MNQ', style: 'INTRADAY', styleKey: 'MNQ_INTRADAY' },
  MGC_SCALP:    { instrument: 'MGC', style: 'SCALP',    styleKey: 'MGC_SCALP'    },
};

// Recency weighting: exponential decay with 14-day half-life
// weight(days) = exp(-days * ln(2) / 14)
// → 7d: 0.71  14d: 0.50  30d: 0.23  60d: 0.05
const RECENCY_HALFLIFE_DAYS = 14;

// Validation gates (aligned with SAFEGUARDS in strategy-params.js)
const GATE = {
  minTrades:          15,   // backtest must have at least this many trades
  minLiveTrades:       3,   // minimum live trades for live performance to count
  minWinRate:        0.50,  // reject if win rate < 50%
  minProfitFactor:   1.10,  // reject if PF < 1.1
  maxDrawdown:       35,    // reject if max drawdown > 35 pts / %
  minExpectancy:    -99,    // expectancy ≥ this (pts per trade) — negative is bad
};

// Confidence buckets for threshold analysis
const CONF_BUCKETS = [
  { label: '80+',   min: 80, max: 999 },
  { label: '75-79', min: 75, max: 80  },
  { label: '70-74', min: 70, max: 75  },
  { label: '65-69', min: 65, max: 70  },
  { label: '60-64', min: 60, max: 65  },
  { label: '<60',   min:  0, max: 60  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function recencyWeight(runAtStr) {
  const daysOld = (Date.now() - new Date(runAtStr).getTime()) / 86_400_000;
  return Math.exp(-daysOld * Math.LN2 / RECENCY_HALFLIFE_DAYS);
}

function profitFactor(wins, losses) {
  if (losses === 0) return wins > 0 ? 99 : 0;
  return +(wins / losses).toFixed(3);
}

function expectancy(winRate, avgWin, avgLoss) {
  // E = WR × avgWin - (1 - WR) × avgLoss
  return +((winRate * avgWin) - ((1 - winRate) * Math.abs(avgLoss))).toFixed(3);
}

function safe(v, decimals = 2) {
  if (v == null || !isFinite(v)) return null;
  return +v.toFixed(decimals);
}

// ── Phase 1: Mine backtest_trades for segment analysis ────────────────────────

function mineSegments(db, strategyName) {
  // Setup × regime breakdown
  const setupRegime = db.prepare(`
    SELECT
      bt.setup,
      bt.regime,
      COUNT(*) AS trades,
      ROUND(AVG(CASE WHEN bt.outcome = 'WIN' THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
      ROUND(AVG(bt.pnl_pts), 3)  AS avg_pnl,
      ROUND(
        SUM(CASE WHEN bt.outcome = 'WIN'  THEN bt.pnl_pts ELSE 0 END) /
        NULLIF(ABS(SUM(CASE WHEN bt.outcome = 'LOSS' THEN bt.pnl_pts ELSE 0 END)), 0)
      , 3) AS profit_factor,
      ROUND(AVG(bt.confidence), 1) AS avg_confidence,
      MAX(br.run_at)  AS latest_run_at,
      COUNT(DISTINCT bt.run_id) AS run_count
    FROM backtest_trades bt
    JOIN backtest_runs br ON br.id = bt.run_id
    WHERE bt.strategy_name = ?
      AND bt.outcome IN ('WIN', 'LOSS', 'BE')
      AND bt.pnl_pts IS NOT NULL
    GROUP BY bt.setup, bt.regime
    HAVING trades >= 3
    ORDER BY win_rate DESC, trades DESC
  `).all(strategyName);

  // Confidence bucket breakdown
  const confBuckets = CONF_BUCKETS.map(bucket => {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS trades,
        ROUND(AVG(CASE WHEN outcome = 'WIN' THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
        ROUND(AVG(pnl_pts), 3)  AS avg_pnl,
        ROUND(
          SUM(CASE WHEN outcome = 'WIN'  THEN pnl_pts ELSE 0 END) /
          NULLIF(ABS(SUM(CASE WHEN outcome = 'LOSS' THEN pnl_pts ELSE 0 END)), 0)
        , 3) AS profit_factor
      FROM backtest_trades
      WHERE strategy_name = ?
        AND confidence >= ? AND confidence < ?
        AND outcome IN ('WIN', 'LOSS', 'BE')
        AND pnl_pts IS NOT NULL
    `).get(strategyName, bucket.min, bucket.max);
    return { ...bucket, ...row };
  });

  // Session breakdown approximated from hour-of-day (backtest_trades has no session column)
  // Pacific Time: London ≈ 01-04h, NY_PRE ≈ 04-06h, NY_OPEN ≈ 06-09h, MIDDAY ≈ 09-12h
  const sessionData = db.prepare(`
    SELECT
      CASE
        WHEN CAST(strftime('%H', bt.timestamp) AS INTEGER) BETWEEN 1  AND 3  THEN 'LONDON'
        WHEN CAST(strftime('%H', bt.timestamp) AS INTEGER) BETWEEN 4  AND 5  THEN 'NY_PRE'
        WHEN CAST(strftime('%H', bt.timestamp) AS INTEGER) BETWEEN 6  AND 8  THEN 'NY_OPEN'
        WHEN CAST(strftime('%H', bt.timestamp) AS INTEGER) BETWEEN 9  AND 11 THEN 'MIDDAY'
        WHEN CAST(strftime('%H', bt.timestamp) AS INTEGER) BETWEEN 12 AND 14 THEN 'AFTERNOON'
        ELSE 'OVERNIGHT'
      END AS session,
      COUNT(*) AS trades,
      ROUND(AVG(CASE WHEN bt.outcome = 'WIN' THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
      ROUND(AVG(bt.pnl_pts), 3) AS avg_pnl
    FROM backtest_trades bt
    WHERE bt.strategy_name = ?
      AND bt.timestamp IS NOT NULL
      AND bt.outcome IN ('WIN', 'LOSS', 'BE')
    GROUP BY session
    HAVING trades >= 3
    ORDER BY win_rate DESC
  `).all(strategyName);

  // Worst regime/setup combos (loss clusters)
  const worstCombos = setupRegime
    .filter(r => r.win_rate < 0.45 && r.trades >= 5)
    .sort((a, b) => a.win_rate - b.win_rate)
    .slice(0, 5);

  // Best regime/setup combos
  const bestCombos = setupRegime
    .filter(r => r.win_rate >= 0.55 && r.trades >= 5)
    .sort((a, b) => (b.win_rate * b.trades) - (a.win_rate * a.trades))
    .slice(0, 8);

  const totalTrades = db.prepare(
    `SELECT COUNT(*) AS n FROM backtest_trades WHERE strategy_name = ? AND outcome IN ('WIN','LOSS','BE')`
  ).get(strategyName)?.n ?? 0;

  return { setupRegime, confBuckets, sessionData, bestCombos, worstCombos, totalTrades };
}

// ── Phase 2: Mine backtest_runs for recency-weighted run rankings ─────────────

function mineRuns(db, instrument, styleMode) {
  const rows = db.prepare(`
    SELECT
      br.id, br.run_at, br.win_rate, br.profit_factor, br.sharpe, br.max_drawdown,
      br.trades_found, br.params_json,
      bd.multi_obj_score, bd.walk_forward_consistency,
      bd.regime_breakdown, bd.style_breakdown, bd.setup_breakdown
    FROM backtest_runs br
    LEFT JOIN backtest_details bd ON bd.run_id = br.id
    WHERE br.instrument = ?
      AND br.trades_found >= ?
      AND (br.win_rate IS NULL OR br.win_rate > 0)
    ORDER BY br.run_at DESC
    LIMIT 100
  `).all(instrument, GATE.minTrades);

  // Filter to style mode if present in params_json, and apply recency weight
  const scored = rows
    .map(r => {
      let params = {};
      try { params = JSON.parse(r.params_json ?? '{}'); } catch {}
      // If styleMode specified, filter; old runs without tradeStyleMode count for all
      if (styleMode && params.tradeStyleMode && params.tradeStyleMode !== styleMode &&
          params.tradeStyleMode !== 'auto') return null;

      const rw = recencyWeight(r.run_at);
      const wr = r.win_rate ?? 0;
      const pf = r.profit_factor ?? 0;
      const sh = r.sharpe ?? 0;
      const mo = r.multi_obj_score ?? 0;

      // Composite: WR×0.40 + PF_norm×0.25 + Sharpe_norm×0.20 + MO×0.15, then × recency
      const pfNorm  = Math.min(pf / 3, 1);
      const shNorm  = Math.min(Math.max((sh + 1) / 4, 0), 1);
      const rawScore = wr * 0.40 + pfNorm * 0.25 + shNorm * 0.20 + mo * 0.15;
      const weighted = rawScore * rw;

      return { ...r, params, rw: safe(rw, 3), rawScore: safe(rawScore, 4), weighted: safe(weighted, 4) };
    })
    .filter(Boolean)
    .sort((a, b) => b.weighted - a.weighted);

  return scored;
}

// ── Phase 3: Mine optimization_runs for genetic optimizer best params ─────────

function mineOptimizer(db, instrument, style) {
  const rows = db.prepare(`
    SELECT id, run_at, candidates_tested, best_win_rate, best_sharpe, best_multi_obj,
           best_params_json, baseline_win_rate, promoted
    FROM optimization_runs
    WHERE instrument = ?
      AND (trade_style = ? OR trade_style IS NULL)
      AND best_win_rate > 0
    ORDER BY run_at DESC
    LIMIT 20
  `).all(instrument, style ?? instrument);

  return rows.map(r => {
    let params = {};
    try { params = JSON.parse(r.best_params_json ?? '{}'); } catch {}
    const rw = recencyWeight(r.run_at);
    return { ...r, params, rw: safe(rw, 3) };
  });
}

// ── Phase 4: Mine live signal performance ─────────────────────────────────────

function mineLiveSignals(db, strategyName) {
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN o.result = 'WIN'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN o.result = 'BE'   THEN 1 ELSE 0 END) AS breakevens,
      ROUND(AVG(CASE WHEN o.result = 'WIN' THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
      ROUND(AVG(o.pnl_pts), 3) AS avg_pnl,
      ROUND(
        SUM(CASE WHEN o.result = 'WIN'  THEN o.pnl_pts ELSE 0 END) /
        NULLIF(ABS(SUM(CASE WHEN o.result = 'LOSS' THEN o.pnl_pts ELSE 0 END)), 0)
      , 3) AS profit_factor,
      ROUND(AVG(s.confidence), 1) AS avg_confidence
    FROM signals s
    JOIN outcomes o ON o.signal_id = s.id
    WHERE s.strategy_name = ?
      AND (s.live_gated = 0 OR s.live_gated IS NULL)
  `).get(strategyName);

  // Per-session live breakdown
  const bySession = db.prepare(`
    SELECT
      s.session,
      COUNT(*) AS trades,
      ROUND(AVG(CASE WHEN o.result = 'WIN' THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
      ROUND(AVG(o.pnl_pts), 3) AS avg_pnl
    FROM signals s
    JOIN outcomes o ON o.signal_id = s.id
    WHERE s.strategy_name = ?
      AND (s.live_gated = 0 OR s.live_gated IS NULL)
      AND s.session IS NOT NULL
    GROUP BY s.session
    HAVING trades >= 1
    ORDER BY win_rate DESC
  `).all(strategyName);

  // Confidence × outcome correlation (live)
  const byConf = CONF_BUCKETS.map(bucket => {
    const row = db.prepare(`
      SELECT COUNT(*) AS trades,
        ROUND(AVG(CASE WHEN o.result = 'WIN' THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
        ROUND(AVG(o.pnl_pts), 3) AS avg_pnl
      FROM signals s
      JOIN outcomes o ON o.signal_id = s.id
      WHERE s.strategy_name = ?
        AND s.confidence >= ? AND s.confidence < ?
        AND (s.live_gated = 0 OR s.live_gated IS NULL)
    `).get(strategyName, bucket.min, bucket.max);
    return { ...bucket, ...row };
  });

  return { summary: summary ?? {}, bySession, byConf };
}

// ── Phase 5: Select best confidence threshold from data ───────────────────────

/**
 * Find the confidence threshold that maximises signal quality score.
 * Quality = win_rate × profit_factor × log10(trades + 1)
 * We require at least 5 trades above the threshold to consider it.
 * The chosen threshold = highest-quality bucket's min value.
 */
function selectBestConfidenceThreshold(confBuckets, minTrades = 5, fallback = null) {
  // Score each threshold level (≥X means we keep trades in this bucket and above)
  const candidates = [];
  for (let i = 0; i < confBuckets.length; i++) {
    const bucket = confBuckets[i];
    if (bucket.label === '<60') continue; // never raise below 60

    // Aggregate all trades at or above this bucket
    const above = confBuckets.slice(0, i + 1); // higher buckets come first
    const totalTrades = above.reduce((s, b) => s + (b.trades ?? 0), 0);
    if (totalTrades < minTrades) continue;

    const totalWins  = above.reduce((s, b) => s + (b.trades ?? 0) * (b.win_rate ?? 0), 0);
    const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
    const pf = above.reduce((s, b) => {
      const t = b.trades ?? 0;
      return s + t * (b.profit_factor ?? 1);
    }, 0) / Math.max(1, totalTrades);
    const quality = wr * Math.min(pf, 3) * Math.log10(totalTrades + 1);

    candidates.push({ threshold: bucket.min, wr, pf, totalTrades, quality });
  }

  if (!candidates.length) return fallback;
  candidates.sort((a, b) => b.quality - a.quality);
  return candidates[0].threshold;
}

// ── Phase 6: Select best params from run/optimizer data ───────────────────────

function selectBestParams(runRanking, optimizerRuns, currentParams, instrument, style) {
  // Primary: top optimizer run (genetic algorithm found the best combination)
  const topOptimizer = optimizerRuns
    .filter(r => (r.best_win_rate ?? 0) > 0 && r.params && Object.keys(r.params).length > 0)
    [0];

  // Secondary: top backtest run
  const topRun = runRanking
    .filter(r => (r.win_rate ?? 0) >= GATE.minWinRate && (r.trades_found ?? 0) >= GATE.minTrades)
    [0];

  // Start from current params, apply best improvements found
  const result = { ...currentParams };

  // Apply slPts from the best optimizer run if it's different and within bounds
  if (topOptimizer?.params?.slPts != null) {
    const clamped = Math.min(Math.max(Math.round(topOptimizer.params.slPts), PARAM_BOUNDS.slPts.min), PARAM_BOUNDS.slPts.max);
    result.slPts = clamped;
    result._slPtsSource = `optimizer run ${topOptimizer.id} (${topOptimizer.run_at?.slice(0, 10)})`;
  } else if (topRun?.params?.slPts != null) {
    const clamped = Math.min(Math.max(Math.round(topRun.params.slPts), PARAM_BOUNDS.slPts.min), PARAM_BOUNDS.slPts.max);
    result.slPts = clamped;
    result._slPtsSource = `backtest run ${topRun.id} (${topRun.run_at?.slice(0, 10)})`;
  }

  // Apply minScore similarly
  if (topOptimizer?.params?.minScore != null) {
    const clamped = Math.min(Math.max(Math.round(topOptimizer.params.minScore), PARAM_BOUNDS.minScore.min), PARAM_BOUNDS.minScore.max);
    result.minScore = clamped;
  }

  result._sourceRunId  = topOptimizer?.id ?? topRun?.id ?? null;
  result._sourceWinRate = safe(topOptimizer?.best_win_rate ?? topRun?.win_rate, 4);
  result.tradeStyleMode = style?.toLowerCase() ?? currentParams.tradeStyleMode ?? 'auto';

  return result;
}

// ── Phase 7: Validate candidate before applying ───────────────────────────────

function validateCandidate(segments, runs, label) {
  const issues = [];

  // Must have enough backtest trades
  if (segments.totalTrades < GATE.minTrades) {
    issues.push(`only ${segments.totalTrades} backtest trades (need ≥${GATE.minTrades})`);
  }

  // Best setup must have a decent win rate
  const bestSetup = segments.bestCombos[0];
  if (bestSetup && bestSetup.win_rate < GATE.minWinRate) {
    issues.push(`best setup win_rate=${(bestSetup.win_rate * 100).toFixed(1)}% < ${GATE.minWinRate * 100}% minimum`);
  }

  // Must have at least one qualifying run
  const qualRuns = runs.filter(r => (r.win_rate ?? 0) >= GATE.minWinRate);
  if (qualRuns.length === 0 && runs.length > 0) {
    issues.push(`no backtest runs met win_rate ≥ ${GATE.minWinRate * 100}% threshold`);
  }

  return { valid: issues.length === 0, issues };
}

// ── Phase 8: Apply optimized config to live system ────────────────────────────

function applyConfig(db, strategyName, newConfidenceThreshold, newParams, report) {
  const { instrument, style } = TARGETS[strategyName];
  const weekStart = new Date().toISOString().slice(0, 10);
  const results = [];

  // 1. Apply confidence threshold via ThresholdManager
  if (newConfidenceThreshold != null && thresholdManager.initialized) {
    const key = `LIVE_THRESHOLD:${strategyName}`;
    const reason = `backtest-miner: data-driven threshold from ${report.totalBacktestTrades} trades, best conf bucket WR=${(report.bestConfBucketWr * 100).toFixed(1)}%`;
    const r = thresholdManager.applyChange(key, newConfidenceThreshold, reason, weekStart);
    results.push({ type: 'threshold', key, value: newConfidenceThreshold, result: r });
  }

  // 2. Apply style params (slPts, minScore) if changed from current
  const currentParams = getStyleParams(db, instrument, style);
  const slChanged     = newParams.slPts    !== currentParams.slPts;
  const scoreChanged  = newParams.minScore !== currentParams.minScore;
  if (slChanged || scoreChanged) {
    saveStyleParams(db, instrument, style, newParams);
    results.push({
      type: 'style_params', key: `${instrument}_${style}`,
      oldSlPts: currentParams.slPts, newSlPts: newParams.slPts,
      oldMinScore: currentParams.minScore, newMinScore: newParams.minScore,
    });

    // Create strategy_revisions entry for audit trail
    try {
      const oldM = { winRate: 0, sharpe: 0, regimeConsistency: 1 };
      const newM = {
        winRate: report.currentRunWinRate ?? 0.0,
        sharpe:  report.currentRunSharpe  ?? 0.0,
        regimeConsistency: 1,
        tradeCount: report.totalBacktestTrades ?? 0,
      };
      db.prepare(`
        INSERT INTO strategy_revisions
          (instrument, reason, old_params_json, new_params_json, win_rate_before, win_rate_after, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `).run(
        instrument,
        `backtest-miner optimization: ${strategyName} slPts ${currentParams.slPts}→${newParams.slPts}`,
        JSON.stringify(currentParams),
        JSON.stringify(newParams),
        oldM.winRate,
        newM.winRate,
      );
      results.push({ type: 'revision_logged', instrument, strategy: strategyName });
    } catch { /* audit logging never crashes the apply */ }
  }

  return results;
}

// ── Main: mine() ──────────────────────────────────────────────────────────────

/**
 * Run the full data mining pipeline.
 *
 * @param {object} db     — better-sqlite3 DB instance
 * @param {object} opts   — { apply: boolean, dryRun: boolean }
 * @returns {object} full report JSON
 */
function mine(db, opts = {}) {
  const { apply = false } = opts;
  const startMs = Date.now();

  // Ensure ThresholdManager is initialized
  if (!thresholdManager.initialized) {
    thresholdManager.init(db);
  }

  const report = {
    generated_at: new Date().toISOString(),
    applied: false,
    strategies: {},
    summary: {},
  };

  // ── Count all backtest data ─────────────────────────────────────────────────
  const totalRuns   = db.prepare('SELECT COUNT(*) n FROM backtest_runs WHERE trades_found >= ?').get(GATE.minTrades)?.n ?? 0;
  const zeroRuns    = db.prepare('SELECT COUNT(*) n FROM backtest_runs WHERE trades_found = 0 OR trades_found IS NULL').get()?.n ?? 0;
  const totalTrades = db.prepare('SELECT COUNT(*) n FROM backtest_trades WHERE outcome IN (\'WIN\',\'LOSS\',\'BE\')').get()?.n ?? 0;
  const optRuns     = db.prepare('SELECT COUNT(*) n FROM optimization_runs WHERE best_win_rate > 0').get()?.n ?? 0;

  report.dataSources = { totalValidRuns: totalRuns, zeroTradeRunsExcluded: zeroRuns, totalBacktestTrades: totalTrades, optimizerRunsAnalyzed: optRuns };

  // ── Process each target strategy ──────────────────────────────────────────
  for (const [strategyName, target] of Object.entries(TARGETS)) {
    const { instrument, style, styleKey } = target;

    // Phase 1: segment analysis from backtest_trades
    const segments = mineSegments(db, strategyName);

    // Phase 2: recency-weighted run rankings
    const runs = mineRuns(db, instrument, style.toLowerCase());

    // Phase 3: optimizer best params
    const optimizerRuns = mineOptimizer(db, instrument, style.toLowerCase());

    // Phase 4: live signal performance
    const livePerf = mineLiveSignals(db, strategyName);

    // Phase 5: find best confidence threshold
    const allBuckets = segments.confBuckets;
    const bestThreshold = selectBestConfidenceThreshold(
      allBuckets,
      Math.max(5, Math.floor(segments.totalTrades * 0.05)),
      null
    );

    // Also compute best threshold from live signal data (if enough data)
    const liveBestThreshold = livePerf.summary?.total >= GATE.minLiveTrades
      ? selectBestConfidenceThreshold(livePerf.byConf, 2, null)
      : null;

    // Blend: 70% backtest, 30% live (if live has enough data)
    let finalThreshold = bestThreshold;
    if (bestThreshold != null && liveBestThreshold != null && livePerf.summary.total >= 5) {
      finalThreshold = Math.round(bestThreshold * 0.70 + liveBestThreshold * 0.30);
    }

    // Phase 6: select best params
    const currentParams = getStyleParams(db, instrument, style);
    const bestParams = selectBestParams(runs, optimizerRuns, currentParams, instrument, style);

    // Phase 7: validate
    const validation = validateCandidate(segments, runs, strategyName);

    // Best conf bucket for reporting
    const bestBucket = allBuckets
      .filter(b => b.trades >= 5 && b.win_rate > 0 && b.label !== '<60')
      .sort((a, b) => (b.win_rate * Math.log10(b.trades + 1)) - (a.win_rate * Math.log10(a.trades + 1)))
      [0];

    // Top runs for report
    const topRuns = runs.slice(0, 5).map(r => ({
      id: r.id, run_at: r.run_at?.slice(0, 16),
      win_rate: safe(r.win_rate, 3), profit_factor: safe(r.profit_factor, 3),
      sharpe: safe(r.sharpe, 3), max_drawdown: safe(r.max_drawdown, 1),
      trades_found: r.trades_found, weighted_score: r.weighted, recency: r.rw,
    }));

    // Current live threshold for comparison
    const currentThreshold = thresholdManager.getLiveThreshold(strategyName);

    const stratReport = {
      strategy: strategyName,
      data: {
        totalBacktestTrades: segments.totalTrades,
        validRuns: runs.length,
        optimizerRuns: optimizerRuns.length,
        liveTrades: livePerf.summary?.total ?? 0,
      },
      segments: {
        bestSetups:  segments.bestCombos,
        worstSetups: segments.worstCombos,
        bySession:   segments.sessionData,
        byConfidence: segments.confBuckets.filter(b => b.trades > 0),
      },
      livePerformance: {
        ...livePerf.summary,
        bySession: livePerf.bySession,
        byConfidence: livePerf.byConf.filter(b => b.trades > 0),
      },
      topRuns,
      currentConfig: {
        liveThreshold: currentThreshold,
        slPts:     currentParams.slPts,
        minScore:  currentParams.minScore,
        version:   currentParams.version ?? 1,
      },
      optimizedConfig: {
        liveThreshold:     finalThreshold,
        liveThresholdNote: finalThreshold != null
          ? `data-backed (backtest_threshold=${bestThreshold} live_threshold=${liveBestThreshold})`
          : 'insufficient data — current threshold kept',
        slPts:    bestParams.slPts,
        minScore: bestParams.minScore,
        slPtsSource: bestParams._slPtsSource ?? 'default',
        sourceWinRate: bestParams._sourceWinRate,
      },
      validation,
      improvement: {
        thresholdDelta:   finalThreshold != null ? finalThreshold - currentThreshold : 0,
        slPtsDelta:       bestParams.slPts - currentParams.slPts,
        expectedBenefit:  bestBucket
          ? `Trades in best conf bucket: WR=${(bestBucket.win_rate * 100).toFixed(1)}% PF=${bestBucket.profit_factor} n=${bestBucket.trades}`
          : 'Not enough data for projection',
      },
    };

    // Attach for apply phase
    stratReport._finalThreshold = finalThreshold;
    stratReport._bestParams     = bestParams;
    stratReport._currentRunWinRate = runs[0]?.win_rate ?? 0;
    stratReport._currentRunSharpe  = runs[0]?.sharpe  ?? 0;
    stratReport._totalBacktestTrades = segments.totalTrades;
    stratReport._bestConfBucketWr   = bestBucket?.win_rate ?? 0;

    report.strategies[strategyName] = stratReport;
  }

  // ── Phase 8: Apply if requested + validated ──────────────────────────────
  const appliedResults = {};

  if (apply) {
    for (const [strategyName, strat] of Object.entries(report.strategies)) {
      if (!strat.validation.valid) {
        appliedResults[strategyName] = { skipped: true, reason: strat.validation.issues };
        continue;
      }

      const subReport = {
        totalBacktestTrades: strat._totalBacktestTrades,
        currentRunWinRate:   strat._currentRunWinRate,
        currentRunSharpe:    strat._currentRunSharpe,
        bestConfBucketWr:    strat._bestConfBucketWr,
      };

      const results = applyConfig(
        db,
        strategyName,
        strat._finalThreshold,
        strat._bestParams,
        subReport,
      );
      appliedResults[strategyName] = { applied: true, results };
    }
    report.applied = true;
    report.appliedResults = appliedResults;
  }

  report.elapsed_ms = Date.now() - startMs;

  // ── Summary ─────────────────────────────────────────────────────────────
  report.summary = {
    tablesQueried: ['backtest_runs', 'backtest_details', 'backtest_trades', 'optimization_runs', 'signals', 'outcomes'],
    validRunsAnalyzed:          report.dataSources.totalValidRuns,
    zeroTradeRunsExcluded:      report.dataSources.zeroTradeRunsExcluded,
    totalBacktestTradesAnalyzed: report.dataSources.totalBacktestTrades,
    mnq_intraday: {
      bestSetup:            report.strategies.MNQ_INTRADAY?.segments?.bestSetups?.[0]?.setup ?? 'N/A',
      bestRegime:           report.strategies.MNQ_INTRADAY?.segments?.bestSetups?.[0]?.regime ?? 'N/A',
      suggestedThreshold:   report.strategies.MNQ_INTRADAY?.optimizedConfig?.liveThreshold,
      suggestedSlPts:       report.strategies.MNQ_INTRADAY?.optimizedConfig?.slPts,
      backtest_trades:      report.strategies.MNQ_INTRADAY?.data?.totalBacktestTrades,
      live_trades:          report.strategies.MNQ_INTRADAY?.data?.liveTrades,
      validationPassed:     report.strategies.MNQ_INTRADAY?.validation?.valid,
    },
    mgc_scalp: {
      bestSetup:            report.strategies.MGC_SCALP?.segments?.bestSetups?.[0]?.setup ?? 'N/A',
      bestRegime:           report.strategies.MGC_SCALP?.segments?.bestSetups?.[0]?.regime ?? 'N/A',
      suggestedThreshold:   report.strategies.MGC_SCALP?.optimizedConfig?.liveThreshold,
      suggestedSlPts:       report.strategies.MGC_SCALP?.optimizedConfig?.slPts,
      backtest_trades:      report.strategies.MGC_SCALP?.data?.totalBacktestTrades,
      live_trades:          report.strategies.MGC_SCALP?.data?.liveTrades,
      validationPassed:     report.strategies.MGC_SCALP?.validation?.valid,
    },
    rollbackPlan: 'Call POST /api/thresholds/rollback/:id to revert threshold changes. ' +
                  'For params: query strategy_revisions WHERE status=\'active\' ORDER BY revised_at DESC, ' +
                  'restore old_params_json via POST /api/backtest/mine-data/rollback',
    remainingRisks: [
      'Backtest is in-sample: these params were found on historical data; real edge may differ',
      'Low live trade count (<10) means live performance stats have wide confidence intervals',
      'Threshold changes take effect immediately; monitor for 48h before raising further',
      'Session and regime filters are advisory only — hardcoded strategy gates still apply',
    ],
  };

  return report;
}

module.exports = { mine };
