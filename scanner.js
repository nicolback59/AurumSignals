'use strict';

/**
 * STANDALONE SCANNER — for local development / direct process invocation.
 *
 * In production (Render.com), the scanner runs inside server.js via scanner-core.js.
 * Use this file only if you want to run the scanner as a completely separate process,
 * e.g. during local testing alongside a separately-started server.
 *
 * Usage:
 *   node scanner.js
 *   npm run scan
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { Scanner } = require('./scanner-core');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'signals.db');

// Ensure DB directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db     = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── CRITICAL: run migrations BEFORE db.exec(schema) ───────────────────────────
// schema.sql creates idx_signals_strategy index which references strategy_name.
// If that column is missing (old DB), the index creation fails with SQLITE_ERROR.
// Migrations add the missing column first so the index creation succeeds.
function applyMigrations() {
  const hasSignals = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='signals'").get();
  if (hasSignals) {
    const cols = db.prepare('PRAGMA table_info(signals)').all().map(r => r.name);
    if (!cols.includes('strategy_name')) {
      db.exec('ALTER TABLE signals ADD COLUMN strategy_name TEXT');
      console.log('[migration] Added strategy_name to signals');
    }
  }
  const hasBtTrades = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backtest_trades'").get();
  if (hasBtTrades) {
    const btCols = db.prepare('PRAGMA table_info(backtest_trades)').all().map(r => r.name);
    if (!btCols.includes('strategy_name')) {
      db.exec('ALTER TABLE backtest_trades ADD COLUMN strategy_name TEXT');
      console.log('[migration] Added strategy_name to backtest_trades');
    }
    if (!btCols.includes('confidence')) {
      db.exec('ALTER TABLE backtest_trades ADD COLUMN confidence INTEGER');
      console.log('[migration] Added confidence to backtest_trades');
    }
  }
}
applyMigrations(); // ← must run before db.exec(schema)

db.exec(schema);   // ← now safe: columns exist before indexes are created

const scanner = new Scanner(db);

// Log all events to console in standalone mode
scanner.on('signal',   s  => { /* already logged by Scanner */ });
scanner.on('error',    e  => console.error('[scanner-standalone] error:', e));
scanner.on('backtest', bt => console.log('[scanner-standalone] backtest done:', bt.instrument, bt.runId));

scanner.start();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    scanner.stop();
    db.close();
    process.exit(0);
  });
}
