'use strict';

/**
 * SESSION AGENT
 *
 * Scores whether the current trading session is favourable for each strategy.
 * MGC Scalp and MNQ Intraday have different optimal sessions.
 *
 * ctx fields used:
 *   session   — session name from market-clock (NY_OPEN, LONDON, etc.)
 *   sess      — { quality: 0–1, name: string }
 *   strategy  — 'MGC_SCALP' | 'MNQ_INTRADAY'
 */

const { agentResult } = require('./agent-framework');

// Per-strategy session quality overrides (0–100)
const SESSION_SCORES = {
  MGC_SCALP: {
    NY_OPEN:     95,  // best — high gold volume at US open
    POWER_HOUR:  85,
    LONDON:      80,  // good — European gold market active
    MIDDAY:      55,
    NY_PRE:      65,
    NY_CLOSE:    60,
    ASIAN:       35,  // low gold liquidity
    OVERNIGHT:   20,
  },
  MNQ_INTRADAY: {
    NY_OPEN:     95,  // best — opening drive, gap fills
    POWER_HOUR:  90,
    NY_PRE:      70,
    MIDDAY:      55,
    NY_CLOSE:    65,
    LONDON:      45,  // NQ less active during London hours
    ASIAN:       25,
    OVERNIGHT:   15,
  },
};

// Minimum session score to approve (below this = RESEARCH_ONLY)
const SESSION_LIVE_MIN = {
  MGC_SCALP:    40,
  MNQ_INTRADAY: 30,
};

function evaluate(ctx) {
  const strategy = ctx.strategy ?? ctx.strategy_name ?? '';
  const sessName = (ctx.sess?.name ?? ctx.session ?? ctx.indicators?.session ?? '').toUpperCase();
  const quality  = ctx.sess?.quality ?? ctx.indicators?.sessionQuality ?? 0.6;

  // Normalize session name to key (handle variants like 'NY OPEN', 'NY_OPEN_DRIVE')
  let key = sessName;
  if (sessName.includes('NY_OPEN') || sessName.includes('NY OPEN')) key = 'NY_OPEN';
  else if (sessName.includes('POWER')) key = 'POWER_HOUR';
  else if (sessName.includes('LONDON')) key = 'LONDON';
  else if (sessName.includes('MIDDAY')) key = 'MIDDAY';
  else if (sessName.includes('NY_PRE') || sessName.includes('PRE')) key = 'NY_PRE';
  else if (sessName.includes('NY_CLOSE') || sessName.includes('CLOSE')) key = 'NY_CLOSE';
  else if (sessName.includes('ASIAN')) key = 'ASIAN';
  else if (sessName.includes('OVERNIGHT')) key = 'OVERNIGHT';

  const scoreMap  = SESSION_SCORES[strategy] ?? SESSION_SCORES['MNQ_INTRADAY'];
  const liveMin   = SESSION_LIVE_MIN[strategy] ?? 30;
  const baseScore = scoreMap[key] ?? Math.round(quality * 70);  // fallback to quality

  // Quality multiplier (ntfy session quality 0-1 × 0.3 weighting)
  const score    = Math.round(baseScore * 0.7 + quality * 100 * 0.3);
  const approved = score >= liveMin;
  const warnings = [];

  if (key === 'ASIAN' || key === 'OVERNIGHT') warnings.push('low_liquidity_session');
  if (!approved) warnings.push(`session_below_live_min_${liveMin}`);

  return agentResult({
    score: Math.min(100, score),
    bias: 'neutral',
    reason: `session=${key} quality=${quality.toFixed(2)} strategy=${strategy}`,
    warnings,
    approved,
  });
}

module.exports = { evaluate, name: 'SessionAgent' };
