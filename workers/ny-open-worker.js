'use strict';

/**
 * NY Open Pre-Open Analysis Worker
 *
 * Runs at 9:20 ET Mon–Fri (before the NY cash open at 9:30 ET).
 * Fetches the latest multi-timeframe bars, computes the day's LONG/SHORT
 * directional thesis, and writes it to the database for:
 *   1. Audit trail — what did the model think at 9:20 today?
 *   2. Dashboard — display the pre-open thesis to the operator
 *   3. Forensics — correlate thesis quality with live outcomes
 *
 * Run via PM2 cron or manually: node workers/ny-open-worker.js
 */

const path = require('path');
const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');
const { computePreopenBias } = require('../strategies/nq-ny-open-v3');

const WORKER_NAME = 'ny-open-worker';
const SYMBOL_MNQ  = process.env.SYMBOL_MNQ  || 'MNQ1!';
const SYMBOL_NQ   = process.env.SYMBOL_NQ   || 'NQ=F';

const db = openDb();

// ── Create thesis log table ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ny_open_thesis (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at    TEXT NOT NULL DEFAULT (datetime('now')),
    date_key     TEXT NOT NULL,
    direction    TEXT NOT NULL,
    long_score   INTEGER NOT NULL,
    short_score  INTEGER NOT NULL,
    confidence   INTEGER NOT NULL,
    bias_notes   TEXT,
    gap_pct      REAL,
    htf_4h       TEXT,
    htf_1h       TEXT,
    htf_15m      TEXT,
    archetype    TEXT,
    outcome      TEXT,
    outcome_at   TEXT
  )
`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ny_thesis_date ON ny_open_thesis(date_key)`);
db.exec(`DELETE FROM ny_open_thesis WHERE logged_at < datetime('now', '-90 days')`);

// ── Macro calendar table ──────────────────────────────────────────────────────
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

// ── Macro blackout check ──────────────────────────────────────────────────────
function checkMacroBlackout(dateKey) {
  const events = db.prepare(
    `SELECT event_name, impact FROM macro_calendar WHERE date_key = ? AND impact = 'HIGH'`
  ).all(dateKey);
  return events;
}

// ── Load recent bars from historical_bars table ────────────────────────────────
function loadBars(symbol, interval, daysBack) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 3600 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  for (const sym of [symbol, SYMBOL_NQ, SYMBOL_MNQ]) {
    const rows = db.prepare(
      `SELECT timestamp, open, high, low, close, volume
       FROM historical_bars
       WHERE symbol = ? AND interval = ? AND timestamp >= ?
       ORDER BY timestamp ASC`
    ).all(sym, interval, cutoff);
    if (rows.length >= 10) return rows;
  }
  return [];
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  try {
    const bars5m  = loadBars(SYMBOL_MNQ, '5m',  7);
    const bars1h  = loadBars(SYMBOL_MNQ, '1h',  30);
    const bars4h  = loadBars(SYMBOL_MNQ, '4h',  60);
    const barsDly = loadBars(SYMBOL_MNQ, '1d',  10);

    // Aggregate 1h → 4h if bars4h is empty
    let h4 = bars4h;
    if (h4.length < 3 && bars1h.length >= 4) {
      h4 = [];
      for (let i = 0; i + 3 < bars1h.length; i += 4) {
        const s = bars1h.slice(i, i + 4);
        h4.push({
          timestamp: s[0].timestamp, open: s[0].open,
          high: Math.max(...s.map(b => b.high)), low: Math.min(...s.map(b => b.low)),
          close: s[3].close, volume: s.reduce((a, b) => a + (b.volume || 0), 0),
        });
      }
    }

    if (bars5m.length < 10) {
      console.log(`[${WORKER_NAME}] insufficient 5m bars (${bars5m.length}) — skipping`);
      heartbeat(db, WORKER_NAME, 'IDLE', { skipped: true, reason: 'insufficient_bars' });
      process.exit(0);
    }

    // Aggregate 1h → daily if barsDly is empty
    let dly = barsDly;
    if (dly.length < 2 && bars1h.length >= 6) {
      const dayMap = new Map();
      for (const bar of bars1h) {
        const dk = bar.timestamp.slice(0, 10);
        if (!dayMap.has(dk)) dayMap.set(dk, []);
        dayMap.get(dk).push(bar);
      }
      dly = [...dayMap.entries()].sort().map(([dk, bars]) => ({
        timestamp: dk + ' 00:00:00',
        open:   bars[0].open,
        high:   Math.max(...bars.map(b => b.high)),
        low:    Math.min(...bars.map(b => b.low)),
        close:  bars[bars.length - 1].close,
        volume: bars.reduce((a, b) => a + (b.volume || 0), 0),
      }));
    }

    // Aggregate 5m → 15m
    const bars15m = [];
    for (let i = 0; i + 2 < bars5m.length; i += 3) {
      const s = bars5m.slice(i, i + 3);
      bars15m.push({
        timestamp: s[0].timestamp, open: s[0].open,
        high: Math.max(...s.map(b => b.high)), low: Math.min(...s.map(b => b.low)),
        close: s[2].close, volume: s.reduce((a, b) => a + (b.volume || 0), 0),
      });
    }

    const now     = new Date();
    const dateKey = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

    // ── Macro blackout gate ─────────────────────────────────────────────────
    const blockers = checkMacroBlackout(dateKey);
    if (blockers.length > 0) {
      const eventList = blockers.map(e => e.event_name).join(', ');
      console.log(`[${WORKER_NAME}] ${dateKey} MACRO BLACKOUT: ${eventList} — skipping thesis`);
      heartbeat(db, WORKER_NAME, 'IDLE', {
        skipped: true, reason: 'macro_blackout', events: eventList, dateKey,
      });
      db.close();
      process.exit(0);
    }

    const bias = computePreopenBias(bars5m, bars15m, bars1h, h4, dly);

    // Gap pct (today open vs prior day close)
    let gapPct = null;
    if (dly.length >= 2 && bars5m.length > 0) {
      const prevClose = dly[dly.length - 2]?.close;
      const curPrice  = bars5m[bars5m.length - 1].close;
      if (prevClose) gapPct = +((curPrice - prevClose) / prevClose * 100).toFixed(3);
    }

    // HTF labels
    const htf4hLabel  = bias.notes.find(n => n.startsWith('4H:'))  ?? 'unknown';
    const htf1hLabel  = bias.notes.find(n => n.startsWith('1H:'))  ?? 'unknown';
    const htf15mLabel = bias.notes.find(n => n.startsWith('15m:')) ?? 'unknown';

    db.prepare(`
      INSERT OR REPLACE INTO ny_open_thesis
        (logged_at, date_key, direction, long_score, short_score, confidence, bias_notes, gap_pct, htf_4h, htf_1h, htf_15m)
      VALUES
        (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dateKey,
      bias.direction,
      bias.longScore,
      bias.shortScore,
      bias.confidence,
      JSON.stringify(bias.notes),
      gapPct,
      htf4hLabel,
      htf1hLabel,
      htf15mLabel,
    );

    console.log(`[${WORKER_NAME}] ${dateKey} thesis: ${bias.direction} | L${bias.longScore} vs S${bias.shortScore} | conf=${bias.confidence}% | gap=${gapPct ?? 'n/a'}%`);
    console.log(`[${WORKER_NAME}] notes: ${bias.notes.join(', ')}`);

    bumpCycle(db, WORKER_NAME);
    heartbeat(db, WORKER_NAME, 'IDLE', {
      lastRun:    new Date().toISOString(),
      dateKey,
      direction:  bias.direction,
      confidence: bias.confidence,
      longScore:  bias.longScore,
      shortScore: bias.shortScore,
      gapPct,
    });

  } catch (err) {
    logWorkerError(db, WORKER_NAME, err);
    console.error(`[${WORKER_NAME}] error:`, err.message);
  }

  db.close();
  process.exit(0);
}

run();
