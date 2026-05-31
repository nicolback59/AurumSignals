'use strict';

/**
 * SCANNER WORKER
 *
 * Standalone PM2 process — owns the live market scanner.
 * Isolated from the API server so a scanner crash never takes down the API,
 * and an API restart never interrupts live scanning.
 *
 * State bridge:
 *   - Writes scanner state to worker_health.metadata every scan cycle.
 *   - Writes SSE events to sse_queue; api-server polls and forwards to clients.
 *   - Writes last 200 bars to bar_cache for the mini-chart API endpoint.
 *
 * Start: pm2 start ecosystem.config.js (SCANNER_MODE=worker env required in api-server)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError, getWorkerMeta } = require('./worker-utils');
const { Scanner } = require('../scanner-core');

const WORKER_NAME = 'scanner-worker';
const BAR_CACHE_LIMIT = 200;

// ── DB connection ─────────────────────────────────────────────────────────────
const db = openDb();
// ── PM2 restart counter ───────────────────────────────────────────────────────
// Incremented on every process start so /api/health can surface crash frequency.
const _prevMeta    = getWorkerMeta(db, WORKER_NAME);
const _pm2Restarts = (_prevMeta.pm2Restarts ?? 0) + 1;

heartbeat(db, WORKER_NAME, 'STARTING', { pid: process.pid, pm2Restarts: _pm2Restarts });

// ── Prepared statements ───────────────────────────────────────────────────────
const _insertSse = db.prepare(`
  INSERT INTO sse_queue (event_type, data, created_at, expires_at)
  VALUES (?, ?, datetime('now'), datetime('now', '+15 seconds'))
`);

const _upsertBarCache = db.prepare(`
  INSERT INTO bar_cache (instrument, bars_5m, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(instrument) DO UPDATE SET
    bars_5m    = excluded.bars_5m,
    updated_at = excluded.updated_at
`);

// ── Helper: push an event into sse_queue for api-server to broadcast ──────────
function queueSse(eventType, data) {
  try { _insertSse.run(eventType, JSON.stringify(data)); } catch (_) { /* non-critical */ }
}

// ── Helper: update bar cache (called after each scan with fresh bars) ─────────
function updateBarCache(scanner) {
  try {
    const bars = scanner._lastGoodBars;
    if (!bars) return;
    if (bars.mnq5m?.length) {
      _upsertBarCache.run('MNQ', JSON.stringify(bars.mnq5m.slice(-BAR_CACHE_LIMIT)));
    }
    if (bars.mgc5m?.length) {
      _upsertBarCache.run('MGC', JSON.stringify(bars.mgc5m.slice(-BAR_CACHE_LIMIT)));
    }
  } catch (_) { /* non-critical */ }
}

// ── Helper: write full scanner state to worker_health ─────────────────────────
function syncState(scanner) {
  heartbeat(db, WORKER_NAME, 'RUNNING', {
    pid:               process.pid,
    pm2Restarts:       _pm2Restarts,
    running:           !!scanner._running,
    feedConnected:     scanner._feed?.isConnected() ?? false,
    feedType:          scanner.feedType ?? 'unknown',
    dataStatus:        scanner._lastDataStatus ?? 'INIT',
    scanCount:         scanner._scanCount ?? 0,
    consecutiveErrors: scanner._consecutiveErrors ?? 0,
    lastFetchAt:       scanner._lastFetchAt ?? null,
    lastNtfyAttemptAt: scanner._lastNtfyAttemptAt ?? null,
    lastNtfySuccessAt: scanner._lastNtfySuccessAt ?? null,
    lastNtfyStatus:    scanner._lastNtfyStatus ?? null,
    lastNtfyError:     scanner._lastNtfyError  ?? null,
    lastBarTimestamp:  scanner._lastGoodBars?.mnq5m?.slice(-1)[0]?.timestamp ?? null,
  });
}

// ── Scanner setup ─────────────────────────────────────────────────────────────
const scanner = new Scanner(db);

scanner.on('scan',      data => { queueSse('scan', data);      bumpCycle(db, WORKER_NAME); updateBarCache(scanner); syncState(scanner); });
scanner.on('signal',    data => queueSse('signal',      data));
scanner.on('heartbeat', data => queueSse('heartbeat',   data));
scanner.on('backtest',  data => queueSse('backtest',    data));
scanner.on('outcome',   data => queueSse('outcome',     data));
scanner.on('error',     data => { queueSse('scannerError', data); logWorkerError(db, WORKER_NAME, data); });

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  scanner.start();
  console.log(`[${WORKER_NAME}] Scanner started — pid ${process.pid}`);
} catch (err) {
  logWorkerError(db, WORKER_NAME, err);
  heartbeat(db, WORKER_NAME, 'ERROR', { error: err.message });
  process.exit(1);
}

// ── Global error handlers ─────────────────────────────────────────────────────
// Without these, any unhandled async rejection in the scanner crashes the process.
// server.js has these too but scanner-worker is a separate process that doesn't
// inherit them — each process needs its own handlers.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message ?? String(reason);
  console.error(`[${WORKER_NAME}] Unhandled rejection: ${msg}`);
  try { logWorkerError(db, WORKER_NAME, { message: msg, stack: reason?.stack }); } catch (_) {}
  try { heartbeat(db, WORKER_NAME, 'RUNNING', { lastError: msg }); } catch (_) {}
  // Do NOT exit — log and continue so PM2 doesn't spam restarts
});

process.on('uncaughtException', async (err) => {
  console.error(`[${WORKER_NAME}] Uncaught exception:`, err.message, err.stack);
  try { logWorkerError(db, WORKER_NAME, err); } catch (_) {}
  try { heartbeat(db, WORKER_NAME, 'ERROR', { error: err.message }); } catch (_) {}

  // Send CRITICAL ntfy before exiting so the crash is immediately visible.
  // 3-second timeout — if ntfy is unreachable we still exit promptly.
  const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC  || '';
  const ntfyToken = process.env.NTFY_TOKEN  || '';
  if (ntfyTopic) {
    try {
      const headers = {
        'Content-Type': 'text/plain',
        'Title':    '[CRITICAL] Scanner crashed — restarting',
        'Priority': 'urgent',
        'Tags':     'rotating_light,x',
      };
      if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
      await fetch(`${ntfyUrl}/${ntfyTopic}`, {
        method: 'POST', headers,
        body: `Scanner process crashed.\nError: ${err.message}\n${err.stack?.slice(0, 400) ?? ''}\nPM2 will restart automatically.`,
        signal: AbortSignal.timeout(3_000),
      });
    } catch (_) { /* never block exit on ntfy failure */ }
  }

  process.exit(1); // Exit cleanly so PM2 can restart once, not loop
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    console.log(`[${WORKER_NAME}] ${sig} received — stopping scanner`);
    heartbeat(db, WORKER_NAME, 'STOPPED', {});
    try { scanner.stop(); } catch (_) {}
    process.exit(0);
  });
}
