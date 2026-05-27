'use strict';

const { runBacktest } = require('./backtest-engine');

// ── Default parameters per instrument ────────────────────────────────────────
const DEFAULT_PARAMS = {
  MNQ: {
    slPts: 25, minScore: 8, oteHigh: 0.786, oteLow: 0.618,
    swingLook: 20, stdvLen: 20, std2: 2.0, std1: 1.0,
    htfEmaF: 9, htfEmaS: 21, atrLen: 14, swingL: 7,
    emaF: 9, emaS: 21, emaT: 50,
    instrument: 'MNQ', tradeStyleMode: 'auto',
  },
  MGC: {
    slPts: 12, minScore: 8, oteHigh: 0.786, oteLow: 0.618,
    swingLook: 15, stdvLen: 15, std2: 2.0, std1: 1.0,
    htfEmaF: 9, htfEmaS: 21, atrLen: 14, swingL: 5,
    emaF: 9, emaS: 21, emaT: 50,
    instrument: 'MGC', tradeStyleMode: 'scalp',
  },
};

// Per-style defaults for MNQ — optimizer uses these as starting points
const DEFAULT_PARAMS_BY_STYLE = {
  MNQ_SCALP: {
    ...DEFAULT_PARAMS.MNQ,
    slPts: 16, minScore: 7, stdvLen: 15, std2: 2.2, swingLook: 15,
    tradeStyleMode: 'scalp',
  },
  MNQ_INTRADAY: {
    ...DEFAULT_PARAMS.MNQ,
    slPts: 28, minScore: 8, stdvLen: 20, std2: 2.0,
    tradeStyleMode: 'intraday',
  },
  MGC_SCALP: {
    ...DEFAULT_PARAMS.MGC,
    slPts: 10, minScore: 7, stdvLen: 12, std2: 2.2, swingLook: 12,
    tradeStyleMode: 'scalp',
  },
  NQ_NY_OPEN: {
    ...DEFAULT_PARAMS.MNQ,
    // NQ NY Open is an opening auction model — params control the scoring weights
    // and entry trigger sensitivity, NOT the generic intraday EMA stack
    slPts: 20, minScore: 6, stdvLen: 14, std2: 2.0, swingLook: 10, swingL: 5,
    tradeStyleMode: 'ny_open',
    instrument: 'MNQ',
  },
};

// Hard bounds — adjustments never exceed these limits
const PARAM_BOUNDS = {
  slPts:     { min: 10,   max: 60    },
  minScore:  { min: 6,    max: 20    },
  oteHigh:   { min: 0.72, max: 0.92  },
  oteLow:    { min: 0.50, max: 0.72  },
  stdvLen:   { min: 8,    max: 40    },
  std2:      { min: 1.5,  max: 3.0   },
  htfEmaF:   { min: 5,    max: 15    },
  htfEmaS:   { min: 15,   max: 35    },
  swingLook: { min: 10,   max: 35    },
  swingL:    { min: 4,    max: 12    },
  swingTp1:  { min: 30,   max: 80    },
  swingTp2:  { min: 60,   max: 150   },
  swingTp3:  { min: 100,  max: 220   },
};

// Safeguards for autonomous revisions
const SAFEGUARDS = {
  minTrades:        15,    // backtest must find at least this many trades
  minWinRateGain:   0.025, // 2.5pp absolute improvement required
  minSharpeDelta:   0.06,  // Sharpe ratio must improve by at least this much
  cooldownHours:    6,     // minimum hours between revisions
  maxScoreShift:    4,     // minScore can't shift more than ±4 per revision
  perturbTrials:    80,    // total candidates per cycle (perturbation + crossover)
  eliteCount:       5,     // top-N kept for crossover breeding
};

// ── Param helpers ─────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function perturbParams(params) {
  const perturb = key => {
    const b = PARAM_BOUNDS[key];
    if (!b || params[key] === undefined) return params[key];
    const step = (b.max - b.min) * 0.12;
    const raw  = params[key] + (Math.random() * 2 - 1) * step;
    return Number(raw.toFixed(3));
  };
  return {
    ...params,
    slPts:     clamp(Math.round(perturb('slPts')),     PARAM_BOUNDS.slPts.min,     PARAM_BOUNDS.slPts.max),
    minScore:  clamp(Math.round(perturb('minScore')),  PARAM_BOUNDS.minScore.min,  PARAM_BOUNDS.minScore.max),
    oteHigh:   clamp(perturb('oteHigh'),               PARAM_BOUNDS.oteHigh.min,   PARAM_BOUNDS.oteHigh.max),
    oteLow:    clamp(perturb('oteLow'),                PARAM_BOUNDS.oteLow.min,    PARAM_BOUNDS.oteLow.max),
    std2:      clamp(perturb('std2'),                  PARAM_BOUNDS.std2.min,      PARAM_BOUNDS.std2.max),
    htfEmaF:   clamp(Math.round(perturb('htfEmaF')),   PARAM_BOUNDS.htfEmaF.min,   PARAM_BOUNDS.htfEmaF.max),
    htfEmaS:   clamp(Math.round(perturb('htfEmaS')),   PARAM_BOUNDS.htfEmaS.min,   PARAM_BOUNDS.htfEmaS.max),
    stdvLen:   clamp(Math.round(perturb('stdvLen')),   PARAM_BOUNDS.stdvLen.min,   PARAM_BOUNDS.stdvLen.max),
    swingLook: clamp(Math.round(perturb('swingLook')), PARAM_BOUNDS.swingLook.min, PARAM_BOUNDS.swingLook.max),
    swingL:    clamp(Math.round(perturb('swingL')),    PARAM_BOUNDS.swingL.min,    PARAM_BOUNDS.swingL.max),
    ...(params.swingTp1 !== undefined ? {
      swingTp1: clamp(Math.round(perturb('swingTp1')), PARAM_BOUNDS.swingTp1.min, PARAM_BOUNDS.swingTp1.max),
      swingTp2: clamp(Math.round(perturb('swingTp2')), PARAM_BOUNDS.swingTp2.min, PARAM_BOUNDS.swingTp2.max),
      swingTp3: clamp(Math.round(perturb('swingTp3')), PARAM_BOUNDS.swingTp3.min, PARAM_BOUNDS.swingTp3.max),
    } : {}),
  };
}

/**
 * Genetic crossover: randomly mix genes from two parent param sets.
 * Each numeric param is independently taken from either p1 or p2 with 50/50 odds,
 * then lightly perturbed to introduce variation.
 */
function crossoverParams(p1, p2) {
  const child = { ...p1 };
  for (const key of Object.keys(PARAM_BOUNDS)) {
    if (p1[key] === undefined || p2[key] === undefined) continue;
    const chosen = Math.random() < 0.5 ? p1[key] : p2[key];
    const b = PARAM_BOUNDS[key];
    // Small perturbation (±5% of range) on top of crossover
    const micro = (b.max - b.min) * 0.05 * (Math.random() * 2 - 1);
    const raw = chosen + micro;
    const isInt = Number.isInteger(p1[key]);
    child[key] = isInt
      ? clamp(Math.round(raw), b.min, b.max)
      : clamp(+raw.toFixed(3), b.min, b.max);
  }
  return child;
}

/**
 * Generate a pool of `n` candidate param sets using:
 *   - perturbation of current params (60%)
 *   - crossover between current and default (20%)
 *   - random restart within bounds (20%) for diversity
 */
function generateCandidates(params, instrument, n = 50) {
  const base    = DEFAULT_PARAMS[instrument] ?? DEFAULT_PARAMS.MNQ;
  const nPerturb  = Math.ceil(n * 0.60);
  const nCrossover = Math.ceil(n * 0.20);
  const nRandom   = n - nPerturb - nCrossover;

  const candidates = [];

  // Perturbation pool
  for (let k = 0; k < nPerturb; k++) candidates.push(perturbParams(params));

  // Crossover pool (current × default for regime diversity)
  for (let k = 0; k < nCrossover; k++) candidates.push(crossoverParams(params, base));

  // Random restarts (bounded) for escaping local optima
  for (let k = 0; k < nRandom; k++) {
    const rand = { ...params };
    for (const [key, b] of Object.entries(PARAM_BOUNDS)) {
      if (rand[key] === undefined) continue;
      const isInt = Number.isInteger(rand[key]);
      const v = b.min + Math.random() * (b.max - b.min);
      rand[key] = isInt ? Math.round(v) : +v.toFixed(3);
    }
    candidates.push(rand);
  }

  return candidates;
}

// ── Multi-objective scoring ───────────────────────────────────────────────────
/**
 * Composite score weighting win rate, Sharpe, regime consistency, and trade count.
 * Returns a 0–1 scalar; higher is better.
 * Target: win rate ≥ 0.75 is the 75 % live-signal goal.
 */
function multiObjectiveScore(metrics) {
  if (!metrics || metrics.tradeCount < SAFEGUARDS.minTrades) return 0;

  const wr          = metrics.winRate;
  const sharpe      = Math.min(Math.max(metrics.sharpe, -1), 3);
  const consistency = metrics.regimeConsistency ?? 1;
  const drawdown    = metrics.maxDrawdown ?? 0;

  // Penalise if win rate is below live target (0.75)
  const wrScore     = wr >= 0.75 ? wr : wr * 0.85;
  // Normalise sharpe to 0–1
  const sharpeScore = (sharpe + 1) / 4;
  // Mild penalty for deep drawdown
  const ddPenalty   = Math.max(0, 1 - drawdown * 0.02);

  return +(wrScore * 0.50 + sharpeScore * 0.25 + consistency * 0.15 + ddPenalty * 0.10)
           .toFixed(4);
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function getParams(db, instrument) {
  const row = db.prepare('SELECT params_json FROM strategy_params WHERE instrument = ?').get(instrument);
  if (row) {
    try { return JSON.parse(row.params_json); } catch {}
  }
  return { ...(DEFAULT_PARAMS[instrument] ?? DEFAULT_PARAMS.MNQ) };
}

function saveParams(db, instrument, params) {
  db.prepare(`
    INSERT INTO strategy_params (instrument, params_json, updated_at, version)
    VALUES (?, ?, datetime('now'), 1)
    ON CONFLICT(instrument) DO UPDATE SET
      params_json = excluded.params_json,
      updated_at  = excluded.updated_at,
      version     = version + 1
  `).run(instrument, JSON.stringify(params));
}

/** Per-style param storage — key is e.g. 'MNQ_SCALP', 'MGC_SCALP' */
function getStyleKey(instrument, style) {
  return `${instrument}_${style.toUpperCase()}`;
}

function getStyleParams(db, instrument, style) {
  const key = getStyleKey(instrument, style);
  const row = db.prepare('SELECT params_json FROM style_params WHERE key = ?').get(key);
  if (row) {
    try { return JSON.parse(row.params_json); } catch {}
  }
  return { ...(DEFAULT_PARAMS_BY_STYLE[key] ?? DEFAULT_PARAMS[instrument] ?? DEFAULT_PARAMS.MNQ) };
}

function saveStyleParams(db, instrument, style, params) {
  const key = getStyleKey(instrument, style);
  db.prepare(`
    INSERT INTO style_params (key, params_json, updated_at, version)
    VALUES (?, ?, datetime('now'), 1)
    ON CONFLICT(key) DO UPDATE SET
      params_json = excluded.params_json,
      updated_at  = excluded.updated_at,
      version     = version + 1
  `).run(key, JSON.stringify(params));
}

function saveBacktestRun(db, instrument, params, metrics, triggeredBy = 'scheduled', dataWindow = {}) {
  const info = db.prepare(`
    INSERT INTO backtest_runs
      (instrument, bars_tested, trades_found, win_rate, profit_factor, sharpe, max_drawdown,
       params_json, triggered_by, source_data_start, source_data_end, data_window_label, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instrument,
    metrics.barsScanned ?? 0,
    metrics.tradeCount,
    metrics.winRate,
    metrics.profitFactor,
    metrics.sharpe,
    metrics.maxDrawdown,
    JSON.stringify(params),
    triggeredBy,
    dataWindow.sourceStart ?? null,
    dataWindow.sourceEnd   ?? null,
    dataWindow.label       ?? null,
    dataWindow.mode        ?? 'LIVE',
  );
  return info.lastInsertRowid;
}

function saveBacktestDetails(db, runId, details) {
  db.prepare(`
    INSERT OR REPLACE INTO backtest_details
      (run_id, regime_breakdown, style_breakdown, setup_breakdown,
       walk_forward_consistency, max_win_streak, max_loss_streak,
       slippage_used, cooldown_used, multi_obj_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    JSON.stringify(details.byRegime ?? {}),
    JSON.stringify(details.byStyle  ?? {}),
    JSON.stringify(details.bySetup  ?? {}),
    details.walkForwardConsistency ?? null,
    details.maxWinStreak  ?? null,
    details.maxLossStreak ?? null,
    details.slippageUsed  ?? null,
    details.cooldownUsed  ?? null,
    details.multiObjScore ?? null,
  );
}

function saveRevision(db, instrument, oldParams, newParams, oldMetrics, newMetrics, runId, status = 'shadow') {
  const improvement = ((newMetrics.winRate - oldMetrics.winRate) * 100).toFixed(1);
  const reason =
    `win_rate +${improvement}% (${(oldMetrics.winRate*100).toFixed(1)}→${(newMetrics.winRate*100).toFixed(1)}%), ` +
    `sharpe ${oldMetrics.sharpe.toFixed(2)}→${newMetrics.sharpe.toFixed(2)}, ` +
    `consistency ${(oldMetrics.regimeConsistency ?? 1).toFixed(2)}→${(newMetrics.regimeConsistency ?? 1).toFixed(2)}, ` +
    `trades=${newMetrics.tradeCount}`;
  db.prepare(`
    INSERT INTO strategy_revisions
      (instrument, reason, old_params_json, new_params_json, backtest_run_id, win_rate_before, win_rate_after, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(instrument, reason, JSON.stringify(oldParams), JSON.stringify(newParams), runId,
         oldMetrics.winRate, newMetrics.winRate, status);
}

function getLastRevisionTime(db, instrument) {
  const row = db.prepare(`
    SELECT revised_at FROM strategy_revisions
    WHERE instrument = ? AND status IN ('active','shadow')
    ORDER BY revised_at DESC LIMIT 1
  `).get(instrument);
  return row ? new Date(row.revised_at).getTime() : 0;
}

// ── Improvement validation ────────────────────────────────────────────────────
function validateImprovement(oldM, newM) {
  if (newM.tradeCount < SAFEGUARDS.minTrades)               return false;
  if (newM.winRate - oldM.winRate < SAFEGUARDS.minWinRateGain) return false;
  if (newM.sharpe  - oldM.sharpe  < SAFEGUARDS.minSharpeDelta) return false;
  if (newM.winRate < 0.45)                                   return false;
  // Don't accept lower regime consistency (robustness guard)
  if ((newM.regimeConsistency ?? 1) < (oldM.regimeConsistency ?? 1) - 0.10) return false;
  return true;
}

// ── Core: neighbourhood search with genetic crossover ────────────────────────
/**
 * Generate 50 candidates (perturbation + crossover + random restart),
 * rank them by multi-objective score, save the best as a shadow revision.
 */
function proposeRevision(db, instrument, bars1m, runId, btOpts = {}) {
  // Cooldown check
  const lastRevMs = getLastRevisionTime(db, instrument);
  if (Date.now() - lastRevMs < SAFEGUARDS.cooldownHours * 3_600_000) return null;

  const currentParams  = getParams(db, instrument);
  const currentResult  = runBacktest(bars1m, currentParams,
    { cooldown: btOpts.cooldown ?? 1, slippage: btOpts.slippage ?? 0.5 });
  const currentMetrics = currentResult.metrics;

  // Generate diverse candidate pool
  const candidates = generateCandidates(currentParams, instrument, SAFEGUARDS.perturbTrials);

  // Evaluate all candidates
  const results = candidates.map(p => {
    const r = runBacktest(bars1m, p,
      { cooldown: btOpts.cooldown ?? 1, slippage: btOpts.slippage ?? 0.5 });
    return { params: p, metrics: r.metrics, score: multiObjectiveScore(r.metrics) };
  });

  // Sort by multi-objective score descending
  results.sort((a, b) => b.score - a.score);

  // Elite selection: further crossover among top-N to breed a final candidate
  const elites = results.slice(0, SAFEGUARDS.eliteCount);
  for (let k = 0; k < 5; k++) {
    const p1 = elites[Math.floor(Math.random() * elites.length)].params;
    const p2 = elites[Math.floor(Math.random() * elites.length)].params;
    if (p1 === p2) continue;
    const child = crossoverParams(p1, p2);
    const r = runBacktest(bars1m, child,
      { cooldown: btOpts.cooldown ?? 1, slippage: btOpts.slippage ?? 0.5 });
    results.push({ params: child, metrics: r.metrics, score: multiObjectiveScore(r.metrics) });
  }
  results.sort((a, b) => b.score - a.score);

  const best = results[0];
  if (!best || !validateImprovement(currentMetrics, best.metrics)) return null;

  saveRevision(db, instrument, currentParams, best.params, currentMetrics, best.metrics, runId, 'shadow');
  return best;
}

/**
 * Evaluate any pending shadow revision. Promote if still better, discard otherwise.
 */
function evaluateShadow(db, instrument, bars1m, btOpts = {}) {
  const shadow = db.prepare(`
    SELECT * FROM strategy_revisions
    WHERE instrument = ? AND status = 'shadow'
    ORDER BY revised_at DESC LIMIT 1
  `).get(instrument);
  if (!shadow) return null;

  const currentParams = getParams(db, instrument);
  const shadowParams  = JSON.parse(shadow.new_params_json);
  const innerOpts     = { cooldown: btOpts.cooldown ?? 1, slippage: btOpts.slippage ?? 0.5 };

  const currentM = runBacktest(bars1m, currentParams, innerOpts).metrics;
  const shadowM  = runBacktest(bars1m, shadowParams,  innerOpts).metrics;

  if (validateImprovement(currentM, shadowM)) {
    saveParams(db, instrument, shadowParams);
    db.prepare(`UPDATE strategy_revisions SET status = 'active' WHERE id = ?`).run(shadow.id);
    return { promoted: true, before: currentM.winRate, after: shadowM.winRate };
  } else {
    db.prepare(`UPDATE strategy_revisions SET status = 'discarded' WHERE id = ?`).run(shadow.id);
    return { promoted: false };
  }
}

module.exports = {
  DEFAULT_PARAMS,
  DEFAULT_PARAMS_BY_STYLE,
  PARAM_BOUNDS,
  SAFEGUARDS,
  getParams, saveParams,
  getStyleParams, saveStyleParams,
  saveBacktestRun, saveBacktestDetails,
  saveRevision,
  perturbParams, crossoverParams, generateCandidates,
  multiObjectiveScore, validateImprovement,
  proposeRevision, evaluateShadow,
};
