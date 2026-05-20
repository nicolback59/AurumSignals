'use strict';

/**
 * SCANNER WORKER — standalone process for VPS/PM2 deployment
 *
 * Runs the scanner loop independently of the web server.
 * Deploy this on a VPS with PM2 for always-on reliability.
 *
 * Start:  pm2 start ecosystem.config.js
 * Logs:   pm2 logs aurum-scanner
 * Status: pm2 status
 */

const path    = require('path');
const Database = require('better-sqlite3');

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'aurum.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ── Run migrations before anything else ──────────────────────────────────────
// Re-use server.js migration logic by requiring it if available,
// otherwise run inline schema creation
try {
  // Apply schema from schema.sql
  const fs     = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
} catch (e) {
  console.error('[scanner-worker] Schema load warning:', e.message);
}

// ── Scanner ───────────────────────────────────────────────────────────────────
const Scanner = require('../scanner-core');

const scanner = new Scanner(db, {
  symbol:           process.env.SCANNER_SYMBOL       || 'NQ=F',
  symbolMgc:        process.env.SCANNER_SYMBOL_MGC   || 'GC=F',
  scanInterval:     parseInt(process.env.SCAN_INTERVAL || '30') * 1000,
  duplicateGuardMin: parseInt(process.env.SCANNER_DUPLICATE_GUARD_MIN || '5'),
  baseScore:        parseInt(process.env.SCANNER_MIN_SCORE || '6'),
  dailySignalCap:   parseInt(process.env.DAILY_SIGNAL_CAP || '20'),
  logLevel:         process.env.SCANNER_LOG_LEVEL || 'signal',
  ntfyUrl:          (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, ''),
  ntfyTopic:        process.env.NTFY_TOPIC || '',
  ntfyToken:        process.env.NTFY_TOKEN || '',
  btIntervalH:      parseFloat(process.env.BACKTEST_INTERVAL_H || '6'),
  btBars:           parseInt(process.env.BACKTEST_BARS || '2000'),
});

// ── Event logging ─────────────────────────────────────────────────────────────
scanner.on('signal', sig => {
  console.log(`[signal] ${sig.instrument} ${sig.direction} ${sig.strategy_name} entry=${sig.entry} conf=${sig.confidence} tier=${sig.tier}`);
});

scanner.on('outcome', ({ signalId, instrument, result, pnlPts }) => {
  console.log(`[outcome] #${signalId} ${instrument} ${result} ${pnlPts >= 0 ? '+' : ''}${pnlPts}pts`);
});

scanner.on('heartbeat', ({ scanCount, marketClosed, feedType }) => {
  if (scanCount % 20 === 0) {
    console.log(`[heartbeat] scans=${scanCount} market=${marketClosed ? 'CLOSED' : 'OPEN'} feed=${feedType}`);
  }
});

scanner.on('error', ({ msg, err }) => {
  console.error(`[error] ${msg}: ${err}`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('[scanner-worker] Starting Aurum Signals scanner...');
console.log(`[scanner-worker] DB: ${DB_PATH}`);
console.log(`[scanner-worker] NTFY topic: ${process.env.NTFY_TOPIC ? process.env.NTFY_TOPIC.slice(0,3) + '***' : 'NOT SET'}`);
console.log(`[scanner-worker] Scan interval: ${process.env.SCAN_INTERVAL || '30'}s`);

scanner.start();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[scanner-worker] Received ${signal} — shutting down gracefully`);
  try { scanner.stop(); } catch {}
  setTimeout(() => {
    db.close();
    console.log('[scanner-worker] DB closed. Bye.');
    process.exit(0);
  }, 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', err => {
  console.error('[scanner-worker] UNCAUGHT EXCEPTION:', err.message, err.stack);
  // Don't crash — PM2 will restart if needed
});

process.on('unhandledRejection', (reason) => {
  console.error('[scanner-worker] UNHANDLED REJECTION:', reason);
});
