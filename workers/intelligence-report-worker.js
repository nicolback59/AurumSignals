'use strict';

/**
 * INTELLIGENCE REPORT WORKER
 *
 * Weekly cron: Mondays at 07:00 UTC.
 * Consolidates all Phase 1-4 intelligence data into a single weekly digest
 * and writes it to the reports table (report_type = 'INTELLIGENCE_WEEKLY').
 *
 * Report sections:
 *   1. Executive summary     — 30d trades, WR, expectancy, PF
 *   2. Strategy health       — from strategy_health_snapshots (Phase 1)
 *   3. Edge health           — from edge_health_log (Phase 4)
 *   4. Failure analysis      — from loss_forensics (Phase 2)
 *   5. Win patterns          — from win_forensics (Phase 2)
 *   6. Top correlations      — from feature_correlations (Phase 3, optional)
 *   7. Consensus actions     — from intervention_log (Phase 3, optional)
 *   8. Calibration status    — from calibration_audit (Phase 1)
 *   9. Agent trust scores    — from agent_trust_scores
 *  10. Recommended actions   — synthesised from above
 *
 * Gracefully skips sections that depend on Phase 3 tables if those
 * tables don't yet exist (Phase 3 PR may not be merged).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'intelligence-report';

// ── Utility ───────────────────────────────────────────────────────────────────

function pct(n, total) {
  if (!total) return null;
  return Math.round((n / total) * 1000) / 10; // one decimal
}

function safeQuery(db, fn) {
  try { return fn(); } catch (_) { return null; }
}

/** Monday of the current ISO week (UTC), returns YYYY-MM-DD string. */
function currentWeekMonday() {
  const d   = new Date();
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildExecutiveSummary(db) {
  const row = db.prepare(`
    SELECT
      COUNT(*)  AS total,
      SUM(CASE WHEN o.result = 'WIN'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN o.result = 'BE'   THEN 1 ELSE 0 END) AS be,
      AVG(o.pnl_pts) AS avg_pnl,
      SUM(CASE WHEN o.pnl_pts > 0 THEN o.pnl_pts ELSE 0 END)  AS gross_profit,
      SUM(CASE WHEN o.pnl_pts < 0 THEN -o.pnl_pts ELSE 0 END) AS gross_loss
    FROM outcomes o
    JOIN signals  s ON s.id = o.signal_id
    WHERE o.result IN ('WIN','LOSS','BE','EXPIRED')
      AND o.exit_at >= datetime('now', '-30 days')
  `).get();

  const total       = row?.total ?? 0;
  const wins        = row?.wins  ?? 0;
  const wr          = total > 0 ? pct(wins, total) : null;
  const grossProfit = row?.gross_profit ?? 0;
  const grossLoss   = row?.gross_loss   ?? 0;
  const pf          = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : null;

  // Per-strategy 30d breakdown
  const byStrategy = db.prepare(`
    SELECT s.strategy_name,
      COUNT(*)  AS total,
      SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS wins,
      AVG(o.pnl_pts) AS avg_pnl
    FROM outcomes o
    JOIN signals  s ON s.id = o.signal_id
    WHERE o.result IN ('WIN','LOSS','BE','EXPIRED')
      AND o.exit_at >= datetime('now', '-30 days')
      AND s.strategy_name IS NOT NULL
    GROUP BY s.strategy_name
    ORDER BY total DESC
  `).all();

  return {
    period:        '30d',
    trades_total:  total,
    win_rate_pct:  wr,
    avg_pnl_pts:   row?.avg_pnl != null ? Math.round(row.avg_pnl * 100) / 100 : null,
    profit_factor: pf,
    by_strategy:   byStrategy.map(r => ({
      name:         r.strategy_name,
      trades:       r.total,
      win_rate_pct: pct(r.wins, r.total),
      avg_pnl_pts:  r.avg_pnl != null ? Math.round(r.avg_pnl * 100) / 100 : null,
    })),
  };
}

function buildStrategyHealth(db) {
  return safeQuery(db, () => {
    const rows = db.prepare(`
      SELECT strategy_name, health_score, health_status,
             wr_7d, wr_30d, exp_30d, pf_30d, trades_30d,
             wr_trend, top_failure, top_failure_pct, snapshot_date
      FROM strategy_health_snapshots
      WHERE snapshot_date = (
        SELECT MAX(s2.snapshot_date) FROM strategy_health_snapshots s2
        WHERE s2.strategy_name = strategy_health_snapshots.strategy_name
      )
      ORDER BY health_score ASC
    `).all();
    return rows.map(r => ({ ...r }));
  });
}

function buildEdgeHealth(db) {
  return safeQuery(db, () => {
    const rows = db.prepare(`
      SELECT strategy_name, decay_score, edge_status,
             wr_last5, wr_last10, wr_last20, baseline_wr,
             consecutive_losses, trades_available, notes, checked_at
      FROM edge_health_log
      WHERE checked_at = (
        SELECT MAX(e2.checked_at) FROM edge_health_log e2
        WHERE e2.strategy_name = edge_health_log.strategy_name
      )
      ORDER BY decay_score DESC
    `).all();
    return rows.map(r => ({ ...r }));
  });
}

function buildFailureAnalysis(db) {
  return safeQuery(db, () => {
    // 14-day category breakdown
    const categories = db.prepare(`
      SELECT strategy_name, failure_category,
             COUNT(*) AS n
      FROM loss_forensics
      WHERE created_at >= datetime('now', '-14 days')
      GROUP BY strategy_name, failure_category
      ORDER BY strategy_name, n DESC
    `).all();

    // Total losses per strategy in 14d
    const totals = db.prepare(`
      SELECT strategy_name, COUNT(*) AS total
      FROM loss_forensics
      WHERE created_at >= datetime('now', '-14 days')
      GROUP BY strategy_name
    `).all();

    const totalMap = {};
    for (const t of totals) totalMap[t.strategy_name] = t.total;

    const grouped = {};
    for (const row of categories) {
      if (!grouped[row.strategy_name]) grouped[row.strategy_name] = [];
      grouped[row.strategy_name].push({
        category:  row.failure_category,
        count:     row.n,
        pct:       pct(row.n, totalMap[row.strategy_name]),
        is_dominant: pct(row.n, totalMap[row.strategy_name]) > 45,
      });
    }
    return { period: '14d', by_strategy: grouped };
  });
}

function buildWinPatterns(db) {
  return safeQuery(db, () => {
    const categories = db.prepare(`
      SELECT strategy_name, win_category,
             COUNT(*) AS n,
             AVG(rr_achieved) AS avg_rr,
             AVG(hold_time_min) AS avg_hold_min
      FROM win_forensics
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY strategy_name, win_category
      ORDER BY strategy_name, n DESC
    `).all();

    const totals = db.prepare(`
      SELECT strategy_name, COUNT(*) AS total
      FROM win_forensics
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY strategy_name
    `).all();

    const totalMap = {};
    for (const t of totals) totalMap[t.strategy_name] = t.total;

    const grouped = {};
    for (const row of categories) {
      if (!grouped[row.strategy_name]) grouped[row.strategy_name] = [];
      grouped[row.strategy_name].push({
        category:     row.win_category,
        count:        row.n,
        pct:          pct(row.n, totalMap[row.strategy_name]),
        avg_rr:       row.avg_rr != null ? Math.round(row.avg_rr * 100) / 100 : null,
        avg_hold_min: row.avg_hold_min != null ? Math.round(row.avg_hold_min) : null,
        is_dominant:  pct(row.n, totalMap[row.strategy_name]) > 40,
      });
    }
    return { period: '30d', by_strategy: grouped };
  });
}

function buildTopCorrelations(db) {
  return safeQuery(db, () => {
    const hasTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='feature_correlations'"
    ).get();
    if (!hasTable) return null;

    const rows = db.prepare(`
      SELECT strategy_name, feature_key, feature_value,
             period_days, sample_size, win_rate, baseline_wr, wr_delta, significance,
             computed_at
      FROM feature_correlations
      WHERE significance IN ('STRONG','MODERATE')
        AND computed_at >= datetime('now', '-7 days')
      ORDER BY ABS(wr_delta) DESC
      LIMIT 20
    `).all();

    return rows.map(r => ({ ...r }));
  });
}

function buildConsensusActions(db) {
  return safeQuery(db, () => {
    const hasTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='intervention_log'"
    ).get();
    if (!hasTable) return null;

    const rows = db.prepare(`
      SELECT id, strategy_name, recommendation_text, applied_at,
             eval_status, wr_before, wr_after, confidence_score
      FROM intervention_log
      WHERE applied_at >= datetime('now', '-30 days')
      ORDER BY applied_at DESC
      LIMIT 10
    `).all();

    return rows.map(r => ({ ...r }));
  });
}

function buildCalibrationStatus(db) {
  return safeQuery(db, () => {
    const rows = db.prepare(`
      SELECT strategy_name, conf_bucket, period_days,
             sample_size, actual_wr, predicted_wr,
             ABS(actual_wr - predicted_wr) AS calibration_error,
             computed_at
      FROM calibration_audit
      WHERE period_days = 30
        AND computed_at >= datetime('now', '-7 days')
      ORDER BY strategy_name, conf_bucket
    `).all();

    return rows.map(r => ({
      ...r,
      calibration_error: r.calibration_error != null
        ? Math.round(r.calibration_error * 1000) / 10 : null,
      is_degraded: r.calibration_error > 0.15,
    }));
  });
}

function buildAgentTrust(db) {
  return safeQuery(db, () => {
    const rows = db.prepare(`
      SELECT agent_name, recommendations, correct_calls, incorrect_calls,
             trust_weight, last_calibrated
      FROM agent_trust_scores
      ORDER BY trust_weight DESC, recommendations DESC
    `).all();

    return rows.map(r => ({
      ...r,
      accuracy_pct: r.recommendations > 0
        ? pct(r.correct_calls, r.recommendations) : null,
    }));
  });
}

function buildRecommendations(sections) {
  const recs = [];

  // Edge health alerts
  if (sections.edge_health) {
    for (const e of sections.edge_health) {
      if (e.edge_status === 'COLLAPSE') {
        recs.push({ priority: 1, action: 'PAUSE_STRATEGY', strategy: e.strategy_name,
          reason: `Edge in COLLAPSE (score ${e.decay_score}). ${e.notes}` });
      } else if (e.edge_status === 'CRITICAL') {
        recs.push({ priority: 2, action: 'REDUCE_SIZE', strategy: e.strategy_name,
          reason: `Edge CRITICAL (score ${e.decay_score}). ${e.notes}` });
      }
    }
  }

  // Strategy health alerts
  if (sections.strategy_health) {
    for (const s of sections.strategy_health) {
      if (s.health_status === 'CRITICAL') {
        recs.push({ priority: 2, action: 'REVIEW_PARAMETERS', strategy: s.strategy_name,
          reason: `Health CRITICAL (score ${s.health_score}). Top failure: ${s.top_failure}` });
      } else if (s.health_status === 'DEGRADED') {
        recs.push({ priority: 3, action: 'MONITOR_CLOSELY', strategy: s.strategy_name,
          reason: `Health DEGRADED (score ${s.health_score}). WR 30d: ${s.wr_30d}` });
      }
    }
  }

  // Dominant failure modes
  if (sections.failure_analysis?.by_strategy) {
    for (const [strat, cats] of Object.entries(sections.failure_analysis.by_strategy)) {
      const dominant = cats.find(c => c.is_dominant);
      if (dominant) {
        recs.push({ priority: 3, action: 'ADDRESS_FAILURE_MODE', strategy: strat,
          reason: `${dominant.category} accounts for ${dominant.pct}% of losses (14d)` });
      }
    }
  }

  // Calibration degraded
  if (sections.calibration_status) {
    const degraded = sections.calibration_status.filter(c => c.is_degraded);
    for (const c of degraded) {
      recs.push({ priority: 4, action: 'RECALIBRATE_CONFIDENCE', strategy: c.strategy_name,
        reason: `Calibration error ${c.calibration_error}pp in ${c.conf_bucket} bucket (30d)` });
    }
  }

  recs.sort((a, b) => a.priority - b.priority);
  return recs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  const weekMonday = currentWeekMonday();
  const reportId   = `INTELLIGENCE_WEEKLY_${weekMonday}`;

  // Skip if already generated this week
  const existing = db.prepare(
    "SELECT id FROM reports WHERE report_id = ? AND status = 'completed'"
  ).get(reportId);
  if (existing) {
    console.log(`[${WORKER_NAME}] Report ${reportId} already exists — skipping`);
    heartbeat(db, WORKER_NAME, 'COMPLETED', { skipped: true, reportId });
    db.close();
    return;
  }

  console.log(`[${WORKER_NAME}] Generating ${reportId}...`);

  try {
    // ── Build all sections ───────────────────────────────────────────────────
    const exec        = buildExecutiveSummary(db);
    const stratHealth = buildStrategyHealth(db);
    const edgeHealth  = buildEdgeHealth(db);
    const failures    = buildFailureAnalysis(db);
    const winPatterns = buildWinPatterns(db);
    const correlations = buildTopCorrelations(db);
    const consensus   = buildConsensusActions(db);
    const calibration = buildCalibrationStatus(db);
    const agentTrust  = buildAgentTrust(db);

    const sections = {
      executive_summary:  exec,
      strategy_health:    stratHealth,
      edge_health:        edgeHealth,
      failure_analysis:   failures,
      win_patterns:       winPatterns,
      top_correlations:   correlations,
      consensus_actions:  consensus,
      calibration_status: calibration,
      agent_trust:        agentTrust,
    };

    const recommendations = buildRecommendations(sections);
    sections.recommended_actions = recommendations;

    // ── Build narrative summary ──────────────────────────────────────────────
    const totalTrades = exec.trades_total;
    const wrLine      = exec.win_rate_pct != null ? `${exec.win_rate_pct}% WR` : 'WR unknown';
    const pfLine      = exec.profit_factor != null ? `, PF ${exec.profit_factor}` : '';
    const critStrategies = (stratHealth || [])
      .filter(s => ['CRITICAL','DEGRADED'].includes(s.health_status))
      .map(s => `${s.strategy_name}(${s.health_status})`).join(', ') || 'none';
    const collapseStrategies = (edgeHealth || [])
      .filter(e => ['COLLAPSE','CRITICAL'].includes(e.edge_status))
      .map(e => `${e.strategy_name}(${e.edge_status})`).join(', ') || 'none';

    const narrative = [
      `=== AURUM SIGNALS — Intelligence Weekly Report ===`,
      `Week: ${weekMonday} | Generated: ${new Date().toISOString()}`,
      ``,
      `EXECUTIVE SUMMARY`,
      `30-day trades: ${totalTrades} | ${wrLine}${pfLine}`,
      exec.by_strategy.map(s =>
        `  ${s.name}: ${s.trades} trades, WR ${s.win_rate_pct ?? '?'}%, avg ${s.avg_pnl_pts ?? '?'}pts`
      ).join('\n'),
      ``,
      `STRATEGY HEALTH`,
      critStrategies !== 'none'
        ? `⚠️  Strategies needing attention: ${critStrategies}`
        : '✅ All strategies within healthy range',
      ``,
      `EDGE HEALTH`,
      collapseStrategies !== 'none'
        ? `🔴 Edge decay detected: ${collapseStrategies}`
        : '✅ Edge integrity intact across all strategies',
      ``,
      `RECOMMENDED ACTIONS (${recommendations.length})`,
      recommendations.length
        ? recommendations.map((r, i) =>
            `  ${i+1}. [P${r.priority}] ${r.action} — ${r.strategy}: ${r.reason}`
          ).join('\n')
        : '  No critical actions required this week.',
    ].join('\n');

    // ── Persist to reports table ─────────────────────────────────────────────
    const endDate   = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    db.prepare(`
      INSERT OR REPLACE INTO reports
        (report_id, report_type, scope, status, generated_at,
         start_date, end_date, summary, metrics_json, strategy_json,
         recommendations_json, failure_analysis, narrative)
      VALUES (?, 'INTELLIGENCE_WEEKLY', 'COMBINED', 'completed', datetime('now'),
              ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      startDate,
      endDate,
      `Intelligence weekly: ${totalTrades} trades, ${wrLine}. ${recommendations.length} recommendation(s).`,
      JSON.stringify({ executive_summary: exec, edge_health: edgeHealth, calibration_status: calibration, agent_trust: agentTrust }),
      JSON.stringify({ strategy_health: stratHealth, win_patterns: winPatterns }),
      JSON.stringify(recommendations),
      JSON.stringify({ failure_analysis: failures, top_correlations: correlations, consensus_actions: consensus }),
      narrative,
    );

    console.log(`[${WORKER_NAME}] Report ${reportId} saved — ${recommendations.length} recommendation(s)`);

    // ── ntfy digest ──────────────────────────────────────────────────────────
    const ntfyUrl   = (process.env.NTFY_URL   || 'https://ntfy.sh').replace(/\/$/, '');
    const ntfyTopic = process.env.NTFY_TOPIC  || '';
    const ntfyToken = process.env.NTFY_TOKEN  || '';
    if (ntfyTopic) {
      try {
        const headers = {
          'Content-Type': 'text/plain',
          'Title':    `[WEEKLY INTELLIGENCE] Aurum — ${weekMonday}`,
          'Priority': 'default',
          'Tags':     'bar_chart,memo',
        };
        if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
        const body = [
          `30d: ${totalTrades} trades | ${wrLine}${pfLine}`,
          `Strategy health alerts: ${critStrategies}`,
          `Edge decay alerts: ${collapseStrategies}`,
          `Recommendations: ${recommendations.length}`,
          recommendations.slice(0, 3).map(r =>
            `• [P${r.priority}] ${r.action} — ${r.strategy}`
          ).join('\n'),
        ].filter(Boolean).join('\n');
        await fetch(`${ntfyUrl}/${ntfyTopic}`, {
          method: 'POST', headers, body,
          signal: AbortSignal.timeout(8_000),
        });
      } catch (_) { /* non-critical */ }
    }

    heartbeat(db, WORKER_NAME, 'COMPLETED', {
      pid: process.pid, reportId, recommendations: recommendations.length,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[${WORKER_NAME}] Error:`, err.message, err.stack);
    logWorkerError(db, WORKER_NAME, err);
    heartbeat(db, WORKER_NAME, 'ERROR', { error: err.message });
    try {
      db.prepare(`
        INSERT OR REPLACE INTO reports
          (report_id, report_type, scope, status, generated_at,
           start_date, end_date, summary, error_message)
        VALUES (?, 'INTELLIGENCE_WEEKLY', 'COMBINED', 'failed', datetime('now'),
                ?, ?, 'Failed to generate intelligence report', ?)
      `).run(
        reportId,
        new Date(Date.now() - 30*86400000).toISOString().slice(0,10),
        new Date().toISOString().slice(0,10),
        err.message,
      );
    } catch (_) {}
    db.close();
    process.exit(1);
  }

  db.close();
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message);
  process.exit(1);
});
