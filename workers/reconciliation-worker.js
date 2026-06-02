'use strict';

/**
 * RECONCILIATION WORKER
 *
 * Standalone PM2 process — owns trade lifecycle management.
 * Runs independently of the scanner and API server so a sweep failure
 * never affects live scanning or the web interface.
 *
 * Responsibilities:
 *   1. _sweepExpiredSignals — expire signals past market close / weekend / max hold
 *   2. _fixStuckTrades      — close genuinely stuck ACTIVE rows
 *   3. Writes its own heartbeat to worker_health
 *
 * Schedule: PM2 cron_restart every 5 min, autorestart: false.
 * Each PM2 cron invocation starts a fresh Node process, runs once, then exits.
 * This is intentional — no polling loop needed.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');
const {
  STATES,
  STRATEGY_CONFIG,
  MAX_HOLD_MS_BY_STRATEGY,
  shouldExpire,
} = require('../signals/signal-state-machine');

const WORKER_NAME  = 'reconcile-worker';
const LIVE_STRATS  = new Set(['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE']);

// ── DB ────────────────────────────────────────────────────────────────────────
const db = openDb();
heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

// ── PT time helpers ───────────────────────────────────────────────────────────
// Uses Intl.DateTimeFormat.formatToParts() — spec-defined, works correctly on any
// server timezone (including UTC Droplets). Does NOT use new Date(localeString)
// which is implementation-defined and can return wrong values near midnight.
function getPtParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const hours   = parseInt(parts.hour,   10) % 24; // formatToParts may return '24' for midnight
  const minutes = parseInt(parts.minute, 10);
  const DOW     = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hours,
    minutes,
    hm:      hours * 60 + minutes,
    dow:     DOW[parts.weekday] ?? 0,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// ── Prepared statements ───────────────────────────────────────────────────────
const _getPending = db.prepare(`
  SELECT s.id, s.entry, s.received_at, s.strategy_name, s.trade_style, s.instrument, s.direction
  FROM   signals s
  LEFT   JOIN outcomes o ON o.signal_id = s.id
  WHERE  o.id IS NULL
    AND  s.entry IS NOT NULL
    AND  s.received_at IS NOT NULL
    AND  (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
    AND  s.strategy_name IN ('MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE')
`);

const _insertOutcome   = db.prepare(`INSERT OR IGNORE INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts) VALUES (?,?,?,?,?)`);
const _updateStatus    = db.prepare(`UPDATE signals SET trade_status = 'EXPIRED' WHERE id = ?`);
const _setSigReason    = db.prepare(`UPDATE signals  SET expiration_reason = ? WHERE id = ?`);
const _setOutReason    = db.prepare(`UPDATE outcomes SET expiration_reason = ? WHERE signal_id = ?`);

// Wrap the 4-statement expiry in a single transaction — prevents partial writes
// where the outcome row is inserted but trade_status is never updated (or vice versa).
const _expireTxn = db.transaction((sigId, entry, nowIso, reason) => {
  _insertOutcome.run(sigId, 'EXPIRED', entry, nowIso, 0);
  _updateStatus.run(sigId);
  _setSigReason.run(reason, sigId);
  _setOutReason.run(reason, sigId);
});

// ── Core sweep ────────────────────────────────────────────────────────────────
function runSweep() {
  const now    = new Date();
  const nowMs  = now.getTime();
  const nowIso = now.toISOString();
  const pt     = getPtParts();

  const isFriClose     = pt.dow === 5 && pt.hm >= 13 * 60;
  const isWeekend      = pt.dow === 6 || (pt.dow === 0 && pt.hm < 14 * 60);
  const isWeekendClose = isFriClose || isWeekend;
  const pastDailyClose = pt.dow >= 1 && pt.dow <= 5 && pt.hm >= 13 * 60;
  const todayStr       = pt.dateStr;

  const pending = _getPending.all();
  if (!pending.length) return 0;

  let swept = 0;

  const expireSignal = (sig, reason) => {
    try {
      _expireTxn(sig.id, sig.entry, nowIso, reason);
      console.log(`[${WORKER_NAME}] EXPIRED #${sig.id} ${sig.instrument} ${sig.direction} reason=${reason}`);
      swept++;
    } catch (err) {
      console.error(`[${WORKER_NAME}] expireSignal error #${sig.id}: ${err.message}`);
    }
  };

  for (const sig of pending) {
    const stratCfg = STRATEGY_CONFIG[sig.strategy_name] || {};

    // RULE D: Weekend forced close
    if (isWeekendClose && !stratCfg.allowHoldWeekend) {
      expireSignal(sig, 'EXPIRED_WEEKEND_CLOSE');
      continue;
    }

    // RULE C: Weekday market close at 13:00 PT
    if (pastDailyClose && !stratCfg.allowHoldOvernight) {
      if (!sig.received_at) { expireSignal(sig, 'EXPIRED_MARKET_CLOSE'); continue; }
      const sigPt = getPtParts(new Date(sig.received_at));
      if (sigPt.dateStr < todayStr || (sigPt.dateStr === todayStr && sigPt.hm < 13 * 60)) {
        expireSignal(sig, 'EXPIRED_MARKET_CLOSE');
        continue;
      }
    }

    // RULE B: Max hold time exceeded (23h — effectively only catches orphaned signals)
    const { expire, reason } = shouldExpire(sig, now);
    if (expire) {
      expireSignal(sig, reason || 'EXPIRED_MAX_HOLD');
    }
  }

  return swept;
}

// ── Data retention — prune high-growth tables on a rolling window ─────────────
// Runs after every sweep. Deletes are cheap on small row counts and safe
// because all these tables are diagnostic/operational, not source-of-truth.
function runRetention() {
  const counts = {};
  const prune = (label, sql) => {
    try {
      const info = db.prepare(sql).run();
      if (info.changes > 0) {
        counts[label] = info.changes;
        console.log(`[${WORKER_NAME}] retention: pruned ${info.changes} row(s) from ${label}`);
      }
    } catch (err) {
      console.warn(`[${WORKER_NAME}] retention ${label} error: ${err.message}`);
    }
  };

  // scan_diagnostics: keep 90 days — enough for all rolling analysis windows
  prune('scan_diagnostics',
    "DELETE FROM scan_diagnostics WHERE scanned_at < datetime('now', '-90 days')");

  // signal_rejections: keep 30 days — frequency-agent only needs recent near-misses
  prune('signal_rejections',
    "DELETE FROM signal_rejections WHERE rejected_at < datetime('now', '-30 days')");

  // regime_states: keep 90 days — regime_transitions preserves events permanently
  prune('regime_states',
    "DELETE FROM regime_states WHERE classified_at < datetime('now', '-90 days')");

  // agent_messages: consumed/rejected messages older than 7 days serve no purpose
  prune('agent_messages',
    "DELETE FROM agent_messages WHERE status IN ('consumed','rejected') AND created_at < datetime('now', '-7 days')");

  // sse_queue: belt-and-suspenders — server polls + deletes on 1s loop, but
  // catch anything that slipped through during downtime
  prune('sse_queue',
    "DELETE FROM sse_queue WHERE expires_at < datetime('now', '-5 minutes')");

  return counts;
}

// ── Main ──────────────────────────────────────────────────────────────────────
let swept    = 0;
let retained = {};
try {
  swept    = runSweep();
  retained = runRetention();
  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'IDLE', {
    pid:         process.pid,
    lastRun:     new Date().toISOString(),
    sweptCount:  swept,
    retained,
  });
  console.log(`[${WORKER_NAME}] Sweep complete — ${swept} signal(s) expired`);
} catch (err) {
  logWorkerError(db, WORKER_NAME, err);
  console.error(`[${WORKER_NAME}] Fatal sweep error: ${err.message}`);
  process.exit(1);
}

process.exit(0);
