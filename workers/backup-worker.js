'use strict';

/**
 * BACKUP WORKER
 *
 * Nightly SQLite backup using better-sqlite3's built-in hot-backup API.
 * Runs as a PM2 cron (0 4 * * * — 4 AM UTC), starts fresh, exits on completion.
 *
 * Retention: keeps last 7 daily backups, deletes older ones automatically.
 * Destination: /root/AurumSignals/backups/signals-YYYY-MM-DD.db
 *
 * better-sqlite3 backup() is safe under concurrent writes — SQLite WAL mode
 * guarantees a consistent snapshot without locking the main process.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH      = process.env.DB_PATH || path.join(__dirname, '..', 'signals.db');
const BACKUP_DIR   = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_DAYS    = 7;
const WORKER_NAME  = 'backup-worker';

// ── Ensure backup directory exists ────────────────────────────────────────────
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  console.log(`[${WORKER_NAME}] Created backup directory: ${BACKUP_DIR}`);
}

// ── Build backup filename ─────────────────────────────────────────────────────
const today      = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const destPath   = path.join(BACKUP_DIR, `signals-${today}.db`);

// ── Run backup ────────────────────────────────────────────────────────────────
async function runBackup() {
  console.log(`[${WORKER_NAME}] Starting backup → ${destPath}`);
  const startMs = Date.now();

  const db = new Database(DB_PATH, { readonly: true });
  try {
    await db.backup(destPath);
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const sizeMb  = (fs.statSync(destPath).size / 1_048_576).toFixed(1);
    console.log(`[${WORKER_NAME}] Backup complete — ${sizeMb} MB in ${elapsed}s`);
  } finally {
    db.close();
  }

  // ── Prune backups older than KEEP_DAYS ────────────────────────────────────
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^signals-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();

  let pruned = 0;
  for (const f of files) {
    const dateStr = f.replace('signals-', '').replace('.db', '');
    if (dateStr < cutoffStr) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[${WORKER_NAME}] Pruned ${pruned} backup(s) older than ${KEEP_DAYS} days`);
  }

  // ── Optional: ntfy on success ──────────────────────────────────────────────
  const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC  || '';
  const ntfyToken = process.env.NTFY_TOKEN  || '';
  if (ntfyTopic) {
    try {
      const headers = {
        'Content-Type': 'text/plain',
        'Title':    'Aurum Signals — Nightly backup complete',
        'Priority': 'min',
        'Tags':     'floppy_disk',
      };
      if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
      const sizeMb = (fs.statSync(destPath).size / 1_048_576).toFixed(1);
      await fetch(`${ntfyUrl}/${ntfyTopic}`, {
        method: 'POST', headers,
        body: `DB backed up: ${sizeMb} MB → ${path.basename(destPath)}\nRetaining last ${KEEP_DAYS} days.`,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (_) { /* non-critical */ }
  }
}

runBackup()
  .then(() => {
    console.log(`[${WORKER_NAME}] Done`);
    process.exit(0);
  })
  .catch(err => {
    console.error(`[${WORKER_NAME}] FAILED:`, err.message);
    process.exit(1);
  });
