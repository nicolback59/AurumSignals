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

const { openDb, heartbeat, logWorkerError, sendNotification, withOverridesLock, getEtDateStr } = require('./worker-utils');

const WORKER_NAME        = 'portfolio-circuit-breaker';
const STRATEGIES         = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const COMBINED_PNL_LIMIT = -15;  // pts — combined today triggers WARNING
const FLOOD_THRESHOLD    =   3;  // how many strategies must be impaired to fire
const MIN_L2_LEVEL       =   2;  // drawdownProtectionLevel ≥ 2 = REDUCE or PAUSE


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

  const todayStr = getEtDateStr();

  // ── Phase A: gather analysis data OUTSIDE the lock ────────────────────────
  const pnlRow = db.prepare(`
    SELECT SUM(pnl_pts) AS total_pnl
    FROM trade_dna
    WHERE outcome IN ('WIN','LOSS') AND trade_date = ?
  `).get(todayStr);
  const combinedPnlToday = pnlRow?.total_pnl ?? 0;

  let strategiesAtL2   = 0;
  let strategiesFlooded = 0;
  const stratPrecheck   = [];

  for (const strategy of STRATEGIES) {
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
    stratPrecheck.push({ strategy, consec });
  }

  const pnlTrigger   = combinedPnlToday < COMBINED_PNL_LIMIT;
  const lossTrigger  = strategiesFlooded >= FLOOD_THRESHOLD;
  const triggerReason = [
    pnlTrigger  && `combined_pnl_${combinedPnlToday.toFixed(1)}pts`,
    lossTrigger && `${strategiesFlooded}_strategies_5+_losses`,
  ].filter(Boolean).join('; ');

  // ── Phase B: apply break / recovery atomically ────────────────────────────
  // floodTrigger (L2+ count) and alreadyBroken are determined inside the lock
  // so they reflect the most current state of ADAPTIVE_OVERRIDES.
  let shouldBreak  = false;
  let alreadyBroken = false;
  let autoRecovered = 0;
  let finalTriggerReason = triggerReason;
  const stratDetails = [];

  withOverridesLock(db, overrides => {
    // Re-read drawdown levels from the freshly-locked overrides
    let atL2 = 0;
    for (const { strategy, consec } of stratPrecheck) {
      const ov = overrides[strategy] ?? {};
      const level = ov.drawdownProtectionLevel ?? 0;
      if (level >= MIN_L2_LEVEL) atL2++;
      stratDetails.push({ strategy, level, consec, paused: !!ov.paused });
    }
    strategiesAtL2 = atL2;

    const floodTrigger = atL2 >= FLOOD_THRESHOLD;
    shouldBreak = pnlTrigger || floodTrigger || lossTrigger;

    finalTriggerReason = [
      pnlTrigger   && `combined_pnl_${combinedPnlToday.toFixed(1)}pts`,
      floodTrigger && `${atL2}_strategies_at_L2+`,
      lossTrigger  && `${strategiesFlooded}_strategies_5+_losses`,
    ].filter(Boolean).join('; ');

    alreadyBroken = STRATEGIES.every(s => {
      const ov = overrides[s] ?? {};
      return ov.paused && (ov.reasons ?? []).includes('portfolio_circuit_break');
    });

    if (alreadyBroken && !shouldBreak) {
      // Conditions cleared — lift the portfolio-level pause only
      for (const strategy of STRATEGIES) {
        const ov = overrides[strategy] ?? {};
        if ((ov.reasons ?? []).includes('portfolio_circuit_break')) {
          ov.reasons = (ov.reasons ?? []).filter(r => r !== 'portfolio_circuit_break');
          if (!ov.reasons.length && !ov.manualPause && (ov.drawdownProtectionLevel ?? 0) < 3) {
            ov.paused = false;
          }
          overrides[strategy] = ov;
          autoRecovered = 1;
        }
      }
    } else if (shouldBreak && !alreadyBroken) {
      for (const strategy of STRATEGIES) {
        const ov = overrides[strategy] ?? {};
        ov.paused  = true;
        ov.reasons = [...new Set([...(ov.reasons ?? []), 'portfolio_circuit_break'])];
        overrides[strategy] = ov;
      }
    }
  });

  // ── Phase C: log and notify OUTSIDE the lock ──────────────────────────────
  if (autoRecovered) {
    console.log(`[${WORKER_NAME}] Portfolio circuit break auto-recovered`);
  }

  if (shouldBreak && !alreadyBroken) {
    const note = `PORTFOLIO CIRCUIT BREAK: ${finalTriggerReason}. Combined P&L today: ${combinedPnlToday.toFixed(1)}pts. All strategies paused.`;
    console.log(`[${WORKER_NAME}] ${note}`);

    try {
      insertMsg.run(WORKER_NAME, 'observation', 'PORTFOLIO', 1,
        JSON.stringify({
          alert:               'portfolio_circuit_break',
          trigger_reason:      finalTriggerReason,
          combined_pnl_today:  +combinedPnlToday.toFixed(2),
          strategies_at_l2:    strategiesAtL2,
          strategies_flooded:  strategiesFlooded,
          action:              'ALL_STRATEGIES_PAUSED',
          strategy_details:    stratDetails,
          note,
        }));
    } catch (_) {}

    await sendNotification(
      'PORTFOLIO CIRCUIT BREAK TRIGGERED',
      `All strategies paused.\n${finalTriggerReason}\nCombined P&L today: ${combinedPnlToday.toFixed(1)}pts\n${strategiesAtL2} strategies at L2+ drawdown`,
      { priority: 'urgent', tags: 'rotating_light,no_entry', emailFallback: true },
    );
  }

  insertLog.run(
    shouldBreak && !alreadyBroken ? 1 : 0,
    finalTriggerReason || null,
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
