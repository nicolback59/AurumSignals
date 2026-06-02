'use strict';

/**
 * DROPLET HEALTH WORKER
 *
 * Runs every 5 minutes. Monitors OS-level resources on the Droplet —
 * CPU load, RAM usage, disk usage, and SQLite WAL file size.
 *
 * This closes the biggest monitoring blind spot: a full disk or OOM event
 * will crash every PM2 process simultaneously with no prior warning.
 *
 * Alert thresholds:
 *   CPU  > 70% (1-min avg) → WARNING   | > 90% → CRITICAL
 *   RAM  > 80%             → WARNING   | > 90% → CRITICAL
 *   Disk > 75%             → WARNING   | > 85% → CRITICAL
 *   WAL  > 50 MB           → WARNING (auto-checkpoint attempted)
 *
 * All alerts rate-limited to once per 30 min per type.
 * Recovery alerts fire when a condition clears.
 *
 * PM2 cron: *\/5 * * * * (every 5 minutes)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME       = 'droplet-health';
const DB_PATH           = process.env.DB_PATH || path.join(__dirname, '..', 'signals.db');
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const CPU_WARN_PCT  = 70;
const CPU_CRIT_PCT  = 90;
const RAM_WARN_PCT  = 80;
const RAM_CRIT_PCT  = 90;
const DISK_WARN_PCT = 75;
const DISK_CRIT_PCT = 85;
const WAL_WARN_MB   = 50;

// ── Collect OS metrics ────────────────────────────────────────────────────────
function getCpuPct() {
  const load     = os.loadavg()[0];          // 1-min load average
  const cores    = os.cpus().length;
  return { pct: Math.round(load / cores * 100), load1m: +load.toFixed(2), cores };
}

function getRamPct() {
  const total = os.totalmem();
  const free  = os.freemem();
  const used  = total - free;
  return {
    pct:     Math.round(used / total * 100),
    usedMb:  Math.round(used  / 1_048_576),
    totalMb: Math.round(total / 1_048_576),
  };
}

function getDiskPct() {
  try {
    const lines = execSync('df -k /', { timeout: 5_000 }).toString().trim().split('\n');
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    const totalK = parseInt(parts[1], 10);
    const usedK  = parseInt(parts[2], 10);
    if (!totalK) return null;
    return {
      pct:    Math.round(usedK / totalK * 100),
      usedGb: +(usedK  / 1_048_576).toFixed(1),
      totalGb:+(totalK / 1_048_576).toFixed(1),
    };
  } catch (_) { return null; }
}

function getWalMb() {
  try {
    const walPath = DB_PATH + '-wal';
    if (!fs.existsSync(walPath)) return 0;
    return +(fs.statSync(walPath).size / 1_048_576).toFixed(1);
  } catch (_) { return null; }
}

// ── Cooldown helpers ──────────────────────────────────────────────────────────
function loadState(db) {
  try {
    const row = db.prepare(
      "SELECT metadata FROM worker_health WHERE worker_name = ?"
    ).get(WORKER_NAME);
    const meta = row?.metadata ? JSON.parse(row.metadata) : {};
    return meta.alertState ?? {};
  } catch (_) { return {}; }
}

function canAlert(state, key) {
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS;
}

async function sendAlert(title, body, critical = false) {
  const { ntfyOk, emailOk } = await sendNotification(title, body, {
    priority:      critical ? 'urgent' : 'high',
    tags:          critical ? 'rotating_light,skull' : 'warning,computer',
    emailFallback: critical,
  });
  return ntfyOk || emailOk;
}

async function sendRecovery(title, body) {
  await sendNotification(title, body, {
    priority: 'default', tags: 'white_check_mark', emailFallback: false,
  });
}

// ── Main run ──────────────────────────────────────────────────────────────────
async function run() {
  const db     = openDb();
  const nowIso = new Date().toISOString();
  const state  = loadState(db);

  const alerts     = [];
  const recoveries = [];

  // ── Collect all metrics ───────────────────────────────────────────────────
  const cpu  = getCpuPct();
  const ram  = getRamPct();
  const disk = getDiskPct();
  const walMb = getWalMb();

  console.log(
    `[${WORKER_NAME}] cpu=${cpu.pct}% ram=${ram.pct}% disk=${disk?.pct ?? '?'}% wal=${walMb ?? '?'}MB`
  );

  // ── 1. CPU ────────────────────────────────────────────────────────────────
  const cpuCrit = cpu.pct >= CPU_CRIT_PCT;
  const cpuWarn = cpu.pct >= CPU_WARN_PCT;

  if (cpuCrit) {
    alerts.push(`cpu_critical: ${cpu.pct}% (load ${cpu.load1m} / ${cpu.cores} cores)`);
    if (canAlert(state, 'lastCpuAlert')) {
      const fired = await sendAlert(
        '🔴 Aurum — CPU Critical',
        `CPU load at ${cpu.pct}% (${cpu.load1m} avg / ${cpu.cores} cores).\nDroplet may be overwhelmed. Check: pm2 status | top`,
        true,
      );
      if (fired) { state.lastCpuAlert = nowIso; state.cpuWasHigh = true; }
    }
  } else if (cpuWarn) {
    alerts.push(`cpu_warning: ${cpu.pct}% (load ${cpu.load1m})`);
    if (canAlert(state, 'lastCpuAlert')) {
      const fired = await sendAlert(
        '🟠 Aurum — CPU High',
        `CPU load at ${cpu.pct}% (${cpu.load1m} avg / ${cpu.cores} cores).\nMonitor if sustained.`,
      );
      if (fired) { state.lastCpuAlert = nowIso; state.cpuWasHigh = true; }
    }
  } else if (state.cpuWasHigh) {
    await sendRecovery('✅ Aurum — CPU Normal', `CPU back to ${cpu.pct}%.`);
    state.cpuWasHigh = false;
    state.lastCpuAlert = null;
    recoveries.push('cpu_recovered');
  }

  // ── 2. RAM ────────────────────────────────────────────────────────────────
  const ramCrit = ram.pct >= RAM_CRIT_PCT;
  const ramWarn = ram.pct >= RAM_WARN_PCT;

  if (ramCrit) {
    alerts.push(`ram_critical: ${ram.pct}% (${ram.usedMb}/${ram.totalMb} MB)`);
    if (canAlert(state, 'lastRamAlert')) {
      const fired = await sendAlert(
        '🔴 Aurum — RAM Critical',
        `RAM at ${ram.pct}% (${ram.usedMb} MB / ${ram.totalMb} MB).\nOOM risk — PM2 may start killing processes. Check: pm2 status | free -h`,
        true,
      );
      if (fired) { state.lastRamAlert = nowIso; state.ramWasHigh = true; }
    }
  } else if (ramWarn) {
    alerts.push(`ram_warning: ${ram.pct}% (${ram.usedMb}/${ram.totalMb} MB)`);
    if (canAlert(state, 'lastRamAlert')) {
      const fired = await sendAlert(
        '🟠 Aurum — RAM High',
        `RAM at ${ram.pct}% (${ram.usedMb} MB / ${ram.totalMb} MB). Monitor for growth.`,
      );
      if (fired) { state.lastRamAlert = nowIso; state.ramWasHigh = true; }
    }
  } else if (state.ramWasHigh) {
    await sendRecovery('✅ Aurum — RAM Normal', `RAM back to ${ram.pct}% (${ram.usedMb} MB).`);
    state.ramWasHigh = false;
    state.lastRamAlert = null;
    recoveries.push('ram_recovered');
  }

  // ── 3. Disk ───────────────────────────────────────────────────────────────
  if (disk) {
    const diskCrit = disk.pct >= DISK_CRIT_PCT;
    const diskWarn = disk.pct >= DISK_WARN_PCT;

    if (diskCrit) {
      alerts.push(`disk_critical: ${disk.pct}% (${disk.usedGb}/${disk.totalGb} GB)`);
      if (canAlert(state, 'lastDiskAlert')) {
        const fired = await sendAlert(
          '🔴 Aurum — Disk Critical',
          `Disk at ${disk.pct}% (${disk.usedGb} GB / ${disk.totalGb} GB).\nSQLite writes will fail when disk is full.\nPrune backups or expand Droplet disk immediately.\nCheck: df -h | du -sh /root/AurumSignals/*`,
          true,
        );
        if (fired) { state.lastDiskAlert = nowIso; state.diskWasHigh = true; }
      }
    } else if (diskWarn) {
      alerts.push(`disk_warning: ${disk.pct}% (${disk.usedGb}/${disk.totalGb} GB)`);
      if (canAlert(state, 'lastDiskAlert')) {
        const fired = await sendAlert(
          '🟠 Aurum — Disk High',
          `Disk at ${disk.pct}% (${disk.usedGb} GB / ${disk.totalGb} GB).\nPlan for cleanup or expansion — full disk kills DB writes.`,
        );
        if (fired) { state.lastDiskAlert = nowIso; state.diskWasHigh = true; }
      }
    } else if (state.diskWasHigh) {
      await sendRecovery('✅ Aurum — Disk Normal', `Disk back to ${disk.pct}% (${disk.usedGb} GB used).`);
      state.diskWasHigh = false;
      state.lastDiskAlert = null;
      recoveries.push('disk_recovered');
    }
  }

  // ── 4. WAL size (auto-checkpoint if oversized) ────────────────────────────
  if (walMb !== null && walMb > WAL_WARN_MB) {
    alerts.push(`wal_large: ${walMb} MB`);
    console.log(`[${WORKER_NAME}] WAL ${walMb} MB — attempting checkpoint`);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      const walMbAfter = getWalMb();
      console.log(`[${WORKER_NAME}] Checkpoint complete — WAL now ${walMbAfter} MB`);
    } catch (err) {
      console.warn(`[${WORKER_NAME}] WAL checkpoint failed: ${err.message}`);
    }
    if (canAlert(state, 'lastWalAlert')) {
      const fired = await sendAlert(
        '🟠 Aurum — WAL File Large',
        `SQLite WAL file is ${walMb} MB (normal < 10 MB).\nAuto-checkpoint was attempted. If this recurs, check for long-running read transactions.`,
      );
      if (fired) { state.lastWalAlert = nowIso; }
    }
  } else if (state.lastWalAlert && walMb !== null && walMb < WAL_WARN_MB) {
    state.lastWalAlert = null; // reset silently
  }

  // ── 5. ADAPTIVE_OVERRIDES integrity ──────────────────────────────────────
  const OV_STRATEGIES = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
  const ovIssues = [];
  try {
    const ovRow = db.prepare(
      "SELECT params_json FROM strategy_params WHERE instrument = 'ADAPTIVE_OVERRIDES'"
    ).get();
    if (!ovRow?.params_json) {
      ovIssues.push('row missing');
    } else {
      const ov = JSON.parse(ovRow.params_json);
      for (const strat of OV_STRATEGIES) {
        const s = ov[strat];
        if (!s) continue;
        if (s.paused !== undefined && typeof s.paused !== 'boolean')     ovIssues.push(`${strat}.paused not boolean`);
        if (!Array.isArray(s.reasons ?? []))                             ovIssues.push(`${strat}.reasons not array`);
        if (!Array.isArray(s.blockedRegimes ?? []))                      ovIssues.push(`${strat}.blockedRegimes not array`);
        if (s.drawdownSizeMult  !== undefined && !Number.isFinite(s.drawdownSizeMult))  ovIssues.push(`${strat}.drawdownSizeMult NaN`);
        if (s.portfolioWeight   !== undefined && !Number.isFinite(s.portfolioWeight))   ovIssues.push(`${strat}.portfolioWeight NaN`);
        if (s.transitionSizeMult !== undefined && !Number.isFinite(s.transitionSizeMult)) ovIssues.push(`${strat}.transitionSizeMult NaN`);
      }
    }
  } catch (e) {
    ovIssues.push(`parse_error: ${e.message}`);
  }

  if (ovIssues.length) {
    alerts.push(`overrides_integrity: ${ovIssues.join(', ')}`);
    if (canAlert(state, 'lastOvAlert')) {
      const fired = await sendAlert(
        'Aurum — ADAPTIVE_OVERRIDES Corrupt',
        `ADAPTIVE_OVERRIDES integrity check failed:\n${ovIssues.join('\n')}\nScanner may be using invalid sizing/pause state.`,
        true,
      );
      if (fired) { state.lastOvAlert = nowIso; state.ovWasBad = true; }
    }
  } else if (state.ovWasBad) {
    await sendRecovery('Aurum — ADAPTIVE_OVERRIDES OK', 'Override integrity check passing.');
    state.ovWasBad = false;
    state.lastOvAlert = null;
    recoveries.push('overrides_recovered');
  }

  // ── 6. Worker heartbeat staleness ─────────────────────────────────────────
  const CRITICAL_WORKERS = [
    { name: 'reconcile-worker',          maxStaleMin: 15 },
    { name: 'circuit-breaker',           maxStaleMin: 90 },
    { name: 'drawdown-protection',       maxStaleMin: 90 },
    { name: 'signal-gate',               maxStaleMin: 90 },
    { name: 'portfolio-circuit-breaker', maxStaleMin: 45 },
  ];
  const staleWorkers = [];
  try {
    for (const { name, maxStaleMin } of CRITICAL_WORKERS) {
      const row = db.prepare(
        'SELECT last_heartbeat FROM worker_health WHERE worker_name = ?'
      ).get(name);
      if (!row) { staleWorkers.push(`${name}(never_seen)`); continue; }
      const ageMin = (Date.now() - new Date(row.last_heartbeat).getTime()) / 60000;
      if (ageMin > maxStaleMin) staleWorkers.push(`${name}(${Math.round(ageMin)}m_ago)`);
    }
  } catch (_) { /* non-critical */ }

  if (staleWorkers.length) {
    alerts.push(`stale_workers: ${staleWorkers.join(', ')}`);
    if (canAlert(state, 'lastStaleAlert')) {
      const fired = await sendAlert(
        'Aurum — Worker Heartbeat Stale',
        `${staleWorkers.length} worker(s) not heartbeating:\n${staleWorkers.join('\n')}\nCheck: pm2 status | pm2 logs`,
      );
      if (fired) { state.lastStaleAlert = nowIso; state.workersWereStale = true; }
    }
  } else if (state.workersWereStale) {
    await sendRecovery('Aurum — Workers Healthy', 'All critical workers heartbeating normally.');
    state.workersWereStale = false;
    state.lastStaleAlert = null;
    recoveries.push('workers_recovered');
  }

  // ── Persist state + heartbeat ─────────────────────────────────────────────
  heartbeat(db, WORKER_NAME, 'IDLE', {
    lastChecked: nowIso,
    cpu:  { pct: cpu.pct,   load1m: cpu.load1m,   cores: cpu.cores },
    ram:  { pct: ram.pct,   usedMb: ram.usedMb,   totalMb: ram.totalMb },
    disk: disk ? { pct: disk.pct, usedGb: disk.usedGb, totalGb: disk.totalGb } : null,
    walMb,
    alerts:     alerts.length ? alerts : null,
    recoveries: recoveries.length ? recoveries : null,
    alertState: state,
  });

  const statusLine = alerts.length
    ? `ISSUES: ${alerts.join(' | ')}`
    : `OK — cpu=${cpu.pct}% ram=${ram.pct}% disk=${disk?.pct ?? '?'}% wal=${walMb ?? '?'}MB`;
  console.log(`[${WORKER_NAME}] ${statusLine}`);

  db.close();
  process.exit(0);
}

run().catch(err => {
  logWorkerError(null, WORKER_NAME, err);
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
});
