'use strict';

// ── EMA / SMA / RMA ───────────────────────────────────────────────────────────

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

// Wilder's RMA — matches Pine Script ta.rma() / ta.atr() smoothing
function rma(values, period) {
  const alpha = 1 / period;
  const result = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      if (i === period - 1) {
        let s = 0;
        for (let j = 0; j < period; j++) s += values[j] ?? 0;
        prev = s / period;
        result[i] = prev;
      }
    } else {
      prev = alpha * (values[i] ?? 0) + (1 - alpha) * prev;
      result[i] = prev;
    }
  }
  return result;
}

function rollingStdev(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  });
}

// ── ATR (Wilder's RMA of True Range) ─────────────────────────────────────────

function calcAtr(bars, period = 14) {
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low :
    Math.max(
      b.high - b.low,
      Math.abs(b.high - bars[i - 1].close),
      Math.abs(b.low  - bars[i - 1].close)
    )
  );
  return rma(tr, period);
}

// ── VWAP (daily reset) ────────────────────────────────────────────────────────

function calcVwap(bars) {
  let cumPV = 0, cumV = 0, lastDate = '';
  return bars.map(b => {
    const date = new Date(b.timestamp).toISOString().slice(0, 10);
    if (date !== lastDate) { cumPV = 0; cumV = 0; lastDate = date; }
    const hlc3 = (b.high + b.low + b.close) / 3;
    const v    = b.volume || 1;
    cumPV += hlc3 * v;
    cumV  += v;
    return cumPV / cumV;
  });
}

// ── RSI ───────────────────────────────────────────────────────────────────────

function calcRsi(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = 100 - 100 / (1 + (avgGain / (avgLoss || 0.0001)));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = 100 - 100 / (1 + (avgGain / (avgLoss || 0.0001)));
  }
  return result;
}

// ── MACD ──────────────────────────────────────────────────────────────────────

function calcMacd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast  = ema(closes, fast);
  const emaSlow  = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const sigLine  = ema(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - sigLine[i]);
  return { macdLine, sigLine, histogram };
}

// ── ADX / DI ──────────────────────────────────────────────────────────────────

function calcAdx(bars, period = 14) {
  const n = bars.length;
  const nullArr = () => new Array(n).fill(null);
  if (n < period * 2) return { adx: nullArr(), diPlus: nullArr(), diMinus: nullArr() };

  const trArr   = new Array(n).fill(0);
  const dmPlus  = new Array(n).fill(0);
  const dmMinus = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove   = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    trArr[i]   = Math.max(bars[i].high - bars[i].low,
                          Math.abs(bars[i].high - bars[i - 1].close),
                          Math.abs(bars[i].low  - bars[i - 1].close));
    dmPlus[i]  = (upMove > downMove && upMove > 0) ? upMove : 0;
    dmMinus[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  const atrSmooth   = rma(trArr,   period);
  const rDmPlus     = rma(dmPlus,  period);
  const rDmMinus    = rma(dmMinus, period);

  const diPlusArr  = rDmPlus.map((v, i)  => atrSmooth[i] ? (v / atrSmooth[i]) * 100 : null);
  const diMinusArr = rDmMinus.map((v, i) => atrSmooth[i] ? (v / atrSmooth[i]) * 100 : null);

  const dx = diPlusArr.map((v, i) => {
    const dm = diMinusArr[i];
    if (v == null || dm == null) return null;
    const sum = v + dm;
    return sum > 0 ? Math.abs(v - dm) / sum * 100 : 0;
  });

  const adx = rma(dx.map(v => v ?? 0), period);
  return { adx, diPlus: diPlusArr, diMinus: diMinusArr };
}

// ── Swing high/low detection ──────────────────────────────────────────────────

function detectSwings(bars, lookback = 5) {
  const swings = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1);
    const c = bars[i];
    if (window.every(b => b.high <= c.high)) swings.push({ idx: i, price: c.high, type: 'high' });
    if (window.every(b => b.low  >= c.low))  swings.push({ idx: i, price: c.low,  type: 'low'  });
  }
  return swings;
}

// ── Market structure: BULL (HH/HL) vs BEAR (LH/LL) ──────────────────────────

function detectMarketStructure(bars, lookback = 20) {
  const slice  = bars.slice(-Math.min(bars.length, lookback + 10));
  const swings = detectSwings(slice, 3);
  const highs  = swings.filter(s => s.type === 'high').slice(-3);
  const lows   = swings.filter(s => s.type === 'low').slice(-3);
  if (highs.length < 2 || lows.length < 2) return 'UNCLEAR';
  const hhhl = highs[1].price > highs[0].price && lows[1].price > lows[0].price;
  const lhll = highs[1].price < highs[0].price && lows[1].price < lows[0].price;
  if (hhhl) return 'BULL';
  if (lhll) return 'BEAR';
  return 'UNCLEAR';
}

// ── Consolidation detection (compression before expansion) ───────────────────

function detectConsolidation(bars, lookback = 10, atrPeriod = 14) {
  if (bars.length < lookback + atrPeriod) return { isConsolidating: false };
  const recent    = bars.slice(-lookback);
  const rangeHigh = Math.max(...recent.map(b => b.high));
  const rangeLow  = Math.min(...recent.map(b => b.low));
  const rangePts  = rangeHigh - rangeLow;
  const atrArr    = calcAtr(bars, atrPeriod);
  const curAtr    = atrArr[atrArr.length - 1];
  if (!curAtr) return { isConsolidating: false };

  // Range is "tight" when total range < 40% of what lookback × ATR would normally cover
  const atrRatio = rangePts / (curAtr * lookback * 0.5);
  return {
    isConsolidating: atrRatio < 0.5,
    rangePts,
    rangeHigh,
    rangeLow,
    atrRatio,
    curAtr,
  };
}

// ── Session classifier ────────────────────────────────────────────────────────

function getSessionInfo(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const h    = parseInt(parts.find(p => p.type === 'hour').value);
  const m    = parseInt(parts.find(p => p.type === 'minute').value);
  const hhmm = h * 100 + m;

  const isLondon      = hhmm >= 200  && hhmm < 730;
  const isLondonNY    = hhmm >= 730  && hhmm < 930;
  const isNYOpen      = hhmm >= 930  && hhmm < 1130;
  const isMidDay      = hhmm >= 1130 && hhmm < 1330;
  const isAftNoon     = hhmm >= 1330 && hhmm < 1600;
  const isPreMarket   = hhmm >= 800  && hhmm < 930;

  let name = 'After Hours', quality = 0.40;
  if (isLondon)    { name = 'London';              quality = 0.70; }
  if (isPreMarket) { name = 'Pre-Market';          quality = 0.65; }
  if (isLondonNY)  { name = 'London/NY Overlap';   quality = 0.95; }
  if (isNYOpen)    { name = 'NY Open ★';            quality = 1.00; }
  if (isMidDay)    { name = 'Midday';               quality = 0.75; }
  if (isAftNoon)   { name = 'Afternoon ✓';          quality = 0.65; }

  return { name, quality, hhmm, isNYOpen, isMidDay, isAftNoon, isLondonNY, isLondon, isPreMarket };
}

// ── Bar aggregation ───────────────────────────────────────────────────────────

function aggregateBars(bars, factor) {
  const out   = [];
  const start = bars.length % factor;
  for (let i = start; i + factor - 1 < bars.length; i += factor) {
    const s = bars.slice(i, i + factor);
    out.push({
      timestamp: s[0].timestamp,
      open:      s[0].open,
      high:      Math.max(...s.map(b => b.high)),
      low:       Math.min(...s.map(b => b.low)),
      close:     s[s.length - 1].close,
      volume:    s.reduce((sum, b) => sum + (b.volume || 0), 0),
    });
  }
  return out;
}

function aggregate1mTo5m(bars)  { return aggregateBars(bars, 5);  }
function aggregate5mTo15m(bars) { return aggregateBars(bars, 3);  }
function aggregate5mTo1h(bars)  { return aggregateBars(bars, 12); }
function aggregate15mTo1h(bars) { return aggregateBars(bars, 4);  }
function aggregate1hTo4h(bars)  { return aggregateBars(bars, 4);  }

function aggregate1hToDaily(bars1h) {
  const byDate = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const b of bars1h) {
    const date = fmt.format(new Date(b.timestamp));
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(b);
  }
  return Object.values(byDate).map(dayBars => ({
    timestamp: dayBars[0].timestamp,
    open:      dayBars[0].open,
    high:      Math.max(...dayBars.map(b => b.high)),
    low:       Math.min(...dayBars.map(b => b.low)),
    close:     dayBars[dayBars.length - 1].close,
    volume:    dayBars.reduce((s, b) => s + (b.volume || 0), 0),
  }));
}

// ── Volume spike ──────────────────────────────────────────────────────────────

function hasVolumeSpike(bars, period = 20, multiplier = 1.5) {
  if (bars.length < period + 1) return false;
  const recent = bars.slice(-period - 1, -1);
  const avgVol = recent.reduce((s, b) => s + (b.volume || 0), 0) / period;
  const lastVol = bars[bars.length - 1].volume || 0;
  return lastVol > avgVol * multiplier;
}

// ── EMA stack direction check ─────────────────────────────────────────────────

function calcEmaStack(closes, fast, mid, slow) {
  const ef = ema(closes, fast);
  const em = ema(closes, mid);
  const es = ema(closes, slow);
  const n  = closes.length - 1;
  return { fast: ef[n], mid: em[n], slow: es[n] };
}

function emaStackScore(closes, fast, mid, slow, direction) {
  const { fast: ef, mid: em, slow: es } = calcEmaStack(closes, fast, mid, slow);
  if (direction === 'LONG') {
    if (ef > em && em > es) return 2; // full bull stack
    if (ef > es)            return 1; // partial
    return 0;
  }
  if (direction === 'SHORT') {
    if (ef < em && em < es) return 2; // full bear stack
    if (ef < es)            return 1;
    return 0;
  }
  return 0;
}

// ── HTF bias (EMA fast vs slow) ───────────────────────────────────────────────

function calcHtfBias(bars, fastPeriod = 9, slowPeriod = 21) {
  if (bars.length < slowPeriod) return 0;
  const closes  = bars.map(b => b.close);
  const efArr   = ema(closes, fastPeriod);
  const esArr   = ema(closes, slowPeriod);
  const n       = closes.length - 1;
  const ef = efArr[n], es = esArr[n];
  if (ef > es * 1.0002) return  1;  // bullish bias
  if (ef < es * 0.9998) return -1;  // bearish bias
  return 0;
}

// ── Pullback zone check ───────────────────────────────────────────────────────
// Returns true if any of the last `lookback` bars' lows/highs touched `level` ± `tolerance`

function hadPullbackToLevel(bars, level, tolerance, direction, lookback = 5) {
  const slice = bars.slice(-lookback - 1, -1); // exclude current bar
  if (direction === 'LONG') {
    return slice.some(b => b.low  <= level + tolerance && b.high >= level - tolerance);
  }
  return slice.some(b => b.high >= level - tolerance && b.low  <= level + tolerance);
}

// ── Confirmation candle ───────────────────────────────────────────────────────

function isBullishCandle(bar, minBodyRatio = 0.35) {
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  return (bar.close - bar.open) / range >= minBodyRatio;
}

function isBearishCandle(bar, minBodyRatio = 0.35) {
  const range = bar.high - bar.low;
  if (range <= 0) return false;
  return (bar.open - bar.close) / range >= minBodyRatio;
}

// ── VWAP chop detection ───────────────────────────────────────────────────────
// Returns true if price has been oscillating through VWAP frequently

function isChoppingAroundVwap(bars, vwapArr, lookback = 8, maxCrossings = 3) {
  if (bars.length < lookback) return false;
  let crossings = 0;
  const slice  = bars.slice(-lookback);
  const vwapSl = vwapArr.slice(-lookback);
  for (let i = 1; i < slice.length; i++) {
    const wasAbove = slice[i - 1].close >= vwapSl[i - 1];
    const isAbove  = slice[i].close     >= vwapSl[i];
    if (wasAbove !== isAbove) crossings++;
  }
  return crossings >= maxCrossings;
}

// ── Recent swing high/low for SL placement ────────────────────────────────────

function recentSwingLow(bars, lookback = 10) {
  const slice = bars.slice(-lookback - 1, -1);
  return Math.min(...slice.map(b => b.low));
}

function recentSwingHigh(bars, lookback = 10) {
  const slice = bars.slice(-lookback - 1, -1);
  return Math.max(...slice.map(b => b.high));
}

// ── Find nearest key S/R level in ATR units ───────────────────────────────────

function srDistanceAtr(price, bars, atr, lookback = 50) {
  if (!atr || atr <= 0) return 10;
  const swings = detectSwings(bars.slice(-lookback), 5);
  if (!swings.length) return 10;
  const distances = swings.map(s => Math.abs(s.price - price) / atr);
  return Math.min(...distances);
}

module.exports = {
  ema, sma, rma, rollingStdev,
  calcAtr, calcVwap, calcRsi, calcMacd, calcAdx,
  detectSwings, detectMarketStructure, detectConsolidation,
  getSessionInfo,
  aggregateBars, aggregate1mTo5m, aggregate5mTo15m, aggregate5mTo1h,
  aggregate15mTo1h, aggregate1hTo4h, aggregate1hToDaily,
  hasVolumeSpike, calcEmaStack, emaStackScore, calcHtfBias,
  hadPullbackToLevel, isBullishCandle, isBearishCandle,
  isChoppingAroundVwap, recentSwingLow, recentSwingHigh, srDistanceAtr,
};
