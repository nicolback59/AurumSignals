'use strict';

/**
 * PERFORMANCE MULTIPLIER WORKER  (Prompt #14 — Performance Multiplier Engine)
 *
 * THE single highest-ROI improvement after Prompts 1-13.
 *
 * Problem solved: the system generated insights across 4 research pipelines
 * (edge_discoveries, research_experiments, session_calendar, risk_metrics_log)
 * but scanner-core never automatically acted on them. Every signal was scored
 * with static multipliers regardless of what the research found.
 *
 * This worker closes the loop:
 *   Research outputs → performance_multipliers table → scanner-core applies at scoring time
 *
 * Runs daily at 07:45 UTC (after risk-metrics 07:30, before scanner peak activity).
 *
 * Sources synthesized (in priority order — higher overwrites lower):
 *   1. session_calendar     — EDGE/AVOID patterns from DOW/hour/month/session analysis
 *   2. edge_discoveries     — high-impact grid patterns (impact_score ≥ 1.5, status=ACTIVE)
 *   3. research_experiments — statistically confirmed hypotheses (result=CONFIRMED)
 *
 * Output per (strategy, condition_type, condition_key):
 *   score_adj    — added to qualityPts in scanner-core (-20 to +20)
 *   size_mult    — multiplied against final sizing (0.50 to 1.30)
 *   should_block — hard reject this signal (when wr_delta ≤ -0.25 AND n ≥ 30 AND HIGH confidence)
 *   confidence   — HIGH | MEDIUM | LOW (affects whether block is applied)
 *
 * Condition types recognized by scanner-core:
 *   regime         → maps to _activeRegime (TREND_BULL, RANGE_CHOP, …)
 *   session        → maps to sig.session (ny_open, power_hour, …)
 *   entry_type     → maps to sig.entry_type
 *   archetype      → maps to sig.archetype
 *   htf_bias       → maps to sig.htf_bias
 *   (dow/hour_et via session_calendar → handled separately by _calendarSizeMult)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME        = 'performance-multiplier';
const STRATEGIES         = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const MIN_IMPACT         = 1.5;    // edge_discoveries minimum impact_score
const MIN_DELTA_ED       = 0.08;   // minimum |wr_delta| to act on from edge_discoveries
const MIN_DELTA_EXP      = 0.07;   // minimum |wr_delta| from confirmed experiments
const MIN_DELTA_CAL      = 0.10;   // minimum |wr_delta| from session_calendar
const BLOCK_THRESHOLD    = -0.22;  // wr_delta ≤ this → should_block = true (HIGH confidence only)
const BLOCK_MIN_N        = 25;     // minimum sample size to hard-block

// ── Convert wr_delta to score/size adjustments ─────────────────────────────────
// score_adj: +/- qualityPts in scanner-core quality scoring (range -20 to +20)
// size_mult: applied in final sizing formula (range 0.50 to 1.30)

function deltaToScoreAdj(wrDelta, strength = 1.0) {
  const adj = wrDelta * 65 * strength;
  return Math.max(-20, Math.min(20, +adj.toFixed(1)));
}

function deltaToSizeMult(wrDelta, strength = 1.0) {
  const mult = 1 + wrDelta * 0.65 * strength;
  return Math.max(0.50, Math.min(1.30, +mult.toFixed(3)));
}

function confidenceLabel(impactScore) {
  if (impactScore >= 3.0) return 'HIGH';
  if (impactScore >= 2.0) return 'MEDIUM';
  return 'LOW';
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS performance_multipliers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name   TEXT NOT NULL,
      condition_type  TEXT NOT NULL,
      condition_key   TEXT NOT NULL,
      score_adj       REAL NOT NULL DEFAULT 0,
      size_mult       REAL NOT NULL DEFAULT 1.0,
      should_block    INTEGER DEFAULT 0,
      confidence      TEXT DEFAULT 'MEDIUM',
      source          TEXT,
      n_samples       INTEGER,
      wr_delta        REAL,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT,
      UNIQUE(strategy_name, condition_type, condition_key)
    )
  `).run();

  // Phase 4 (Prompt #15): expire stale should_block rules before re-synthesising.
  // Any block not re-confirmed within 90 days is automatically lifted.
  try {
    db.prepare(
      `UPDATE performance_multipliers SET should_block = 0
       WHERE should_block = 1 AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    ).run();
  } catch (_) {}

  const upsert = db.prepare(`
    INSERT INTO performance_multipliers
      (strategy_name, condition_type, condition_key, score_adj, size_mult,
       should_block, confidence, source, n_samples, wr_delta, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+90 days'))
    ON CONFLICT(strategy_name, condition_type, condition_key) DO UPDATE SET
      score_adj    = excluded.score_adj,
      size_mult    = excluded.size_mult,
      should_block = excluded.should_block,
      confidence   = excluded.confidence,
      source       = excluded.source,
      n_samples    = excluded.n_samples,
      wr_delta     = excluded.wr_delta,
      updated_at   = datetime('now'),
      expires_at   = datetime('now', '+90 days')
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  let totalUpserted = 0;
  let highConfidenceCount = 0;
  let blockCount = 0;
  const newHighConfidence = [];

  for (const strategy of STRATEGIES) {
    try {
      let stratUpserted = 0;

      // ── Source 1: session_calendar (EDGE/AVOID patterns) ──────────────────────
      // Lowest priority — overwritten by stronger sources below.
      // Only synthesize DOW/hour/session types (regime/archetype come from edge_discoveries).
      try {
        const calRows = db.prepare(`
          SELECT dimension, dimension_key, pattern, wr_delta, trade_count
          FROM session_calendar
          WHERE strategy_name = ?
            AND run_date = (SELECT MAX(run_date) FROM session_calendar WHERE strategy_name = ?)
            AND pattern != 'NEUTRAL'
            AND ABS(wr_delta) >= ?
          ORDER BY ABS(wr_delta) DESC
        `).all(strategy, strategy, MIN_DELTA_CAL);

        for (const r of calRows) {
          const impactProxy = Math.abs(r.wr_delta) * Math.sqrt(r.trade_count ?? 10);
          const scoreAdj = deltaToScoreAdj(r.wr_delta, 0.8); // slightly dampened for calendar
          const sizeMult = deltaToSizeMult(r.wr_delta, 0.8);
          const conf     = impactProxy >= 3.0 ? 'HIGH' : impactProxy >= 1.5 ? 'MEDIUM' : 'LOW';
          const block    = r.wr_delta <= BLOCK_THRESHOLD && (r.trade_count ?? 0) >= BLOCK_MIN_N && conf === 'HIGH';

          upsert.run(strategy, r.dimension, r.dimension_key,
            scoreAdj, sizeMult, block ? 1 : 0, conf, 'calendar', r.trade_count, r.wr_delta);
          stratUpserted++;
          if (block) blockCount++;
        }
      } catch (_) {}

      // ── Source 2: edge_discoveries (grid pattern analysis) ────────────────────
      // Overrides calendar for the same condition_type|condition_key.
      // Only process 1D conditions (dimension_b IS NULL) — 2D cross conditions
      // are applied via the calendar channel or future enhancement.
      try {
        const edRows = db.prepare(`
          SELECT dimension_a AS ctype, value_a AS ckey,
                 sample_size, observed_wr, baseline_wr, wr_delta, impact_score
          FROM edge_discoveries
          WHERE strategy_name = ?
            AND status IN ('ACTIVE','NEW')
            AND dimension_b IS NULL
            AND ABS(wr_delta) >= ?
            AND impact_score >= ?
            AND sample_size >= 15
          ORDER BY impact_score DESC
        `).all(strategy, MIN_DELTA_ED, MIN_IMPACT);

        for (const r of edRows) {
          if (!r.ctype || !r.ckey) continue;
          const scoreAdj = deltaToScoreAdj(r.wr_delta);
          const sizeMult = deltaToSizeMult(r.wr_delta);
          const conf     = confidenceLabel(r.impact_score);
          const block    = r.wr_delta <= BLOCK_THRESHOLD && r.sample_size >= BLOCK_MIN_N && conf === 'HIGH';

          upsert.run(strategy, r.ctype, r.ckey,
            scoreAdj, sizeMult, block ? 1 : 0, conf, 'edge_discovery', r.sample_size, r.wr_delta);
          stratUpserted++;
          if (block) blockCount++;
          if (conf === 'HIGH') highConfidenceCount++;
        }
      } catch (_) {}

      // ── Source 3: research_experiments (confirmed hypotheses) ─────────────────
      // Highest priority — statistically confirmed with OOS validation.
      // Overwrites everything for matching conditions.
      try {
        const expRows = db.prepare(`
          SELECT condition_key AS ctype, condition_value AS ckey,
                 test_n AS sample_size, wr_delta, z_score, oos_confirmed
          FROM research_experiments
          WHERE strategy_name = ?
            AND result = 'CONFIRMED'
            AND ABS(wr_delta) >= ?
            AND test_n >= 15
          ORDER BY ABS(wr_delta) DESC
        `).all(strategy, MIN_DELTA_EXP);

        for (const r of expRows) {
          if (!r.ctype || !r.ckey) continue;
          // Confirmed experiments get full strength + OOS bonus
          const oosBonus = r.oos_confirmed ? 1.15 : 1.0;
          const scoreAdj = deltaToScoreAdj(r.wr_delta, oosBonus);
          const sizeMult = deltaToSizeMult(r.wr_delta, oosBonus);
          const absZ     = Math.abs(r.z_score ?? 0);
          const conf     = absZ >= 2.33 ? 'HIGH' : absZ >= 1.65 ? 'MEDIUM' : 'LOW';
          const block    = r.wr_delta <= BLOCK_THRESHOLD && r.sample_size >= BLOCK_MIN_N && conf === 'HIGH' && !!r.oos_confirmed;

          upsert.run(strategy, r.ctype, r.ckey,
            scoreAdj, sizeMult, block ? 1 : 0, conf, 'experiment', r.sample_size, r.wr_delta);
          stratUpserted++;
          if (block) blockCount++;
          if (conf === 'HIGH') {
            highConfidenceCount++;
            newHighConfidence.push({ strategy, ctype: r.ctype, ckey: r.ckey, wr_delta: r.wr_delta, conf });
          }
        }
      } catch (_) {}

      totalUpserted += stratUpserted;
      console.log(`[${WORKER_NAME}] ${strategy}: ${stratUpserted} multipliers upserted`);
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── Post agent_message summary ───────────────────────────────────────────────
  if (totalUpserted > 0) {
    try {
      insertMsg.run(
        WORKER_NAME, 'observation', 'PORTFOLIO', 4,
        JSON.stringify({
          total_multipliers: totalUpserted,
          high_confidence:   highConfidenceCount,
          hard_blocks:       blockCount,
          note: `Performance multipliers refreshed: ${totalUpserted} rules, ${highConfidenceCount} HIGH-confidence, ${blockCount} hard blocks active`,
        }),
      );
    } catch (_) {}
  }

  // ── ntfy notification for new HIGH-confidence blocks ─────────────────────────
  if (blockCount > 0) {
    const blockLines = db.prepare(`
      SELECT strategy_name, condition_type, condition_key, wr_delta, n_samples, source
      FROM performance_multipliers
      WHERE should_block = 1 AND confidence = 'HIGH'
      ORDER BY wr_delta ASC LIMIT 10
    `).all().map(r =>
      `${r.strategy_name}: ${r.condition_type}=${r.condition_key} WR△${(r.wr_delta*100).toFixed(0)}% n=${r.n_samples} [${r.source}]`
    );
    await sendNotification(
      'Performance Multipliers — Hard Blocks Active',
      `${blockCount} condition(s) set to hard-block signals:\n${blockLines.join('\n')}`,
      { priority: 'default', tags: 'no_entry,chart_with_downwards_trend' },
    );
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    totalUpserted,
    highConfidenceCount,
    blockCount,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${totalUpserted} multipliers, ${highConfidenceCount} HIGH-conf, ${blockCount} blocks`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
