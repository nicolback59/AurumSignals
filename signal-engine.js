'use strict';

// ── Math helpers ──────────────────────────────────────────────────────────────

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

// Wilder's RMA — matches Pine Script ta.atr() smoothing
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

function calcAtr(bars, period) {
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
    const v    = b.volume || 1;
    cumPV += hlc3 * v;
    cumV  += v;
    return cumPV / cumV;
  });
}

function getSessionInfo(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const h    = parseInt(parts.find(p => p.type === 'hour').value);
  const m    = parseInt(parts.find(p => p.type === 'minute').value);
  const hhmm = h * 100 + m;
  const inNYOpen  = hhmm >= 930  && hhmm < 1130;
  const inMidDay  = hhmm >= 1130 && hhmm < 1330;
  const inAftNoon = hhmm >= 1330 && hhmm < 1600;
  const inLunch   = hhmm >= 1145 && hhmm < 1300;
  const inRTH     = hhmm >= 930  && hhmm < 1600;
  const sessOK    = inRTH && !inLunch;
  const sessScore = inNYOpen ? 3 : inAftNoon ? 2 : inMidDay ? 1 : 0;
  const sessQ     = inNYOpen ? 1.0 : inAftNoon ? 0.85 : inMidDay ? 0.65 : 0.5;
  const sessName  = inNYOpen  ? 'NY Open ★'   : inAftNoon ? 'Afternoon ✓'
                  : inMidDay  ? 'Midday'       : hhmm >= 1600 ? 'After Hours'
                  : hhmm >= 400 ? 'Pre-Market' : 'Overnight';
  return { sessOK, sessScore, sessQ, sessName, hhmm, inRTH };
}

// ── Win probability — matches Pine Script formula ─────────────────────────────

function calcWinProb(score, isAplus, sessQ, setup) {
  const base  = setup === 'OTE+STDV' ? 0.70 : setup === 'OTE PB' ? 0.65
              : (setup === 'STDV REV' || setup === 'STDV RST') ? 0.60 : 0.58;
  const gAdj  = isAplus ? 0.06 : 0.0;
  const sAdj  = (score - 16) * 0.008;
  const ssAdj = sessQ >= 0.85 ? 0.04 : sessQ >= 0.65 ? 0.0 : -0.06;
  return Math.min(Math.max(base + gAdj + sAdj + ssAdj, 0.35), 0.92);
}

// ── Trade style detection ─────────────────────────────────────────────────────

/**
 * Classify the trade as scalp, intraday, or swing based on market conditions.
 * MGC is always scalp. MNQ auto-detects from HTF trend + structure + ATR state.
 */
function detectTradeStyle(instrument, tradeStyleMode, direction, indicators) {
  if (instrument === 'MGC') return 'scalp';
  if (tradeStyleMode !== 'auto') return tradeStyleMode;

  const { htfBull, htfBear, msB, msBr, inOTED, inOTEP,
          atrExpanded, blwV2, abvV2, trendStrength } = indicators;

  const trendAligned = direction === 'LONG' ? htfBull : htfBear;
  const msAligned    = direction === 'LONG' ? msB     : msBr;
  const inOTE        = direction === 'LONG' ? inOTED  : inOTEP;

  // Swing: strong trend + structure + OTE zone + expanding volatility
  if (trendAligned && msAligned && inOTE && atrExpanded && trendStrength > 0.008) {
    return 'swing';
  }
  // Intraday: trend alignment + OTE pullback or clear structure
  if (trendAligned && (inOTE || msAligned)) {
    return 'intraday';
  }
  // Scalp: STDV extension reversals or counter/neutral-trend setups
  return 'scalp';
}

// ── Style-specific SL / TP levels ─────────────────────────────────────────────

/**
 * Returns { sl, tp1, tp2, tp3, rr, effectiveSL } based on trade style.
 * Swing targets are fixed NQ-point levels; scalp/intraday use R-multiples.
 */
function calcStyleLevels(close, direction, tradeStyle, slPts, swingTp1, swingTp2, swingTp3) {
  const dir = direction === 'LONG' ? 1 : -1;

  if (tradeStyle === 'swing') {
    const swingSL = slPts * 2.0;
    return {
      sl:  close - dir * swingSL,
      tp1: close + dir * swingTp1,
      tp2: close + dir * swingTp2,
      tp3: close + dir * swingTp3,
      rr:  +(swingTp1 / swingSL).toFixed(2),
      effectiveSL: swingSL,
    };
  }

  const effectiveSL = tradeStyle === 'scalp' ? +(slPts * 0.65).toFixed(2) : slPts;
  return {
    sl:  close - dir * effectiveSL,
    tp1: close + dir * effectiveSL,
    tp2: close + dir * effectiveSL * 2,
    tp3: close + dir * effectiveSL * 3,
    rr:  1.00,
    effectiveSL,
  };
}

// ── Main signal computation ───────────────────────────────────────────────────

/**
 * Compute a signal for the last bar in `bars`.
 * @param {Array}  bars    - 1m OHLCV bars, oldest first: {timestamp,open,high,low,close,volume}
 * @param {Array}  htfBars - 15m OHLCV bars, same format
 * @param {Object} cfg     - optional parameter overrides
 * @returns signal object or null
 */
function computeSignal(bars, htfBars, cfg = {}) {
  const C = {
    slPts:          cfg.slPts          ?? 25,
    minScore:       cfg.minScore       ?? 8,
    oteHigh:        cfg.oteHigh        ?? 0.786,
    oteLow:         cfg.oteLow         ?? 0.618,
    swingLook:      cfg.swingLook      ?? 20,
    stdvLen:        cfg.stdvLen        ?? 20,
    std2:           cfg.std2           ?? 2.0,
    std1:           cfg.std1           ?? 1.0,
    htfEmaF:        cfg.htfEmaF        ?? 9,
    htfEmaS:        cfg.htfEmaS        ?? 21,
    atrLen:         cfg.atrLen         ?? 14,
    swingL:         cfg.swingL         ?? 7,
    emaF:           cfg.emaF           ?? 9,
    emaS:           cfg.emaS           ?? 21,
    emaT:           cfg.emaT           ?? 50,
    rthOnly:        cfg.rthOnly        ?? false,
    // Instrument + style
    instrument:     cfg.instrument     ?? 'MNQ',
    tradeStyleMode: cfg.tradeStyleMode ?? 'auto',  // 'auto'|'scalp'|'intraday'|'swing'
    swingTp1:       cfg.swingTp1       ?? 50,
    swingTp2:       cfg.swingTp2       ?? 100,
    swingTp3:       cfg.swingTp3       ?? 150,
  };

  const n = bars.length;
  if (n < 60 || htfBars.length < 30) return null;

  const closes   = bars.map(b => b.close);
  const highs    = bars.map(b => b.high);
  const lows     = bars.map(b => b.low);
  const opens    = bars.map(b => b.open);
  const volumes  = bars.map(b => b.volume || 1);
  const htfClose = htfBars.map(b => b.close);

  // ── Indicators ──────────────────────────────────────────────────────────────
  const atrV    = calcAtr(bars, C.atrLen);
  const atrSmaV = sma(atrV.map(v => v ?? 0), 20);
  const volAvgV = sma(volumes, 20);
  const vwapV   = calcVwap(bars);
  const stdvV   = rollingStdev(closes, C.stdvLen);

  const htfEmaFV = ema(htfClose, C.htfEmaF);
  const htfEmaSV = ema(htfClose, C.htfEmaS);

  const i = n - 1;
  const { close, high, low, open, volume, timestamp } = bars[i];

  const atrVal = atrV[i]   ?? 1;
  const vwap   = vwapV[i];
  const sdv    = stdvV[i]  ?? 1;
  const upp1   = vwap + sdv * C.std1, dwn1 = vwap - sdv * C.std1;
  const upp2   = vwap + sdv * C.std2, dwn2 = vwap - sdv * C.std2;
  const abvV1  = close > upp1, abvV2 = close > upp2;
  const blwV1  = close < dwn1, blwV2 = close < dwn2;
  const atVwap = Math.abs(close - vwap) < sdv * 0.3;

  // ATR expansion / compression state
  const atrSma20    = atrSmaV[i] ?? atrVal;
  const atrExpanded = atrVal > atrSma20 * 1.25;

  // STDV extension memory (20-bar rolling lookback)
  // Reset only when price crosses to the opposite side — not merely near VWAP
  let hadExtUp = false, hadExtDn = false;
  for (let j = Math.max(0, i - 20); j < i; j++) {
    const c = closes[j], sv = stdvV[j] ?? 0, vv = vwapV[j];
    if (c > vv + sv * C.std2) hadExtUp = true;
    if (c < vv - sv * C.std2) hadExtDn = true;
    if (hadExtUp && c < vv - sv * 0.5) hadExtUp = false;
    if (hadExtDn && c > vv + sv * 0.5) hadExtDn = false;
  }
  const rstL = hadExtDn && blwV1 && !blwV2;
  const rstS = hadExtUp && abvV1 && !abvV2;

  // OTE zones
  const lb  = Math.min(C.swingLook, i);
  const swH = Math.max(...highs.slice(i - lb, i + 1));
  const swL = Math.min(...lows.slice(i - lb,  i + 1));
  const swR = swH - swL;
  const odL = swL + swR * (1 - C.oteHigh), odH = swL + swR * (1 - C.oteLow);
  const opL = swL + swR * C.oteLow,        opH = swL + swR * C.oteHigh;
  const inOTED   = close >= odL && close <= odH;
  const inOTEP   = close >= opL && close <= opH;
  const nearOTED = close >= odL - atrVal*0.5 && close <= odH + atrVal*0.3;
  const nearOTEP = close >= opL - atrVal*0.3 && close <= opH + atrVal*0.5;

  // Candle analysis
  const cRng = high - low, cBody = Math.abs(close - open);
  const bull = close > open, bear = !bull;
  const cLoc = cRng > 0 ? (close - low) / cRng : 0.5;
  const lW   = Math.min(open, close) - low, uW = high - Math.max(open, close);
  const lWR  = cRng > 0 ? lW / cRng : 0, uWR = cRng > 0 ? uW / cRng : 0;
  const spike = cRng >= 4.5 * atrVal;
  const dB    = cBody >= 0.3*atrVal && cLoc >= 0.55 && bull && !spike;   // relaxed: 0.5→0.3 body, 0.62→0.55 loc
  const dBr   = cBody >= 0.3*atrVal && cLoc <= 0.45 && bear && !spike;   // relaxed: 0.5→0.3 body, 0.38→0.45 loc
  const rU    = lWR >= 0.25 && lW > cBody * 0.2;   // relaxed: 0.33→0.25 ratio, 0.4→0.2 size
  const rD    = uWR >= 0.25 && uW > cBody * 0.2;
  const mB    = close > highs[i-1] && bull;
  const mBr   = close < lows[i-1]  && bear;
  const vUp   = volume > (volAvgV[i] ?? 0) * 1.05; // relaxed: 1.2→1.05

  // Chop filter — 1.0× ATR: only block truly dead/flatline markets
  const cH   = Math.max(...highs.slice(Math.max(0,i-14), i+1));
  const cL   = Math.min(...lows.slice(Math.max(0,i-14),  i+1));
  const chop = (cH - cL) < atrVal * 1.0;

  // Pivot highs/lows → market structure
  const sl = C.swingL;
  const pH = [], pL = [];
  for (let j = sl; j < n - sl; j++) {
    if (highs[j] === Math.max(...highs.slice(j-sl, j+sl+1))) pH.push(highs[j]);
    if (lows[j]  === Math.min(...lows.slice(j-sl,  j+sl+1))) pL.push(lows[j]);
  }
  const [sh1, sh0] = pH.slice(-2);
  const [sl1, sl0] = pL.slice(-2);
  const msB  = sh0&&sh1&&sl0&&sl1 && sh0>sh1&&sl0>sl1;
  const msBr = sh0&&sh1&&sl0&&sl1 && sh0<sh1&&sl0<sl1;
  const eqTol = atrVal * 0.18;
  const eqH   = sh0&&sh1 && Math.abs(sh0-sh1) <= eqTol;
  const eqL   = sl0&&sl1 && Math.abs(sl0-sl1) <= eqTol;

  // Liquidity sweeps
  const rH   = Math.max(...highs.slice(Math.max(0,i-sl*2), i+1));
  const rL   = Math.min(...lows.slice(Math.max(0, i-sl*2), i+1));
  const swpL = low < rL && close > rL && bull && !spike;
  const swpH = high > rH && close < rH && bear && !spike;

  // HTF bias (last 15m bar)
  const hj    = htfBars.length - 1;
  const htfEF = htfEmaFV[hj], htfES = htfEmaSV[hj], htfC = htfClose[hj];
  const htfBull     = htfEF > htfES && htfC > htfES;  // strict: EMA + price confirmation
  const htfBear     = htfEF < htfES && htfC < htfES;
  const htfWeakBull = htfEF > htfES;                  // looser: EMA alignment only
  const htfWeakBear = htfEF < htfES;
  const htfNeutral  = !htfWeakBull && !htfWeakBear;
  const htfBiasStr  = htfBull ? 'BULL ▲' : htfBear ? 'BEAR ▼'
                    : htfWeakBull ? 'WEAK BULL' : htfWeakBear ? 'WEAK BEAR' : 'NEUTRAL';

  // HTF trend strength (close-to-close change relative to ATR)
  const trendStrength = hj > 0
    ? Math.abs(htfClose[hj] - htfClose[hj - 1]) / (atrVal * 15 + 1)
    : 0;

  // Session
  const sess = getSessionInfo(timestamp);
  if (C.rthOnly && !sess.sessOK) return null;

  // ── Setup conditions (relaxed for adequate signal frequency) ────────────────
  // OTE PB: accept near-OTE zone, simpler candle req (dB OR rU, not both)
  const s1L  = (htfBull || htfWeakBull) && (inOTED || nearOTED) && (dB || rU) && !chop;
  const s1S  = (htfBear || htfWeakBear) && (inOTEP || nearOTEP) && (dBr || rD) && !chop;
  // STDV REV: only block strict strong HTF trend (not weak), fire on any candle signal
  const s2L  = blwV2 && (rU || dB) && !htfBull;   // was !htfWeakBull — too restrictive
  const s2S  = abvV2 && (rD || dBr) && !htfBear;  // was !htfWeakBear
  // STDV RST: accept rejection wicks too
  const s2CL = rstL && (htfBull || htfWeakBull) && (dB || mB || rU);
  const s2CS = rstS && (htfBear || htfWeakBear) && (dBr || mBr || rD);
  // OTE+STDV: relax to weak HTF, include near-OTE
  const s3L  = (htfBull || htfWeakBull) && (inOTED || nearOTED) && blwV1 && (dB || rU) && !chop;
  const s3S  = (htfBear || htfWeakBear) && (inOTEP || nearOTEP) && abvV1 && (dBr || rD) && !chop;

  const anyL = s1L || s2L || s2CL || s3L;
  const anyS = s1S || s2S || s2CS || s3S;
  if (!anyL && !anyS) return null;

  const direction = anyL ? 'LONG' : 'SHORT';
  const setup     = direction === 'LONG'
    ? (s3L ? 'OTE+STDV' : s1L ? 'OTE PB' : s2CL ? 'STDV RST' : 'STDV REV')
    : (s3S ? 'OTE+STDV' : s1S ? 'OTE PB' : s2CS ? 'STDV RST' : 'STDV REV');

  // ── Factor scoring ───────────────────────────────────────────────────────────
  const sc  = sess.sessScore;
  const f1L = htfBull ? 6 : htfWeakBull ? 3 : 0;
  const f1S = htfBear ? 6 : htfWeakBear ? 3 : 0;
  const f2L = inOTED ? 7 : nearOTED ? 4 : 0;
  const f2S = inOTEP ? 7 : nearOTEP ? 4 : 0;
  const f3L = blwV2 ? 7 : blwV1 ? 4 : rstL ? 5 : atVwap ? 2 : 0;
  const f3S = abvV2 ? 7 : abvV1 ? 4 : rstS ? 5 : atVwap ? 2 : 0;
  const f4L = (dB ? 4 : rU ? 3 : 0) + (mB  ? 1 : 0) + (vUp ? 1 : 0);
  const f4S = (dBr? 4 : rD ? 3 : 0) + (mBr ? 1 : 0) + (vUp ? 1 : 0);
  const bL  = (s3L?4:0) + (msB?2:0)  + (eqL?2:0) + (swpL?2:0) + sc;
  const bS  = (s3S?4:0) + (msBr?2:0) + (eqH?2:0) + (swpH?2:0) + sc;

  const scoreL = anyL ? Math.min(f1L+f2L+f3L+f4L+bL, 35) : 0;
  const scoreS = anyS ? Math.min(f1S+f2S+f3S+f4S+bS, 35) : 0;
  const score  = direction === 'LONG' ? scoreL : scoreS;

  if (score < C.minScore) return null;

  const grade    = score >= 20 ? 'A+' : score >= 8 ? 'A' : null;
  if (!grade) return null;

  const isAplus = grade === 'A+';

  // ── Trade style detection ────────────────────────────────────────────────────
  const tradeStyle = detectTradeStyle(C.instrument, C.tradeStyleMode, direction, {
    htfBull, htfBear, msB, msBr, inOTED, inOTEP,
    atrExpanded, blwV2, abvV2, trendStrength,
  });

  // MGC: skip swing attempts — scalp only
  if (C.instrument === 'MGC' && tradeStyle === 'swing') return null;

  // ── Style-specific SL / TP ───────────────────────────────────────────────────
  const levels = calcStyleLevels(close, direction, tradeStyle, C.slPts,
    C.swingTp1, C.swingTp2, C.swingTp3);

  // Win probability (style-adjusted)
  const styleWpAdj = tradeStyle === 'scalp' ? 0.03 : tradeStyle === 'swing' ? -0.04 : 0;
  const wp1 = Math.min(0.92, Math.max(0.35,
    calcWinProb(score, isAplus, sess.sessQ, setup) + styleWpAdj));

  const tickerMap = { MNQ: 'MNQ1!', MGC: 'MGC1!', NQ: 'NQ1!' };
  const ticker    = tickerMap[C.instrument] ?? 'NQ1!';

  return {
    ticker, timeframe: '1', direction, grade, setup,
    instrument:   C.instrument,
    tradeStyle,
    entry:        close,
    sl:           levels.sl,
    tp1:          levels.tp1,
    tp2:          levels.tp2,
    tp3:          levels.tp3,
    rr:           levels.rr,
    effectiveSL:  levels.effectiveSL,
    score,
    win_prob_tp1: Math.round(wp1 * 100),
    win_prob_tp2: Math.round(wp1 * 0.72 * 100),
    win_prob_tp3: Math.round(wp1 * 0.50 * 100),
    htf_bias:     htfBiasStr,
    session:      sess.sessName,
    timestamp,
  };
}

// ── Diagnostic signal analysis ────────────────────────────────────────────────
/**
 * Returns a structured breakdown of every condition that was checked,
 * including which ones passed and which caused the signal to be rejected.
 * Used by the scanner to log WHY a signal did or did not fire.
 *
 * @param {Array}  bars    - 1m OHLCV bars
 * @param {Array}  htfBars - 15m OHLCV bars
 * @param {Object} cfg     - same cfg as computeSignal
 * @returns {{ fired: boolean, signal: object|null, indicators: object, setups: object, scores: object, rejectReasons: string[] }}
 */
function diagnoseSignal(bars, htfBars, cfg = {}) {
  const reasons = [];

  if (bars.length < 60)      { reasons.push(`insufficient 1m bars: ${bars.length} < 60`); }
  if (htfBars.length < 30)   { reasons.push(`insufficient 15m bars: ${htfBars.length} < 30`); }
  if (reasons.length) return { fired: false, rejectReasons: reasons, indicators: {}, setups: {}, scores: {} };

  const C = {
    slPts: cfg.slPts ?? 25, minScore: cfg.minScore ?? 12,
    oteHigh: cfg.oteHigh ?? 0.786, oteLow: cfg.oteLow ?? 0.618,
    swingLook: cfg.swingLook ?? 20, stdvLen: cfg.stdvLen ?? 20,
    std2: cfg.std2 ?? 2.0, std1: cfg.std1 ?? 1.0,
    htfEmaF: cfg.htfEmaF ?? 9, htfEmaS: cfg.htfEmaS ?? 21,
    atrLen: cfg.atrLen ?? 14, swingL: cfg.swingL ?? 7,
    rthOnly: cfg.rthOnly ?? false, instrument: cfg.instrument ?? 'MNQ',
  };

  const n = bars.length;
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high);
  const lows   = bars.map(b => b.low),  opens  = bars.map(b => b.open);
  const volumes = bars.map(b => b.volume || 1);
  const htfClose = htfBars.map(b => b.close);
  const i = n - 1;
  const { close, high, low, open, volume, timestamp } = bars[i];

  const atrV    = calcAtr(bars, C.atrLen);
  const vwapV   = calcVwap(bars);
  const stdvV   = rollingStdev(closes, C.stdvLen);
  const atrSmaV = sma(atrV.map(v => v ?? 0), 20);
  const volAvgV = sma(volumes, 20);

  const htfEmaFV = ema(htfClose, C.htfEmaF);
  const htfEmaSV = ema(htfClose, C.htfEmaS);

  const atrVal = atrV[i] ?? 1;
  const vwap   = vwapV[i];
  const sdv    = stdvV[i] ?? 1;
  const upp2   = vwap + sdv * C.std2, dwn2 = vwap - sdv * C.std2;
  const upp1   = vwap + sdv * C.std1, dwn1 = vwap - sdv * C.std1;
  const abvV2  = close > upp2, blwV2 = close < dwn2;
  const abvV1  = close > upp1, blwV1 = close < dwn1;
  const atVwap = Math.abs(close - vwap) < sdv * 0.3;
  const atrSma20    = atrSmaV[i] ?? atrVal;
  const atrExpanded = atrVal > atrSma20 * 1.25;

  let hadExtUp = false, hadExtDn = false;
  for (let j = Math.max(0, i - 20); j < i; j++) {
    const c = closes[j], sv = stdvV[j] ?? 0, vv = vwapV[j];
    if (c > vv + sv * C.std2) hadExtUp = true;
    if (c < vv - sv * C.std2) hadExtDn = true;
    if (hadExtUp && c < vv - sv * 0.5) hadExtUp = false;
    if (hadExtDn && c > vv + sv * 0.5) hadExtDn = false;
  }
  const rstL = hadExtDn && blwV1 && !blwV2;
  const rstS = hadExtUp && abvV1 && !abvV2;

  const lb  = Math.min(C.swingLook, i);
  const swH = Math.max(...highs.slice(i - lb, i + 1));
  const swL = Math.min(...lows.slice(i - lb,  i + 1));
  const swR = swH - swL;
  const odL = swL + swR * (1 - C.oteHigh), odH = swL + swR * (1 - C.oteLow);
  const opL = swL + swR * C.oteLow,        opH = swL + swR * C.oteHigh;
  const inOTED = close >= odL && close <= odH;
  const inOTEP = close >= opL && close <= opH;

  const cRng = high - low, cBody = Math.abs(close - open);
  const bull = close > open;
  const cLoc = cRng > 0 ? (close - low) / cRng : 0.5;
  const lW = Math.min(open, close) - low, uW = high - Math.max(open, close);
  const lWR = cRng > 0 ? lW / cRng : 0, uWR = cRng > 0 ? uW / cRng : 0;
  const spike = cRng >= 4.5 * atrVal;
  const dB   = cBody >= 0.3*atrVal && cLoc >= 0.55 && bull && !spike;
  const dBr  = cBody >= 0.3*atrVal && cLoc <= 0.45 && !bull && !spike;
  const rU   = lWR >= 0.25 && lW > cBody * 0.2;
  const rD   = uWR >= 0.25 && uW > cBody * 0.2;
  const mB   = close > highs[i-1] && bull;
  const mBr  = close < lows[i-1]  && !bull;
  const vUp  = volume > (volAvgV[i] ?? 0) * 1.05;

  const cH   = Math.max(...highs.slice(Math.max(0,i-14), i+1));
  const cLv  = Math.min(...lows.slice(Math.max(0,i-14),  i+1));
  const chop = (cH - cLv) < atrVal * 1.0;

  const hj   = htfBars.length - 1;
  const htfEF = htfEmaFV[hj], htfES = htfEmaSV[hj], htfC = htfClose[hj];
  const htfBull     = htfEF > htfES && htfC > htfES;
  const htfBear     = htfEF < htfES && htfC < htfES;
  const htfWeakBull = htfEF > htfES;
  const htfWeakBear = htfEF < htfES;
  const htfBiasStr  = htfBull ? 'BULL ▲' : htfBear ? 'BEAR ▼'
                    : htfWeakBull ? 'WEAK BULL' : htfWeakBear ? 'WEAK BEAR' : 'NEUTRAL';

  const sess = getSessionInfo(timestamp);
  if (C.rthOnly && !sess.sessOK) reasons.push('rthOnly filter: outside RTH session');

  const nearOTED = close >= odL - atrVal*0.5 && close <= odH + atrVal*0.3;
  const nearOTEP = close >= opL - atrVal*0.3 && close <= opH + atrVal*0.5;

  const s1L  = (htfBull || htfWeakBull) && (inOTED || nearOTED) && (dB || rU) && !chop;
  const s1S  = (htfBear || htfWeakBear) && (inOTEP || nearOTEP) && (dBr || rD) && !chop;
  const s2L  = blwV2 && (rU || dB) && !htfBull;
  const s2S  = abvV2 && (rD || dBr) && !htfBear;
  const s2CL = rstL && (htfBull || htfWeakBull) && (dB || mB || rU);
  const s2CS = rstS && (htfBear || htfWeakBear) && (dBr || mBr || rD);
  const s3L  = (htfBull || htfWeakBull) && (inOTED || nearOTED) && blwV1 && (dB || rU) && !chop;
  const s3S  = (htfBear || htfWeakBear) && (inOTEP || nearOTEP) && abvV1 && (dBr || rD) && !chop;

  const anyL = s1L || s2L || s2CL || s3L;
  const anyS = s1S || s2S || s2CS || s3S;

  const f1L = htfBull ? 6 : htfWeakBull ? 3 : 0;
  const f1S = htfBear ? 6 : htfWeakBear ? 3 : 0;
  const f2L = inOTED ? 7 : nearOTED ? 4 : 0; const f2S = inOTEP ? 7 : nearOTEP ? 4 : 0;
  const f3L = blwV2 ? 7 : blwV1 ? 4 : rstL ? 5 : atVwap ? 2 : 0;
  const f3S = abvV2 ? 7 : abvV1 ? 4 : rstS ? 5 : atVwap ? 2 : 0;
  const f4L = (dB ? 4 : rU ? 3 : 0) + (mB  ? 1 : 0) + (vUp ? 1 : 0);
  const f4S = (dBr? 4 : rD ? 3 : 0) + (mBr ? 1 : 0) + (vUp ? 1 : 0);
  const sl = C.swingL;
  const pH = [], pL = [];
  for (let j = sl; j < n - sl; j++) {
    if (highs[j] === Math.max(...highs.slice(j-sl, j+sl+1))) pH.push(highs[j]);
    if (lows[j]  === Math.min(...lows.slice(j-sl,  j+sl+1))) pL.push(lows[j]);
  }
  const [sh1, sh0] = pH.slice(-2); const [sl1, sl0] = pL.slice(-2);
  const msB  = sh0&&sh1&&sl0&&sl1 && sh0>sh1&&sl0>sl1;
  const msBr = sh0&&sh1&&sl0&&sl1 && sh0<sh1&&sl0<sl1;
  const eqTol = atrVal * 0.18;
  const eqH  = sh0&&sh1 && Math.abs(sh0-sh1) <= eqTol;
  const eqL  = sl0&&sl1 && Math.abs(sl0-sl1) <= eqTol;
  const rH   = Math.max(...highs.slice(Math.max(0,i-sl*2), i+1));
  const rLv  = Math.min(...lows.slice(Math.max(0,i-sl*2),  i+1));
  const swpL = low < rLv && close > rLv && bull && !spike;
  const swpH = high > rH  && close < rH  && !bull && !spike;
  const bL = (s3L?4:0)+(msB?2:0) +(eqL?2:0)+(swpL?2:0)+sess.sessScore;
  const bS = (s3S?4:0)+(msBr?2:0)+(eqH?2:0)+(swpH?2:0)+sess.sessScore;
  const scoreL = anyL ? Math.min(f1L+f2L+f3L+f4L+bL, 35) : 0;
  const scoreS = anyS ? Math.min(f1S+f2S+f3S+f4S+bS, 35) : 0;

  if (!anyL && !anyS) {
    reasons.push('no setup condition met');
    reasons.push(`  OTE PB L:  htfWkBull=${htfWeakBull} ote=${inOTED||nearOTED} candle=${dB||rU} chop=${chop}`);
    reasons.push(`  OTE PB S:  htfWkBear=${htfWeakBear} ote=${inOTEP||nearOTEP} candle=${dBr||rD} chop=${chop}`);
    reasons.push(`  STDV REV L: blwV2=${blwV2} candle=${rU||dB} notStrictBull=${!htfBull}`);
    reasons.push(`  STDV REV S: abvV2=${abvV2} candle=${rD||dBr} notStrictBear=${!htfBear}`);
    reasons.push(`  STDV RST L: rstL=${rstL} htfWkBull=${htfBull||htfWeakBull} candle=${dB||mB||rU}`);
    reasons.push(`  STDV RST S: rstS=${rstS} htfWkBear=${htfBear||htfWeakBear} candle=${dBr||mBr||rD}`);
    reasons.push(`  OTE+STDV L: htfWkBull=${htfBull||htfWeakBull} ote=${inOTED||nearOTED} blwV1=${blwV1} candle=${dB||rU} chop=${chop}`);
    reasons.push(`  OTE+STDV S: htfWkBear=${htfBear||htfWeakBear} ote=${inOTEP||nearOTEP} abvV1=${abvV1} candle=${dBr||rD} chop=${chop}`);
  }

  const direction = anyL ? 'LONG' : anyS ? 'SHORT' : null;
  const score     = direction === 'LONG' ? scoreL : scoreS;

  if (direction && score < C.minScore)
    reasons.push(`score ${score} < minScore ${C.minScore}`);

  return {
    fired:         (anyL || anyS) && score >= C.minScore,
    signal:        (anyL || anyS) ? computeSignal(bars, htfBars, cfg) : null,
    rejectReasons: reasons,
    indicators: {
      htfBull, htfBear, htfWeakBull, htfWeakBear, htfBias: htfBiasStr,
      close: +close.toFixed(3), vwap: +vwap.toFixed(3), sdv: +sdv.toFixed(3),
      atr: +atrVal.toFixed(3), chop, atrExpanded,
      blwV1, blwV2, abvV1, abvV2, atVwap,
      inOTED, inOTEP, rstL, rstS, hadExtUp, hadExtDn,
      dB, dBr, rU, rD, mB, mBr, vUp, spike,
      oteZone: { odL: +odL.toFixed(3), odH: +odH.toFixed(3), opL: +opL.toFixed(3), opH: +opH.toFixed(3) },
      swingRange: { swH: +swH.toFixed(3), swL: +swL.toFixed(3) },
      session: sess.sessName,
    },
    setups: { s1L, s1S, s2L, s2S, s2CL, s2CS, s3L, s3S },
    scores: { scoreL, scoreS, minScore: C.minScore },
  };
}

module.exports = { computeSignal, diagnoseSignal, detectTradeStyle, calcStyleLevels };
