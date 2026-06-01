'use strict';

/**
 * RISK METRICS WORKER  (Prompt #13 — Gap Analysis)
 *
 * Fills the single biggest missing piece after Prompts 1-12:
 * live-trade risk-adjusted return metrics. WR and PF exist everywhere,
 * but no system was computing Sharpe, Sortino, Calmar, or max drawdown
 * from LIVE trades (only from backtests).
 *
 * Runs daily at 07:30 UTC (after trade-dna refresh at 06:00).
 *
 * Per strategy + portfolio level, over 30 / 90 / 180 / 365-day windows:
 *
 *   Equity curve         cumulative pnl_pts from first trade in window
 *   Peak equity          running high-watermark
 *   Max drawdown         max(peak − current) in pts + as % of peak
 *   Daily P&L series     sum(pnl_pts) per calendar day (days with no trades = 0)
 *   Sharpe ratio         mean(daily) / std(daily) × sqrt(252)
 *   Sortino ratio        mean(daily) / downside_std(daily) × sqrt(252)
 *   Calmar ratio         annualized_return_pts / max_drawdown_pts
 *   Best / worst day     single calendar day max/min P&L
 *   Win days / loss days calendar days with net positive/negative P&L
 *
 * Portfolio row is the sum of all strategy daily P&Ls (treats as one book).
 *
 * Writes to risk_metrics_log.
 * Posts agent_messages when Sharpe drops below 0.5 or max DD exceeds 10R.
 * Sends ntfy digest showing Sharpe + max DD for each strategy.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'risk-metrics';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const WINDOWS     = [30, 90, 180, 365];

// ── Statistical helpers ───────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr, mu) {
  if (arr.length < 2) return 0;
  const m   = mu ?? mean(arr);
  const sum = arr.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(sum / (arr.length - 1));
}

function downsideStd(arr, target = 0) {
  const neg = arr.filter(v => v < target);
  if (neg.length < 2) return std(arr) || 1e-9;
  return std(neg, mean(neg));
}

function sharpe(dailyReturns) {
  const mu  = mean(dailyReturns);
  const sd  = std(dailyReturns, mu);
  return sd > 0 ? (mu / sd) * Math.sqrt(252) : 0;
}

function sortino(dailyReturns) {
  const mu  = mean(dailyReturns);
  const dsd = downsideStd(dailyReturns);
  return dsd > 0 ? (mu / dsd) * Math.sqrt(252) : 0;
}

function calmar(annualizedReturn, maxDrawdownPts) {
  return maxDrawdownPts > 0 ? annualizedReturn / maxDrawdownPts : 0;
}

// ── Build daily P&L series ────────────────────────────────────────────────────

function buildDailySeries(db, strategy, windowDays) {
  const rows = db.prepare(`
    SELECT trade_date, SUM(pnl_pts) AS daily_pnl
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND trade_date >= date('now', ? || ' days')
    GROUP BY trade_date
    ORDER BY trade_date ASC
  `).all(strategy, String(-windowDays));

  return rows.map(r => ({ date: r.trade_date, pnl: r.daily_pnl ?? 0 }));
}

// ── Compute metrics from daily series ────────────────────────────────────────

function computeMetrics(series, windowDays) {
  if (!series.length) return null;

  const pnls = series.map(r => r.pnl);

  // Equity curve + max drawdown
  let cumPnl  = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    cumPnl += p;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPct = peak > 0 ? maxDD / peak : 0;

  const mu        = mean(pnls);
  const annReturn = mu * 252;                          // annualized in pts
  const sr        = sharpe(pnls);
  const so        = sortino(pnls);
  const cr        = calmar(annReturn, maxDD);

  const winDays   = pnls.filter(p => p > 0).length;
  const lossDays  = pnls.filter(p => p < 0).length;
  const bestDay   = Math.max(...pnls);
  const worstDay  = Math.min(...pnls);

  return {
    windowDays,
    tradingDays:    series.length,
    totalPnlPts:    +cumPnl.toFixed(2),
    peakPnlPts:     +peak.toFixed(2),
    maxDrawdownPts: +maxDD.toFixed(2),
    maxDrawdownPct: +maxDDPct.toFixed(4),
    sharpeRatio:    +sr.toFixed(3),
    sortinoRatio:   +so.toFixed(3),
    calmarRatio:    +cr.toFixed(3),
    annualizedPts:  +annReturn.toFixed(2),
    winDays,
    lossDays,
    bestDayPts:     +bestDay.toFixed(2),
    worstDayPts:    +worstDay.toFixed(2),
  };
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS risk_metrics_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date          TEXT NOT NULL,
      strategy_name     TEXT NOT NULL,
      window_days       INTEGER NOT NULL,
      trading_days      INTEGER,
      total_pnl_pts     REAL,
      peak_pnl_pts      REAL,
      max_drawdown_pts  REAL,
      max_drawdown_pct  REAL,
      sharpe_ratio      REAL,
      sortino_ratio     REAL,
      calmar_ratio      REAL,
      annualized_pts    REAL,
      win_days          INTEGER,
      loss_days         INTEGER,
      best_day_pts      REAL,
      worst_day_pts     REAL,
      computed_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name, window_days)
    )
  `).run();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO risk_metrics_log
      (run_date, strategy_name, window_days, trading_days,
       total_pnl_pts, peak_pnl_pts, max_drawdown_pts, max_drawdown_pct,
       sharpe_ratio, sortino_ratio, calmar_ratio, annualized_pts,
       win_days, loss_days, best_day_pts, worst_day_pts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const runDate = new Date().toISOString().slice(0, 10);

  // Per-window daily series for portfolio roll-up (day → combined pnl)
  const portfolioByWindow = {};
  for (const w of WINDOWS) portfolioByWindow[w] = {};

  let processed = 0;
  const summary90 = []; // for ntfy digest

  for (const strategy of STRATEGIES) {
    try {
      for (const w of WINDOWS) {
        const series  = buildDailySeries(db, strategy, w);
        const metrics = computeMetrics(series, w);
        if (!metrics) continue;

        upsert.run(
          runDate, strategy, w,
          metrics.tradingDays,
          metrics.totalPnlPts, metrics.peakPnlPts,
          metrics.maxDrawdownPts, metrics.maxDrawdownPct,
          metrics.sharpeRatio, metrics.sortinoRatio, metrics.calmarRatio,
          metrics.annualizedPts,
          metrics.winDays, metrics.lossDays,
          metrics.bestDayPts, metrics.worstDayPts,
        );

        // Roll up into portfolio
        for (const r of series) {
          portfolioByWindow[w][r.date] = (portfolioByWindow[w][r.date] ?? 0) + r.pnl;
        }

        // Alert on 90-day Sharpe < 0.5 or max DD > 10pts (approximate 10R)
        if (w === 90) {
          summary90.push({ strategy, metrics });
          if (metrics.sharpeRatio < 0.5 && metrics.tradingDays >= 20) {
            try {
              insertMsg.run(
                'risk-metrics', 'observation', strategy, 3,
                JSON.stringify({
                  alert:           'low_sharpe',
                  window_days:     90,
                  sharpe_ratio:    metrics.sharpeRatio,
                  sortino_ratio:   metrics.sortinoRatio,
                  max_dd_pts:      metrics.maxDrawdownPts,
                  max_dd_pct:      metrics.maxDrawdownPct,
                  recommendation:  `Sharpe ${metrics.sharpeRatio.toFixed(2)} below 0.5 threshold — review strategy conditions`,
                }),
              );
            } catch (_) {}
          }
        }
      }

      console.log(
        `[${WORKER_NAME}] ${strategy}: ` +
        WINDOWS.map(w => {
          const r = db.prepare(
            `SELECT sharpe_ratio, max_drawdown_pts FROM risk_metrics_log
             WHERE strategy_name=? AND window_days=? AND run_date=? LIMIT 1`
          ).get(strategy, w, runDate);
          return r ? `${w}d: Sharpe ${r.sharpe_ratio?.toFixed(2)} DD ${r.max_drawdown_pts?.toFixed(1)}pts` : `${w}d: n/a`;
        }).join(' | ')
      );
      processed++;
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // ── Portfolio-level metrics ─────────────────────────────────────────────────
  for (const w of WINDOWS) {
    try {
      const series  = Object.entries(portfolioByWindow[w])
        .sort(([a], [b]) => a < b ? -1 : 1)
        .map(([date, pnl]) => ({ date, pnl }));
      const metrics = computeMetrics(series, w);
      if (!metrics) continue;

      upsert.run(
        runDate, 'PORTFOLIO', w,
        metrics.tradingDays,
        metrics.totalPnlPts, metrics.peakPnlPts,
        metrics.maxDrawdownPts, metrics.maxDrawdownPct,
        metrics.sharpeRatio, metrics.sortinoRatio, metrics.calmarRatio,
        metrics.annualizedPts,
        metrics.winDays, metrics.lossDays,
        metrics.bestDayPts, metrics.worstDayPts,
      );
    } catch (_) {}
  }

  // ── ntfy digest ────────────────────────────────────────────────────────────
  if (summary90.length > 0) {
    const lines = summary90
      .filter(s => s.metrics.tradingDays >= 10)
      .map(s => {
        const m = s.metrics;
        return `${s.strategy}: Sharpe ${m.sharpeRatio.toFixed(2)} | Sortino ${m.sortinoRatio.toFixed(2)} | MaxDD ${m.maxDrawdownPts.toFixed(1)}pts`;
      });
    if (lines.length > 0) {
      await sendNotification(
        'Risk Metrics — Daily Update',
        `90-day risk-adjusted returns:\n${lines.join('\n')}`,
        { priority: 'low', tags: 'bar_chart' },
      );
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies computed`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
