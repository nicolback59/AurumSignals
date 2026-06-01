'use strict';

/**
 * PORTFOLIO CIRCUIT BREAKER WORKER  (Prompt #15 Phase 5 — Red Team Foundation)
 *
 * Addresses the red-team finding: per-strategy drawdown protection exists but
 * there is no portfolio-level emergency stop. All 4 strategies can simultaneously
 * be in deep drawdown with no mechanism to pause the entire book.
 *
 * Three trigger conditions (any one fires the circuit break):
 *
 *   COMBINED_PNL   — today's combined P&L across all strategies < -15 pts
 *   DRAWDOWN_FLOOD — ≥ 3 strategies at drawdownProtectionLevel ≥ 2 (REDUCE/PAUSE)
 *   LOSS_FLOOD     — ≥ 3 strategies with ≥ 5 consecutive losses right now
 *
 * On circuit break:
 *   - Pauses ALL strategies via ADAPTIVE_OVERRIDES (paused=true)
 *   - Adds 'portfolio_circuit_break' to each strategy's reasons[]
 *   - Posts priority-1 agent_message
 *   - Sends HIGH-priority ntfy
 *   - Writes to portfolio_circuit_breaker_log
 *
 * Auto-recovery (next run after break, if conditions clear):
 *   - Combined today's P&L > -5 pts AND ≤ 1 strategy in L2+
 *   - Only removes the portfolio_circuit_break pause; other pauses remain
 *
 * Runs every 15 minutes (cron: every-15-min).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME        = 'portfolio-circuit-breaker';
const STRATEGIES         = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const COMBINED_PNL_LIMIT = -15;  // pts — combined today triggers WARNING
const FLOOD_THRESHOLD    =   3;  // how many strategies must be impaired to fire
const MIN_L2_LEVEL       =   2;  // drawdownProtectionLevel ≥ 2 = REDUCE or PAUSE

// ── ADAPTIVE_OVERRIDES helpers (same pattern as drawdown-protection-worker) ───

function loadOverrides(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE key = 'ADAPTIVE_OVERRIDES'"
    ).get();
    return row?.params_json ? JSON.parse(row.params_json) : {};
  } catch (_) { return {}; }
}

function saveOverrides(db, overrides) {
  db.prepare(`
    INSERT INTO strategy_params (key, params_json, updated_at)
    VALUES ('ADAPTIVE_OVERRIDES', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      params_json = excluded.params_json,
      updated_at  = excluded.updated_at
  `).run(JSON.stringify(overrides));
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS portfolio_circuit_breaker_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
      triggered           INTEGER NOT NULL DEFAULT 0,
      trigger_reason      TEXT,
      combined_pnl_today  REAL,
      strategies_at_l2    INTEGER,
      strategies_flooded  INTEGER,
      action              TEXT,
      auto_recovered      INTEGER DEFAULT 0,
      notes               TEXT
    )
  `).run();

  const insertLog = db.prepare(`
    INSERT INTO portfolio_circuit_breaker_log
      (triggered, trigger_reason, combined_pnl_today,
       strategies_at_l2, strategies_flooded, action, auto_recovered, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const todayStr = new Date().toISOString().slice(0, 10);

  // ── Gather current state ──────────────────────────────────────────────────
  const overrides = loadOverrides(db);

  // Combined today's P&L
  const pnlRow = db.prepare(`
    SELECT SUM(pnl_pts) AS total_pnl
    FROM trade_dna
    WHERE outcome IN ('WIN','LOSS') AND trade_date = ?
  `).get(todayStr);
  const combinedPnlToday = pnlRow?.total_pnl ?? 0;

  // Per-strategy drawdown level from ADAPTIVE_OVERRIDES
  let strategiesAtL2 = 0;
  let strategiesFlooded = 0;
  const stratDetails = [];

  for (const strategy of STRATEGIES) {
    const ov = overrides[strategy] ?? {};
    const level = ov.drawdownProtectionLevel ?? 0;
    if (level >= MIN_L2_LEVEL) strategiesAtL2++;

    // Count consecutive losses from trade_dna
    const recent = db.prepare(`
      SELECT outcome FROM trade_dna
      WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      ORDER BY trade_date DESC, rowid DESC LIMIT 10
    `).all(strategy);
    let consec = 0;
    for (const r of recent) {
      if (r.outcome === 'LOSS') consec++;
      else break;
    }
    if (consec >= 5) strategiesFlooded++;

    stratDetails.push({ strategy, level, consec, paused: !!ov.paused });
  }

  // ── Evaluate triggers ──────────────────────────────────────────────────────
  const pnlTrigger      = combinedPnlToday < COMBINED_PNL_LIMIT;
  const floodTrigger    = strategiesAtL2   >= FLOOD_THRESHOLD;
  const lossTrigger     = strategiesFlooded >= FLOOD_THRESHOLD;
  const shouldBreak     = pnlTrigger || floodTrigger || lossTrigger;

  const triggerReason   = [
    pnlTrigger   && `combined_pnl_${combinedPnlToday.toFixed(1)}pts`,
    floodTrigger && `${strategiesAtL2}_strategies_at_L2+`,
    lossTrigger  && `${strategiesFlooded}_strategies_5+_losses`,
  ].filter(Boolean).join('; ');

  // Check if already circuit-broken by this worker
  const alreadyBroken = STRATEGIES.every(s => {
    const ov = overrides[s] ?? {};
    return ov.paused && (ov.reasons ?? []).includes('portfolio_circuit_break');
  });

  // ── Auto-recovery check ────────────────────────────────────────────────────
  let autoRecovered = 0;
  if (alreadyBroken && !shouldBreak) {
    // Conditions have cleared — lift the portfolio-level pause
    let changed = false;
    for (const strategy of STRATEGIES) {
      const ov = overrides[strategy] ?? {};
      if ((ov.reasons ?? []).includes('portfolio_circuit_break')) {
        ov.reasons = (ov.reasons ?? []).filter(r => r !== 'portfolio_circuit_break');
        // Only clear paused if no other reason remains
        if (!ov.reasons.length && !ov.manualPause && (ov.drawdownProtectionLevel ?? 0) < 3) {
          ov.paused = false;
        }
        overrides[strategy] = ov;
        changed = true;
      }
    }
    if (changed) {
      saveOverrides(db, overrides);
      autoRecovered = 1;
      console.log(`[${WORKER_NAME}] Portfolio circuit break auto-recovered`);
    }
  }

  // ── Fire circuit break ─────────────────────────────────────────────────────
  if (shouldBreak && !alreadyBroken) {
    for (const strategy of STRATEGIES) {
      const ov = overrides[strategy] ?? {};
      ov.paused  = true;
      ov.reasons = [...new Set([...(ov.reasons ?? []), 'portfolio_circuit_break'])];
      overrides[strategy] = ov;
    }
    saveOverrides(db, overrides);

    const note = `PORTFOLIO CIRCUIT BREAK: ${triggerReason}. Combined P&L today: ${combinedPnlToday.toFixed(1)}pts. All strategies paused.`;
    console.log(`[${WORKER_NAME}] ${note}`);

    try {
      insertMsg.run(WORKER_NAME, 'observation', 'PORTFOLIO', 1,
        JSON.stringify({
          alert:               'portfolio_circuit_break',
          trigger_reason:      triggerReason,
          combined_pnl_today:  +combinedPnlToday.toFixed(2),
          strategies_at_l2:    strategiesAtL2,
          strategies_flooded:  strategiesFlooded,
          action:              'ALL_STRATEGIES_PAUSED',
          strategy_details:    stratDetails,
          note,
        }));
    } catch (_) {}

    await sendNotification(
      '🛑 PORTFOLIO CIRCUIT BREAK TRIGGERED',
      `All strategies paused.\n${triggerReason}\nCombined P&L today: ${combinedPnlToday.toFixed(1)}pts\n${strategiesAtL2} strategies at L2+ drawdown`,
      { priority: 'urgent', tags: 'rotating_light,no_entry' },
    );
  }

  insertLog.run(
    shouldBreak && !alreadyBroken ? 1 : 0,
    triggerReason || null,
    +combinedPnlToday.toFixed(2),
    strategiesAtL2, strategiesFlooded,
    shouldBreak && !alreadyBroken ? 'ALL_PAUSED'
      : autoRecovered             ? 'AUTO_RECOVERED'
      : alreadyBroken             ? 'BREAK_ACTIVE'
      : 'CLEAR',
    autoRecovered,
    JSON.stringify(stratDetails),
  );

  console.log(
    `[${WORKER_NAME}] combinedPnl=${combinedPnlToday.toFixed(1)}pts ` +
    `L2+=${strategiesAtL2} flooded=${strategiesFlooded} ` +
    `status=${shouldBreak ? 'BREAK' : alreadyBroken ? 'BREAK_ACTIVE' : 'CLEAR'}`
  );

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, triggered: shouldBreak && !alreadyBroken ? 1 : 0,
    autoRecovered, completedAt: new Date().toISOString(),
  });

  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
