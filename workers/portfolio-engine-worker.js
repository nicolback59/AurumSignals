'use strict';

/**
 * PORTFOLIO ENGINE WORKER  (Prompt #11 — Phase 10, 3, 8, 9, 11)
 *
 * Runs every 4 hours. Synthesizes all intelligence layers into a portfolio-level
 * capital allocation decision. Acts as the CIO of the system.
 *
 * Inputs (in priority order):
 *   1. strategy_rankings       — health + confidence + allocation scores
 *   2. regime_health_log       — behavior mode (STANDBY blocks, AGGRESSIVE boosts)
 *   3. edge_health_log         — CRITICAL/COLLAPSE degrades allocation
 *   4. drawdown_log            — protection level degrades allocation
 *   5. regime_performance_stats — per-regime WR context
 *
 * Output: portfolio_allocations table + agent_messages recommendations
 *
 * Allocation methodology (prop desk model):
 *   1. Start with equal-weight base (100% / N active strategies)
 *   2. Scale by allocation_score (0.50–1.50× weight)
 *   3. Block STANDBY strategies (weight = 0)
 *   4. Degrade by edge health: CRITICAL → ×0.50, COLLAPSE → ×0.25
 *   5. Degrade by drawdown protection level: L2 → ×0.75, L3 → ×0 (blocked)
 *   6. Normalize surviving weights to sum to 100%
 *   7. Apply cash reserve rule: if fewer than 2 strategies active → hold 30% cash
 *
 * Capital efficiency tiers (Phase 8):
 *   $10k  account: 1 contract MNQ, no MGC (margin risk)
 *   $50k  account: 2 MNQ + 1 MGC
 *   $100k account: 3 MNQ + 2 MGC
 *   $500k account: 10 MNQ + 5 MGC, dedicated risk desk model
 *
 * Degradation detection (Phase 9):
 *   Edge decay:          edge_status CRITICAL/COLLAPSE + WR trend negative
 *   Regime mismatch:     behavior_mode STANDBY
 *   Frequency collapse:  trades_per_week < 1 (last 28d)
 *   Expectancy collapse: 30d expectancy < 0 AND last 7d also negative
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'portfolio-engine';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

// Capital tiers for Phase 8 reference data in the output
const CAPITAL_TIERS = [
  { label: '$10k',  mnq_contracts: 1, mgc_contracts: 0, cash_reserve_pct: 40 },
  { label: '$50k',  mnq_contracts: 2, mgc_contracts: 1, cash_reserve_pct: 25 },
  { label: '$100k', mnq_contracts: 3, mgc_contracts: 2, cash_reserve_pct: 20 },
  { label: '$500k', mnq_contracts: 10, mgc_contracts: 5, cash_reserve_pct: 15 },
];

// ── Adaptive overrides helpers ────────────────────────────────────────────────

function loadOverrides(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE key = 'ADAPTIVE_OVERRIDES'"
    ).get();
    return row?.params_json ? JSON.parse(row.params_json) : {};
  } catch (_) { return {}; }
}

// ── Degradation detection ─────────────────────────────────────────────────────

function detectDegradation(db, strategy) {
  const flags = [];

  // Edge decay: CRITICAL or COLLAPSE
  const edge = db.prepare(
    `SELECT edge_status, wr_last5, wr_last10, baseline_wr
     FROM edge_health_log WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
  ).get(strategy);
  if (edge?.edge_status === 'CRITICAL' || edge?.edge_status === 'COLLAPSE') {
    flags.push(`edge_decay:${edge.edge_status}`);
  }

  // Regime mismatch: STANDBY
  const regime = db.prepare(
    `SELECT behavior_mode FROM regime_health_log WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
  ).get(strategy);
  if (regime?.behavior_mode === 'STANDBY') flags.push('regime_mismatch:STANDBY');

  // Frequency collapse: < 1 trade/week last 28 days
  const freq = db.prepare(
    `SELECT COUNT(*) AS n FROM trade_dna
     WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
       AND trade_date >= date('now', '-28 days')`
  ).get(strategy);
  if ((freq?.n ?? 0) < 4) flags.push(`frequency_collapse:${freq?.n ?? 0}_trades_28d`);

  // Expectancy collapse: negative 30d AND negative 7d
  const exp30 = db.prepare(
    `SELECT AVG(pnl_pts) AS exp FROM trade_dna
     WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
       AND trade_date >= date('now', '-30 days')`
  ).get(strategy);
  const exp7 = db.prepare(
    `SELECT AVG(pnl_pts) AS exp FROM trade_dna
     WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
       AND trade_date >= date('now', '-7 days')`
  ).get(strategy);
  if ((exp30?.exp ?? 0) < 0 && (exp7?.exp ?? 0) < 0) {
    flags.push(`expectancy_collapse:30d=${(exp30?.exp ?? 0).toFixed(2)}_7d=${(exp7?.exp ?? 0).toFixed(2)}`);
  }

  return flags;
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS portfolio_allocations (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      run_ts               TEXT NOT NULL DEFAULT (datetime('now')),
      strategy_name        TEXT NOT NULL,
      instrument           TEXT,
      raw_weight           REAL,
      final_weight_pct     REAL,
      allocation_score     INTEGER,
      behavior_mode        TEXT,
      edge_status          TEXT,
      dd_protection_level  INTEGER,
      degradation_flags    TEXT,
      recommendation       TEXT,
      capital_action       TEXT,
      notes                TEXT
    )
  `).run();

  const insertAlloc = db.prepare(`
    INSERT INTO portfolio_allocations
      (strategy_name, instrument, raw_weight, final_weight_pct,
       allocation_score, behavior_mode, edge_status, dd_protection_level,
       degradation_flags, recommendation, capital_action, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const overrides = loadOverrides(db);

  // ── Gather inputs per strategy ─────────────────────────────────────────────
  const stratData = [];

  for (const strategy of STRATEGIES) {
    try {
      const instrument = strategy.startsWith('MGC') ? 'MGC' : 'MNQ';
      const ov         = overrides[strategy] ?? {};

      // Latest strategy ranking
      const ranking = db.prepare(
        `SELECT allocation_score, health_score, confidence_score
         FROM strategy_rankings WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
      ).get(strategy);

      // Regime health
      const regime = db.prepare(
        `SELECT behavior_mode, health_score AS regime_health
         FROM regime_health_log WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
      ).get(strategy);
      const behaviorMode = regime?.behavior_mode ?? 'NORMAL';

      // Edge health
      const edge = db.prepare(
        `SELECT edge_status, decay_score
         FROM edge_health_log WHERE strategy_name = ? ORDER BY id DESC LIMIT 1`
      ).get(strategy);
      const edgeStatus  = edge?.edge_status ?? 'HEALTHY';

      // Drawdown protection
      const ddLevel = ov.drawdownProtectionLevel ?? 0;

      // Whether paused
      const isPaused = !!(ov.paused);

      // Degradation
      const degradationFlags = detectDegradation(db, strategy);

      stratData.push({
        strategy, instrument,
        allocationScore:  ranking?.allocation_score ?? 50,
        healthScore:      ranking?.health_score ?? 50,
        confidenceScore:  ranking?.confidence_score ?? 50,
        behaviorMode,
        edgeStatus,
        ddLevel,
        isPaused,
        degradationFlags,
      });
    } catch (err) {
      console.error(`[${WORKER_NAME}] gather error ${strategy}: ${err.message}`);
      stratData.push({
        strategy, instrument: strategy.startsWith('MGC') ? 'MGC' : 'MNQ',
        allocationScore: 50, healthScore: 50, confidenceScore: 50,
        behaviorMode: 'NORMAL', edgeStatus: 'HEALTHY',
        ddLevel: 0, isPaused: false, degradationFlags: [],
      });
    }
  }

  // ── Compute allocation weights ─────────────────────────────────────────────
  // Raw weight = allocation_score-based multiplier (0.50–1.50)
  const withWeights = stratData.map(s => {
    let rawWeight = 0.50 + (s.allocationScore / 100);  // 0.50–1.50

    // Zero out blocked/paused strategies
    if (s.isPaused || s.behaviorMode === 'STANDBY') {
      rawWeight = 0;
    }

    // Edge health degradation
    if (s.edgeStatus === 'COLLAPSE')  rawWeight *= 0.25;
    else if (s.edgeStatus === 'CRITICAL') rawWeight *= 0.50;
    else if (s.edgeStatus === 'WARNING')  rawWeight *= 0.75;

    // Drawdown protection
    if      (s.ddLevel >= 3) rawWeight = 0;
    else if (s.ddLevel === 2) rawWeight *= 0.75;
    else if (s.ddLevel === 1) rawWeight *= 0.875;

    return { ...s, rawWeight };
  });

  const totalWeight = withWeights.reduce((sum, s) => sum + s.rawWeight, 0);
  const activeCount = withWeights.filter(s => s.rawWeight > 0).length;

  // Cash reserve rule: fewer than 2 active → hold extra cash
  const cashReservePct = activeCount < 2 ? 30 : 0;
  const deployablePct  = 100 - cashReservePct;

  const results = withWeights.map(s => {
    const finalPct = totalWeight > 0
      ? +(s.rawWeight / totalWeight * deployablePct).toFixed(1)
      : 0;

    // Determine capital action
    let capitalAction;
    if (s.rawWeight === 0)       capitalAction = 'BLOCK';
    else if (finalPct >= 35)     capitalAction = 'INCREASE';
    else if (finalPct >= 20)     capitalAction = 'MAINTAIN';
    else                         capitalAction = 'DECREASE';

    // Recommendation text
    const recs = [];
    if (capitalAction === 'INCREASE') recs.push(`Increase allocation to ${finalPct}% — strong edge`);
    if (capitalAction === 'DECREASE') recs.push(`Decrease allocation to ${finalPct}% — weakened edge`);
    if (capitalAction === 'BLOCK')    recs.push(`Block capital — ${s.behaviorMode === 'STANDBY' ? 'regime STANDBY' : s.ddLevel >= 3 ? 'drawdown PAUSE' : 'edge COLLAPSE'}`);
    if (capitalAction === 'MAINTAIN') recs.push(`Maintain ${finalPct}% allocation`);
    if (s.degradationFlags.length)    recs.push(`Degradation: ${s.degradationFlags.join(', ')}`);

    return { ...s, finalPct, capitalAction, recommendation: recs.join(' | ') };
  });

  // ── Persist and post messages ──────────────────────────────────────────────
  for (const r of results) {
    const notes = [];
    if (cashReservePct > 0) notes.push(`cash_reserve=${cashReservePct}%`);
    if (r.degradationFlags.length) notes.push(r.degradationFlags.join(','));

    insertAlloc.run(
      r.strategy, r.instrument,
      +r.rawWeight.toFixed(3), r.finalPct,
      r.allocationScore, r.behaviorMode, r.edgeStatus,
      r.ddLevel,
      r.degradationFlags.length ? r.degradationFlags.join('; ') : null,
      r.recommendation,
      r.capitalAction,
      notes.join('; ') || null,
    );

    // Post agent_message for any strategy that needs action (not MAINTAIN with no degradation)
    const needsAction = r.capitalAction !== 'MAINTAIN' || r.degradationFlags.length > 0;
    if (needsAction) {
      const priority = r.capitalAction === 'BLOCK' ? 2 : r.degradationFlags.length > 0 ? 3 : 4;
      try {
        insertMsg.run(
          'portfolio-engine',
          r.capitalAction === 'BLOCK' ? 'veto' : 'recommendation',
          r.strategy,
          priority,
          JSON.stringify({
            capital_action:     r.capitalAction,
            final_weight_pct:   r.finalPct,
            allocation_score:   r.allocationScore,
            behavior_mode:      r.behaviorMode,
            edge_status:        r.edgeStatus,
            dd_level:           r.ddLevel,
            degradation_flags:  r.degradationFlags,
            recommendation:     r.recommendation,
          }),
        );
      } catch (_) {}
    }

    console.log(
      `[${WORKER_NAME}] ${r.strategy}: action=${r.capitalAction} weight=${r.finalPct}% ` +
      `alloc=${r.allocationScore} mode=${r.behaviorMode} edge=${r.edgeStatus} dd=${r.ddLevel}` +
      (r.degradationFlags.length ? ` DEGRADE:[${r.degradationFlags.join(',')}]` : ''),
    );
  }

  // ── Portfolio summary ntfy (if any BLOCK or degradation) ──────────────────
  const blocked    = results.filter(r => r.capitalAction === 'BLOCK');
  const degrading  = results.filter(r => r.degradationFlags.length > 0);

  if (blocked.length > 0 || degrading.length > 0) {
    const lines = [
      `Active strategies: ${activeCount}/${STRATEGIES.length}`,
      cashReservePct > 0 ? `Cash reserve: ${cashReservePct}%` : null,
      ...results.map(r => `${r.strategy}: ${r.finalPct}% (${r.capitalAction})`),
      degrading.length > 0 ? `Degradation detected: ${degrading.map(r => r.strategy).join(', ')}` : null,
    ].filter(Boolean);

    await sendNotification(
      `Portfolio Engine — ${blocked.length} blocked, ${degrading.length} degrading`,
      lines.join('\n'),
      { priority: blocked.length > 0 ? 'default' : 'low', tags: 'bar_chart,warning' },
    );
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    active: activeCount,
    blocked: blocked.length,
    cashReservePct,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${activeCount} active strategies, cash reserve ${cashReservePct}%`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
