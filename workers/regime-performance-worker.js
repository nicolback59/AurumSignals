'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'regime-performance';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

function computeMaxLossStreak(db, strategy, regime) {
  const rows = db.prepare(`
    SELECT outcome
    FROM trade_dna
    WHERE strategy_name = ?
      AND regime = ?
      AND outcome IN ('WIN', 'LOSS')
    ORDER BY trade_date ASC
  `).all(strategy, regime);

  let max = 0;
  let current = 0;
  for (const row of rows) {
    if (row.outcome === 'LOSS') {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

function postObservation(db, strategy, regime, payload) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES (?, 'consensus', 'observation', ?, ?, ?)
    `).run(WORKER_NAME, strategy, JSON.stringify(payload), payload._priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS regime_performance_stats (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date         TEXT NOT NULL,
      strategy_name    TEXT NOT NULL,
      regime           TEXT NOT NULL,
      trade_count      INTEGER,
      win_count        INTEGER,
      loss_count       INTEGER,
      win_rate         REAL,
      profit_factor    REAL,
      expectancy       REAL,
      avg_win_pts      REAL,
      avg_loss_pts     REAL,
      avg_mae_pts      REAL,
      avg_mfe_pts      REAL,
      max_loss_streak  INTEGER,
      trades_per_week  REAL,
      computed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, regime)
    )
  `).run();

  const runDate = new Date().toISOString().slice(0, 10);

  let totalRegimesProcessed = 0;

  const summaryByStrategy = [];

  for (const strategy of STRATEGIES) {
    try {
      const regimeRows = db.prepare(`
        SELECT
          regime,
          COUNT(*)                                                        AS trade_count,
          SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END)              AS win_count,
          SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)              AS loss_count,
          SUM(CASE WHEN outcome = 'WIN'  THEN pnl_pts ELSE 0 END)        AS gross_win_pts,
          ABS(SUM(CASE WHEN outcome = 'LOSS' THEN pnl_pts ELSE 0 END))   AS gross_loss_pts,
          AVG(pnl_pts)                                                    AS expectancy,
          AVG(CASE WHEN outcome = 'WIN'  THEN pnl_pts ELSE NULL END)     AS avg_win_pts,
          AVG(CASE WHEN outcome = 'LOSS' THEN pnl_pts ELSE NULL END)     AS avg_loss_pts,
          AVG(CASE WHEN mae_pts IS NOT NULL THEN mae_pts ELSE NULL END)   AS avg_mae_pts,
          AVG(CASE WHEN mfe_pts IS NOT NULL THEN mfe_pts ELSE NULL END)   AS avg_mfe_pts,
          COUNT(DISTINCT date(trade_date))                                AS trade_days
        FROM trade_dna
        WHERE strategy_name = ?
          AND outcome IN ('WIN', 'LOSS')
          AND regime IS NOT NULL
        GROUP BY regime
        HAVING COUNT(*) >= 5
      `).all(strategy);

      const strategyRegimes = [];

      for (const row of regimeRows) {
        const winRate      = row.win_count / (row.win_count + row.loss_count);
        const profitFactor = row.gross_loss_pts > 0
          ? row.gross_win_pts / row.gross_loss_pts
          : null;
        const tradesPerWeek = row.trade_days > 0
          ? (row.trade_count / row.trade_days) * 5
          : null;

        const maxLossStreak = computeMaxLossStreak(db, strategy, row.regime);

        db.prepare(`
          INSERT OR REPLACE INTO regime_performance_stats
            (run_date, strategy_name, regime, trade_count, win_count, loss_count,
             win_rate, profit_factor, expectancy, avg_win_pts, avg_loss_pts,
             avg_mae_pts, avg_mfe_pts, max_loss_streak, trades_per_week)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runDate,
          strategy,
          row.regime,
          row.trade_count,
          row.win_count,
          row.loss_count,
          +winRate.toFixed(4),
          profitFactor != null ? +profitFactor.toFixed(4) : null,
          row.expectancy != null ? +row.expectancy.toFixed(4) : null,
          row.avg_win_pts  != null ? +row.avg_win_pts.toFixed(4)  : null,
          row.avg_loss_pts != null ? +row.avg_loss_pts.toFixed(4) : null,
          row.avg_mae_pts  != null ? +row.avg_mae_pts.toFixed(4)  : null,
          row.avg_mfe_pts  != null ? +row.avg_mfe_pts.toFixed(4)  : null,
          maxLossStreak,
          tradesPerWeek != null ? +tradesPerWeek.toFixed(4) : null,
        );

        totalRegimesProcessed += 1;
        strategyRegimes.push({ regime: row.regime, winRate, tradeCount: row.trade_count });

        if (winRate >= 0.68 && row.trade_count >= 10) {
          postObservation(db, strategy, row.regime, {
            _priority:    3,
            regime:       row.regime,
            win_rate:     +winRate.toFixed(4),
            profit_factor: profitFactor != null ? +profitFactor.toFixed(4) : null,
            trade_count:  row.trade_count,
            note:         'STRONG_EDGE',
            timestamp:    new Date().toISOString(),
          });
        } else if (winRate < 0.35 && row.trade_count >= 10) {
          postObservation(db, strategy, row.regime, {
            _priority:    2,
            regime:       row.regime,
            win_rate:     +winRate.toFixed(4),
            profit_factor: profitFactor != null ? +profitFactor.toFixed(4) : null,
            trade_count:  row.trade_count,
            note:         'AVOID_REGIME',
            timestamp:    new Date().toISOString(),
          });
        }

        console.log(
          `[${WORKER_NAME}] ${strategy} / ${row.regime}:` +
          ` wr=${winRate.toFixed(3)} pf=${profitFactor != null ? profitFactor.toFixed(3) : 'N/A'}` +
          ` trades=${row.trade_count} streak=${maxLossStreak}`
        );
      }

      summaryByStrategy.push({ strategy, regimes: strategyRegimes });
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  const bodyLines = [];
  for (const { strategy, regimes } of summaryByStrategy) {
    if (regimes.length === 0) {
      bodyLines.push(`${strategy}: no qualifying regimes`);
      continue;
    }
    const sorted   = [...regimes].sort((a, b) => b.winRate - a.winRate);
    const best     = sorted[0];
    const worst    = sorted[sorted.length - 1];
    const bestStr  = `best=${best.regime} ${(best.winRate * 100).toFixed(1)}% (n=${best.tradeCount})`;
    const worstStr = `worst=${worst.regime} ${(worst.winRate * 100).toFixed(1)}% (n=${worst.tradeCount})`;
    bodyLines.push(`${strategy}: ${bestStr}  ${worstStr}`);
  }

  await sendNotification(
    'Regime Performance — Daily Update',
    bodyLines.join('\n'),
    {
      priority: 'default',
      tags:     'bar_chart,compass',
    }
  );

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    completedAt:      new Date().toISOString(),
    regimesProcessed: totalRegimesProcessed,
  });

  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
