'use strict';

/**
 * DAILY DIGEST WORKER
 *
 * Sends one ntfy push every morning with a complete overnight summary.
 * Answers all 8 operational questions before the trading session starts:
 *
 *   1. Is the scanner running?
 *   2. Is market data fresh?
 *   3. Did signals fire recently?
 *   4. Are notifications working?
 *   5. Is Droplet healthy?
 *   6. Is Droplet learning?
 *   7. Did anything break overnight?
 *   8. Are strategies improving or degrading?
 *
 * Priority: min (appears silently in notification shade — informational only).
 * Uses emailFallback: false — this is a digest, not a critical alert.
 *
 * PM2 cron: 30 11 * * * (11:30 UTC = 7:30 AM EDT)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'digest-worker';

// ── Safe query helper ─────────────────────────────────────────────────────────
function q(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch (_) { return []; }
}
function qOne(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch (_) { return null; }
}

// ── Format helpers ────────────────────────────────────────────────────────────
function pct(n) { return n != null ? `${n}%` : '?%'; }
function num(n) { return n != null ? n.toLocaleString() : '?'; }
function trend(t) {
  if (t === 'improving') return '↑';
  if (t === 'declining') return '↓';
  return '→';
}

// ── Main digest run ───────────────────────────────────────────────────────────
async function run() {
  const db     = openDb();
  const nowIso = new Date().toISOString();
  const today  = nowIso.slice(0, 10);

  const lines = [];
  const warnings = [];

  // ── 1. Scanner ──────────────────────────────────────────────────────────────
  const scannerRow = qOne(db,
    "SELECT status, last_heartbeat, metadata FROM worker_health WHERE worker_name = 'scanner-worker'"
  );
  let scannerStatus = 'UNKNOWN';
  let scannerAgeMin = null;
  let scanCount = null;
  let pm2Restarts = null;
  let lastBarAge = null;

  if (scannerRow) {
    scannerStatus = scannerRow.status ?? 'UNKNOWN';
    if (scannerRow.last_heartbeat) {
      scannerAgeMin = Math.round(
        (Date.now() - new Date(scannerRow.last_heartbeat).getTime()) / 60_000
      );
    }
    try {
      const meta = scannerRow.metadata ? JSON.parse(scannerRow.metadata) : {};
      scanCount   = meta.scanCount   ?? null;
      pm2Restarts = meta.pm2Restarts ?? null;
      if (meta.lastBarTimestamp) {
        lastBarAge = Math.round(
          (Date.now() - new Date(meta.lastBarTimestamp).getTime()) / 60_000
        );
      }
    } catch (_) {}
  }

  const scannerHealthy = scannerAgeMin != null && scannerAgeMin < 10;
  const scannerLine = scannerHealthy
    ? `● RUNNING  | Hb: ${scannerAgeMin}m ago | Scans: ${num(scanCount)} | Restarts: ${pm2Restarts ?? '?'}`
    : `● ${scannerStatus}  | Hb: ${scannerAgeMin != null ? scannerAgeMin + 'm ago' : 'never'} | Restarts: ${pm2Restarts ?? '?'}`;

  if (!scannerHealthy) warnings.push('scanner not healthy');
  if (pm2Restarts > 3) warnings.push(`scanner restarted ${pm2Restarts}× since last deploy`);

  lines.push(`📡 Scanner: ${scannerLine}`);
  if (lastBarAge != null) {
    lines.push(`   Last bar: ${lastBarAge}m ago`);
  }

  // ── 2. Signals (last 24h) ──────────────────────────────────────────────────
  const sigRows = q(db, `
    SELECT strategy_name, COUNT(*) n
    FROM   signals
    WHERE  received_at >= datetime('now', '-24 hours')
    GROUP  BY strategy_name
    ORDER  BY n DESC
  `);
  const sigTotal = sigRows.reduce((a, r) => a + r.n, 0);

  const notifRow = qOne(db, `
    SELECT COUNT(*) n FROM notification_log
    WHERE  event_type = 'TRADE_ENTRY'
      AND  sent_at >= datetime('now', '-24 hours')
  `);
  const notifSent = notifRow?.n ?? 0;

  const latencyRow = qOne(db, `
    SELECT ROUND(AVG((julianday(n.sent_at) - julianday(s.received_at)) * 86400), 0) avg_s
    FROM   notification_log n
    JOIN   signals s ON s.id = n.signal_id
    WHERE  n.event_type = 'TRADE_ENTRY'
      AND  n.sent_at >= datetime('now', '-24 hours')
      AND  julianday(n.sent_at) > julianday(s.received_at)
  `);
  const latencyS = latencyRow?.avg_s;

  const notifLine = sigTotal > 0
    ? `${notifSent}/${sigTotal} delivered${latencyS != null ? ` (avg ${latencyS}s)` : ''}`
    : 'none fired';

  if (sigTotal > 0 && notifSent < sigTotal) {
    warnings.push(`${sigTotal - notifSent} signal(s) not notified`);
  }

  const stratBreakdown = sigRows.length
    ? sigRows.map(r => `${r.strategy_name}: ${r.n}`).join(' | ')
    : 'none';

  lines.push(`📊 Signals (24h): ${sigTotal} total — ${stratBreakdown}`);
  lines.push(`   Notifications: ${notifLine}`);

  // ── 3. Strategy health ─────────────────────────────────────────────────────
  const healthRows = q(db, `
    SELECT strategy_name, health_score, health_status, wr_30d, trades_30d, wr_trend,
           exp_30d, top_failure, top_failure_pct
    FROM   strategy_health_snapshots
    WHERE  snapshot_date = (
      SELECT MAX(s2.snapshot_date) FROM strategy_health_snapshots s2
      WHERE  s2.strategy_name = strategy_health_snapshots.strategy_name
    )
    ORDER  BY strategy_name
  `);

  if (healthRows.length) {
    lines.push('🧠 Strategy Health:');
    for (const r of healthRows) {
      const score  = r.health_score != null ? `${r.health_score}/100` : '?';
      const wr     = r.wr_30d != null ? `WR ${Math.round(r.wr_30d * 100)}%` : '';
      const trades = r.trades_30d != null ? `${r.trades_30d} trades` : '';
      const arrow  = trend(r.wr_trend);
      const exp    = r.exp_30d != null ? `E:${r.exp_30d.toFixed(1)}` : '';
      lines.push(`   ${r.strategy_name}: ${score} ${arrow} | ${[wr, trades, exp].filter(Boolean).join(' ')}`);
      if (r.health_score != null && r.health_score < 40) warnings.push(`${r.strategy_name} health score low (${r.health_score})`);
    }
  }

  // ── 4. Edge health ─────────────────────────────────────────────────────────
  const edgeRows = q(db, `
    SELECT strategy_name, edge_status, decay_score, consecutive_losses, veto_posted
    FROM   edge_health_log
    WHERE  checked_at = (
      SELECT MAX(e2.checked_at) FROM edge_health_log e2
      WHERE  e2.strategy_name = edge_health_log.strategy_name
    )
    ORDER  BY strategy_name
  `);

  if (edgeRows.length) {
    const edgeSummary = edgeRows.map(r => {
      const veto = r.veto_posted ? ' [VETOED]' : '';
      return `${r.strategy_name}: ${r.edge_status}${veto}`;
    }).join(' | ');
    lines.push(`⚡ Edge: ${edgeSummary}`);
    for (const r of edgeRows) {
      if (r.veto_posted) warnings.push(`${r.strategy_name} edge vetoed`);
      if (r.consecutive_losses >= 5) warnings.push(`${r.strategy_name} ${r.consecutive_losses} consecutive losses`);
    }
  }

  // ── 5. Droplet resources ───────────────────────────────────────────────────
  const dropletRow = qOne(db,
    "SELECT metadata FROM worker_health WHERE worker_name = 'droplet-health'"
  );
  if (dropletRow?.metadata) {
    try {
      const d = JSON.parse(dropletRow.metadata);
      lines.push(
        `💻 Droplet: CPU ${pct(d.cpu?.pct)} | RAM ${pct(d.ram?.pct)} | Disk ${pct(d.disk?.pct)} | WAL ${d.walMb ?? '?'} MB`
      );
      if (d.disk?.pct >= 75) warnings.push(`disk at ${d.disk.pct}%`);
      if (d.ram?.pct >= 80)  warnings.push(`RAM at ${d.ram.pct}%`);
    } catch (_) {}
  }

  // ── 6. Learning / intelligence workers ────────────────────────────────────
  const learnRow = qOne(db,
    "SELECT last_heartbeat FROM worker_health WHERE worker_name = 'learning-agent'"
  );
  const optimRow = qOne(db,
    "SELECT last_heartbeat FROM worker_health WHERE worker_name = 'optimizer'"
  );

  const learnAge = learnRow?.last_heartbeat
    ? Math.round((Date.now() - new Date(learnRow.last_heartbeat).getTime()) / 3_600_000)
    : null;
  const optimAge = optimRow?.last_heartbeat
    ? Math.round((Date.now() - new Date(optimRow.last_heartbeat).getTime()) / 3_600_000)
    : null;

  const learnLine = learnAge != null ? `Learning: ${learnAge}h ago` : 'Learning: never';
  const optimLine = optimAge != null ? `Optimizer: ${optimAge}h ago` : 'Optimizer: never';
  lines.push(`🔬 ${learnLine} | ${optimLine}`);

  // ── 7. Overnight alerts ────────────────────────────────────────────────────
  const watchdogRow = qOne(db,
    "SELECT metadata FROM worker_health WHERE worker_name = 'feed-watchdog'"
  );
  let overnightAlerts = [];
  if (watchdogRow?.metadata) {
    try {
      const m = JSON.parse(watchdogRow.metadata);
      if (m.alertsFired > 0) {
        overnightAlerts.push(`feed-watchdog fired ${m.alertsFired} alert(s)`);
        if (m.issues?.length) overnightAlerts.push(...m.issues);
      }
    } catch (_) {}
  }

  const dropletAlertRow = qOne(db,
    "SELECT metadata FROM worker_health WHERE worker_name = 'droplet-health'"
  );
  if (dropletAlertRow?.metadata) {
    try {
      const m = JSON.parse(dropletAlertRow.metadata);
      if (m.alerts?.length) overnightAlerts.push(...m.alerts);
    } catch (_) {}
  }

  lines.push(`⚠️  Overnight alerts: ${overnightAlerts.length ? overnightAlerts.join(', ') : 'none'}`);

  // ── 8. Worker health summary ───────────────────────────────────────────────
  const workerRows = q(db, `
    SELECT worker_name, status, last_heartbeat
    FROM   worker_health
    ORDER  BY worker_name
  `);

  const longRunners  = ['api-server', 'scanner-worker'];
  const unhealthy = workerRows.filter(w => {
    if (!longRunners.includes(w.worker_name)) return false;
    if (!w.last_heartbeat) return true;
    return Date.now() - new Date(w.last_heartbeat).getTime() > 10 * 60_000;
  });
  const errorWorkers = workerRows.filter(w => w.status === 'ERROR');

  const workerTotal = workerRows.length;
  const workerIssues = [...new Set([...unhealthy, ...errorWorkers].map(w => w.worker_name))];

  if (workerIssues.length) {
    lines.push(`🔴 Workers: ${workerIssues.join(', ')} in bad state`);
    warnings.push(`worker issues: ${workerIssues.join(', ')}`);
  } else {
    lines.push(`✅ Workers: ${workerTotal} processes nominal`);
  }

  // ── 9. Backup status ───────────────────────────────────────────────────────
  const backupRow = qOne(db,
    "SELECT metadata FROM worker_health WHERE worker_name = 'backup-worker'"
  );
  if (backupRow?.metadata) {
    try {
      const m = JSON.parse(backupRow.metadata);
      const lastRun = m.lastCompleted ?? null;
      const ageH = lastRun
        ? Math.round((Date.now() - new Date(lastRun).getTime()) / 3_600_000)
        : null;
      if (ageH != null && ageH > 28) warnings.push(`backup last ran ${ageH}h ago`);
    } catch (_) {}
  }

  // ── Compose final message ──────────────────────────────────────────────────
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });

  const header = warnings.length
    ? `⚠️ ${warnings.length} issue(s) need attention`
    : '✅ All systems nominal';

  const body = [
    `${dateLabel}  |  ${header}`,
    '',
    ...lines,
    warnings.length ? `\n⚡ Action needed: ${warnings.join(' | ')}` : '',
  ].filter(l => l !== undefined).join('\n').trimEnd();

  const title = warnings.length
    ? `Aurum Signals — Digest ⚠️ ${warnings.length} issue(s)`
    : 'Aurum Signals — Morning Digest ✅';

  const { ntfyOk } = await sendNotification(title, body, {
    priority:      'min',
    tags:          'memo,chart_with_upwards_trend',
    emailFallback: false,
  });

  heartbeat(db, WORKER_NAME, 'IDLE', {
    lastRun:   nowIso,
    warnings:  warnings.length ? warnings : null,
    ntfySent:  ntfyOk,
    sigTotal,
    scannerHealthy,
  });

  console.log(`[${WORKER_NAME}] Digest sent | warnings=${warnings.length} signals24h=${sigTotal} ntfy=${ntfyOk}`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  logWorkerError(null, WORKER_NAME, err);
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
});
