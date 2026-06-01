'use strict';

/**
 * WALK-FORWARD VALIDATOR WORKER  (Prompt #15 Phase 6 — Red Team Foundation)
 *
 * Addresses the red-team finding: all backtesting uses the full history, so
 * there is no out-of-sample (OOS) test for live-performance degradation.
 *
 * Splits trade_dna per strategy into:
 *   IS  — trades older than 90 days (in-sample / "learning" period)
 *   OOS — last 90 days       (out-of-sample / "live" period)
 *
 * Computes for each window:
 *   - Win rate
 *   - Annualised daily Sharpe ratio
 *   - Expectancy (pts)
 *
 * Flags OVERFIT_RISK when:
 *   IS n ≥ 30 AND OOS n ≥ 10 AND OOS Sharpe < 60 % of IS Sharpe
 *
 * On any OVERFIT flag: posts HIGH-priority ntfy alert.
 * Writes to walk_forward_validation (UNIQUE run_date + strategy).
 *
 * Runs weekly Saturday 08:00 UTC (0 8 * * 6).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME   = 'walk-forward-validator';
const STRATEGIES    = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const OOS_DAYS      = 90;
const OVERFIT_RATIO = 0.60;  // OOS Sharpe must be ≥ 60% of IS Sharpe to pass

// ── Statistical helpers ───────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function annualisedSharpe(dailyPnls) {
  if (dailyPnls.length < 5) return 0;
  const m = mean(dailyPnls);
  const s = std(dailyPnls);
  return s > 0 ? (m / s) * Math.sqrt(252) : 0;
}

function calcStats(trades) {
  if (!trades.length) return { n: 0, wr: 0, avgPnl: 0, expectancy: 0, sharpe: 0 };

  const n    = trades.length;
  const wins = trades.filter(t => t.outcome === 'WIN').length;
  const wr   = wins / n;

  const winPnls  = trades.filter(t => t.outcome === 'WIN') .map(t => t.pnl_pts ?? 0);
  const lossPnls = trades.filter(t => t.outcome === 'LOSS').map(t => Math.abs(t.pnl_pts ?? 0));
  const avgWin   = winPnls.length  ? mean(winPnls)  : 0;
  const avgLoss  = lossPnls.length ? mean(lossPnls) : 0;
  const expectancy = wr * avgWin - (1 - wr) * avgLoss;
  const avgPnl   = mean(trades.map(t => t.pnl_pts ?? 0));

  const daily = {};
  for (const t of trades) {
    const d = t.trade_date ?? '';
    daily[d] = (daily[d] ?? 0) + (t.pnl_pts ?? 0);
  }
  const sharpe = annualisedSharpe(Object.values(daily));

  return { n, wr, avgPnl, expectancy, sharpe };
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS walk_forward_validation (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date            TEXT NOT NULL,
      strategy_name       TEXT NOT NULL,
      is_trade_count      INTEGER,
      is_win_rate         REAL,
      is_avg_pnl_pts      REAL,
      is_expectancy       REAL,
      is_sharpe           REAL,
      oos_trade_count     INTEGER,
      oos_win_rate        REAL,
      oos_avg_pnl_pts     REAL,
      oos_expectancy      REAL,
      oos_sharpe          REAL,
      wr_degradation_pct  REAL,
      sharpe_retention    REAL,
      overfit_flag        INTEGER NOT NULL DEFAULT 0,
      verdict             TEXT,
      computed_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name)
    )
  `).run();

  const upsertRow = db.prepare(`
    INSERT INTO walk_forward_validation
      (run_date, strategy_name,
       is_trade_count, is_win_rate, is_avg_pnl_pts, is_expectancy, is_sharpe,
       oos_trade_count, oos_win_rate, oos_avg_pnl_pts, oos_expectancy, oos_sharpe,
       wr_degradation_pct, sharpe_retention, overfit_flag, verdict)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_date, strategy_name) DO UPDATE SET
      is_trade_count     = excluded.is_trade_count,
      is_win_rate        = excluded.is_win_rate,
      is_avg_pnl_pts     = excluded.is_avg_pnl_pts,
      is_expectancy      = excluded.is_expectancy,
      is_sharpe          = excluded.is_sharpe,
      oos_trade_count    = excluded.oos_trade_count,
      oos_win_rate       = excluded.oos_win_rate,
      oos_avg_pnl_pts    = excluded.oos_avg_pnl_pts,
      oos_expectancy     = excluded.oos_expectancy,
      oos_sharpe         = excluded.oos_sharpe,
      wr_degradation_pct = excluded.wr_degradation_pct,
      sharpe_retention   = excluded.sharpe_retention,
      overfit_flag       = excluded.overfit_flag,
      verdict            = excluded.verdict,
      computed_at        = datetime('now')
  `);

  const runDate = new Date().toISOString().slice(0, 10);
  const overfitHits = [];

  for (const strategy of STRATEGIES) {
    try {
      const isQuery = db.prepare(`
        SELECT outcome, pnl_pts, trade_date FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND trade_date < date('now', '-${OOS_DAYS} days')
        ORDER BY trade_date
      `);
      const oosQuery = db.prepare(`
        SELECT outcome, pnl_pts, trade_date FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND trade_date >= date('now', '-${OOS_DAYS} days')
        ORDER BY trade_date
      `);

      const is  = calcStats(isQuery.all(strategy));
      const oos = calcStats(oosQuery.all(strategy));

      const wrDegradationPct = is.wr > 0
        ? +((1 - oos.wr / is.wr) * 100).toFixed(1)
        : 0;
      const sharpeRetention = (is.sharpe > 0 && oos.n >= 5)
        ? +(oos.sharpe / is.sharpe).toFixed(4)
        : (is.sharpe <= 0 ? 1 : 0);

      const overfitFlag = (
        is.n >= 30 && oos.n >= 10 &&
        is.sharpe > 0 && oos.sharpe < is.sharpe * OVERFIT_RATIO
      ) ? 1 : 0;

      let verdict;
      if (is.n < 30)         verdict = 'INSUFFICIENT_IS_DATA';
      else if (oos.n < 10)   verdict = 'INSUFFICIENT_OOS_DATA';
      else if (overfitFlag)  verdict = `OVERFIT_RISK: OOS Sharpe ${oos.sharpe.toFixed(2)} vs IS ${is.sharpe.toFixed(2)} (${(sharpeRetention * 100).toFixed(0)}% retained)`;
      else                   verdict = `HEALTHY: Sharpe retention ${(sharpeRetention * 100).toFixed(0)}%`;

      upsertRow.run(
        runDate, strategy,
        is.n,  +is.wr.toFixed(4),  +is.avgPnl.toFixed(2),  +is.expectancy.toFixed(2),  +is.sharpe.toFixed(3),
        oos.n, +oos.wr.toFixed(4), +oos.avgPnl.toFixed(2), +oos.expectancy.toFixed(2), +oos.sharpe.toFixed(3),
        wrDegradationPct, sharpeRetention, overfitFlag, verdict,
      );

      if (overfitFlag) overfitHits.push({ strategy, is, oos, sharpeRetention });

      console.log(
        `[${WORKER_NAME}] ${strategy}: IS(n=${is.n} wr=${(is.wr*100).toFixed(0)}% sh=${is.sharpe.toFixed(2)}) ` +
        `OOS(n=${oos.n} wr=${(oos.wr*100).toFixed(0)}% sh=${oos.sharpe.toFixed(2)}) ` +
        `ret=${(sharpeRetention*100).toFixed(0)}% ${overfitFlag ? '*** OVERFIT ***' : 'OK'}`
      );
    } catch (stratErr) {
      logWorkerError(db, WORKER_NAME, stratErr);
      console.error(`[${WORKER_NAME}] ${strategy} error: ${stratErr.message}`);
    }
  }

  if (overfitHits.length) {
    const names = overfitHits.map(s => s.strategy).join(', ');
    const lines = overfitHits.map(s =>
      `${s.strategy}: IS Sharpe ${s.is.sharpe.toFixed(2)} -> OOS ${s.oos.sharpe.toFixed(2)} (${(s.sharpeRetention*100).toFixed(0)}% retained, IS n=${s.is.n}, OOS n=${s.oos.n})`
    ).join('\n');

    await sendNotification(
      `WALK-FORWARD OVERFIT RISK: ${names}`,
      `${lines}\nReview strategy parameters — OOS Sharpe below ${(OVERFIT_RATIO*100).toFixed(0)}% of IS Sharpe.`,
      { priority: 'high', tags: 'warning,chart_with_downwards_trend' },
    );
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, overfitCount: overfitHits.length, completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${overfitHits.length} overfit flags across ${STRATEGIES.length} strategies`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
