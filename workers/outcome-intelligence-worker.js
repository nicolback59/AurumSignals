'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'outcome-intelligence';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

function percentile(sorted, p) {
  return sorted[Math.floor(p * sorted.length)];
}

function upsertLog(db, runDate, strategyName, phase, metricKey, metricValue, metricJson, sampleSize, notes) {
  db.prepare(`
    INSERT OR REPLACE INTO outcome_intelligence_log
      (run_date, strategy_name, phase, metric_key, metric_value, metric_json, sample_size, notes, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(runDate, strategyName, phase, metricKey, metricValue, metricJson, sampleSize, notes ?? null);
}

function postAgentMessage(db, strategy, msgType, payload, priority) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('outcome-intelligence', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

// ── Phase 3 — MAE deep analysis ───────────────────────────────────────────────

function runPhase3(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 3 MAE analysis: ${strategy}`);

  const rows = db.prepare(`
    SELECT mae_pts, atr, mae_sl_ratio
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome = 'WIN'
      AND mae_pts IS NOT NULL
      AND atr > 0
  `).all(strategy);

  if (rows.length < 10) {
    console.log(`[${WORKER_NAME}] Phase 3 ${strategy}: skipped (N=${rows.length} < 10)`);
    return {};
  }

  const maeAtrValues = rows.map(r => r.mae_pts / r.atr).sort((a, b) => a - b);

  const p50 = percentile(maeAtrValues, 0.5);
  const p75 = percentile(maeAtrValues, 0.75);
  const p90 = percentile(maeAtrValues, 0.9);

  const nearStopCount = rows.filter(r => r.mae_sl_ratio != null && r.mae_sl_ratio >= 0.70).length;
  const nearStopPct   = nearStopCount / rows.length;

  upsertLog(db, runDate, strategy, 'mae_analysis', 'mae_winner_p50_atr',  p50,         null, rows.length, null);
  upsertLog(db, runDate, strategy, 'mae_analysis', 'mae_winner_p75_atr',  p75,         null, rows.length, null);
  upsertLog(db, runDate, strategy, 'mae_analysis', 'mae_winner_p90_atr',  p90,         null, rows.length, null);
  upsertLog(db, runDate, strategy, 'mae_analysis', 'near_stop_winner_pct', nearStopPct, null, rows.length, null);

  console.log(`[${WORKER_NAME}] Phase 3 ${strategy}: N=${rows.length} p50=${p50.toFixed(3)} p75=${p75.toFixed(3)} p90=${p90.toFixed(3)} near_stop=${(nearStopPct*100).toFixed(1)}%`);
  return { p50, p75, p90, nearStopPct, n: rows.length };
}

// ── Phase 8 — Expectancy decomposition ───────────────────────────────────────

function runPhase8(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 8 expectancy decomposition: ${strategy}`);

  const allRows = db.prepare(`
    SELECT outcome, confidence, htf_bias, session, pnl_pts
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS', 'BE')
  `).all(strategy);

  function bucket(rows, key) {
    if (rows.length < 5) return;
    const wins    = rows.filter(r => r.outcome === 'WIN').length;
    const wr      = wins / rows.length;
    const avg_pnl = rows.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / rows.length;
    upsertLog(
      db, runDate, strategy, 'expectancy', key,
      +avg_pnl.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: rows.length }),
      rows.length,
      null,
    );
  }

  const withConf = allRows.filter(r => r.confidence != null);
  bucket(withConf.filter(r => r.confidence >= 80), 'conf_high');
  bucket(withConf.filter(r => r.confidence >= 60 && r.confidence < 80), 'conf_med');
  bucket(withConf.filter(r => r.confidence < 60), 'conf_low');

  const htfGroups = {};
  for (const r of allRows) {
    if (r.htf_bias == null) continue;
    const k = String(r.htf_bias);
    if (!htfGroups[k]) htfGroups[k] = [];
    htfGroups[k].push(r);
  }
  for (const [val, rows] of Object.entries(htfGroups)) {
    if (rows.length >= 5) bucket(rows, `htf_${val}`);
  }

  const sessionGroups = {};
  for (const r of allRows) {
    if (r.session == null) continue;
    if (!sessionGroups[r.session]) sessionGroups[r.session] = [];
    sessionGroups[r.session].push(r);
  }
  for (const [val, rows] of Object.entries(sessionGroups)) {
    if (rows.length >= 5) bucket(rows, `session_${val}`);
  }

  console.log(`[${WORKER_NAME}] Phase 8 ${strategy}: done`);
}

// ── Phase 9 — Regime outcome analysis ────────────────────────────────────────

function runPhase9(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 9 regime analysis: ${strategy}`);

  const rows = db.prepare(`
    SELECT regime,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total,
           AVG(pnl_pts) AS avg_pnl
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
      AND regime IS NOT NULL
    GROUP BY regime
  `).all(strategy);

  const results = [];

  for (const r of rows) {
    const counted = r.wins + r.losses;
    if (counted < 5) continue;

    const wr      = r.wins / counted;
    const avg_pnl = r.avg_pnl ?? 0;

    upsertLog(
      db, runDate, strategy, 'regime', r.regime,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: r.total }),
      r.total,
      null,
    );

    results.push({ regime: r.regime, wr, trade_count: r.total, avg_pnl });

    if (counted >= 10 && (wr > 0.70 || wr < 0.40)) {
      postAgentMessage(db, strategy, 'observation', {
        observation: 'regime_edge_detected',
        strategy,
        regime:      r.regime,
        wr:          +wr.toFixed(4),
        avg_pnl:     +avg_pnl.toFixed(4),
        trade_count: r.total,
        timestamp:   new Date().toISOString(),
      }, wr > 0.70 ? 2 : 3);
    }
  }

  console.log(`[${WORKER_NAME}] Phase 9 ${strategy}: ${results.length} regimes`);
  return results;
}

// ── Phase 10 — Session outcome analysis ──────────────────────────────────────

function runPhase10(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 10 session analysis: ${strategy}`);

  const rows = db.prepare(`
    SELECT session,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total,
           AVG(pnl_pts) AS avg_pnl,
           AVG(hold_time_min) AS avg_hold
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS', 'BE')
      AND session IS NOT NULL
    GROUP BY session
  `).all(strategy);

  const results = [];

  for (const r of rows) {
    if (r.total < 5) continue;

    const counted = r.wins + r.losses;
    const wr      = counted > 0 ? r.wins / counted : 0;
    const avg_pnl = r.avg_pnl ?? 0;
    const avg_hold = r.avg_hold ?? 0;

    upsertLog(
      db, runDate, strategy, 'session', r.session,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: r.total, avg_hold_min: +avg_hold.toFixed(2) }),
      r.total,
      null,
    );

    results.push({ session: r.session, wr, avg_pnl, trade_count: r.total, avg_hold_min: avg_hold });
  }

  console.log(`[${WORKER_NAME}] Phase 10 ${strategy}: ${results.length} sessions`);
  return results;
}

// ── Phase 13 — Edge discovery ─────────────────────────────────────────────────

function runPhase13(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 13 edge discovery: ${strategy}`);

  const allRows = db.prepare(`
    SELECT outcome, regime, session, hour_et, pnl_pts
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
      AND regime IS NOT NULL
      AND session IS NOT NULL
  `).all(strategy);

  const totalRows = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
  `).get(strategy);

  const baselineWr = (totalRows && totalRows.n > 0)
    ? totalRows.wins / totalRows.n
    : 0;

  let edgesFound = 0;

  // ── Regime × Session cross ────────────────────────────────────────────────
  const crossMap = {};
  for (const r of allRows) {
    const k = `${r.regime}_${r.session}`;
    if (!crossMap[k]) crossMap[k] = { wins: 0, losses: 0, pnl: 0 };
    if (r.outcome === 'WIN')  crossMap[k].wins++;
    else                      crossMap[k].losses++;
    crossMap[k].pnl += r.pnl_pts ?? 0;
  }

  for (const [key, s] of Object.entries(crossMap)) {
    const total = s.wins + s.losses;
    if (total < 8) continue;

    const wr      = s.wins / total;
    const avg_pnl = s.pnl / total;

    upsertLog(
      db, runDate, strategy, 'edge_cross', key,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: total }),
      total,
      wr >= baselineWr + 0.15 ? 'EDGE_FOUND' : null,
    );

    if (wr >= 0.75) {
      postAgentMessage(db, strategy, 'observation', {
        observation: 'cross_edge_detected',
        strategy,
        combo:       key,
        wr:          +wr.toFixed(4),
        avg_pnl:     +avg_pnl.toFixed(4),
        trade_count: total,
        timestamp:   new Date().toISOString(),
      }, 2);
      edgesFound++;
    }
  }

  // ── Hour-of-day patterns ──────────────────────────────────────────────────
  const hourRows = db.prepare(`
    SELECT hour_et,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total,
           AVG(pnl_pts) AS avg_pnl
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
      AND hour_et IS NOT NULL
    GROUP BY hour_et
  `).all(strategy);

  for (const r of hourRows) {
    const counted = r.wins + r.losses;
    if (counted < 5) continue;

    const wr      = r.wins / counted;
    const avg_pnl = r.avg_pnl ?? 0;
    const isEdge  = wr >= baselineWr + 0.15;

    upsertLog(
      db, runDate, strategy, 'edge_hour', `hour_${r.hour_et}`,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: r.total }),
      r.total,
      isEdge ? 'EDGE_FOUND' : null,
    );
  }

  console.log(`[${WORKER_NAME}] Phase 13 ${strategy}: baseline=${(baselineWr*100).toFixed(1)}% edges=${edgesFound}`);
  return { edgesFound, baselineWr };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const db      = openDb();
  const runDate = new Date().toISOString().slice(0, 10);

  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  const summaryParts = [];

  for (const strategy of STRATEGIES) {
    try {
      const mae      = runPhase3(db, strategy, runDate);
      runPhase8(db, strategy, runDate);
      const regimes  = runPhase9(db, strategy, runDate);
      const sessions = runPhase10(db, strategy, runDate);
      const edges    = runPhase13(db, strategy, runDate);

      const topRegime  = regimes.sort((a, b) => b.wr - a.wr)[0];
      const topSession = sessions.sort((a, b) => b.wr - a.wr)[0];

      const parts = [`[${strategy}]`];
      if (topRegime)  parts.push(`top regime: ${topRegime.regime} WR=${(topRegime.wr*100).toFixed(0)}%`);
      if (topSession) parts.push(`top session: ${topSession.session} WR=${(topSession.wr*100).toFixed(0)}%`);
      if (edges.edgesFound > 0) parts.push(`${edges.edgesFound} edge cross(es) found`);
      if (mae.nearStopPct != null) parts.push(`near-stop winners: ${(mae.nearStopPct*100).toFixed(0)}%`);

      summaryParts.push(parts.join(' | '));
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', { completedAt: new Date().toISOString() });

  const body = summaryParts.length > 0
    ? summaryParts.join('\n')
    : 'No significant findings this week.';

  await sendNotification(
    'Outcome Intelligence — Weekly Analysis Complete',
    body,
    { priority: 'default', tags: 'brain,chart_increasing' },
  );

  db.close();

  console.log(`[${WORKER_NAME}] Done`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
