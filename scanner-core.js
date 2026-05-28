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

const EventEmitter        = require('events');
const { Worker }          = require('worker_threads');
const path                = require('path');

const { evaluateAll, STRATEGY_META } = require('./strategy-engine');
const {
  aggregate1mTo5m,
  aggregate5mTo15m,
  aggregate5mTo30m,
  aggregate5mTo45m,
  aggregate1hTo4h,
  aggregate1hToDaily,
} = require('./strategies/shared-indicators');
const { isBlackout, classifyNow } = require('./clock/market-clock');
const BarAggregator = require('./feed/bar-aggregator');
const { createFeed } = require('./feed/feed-selector');
const BarWatcher    = require('./feed/bar-watcher');
const { rankSignal }        = require('./signals/signal-ranker');
const signalDedup           = require('./signals/signal-dedup');
const {
  STATES, resolveBar, shouldExpire, stateToResult,
  STRATEGY_CONFIG, MAX_HOLD_MS_BY_STRATEGY,
} = require('./signals/signal-state-machine');
const {
  buildAlertPayload, flattenPayload, buildNtfyBody, buildNtfyHeaders,
  buildNtfyOutcomeBody, buildNtfyOutcomeHeaders,
} = require('./signals/alert-payload');
const { evaluateTPViability } = require('./signals/tp-viability');
const {
  getAdaptiveMinScore, getMarketRegime, getLearnedThreshold,
  updateLearnedThresholds, updateLearningFromLiveSignals,
  getPredictedWinRate, getBacktestWinRates, getStrategyFreshness,
  getPatternAdjustment, updatePatternMemory, computeAdaptiveOverrides,
  loadAdaptiveOverrides, detectEdgeDegradation,
} = require('./learning');
const {
  generateMidWeekReport, generateWeeklyDeepReport,
  listReports, getReportScheduleStatus,
} = require('./performance-reporter');
const { runForensicsAnalysis } = require('./agents/forensics-analyst');
const thresholdManager         = require('./agents/threshold-manager');
const { runBacktest, runBacktest5m, calcEnhancedMetrics } = require('./backtest-engine');
const {
  getParams, saveBacktestRun, saveBacktestDetails,
  proposeRevision, evaluateShadow, multiObjectiveScore,
} = require('./strategy-params');
const { runFullOptimizationCycle } = require('./strategy-optimizer');
const { fetchAllNews }             = require('./news-fetcher');
const {
  loadDNA, updateDNAFromBacktest, updateDNAFromLive,
  getDNAScore, getDNAGateAdjustment,
} = require('./strategy-dna');
const { runEvolutionCycle }        = require('./strategy-evolution');
const {
  checkAdaptiveCooldown,
  formatBlockLog,
  formatBlockSummary,
  formatStartupConfig,
} = require('./adaptive-cooldown');
const {
  recordOpeningCandle, getSessionOpenBias, getOpeningCandleAdjustment,
  updateSessionBiasAccuracy, updateSessionBiasFromBacktest,
  getOpeningCandleReport, getEtDateKey,
} = require('./opening-candle');
const { computeQuantScore } = require('./strategies/quant-scorer');
const gatekeeper = require('./agents/signal-gatekeeper');
const {
  writeLossForensic, computeMfeMae, detectClusters, formatClusterLog,
} = require('./signals/loss-forensics');

// ── Helpers ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }

/**
 * Merge 1m and 5m bar arrays for outcome resolution.
 * 1m bars are sorted by time; we de-duplicate by preferring the 1m bar when
 * both cover the same minute (more granular intrabar low/high).
 * Result is chronologically sorted.
 */
function _mergeResolutionBars(bars1m, bars5m) {
  if (!bars1m || bars1m.length === 0) return bars5m;
  // Use a map keyed by minute to de-dup: prefer 1m bars over 5m bars
  const byMinute = new Map();
  for (const b of bars5m) {
    const min = b.timestamp.slice(0, 16); // "YYYY-MM-DDTHH:MM"
    if (!byMinute.has(min)) byMinute.set(min, b);
  }
  for (const b of bars1m) {
    const min = b.timestamp.slice(0, 16);
    byMinute.set(min, b); // 1m always wins
  }
  return [...byMinute.values()].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
}

// ── Scanner class ─────────────────────────────────────────────────────────────

class Scanner extends EventEmitter {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} [config]
   */
  constructor(db, config = {}) {
    super();
    this.db = db;
    signalDedup.init(db);        // load persisted ideas + prep SQLite statements
    thresholdManager.init(db);   // create ai_thresholds table, warm cache

    this.cfg = {
      symbol:          config.symbol          || process.env.SCANNER_SYMBOL       || 'NQ=F',
      symbolMgc:       config.symbolMgc       || process.env.SCANNER_SYMBOL_MGC   || 'GC=F',
      scanInterval:    config.scanInterval    || Math.min(parseInt(process.env.SCAN_INTERVAL || '30') * 1000, 300_000),
      duplicateGuardMin: config.duplicateGuardMin || parseInt(process.env.SCANNER_DUPLICATE_GUARD_MIN || '5'),
      baseScore:       config.baseScore       || parseInt(process.env.SCANNER_MIN_SCORE   || '6'),
      dailySignalCap:  config.dailySignalCap  || parseInt(process.env.DAILY_SIGNAL_CAP    || '20'),
      dailyMinSignals: config.dailyMinSignals || parseInt(process.env.DAILY_MIN_SIGNALS   || '20'),
      logLevel:        config.logLevel        || (process.env.SCANNER_LOG_LEVEL || 'full').toLowerCase(),
      ntfyUrl:         config.ntfyUrl         || (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, ''),
      ntfyTopic:       config.ntfyTopic       || process.env.NTFY_TOPIC || '',
      ntfyToken:       config.ntfyToken       || process.env.NTFY_TOKEN || '',
      btIntervalH:     config.btIntervalH     || parseFloat(process.env.BACKTEST_INTERVAL_H  || '0.167'),  // 10 min default
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
    this._lastSignalTimes   = {}; // keyed by `${instrument}_${strategy_name}`
    this._edgeDegradState   = {};  // keyed by instrument — persisted to DB on change
    this._lastDiagSave          = { MNQ: 0, MGC: 0 };
    this._lastRejectionSave     = { MNQ: 0, MGC: 0 };
    // _lastEdgeDegradNtfy removed — edge degradation state is now DB-persisted (see _checkEdgeDegradation)
    this._scanCount         = 0;
    this._consecutiveErrors = 0;
    this._fetchBackoffUntil = 0;   // circuit breaker: epoch ms when backoff expires
    this._intervals         = [];
    this._running           = false;
    this._lastResearchAt    = 0;   // epoch ms of last research cycle (throttled to 1/hour)
    this._prevMarketOpen    = null; // null = first scan; used to detect closed→open transition
    this._startupNtfySent   = false; // in-memory flag: reset on every new process, never persisted
    this._lastFetchAt       = 0;   // epoch ms of last successful bar fetch
    this._lastDataStatus    = 'INIT'; // DATA_OK | DATA_STALE | DATA_MISSING | DATA_BACKOFF
    this._lastNtfyAttemptAt = 0;   // epoch ms of last ntfy send attempt
    this._lastNtfySuccessAt = 0;   // epoch ms of last ntfy HTTP 2xx response
    this._lastNtfyStatus    = null; // last HTTP status code from ntfy
    this._lastNtfyError     = null; // last ntfy error message
    // Idempotency: in-memory fast-path cache of (signalId, eventType) pairs already notified.
    // Populated from notification_log DB on startup so state survives process restarts.
    // Key format: `${signalId}_${eventType}`
    this._notifiedOutcomes  = new Set();
    this._notifiedEntries   = new Set(); // alias view — same Set, TRADE_ENTRY events

    // Prevents concurrent scan() calls from racing (BarWatcher + setInterval can both fire)
    this._scanInProgress    = false;

    // Cache last known good bars so a transient fetch error doesn't kill the scan
    this._lastGoodBars = {
      mnq5m: [], mnq1h: [], mgc5m: [], mgc1h: [],
    };

    // 1m bars fetched separately for outcome resolution (TP1/SL detection granularity)
    // Yahoo 5m forming bar may not update intrabar low/high until the bar closes;
    // 1m bars close every minute so TP1 touches are detected within ~60 seconds.
    this._resolution1m = { mnq: [], mgc: [] };
    this._resolution1mFetchedAt = 0;  // epoch ms of last 1m fetch

    // Feed adapter — Tradovate WebSocket if credentials present, Yahoo otherwise
    this._feed = createFeed({
      instruments: ['MNQ', 'MGC'],
      symbolMap:   {
        MNQ: process.env.TRADOVATE_SYMBOL_MNQ || '',
        MGC: process.env.TRADOVATE_SYMBOL_MGC || '',
      },
      pollMs: this.cfg.scanInterval,  // Tradovate: used for reconnect; Yahoo: adaptive internally
    });
    this.feedType = this._feed.constructor.name;  // 'TradovateFeed' | 'YahooFeed'

    // Create tp_hits BEFORE preparing statements — better-sqlite3 validates
    // that referenced tables exist at prepare() time, not execution time.
    db.exec(`
      CREATE TABLE IF NOT EXISTS tp_hits (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES signals(id),
        tp_level  INTEGER NOT NULL,
        hit_at    TEXT    NOT NULL,
        pnl_pts   REAL,
        UNIQUE(signal_id, tp_level)
      );
      CREATE INDEX IF NOT EXISTS idx_tp_hits_signal ON tp_hits(signal_id);

      CREATE TABLE IF NOT EXISTS notification_log (
        signal_id  INTEGER NOT NULL,
        event_type TEXT    NOT NULL,
        sent_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (signal_id, event_type)
      );
    `);

    this._prepareStatements();
  }

  // ── SQLite prepared statements ──────────────────────────────────────────────

  _prepareStatements() {
    const db = this.db;
    this._stmts = {
      insertSignal: db.prepare(`
        INSERT INTO signals
          (ticker, timeframe, direction, grade, setup, strategy_name, entry, sl, tp1, tp2, tp3,
           score, confidence, tier, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
           trade_style, instrument, rr, trade_status, raw_payload)
        VALUES
          (@ticker, @timeframe, @direction, @grade, @setup, @strategy_name, @entry, @sl, @tp1, @tp2, @tp3,
           @score, @confidence, @tier, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
           @trade_style, @instrument, @rr, @trade_status, @raw_payload)
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
        SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument,
               s.trade_style, s.strategy_name, s.session, s.setup,
               s.win_prob_tp1, s.quant_score, s.quant_grade, s.confidence,
               s.htf_bias, s.raw_payload, s.live_gated,
               json_extract(s.raw_payload, '$.context.prediction.win_rate_pct') AS predicted_wr_pct
        FROM   signals s
        LEFT JOIN outcomes o ON o.signal_id = s.id
        WHERE  o.id IS NULL
          AND  s.entry IS NOT NULL AND s.sl IS NOT NULL AND s.tp1 IS NOT NULL
          AND  s.received_at <= datetime('now', '-3 minutes')
          AND  (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
          AND  s.instrument = ?
        ORDER BY s.received_at ASC
      `),

      getAllPendingSignals: db.prepare(`
        SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument,
               s.trade_style, s.strategy_name, s.session, s.setup,
               s.win_prob_tp1, s.quant_score, s.quant_grade, s.confidence,
               s.htf_bias, s.raw_payload, s.live_gated
        FROM   signals s
        LEFT JOIN outcomes o ON o.signal_id = s.id
        WHERE  o.id IS NULL
          AND  s.entry IS NOT NULL AND s.sl IS NOT NULL AND s.tp1 IS NOT NULL
          AND  s.received_at <= datetime('now', '-3 minutes')
          AND  (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
        ORDER BY s.received_at ASC
      `),

      updateTradeStatus: db.prepare(`
        UPDATE signals SET trade_status = ? WHERE id = ?
      `),

      updateSigExpReason: db.prepare(`
        UPDATE signals SET expiration_reason = ? WHERE id = ?
      `),

      updateOutExpReason: db.prepare(`
        UPDATE outcomes SET expiration_reason = ? WHERE signal_id = ?
      `),

      getAllActiveSignals: db.prepare(`
        SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument,
               s.trade_style, s.strategy_name, s.session, s.setup,
               s.win_prob_tp1, s.live_gated
        FROM   signals s
        LEFT JOIN outcomes o ON o.signal_id = s.id
        WHERE  o.id IS NULL
          AND  s.entry IS NOT NULL
          AND  s.received_at <= datetime('now', '-3 minutes')
          AND  (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
        ORDER BY s.received_at ASC
      `),

      insertTpHit: db.prepare(`
        INSERT OR IGNORE INTO tp_hits (signal_id, tp_level, hit_at, pnl_pts)
        VALUES (?, ?, ?, ?)
      `),

      getWinSignalsPendingTPs: db.prepare(`
        SELECT s.id, s.direction, s.entry, s.tp1, s.tp2, s.tp3,
               s.instrument, s.strategy_name, s.session, s.trade_style,
               o.exit_at AS tp1_hit_at,
               CASE WHEN h2.id IS NOT NULL THEN 1 ELSE 0 END AS tp2_done,
               CASE WHEN h3.id IS NOT NULL THEN 1 ELSE 0 END AS tp3_done
        FROM   signals s
        JOIN   outcomes o ON o.signal_id = s.id AND o.result = 'WIN'
        LEFT JOIN tp_hits h2 ON h2.signal_id = s.id AND h2.tp_level = 2
        LEFT JOIN tp_hits h3 ON h3.signal_id = s.id AND h3.tp_level = 3
        WHERE  s.instrument = ?
          AND  o.exit_at >= datetime('now', '-24 hours')
          AND  (
            (s.tp2 IS NOT NULL AND h2.id IS NULL) OR
            (s.tp3 IS NOT NULL AND h3.id IS NULL)
          )
        ORDER BY o.exit_at DESC
        LIMIT 20
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

      insertHistBar: db.prepare(`
        INSERT OR IGNORE INTO historical_bars (symbol, interval, timestamp, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),

      loadHistBars: db.prepare(`
        SELECT timestamp, open, high, low, close, volume
        FROM historical_bars
        WHERE symbol = ? AND interval = ?
        ORDER BY timestamp ASC
      `),

      insertNotificationLog: db.prepare(`
        INSERT OR IGNORE INTO notification_log (signal_id, event_type)
        VALUES (?, ?)
      `),

      loadNotificationLog: db.prepare(`
        SELECT signal_id, event_type FROM notification_log
      `),

      getLatestRegime: db.prepare(`
        SELECT regime FROM regime_states
        WHERE instrument = ? AND classified_at > datetime('now', '-20 minutes')
        ORDER BY classified_at DESC LIMIT 1
      `),
    };
  }

  // ── Notification idempotency ──────────────────────────────────────────────────

  // Load all previously-sent notification keys from DB into the in-memory Sets.
  // Called once at start() so the Set survives PM2 restarts.
  _loadNotificationState() {
    try {
      const rows = this._stmts.loadNotificationLog.all();
      for (const { signal_id, event_type } of rows) {
        const key = `${signal_id}_${event_type}`;
        this._notifiedOutcomes.add(key);
        if (event_type === 'TRADE_ENTRY') this._notifiedEntries.add(key);
      }
      this._log(`NOTIFICATION_STATE_LOADED count=${rows.length}`, 'signal');
    } catch (err) {
      this._err('[notification] failed to load notification state from DB', err);
    }
  }

  // Atomically marks (signalId, eventType) as notified in both DB and in-memory Set.
  // Returns true if this is the FIRST time (should send), false if already notified (skip).
  // The DB PRIMARY KEY (signal_id, event_type) guarantees single-write even under concurrency.
  _tryMarkNotified(signalId, eventType) {
    const key = `${signalId}_${eventType}`;
    if (this._notifiedOutcomes.has(key)) return false;
    try {
      const info = this._stmts.insertNotificationLog.run(signalId, eventType);
      if (info.changes === 0) {
        // Already existed in DB — sync in-memory cache and skip
        this._notifiedOutcomes.add(key);
        if (eventType === 'TRADE_ENTRY') this._notifiedEntries.add(key);
        return false;
      }
    } catch (err) { this._log(`notification-log DB error (fail open): ${err.message}`, 'signal'); }
    this._notifiedOutcomes.add(key);
    if (eventType === 'TRADE_ENTRY') this._notifiedEntries.add(key);
    return true;
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
              'User-Agent': 'Mozilla/5.0 (compatible; AurumSignals/1.0)',
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

  // Seed _lastGoodBars from DB-persisted historical_bars on startup.
  // Prevents Yahoo Finance rate-limiting from blocking the scanner after a crash restart.
  _restoreBarCache() {
    try {
      const mnq5m = this._loadHistoricalBars(this.cfg.symbol,    '5m').slice(-500);
      const mnq1h = this._loadHistoricalBars(this.cfg.symbol,    '1h').slice(-500);
      const mgc5m = this._loadHistoricalBars(this.cfg.symbolMgc, '5m').slice(-500);
      const mgc1h = this._loadHistoricalBars(this.cfg.symbolMgc, '1h').slice(-500);
      if (mnq5m.length) { this._lastGoodBars.mnq5m = mnq5m; this._log(`[cache] restored ${mnq5m.length} MNQ 5m bars from DB`); }
      if (mnq1h.length) { this._lastGoodBars.mnq1h = mnq1h; this._log(`[cache] restored ${mnq1h.length} MNQ 1h bars from DB`); }
      if (mgc5m.length) { this._lastGoodBars.mgc5m = mgc5m; this._log(`[cache] restored ${mgc5m.length} MGC 5m bars from DB`); }
      if (mgc1h.length) { this._lastGoodBars.mgc1h = mgc1h; this._log(`[cache] restored ${mgc1h.length} MGC 1h bars from DB`); }
    } catch (e) { this._log(`[cache] bar restore error: ${e.message}`); }
  }

  _savePrice(symbol, bars) {
    if (!bars || bars.length < 2) return;
    const last  = bars[bars.length - 1];
    const first = bars[0];
    const chg   = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0;
    const high  = Math.max(...bars.map(b => b.high));
    const low   = Math.min(...bars.map(b => b.low));
    this._stmts.upsertPrice.run(symbol, last.close, first.open, +chg.toFixed(3), high, low);
  }

  // ── Historical bar archive ────────────────────────────────────────────────────

  _saveHistoricalBars(symbol, bars, interval = '1m') {
    if (!bars || bars.length === 0) return;
    const ins = this._stmts.insertHistBar;
    this.db.transaction(() => {
      for (const b of bars) {
        if (b.open == null || b.close == null) continue;
        ins.run(symbol, interval, b.timestamp, b.open, b.high, b.low, b.close, b.volume ?? 0);
      }
    })();
  }

  _loadHistoricalBars(symbol, interval = '1m') {
    return this._stmts.loadHistBars.all(symbol, interval);
  }

  // Merge two bar arrays by timestamp — prefer bars from `a` on collision.
  _mergeBarsByTimestamp(a, b) {
    const seen = new Set(a.map(bar => bar.timestamp));
    const merged = [...a];
    for (const bar of b) {
      if (!seen.has(bar.timestamp)) {
        seen.add(bar.timestamp);
        merged.push(bar);
      }
    }
    merged.sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));
    return merged;
  }

  // ── ntfy push ────────────────────────────────────────────────────────────────

  _sendNtfyPayload(payload) {
    if (!this.cfg.ntfyTopic) {
      this._log('NOTIFICATION_SEND_FAILED reason=NTFY_TOPIC_not_set', 'signal');
      return;
    }
    // Idempotency: DB-backed — survives PM2 restarts, impossible to double-send
    if (payload.id != null) {
      if (!this._tryMarkNotified(payload.id, 'TRADE_ENTRY')) {
        this._log(`ENTRY_NOTIFICATION_SKIPPED_DUPLICATE id=${payload.id}`, 'signal');
        return;
      }
    }
    const body    = buildNtfyBody(payload);
    const headers = buildNtfyHeaders(payload, { ntfyToken: this.cfg.ntfyToken });
    const url     = `${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`;
    this._lastNtfyAttemptAt = Date.now();
    this._log(`ENTRY_NOTIFICATION_SENT id=${payload.id ?? '?'} instr=${payload.instrument ?? ''} dir=${payload.direction ?? ''}`, 'signal');
    this._log(`NOTIFICATION_EVENT_CREATED event=TRADE_ENTRY instr=${payload.instrument ?? ''} dir=${payload.direction ?? ''}`, 'signal');
    this._log(`NOTIFICATION_SEND_START → ${url}`, 'signal');
    fetch(url, { method: 'POST', headers, body })
      .then(r => {
        this._lastNtfyStatus = r.status;
        if (r.ok) {
          this._lastNtfySuccessAt = Date.now();
          this._lastNtfyError = null;
          this._log(`NOTIFICATION_SEND_SUCCESS HTTP ${r.status}`, 'signal');
        } else {
          this._lastNtfyError = `HTTP ${r.status}`;
          this._log(`NOTIFICATION_SEND_FAILED HTTP ${r.status} (check NTFY_TOPIC / NTFY_TOKEN)`, 'signal');
        }
      })
      .catch(err => {
        this._lastNtfyError = err.message;
        this._log(`NOTIFICATION_SEND_FAILED network error: ${err.message}`, 'signal');
        this._err('[ntfy] send failed', err);
      });
  }

  // ── Outcome ntfy push ─────────────────────────────────────────────────────────
  // Idempotency: each (signalId, eventType) pair is only sent once per process.

  _sendNtfyOutcome(sig, result, pnlPts, exitPrice = null, exitAt = null) {
    if (!this.cfg.ntfyTopic) return;

    const eventType = result === 'WIN'  ? 'TRADE_WIN'
                    : result === 'LOSS' ? 'TRADE_LOSS'
                    : 'TRADE_BREAKEVEN';

    if (!this._tryMarkNotified(sig.id, eventType)) {
      this._log(`NOTIFICATION_SKIPPED reason=already_sent event=${eventType} id=${sig.id}`, 'signal');
      return;
    }

    this._log(`NOTIFICATION_EVENT_CREATED event=${eventType} id=${sig.id} instr=${sig.instrument} result=${result}`, 'signal');

    const body    = buildNtfyOutcomeBody(eventType, sig, { exitPrice, exitAt, pnlPts });
    const headers = buildNtfyOutcomeHeaders(eventType, sig, { ntfyToken: this.cfg.ntfyToken });
    const url     = `${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`;

    this._log(`NOTIFICATION_SEND_START event=${eventType} → ${url}`, 'signal');
    fetch(url, { method: 'POST', headers, body })
      .then(r => {
        if (r.ok) {
          this._log(`NOTIFICATION_SEND_SUCCESS HTTP ${r.status} event=${eventType}`, 'signal');
        } else {
          this._log(`NOTIFICATION_SEND_FAILED HTTP ${r.status} event=${eventType}`, 'signal');
        }
      })
      .catch(err => this._err(`[ntfy-outcome] ${eventType} send failed`, err));
  }

  // ── Expired ntfy push ─────────────────────────────────────────────────────────

  _sendNtfyExpired(sig, expReason) {
    if (!this.cfg.ntfyTopic) return;

    const eventType = expReason === 'EXPIRED_MARKET_CLOSE'  ? 'TRADE_EXPIRED_MARKET_CLOSE'
                    : expReason === 'EXPIRED_WEEKEND_CLOSE' ? 'TRADE_EXPIRED_WEEKEND_CLOSE'
                    : 'TRADE_EXPIRED_MAX_HOLD';

    if (!this._tryMarkNotified(sig.id, eventType)) {
      this._log(`NOTIFICATION_SKIPPED reason=already_sent event=${eventType} id=${sig.id}`, 'signal');
      return;
    }

    this._log(`NOTIFICATION_EVENT_CREATED event=${eventType} id=${sig.id} instr=${sig.instrument} reason=${expReason}`, 'signal');

    const now     = new Date().toISOString();
    const body    = buildNtfyOutcomeBody(eventType, sig, { exitAt: now, expReason });
    const headers = buildNtfyOutcomeHeaders(eventType, sig, { ntfyToken: this.cfg.ntfyToken });
    const url     = `${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`;

    this._log(`NOTIFICATION_SEND_START event=${eventType} → ${url}`, 'signal');
    fetch(url, { method: 'POST', headers, body })
      .then(r => {
        if (r.ok) {
          this._log(`NOTIFICATION_SEND_SUCCESS HTTP ${r.status} event=${eventType}`, 'signal');
        } else {
          this._log(`NOTIFICATION_SEND_FAILED HTTP ${r.status} event=${eventType}`, 'signal');
        }
      })
      .catch(err => this._err(`[ntfy-expired] send failed`, err));
  }

  // ── TP2 / TP3 push notification ───────────────────────────────────────────────

  _sendNtfyTpHit(sig, tpLevel, exitPrice, pnlPts) {
    if (!this.cfg.ntfyTopic) return;
    // Idempotency: TP hits had NO guard before — this is the critical fix
    const tpEventType = `TP${tpLevel}_HIT`;
    if (!this._tryMarkNotified(sig.id, tpEventType)) {
      this._log(`NOTIFICATION_SKIPPED reason=already_sent event=${tpEventType} id=${sig.id}`, 'signal');
      return;
    }
    const STRAT_LABELS = {
      MNQ_INTRADAY: 'MNQ Intraday', MGC_SCALP: 'MGC Scalp', NQ_NY_OPEN: 'NQ NY Open',
    };
    const stratLabel = STRAT_LABELS[sig.strategy_name] || sig.strategy_name || sig.instrument;
    const pnlStr     = pnlPts != null ? ` (+${pnlPts} pts)` : '';
    const emoji      = tpLevel === 2 ? '🎯' : '🔥';
    const headers    = {
      'Content-Type': 'text/plain',
      'Title':    `[TP${tpLevel}] ${sig.instrument} ${sig.direction}${pnlStr}`,
      'Priority': tpLevel === 2 ? 'high' : 'default',
      'Tags':     tpLevel === 2 ? 'dart,moneybag' : 'fire,moneybag',
    };
    if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
    const body = [
      `${emoji} TP${tpLevel} HIT — ${sig.direction} ${stratLabel}`,
      sig.entry != null ? `Entry: ${sig.entry}  →  TP${tpLevel}: ${exitPrice}` : null,
      pnlPts    != null ? `Gained: +${pnlPts} pts` : null,
      sig.session       ? `Session: ${sig.session}` : null,
      `Signal #${sig.id}`,
    ].filter(Boolean).join('\n');
    fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, { method: 'POST', headers, body })
      .catch(err => this._err('[ntfy-tp] send failed', err));
  }

  // ── Track TP2 / TP3 hits on already-won signals ───────────────────────────────

  _trackHigherTPs(bars, instrument) {
    try {
    const pending = this._stmts.getWinSignalsPendingTPs.all(instrument);
    if (!pending.length) return;

    // Pre-compute bar timestamps once — avoids O(signals × bars) Date constructions
    const barTimes = bars.map(b => new Date(b.timestamp).getTime());

    // How long after TP1 hit to keep tracking for TP2/TP3
    const TP_TRACK_MAX_MS = {
      scalp:    2  * 3_600_000,
      intraday: 6  * 3_600_000,
      swing:    24 * 3_600_000,
    };
    const now = Date.now();

    for (const sig of pending) {
      const tp1HitMs = new Date(sig.tp1_hit_at).getTime();
      const maxMs    = TP_TRACK_MAX_MS[sig.trade_style] ?? 6 * 3_600_000;
      if (now - tp1HitMs > maxMs) continue;

      // Use pre-computed timestamps for the filter
      const afterBars = bars.filter((_, i) => barTimes[i] > tp1HitMs);
      if (!afterBars.length) continue;

      const levels = [
        { level: 2, price: sig.tp2, done: !!sig.tp2_done },
        { level: 3, price: sig.tp3, done: !!sig.tp3_done },
      ].filter(l => l.price != null && !l.done);

      for (const { level, price } of levels) {
        for (const bar of afterBars) {
          const hit = sig.direction === 'LONG' ? bar.high >= price : bar.low <= price;
          if (hit) {
            const pnlPts = +(sig.direction === 'LONG'
              ? price - sig.entry
              : sig.entry - price).toFixed(2);
            this._stmts.insertTpHit.run(sig.id, level, bar.timestamp, pnlPts);
            this._sendNtfyTpHit(sig, level, price, pnlPts);
            this._log(
              `TP${level} HIT #${sig.id} ${instrument}: ${sig.direction} @ ${price} (+${pnlPts} pts)`,
              'signal'
            );
            break; // move on to next level
          }
        }
      }
    }
    } catch (err) { this._err('[tp-track] TP hit tracking error', err); }
  }

  // ── Signal storage ────────────────────────────────────────────────────────────

  _storeSignal(signal) {
    // Evaluate TP2/TP3 viability before storage.
    // Nulls out tp2/tp3 (and their win probs) when the adjusted win probability
    // doesn't clear the threshold — so they won't appear on the signal card,
    // ntfy notification, or TP-hit tracking.
    try {
      const tpv = evaluateTPViability(signal);
      if (!tpv.tp2Viable) {
        signal.tp2 = null;
        signal.win_prob_tp2 = null;
      }
      // TP3 requires TP2 to be viable — can't skip a level
      if (!tpv.tp2Viable || !tpv.tp3Viable) {
        signal.tp3 = null;
        signal.win_prob_tp3 = null;
      }
      this._log(
        `📊 TP viability ${signal.instrument} ${signal.direction}: ` +
        `TP2=${tpv.tp2Viable ? tpv.tp2AdjProb + '%✓' : tpv.tp2AdjProb + '%✗'} ` +
        `TP3=${tpv.tp3Viable ? tpv.tp3AdjProb + '%✓' : tpv.tp3AdjProb + '%✗'} ` +
        `[${tpv.factors}]`
      );
    } catch (err) { this._log(`tp-viability error: ${err.message}`, 'signal'); }

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
    } catch (err) { this._log(`predicted-wr error: ${err.message}`, 'signal'); }

    const received_at = new Date().toISOString();
    const rank        = signal._rank ?? null;
    // Build canonical payload; id is null until after insert
    const prePayload  = buildAlertPayload(signal, { id: null, received_at, rank });

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
      confidence:    signal.confidence   ?? null,
      tier:          signal.tier         ?? null,
      win_prob_tp1:  signal.win_prob_tp1,
      win_prob_tp2:  signal.win_prob_tp2,
      win_prob_tp3:  signal.win_prob_tp3,
      htf_bias:      signal.htf_bias     ?? null,
      session:       signal.session,
      trade_style:   signal.trade_style  ?? null,
      instrument:    signal.instrument,
      rr:            signal.rr,
      trade_status:  STATES.ACTIVE,
      raw_payload:   JSON.stringify(prePayload),
    });

    const id         = info.lastInsertRowid;

    // Set expires_at and live_gated on the newly inserted signal
    try {
      const holdMs = MAX_HOLD_MS_BY_STRATEGY[signal.strategy_name]
        ?? (signal.trade_style === 'swing' ? 72*3600000 : signal.trade_style === 'scalp' ? 2*3600000 : 6*3600000);
      const expiresAt = new Date(Date.now() + holdMs).toISOString();
      this.db.prepare('UPDATE signals SET expires_at = ? WHERE id = ?').run(expiresAt, id);
      if (rank?.liveGated) {
        this.db.prepare('UPDATE signals SET live_gated = 1 WHERE id = ?').run(id);
      }
    } catch (err) { this._log(`expires-at/live-gated update error: ${err.message}`, 'signal'); }

    // Persist agent scores for audit trail (async — never blocks signal storage)
    if (signal._agentScores) {
      setImmediate(() => gatekeeper.persistAgentScores(this.db, id, signal._agentScores));
    }

    const stratLabel = signal.strategy_name ?? signal.setup ?? 'unknown';
    const gateStr    = signal._gateVerdict ? ` gate=${signal._gateVerdict}(${signal._gateScore})` : '';
    const logMsg = `✅ SIGNAL #${id} | ${signal.instrument} ${signal.direction} ${signal.grade} | ` +
      `${stratLabel} | confidence=${signal.confidence ?? signal.score}/100 | entry=${signal.entry} | rr=${signal.rr}${gateStr}`;
    this._log(logMsg, 'signal');

    // Rebuild with id for emit + ntfy
    const payload = buildAlertPayload(signal, { id, received_at, rank });
    this.emit('signal', { ...flattenPayload(payload), raw_payload: JSON.stringify(payload) });
    // Live-gated signals are stored for backtest/research but do not fire a
    // live notification (confidence below strategy's LIVE_THRESHOLDS).
    if (rank?.liveGated) {
      this._log(`SIGNAL_RESEARCH_ONLY #${id} strat=${signal.strategy_name} conf=${signal.confidence} (below live min — no ntfy)`, 'signal');
    } else {
      this._sendNtfyPayload(payload);
    }
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
    } catch (err) { this._log(`store-rejection error: ${err.message}`, 'signal'); }
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
    } catch (err) { this._log(`store-scan-diag error: ${err.message}`, 'signal'); }
  }

  // ── Auto-resolve pending outcomes ─────────────────────────────────────────────

  _autoResolveOutcomes(bars5m, instrument) {
    const pending = this._stmts.getPendingSignals.all(instrument);
    if (!pending.length) return;
    let resolvedCount = 0;
    const now = new Date();

    for (const sig of pending) {
      const sigTime    = new Date(sig.received_at).getTime();
      const futureBars = bars5m.filter(b => new Date(b.timestamp).getTime() > sigTime);

      let resolution = null, exitBar = null;

      // Walk forward bars looking for TP1 or SL hit
      for (const bar of futureBars) {
        resolution = resolveBar(sig, bar);
        if (resolution) { exitBar = bar; break; }
      }

      // No TP1/SL hit yet — check expiry
      if (!resolution && shouldExpire(sig, now).expire) {
        const lastBar = futureBars[futureBars.length - 1];
        resolution = {
          toState:   STATES.EXPIRED,
          exitPrice: lastBar?.close ?? sig.entry,
          pnlPts:    0,
        };
        exitBar = lastBar ?? null;
      }

      if (!resolution) continue;

      const result = stateToResult(resolution.toState);
      if (!result) continue;

      const pnlPts = result === 'EXPIRED' ? 0 : +resolution.pnlPts.toFixed(2);

      // Compute MFE / MAE and hold time from bars before writing outcome
      const { mfePts, maePts, holdTimeMin } = computeMfeMae(futureBars, sig, exitBar);

      this._stmts.insertOutcome.run(
        sig.id, result, resolution.exitPrice,
        exitBar?.timestamp ?? now.toISOString(),
        pnlPts
      );
      this._stmts.updateTradeStatus.run(resolution.toState, sig.id);

      // Backfill enriched columns into outcome row
      try {
        this.db.prepare(`
          UPDATE outcomes SET
            mfe_pts = ?, mae_pts = ?, hold_time_min = ?,
            quant_score = ?, quant_grade = ?
          WHERE signal_id = ?
        `).run(mfePts, maePts, holdTimeMin, sig.quant_score ?? null, sig.quant_grade ?? null, sig.id);
      } catch (err) { this._log(`outcome-enrich error: ${err.message}`, 'signal'); }

      // Release the dedup slot so a genuinely new setup at the same zone can
      // alert immediately rather than waiting for the suppression window.
      if (result === 'WIN' || result === 'LOSS') {
        signalDedup.releaseBySignal(sig);
      }

      this._log(`AUTO-RESOLVE #${sig.id} ${instrument}: ${sig.direction} → ${resolution.toState}${pnlPts !== 0 ? ` (${pnlPts > 0 ? '+' : ''}${pnlPts} pts)` : ''}${mfePts != null ? ` MFE=${mfePts} MAE=${maePts}` : ''}`, 'signal');
      this.emit('outcome', { signalId: sig.id, instrument, result, pnlPts });
      // Only send outcome notifications for live signals (live_gated=0/null).
      // Research-only signals never sent entry alerts, so outcomes would be confusing noise.
      if (result !== 'EXPIRED' && !sig.live_gated) this._sendNtfyOutcome(sig, result, pnlPts, resolution.exitPrice, exitBar?.timestamp);

      // Loss forensics — classify and write for all non-WIN outcomes
      if (result === 'LOSS' || result === 'EXPIRED' || result === 'BE') {
        try {
          const forensicCtx = { mfePts, maePts, holdTimeMin, pnlPts, regime: null, atr: null };
          const classification = writeLossForensic(this.db, sig, result, forensicCtx);
          if (classification) {
            this._log(`LOSS_FORENSIC #${sig.id} strategy=${sig.strategy_name} category=${classification.category} sub=${classification.subcategory ?? '-'}`, 'signal');
            // Cluster detection — check last 10 losses for this strategy
            const cluster = detectClusters(this.db, sig.strategy_name, 10);
            if (cluster) this._log(formatClusterLog(cluster), 'signal');
          }
        } catch (err) { this._log(`loss-forensics error: ${err.message}`, 'signal'); }
      }

      resolvedCount++;
    }

    // ── Retroactively correct signals expired by the sweep before bar resolution ──
    // Fixes the live race: sweep fires at 13:00 PT and expires a signal whose bar
    // showed TP1 was hit at 12:58 PT before the next scan could detect it.
    const retroCutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
    const recentlyExpired = this.db.prepare(`
      SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument,
             s.trade_style, s.strategy_name, s.session, s.setup, s.win_prob_tp1,
             s.quant_score, s.quant_grade, s.confidence, s.htf_bias, s.raw_payload,
             json_extract(s.raw_payload, '$.context.prediction.win_rate_pct') AS predicted_wr_pct,
             o.exit_at AS expired_at
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  o.result = 'EXPIRED'
        AND  o.exit_at >= ?
        AND  s.entry IS NOT NULL AND s.sl IS NOT NULL AND s.tp1 IS NOT NULL
        AND  s.instrument = ?
    `).all(retroCutoff, instrument);

    for (const sig of recentlyExpired) {
      const sigTime   = new Date(sig.received_at).getTime();
      const expiredAt = new Date(sig.expired_at).getTime();
      const validBars = bars5m.filter(b => {
        const ts = new Date(b.timestamp).getTime();
        return ts > sigTime && ts <= expiredAt;
      });

      for (const bar of validBars) {
        const resolution = resolveBar(sig, bar);
        if (!resolution) continue;
        const result = stateToResult(resolution.toState);
        if (result !== 'WIN' && result !== 'LOSS') continue;

        const pnlPts = +resolution.pnlPts.toFixed(2);
        this.db.prepare(
          `UPDATE outcomes SET result = ?, exit_price = ?, exit_at = ?, pnl_pts = ?, expiration_reason = NULL WHERE signal_id = ?`
        ).run(result, resolution.exitPrice, bar.timestamp, pnlPts, sig.id);
        this._stmts.updateTradeStatus.run(resolution.toState, sig.id);
        // Backfill enrichment columns for retro-fixed outcomes
        try {
          const { mfePts, maePts, holdTimeMin } = computeMfeMae(validBars, sig, bar);
          this.db.prepare(`
            UPDATE outcomes SET
              mfe_pts = ?, mae_pts = ?, hold_time_min = ?,
              quant_score = ?, quant_grade = ?
            WHERE signal_id = ?
          `).run(mfePts, maePts, holdTimeMin, sig.quant_score ?? null, sig.quant_grade ?? null, sig.id);
          // Forensics for retro-fixed LOSS outcomes
          if (result === 'LOSS') {
            try {
              const classification = writeLossForensic(this.db, sig, 'LOSS', {
                mfePts, maePts, holdTimeMin, pnlPts, regime: null, atr: null,
              });
              if (classification) {
                this._log(`LOSS_FORENSIC #${sig.id} strategy=${sig.strategy_name} category=${classification.category} (retro-fix)`, 'signal');
                const cluster = detectClusters(this.db, sig.strategy_name, 10);
                if (cluster) this._log(formatClusterLog(cluster), 'signal');
              }
            } catch (err) { this._log(`retro-forensics error: ${err.message}`, 'signal'); }
          }
        } catch (err) { this._log(`retro-backfill error: ${err.message}`, 'signal'); }
        if (result === 'WIN' || result === 'LOSS') signalDedup.releaseBySignal(sig);
        this._log(`RETRO-FIX #${sig.id} ${instrument}: EXPIRED → ${result}${pnlPts !== 0 ? ` (${pnlPts > 0 ? '+' : ''}${pnlPts} pts)` : ''}`, 'signal');
        this.emit('outcome', { signalId: sig.id, instrument, result, pnlPts });
        if (!sig.live_gated) this._sendNtfyOutcome(sig, result, pnlPts, resolution.exitPrice, bar.timestamp);
        resolvedCount++;
        break;
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
      } catch (err) { this._log(`live-learn update error: ${err.message}`, 'signal'); }

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
      } catch (err) { this._log(`pattern-memory update error: ${err.message}`, 'signal'); }

      // Update opening candle bias accuracy from newly resolved outcomes
      try {
        const recentWithNotes = this.db.prepare(`
          SELECT s.direction, s.session, s.notes, o.result AS outcome
          FROM   signals s
          JOIN   outcomes o ON o.signal_id = s.id
          WHERE  s.instrument = ?
            AND  o.exit_at >= datetime('now', '-1 hour')
        `).all(instrument);
        for (const t of recentWithNotes) {
          if (!t.notes || !t.outcome || !t.direction) continue;
          let sessionKey = null, bias = null;
          try {
            const meta = JSON.parse(t.notes);
            sessionKey = meta._ocSessionKey ?? null;
            bias       = meta._ocBias ?? null;
          } catch (err) { this._log(`parse-oc-meta error: ${err.message}`, 'signal'); }
          if (sessionKey && bias) {
            updateSessionBiasAccuracy(this.db, instrument, sessionKey, bias, t.direction, t.outcome);
          }
        }
      } catch (err) { this._log(`session-bias-accuracy error: ${err.message}`, 'signal'); }

      // Recompute adaptive overrides after new outcomes arrive
      try { computeAdaptiveOverrides(this.db); } catch (err) { this._log(`adaptive-overrides error: ${err.message}`, 'signal'); }
    }
  }

  // ── Closed-market research cycle ─────────────────────────────────────────────
  // Runs at most once per hour during blackout/overnight periods.
  // Uses accumulated historical bars to run a lightweight backtest and surface
  // key edge health metrics — no live fetches, no signal emission.

  async _runResearchCycle() {
    try {
      const instruments = ['MNQ', 'MGC'];
      const summary = [];

      for (const instrument of instruments) {
        const symbol = this.cfg.btSymbols[instrument];
        if (!symbol) continue;

        const bars1m = this._loadHistoricalBars(symbol, '1m');
        const bars5m = this._loadHistoricalBars(symbol, '5m');

        // Prefer whichever set has more coverage; need at least 200 bars
        const bars = bars5m.length >= bars1m.length ? bars5m : bars1m;
        const interval = bars5m.length >= bars1m.length ? '5m' : '1m';
        if (bars.length < 200) continue;

        const params = getParams(this.db, instrument);
        const mode   = interval === '5m' ? 'research5m' : 'research';
        const result = await this._runBacktestInWorker(
          bars, params, { instrument, slippage: this.cfg.btSlippage, walkForward: false },
          [], 0, mode,
        );

        const m = result?.metrics;
        if (!m || (m.tradeCount ?? 0) === 0) continue;

        const dwFirst = bars[0]?.timestamp?.slice(0, 10) ?? '?';
        const dwLast  = bars[bars.length - 1]?.timestamp?.slice(0, 10) ?? '?';
        const wrPct   = (m.winRate * 100).toFixed(1);
        const pf      = m.profitFactor?.toFixed(2) ?? 'N/A';

        summary.push(`${instrument}: WR=${wrPct}% PF=${pf} trades=${m.tradeCount} [${dwFirst}→${dwLast}]`);

        // Update learning state from research backtest (same as live backtest path)
        try {
          updateLearningFromLiveSignals(this.db, result.signalLog ?? []);
          updateSessionBiasFromBacktest(this.db, instrument, result.signalLog ?? []);
        } catch (err) { this._log(`research-learn error: ${err.message}`, 'signal'); }
      }

      if (summary.length > 0) {
        this._log(`🔬 RESEARCH MODE: ${summary.join(' | ')}`);
        this.emit('research', { at: ts(), summary });
      }
    } catch (err) {
      this._err('_runResearchCycle error', err);
    }
  }

  // ── Timer-based expiry sweep ──────────────────────────────────────────────────
  // Runs every 5 min regardless of market hours or bars availability.
  // Expires ACTIVE signals that have exceeded their max hold time so signals
  // don't stay open indefinitely if the scanner was down or bars were unavailable.

  _sweepExpiredSignals() {
    try {
      // Use getAllActiveSignals (no sl/tp1 requirement) so signals that lack
      // price levels are not silently skipped by this sweep.
      const pending = this._stmts.getAllActiveSignals.all();
      const now = new Date();

      if (pending.length > 0) {
        this._log(`RECONCILIATION_TICK checking ${pending.length} active signal(s)`, 'signal');
      }
      console.log(`[${now.toISOString()}] [sweep] checking ${pending.length} active signal(s)`);
      if (!pending.length) return;

      let swept = 0;

      // PT timezone context
      const nowPt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const ptHm  = nowPt.getHours() * 60 + nowPt.getMinutes();
      const ptDow = nowPt.getDay(); // 0=Sun,1=Mon,...,5=Fri,6=Sat
      const ptDateStr = `${nowPt.getFullYear()}-${String(nowPt.getMonth()+1).padStart(2,'0')}-${String(nowPt.getDate()).padStart(2,'0')}`;

      // Weekend forced close: Fri 13:00 PT onward, all day Sat, Sun before 14:00 PT
      const isFridayClose  = ptDow === 5 && ptHm >= 13 * 60;
      const isWeekend      = ptDow === 6 || (ptDow === 0 && ptHm < 14 * 60);
      const isWeekendClose = isFridayClose || isWeekend;

      // Weekday after maintenance close: any time on a weekday at or past 13:00 PT.
      // We check the SIGNAL's creation time (in PT) against the daily 13:00 close so
      // that a server restart at 14:30 PT still expires signals created before 13:00 PT.
      const pastDailyClose = ptDow >= 1 && ptDow <= 5 && ptHm >= 13 * 60;

      const expireSignal = (sig, reason) => {
        this._stmts.insertOutcome.run(sig.id, 'EXPIRED', sig.entry, now.toISOString(), 0);
        this._stmts.updateTradeStatus.run(STATES.EXPIRED, sig.id);
        try {
          this._stmts.updateSigExpReason.run(reason, sig.id);
          this._stmts.updateOutExpReason.run(reason, sig.id);
        } catch (err) { this._log(`sweep-exp-reason error: ${err.message}`, 'signal'); }
        // Backfill enrichment columns into the outcome row
        try {
          const holdMs  = now.getTime() - new Date(sig.received_at).getTime();
          const holdMin = +(holdMs / 60000).toFixed(1);
          this.db.prepare(`
            UPDATE outcomes SET hold_time_min = ?, quant_score = ?, quant_grade = ?
            WHERE signal_id = ?
          `).run(holdMin, sig.quant_score ?? null, sig.quant_grade ?? null, sig.id);
        } catch (err) { this._log(`sweep-outcome-enrich error: ${err.message}`, 'signal'); }
        if (!sig.live_gated) this._sendNtfyExpired(sig, reason);
        // Loss forensics for sweep-expired signals (no bars available — limited context)
        try {
          const holdMs  = now.getTime() - new Date(sig.received_at).getTime();
          const holdMin = +(holdMs / 60000).toFixed(1);
          const classification = writeLossForensic(this.db, sig, 'EXPIRED', {
            holdTimeMin: holdMin,
            pnlPts:      0,
            regime:      null,
            atr:         null,
          });
          if (classification) {
            this._log(`LOSS_FORENSIC #${sig.id} strategy=${sig.strategy_name} category=${classification.category} reason=${reason}`, 'signal');
            const cluster = detectClusters(this.db, sig.strategy_name, 10);
            if (cluster) this._log(formatClusterLog(cluster), 'signal');
          }
        } catch (err) { this._log(`sweep-forensics error: ${err.message}`, 'signal'); }
        console.log(`[sweep] EXPIRED #${sig.id} ${sig.instrument} ${sig.direction} reason=${reason} age=${Math.round((now - new Date(sig.received_at)) / 60000)}m`);
      };

      for (const sig of pending) {
        const stratCfg = STRATEGY_CONFIG[sig.strategy_name] || {};

        // RULE D: Weekend forced close
        if (isWeekendClose && !stratCfg.allowHoldWeekend) {
          expireSignal(sig, 'EXPIRED_WEEKEND_CLOSE');
          swept++;
          continue;
        }

        // RULE C: Weekday market close (expanded — catches restarts after the 1-2 PM window)
        // Expire any non-overnight signal that was created before today's 13:00 PT
        // and it is now at or past 13:00 PT on the same or a later day.
        if (pastDailyClose && !stratCfg.allowHoldOvernight) {
          const sigPt    = new Date(new Date(sig.received_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
          const sigDateStr = `${sigPt.getFullYear()}-${String(sigPt.getMonth()+1).padStart(2,'0')}-${String(sigPt.getDate()).padStart(2,'0')}`;
          const sigHm    = sigPt.getHours() * 60 + sigPt.getMinutes();
          // Signal was created before today's 13:00 PT, or was created on a prior calendar day
          if (sigDateStr < ptDateStr || (sigDateStr === ptDateStr && sigHm < 13 * 60)) {
            expireSignal(sig, 'EXPIRED_MARKET_CLOSE');
            swept++;
            continue;
          }
        }

        // RULE B: Max hold time exceeded
        const expResult = shouldExpire(sig, now);
        if (expResult.expire) {
          expireSignal(sig, expResult.reason || 'EXPIRED_MAX_HOLD');
          swept++;
        }
      }

      if (swept > 0) {
        console.log(`[sweep] closed ${swept} signal(s)`);
        try { computeAdaptiveOverrides(this.db); } catch (err) { this._log(`sweep-adaptive-overrides error: ${err.message}`, 'signal'); }
      }
    } catch (err) {
      this._err('_sweepExpiredSignals error', err);
    }
  }

  // ── Fix stuck trades (runs once at startup) ──────────────────────────────────

  _fixStuckTrades() {
    try {
      // Fetch ALL ACTIVE/NULL signals with no outcome (no age cutoff — any age)
      const stuckSignals = this.db.prepare(`
        SELECT s.id, s.direction, s.entry, s.sl, s.tp1, s.received_at, s.instrument,
               s.trade_style, s.strategy_name, s.session, s.setup
        FROM signals s
        LEFT JOIN outcomes o ON o.signal_id = s.id
        WHERE o.id IS NULL
          AND s.entry IS NOT NULL
          AND (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
      `).all();

      const now = new Date();
      console.log(`[${now.toISOString()}] [fixStuck] found ${stuckSignals.length} unresolved signal(s)`);
      if (!stuckSignals.length) return;

      const nowPt      = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const ptHm       = nowPt.getHours() * 60 + nowPt.getMinutes();
      const ptDow      = nowPt.getDay();
      const ptDateStr  = `${nowPt.getFullYear()}-${String(nowPt.getMonth()+1).padStart(2,'0')}-${String(nowPt.getDate()).padStart(2,'0')}`;

      const isFriClose     = ptDow === 5 && ptHm >= 13 * 60;
      const isWeekend      = ptDow === 6 || (ptDow === 0 && ptHm < 14 * 60);
      const isWeekendClose = isFriClose || isWeekend;
      // Expanded: any weekday time at or past 13:00 PT (not just the 1-hour maintenance window)
      const pastDailyClose = ptDow >= 1 && ptDow <= 5 && ptHm >= 13 * 60;

      let fixed = 0;

      for (const sig of stuckSignals) {
        try {
          const stratCfg = STRATEGY_CONFIG[sig.strategy_name] || {};
          const maxMs    = MAX_HOLD_MS_BY_STRATEGY[sig.strategy_name]
            ?? (sig.trade_style === 'swing' ? 72*3600000 : 23*3600000);
          const ageMs    = now.getTime() - new Date(sig.received_at).getTime();

          let reason = null;

          if (isWeekendClose && !stratCfg.allowHoldWeekend) {
            reason = 'EXPIRED_WEEKEND_CLOSE';
          } else if (pastDailyClose && !stratCfg.allowHoldOvernight) {
            // Signal was created before today's 13:00 PT, or on a prior calendar day
            const sigPt      = new Date(new Date(sig.received_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
            const sigDateStr  = `${sigPt.getFullYear()}-${String(sigPt.getMonth()+1).padStart(2,'0')}-${String(sigPt.getDate()).padStart(2,'0')}`;
            const sigHm       = sigPt.getHours() * 60 + sigPt.getMinutes();
            if (sigDateStr < ptDateStr || (sigDateStr === ptDateStr && sigHm < 13 * 60)) {
              reason = 'EXPIRED_MARKET_CLOSE';
            }
          }

          if (!reason && ageMs > maxMs) {
            reason = ageMs > 3 * 24 * 3600000 ? 'EXPIRED_STUCK_TRADE' : 'EXPIRED_MAX_HOLD';
          }

          if (!reason) continue;

          this._stmts.insertOutcome.run(sig.id, 'EXPIRED', sig.entry, now.toISOString(), 0);
          this._stmts.updateTradeStatus.run(STATES.EXPIRED, sig.id);
          try {
            this._stmts.updateSigExpReason.run(reason, sig.id);
            this._stmts.updateOutExpReason.run(reason, sig.id);
          } catch (err) { this._log(`fix-stuck-exp-reason error: ${err.message}`, 'signal'); }
          console.log(`[fixStuck] EXPIRED #${sig.id} ${sig.instrument} ${sig.direction} reason=${reason} age=${Math.round(ageMs/3600000)}h`);
          fixed++;
        } catch (err) { this._log(`fix-stuck per-signal error: ${err.message}`, 'signal'); }
      }
      if (fixed > 0) {
        console.log(`[fixStuck] expired ${fixed} stuck trade(s)`);
        try { computeAdaptiveOverrides(this.db); } catch (err) { this._log(`fix-stuck adaptive-overrides error: ${err.message}`, 'signal'); }
      }
    } catch (err) {
      this._err('_fixStuckTrades error', err);
    }
  }

  // ── Per-instrument scan ───────────────────────────────────────────────────────

  async _scanInstrument(instrument, bars5m, bars15m, bars1h, bars4h, barsDly, bars30m = [], bars45m = [], bars3m = []) {
    const duplicateGuardMs = this.cfg.duplicateGuardMin * 60_000;

    // Daily cap
    const todayCount = this._stmts.dailySignalCount.get(instrument)?.cnt ?? 0;
    if (todayCount >= this.cfg.dailySignalCap) {
      if (this.cfg.logLevel === 'full') {
        this._log(`🚫 ${instrument} daily cap (${todayCount}/${this.cfg.dailySignalCap})`);
      }
      return;
    }

    // ── Record opening candle for power-hour / session bias tracking ────────────
    // Scan ALL of today's 5m bars so that session opens recorded before this
    // scan cycle (e.g. 9:30 NY Open when scanner started at noon) are backfilled.
    // recordOpeningCandle is idempotent — it skips already-stored sessions.
    let currentSessionBias = null;
    try {
      const todayKey  = getEtDateKey(new Date().toISOString());
      const todayBars = bars5m.filter(b => getEtDateKey(b.timestamp) === todayKey);
      for (const bar of todayBars) {
        const ocEntry = recordOpeningCandle(this.db, instrument, bar);
        if (ocEntry) {
          this._log(`🕯️  ${instrument} opening candle: ${ocEntry.sessionKey} ${ocEntry.bias} str=${ocEntry.strength.toFixed(2)}`);
        }
      }
      const latestBar = bars5m[bars5m.length - 1];
      currentSessionBias = getSessionOpenBias(this.db, instrument, latestBar?.timestamp ?? new Date().toISOString());
    } catch (err) { this._log(`opening-candle scan error: ${err.message}`, 'signal'); }

    const barSets = instrument === 'MGC'
      ? { bars3mMgc: bars3m, bars5mMgc: bars5m, bars15mMgc: bars15m, bars30mMgc: bars30m, bars45mMgc: bars45m, bars1hMgc: bars1h }
      : { bars5m, bars15m, bars1h, bars4h, barsDly };

    this._log(`STRATEGY_SCAN_START instrument=${instrument} bars5m=${bars5m.length} bars15m=${bars15m.length} bars1h=${bars1h.length}`, 'signal');
    const signals         = evaluateAll(barSets, { instrument });
    const stratsFiredNames = signals.map(s => s.strategy_name);
    let anyFired          = false;

    // Candidate signals logged at 'signal' level so they're always visible in Render
    if (signals.length > 0) {
      const summary = signals.map(s => `${s.strategy_name}(${s.direction} conf=${s.confidence})`).join(', ');
      this._log(`SIGNAL_CANDIDATE_CREATED ${instrument} ${summary}`, 'signal');
    } else {
      this._log(`STRATEGY_SCAN_COMPLETE instrument=${instrument} candidates=0 scan=#${this._scanCount}`, 'signal');
    }

    // ── Minimum daily signal guarantee — 3-tier confidence relaxation ────────────
    // Target: 20 signals per instrument per day (20 MNQ + 20 MGC = 40 total).
    // Cap: 20 per instrument — fills the full allocation every trading day.
    // Duplicate guard (SCANNER_DUPLICATE_GUARD_MIN) keeps cap clean; adaptive cooldown handles real timing.
    // When behind pace, confidence gate is progressively relaxed across the day.
    const todayCountNow = this._stmts.dailySignalCount.get(instrument)?.cnt ?? 0;
    const minTarget     = this.cfg.dailyMinSignals ?? 20;
    const nowHhmm = (() => {
      const d = new Date();
      return (d.getUTCHours() - 4) * 100 + d.getUTCMinutes(); // rough ET
    })();
    // Expected pace: 20 signals over 6.5h ≈ 3 signals/hour
    //   By 9:30 AM  → 0 expected (market just opened)
    //   By 11:00 AM → ~5 expected
    //   By 1:00 PM  → ~11 expected
    //   By 3:00 PM  → ~17 expected
    const expectedByNow = Math.min(minTarget, Math.max(0, Math.round((nowHhmm - 930) / 650 * minTarget)));
    const pace          = todayCountNow - expectedByNow; // negative = behind pace
    let minConfBonus = 0;
    if      (pace <= -8  && nowHhmm >= 1300 && nowHhmm < 1600) minConfBonus = -22; // very behind afternoon
    else if (pace <= -5  && nowHhmm >= 1100 && nowHhmm < 1600) minConfBonus = -16; // behind midday
    else if (pace <= -3  && nowHhmm >= 930  && nowHhmm < 1600) minConfBonus = -10; // slightly behind morning
    else if (pace <= -1  && nowHhmm >= 930  && nowHhmm < 1600) minConfBonus = -6;  // just a bit slow

    if (minConfBonus < 0 && this._scanCount % 3 === 0) {
      this._log(`📊 ${instrument} pace: ${todayCountNow}/${minTarget} (expected ${expectedByNow}) — gate ${minConfBonus} pts`);
    }

    // Load adaptive overrides once per scan (auto-computed from live WR data)
    let adaptiveOverrides = {};
    try { adaptiveOverrides = loadAdaptiveOverrides(this.db); } catch (err) { this._log(`load-adaptive-overrides error: ${err.message}`, 'signal'); }

    // Regime is needed by the adaptive cooldown engine — fetch once per scan cycle
    let currentRegime = 'unknown';
    try { currentRegime = getMarketRegime(this.db); } catch (err) { this._log(`get-market-regime error: ${err.message}`, 'signal'); }

    // Fresh regime from regime-agent-worker (< 20 min old) takes priority for signal context
    let dbRegime = null;
    try {
      const rgRow = this._stmts.getLatestRegime.get(instrument);
      if (rgRow?.regime) dbRegime = rgRow.regime;
    } catch (err) { this._log(`regime_states read error: ${err.message}`, 'signal'); }

    for (const sig of signals) {
      const stratKey = `${instrument}_${sig.strategy_name}`;

      // ── Duplicate guard — spam/same-bar prevention only (SCANNER_DUPLICATE_GUARD_MIN) ──
      if (Date.now() - (this._lastSignalTimes[stratKey] ?? 0) < duplicateGuardMs) {
        const guarMin = Math.ceil((duplicateGuardMs - (Date.now() - (this._lastSignalTimes[stratKey] ?? 0))) / 60000);
        this._log(`SIGNAL_FILTERED_OUT reason=duplicate_guard strat=${sig.strategy_name} remainingMin=${guarMin}`, 'signal');
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, null, 'duplicate_guard');
        continue;
      }

      // ── Adaptive cooldown — context-aware timing control ──────────────────
      // Prefer dbRegime (precise new vocab from regime_states); fall back to
      // currentRegime (old vocab from getMarketRegime) when agent hasn't run yet.
      const cooldownResult = checkAdaptiveCooldown({
        strategyName:   sig.strategy_name,
        instrument,
        session:        sig.session ?? 'unknown',
        regime:         dbRegime ?? currentRegime,
        confidence:     sig.confidence,
        lastSignalTime: this._lastSignalTimes[stratKey] ?? 0,
        db:             this.db,
      });

      if (!cooldownResult.allowed) {
        const remStr = cooldownResult.remainingMin === Infinity ? '∞' : `${cooldownResult.remainingMin?.toFixed(1)}`;
        const reason = `adaptive_cooldown: ${cooldownResult.reason} (${remStr}min remaining)`;
        this._log(`SIGNAL_FILTERED_OUT reason=adaptive_cooldown strat=${sig.strategy_name} remainingMin=${remStr}`, 'signal');
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, null, reason);
        if (this.cfg.logLevel === 'full') {
          this._log(formatBlockLog(sig.strategy_name, instrument, sig.session ?? 'unknown',
            sig.confidence, currentRegime, cooldownResult));
        }
        continue;
      }

      // ── Adaptive overrides (genuine learning — auto-block bad patterns) ────
      const ov = adaptiveOverrides[sig.strategy_name];
      if (ov) {
        if (ov.paused) {
          const reason = `strategy paused by adaptive learning (${(ov.reasons ?? []).slice(-1)[0] ?? 'poor WR'})`;
          this._log(`SIGNAL_FILTERED_OUT reason=strategy_paused strat=${sig.strategy_name} cause=${(ov.reasons ?? []).slice(-1)[0] ?? 'poor WR'}`, 'signal');
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, reason);
          continue;
        }
        if (sig.direction === 'LONG'  && ov.blockLong) {
          this._log(`SIGNAL_FILTERED_OUT reason=long_blocked strat=${sig.strategy_name} cause=low_LONG_WR`, 'signal');
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, 'LONG direction blocked by adaptive learning (low LONG WR)');
          continue;
        }
        if (sig.direction === 'SHORT' && ov.blockShort) {
          this._log(`SIGNAL_FILTERED_OUT reason=short_blocked strat=${sig.strategy_name} cause=low_SHORT_WR`, 'signal');
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, 'SHORT direction blocked by adaptive learning (low SHORT WR)');
          continue;
        }
        if ((ov.blockedSessions ?? []).includes(sig.session)) {
          this._log(`SIGNAL_FILTERED_OUT reason=session_blocked strat=${sig.strategy_name} session=${sig.session}`, 'signal');
          this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
            sig.confidence, null, `session '${sig.session}' blocked by adaptive learning`);
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
      } catch (err) { this._log(`pattern-adjustment error: ${err.message}`, 'signal'); }

      // ── Strategy DNA score + gate adjustment ─────────────────────────────────
      // DNA fingerprints winning trade conditions (combo × timing × quality).
      // High-DNA signals get a confidence boost; gate is relaxed for strong matches.
      let dnaGateAdj = 0;
      try {
        const dna = loadDNA(this.db, instrument);
        if (dna) {
          const dnaResult  = getDNAScore(dna, sig);
          const dnaScore   = dnaResult.score;    // 0–100
          const dnaBoost   = Math.round(Math.max(0, Math.min(8, (dnaScore - 50) / 6.25)));
          dnaGateAdj       = getDNAGateAdjustment(dna, sig).adjustment;  // negative = relax gate

          if (dnaBoost > 0) {
            sig.confidence  = Math.min(100, sig.confidence + dnaBoost);
            sig.dnaScore    = dnaScore;
          }
          if (Math.abs(dnaGateAdj) >= 3) {
            this._log(
              `🧬 DNA [${sig.strategy_name} ${sig.direction}/${sig.session}]: ` +
              `score=${dnaScore} boost=+${dnaBoost} gate adj ${dnaGateAdj > 0 ? '+' : ''}${dnaGateAdj}`
            );
          }
        }
      } catch (err) { this._log(`dna-gate error: ${err.message}`, 'signal'); }

      // ── Opening candle / power-hour bias adjustment ────────────────────────────
      // Boosts or penalises confidence when the session open candle gives a
      // statistically validated directional bias (≥54% accuracy over ≥15 samples).
      let ocAdj = 0;
      try {
        if (currentSessionBias) {
          const ocResult = getOpeningCandleAdjustment(currentSessionBias, sig.direction);
          ocAdj = ocResult.adjustment;
          sig.openingCandleAdj = ocAdj; // passed into scoreSignal via _storeSignal
          if (Math.abs(ocAdj) >= 2) {
            this._log(
              `🕯️  Opening bias [${currentSessionBias.sessionKey}]: ${currentSessionBias.bias} str=${currentSessionBias.strength.toFixed(2)} → ${sig.direction} adj ${ocAdj > 0 ? '+' : ''}${ocAdj}`
            );
          }
          // Carry session key + bias for outcome accuracy update later
          sig._ocSessionKey = currentSessionBias.sessionKey;
          sig._ocBias       = currentSessionBias.bias;
        }
      } catch (err) { this._log(`opening-candle-adj error: ${err.message}`, 'signal'); }

      // Learned confidence gate — threshold evolves based on backtest win rates.
      // Pattern memory, DNA gate, and opening candle bias all tune the effective gate.
      const learnedMin = getLearnedThreshold(this.db, sig.strategy_name, sig.confidence * 0.9);
      const effectiveMin = Math.round(learnedMin + patternAdj + dnaGateAdj + ocAdj + minConfBonus);
      if (sig.confidence < effectiveMin) {
        const adjParts = [];
        if (patternAdj !== 0) adjParts.push(`pattern${patternAdj > 0 ? '+' : ''}${patternAdj}`);
        if (dnaGateAdj  !== 0) adjParts.push(`dna${dnaGateAdj > 0 ? '+' : ''}${dnaGateAdj}`);
        if (ocAdj       !== 0) adjParts.push(`oc${ocAdj > 0 ? '+' : ''}${ocAdj}`);
        if (minConfBonus < 0) adjParts.push(`pace${minConfBonus}`);
        const adjStr = adjParts.length ? ` [${adjParts.join(' ')}]` : '';
        this._log(`SIGNAL_FILTERED_OUT reason=confidence_below_threshold strat=${sig.strategy_name} conf=${sig.confidence} threshold=${effectiveMin} base=${learnedMin}${adjStr}`, 'signal');
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, effectiveMin,
          `confidence ${sig.confidence} < learned threshold ${effectiveMin}${adjStr}`);
        continue;
      }

      // ── Trade-idea deduplication (fuzzy, family-aware, persistent) ─────────────
      const { isDuplicate, suppressLog } = signalDedup.checkAndRegister(sig);
      if (isDuplicate) {
        this._log(`SIGNAL_FILTERED_OUT reason=fuzzy_dedup strat=${sig.strategy_name} ${suppressLog}`, 'signal');
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, null, suppressLog);
        continue;
      }

      // ── Institutional tier gate ───────────────────────────────────────────────
      const rank = rankSignal(sig);
      if (!rank.accepted) {
        this._log(`SIGNAL_FILTERED_OUT reason=tier_gate strat=${sig.strategy_name} conf=${sig.confidence} cause=${rank.rejectReason}`, 'signal');
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, null, rank.rejectReason);
        continue;
      }
      // ── Strategy status gate (RESEARCH_ONLY overrides live threshold) ─────────
      if (sig.strategy_name && !rank.liveGated) {
        const statusRow = this.db.prepare(
          'SELECT mode FROM strategy_status WHERE strategy_name = ?'
        ).get(sig.strategy_name);
        if (statusRow?.mode === 'RESEARCH_ONLY') {
          rank.liveGated = true;
        }
      }

      // ── Quant scorer — 8-dimension score (kept for DB storage + grading) ─────
      // RegimeAgent expects structured vocabulary: TREND_BULL/TREND_BEAR/EXPANSION/
      // NORMAL/COMPRESSION/SOFT_CHOP/RANGE_CHOP.
      // MGC_SCALP computes classifyRegime() in-strategy → sig.indicators.regime already
      // uses the correct vocabulary; use that as the primary source.
      // For strategies without their own regime (MNQ_INTRADAY), fall back to a mapped
      // version of getMarketRegime() which returns 'trending'/'choppy'/'mixed'/'unknown'.
      const REGIME_VOCAB_MAP = { trending: 'EXPANSION', mixed: 'NORMAL', choppy: 'SOFT_CHOP', unknown: 'NORMAL' };
      const quantCtx = {
        regime:    sig.indicators?.regime ?? dbRegime ?? REGIME_VOCAB_MAP[currentRegime] ?? 'NORMAL',
        volRegime: sig.indicators?.volRegime ?? 'NORMAL',
        atrRatio:  sig.indicators?.atr ? (sig.indicators.atr / (sig.indicators?.atrMin ?? sig.indicators.atr)) : 1,
        sess:      { quality: sig.indicators?.sessionQuality ?? 0.7, name: sig.session ?? '' },
        htfBiases: [
          { bias: sig.indicators?.htfBias   ?? 0, present: sig.indicators?.htfBias   != null },
          { bias: sig.indicators?.htf2Bias  ?? 0, present: sig.indicators?.htf2Bias  != null },
          { bias: sig.indicators?.htf1hBias ?? 0, present: sig.indicators?.htf1hBias != null },
        ],
        bars5m,
        rsi: sig.indicators?.rsi ?? null,
        hist: null, histPrev: null,
      };
      try {
        const quantResult  = computeQuantScore(sig, quantCtx);
        sig.quant_score    = quantResult.total;
        sig.quant_grade    = quantResult.grade;
        sig.quant_subscores = quantResult.subscores;
      } catch (err) { this._log(`quant-score error: ${err.message}`, 'signal'); }

      // ── Multi-agent gatekeeper — replaces ad-hoc quant isLive check ──────────
      if (!rank.liveGated) {
        try {
          const scanCtx = {
            ...quantCtx,
            atr:   sig.indicators?.atr,
            close: sig.indicators?.close,
            vwap:  sig.indicators?.vwap,
          };
          const gate = gatekeeper.evaluate(sig, scanCtx, this.db);
          sig._gateVerdict  = gate.verdict;
          sig._gateScore    = gate.score;
          sig._gateLog      = gate.gateLog;
          sig._agentScores  = gate.agentScores;

          if (gate.liveGated) {
            rank.liveGated = true;
            this._log(
              `SIGNAL_GATED verdict=${gate.verdict} strat=${sig.strategy_name} gateScore=${gate.score}` +
              (gate.failedGates.length ? ` failed=[${gate.failedGates.join(',')}]` : ''),
              'signal'
            );
          }
        } catch (err) { this._log(`gatekeeper error: ${err.message}`, 'signal'); }
      }

      sig.tier              = rank.tier;
      sig.adjusted_confidence = rank.adjustedConfidence;
      const approvalTag = rank.liveGated ? 'SIGNAL_RESEARCH_ONLY' : 'SIGNAL_APPROVED';
      this._log(`${approvalTag} strat=${sig.strategy_name} ${instrument} ${sig.direction} conf=${sig.confidence} tier=${rank.tier} adjConf=${rank.adjustedConfidence}${rank.liveGated ? ' (live-gated)' : ''}${sig.quant_grade ? ` quantGrade=${sig.quant_grade} quantScore=${sig.quant_score}` : ''}`, 'signal');

      this._lastSignalTimes[stratKey] = Date.now();
      this._storeSignal({ ...sig, ticker: `${instrument}1!`, _rank: rank });
      anyFired = true;
    }

    // Diagnostic snapshot — use already-fetched regime (no extra DB call)
    const diagRegime = dbRegime ?? currentRegime;
    const lastBar    = bars5m.length > 0 ? bars5m[bars5m.length - 1] : null;
    const diagInfo   = { close: lastBar?.close ?? null, atr: null, htfBias: null };

    this._log(`STRATEGY_SCAN_COMPLETE instrument=${instrument} fired=${anyFired} candidates=${stratsFiredNames.length} scan=#${this._scanCount}`, 'signal');
    if (this.cfg.logLevel === 'full') {
      this._log(
        `📊 ${instrument} | close=${diagInfo.close ?? '?'} | regime=${diagRegime} | ` +
        `strats=${stratsFiredNames.join(',') || 'none'} | fired=${anyFired ? 'YES' : 'no'}`
      );
    }

    this._storeScanDiag(instrument, diagInfo, stratsFiredNames, anyFired,
      anyFired ? null : 'confidence threshold not met');

    this.emit('scan', {
      instrument, regime: diagRegime, fired: anyFired,
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

  // ── Market hours check ────────────────────────────────────────────────────────
  // Delegated to clock/market-clock.js (America/Los_Angeles timezone).
  // Blackout: Fri 13:00 PT → Sun 14:00 PT + Mon–Thu 13:00–13:59 PT maintenance. OVERNIGHT also skipped.

  _isMarketOpen() {
    if (isBlackout()) return false;
    const { meta } = classifyNow();
    if (meta.minTier === 'IGNORE') return false;
    return true;
  }

  /** Returns the current session name for logging (e.g. 'NY_OPEN', 'MIDDAY'). */
  _sessionName() {
    return classifyNow().session;
  }

  /** Fires an ntfy push when the market transitions from closed → open. */
  _notifyMarketResuming() {
    const cfg = this.cfg;
    if (!cfg.ntfyTopic) {
      this._log('[ntfy] market-resume skipped — NTFY_TOPIC not set', 'signal');
      return;
    }
    try {
      const sess = classifyNow().session || 'LIVE';
      const headers = {
        'Content-Type': 'text/plain',
        'Title':    'Aurum Signals - Market Resuming',
        'Priority': 'default',
        'Tags':     'chart_with_upwards_trend',
      };
      if (cfg.ntfyToken) headers['Authorization'] = `Bearer ${cfg.ntfyToken}`;
      const body = `📈 Market reopening — scanner active\nSession: ${sess}\nStrategies: MNQ_INTRADAY, MGC_SCALP`;
      const ntfyUrl = `${cfg.ntfyUrl}/${cfg.ntfyTopic}`;
      this._log(`📈 Market resuming — sending ntfy → ${ntfyUrl} (session=${sess})`, 'signal');
      fetch(ntfyUrl, { method: 'POST', headers, body })
        .then(r => this._log(`[ntfy] market-resume sent — HTTP ${r.status}`, 'signal'))
        .catch(err => this._log(`[ntfy] market-resume FAILED: ${err.message}`, 'signal'));
    } catch (e) { this._log(`[ntfy] market-resume error: ${e.message}`, 'signal'); }
  }

  // ── Main scan cycle ───────────────────────────────────────────────────────────

  async scan() {
    // Prevent concurrent execution: BarWatcher and setInterval can both fire simultaneously.
    // Without this guard, two concurrent scans can race on _autoResolveOutcomes and
    // _trackHigherTPs, producing duplicate outcome/TP notifications even within a process.
    if (this._scanInProgress) {
      this._log('SCAN_SKIPPED reason=scan_in_progress', 'signal');
      return;
    }
    this._scanInProgress = true;
    try {
      return await this._scanBody();
    } finally {
      this._scanInProgress = false;
    }
  }

  async _scanBody() {
    this._scanCount++;

    const marketIsOpen = this._isMarketOpen();

    // Detect closed → open transition and notify (e.g. Globex reopen after weekend)
    if (this._prevMarketOpen === false && marketIsOpen) {
      this._notifyMarketResuming();
    }
    this._prevMarketOpen = marketIsOpen;

    // Periodic heartbeat visible in Render logs (every 10 scans ≈ every 2.5 min at 15s interval)
    if (this._scanCount % 10 === 0) {
      const _upMin = Math.floor(process.uptime() / 60);
      this._log(`SCAN_TICK #${this._scanCount} mode=${marketIsOpen ? 'LIVE' : 'RESEARCH'} feed=${this.feedType} uptime=${_upMin}min data=${this._lastDataStatus}`, 'signal');
    }

    // SCANNER_HEARTBEAT — every 12 scans (~60s at 5s interval, ~30s at 5s with event feed)
    if (this._scanCount % 12 === 0) {
      const _upMin = Math.floor(process.uptime() / 60);
      const _lastFetchAgo = this._lastFetchAt
        ? Math.round((Date.now() - this._lastFetchAt) / 1000)
        : null;
      const _dataStatus = this._lastDataStatus === 'DATA_OK' ? 'OK' : 'STALE';
      this._log(
        `SCANNER_HEARTBEAT scans=${this._scanCount} uptime=${_upMin}m` +
        (_lastFetchAgo != null ? ` lastFetch=${_lastFetchAgo}s ago` : '') +
        ` dataStatus=${_dataStatus}`,
        'signal'
      );
    }

    // Skip signal evaluation entirely when futures markets are closed.
    // Heartbeat is still emitted so the UI knows the scanner process is alive.
    if (!marketIsOpen) {
      if (this._scanCount % 10 === 0) {
        this._log('⏸️  Market closed — scanner paused until next session opens');
      }
      try { this._stmts.upsertHeartbeat.run(); } catch (err) { this._log(`heartbeat-db error: ${err.message}`, 'signal'); }
      // Determine market mode for closed-market heartbeat
      let marketMode = 'RESEARCH';
      try {
        const { session: _sess, meta, isBlackout: blk } = classifyNow();
        if (blk) {
          const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
          const dow = ptNow.getDay();
          const hm  = ptNow.getHours() * 60 + ptNow.getMinutes();
          marketMode = (dow === 5 && hm >= 780) || dow === 6 || (dow === 0 && hm < 840) ? 'WEEKEND_CLOSE' : 'MAINTENANCE';
        } else if (meta && meta.minTier === 'IGNORE') {
          marketMode = 'OVERNIGHT';
        }
      } catch (err) { this._log(`market-mode classify error: ${err.message}`, 'signal'); }
      this.emit('heartbeat', { scanCount: this._scanCount, at: ts(), marketClosed: true, marketMode, feedType: this.feedType, feedConnected: this._feed.isConnected() });

      // Research mode: run a background analysis cycle using historical bars.
      // Throttled to once per hour so it doesn't compete with startup backtests.
      const researchIntervalMs = 60 * 60_000;
      if (Date.now() - this._lastResearchAt > researchIntervalMs) {
        this._lastResearchAt = Date.now();
        this._runResearchCycle().catch(e => this._err('Research cycle error', e));
      }
      return;
    }

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

          // Update in-memory last-known-good cache
          if (mnq5mRaw.length) this._lastGoodBars.mnq5m = mnq5mRaw;
          if (mnq1hRaw.length) this._lastGoodBars.mnq1h = mnq1hRaw;
          if (mgc5mRaw.length) this._lastGoodBars.mgc5m = mgc5mRaw;
          if (mgc1hRaw.length) this._lastGoodBars.mgc1h = mgc1hRaw;

          // Persist 5m and 1h bars to DB so they survive a crash restart
          if (mnq5mRaw.length) this._saveHistoricalBars(this.cfg.symbol,    mnq5mRaw, '5m');
          if (mnq1hRaw.length) this._saveHistoricalBars(this.cfg.symbol,    mnq1hRaw, '1h');
          if (mgc5mRaw.length) this._saveHistoricalBars(this.cfg.symbolMgc, mgc5mRaw, '5m');
          if (mgc1hRaw.length) this._saveHistoricalBars(this.cfg.symbolMgc, mgc1hRaw, '1h');

          this._consecutiveErrors = 0;
          this._fetchBackoffUntil = 0;
          this._lastFetchAt = Date.now();

          // Track data freshness for health endpoint and SCAN_TICK log
          const _latestMnq = mnq5mRaw[mnq5mRaw.length - 1];
          const _ageMin = _latestMnq
            ? Math.round((Date.now() - new Date(_latestMnq.timestamp).getTime()) / 60000)
            : 999;
          if (_ageMin > 15) {
            this._lastDataStatus = 'DATA_STALE';
            if (this._scanCount % 5 === 0) {
              this._log(`DATA_STALE MNQ latest bar ${_ageMin}min old (${_latestMnq?.timestamp})`, 'signal');
            }
          } else {
            this._lastDataStatus = 'DATA_OK';
            if (this._scanCount % 20 === 0) {
              this._log(`DATA_OK MNQ 5m=${mnq5mRaw.length} bars age=${_ageMin}min | MGC 5m=${mgc5mRaw.length} bars`, 'signal');
            }
          }
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
              const headers = {
                'Content-Type': 'text/plain',
                'Title':    `[SYS] Rate-limit backoff ${backoffMin}min`,
                'Priority': 'urgent',
                'Tags':     'warning',
              };
              if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
              fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, {
                method: 'POST', headers,
                body: `${this._consecutiveErrors} consecutive 429s — check Yahoo Finance access`,
              }).catch(err => this._log(`SYSTEM_ALERT_SEND_FAILED: ${err.message}`, 'signal'));
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
        this._lastDataStatus = 'DATA_BACKOFF';
        if (this._scanCount % 5 === 0) {
          this._log(`⏸️  Rate-limit backoff — ${remaining} min remaining — signal eval on cached bars`, 'signal');
        }
        if (!this._lastGoodBars.mnq5m.length) return;
        // Block evaluation when cached bars are stale — check both MNQ and MGC
        for (const [key, label] of [['mnq5m', 'MNQ'], ['mgc5m', 'MGC']]) {
          const bars = this._lastGoodBars[key];
          if (!bars.length) continue;
          const _cachedLast = bars[bars.length - 1];
          if (_cachedLast) {
            const _cacheAgeMs = Date.now() - new Date(_cachedLast.timestamp).getTime();
            if (_cacheAgeMs > 15 * 60_000) {
              const _ageMin = Math.round(_cacheAgeMs / 60_000);
              this._log(`DATA_BACKOFF_STALE: ${label} cached bars are ${_ageMin}min old — skipping signal evaluation`, 'signal');
              return;
            }
          }
        }
        mnq5mRaw = this._lastGoodBars.mnq5m;
        mnq1hRaw = this._lastGoodBars.mnq1h;
        mgc5mRaw = this._lastGoodBars.mgc5m;
        mgc1hRaw = this._lastGoodBars.mgc1h;
      }

      // Slice to useful window (full bars kept for outcome resolution)
      const mnq5m = mnq5mRaw.slice(-500);
      const mnq1h = mnq1hRaw.slice(-500);
      const mgc5m = mgc5mRaw.slice(-500);
      const mgc1h = mgc1hRaw.slice(-500);

      // Confirmed-bar slices (exclude the last possibly still-forming bar).
      // Signal evaluation must use only closed bars to match backtest behavior
      // and prevent intrabar repainting — the most common live/backtest divergence cause.
      const mnq5mConf = mnq5m.length > 1 ? mnq5m.slice(0, -1) : mnq5m;
      const mnq1hConf = mnq1h.length > 1 ? mnq1h.slice(0, -1) : mnq1h;
      const mgc5mConf = mgc5m.length > 1 ? mgc5m.slice(0, -1) : mgc5m;
      const mgc1hConf = mgc1h.length > 1 ? mgc1h.slice(0, -1) : mgc1h;

      // Build multi-TF sets via BarAggregator (feeds from confirmed 5m bars)
      const _mnqAgg = new BarAggregator('MNQ');
      _mnqAgg.loadHistory(mnq5mConf);
      const _mnqSnap = _mnqAgg.snapshot();

      const _mgcAgg = new BarAggregator('MGC');
      _mgcAgg.loadHistory(mgc5mConf);
      const _mgcSnap = _mgcAgg.snapshot();

      const mnq15m = _mnqSnap.bars15m.length >= 4 ? _mnqSnap.bars15m : aggregate5mTo15m(mnq5mConf);
      const mgc15m = _mgcSnap.bars15m.length >= 4 ? _mgcSnap.bars15m : aggregate5mTo15m(mgc5mConf);
      const mgc30m = _mgcSnap.bars30m.length >= 3 ? _mgcSnap.bars30m : aggregate5mTo30m(mgc5mConf);
      const mgc45m = _mgcSnap.bars45m.length >= 3 ? _mgcSnap.bars45m : aggregate5mTo45m(mgc5mConf);

      // 1h-derived TFs still come from the 1h feed (not 5m aggregation)
      const mnq4h  = aggregate1hTo4h(mnq1hConf);
      const mnqDly = aggregate1hToDaily(mnq1hConf);

      if (mnq5m.length >= 2) this._savePrice(this.cfg.symbol,    mnq5m);
      if (mgc5m.length >= 2) this._savePrice(this.cfg.symbolMgc, mgc5m);

      const mnqReady = mnq5mConf.length >= 60 && mnq15m.length >= 20 && mnq1hConf.length >= 30;
      const mgcReady = mgc5mConf.length >= 60 && mgc15m.length >= 20;

      // Record opening candles regardless of bar-count readiness.
      // On Sundays right after Globex open (only ~32 bars vs 60 needed for signals)
      // we still want the GLOBEX_OPEN candle captured immediately.
      // recordOpeningCandle is idempotent — safe to call again from _scanInstrument.
      try {
        const _ocTodayKey = getEtDateKey(new Date().toISOString());
        for (const [_ocInst, _ocBars] of [['MNQ', mnq5m], ['MGC', mgc5m]]) {
          for (const bar of _ocBars) {
            if (getEtDateKey(bar.timestamp) === _ocTodayKey) {
              recordOpeningCandle(this.db, _ocInst, bar);
            }
          }
        }
      } catch (err) { this._log(`opening-candle error: ${err.message}`, 'signal'); }

      if (!mnqReady && !mgcReady) {
        this._log(`⏳ Insufficient bars: MNQ 5m=${mnq5mConf.length}/15m=${mnq15m.length}/1h=${mnq1hConf.length} MGC 5m=${mgc5mConf.length}`);
        return;
      }

      // Stale candle detection — skip signal evaluation if most recent bar is >15 min old during market hours.
      // Stale data in live mode produces signals on old prices, wasting alert budget.
      {
        const _latestMnq5m = mnq5mConf[mnq5mConf.length - 1];
        const _latestMgc5m = mgc5mConf[mgc5mConf.length - 1];
        const _staleMnq = _latestMnq5m
          ? (Date.now() - new Date(_latestMnq5m.timestamp).getTime()) > 15 * 60_000
          : false;
        const _staleMgc = _latestMgc5m
          ? (Date.now() - new Date(_latestMgc5m.timestamp).getTime()) > 15 * 60_000
          : false;
        if (_staleMnq || _staleMgc) {
          const _staleInfo = [
            _staleMnq ? `MNQ latest=${_latestMnq5m?.timestamp}` : null,
            _staleMgc ? `MGC latest=${_latestMgc5m?.timestamp}` : null,
          ].filter(Boolean).join(', ');
          this._log(`DATA_STALE_WARNING stale candles detected — skipping signal evaluation (${_staleInfo})`, 'signal');
          return;
        }
      }

      // Signal evaluation uses confirmed bars; outcome resolution uses full bars (including forming)
      await Promise.all([
        mnqReady ? this._scanInstrument('MNQ', mnq5mConf, mnq15m, mnq1hConf, mnq4h, mnqDly) : null,
        mgcReady ? this._scanInstrument('MGC', mgc5mConf, mgc15m, mgc1hConf, [], [], mgc30m, mgc45m, []) : null,
      ].filter(Boolean));

      // Refresh 1m bars for resolution once per minute (more granular TP1/SL detection
      // without hammering the rate limit — 5m forming bar low may lag by up to 5 min).
      const nowMs = Date.now();
      if (nowMs - this._resolution1mFetchedAt > 60_000) {
        try {
          const [mnq1m, mgc1m] = await Promise.all([
            this._fetchYahooBars(this.cfg.symbol,    '1m', '1d'),
            this._fetchYahooBars(this.cfg.symbolMgc, '1m', '1d'),
          ]);
          if (mnq1m.length) this._resolution1m.mnq = mnq1m.slice(-120); // last 2 hours
          if (mgc1m.length) this._resolution1m.mgc = mgc1m.slice(-120);
          this._resolution1mFetchedAt = nowMs;
        } catch (err) { this._log(`1m-resolution-fetch error (falling back to 5m): ${err.message}`, 'signal'); }
      }

      // Merge 1m and 5m bars for resolution: 1m bars are more granular (detect intrabar
      // TP1/SL touches within ~60s), 5m bars catch anything the 1m set missed.
      const mnqResBars = _mergeResolutionBars(this._resolution1m.mnq, mnq5m);
      const mgcResBars = _mergeResolutionBars(this._resolution1m.mgc, mgc5m);

      if (mnqReady) this._autoResolveOutcomes(mnqResBars, 'MNQ');
      if (mgcReady) this._autoResolveOutcomes(mgcResBars, 'MGC');
      if (mnqReady) this._trackHigherTPs(mnqResBars, 'MNQ');
      if (mgcReady) this._trackHigherTPs(mgcResBars, 'MGC');

    } catch (err) {
      this._err('Scan cycle error', err);
    } finally {
      try { this._stmts.upsertHeartbeat.run(); } catch (_err) { /* heartbeat DB failure — non-critical */ }
      this.emit('heartbeat', { scanCount: this._scanCount, at: ts(), marketMode: 'LIVE', feedType: this.feedType, feedConnected: this._feed.isConnected() });
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

  /**
   * Runs a backtest variant in a Worker Thread so the main event loop stays free.
   * mode: 'backtest' (default, 1m bars + swing), 'backtest5m' (5m bars), 'research' (1m), 'research5m' (5m)
   */
  _runBacktestInWorker(bars, params, opts, swing1hBars = [], swingSlippage = 0.5, mode = 'backtest') {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'workers/backtest-worker.js'), {
        workerData: { mode, bars, params, opts, swing1hBars, swingSlippage },
      });
      worker.on('message', msg => {
        if (msg.success) resolve(msg.result);
        else reject(new Error(msg.error));
      });
      worker.on('error', reject);
      worker.on('exit', code => {
        if (code !== 0) reject(new Error(`Backtest worker exited with code ${code}`));
      });
    });
  }

  async runBacktestCycle(instrument, triggeredBy = 'scheduled') {
    const symbol = this.cfg.btSymbols[instrument];
    if (!symbol) return;

    // Skip resource-intensive backtest when futures market is closed.
    // Manual/midweek_trigger calls pass a non-'scheduled' triggeredBy so they
    // can bypass this guard (e.g. server startup warm-up runs).
    if (triggeredBy === 'scheduled' && !this._isMarketOpen()) {
      this._log(`BACKTEST SKIP (${instrument}): market closed`);
      return;
    }

    try {
      // Hint V8 to collect garbage before the memory-intensive backtest loop.
      // --expose-gc flag makes global.gc() available; gracefully skipped if absent.
      if (typeof global.gc === 'function') global.gc();

      const mem   = process.memoryUsage();
      const heapMB = Math.round(mem.heapUsed / 1_048_576);
      const heapTotalMB = Math.round(mem.heapTotal / 1_048_576);

      // Guard: skip if heap is already too full — the O(n²) backtest loop would OOM.
      // 330 MB leaves ~70 MB headroom under the 400 MB --max-old-space-size limit.
      if (heapMB > 330) {
        this._log(`BACKTEST SKIP (${instrument}): heap ${heapMB}/${heapTotalMB}MB too high — will retry next cycle`);
        return;
      }

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

      // Seed the 5m chart cache from the 1m bars so the homepage charts always
      // have data after the first backtest cycle, even before a scan cycle runs.
      const bt5m = aggregate1mTo5m(bars1m);
      if (bt5m.length > 0) {
        if (instrument === 'MNQ') this._lastGoodBars.mnq5m = bt5m;
        else if (instrument === 'MGC') this._lastGoodBars.mgc5m = bt5m;
      }

      // ── Archive 1m bars for growing historical dataset ───────────────────────
      // Each cycle saves the fetched bars (INSERT OR IGNORE keeps deduplication
      // safe). Over days/weeks this builds up a 30-day+ 1m bar archive that
      // feeds progressively richer backtests.
      this._saveHistoricalBars(symbol, bars1m, '1m');

      // Load full accumulated 1m history and merge with the current fetch so the
      // backtest window grows over time rather than being capped at 7 days.
      const storedBars = this._loadHistoricalBars(symbol, '1m');
      const allBars1m  = this._mergeBarsByTimestamp(storedBars, bars1m);
      this._log(`BACKTEST HISTORY: ${instrument} using ${allBars1m.length} 1m bars (stored: ${storedBars.length} + fresh: ${bars1m.length})`);

      const params = getParams(this.db, instrument);

      // Run the CPU-intensive backtest in a Worker Thread so the main event loop
      // stays free for HTTP health checks and SSE clients during computation.
      const swing1hBars = (instrument === 'MNQ') ? (this._lastGoodBars.mnq1h ?? []) : [];
      const result = await this._runBacktestInWorker(
        allBars1m,
        params,
        { instrument, targetTrades: this.cfg.btTargetTrades, slippage: this.cfg.btSlippage, walkForward: true },
        swing1hBars,
        this.cfg.btSlippage,
        'backtest',
      );

      const { metrics } = result;
      metrics.barsScanned = bars1m.length;

      // ── No-signal run guard ───────────────────────────────────────────────────
      // Do not save runs that produced zero trades — they pollute the chart and
      // inflate total_runs counts without contributing meaningful performance data.
      if ((metrics.tradeCount ?? 0) === 0) {
        this._log(`BACKTEST SKIP SAVE (${instrument}): zero trades found — not storing empty run`);
        return;
      }

      // ── Duplicate run guard ───────────────────────────────────────────────────
      // Use a data-window fingerprint (first+last bar timestamp + trade count) so
      // we never store two runs built from the exact same Yahoo Finance response.
      // This is immune to Infinity profit_factor (stored as NULL by SQLite) and
      // any floating-point precision edge cases.
      const _dwFirst = allBars1m[0]?.timestamp ?? '';
      const _dwLast  = allBars1m[allBars1m.length - 1]?.timestamp ?? '';
      const _dataWindowKey = `${_dwFirst}|${_dwLast}|${metrics.tradeCount ?? 0}`;

      const _lastRunRow = this.db.prepare(
        `SELECT params_json FROM backtest_runs WHERE instrument=? ORDER BY run_at DESC LIMIT 1`
      ).get(instrument);
      if (_lastRunRow) {
        let _lastKey = '';
        try { _lastKey = JSON.parse(_lastRunRow.params_json ?? '{}')._dataWindowKey ?? ''; } catch (_err) {}
        if (_lastKey && _lastKey === _dataWindowKey) {
          this._log(`BACKTEST SKIP SAVE (${instrument}): same data window as last run — skipped`);
          return;
        }
      }

      // Embed fingerprint so the NEXT run can compare against it
      params._dataWindowKey = _dataWindowKey;

      const _dwDays = _dwFirst && _dwLast
        ? Math.max(1, Math.round((new Date(_dwLast) - new Date(_dwFirst)) / 86400000))
        : 0;
      const _dataWindow = {
        sourceStart: _dwFirst,
        sourceEnd:   _dwLast,
        label: `${_dwDays}d · ${allBars1m.length.toLocaleString()} 1m bars`,
        mode: 'LIVE',
      };

      const runId = saveBacktestRun(this.db, instrument, params, metrics, triggeredBy, _dataWindow);

      // Store up to 200 trades per run (WIN + LOSS + BE)
      const allTrades = (result.signalLog ?? []).slice(0, 200);
      if (allTrades.length > 0) {
        const insTrade = this.db.prepare(`
          INSERT INTO backtest_trades
            (run_id, instrument, bar_idx, timestamp, direction, setup, strategy_name,
             trade_style, regime, entry, sl, tp1, outcome, score, confidence, pnl_pts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const updNote = this.db.prepare(
          `UPDATE backtest_trades SET note = ?, noted_at = datetime('now') WHERE id = ?`
        );

        this.db.transaction(() => {
          for (const t of allTrades) {
            // Compute realized pnl_pts from outcome for profit-factor calculation
            let pnl_pts = null;
            if (t.outcome === 'WIN' && t.entry != null && t.tp1 != null) {
              pnl_pts = t.direction === 'LONG' ? +(t.tp1 - t.entry).toFixed(2) : +(t.entry - t.tp1).toFixed(2);
            } else if (t.outcome === 'LOSS' && t.entry != null && t.sl != null) {
              pnl_pts = t.direction === 'LONG' ? +(t.sl - t.entry).toFixed(2) : +(t.entry - t.sl).toFixed(2);
            } else if (t.outcome === 'BE') {
              pnl_pts = 0;
            }

            const info = insTrade.run(runId, instrument, t.bar ?? null, t.timestamp ?? null,
              t.direction, t.setup ?? null, t.strategy_name ?? null,
              t.trade_style ?? null, t.regime ?? null,
              t.entry ?? null, t.sl ?? null, t.tp1 ?? null,
              t.outcome, t.score ?? null, t.confidence ?? null, pnl_pts);

            // Auto-generate deep learning notes for ALL trades (WIN/LOSS/BE)
            try {
              const note = this._autoNote(t);
              if (note) updNote.run(note, info.lastInsertRowid);
            } catch (err) { this._log(`auto-note error: ${err.message}`, 'signal'); }
          }
        })();
      }

      saveBacktestDetails(this.db, runId, {
        byRegime:               metrics.byRegime,
        byStyle:                metrics.byStrategy ?? metrics.byStyle ?? {},
        bySetup:                metrics.bySetup,
        walkForwardConsistency: result.walkForward?.consistency ?? null,
        walkForwardAvgWR:       result.walkForward?.avgWinRate  ?? null,
        maxWinStreak:           metrics.maxWinStreak,
        maxLossStreak:          metrics.maxLossStreak,
        slippageUsed:           result.slippageUsed,
        cooldownUsed:           result.cooldownUsed,
        multiObjScore:          multiObjectiveScore(metrics),
      });

      // Per-strategy signal count from this run — surface for frequency monitoring
      const _stratCounts = {};
      for (const t of (result.signalLog ?? [])) {
        _stratCounts[t.strategy_name] = (_stratCounts[t.strategy_name] ?? 0) + 1;
      }
      const _stratSummary = Object.entries(_stratCounts)
        .map(([s, c]) => `${s.replace('MNQ_', '').replace('MGC_', '')}=${c}`)
        .join(' ');

      this._log(
        `BACKTEST DONE: ${instrument} | trades=${metrics.tradeCount} | ` +
        `win=${(metrics.winRate * 100).toFixed(1)}% | sharpe=${metrics.sharpe} | ` +
        `pf=${metrics.profitFactor} | run#${runId}` +
        (_stratSummary ? ` | by-strategy: ${_stratSummary}` : '')
      );

      // ── Learning feedback: update thresholds from last 3 backtest runs ─────────
      try {
        const btWinRates  = getBacktestWinRates(this.db, instrument, 3);
        const learnResult = updateLearnedThresholds(this.db, btWinRates, instrument);
        for (const [strat, { from, to, wr, trades, delta }] of Object.entries(learnResult.changes)) {
          const dir = delta > 0 ? '↑' : '↓';
          this._log(`📚 LEARNED [${strat}]: threshold ${from} ${dir} ${to} (WR=${wr}%, ${trades} trades)`);
        }

        // Per-strategy trade count report — identifies strategies silently skipped in backtests
        const freshness = getStrategyFreshness(this.db, instrument, 5);
        const ALL_STRATS = instrument === 'MNQ'
          ? ['MNQ_INTRADAY']
          : ['MGC_SCALP'];
        const freshnessReport = ALL_STRATS.map(s => {
          const f = freshness[s];
          return f ? `${s}=${f.tradeCount}` : `${s}=0(stale)`;
        }).join(' | ');
        this._log(`📊 BT COVERAGE [${instrument}]: ${freshnessReport}`);
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

      // ── DNA: update pattern fingerprints from backtest trades ─────────────────
      try {
        if (allTrades.length > 0) {
          updateDNAFromBacktest(this.db, instrument, allTrades);
          this._log(`🧬 DNA updated from ${allTrades.length} backtest trades (${instrument})`);
        }
      } catch (e) {
        this._log(`DNA UPDATE ERR: ${e.message}`);
      }

      // ── Opening candle: update session bias accuracy from backtest trades ─────
      try {
        if (allTrades.length > 0) {
          updateSessionBiasFromBacktest(this.db, instrument, allTrades);
          this._log(`🕯️  Opening candle bias stats updated from backtest (${instrument})`);
        }
      } catch (e) {
        this._log(`OPENING CANDLE UPDATE ERR: ${e.message}`);
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

      // Check edge degradation after every backtest cycle
      try { this._checkEdgeDegradation(); } catch (err) { this._log(`edge-degradation check error: ${err.message}`, 'signal'); }

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
      if (typeof global.gc === 'function') { try { global.gc(); } catch (_err) {} }
    }
  }

  // ── Deep historical backtest (60-day 5m bars) ─────────────────────────────────

  /**
   * Fetch 60 days of 5m bars from Yahoo Finance and run a full backtest.
   *
   * This gives ~8× more bar history than the regular 7-day 1m backtest and
   * produces statistically stronger win-rate estimates. Results are saved to
   * backtest_runs with triggered_by='historical_5m' so the dashboard can
   * distinguish them. Runs automatically at startup and weekly thereafter.
   */
  async runDeepHistoricalBacktest(instrument) {
    const symbol = this.cfg.btSymbols[instrument];
    if (!symbol) return;

    // Safety guard: 60d of 5m bars + walkForward backtest needs ~500MB headroom.
    // On constrained deployments (Render, --max-old-space-size=400) skip entirely.
    const heapLimitMB = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1_048_576);
    if (heapLimitMB < 500) {
      this._log(`DEEP HIST BT SKIP (${instrument}): heap limit ${heapLimitMB}MB < 500MB — use SCANNER_MODE=worker`);
      return;
    }

    try {
      this._log(`DEEP HIST BT START: ${instrument} — fetching 60d of 5m bars`);

      const bars5m = await this._fetchYahooBars(symbol, '5m', '60d');
      if (bars5m.length < 200) {
        this._log(`DEEP HIST BT SKIP (${instrument}): insufficient 5m bars (${bars5m.length})`);
        return;
      }

      this._log(`DEEP HIST BT: ${instrument} — ${bars5m.length} 5m bars fetched`);

      // Persist 5m bars so subsequent runs can load them without re-fetching
      this._saveHistoricalBars(symbol, bars5m, '5m');

      // Also update chart cache with these fresh 5m bars
      if (instrument === 'MNQ') this._lastGoodBars.mnq5m = bars5m;
      else if (instrument === 'MGC') this._lastGoodBars.mgc5m = bars5m;

      const params = getParams(this.db, instrument);
      const result = runBacktest5m(bars5m, params, {
        instrument,
        slippage:    this.cfg.btSlippage,
        walkForward: true,
        nWindows:    5,
        minBars:     200,
      });

      const { metrics } = result;
      metrics.barsScanned = bars5m.length;

      if ((metrics.tradeCount ?? 0) === 0) {
        this._log(`DEEP HIST BT SKIP SAVE (${instrument}): zero trades found`);
        return;
      }

      this._log(
        `DEEP HIST BT END: ${instrument} | trades=${metrics.tradeCount} ` +
        `WR=${(metrics.winRate * 100).toFixed(1)}% PF=${metrics.profitFactor?.toFixed(2) ?? 'N/A'}`
      );

      // Tag params so dashboard can identify historical runs
      const _dw5mFirst = bars5m[0]?.timestamp ?? '';
      const _dw5mLast  = bars5m[bars5m.length - 1]?.timestamp ?? '';
      const _dw5mDays  = _dw5mFirst && _dw5mLast
        ? Math.max(1, Math.round((new Date(_dw5mLast) - new Date(_dw5mFirst)) / 86400000))
        : 60;
      params._dataWindowKey  = `5m|${_dw5mFirst}|${_dw5mLast}|${metrics.tradeCount}`;
      params._baseInterval   = '5m';
      params._histDays       = _dw5mDays;

      const _deepDataWindow = {
        sourceStart: _dw5mFirst,
        sourceEnd:   _dw5mLast,
        label: `${_dw5mDays}d · ${bars5m.length.toLocaleString()} 5m bars (deep)`,
        mode: 'LIVE',
      };

      const runId = saveBacktestRun(this.db, instrument, params, metrics, 'historical_5m', _deepDataWindow);

      // Store up to 500 trades from the deep backtest (larger window = more trades)
      const allTrades = (result.signalLog ?? []).slice(0, 500);
      if (allTrades.length > 0) {
        const insTrade = this.db.prepare(`
          INSERT INTO backtest_trades
            (run_id, instrument, bar_idx, timestamp, direction, setup, strategy_name,
             trade_style, regime, entry, sl, tp1, outcome, score, confidence, pnl_pts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.db.transaction(() => {
          for (const t of allTrades) {
            let pnl_pts = null;
            if (t.outcome === 'WIN' && t.entry != null && t.tp1 != null) {
              pnl_pts = t.direction === 'LONG' ? +(t.tp1 - t.entry).toFixed(2) : +(t.entry - t.tp1).toFixed(2);
            } else if (t.outcome === 'LOSS' && t.entry != null && t.sl != null) {
              pnl_pts = t.direction === 'LONG' ? +(t.sl - t.entry).toFixed(2) : +(t.entry - t.sl).toFixed(2);
            } else if (t.outcome === 'BE') {
              pnl_pts = 0;
            }
            insTrade.run(runId, instrument, t.bar ?? null, t.timestamp ?? null,
              t.direction, t.setup ?? null, t.strategy_name ?? null,
              t.trade_style ?? null, t.regime ?? null,
              t.entry ?? null, t.sl ?? null, t.tp1 ?? null,
              t.outcome, t.score ?? null, t.confidence ?? null, pnl_pts);
          }
        })();
      }

      saveBacktestDetails(this.db, runId, {
        byRegime:    metrics.byRegime,
        byStyle:     metrics.byStyle ?? metrics.byStrategy,
        bySetup:     metrics.bySetup,
        walkForwardConsistency: result.walkForward?.consistency,
        maxWinStreak:  metrics.maxWinStreak,
        maxLossStreak: metrics.maxLossStreak,
        slippageUsed:  result.slippageUsed,
        cooldownUsed:  result.cooldownUsed,
        multiObjScore: null,
      });

      this.emit('backtest', { instrument, runId, metrics, deep: true });
    } catch (err) {
      this._err(`DEEP HIST BT ERROR (${instrument})`, err);
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
        `OPTIMIZER DONE: ${instrument} | ` +
        `live=${(report.liveWinRate * 100).toFixed(1)}% | ` +
        `baseline=${report.baselineWinRate != null ? (report.baselineWinRate * 100).toFixed(1) + '%' : 'n/a'} | ` +
        `global_promoted=${report.globalPromoted} | ` +
        `style_promoted=${report.stylePromotions ?? 0} | ` +
        `candidates=${report.candidatesTested ?? 'n/a'}`
      );

      // ── Evolution cycle: A/B test variants against the champion ──────────────
      try {
        const evoReport = runEvolutionCycle(this.db, instrument, bars1m, {
          cooldown: 2,
          slippage: this.cfg.btSlippage ?? 0.5,
        });
        this._log(evoReport.report);
        if (evoReport.promoted) {
          this._log(
            `🧬 EVOLUTION PROMOTED: ${instrument} gen${evoReport.generation} ` +
            `src=${evoReport.promotedVariant?.source} score=${evoReport.promotedVariant?.score?.toFixed(3)}`
          );
        }
      } catch (e) {
        this._log(`EVOLUTION ERR: ${e.message}`);
      }

      // ── DNA: update from resolved live signals after optimizer run ────────────
      try {
        updateDNAFromLive(this.db, instrument);
        this._log(`🧬 DNA updated from live outcomes (${instrument})`);
      } catch (e) {
        this._log(`DNA LIVE UPDATE ERR: ${e.message}`);
      }

    } catch (err) {
      this._err(`Optimizer error (${instrument})`, err);
    }
  }

  // ── Weekly Deep Dive Report ───────────────────────────────────────────────────
  // Auto-generated Friday after 14:00 PT (17:00 ET) / after NY market close.
  // Also catches up Saturday/Sunday if Friday was missed.
  // Timezone: America/Los_Angeles per product requirement.

  _maybeGenerateWeeklyDeepReport() {
    try {
      const now = new Date();
      const ptParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(now);
      const weekday = ptParts.find(p => p.type === 'weekday').value;
      const hour    = parseInt(ptParts.find(p => p.type === 'hour').value, 10);

      // Generate on Friday after 14:00 PT (=17:00 ET, after market close) or Sat/Sun as catch-up
      const isWindow =
        (weekday === 'Fri' && hour >= 14) ||
        weekday === 'Sat' ||
        (weekday === 'Sun' && hour < 20);
      if (!isWindow) return;

      // Determine Monday of current week
      const d = new Date(now);
      const day = d.getDay(); // 0=Sun
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      const weekStart = d.toISOString().slice(0, 10);

      // Skip if already generated this week
      const key = `REPORT_WEEKLY_${weekStart}`;
      const existing = this.db.prepare(
        'SELECT instrument FROM strategy_params WHERE instrument = ?'
      ).get(key);
      if (existing) return;

      this._log(`📋 Generating Weekly Deep Dive report for week of ${weekStart}…`);

      const report = generateWeeklyDeepReport(this.db, weekStart);

      this._log(
        `📋 Weekly Deep Dive complete — ` +
        `WR=${report.metrics?.win_rate_pct ?? 'N/A'}% | ` +
        `PF=${report.metrics?.profit_factor ?? 'N/A'} | ` +
        `Trades=${report.metrics?.total_trades ?? 0} | ` +
        `BT runs=${report.backtest?.total_runs ?? 0}`
      );

      // ── Layer 2: AI forensics analysis ─────────────────────────────────────────
      // Fire-and-forget — doesn't block report delivery or ntfy notification.
      // Persists to strategy_params as AI_FORENSICS_<weekStart>.
      runForensicsAnalysis(this.db, report.metrics ?? {}, weekStart)
        .then(analysis => {
          if (!analysis) return;
          this._log(
            `🤖 AI Forensics Analysis complete — ` +
            `${analysis.strategies_analyzed?.length ?? '?'} strategies | ` +
            `${analysis.output_tokens ?? '?'} tokens out`,
            'signal'
          );
          // Surface top AI recommendations to ntfy
          if (this.cfg.ntfyTopic) {
            const preview = (analysis.adjustments ?? '').split('\n')
              .filter(l => l.trim() && !l.startsWith('#'))
              .slice(0, 5)
              .join('\n');
            const headers = {
              'Content-Type': 'text/plain',
              'Title': `AI Forensics Analysis - Week of ${weekStart}`,
              'Priority': 'default',
              'Tags': 'robot,bar_chart',
            };
            if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
            fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, {
              method: 'POST',
              headers,
              body: `🤖 AI Strategy Adjustments — Week of ${weekStart}\n\n${preview}\n\nFull analysis: /reports`,
            }).catch(() => {});
          }
        })
        .catch(err => this._log(`AI_FORENSICS_ERR: ${err.message}`, 'signal'));

      // Surface to ntfy
      if (this.cfg.ntfyTopic) {
        const wr  = report.metrics?.win_rate_pct;
        const n   = report.metrics?.total_trades ?? 0;
        const pf  = report.metrics?.profit_factor;
        const btRuns = report.backtest?.valid_runs ?? 0;
        const lvl = wr != null && wr < 45 ? 'high' : 'default';
        const btDecl = (report.backtest?.strategies ?? []).filter(s => s.wr_trend === 'declining').length;
        const headers = {
          'Content-Type': 'text/plain',
          'Title': `Weekly Deep Dive - WR=${wr ?? '?'}% (${n} trades)`,
          'Priority': lvl,
          'Tags': lvl === 'high' ? 'warning,bar_chart' : 'bar_chart',
        };
        if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
        const body = [
          `📋 Weekly Deep Dive Report — Week of ${weekStart}`,
          `Live: WR=${wr ?? '?'}% | PF=${pf ?? '?'} | Trades=${n}`,
          `Backtest: ${btRuns} valid runs | ${btDecl > 0 ? btDecl + ' strategies declining' : 'all stable'}`,
          `Full report: /reports`,
        ].join('\n');
        fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, {
          method: 'POST', headers, body,
        }).catch(() => {});
      }
    } catch (err) {
      this._err('Weekly Deep Dive report error', err);
    }
  }

  // ── Mid-week intelligence report ─────────────────────────────────────────────
  // Auto-generated Wednesday after 3:00 PM ET. Persisted to strategy_params.
  // Also checks for edge degradation on both instruments after every backtest cycle.

  _maybeGenerateMidWeekReport() {
    try {
      const now = new Date();
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(now);
      const weekday = etParts.find(p => p.type === 'weekday').value;
      const hour    = parseInt(etParts.find(p => p.type === 'hour').value, 10);

      // Generate on Wednesday after 15:00 ET or Thursday/Friday as catch-up
      const isWindow = (weekday === 'Wed' && hour >= 15) || weekday === 'Thu' || (weekday === 'Fri' && hour < 10);
      if (!isWindow) return;

      // Compute Monday of current week
      const d = new Date(now);
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      const weekStart = d.toISOString().slice(0, 10);

      // Skip if already generated this week
      const key = `REPORT_MIDWEEK_${weekStart}`;
      const existing = this.db.prepare(
        'SELECT instrument FROM strategy_params WHERE instrument = ?'
      ).get(key);
      if (existing) return;

      this._log(`📊 Generating mid-week intelligence report for week of ${weekStart}…`);
      const report = generateMidWeekReport(this.db);
      this._log(`📊 Mid-week report generated — WR=${report.metrics.win_rate_pct ?? 'N/A'}% on ${report.metrics.total_trades} trades`);

      // ── Apply report recommendations directly to strategy learning ──────────
      // The report is not just for humans — it drives automatic threshold changes.
      try {
        this._applyMidWeekReportLearning(report);
      } catch (e) {
        this._log(`MID-WEEK LEARNING ERR: ${e.message}`);
      }

      // Surface report summary to ntfy (ASCII headers only)
      if (this.cfg.ntfyTopic) {
        const wr  = report.metrics.win_rate_pct;
        const n   = report.metrics.total_trades;
        const pf  = report.metrics.profit_factor;
        const lvl = wr != null && wr < 45 ? 'high' : 'default';
        const headers = {
          'Content-Type': 'text/plain',
          'Title':    `Mid-Week Report - WR=${wr ?? '?'}% (${n} trades)`,
          'Priority': lvl, 'Tags': lvl === 'high' ? 'warning' : 'bar_chart',
        };
        if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
        const recaps = (report.recommendations ?? []).slice(0, 3).join('\n');
        const body = `📊 Mid-Week Intelligence Report\nWR=${wr ?? '?'}% | PF=${pf ?? '?'} | Trades=${n}\n${recaps ? '\nRecommendations:\n' + recaps : ''}\nFull report: /reports`;
        fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, { method: 'POST', headers, body }).catch(() => {});
      }
    } catch (err) {
      this._err('Mid-week report error', err);
    }
  }

  // ── Apply mid-week report insights to strategy learning ──────────────────────
  // This is what makes the report actionable rather than passive.
  // Parses the generated report and directly adjusts thresholds, blocking,
  // and pattern memory based on what it learned this week.
  _applyMidWeekReportLearning(report) {
    if (!report || !report.metrics) return;

    const wr    = (report.metrics.win_rate_pct ?? 0) / 100;
    const n     = report.metrics.total_trades ?? 0;

    // Not enough data to learn from
    if (n < 5) {
      this._log('📊 Mid-week learning: fewer than 5 trades — skipping threshold adjustment');
      return;
    }

    // Build a win-rate map per strategy from report breakdowns
    const btWinRates = {};
    for (const row of (report.breakdowns?.byStrategy ?? [])) {
      if (!row.strategy_name || row.total < 2) continue;
      btWinRates[row.strategy_name] = {
        winRate:    row.wins / row.total,
        tradeCount: row.total,
      };
    }

    // Apply learned thresholds across both instruments if we have enough data
    if (Object.keys(btWinRates).length > 0) {
      for (const instrument of ['MNQ', 'MGC']) {
        try {
          const result = updateLearnedThresholds(this.db, btWinRates, instrument);
          for (const [strat, ch] of Object.entries(result.changes ?? {})) {
            this._log(`📊 MID-WEEK LEARN [${strat}/${instrument}]: threshold ${ch.from} → ${ch.to} (WR=${ch.wr}%)`);
          }
          if (result.explanation) this._log(`📊 Mid-week learning: ${result.explanation}`);
        } catch (err) { this._log(`mid-week-learn error: ${err.message}`, 'signal'); }
      }
    }

    // If overall WR is very low, force a backtest cycle to recheck parameters
    if (wr < 0.45 && n >= 10) {
      this._log(`📊 Mid-week learning: WR=${(wr*100).toFixed(1)}% critical — triggering immediate backtest cycles`);
      setTimeout(() => this.runBacktestCycle('MNQ', 'midweek_trigger'), 5_000);
      setTimeout(() => this.runBacktestCycle('MGC', 'midweek_trigger'), 15_000);
    }

    // If a specific session is consistently bad, update pattern memory to reflect that
    for (const row of (report.breakdowns?.bySession ?? [])) {
      if (!row.session || row.total < 3) continue;
      const sessWR = row.wins / row.total;
      if (sessWR < 0.35) {
        this._log(`📊 Mid-week learning: session "${row.session}" WR=${(sessWR*100).toFixed(0)}% — pattern memory will suppress future signals`);
        // Pattern memory will naturally adjust over the next cycles from backtest data
      }
    }

    this._log(`📊 Mid-week learning applied: ${Object.keys(btWinRates).length} strategies updated from ${n} trades`);
  }

  _checkEdgeDegradation() {
    const DEGRADE_STATE_KEY = 'EDGE_DEGRADE_STATE';
    const MIN_ALERT_GAP_MS  = 4 * 60 * 60_000;  // 4h minimum between same-severity alerts
    const WORSEN_THRESHOLD  = 5;                  // re-alert only if delta worsens by ≥5pts

    // ── Per-instrument in-memory state initialization (runs once per process) ──
    // On first call, bootstrap from DB. If DB says 'degrading', bump lastAlertAt
    // to now so the 4h throttle suppresses immediate re-alerts after restart.
    if (!this._edgeDegradInitDone) {
      this._edgeDegradInitDone = true;
      let saved = {};
      try {
        const row = this.db.prepare(`SELECT params_json FROM strategy_params WHERE instrument = ?`)
          .get(DEGRADE_STATE_KEY);
        if (row) saved = JSON.parse(row.params_json);
      } catch (e) {
        console.error('[edge-degrade] state load error:', e.message);
      }
      for (const inst of ['MNQ', 'MGC']) {
        const s = saved[inst] ?? { status: 'stable', lastAlertAt: 0, lastDelta: 0 };
        this._edgeDegradState[inst] = {
          status:      s.status    ?? 'stable',
          lastDelta:   s.lastDelta ?? 0,
          // If was degrading: treat lastAlertAt as now — this silences both
          // statusChanged and worsenedMore checks after a restart.
          lastAlertAt: s.status === 'degrading' ? Date.now() : (s.lastAlertAt ?? 0),
        };
        this._log(`📈 Edge [${inst}] startup state: ${this._edgeDegradState[inst].status}`);
      }
    }

    for (const instrument of ['MNQ', 'MGC']) {
      try {
        const result = detectEdgeDegradation(this.db, instrument);

        if (result.status === 'insufficient_data' || result.status === 'error') continue;

        const mem       = this._edgeDegradState[instrument];
        const newStatus = result.status; // 'degrading' | 'stable' | 'improving'
        const now       = Date.now();

        this._log(
          `📈 Edge [${instrument}]: ${newStatus} | ` +
          `recent=${result.recentAvgWR}% prior=${result.priorAvgWR}% delta=${result.delta > 0 ? '+' : ''}${result.delta}%`
        );

        let shouldAlert = false;
        let alertTitle  = '';
        let alertBody   = '';
        let alertTags   = '';

        if (newStatus === 'degrading') {
          // Use in-memory status as source of truth — survives DB write failures
          const statusChanged   = mem.status !== 'degrading';
          const worsenedMore    = (result.delta - mem.lastDelta) < -WORSEN_THRESHOLD;
          const throttleElapsed = (now - mem.lastAlertAt) > MIN_ALERT_GAP_MS;

          if (statusChanged) {
            shouldAlert = true;
            alertTitle  = `Edge Degradation - ${instrument}`;
            alertBody   = `🔴 NEW DEGRADATION: ${result.message}`;
            alertTags   = 'chart_decreasing,red_circle';
            this._log(`🚨 EDGE DEGRADATION [${instrument}] STATE CHANGE: stable→degrading | ${result.message}`);
          } else if (worsenedMore && throttleElapsed) {
            shouldAlert = true;
            alertTitle  = `Edge Worsening - ${instrument}`;
            alertBody   = `⚠️ DEGRADATION WORSENING: ${result.message} (was ${mem.lastDelta}% → now ${result.delta}%)`;
            alertTags   = 'chart_decreasing,warning';
            this._log(`🚨 EDGE WORSENING [${instrument}]: delta ${mem.lastDelta}% → ${result.delta}%`);
          } else {
            this._log(`🔕 Edge alert suppressed [${instrument}]: already degrading (last alert ${Math.round((now - mem.lastAlertAt) / 60_000)}min ago)`);
          }
        } else if (newStatus !== 'degrading' && mem.status === 'degrading') {
          shouldAlert = true;
          alertTitle  = `Edge Recovered - ${instrument}`;
          alertBody   = `✅ EDGE RECOVERED: ${result.message}`;
          alertTags   = 'chart_with_upwards_trend,green_circle';
          this._log(`✅ EDGE RECOVERED [${instrument}]: degrading→${newStatus} | ${result.message}`);
        }

        // Update in-memory state (primary source of truth within this process)
        mem.status    = newStatus;
        mem.lastDelta = result.delta ?? mem.lastDelta;
        if (shouldAlert) mem.lastAlertAt = now;

        // Send ntfy only when truly actionable
        if (shouldAlert && this.cfg.ntfyTopic) {
          const headers = {
            'Content-Type': 'text/plain',
            'Title':    alertTitle,
            'Priority': newStatus === 'degrading' ? 'high' : 'default',
            'Tags':     alertTags,
          };
          if (this.cfg.ntfyToken) headers['Authorization'] = `Bearer ${this.cfg.ntfyToken}`;
          fetch(`${this.cfg.ntfyUrl}/${this.cfg.ntfyTopic}`, {
            method: 'POST', headers, body: alertBody,
          }).catch(() => {});
        }
      } catch (e) {
        console.error(`[edge-degrade] processing error for ${instrument}:`, e.message);
      }
    }

    // Persist in-memory state to DB for cross-restart continuity
    try {
      const toSave = {};
      for (const inst of ['MNQ', 'MGC']) {
        if (this._edgeDegradState[inst]) toSave[inst] = { ...this._edgeDegradState[inst], updatedAt: Date.now() };
      }
      this.db.prepare(`
        INSERT INTO strategy_params (instrument, params_json, updated_at, version)
        VALUES (?, ?, datetime('now'), 1)
        ON CONFLICT(instrument) DO UPDATE SET
          params_json = excluded.params_json, updated_at = excluded.updated_at, version = version + 1
      `).run(DEGRADE_STATE_KEY, JSON.stringify(toSave));
    } catch (e) {
      console.error('[edge-degrade] DB save failed:', e.message);
    }
  }

  // ── Weekly learning summary generation ───────────────────────────────────────
  // Runs automatically every Friday at 5:30 PM ET (after the week's last session).
  // Also runs on Saturday/Sunday mornings as a catch-up in case Friday evening was missed.
  // Generates per-strategy summaries for MGC_SCALP and MNQ_INTRADAY.

  _maybeGenerateWeeklySummary() {
    try {
      const now = new Date();
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(now);
      const weekday = etParts.find(p => p.type === 'weekday').value;
      const hour    = parseInt(etParts.find(p => p.type === 'hour').value, 10);

      // Only generate on Fri after 17:00 ET, or Sat/Sun as catch-up
      const isGenerationWindow =
        (weekday === 'Fri' && hour >= 17) ||
        weekday === 'Sat' ||
        (weekday === 'Sun' && hour < 18);
      if (!isGenerationWindow) return;

      // Find Monday of this week
      const d = new Date(now);
      const day = d.getDay(); // 0=Sun, 1=Mon, …
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      const weekStart = d.toISOString().slice(0, 10);

      // Skip if already generated for this week
      const existing = this.db.prepare(
        'SELECT id FROM weekly_summaries WHERE week_start = ? LIMIT 1'
      ).get(weekStart);
      if (existing) return;

      this._log(`📋 Generating weekly learning summary for week of ${weekStart}…`);

      const STRATEGY_CONFIGS = [
        { key: 'MGC_SCALP',    label: 'MGC Scalp',   instrument: 'MGC' },
        { key: 'MNQ_INTRADAY', label: 'MNQ Intraday', instrument: 'MNQ' },
        { key: 'NQ_NY_OPEN',   label: 'NQ NY Open',  instrument: 'MNQ' },
      ];

      const weekEnd = new Date(weekStart + 'T00:00:00Z');
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      const weekEndStr = weekEnd.toISOString().slice(0, 10);

      const fmtLabel = (ws) => {
        const dL = new Date(ws + 'T12:00:00Z');
        return 'Week of ' + dL.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        });
      };

      const upsert = this.db.prepare(`
        INSERT INTO weekly_summaries
          (week_start, week_label, strategy_key, strategy_label, total_signals,
           wins, losses, breakevens, win_rate, performance_review, failure_analysis,
           corrective_actions, pattern_tracking, prior_repeats, escalated, raw_signals_json)
        VALUES
          (@week_start, @week_label, @strategy_key, @strategy_label, @total_signals,
           @wins, @losses, @breakevens, @win_rate, @performance_review, @failure_analysis,
           @corrective_actions, @pattern_tracking, @prior_repeats, @escalated, @raw_signals_json)
        ON CONFLICT(week_start, strategy_key) DO NOTHING
      `);

      this.db.transaction(() => {
        for (const cfg of STRATEGY_CONFIGS) {
          const sigs = this.db.prepare(`
            SELECT s.direction, s.grade, s.session, s.htf_bias, s.score, o.result, o.pnl_pts
            FROM   signals s
            LEFT   JOIN outcomes o ON o.signal_id = s.id
            WHERE  s.strategy_name = ?
              AND  date(s.received_at) >= ?
              AND  date(s.received_at) <  ?
            ORDER  BY s.received_at ASC
          `).all(cfg.key, weekStart, weekEndStr);

          const resolved = sigs.filter(s => s.result);
          const wins   = resolved.filter(s => s.result === 'WIN').length;
          const losses = resolved.filter(s => s.result === 'LOSS').length;
          const be     = resolved.filter(s => s.result === 'BE').length;
          const total  = wins + losses;
          const wr     = total > 0 ? +(wins / total * 100).toFixed(1) : null;

          const prevWeek = new Date(weekStart + 'T00:00:00Z');
          prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
          const prevWeekStr = prevWeek.toISOString().slice(0, 10);
          const prevSummary = this.db.prepare(
            'SELECT * FROM weekly_summaries WHERE week_start = ? AND strategy_key = ?'
          ).get(prevWeekStr, cfg.key);

          const htfMismatches = resolved.filter(t => {
            return (t.direction === 'LONG' && t.htf_bias === 'BEAR') ||
                   (t.direction === 'SHORT' && t.htf_bias === 'BULL');
          }).length;

          const perfLines = [
            `LIVE_SIGNALS: ${sigs.length} total | ${wins}W/${losses}L/${be}BE | WR=${wr != null ? wr + '%' : 'N/A'}`,
          ];
          if (wr >= 65) perfLines.push('ASSESSMENT: Strong — WR >= 65%');
          else if (wr >= 52) perfLines.push('ASSESSMENT: Acceptable — WR 52-65%');
          else if (wr != null) perfLines.push('ASSESSMENT: Below average — WR < 52%; threshold review required');
          else perfLines.push('ASSESSMENT: No resolved live trades this week');
          if (htfMismatches > 0) perfLines.push(`HTF_COUNTER_TREND: ${htfMismatches} counter-trend trades taken`);

          const failureLines = [];
          if (htfMismatches > 0) failureLines.push(`COUNTER_TREND_ENTRIES: ${htfMismatches} trades against HTF bias`);
          if (wr != null && wr < 45) failureLines.push(`LOW_WIN_RATE: WR=${wr}% — confidence filter should be raised`);
          if (!failureLines.length) failureLines.push('NO_IDENTIFIED_FAILURES: Performance acceptable');

          const correctiveLines = [];
          if (wr != null && wr < 45) correctiveLines.push(`RAISE_THRESHOLD: Increase ${cfg.key} confidence minimum`);
          if (htfMismatches > 0) correctiveLines.push('ENFORCE_HTF_FILTER: Require HTF alignment before entry');
          if (!correctiveLines.length) correctiveLines.push('MAINTAIN_CURRENT_APPROACH: No changes required');

          const patternLines = [];
          let priorRepeats = 0, escalated = 0;
          if (prevSummary) {
            const prevKeys = new Set((prevSummary.failure_analysis || '').split('\n').map(l => l.split(':')[0]));
            for (const l of failureLines) {
              const k = l.split(':')[0];
              if (k !== 'NO_IDENTIFIED_FAILURES' && prevKeys.has(k)) {
                priorRepeats++;
                patternLines.push(`REPEAT_ERROR [${k}]: Same mistake 2nd consecutive week — escalating`);
                escalated = 1;
              }
            }
            if (prevSummary.escalated && escalated) {
              patternLines.push('PERSISTENT_ERROR: 3+ week repeat — mandatory parameter override');
            }
          } else {
            patternLines.push('FIRST_WEEK: No prior data for comparison');
          }
          if (!patternLines.length) patternLines.push('NO_REPEAT_PATTERNS: No recurring mistakes');

          upsert.run({
            week_start:         weekStart,
            week_label:         fmtLabel(weekStart),
            strategy_key:       cfg.key,
            strategy_label:     cfg.label,
            total_signals:      sigs.length,
            wins, losses, breakevens: be,
            win_rate:           wr,
            performance_review: perfLines.join('\n'),
            failure_analysis:   failureLines.join('\n'),
            corrective_actions: correctiveLines.join('\n'),
            pattern_tracking:   patternLines.join('\n'),
            prior_repeats:      priorRepeats,
            escalated,
            raw_signals_json:   JSON.stringify(resolved.slice(0, 50).map(s => ({
              dir: s.direction, res: s.result, htf: s.htf_bias, sess: s.session, pnl: s.pnl_pts,
            }))),
          });
        }
      })();

      // Log per-strategy outcome for verification
      try {
        const rows = this.db.prepare(
          `SELECT strategy_key, wins, losses, win_rate FROM weekly_summaries WHERE week_start = ?`
        ).all(weekStart);
        const summary = rows.map(r =>
          `${r.strategy_key}: ${r.wins}W/${r.losses}L WR=${r.win_rate != null ? r.win_rate + '%' : 'n/a'}`
        ).join(' | ');
        this._log(`📋 Weekly learning generated for ${weekStart} — ${summary || 'no resolved trades'}`);
      } catch (err) {
        this._log(`📋 Weekly summary generated for week of ${weekStart} (detail query failed: ${err.message})`);

      }
    } catch (err) {
      this._err(`Weekly summary generation FAILED for week of ${weekStart ?? 'unknown'}: ${err.message}`, err);
      console.error('[weekly-summary]', err.stack);
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

  // ── Event-driven scan trigger ─────────────────────────────────────────────────

  /**
   * Called by BarWatcher when a 5m bar closes (Tradovate) or after each Yahoo poll.
   * Merges snapshot bars with cached 1h bars then runs signal evaluation.
   */
  async _onBarReady(instrument, snapshot) {
    if (!this._isMarketOpen()) return;
    if (!this._running) return;

    try {
      // bars from the snapshot (BarAggregator output)
      const bars3m  = (snapshot.bars3m  || []);
      const bars5m  = (snapshot.bars5m  || []).slice(-500);
      const bars15m = (snapshot.bars15m || []);
      const bars30m = (snapshot.bars30m || []);
      const bars45m = (snapshot.bars45m || []);

      // 1h bars: prefer native Yahoo 1h fetch (richer history than 5m aggregation)
      // Fall back to aggregator's 1h if cache is empty
      let bars1h, bars4h, barsDly;
      if (instrument === 'MNQ') {
        bars1h  = (this._lastGoodBars.mnq1h.length >= 30
          ? this._lastGoodBars.mnq1h : snapshot.bars1h || []).slice(-500);
        bars4h  = aggregate1hTo4h(bars1h);
        barsDly = aggregate1hToDaily(bars1h);
      } else {
        bars1h  = (this._lastGoodBars.mgc1h.length >= 20
          ? this._lastGoodBars.mgc1h : snapshot.bars1h || []).slice(-500);
        bars4h  = [];
        barsDly = [];
      }

      // Confirmed-bar slices (exclude the still-forming last bar)
      const c3m  = bars3m.length  > 1 ? bars3m.slice(0, -1)  : bars3m;
      const c5m  = bars5m.length  > 1 ? bars5m.slice(0, -1)  : bars5m;
      const c1h  = bars1h.length  > 1 ? bars1h.slice(0, -1)  : bars1h;

      const c15m = bars15m.length > 1 ? bars15m.slice(0, -1) : bars15m;
      const c30m = bars30m.length > 1 ? bars30m.slice(0, -1) : bars30m;
      const c45m = bars45m.length > 1 ? bars45m.slice(0, -1) : bars45m;
      const c4h  = bars4h.length  > 1 ? bars4h.slice(0, -1)  : bars4h;
      const cDly = barsDly.length > 1 ? barsDly.slice(0, -1) : barsDly;

      if (c5m.length < 40) return; // not enough bars yet

      if (instrument === 'MNQ') {
        await this._scanInstrument('MNQ', c5m, c15m, c1h, c4h, cDly);
        const resBars = _mergeResolutionBars(this._resolution1m.mnq, bars5m);
        this._autoResolveOutcomes(resBars, 'MNQ');
        this._trackHigherTPs(resBars, 'MNQ');
      } else {
        await this._scanInstrument('MGC', c5m, c15m, c1h, [], [], c30m, c45m, c3m);
        const resBars = _mergeResolutionBars(this._resolution1m.mgc, bars5m);
        this._autoResolveOutcomes(resBars, 'MGC');
        this._trackHigherTPs(resBars, 'MGC');
      }

      if (bars5m.length >= 2) {
        const sym = instrument === 'MNQ' ? this.cfg.symbol : this.cfg.symbolMgc;
        this._savePrice(sym, bars5m);
      }
    } catch (err) {
      this._err(`_onBarReady error (${instrument})`, err);
    }
  }

  // ── Start / stop ──────────────────────────────────────────────────────────────

  start() {
    if (this._running) return this;
    this._running = true;

    const cfg = this.cfg;

    this._log(`SCANNER_BOOT_START platform=${process.env.NODE_ENV ?? 'dev'} feed=${this.feedType} logLevel=${cfg.logLevel} scanInterval=${cfg.scanInterval / 1000}s`, 'signal');
    this._log('REGISTERED_STRATEGIES LIVE: MGC_SCALP, MNQ_INTRADAY', 'signal');

    // Enforce correct strategy modes and log verified state
    try {
      // Enforce live strategies — auto-recover if accidentally disabled (skip if locked)
      for (const strat of ['MGC_SCALP', 'MNQ_INTRADAY']) {
        const before = this.db.prepare('SELECT mode, locked FROM strategy_status WHERE strategy_name = ?').get(strat);
        if (before?.locked) {
          this._log(`STRATEGY_LOCKED strategy=${strat} mode=${before.mode} — preserving (set locked=0 to re-enable auto-restore)`, 'signal');
          continue;
        }
        if (before?.mode === 'RESEARCH_ONLY') {
          this._log(`CRITICAL_STRATEGY_DISABLED_DETECTED strategy=${strat} was RESEARCH_ONLY — auto-restoring LIVE_ENABLED`, 'signal');
        }
        this.db.prepare(`
          INSERT INTO strategy_status (strategy_name, mode, live_since, updated_at)
          VALUES (?, 'LIVE_ENABLED', datetime('now'), datetime('now'))
          ON CONFLICT(strategy_name) DO UPDATE SET mode = 'LIVE_ENABLED', updated_at = datetime('now')
        `).run(strat);
      }
      // Log verified state from DB
      const allStatus = this.db.prepare('SELECT strategy_name, mode FROM strategy_status ORDER BY strategy_name').all();
      for (const row of allStatus) {
        this._log(`STRATEGY_STATUS_LOAD strategy=${row.strategy_name} mode=${row.mode} source=DB`, 'signal');
      }
    } catch (e) { this._log(`STRATEGY_STATUS_INIT_ERROR ${e.message}`, 'signal'); }

    if (cfg.ntfyTopic) {
      const masked = cfg.ntfyTopic.length > 4
        ? cfg.ntfyTopic.slice(0, 3) + '***'
        : '***';
      this._log(`NOTIFICATION_CONFIG_VALID provider=ntfy url=${cfg.ntfyUrl}/${masked} token=${cfg.ntfyToken ? 'SET' : 'NOT_SET'}`, 'signal');
    } else {
      this._log('NOTIFICATION_CONFIG_INVALID NTFY_TOPIC is not set — no push notifications will fire. Set NTFY_TOPIC in Render dashboard and redeploy.', 'signal');
    }

    // Restore last-known bars from DB so the scanner has data immediately on restart.
    // Prevents Yahoo Finance rate-limiting from blocking signal evaluation after a crash.
    this._restoreBarCache();

    // Repopulate in-memory notification Sets from DB so duplicate-send protection
    // survives PM2 restarts — without this, every restart would re-send all notifications.
    this._loadNotificationState();

    // ── Feed + event-driven watcher ─────────────────────────────────────────────
    // Start the feed adapter (Tradovate WS or Yahoo poll).
    // BarWatcher fires _onBarReady on each 5m bar close or Yahoo poll completion.
    this._feed.start().catch(err => this._err('Feed start error', err));

    this._barWatcher = new BarWatcher((instrument, snapshot) => {
      this._onBarReady(instrument, snapshot);
    });

    // ── Timer fallback ───────────────────────────────────────────────────────────
    // Yahoo: feed handles adaptive polling (30s RTH, 45s Globex); timer is a
    // safety net that also refreshes 1h bars and sweeps outcome resolution.
    // Tradovate: widen to 5 min — events drive the scan, timer is truly fallback.
    const isTradovate = this.feedType === 'TradovateFeed';
    const fallbackMs  = isTradovate ? 5 * 60_000 : cfg.scanInterval;

    this._intervals.push(setInterval(() => this.scan(), fallbackMs));

    this._log(`SCANNER_LOOP_STARTED interval=${fallbackMs / 1000}s`, 'signal');

    // Startup backtests — delayed so the service stabilises, Render health checks
    // pass, and GC has had multiple cycles before the memory-heavy backtest runs.
    // Runs in a Worker Thread (see _runBacktestInWorker) so the main event loop
    // stays free during computation — no more health-check timeouts.
    setTimeout(() => this.runBacktestCycle('MNQ', 'startup'), 30 * 60_000);   // 30 min
    setTimeout(() => this.runBacktestCycle('MGC', 'startup'), 40 * 60_000);   // 40 min

    // Startup optimizers (after backtests finish)
    setTimeout(() => this.runOptimizerCycle('MNQ'), 70 * 60_000);
    setTimeout(() => this.runOptimizerCycle('MGC'), 78 * 60_000);

    // News at startup + every 30 min
    setTimeout(() => this.fetchAndStoreNews(), 8_000);
    this._intervals.push(setInterval(() => this.fetchAndStoreNews(), 30 * 60_000));

    // Storage cleanup
    setTimeout(() => this.runStorageCleanup(), 15_000);
    this._intervals.push(setInterval(() => this.runStorageCleanup(), 24 * 3_600_000));

    // First scan runs immediately; expiry sweeps chain after so _autoResolveOutcomes
    // can detect WIN/LOSS in recent bars before the sweep fires and expires them.
    this.scan().finally(() => {
      this._fixStuckTrades();
      this._sweepExpiredSignals();
      this._intervals.push(setInterval(() => this._sweepExpiredSignals(), 60_000));
      this._intervals.push(setInterval(() => this._fixStuckTrades(), 5 * 60_000));
      this._log('RECONCILIATION_LOOP_STARTED expirySweep=60s fixStuck=5min', 'signal');
    });

    // Deep historical backtest (60-day 5m bars from Yahoo Finance).
    // Only runs in worker mode (dedicated process on Droplet with ≥1GB RAM).
    // Skipped in INLINE mode (Render 512MB) — loading ~23k bars + walkForward backtest
    // exhausts the 400MB heap and causes a silent OOM kill every ~60 minutes.
    if (process.env.SCANNER_MODE === 'worker') {
      setTimeout(() => this.runDeepHistoricalBacktest('MNQ'), 55 * 60_000);
      setTimeout(() => this.runDeepHistoricalBacktest('MGC'), 65 * 60_000);
      this._intervals.push(setInterval(() => {
        const now = new Date();
        if (now.getDay() === 0 && now.getHours() >= 18) {  // Sunday 18:00+ local (futures re-open)
          this.runDeepHistoricalBacktest('MNQ');
          setTimeout(() => this.runDeepHistoricalBacktest('MGC'), 8 * 60_000);
        }
      }, 60 * 60_000)); // check every hour
    }

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

    // Weekly learning summary — check every hour; generates once per week on Friday after close
    this._intervals.push(setInterval(() => this._maybeGenerateWeeklySummary(), 60 * 60_000));
    setTimeout(() => this._maybeGenerateWeeklySummary(), 30_000); // check shortly after startup

    // Mid-week intelligence report — check every hour; generates once on Wednesday after 15:00 ET
    this._intervals.push(setInterval(() => this._maybeGenerateMidWeekReport(), 60 * 60_000));
    setTimeout(() => this._maybeGenerateMidWeekReport(), 45_000);

    // Weekly Deep Dive report — check every hour; generates Friday after 14:00 PT (17:00 ET) or Sat/Sun catch-up
    this._intervals.push(setInterval(() => this._maybeGenerateWeeklyDeepReport(), 60 * 60_000));
    setTimeout(() => this._maybeGenerateWeeklyDeepReport(), 60_000);

    // Edge degradation monitoring — runs after each backtest cycle (called inline in runBacktestCycle)
    // Also check once at startup after backtests have run (35 min delay)
    setTimeout(() => this._checkEdgeDegradation(), 35 * 60_000);

    this._log(
      `Scanner started — feed=${this.feedType} symbol=${cfg.symbol} mgc=${cfg.symbolMgc} ` +
      `fallback=${Math.round(fallbackMs / 1000)}s dupGuard=${cfg.duplicateGuardMin}min ` +
      `cap=${cfg.dailySignalCap} minDaily=${cfg.dailyMinSignals} ` +
      `strategies=MNQ_INTRADAY,MGC_SCALP`
    );
    this._log(formatStartupConfig(cfg.duplicateGuardMin));

    this._log(`SCANNER_BOOT_SUCCESS all subsystems armed — scanner is live`, 'signal');

    // Startup ntfy confirmation — DB-throttled to once per 10 minutes (cross-process safe).
    // Uses dedup_ideas table so crash loops (PM2 auto-restart every 2-5 min) produce
    // at most one notification per 10-minute window instead of spamming on every restart.
    // A genuine restart after >10 min offline always sends.
    const STARTUP_COOLDOWN_MS = 10 * 60_000;
    const STARTUP_DEDUP_KEY   = 'SYSTEM:SCANNER_ONLINE';
    if (cfg.ntfyTopic) {
      setTimeout(() => {
        if (this._startupNtfySent) {
          this._log('[ntfy] startup notification already sent this process — skipping', 'signal');
          return;
        }
        // Cross-process throttle check
        try {
          const now = Date.now();
          const existing = this.db.prepare(
            "SELECT expires_at FROM dedup_ideas WHERE key = ? AND expires_at > ?"
          ).get(STARTUP_DEDUP_KEY, now);
          if (existing) {
            const minsLeft = Math.round((existing.expires_at - now) / 60_000);
            this._log(`[ntfy] startup notification throttled — crash-loop guard active, ${minsLeft} min remaining`, 'signal');
            return;
          }
          // Claim the slot atomically before sending
          this.db.prepare(`
            INSERT OR REPLACE INTO dedup_ideas
              (key, expires_at, instrument, direction, family, strategy, session, entry, sl)
            VALUES (?, ?, 'SYSTEM', 'NONE', 'SYSTEM', 'SYSTEM', NULL, 0, 0)
          `).run(STARTUP_DEDUP_KEY, now + STARTUP_COOLDOWN_MS);
        } catch (e) { this._log(`[ntfy] startup throttle DB error (proceeding): ${e.message}`, 'signal'); }

        this._startupNtfySent = true;
        try {
          const headers = {
            'Content-Type': 'text/plain',
            'Title':    'Aurum Signals - Online',
            'Priority': 'default',
            'Tags':     'white_check_mark',
          };
          if (cfg.ntfyToken) headers['Authorization'] = `Bearer ${cfg.ntfyToken}`;
          const body = `✅ Scanner started\nMin daily signals: ${cfg.dailyMinSignals}/instrument\nStrategies: MNQ_INTRADAY, MGC_SCALP\nDuplicate guard: ${cfg.duplicateGuardMin}min | Adaptive cooldown: ENABLED`;
          const ntfyUrl = `${cfg.ntfyUrl}/${cfg.ntfyTopic}`;
          this._log(`[ntfy] sending startup notification → ${ntfyUrl}`, 'signal');
          fetch(ntfyUrl, { method: 'POST', headers, body })
            .then(r => this._log(`[ntfy] startup notification sent — HTTP ${r.status}`, 'signal'))
            .catch(err => this._log(`[ntfy] startup notification FAILED: ${err.message}`, 'signal'));
        } catch (e) { this._log(`[ntfy] startup notification error: ${e.message}`, 'signal'); }
      }, 3_000);
    } else {
      this._log('[ntfy] NTFY_TOPIC not configured — startup notification skipped', 'signal');
    }

    return this;
  }

  stop() {
    this._running = false;
    for (const iv of this._intervals) clearInterval(iv);
    this._intervals = [];
    this._barWatcher?.destroy();
    this._feed?.stop().catch(() => {});
    this._log('Scanner stopped.');
    return this;
  }
}

module.exports = { Scanner };
