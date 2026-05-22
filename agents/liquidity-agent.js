'use strict';

/**
 * LIQUIDITY AGENT
 *
 * Detects liquidity sweeps, stop hunts, and liquidity pool conditions.
 * The best entries happen AFTER a sweep of obvious highs/lows — not before.
 *
 * Looks for:
 *   - Price swept below prior session low then reclaimed (LONG setup)
 *   - Price swept above prior session high then rejected (SHORT setup)
 *   - Failed breakout with immediate reversal candle
 *   - Displacement candle after sweep (confirms intent)
 *
 * ctx fields used:
 *   bars5m       — array of 5m bars [{open,high,low,close,timestamp}]
 *   direction    — 'LONG' | 'SHORT'
 *   close        — current price
 *   atr          — current ATR
 *   indicators.dB, dBr, rU, rD — existing displacement flags
 *   indicators.rstL, rstS      — reversal structure flags
 */

const { agentResult } = require('./agent-framework');

// Find the swing high/low over the last N bars
function swingHigh(bars, n = 20) {
  const slice = bars.slice(-n);
  return slice.reduce((m, b) => Math.max(m, b.high), -Infinity);
}
function swingLow(bars, n = 20) {
  const slice = bars.slice(-n);
  return slice.reduce((m, b) => Math.min(m, b.low), Infinity);
}

function evaluate(ctx) {
  const bars  = ctx.bars5m ?? [];
  const dir   = (ctx.direction ?? 'LONG').toUpperCase();
  const close = ctx.close ?? ctx.indicators?.close;
  const atr   = ctx.atr   ?? ctx.indicators?.atr ?? 1;

  if (bars.length < 10 || close == null) {
    return agentResult({ score: 50, bias: 'neutral', reason: 'insufficient bars for liquidity analysis', approved: true });
  }

  const last     = bars[bars.length - 1];
  const prev     = bars[bars.length - 2];
  const prevHigh = swingHigh(bars, 20);
  const prevLow  = swingLow(bars,  20);

  const warnings = [];
  let score = 50;
  let bias  = 'neutral';

  if (dir === 'LONG') {
    // Best LONG: swept below prior swing low, now reclaimed
    const sweptLow    = last.low < prevLow && last.close > prevLow;
    const nearLow     = Math.abs(close - prevLow) / atr < 0.5;
    const displacement = ctx.indicators?.dB || ctx.indicators?.rU; // bullish displacement

    if (sweptLow && displacement) {
      score = 88;
      bias  = 'bullish';
    } else if (sweptLow) {
      score = 72;
      bias  = 'bullish';
    } else if (nearLow) {
      // Approaching prior low — potential liquidity grab
      score = 60;
      bias  = 'bullish';
    } else if (close > prevHigh) {
      // Breaking out above prior high — chasing breakout, possible sweep target
      score = 30;
      bias  = 'neutral';
      warnings.push('potential_sweep_target_long');
    } else {
      score = 50;
    }
  } else {
    // Best SHORT: swept above prior swing high, now rejected
    const sweptHigh   = last.high > prevHigh && last.close < prevHigh;
    const nearHigh    = Math.abs(close - prevHigh) / atr < 0.5;
    const displacement = ctx.indicators?.dBr || ctx.indicators?.rD; // bearish displacement

    if (sweptHigh && displacement) {
      score = 88;
      bias  = 'bearish';
    } else if (sweptHigh) {
      score = 72;
      bias  = 'bearish';
    } else if (nearHigh) {
      score = 60;
      bias  = 'bearish';
    } else if (close < prevLow) {
      score = 30;
      bias  = 'neutral';
      warnings.push('potential_sweep_target_short');
    } else {
      score = 50;
    }
  }

  // Low liquidity sessions reduce score
  const sessQuality = ctx.sess?.quality ?? ctx.indicators?.sessionQuality ?? 0.7;
  if (sessQuality < 0.4) {
    score = Math.max(0, score - 20);
    warnings.push('low_liquidity_session');
  }

  return agentResult({
    score,
    bias,
    reason: `dir=${dir} swingH=${prevHigh?.toFixed(2)} swingL=${prevLow?.toFixed(2)} close=${close?.toFixed(2)}`,
    warnings,
    approved: score >= 50,
  });
}

module.exports = { evaluate, name: 'LiquidityAgent' };
