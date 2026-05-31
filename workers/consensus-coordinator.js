'use strict';

/**
 * CONSENSUS COORDINATOR
 *
 * The intelligence engine's decision layer. Reads pending agent_messages,
 * computes a trust-weighted consensus score per strategy, and writes
 * actionable recommendations to intervention_log when multiple independent
 * agents converge on the same finding.
 *
 * Flow:
 *   1. Consume pending agent_messages (observations → context; recommendations/
 *      votes → weighted score; vetoes → hard blocks)
 *   2. For each strategy: cluster messages by theme, compute consensus score
 *   3. If score ≥ CONSENSUS_THRESHOLD and ≥ MIN_AGREEING_AGENTS → write to
 *      intervention_log with eval_status = 'pending' (human reviews before apply)
 *   4. Evaluate past interventions: if 14+ days old and still 'pending' → compute
 *      wr_before/after and mark 'evaluated'; update agent trust scores accordingly
 *   5. Mark all processed messages as 'consumed'
 *
 * PM2 cron: 0 *\/4 * * * (every 4 hours)
 * autorestart: false — runs once, exits.
 *
 * Trust weights (agent_trust_scores.trust_weight):
 *   Range: 0.5 – 2.0   Default: 1.0
 *   Bump:  +0.05 per correct recommendation call
 *   Penalize: -0.10 per incorrect call
 *   Correct = wr improved ≥ 3pp when action taken; incorrect = worsened ≥ 3pp
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME          = 'consensus-coordinator';
const CONSENSUS_THRESHOLD  = 1.5;   // weighted vote score to trigger recommendation
const MIN_AGREEING_AGENTS  = 2;     // at least 2 distinct agents must agree
const EVAL_AFTER_DAYS      = 14;    // evaluate interventions after this many days
const WR_IMPROVEMENT_MIN   = 0.03;  // +3pp = correct call
const WR_WORSENING_MIN     = 0.03;  // -3pp = incorrect call
const TRUST_BUMP           = 0.05;
const TRUST_PENALTY        = 0.10;
const TRUST_MIN            = 0.5;
const TRUST_MAX            = 2.0;

// Message type → vote weight multipliers
const MSG_WEIGHTS = {
  observation:    0.0,  // informational only
  recommendation: 1.0,  // soft positive vote
  vote:           2.0,  // hard positive vote
  veto:          -5.0,  // hard block — one veto can neutralize many recommendations
};

// ── Load agent trust scores ────────────────────────────────────────────────────
function loadTrustScores(db) {
  const rows = db.prepare('SELECT agent_name, trust_weight FROM agent_trust_scores').all();
  const map  = {};
  for (const r of rows) map[r.agent_name] = r.trust_weight ?? 1.0;
  return map;
}

// ── Extract theme key from message payload ─────────────────────────────────────
// Groups messages about the same finding so we can count agreeing agents.
function themeKey(msg) {
  try {
    const p = JSON.parse(msg.payload);
    // Loss forensics: systemic failure
    if (p.observation === 'systemic_failure_detected') {
      return `failure:${p.failure_category}`;
    }
    // Win forensics: dominant pattern
    if (p.observation === 'dominant_win_pattern_detected') {
      return `win_pattern:${p.win_category}`;
    }
    // Feature intelligence: correlation finding
    if (p.observation === 'feature_correlation') {
      const sign = p.wr_delta > 0 ? 'positive' : 'negative';
      return `feature:${p.feature_key}:${p.feature_value}:${sign}`;
    }
    // Generic: use from_agent + msg_type
    return `${msg.from_agent}:${msg.msg_type}`;
  } catch {
    return `${msg.from_agent}:${msg.msg_type}`;
  }
}

// ── Build human-readable recommendation text ───────────────────────────────────
function buildRecommendation(strategy, theme, messages) {
  const sources = [...new Set(messages.map(m => m.from_agent))].join(', ');
  const [type, ...parts] = theme.split(':');

  if (type === 'failure') {
    const cat = parts[0];
    const payloads = messages.map(m => { try { return JSON.parse(m.payload); } catch { return {}; } });
    const maxPct = Math.max(...payloads.map(p => p.pct_of_losses ?? 0));
    return `Systemic failure detected in ${strategy}: '${cat}' accounts for ${(maxPct*100).toFixed(0)}% of losses. Sources: ${sources}. Suggested: tighten entry filter for ${cat} conditions.`;
  }

  if (type === 'win_pattern') {
    const cat = parts[0];
    const payloads = messages.map(m => { try { return JSON.parse(m.payload); } catch { return {}; } });
    const maxPct = Math.max(...payloads.map(p => p.pct_of_wins ?? 0));
    return `Dominant win pattern in ${strategy}: '${cat}' accounts for ${(maxPct*100).toFixed(0)}% of wins. Sources: ${sources}. Suggested: increase confidence weight for ${cat} archetype.`;
  }

  if (type === 'feature') {
    const [key, value, sign] = parts;
    const payloads = messages.map(m => { try { return JSON.parse(m.payload); } catch { return {}; } });
    const best = payloads.reduce((a, b) => Math.abs(b.wr_delta ?? 0) > Math.abs(a.wr_delta ?? 0) ? b : a, {});
    const pct  = best.wr_delta != null ? `${best.wr_delta > 0 ? '+' : ''}${(best.wr_delta*100).toFixed(1)}pp vs baseline` : '';
    const action = sign === 'positive'
      ? `lean into ${key}=${value} (${pct})`
      : `penalize or filter ${key}=${value} (${pct})`;
    return `Feature edge in ${strategy}: ${action}, N=${best.sample_size ?? '?'}. Sources: ${sources}.`;
  }

  return `Consensus signal for ${strategy} from [${sources}]: ${theme}.`;
}

// ── Step 1: consume pending messages and compute per-strategy consensus ────────
function processPendingMessages(db, trustScores) {
  const messages = db.prepare(`
    SELECT id, from_agent, to_agent, msg_type, strategy, payload, priority, created_at
    FROM agent_messages
    WHERE status = 'pending'
      AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at ASC
  `).all();

  if (!messages.length) return { byStrategy: {}, processedIds: [] };

  // Group by strategy → theme
  const byStrategy = {};
  for (const msg of messages) {
    const strat = msg.strategy ?? 'UNKNOWN';
    if (!byStrategy[strat]) byStrategy[strat] = {};

    const theme = themeKey(msg);
    if (!byStrategy[strat][theme]) byStrategy[strat][theme] = [];
    byStrategy[strat][theme].push(msg);
  }

  return { byStrategy, processedIds: messages.map(m => m.id) };
}

// ── Step 2: compute consensus score per theme ──────────────────────────────────
function computeConsensus(themeMessages, trustScores) {
  let score         = 0;
  const agentsFor   = new Set();
  const agentsAgainst = new Set();
  let hasVeto       = false;

  for (const msg of themeMessages) {
    const weight    = trustScores[msg.from_agent] ?? 1.0;
    const typeScore = MSG_WEIGHTS[msg.msg_type] ?? 0;

    if (typeScore < 0) {
      hasVeto = true;
      agentsAgainst.add(msg.from_agent);
    } else if (typeScore > 0) {
      agentsFor.add(msg.from_agent);
    }

    score += typeScore * weight;
  }

  return { score, agentsFor, agentsAgainst, hasVeto };
}

// ── Step 3: get baseline WR for a strategy (last 30d) ─────────────────────────
function getBaselineWr(db, strategy, days = 30) {
  try {
    const row = db.prepare(`
      SELECT
        CAST(SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(COUNT(*), 0) AS wr
      FROM outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE s.strategy_name = ?
        AND o.result IN ('WIN', 'LOSS', 'BE')
        AND o.exit_at >= datetime('now', ? || ' days')
    `).get(strategy, `-${days}`);
    return row?.wr ?? null;
  } catch { return null; }
}

// ── Step 4: evaluate past interventions (14d lookback) ─────────────────────────
function evaluatePastInterventions(db, trustScores) {
  const due = db.prepare(`
    SELECT id, strategy_name, agent_source, applied_at, wr_before
    FROM intervention_log
    WHERE eval_status = 'pending'
      AND applied_at <= datetime('now', '-${EVAL_AFTER_DAYS} days')
    LIMIT 20
  `).all();

  for (const inv of due) {
    try {
      const wrAfter = getBaselineWr(db, inv.strategy_name, 14);
      if (wrAfter == null || inv.wr_before == null) {
        db.prepare(`UPDATE intervention_log SET eval_status = 'insufficient_data' WHERE id = ?`).run(inv.id);
        continue;
      }

      const delta    = wrAfter - inv.wr_before;
      let netEffect  = delta;
      const evalStatus = 'evaluated';

      db.prepare(`
        UPDATE intervention_log
        SET wr_after = ?, wr_delta = ?, net_effect = ?, eval_at = datetime('now'), eval_status = ?
        WHERE id = ?
      `).run(+wrAfter.toFixed(4), +delta.toFixed(4), +netEffect.toFixed(4), evalStatus, inv.id);

      // Update trust score for the agent that triggered this intervention
      if (inv.agent_source) {
        const current = trustScores[inv.agent_source] ?? 1.0;
        let updated;
        if (delta >= WR_IMPROVEMENT_MIN) {
          updated = Math.min(TRUST_MAX, current + TRUST_BUMP);
          console.log(`[${WORKER_NAME}] Trust +${TRUST_BUMP} for ${inv.agent_source} (correct, delta=${(delta*100).toFixed(1)}pp)`);
        } else if (delta <= -WR_WORSENING_MIN) {
          updated = Math.max(TRUST_MIN, current - TRUST_PENALTY);
          console.log(`[${WORKER_NAME}] Trust -${TRUST_PENALTY} for ${inv.agent_source} (incorrect, delta=${(delta*100).toFixed(1)}pp)`);
        } else {
          continue; // inconclusive — no trust change
        }

        trustScores[inv.agent_source] = updated;
        db.prepare(`
          UPDATE agent_trust_scores
          SET trust_weight       = ?,
              correct_calls      = correct_calls   + ?,
              incorrect_calls    = incorrect_calls + ?
          WHERE agent_name = ?
        `).run(
          +updated.toFixed(4),
          delta >= WR_IMPROVEMENT_MIN ? 1 : 0,
          delta <= -WR_WORSENING_MIN  ? 1 : 0,
          inv.agent_source,
        );
      }
    } catch (err) {
      console.error(`[${WORKER_NAME}] Intervention eval error: ${err.message}`);
    }
  }
}

// ── Step 5: mark messages consumed ────────────────────────────────────────────
function markConsumed(db, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE agent_messages
    SET status = 'consumed', consumed_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(...ids);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'running', { startedAt: new Date().toISOString() });

  const trustScores = loadTrustScores(db);

  // Step 1 — consume pending messages
  const { byStrategy, processedIds } = processPendingMessages(db, trustScores);

  let interventionsCreated = 0;

  // Step 2 — compute consensus per strategy per theme
  for (const [strategy, themes] of Object.entries(byStrategy)) {
    const wrBefore = getBaselineWr(db, strategy, 30);

    for (const [theme, messages] of Object.entries(themes)) {
      const { score, agentsFor, agentsAgainst, hasVeto } = computeConsensus(messages, trustScores);

      // Skip if vetoed or not enough agreement
      if (hasVeto || score < CONSENSUS_THRESHOLD || agentsFor.size < MIN_AGREEING_AGENTS) continue;

      const description = buildRecommendation(strategy, theme, messages);
      const agentSources = [...agentsFor].join(',');

      // Check for duplicate (same strategy + similar theme in last 7d)
      const existing = db.prepare(`
        SELECT id FROM intervention_log
        WHERE strategy_name = ?
          AND description LIKE ?
          AND applied_at >= datetime('now', '-7 days')
        LIMIT 1
      `).get(strategy, `%${theme.split(':').slice(0,2).join(':')}%`);

      if (existing) continue; // don't duplicate

      db.prepare(`
        INSERT INTO intervention_log
          (strategy_name, agent_source, description, wr_before, eval_status)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(strategy, agentSources, description, wrBefore != null ? +wrBefore.toFixed(4) : null);

      interventionsCreated++;
      console.log(`[${WORKER_NAME}] Intervention logged for ${strategy}: ${theme} (score=${score.toFixed(2)}, agents=[${agentSources}])`);
    }
  }

  // Step 3 — evaluate past interventions + update trust scores
  evaluatePastInterventions(db, trustScores);

  // Step 4 — mark messages consumed
  markConsumed(db, processedIds);

  bumpCycle(db, WORKER_NAME);
  heartbeat(db, WORKER_NAME, 'idle', {
    completedAt:          new Date().toISOString(),
    messagesProcessed:    processedIds.length,
    interventionsCreated,
  });
  db.close();

  console.log(`[${WORKER_NAME}] Done — ${processedIds.length} msgs, ${interventionsCreated} interventions logged`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
