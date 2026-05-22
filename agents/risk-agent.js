'use strict';

/**
 * RISK AGENT
 *
 * Validates risk parameters before a live alert.
 * Hard rules: entry, SL, TP1 must exist and make sense.
 * Soft rules: RR score, stop size quality.
 *
 * This is a CRITICAL gate — if it fails, no live signal regardless of other scores.
 *
 * ctx fields used:
 *   entry, sl, tp1, tp2 — price levels
 *   rr                  — risk/reward ratio
 *   direction           — 'LONG' | 'SHORT'
 *   strategy            — for per-strategy min RR
 *   atr                 — for stop size validation
 */

const { agentResult } = require('./agent-framework');

const MIN_RR = {
  MGC_SCALP:    1.3,
  MNQ_INTRADAY: 1.5,
  DEFAULT:      1.3,
};

function evaluate(ctx) {
  const entry    = ctx.entry    ?? null;
  const sl       = ctx.sl       ?? null;
  const tp1      = ctx.tp1      ?? null;
  const rr       = ctx.rr       ?? null;
  const dir      = (ctx.direction ?? 'LONG').toUpperCase();
  const strategy = ctx.strategy ?? ctx.strategy_name ?? 'DEFAULT';
  const atr      = ctx.atr      ?? ctx.indicators?.atr ?? null;
  const minRR    = MIN_RR[strategy] ?? MIN_RR.DEFAULT;

  const warnings = [];

  // ── Hard checks (critical gate) ───────────────────────────────────────────
  if (entry == null || sl == null || tp1 == null) {
    return agentResult({ score: 0, bias: 'neutral', approved: false,
      reason: `missing price levels: entry=${entry} sl=${sl} tp1=${tp1}`,
      warnings: ['missing_levels'] });
  }

  // Direction sanity
  if (dir === 'LONG' && sl >= entry) {
    return agentResult({ score: 0, bias: 'neutral', approved: false,
      reason: `LONG stop (${sl}) >= entry (${entry}) — invalid`,
      warnings: ['invalid_stop'] });
  }
  if (dir === 'SHORT' && sl <= entry) {
    return agentResult({ score: 0, bias: 'neutral', approved: false,
      reason: `SHORT stop (${sl}) <= entry (${entry}) — invalid`,
      warnings: ['invalid_stop'] });
  }
  if (dir === 'LONG' && tp1 <= entry) {
    return agentResult({ score: 0, bias: 'neutral', approved: false,
      reason: `LONG target (${tp1}) <= entry (${entry}) — invalid`,
      warnings: ['invalid_target'] });
  }
  if (dir === 'SHORT' && tp1 >= entry) {
    return agentResult({ score: 0, bias: 'neutral', approved: false,
      reason: `SHORT target (${tp1}) >= entry (${entry}) — invalid`,
      warnings: ['invalid_target'] });
  }

  // ── RR scoring ────────────────────────────────────────────────────────────
  const effectiveRR = rr ?? Math.abs(tp1 - entry) / Math.abs(entry - sl);

  if (effectiveRR < minRR) {
    return agentResult({ score: 15, bias: 'neutral', approved: false,
      reason: `RR ${effectiveRR.toFixed(2)} below minimum ${minRR} for ${strategy}`,
      warnings: ['rr_too_low'] });
  }

  let score = 50;
  if (effectiveRR >= 3.0)      score = 95;
  else if (effectiveRR >= 2.5) score = 85;
  else if (effectiveRR >= 2.0) score = 75;
  else if (effectiveRR >= 1.8) score = 65;
  else if (effectiveRR >= 1.5) score = 58;
  else                         score = 50;

  // ── Stop size vs ATR ──────────────────────────────────────────────────────
  if (atr != null && atr > 0) {
    const stopPts = Math.abs(entry - sl);
    const slAtr   = stopPts / atr;
    if (slAtr < 0.3) { score = Math.max(0, score - 15); warnings.push('stop_too_tight'); }
    if (slAtr > 3.5) { score = Math.max(0, score - 20); warnings.push('stop_too_wide'); }
  }

  return agentResult({
    score,
    bias: 'neutral',
    reason: `rr=${effectiveRR.toFixed(2)} minRR=${minRR} entry=${entry} sl=${sl} tp1=${tp1}`,
    warnings,
    approved: score >= 50,
  });
}

module.exports = { evaluate, name: 'RiskAgent' };
