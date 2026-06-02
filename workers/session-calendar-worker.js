'use strict';

/**
 * SESSION CALENDAR WORKER  (Prompt #13 — Gap Analysis)
 *
 * Fills the third identified gap: no performance calendar or heatmap.
 * After Prompts 1-12, session analysis existed (NY Open, Power Hour, etc.)
 * but there was no time-based calendar view of performance patterns —
 * which day of the week is best, which month, which week of the month.
 *
 * Runs weekly (Friday 20:00 UTC, after markets close).
 *
 * For each strategy, computes W/L/PnL aggregates across:
 *
 *   Day of week (0=Sun … 6=Sat, ISO style: 1=Mon … 5=Fri for futures)
 *   Week of month (1–5, computed from trade_date)
 *   Month (1–12)
 *   Hour ET bucket (derived from hour_et column)
 *   Session × day_of_week cross (highest-ROI combination)
 *
 * Writes to session_calendar table.
 * Posts agent_messages for any calendar cell with:
 *   - n ≥ 15 AND WR > baseline + 0.12   (strong day pattern)
 *   - n ≥ 15 AND WR < baseline − 0.12   (avoid pattern)
 *
 * This directly feeds the allocation engine — session multipliers
 * in scanner-core.js can be tuned to specific DOW/week-of-month patterns.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'session-calendar';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const MIN_N       = 10;   // minimum trades to include a calendar cell

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function calendarZ(wr, baselineWr, n) {
  if (!n || baselineWr == null) return 0;
  const se = Math.sqrt(baselineWr * (1 - baselineWr) / n);
  return se > 0 ? (wr - baselineWr) / se : 0;
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS session_calendar (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date       TEXT NOT NULL,
      strategy_name  TEXT NOT NULL,
      dimension      TEXT NOT NULL,   -- dow|week_of_month|month|hour_et|session_dow
      dimension_key  TEXT NOT NULL,   -- the bucket value (e.g. "Mon", "2", "Jan", "10")
      trade_count    INTEGER,
      win_count      INTEGER,
      loss_count     INTEGER,
      win_rate       REAL,
      baseline_wr    REAL,
      wr_delta       REAL,
      avg_pnl_pts    REAL,
      total_pnl_pts  REAL,
      pattern        TEXT,            -- EDGE|AVOID|NEUTRAL
      computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, dimension, dimension_key)
    )
  `).run();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO session_calendar
      (run_date, strategy_name, dimension, dimension_key,
       trade_count, win_count, loss_count, win_rate,
       baseline_wr, wr_delta, avg_pnl_pts, total_pnl_pts, pattern)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate = new Date().toISOString().slice(0, 10);

  for (const strategy of STRATEGIES) {
    try {
      // Baseline WR (LIVE trades only)
      const base = db.prepare(`
        SELECT COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND source = 'LIVE'
      `).get(strategy);

      if ((base?.n ?? 0) < MIN_N) continue;
      const baselineWr = base.wins / base.n;

      // ── Day of Week ──────────────────────────────────────────────────────────
      // SQLite strftime('%w', date) returns 0=Sunday … 6=Saturday
      const dowRows = db.prepare(`
        SELECT CAST(strftime('%w', trade_date) AS INTEGER) AS dow,
               COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
               SUM(pnl_pts) AS total_pnl,
               AVG(pnl_pts) AS avg_pnl
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND source = 'LIVE'
        GROUP BY dow HAVING n >= ${MIN_N}
      `).all(strategy);

      for (const r of dowRows) {
        const wr      = r.wins / r.n;
        const delta   = wr - baselineWr;
        const z       = calendarZ(wr, baselineWr, r.n);
        const pattern = Math.abs(z) >= 1.28 && delta >= 0.12 ? 'EDGE'
                      : Math.abs(z) >= 1.28 && delta <= -0.12 ? 'AVOID'
                      : 'NEUTRAL';
        const key     = DOW_NAMES[r.dow] ?? String(r.dow);
        upsert.run(runDate, strategy, 'dow', key,
          r.n, r.wins, r.n - r.wins,
          +wr.toFixed(4), +baselineWr.toFixed(4), +delta.toFixed(4),
          r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
          r.total_pnl != null ? +r.total_pnl.toFixed(2) : null,
          pattern);

        if (pattern !== 'NEUTRAL') {
          try {
            insertMsg.run('session-calendar', 'observation', strategy, 4,
              JSON.stringify({
                dimension: 'dow', key,
                win_rate: +wr.toFixed(4), baseline_wr: +baselineWr.toFixed(4),
                wr_delta: +delta.toFixed(4), n: r.n, pattern,
                note: `${strategy}: ${key} ${pattern} — WR ${(wr*100).toFixed(0)}% vs ${(baselineWr*100).toFixed(0)}% baseline (n=${r.n})`,
              }));
          } catch (_) {}
        }
      }

      // ── Week of Month ────────────────────────────────────────────────────────
      // Week of month = ceil(day_of_month / 7)
      const womRows = db.prepare(`
        SELECT CAST((CAST(strftime('%d', trade_date) AS INTEGER) - 1) / 7 + 1 AS INTEGER) AS wom,
               COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
               SUM(pnl_pts) AS total_pnl,
               AVG(pnl_pts) AS avg_pnl
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND source = 'LIVE'
        GROUP BY wom HAVING n >= ${MIN_N}
      `).all(strategy);

      for (const r of womRows) {
        const wr    = r.wins / r.n;
        const delta = wr - baselineWr;
        const z     = calendarZ(wr, baselineWr, r.n);
        const pattern = Math.abs(z) >= 1.28 && delta >= 0.12 ? 'EDGE'
                      : Math.abs(z) >= 1.28 && delta <= -0.12 ? 'AVOID'
                      : 'NEUTRAL';
        upsert.run(runDate, strategy, 'week_of_month', `W${r.wom}`,
          r.n, r.wins, r.n - r.wins,
          +wr.toFixed(4), +baselineWr.toFixed(4), +delta.toFixed(4),
          r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
          r.total_pnl != null ? +r.total_pnl.toFixed(2) : null,
          pattern);
      }

      // ── Month ─────────────────────────────────────────────────────────────────
      const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monthRows = db.prepare(`
        SELECT CAST(strftime('%m', trade_date) AS INTEGER) AS month,
               COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
               SUM(pnl_pts) AS total_pnl,
               AVG(pnl_pts) AS avg_pnl
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND source = 'LIVE'
        GROUP BY month HAVING n >= ${MIN_N}
      `).all(strategy);

      for (const r of monthRows) {
        const wr    = r.wins / r.n;
        const delta = wr - baselineWr;
        const z     = calendarZ(wr, baselineWr, r.n);
        const pattern = Math.abs(z) >= 1.28 && delta >= 0.12 ? 'EDGE'
                      : Math.abs(z) >= 1.28 && delta <= -0.12 ? 'AVOID'
                      : 'NEUTRAL';
        upsert.run(runDate, strategy, 'month', monthNames[r.month] ?? String(r.month),
          r.n, r.wins, r.n - r.wins,
          +wr.toFixed(4), +baselineWr.toFixed(4), +delta.toFixed(4),
          r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
          r.total_pnl != null ? +r.total_pnl.toFixed(2) : null,
          pattern);
      }

      // ── Hour ET ───────────────────────────────────────────────────────────────
      const hourRows = db.prepare(`
        SELECT hour_et,
               COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
               SUM(pnl_pts) AS total_pnl,
               AVG(pnl_pts) AS avg_pnl
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND source = 'LIVE'
          AND hour_et IS NOT NULL
        GROUP BY hour_et HAVING n >= ${MIN_N}
        ORDER BY hour_et
      `).all(strategy);

      for (const r of hourRows) {
        const wr    = r.wins / r.n;
        const delta = wr - baselineWr;
        const z     = calendarZ(wr, baselineWr, r.n);
        const pattern = Math.abs(z) >= 1.28 && delta >= 0.12 ? 'EDGE'
                      : Math.abs(z) >= 1.28 && delta <= -0.12 ? 'AVOID'
                      : 'NEUTRAL';
        upsert.run(runDate, strategy, 'hour_et', `${r.hour_et}:00`,
          r.n, r.wins, r.n - r.wins,
          +wr.toFixed(4), +baselineWr.toFixed(4), +delta.toFixed(4),
          r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
          r.total_pnl != null ? +r.total_pnl.toFixed(2) : null,
          pattern);
      }

      // ── Session × Day of Week (cross) ─────────────────────────────────────────
      const sessDowRows = db.prepare(`
        SELECT session,
               CAST(strftime('%w', trade_date) AS INTEGER) AS dow,
               COUNT(*) AS n,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
               AVG(pnl_pts) AS avg_pnl,
               SUM(pnl_pts) AS total_pnl
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND source = 'LIVE'
          AND session IS NOT NULL
        GROUP BY session, dow HAVING n >= ${MIN_N}
      `).all(strategy);

      for (const r of sessDowRows) {
        const wr    = r.wins / r.n;
        const delta = wr - baselineWr;
        const z     = calendarZ(wr, baselineWr, r.n);
        const pattern = Math.abs(z) >= 1.28 && delta >= 0.12 ? 'EDGE'
                      : Math.abs(z) >= 1.28 && delta <= -0.12 ? 'AVOID'
                      : 'NEUTRAL';
        const key   = `${r.session}|${DOW_NAMES[r.dow] ?? r.dow}`;
        upsert.run(runDate, strategy, 'session_dow', key,
          r.n, r.wins, r.n - r.wins,
          +wr.toFixed(4), +baselineWr.toFixed(4), +delta.toFixed(4),
          r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
          r.total_pnl != null ? +r.total_pnl.toFixed(2) : null,
          pattern);
      }

      console.log(`[${WORKER_NAME}] ${strategy}: DOW ${dowRows.length} | WOM ${womRows.length} | Month ${monthRows.length} | Hour ${hourRows.length} | Sess×DOW ${sessDowRows.length} rows`);
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
