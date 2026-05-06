'use strict';

// ── Shared math helpers ───────────────────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map(v => (prev = v * k + prev * (1 - k)));
}

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j] ?? 0;
    return s / period;
  });
}

function rma(values, period) {
  const alpha = 1 / period;
  const result = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      if (i === period - 1) {
        let s = 0; for (let j = 0; j < period; j++) s += values[j] ?? 0;
        prev = s / period; result[i] = prev;
      }
    } else { prev = alpha * (values[i] ?? 0) + (1 - alpha) * prev; result[i] = prev; }
  }
  return result;
}

function calcAtr(bars, period = 14) {
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low :
    Math.max(b.high - b.low, Math.abs(b.high - bars[i-1].close), Math.abs(b.low - bars[i-1].close))
  );
  return rma(tr, period);
}

function calcVwap(bars) {
  let cumPV = 0, cumV = 0, lastDate = '';
  return bars.map(b => {
    const date = new Date(b.timestamp).toISOString().slice(0, 10);
    if (date !== lastDate) { cumPV = 0; cumV = 0; lastDate = date; }
    const hlc3 = (b.high + b.low + b.close) / 3;
    const v = b.volume || 1;
    cumPV += hlc3 * v; cumV += v;
    return cumPV / cumV;
  });
}

function rollingStdev(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  });
}

/**
 * Wilder RSI.
 * @returns {Array<number|null>} — null until period+1 bars are available.
 */
function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);
  const result = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain += Math.max(0, d); avgLoss += Math.max(0, -d);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = 100 - 100 / (1 + avgGain / (avgLoss || 0.001));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    result[i] = 100 - 100 / (1 + avgGain / (avgLoss || 0.001));
  }
  return result;
}

/**
 * Standard MACD (12/26/9).
 */
function calcMacd(closes, fast = 12, slow = 26, sig = 9) {
  const emaFast   = ema(closes, fast);
  const emaSlow   = ema(closes, slow);
  const macdLine  = emaFast.map((v, i) => v - emaSlow[i]);
  const sigLine   = ema(macdLine, sig);
  const histogram = macdLine.map((v, i) => v - sigLine[i]);
  return { macdLine, sigLine, histogram };
}

function getSessionInfo(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const hhmm = h * 100 + m;
  const sessName = hhmm >= 930  && hhmm < 1130 ? 'NY Open ★'
                 : hhmm >= 1130 && hhmm < 1330 ? 'Midday'
                 : hhmm >= 1330 && hhmm < 1600 ? 'Afternoon ✓'
                 : hhmm >= 1600                 ? 'After Hours'
                 : hhmm >= 400                  ? 'Pre-Market'
                 :                                'Overnight';
  return { sessName, hhmm, inRTH: hhmm >= 930 && hhmm < 1600 };
}

// ── Internal signal builder ───────────────────────────────────────────────────
function _build(bars, direction, strategy, score, sl, tp1, tp2, tp3, winBase = 0.57) {
  const grade = score >= 24 ? 'A+' : score >= 14 ? 'A' : null;
  if (!grade) return null;
  const i   = bars.length - 1;
  const atr = (calcAtr(bars, 14)[i] ?? bars[i].close * 0.001);
  const close = bars[i].close;
  const slDist  = Math.abs(close - sl)  || atr;
  const tp1Dist = Math.abs(tp1 - close) || atr;
  const wp1 = Math.min(0.88, Math.max(0.40, winBase + (score - 16) * 0.007));
  return {
    strategy,
    direction,
    grade,
    setup:        strategy,
    source:       'strategy',
    score,
    entry:        close,
    sl, tp1, tp2, tp3,
    rr:           +(tp1Dist / slDist).toFixed(2),
    effectiveSL:  +slDist.toFixed(3),
    win_prob_tp1: Math.round(wp1 * 100),
    win_prob_tp2: Math.round(wp1 * 0.72 * 100),
    win_prob_tp3: Math.round(wp1 * 0.50 * 100),
    session:      getSessionInfo(bars[i].timestamp).sessName,
    timestamp:    bars[i].timestamp,
    atr:          +atr.toFixed(3),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 1 — EMA Crossover + RSI Confirmation
// ─────────────────────────────────────────────────────────────────────────────
// Entry:     EMA9 crosses EMA21 (confirmed in current bar); RSI 35–70 (LONG)
//            or 30–65 (SHORT); price on correct side of EMA50; volume ≥ 1.05×.
// SL:        1.4× ATR on losing side of EMA9.
// TP:        1:1 / 2:1 / 3:1 R.
// Timeframe: 1m.   Frequency: 3–8 signals/day.   Risk: Medium.
// Win rate:  ~55–63% historically in trending conditions.
// ─────────────────────────────────────────────────────────────────────────────
function emaCrossRsi(bars) {
  const N = bars.length;
  if (N < 55) return { fired: false, reason: 'need 55 bars' };

  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume || 1);
  const i = N - 1;

  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const rsi = calcRsi(closes, 14);
  const volAvg = sma(volumes, 20);

  const crossUp   = e9[i-1] <= e21[i-1] && e9[i] > e21[i];
  const crossDown = e9[i-1] >= e21[i-1] && e9[i] < e21[i];
  if (!crossUp && !crossDown) return { fired: false, reason: 'no EMA cross' };

  const direction = crossUp ? 'LONG' : 'SHORT';
  const rsiVal = rsi[i];
  if (rsiVal == null) return { fired: false, reason: 'RSI not ready' };

  if (direction === 'LONG'  && (rsiVal < 35 || rsiVal > 70))
    return { fired: false, reason: `RSI ${rsiVal.toFixed(1)} out of LONG range 35–70` };
  if (direction === 'SHORT' && (rsiVal > 65 || rsiVal < 30))
    return { fired: false, reason: `RSI ${rsiVal.toFixed(1)} out of SHORT range 30–65` };

  const close = closes[i];
  if (direction === 'LONG'  && close < e50[i] * 0.998)
    return { fired: false, reason: 'price below EMA50 for LONG' };
  if (direction === 'SHORT' && close > e50[i] * 1.002)
    return { fired: false, reason: 'price above EMA50 for SHORT' };

  const volOk = volumes[i] > (volAvg[i] ?? 1) * 1.05;
  const atrV  = calcAtr(bars, 14);
  const atr   = atrV[i] ?? 1;
  const dir   = direction === 'LONG' ? 1 : -1;

  let score = 14;
  if (direction === 'LONG'  && rsiVal >= 45 && rsiVal <= 60) score += 3;
  if (direction === 'SHORT' && rsiVal >= 40 && rsiVal <= 55) score += 3;
  if (volOk) score += 2;
  if (direction === 'LONG'  && close > e50[i]) score += 2;
  if (direction === 'SHORT' && close < e50[i]) score += 2;
  if (Math.abs(e9[i] - e21[i]) > Math.abs(e21[i]) * 0.0003) score += 2;

  const slPts = atr * 1.4;
  const sl  = close - dir * slPts;
  const tp1 = close + dir * slPts;
  const tp2 = close + dir * slPts * 2;
  const tp3 = close + dir * slPts * 3;

  const sig = _build(bars, direction, 'EMA Cross', score, sl, tp1, tp2, tp3, 0.57);
  return sig ? { fired: true, signal: sig } : { fired: false, reason: `score ${score} below grade threshold` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 2 — VWAP Pullback
// ─────────────────────────────────────────────────────────────────────────────
// Entry:     Price extended >1.5 std above/below VWAP in last 6 bars (trend),
//            then pulls back to within 0.35 std of VWAP; bounce candle present;
//            EMA9 > EMA21 for LONG.
// SL:        0.6× VWAP std beyond entry.
// TP:        1.5× std / 2.7× std / 4× std from VWAP.
// Timeframe: 1m.   Frequency: 5–12 signals/day.   Risk: Low–Medium.
// Win rate:  ~60–68% near VWAP with clean pullback structure.
// ─────────────────────────────────────────────────────────────────────────────
function vwapPullback(bars) {
  const N = bars.length;
  if (N < 35) return { fired: false, reason: 'need 35 bars' };

  const closes = bars.map(b => b.close);
  const i = N - 1;

  const vwapV = calcVwap(bars);
  const stdvV = rollingStdev(closes, 20);
  const e9    = ema(closes, 9);
  const e21   = ema(closes, 21);

  const vwap = vwapV[i], sdv = stdvV[i];
  if (!vwap || !sdv || sdv < 0.01) return { fired: false, reason: 'VWAP/STDV not ready' };

  const close = closes[i];
  const nearVwap = Math.abs(close - vwap) <= sdv * 0.35;
  if (!nearVwap) return { fired: false, reason: `price ${(Math.abs(close-vwap)/sdv).toFixed(2)} std from VWAP — not in pullback zone` };

  const lookback = Math.min(6, i);
  let hadBullExt = false, hadBearExt = false;
  for (let j = i - lookback; j < i; j++) {
    if (closes[j] > vwapV[j] + (stdvV[j] ?? sdv) * 1.5) hadBullExt = true;
    if (closes[j] < vwapV[j] - (stdvV[j] ?? sdv) * 1.5) hadBearExt = true;
  }
  if (!hadBullExt && !hadBearExt)
    return { fired: false, reason: 'no prior VWAP extension in last 6 bars' };

  const bull = bars[i].close > bars[i].open;
  const bear = !bull;
  const cRng  = bars[i].high - bars[i].low;
  const cBody = Math.abs(bars[i].close - bars[i].open);
  if (cRng > 0 && cBody < cRng * 0.20) return { fired: false, reason: 'doji candle — no conviction' };

  const direction = (hadBullExt && bull && e9[i] >= e21[i]) ? 'LONG'
                  : (hadBearExt && bear && e9[i] <= e21[i]) ? 'SHORT'
                  : null;
  if (!direction) return { fired: false, reason: 'EMA trend opposes VWAP extension direction' };

  const dir    = direction === 'LONG' ? 1 : -1;
  const slPts  = sdv * 0.60;
  const tp1Pts = sdv * 1.50;
  const sl  = close - dir * slPts;
  const tp1 = close + dir * tp1Pts;
  const tp2 = close + dir * tp1Pts * 1.8;
  const tp3 = close + dir * tp1Pts * 2.5;

  let score = 15;
  if (Math.abs(close - vwap) < sdv * 0.15) score += 3;
  else if (Math.abs(close - vwap) < sdv * 0.25) score += 2;
  if (direction === 'LONG'  && e9[i] > e21[i]) score += 2;
  if (direction === 'SHORT' && e9[i] < e21[i]) score += 2;
  if (cBody >= cRng * 0.50) score += 2;

  const sig = _build(bars, direction, 'VWAP PB', score, sl, tp1, tp2, tp3, 0.62);
  return sig ? { fired: true, signal: sig } : { fired: false, reason: `score ${score} below grade threshold` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 3 — Bollinger Bands Breakout / Reversion
// ─────────────────────────────────────────────────────────────────────────────
// Reversion: Previous bar closed outside 2-std band; current bar closes back
//            inside; candle shows conviction (body ≥ 20% of range).
// Breakout:  Bar closes outside band with volume >1.4× avg AND ATR expanding
//            (momentum continuation, not fade).
// Timeframe: 1m.   Frequency: 4–8 signals/day.   Risk: Medium.
// Win rate:  Reversion ~62–68%; Breakout ~52–60%.
// ─────────────────────────────────────────────────────────────────────────────
function bollingerBands(bars) {
  const N = bars.length;
  if (N < 25) return { fired: false, reason: 'need 25 bars' };

  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume || 1);
  const i = N - 1;

  const period  = 20;
  const mid     = sma(closes, period)[i];
  const sdv     = rollingStdev(closes, period)[i];
  const volAvg  = sma(volumes, 20)[i] ?? 1;
  const atrV    = calcAtr(bars, 14);
  const atr     = atrV[i] ?? 1;
  const atrAvg  = (sma(atrV.map(v => v ?? 0), 20)[i]) ?? atr;

  if (!mid || !sdv) return { fired: false, reason: 'BB not ready' };

  const upper = mid + sdv * 2, lower = mid - sdv * 2;
  const close = closes[i], prevClose = closes[i-1];
  const vol   = volumes[i];

  const revL = prevClose < lower && close > lower;
  const revS = prevClose > upper && close < upper;
  const brkL = close > upper && vol > volAvg * 1.4 && atr > atrAvg * 1.2;
  const brkS = close < lower && vol > volAvg * 1.4 && atr > atrAvg * 1.2;

  if (!revL && !revS && !brkL && !brkS) {
    const relPos = close > upper ? 'above upper' : close < lower ? 'below lower' : 'inside bands';
    return { fired: false, reason: `no BB trigger (${relPos}; prev ${prevClose > upper ? 'above upper' : prevClose < lower ? 'below lower' : 'inside'})` };
  }

  const cRng = bars[i].high - bars[i].low;
  const cBody = Math.abs(bars[i].close - bars[i].open);
  if (cRng > 0 && cBody < cRng * 0.20 && (revL || revS))
    return { fired: false, reason: 'doji candle on reversion — no conviction' };

  let direction, subtype, score;
  let sl, tp1, tp2, tp3;
  const dir = (revL || brkL) ? 1 : -1;
  direction  = dir === 1 ? 'LONG' : 'SHORT';

  if (revL || revS) {
    subtype = 'BB Rev';
    score   = 15;
    if (vol > volAvg) score += 2;
    const distFromBand = revL ? close - lower : upper - close;
    if (distFromBand > sdv * 0.3) score += 2;
    const slDist = Math.abs(close - (revL ? lower : upper)) + sdv * 0.2;
    sl  = close - dir * slDist;
    tp1 = mid;
    tp2 = mid + dir * sdv * 0.8;
    tp3 = revL ? upper : lower;
  } else {
    subtype = 'BB Break';
    score   = 16;
    if (vol > volAvg * 1.8) score += 3;
    if (atr > atrAvg * 1.4) score += 2;
    sl  = close - dir * atr * 1.2;
    tp1 = close + dir * atr * 2.0;
    tp2 = close + dir * atr * 3.5;
    tp3 = close + dir * atr * 5.0;
  }

  const sig = _build(bars, direction, subtype, score, sl, tp1, tp2, tp3, revL || revS ? 0.62 : 0.55);
  return sig ? { fired: true, signal: sig } : { fired: false, reason: `score ${score} below grade threshold` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 4 — MACD Momentum Continuation
// ─────────────────────────────────────────────────────────────────────────────
// Entry:     MACD histogram crosses zero; MACD line above/below signal line;
//            price within ±0.3% of EMA50 (loose trend filter).
// SL:        1.0× ATR.
// TP:        1.5× / 2.5× / 4.0× ATR.
// Timeframe: 1m.   Frequency: 4–10 signals/day.   Risk: Medium.
// Win rate:  ~53–60% depending on trend strength.
// ─────────────────────────────────────────────────────────────────────────────
function macdMomentum(bars) {
  const N = bars.length;
  if (N < 60) return { fired: false, reason: 'need 60 bars' };

  const closes = bars.map(b => b.close);
  const i = N - 1;

  const { macdLine, sigLine, histogram } = calcMacd(closes);
  const e50 = ema(closes, 50);

  const hist = histogram[i], histP = histogram[i-1];
  const macd = macdLine[i],  sig   = sigLine[i];
  const close = closes[i], e50v = e50[i];

  if (hist == null || histP == null) return { fired: false, reason: 'MACD not ready' };

  const crossUp   = histP < 0 && hist > 0;
  const crossDown = histP > 0 && hist < 0;
  if (!crossUp && !crossDown) return { fired: false, reason: `histogram ${hist.toFixed(4)} no zero-cross (prev ${histP.toFixed(4)})` };

  const direction = crossUp ? 'LONG' : 'SHORT';

  if (direction === 'LONG'  && macd < sig) return { fired: false, reason: 'MACD below signal on LONG cross' };
  if (direction === 'SHORT' && macd > sig) return { fired: false, reason: 'MACD above signal on SHORT cross' };

  if (direction === 'LONG'  && close < e50v * 0.997) return { fired: false, reason: 'price too far below EMA50 for LONG' };
  if (direction === 'SHORT' && close > e50v * 1.003) return { fired: false, reason: 'price too far above EMA50 for SHORT' };

  const atrV = calcAtr(bars, 14);
  const atr  = atrV[i] ?? 1;
  const dir  = direction === 'LONG' ? 1 : -1;

  let score = 14;
  if (direction === 'LONG'  && close > e50v) score += 2;
  if (direction === 'SHORT' && close < e50v) score += 2;
  if (Math.abs(hist) > Math.abs(histP) * 1.5) score += 2;  // accelerating
  if (Math.abs(hist) > atr * 0.01)            score += 2;
  if (Math.abs(macd - sig) > atr * 0.005)     score += 2;

  const sl  = close - dir * atr;
  const tp1 = close + dir * atr * 1.5;
  const tp2 = close + dir * atr * 2.5;
  const tp3 = close + dir * atr * 4.0;

  const sig2 = _build(bars, direction, 'MACD Mom', score, sl, tp1, tp2, tp3, 0.56);
  return sig2 ? { fired: true, signal: sig2 } : { fired: false, reason: `score ${score} below grade threshold` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 5 — Support / Resistance Breakout with Volume
// ─────────────────────────────────────────────────────────────────────────────
// Entry:     Pivot high/low S/R level identified in last 50 bars; price closes
//            beyond level with volume >1.5× avg AND ATR expanding; price held
//            below/above level for ≥ 3 prior consecutive bars (confirmation).
// SL:        Back inside level + 0.4× ATR buffer.
// TP:        1.5× / 2.5× / 4.0× distance-from-level.
// Timeframe: 1m.   Frequency: 2–6 signals/day.   Risk: Medium–High.
// Win rate:  ~55–65% when volume + ATR confirm.
// ─────────────────────────────────────────────────────────────────────────────
function srBreakout(bars) {
  const N = bars.length;
  if (N < 55) return { fired: false, reason: 'need 55 bars' };

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume || 1);
  const i = N - 1;

  const atrV    = calcAtr(bars, 14);
  const atrSmaV = sma(atrV.map(v => v ?? 0), 20);
  const volAvg  = sma(volumes, 20);

  const atr    = atrV[i] ?? 1;
  const atrAvg = atrSmaV[i] ?? atr;
  const vol    = volumes[i], vavg = volAvg[i] ?? 1;
  const close  = closes[i];

  // Find nearest pivot levels in last 50 bars (excluding last 3 — confirmation zone)
  const swL = 5;
  const maxJ = Math.min(i - 3, N - 1);
  let nearestRes = null, nearestSup = null;

  for (let j = swL; j <= maxJ - swL; j++) {
    const lo = Math.max(0, j - swL), hi = Math.min(N - 1, j + swL);
    if (highs[j] === Math.max(...highs.slice(lo, hi + 1)) && highs[j] > close) {
      if (!nearestRes || highs[j] < nearestRes) nearestRes = highs[j];
    }
    if (lows[j] === Math.min(...lows.slice(lo, hi + 1)) && lows[j] < close) {
      if (!nearestSup || lows[j] > nearestSup) nearestSup = lows[j];
    }
  }

  if (!nearestRes && !nearestSup) return { fired: false, reason: 'no S/R pivot levels found' };

  const atrOk = atr > atrAvg * 1.15;
  const volOk = vol > vavg * 1.5;
  if (!atrOk) return { fired: false, reason: `ATR not expanding (${(atr/atrAvg).toFixed(2)}× avg)` };
  if (!volOk) return { fired: false, reason: `volume weak (${(vol/vavg).toFixed(2)}× avg, need 1.5×)` };

  const breakAbove = nearestRes && close > nearestRes + atr * 0.05;
  const breakBelow = nearestSup && close < nearestSup - atr * 0.05;

  if (!breakAbove && !breakBelow) {
    const nearRes = nearestRes ? ` res=${nearestRes.toFixed(1)}` : '';
    const nearSup = nearestSup ? ` sup=${nearestSup.toFixed(1)}` : '';
    return { fired: false, reason: `price ${close.toFixed(1)} not past levels${nearRes}${nearSup}` };
  }

  const direction = breakAbove ? 'LONG' : 'SHORT';
  const level     = breakAbove ? nearestRes : nearestSup;
  const dir       = direction === 'LONG' ? 1 : -1;

  // Confirm price held correct side for last 3 bars
  for (let j = i - 3; j < i; j++) {
    if (j < 0) continue;
    if (direction === 'LONG'  && closes[j] > level) return { fired: false, reason: 'price already above resistance — not fresh breakout' };
    if (direction === 'SHORT' && closes[j] < level) return { fired: false, reason: 'price already below support — not fresh breakdown' };
  }

  const distFromLevel = Math.abs(close - level);
  const slPts = atr * 0.4 + distFromLevel;
  const sl  = close - dir * slPts;
  const tp1 = close + dir * distFromLevel * 1.5;
  const tp2 = close + dir * distFromLevel * 2.5;
  const tp3 = close + dir * distFromLevel * 4.0;

  let score = 16;
  if (vol > vavg * 2.0) score += 3;
  if (atr > atrAvg * 1.3) score += 2;
  if (distFromLevel < atr * 0.15) score += 2;  // tight breakout
  if (dir === 1  && closes[i] > closes[i-1]) score += 1;
  if (dir === -1 && closes[i] < closes[i-1]) score += 1;

  const sig = _build(bars, direction, 'SR Break', score, sl, tp1, tp2, tp3, 0.58);
  return sig ? { fired: true, signal: { ...sig, level } }
             : { fired: false, reason: `score ${score} below grade threshold` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all 5 strategies and return every signal that fired.
 * @returns {Array} Array of signal objects (may be empty).
 */
function runAllStrategies(bars, instrument = 'MNQ') {
  const runners = [
    { name: 'EMA Cross', fn: emaCrossRsi },
    { name: 'VWAP PB',   fn: vwapPullback },
    { name: 'BB',        fn: bollingerBands },
    { name: 'MACD Mom',  fn: macdMomentum },
    { name: 'SR Break',  fn: srBreakout },
  ];

  const signals = [];
  for (const r of runners) {
    try {
      const result = r.fn(bars);
      if (result?.fired && result.signal) {
        signals.push({ ...result.signal, instrument });
      }
    } catch { /* individual strategy errors must not abort the scan */ }
  }
  return signals;
}

/**
 * Diagnostic run — returns fired/rejected status + reason for every strategy.
 * @returns {Array<{strategy, fired, signal?, reason?, error?}>}
 */
function diagnoseStrategies(bars, instrument = 'MNQ') {
  const runners = [
    { name: 'EMA Cross', fn: emaCrossRsi },
    { name: 'VWAP PB',   fn: vwapPullback },
    { name: 'BB',        fn: bollingerBands },
    { name: 'MACD Mom',  fn: macdMomentum },
    { name: 'SR Break',  fn: srBreakout },
  ];

  return runners.map(r => {
    try {
      const result = r.fn(bars);
      return {
        strategy: r.name,
        fired:    result?.fired ?? false,
        signal:   result?.signal ?? null,
        reason:   result?.reason ?? null,
      };
    } catch (err) {
      return { strategy: r.name, fired: false, error: err.message };
    }
  });
}

module.exports = {
  emaCrossRsi, vwapPullback, bollingerBands, macdMomentum, srBreakout,
  runAllStrategies, diagnoseStrategies,
};
