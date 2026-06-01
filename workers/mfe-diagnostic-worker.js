'use strict';

/**
 * MFE/MAE DIAGNOSTIC WORKER — Edge Audit Part 1
 *
 * Runs every Monday at 06:15 UTC (after trade-dna refresh at 04:30).
 * Queries trade_dna for 5 diagnostic analyses per strategy:
 *   1. BE trigger potential — % of losses where mfe_sl_ratio >= 0.5
 *   2. MAE stop-distance health — % exceeding 50%/75%/100% of SL
 *   3. MFE vs TP1 gap — are we leaving money on the table?
 *   4. Regime WR breakdown — which regimes are losing money
 *   5. Confidence bucket P&L — highest vs lowest conf tier performance
 *
 * Writes one row per strategy to mfe_diagnostic_log.
 * Sends a single weekly ntfy report with actionable findings.
 *
 * PM2 cron: 15 6 * * 1 (Monday 06:15 UTC)
 * autorestart: false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'mfe-diagnostic-worker';
const STRATEGIES  = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN', 'MNQ_FIRE'];
const LOOKBACK    = 90; // days

function qOne(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch (_) { return null; }
}
function q(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch (_) { return []; }
}

function analyzeStrategy(db, strategy) {
  const lookbackClause = `trade_date >= date('now', '-${LOOKBACK} days')`;

  const overall = qOne(db, `
    SELECT COUNT(*) n,
           ROUND(AVG(CASE WHEN outcome = 'WIN' THEN 1.0 ELSE 0.0 END), 3) wr,
           ROUND(AVG(pnl_pts), 2) avg_pnl
    FROM trade_dna
    WHERE strategy_name = ? AND ${lookbackClause}
      AND outcome IN ('WIN','LOSS','BE')
  `, [strategy]);

  // BE trigger: losses where price moved >= 50% of SL in our favour before reversal
  const beTrigger = qOne(db, `
    SELECT COUNT(*) n,
           SUM(CASE WHEN mfe_sl_ratio >= 0.5  THEN 1 ELSE 0 END) be_eligible,
           SUM(CASE WHEN mfe_sl_ratio >= 0.75 THEN 1 ELSE 0 END) be_strong
    FROM trade_dna
    WHERE strategy_name = ? AND ${lookbackClause}
      AND outcome = 'LOSS'
      AND mfe_sl_ratio IS NOT NULL
  `, [strategy]);

  // Regime WR — ordered worst-first for alerting
  const regimeWr = q(db, `
    SELECT regime,
           COUNT(*) n,
           SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) wins
    FROM trade_dna
    WHERE strategy_name = ? AND ${lookbackClause}
      AND outcome IN ('WIN','LOSS')
      AND regime IS NOT NULL
    GROUP BY regime
    HAVING n >= 8
    ORDER BY CAST(wins AS REAL)/n ASC
  `, [strategy]);

  // Confidence bucket P&L
  const confBuckets = q(db, `
    SELECT
      CASE
        WHEN confidence >= 90 THEN '90+'
        WHEN confidence >= 80 THEN '80-89'
        WHEN confidence >= 70 THEN '70-79'
        WHEN confidence >= 60 THEN '60-69'
        ELSE '<60'
      END bucket,
      COUNT(*) n,
      ROUND(AVG(CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END), 3) wr,
      ROUND(AVG(pnl_pts), 2) avg_pnl
    FROM trade_dna
    WHERE strategy_name = ? AND ${lookbackClause}
      AND outcome IN ('WIN','LOSS','BE')
      AND confidence IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket DESC
  `, [strategy]);

  // MAE stop-distance distribution (all resolved trades)
  const maeStats = qOne(db, `
    SELECT COUNT(*) n,
           ROUND(AVG(CASE WHEN mae_sl_ratio > 0.50 THEN 1.0 ELSE 0.0 END), 3) gt50,
           ROUND(AVG(CASE WHEN mae_sl_ratio > 0.75 THEN 1.0 ELSE 0.0 END), 3) gt75,
           ROUND(AVG(CASE WHEN mae_sl_ratio > 1.00 THEN 1.0 ELSE 0.0 END), 3) gt100,
           ROUND(AVG(mae_sl_ratio), 3) avg_ratio
    FROM trade_dna
    WHERE strategy_name = ? AND ${lookbackClause}
      AND mae_sl_ratio IS NOT NULL
  `, [strategy]);

  // MFE vs TP1 (rr_achieved = mfe_pts / tp1_pts; >=1 means MFE exceeded TP1)
  const mfeStats = qOne(db, `
    SELECT ROUND(AVG(rr_achieved), 3) avg_rr_achieved,
           ROUND(AVG(CASE WHEN rr_achieved >= 1.0 THEN 1.0 ELSE 0.0 END), 3) mfe_exceeds_tp1
    FROM trade_dna
    WHERE strategy_name = ? AND ${lookbackClause}
      AND outcome IN ('WIN','LOSS')
      AND rr_achieved IS NOT NULL
  `, [strategy]);

  return { overall, beTrigger, regimeWr, confBuckets, maeStats, mfeStats };
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
      'Tags':     'bar_chart,mag',
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
  const insights    = [];

  const insertDiag = db.prepare(`
    INSERT INTO mfe_diagnostic_log
      (run_date, strategy_name, total_trades, win_rate,
       be_eligible_pct, be_strong_pct,
       regime_wr, conf_bucket_pnl,
       mae_gt50_pct, mae_gt75_pct, mae_gt100_pct, avg_mae_sl_ratio,
       avg_rr_achieved, mfe_exceeds_tp1_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_date, strategy_name) DO UPDATE SET
      total_trades        = excluded.total_trades,
      win_rate            = excluded.win_rate,
      be_eligible_pct     = excluded.be_eligible_pct,
      be_strong_pct       = excluded.be_strong_pct,
      regime_wr           = excluded.regime_wr,
      conf_bucket_pnl     = excluded.conf_bucket_pnl,
      mae_gt50_pct        = excluded.mae_gt50_pct,
      mae_gt75_pct        = excluded.mae_gt75_pct,
      mae_gt100_pct       = excluded.mae_gt100_pct,
      avg_mae_sl_ratio    = excluded.avg_mae_sl_ratio,
      avg_rr_achieved     = excluded.avg_rr_achieved,
      mfe_exceeds_tp1_pct = excluded.mfe_exceeds_tp1_pct
  `);

  reportLines.push(`MFE/MAE Diagnostic  ${runDate}  (${LOOKBACK}d lookback)`);

  for (const strategy of STRATEGIES) {
    try {
      const { overall, beTrigger, regimeWr, confBuckets, maeStats, mfeStats } =
        analyzeStrategy(db, strategy);

      if (!overall?.n || overall.n < 5) {
        reportLines.push(`\n▸ ${strategy}: insufficient data (${overall?.n ?? 0} trades)`);
        continue;
      }

      const beEligiblePct = beTrigger?.n > 0 ? beTrigger.be_eligible / beTrigger.n : null;
      const beStrongPct   = beTrigger?.n > 0 ? beTrigger.be_strong   / beTrigger.n : null;

      // Enrich regime rows with WR for storage
      const regimeWrEnriched = regimeWr.map(r => ({
        regime: r.regime, n: r.n, wr: r.n > 0 ? +(r.wins / r.n).toFixed(3) : 0,
      }));

      insertDiag.run(
        runDate, strategy, overall.n, overall.wr,
        beEligiblePct != null ? +beEligiblePct.toFixed(4) : null,
        beStrongPct   != null ? +beStrongPct.toFixed(4)   : null,
        regimeWrEnriched.length ? JSON.stringify(regimeWrEnriched) : null,
        confBuckets.length ? JSON.stringify(confBuckets) : null,
        maeStats?.gt50  ?? null,
        maeStats?.gt75  ?? null,
        maeStats?.gt100 ?? null,
        maeStats?.avg_ratio ?? null,
        mfeStats?.avg_rr_achieved    ?? null,
        mfeStats?.mfe_exceeds_tp1    ?? null,
      );

      reportLines.push('');
      reportLines.push(`▸ ${strategy}  WR=${Math.round((overall.wr ?? 0)*100)}%  n=${overall.n}  avg_pnl=${overall.avg_pnl ?? '?'}`);

      // BE trigger
      if (beEligiblePct != null && beTrigger.n >= 5) {
        const pct = Math.round(beEligiblePct * 100);
        reportLines.push(`  BE: ${pct}% of losses hit +0.5R (${beTrigger.be_eligible}/${beTrigger.n})`);
        if (pct >= 25) insights.push(`${strategy}: ${pct}% of losses reached +0.5R → enable BE stop`);
      }

      // MAE health
      if (maeStats?.gt50 != null && maeStats.n >= 10) {
        const p50  = Math.round(maeStats.gt50  * 100);
        const p100 = Math.round((maeStats.gt100 ?? 0) * 100);
        reportLines.push(`  MAE: ${p50}% exceed 50% SL | ${p100}% hit full SL | avg=${maeStats.avg_ratio}`);
        if (maeStats.gt100 > 0.20) {
          insights.push(`${strategy}: ${p100}% fully stopped out — consider wider stop`);
        }
      }

      // MFE vs TP1
      if (mfeStats?.avg_rr_achieved != null) {
        const rr  = mfeStats.avg_rr_achieved.toFixed(2);
        const pct = mfeStats.mfe_exceeds_tp1 != null
          ? Math.round(mfeStats.mfe_exceeds_tp1 * 100) : '?';
        reportLines.push(`  MFE/TP1: avg_rr=${rr} | MFE>TP1 in ${pct}%`);
        if (mfeStats.mfe_exceeds_tp1 > 0.35) {
          insights.push(`${strategy}: MFE>TP1 in ${pct}% — add TP2 target`);
        }
      }

      // Worst regime (already sorted WR ASC)
      const worstRegime = regimeWrEnriched.find(r => r.wr < 0.44 && r.n >= 10);
      if (worstRegime) {
        const rPct = Math.round(worstRegime.wr * 100);
        reportLines.push(`  ⚠ ${worstRegime.regime}: WR=${rPct}% n=${worstRegime.n} → hard vetoed`);
        insights.push(`${strategy}: ${worstRegime.regime} WR=${rPct}% (n=${worstRegime.n}) — regime blocked`);
      }

      // Confidence bucket anomaly (highest conf < 50% WR)
      const topBucket = confBuckets.find(b => b.bucket === '90+' && b.n >= 5 && b.wr < 0.50);
      if (topBucket) {
        const bPct = Math.round(topBucket.wr * 100);
        reportLines.push(`  ⚠ conf 90+: WR=${bPct}% (n=${topBucket.n}) — overconfident`);
        insights.push(`${strategy}: 90+ confidence WR only ${bPct}% — calibration issue`);
      }

      console.log(`[${WORKER_NAME}] ${strategy}: n=${overall.n} wr=${overall.wr} be_eligible=${beEligiblePct != null ? Math.round(beEligiblePct*100) + '%' : 'N/A'}`);
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  // Actionable summary
  if (insights.length) {
    reportLines.push('');
    reportLines.push(`⚡ Actions (${insights.length}):`);
    insights.slice(0, 5).forEach(i => reportLines.push(`  • ${i}`));
  }

  const body  = reportLines.join('\n').trimEnd();
  const title = insights.length
    ? `Aurum — MFE/MAE Digest ⚡ ${insights.length} finding(s)`
    : 'Aurum — MFE/MAE Digest ✓ all clear';

  const ntfyOk = await sendNtfy(title, body);

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'IDLE', {
    completedAt: new Date().toISOString(),
    insights: insights.length,
    ntfyOk,
  });

  console.log(`[${WORKER_NAME}] Done — ${insights.length} insight(s), ntfy=${ntfyOk}`);
  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
});
