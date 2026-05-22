'use strict';

/**
 * AGENT FRAMEWORK
 *
 * Lightweight agent interface and consensus engine.
 * Each agent is a pure function: (ctx) → AgentResult
 * No async, no I/O — agents evaluate synchronously from the signal context
 * that the scanner already has in memory.
 *
 * AgentResult shape:
 *   { score, bias, confidence, reason, warnings, approved }
 *
 * The consensus engine decides whether a live alert fires based on
 * strategy-specific approval rules.
 */

// ── Agent result builder ──────────────────────────────────────────────────────

function agentResult({ score = 0, bias = 'neutral', confidence = null, reason = '', warnings = [], approved = null } = {}) {
  const s = Math.min(100, Math.max(0, Math.round(score)));
  return {
    score:      s,
    bias,                            // 'bullish' | 'bearish' | 'neutral'
    confidence: confidence ?? s,
    reason,
    warnings:   Array.isArray(warnings) ? warnings : [warnings].filter(Boolean),
    approved:   approved ?? s >= 50,
    timestamp:  Date.now(),
  };
}

// ── Safe agent runner — never crashes the scanner ────────────────────────────

function runAgent(name, fn, ctx) {
  try {
    const result = fn(ctx);
    return { agent: name, ...agentResult(result) };
  } catch (err) {
    return {
      agent:      name,
      score:      0,
      bias:       'neutral',
      confidence: 0,
      reason:     `AGENT_ERROR: ${err.message}`,
      warnings:   ['agent_error'],
      approved:   false,
      timestamp:  Date.now(),
    };
  }
}

// ── Consensus engine ──────────────────────────────────────────────────────────

/**
 * Evaluate a list of agent results against strategy-specific approval rules.
 *
 * rules: array of { agents: string[], required: number, critical?: boolean }
 *   - agents:   which agents must approve
 *   - required: how many of those agents must approve (use agents.length for ALL)
 *   - critical: if true and this rule fails → immediate REJECT regardless of score
 *
 * @returns {{
 *   approved:     boolean,
 *   finalScore:   number,
 *   failedGates:  string[],
 *   agentScores:  object,
 *   summary:      string,
 * }}
 */
function computeConsensus(agentResults, rules = []) {
  const byName = {};
  for (const r of agentResults) byName[r.agent] = r;

  const failedGates = [];
  let criticalFail  = false;

  for (const rule of rules) {
    const approvals = rule.agents.filter(n => byName[n]?.approved).length;
    if (approvals < rule.required) {
      const label = `${rule.agents.join('+')} (${approvals}/${rule.required})`;
      failedGates.push(label);
      if (rule.critical) criticalFail = true;
    }
  }

  // Weighted average of all agent scores
  const scores     = agentResults.map(r => r.score);
  const finalScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  const approved = !criticalFail && failedGates.length === 0;

  const agentScores = {};
  for (const r of agentResults) {
    agentScores[r.agent] = { score: r.score, bias: r.bias, approved: r.approved, reason: r.reason };
  }

  const summary = approved
    ? `CONSENSUS_PASS score=${finalScore} agents=${agentResults.length}`
    : `CONSENSUS_FAIL gates=[${failedGates.join(', ')}] score=${finalScore}`;

  return { approved, finalScore, failedGates, agentScores, summary };
}

// ── Strategy-specific approval rules ─────────────────────────────────────────

const APPROVAL_RULES = {
  MGC_SCALP: [
    { agents: ['RegimeAgent'],     required: 1, critical: true  },
    { agents: ['VolatilityAgent'], required: 1, critical: true  },
    { agents: ['RiskAgent'],       required: 1, critical: true  },
    { agents: ['VwapAgent', 'LiquidityAgent', 'MomentumAgent'], required: 2 },
    { agents: ['SessionAgent'],    required: 1 },
  ],
  MNQ_INTRADAY: [
    { agents: ['HtfBiasAgent'],    required: 1, critical: true  },
    { agents: ['RegimeAgent'],     required: 1, critical: true  },
    { agents: ['RiskAgent'],       required: 1, critical: true  },
    { agents: ['MomentumAgent', 'VwapAgent'], required: 1 },
    { agents: ['SessionAgent'],    required: 1 },
  ],
};

module.exports = { agentResult, runAgent, computeConsensus, APPROVAL_RULES };
