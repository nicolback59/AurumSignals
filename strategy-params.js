'use strict';

const { runBacktest, compositeFitness } = require('./backtest-engine');

// ── Default parameters per instrument ────────────────────────────────────────
const DEFAULT_PARAMS = {
  MNQ: {
    slPts: 25, minScore: 16, oteHigh: 0.786, oteLow: 0.618,
    swingLook: 20, stdvLen: 20, std2: 2.0, std1: 1.0,
    htfEmaF: 9, htfEmaS: 21, atrLen: 14, swingL: 7,
    emaF: 9, emaS: 21, emaT: 50, volFilter: 1.20,
    swing_minScore: 28,
  },
  MGC: {
    slPts: 10, minScore: 14, oteHigh: 0.786, oteLow: 0.618,
    swingLook: 15, stdvLen: 14, std2: 2.0, std1: 1.0,
    htfEmaF: 9, htfEmaS: 21, atrLen: 14, swingL: 5,
    emaF: 9, emaS: 21, emaT: 50, volFilter: 1.15,
    swing_minScore: 99,  // MGC stays scalp-only
  },
};

// Hard bounds — instrument-specific, never exceeded by the optimizer
const PARAM_BOUNDS = {
  MNQ: {
    slPts:          { min: 15,    max: 50    },
    minScore:       { min: 12,    max: 26    },
    oteHigh:        { min: 0.72,  max: 0.92  },
    oteLow:         { min: 0.50,  max: 0.72  },
    stdvLen:        { min: 10,    max: 40    },
    std2:           { min: 1.5,   max: 3.0   },
    std1:           { min: 0.75,  max: 1.50  },
    htfEmaF:        { min: 5,     max: 15    },
    htfEmaS:        { min: 15,    max: 35    },
    swingLook:      { min: 10,    max: 40    },
    swingL:         { min: 4,     max: 12    },
    atrLen:         { min: 8,     max: 21    },
    volFilter:      { min: 1.0,   max: 1.80  },
    swing_minScore: { min: 24,    max: 36    },
  },
  MGC: {
    slPts:      { min: 5,     max: 20    },
    minScore:   { min: 10,    max: 22    },
    oteHigh:    { min: 0.72,  max: 0.92  },
    oteLow:     { min: 0.50,  max: 0.72  },
    stdvLen:    { min: 8,     max: 30    },
    std2:       { min: 1.5,   max: 2.8   },
    std1:       { min: 0.75,  max: 1.25  },
    htfEmaF:    { min: 5,     max: 12    },
    htfEmaS:    { min: 12,    max: 28    },
    swingLook:  { min: 8,     max: 25    },
    swingL:     { min: 3,     max: 8     },
    atrLen:     { min: 8,     max: 18    },
    volFilter:  { min: 1.0,   max: 1.60  },
  },
};

// Optimizer control knobs
const SAFEGUARDS = {
  minTrades:          50,    // minimum trades for statistical validity
  minFitnessGain:     0.015, // minimum composite fitness improvement to accept revision
  minWinRateGain:     0.02,  // absolute win-rate improvement floor (2 pp)
  oosMaxDivergence:   0.12,  // IS vs OOS win-rate gap that triggers overfitting rejection
  cooldownHours:      2,     // minimum hours between revisions
  perturbTrials:      50,    // neighbourhood candidates per cycle
  topK:               5,     // keep top-K candidates for tournament selection
  maxScoreShift:      5,     // minScore can't shift more than ±5 per revision
};

// ── Param helpers ─────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

/**
 * Perturb a parameter set within instrument-specific bounds.
 * Covers more parameters than the previous version for richer search space.
 */
function perturbParams(params, instrument) {
  const bounds = PARAM_BOUNDS[instrument] ?? PARAM_BOUNDS.MNQ;

  const perturb = (key, isInt = false) => {
    const b = bounds[key];
    if (!b) return params[key];
    const range = b.max - b.min;
    // ±15% of the parameter range per perturbation
    const step  = range * 0.15;
    const raw   = (params[key] ?? DEFAULT_PARAMS[instrument]?.[key] ?? (b.min + b.max) / 2)
                  + (Math.random() * 2 - 1) * step;
    const val   = isInt ? Math.round(raw) : +raw.toFixed(3);
    return clamp(val, b.min, b.max);
  };

  return {
    ...params,
    minScore:       perturb('minScore',  true),
    oteHigh:        perturb('oteHigh'),
    oteLow:         perturb('oteLow'),
    std2:           perturb('std2'),
    std1:           perturb('std1'),
    stdvLen:        perturb('stdvLen',   true),
    htfEmaF:        perturb('htfEmaF',  true),
    htfEmaS:        perturb('htfEmaS',  true),
    swingLook:      perturb('swingLook', true),
    swingL:         perturb('swingL',   true),
    atrLen:         perturb('atrLen',   true),
    volFilter:      perturb('volFilter'),
    ...(instrument === 'MNQ' ? { swing_minScore: perturb('swing_minScore', true) } : {}),
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
      (instrument, bars_tested, trades_found, win_rate, profit_factor, sharpe,
       max_drawdown, is_win_rate, oos_win_rate, fitness, params_json, triggered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instrument,
    metrics.barsScanned   ?? 0,
    metrics.tradeCount,
    metrics.winRate,
    metrics.profitFactor,
    metrics.sharpe,
    metrics.maxDrawdown,
    metrics.isWinRate     ?? null,
    metrics.oosWinRate    ?? null,
    metrics.fitness       ?? null,
    JSON.stringify(params),
    triggeredBy,
  );
  return info.lastInsertRowid;
}

function saveRevision(db, instrument, oldParams, newParams, oldMetrics, newMetrics, runId, status = 'shadow') {
  const wrBefore  = (oldMetrics.winRate * 100).toFixed(1);
  const wrAfter   = (newMetrics.winRate * 100).toFixed(1);
  const oosBefore = oldMetrics.oosWinRate != null ? (oldMetrics.oosWinRate * 100).toFixed(1) : '?';
  const oosAfter  = newMetrics.oosWinRate != null ? (newMetrics.oosWinRate * 100).toFixed(1) : '?';
  const reason = `win_rate ${wrBefore}%→${wrAfter}% | OOS ${oosBefore}%→${oosAfter}% | ` +
                 `sharpe ${oldMetrics.sharpe?.toFixed(2)}→${newMetrics.sharpe?.toFixed(2)} | ` +
                 `fitness ${(oldMetrics.fitness ?? 0).toFixed(3)}→${(newMetrics.fitness ?? 0).toFixed(3)} | ` +
                 `trades=${newMetrics.tradeCount}`;
  db.prepare(`
    INSERT INTO strategy_revisions
      (instrument, reason, old_params_json, new_params_json, backtest_run_id,
       win_rate_before, win_rate_after, status)
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
/**
 * Decide whether a candidate parameter set is genuinely better.
 * Uses composite fitness as primary metric, with guard rails on:
 *   – minimum trade count
 *   – minimum win-rate improvement
 *   – maximum IS/OOS divergence (anti-overfitting)
 */
function validateImprovement(oldM, newM) {
  if (newM.tradeCount < SAFEGUARDS.minTrades) return false;

  // Must improve composite fitness
  const oldFit = oldM.fitness ?? compositeFitness(oldM);
  const newFit = newM.fitness ?? compositeFitness(newM);
  if (newFit - oldFit < SAFEGUARDS.minFitnessGain) return false;

  // Must improve win rate
  if (newM.winRate - oldM.winRate < SAFEGUARDS.minWinRateGain) return false;

  // Hard floor: never allow below 45% win rate
  if (newM.winRate < 0.45) return false;

  // Anti-overfitting: OOS win rate must not diverge too far from IS
  if (newM.oosWinRate != null && newM.isWinRate != null) {
    if (Math.abs(newM.isWinRate - newM.oosWinRate) > SAFEGUARDS.oosMaxDivergence) return false;
  }

  return true;
}

// ── Core: propose a parameter revision via neighbourhood search ───────────────
/**
 * Generates SAFEGUARDS.perturbTrials random candidates, evaluates each with
 * the full walk-forward backtest, picks the top-K by composite fitness,
 * validates against the current params, and saves the best as a shadow revision.
 *
 * Returns the best candidate metrics (or null if no valid improvement found).
 */
function proposeRevision(db, instrument, bars1m, runId) {
  // Cooldown guard
  const lastRevMs = getLastRevisionTime(db, instrument);
  if (Date.now() - lastRevMs < SAFEGUARDS.cooldownHours * 3_600_000) return null;

  const currentParams = getParams(db, instrument);
  const { metrics: currentMetrics } = runBacktest(bars1m, currentParams, {
    instrument, cooldown: 1,
  });

  // Generate candidates
  const candidates = Array.from({ length: SAFEGUARDS.perturbTrials }, () =>
    perturbParams(currentParams, instrument)
  );

  // Evaluate all candidates
  const results = candidates.map(p => {
    const { metrics } = runBacktest(bars1m, p, { instrument, cooldown: 1 });
    return { params: p, metrics };
  });

  // Tournament selection: rank by composite fitness, take top-K
  results.sort((a, b) => (b.metrics.fitness ?? 0) - (a.metrics.fitness ?? 0));
  const topK = results.slice(0, SAFEGUARDS.topK);

  // Find the best that genuinely passes all validation gates
  const best = topK.find(c => validateImprovement(currentMetrics, c.metrics));
  if (!best) return null;

  saveRevision(db, instrument, currentParams, best.params,
               currentMetrics, best.metrics, runId, 'shadow');
  return best;
}

/**
 * Re-evaluate a pending shadow revision against fresh data.
 * Promote to active if it still beats current params; discard otherwise.
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

  const { metrics: currentM } = runBacktest(bars1m, currentParams, { instrument, cooldown: 1 });
  const { metrics: shadowM  } = runBacktest(bars1m, shadowParams,  { instrument, cooldown: 1 });

  if (validateImprovement(currentM, shadowM)) {
    saveParams(db, instrument, shadowParams);
    db.prepare(`UPDATE strategy_revisions SET status = 'active' WHERE id = ?`).run(shadow.id);
    return { promoted: true, before: currentM.winRate, after: shadowM.winRate,
             fitBefore: currentM.fitness, fitAfter: shadowM.fitness };
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
