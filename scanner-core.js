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
  aggregate1hTo4h,
  aggregate1hToDaily,
} = require('./strategies/shared-indicators');
const { getAdaptiveMinScore, getMarketRegime } = require('./learning');
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
      scanInterval:    config.scanInterval    || Math.min(parseInt(process.env.SCAN_INTERVAL || '15') * 1000, 60_000),
      cooldown:        config.cooldown        || parseInt(process.env.SCANNER_COOLDOWN    || '90'),
      baseScore:       config.baseScore       || parseInt(process.env.SCANNER_MIN_SCORE   || '6'),
      dailySignalCap:  config.dailySignalCap  || parseInt(process.env.DAILY_SIGNAL_CAP    || '15'),
      logLevel:        config.logLevel        || (process.env.SCANNER_LOG_LEVEL || 'full').toLowerCase(),
      ntfyUrl:         config.ntfyUrl         || (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, ''),
      ntfyTopic:       config.ntfyTopic       || process.env.NTFY_TOPIC || '',
      ntfyToken:       config.ntfyToken       || process.env.NTFY_TOKEN || '',
      btIntervalH:     config.btIntervalH     || parseFloat(process.env.BACKTEST_INTERVAL_H  || '4'),
      btBars:          config.btBars          || parseInt(process.env.BACKTEST_BARS           || '10000'),
      btSlippage:      config.btSlippage      || parseFloat(process.env.BT_SLIPPAGE          || '0.5'),
      btTargetTrades:  config.btTargetTrades  || parseInt(process.env.BT_TARGET_TRADES        || '250'),
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

  // ── Yahoo Finance fetch with exponential-backoff retry ───────────────────────

  async _fetchWithRetry(url, maxAttempts = 3) {
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0) {
          // 2s, 4s, 8s backoff
          const delay = Math.min(2000 * (2 ** (attempt - 1)), 30_000);
          await new Promise(r => setTimeout(r, delay));
          this._log(`Retry ${attempt}/${maxAttempts - 1}: ${url.slice(50, 110)}…`);
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20_000);
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'NQ-Signal-Pro/3.0' },
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.slice(0, 80)}`);
          return await res.json();
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err;
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
    const body = [
      s.setup        ? `Setup:   ${stratTag}${s.setup}`   : null,
      s.trade_style  ? `Style:   ${s.trade_style}`         : null,
      s.entry != null? `Entry:   ${s.entry}`               : null,
      s.sl    != null? `SL:      ${s.sl}`                  : null,
      s.tp1   != null? `TP1:     ${s.tp1}`                 : null,
      s.tp2   != null? `TP2:     ${s.tp2}`                 : null,
      s.tp3   != null? `TP3:     ${s.tp3}`                 : null,
      s.rr    != null? `RR:      ${s.rr}`                  : null,
      s.confidence != null ? `Conf:    ${s.confidence}/100` : null,
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

  // ── Signal storage ────────────────────────────────────────────────────────────

  _storeSignal(signal) {
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
        this._log(`AUTO-RESOLVE #${sig.id} ${instrument}: ${sig.direction} → ${resolved.result} (${+pnlPts.toFixed(2)} pts)`, 'signal');
        this.emit('outcome', { signalId: sig.id, instrument, result: resolved.result, pnlPts: +pnlPts.toFixed(2) });
      }
    }
  }

  // ── Per-instrument scan ───────────────────────────────────────────────────────

  async _scanInstrument(instrument, bars5m, bars15m, bars1h, bars4h, barsDly) {
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
      ? { bars5mMgc: bars5m, bars15mMgc: bars15m, bars1hMgc: bars1h }
      : { bars5m, bars15m, bars1h, bars4h, barsDly };

    const signals         = evaluateAll(barSets, { instrument });
    const stratsFiredNames = signals.map(s => s.strategy_name);
    let anyFired          = false;

    for (const sig of signals) {
      // Re-check cooldown per signal (another strategy may have just fired)
      if (Date.now() - (this._lastSignalTimes[instrument] ?? 0) < cooldownMs) {
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, null, 'cooldown');
        this._log(`⏳ Cooldown: ${sig.strategy_name} ${instrument} suppressed`);
        continue;
      }

      // Adaptive confidence gate
      const minConf = getAdaptiveMinScore(this.db, sig.setup, sig.trade_style, sig.confidence);
      if (sig.confidence < minConf) {
        const reason = `confidence ${sig.confidence} < adaptive min ${minConf}`;
        this._log(`⚠️  ${sig.strategy_name} ${instrument} — ${reason}`);
        this._storeRejection(instrument, sig.direction, sig.setup, sig.strategy_name,
          sig.confidence, minConf, reason);
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

  // ── Main scan cycle ───────────────────────────────────────────────────────────

  async scan() {
    this._scanCount++;
    try {
      // Fetch primary bars — use last known good on failure
      let mnq5mRaw = [], mnq1hRaw = [], mgc5mRaw = [], mgc1hRaw = [];

      try {
        [mnq5mRaw, mnq1hRaw, mgc5mRaw, mgc1hRaw] = await Promise.all([
          this._fetchYahooBars(this.cfg.symbol,    '5m', '60d'),
          this._fetchYahooBars(this.cfg.symbol,    '1h', '730d'),
          this._fetchYahooBars(this.cfg.symbolMgc, '5m', '60d'),
          this._fetchYahooBars(this.cfg.symbolMgc, '1h', '730d'),
        ]);
        // Update last-known-good cache
        if (mnq5mRaw.length) this._lastGoodBars.mnq5m = mnq5mRaw;
        if (mnq1hRaw.length) this._lastGoodBars.mnq1h = mnq1hRaw;
        if (mgc5mRaw.length) this._lastGoodBars.mgc5m = mgc5mRaw;
        if (mgc1hRaw.length) this._lastGoodBars.mgc1h = mgc1hRaw;
        this._consecutiveErrors = 0;
      } catch (fetchErr) {
        this._consecutiveErrors++;
        this._err(`Data fetch failed (error #${this._consecutiveErrors})`, fetchErr);

        // Fall back to cached data if available
        if (this._lastGoodBars.mnq5m.length) {
          this._log('⚠️  Using cached bars from last successful fetch');
          mnq5mRaw = this._lastGoodBars.mnq5m;
          mnq1hRaw = this._lastGoodBars.mnq1h;
          mgc5mRaw = this._lastGoodBars.mgc5m;
          mgc1hRaw = this._lastGoodBars.mgc1h;
          // After 5+ consecutive failures send an alert
          if (this._consecutiveErrors === 5 && this.cfg.ntfyTopic) {
            this._sendNtfy({
              direction: 'SHORT', grade: '!', instrument: 'SYS',
              setup: 'Data feed warning', session: 'system',
              ticker: 'NQ Signal Pro',
              trade_style: `${this._consecutiveErrors} consecutive fetch failures`,
            });
          }
        } else {
          return; // No cache yet, nothing to scan
        }
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
        mgcReady ? this._scanInstrument('MGC', mgc5m, mgc15m, mgc1h, [],    [])    : null,
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
      this._log(`BACKTEST START: ${instrument} (${this.cfg.btBars} bars, target ${this.cfg.btTargetTrades} trades)`);

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
        this.db.transaction(() => {
          for (const t of allTrades) {
            insTrade.run(runId, instrument, t.bar ?? null, t.timestamp ?? null,
              t.direction, t.setup ?? null, t.strategy_name ?? null,
              t.trade_style ?? null, t.regime ?? null,
              t.entry ?? null, t.sl ?? null, t.tp1 ?? null,
              t.outcome, t.score ?? null, t.confidence ?? null);
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

    // Startup backtests (staggered)
    setTimeout(() => this.runBacktestCycle('MNQ', 'startup'),  5_000);
    setTimeout(() => this.runBacktestCycle('MGC', 'startup'), 35_000);

    // Startup optimizers (further staggered)
    setTimeout(() => this.runOptimizerCycle('MNQ'), 120_000);
    setTimeout(() => this.runOptimizerCycle('MGC'), 180_000);

    // News at startup + every 30 min
    setTimeout(() => this.fetchAndStoreNews(), 8_000);
    this._intervals.push(setInterval(() => this.fetchAndStoreNews(), 30 * 60_000));

    // Storage cleanup
    setTimeout(() => this.runStorageCleanup(), 15_000);
    this._intervals.push(setInterval(() => this.runStorageCleanup(), 24 * 3_600_000));

    // Periodic backtests (staggered so they don't overlap)
    const btMs  = cfg.btIntervalH * 3_600_000;
    this._intervals.push(setInterval(() => this.runBacktestCycle('MNQ'), btMs));
    this._intervals.push(setInterval(() => this.runBacktestCycle('MGC'), btMs + btMs / 2));

    // Periodic optimizers
    const optMs = cfg.optIntervalH * 3_600_000;
    this._intervals.push(setInterval(() => this.runOptimizerCycle('MNQ'), optMs));
    this._intervals.push(setInterval(() => this.runOptimizerCycle('MGC'), optMs + optMs / 3));

    this._log(
      `Scanner started — symbol=${cfg.symbol} mgc=${cfg.symbolMgc} ` +
      `interval=${cfg.scanInterval / 1000}s cooldown=${cfg.cooldown}min ` +
      `strategies=MNQ_INTRADAY,MNQ_SWING,MNQ_50PT,MGC_SCALP`
    );

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
