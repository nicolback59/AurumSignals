#!/usr/bin/env node
'use strict';

/**
 * Macro Event Calendar — NQ NY Open blackout manager
 *
 * Manages a macro_calendar table in the AurumSignals SQLite DB.
 * When a HIGH-impact event is listed for today, the ny-open-worker skips the
 * pre-open thesis and the evaluate() function skips firing a trade signal.
 *
 * Usage:
 *   node scripts/macro-calendar.js list
 *   node scripts/macro-calendar.js add 2026-05-28 "FOMC Decision" HIGH
 *   node scripts/macro-calendar.js add 2026-06-06 "NFP" HIGH
 *   node scripts/macro-calendar.js remove 2026-05-28
 *   node scripts/macro-calendar.js today
 *   node scripts/macro-calendar.js clear-past     # remove events older than 7 days
 *
 * Impact levels: HIGH (skip trade), MEDIUM (reduce size to MIN), LOW (log only)
 */

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

function findDb() {
  const envPath = process.env.DATABASE_URL?.replace('sqlite://', '')
    || process.env.DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of [
    path.join(__dirname, '..', 'aurum.db'),
    path.join(__dirname, '..', 'aurumsignals.db'),
    path.join(__dirname, '..', 'signals.db'),
    '/root/AurumSignals/aurum.db',
    '/root/AurumSignals/signals.db',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Cannot find SQLite DB. Set DB_PATH or run from project root.');
}

const VALID_IMPACTS = new Set(['HIGH', 'MEDIUM', 'LOW']);

function setupTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS macro_calendar (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date_key    TEXT    NOT NULL,
      event_name  TEXT    NOT NULL,
      impact      TEXT    NOT NULL DEFAULT 'HIGH',
      added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      notes       TEXT,
      UNIQUE(date_key, event_name)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_macro_cal_date ON macro_calendar(date_key)`);
}

const argv = process.argv.slice(2);
const cmd  = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`
Usage:
  node scripts/macro-calendar.js list
  node scripts/macro-calendar.js add <YYYY-MM-DD> "<event>" [HIGH|MEDIUM|LOW]
  node scripts/macro-calendar.js remove <YYYY-MM-DD>
  node scripts/macro-calendar.js today
  node scripts/macro-calendar.js clear-past

Impact levels:
  HIGH    — skip trade entirely (default)
  MEDIUM  — fire signal but force MIN conviction
  LOW     — log warning only, trade proceeds normally
`);
  process.exit(0);
}

const dbPath = findDb();
const db = new Database(dbPath);
setupTable(db);

if (cmd === 'list') {
  const rows = db.prepare(`
    SELECT date_key, impact, event_name, added_at
    FROM macro_calendar
    ORDER BY date_key ASC
  `).all();
  if (!rows.length) { console.log('  (no events)'); process.exit(0); }
  console.log(`\n  ${'Date'.padEnd(12)}  ${'Impact'.padEnd(8)}  Event`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const r of rows) {
    console.log(`  ${r.date_key.padEnd(12)}  ${r.impact.padEnd(8)}  ${r.event_name}`);
  }
  console.log();

} else if (cmd === 'add') {
  const dateKey   = argv[1];
  const eventName = argv[2];
  const impact    = (argv[3] ?? 'HIGH').toUpperCase();

  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    console.error('ERROR: date must be YYYY-MM-DD format');
    process.exit(1);
  }
  if (!eventName) {
    console.error('ERROR: event name is required');
    process.exit(1);
  }
  if (!VALID_IMPACTS.has(impact)) {
    console.error(`ERROR: impact must be HIGH, MEDIUM, or LOW (got: ${impact})`);
    process.exit(1);
  }

  db.prepare(`
    INSERT INTO macro_calendar (date_key, event_name, impact)
    VALUES (?, ?, ?)
    ON CONFLICT(date_key, event_name) DO UPDATE SET impact = excluded.impact
  `).run(dateKey, eventName, impact);
  console.log(`  Added: ${dateKey}  [${impact}]  ${eventName}`);

} else if (cmd === 'remove') {
  const dateKey = argv[1];
  if (!dateKey) { console.error('ERROR: provide a date (YYYY-MM-DD)'); process.exit(1); }
  const { changes } = db.prepare(`DELETE FROM macro_calendar WHERE date_key = ?`).run(dateKey);
  console.log(changes ? `  Removed ${changes} event(s) for ${dateKey}` : `  No events found for ${dateKey}`);

} else if (cmd === 'today') {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const rows  = db.prepare(`SELECT * FROM macro_calendar WHERE date_key = ? ORDER BY impact`).all(today);
  if (!rows.length) {
    console.log(`  ${today}: no macro events — trade proceeds normally`);
  } else {
    console.log(`\n  ${today}: ${rows.length} event(s):`);
    for (const r of rows) {
      const action = r.impact === 'HIGH' ? 'SKIP TRADE' : r.impact === 'MEDIUM' ? 'MIN SIZE' : 'LOG ONLY';
      console.log(`    [${r.impact}] ${r.event_name}  →  ${action}`);
    }
    console.log();
  }

} else if (cmd === 'clear-past') {
  const { changes } = db.prepare(
    `DELETE FROM macro_calendar WHERE date_key < date('now', '-7 days')`
  ).run();
  console.log(`  Removed ${changes} past event(s).`);

} else {
  console.error(`Unknown command: ${cmd}. Run with --help for usage.`);
  process.exit(1);
}

db.close();
