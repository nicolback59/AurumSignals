'use strict';

/**
 * MULTI-TP BACKTEST WORKER — Edge Audit Part 4
 *
 * Runs weekly (Tuesday 06:30 UTC) after trade-dna refresh (Mon 04:30).
 * Simulates three exit models against stored trade_dna data to quantify
 * the P&L improvement from adding a second take-profit leg.
 *
 * Models compared:
 *   BASE     — current model: full position exits at TP1
 *   M15      — 50% at TP1, remaining 50% trails to TP2 @ 1.5R from entry
 *   M20      — 50% at TP1, remaining 50% trails to TP2 @ 2.0R from entry
 *
 * TP2 viability uses rr_achieved = mfe_pts / tp1_pts (stored in trade_dna).
 * If rr_achieved >= tp2_ratio, price reached TP2 during the trade.
 * If TP2 not reached, remaining 50% exits at breakeven (trailing stop = entry).
 *
 * Writes per-strategy results to backtest_multi_tp.
 * Sends ntfy with the recommended model and expected P&L improvement.
 *
 * PM2 cron: 30 6 * * 2 (Tuesday 06:30 UTC)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME  = 'multi-tp-backtest-worker';
const STRATEGIES   = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const LOOKBACK     = 90; // days

// TP2 ratios to test (multiples of TP1 distance)
const TP2_RATIOS = { M15: 1.5, M20: 2.0 };

/**
 * Simulate multi-TP model on a set of trade_dna rows.
 *
 * For WIN trades:
 *   - Base:  pnl = tp1_pts (100% at TP1)
 *   - Multi: pnl = 0.5×tp1_pts + (rr_achieved >= tp2Ratio ? 0.5×(tp2Ratio×tp1_pts) : 0)
 *
 * For LOSS trades: pnl = sl_pts (unchanged — SL hit before TP1 in all models)
 * For BE trades:   pnl = 0 (unchanged)
 */
function simulateModel(trades, tp2Ratio) {
  let totalPnl = 0;
  let wins = 0, losses = 0, partials = 0;
  let tp2Hits = 0, winCount = 0;

  for (const t of trades) {
    const slPts  = t.sl_pts  ?? Math.abs((t.sl ?? 0)  - (t.entry ?? 0));
    const tp1Pts = t.tp1_pts ?? Math.abs((t.tp1 ?? 0) - (t.entry ?? 0));
    const rrAch  = t.rr_achieved;

    if (t.outcome === 'LOSS') {
      totalPnl += slPts > 0 ? -slPts : (t.pnl_pts ?? 0);
      losses++;
    } else if (t.outcome === 'WIN') {
      winCount++;
      if (tp2Ratio == null || rrAch == null) {
        // No multi-TP data — fall back to base model
        totalPnl += tp1Pts > 0 ? tp1Pts : (t.pnl_pts ?? 0);
        wins++;
      } else if (rrAch >= tp2Ratio) {
        // TP2 hit — locked in both legs
        const tp2Pts = tp2Ratio * tp1Pts;
        totalPnl += 0.5 * tp1Pts + 0.5 * tp2Pts;
        wins++;
        tp2Hits++;
      } else {
        // TP2 not hit — remaining 50% exits at entry (BE)
        totalPnl += 0.5 * tp1Pts;
        partials++;
      }
    } else {
      // BE
      totalPnl += t.pnl_pts ?? 0;
    }
  }

  const n       = trades.length;
  const baseWin = wins + partials; // any trade that hit TP1
  return {
    totalPnl:   +totalPnl.toFixed(2),
    avgPnl:     n > 0 ? +(totalPnl / n).toFixed(2) : 0,
    wr:         n > 0 ? +((wins + partials) / n).toFixed(3) : 0, // TP1-hit rate
    tp1HitPct:  n > 0 ? +((winCount) / n).toFixed(3) : 0,
    tp2HitPct:  winCount > 0 ? +(tp2Hits / winCount).toFixed(3) : 0,
  };
}

async function sendNtfy(title, body) {
  const ntfyUrl   = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC || '';
  const ntfyToken = process.env.NTFY_TOKEN || '';
  if (!ntfyTopic) return false;
  try {
    const headers = {
      'Content-Type': 'text/plain',
      'Title':    title,
      'Priority': 'low',
      'Tags':     'dart,moneybag',
    };
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
    const res = await fetch(`${ntfyUrl}/${ntfyTopic}`, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  const runDate = new Date().toISOString().slice(0, 10);
  const reportLines = [];
  const recommendations = [];

  const insertResult = db.prepare(`
    INSERT INTO backtest_multi_tp
      (run_date, strategy_name, lookback_days, total_trades,
       base_wr, base_total_pnl, base_avg_pnl,
       m15_wr, m15_total_pnl, m15_avg_pnl, m15_tp2_hit_pct,
       m20_wr, m20_total_pnl, m20_avg_pnl, m20_tp2_hit_pct,
       best_model, pnl_improvement_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_date, strategy_name) DO UPDATE SET
      total_trades        = excluded.total_trades,
      base_wr             = excluded.base_wr,
      base_total_pnl      = excluded.base_total_pnl,
      base_avg_pnl        = excluded.base_avg_pnl,
      m15_wr              = excluded.m15_wr,
      m15_total_pnl       = excluded.m15_total_pnl,
      m15_avg_pnl         = excluded.m15_avg_pnl,
      m15_tp2_hit_pct     = excluded.m15_tp2_hit_pct,
      m20_wr              = excluded.m20_wr,
      m20_total_pnl       = excluded.m20_total_pnl,
      m20_avg_pnl         = excluded.m20_avg_pnl,
      m20_tp2_hit_pct     = excluded.m20_tp2_hit_pct,
      best_model          = excluded.best_model,
      pnl_improvement_pct = excluded.pnl_improvement_pct
  `);

  reportLines.push(`Multi-TP Backtest  ${runDate}  (${LOOKBACK}d)`);
  reportLines.push('Models: BASE (all@TP1) vs M1.5 (50%@TP1+50%@1.5R) vs M2.0 (50%@TP1+50%@2R)');

  for (const strategy of STRATEGIES) {
    try {
      const trades = db.prepare(`
        SELECT outcome, pnl_pts, sl_pts, tp1_pts, rr_achieved, mfe_pts
        FROM trade_dna
        WHERE strategy_name = ?
          AND trade_date >= date('now', '-${LOOKBACK} days')
          AND outcome IN ('WIN','LOSS','BE')
          AND sl_pts  IS NOT NULL
          AND tp1_pts IS NOT NULL
      `).all(strategy);

      if (trades.length < 10) {
        reportLines.push(`\n▸ ${strategy}: insufficient data (${trades.length} trades)`);
        continue;
      }

      const base = simulateModel(trades, null);
      const m15  = simulateModel(trades, TP2_RATIOS.M15);
      const m20  = simulateModel(trades, TP2_RATIOS.M20);

      // Determine best model by total P&L
      let bestModel = 'BASE';
      let bestPnl   = base.totalPnl;
      if (m15.totalPnl > bestPnl) { bestModel = 'M15'; bestPnl = m15.totalPnl; }
      if (m20.totalPnl > bestPnl) { bestModel = 'M20'; bestPnl = m20.totalPnl; }

      const improvementPct = base.totalPnl !== 0
        ? +((bestPnl - base.totalPnl) / Math.abs(base.totalPnl) * 100).toFixed(1)
        : 0;

      insertResult.run(
        runDate, strategy, LOOKBACK, trades.length,
        base.wr, base.totalPnl, base.avgPnl,
        m15.wr, m15.totalPnl, m15.avgPnl, m15.tp2HitPct,
        m20.wr, m20.totalPnl, m20.avgPnl, m20.tp2HitPct,
        bestModel, improvementPct,
      );

      const sign = improvementPct >= 0 ? '+' : '';
      reportLines.push('');
      reportLines.push(`▸ ${strategy}  n=${trades.length}`);
      reportLines.push(`  BASE:  ${base.avgPnl} avg_pnl  WR=${Math.round(base.wr*100)}%`);
      reportLines.push(`  M1.5:  ${m15.avgPnl} avg_pnl  TP2hit=${Math.round(m15.tp2HitPct*100)}% of wins`);
      reportLines.push(`  M2.0:  ${m20.avgPnl} avg_pnl  TP2hit=${Math.round(m20.tp2HitPct*100)}% of wins`);
      reportLines.push(`  Best: ${bestModel}  ${sign}${improvementPct}% P&L vs BASE`);

      if (bestModel !== 'BASE' && improvementPct >= 5) {
        const tp2HitPct = bestModel === 'M15' ? m15.tp2HitPct : m20.tp2HitPct;
        recommendations.push(
          `${strategy}: ${bestModel} +${improvementPct}% P&L (TP2 hit ${Math.round(tp2HitPct * 100)}% of wins)`
        );
      }

      console.log(`[${WORKER_NAME}] ${strategy}: base=${base.totalPnl} m15=${m15.totalPnl} m20=${m20.totalPnl} best=${bestModel}(${sign}${improvementPct}%)`);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  if (recommendations.length) {
    reportLines.push('');
    reportLines.push(`⚡ Recommendations:`);
    recommendations.forEach(r => reportLines.push(`  • ${r}`));
  } else {
    reportLines.push('');
    reportLines.push('✓ BASE model optimal — no multi-TP improvement found');
  }

  const body  = reportLines.join('\n').trimEnd();
  const title = recommendations.length
    ? `Aurum — Multi-TP Backtest ⚡ ${recommendations.length} upgrade(s)`
    : 'Aurum — Multi-TP Backtest ✓ base model optimal';

  const ntfyOk = await sendNtfy(title, body);

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'IDLE', {
    completedAt: new Date().toISOString(),
    recommendations: recommendations.length,
    ntfyOk,
  });

  console.log(`[${WORKER_NAME}] Done — ${recommendations.length} recommendation(s), ntfy=${ntfyOk}`);
  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
});
