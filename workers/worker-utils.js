'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'signals.db');

/** Open a DB connection with WAL + busy-timeout — safe for concurrent workers. */
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
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
  try {
    db.prepare(`
      UPDATE worker_health
      SET error_count = COALESCE(error_count, 0) + 1,
          last_error  = ?
      WHERE worker_name = ?
    `).run(String(err?.message ?? err), workerName);
  } catch (_) { /* non-critical */ }
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

module.exports = { openDb, heartbeat, bumpCycle, logWorkerError, getWorkerMeta, DB_PATH };
