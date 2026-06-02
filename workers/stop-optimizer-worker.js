'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'stop-optimizer';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];

function percentile(sorted, p) {
  const idx = Math.floor(p * sorted.length);
  return sorted[idx];
}

function median(sorted) {
  return percentile(sorted, 0.5);
}

function postRecommendation(db, strategy, payload) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES (?, 'consensus', 'recommendation', ?, ?, 3)
    `).run(WORKER_NAME, strategy, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS stop_intelligence_log (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date              TEXT NOT NULL,
      strategy_name         TEXT NOT NULL,
      trade_count           INTEGER,
      winner_count          INTEGER,
      loser_count           INTEGER,
      winner_mae_p50_atr    REAL,
      winner_mae_p75_atr    REAL,
      winner_mae_p90_atr    REAL,
      optimal_sl_atr_ratio  REAL,
      current_sl_atr_ratio  REAL,
      near_stop_loss_pct    REAL,
      recoverable_loss_pct  REAL,
      recommendation        TEXT,
      computed_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_date, strategy_name)
    )
  `).run();

  const runDate = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const strategy of STRATEGIES) {
    try {
      // ── 1. MAE analysis for winners ──────────────────────────────────────────
      const winnerRows = db.prepare(`
        SELECT mae_pts, atr
        FROM trade_dna
        WHERE strategy_name = ?
          AND outcome = 'WIN'
          AND mae_pts IS NOT NULL
          AND atr > 0
          AND sl_pts > 0
      `).all(strategy);

      let winnerMaeP50Atr    = null;
      let winnerMaeP75Atr    = null;
      let winnerMaeP90Atr    = null;
      let optimalSlAtrRatio  = null;

      if (winnerRows.length >= 10) {
        const maeAtrValues = winnerRows
          .map(r => r.mae_pts / r.atr)
          .sort((a, b) => a - b);

        winnerMaeP50Atr   = percentile(maeAtrValues, 0.50);
        winnerMaeP75Atr   = percentile(maeAtrValues, 0.75);
        winnerMaeP90Atr   = percentile(maeAtrValues, 0.90);
        optimalSlAtrRatio = winnerMaeP90Atr * 1.05;
      }

      // ── 2. Current stop profile ───────────────────────────────────────────────
      const allTradeRows = db.prepare(`
        SELECT sl_pts, atr
        FROM trade_dna
        WHERE strategy_name = ?
          AND sl_pts IS NOT NULL
          AND atr > 0
          AND outcome IN ('WIN', 'LOSS', 'BE')
      `).all(strategy);

      let currentSlAtrRatio = null;

      if (allTradeRows.length > 0) {
        const slAtrValues = allTradeRows
          .map(r => r.sl_pts / r.atr)
          .sort((a, b) => a - b);
        currentSlAtrRatio = median(slAtrValues);
      }

      // ── 3. Near-stop loss analysis ────────────────────────────────────────────
      const lossRows = db.prepare(`
        SELECT mae_sl_ratio
        FROM trade_dna
        WHERE strategy_name = ?
          AND outcome = 'LOSS'
          AND mae_sl_ratio IS NOT NULL
      `).all(strategy);

      let nearStopLossPct    = null;
      let recoverableLossPct = null;

      if (lossRows.length >= 5) {
        const nearStopCount    = lossRows.filter(r => r.mae_sl_ratio >= 0.90).length;
        const recoverableCount = lossRows.filter(r => r.mae_sl_ratio < 0.50).length;
        nearStopLossPct    = nearStopCount    / lossRows.length;
        recoverableLossPct = recoverableCount / lossRows.length;
      }

      // ── 4. Recommendation logic ───────────────────────────────────────────────
      let recommendation = 'OPTIMAL';

      if (optimalSlAtrRatio != null && currentSlAtrRatio != null &&
          nearStopLossPct != null && recoverableLossPct != null) {
        if (currentSlAtrRatio < optimalSlAtrRatio * 0.85 && recoverableLossPct > 0.25) {
          recommendation = 'WIDEN_STOPS';
        } else if (currentSlAtrRatio > optimalSlAtrRatio * 1.30 && nearStopLossPct < 0.10) {
          recommendation = 'TIGHTEN_STOPS';
        }
      }

      if (recommendation !== 'OPTIMAL') {
        postRecommendation(db, strategy, {
          recommendation,
          strategy,
          optimal_sl_atr_ratio:  optimalSlAtrRatio  != null ? +optimalSlAtrRatio.toFixed(4)  : null,
          current_sl_atr_ratio:  currentSlAtrRatio  != null ? +currentSlAtrRatio.toFixed(4)  : null,
          near_stop_loss_pct:    nearStopLossPct     != null ? +nearStopLossPct.toFixed(4)    : null,
          recoverable_loss_pct:  recoverableLossPct  != null ? +recoverableLossPct.toFixed(4) : null,
          winner_count:          winnerRows.length,
          loser_count:           lossRows.length,
          timestamp:             new Date().toISOString(),
        });
      }

      // ── 5. Write to stop_intelligence_log ────────────────────────────────────
      db.prepare(`
        INSERT INTO stop_intelligence_log
          (run_date, strategy_name, trade_count, winner_count, loser_count,
           winner_mae_p50_atr, winner_mae_p75_atr, winner_mae_p90_atr,
           optimal_sl_atr_ratio, current_sl_atr_ratio,
           near_stop_loss_pct, recoverable_loss_pct, recommendation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_date, strategy_name) DO UPDATE SET
          trade_count           = excluded.trade_count,
          winner_count          = excluded.winner_count,
          loser_count           = excluded.loser_count,
          winner_mae_p50_atr    = excluded.winner_mae_p50_atr,
          winner_mae_p75_atr    = excluded.winner_mae_p75_atr,
          winner_mae_p90_atr    = excluded.winner_mae_p90_atr,
          optimal_sl_atr_ratio  = excluded.optimal_sl_atr_ratio,
          current_sl_atr_ratio  = excluded.current_sl_atr_ratio,
          near_stop_loss_pct    = excluded.near_stop_loss_pct,
          recoverable_loss_pct  = excluded.recoverable_loss_pct,
          recommendation        = excluded.recommendation,
          computed_at           = datetime('now')
      `).run(
        runDate,
        strategy,
        allTradeRows.length,
        winnerRows.length,
        lossRows.length,
        winnerMaeP50Atr    != null ? +winnerMaeP50Atr.toFixed(4)   : null,
        winnerMaeP75Atr    != null ? +winnerMaeP75Atr.toFixed(4)   : null,
        winnerMaeP90Atr    != null ? +winnerMaeP90Atr.toFixed(4)   : null,
        optimalSlAtrRatio  != null ? +optimalSlAtrRatio.toFixed(4)  : null,
        currentSlAtrRatio  != null ? +currentSlAtrRatio.toFixed(4)  : null,
        nearStopLossPct    != null ? +nearStopLossPct.toFixed(4)    : null,
        recoverableLossPct != null ? +recoverableLossPct.toFixed(4) : null,
        recommendation,
      );

      results.push({
        strategy,
        recommendation,
        optimalSlAtrRatio,
        currentSlAtrRatio,
        winnerCount: winnerRows.length,
        loserCount:  lossRows.length,
      });

      console.log(
        `[${WORKER_NAME}] ${strategy}: ${recommendation}` +
        ` | optimal_sl_atr=${optimalSlAtrRatio != null ? optimalSlAtrRatio.toFixed(3) : 'N/A'}` +
        ` | current_sl_atr=${currentSlAtrRatio != null ? currentSlAtrRatio.toFixed(3) : 'N/A'}` +
        ` | winners=${winnerRows.length} losers=${lossRows.length}`
      );
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  // ── Ntfy notification ─────────────────────────────────────────────────────────
  const hasAlert = results.some(r => r.recommendation === 'WIDEN_STOPS' || r.recommendation === 'TIGHTEN_STOPS');

  const bodyLines = [`Stop Optimizer — Weekly Analysis  ${runDate}`, ''];
  for (const r of results) {
    const optStr  = r.optimalSlAtrRatio  != null ? r.optimalSlAtrRatio.toFixed(3)  : 'N/A';
    const currStr = r.currentSlAtrRatio  != null ? r.currentSlAtrRatio.toFixed(3) : 'N/A';
    bodyLines.push(`${r.strategy}: ${r.recommendation}  optimal=${optStr}  current=${currStr}`);
  }

  await sendNotification(
    'Stop Optimizer — Weekly Analysis',
    bodyLines.join('\n'),
    {
      priority: hasAlert ? 'high' : 'default',
      tags:     'wrench,chart_with_downwards_trend',
    }
  );

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    completedAt:      new Date().toISOString(),
    strategiesRun:    results.length,
    alertsPosted:     results.filter(r => r.recommendation !== 'OPTIMAL').length,
  });

  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
