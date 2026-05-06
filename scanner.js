'use strict';

const Database              = require('better-sqlite3');
const path                  = require('path');
const fs                    = require('fs');
const { computeSignal, diagnoseSignal }   = require('./signal-engine');
const { runAllStrategies, diagnoseStrategies } = require('./strategies');
const { getAdaptiveMinScore, getMarketRegime } = require('./learning');
const { runBacktest }       = require('./backtest-engine');
const {
  getParams, saveBacktestRun, saveBacktestDetails,
  proposeRevision, evaluateShadow, multiObjectiveScore,
} = require('./strategy-params');
const { runFullOptimizationCycle } = require('./strategy-optimizer');

// ── Config ────────────────────────────────────────────────────────────────────
const DB_PATH        = process.env.DB_PATH           || path.join(__dirname, 'signals.db');
const NTFY_URL       = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC     = process.env.NTFY_TOPIC        || '';
const NTFY_TOKEN     = process.env.NTFY_TOKEN        || '';
const SYMBOL         = process.env.SCANNER_SYMBOL     || 'NQ=F';
const SYMBOL_MGC     = process.env.SCANNER_SYMBOL_MGC || 'GC=F';
const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL     || '60')  * 1000;
const COOLDOWN       = parseInt(process.env.SCANNER_COOLDOWN  || '1');
const RTH_ONLY       = process.env.SCANNER_RTH_ONLY === 'true';
const BASE_SCORE     = parseInt(process.env.SCANNER_MIN_SCORE || '8');

// Diagnostic verbosity: 'full' logs every scan; 'signal' logs only fires; 'quiet' errors only
const LOG_LEVEL = (process.env.SCANNER_LOG_LEVEL || 'full').toLowerCase();

const BT_SYMBOLS = { MNQ: process.env.SCANNER_BT_MNQ || 'NQ=F', MGC: process.env.SCANNER_BT_MGC || 'GC=F' };
const BT_INTERVAL_H  = parseFloat(process.env.BACKTEST_INTERVAL_H  || '4');
const BT_BARS        = parseInt(process.env.BACKTEST_BARS           || '10000');
const OPT_INTERVAL_H = parseFloat(process.env.OPTIMIZER_INTERVAL_H || '12');
const BT_SLIPPAGE    = parseFloat(process.env.BT_SLIPPAGE           || '0.5');
const BT_TARGET_TRADES = parseInt(process.env.BT_TARGET_TRADES      || '500');

// ── Database ──────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, entry, sl, tp1, tp2, tp3,
     score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
     trade_style, instrument, rr, raw_payload)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
     @trade_style, @instrument, @rr, @raw_payload)
`);

const upsertPrice = db.prepare(`
  INSERT INTO market_snapshots (symbol, price, open_price, change_pct, high_24h, low_24h, snapped_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(symbol) DO UPDATE SET
    price      = excluded.price,
    open_price = excluded.open_price,
    change_pct = excluded.change_pct,
    high_24h   = excluded.high_24h,
    low_24h    = excluded.low_24h,
    snapped_at = excluded.snapped_at
`);

const insertOutcome = db.prepare(`
  INSERT OR IGNORE INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts)
  VALUES (?, ?, ?, ?, ?)
`);

const getPendingSignals = db.prepare(`
  SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument
  FROM signals s
  LEFT JOIN outcomes o ON o.signal_id = s.id
  WHERE o.id IS NULL
    AND s.entry IS NOT NULL AND s.sl IS NOT NULL AND s.tp1 IS NOT NULL
    AND s.received_at <= datetime('now', '-3 minutes')
    AND s.received_at >= datetime('now', '-4 hours')
    AND s.instrument = ?
  ORDER BY s.received_at ASC
`);

// Prepared statements for diagnostic tables
const insertRejection = db.prepare(`
  INSERT INTO signal_rejections (instrument, direction, setup, strategy, score, min_score, reason, details)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertScanDiag = db.prepare(`
  INSERT INTO scan_diagnostics
    (instrument, last_close, htf_bias, chop, atr, score_l, score_s,
     any_setup_l, any_setup_s, fired, strategies_fired, reject_reason, indicators)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── ntfy push notifications ───────────────────────────────────────────────────
function sendNtfy(s) {
  if (!NTFY_TOPIC) return;
  const arrow    = s.direction === 'LONG' ? '▲' : '▼';
  const priority = s.grade === 'A+' ? 'urgent' : 'high';
  const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';
  const stratTag = s.source === 'strategy' ? `[${s.strategy ?? s.setup}] ` : '';
  const body = [
    s.setup        ? `Setup:   ${stratTag}${s.setup}`   : null,
    s.tradeStyle   ? `Style:   ${s.tradeStyle}`          : null,
    s.entry != null? `Entry:   ${s.entry}`               : null,
    s.sl    != null? `SL:      ${s.sl}`                  : null,
    s.tp1   != null? `TP1:     ${s.tp1}`                 : null,
    s.tp2   != null? `TP2:     ${s.tp2}`                 : null,
    s.tp3   != null? `TP3:     ${s.tp3}`                 : null,
    s.rr    != null? `RR:      ${s.rr}`                  : null,
    s.score != null? `Score:   ${s.score}`               : null,
    s.win_prob_tp1 != null ? `Win%:  ${s.win_prob_tp1}%` : null,
    s.session      ? `Session: ${s.session}`             : null,
  ].filter(Boolean).join('\n');
  const headers = {
    'Content-Type': 'text/plain',
    'Title':    `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker ?? s.instrument}`,
    'Priority': priority, 'Tags': tags,
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy]', err.message));
}

// ── Market data (Yahoo Finance) ───────────────────────────────────────────────
async function fetchYahooBars(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
    + `?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'NQ-Signal-Pro/3.0' } });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}: ${symbol}`);
  const json   = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) return [];
  const ts    = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  return ts.map((t, i) => ({
    timestamp: new Date(t * 1000).toISOString(),
    open:   quote.open?.[i],
    high:   quote.high?.[i],
    low:    quote.low?.[i],
    close:  quote.close?.[i],
    volume: quote.volume?.[i] ?? 0,
  })).filter(b => b.open != null && b.close != null);
}

function yahooInterval(tf) { return tf.startsWith('1M') ? '1m' : '15m'; }

async function fetchBarsForSymbol(symbol, timeframe, limit) {
  const interval = yahooInterval(timeframe);
  const range    = interval === '1m' ? '2d' : '5d';
  const bars     = await fetchYahooBars(symbol, interval, range);
  return bars.slice(-limit);
}

async function fetchAllBars(symbol, timeframe, maxBars) {
  const interval = yahooInterval(timeframe);
  const range    = interval === '1m' ? '7d' : '60d';
  const bars     = await fetchYahooBars(symbol, interval, range);
  return bars.slice(-maxBars);
}

function savePrice(symbol, bars) {
  if (!bars || bars.length < 2) return;
  const last  = bars[bars.length - 1];
  const first = bars[0];
  const chg   = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
  const high  = Math.max(...bars.map(b => b.high));
  const low   = Math.min(...bars.map(b => b.low));
  upsertPrice.run(symbol, last.close, first.open, +chg.toFixed(3), high, low);
}

// ── Cooldown tracking ─────────────────────────────────────────────────────────
const lastSignalTimes = { MNQ: 0, MGC: 0 };
let scanCount = 0;
// Track last diagnostic save per instrument (throttled to 1 per 5 minutes)
const lastDiagSave = { MNQ: 0, MGC: 0 };

// ── Auto-resolve pending outcomes ─────────────────────────────────────────────
function autoResolveOutcomes(bars1m, instrument) {
  const pending = getPendingSignals.all(instrument);
  if (!pending.length) return;

  for (const sig of pending) {
    const sigTime    = new Date(sig.received_at).getTime();
    const futureBars = bars1m.filter(b => new Date(b.timestamp).getTime() > sigTime);
    if (futureBars.length < 2) continue;

    let resolved = null, exitBar = null;
    for (const bar of futureBars) {
      if (sig.direction === 'LONG') {
        if (bar.high >= sig.tp1) { resolved = { result: 'WIN',  exitPrice: sig.tp1 }; exitBar = bar; break; }
        if (bar.low  <= sig.sl)  { resolved = { result: 'LOSS', exitPrice: sig.sl  }; exitBar = bar; break; }
      } else {
        if (bar.low  <= sig.tp1) { resolved = { result: 'WIN',  exitPrice: sig.tp1 }; exitBar = bar; break; }
        if (bar.high >= sig.sl)  { resolved = { result: 'LOSS', exitPrice: sig.sl  }; exitBar = bar; break; }
      }
    }
    if (resolved) {
      const pnlPts = sig.direction === 'LONG'
        ? resolved.exitPrice - sig.entry
        : sig.entry - resolved.exitPrice;
      insertOutcome.run(sig.id, resolved.result, resolved.exitPrice,
        exitBar?.timestamp ?? new Date().toISOString(), +pnlPts.toFixed(2));
      console.log(`[${ts()}] AUTO-RESOLVE #${sig.id} ${instrument}: ${sig.direction} → ${resolved.result} (${+pnlPts.toFixed(2)} pts)`);
    }
  }
}

// ── Store a fired signal ──────────────────────────────────────────────────────
function storeSignal(signal, minScore) {
  const info = insertSignal.run({
    ticker:       signal.ticker ?? `${signal.instrument}1!`,
    timeframe:    signal.timeframe ?? '1',
    direction:    signal.direction,
    grade:        signal.grade,
    setup:        signal.setup,
    entry:        signal.entry,
    sl:           signal.sl,
    tp1:          signal.tp1,
    tp2:          signal.tp2,
    tp3:          signal.tp3,
    score:        signal.score,
    win_prob_tp1: signal.win_prob_tp1,
    win_prob_tp2: signal.win_prob_tp2,
    win_prob_tp3: signal.win_prob_tp3,
    htf_bias:     signal.htf_bias    ?? signal.htfBias ?? null,
    session:      signal.session,
    trade_style:  signal.tradeStyle  ?? signal.trade_style ?? null,
    instrument:   signal.instrument,
    rr:           signal.rr,
    raw_payload:  JSON.stringify(signal),
  });

  console.log(
    `[${ts()}] ✅ SIGNAL #${info.lastInsertRowid} | ${signal.instrument} ${signal.direction} ${signal.grade} | ` +
    `${signal.setup} [${signal.tradeStyle ?? signal.source ?? 'unknown'}] | ` +
    `score=${signal.score}/${minScore} | entry=${signal.entry} | rr=${signal.rr}`
  );
  sendNtfy(signal);
  return info.lastInsertRowid;
}

// ── Store rejected signal reason ──────────────────────────────────────────────
function storeRejection(instrument, direction, setup, strategy, score, minScore, reason, indicators) {
  try {
    insertRejection.run(
      instrument, direction ?? null, setup ?? null, strategy ?? null,
      score ?? null, minScore ?? null, reason,
      indicators ? JSON.stringify(indicators) : null
    );
  } catch { /* diagnostic failures must never crash the scanner */ }
}

// ── Store scan diagnostic snapshot (throttled to 1/5min per instrument) ──────
function storeScanDiag(instrument, diag, stratsFired, fired, rejectReason) {
  const now = Date.now();
  if (now - (lastDiagSave[instrument] ?? 0) < 5 * 60_000) return; // 5-min throttle
  lastDiagSave[instrument] = now;
  try {
    insertScanDiag.run(
      instrument,
      diag.indicators?.close   ?? null,
      diag.indicators?.htfBias ?? null,
      diag.indicators?.chop    ? 1 : 0,
      diag.indicators?.atr     ?? null,
      diag.scores?.scoreL      ?? null,
      diag.scores?.scoreS      ?? null,
      diag.setups ? (Object.values(diag.setups).some((v, i) => i < 4 && v) ? 1 : 0) : 0,
      diag.setups ? (Object.values(diag.setups).some((v, i) => i >= 4 && v) ? 1 : 0) : 0,
      fired ? 1 : 0,
      stratsFired.length ? JSON.stringify(stratsFired) : null,
      rejectReason ?? null,
      diag.indicators ? JSON.stringify(diag.indicators) : null
    );
  } catch { /* diagnostic failures must never crash the scanner */ }
}

// ── Per-instrument signal scan ────────────────────────────────────────────────
async function scanInstrument(symbol, instrument, bars1m, bars15m) {
  const barMs = 60_000;
  if (Date.now() - (lastSignalTimes[instrument] ?? 0) < COOLDOWN * barMs) return;

  // Load optimised strategy params from DB (falls back to defaults if none saved)
  const dbParams = getParams(db, instrument);

  // ── 1. Primary 4-factor signal engine ────────────────────────────────────
  const signal = computeSignal(bars1m, bars15m, {
    ...dbParams,
    rthOnly:  RTH_ONLY,
    instrument,
  });

  // Diagnostic breakdown (also used for logging regardless of signal)
  const diag = diagnoseSignal(bars1m, bars15m, {
    ...dbParams,
    rthOnly:  RTH_ONLY,
    instrument,
  });

  // ── 2. 5-strategy engine ─────────────────────────────────────────────────
  const stratResults = diagnoseStrategies(bars1m, instrument);
  const stratSignals = stratResults.filter(r => r.fired && r.signal);
  const stratsFiredNames = stratSignals.map(r => r.strategy);

  // ── 3. Evaluate primary signal ────────────────────────────────────────────
  let primaryFired = false;
  if (signal) {
    const minScore = getAdaptiveMinScore(db, signal.setup, signal.tradeStyle, dbParams.minScore ?? BASE_SCORE);
    if (signal.score >= minScore) {
      lastSignalTimes[instrument] = Date.now();
      storeSignal({ ...signal, source: 'primary', ticker: `${instrument}1!` }, minScore);
      primaryFired = true;
    } else {
      const reason = `adaptive score filter: ${signal.score} < ${minScore} (setup=${signal.setup})`;
      if (LOG_LEVEL === 'full') {
        console.log(`[${ts()}] ⚠️  Suppressed ${instrument} ${signal.setup} — ${reason}`);
      }
      storeRejection(instrument, signal.direction, signal.setup, 'primary',
        signal.score, minScore, reason, diag.indicators);
    }
  }

  // ── 4. Evaluate strategy signals ─────────────────────────────────────────
  let stratFiredCount = 0;
  for (const result of stratResults) {
    if (result.fired && result.signal) {
      const sig      = result.signal;
      const minScore = getAdaptiveMinScore(db, sig.setup, null, BASE_SCORE);
      if (sig.score >= minScore) {
        // Respect per-instrument cooldown for strategy signals too
        if (Date.now() - (lastSignalTimes[instrument] ?? 0) < COOLDOWN * barMs) {
          if (LOG_LEVEL === 'full') {
            console.log(`[${ts()}] ⏳ Cooldown: strategy ${result.strategy} ${instrument} suppressed`);
          }
          continue;
        }
        lastSignalTimes[instrument] = Date.now();
        storeSignal({
          ...sig, source: 'strategy', instrument,
          ticker: `${instrument}1!`,
          htf_bias: diag.indicators?.htfBias ?? null,
        }, minScore);
        stratFiredCount++;
      } else {
        const reason = `score ${sig.score} < min ${minScore}`;
        if (LOG_LEVEL === 'full') {
          console.log(`[${ts()}] ⚠️  Strategy ${result.strategy} ${instrument} rejected — ${reason}`);
        }
        storeRejection(instrument, sig.direction, sig.setup, result.strategy,
          sig.score, minScore, reason, null);
      }
    } else if (!result.fired && LOG_LEVEL === 'full') {
      console.log(`[${ts()}] ⬜ ${instrument} ${result.strategy}: ${result.reason ?? result.error ?? 'no signal'}`);
    }
  }

  // ── 5. Diagnostic log ─────────────────────────────────────────────────────
  const totalFired = primaryFired || stratFiredCount > 0;

  if (LOG_LEVEL === 'full') {
    const ind = diag.indicators ?? {};
    const regime = getMarketRegime(db);
    const parts = [
      `htf=${ind.htfBias ?? '?'}`,
      `chop=${ind.chop ? '⛔' : '✅'}`,
      `atr=${ind.atr ?? '?'}`,
      `close=${ind.close ?? '?'}`,
      `blwV2=${ind.blwV2} blwV1=${ind.blwV1} abvV2=${ind.abvV2}`,
      `inOTED=${ind.inOTED} inOTEP=${ind.inOTEP}`,
      `dB=${ind.dB} dBr=${ind.dBr} rU=${ind.rU} rD=${ind.rD} mB=${ind.mB}`,
      `rstL=${ind.rstL} rstS=${ind.rstS}`,
      `scoreL=${diag.scores?.scoreL ?? 0} scoreS=${diag.scores?.scoreS ?? 0}`,
      `regime=${regime}`,
      `strats=${stratsFiredNames.length ? stratsFiredNames.join(',') : 'none'}`,
    ];
    console.log(`[${ts()}] 📊 ${instrument} | ${parts.join(' | ')}`);

    if (!totalFired && diag.rejectReasons?.length) {
      console.log(`[${ts()}] ❌ ${instrument} no signal — reasons:`);
      for (const r of diag.rejectReasons) console.log(`         ${r}`);
    }
  } else if (!totalFired && LOG_LEVEL === 'signal') {
    // In signal-only mode, log concise rejection summary once every ~10 scans
    if (scanCount % 10 === 0) {
      const top = diag.rejectReasons?.[0] ?? 'no setup met';
      console.log(`[${ts()}] ${instrument} — no signal (${top})`);
    }
  }

  // Throttled persistence of scan diagnostics
  const rejectReason = !totalFired ? (diag.rejectReasons?.[0] ?? 'no setup') : null;
  storeScanDiag(instrument, diag, stratsFiredNames, totalFired, rejectReason);
}

// ── Live scan ─────────────────────────────────────────────────────────────────
async function scan() {
  scanCount++;
  try {
    const [mnqBars1m, mnqBars15m, mgcBars1m, mgcBars15m] = await Promise.all([
      fetchBarsForSymbol(SYMBOL,     '1Min',  120),
      fetchBarsForSymbol(SYMBOL,     '15Min',  60),
      fetchBarsForSymbol(SYMBOL_MGC, '1Min',  120),
      fetchBarsForSymbol(SYMBOL_MGC, '15Min',  60),
    ]);

    if (mnqBars1m.length >= 2) savePrice(SYMBOL,     mnqBars1m);
    if (mgcBars1m.length >= 2) savePrice(SYMBOL_MGC, mgcBars1m);

    const mnqReady = mnqBars1m.length >= 60 && mnqBars15m.length >= 30;
    const mgcReady = mgcBars1m.length >= 60 && mgcBars15m.length >= 30;

    if (!mnqReady && !mgcReady) {
      console.log(`[${ts()}] ⏳ Waiting for bars: MNQ ${mnqBars1m.length} 1m, MGC ${mgcBars1m.length} 1m`);
      return;
    }

    await Promise.all([
      mnqReady ? scanInstrument(SYMBOL,     'MNQ', mnqBars1m, mnqBars15m) : Promise.resolve(),
      mgcReady ? scanInstrument(SYMBOL_MGC, 'MGC', mgcBars1m, mgcBars15m) : Promise.resolve(),
    ]);

    if (mnqReady) autoResolveOutcomes(mnqBars1m, 'MNQ');
    if (mgcReady) autoResolveOutcomes(mgcBars1m, 'MGC');

  } catch (err) {
    console.error(`[${ts()}] Scan error:`, err.message);
  }
}

// ── Quick backtest cycle ──────────────────────────────────────────────────────
async function runBacktestCycle(instrument, triggeredBy = 'scheduled') {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] BACKTEST START: ${instrument} (up to ${BT_BARS} bars, target ${BT_TARGET_TRADES} trades)`);

    const pendingShadow = db.prepare(
      `SELECT id FROM strategy_revisions WHERE instrument=? AND status='shadow' LIMIT 1`
    ).get(instrument);

    if (pendingShadow) {
      const barsForShadow = await fetchAllBars(symbol, '1Min', BT_BARS);
      if (barsForShadow.length >= 100) {
        savePrice(symbol, barsForShadow);
        const result = evaluateShadow(db, instrument, barsForShadow, { slippage: BT_SLIPPAGE });
        if (result?.promoted) {
          console.log(`[${ts()}] ✅ REVISION PROMOTED: ${instrument} ${(result.before*100).toFixed(1)}% → ${(result.after*100).toFixed(1)}%`);
        } else if (result) {
          console.log(`[${ts()}] Shadow discarded for ${instrument}`);
        }
      }
      return;
    }

    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 100) {
      console.log(`[${ts()}] BACKTEST SKIP: insufficient bars (${bars1m.length})`);
      return;
    }

    savePrice(symbol, bars1m);

    const params = getParams(db, instrument);
    const result = runBacktest(bars1m, params, {
      targetTrades: BT_TARGET_TRADES,
      slippage:     BT_SLIPPAGE,
      walkForward:  true,
    });
    const { metrics } = result;
    metrics.barsScanned = bars1m.length;

    const runId = saveBacktestRun(db, instrument, params, metrics, triggeredBy);

    const lossTrades = result.signalLog.slice(0, 200); // store all trades (WIN+LOSS+BE) for better learning
    if (lossTrades.length > 0) {
      const insLoss = db.prepare(`
        INSERT INTO backtest_trades
          (run_id, instrument, bar_idx, timestamp, direction, setup, trade_style, regime, entry, sl, tp1, outcome, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (const t of lossTrades) {
          insLoss.run(runId, instrument, t.bar ?? null, t.timestamp ?? null, t.direction,
            t.setup ?? null, t.tradeStyle ?? null, t.regime ?? null,
            t.entry ?? null, t.sl ?? null, t.tp1 ?? null, t.outcome, t.score ?? null);
        }
      })();
    }

    saveBacktestDetails(db, runId, {
      byRegime:               metrics.byRegime,
      byStyle:                metrics.byStyle,
      bySetup:                metrics.bySetup,
      walkForwardConsistency: result.walkForward?.consistency ?? null,
      walkForwardAvgWR:       result.walkForward?.avgWinRate  ?? null,
      maxWinStreak:           metrics.maxWinStreak,
      maxLossStreak:          metrics.maxLossStreak,
      slippageUsed:           result.slippageUsed,
      cooldownUsed:           result.cooldownUsed,
      multiObjScore:          multiObjectiveScore(metrics),
    });

    console.log(
      `[${ts()}] BACKTEST DONE: ${instrument} | ` +
      `trades=${metrics.tradeCount} | win=${(metrics.winRate*100).toFixed(1)}% | ` +
      `sharpe=${metrics.sharpe} | pf=${metrics.profitFactor} | run#${runId}`
    );

    const best = proposeRevision(db, instrument, bars1m, runId,
      { cooldown: result.cooldownUsed, slippage: BT_SLIPPAGE });
    if (best) {
      console.log(
        `[${ts()}] SHADOW CANDIDATE: ${instrument} ` +
        `win ${(metrics.winRate*100).toFixed(1)}% → ${(best.metrics.winRate*100).toFixed(1)}% ` +
        `score=${best.score}`
      );
    }

  } catch (err) {
    console.error(`[${ts()}] Backtest error (${instrument}):`, err.message);
  }
}

// ── Full optimizer cycle ──────────────────────────────────────────────────────
async function runOptimizerCycle(instrument) {
  const symbol = BT_SYMBOLS[instrument];
  if (!symbol) return;

  try {
    console.log(`[${ts()}] OPTIMIZER START: ${instrument}`);
    const bars1m = await fetchAllBars(symbol, '1Min', BT_BARS);
    if (bars1m.length < 500) return;

    savePrice(symbol, bars1m);

    const report = await runFullOptimizationCycle(db, instrument, bars1m, {
      targetTrades: BT_TARGET_TRADES,
      slippage:     BT_SLIPPAGE,
    });

    console.log(report.summary);
    console.log(
      `[${ts()}] OPTIMIZER DONE: ${instrument} | ` +
      `live=${(report.liveWinRate*100).toFixed(1)}% | promoted=${report.globalPromoted}`
    );

  } catch (err) {
    console.error(`[${ts()}] Optimizer error (${instrument}):`, err.message);
  }
}

function ts() { return new Date().toISOString(); }

// ── Startup ───────────────────────────────────────────────────────────────────
console.log('NQ Signal Pro V3 — Multi-Strategy Scanner + Diagnostic Engine');
console.log(`Symbols: MNQ=${SYMBOL} MGC=${SYMBOL_MGC} | Scan: ${SCAN_INTERVAL/1000}s | Cooldown: ${COOLDOWN}min | LogLevel: ${LOG_LEVEL}`);
console.log(`Backtests: ${BT_INTERVAL_H}h | Bars: ${BT_BARS} | Target: ${BT_TARGET_TRADES} trades | Slippage: ${BT_SLIPPAGE}pts`);
console.log(`Optimizer: ${OPT_INTERVAL_H}h | Strategies: EMA Cross, VWAP PB, BB, MACD Mom, SR Break + 4-factor primary`);
if (!NTFY_TOPIC) console.warn('WARNING: NTFY_TOPIC not set — push notifications disabled');

setTimeout(() => runBacktestCycle('MNQ', 'startup'),   5_000);
setTimeout(() => runBacktestCycle('MGC', 'startup'),  35_000);
setTimeout(() => runOptimizerCycle('MNQ'), 120_000);
setTimeout(() => runOptimizerCycle('MGC'), 180_000);

scan();
setInterval(scan, SCAN_INTERVAL);

const BT_MS  = BT_INTERVAL_H  * 3_600_000;
setInterval(() => runBacktestCycle('MNQ'), BT_MS);
setInterval(() => runBacktestCycle('MGC'), BT_MS + BT_MS / 2);

const OPT_MS = OPT_INTERVAL_H * 3_600_000;
setInterval(() => runOptimizerCycle('MNQ'), OPT_MS);
setInterval(() => runOptimizerCycle('MGC'), OPT_MS + OPT_MS / 3);
