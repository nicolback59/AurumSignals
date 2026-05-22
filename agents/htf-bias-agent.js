'use strict';

/**
 * HTF BIAS AGENT
 *
 * Validates higher-timeframe directional alignment.
 * Critical for MNQ Intraday — counter-HTF trades lose disproportionately.
 *
 * For MGC Scalp, less critical (scalp within the session range) but
 * still penalises strong counter-trend setups.
 *
 * ctx fields used:
 *   htfBiases   — [{ bias: 1|-1|0, present: boolean }]  (from quant context)
 *   direction   — 'LONG' | 'SHORT'
 *   strategy    — 'MGC_SCALP' | 'MNQ_INTRADAY'
 *   indicators.htfBias, htf2Bias, htf1hBias (raw bias numbers)
 */

const { agentResult } = require('./agent-framework');

function evaluate(ctx) {
  const dir      = (ctx.direction ?? 'LONG').toUpperCase();
  const strategy = ctx.strategy  ?? ctx.strategy_name ?? '';
  const expected = dir === 'LONG' ? 1 : -1;

  // Collect all available HTF biases
  const rawBiases = [];

  // From quant context (htfBiases array)
  if (Array.isArray(ctx.htfBiases)) {
    for (const h of ctx.htfBiases) {
      if (h.present) rawBiases.push(h.bias);
    }
  }

  // From signal.indicators direct fields
  const ind = ctx.indicators ?? {};
  if (ind.htfBias != null && !ctx.htfBiases)  rawBiases.push(ind.htfBias > 0 ? 1 : ind.htfBias < 0 ? -1 : 0);
  if (ind.htf2Bias != null)  rawBiases.push(ind.htf2Bias > 0 ? 1 : ind.htf2Bias < 0 ? -1 : 0);
  if (ind.htf1hBias != null) rawBiases.push(ind.htf1hBias > 0 ? 1 : ind.htf1hBias < 0 ? -1 : 0);

  if (rawBiases.length === 0) {
    // No HTF data available — neutral for scalp, soft fail for intraday
    if (strategy === 'MNQ_INTRADAY') {
      return agentResult({ score: 30, bias: 'neutral', approved: false,
        reason: 'no HTF bias data — MNQ_INTRADAY requires HTF confirmation',
        warnings: ['missing_htf_data'] });
    }
    return agentResult({ score: 55, bias: 'neutral', reason: 'no HTF data — neutral', approved: true });
  }

  const aligned    = rawBiases.filter(b => b === expected).length;
  const conflicted = rawBiases.filter(b => b === -expected).length;
  const neutral    = rawBiases.filter(b => b === 0).length;
  const total      = rawBiases.length;
  const ratio      = aligned / total;

  const warnings = [];
  let score = 0;
  let bias  = 'neutral';

  if (ratio >= 1.0) {
    score = 92;
    bias  = dir === 'LONG' ? 'bullish' : 'bearish';
  } else if (ratio >= 0.67) {
    score = 75;
    bias  = dir === 'LONG' ? 'bullish' : 'bearish';
  } else if (ratio >= 0.5) {
    score = 58;
    bias  = 'neutral';
  } else if (ratio >= 0.33) {
    score = 35;
    warnings.push('htf_mixed');
  } else {
    score = 10;
    warnings.push('htf_counter_trend');
    bias = dir === 'LONG' ? 'bearish' : 'bullish';
  }

  // MNQ_INTRADAY is stricter — needs majority alignment
  if (strategy === 'MNQ_INTRADAY' && ratio < 0.5) {
    return agentResult({ score, bias, approved: false,
      reason: `HTF alignment ${aligned}/${total} — MNQ_INTRADAY needs majority`,
      warnings: [...warnings, 'mnq_htf_insufficient'] });
  }

  // Strong counter-trend — hard penalise even for scalp
  if (conflicted === total) {
    return agentResult({ score: 8, bias, approved: false,
      reason: `all ${total} HTF timeframes counter-trend — avoid`,
      warnings: ['all_htf_counter_trend'] });
  }

  return agentResult({
    score,
    bias,
    reason: `aligned=${aligned}/${total} conflicted=${conflicted}/${total} neutral=${neutral}/${total} dir=${dir}`,
    warnings,
    approved: score >= 50,
  });
}

module.exports = { evaluate, name: 'HtfBiasAgent' };
