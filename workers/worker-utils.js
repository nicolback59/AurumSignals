'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'signals.db');

/** Open a DB connection with WAL + busy-timeout — safe for concurrent workers. */
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');   // 15 s — handles 5+ concurrent writers at :00/:30
  db.pragma('foreign_keys = ON');
  return db;
}

/** Upsert this worker's health row. Call every scan cycle or meaningful state change. */
function heartbeat(db, workerName, status, meta = {}) {
  try {
    db.prepare(`
      INSERT INTO worker_health (worker_name, status, last_heartbeat, metadata)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(worker_name) DO UPDATE SET
        status         = excluded.status,
        last_heartbeat = excluded.last_heartbeat,
        metadata       = excluded.metadata
    `).run(workerName, status, JSON.stringify(meta));
  } catch (err) {
    console.error(`[${workerName}] heartbeat write error: ${err.message}`);
  }
}

/** Increment cycle_count and set last_cycle_at. */
function bumpCycle(db, workerName) {
  try {
    db.prepare(`
      UPDATE worker_health
      SET cycle_count   = COALESCE(cycle_count, 0) + 1,
          last_cycle_at = datetime('now')
      WHERE worker_name = ?
    `).run(workerName);
  } catch (_) { /* non-critical */ }
}

/** Increment error_count and store the last error message. */
function logWorkerError(db, workerName, err) {
  if (!db) {
    // db unavailable (e.g. fatal crash before openDb) — at least surface to stderr
    console.error(`[${workerName}] logWorkerError (no db): ${err?.message ?? err}`);
    return;
  }
  try {
    db.prepare(`
      UPDATE worker_health
      SET error_count = COALESCE(error_count, 0) + 1,
          last_error  = ?
      WHERE worker_name = ?
    `).run(String(err?.message ?? err), workerName);
  } catch (_) { /* non-critical */ }
}

/**
 * Return today's date in Eastern Time (America/New_York) as a YYYY-MM-DD string.
 * Uses Intl.DateTimeFormat so it handles DST automatically and works correctly
 * on UTC servers.  Trading days follow ET — use this instead of
 * new Date().toISOString().slice(0,10) whenever "today" means the ET calendar day.
 */
function getEtDateStr(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Read the latest metadata blob for a worker (returns parsed object or {}). */
function getWorkerMeta(db, workerName) {
  try {
    const row = db.prepare(
      'SELECT metadata FROM worker_health WHERE worker_name = ?'
    ).get(workerName);
    return row?.metadata ? JSON.parse(row.metadata) : {};
  } catch (_) { return {}; }
}

/**
 * Send a notification via ntfy with optional Sendgrid email fallback.
 *
 * ntfy env vars:   NTFY_URL, NTFY_TOPIC, NTFY_TOKEN (optional)
 * email env vars:  SENDGRID_API_KEY, ALERT_EMAIL_TO
 *                  ALERT_EMAIL_FROM  (optional — defaults to ALERT_EMAIL_TO)
 *
 * @param {string}  title
 * @param {string}  body
 * @param {object}  opts
 * @param {string}  opts.priority      — ntfy priority (default|high|urgent)
 * @param {string}  opts.tags          — ntfy emoji tags
 * @param {boolean} opts.emailFallback — if true, email fires when ntfy fails
 * @returns {{ ntfyOk: boolean, emailOk: boolean }}
 */
async function sendNotification(title, body, { priority = 'default', tags = 'bell', emailFallback = false } = {}) {
  const ntfyUrl   = (process.env.NTFY_URL  || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC || '';
  const ntfyToken = process.env.NTFY_TOKEN || '';

  let ntfyOk = false;

  if (ntfyTopic) {
    try {
      const headers = {
        'Content-Type': 'text/plain',
        'Title':    title,
        'Priority': priority,
        'Tags':     tags,
      };
      if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
      const r = await fetch(`${ntfyUrl}/${ntfyTopic}`, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(8_000),
      });
      ntfyOk = r.ok;
    } catch (_) { ntfyOk = false; }
  }

  let emailOk = false;

  if (emailFallback && !ntfyOk) {
    const sgKey     = process.env.SENDGRID_API_KEY  || '';
    const emailTo   = process.env.ALERT_EMAIL_TO    || '';
    const emailFrom = process.env.ALERT_EMAIL_FROM  || emailTo;

    if (sgKey && emailTo) {
      try {
        const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sgKey}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: emailTo }] }],
            from:    { email: emailFrom },
            subject: `[Aurum Signals] ${title}`,
            content: [{ type: 'text/plain', value: body }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        emailOk = r.status === 202;
        if (emailOk) {
          console.log(`[sendNotification] ntfy failed — email fallback delivered to ${emailTo}`);
        }
      } catch (_) { emailOk = false; }
    }
  }

  return { ntfyOk, emailOk };
}

/**
 * Atomically read-modify-write the ADAPTIVE_OVERRIDES JSON blob.
 *
 * Uses BEGIN IMMEDIATE so the write lock is acquired BEFORE reading — this
 * prevents the read-modify-write race that occurs when 5+ workers fire
 * simultaneously at :00/:30 and each overwrites the others' changes.
 *
 * @param {Database} db
 * @param {function(object): void} fn  — receives the parsed overrides object;
 *   mutate it in place.  Do NOT use await inside fn — this is synchronous.
 */
function withOverridesLock(db, fn) {
  const locked = db.transaction(() => {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE key = 'ADAPTIVE_OVERRIDES'"
    ).get();
    const overrides = row?.params_json ? JSON.parse(row.params_json) : {};
    fn(overrides);
    db.prepare(`
      INSERT INTO strategy_params (key, params_json, updated_at)
      VALUES ('ADAPTIVE_OVERRIDES', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = excluded.updated_at
    `).run(JSON.stringify(overrides));
  });
  try {
    locked.immediate();
  } catch (err) {
    console.error('[withOverridesLock] transaction failed:', err.message);
    throw err;
  }
}

/** Read-only load of ADAPTIVE_OVERRIDES (no lock needed for reads in WAL mode). */
function loadOverrides(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE key = 'ADAPTIVE_OVERRIDES'"
    ).get();
    return row?.params_json ? JSON.parse(row.params_json) : {};
  } catch (_) { return {}; }
}

module.exports = {
  openDb, heartbeat, bumpCycle, logWorkerError, getWorkerMeta, sendNotification,
  withOverridesLock, loadOverrides, getEtDateStr,
  DB_PATH,
};
