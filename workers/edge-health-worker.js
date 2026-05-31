'use strict';

/**
 * EDGE HEALTH WORKER
 *
 * Runs every 2h. Computes a rolling decay score for each active strategy
 * to detect when a statistical edge is deteriorating.
 *
 * Scoring model (additive, higher = worse):
 *   +30  Rolling-5  WR < 40%
 *   +20  Rolling-10 WR < 45%
 *   +15  Rolling-20 WR < 50%
 *   +35  Consecutive losses ≥ 6     (replaces the +20 below)
 *   +20  Consecutive losses ≥ 4     (only if streak < 6)
 *   +15  Rolling-5 WR > 20pp below 90-day baseline
 *
 * Status thresholds:
 *   0–20   HEALTHY
 *   21–40  WATCH
 *   41–60  WARNING
 *   61–80  CRITICAL
 *   81+    COLLAPSE
 *
 * On CRITICAL or COLLAPSE:
 *   - Posts veto to agent_messages (edge-health → consensus)
 *   - Sends ntfy alert
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'edge-health';

const STRATEGIES = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

const DECAY_THRESHOLDS = { HEALTHY: 20, WATCH: 40, WARNING: 60, CRITICAL: 80 };

function edgeStatus(score) {
  if (score <= DECAY_THRESHOLDS.HEALTHY)  return 'HEALTHY';
  if (score <= DECAY_THRESHOLDS.WATCH)    return 'WATCH';
  if (score <= DECAY_THRESHOLDS.WARNING)  return 'WARNING';
  if (score <= DECAY_THRESHOLDS.CRITICAL) return 'CRITICAL';
  return 'COLLAPSE';
}

async function sendNtfy(title, body, priority = 'high') {
  const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC  || '';
  const ntfyToken = process.env.NTFY_TOKEN  || '';
  if (!ntfyTopic) return;
  try {
    const headers = {
      'Content-Type': 'text/plain',
      'Title':    title,
      'Priority': priority,
      'Tags':     'warning,chart_with_downwards_trend',
    };
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
    await fetch(`${ntfyUrl}/${ntfyTopic}`, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (_) { /* non-critical */ }
}

function computeEdgeHealth(db, strategyName) {
  // Pull last 25 resolved outcomes for this strategy (ordered newest first)
  const trades = db.prepare(`
    SELECT o.result, o.exit_at
    FROM outcomes o
    JOIN signals  s ON s.id = o.signal_id
    WHERE s.strategy_name = ?
      AND o.result IN ('WIN','LOSS','BE','EXPIRED')
      AND o.exit_at IS NOT NULL
    ORDER BY o.exit_at DESC
    LIMIT 25
  `).all(strategyName);

  const n = trades.length;
  if (n < 5) return { skip: true, reason: 'insufficient_data', trades_available: n };

  // Rolling windows (newest-first slice)
  function windowWr(slice) {
    if (!slice.length) return null;
    const wins = slice.filter(t => t.result === 'WIN').length;
    return wins / slice.length;
  }

  const wr5  = windowWr(trades.slice(0, 5));
  const wr10 = n >= 10 ? windowWr(trades.slice(0, 10)) : null;
  const wr20 = n >= 20 ? windowWr(trades.slice(0, 20)) : null;

  // 90-day baseline WR
  const baseRow = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins
    FROM outcomes o
    JOIN signals  s ON s.id = o.signal_id
    WHERE s.strategy_name = ?
      AND o.result IN ('WIN','LOSS','BE','EXPIRED')
      AND o.exit_at >= datetime('now', '-90 days')
  `).get(strategyName);
  const baselineWr = (baseRow?.total >= 10)
    ? (baseRow.wins / baseRow.total)
    : null;

  // Consecutive loss streak (from newest trade back)
  let streak = 0;
  for (const t of trades) {
    if (t.result === 'WIN') break;
    streak++;
  }

  // ── Decay score ─────────────────────────────────────────────────────────────
  let score = 0;
  const triggers = [];

  if (wr5 !== null && wr5 < 0.40) {
    score += 30;
    triggers.push(`wr5=${(wr5*100).toFixed(0)}%<40%`);
  }
  if (wr10 !== null && wr10 < 0.45) {
    score += 20;
    triggers.push(`wr10=${(wr10*100).toFixed(0)}%<45%`);
  }
  if (wr20 !== null && wr20 < 0.50) {
    score += 15;
    triggers.push(`wr20=${(wr20*100).toFixed(0)}%<50%`);
  }
  if (streak >= 6) {
    score += 35;
    triggers.push(`streak=${streak}≥6`);
  } else if (streak >= 4) {
    score += 20;
    triggers.push(`streak=${streak}≥4`);
  }
  if (baselineWr !== null && wr5 !== null && (baselineWr - wr5) > 0.20) {
    score += 15;
    triggers.push(`wr5_vs_base=${((baselineWr-wr5)*100).toFixed(0)}pp_below`);
  }

  return {
    skip:                false,
    decay_score:         score,
    edge_status:         edgeStatus(score),
    wr_last5:            wr5,
    wr_last10:           wr10,
    wr_last20:           wr20,
    baseline_wr:         baselineWr,
    consecutive_losses:  streak,
    trades_available:    n,
    notes:               triggers.length ? triggers.join(', ') : 'no_decay_detected',
  };
}

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  const insertLog = db.prepare(`
    INSERT INTO edge_health_log
      (strategy_name, instrument, decay_score, edge_status,
       wr_last5, wr_last10, wr_last20, baseline_wr,
       consecutive_losses, trades_available, veto_posted, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVeto = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, to_agent, msg_type, strategy, payload, priority)
    VALUES ('edge-health', 'consensus', 'veto', ?, ?, 1)
  `);

  let processed = 0;
  let alerts    = 0;

  for (const strategy of STRATEGIES) {
    try {
      const instrument = strategy.startsWith('MGC') ? 'MGC' : 'MNQ';
      const result = computeEdgeHealth(db, strategy);

      if (result.skip) {
        console.log(`[${WORKER_NAME}] ${strategy}: skip — ${result.reason} (${result.trades_available} trades)`);
        continue;
      }

      const { decay_score, edge_status, wr_last5, wr_last10, wr_last20,
              baseline_wr, consecutive_losses, trades_available, notes } = result;

      insertLog.run(
        strategy, instrument, decay_score, edge_status,
        wr_last5  !== null ? Math.round(wr_last5  * 100) / 100 : null,
        wr_last10 !== null ? Math.round(wr_last10 * 100) / 100 : null,
        wr_last20 !== null ? Math.round(wr_last20 * 100) / 100 : null,
        baseline_wr !== null ? Math.round(baseline_wr * 100) / 100 : null,
        consecutive_losses, trades_available, 0, notes,
      );

      console.log(`[${WORKER_NAME}] ${strategy}: score=${decay_score} status=${edge_status} — ${notes}`);
      processed++;

      if (edge_status === 'CRITICAL' || edge_status === 'COLLAPSE') {
        // Post veto to agent_messages
        try {
          const vetoPayload = JSON.stringify({
            reason:              'edge_decay_detected',
            decay_score,
            edge_status,
            wr_last5:            wr_last5 !== null ? Math.round(wr_last5 * 1000) / 10 : null,
            wr_last10:           wr_last10 !== null ? Math.round(wr_last10 * 1000) / 10 : null,
            baseline_wr:         baseline_wr !== null ? Math.round(baseline_wr * 1000) / 10 : null,
            consecutive_losses,
            notes,
          });
          insertVeto.run(strategy, vetoPayload);
          // Mark veto_posted = 1 on the row we just inserted
          db.prepare(`
            UPDATE edge_health_log SET veto_posted = 1
            WHERE strategy_name = ? AND id = (
              SELECT MAX(id) FROM edge_health_log WHERE strategy_name = ?
            )
          `).run(strategy, strategy);
        } catch (vetoErr) {
          console.error(`[${WORKER_NAME}] veto post error (${strategy}): ${vetoErr.message}`);
        }

        // ntfy alert
        const emoji   = edge_status === 'COLLAPSE' ? '🔴' : '🟠';
        const wr5pct  = wr_last5 !== null ? `${(wr_last5 * 100).toFixed(0)}%` : 'N/A';
        const basePct = baseline_wr !== null ? `${(baseline_wr * 100).toFixed(0)}%` : 'N/A';
        await sendNtfy(
          `${emoji} [${edge_status}] Edge decay — ${strategy}`,
          `Strategy: ${strategy}\nStatus: ${edge_status} (score ${decay_score})\n` +
          `WR last 5: ${wr5pct} | Baseline: ${basePct}\n` +
          `Consecutive losses: ${consecutive_losses}\nTriggers: ${notes}\n` +
          `Veto posted to consensus coordinator.`,
          edge_status === 'COLLAPSE' ? 'urgent' : 'high',
        );
        alerts++;
      }
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error processing ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed, alerts,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies checked, ${alerts} alert(s) sent`);
  db.close();
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
