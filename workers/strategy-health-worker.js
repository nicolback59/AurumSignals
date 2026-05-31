'use strict';

/**
 * STRATEGY HEALTH WORKER
 *
 * Daily snapshot of rolling win-rate, expectancy, profit-factor, and frequency
 * for each strategy. Writes to strategy_health_snapshots. Sends ntfy if a
 * strategy transitions to DEGRADED or CRITICAL.
 *
 * PM2 cron: 0 5 * * * (5 AM UTC daily — after overnight reconciliation)
 * autorestart: false — runs once, exits.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'strategy-health-worker';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_URL   = NTFY_TOPIC ? `https://ntfy.sh/${NTFY_TOPIC}` : null;

// ── Score weights ──────────────────────────────────────────────────────────────
const W = {
  wr_trend:       0.20,
  exp_trend:      0.20,
  pf_trend:       0.15,
  frequency:      0.10,
  failure_rate:   0.15,
  calibration:    0.10,
  regime_fit:     0.05,
  session_fit:    0.05,
};

// ── Health thresholds ──────────────────────────────────────────────────────────
const STATUS_THRESHOLDS = {
  HEALTHY:   70,
  CAUTION:   50,
  DEGRADED:  30,
};

function statusFromScore(score) {
  if (score >= STATUS_THRESHOLDS.HEALTHY)  return 'HEALTHY';
  if (score >= STATUS_THRESHOLDS.CAUTION)  return 'CAUTION';
  if (score >= STATUS_THRESHOLDS.DEGRADED) return 'DEGRADED';
  return 'CRITICAL';
}

// ── Rolling metrics query ──────────────────────────────────────────────────────

function rollingMetrics(db, strategy, days) {
  const rows = db.prepare(`
    SELECT o.win, o.pnl_pts
    FROM outcomes o
    JOIN signals  s ON s.id = o.signal_id
    WHERE s.strategy_name = ?
      AND o.resolved_at >= datetime('now', ? || ' days')
      AND o.win IS NOT NULL
  `).all(strategy, `-${days}`);

  if (!rows.length) return null;
  const wins   = rows.filter(r => r.win).length;
  const losses = rows.length - wins;
  const wr     = wins / rows.length;
  const pnlPts = rows.map(r => r.pnl_pts ?? 0);
  const avgWin = pnlPts.filter((_, i) => rows[i].win).reduce((s, v) => s + v, 0) / (wins || 1);
  const avgLoss= Math.abs(pnlPts.filter((_, i) => !rows[i].win).reduce((s, v) => s + v, 0) / (losses || 1));
  const expectancy = wr * avgWin - (1 - wr) * avgLoss;
  const grossProfit= pnlPts.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss  = Math.abs(pnlPts.filter(v => v < 0).reduce((s, v) => s + v, 0));
  const pf         = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0;

  return {
    count:      rows.length,
    wr:         +wr.toFixed(4),
    expectancy: +expectancy.toFixed(2),
    pf:         +pf.toFixed(3),
  };
}

// ── Trend direction (1 = improving, -1 = worsening, 0 = flat) ─────────────────

function trend(short, long) {
  if (short == null || long == null) return 0;
  const delta = short - long;
  if (Math.abs(delta) < 0.02) return 0;
  return delta > 0 ? 1 : -1;
}

// ── Failure breakdown ──────────────────────────────────────────────────────────

function failureBreakdown(db, strategy, days) {
  const rows = db.prepare(`
    SELECT o.failure_category, COUNT(*) n
    FROM outcomes o
    JOIN signals  s ON s.id = o.signal_id
    WHERE s.strategy_name = ?
      AND o.win = 0
      AND o.resolved_at >= datetime('now', ? || ' days')
      AND o.failure_category IS NOT NULL
    GROUP BY o.failure_category
    ORDER BY n DESC
  `).all(strategy, `-${days}`);

  return rows;
}

// ── Calibration error (avg |actual_wr - conf/100| per strategy) ───────────────

function calibrationError(db, strategy) {
  try {
    const row = db.prepare(`
      SELECT AVG(ABS(actual_wr - (CAST(SUBSTR(conf_bucket, 1, INSTR(conf_bucket,'-')-1) AS REAL)/100 +
                                   CAST(SUBSTR(conf_bucket, INSTR(conf_bucket,'-')+1) AS REAL)/200)))
             AS cal_err
      FROM calibration_audit
      WHERE strategy_name = ?
        AND period_days IN (14, 30)
    `).get(strategy);
    return row?.cal_err ?? null;
  } catch {
    return null;
  }
}

// ── Score computation ──────────────────────────────────────────────────────────

function computeHealthScore(m7, m30, m90, failRate30, calErr) {
  let score = 50; // baseline

  // WR trend (7d vs 30d vs 90d)
  if (m7 && m30 && m90) {
    const wrTrendShort = trend(m7.wr, m30.wr);   // recent vs medium
    const wrTrendLong  = trend(m30.wr, m90.wr);  // medium vs long
    score += W.wr_trend * 100 * (0.6 * wrTrendShort + 0.4 * wrTrendLong);
  }

  // Expectancy trend
  if (m7 && m30) {
    const expT = trend(m7.expectancy, m30.expectancy);
    score += W.exp_trend * 100 * expT;
  }

  // PF trend
  if (m7 && m30) {
    const pfT = trend(m7.pf, m30.pf);
    score += W.pf_trend * 100 * pfT;
  }

  // Frequency health (penalize if < 4 trades in 7d or < 15 in 30d)
  if (m7 != null && m30 != null) {
    const freqScore = (m7.count >= 4 ? 0.5 : m7.count >= 2 ? 0 : -0.5)
                    + (m30.count >= 15 ? 0.5 : m30.count >= 8 ? 0 : -0.5);
    score += W.frequency * 100 * freqScore;
  }

  // Failure rate: penalize if > 50% losses have the same category (systemic)
  if (failRate30 != null) {
    const penalty = failRate30 > 0.6 ? -1 : failRate30 > 0.4 ? -0.5 : 0;
    score += W.failure_rate * 100 * penalty;
  }

  // Calibration
  if (calErr != null) {
    const calScore = calErr < 0.05 ? 1 : calErr < 0.10 ? 0.5 : calErr < 0.15 ? 0 : -0.5;
    score += W.calibration * 100 * calScore;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── ntfy alert ─────────────────────────────────────────────────────────────────

async function sendAlert(strategy, status, score, topFailure, topPct) {
  if (!NTFY_URL) return;
  try {
    const priority = status === 'CRITICAL' ? '5' : '4';
    const emoji    = status === 'CRITICAL' ? '🔴' : '🟡';
    const title    = `${emoji} ${strategy} → ${status} (${score}/100)`;
    const body     = topFailure
      ? `Top failure: ${topFailure} (${Math.round(topPct * 100)}% of losses)`
      : 'No dominant failure pattern detected.';

    const res = await fetch(NTFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Title':        title,
        'Priority':     priority,
        'Tags':         'chart_decreasing',
      },
      body,
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  } catch (err) {
    console.error(`[${WORKER_NAME}] ntfy error: ${err.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  const today = new Date().toISOString().slice(0, 10);
  let snapshotsWritten = 0;
  let alertsSent = 0;

  for (const strategy of STRATEGIES) {
    try {
      const m7  = rollingMetrics(db, strategy, 7);
      const m14 = rollingMetrics(db, strategy, 14);
      const m30 = rollingMetrics(db, strategy, 30);
      const m90 = rollingMetrics(db, strategy, 90);

      // Need at least some data to be useful
      if (!m30 && !m90) {
        console.log(`[${WORKER_NAME}] ${strategy}: insufficient data, skipping`);
        continue;
      }

      // Failure breakdown (30d)
      const fb30 = failureBreakdown(db, strategy, 30);
      const totalLosses30 = fb30.reduce((s, r) => s + r.n, 0);
      const topRow        = fb30[0];
      const topFailure    = topRow?.failure_category ?? null;
      const topFailPct    = topRow && totalLosses30 > 0 ? topRow.n / totalLosses30 : null;

      // Calibration error
      const calErr = calibrationError(db, strategy);

      // Health score
      const healthScore = computeHealthScore(m7, m30, m90, topFailPct, calErr);
      const healthStatus = statusFromScore(healthScore);

      // Trend labels
      const wrTrendLabel  = m7 && m30 ? (trend(m7.wr, m30.wr) > 0 ? 'UP' : trend(m7.wr, m30.wr) < 0 ? 'DOWN' : 'FLAT') : null;
      const expTrendLabel = m7 && m30 ? (trend(m7.expectancy, m30.expectancy) > 0 ? 'UP' : trend(m7.expectancy, m30.expectancy) < 0 ? 'DOWN' : 'FLAT') : null;
      const freqTrend7  = m7?.count ?? null;
      const freqTrend30 = m30?.count ?? null;

      db.prepare(`
        INSERT INTO strategy_health_snapshots
          (strategy_name, snapshot_date,
           wr_7d, wr_14d, wr_30d, wr_90d,
           exp_7d, exp_14d, exp_30d,
           pf_7d, pf_30d,
           trades_7d, trades_14d, trades_30d,
           wr_trend, exp_trend, freq_trend,
           failure_breakdown, top_failure, top_failure_pct,
           health_score, health_status)
        VALUES
          (?, ?,
           ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?,
           ?, ?)
        ON CONFLICT(strategy_name, snapshot_date) DO UPDATE SET
          wr_7d = excluded.wr_7d, wr_14d = excluded.wr_14d,
          wr_30d = excluded.wr_30d, wr_90d = excluded.wr_90d,
          exp_7d = excluded.exp_7d, exp_14d = excluded.exp_14d,
          exp_30d = excluded.exp_30d,
          pf_7d = excluded.pf_7d, pf_30d = excluded.pf_30d,
          trades_7d = excluded.trades_7d, trades_14d = excluded.trades_14d,
          trades_30d = excluded.trades_30d,
          wr_trend = excluded.wr_trend, exp_trend = excluded.exp_trend,
          freq_trend = excluded.freq_trend,
          failure_breakdown = excluded.failure_breakdown,
          top_failure = excluded.top_failure, top_failure_pct = excluded.top_failure_pct,
          health_score = excluded.health_score, health_status = excluded.health_status
      `).run(
        strategy, today,
        m7?.wr ?? null, m14?.wr ?? null, m30?.wr ?? null, m90?.wr ?? null,
        m7?.expectancy ?? null, m14?.expectancy ?? null, m30?.expectancy ?? null,
        m7?.pf ?? null, m30?.pf ?? null,
        m7?.count ?? null, m14?.count ?? null, m30?.count ?? null,
        wrTrendLabel, expTrendLabel, freqTrend7 != null && freqTrend30 != null
          ? (freqTrend7 > freqTrend30 / 4 ? 'UP' : freqTrend7 < freqTrend30 / 8 ? 'DOWN' : 'FLAT')
          : null,
        fb30.length ? JSON.stringify(fb30) : null,
        topFailure, topFailPct != null ? +topFailPct.toFixed(4) : null,
        healthScore, healthStatus,
      );
      snapshotsWritten++;

      // Alert if DEGRADED or CRITICAL
      if (healthStatus === 'DEGRADED' || healthStatus === 'CRITICAL') {
        await sendAlert(strategy, healthStatus, healthScore, topFailure, topFailPct);
        alertsSent++;
      }

      console.log(`[${WORKER_NAME}] ${strategy}: score=${healthScore} status=${healthStatus} wr30=${m30?.wr ?? 'N/A'}`);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt:      new Date().toISOString(),
    snapshotsWritten,
    alertsSent,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — ${snapshotsWritten} snapshots, ${alertsSent} alerts`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
