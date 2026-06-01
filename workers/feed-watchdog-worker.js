'use strict';

/**
 * FEED WATCHDOG WORKER
 *
 * Runs every 5 minutes. Monitors scanner process health and market data
 * freshness. During the active trading window (Mon-Fri 06:00-20:00 ET),
 * fires ntfy CRITICAL if the scanner goes silent or the data feed dies.
 *
 * Three alert conditions:
 *   scanner_stale — scanner-worker heartbeat > 10 min old (process likely dead)
 *   feed_stale    — bar data > 45 min old during active trading window (feed died)
 *   no_scans      — no scan_diagnostics rows in last 60 min during active window
 *
 * All alerts are rate-limited to once per 30 min per type to prevent
 * ntfy spam during extended outages. Recovery alerts fire when a previously
 * triggered condition clears.
 *
 * Alert state is persisted between runs via the worker_health metadata blob
 * so the 30-min rate limit survives process restarts.
 *
 * PM2 cron: *\/5 * * * * (every 5 minutes)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME          = 'feed-watchdog';
const SCANNER_STALE_S      = 10 * 60;   // alert if scanner heartbeat > 10 min old
const FEED_STALE_S         = 45 * 60;   // alert if bar data > 45 min old
const NO_SCAN_S            = 60 * 60;   // alert if no scans in last 60 min
const ALERT_COOLDOWN_MS    = 30 * 60 * 1000; // min 30 min between same-type alerts
const ACTIVE_WINDOW_START  = 6;         // 6 AM ET
const ACTIVE_WINDOW_END    = 20;        // 8 PM ET

// ── Market hours check (Mon–Fri, 06:00–20:00 ET) ─────────────────────────────
function isActiveWindow() {
  const et  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dow  = et.getDay();
  const hour = et.getHours();
  return dow >= 1 && dow <= 5 && hour >= ACTIVE_WINDOW_START && hour < ACTIVE_WINDOW_END;
}

// Thin wrapper — watchdog alerts always use email fallback since they signal infrastructure failure
async function sendNtfy(title, body, priority = 'high', tags = 'warning,rotating_light') {
  const { ntfyOk, emailOk } = await sendNotification(title, body, {
    priority, tags, emailFallback: true,
  });
  return ntfyOk || emailOk;
}

// ── Load persisted watchdog state from worker_health metadata ─────────────────
function loadState(db) {
  try {
    const row = db.prepare(
      "SELECT metadata FROM worker_health WHERE worker_name = ?"
    ).get(WORKER_NAME);
    if (!row?.metadata) return {};
    const meta = JSON.parse(row.metadata);
    return meta.watchdogState ?? {};
  } catch (_) { return {}; }
}

// ── Check if cooldown has elapsed for this alert type ────────────────────────
function canAlert(state, key) {
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS;
}

// ── Main watchdog run ─────────────────────────────────────────────────────────
async function run() {
  const db = openDb();

  const nowMs  = Date.now();
  const nowIso = new Date().toISOString();
  const state  = loadState(db);
  const active = isActiveWindow();

  let alertsFired    = 0;
  let recoveriesFired = 0;
  const issues = [];

  // ── 1. Scanner process heartbeat ─────────────────────────────────────────
  let scannerStale    = false;
  let scannerAgeS     = null;
  let barAgeS         = null;

  try {
    const row = db.prepare(`
      SELECT last_heartbeat, metadata FROM worker_health
      WHERE worker_name = 'scanner-worker'
    `).get();

    if (row) {
      scannerAgeS  = row.last_heartbeat
        ? Math.round((nowMs - new Date(row.last_heartbeat).getTime()) / 1000)
        : null;
      scannerStale = scannerAgeS != null && scannerAgeS > SCANNER_STALE_S;

      // Extract last bar timestamp from metadata
      try {
        const meta = row.metadata ? JSON.parse(row.metadata) : {};
        if (meta.lastBarTimestamp) {
          barAgeS = Math.round((nowMs - new Date(meta.lastBarTimestamp).getTime()) / 1000);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[${WORKER_NAME}] scanner health query failed: ${err.message}`);
  }

  if (scannerStale) {
    issues.push(`scanner_stale: last heartbeat ${Math.round(scannerAgeS / 60)} min ago`);

    if (canAlert(state, 'lastScannerAlert')) {
      const ageMin = Math.round(scannerAgeS / 60);
      const fired  = await sendNtfy(
        '🔴 Aurum Signals — Scanner Down',
        `Scanner process has not heartbeated in ${ageMin} minutes.\n` +
        `Last heartbeat was around ${ageMin} min ago.\n` +
        `Check: pm2 status | pm2 logs scanner-worker`,
        'urgent',
        'rotating_light,skull',
      );
      if (fired) {
        state.lastScannerAlert  = nowIso;
        state.scannerWasDown    = true;
        alertsFired++;
        console.log(`[${WORKER_NAME}] ALERT: scanner_stale (${ageMin} min)`);
      }
    }
  } else if (state.scannerWasDown) {
    // Recovery
    await sendNtfy(
      '✅ Aurum Signals — Scanner Recovered',
      `Scanner heartbeat restored. All systems nominal.`,
      'default', 'white_check_mark',
    );
    state.scannerWasDown  = false;
    state.lastScannerAlert = null;
    recoveriesFired++;
    console.log(`[${WORKER_NAME}] RECOVERY: scanner_stale cleared`);
  }

  // ── 2. Feed data freshness (market hours only) ────────────────────────────
  if (active) {
    let feedStale = false;

    if (barAgeS != null && barAgeS > FEED_STALE_S) {
      feedStale = true;
      issues.push(`feed_stale: last bar ${Math.round(barAgeS / 60)} min ago`);

      if (canAlert(state, 'lastFeedAlert')) {
        const ageMin = Math.round(barAgeS / 60);
        const fired  = await sendNtfy(
          '🟠 Aurum Signals — Feed Stale',
          `Market data feed appears dead. Last bar received ${ageMin} minutes ago.\n` +
          `Scanner is running but not receiving price data.\n` +
          `Check TradingView webhook connection.`,
          'high',
          'warning,bar_chart',
        );
        if (fired) {
          state.lastFeedAlert = nowIso;
          state.feedWasStale  = true;
          alertsFired++;
          console.log(`[${WORKER_NAME}] ALERT: feed_stale (${ageMin} min)`);
        }
      }
    } else if (state.feedWasStale && barAgeS != null && barAgeS < FEED_STALE_S) {
      await sendNtfy(
        '✅ Aurum Signals — Feed Restored',
        `Market data feed is healthy again. Last bar: ${Math.round(barAgeS / 60)} min ago.`,
        'default', 'white_check_mark',
      );
      state.feedWasStale  = false;
      state.lastFeedAlert = null;
      recoveriesFired++;
      console.log(`[${WORKER_NAME}] RECOVERY: feed_stale cleared`);
    }

    // ── 3. Scan activity check (belt-and-suspenders) ──────────────────────
    try {
      const scanRow = db.prepare(`
        SELECT MAX(scanned_at) AS last_scanned_at FROM scan_diagnostics
        WHERE scanned_at >= datetime('now', '-2 hours')
      `).get();

      if (scanRow?.last_scanned_at) {
        const scanAgeS = Math.round(
          (nowMs - new Date(scanRow.last_scanned_at).getTime()) / 1000
        );

        if (scanAgeS > NO_SCAN_S && !scannerStale) {
          issues.push(`no_scans: last scan event ${Math.round(scanAgeS / 60)} min ago`);

          if (canAlert(state, 'lastNoScanAlert')) {
            const ageMin = Math.round(scanAgeS / 60);
            const fired  = await sendNtfy(
              '🟡 Aurum Signals — No Scan Activity',
              `No scan events logged in the last ${ageMin} minutes during market hours.\n` +
              `Scanner process is alive but may not be processing bars.\n` +
              `Check: pm2 logs scanner-worker`,
              'default',
              'warning,eyes',
            );
            if (fired) {
              state.lastNoScanAlert = nowIso;
              alertsFired++;
              console.log(`[${WORKER_NAME}] ALERT: no_scans (${ageMin} min)`);
            }
          }
        } else if (state.lastNoScanAlert && scanAgeS <= NO_SCAN_S) {
          state.lastNoScanAlert = null; // reset silently
        }
      }
    } catch (_) {}
  }

  // ── Persist state + heartbeat ─────────────────────────────────────────────
  heartbeat(db, WORKER_NAME, 'IDLE', {
    lastChecked:      nowIso,
    activeWindow:     active,
    scannerAgeS,
    barAgeS,
    issues:           issues.length ? issues : null,
    alertsFired,
    recoveriesFired,
    watchdogState:    state,
  });

  const statusLine = issues.length
    ? `issues: ${issues.join(' | ')}`
    : `all clear${active ? '' : ' (outside active window)'}`;
  console.log(`[${WORKER_NAME}] ${statusLine} | alerts=${alertsFired} recoveries=${recoveriesFired}`);

  db.close();
  process.exit(0);
}

run().catch(err => {
  logWorkerError(null, WORKER_NAME, err);
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
});
