'use strict';

/**
 * P&L DECOMPOSITION WORKER  (Prompt #14 — Performance Multiplier Engine)
 *
 * Answers the core question: "What moves our P&L the most?"
 *
 * Runs weekly Saturday 06:00 UTC (before edge-discovery at 07:00 so
 * edge-discovery can build on fresh attribution data).
 *
 * For each strategy, over a 90-day window, decomposes P&L into 10 dimensions:
 *
 *   regime          — market structure (TREND_BULL … RANGE_CHOP)
 *   session         — time-of-day slot (ny_open, power_hour, midday …)
 *   dow             — day of week (Mon … Fri)
 *   hour_et         — entry hour (9, 10, 11 … 15)
 *   exit_type       — how the trade closed (TP1, SL, TIME, TP2)
 *   archetype       — setup pattern label
 *   entry_type      — entry trigger type
 *   htf_bias        — higher-timeframe directional context
 *   confidence_tier — bucketed confidence (HIGH ≥80, MED ≥65, LOW <65)
 *   rr_bucket       — planned R:R bucket (<1, 1-1.5, 1.5-2.5, >2.5)
 *
 * For each dimension × value:
 *   n, wins, WR, avg_pnl_pts, total_pnl_pts, profit_share_pct
 *   expectancy_score (WR × avg_win − loss_rate × avg_loss)
 *   role: PROFIT_CENTER | LOSS_DRIVER | NEUTRAL
 *
 * Writes to pnl_decomposition.
 * Posts agent_messages for top 3 profit centers and worst 3 loss drivers.
 * Sends ntfy digest.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'pnl-decomposition';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const WINDOW_DAYS = 90;
const MIN_N       = 12;

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS pnl_decomposition (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date         TEXT NOT NULL,
      strategy_name    TEXT NOT NULL,
      dimension        TEXT NOT NULL,
      dimension_value  TEXT NOT NULL,
      trade_count      INTEGER,
      win_count        INTEGER,
      loss_count       INTEGER,
      win_rate         REAL,
      avg_pnl_pts      REAL,
      total_pnl_pts    REAL,
      avg_win_pts      REAL,
      avg_loss_pts     REAL,
      expectancy_score REAL,
      profit_share_pct REAL,
      role             TEXT,
      computed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, dimension, dimension_value)
    )
  `).run();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO pnl_decomposition
      (run_date, strategy_name, dimension, dimension_value,
       trade_count, win_count, loss_count, win_rate,
       avg_pnl_pts, total_pnl_pts, avg_win_pts, avg_loss_pts,
       expectancy_score, profit_share_pct, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate = new Date().toISOString().slice(0, 10);

  // Standard SQL aggregation template reused per dimension
  const dimQuery = (groupExpr, whereExtra = '') => `
    SELECT
      ${groupExpr} AS dim_value,
      COUNT(*) AS n,
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(pnl_pts) AS total_pnl,
      AVG(pnl_pts) AS avg_pnl,
      AVG(CASE WHEN outcome='WIN' THEN pnl_pts END) AS avg_win,
      AVG(CASE WHEN outcome='LOSS' THEN pnl_pts END) AS avg_loss
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN','LOSS')
      AND trade_date >= date('now', '-${WINDOW_DAYS} days')
      ${whereExtra}
    GROUP BY dim_value
    HAVING n >= ${MIN_N}
    ORDER BY total_pnl DESC
  `;

  const DIMENSIONS = [
    { name: 'regime',      expr: 'COALESCE(regime, "UNKNOWN")',   extra: '' },
    { name: 'session',     expr: 'COALESCE(session, "UNKNOWN")',  extra: '' },
    { name: 'dow',         expr: 'CASE CAST(strftime(\'%w\',trade_date) AS INTEGER) WHEN 0 THEN \'Sun\' WHEN 1 THEN \'Mon\' WHEN 2 THEN \'Tue\' WHEN 3 THEN \'Wed\' WHEN 4 THEN \'Thu\' WHEN 5 THEN \'Fri\' ELSE \'Sat\' END', extra: '' },
    { name: 'hour_et',     expr: 'hour_et || \':00\'',            extra: 'AND hour_et IS NOT NULL' },
    { name: 'exit_type',   expr: 'COALESCE(exit_type, "UNKNOWN")',extra: '' },
    { name: 'archetype',   expr: 'COALESCE(archetype, "UNKNOWN")',extra: '' },
    { name: 'entry_type',  expr: 'COALESCE(entry_type, "UNKNOWN")',extra: '' },
    { name: 'htf_bias',    expr: 'COALESCE(htf_bias, "UNKNOWN")', extra: '' },
    {
      name: 'confidence_tier',
      expr: 'CASE WHEN confidence >= 80 THEN \'HIGH\' WHEN confidence >= 65 THEN \'MED\' ELSE \'LOW\' END',
      extra: 'AND confidence IS NOT NULL',
    },
    {
      name: 'rr_bucket',
      expr: 'CASE WHEN rr_planned < 1 THEN \'<1R\' WHEN rr_planned < 1.5 THEN \'1-1.5R\' WHEN rr_planned < 2.5 THEN \'1.5-2.5R\' ELSE \'>2.5R\' END',
      extra: 'AND rr_planned IS NOT NULL',
    },
  ];

  const digestLines = [];

  for (const strategy of STRATEGIES) {
    try {
      // Total portfolio P&L for this strategy in window (for profit_share_pct)
      const totRow = db.prepare(`
        SELECT SUM(pnl_pts) AS total, SUM(CASE WHEN pnl_pts > 0 THEN pnl_pts ELSE 0 END) AS gross_profit
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND trade_date >= date('now', '-${WINDOW_DAYS} days')
      `).get(strategy);

      const grossProfit = totRow?.gross_profit ?? 1;
      let topProfitCenters = [], topLossDrivers = [];

      for (const dim of DIMENSIONS) {
        try {
          const rows = db.prepare(dimQuery(dim.expr, dim.extra)).all(strategy);
          if (!rows.length) continue;

          for (const r of rows) {
            if (!r.dim_value) continue;
            const wr       = r.wins / r.n;
            const lossRate = 1 - wr;
            const avgWin   = r.avg_win ?? 0;
            const avgLoss  = r.avg_loss ?? 0;
            const expScore = wr * avgWin + lossRate * avgLoss;  // avg_loss is negative
            const profShare = grossProfit > 0 ? (r.total_pnl / grossProfit) * 100 : 0;
            const role = r.total_pnl >= 0 && wr >= 0.50 ? 'PROFIT_CENTER'
                       : r.total_pnl < 0 || wr < 0.35  ? 'LOSS_DRIVER'
                       : 'NEUTRAL';

            upsert.run(
              runDate, strategy, dim.name, String(r.dim_value),
              r.n, r.wins, r.n - r.wins,
              +wr.toFixed(4),
              r.avg_pnl != null ? +r.avg_pnl.toFixed(2) : null,
              r.total_pnl != null ? +r.total_pnl.toFixed(2) : null,
              avgWin   ? +avgWin.toFixed(2)   : null,
              avgLoss  ? +avgLoss.toFixed(2)  : null,
              +expScore.toFixed(3),
              +profShare.toFixed(2),
              role,
            );

            if (role === 'PROFIT_CENTER') topProfitCenters.push({ dim: dim.name, val: r.dim_value, total_pnl: r.total_pnl, wr });
            if (role === 'LOSS_DRIVER')   topLossDrivers.push({ dim: dim.name, val: r.dim_value, total_pnl: r.total_pnl, wr });
          }
        } catch (_) {}
      }

      // Sort and trim
      topProfitCenters.sort((a, b) => b.total_pnl - a.total_pnl);
      topLossDrivers.sort((a, b) => a.total_pnl - b.total_pnl);
      const top3Profit = topProfitCenters.slice(0, 3);
      const top3Loss   = topLossDrivers.slice(0, 3);

      // Post insight messages
      if (top3Profit.length || top3Loss.length) {
        try {
          insertMsg.run(
            WORKER_NAME, 'observation', strategy, 4,
            JSON.stringify({
              window_days:     WINDOW_DAYS,
              profit_centers:  top3Profit.map(x => `${x.dim}=${x.val} (WR ${(x.wr*100).toFixed(0)}%, ${x.total_pnl >= 0 ? '+' : ''}${x.total_pnl.toFixed(1)}pts)`),
              loss_drivers:    top3Loss.map(x => `${x.dim}=${x.val} (WR ${(x.wr*100).toFixed(0)}%, ${x.total_pnl.toFixed(1)}pts)`),
              note: `${strategy} 90d P&L decomposition: top profit center is ${top3Profit[0] ? `${top3Profit[0].dim}=${top3Profit[0].val}` : 'n/a'}; worst loss driver is ${top3Loss[0] ? `${top3Loss[0].dim}=${top3Loss[0].val}` : 'n/a'}`,
            }),
          );
        } catch (_) {}
      }

      if (top3Profit[0]) {
        digestLines.push(
          `${strategy}: best ${top3Profit[0].dim}=${top3Profit[0].val} ` +
          `(WR ${(top3Profit[0].wr*100).toFixed(0)}%) | worst ${top3Loss[0] ? `${top3Loss[0].dim}=${top3Loss[0].val}` : 'n/a'}`,
        );
      }

      console.log(`[${WORKER_NAME}] ${strategy}: ${DIMENSIONS.length} dimensions analyzed`);
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── ntfy digest ────────────────────────────────────────────────────────────
  if (digestLines.length > 0) {
    await sendNotification(
      'P&L Decomposition — Weekly Attribution',
      `90-day profit center analysis:\n${digestLines.join('\n')}`,
      { priority: 'low', tags: 'mag,chart_with_upwards_trend' },
    );
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
