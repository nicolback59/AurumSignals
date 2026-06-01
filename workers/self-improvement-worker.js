'use strict';

/**
 * SELF-IMPROVEMENT WORKER — Prompt 9 Phase 9
 *
 * Runs Saturday 07:00 UTC — one day after outcome-intelligence-worker (Fri).
 * Reads the latest analysis from every Phase 1–8, 10–13 table and converts
 * findings into prioritised, de-duplicated agent_messages recommendations
 * for the consensus-coordinator to act on.
 *
 * Rule categories (each fires at most once per strategy per run):
 *   RAISE_CONFIDENCE_FLOOR  — conf_low bucket has negative expectancy
 *   BLOCK_SESSION           — session WR < 35% with ≥ 10 resolved trades
 *   BLOCK_REGIME            — regime  WR < 35% with ≥ 10 resolved trades
 *   WIDEN_STOPS             — stop_intelligence_log says WIDEN_STOPS
 *   TIGHTEN_STOPS           — stop_intelligence_log says TIGHTEN_STOPS
 *   INCREASE_TP             — mfe_tp1_efficiency > 1.5 (TP leaving big gains on table)
 *   BLOCK_DIRECTION         — one direction WR < 35% with ≥ 10 trades (MGC review)
 *   DEGRADATION_WARNING     — 2+ DEGRADING dimensions from strategy_evolution_log
 *   TP_UNREALISTIC_50PT     — MNQ_50PT mfe reach pct < 40%
 *
 * All fired recommendations are written to self_improvement_log and posted
 * to agent_messages (from_agent = 'self-improvement', to_agent = 'consensus').
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'self-improvement';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

function postMessage(db, strategy, recommendation, dimension, evidence, priority) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('self-improvement', 'consensus', 'recommendation', ?, ?, ?)
    `).run(strategy, JSON.stringify({ recommendation, dimension, evidence }), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

function logImprovement(db, runDate, strategy, recommendation, dimension, evidence, priority) {
  try {
    db.prepare(`
      INSERT INTO self_improvement_log
        (run_date, strategy_name, recommendation, dimension, evidence, priority, message_posted, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(run_date, strategy_name, recommendation, dimension) DO UPDATE SET
        evidence       = excluded.evidence,
        priority       = excluded.priority,
        message_posted = 1
    `).run(runDate, strategy, recommendation, dimension ?? null, JSON.stringify(evidence), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] self_improvement_log insert failed: ${err.message}`);
  }
}

function fire(db, runDate, strategy, recommendation, dimension, evidence, priority) {
  logImprovement(db, runDate, strategy, recommendation, dimension, evidence, priority);
  postMessage(db, strategy, recommendation, dimension, evidence, priority);
  console.log(`[${WORKER_NAME}] ${strategy} → ${recommendation}${dimension ? ` [${dimension}]` : ''} (priority ${priority})`);
}

// Returns the most recent outcome_intelligence_log row matching phase + metric_key for a strategy.
function getMetric(db, strategy, phase, metricKey) {
  return db.prepare(`
    SELECT metric_value, metric_json, sample_size, notes
    FROM outcome_intelligence_log
    WHERE strategy_name = ? AND phase = ? AND metric_key = ?
    ORDER BY run_date DESC LIMIT 1
  `).get(strategy, phase, metricKey);
}

function runStrategy(db, runDate, strategy) {
  // ── Rule 1: RAISE_CONFIDENCE_FLOOR ─────────────────────────────────────────
  // Phase 8 expectancy: conf_low bucket has negative avg_pnl
  const confLow = getMetric(db, strategy, 'expectancy', 'conf_low');
  if (confLow && (confLow.metric_value ?? 0) < 0 && (confLow.sample_size ?? 0) >= 5) {
    fire(db, runDate, strategy, 'RAISE_CONFIDENCE_FLOOR', null, {
      source: 'phase8_expectancy',
      conf_low_avg_pnl: confLow.metric_value,
      trade_count: confLow.sample_size,
      suggestion: 'Low-confidence signals have negative expectancy — consider raising minimum confidence threshold',
    }, 2);
  }

  // ── Rule 2: BLOCK_SESSION ───────────────────────────────────────────────────
  // Phase 10 session: WR < 35% with ≥ 10 resolved trades
  const sessionRows = db.prepare(`
    SELECT metric_key, metric_value, metric_json, sample_size
    FROM outcome_intelligence_log
    WHERE strategy_name = ? AND phase = 'session'
    ORDER BY run_date DESC, metric_key
  `).all(strategy);

  // Deduplicate to latest run_date per metric_key
  const latestSessions = {};
  for (const r of sessionRows) {
    if (!latestSessions[r.metric_key]) latestSessions[r.metric_key] = r;
  }
  for (const [key, r] of Object.entries(latestSessions)) {
    const parsed = r.metric_json ? JSON.parse(r.metric_json) : null;
    const tradeCount = parsed?.trade_count ?? r.sample_size ?? 0;
    if ((r.metric_value ?? 1) < 0.35 && tradeCount >= 10) {
      fire(db, runDate, strategy, 'BLOCK_SESSION', key, {
        source: 'phase10_session', session: key, wr: r.metric_value, trade_count: tradeCount,
        suggestion: `Session "${key}" has WR ${(r.metric_value * 100).toFixed(1)}% — consider blocking new signals in this session`,
      }, 2);
    }
  }

  // ── Rule 3: BLOCK_REGIME ────────────────────────────────────────────────────
  // Phase 9 regime: WR < 35% with ≥ 10 resolved trades
  const regimeRows = db.prepare(`
    SELECT metric_key, metric_value, metric_json, sample_size
    FROM outcome_intelligence_log
    WHERE strategy_name = ? AND phase = 'regime'
    ORDER BY run_date DESC, metric_key
  `).all(strategy);

  const latestRegimes = {};
  for (const r of regimeRows) {
    if (!latestRegimes[r.metric_key]) latestRegimes[r.metric_key] = r;
  }
  for (const [key, r] of Object.entries(latestRegimes)) {
    const parsed = r.metric_json ? JSON.parse(r.metric_json) : null;
    const tradeCount = parsed?.trade_count ?? r.sample_size ?? 0;
    if ((r.metric_value ?? 1) < 0.35 && tradeCount >= 10) {
      fire(db, runDate, strategy, 'BLOCK_REGIME', key, {
        source: 'phase9_regime', regime: key, wr: r.metric_value, trade_count: tradeCount,
        suggestion: `Regime "${key}" has WR ${(r.metric_value * 100).toFixed(1)}% — consider blocking signals in this regime`,
      }, 2);
    }
  }

  // ── Rule 4 & 5: WIDEN_STOPS / TIGHTEN_STOPS ────────────────────────────────
  // Reads most recent stop_intelligence_log row for this strategy
  const stopRow = db.prepare(`
    SELECT recommendation, optimal_sl_atr_ratio, current_sl_atr_ratio,
           near_stop_loss_pct, recoverable_loss_pct, trade_count
    FROM stop_intelligence_log
    WHERE strategy_name = ?
    ORDER BY run_date DESC LIMIT 1
  `).get(strategy);

  if (stopRow && stopRow.recommendation && stopRow.recommendation !== 'OPTIMAL') {
    const recKey = stopRow.recommendation === 'WIDEN_STOPS' ? 'WIDEN_STOPS' : 'TIGHTEN_STOPS';
    fire(db, runDate, strategy, recKey, null, {
      source: 'phase5_stop_optimizer',
      optimal_sl_atr_ratio: stopRow.optimal_sl_atr_ratio,
      current_sl_atr_ratio: stopRow.current_sl_atr_ratio,
      near_stop_loss_pct: stopRow.near_stop_loss_pct,
      recoverable_loss_pct: stopRow.recoverable_loss_pct,
      trade_count: stopRow.trade_count,
    }, 2);
  }

  // ── Rule 6: INCREASE_TP ─────────────────────────────────────────────────────
  // Phase 2 MFE/MAE ext: mfe_tp1_efficiency > 1.5 (winners regularly go far past TP1)
  const effRow = getMetric(db, strategy, 'mfe_mae_ext', 'mfe_tp1_efficiency');
  if (effRow && (effRow.metric_value ?? 0) > 1.5 && (effRow.sample_size ?? 0) >= 5) {
    fire(db, runDate, strategy, 'INCREASE_TP', null, {
      source: 'phase2_mfe_ext',
      mfe_tp1_efficiency: effRow.metric_value,
      trade_count: effRow.sample_size,
      suggestion: `Winners average ${(effRow.metric_value * 100).toFixed(0)}% of TP1 distance in MFE — TP target is too conservative`,
    }, 3);
  }

  // ── Rule 7: DEGRADATION_WARNING ────────────────────────────────────────────
  // strategy_evolution_log: 2+ DEGRADING dimensions in most recent run
  const degradedRows = db.prepare(`
    SELECT dimension, dimension_value, recent_wr, prior_wr, wr_delta, recent_trades
    FROM strategy_evolution_log
    WHERE strategy_name = ? AND trend = 'DEGRADING'
    ORDER BY run_date DESC
    LIMIT 20
  `).all(strategy);

  // Keep only most-recent entry per dimension_value
  const latestDegraded = {};
  for (const r of degradedRows) {
    const k = `${r.dimension}:${r.dimension_value}`;
    if (!latestDegraded[k]) latestDegraded[k] = r;
  }
  const degradedList = Object.values(latestDegraded);
  if (degradedList.length >= 2) {
    fire(db, runDate, strategy, 'DEGRADATION_WARNING', null, {
      source: 'phase12_strategy_evolution',
      degraded_count: degradedList.length,
      dimensions: degradedList.map(r => ({
        dimension: r.dimension, value: r.dimension_value,
        recent_wr: r.recent_wr, prior_wr: r.prior_wr, delta: r.wr_delta,
      })),
      suggestion: `${degradedList.length} archetypes/regimes are degrading simultaneously — review strategy parameters`,
    }, 1);
  }
}

function runMgcRules(db, runDate) {
  // ── Rule 8: BLOCK_DIRECTION (MGC only) ─────────────────────────────────────
  // Phase 6 mgc_review: direction WR < 35% with ≥ 10 trades
  for (const dir of ['long', 'short']) {
    const row = getMetric(db, 'MGC_SCALP', 'mgc_review', `direction_${dir}`);
    if (!row) continue;
    const parsed = row.metric_json ? JSON.parse(row.metric_json) : null;
    const tradeCount = parsed?.trade_count ?? row.sample_size ?? 0;
    if ((row.metric_value ?? 1) < 0.35 && tradeCount >= 10) {
      fire(db, runDate, 'MGC_SCALP', 'BLOCK_DIRECTION', dir.toUpperCase(), {
        source: 'phase6_mgc_review', direction: dir.toUpperCase(),
        wr: row.metric_value, trade_count: tradeCount,
        suggestion: `MGC_SCALP ${dir.toUpperCase()} has WR ${(row.metric_value * 100).toFixed(1)}% — consider blocking ${dir.toUpperCase()} signals`,
      }, 2);
    }
  }
}

function runMnq50PtRules(db, runDate) {
  // ── Rule 9: TP_UNREALISTIC_50PT ────────────────────────────────────────────
  // Phase 7 mnq_review: 50pt_mfe_reach_pct < 0.40
  const row = getMetric(db, 'MNQ_50PT', 'mnq_review', '50pt_mfe_reach_pct');
  if (!row) return;
  const parsed = row.metric_json ? JSON.parse(row.metric_json) : null;
  if ((row.metric_value ?? 1) < 0.40 && (parsed?.sample ?? row.sample_size ?? 0) >= 5) {
    fire(db, runDate, 'MNQ_50PT', 'TP_UNREALISTIC_50PT', null, {
      source: 'phase7_mnq_review',
      mfe_reach_pct: row.metric_value,
      avg_mfe_pts: parsed?.avg_mfe_pts,
      median_mfe_pts: parsed?.median_mfe_pts,
      sample: parsed?.sample ?? row.sample_size,
      suggestion: `Only ${(row.metric_value * 100).toFixed(0)}% of MNQ_50PT trades reach 50pt MFE — TP target may be unrealistic`,
    }, 2);
  }
}

async function main() {
  const db      = openDb();
  const runDate = new Date().toISOString().slice(0, 10);

  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  let totalFired = 0;

  for (const strategy of STRATEGIES) {
    const before = db.prepare(
      'SELECT COUNT(*) AS n FROM self_improvement_log WHERE run_date = ? AND strategy_name = ?'
    ).get(runDate, strategy)?.n ?? 0;

    try {
      runStrategy(db, runDate, strategy);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }

    const after = db.prepare(
      'SELECT COUNT(*) AS n FROM self_improvement_log WHERE run_date = ? AND strategy_name = ?'
    ).get(runDate, strategy)?.n ?? 0;
    totalFired += (after - before);
  }

  // Instrument-specific rules
  try { runMgcRules(db, runDate); }   catch (err) { console.error(`[${WORKER_NAME}] MGC rules error: ${err.message}`); }
  try { runMnq50PtRules(db, runDate); } catch (err) { console.error(`[${WORKER_NAME}] 50PT rules error: ${err.message}`); }

  const allRecs = db.prepare(`
    SELECT strategy_name, recommendation, dimension, priority
    FROM self_improvement_log
    WHERE run_date = ?
    ORDER BY priority ASC, strategy_name
  `).all(runDate);

  totalFired = allRecs.length;

  heartbeat(db, WORKER_NAME, 'COMPLETED', { completedAt: new Date().toISOString(), recommendations: totalFired });

  const maxPriority = allRecs.length > 0 ? Math.min(...allRecs.map(r => r.priority)) : 5;

  const bodyLines = allRecs.length > 0
    ? allRecs.map(r => `[P${r.priority}] ${r.strategy_name}: ${r.recommendation}${r.dimension ? ` (${r.dimension})` : ''}`)
    : ['No actionable improvements found this week.'];

  await sendNotification(
    `Self-Improvement — ${totalFired} recommendation${totalFired !== 1 ? 's' : ''} this week`,
    bodyLines.join('\n'),
    {
      priority: maxPriority <= 2 ? 'high' : 'default',
      tags: 'gear,white_check_mark',
    },
  );

  console.log(`[${WORKER_NAME}] Done — ${totalFired} recommendations posted`);
  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
