'use strict';

/**
 * SIGNAL GATE WORKER
 *
 * Runs every 30 minutes. Synthesizes all Intelligence Engine data (Phases 1-4)
 * into a per-strategy gate score and writes the result to the signal_gates table.
 *
 * Gate score model (additive, higher = more restrictive):
 *   Edge Health (Phase 4):
 *     WATCH     → +3   | WARNING   → +7
 *     CRITICAL  → +12  | COLLAPSE  → +25
 *   Strategy Health (Phase 1):
 *     CAUTION   → +3   | DEGRADED  → +8  | CRITICAL → +15
 *   Active vetoes in agent_messages (Phase 3):
 *     +3 per pending veto, capped at +10
 *   Calibration overconfidence (Phase 1 — 85-95 bucket ≥15pp below predicted):
 *     → +5
 *   Strong positive feature correlation (Phase 3, reduces adjustment):
 *     STRONG positive → -3 per feature, capped at -6
 *
 * Gate status from total score:
 *   ≤ 3   OPEN        — no adjustment, all signals pass normally
 *   4-10  CAUTIOUS    — min confidence raised +5
 *   11-18 RESTRICTED  — min confidence raised +10
 *   ≥ 19  GATED       — strategy paused via adaptive overrides
 *
 * Integration: when gate_status = GATED, the worker writes a pause entry into
 * the adaptive overrides blob (strategy_params) that the scanner reads via
 * computeAdaptiveOverrides. On recovery to OPEN/CAUTIOUS the pause is lifted.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError } = require('./worker-utils');

const WORKER_NAME = 'signal-gate';

const STRATEGIES = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

const CONF_ADJUSTMENT = { OPEN: 0, CAUTIOUS: 5, RESTRICTED: 10, GATED: 20 };

function gateStatus(score) {
  if (score <=  3) return 'OPEN';
  if (score <= 10) return 'CAUTIOUS';
  if (score <= 18) return 'RESTRICTED';
  return 'GATED';
}

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
      'Tags':     'shield,rotating_light',
    };
    if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;
    await fetch(`${ntfyUrl}/${ntfyTopic}`, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (_) { /* non-critical */ }
}

function computeGate(db, strategyName) {
  let score = 0;
  const contributions = { edge: 0, health: 0, vetoes: 0, calibration: 0, correlation: 0 };
  const rationale = [];

  // ── 1. Edge health (Phase 4) ────────────────────────────────────────────────
  try {
    const edgeRow = db.prepare(`
      SELECT edge_status, decay_score FROM edge_health_log
      WHERE strategy_name = ?
        AND checked_at = (SELECT MAX(e2.checked_at) FROM edge_health_log e2 WHERE e2.strategy_name = ?)
    `).get(strategyName, strategyName);

    if (edgeRow) {
      const pts = { WATCH: 3, WARNING: 7, CRITICAL: 12, COLLAPSE: 25 }[edgeRow.edge_status] ?? 0;
      score += pts;
      contributions.edge = pts;
      if (pts > 0) rationale.push(`edge=${edgeRow.edge_status}(+${pts})`);
    }
  } catch (_) {}

  // ── 2. Strategy health (Phase 1) ────────────────────────────────────────────
  try {
    const healthRow = db.prepare(`
      SELECT health_status, health_score FROM strategy_health_snapshots
      WHERE strategy_name = ?
        AND snapshot_date = (SELECT MAX(s2.snapshot_date) FROM strategy_health_snapshots s2 WHERE s2.strategy_name = ?)
    `).get(strategyName, strategyName);

    if (healthRow) {
      const pts = { CAUTION: 3, DEGRADED: 8, CRITICAL: 15 }[healthRow.health_status] ?? 0;
      score += pts;
      contributions.health = pts;
      if (pts > 0) rationale.push(`health=${healthRow.health_status}(+${pts})`);
    }
  } catch (_) {}

  // ── 3. Active vetoes in agent_messages (Phase 3) ───────────────────────────
  try {
    const vetoRow = db.prepare(`
      SELECT COUNT(*) AS n FROM agent_messages
      WHERE strategy = ? AND msg_type = 'veto' AND status = 'pending'
        AND created_at >= datetime('now', '-24 hours')
    `).get(strategyName);

    const vetoPts = Math.min((vetoRow?.n ?? 0) * 3, 10);
    score += vetoPts;
    contributions.vetoes = vetoPts;
    if (vetoPts > 0) rationale.push(`vetoes=${vetoRow.n}(+${vetoPts})`);
  } catch (_) {}

  // ── 4. Calibration overconfidence (Phase 1) ─────────────────────────────────
  try {
    const calRow = db.prepare(`
      SELECT actual_wr, predicted_wr FROM calibration_audit
      WHERE strategy_name = ? AND conf_bucket = '85-95' AND period_days = 30
        AND computed_at >= datetime('now', '-7 days')
      ORDER BY computed_at DESC LIMIT 1
    `).get(strategyName);

    if (calRow && calRow.predicted_wr != null && calRow.actual_wr != null) {
      const error = calRow.predicted_wr - calRow.actual_wr;
      if (error >= 0.15) {
        score += 5;
        contributions.calibration = 5;
        rationale.push(`cal_error=${(error*100).toFixed(0)}pp_high_conf(+5)`);
      }
    }
  } catch (_) {}

  // ── 5. Strong positive correlations from Phase 3 (reduce score) ────────────
  try {
    const corRows = db.prepare(`
      SELECT wr_delta FROM feature_correlations
      WHERE strategy_name = ? AND significance = 'STRONG' AND wr_delta > 0
        AND computed_at >= datetime('now', '-7 days')
      ORDER BY wr_delta DESC LIMIT 2
    `).all(strategyName);

    const reduction = Math.min(corRows.length * 3, 6);
    if (reduction > 0) {
      score = Math.max(0, score - reduction);
      contributions.correlation = -reduction;
      rationale.push(`strong_pos_correlations(−${reduction})`);
    }
  } catch (_) {}

  return {
    score,
    gate_status:         gateStatus(score),
    conf_adjustment:     CONF_ADJUSTMENT[gateStatus(score)],
    edge_contribution:   contributions.edge,
    health_contribution: contributions.health,
    calibration_factor:  contributions.calibration > 0 ? 1.05 : 1.0,
    active_vetoes:       contributions.vetoes / 3,
    rationale,
  };
}

/** Read current adaptive overrides from strategy_params. */
function loadOverrides(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE key = 'ADAPTIVE_OVERRIDES'"
    ).get();
    return row?.params_json ? JSON.parse(row.params_json) : {};
  } catch (_) { return {}; }
}

/** Write merged overrides back to strategy_params. */
function saveOverrides(db, overrides) {
  db.prepare(`
    INSERT INTO strategy_params (key, params_json, updated_at)
    VALUES ('ADAPTIVE_OVERRIDES', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET params_json = excluded.params_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(overrides));
}

function applyGateToOverrides(db, strategyName, gateStatus, prevGateStatus) {
  const overrides = loadOverrides(db);
  if (!overrides[strategyName]) {
    overrides[strategyName] = {
      paused: false, blockLong: false, blockShort: false, blockedSessions: [], reasons: [],
    };
  }
  const ov = overrides[strategyName];
  if (!ov.reasons) ov.reasons = [];

  if (gateStatus === 'GATED') {
    if (!ov.manualPause) {
      ov.paused = true;
      if (!ov.reasons.some(r => r.startsWith('intelligence-gate'))) {
        ov.reasons.push('intelligence-gate: GATED by edge health / strategy health analysis');
      }
    }
  } else {
    // Lift intelligence-driven pause on recovery — unless WR-based pause is also active
    ov.reasons = ov.reasons.filter(r => !r.startsWith('intelligence-gate'));
    if (!ov.manualPause && !ov.reasons.some(r => r.startsWith('auto-paused'))) {
      ov.paused = false;
    }
  }

  saveOverrides(db, overrides);
}

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  const insertGate = db.prepare(`
    INSERT INTO signal_gates
      (strategy_name, gate_status, adjusted_min_conf, base_min_conf, conf_adjustment,
       edge_contribution, health_contribution, calibration_factor,
       active_vetoes, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const BASE_MIN_CONF = 60;
  let processed = 0;
  let statusChanges = 0;

  for (const strategy of STRATEGIES) {
    try {
      const gate = computeGate(db, strategy);
      const { score, gate_status, conf_adjustment, edge_contribution,
              health_contribution, calibration_factor, active_vetoes, rationale } = gate;

      const adjustedConf = BASE_MIN_CONF + conf_adjustment;

      insertGate.run(
        strategy, gate_status, adjustedConf, BASE_MIN_CONF, conf_adjustment,
        edge_contribution, health_contribution, calibration_factor,
        active_vetoes, JSON.stringify(rationale),
      );

      // Retrieve previous gate status for change detection
      const prevRow = db.prepare(`
        SELECT gate_status FROM signal_gates
        WHERE strategy_name = ?
          AND evaluated_at < (SELECT MAX(g2.evaluated_at) FROM signal_gates g2 WHERE g2.strategy_name = ?)
        ORDER BY evaluated_at DESC LIMIT 1
      `).get(strategy, strategy);
      const prevStatus = prevRow?.gate_status ?? 'OPEN';

      // Inject into adaptive overrides (this is how the scanner picks it up)
      applyGateToOverrides(db, strategy, gate_status, prevStatus);

      console.log(
        `[${WORKER_NAME}] ${strategy}: score=${score} status=${gate_status} ` +
        `adj=${conf_adjustment > 0 ? '+' : ''}${conf_adjustment}` +
        (rationale.length ? ` | ${rationale.join(', ')}` : ' | clean')
      );
      processed++;

      // ntfy on status changes that matter
      if (gate_status !== prevStatus) {
        statusChanges++;
        const worsened = ['OPEN','CAUTIOUS','RESTRICTED','GATED'].indexOf(gate_status) >
                         ['OPEN','CAUTIOUS','RESTRICTED','GATED'].indexOf(prevStatus);
        const emoji = gate_status === 'GATED' ? '🔴' : gate_status === 'RESTRICTED' ? '🟠' :
                      gate_status === 'CAUTIOUS' ? '🟡' : '🟢';
        await sendNtfy(
          `${emoji} Signal Gate ${worsened ? 'tightened' : 'eased'} — ${strategy}`,
          `${strategy}: ${prevStatus} → ${gate_status}\n` +
          `Score: ${score} | Conf adjustment: +${conf_adjustment}pts\n` +
          (rationale.length ? `Triggers: ${rationale.join(', ')}` : 'No active triggers'),
          gate_status === 'GATED' ? 'high' : 'default',
        );
      }
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error processing ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed, statusChanges,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies evaluated, ${statusChanges} status change(s)`);
  db.close();
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
