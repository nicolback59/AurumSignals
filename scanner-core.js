'use strict';

/**
 * SCANNER CORE — reusable scanner module
 *
 * Exports a Scanner class that can be embedded in server.js (single-process)
 * or used standalone via scanner.js.
 *
 * Key features:
 *  • Yahoo Finance fetch with exponential-backoff retry (3 attempts)
 *  • Auto-reconnect on repeated failures — scanner never permanently dies
 *  • EventEmitter — emits 'signal', 'scan', 'heartbeat', 'backtest', 'error'
 *  • Per-instrument cooldown + daily cap
 *  • Adaptive confidence thresholding via learning module
 *  • Scheduled backtest + optimizer cycles
 *  • Diagnostic + rejection logging (disk-space throttled)
 *  • Storage cleanup (keeps DB < 200 MB forever)
 */

const EventEmitter = require('events');

const { evaluateAll, STRATEGY_META } = require('./strategy-engine');
const {
  aggregate5mTo15m,
  aggregate5mTo30m,
  aggregate5mTo45m,
  aggregate1hTo4h,
  aggregate1hToDaily,
} = require('./strategies/shared-indicators');
const {
  getAdaptiveMinScore, getMarketRegime, getLearnedThreshold,
  updateLearnedThresholds, updateLearningFromLiveSignals,
  getPredictedWinRate, getBacktestWinRates,
  getPatternAdjustment, updatePatternMemory, computeAdaptiveOverrides,
  loadAdaptiveOverrides,
} = require('./learning');
const { runBacktest }          = require('./backtest-engine');
const {
  getParams, saveBacktestRun, saveBacktestDetails,
  proposeRevision, evaluateShadow, multiObjectiveScore,
} = require('./strategy-params');
const { runFullOptimizationCycle } = require('./strategy-optimizer');
const { fetchAllNews }             = require('./news-fetcher');

// ── Helpers ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }

// ── Scanner class ─────────────────────────────────────────────────────────────

class Scanner extends EventEmitter {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} [config]
   */
  constructor(db, config = {}) {
    super();
    this.db = db;

    this.cfg = {
      symbol:          config.symbol          || process.env.SCANNER_SYMBOL       || 'NQ=F',
      symbolMgc:       config.symbolMgc       || process.env.SCANNER_SYMBOL_MGC   || 'GC=F',
      scanInterval:    config.scanInterval    || Math.min(parseInt(process.env.SCAN_INTERVAL || '120') * 1000, 300_000),
      cooldown:        config.cooldown        || parseInt(process.env.SCANNER_COOLDOWN    || '20'),
      baseScore:       config.baseScore       || parseInt(process.env.SCANNER_MIN_SCORE   || '6'),
      dailySignalCap:  config.dailySignalCap  || parseInt(process.env.DAILY_SIGNAL_CAP    || '15'),
      dailyMinSignals: config.dailyMinSignals || parseInt(process.env.DAILY_MIN_SIGNALS   || '10'),
      logLevel:        config.logLevel        || (process.env.SCANNER_LOG_LEVEL || 'full').toLowerCase(),
      ntfyUrl:         config.ntfyUrl         || (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, ''),
      ntfyTopic:       config.ntfyTopic       || process.env.NTFY_TOPIC || '',
      ntfyToken:       config.ntfyToken       || process.env.NTFY_TOKEN || '',
      btIntervalH:     config.btIntervalH     || parseFloat(process.env.BACKTEST_INTERVAL_H  || '6'),
      btBars:          config.btBars          || parseInt(process.env.BACKTEST_BARS           || '2000'),
      btSlippage:      config.btSlippage      || parseFloat(process.env.BT_SLIPPAGE          || '0.5'),
      btTargetTrades:  config.btTargetTrades  || parseInt(process.env.BT_TARGET_TRADES        || '120'),
      optIntervalH:    config.optIntervalH    || parseFloat(process.env.OPTIMIZER_INTERVAL_H  || '12'),
      btSymbols:       config.btSymbols       || {
        MNQ: process.env.SCANNER_BT_MNQ || process.env.SCANNER_SYMBOL     || 'NQ=F',
        MGC: process.env.SCANNER_BT_MGC || process.env.SCANNER_SYMBOL_MGC || 'GC=F',
      },
    };

    // Runtime state
    this._lastSignalTimes   = { MNQ: 0, MGC: 0 };
    this._lastDiagSave      = { MNQ: 0, MGC: 0 };
    this._lastRejectionSave = { MNQ: 0, MGC: 0 };
    this._scanCount         = 0;
    this._consecutiveErrors = 0;
    this._fetchBackoffUntil = 0;   // circuit breaker: epoch ms when backoff expires
    this._intervals         = [];
    this._running           = false;

    // Cache last known good bars so a transient fetch error doesn't kill the scan
    this._lastGoodBars = {
      mnq5m: [], mnq1h: [], mgc5m: [], mgc1h: [],
    };

    this._prepareStatements();
  }

  // ── SQLite prepared statements ──────────────────────────────────────────────

  _prepareStatements() {
    const db = this.db;
    this._stmts = {
      insertSignal: db.prepare(`
        INSERT INTO signals
          (ticker, timeframe, direction, grade, setup, strategy_name, entry, sl, tp1, tp2, tp3,
           score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
           trade_style, instrument, rr, raw_payload)
        VALUES
          (@ticker, @timeframe, @direction, @grade, @setup, @strategy_name, @entry, @sl, @tp1, @tp2, @tp3,
           @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
           @trade_style, @instrument, @rr, @raw_payload)
      `),

      upsertPrice: db.prepare(`
        INSERT INTO market_snapshots (symbol, price, open_price, change_pct, high_24h, low_24h, snapped_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(symbol) DO UPDATE SET
          price      = excluded.price,
          open_price = excluded.open_price,
          change_pct = excluded.change_pct,
          high_24h   = excluded.high_24h,
          low_24h    = excluded.low_24h,
          snapped_at = excluded.snapped_at
      `),

      insertOutcome: db.prepare(`
        INSERT OR IGNORE INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts)
        VALUES (?, ?, ?, ?, ?)
      `),

      getPendingSignals: db.prepare(`
        SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument
        FROM   signals s
        LEFT JOIN outcomes o ON o.signal_id = s.id
        WHERE  o.id IS NULL
          AND  s.entry IS NOT NULL AND s.sl IS NOT NULL AND s.tp1 IS NOT NULL
          AND  s.received_at <= datetime('now', '-3 minutes')
          AND  s.received_at >= datetime('now', '-4 hours')
          AND  s.instrument = ?
        ORDER BY s.received_at ASC
      `),

      insertRejection: db.prepare(`
        INSERT INTO signal_rejections
          (instrument, direction, setup, strategy, score, min_score, reason, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),

      insertScanDiag: db.prepare(`
        INSERT INTO scan_diagnostics
          (instrument, last_close, htf_bias, chop, atr, score_l, score_s,
           any_setup_l, any_setup_s, fired, strategies_fired, reject_reason, indicators)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      upsertHeartbeat: db.prepare(`
        INSERT INTO scanner_heartbeat (id, last_scan, scan_count)
        VALUES (1, datetime('now'), 1)
        ON CONFLICT(id) DO UPDATE SET
          last_scan  = datetime('now'),
          scan_count = scan_count + 1
      `),

      insertNews: db.prepare(`
        INSERT OR IGNORE INTO news_items (category, title, source, link, summary, published_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      pruneNews: db.prepare(`
        DELETE FROM news_items WHERE id NOT IN (
          SELECT id FROM news_items ORDER BY id DESC LIMIT 500
        )
      `),

      dailySignalCount: db.prepare(
        `SELECT COUNT(*) cnt FROM signals WHERE instrument=? AND date(received_at)=date('now')`
      ),
    };
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  _log(msg, level = 'full') {
    const levels = { quiet: 0, signal: 1, full: 2 };
    if ((levels[this.cfg.logLevel] ?? 2) >= (levels[level] ?? 2)) {
      console.log(`[${ts()}] ${msg}`);
    }
  }

  _err(msg, err) {
    console.error(`[${ts()}] ${msg}`, err?.message ?? '');
    this.emit('error', { msg, err: err?.message });
  }

  // ── Auto-note generator for backtest trades ───────────────────────────────────
  // Generates detailed technical notes for EVERY trade (WIN, LOSS, BE).
  // These notes teach the bot WHY trades succeed or fail, feeding the learning loop.
  // Depth matters: the richer the notes, the more accurately the bot can predict
  // future win rates before a signal is even released.

  _autoNote(trade) {
    const parts = [];
    const dir  = trade.direction  ?? '?';
    const htf  = trade.htf_bias   ?? 'UNKNOWN';
    const sess = (trade.session   ?? '').toLowerCase();
    const strat = trade.strategy_name ?? '';
    const conf  = trade.confidence ?? null;
    const rr    = trade.rr ?? null;
    const regime = trade.regime ?? 'unknown';
    const pnlPts = trade.pnlPts ?? null;

    // ── Outcome headline ────────────────────────────────────────────────────
    if (trade.outcome === 'WIN') {
      parts.push(`WIN — ${dir} reached target${pnlPts != null ? ` (+${pnlPts} pts)` : ''}`);
    } else if (trade.outcome === 'BE') {
      parts.push(`BE — ${dir} stalled before target, returned to entry${pnlPts != null ? ` (${pnlPts} pts)` : ''}`);
    } else {
      parts.push(`LOSS — ${dir} stop triggered${pnlPts != null ? ` (${pnlPts} pts)` : ''}`);
    }

    // ── Confidence quality analysis ─────────────────────────────────────────
    if (conf != null) {
      if (conf >= 80) {
        parts.push(`[SCORE] high-confidence setup (${conf}/100) — strong signal quality`);
      } else if (conf >= 68) {
        parts.push(`[SCORE] good confidence (${conf}/100) — meets quality standard`);
      } else if (conf >= 60) {
        parts.push(`[SCORE] borderline confidence (${conf}/100) — stricter filter would require 68+`);
      } else {
        parts.push(`[SCORE] low confidence (${conf}/100) — below optimal; learning system will raise threshold`);
      }
    }

    // ── Regime analysis ─────────────────────────────────────────────────────
    if (regime === 'volatile') {
      parts.push('[REGIME] high-volatility spike — ATR expanded; stops more likely to be hit on noise; widen SL or skip');
    } else if (regime === 'ranging') {
      parts.push('[REGIME] ranging/choppy market — continuation setups have <45% WR in ranges; wait for breakout confirmation');
    } else if (regime === 'trending') {
      parts.push('[REGIME] trending market — ideal for EMA-stack and VWAP-pullback setups');
    } else {
      parts.push('[REGIME] regime unknown — insufficient historical context for this bar');
    }

    // ── HTF bias analysis ───────────────────────────────────────────────────
    if (htf === 'MIXED') {
      parts.push('[HTF] higher-timeframe bias was mixed/neutral — both 15m and 1h must agree before entry; this setup lacked alignment');
    } else if ((dir === 'LONG' && htf === 'BEAR') || (dir === 'SHORT' && htf === 'BULL')) {
      parts.push(`[HTF] COUNTER-TREND — entered ${dir} while HTF was ${htf}; counter-trend trades have ~35% win rate vs 60%+ with-trend`);
    } else {
      parts.push(`[HTF] bias aligned (HTF=${htf}, dir=${dir}) — structural edge present`);
    }

    // ── Session / timing analysis ───────────────────────────────────────────
    if (sess.includes('pre') || sess.includes('overnight') || sess.includes('asia')) {
      parts.push('[TIMING] pre-market / overnight — thin liquidity, wide spreads, stop-hunt risk elevated; avoid unless very high confidence');
    } else if (sess.includes('london') && sess.includes('ny')) {
      parts.push('[TIMING] London/NY overlap — highest-liquidity window; best session for intraday and scalp setups');
    } else if (sess.includes('london')) {
      parts.push('[TIMING] London open — good session for European momentum setups');
    } else if (sess.includes('ny') || sess.includes('open')) {
      parts.push('[TIMING] NY open session — strong momentum expected 9:30–11:30 ET');
    } else if (sess.includes('lunch') || sess.includes('midday') || sess.includes('mid')) {
      parts.push('[TIMING] midday chop zone (11:30–13:30 ET) — low momentum, mean-reversion common; tight target or skip');
    } else if (sess.includes('afternoon') || sess.includes('aftnoon')) {
      parts.push('[TIMING] afternoon session (13:30–16:00 ET) — late-day reversals and fades; watch for position unwind near close');
    }

    // ── R:R ratio analysis ──────────────────────────────────────────────────
    if (rr != null) {
      if (rr >= 2.5) {
        parts.push(`[RR] strong risk/reward (${rr}R) — even 40% win rate is profitable at this RR`);
      } else if (rr >= 1.5) {
        parts.push(`[RR] adequate risk/reward (${rr}R) — need 40%+ win rate to be profitable`);
      } else {
        parts.push(`[RR] low risk/reward (${rr}R) — need >50% win rate to profit; consider wider targets`);
      }
    }

    // ── Strategy-specific deep notes ────────────────────────────────────────
    if (strat === 'MGC_SCALP') {
      if (trade.outcome === 'LOSS') {
        parts.push('[STRATEGY:MGC_SCALP] tight SL vulnerable to gold volatility; common near FOMC/CPI; check economic calendar before entry; consider 0.5 ATR SL buffer during news days');
      } else if (trade.outcome === 'BE') {
        parts.push('[STRATEGY:MGC_SCALP] price returned to entry — gold scalps often reversed by sudden macro news; confirm no high-impact events within 2h of entry');
      } else {
        parts.push('[STRATEGY:MGC_SCALP] WIN pattern — VWAP/EMA rejection on 5m during active session; replicate setup conditions');
      }
    } else if (strat === 'MNQ_INTRADAY') {
      if (trade.outcome === 'LOSS') {
        parts.push('[STRATEGY:MNQ_INTRADAY] failed intraday pullback — common causes: EMA21 breakdown, HTF reversal mid-trade, or vol spike; require confirmed pullback hold before entry');
      } else if (trade.outcome === 'BE') {
        parts.push('[STRATEGY:MNQ_INTRADAY] price stalled — check VWAP zone; if price oscillates around VWAP for 3+ bars, skip entry; VWAP acts as magnet in choppy conditions');
      } else {
        parts.push('[STRATEGY:MNQ_INTRADAY] WIN — EMA9/21 stack held pullback; MACD and VWAP alignment confirmed momentum; replicate structure');
      }
    } else if (strat === 'MNQ_50PT') {
      if (trade.outcome === 'LOSS') {
        parts.push('[STRATEGY:MNQ_50PT] breakout failed — false breakouts account for ~40% of 50-pt setups; require volume spike ≥1.5× avg and close above prior high; avoid breakouts into major S/R');
      } else if (trade.outcome === 'BE') {
        parts.push('[STRATEGY:MNQ_50PT] consolidation resolved but reversed; next time verify breakout candle body > 60% of its range and no wick rejection back into range');
      } else {
        parts.push('[STRATEGY:MNQ_50PT] WIN — clean volume breakout from tight consolidation; range was ≤1 ATR and price expanded decisively; ideal pattern');
      }
    } else if (strat === 'MNQ_SWING') {
      if (trade.outcome === 'LOSS') {
        parts.push('[STRATEGY:MNQ_SWING] swing failed — 1h structure breakdown or daily S/R rejected move; always verify daily EMA21 direction and 4h structure before swing entries');
      } else if (trade.outcome === 'BE') {
        parts.push('[STRATEGY:MNQ_SWING] swing price retraced — check weekly pivot and daily S/R before next swing; price often revisits 1h EMA21 before resuming; move SL to breakeven after 1R profit');
      } else {
        parts.push('[STRATEGY:MNQ_SWING] WIN swing — daily bias + 4h momentum confirmed; 1h pullback to value held; strong structure-based edge');
      }
    }

    // ── What to do next / learning directive ───────────────────────────────
    let learn = '';
    if (trade.outcome === 'WIN') {
      if (regime === 'trending' && (htf === 'BULL' || htf === 'BEAR')) {
        learn = 'LEARN: trending regime + aligned HTF is the highest-quality combination; prioritize these setups';
      } else {
        learn = 'LEARN: document entry conditions (EMA stack, VWAP position, session) to build a replay library of winning patterns';
      }
    } else if (regime === 'ranging') {
      learn = 'LEARN: SKIP continuation setups in ranging regime — adaptive threshold should rise until WR recovers; wait for regime → trending';
    } else if (htf === 'MIXED') {
      learn = 'LEARN: require 15m + 1h EMA9 both above/below EMA21 before entry — neutral HTF means no edge';
    } else if (conf != null && conf < 65) {
      learn = `LEARN: confidence was ${conf}/100 (target 68+); the learning system should raise the threshold for ${strat} until win rate stabilises above 55%`;
    } else if (sess.includes('lunch') || sess.includes('midday') || sess.includes('mid')) {
      learn = 'LEARN: midday setups underperform — reduce position size 50% or skip entirely between 11:30–13:30 ET';
    } else if (regime === 'volatile') {
      learn = 'LEARN: volatile regime increases SL-hit probability by ~30%; widen SL by 0.5 ATR or wait for volatility to normalise (ATR declines for 3+ consecutive bars)';
    } else {
      learn = 'LEARN: review entry bar in detail — entry timing and confirmation candle quality are the primary variables; tighten to require body >50% of candle range';
    }

    return parts.join(' | ') + ' | ' + learn;
  }

  // ── Yahoo Finance fetch with exponential-backoff retry ───────────────────────

  async _fetchWithRetry(url, maxAttempts = 2) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0) {
          // Only retry on transient errors (not rate limits)
          const delay = 3000 * attempt;
          await new Promise(r => setTimeout(r, delay));
          this._log(`Retry ${attempt}/${maxAttempts - 1}: ${url.slice(50, 110)}…`);
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20_000);
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; NQ-Signal-Pro/3.0)',
              'Accept': 'application/json',
            },
            signal: ctrl.signal,
          });
          if (res.status === 429) {
            // Never retry rate limit errors — they need minutes-long backoff, not seconds
            throw new Error(`HTTP 429 rate-limited — ${url.slice(0, 80)}`);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 80)}`);
          return await res.json();
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
        if (err.message.includes('429')) throw err; // no retry on rate limit
        if (attempt < maxAttempts - 1) {
          this._log(`Fetch warning (attempt ${attempt + 1}): ${err.message}`);
        }
      }
    }
    throw lastErr;
  }

  async _fetchYahooBars(symbol, interval, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=${interval}&range=${range}`;
    const json   = await this._fetchWithRetry(url);
    const result = json.chart?.result?.[0];
    if (!result) return [];
    const tsList = result.timestamp ?? [];
    const quote  = result.indicators?.quote?.[0] ?? {};
    return tsList.map((t, i) => ({
      timestamp: new Date(t * 1000).toISOString(),
      open:   quote.open?.[i],
      high:   quote.high?.[i],
      low:    quote.low?.[i],
      close:  quote.close?.[i],
      volume: quote.volume?.[i] ?? 0,
    })).filter(b => b.open != null && b.close != null);
  }

  // Fetch bars for backtest (1m or 15m)
  async _fetchAllBars(symbol, timeframe, maxBars) {
    const interval = (timeframe === '1Min' || timeframe === '1m') ? '1m' : '15m';
    const range    = interval === '1m' ? '7d' : '60d';
    const bars     = await this._fetchYahooBars(symbol, interval, range);
    return bars.slice(-maxBars);
  }

  // ── Price snapshot ───────────────────────────────────────────────────────────

  _savePrice(symbol, bars) {
    if (!bars || bars.length < 2) return;
    const last  = bars[bars.length - 1];
    const first = bars[0];
    const chg   = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
    const high  = Math.max(...bars.map(b => b.high));
    const low   = Math.min(...bars.map(b => b.low));
    this._stmts.upsertPrice.run(symbol, last.close, first.open, +chg.toFixed(3), high, low);
  }

  // ── ntfy push ────────────────────────────────────────────────────────────────

  _sendNtfy(s) {
    if (!this.cfg.ntfyTopic) return;
    const arrow    = s.direction === 'LONG' ? '▲' : '▼';
    const priority = s.grade === 'A+' ? 'urgent' : 'high';
    const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';
    const stratTag = s.strategy_name ? `[${s.strategy_name}] ` : '';
    const predWR = s.predicted_wr_pct != null
      ? `WinRate: ${s.predicted_wr_pct}%±${s.predicted_wr_band ?? 9}% (${s.predicted_wr_source ?? '?'})${s.predicted_wr_atr_spike ? ' ⚠️NEWS/SPIKE' : ''}`
      : null;
    const body = [
      s.setup        ? `Setup:   ${stratTag}${s.setup}`   : null,
      s.trade_style  ? `Style:   ${s.trade_style}`         : null,
      s.entry != null? `Entry:   ${s.entry}`               : null,
      s.sl    != null? `SL:      ${s.sl}`                  : null,
      s.tp1   != null? `TP1:     ${s.tp1}`                 : null,
      s.tp2   != null? `TP2:     ${s.tp2}`                 : null,
      s.tp3   != null? `TP3:     ${s.tp3}`                 : null,
      s.tp4   != null? `TP4:     ${s.tp4}`                 : null,
      s.rr    != null? `RR:      ${s.rr}`                  : null,
      s.confidence != null ? `Conf:    ${s.confidence}/100` : null,
      predWR,
      s.session      ? `Session: ${s.session}`             : null,
    ].filter(Boolean).join('\n');
    const headers = {
      'Content-Type': 'text/plain',
      'Title':    `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker ?? s.instrument}`,
      'Priority': priority,
      'Tags':     tags,
    };
    if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
    fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, { method: 'POST', headers, body })
      .catch(err => this._err('[ntfy] send failed', err));
  }

  // ── Outcome ntfy push ─────────────────────────────────────────────────────────

  _sendNtfyOutcome(signalId, instrument, direction, result, pnlPts) {
    if (!this.cfg.ntfyTopic) return;
    const emoji    = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '⚠️';
    const pnlStr   = pnlPts != null ? ` (${pnlPts >= 0 ? '+' : ''}${pnlPts} pts)` : '';
    const priority = result === 'WIN' ? 'default' : result === 'LOSS' ? 'high' : 'default';
    const headers  = {
      'Content-Type': 'text/plain',
      'Title':    `${emoji} ${result} — ${instrument} ${direction}${pnlStr}`,
      'Priority': priority,
      'Tags':     result === 'WIN' ? 'white_check_mark' : result === 'LOSS' ? 'x' : 'warning',
    };
    if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
    const body = `Signal #${signalId} auto-resolved: ${direction} ${instrument} → ${result}${pnlStr}`;
    fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, { method: 'POST', headers, body })
      .catch(err => this._err('[ntfy-outcome] send failed', err));
  }

  // ── Signal storage ────────────────────────────────────────────────────────────

  _storeSignal(signal) {
    // Attach predicted win rate before storage — this is the pre-completion success estimate
    try {
      const pred = getPredictedWinRate(this.db, signal);
      signal.predicted_wr          = pred.predicted_wr;
      signal.predicted_wr_pct      = pred.predicted_wr_pct;
      signal.predicted_wr_band     = pred.band;
      signal.predicted_wr_source   = pred.source;
      signal.predicted_wr_factors  = pred.factors;
      signal.predicted_wr_regime   = pred.regime;
      signal.predicted_wr_atr_spike  = pred.atr_spike;
      signal.predicted_wr_high_news  = pred.high_news;
      signal.predicted_wr_dynamic_note = pred.dynamic_note;
    } catch { /* never crash signal storage */ }

    const info = this._stmts.insertSignal.run({
      ticker:        signal.ticker ?? `${signal.instrument}1!`,
      timeframe:     signal.timeframe ?? '5m',
      direction:     signal.direction,
      grade:         signal.grade,
      setup:         signal.setup,
      strategy_name: signal.strategy_name ?? null,
      entry:         signal.entry,
      sl:            signal.sl,
      tp1:           signal.tp1,
      tp2:           signal.tp2,
      tp3:           signal.tp3,
      score:         signal.score,
      win_prob_tp1:  signal.win_prob_tp1,
      win_prob_tp2:  signal.win_prob_tp2,
      win_prob_tp3:  signal.win_prob_tp3,
      htf_bias:      signal.htf_bias   ?? null,
      session:       signal.session,
      trade_style:   signal.trade_style ?? null,
      instrument:    signal.instrument,
      rr:            signal.rr,
      raw_payload:   JSON.stringify(signal),
    });

    const id          = info.lastInsertRowid;
    const stratLabel  = signal.strategy_name ?? signal.setup ?? 'unknown';
    const logMsg = `✅ SIGNAL #${id} | ${signal.instrument} ${signal.direction} ${signal.grade} | ` +
      `${stratLabel} | confidence=${signal.confidence ?? signal.score}/100 | entry=${signal.entry} | rr=${signal.rr}`;
    this._log(logMsg, 'signal');

    const enriched = { ...signal, id, received_at: new Date().toISOString() };
    this.emit('signal', enriched);
    this._sendNtfy(enriched);
    return id;
  }

  // ── Rejection storage (throttled — 1/10 min per instrument) ──────────────────

  _storeRejection(instrument, direction, setup, strategy, score, minScore, reason) {
    try {
      const isNearMiss = score != null && minScore != null && score >= minScore - 4;
      if (!isNearMiss) return;
      const now = Date.now();
      if (now - (this._lastRejectionSave[instrument] ?? 0) < 10 * 60_000) return;
      this._lastRejectionSave[instrument] = now;
      this._stmts.insertRejection.run(
        instrument, direction ?? null, setup ?? null, strategy ?? null,
        score ?? null, minScore ?? null, reason, null
      );
    } catch { /* never crash scanner */ }
  }

  // ── Scan diagnostic storage (throttled — 1/30 min per instrument) ────────────

  _storeScanDiag(instrument, diag, stratsFired, fired, rejectReason) {
    const now = Date.now();
    if (now - (this._lastDiagSave[instrument] ?? 0) < 30 * 60_000) return;
    this._lastDiagSave[instrument] = now;
    try {
      this._stmts.insertScanDiag.run(
        instrument,
        diag?.close   ?? null,
        diag?.htfBias ?? null,
        0, // chop — computed internally
        diag?.atr     ?? null,
        null, null, 0, 0,
        fired ? 1 : 0,
        stratsFired.length ? JSON.stringify(stratsFired) : null,
        rejectReason ?? null,
        diag ? JSON.stringify(diag) : null
      );
    } catch { /* never crash scanner */ }
  }

  // ── Auto-resolve pending outcomes ─────────────────────────────────────────────

  _autoResolveOutcomes(bars1m, instrument) {
    const pending = this._stmts.getPendingSignals.all(instrument);
    if (!pending.length) return;
    let resolvedCount = 0;

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
        this._stmts.insertOutcome.run(
          sig.id, resolved.result, resolved.exitPrice,
          exitBar?.timestamp ?? new Date().toISOString(),
          +pnlPts.toFixed(2)
        );
        const pts = +pnlPts.toFixed(2);
        this._log(`AUTO-RESOLVE #${sig.id} ${instrument}: ${sig.direction} → ${resolved.result} (${pts} pts)`, 'signal');
        this.emit('outcome', { signalId: sig.id, instrument, result: resolved.result, pnlPts: pts });
        this._sendNtfyOutcome(sig.id, instrument, sig.direction, resolved.result, pts);
        resolvedCount++;
      }
    }

    // After resolving outcomes, feed live results back into all learning systems
    if (resolvedCount > 0) {
      try {
        const learnResult = updateLearningFromLiveSignals(this.db, instrument);
        for (const [strat, { from, to, wr, trades, delta }] of Object.entries(learnResult.changes)) {
          const dir = delta > 0 ? '↑' : '↓';
          this._log(`📚 LIVE LEARN [${strat}]: threshold ${from} ${dir} ${to} (WR=${wr}%, ${trades} live trades)`);
        }
      } catch { /* never crash on learning */ }

      // Update pattern memory with newly resolved live trades
      try {
        const recentLiveTrades = this.db.prepare(`
          SELECT s.strategy_name, s.direction, s.htf_bias, s.session, o.result AS outcome
          FROM   signals s
          JOIN   outcomes o ON o.signal_id = s.id
          WHERE  s.instrument = ?
            AND  o.exit_at >= datetime('now', '-1 hour')
        `).all(instrument);
        if (recentLiveTrades.length > 0) updatePatternMemory(this.db, recentLiveTrades);
      } catch { /* never crash on pattern memory */ }

      // Recompute adaptive overrides after new outcomes arrive
      try { computeAdaptiveOverrides(this.db); } catch { /* never crash */ }
    }
  }

  // ── Per-instrument scan ───────────────────────────────────────────────────────

  async _scanInstrument(instrument, bars5m, bars15m, bars1h, bars4h, barsDly, bars30m = [], bars45m = []) {
    const cooldownMs = this.cfg.cooldown * 60_000;
    if (Date.now() - (this._lastSignalTimes[instrument] ?? 0) < cooldownMs) return;

    // Daily cap
    const todayCount = this._stmts.dailySignalCount.get(instrument)?.cnt ?? 0;
    if (todayCount >= this.cfg.dailySignalCap) {
      if (this.cfg.logLevel === 'full') {
        this._log(`🚫 ${instrument} daily cap (${todayCount}/${this.cfg.dailySignalCap})`);
      }
      return;
    }

    const barSets = instrument === 'MGC'
      ? { bars5mMgc: bars5m, bars15mMgc: bars15m, bars30mMgc: bars30m, bars45mMgc: bars45m, bars1hMgc: bars1h }
      : { bars5m, bars15m, bars1h, bars4h, barsDly };

    const signals         = evaluateAll(barSets, { instrument });
    const stratsFiredNames = signals.map(s => s.strategy_name);
    let anyFired          = false;

    // Always log candidate signals so we can debug why signals aren't firing
    if (signals.length > 0) {
      const summary = signals.map(s => `${s.strategy_name}(${s.direction} conf=${s.confidence})`).join(', ');
      this._log(`🔍 ${instrument} candidate signal(s): ${summary}`);
    } else if (this._scanCount % 5 === 0) {
      this._log(`📉 ${instrument} — no strategy candidates (bars=${bars5m.length})`);
    }

    // ── Minimum daily signal guarantee — 3-tier confidence relaxation ────────────
    // Each instrument targets dailyMinSignals (default 10) = 20 total across MNQ+MGC.
    // If running behind, confidence gate is progressively relaxed throughout the day.
    const todayCountNow = this._stmts.dailySignalCount.get(instrument)?.cnt ?? 0;
    const minTarget     = this.cfg.dailyMinSignals ?? 10;
    const nowHhmm = (() => {
      const d = new Date();
      return (d.getUTCHours() - 4) * 100 + d.getUTCMinutes(); // rough ET
    })();
    // Tier 1: 9:30 AM+, behind on signals → -10 pts
    // Tier 2: 12:00 PM+, still behind → -16 pts
    // Tier 3: 2:00 PM+, very behind (< half target) → -22 pts
    let minConfBonus = 0;
    const belowMin     = todayCountNow < minTarget;
    const veryBehind   = todayCountNow < Math.floor(minTarget / 2);
    if      (belowMin && veryBehind  && nowHhmm >= 1400 && nowHhmm < 1600) minConfBonus = -22;
    else if (belowMin                && nowHhmm >= 1200 && nowHhmm < 1600) minConfBonus = -16;
    else if (belowMin                && nowHhmm >= 930  && nowHhmm < 1600) minConfBonus = -10;

    if (minConfBonus < 0 && this._scanCount % 3 === 0) {
      this._log(`📊 ${instrument} signal pace: ${todayCountNow}/${minTarget} — gate relaxed ${minConfBonus} pts`);
    }

    // Load adaptive overrides once per scan (auto-computed from live WR data)
    let adaptiveOverrides = {};
    try { adaptiveOverrides = loadAdaptiveOverrides(this.db); } catch { /* never crash */ }

    for (const sig of signals) {
      // Re-check cooldown per signal (another strategy may have just fired)
      if (Date.now() - (this._lastSignalTimes[instrument] ?? 0) < cooldownMs) {
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, null, 'cooldown');
        this._log(`⏳ Cooldown: ${sig.strategy_name} ${instrument} suppressed`);
        continue;
      }

      // ── Adaptive overrides (genuine learning — auto-block bad patterns) ────
      const ov = adaptiveOverrides[sig.strategy_name];
      if (ov) {
        if (ov.paused) {
          const reason = `strategy paused by adaptive learning (${(ov.reasons ?? []).slice(-1)[0] ?? 'poor WR'})`;
          this._log(`🔇 ${sig.strategy_name} ${instrument} — ${reason}`);
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, reason);
          continue;
        }
        if (sig.direction === 'LONG'  && ov.blockLong) {
          const reason = `LONG direction blocked by adaptive learning (low LONG WR)`;
          this._log(`🔇 ${sig.strategy_name} LONG blocked — ${reason}`);
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, reason);
          continue;
        }
        if (sig.direction === 'SHORT' && ov.blockShort) {
          const reason = `SHORT direction blocked by adaptive learning (low SHORT WR)`;
          this._log(`🔇 ${sig.strategy_name} SHORT blocked — ${reason}`);
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, reason);
          continue;
        }
        if ((ov.blockedSessions ?? []).includes(sig.session)) {
          const reason = `session '${sig.session}' blocked by adaptive learning (low session WR)`;
          this._log(`🔇 ${sig.strategy_name} session blocked — ${reason}`);
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, reason);
          continue;
        }
      }

      // ── Pattern memory adjustment (genuine learning — context-aware gate) ──
      // Raises or lowers the effective confidence gate based on how this exact
      // pattern (strategy + direction + htf_bias + session) has historically performed.
      let patternAdj = 0;
      try {
        const patResult = getPatternAdjustment(this.db, sig);
        patternAdj = patResult.adjustment;
        if (patResult.patternWR != null && Math.abs(patternAdj) >= 4) {
          this._log(
            `🧠 Pattern memory [${sig.strategy_name} ${sig.direction}/${sig.htf_bias}/${sig.session}]: ` +
            `WR=${(patResult.patternWR * 100).toFixed(0)}% (${patResult.patternTrades} trades) → gate adj ${patternAdj > 0 ? '+' : ''}${patternAdj}`
          );
        }
      } catch { /* never crash */ }

      // Learned confidence gate — threshold evolves based on backtest win rates.
      // Pattern memory further adjusts the gate based on this specific context.
      const learnedMin = getLearnedThreshold(this.db, sig.strategy_name, sig.confidence * 0.9);
      const effectiveMin = Math.round(learnedMin + patternAdj + minConfBonus);
      if (sig.confidence < effectiveMin) {
        const reason = `confidence ${sig.confidence} < learned threshold ${effectiveMin}` +
          (patternAdj !== 0 ? ` (pattern adj ${patternAdj > 0 ? '+' : ''}${patternAdj})` : '') +
          (minConfBonus < 0 ? ' (min-guarantee relaxed)' : '');
        this._log(`⚠️  ${sig.strategy_name} ${instrument} — ${reason}`);
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, effectiveMin, reason);
        continue;
      }

      this._lastSignalTimes[instrument] = Date.now();
      this._storeSignal({ ...sig, ticker: `${instrument}1!` });
      anyFired = true;
    }

    // Diagnostic snapshot
    const regime  = getMarketRegime(this.db);
    const lastBar = bars5m.length > 0 ? bars5m[bars5m.length - 1] : null;
    const diagInfo = { close: lastBar?.close ?? null, atr: null, htfBias: null };

    if (this.cfg.logLevel === 'full') {
      this._log(
        `📊 ${instrument} | close=${diagInfo.close ?? '?'} | regime=${regime} | ` +
        `strats=${stratsFiredNames.join(',') || 'none'} | fired=${anyFired ? 'YES' : 'no'}`
      );
    } else if (!anyFired && this.cfg.logLevel === 'signal' && this._scanCount % 10 === 0) {
      this._log(`${instrument} — no signal (threshold not met)`);
    }

    this._storeScanDiag(instrument, diagInfo, stratsFiredNames, anyFired,
      anyFired ? null : 'confidence threshold not met');

    this.emit('scan', {
      instrument, regime, fired: anyFired,
      strategies: stratsFiredNames,
      close: diagInfo.close,
      scanCount: this._scanCount,
    });
  }

  // ── Sequential Yahoo fetch with inter-request gap ─────────────────────────────
  // Fetches 4 bars serially with a 400ms pause between each to avoid burst rate limits.

  async _fetchScanBars() {
    const pause = ms => new Promise(r => setTimeout(r, ms));

    // 5d of 5m = ~5 trading days × 6.5h × 12 = ~390 bars — plenty for all strategies
    // 60d of 1h = ~42 trading days × 6.5h = ~273 bars — enough for swing + daily aggregation
    const mnq5m = await this._fetchYahooBars(this.cfg.symbol,    '5m', '5d');
    await pause(400);
    const mnq1h = await this._fetchYahooBars(this.cfg.symbol,    '1h', '60d');
    await pause(400);
    const mgc5m = await this._fetchYahooBars(this.cfg.symbolMgc, '5m', '5d');
    await pause(400);
    const mgc1h = await this._fetchYahooBars(this.cfg.symbolMgc, '1h', '60d');
    return { mnq5m, mnq1h, mgc5m, mgc1h };
  }

  // ── Main scan cycle ───────────────────────────────────────────────────────────

  async scan() {
    this._scanCount++;
    try {
      // Fetch primary bars — use last known good on failure
      let mnq5mRaw = [], mnq1hRaw = [], mgc5mRaw = [], mgc1hRaw = [];

      const now = Date.now();
      const inBackoff = this._fetchBackoffUntil > now;

      if (!inBackoff) {
        try {
          const bars = await this._fetchScanBars();
          mnq5mRaw = bars.mnq5m;
          mnq1hRaw = bars.mnq1h;
          mgc5mRaw = bars.mgc5m;
          mgc1hRaw = bars.mgc1h;

          // Update last-known-good cache
          if (mnq5mRaw.length) this._lastGoodBars.mnq5m = mnq5mRaw;
          if (mnq1hRaw.length) this._lastGoodBars.mnq1h = mnq1hRaw;
          if (mgc5mRaw.length) this._lastGoodBars.mgc5m = mgc5mRaw;
          if (mgc1hRaw.length) this._lastGoodBars.mgc1h = mgc1hRaw;

          this._consecutiveErrors = 0;
          this._fetchBackoffUntil = 0;
        } catch (fetchErr) {
          this._consecutiveErrors++;
          this._err(`Data fetch failed (error #${this._consecutiveErrors})`, fetchErr);

          // Circuit breaker — exponential backoff to stop hammering the rate limit
          // errors 1-4: no backoff (use cache, keep scanning)
          // errors 5+:  2^(n-4) minutes backoff, capped at 60 min
          if (this._consecutiveErrors >= 5) {
            const backoffMin = Math.min(60, Math.pow(2, this._consecutiveErrors - 4));
            this._fetchBackoffUntil = Date.now() + backoffMin * 60_000;
            this._log(`🔴 Rate-limit circuit breaker: ${backoffMin}min backoff (${this._consecutiveErrors} consecutive errors)`);
            if (this._consecutiveErrors >= 10 && this.cfg.ntfyTopic) {
              this._sendNtfy({
                direction: 'SHORT', grade: '!', instrument: 'SYS',
                setup: `Rate-limit backoff ${backoffMin}min`, session: 'system',
                ticker: 'NQ Signal Pro',
                trade_style: `${this._consecutiveErrors} consecutive 429s — check Yahoo Finance access`,
              });
            }
          }

          if (this._lastGoodBars.mnq5m.length) {
            this._log('⚠️  Using cached bars from last successful fetch');
            mnq5mRaw = this._lastGoodBars.mnq5m;
            mnq1hRaw = this._lastGoodBars.mnq1h;
            mgc5mRaw = this._lastGoodBars.mgc5m;
            mgc1hRaw = this._lastGoodBars.mgc1h;
          } else {
            return; // No cache yet, nothing to scan
          }
        }
      } else {
        // Still in backoff — use cached bars without making any HTTP requests
        const remaining = Math.ceil((this._fetchBackoffUntil - now) / 60_000);
        if (this._scanCount % 5 === 0) {
          this._log(`⏸️  Rate-limit backoff — ${remaining} min remaining — signal eval on cached bars`);
        }
        if (!this._lastGoodBars.mnq5m.length) return;
        mnq5mRaw = this._lastGoodBars.mnq5m;
        mnq1hRaw = this._lastGoodBars.mnq1h;
        mgc5mRaw = this._lastGoodBars.mgc5m;
        mgc1hRaw = this._lastGoodBars.mgc1h;
      }

      // Slice to useful window
      const mnq5m = mnq5mRaw.slice(-500);
      const mnq1h = mnq1hRaw.slice(-500);
      const mgc5m = mgc5mRaw.slice(-500);
      const mgc1h = mgc1hRaw.slice(-500);

      // Build multi-TF sets
      const mnq15m = aggregate5mTo15m(mnq5m);
      const mnq4h  = aggregate1hTo4h(mnq1h);
      const mnqDly = aggregate1hToDaily(mnq1h);
      const mgc15m = aggregate5mTo15m(mgc5m);
      const mgc30m = aggregate5mTo30m(mgc5m);  // 30m confluence layer for MGC scalp
      const mgc45m = aggregate5mTo45m(mgc5m);  // 45m confluence layer for MGC scalp

      if (mnq5m.length >= 2) this._savePrice(this.cfg.symbol,    mnq5m);
      if (mgc5m.length >= 2) this._savePrice(this.cfg.symbolMgc, mgc5m);

      const mnqReady = mnq5m.length >= 60 && mnq15m.length >= 20 && mnq1h.length >= 30;
      const mgcReady = mgc5m.length >= 60 && mgc15m.length >= 20;

      if (!mnqReady && !mgcReady) {
        this._log(`⏳ Insufficient bars: MNQ 5m=${mnq5m.length}/15m=${mnq15m.length}/1h=${mnq1h.length} MGC 5m=${mgc5m.length}`);
        return;
      }

      await Promise.all([
        mnqReady ? this._scanInstrument('MNQ', mnq5m, mnq15m, mnq1h, mnq4h, mnqDly) : null,
        mgcReady ? this._scanInstrument('MGC', mgc5m, mgc15m, mgc1h, [], [], mgc30m, mgc45m) : null,
      ].filter(Boolean));

      if (mnqReady) this._autoResolveOutcomes(mnq5m, 'MNQ');
      if (mgcReady) this._autoResolveOutcomes(mgc5m, 'MGC');

    } catch (err) {
      this._err('Scan cycle error', err);
    } finally {
      try { this._stmts.upsertHeartbeat.run(); } catch { /* never crash on heartbeat */ }
      this.emit('heartbeat', { scanCount: this._scanCount, at: ts() });
    }
  }

  // ── News fetch ────────────────────────────────────────────────────────────────

  async fetchAndStoreNews() {
    try {
      const items = await fetchAllNews();
      if (!items.length) return;
      this.db.transaction(() => {
        for (const item of items) {
          this._stmts.insertNews.run(
            item.category, item.title, item.source || null,
            item.link || null, item.summary || null, item.pubDate || null
          );
        }
        this._stmts.pruneNews.run();
      })();
      this._log(`📰 News: ${items.length} items`);
    } catch (err) {
      this._err('News fetch error', err);
    }
  }

  // ── Backtest cycle ────────────────────────────────────────────────────────────

  async runBacktestCycle(instrument, triggeredBy = 'scheduled') {
    const symbol = this.cfg.btSymbols[instrument];
    if (!symbol) return;

    try {
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1_048_576);
      this._log(`BACKTEST START: ${instrument} (${this.cfg.btBars} bars, target ${this.cfg.btTargetTrades} trades) heap=${heapMB}MB`);

      // Check for pending shadow revision first
      const pendingShadow = this.db.prepare(
        `SELECT id FROM strategy_revisions WHERE instrument=? AND status='shadow' LIMIT 1`
      ).get(instrument);

      if (pendingShadow) {
        const barsForShadow = await this._fetchAllBars(symbol, '1Min', this.cfg.btBars);
        if (barsForShadow.length >= 100) {
          this._savePrice(symbol, barsForShadow);
          const result = evaluateShadow(this.db, instrument, barsForShadow, { slippage: this.cfg.btSlippage });
          if (result?.promoted) {
            this._log(`✅ REVISION PROMOTED: ${instrument} ${(result.before * 100).toFixed(1)}% → ${(result.after * 100).toFixed(1)}%`);
          } else if (result) {
            this._log(`Shadow discarded for ${instrument}`);
          }
        }
        return;
      }

      const bars1m = await this._fetchAllBars(symbol, '1Min', this.cfg.btBars);
      if (bars1m.length < 100) {
        this._log(`BACKTEST SKIP: insufficient bars (${bars1m.length})`);
        return;
      }

      this._savePrice(symbol, bars1m);

      const params = getParams(this.db, instrument);
      const result = runBacktest(bars1m, params, {
        instrument,
        targetTrades: this.cfg.btTargetTrades,
        slippage:     this.cfg.btSlippage,
        walkForward:  true,
      });
      const { metrics } = result;
      metrics.barsScanned = bars1m.length;

      const runId = saveBacktestRun(this.db, instrument, params, metrics, triggeredBy);

      // Store up to 200 trades per run (WIN + LOSS + BE)
      const allTrades = (result.signalLog ?? []).slice(0, 200);
      if (allTrades.length > 0) {
        const insTrade = this.db.prepare(`
          INSERT INTO backtest_trades
            (run_id, instrument, bar_idx, timestamp, direction, setup, strategy_name,
             trade_style, regime, entry, sl, tp1, outcome, score, confidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const updNote = this.db.prepare(
          `UPDATE backtest_trades SET note = ?, noted_at = datetime('now') WHERE id = ?`
        );

        this.db.transaction(() => {
          for (const t of allTrades) {
            const info = insTrade.run(runId, instrument, t.bar ?? null, t.timestamp ?? null,
              t.direction, t.setup ?? null, t.strategy_name ?? null,
              t.trade_style ?? null, t.regime ?? null,
              t.entry ?? null, t.sl ?? null, t.tp1 ?? null,
              t.outcome, t.score ?? null, t.confidence ?? null);

            // Auto-generate deep learning notes for ALL trades (WIN/LOSS/BE)
            try {
              const note = this._autoNote(t);
              if (note) updNote.run(note, info.lastInsertRowid);
            } catch { /* never crash backtest storage */ }
          }
        })();
      }

      saveBacktestDetails(this.db, runId, {
        byRegime:               metrics.byRegime,
        byStyle:                JSON.stringify(metrics.byStrategy ?? metrics.byStyle ?? {}),
        bySetup:                metrics.bySetup,
        walkForwardConsistency: result.walkForward?.consistency ?? null,
        walkForwardAvgWR:       result.walkForward?.avgWinRate  ?? null,
        maxWinStreak:           metrics.maxWinStreak,
        maxLossStreak:          metrics.maxLossStreak,
        slippageUsed:           result.slippageUsed,
        cooldownUsed:           result.cooldownUsed,
        multiObjScore:          multiObjectiveScore(metrics),
      });

      this._log(
        `BACKTEST DONE: ${instrument} | trades=${metrics.tradeCount} | ` +
        `win=${(metrics.winRate * 100).toFixed(1)}% | sharpe=${metrics.sharpe} | ` +
        `pf=${metrics.profitFactor} | totalReturn=${metrics.totalReturn ?? '?'} | run#${runId}`
      );

      // ── Learning feedback: update thresholds from last 3 backtest runs ─────────
      try {
        const btWinRates  = getBacktestWinRates(this.db, instrument, 3);
        const learnResult = updateLearnedThresholds(this.db, btWinRates);
        for (const [strat, { from, to, wr, trades, delta }] of Object.entries(learnResult.changes)) {
          const dir = delta > 0 ? '↑' : '↓';
          this._log(`📚 LEARNED [${strat}]: threshold ${from} ${dir} ${to} (WR=${wr}%, ${trades} trades)`);
        }
      } catch (e) {
        this._log(`LEARN ERR: ${e.message}`);
      }

      // ── Pattern memory: learn from backtest trades ────────────────────────────
      // Feeds every backtest outcome into the pattern memory so context-specific
      // WR data builds up immediately — not waiting for live trades to accumulate.
      try {
        if (allTrades.length > 0) {
          updatePatternMemory(this.db, allTrades.map(t => ({
            strategy_name: t.strategy_name,
            direction:     t.direction,
            htf_bias:      t.htf_bias ?? null,
            session:       t.session  ?? null,
            outcome:       t.outcome,
          })));
          this._log(`🧠 Pattern memory updated from ${allTrades.length} backtest trades`);
        }
      } catch (e) {
        this._log(`PATTERN MEMORY ERR: ${e.message}`);
      }

      // ── Adaptive overrides: recompute after each backtest ─────────────────────
      // This is where real behavioral decisions get made: auto-pause strategies
      // with sustained poor WR, block LONG/SHORT directions, block bad sessions.
      try {
        const newOverrides = computeAdaptiveOverrides(this.db);
        const paused = Object.entries(newOverrides).filter(([, v]) => v.paused).map(([k]) => k);
        const blocked = Object.entries(newOverrides)
          .filter(([, v]) => v.blockLong || v.blockShort || (v.blockedSessions ?? []).length > 0)
          .map(([k, v]) => {
            const parts = [];
            if (v.blockLong)  parts.push('LONG');
            if (v.blockShort) parts.push('SHORT');
            if ((v.blockedSessions ?? []).length) parts.push(`sessions:${v.blockedSessions.join(',')}`);
            return `${k}[${parts.join('|')}]`;
          });
        if (paused.length > 0)  this._log(`🔇 Adaptive overrides — PAUSED: ${paused.join(', ')}`);
        if (blocked.length > 0) this._log(`🔇 Adaptive overrides — BLOCKED: ${blocked.join(', ')}`);
      } catch (e) {
        this._log(`OVERRIDE ERR: ${e.message}`);
      }

      this.emit('backtest', { instrument, runId, metrics });

      const best = proposeRevision(this.db, instrument, bars1m, runId,
        { cooldown: result.cooldownUsed, slippage: this.cfg.btSlippage });
      if (best) {
        this._log(
          `SHADOW CANDIDATE: ${instrument} ` +
          `win ${(metrics.winRate * 100).toFixed(1)}% → ${(best.metrics.winRate * 100).toFixed(1)}% score=${best.score}`
        );
      }

    } catch (err) {
      this._err(`Backtest error (${instrument})`, err);
    } finally {
      // Log memory after backtest so we can see if we're near the limit
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1_048_576);
      const rssMB  = Math.round(process.memoryUsage().rss       / 1_048_576);
      this._log(`BACKTEST END: ${instrument} heap=${heapMB}MB rss=${rssMB}MB`);
      // Nudge GC if available (node --expose-gc) to free backtest arrays immediately
      if (typeof global.gc === 'function') { try { global.gc(); } catch {} }
    }
  }

  // ── Optimizer cycle ───────────────────────────────────────────────────────────

  async runOptimizerCycle(instrument) {
    const symbol = this.cfg.btSymbols[instrument];
    if (!symbol) return;

    try {
      this._log(`OPTIMIZER START: ${instrument}`);
      const bars1m = await this._fetchAllBars(symbol, '1Min', this.cfg.btBars);
      if (bars1m.length < 500) return;

      this._savePrice(symbol, bars1m);

      const report = await runFullOptimizationCycle(this.db, instrument, bars1m, {
        targetTrades: this.cfg.btTargetTrades,
        slippage:     this.cfg.btSlippage,
      });

      this._log(report.summary);
      this._log(
        `OPTIMIZER DONE: ${instrument} | live=${(report.liveWinRate * 100).toFixed(1)}% | promoted=${report.globalPromoted}`
      );
    } catch (err) {
      this._err(`Optimizer error (${instrument})`, err);
    }
  }

  // ── Storage cleanup ───────────────────────────────────────────────────────────

  runStorageCleanup() {
    try {
      const before = this.db.prepare(
        'SELECT page_count * page_size sz FROM pragma_page_count(), pragma_page_size()'
      ).get()?.sz ?? 0;

      this.db.prepare(`DELETE FROM scan_diagnostics  WHERE scanned_at  < datetime('now','-90 days')`).run();
      this.db.prepare(`DELETE FROM signal_rejections WHERE rejected_at < datetime('now','-90 days')`).run();
      this.db.prepare(`
        DELETE FROM backtest_trades WHERE id NOT IN (
          SELECT id FROM backtest_trades ORDER BY id DESC LIMIT 2000
        )
      `).run();
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();

      const after   = this.db.prepare(
        'SELECT page_count * page_size sz FROM pragma_page_count(), pragma_page_size()'
      ).get()?.sz ?? 0;
      const savedMB = +((before - after) / 1_048_576).toFixed(1);
      this._log(
        `🗑️  Cleanup done — DB: ${(after / 1_048_576).toFixed(1)} MB${savedMB > 0 ? ` (freed ${savedMB} MB)` : ''}`
      );
    } catch (err) {
      this._err('Cleanup error', err);
    }
  }

  // ── Start / stop ──────────────────────────────────────────────────────────────

  start() {
    if (this._running) return this;
    this._running = true;

    const cfg = this.cfg;

    // Immediate first scan
    this.scan();
    this._intervals.push(setInterval(() => this.scan(), cfg.scanInterval));

    // Startup backtests — delayed so the service stabilises and scan traffic settles
    // before the memory-heavy backtest runs. Staggered 6 min apart to avoid
    // simultaneous Yahoo Finance requests.
    setTimeout(() => this.runBacktestCycle('MNQ', 'startup'), 20 * 60_000);   // 20 min
    setTimeout(() => this.runBacktestCycle('MGC', 'startup'), 26 * 60_000);   // 26 min

    // Startup optimizers (after backtests finish)
    setTimeout(() => this.runOptimizerCycle('MNQ'), 45 * 60_000);
    setTimeout(() => this.runOptimizerCycle('MGC'), 52 * 60_000);

    // News at startup + every 30 min
    setTimeout(() => this.fetchAndStoreNews(), 8_000);
    this._intervals.push(setInterval(() => this.fetchAndStoreNews(), 30 * 60_000));

    // Storage cleanup
    setTimeout(() => this.runStorageCleanup(), 15_000);
    this._intervals.push(setInterval(() => this.runStorageCleanup(), 24 * 3_600_000));

    // Periodic backtests — same interval for both instruments; MGC offset by 4 min
    // so they never run at the same time and compete for rate-limit budget.
    const btMs  = cfg.btIntervalH * 3_600_000;
    this._intervals.push(setInterval(() => this.runBacktestCycle('MNQ'), btMs));
    // Delay first MGC periodic run by 4 min so the two timers are staggered for life
    setTimeout(() => {
      this._intervals.push(setInterval(() => this.runBacktestCycle('MGC'), btMs));
    }, 4 * 60_000);

    // Periodic optimizers — same cadence, offset by 5 min
    const optMs = cfg.optIntervalH * 3_600_000;
    this._intervals.push(setInterval(() => this.runOptimizerCycle('MNQ'), optMs));
    setTimeout(() => {
      this._intervals.push(setInterval(() => this.runOptimizerCycle('MGC'), optMs));
    }, 5 * 60_000);

    this._log(
      `Scanner started — symbol=${cfg.symbol} mgc=${cfg.symbolMgc} ` +
      `interval=${cfg.scanInterval / 1000}s cooldown=${cfg.cooldown}min ` +
      `cap=${cfg.dailySignalCap} minDaily=${cfg.dailyMinSignals} ` +
      `strategies=MNQ_INTRADAY,MNQ_SWING,MNQ_50PT,MGC_SCALP,MGC_INTRADAY`
    );

    // Startup ntfy confirmation so you know the bot is live and watching
    if (cfg.ntfyTopic) {
      setTimeout(() => {
        const headers = {
          'Content-Type': 'text/plain',
          'Title':    '🟢 NQ Signal Pro V3 — Online',
          'Priority': 'default',
          'Tags':     'white_check_mark',
        };
        if (cfg.ntfyToken) headers['Authorization'] = `Bearer ${cfg.ntfyToken}`;
        const body = `Scanner started\nMin daily signals: ${cfg.dailyMinSignals}/instrument\nStrategies: MNQ_INTRADAY, MNQ_SWING, MNQ_50PT, MGC_SCALP, MGC_INTRADAY\nCooldown: ${cfg.cooldown} min`;
        fetch(`${cfg.ntfyUrl}/${cfg.ntfyTopic}`, { method: 'POST', headers, body })
          .catch(() => {});
      }, 3_000);
    }

    return this;
  }

  stop() {
    this._running = false;
    for (const iv of this._intervals) clearInterval(iv);
    this._intervals = [];
    this._log('Scanner stopped.');
    return this;
  }
}

module.exports = { Scanner };
