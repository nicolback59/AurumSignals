'use strict';

/**
 * TRADE DNA WORKER
 *
 * Nightly full-refresh of the trade_dna materialized table.
 * Deletes and rebuilds from two sources:
 *   1. LIVE  — signals JOIN outcomes JOIN signal_features
 *   2. BACKTEST — backtest_trades (most recent run per instrument)
 *
 * Pre-computes derived ratios used by stop-agent, tp-agent, and any future
 * ML model: mfe_sl_ratio, mae_sl_ratio, rr_achieved.
 *
 * PM2 cron: 30 4 * * * (4:30 AM UTC — 30 min after nightly backup completes)
 * autorestart: false — runs once, exits.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'trade-dna-worker';
const LIVE_STRATS = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];

function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  // Ensure table + indexes exist (server.js migrations handle this at startup,
  // but guard here in case the worker runs before the next server restart).
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_dna (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT    NOT NULL,
      signal_id     INTEGER,
      bt_trade_id   INTEGER,
      strategy_name TEXT    NOT NULL,
      instrument    TEXT,
      direction     TEXT,
      outcome       TEXT    NOT NULL,
      session       TEXT,
      regime        TEXT,
      hour_et       INTEGER,
      trade_date    TEXT,
      entry         REAL,
      sl            REAL,
      tp1           REAL,
      sl_pts        REAL,
      tp1_pts       REAL,
      rr_planned    REAL,
      pnl_pts       REAL,
      mfe_pts       REAL,
      mae_pts       REAL,
      hold_time_min REAL,
      exit_type     TEXT,
      mfe_sl_ratio  REAL,
      mae_sl_ratio  REAL,
      rr_achieved   REAL,
      confidence    INTEGER,
      archetype     TEXT,
      entry_type    TEXT,
      htf_bias      TEXT,
      atr           REAL,
      rsi           REAL,
      refreshed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dna_strategy  ON trade_dna(strategy_name, trade_date DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dna_outcome   ON trade_dna(outcome, strategy_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dna_source    ON trade_dna(source, strategy_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dna_refreshed ON trade_dna(refreshed_at DESC)`);

  let liveRows = 0;
  let btRows   = 0;

  const stratList = LIVE_STRATS.map(() => '?').join(',');

  db.transaction(() => {
    db.prepare('DELETE FROM trade_dna').run();

    // ── 1. LIVE trades ─────────────────────────────────────────────────────────
    // JOIN signals + outcomes (only WIN/LOSS/BE with full price data) + signal_features
    liveRows = db.prepare(`
      INSERT INTO trade_dna (
        source, signal_id, strategy_name, instrument, direction, outcome,
        session, regime, trade_date,
        entry, sl, tp1, sl_pts, tp1_pts, rr_planned,
        pnl_pts, mfe_pts, mae_pts, hold_time_min, exit_type,
        mfe_sl_ratio, mae_sl_ratio, rr_achieved,
        confidence, archetype, entry_type, htf_bias, atr, rsi
      )
      SELECT
        'LIVE',
        s.id,
        s.strategy_name,
        s.instrument,
        s.direction,
        o.result,
        s.session,
        sf.regime,
        DATE(s.received_at),
        s.entry,
        s.sl,
        s.tp1,
        ROUND(ABS(s.entry - s.sl), 4)      AS sl_pts,
        ROUND(ABS(s.tp1 - s.entry), 4)     AS tp1_pts,
        CASE WHEN ABS(s.entry - s.sl) > 0
             THEN ROUND(ABS(s.tp1 - s.entry) / ABS(s.entry - s.sl), 3)
             ELSE NULL END                  AS rr_planned,
        o.pnl_pts,
        o.mfe_pts,
        o.mae_pts,
        o.hold_time_min,
        CASE o.result
          WHEN 'WIN'  THEN 'TP_HIT'
          WHEN 'LOSS' THEN 'SL_HIT'
          ELSE 'TIMEOUT'
        END                                 AS exit_type,
        CASE WHEN ABS(s.entry - s.sl) > 0 AND o.mfe_pts IS NOT NULL
             THEN ROUND(o.mfe_pts / ABS(s.entry - s.sl), 3)
             ELSE NULL END                  AS mfe_sl_ratio,
        CASE WHEN ABS(s.entry - s.sl) > 0 AND o.mae_pts IS NOT NULL
             THEN ROUND(o.mae_pts / ABS(s.entry - s.sl), 3)
             ELSE NULL END                  AS mae_sl_ratio,
        CASE WHEN ABS(s.tp1 - s.entry) > 0 AND o.mfe_pts IS NOT NULL
             THEN ROUND(o.mfe_pts / ABS(s.tp1 - s.entry), 3)
             ELSE NULL END                  AS rr_achieved,
        s.confidence,
        sf.archetype,
        sf.entry_type,
        s.htf_bias,
        sf.atr,
        sf.rsi
      FROM signals s
      JOIN outcomes o ON o.signal_id = s.id
      LEFT JOIN signal_features sf ON sf.signal_id = s.id
      WHERE o.result IN ('WIN', 'LOSS', 'BE')
        AND s.entry  IS NOT NULL
        AND s.sl     IS NOT NULL
        AND s.tp1    IS NOT NULL
        AND s.strategy_name IN (${stratList})
    `).run(...LIVE_STRATS).changes;

    // ── 2. BACKTEST trades ─────────────────────────────────────────────────────
    // Use the most recent backtest run per instrument (via MAX(run_id) CTE).
    btRows = db.prepare(`
      INSERT INTO trade_dna (
        source, bt_trade_id, strategy_name, instrument, direction, outcome,
        session, regime, trade_date,
        entry, sl, tp1, sl_pts, tp1_pts, rr_planned,
        pnl_pts, mfe_pts, mae_pts, hold_time_min, exit_type,
        mfe_sl_ratio, mae_sl_ratio, rr_achieved,
        confidence
      )
      WITH latest_runs AS (
        SELECT instrument, MAX(id) AS run_id
        FROM backtest_runs
        GROUP BY instrument
      )
      SELECT
        'BACKTEST',
        bt.id,
        bt.strategy_name,
        bt.instrument,
        bt.direction,
        bt.outcome,
        bt.trade_style,
        bt.regime,
        DATE(bt.timestamp),
        bt.entry,
        bt.sl,
        bt.tp1,
        ROUND(ABS(bt.entry - bt.sl), 4)    AS sl_pts,
        ROUND(ABS(bt.tp1 - bt.entry), 4)   AS tp1_pts,
        CASE WHEN ABS(bt.entry - bt.sl) > 0
             THEN ROUND(ABS(bt.tp1 - bt.entry) / ABS(bt.entry - bt.sl), 3)
             ELSE NULL END                  AS rr_planned,
        bt.pnl_pts,
        bt.mfe_pts,
        bt.mae_pts,
        bt.hold_time_min,
        bt.exit_type,
        CASE WHEN ABS(bt.entry - bt.sl) > 0 AND bt.mfe_pts IS NOT NULL
             THEN ROUND(bt.mfe_pts / ABS(bt.entry - bt.sl), 3)
             ELSE NULL END                  AS mfe_sl_ratio,
        CASE WHEN ABS(bt.entry - bt.sl) > 0 AND bt.mae_pts IS NOT NULL
             THEN ROUND(bt.mae_pts / ABS(bt.entry - bt.sl), 3)
             ELSE NULL END                  AS mae_sl_ratio,
        CASE WHEN ABS(bt.tp1 - bt.entry) > 0 AND bt.mfe_pts IS NOT NULL
             THEN ROUND(bt.mfe_pts / ABS(bt.tp1 - bt.entry), 3)
             ELSE NULL END                  AS rr_achieved,
        bt.confidence
      FROM backtest_trades bt
      JOIN latest_runs lr ON lr.run_id = bt.run_id
      WHERE bt.outcome IN ('WIN', 'LOSS', 'BE')
        AND bt.entry         IS NOT NULL
        AND bt.sl            IS NOT NULL
        AND bt.tp1           IS NOT NULL
        AND bt.strategy_name IS NOT NULL
    `).run().changes;
  })();

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'IDLE', {
    pid:       process.pid,
    lastRun:   new Date().toISOString(),
    liveRows,
    btRows,
    totalRows: liveRows + btRows,
  });
  console.log(`[${WORKER_NAME}] trade_dna rebuilt — live=${liveRows} backtest=${btRows} total=${liveRows + btRows}`);
  db.close();
  process.exit(0);
}

try {
  run();
} catch (err) {
  logWorkerError(null, WORKER_NAME, err);
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
}
