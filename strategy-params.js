'use strict';

const { runBacktest } = require('./backtest-engine');

// ── Default parameters per instrument ────────────────────────────────────────
const DEFAULT_PARAMS = {
  MNQ: {
    slPts: 25, minScore: 16, oteHigh: 0.786, oteLow: 0.618,
    swingLook: 20, stdvLen: 20, std2: 2.0, std1: 1.0,
    htfEmaF: 9, htfEmaS: 21, atrLen: 14, swingL: 7,
    emaF: 9, emaS: 21, emaT: 50,
  },
  MGC: {
    slPts: 15, minScore: 14, oteHigh: 0.786, oteLow: 0.618,
    swingLook: 15, stdvLen: 15, std2: 2.0, std1: 1.0,
    htfEmaF: 9, htfEmaS: 21, atrLen: 14, swingL: 5,
    emaF: 9, emaS: 21, emaT: 50,
  },
};

// Hard bounds — strategy adjustments never exceed these limits
const PARAM_BOUNDS = {
  slPts:     { min: 15,   max: 50    },
  minScore:  { min: 12,   max: 26    },
  oteHigh:   { min: 0.72, max: 0.92  },
  oteLow:    { min: 0.50, max: 0.70  },
  stdvLen:   { min: 10,   max: 40    },
  std2:      { min: 1.5,  max: 3.0   },
  htfEmaF:   { min: 5,    max: 15    },
  htfEmaS:   { min: 15,   max: 35    },
};

// Safeguards for autonomous revisions
const SAFEGUARDS = {
  minTrades:        20,    // backtest must find at least this many trades
  minWinRateGain:   0.05,  // 5 percentage-point absolute improvement required
  minSharpeDelta:   0.10,  // Sharpe ratio must improve by at least this much
  cooldownHours:    6,     // minimum hours between revisions
  maxScoreShift:    4,     // minScore can't shift more than ±4 per revision
  perturbTrials:    15,    // neighborhood search candidates per cycle
};

// ── Param helpers ─────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function perturbParams(params, instrument) {
  const base    = DEFAULT_PARAMS[instrument] ?? DEFAULT_PARAMS.MNQ;
  const perturb = (key, delta) => {
    const b = PARAM_BOUNDS[key];
    if (!b) return params[key];
    const step = (b.max - b.min) * 0.12;  // ±12% of range
    const raw  = params[key] + (Math.random() * 2 - 1) * step;
    const val  = Number(raw.toFixed(3));
    return clamp(val, b.min, b.max);
  };
  return {
    ...params,
    minScore:  clamp(Math.round(perturb('minScore')),  PARAM_BOUNDS.minScore.min,  PARAM_BOUNDS.minScore.max),
    oteHigh:   perturb('oteHigh'),
    oteLow:    perturb('oteLow'),
    std2:      perturb('std2'),
    htfEmaF:   clamp(Math.round(perturb('htfEmaF')),   PARAM_BOUNDS.htfEmaF.min,   PARAM_BOUNDS.htfEmaF.max),
    htfEmaS:   clamp(Math.round(perturb('htfEmaS')),   PARAM_BOUNDS.htfEmaS.min,   PARAM_BOUNDS.htfEmaS.max),
    stdvLen:   clamp(Math.round(perturb('stdvLen')),   PARAM_BOUNDS.stdvLen.min,   PARAM_BOUNDS.stdvLen.max),
  };
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

function saveBacktestRun(db, instrument, params, metrics, triggeredBy = 'scheduled') {
  const info = db.prepare(`
    INSERT INTO backtest_runs
      (instrument, bars_tested, trades_found, win_rate, profit_factor, sharpe, max_drawdown, params_json, triggered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
  return info.lastInsertRowid;
}

function saveRevision(db, instrument, oldParams, newParams, oldMetrics, newMetrics, runId, status = 'shadow') {
  const improvement = ((newMetrics.winRate - oldMetrics.winRate) * 100).toFixed(1);
  const reason = `win_rate +${improvement}% (${(oldMetrics.winRate * 100).toFixed(1)}→${(newMetrics.winRate * 100).toFixed(1)}%), ` +
                 `sharpe ${oldMetrics.sharpe.toFixed(2)}→${newMetrics.sharpe.toFixed(2)}, ` +
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

// ── Core: decide whether to propose a revision ────────────────────────────────
function validateImprovement(oldM, newM) {
  if (newM.tradeCount < SAFEGUARDS.minTrades)       return false;
  if (newM.winRate - oldM.winRate < SAFEGUARDS.minWinRateGain) return false;
  if (newM.sharpe  - oldM.sharpe  < SAFEGUARDS.minSharpeDelta) return false;
  if (newM.winRate < 0.45)                          return false;  // floor: never below 45%
  return true;
}

/**
 * Run neighborhood search and, if a better param set is found, save it as shadow.
 * Returns the best candidate metrics (or null if no improvement found).
 */
function proposeRevision(db, instrument, bars1m, runId) {
  // Cooldown check
  const lastRevMs = getLastRevisionTime(db, instrument);
  if (Date.now() - lastRevMs < SAFEGUARDS.cooldownHours * 3_600_000) return null;

  const currentParams  = getParams(db, instrument);
  const currentMetrics = runBacktest(bars1m, currentParams, { cooldown: 1 }).metrics;

  // Generate and evaluate candidates
  const candidates = Array.from({ length: SAFEGUARDS.perturbTrials }, () =>
    perturbParams(currentParams, instrument)
  );
  const results = candidates.map(p => ({
    params:  p,
    metrics: runBacktest(bars1m, p, { cooldown: 1 }).metrics,
  }));

  const best = results.reduce((a, b) =>
    b.metrics.winRate > a.metrics.winRate && validateImprovement(currentMetrics, b.metrics) ? b : a,
    { metrics: { winRate: -1 } }
  );

  if (best.metrics.winRate < 0) return null;  // no improvement found

  saveRevision(db, instrument, currentParams, best.params, currentMetrics, best.metrics, runId, 'shadow');
  return best;
}

/**
 * Evaluate any pending shadow revision. Promote if still better, discard if not.
 */
function evaluateShadow(db, instrument, bars1m) {
  const shadow = db.prepare(`
    SELECT * FROM strategy_revisions
    WHERE instrument = ? AND status = 'shadow'
    ORDER BY revised_at DESC LIMIT 1
  `).get(instrument);
  if (!shadow) return null;

  const currentParams = getParams(db, instrument);
  const shadowParams  = JSON.parse(shadow.new_params_json);

  const currentM = runBacktest(bars1m, currentParams, { cooldown: 1 }).metrics;
  const shadowM  = runBacktest(bars1m, shadowParams,  { cooldown: 1 }).metrics;

  if (validateImprovement(currentM, shadowM)) {
    // Promote: update active params and mark revision active
    saveParams(db, instrument, shadowParams);
    db.prepare(`UPDATE strategy_revisions SET status = 'active' WHERE id = ?`).run(shadow.id);
    return { promoted: true, before: currentM.winRate, after: shadowM.winRate };
  } else {
    db.prepare(`UPDATE strategy_revisions SET status = 'discarded' WHERE id = ?`).run(shadow.id);
    return { promoted: false };
  }
}

module.exports = {
  DEFAULT_PARAMS, PARAM_BOUNDS, SAFEGUARDS,
  getParams, saveParams, saveBacktestRun, saveRevision,
  perturbParams, validateImprovement, proposeRevision, evaluateShadow,
};
