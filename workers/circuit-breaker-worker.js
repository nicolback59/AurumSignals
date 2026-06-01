'use strict';

/**
 * CIRCUIT BREAKER WORKER — Edge Audit Part 6
 *
 * Runs every 30 minutes. Checks each strategy for recent loss clusters and
 * auto-pauses via adaptive overrides when thresholds are breached.
 *
 * Trigger conditions (either trips the breaker):
 *   Streak  — 3+ consecutive losses (most-recent-first from outcomes table)
 *   Rate    — loss rate ≥ 60% with ≥5 resolved trades in the last 4 hours
 *
 * Recovery conditions (both must hold to lift):
 *   - Neither trigger condition currently met
 *   - Last circuit-breaker trigger was > 2 hours ago (cooldown)
 *
 * Integration: writes reason 'auto-paused: circuit-breaker <reason>' into
 * adaptive overrides blob (strategy_params key ADAPTIVE_OVERRIDES) — the same
 * mechanism the signal-gate-worker uses. The scanner reads this via
 * computeAdaptiveOverrides and blocks new signals for the paused strategy.
 *
 * Sends ntfy on state changes (trip → lift or lift → trip).
 * Writes every check to circuit_breaker_log for audit trail.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'circuit-breaker';

const STRATEGIES = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

const STREAK_THRESHOLD    = 3;    // consecutive losses to trip
const RATE_THRESHOLD      = 0.60; // loss rate to trip
const RATE_MIN_TRADES     = 5;    // minimum trades in 4h window for rate check
const COOLDOWN_MS         = 2 * 3_600_000; // 2h before auto-lift is allowed

async function sendNtfy(title, body, priority = 'default') {
  const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC  || '';
  const ntfyToken = process.env.NTFY_TOKEN  || '';
  if (!ntfyTopic) return;
  try {
    const headers = {
      'Content-Type': 'text/plain',
      'Title':    title,
      'Priority': priority,
      'Tags':     'rotating_light,no_entry',
    };
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
    await fetch(`${ntfyUrl}/${ntfyTopic}`, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (_) { /* non-critical */ }
}

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
    ON CONFLICT(key) DO UPDATE SET params_json = excluded.params_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(overrides));
}

function checkStrategy(db, strategy) {
  // Last 10 resolved outcomes (WIN/LOSS only) for consecutive streak
  const recentRows = db.prepare(`
    SELECT o.result FROM outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE s.strategy_name = ?
      AND o.result IN ('WIN','LOSS')
      AND o.exit_at IS NOT NULL
    ORDER BY o.exit_at DESC
    LIMIT 10
  `).all(strategy);

  // Consecutive loss streak from most recent
  let streak = 0;
  for (const row of recentRows) {
    if (row.result === 'LOSS') streak++;
    else break;
  }

  // Rolling 4-hour win/loss stats
  const rolling = db.prepare(`
    SELECT COUNT(*) n,
           SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END) losses
    FROM outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE s.strategy_name = ?
      AND o.result IN ('WIN','LOSS')
      AND o.exit_at >= datetime('now', '-4 hours')
  `).get(strategy);

  const rolling4hTrades = rolling?.n ?? 0;
  const rolling4hLossRate = rolling4hTrades > 0
    ? +((rolling?.losses ?? 0) / rolling4hTrades).toFixed(3)
    : 0;

  // Determine if triggered
  const streakTripped = streak >= STREAK_THRESHOLD;
  const rateTripped   = rolling4hTrades >= RATE_MIN_TRADES && rolling4hLossRate >= RATE_THRESHOLD;
  const triggered     = streakTripped || rateTripped;
  const triggerReason = streakTripped ? 'streak' : rateTripped ? 'rolling_rate' : null;

  return { streak, rolling4hTrades, rolling4hLossRate, triggered, triggerReason };
}

function getLastTriggerTime(db, strategy) {
  try {
    const row = db.prepare(`
      SELECT checked_at FROM circuit_breaker_log
      WHERE strategy_name = ? AND triggered = 1
      ORDER BY checked_at DESC LIMIT 1
    `).get(strategy);
    return row?.checked_at ? new Date(row.checked_at).getTime() : 0;
  } catch (_) { return 0; }
}

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  const insertLog = db.prepare(`
    INSERT INTO circuit_breaker_log
      (strategy_name, triggered, trigger_reason, streak,
       rolling_4h_trades, rolling_4h_loss_rate, action_taken)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let processed = 0;
  let tripped = 0;
  let lifted = 0;

  for (const strategy of STRATEGIES) {
    try {
      const { streak, rolling4hTrades, rolling4hLossRate, triggered, triggerReason }
        = checkStrategy(db, strategy);

      const overrides = loadOverrides(db);
      if (!overrides[strategy]) {
        overrides[strategy] = {
          paused: false, blockLong: false, blockShort: false,
          blockedSessions: [], blockedRegimes: [], reasons: [],
        };
      }
      const ov = overrides[strategy];
      if (!ov.reasons) ov.reasons = [];

      const isCbPaused = ov.reasons.some(r => r.startsWith('auto-paused: circuit-breaker'));
      const lastTriggerMs = getLastTriggerTime(db, strategy);
      const cooldownElapsed = (Date.now() - lastTriggerMs) > COOLDOWN_MS;

      let action = 'NO_CHANGE';

      if (triggered && !isCbPaused) {
        // Trip: apply pause
        if (!ov.manualPause) ov.paused = true;
        ov.reasons.push(`auto-paused: circuit-breaker ${triggerReason} (streak=${streak} rate=${(rolling4hLossRate*100).toFixed(0)}%/${rolling4hTrades}trades)`);
        saveOverrides(db, overrides);
        action = 'PAUSED';
        tripped++;

        const emoji = '🔴';
        const reason = triggerReason === 'streak'
          ? `${streak} consecutive losses`
          : `${(rolling4hLossRate*100).toFixed(0)}% loss rate over ${rolling4hTrades} trades (4h)`;
        await sendNtfy(
          `${emoji} Circuit Breaker Tripped — ${strategy}`,
          `${strategy} auto-paused\nReason: ${reason}\nConsecutive losses: ${streak}\n4h trades: ${rolling4hTrades} | Loss rate: ${(rolling4hLossRate*100).toFixed(0)}%`,
          'high',
        );
        console.log(`[${WORKER_NAME}] TRIPPED ${strategy}: ${reason}`);

      } else if (!triggered && isCbPaused && cooldownElapsed) {
        // Lift: remove circuit-breaker pause
        ov.reasons = ov.reasons.filter(r => !r.startsWith('auto-paused: circuit-breaker'));
        if (!ov.manualPause && !ov.reasons.some(r => r.startsWith('auto-paused') || r.startsWith('intelligence-gate'))) {
          ov.paused = false;
        }
        saveOverrides(db, overrides);
        action = 'LIFTED';
        lifted++;

        await sendNtfy(
          `🟢 Circuit Breaker Lifted — ${strategy}`,
          `${strategy} auto-pause removed\nStreak: ${streak} | 4h trades: ${rolling4hTrades} | Loss rate: ${(rolling4hLossRate*100).toFixed(0)}%\nCooldown elapsed — resuming normal operation`,
          'default',
        );
        console.log(`[${WORKER_NAME}] LIFTED ${strategy}: conditions clear + cooldown elapsed`);

      } else {
        console.log(
          `[${WORKER_NAME}] ${strategy}: streak=${streak} rate=${(rolling4hLossRate*100).toFixed(0)}%/${rolling4hTrades}t ` +
          `triggered=${triggered} cbPaused=${isCbPaused} cooldown=${cooldownElapsed ? 'elapsed' : 'active'}`
        );
      }

      insertLog.run(
        strategy, triggered ? 1 : 0, triggerReason ?? null,
        streak, rolling4hTrades, rolling4hLossRate, action,
      );

      processed++;
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed, tripped, lifted,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies checked, ${tripped} tripped, ${lifted} lifted`);
  db.close();
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
