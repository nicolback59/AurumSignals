'use strict';

/**
 * REGIME AGENT
 *
 * Classifies the current market regime using ATR structure, price action,
 * and the existing getMarketRegime() + OVERNIGHT session awareness.
 *
 * Scores 0–100. High score = regime favourable for the signal direction.
 * Rejects RANGE_CHOP and SOFT_CHOP outright for both strategies.
 *
 * ctx fields used:
 *   regime         — 'TREND_BULL'|'TREND_BEAR'|'EXPANSION'|'NORMAL'|
 *                    'COMPRESSION'|'SOFT_CHOP'|'RANGE_CHOP'
 *   direction      — 'LONG' | 'SHORT'
 *   volRegime      — 'NORMAL' | 'HIGH' | 'LOW'
 *   atrRatio       — current ATR / baseline ATR
 */

const { agentResult } = require('./agent-framework');

function evaluate(ctx) {
  const regime    = (ctx.regime    ?? 'NORMAL').toUpperCase();
  const dir       = (ctx.direction ?? 'LONG').toUpperCase();
  const volRegime = (ctx.volRegime ?? 'NORMAL').toUpperCase();
  const atrRatio  = ctx.atrRatio  ?? 1;

  // Hard reject — chop regimes have no edge
  if (regime === 'RANGE_CHOP') {
    return agentResult({ score: 0, bias: 'neutral', approved: false,
      reason: 'RANGE_CHOP regime — no directional edge', warnings: ['chop_regime'] });
  }
  if (regime === 'SOFT_CHOP') {
    return agentResult({ score: 10, bias: 'neutral', approved: false,
      reason: 'SOFT_CHOP regime — low probability setups', warnings: ['soft_chop'] });
  }

  // Score by regime quality
  let score = 0;
  let bias  = 'neutral';

  if (regime === 'TREND_BULL') {
    bias  = dir === 'LONG' ? 'bullish' : 'bearish';
    score = dir === 'LONG' ? 90 : 30; // counter-trend is high risk
  } else if (regime === 'TREND_BEAR') {
    bias  = dir === 'SHORT' ? 'bearish' : 'bullish';
    score = dir === 'SHORT' ? 90 : 30;
  } else if (regime === 'EXPANSION') {
    score = 72;
    bias  = 'neutral'; // expansion can go either way
  } else if (regime === 'NORMAL') {
    score = 60;
    bias  = 'neutral';
  } else if (regime === 'COMPRESSION') {
    // Compression before breakout can be good — but uncertain
    score = 45;
    bias  = 'neutral';
    return agentResult({ score, bias, approved: false,
      reason: 'COMPRESSION — wait for breakout confirmation', warnings: ['compression'] });
  }

  // Volatility adjustment
  const warnings = [];
  if (volRegime === 'HIGH' && atrRatio > 2.0) {
    score = Math.max(0, score - 15);
    warnings.push('high_volatility');
  }
  if (volRegime === 'LOW') {
    score = Math.max(0, score - 10);
    warnings.push('low_volatility');
  }

  return agentResult({
    score,
    bias,
    reason: `regime=${regime} vol=${volRegime} atrRatio=${atrRatio.toFixed(2)} dir=${dir}`,
    warnings,
  });
}

module.exports = { evaluate, name: 'RegimeAgent' };
