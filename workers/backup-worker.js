'use strict';

/**
 * BACKUP WORKER
 *
 * Nightly SQLite backup using better-sqlite3's built-in hot-backup API.
 * Runs as a PM2 cron (0 4 * * * — 4 AM UTC), starts fresh, exits on completion.
 *
 * Stage 1 — Local backup:
 *   Destination: /root/AurumSignals/backups/signals-YYYY-MM-DD.db
 *   Retention:   last 7 daily snapshots (local disk)
 *
 * Stage 2 — Cloud backup (DO Spaces / S3-compatible):
 *   Requires env vars: DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET
 *   Optional:          DO_SPACES_REGION (default: nyc3), DO_SPACES_ENDPOINT
 *   Uploads to:        s3://<BUCKET>/backups/signals-YYYY-MM-DD.db
 *   Retention:         last 30 daily snapshots (cloud)
 *   Skipped silently if env vars are not set.
 *
 * better-sqlite3 backup() is WAL-safe — consistent snapshot under concurrent writes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH     = process.env.DB_PATH    || path.join(__dirname, '..', 'signals.db');
const BACKUP_DIR  = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_LOCAL  = 7;   // local retention in days
const KEEP_CLOUD  = 30;  // cloud retention in days
const WORKER_NAME = 'backup-worker';

// ── DO Spaces / S3 configuration ──────────────────────────────────────────────
const SPACES_KEY      = process.env.DO_SPACES_KEY      || '';
const SPACES_SECRET   = process.env.DO_SPACES_SECRET   || '';
const SPACES_BUCKET   = process.env.DO_SPACES_BUCKET   || '';
const SPACES_REGION   = process.env.DO_SPACES_REGION   || 'nyc3';
const SPACES_ENDPOINT = process.env.DO_SPACES_ENDPOINT ||
  `https://${SPACES_REGION}.digitaloceanspaces.com`;
const CLOUD_ENABLED   = !!(SPACES_KEY && SPACES_SECRET && SPACES_BUCKET);

// ── Ensure local backup directory exists ──────────────────────────────────────
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  console.log(`[${WORKER_NAME}] Created backup directory: ${BACKUP_DIR}`);
}

const today    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const destPath = path.join(BACKUP_DIR, `signals-${today}.db`);

// ── Cloud upload via AWS SDK v3 (S3-compatible) ───────────────────────────────
async function uploadToCloud(localPath, filename) {
  const { S3Client, PutObjectCommand,
          ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

  const client = new S3Client({
    endpoint:    SPACES_ENDPOINT,
    region:      SPACES_REGION,
    credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET },
    forcePathStyle: false,
  });

  const key = `backups/${filename}`;

  // Upload
  console.log(`[${WORKER_NAME}] Uploading to ${SPACES_BUCKET}/${key} ...`);
  const uploadStart = Date.now();
  await client.send(new PutObjectCommand({
    Bucket:      SPACES_BUCKET,
    Key:         key,
    Body:        fs.createReadStream(localPath),
    ContentType: 'application/octet-stream',
  }));
  const uploadElapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
  const sizeMb = (fs.statSync(localPath).size / 1_048_576).toFixed(1);
  console.log(`[${WORKER_NAME}] Cloud upload complete — ${sizeMb} MB in ${uploadElapsed}s`);

  // Prune cloud files older than KEEP_CLOUD days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_CLOUD);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: SPACES_BUCKET,
      Prefix: 'backups/',
    }));

    const toDelete = (listed.Contents ?? []).filter(obj => {
      const match = obj.Key.match(/signals-(\d{4}-\d{2}-\d{2})\.db$/);
      return match && match[1] < cutoffStr;
    });

    for (const obj of toDelete) {
      await client.send(new DeleteObjectCommand({ Bucket: SPACES_BUCKET, Key: obj.Key }));
      console.log(`[${WORKER_NAME}] Pruned cloud file: ${obj.Key}`);
    }
    if (toDelete.length > 0) {
      console.log(`[${WORKER_NAME}] Pruned ${toDelete.length} cloud backup(s) older than ${KEEP_CLOUD} days`);
    }
  } catch (pruneErr) {
    console.warn(`[${WORKER_NAME}] Cloud prune error (non-fatal): ${pruneErr.message}`);
  }

  return { sizeMb, uploadElapsed };
}

// ── Main backup run ───────────────────────────────────────────────────────────
async function runBackup() {
  // ── Stage 1: Local backup ────────────────────────────────────────────────
  console.log(`[${WORKER_NAME}] Starting local backup → ${destPath}`);
  const localStart = Date.now();

  const db = new Database(DB_PATH, { readonly: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }

  const localElapsed = ((Date.now() - localStart) / 1000).toFixed(1);
  const localSizeMb  = (fs.statSync(destPath).size / 1_048_576).toFixed(1);
  console.log(`[${WORKER_NAME}] Local backup complete — ${localSizeMb} MB in ${localElapsed}s`);

  // Prune local backups older than KEEP_LOCAL days
  const cutoffLocal = new Date();
  cutoffLocal.setDate(cutoffLocal.getDate() - KEEP_LOCAL);
  const cutoffLocalStr = cutoffLocal.toISOString().slice(0, 10);

  const localFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^signals-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();

  let pruned = 0;
  for (const f of localFiles) {
    const dateStr = f.replace('signals-', '').replace('.db', '');
    if (dateStr < cutoffLocalStr) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[${WORKER_NAME}] Pruned ${pruned} local backup(s) older than ${KEEP_LOCAL} days`);
  }

  // ── Stage 2: Cloud backup ────────────────────────────────────────────────
  let cloudResult = null;
  let cloudError  = null;

  if (CLOUD_ENABLED) {
    try {
      cloudResult = await uploadToCloud(destPath, path.basename(destPath));
    } catch (err) {
      cloudError = err.message;
      console.error(`[${WORKER_NAME}] Cloud upload FAILED: ${err.message}`);
    }
  } else {
    console.log(`[${WORKER_NAME}] Cloud backup skipped — DO_SPACES_KEY/SECRET/BUCKET not configured`);
  }

  // ── ntfy summary ─────────────────────────────────────────────────────────
  const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC  || '';
  const ntfyToken = process.env.NTFY_TOKEN  || '';

  if (ntfyTopic) {
    const cloudLine = CLOUD_ENABLED
      ? (cloudError
          ? `☁️ Cloud upload FAILED: ${cloudError}`
          : `☁️ Cloud upload OK — ${SPACES_BUCKET}/backups/${path.basename(destPath)}`)
      : '☁️ Cloud backup not configured';

    const body = [
      `💾 Local: ${localSizeMb} MB → ${path.basename(destPath)} (${localElapsed}s)`,
      cloudLine,
      `🗂 Local retention: last ${KEEP_LOCAL} days | Cloud retention: last ${KEEP_CLOUD} days`,
    ].join('\n');

    try {
      const headers = {
        'Content-Type': 'text/plain',
        'Title':    cloudError
          ? 'Aurum Signals — Backup: local OK, cloud FAILED'
          : 'Aurum Signals — Nightly backup complete',
        'Priority': cloudError ? 'default' : 'min',
        'Tags':     cloudError ? 'floppy_disk,warning' : 'floppy_disk',
      };
      if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
      await fetch(`${ntfyUrl}/${ntfyTopic}`, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (_) { /* non-critical */ }
  }

  // Exit non-zero if cloud was attempted but failed — PM2 will log the error
  if (CLOUD_ENABLED && cloudError) {
    throw new Error(`Cloud upload failed: ${cloudError}`);
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
