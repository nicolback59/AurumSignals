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
const LIVE_STRATS  = new Set(['MNQ_INTRADAY', 'MGC_SCALP']);

// ── DB ────────────────────────────────────────────────────────────────────────
const db = openDb();
heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

// ── PT time helpers ───────────────────────────────────────────────────────────
function ptNow() {
  const now   = new Date();
  const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  return new Date(ptStr);
}

function ptDateStr(pt) {
  return `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, '0')}-${String(pt.getDate()).padStart(2, '0')}`;
}

// ── Prepared statements ───────────────────────────────────────────────────────
const _getPending = db.prepare(`
  SELECT s.id, s.entry, s.received_at, s.strategy_name, s.trade_style, s.instrument, s.direction
  FROM   signals s
  LEFT   JOIN outcomes o ON o.signal_id = s.id
  WHERE  o.id IS NULL
    AND  s.entry IS NOT NULL
    AND  (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
    AND  s.strategy_name IN ('MNQ_INTRADAY', 'MGC_SCALP')
`);

const _insertOutcome   = db.prepare(`INSERT OR IGNORE INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts) VALUES (?,?,?,?,?)`);
const _updateStatus    = db.prepare(`UPDATE signals SET trade_status = 'EXPIRED' WHERE id = ?`);
const _setSigReason    = db.prepare(`UPDATE signals  SET expiration_reason = ? WHERE id = ?`);
const _setOutReason    = db.prepare(`UPDATE outcomes SET expiration_reason = ? WHERE signal_id = ?`);

// ── Core sweep ────────────────────────────────────────────────────────────────
function runSweep() {
  const now       = new Date();
  const nowMs     = now.getTime();
  const nowIso    = now.toISOString();
  const pt        = ptNow();
  const ptHm      = pt.getHours() * 60 + pt.getMinutes();
  const ptDow     = pt.getDay();
  const todayStr  = ptDateStr(pt);

  const isFriClose    = ptDow === 5 && ptHm >= 13 * 60;
  const isWeekend     = ptDow === 6 || (ptDow === 0 && ptHm < 14 * 60);
  const isWeekendClose = isFriClose || isWeekend;
  const pastDailyClose = ptDow >= 1 && ptDow <= 5 && ptHm >= 13 * 60;

  const pending = _getPending.all();
  if (!pending.length) return 0;

  let swept = 0;

  const expireSignal = (sig, reason) => {
    try {
      _insertOutcome.run(sig.id, 'EXPIRED', sig.entry, nowIso, 0);
      _updateStatus.run(sig.id);
      _setSigReason.run(reason, sig.id);
      _setOutReason.run(reason, sig.id);
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
      const sigPt      = new Date(new Date(sig.received_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const sigDateStr = ptDateStr(sigPt);
      const sigHm      = sigPt.getHours() * 60 + sigPt.getMinutes();
      if (sigDateStr < todayStr || (sigDateStr === todayStr && sigHm < 13 * 60)) {
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

// ── Main ──────────────────────────────────────────────────────────────────────
let swept = 0;
try {
  swept = runSweep();
  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'IDLE', {
    pid:         process.pid,
    lastRun:     new Date().toISOString(),
    sweptCount:  swept,
  });
  console.log(`[${WORKER_NAME}] Sweep complete — ${swept} signal(s) expired`);
} catch (err) {
  logWorkerError(db, WORKER_NAME, err);
  console.error(`[${WORKER_NAME}] Fatal sweep error: ${err.message}`);
  process.exit(1);
}

process.exit(0);
