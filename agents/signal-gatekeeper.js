'use strict';

/**
 * SIGNAL GATEKEEPER
 *
 * The final approval pipeline before a live alert fires.
 * Runs all specialist agents, applies strategy-specific consensus rules,
 * and returns a structured verdict with full audit trail.
 *
 * 10-step pipeline:
 *   1. Data quality
 *   2. Strategy enabled (live_gated check)
 *   3. Market hours
 *   4. Risk validation (RiskAgent — critical)
 *   5. Regime suitability (RegimeAgent — critical)
 *   6. Volatility check (VolatilityAgent — critical)
 *   7. HTF alignment (HtfBiasAgent — critical for MNQ_INTRADAY)
 *   8. Specialist consensus (VWAP + Liquidity + Momentum + Session)
 *   9. Loss cluster check (adaptive suppression)
 *  10. Final score + verdict
 *
 * Returns:
 *   { verdict: 'LIVE'|'RESEARCH'|'REJECT', score, agentScores, failedGates,
 *     gateLog, liveGated: boolean }
 */

const { runAgent, computeConsensus, APPROVAL_RULES } = require('./agent-framework');
const regimeAgent    = require('./regime-agent');
const vwapAgent      = require('./vwap-agent');
const liquidityAgent = require('./liquidity-agent');
const momentumAgent  = require('./momentum-agent');
const volatilityAgent = require('./volatility-agent');
const sessionAgent   = require('./session-agent');
const htfBiasAgent   = require('./htf-bias-agent');
const riskAgent      = require('./risk-agent');

const ALL_AGENTS = [
  regimeAgent,
  vwapAgent,
  liquidityAgent,
  momentumAgent,
  volatilityAgent,
  sessionAgent,
  htfBiasAgent,
  riskAgent,
];

// Minimum consensus score per strategy for a LIVE verdict
const LIVE_SCORE_MIN = {
  MGC_SCALP:    55,
  MNQ_INTRADAY: 58,
  DEFAULT:      55,
};

/**
 * Build the agent context from the signal + scan context.
 * Maps signal fields into the shape each agent expects.
 */
function buildAgentCtx(sig, scanCtx = {}) {
  const ind = sig.indicators ?? {};
  return {
    // Identity
    direction:    sig.direction,
    strategy:     sig.strategy_name,
    strategy_name: sig.strategy_name,

    // Price levels
    entry:   sig.entry,
    sl:      sig.sl,
    tp1:     sig.tp1,
    tp2:     sig.tp2,
    rr:      sig.rr,

    // Market state
    regime:    scanCtx.regime    ?? ind.regime    ?? 'NORMAL',
    volRegime: scanCtx.volRegime ?? ind.volRegime ?? 'NORMAL',
    atrRatio:  scanCtx.atrRatio  ?? (ind.atr && ind.atrMin ? ind.atr / ind.atrMin : 1),
    atr:       ind.atr   ?? scanCtx.atr,
    close:     ind.close ?? sig.entry,
    vwap:      ind.vwap  ?? scanCtx.vwap,

    // Session
    sess:    scanCtx.sess    ?? { quality: ind.sessionQuality ?? 0.6, name: sig.session ?? '' },
    session: sig.session     ?? ind.session ?? '',

    // HTF
    htfBiases: scanCtx.htfBiases ?? [
      { bias: ind.htfBias  ?? 0, present: ind.htfBias  != null },
      { bias: ind.htf2Bias ?? 0, present: ind.htf2Bias != null },
      { bias: ind.htf1hBias ?? 0, present: ind.htf1hBias != null },
    ],
    indicators: ind,

    // Bars + momentum
    bars5m:   scanCtx.bars5m   ?? [],
    rsi:      scanCtx.rsi      ?? ind.rsi      ?? null,
    hist:     scanCtx.hist     ?? null,
    histPrev: scanCtx.histPrev ?? null,
  };
}

/**
 * Run the full gatekeeper pipeline.
 *
 * @param {object} sig       - signal object (strategy_name, direction, entry, sl, tp1, confidence, indicators, …)
 * @param {object} scanCtx   - scan context (regime, volRegime, atrRatio, sess, htfBiases, bars5m, rsi, hist, histPrev)
 * @param {object} [db]      - SQLite db for loss cluster check (optional)
 * @returns {{
 *   verdict:    'LIVE'|'RESEARCH'|'REJECT',
 *   liveGated:  boolean,
 *   score:      number,
 *   agentScores: object,
 *   failedGates: string[],
 *   gateLog:    string[],
 *   warnings:   string[],
 * }}
 */
function evaluate(sig, scanCtx = {}, db = null) {
  const strategy = sig.strategy_name ?? 'DEFAULT';
  const gateLog  = [];
  const allWarnings = [];

  // ── Step 1: Data quality ────────────────────────────────────────────────────
  if (!sig.entry || !sig.sl || !sig.tp1) {
    gateLog.push('GATE_FAIL:data_quality missing entry/sl/tp1');
    return { verdict: 'REJECT', liveGated: false, score: 0, agentScores: {}, failedGates: ['data_quality'], gateLog, warnings: ['missing_levels'] };
  }
  if (sig.confidence == null || sig.confidence < 0) {
    gateLog.push('GATE_FAIL:data_quality invalid confidence');
    return { verdict: 'REJECT', liveGated: false, score: 0, agentScores: {}, failedGates: ['data_quality'], gateLog, warnings: ['invalid_confidence'] };
  }
  gateLog.push('GATE_PASS:data_quality');

  // ── Step 2: Loss cluster check (adaptive suppression) ───────────────────────
  // If 3+ same-category losses in last 10 trades, downgrade to RESEARCH
  let clusterPenalty = 0;
  if (db) {
    try {
      const recentLosses = db.prepare(`
        SELECT lf.failure_category, COUNT(*) as cnt
        FROM   loss_forensics lf
        JOIN   signals s ON s.id = lf.signal_id
        WHERE  s.strategy_name = ?
          AND  lf.created_at >= datetime('now', '-7 days')
        GROUP BY lf.failure_category
        HAVING cnt >= 3
        ORDER BY cnt DESC
        LIMIT 3
      `).all(strategy);

      if (recentLosses.length > 0) {
        clusterPenalty = Math.min(30, recentLosses.length * 8);
        gateLog.push(`GATE_WARN:loss_cluster penalty=${clusterPenalty} clusters=[${recentLosses.map(r => `${r.failure_category}×${r.cnt}`).join(',')}]`);
        allWarnings.push('recent_loss_cluster');
      } else {
        gateLog.push('GATE_PASS:loss_cluster no clusters');
      }
    } catch { /* never crash scanner */ }
  }

  // ── Steps 3–8: Run all agents ───────────────────────────────────────────────
  const ctx     = buildAgentCtx(sig, scanCtx);
  const results = ALL_AGENTS.map(agent => runAgent(agent.name, agent.evaluate, ctx));

  for (const r of results) {
    gateLog.push(`AGENT:${r.agent} score=${r.score} approved=${r.approved}${r.warnings.length ? ` warn=[${r.warnings.join(',')}]` : ''}`);
    allWarnings.push(...r.warnings);
  }

  // ── Step 9: Consensus check ─────────────────────────────────────────────────
  const rules    = APPROVAL_RULES[strategy] ?? APPROVAL_RULES['MGC_SCALP'];
  const consensus = computeConsensus(results, rules);
  gateLog.push(consensus.summary);

  // ── Step 10: Final score + verdict ──────────────────────────────────────────
  const finalScore = Math.max(0, consensus.finalScore - clusterPenalty);
  const liveMin    = LIVE_SCORE_MIN[strategy] ?? LIVE_SCORE_MIN.DEFAULT;

  let verdict;
  if (!consensus.approved) {
    // Check if any CRITICAL agent failed
    const criticalFailed = results.filter(r =>
      !r.approved && ['RiskAgent', 'RegimeAgent', 'VolatilityAgent'].includes(r.agent)
    );
    verdict = criticalFailed.length > 0 ? 'REJECT' : 'RESEARCH';
  } else if (finalScore >= liveMin) {
    verdict = 'LIVE';
  } else {
    verdict = 'RESEARCH';
  }

  gateLog.push(`VERDICT:${verdict} finalScore=${finalScore} liveMin=${liveMin}`);

  return {
    verdict,
    liveGated:   verdict !== 'LIVE',
    score:       finalScore,
    agentScores: consensus.agentScores,
    failedGates: consensus.failedGates,
    gateLog,
    warnings:    [...new Set(allWarnings)],
  };
}

/**
 * Persist agent scores to DB for audit trail (fire-and-forget).
 */
function persistAgentScores(db, signalId, agentScores) {
  if (!db || !signalId) return;
  try {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO agent_scores
        (signal_id, agent_name, score, bias, approved, reason, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    db.transaction(() => {
      for (const [name, s] of Object.entries(agentScores)) {
        ins.run(signalId, name, s.score ?? null, s.bias ?? null, s.approved ? 1 : 0, s.reason ?? null);
      }
    })();
  } catch { /* never crash scanner */ }
}

module.exports = { evaluate, buildAgentCtx, persistAgentScores };
