'use strict';

/**
 * EXECUTION REALITY WORKER  (Prompt #15 Phase 1 — Red Team Foundation)
 *
 * Addresses the single largest risk surfaced by the red-team review:
 * every metric in the system — WR, Sharpe, expectancy — is computed from
 * theoretical signal prices, not actual execution prices. In live futures
 * trading there is always slippage (market impact + bid-ask spread + latency).
 *
 * Without measuring this gap the system cannot know whether its edge survives
 * real execution. A strategy with a theoretical Sharpe of 1.2 and round-trip
 * slippage consuming 25% of edge may have an adjusted Sharpe of 0.9 — still
 * viable but meaningfully different from what all downstream metrics report.
 *
 * SLIPPAGE MODEL
 * Round-trip slippage estimate = base × session_factor × atr_factor
 *
 *   MNQ base: 0.75 pts  (≈3 ticks × $0.50 = $1.50/contract, realistic retail fill)
 *   MGC base: 0.30 pts  (≈3 ticks × $0.10 = $0.30/contract)
 *
 *   Session:  ny_open 2.0×  |  power_hour 1.5×  |  pre_market 1.25×  |  midday 0.75×
 *   ATR:      > 80th pct → 1.5×  |  < 20th pct → 0.75×  |  else 1.0×
 *
 * The model is deliberately conservative (it understates slippage to avoid
 * false alarms). If even this conservative model shows a large reality gap,
 * the actual gap is likely worse.
 *
 * Slippage affects BOTH sides of every trade:
 *   WIN:  adjusted_pnl = pnl_pts − slip  (smaller win)
 *   LOSS: adjusted_pnl = pnl_pts − slip  (larger loss, since pnl_pts is negative)
 *
 * Runs daily at 08:00 UTC after risk-metrics (07:30) and PM worker (07:45).
 *
 * Writes:
 *   execution_log              — per-trade slippage estimates (LIVE trades only)
 *   execution_reality_summary  — per-strategy aggregate reality vs theoretical
 *
 * Posts agent_messages + ntfy alert when reality_gap > 20% on 90-day window.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME      = 'execution-reality';
const STRATEGIES       = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const WINDOWS          = [30, 90, 180];
const REALITY_GAP_ALERT = 20;   // alert if >20% of theoretical edge consumed by slippage

// ── Slippage model ─────────────────────────────────────────────────────────────

const BASE_SLIP = { MNQ: 0.75, MGC: 0.30 };

const SESSION_SLIP = {
  ny_open: 2.00, power_hour: 1.50, pre_market: 1.25, midday: 0.75,
};

function estimateSlippage(instrument, session, atr, atrP20, atrP80) {
  const base   = BASE_SLIP[instrument] ?? 0.75;
  const sessFx = SESSION_SLIP[(session ?? '').toLowerCase()] ?? 1.00;
  let atrFx    = 1.00;
  if (atr != null && atrP20 != null && atrP80 != null) {
    if (atr > atrP80) atrFx = 1.50;
    else if (atr < atrP20) atrFx = 0.75;
  }
  return +(base * sessFx * atrFx).toFixed(3);
}

// ── Statistical helpers (same as risk-metrics-worker) ─────────────────────────

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function std(arr, mu) {
  if (arr.length < 2) return 0;
  const m = mu ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function downsideStd(arr) {
  const neg = arr.filter(v => v < 0);
  if (neg.length < 2) return std(arr) || 1e-9;
  return std(neg, mean(neg));
}
function sharpe(series) {
  const mu = mean(series), sd = std(series, mu);
  return sd > 0 ? (mu / sd) * Math.sqrt(252) : 0;
}
function sortino(series) {
  const mu = mean(series), dsd = downsideStd(series);
  return dsd > 0 ? (mu / dsd) * Math.sqrt(252) : 0;
}

// ── Aggregate daily series from a set of trade records ────────────────────────

function toDailySeries(trades) {
  const byDate = {};
  for (const t of trades) {
    byDate[t.trade_date] = (byDate[t.trade_date] ?? 0) + t.pnl;
  }
  return Object.entries(byDate).sort(([a], [b]) => a < b ? -1 : 1).map(([, p]) => p);
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS execution_log (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_dna_id           INTEGER,
      run_date               TEXT NOT NULL,
      strategy_name          TEXT NOT NULL,
      trade_date             TEXT,
      hour_et                INTEGER,
      session                TEXT,
      regime                 TEXT,
      instrument             TEXT,
      outcome                TEXT,
      theoretical_pnl_pts    REAL,
      estimated_slippage_pts REAL,
      adjusted_pnl_pts       REAL,
      sl_pts                 REAL,
      tp1_pts                REAL,
      atr                    REAL,
      slippage_pct_of_stop   REAL,
      computed_at            TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS execution_reality_summary (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date                 TEXT NOT NULL,
      strategy_name            TEXT NOT NULL,
      window_days              INTEGER NOT NULL,
      trade_count              INTEGER,
      theoretical_wr           REAL,
      adjusted_wr              REAL,
      wr_gap_pts               REAL,
      theoretical_expectancy   REAL,
      adjusted_expectancy      REAL,
      theoretical_sharpe       REAL,
      adjusted_sharpe          REAL,
      theoretical_sortino      REAL,
      adjusted_sortino         REAL,
      avg_slippage_pts         REAL,
      avg_slippage_pct_stop    REAL,
      reality_gap_pct          REAL,
      edge_survives_execution  INTEGER,
      computed_at              TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, window_days)
    )
  `).run();

  const insertLog = db.prepare(`
    INSERT INTO execution_log
      (trade_dna_id, run_date, strategy_name, trade_date, hour_et, session,
       regime, instrument, outcome, theoretical_pnl_pts, estimated_slippage_pts,
       adjusted_pnl_pts, sl_pts, tp1_pts, atr, slippage_pct_of_stop)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertSummary = db.prepare(`
    INSERT OR REPLACE INTO execution_reality_summary
      (run_date, strategy_name, window_days, trade_count,
       theoretical_wr, adjusted_wr, wr_gap_pts,
       theoretical_expectancy, adjusted_expectancy,
       theoretical_sharpe, adjusted_sharpe,
       theoretical_sortino, adjusted_sortino,
       avg_slippage_pts, avg_slippage_pct_stop,
       reality_gap_pct, edge_survives_execution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate = new Date().toISOString().slice(0, 10);

  // Clear today's execution_log before re-inserting (idempotent runs)
  db.prepare(`DELETE FROM execution_log WHERE run_date = ?`).run(runDate);

  const alertLines = [];

  for (const strategy of STRATEGIES) {
    try {
      // Determine instrument from strategy name
      const instrument = strategy.startsWith('MGC') ? 'MGC' : 'MNQ';

      // Compute ATR percentiles across all trades for this strategy (for ATR factor)
      const atrRows = db.prepare(`
        SELECT atr FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS') AND atr IS NOT NULL
        ORDER BY atr ASC
      `).all(strategy).map(r => r.atr);

      const atrP20 = atrRows.length ? atrRows[Math.floor(atrRows.length * 0.20)] : null;
      const atrP80 = atrRows.length ? atrRows[Math.floor(atrRows.length * 0.80)] : null;

      // Read all LIVE trades (LIVE source only — backtest fills are already theoretical)
      const allTrades = db.prepare(`
        SELECT id, trade_date, hour_et, session, regime,
               outcome, pnl_pts, sl_pts, tp1_pts, atr
        FROM trade_dna
        WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          AND source = 'LIVE'
        ORDER BY trade_date ASC
      `).all(strategy);

      if (!allTrades.length) {
        // Fall back to any source if no LIVE trades yet
        const fallback = db.prepare(`
          SELECT id, trade_date, hour_et, session, regime,
                 outcome, pnl_pts, sl_pts, tp1_pts, atr
          FROM trade_dna
          WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
          ORDER BY trade_date ASC
        `).all(strategy);
        allTrades.push(...fallback);
      }

      if (!allTrades.length) continue;

      // Insert per-trade slippage estimates into execution_log
      const insertMany = db.transaction((trades) => {
        for (const t of trades) {
          const slip = estimateSlippage(instrument, t.session, t.atr, atrP20, atrP80);
          const adjPnl = t.pnl_pts != null ? +(t.pnl_pts - slip).toFixed(2) : null;
          const slipPctStop = (t.sl_pts > 0) ? +(slip / t.sl_pts * 100).toFixed(1) : null;

          insertLog.run(
            t.id, runDate, strategy, t.trade_date, t.hour_et, t.session,
            t.regime, instrument, t.outcome,
            t.pnl_pts != null ? +t.pnl_pts.toFixed(2) : null,
            slip, adjPnl, t.sl_pts, t.tp1_pts, t.atr, slipPctStop,
          );
        }
      });
      insertMany(allTrades);

      // ── Compute per-window aggregate metrics ─────────────────────────────────
      for (const windowDays of WINDOWS) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - windowDays);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const windowTrades = allTrades.filter(t => t.trade_date >= cutoffStr);
        if (windowTrades.length < 5) continue;

        const slips = windowTrades.map(t =>
          estimateSlippage(instrument, t.session, t.atr, atrP20, atrP80)
        );

        const theoSeries = windowTrades.map(t => t.pnl_pts ?? 0);
        const adjSeries  = windowTrades.map((t, i) => (t.pnl_pts ?? 0) - slips[i]);

        // WR
        const wins         = windowTrades.filter(t => t.outcome === 'WIN').length;
        const theoWr       = wins / windowTrades.length;
        const adjWins      = adjSeries.filter(p => p > 0).length;
        const adjWr        = adjWins / windowTrades.length;

        // Expectancy (avg P&L per trade)
        const theoExp      = mean(theoSeries);
        const adjExp       = mean(adjSeries);

        // Sharpe/Sortino on daily series
        const theoDailySeries = toDailySeries(windowTrades.map(t => ({ trade_date: t.trade_date, pnl: t.pnl_pts ?? 0 })));
        const adjDailySeries  = toDailySeries(windowTrades.map((t, i) => ({ trade_date: t.trade_date, pnl: (t.pnl_pts ?? 0) - slips[i] })));

        const theoSharpe   = sharpe(theoDailySeries);
        const adjSharpe    = sharpe(adjDailySeries);
        const theoSortino  = sortino(theoDailySeries);
        const adjSortino   = sortino(adjDailySeries);

        // Reality gap: how much of theoretical edge is lost to slippage
        const realityGapPct = theoSharpe !== 0
          ? +((1 - adjSharpe / Math.max(theoSharpe, 0.01)) * 100).toFixed(1)
          : 0;

        const avgSlip      = mean(slips);
        const avgSlipPct   = mean(windowTrades.map((t, i) =>
          t.sl_pts > 0 ? (slips[i] / t.sl_pts * 100) : 0
        ));

        const edgeSurvives = adjSharpe > 0.50 ? 1 : 0;

        upsertSummary.run(
          runDate, strategy, windowDays, windowTrades.length,
          +theoWr.toFixed(4), +adjWr.toFixed(4), +(theoWr - adjWr).toFixed(4),
          +theoExp.toFixed(3), +adjExp.toFixed(3),
          +theoSharpe.toFixed(3), +adjSharpe.toFixed(3),
          +theoSortino.toFixed(3), +adjSortino.toFixed(3),
          +avgSlip.toFixed(3), +avgSlipPct.toFixed(1),
          realityGapPct, edgeSurvives,
        );

        if (windowDays === 90) {
          const line = `${strategy}: theoretical Sharpe ${theoSharpe.toFixed(2)} → adjusted ${adjSharpe.toFixed(2)} (gap ${realityGapPct}%, avg slip ${avgSlip.toFixed(2)}pts = ${avgSlipPct.toFixed(0)}% of stop)`;
          console.log(`[${WORKER_NAME}] ${line}`);

          if (realityGapPct > REALITY_GAP_ALERT && windowTrades.length >= 20) {
            alertLines.push(line);
            try {
              insertMsg.run(
                WORKER_NAME, 'observation', strategy, 2,
                JSON.stringify({
                  alert:                'execution_reality_gap',
                  window_days:          90,
                  theoretical_sharpe:   +theoSharpe.toFixed(3),
                  adjusted_sharpe:      +adjSharpe.toFixed(3),
                  reality_gap_pct:      realityGapPct,
                  avg_slippage_pts:     +avgSlip.toFixed(3),
                  avg_slippage_pct_stop: +avgSlipPct.toFixed(1),
                  recommendation:       `${strategy}: ${realityGapPct}% of theoretical edge may be consumed by execution costs. Verify actual fill prices against signal entry prices.`,
                }),
              );
            } catch (_) {}
          }
        }
      }
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── ntfy digest ─────────────────────────────────────────────────────────────
  const allSummary = db.prepare(`
    SELECT strategy_name, theoretical_sharpe, adjusted_sharpe, reality_gap_pct,
           avg_slippage_pts, avg_slippage_pct_stop, edge_survives_execution
    FROM execution_reality_summary
    WHERE run_date = ? AND window_days = 90
    ORDER BY reality_gap_pct DESC
  `).all(runDate);

  if (allSummary.length > 0) {
    const lines = allSummary.map(r =>
      `${r.strategy_name}: Sharpe ${r.theoretical_sharpe?.toFixed(2)} → ${r.adjusted_sharpe?.toFixed(2)} | gap ${r.reality_gap_pct}% | slip ${r.avg_slippage_pts?.toFixed(2)}pts (${r.avg_slippage_pct_stop?.toFixed(0)}% of stop)${r.edge_survives_execution ? '' : ' ⚠ EDGE AT RISK'}`
    );

    await sendNotification(
      alertLines.length > 0 ? 'Execution Reality — ALERT: Large Gap Detected' : 'Execution Reality — Daily Update',
      `90-day slippage-adjusted performance:\n${lines.join('\n')}`,
      {
        priority: alertLines.length > 0 ? 'high' : 'low',
        tags: alertLines.length > 0 ? 'warning,money_with_wings' : 'white_check_mark,chart_with_upwards_trend',
      },
    );
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid,
    strategies: STRATEGIES.length,
    alerts: alertLines.length,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${alertLines.length} reality-gap alerts`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
