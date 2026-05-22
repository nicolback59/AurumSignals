'use strict';

/**
 * VWAP AGENT
 *
 * Evaluates VWAP relationship quality for the signal setup.
 *
 * Scores:
 *   LONG above VWAP by >0.5 ATR   → 80–90  (confirmed above, momentum)
 *   LONG reclaim from below        → 65–75  (reclaim — need confirmation)
 *   LONG below VWAP                → 10–30  (counter VWAP — penalise)
 *   SHORT below VWAP by >0.5 ATR  → 80–90
 *   SHORT rejection from above     → 65–75
 *   VWAP chop-through (price at)   → 30–40  (no clean side)
 *
 * ctx fields used:
 *   close     — current price
 *   vwap      — VWAP value
 *   atr       — current ATR
 *   direction — 'LONG' | 'SHORT'
 *   indicators.blwV1, abvV1 — existing VWAP position flags
 */

const { agentResult } = require('./agent-framework');

function evaluate(ctx) {
  const close = ctx.close ?? ctx.indicators?.close;
  const vwap  = ctx.vwap  ?? ctx.indicators?.vwap;
  const atr   = ctx.atr   ?? ctx.indicators?.atr ?? 1;
  const dir   = (ctx.direction ?? 'LONG').toUpperCase();

  if (close == null || vwap == null || vwap === 0) {
    // No VWAP available (e.g. overnight session) — neutral pass
    return agentResult({ score: 55, bias: 'neutral', reason: 'VWAP not available — neutral', approved: true });
  }

  const dist    = (close - vwap) / atr; // positive = above VWAP
  const absDist = Math.abs(dist);
  const warnings = [];
  let score = 0;
  let bias  = 'neutral';

  if (dir === 'LONG') {
    bias = dist > 0 ? 'bullish' : 'bearish';
    if (dist > 1.5)      { score = 85; /* strongly above — momentum confirmed */ }
    else if (dist > 0.5) { score = 78; }
    else if (dist > 0)   { score = 65; /* just above — watch for rejection */ }
    else if (dist > -0.3){ score = 45; warnings.push('price_at_vwap'); }  // chop zone
    else if (dist > -0.8){ score = 30; warnings.push('price_below_vwap'); }
    else                 { score = 12; warnings.push('far_below_vwap'); approved: false; }
  } else {
    bias = dist < 0 ? 'bearish' : 'bullish';
    if (dist < -1.5)      { score = 85; }
    else if (dist < -0.5) { score = 78; }
    else if (dist < 0)    { score = 65; }
    else if (dist < 0.3)  { score = 45; warnings.push('price_at_vwap'); }
    else if (dist < 0.8)  { score = 30; warnings.push('price_above_vwap'); }
    else                  { score = 12; warnings.push('far_above_vwap'); }
  }

  // Chop zone override — price within ±0.3 ATR of VWAP
  if (absDist < 0.3) {
    warnings.push('vwap_chop_zone');
    score = Math.min(score, 40);
  }

  return agentResult({
    score,
    bias,
    reason: `close=${close?.toFixed(2)} vwap=${vwap?.toFixed(2)} dist=${dist.toFixed(2)}ATR dir=${dir}`,
    warnings,
    approved: score >= 50,
  });
}

module.exports = { evaluate, name: 'VwapAgent' };
