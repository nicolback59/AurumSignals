'use strict';

/**
 * MULTI-TP BACKTEST WORKER — Edge Audit Part 4
 *
 * Runs every Tuesday at 06:30 UTC (after trade-dna refresh at 04:30).
 * Simulates two split-exit models (TP2 at 1.5R and 2.0R) against historical
 * trade_dna data, comparing net P&L to the single-exit baseline.
 *
 * Models:
 *   BASE — current single exit at TP1 (no split)
 *   M15  — 50% at TP1, 50% trailing to TP2 at 1.5× tp1_pts from entry
 *   M20  — 50% at TP1, 50% trailing to TP2 at 2.0× tp1_pts from entry
 *
 * TP2 viability proxy: rr_achieved (mfe_pts / tp1_pts) stored in trade_dna.
 * If rr_achieved >= tp2Ratio, price reached TP2 distance during the trade.
 *
 * For LOSS trades the P&L is unchanged across all models (SL always hit full).
 *
 * Writes one row per strategy to backtest_multi_tp with ON CONFLICT DO UPDATE.
 * Sends ntfy recommendation when a split model beats BASE by ≥5% net P&L.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'multi-tp-backtest';

const STRATEGIES = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];
const LOOKBACK_DAYS = 90;

async function sendNtfy(title, body, priority = 'default') {
  const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
  const ntfyTopic = process.env.NTFY_TOPIC  || '';
  const ntfyToken = process.env.NTFY_TOKEN  || '';
  if (!ntfyTopic) return;
  try {
    const headers = {
      'Content-Type': 'text/plain',
      'Title':    title,
      'Priority': priority,
      'Tags':     'chart_with_upwards_trend,moneybag',
    };
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
    await fetch(`${ntfyUrl}/${ntfyTopic}`, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (_) { /* non-critical */ }
}

/**
 * Simulate one split-exit model on historical trades.
 *
 * tp2Ratio: multiplier against tp1_pts for TP2 distance (null = BASE model)
 *
 * For WIN trades:
 *   BASE: pnl = tp1_pts
 *   M15/M20: pnl = 0.5*tp1_pts + (rr_achieved >= tp2Ratio ? 0.5*(tp2Ratio*tp1_pts) : 0.5*tp1_pts*0)
 *
 * "Trail stopped" (TP1 hit but TP2 not reached):
 *   Treated as PARTIAL_WIN: pnl = 0.5*tp1_pts (half position locked at BE after TP1)
 *
 * For LOSS trades: pnl = -sl_pts (unchanged across all models)
 */
function simulateModel(trades, tp2Ratio) {
  let totalPnl = 0;
  let wins = 0, losses = 0, partialWins = 0, tp2Hits = 0;

  for (const t of trades) {
    const tp1Pts = t.tp1_pts ?? 0;
    const slPts  = t.sl_pts  ?? tp1Pts; // fallback to tp1 if sl_pts missing

    if (t.outcome === 'WIN') {
      wins++;
      if (tp2Ratio == null) {
        totalPnl += tp1Pts;
      } else {
        // Half locked at TP1 always
        totalPnl += 0.5 * tp1Pts;
        // Second half: did price reach TP2?
        if ((t.rr_achieved ?? 0) >= tp2Ratio) {
          totalPnl += 0.5 * (tp2Ratio * tp1Pts);
          tp2Hits++;
        }
        // else: trail returned to entry (PARTIAL_WIN) — second half = 0
        else {
          partialWins++;
        }
      }
    } else if (t.outcome === 'LOSS') {
      losses++;
      totalPnl -= slPts;
    }
    // BE / other — no P&L impact
  }

  const tradeCount = wins + losses + partialWins;
  const tp2HitPct  = wins > 0 && tp2Ratio != null ? tp2Hits / wins : null;

  return { totalPnl: +totalPnl.toFixed(2), tradeCount, wins, losses, partialWins, tp2Hits, tp2HitPct };
}

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  const today = new Date().toISOString().slice(0, 10);

  const insertResult = db.prepare(`
    INSERT INTO backtest_multi_tp
      (run_date, strategy_name, trade_count, base_pnl, m15_pnl, m20_pnl,
       base_wr, m15_wr, m20_wr, m15_tp2_hit_pct, m20_tp2_hit_pct,
       recommended_model, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_date, strategy_name) DO UPDATE SET
      trade_count      = excluded.trade_count,
      base_pnl         = excluded.base_pnl,
      m15_pnl          = excluded.m15_pnl,
      m20_pnl          = excluded.m20_pnl,
      base_wr          = excluded.base_wr,
      m15_wr           = excluded.m15_wr,
      m20_wr           = excluded.m20_wr,
      m15_tp2_hit_pct  = excluded.m15_tp2_hit_pct,
      m20_tp2_hit_pct  = excluded.m20_tp2_hit_pct,
      recommended_model = excluded.recommended_model,
      notes            = excluded.notes,
      computed_at      = datetime('now')
  `);

  let processed = 0;
  const ntfyLines = [`Multi-TP Backtest — ${today}`];

  for (const strategy of STRATEGIES) {
    try {
      const trades = db.prepare(`
        SELECT outcome, tp1_pts, sl_pts, rr_achieved
        FROM trade_dna
        WHERE strategy_name = ?
          AND trade_date >= date('now', '-${LOOKBACK_DAYS} days')
          AND outcome IN ('WIN','LOSS')
          AND tp1_pts > 0
      `).all(strategy);

      if (trades.length < 10) {
        console.log(`[${WORKER_NAME}] ${strategy}: skipped — only ${trades.length} trades`);
        continue;
      }

      const base = simulateModel(trades, null);
      const m15  = simulateModel(trades, 1.5);
      const m20  = simulateModel(trades, 2.0);

      const baseWr = base.wins / (base.wins + base.losses || 1);
      const m15Wr  = m15.wins / (m15.wins + m15.losses || 1);
      const m20Wr  = m20.wins / (m20.wins + m20.losses || 1);

      // Best model by net P&L
      let bestModel = 'BASE';
      let bestPnl   = base.totalPnl;
      if (m15.totalPnl > bestPnl) { bestModel = 'M15'; bestPnl = m15.totalPnl; }
      if (m20.totalPnl > bestPnl) { bestModel = 'M20'; bestPnl = m20.totalPnl; }

      // Only recommend split model if improvement >= 5% over base
      const improvement = base.totalPnl !== 0 ? (bestPnl - base.totalPnl) / Math.abs(base.totalPnl) : 0;
      const recommended = bestModel !== 'BASE' && improvement >= 0.05 ? bestModel : 'BASE';

      const m15Tp2HitPct = m15.tp2HitPct != null ? Math.round(m15.tp2HitPct * 100) : null;
      const m20Tp2HitPct = m20.tp2HitPct != null ? Math.round(m20.tp2HitPct * 100) : null;
      const notes = recommended !== 'BASE'
        ? `${recommended} improves net P&L by ${(improvement * 100).toFixed(1)}% over BASE`
        : 'BASE model optimal or split improvement < 5%';

      insertResult.run(
        today, strategy, trades.length,
        base.totalPnl, m15.totalPnl, m20.totalPnl,
        +baseWr.toFixed(4), +m15Wr.toFixed(4), +m20Wr.toFixed(4),
        m15Tp2HitPct, m20Tp2HitPct,
        recommended, notes,
      );

      const line = `• ${strategy}: BASE=${base.totalPnl >= 0 ? '+' : ''}${base.totalPnl} | ` +
        `M1.5=${m15.totalPnl >= 0 ? '+' : ''}${m15.totalPnl} | ` +
        `M2.0=${m20.totalPnl >= 0 ? '+' : ''}${m20.totalPnl} → ${recommended}`;
      ntfyLines.push(line);

      console.log(`[${WORKER_NAME}] ${strategy}: n=${trades.length} base=${base.totalPnl} m15=${m15.totalPnl} m20=${m20.totalPnl} → ${recommended}`);
      processed++;
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  // Send consolidated ntfy summary
  if (processed > 0) {
    await sendNtfy(
      `📊 Multi-TP Backtest — ${processed} strategies`,
      ntfyLines.join('\n'),
      'default',
    );
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies processed`);
  db.close();
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
