'use strict';

/**
 * MOMENTUM AGENT
 *
 * Measures displacement strength, candle quality, and exhaustion risk.
 * A good signal needs momentum behind it — not a tired, extended move.
 *
 * Scores based on:
 *   - RSI position and trend
 *   - MACD histogram direction and strength
 *   - Recent candle body ratio (displacement quality)
 *   - Exhaustion flags (RSI divergence, histogram flattening)
 *
 * ctx fields used:
 *   rsi, hist, histPrev — from existing quant context
 *   bars5m              — for candle quality
 *   direction           — 'LONG' | 'SHORT'
 */

const { agentResult } = require('./agent-framework');

function candleBodyRatio(bar) {
  if (!bar) return 0;
  const range = bar.high - bar.low;
  if (range === 0) return 0;
  return Math.abs(bar.close - bar.open) / range;
}

function evaluate(ctx) {
  const dir      = (ctx.direction ?? 'LONG').toUpperCase();
  const rsi      = ctx.rsi      ?? null;
  const hist     = ctx.hist     ?? null;
  const histPrev = ctx.histPrev ?? null;
  const bars     = ctx.bars5m   ?? [];
  const isBull   = dir === 'LONG';

  const warnings = [];
  let score = 50;

  // ── RSI scoring ───────────────────────────────────────────────────────────
  let rsiScore = 0;
  if (rsi != null) {
    if (isBull) {
      if (rsi >= 55 && rsi <= 70)       rsiScore = 25;  // momentum zone
      else if (rsi >= 50 && rsi < 55)   rsiScore = 15;  // mild
      else if (rsi > 70 && rsi <= 78)   { rsiScore = 5; warnings.push('rsi_extended'); }
      else if (rsi > 78)                { rsiScore = 0; warnings.push('rsi_overbought'); }
      else if (rsi < 50)                { rsiScore = 5; warnings.push('rsi_bearish'); }
    } else {
      if (rsi <= 45 && rsi >= 30)       rsiScore = 25;
      else if (rsi <= 50 && rsi > 45)   rsiScore = 15;
      else if (rsi < 30 && rsi >= 22)   { rsiScore = 5; warnings.push('rsi_extended'); }
      else if (rsi < 22)                { rsiScore = 0; warnings.push('rsi_oversold'); }
      else if (rsi > 50)                { rsiScore = 5; warnings.push('rsi_bullish'); }
    }
  }

  // ── MACD histogram scoring ────────────────────────────────────────────────
  let macdScore = 0;
  if (hist != null) {
    const aligned   = isBull ? hist > 0   : hist < 0;
    const improving = histPrev != null
      ? (isBull ? hist > histPrev : hist < histPrev)
      : true;
    const flattening = histPrev != null && Math.abs(hist - histPrev) < Math.abs(histPrev) * 0.1;

    if (aligned && improving)  macdScore = 30;
    else if (aligned)          macdScore = 15;
    else if (flattening)       { macdScore = 5; warnings.push('macd_flattening'); }
    else                       { macdScore = 0; warnings.push('macd_counter_trend'); }
  }

  // ── Candle quality (last 3 bars) ──────────────────────────────────────────
  let candleScore = 0;
  if (bars.length >= 3) {
    const lastBars = bars.slice(-3);
    const avgBody  = lastBars.reduce((s, b) => s + candleBodyRatio(b), 0) / 3;
    const lastBar  = lastBars[lastBars.length - 1];
    const bullish  = lastBar.close > lastBar.open;

    if (avgBody > 0.6 && (isBull ? bullish : !bullish)) candleScore = 25;  // strong displacement
    else if (avgBody > 0.4)                              candleScore = 15;
    else if (avgBody < 0.25)                             { candleScore = 5; warnings.push('weak_candles'); }
    else                                                 candleScore = 10;
  }

  score = rsiScore + macdScore + candleScore;

  // Exhaustion: RSI > 78 long or < 22 short + weak histogram = hard reject
  if (warnings.includes('rsi_overbought') || warnings.includes('rsi_oversold')) {
    if (macdScore <= 5) {
      return agentResult({ score: 5, bias: 'neutral', approved: false,
        reason: 'momentum exhaustion — RSI extreme + weak histogram', warnings });
    }
  }

  const bias = score >= 60 ? (isBull ? 'bullish' : 'bearish') : 'neutral';

  return agentResult({
    score: Math.min(100, score),
    bias,
    reason: `rsi=${rsi?.toFixed(1) ?? '?'} hist=${hist?.toFixed(4) ?? '?'} candle_body=${bars.length >= 1 ? candleBodyRatio(bars[bars.length-1]).toFixed(2) : '?'}`,
    warnings,
    approved: score >= 40,  // momentum is supportive — lower bar since other agents gate
  });
}

module.exports = { evaluate, name: 'MomentumAgent' };
