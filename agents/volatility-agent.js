'use strict';

/**
 * VOLATILITY AGENT
 *
 * Checks whether current volatility is suitable for the setup.
 * Too low: stops get clipped by noise, targets never reached.
 * Too high: stops must be huge, RR collapses, random spikes kill trades.
 *
 * Also validates stop size against current ATR.
 *
 * ctx fields used:
 *   volRegime  — 'NORMAL' | 'HIGH' | 'LOW'
 *   atrRatio   — current ATR / baseline ATR
 *   atr        — raw ATR value
 *   sl         — stop loss distance in points
 *   entry      — entry price
 *   strategy   — 'MGC_SCALP' | 'MNQ_INTRADAY'
 */

const { agentResult } = require('./agent-framework');

// Min/max ATR ratios per strategy (tuned for CME micros)
const ATR_BOUNDS = {
  MGC_SCALP:    { minRatio: 0.7, maxRatio: 2.2 },
  MNQ_INTRADAY: { minRatio: 0.8, maxRatio: 2.5 },
  DEFAULT:      { minRatio: 0.7, maxRatio: 2.5 },
};

function evaluate(ctx) {
  const volRegime = (ctx.volRegime ?? 'NORMAL').toUpperCase();
  const atrRatio  = ctx.atrRatio  ?? 1;
  const strategy  = ctx.strategy  ?? ctx.strategy_name ?? 'DEFAULT';
  const atr       = ctx.atr       ?? ctx.indicators?.atr;
  const sl        = ctx.sl;
  const entry     = ctx.entry;

  const bounds  = ATR_BOUNDS[strategy] ?? ATR_BOUNDS.DEFAULT;
  const warnings = [];
  let score = 60;

  // ── Volatility regime ──────────────────────────────────────────────────────
  if (volRegime === 'NORMAL') {
    score = 75;
  } else if (volRegime === 'HIGH') {
    if (atrRatio > bounds.maxRatio) {
      score = 15;
      warnings.push('volatility_too_high');
      return agentResult({ score, bias: 'neutral', approved: false,
        reason: `ATR ratio ${atrRatio.toFixed(2)} exceeds max ${bounds.maxRatio} — stops will be too wide`,
        warnings });
    }
    score = atrRatio < 1.8 ? 60 : 35;
    if (atrRatio >= 1.8) warnings.push('elevated_volatility');
  } else if (volRegime === 'LOW') {
    if (atrRatio < bounds.minRatio) {
      score = 20;
      warnings.push('volatility_too_low');
      return agentResult({ score, bias: 'neutral', approved: false,
        reason: `ATR ratio ${atrRatio.toFixed(2)} below min ${bounds.minRatio} — targets unlikely to be reached`,
        warnings });
    }
    score = 40;
    warnings.push('low_volatility');
  }

  // ── Stop size validation ───────────────────────────────────────────────────
  if (sl != null && entry != null && atr != null && atr > 0) {
    const slAtr = Math.abs(entry - sl) / atr;
    if (slAtr < 0.3) {
      score = Math.max(0, score - 20);
      warnings.push('stop_too_tight');
    } else if (slAtr > 4.0) {
      score = Math.max(0, score - 25);
      warnings.push('stop_too_wide');
    }
  }

  return agentResult({
    score,
    bias: 'neutral',
    reason: `volRegime=${volRegime} atrRatio=${atrRatio.toFixed(2)} strategy=${strategy}`,
    warnings,
    approved: score >= 50,
  });
}

module.exports = { evaluate, name: 'VolatilityAgent' };
