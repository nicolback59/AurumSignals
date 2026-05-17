'use strict';
const express  = require('express');
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { getLearningStats, detectEdgeDegradation } = require('./learning');
const { getParams }        = require('./strategy-params');
const { Scanner }          = require('./scanner-core');
const {
  analyzeDivergence, generateMidWeekReport, generateWeeklyDeepReport,
  getPerformanceIntelligence, getInstrumentBehaviorProfile, loadReport,
  listReports, getReportScheduleStatus,
} = require('./performance-reporter');
const { getDNAInsights, getDNAGuidance, loadDNA } = require('./strategy-dna');
const { getEvolutionHistory, getVariantPoolStatus } = require('./strategy-evolution');
const { getOpeningCandleReport, getSessionOpenBias } = require('./opening-candle');
const { classifyNow, isBlackout, msUntilOpen } = require('./clock/market-clock');

// ── Global crash guards ───────────────────────────────────────────────────────
// Prevent unhandled promise rejections or thrown errors from killing the server.
// The scanner catches its own errors, but these backstops ensure the HTTP server
// never goes down due to an async scanner fault.
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason?.message ?? reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err.message, err.stack);
  // Do NOT exit — the server must keep serving HTTP even if something throws.
});

const PORT           = process.env.PORT           || 3000;
const DB_PATH        = process.env.DB_PATH        || path.join(__dirname, 'signals.db');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const NTFY_URL       = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC     = process.env.NTFY_TOPIC || '';
const NTFY_TOKEN     = process.env.NTFY_TOKEN || '';

const app = express();
// Stripe webhook needs raw body — skip JSON parsing for that path only
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return express.raw({ type: 'application/json' })(req, res, next);
  express.json({ limit: '64kb' })(req, res, next);
});
app.use(express.static(__dirname));

// ── DATABASE ─────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Safe column migrations for existing databases ─────────────────────────────
// Must run BEFORE db.exec(schema) so indexes on new columns don't fail on old DBs.
function applyMigrations() {
  const hasSignals = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='signals'").get();
  if (hasSignals) {
    const cols = db.prepare("PRAGMA table_info(signals)").all().map(r => r.name);
    if (!cols.includes('strategy_name')) {
      db.exec("ALTER TABLE signals ADD COLUMN strategy_name TEXT");
      console.log('[migration] Added strategy_name to signals');
    }
    if (!cols.includes('confidence')) {
      db.exec("ALTER TABLE signals ADD COLUMN confidence INTEGER");
      console.log('[migration] Added confidence to signals');
    }
    if (!cols.includes('tier')) {
      db.exec("ALTER TABLE signals ADD COLUMN tier TEXT");
      console.log('[migration] Added tier to signals');
    }
    if (!cols.includes('trade_status')) {
      db.exec("ALTER TABLE signals ADD COLUMN trade_status TEXT NOT NULL DEFAULT 'ACTIVE'");
      console.log('[migration] Added trade_status to signals');
    }
    if (!cols.includes('expires_at')) {
      db.exec("ALTER TABLE signals ADD COLUMN expires_at TEXT");
      console.log('[migration] Added expires_at to signals');
    }
    if (!cols.includes('expiration_reason')) {
      db.exec("ALTER TABLE signals ADD COLUMN expiration_reason TEXT");
      console.log('[migration] Added expiration_reason to signals');
    }
  }
  const hasOutcomes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outcomes'").get();
  if (hasOutcomes) {
    const outCols = db.prepare("PRAGMA table_info(outcomes)").all().map(r => r.name);
    if (!outCols.includes('expiration_reason')) {
      db.exec("ALTER TABLE outcomes ADD COLUMN expiration_reason TEXT");
      console.log('[migration] Added expiration_reason to outcomes');
    }
  }
  const hasBtTrades = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backtest_trades'").get();
  if (hasBtTrades) {
    const btCols = db.prepare("PRAGMA table_info(backtest_trades)").all().map(r => r.name);
    if (!btCols.includes('strategy_name')) {
      db.exec("ALTER TABLE backtest_trades ADD COLUMN strategy_name TEXT");
      console.log('[migration] Added strategy_name to backtest_trades');
    }
    if (!btCols.includes('confidence')) {
      db.exec("ALTER TABLE backtest_trades ADD COLUMN confidence INTEGER");
      console.log('[migration] Added confidence to backtest_trades');
    }
    if (!btCols.includes('pnl_pts')) {
      db.exec("ALTER TABLE backtest_trades ADD COLUMN pnl_pts REAL");
      console.log('[migration] Added pnl_pts to backtest_trades');
    }
    // Backfill pnl_pts for historical rows that have entry/tp1/sl but no pnl_pts
    db.exec(`
      UPDATE backtest_trades
      SET pnl_pts = CASE
        WHEN outcome = 'BE'   THEN 0
        WHEN outcome = 'WIN'  AND direction = 'LONG'  AND tp1 IS NOT NULL AND entry IS NOT NULL THEN ROUND(tp1 - entry, 2)
        WHEN outcome = 'WIN'  AND direction = 'SHORT' AND tp1 IS NOT NULL AND entry IS NOT NULL THEN ROUND(entry - tp1, 2)
        WHEN outcome = 'LOSS' AND direction = 'LONG'  AND sl  IS NOT NULL AND entry IS NOT NULL THEN ROUND(sl  - entry, 2)
        WHEN outcome = 'LOSS' AND direction = 'SHORT' AND sl  IS NOT NULL AND entry IS NOT NULL THEN ROUND(entry - sl,  2)
        ELSE NULL
      END
      WHERE pnl_pts IS NULL AND outcome IN ('WIN','LOSS','BE') AND entry IS NOT NULL
    `);
  }
  // ── Deduplicate historical backtest_runs ─────────────────────────────────
  // Keep only the most recent run per (instrument, win_rate rounded to 3dp,
  // trades_found) group. Cascades to backtest_trades and backtest_details.
  const hasBtRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backtest_runs'").get();
  if (hasBtRuns) {
    const btRunCols = db.prepare("PRAGMA table_info(backtest_runs)").all().map(r => r.name);
    if (!btRunCols.includes('source_data_start')) {
      db.exec("ALTER TABLE backtest_runs ADD COLUMN source_data_start TEXT");
      console.log('[migration] Added source_data_start to backtest_runs');
    }
    if (!btRunCols.includes('source_data_end')) {
      db.exec("ALTER TABLE backtest_runs ADD COLUMN source_data_end TEXT");
      console.log('[migration] Added source_data_end to backtest_runs');
    }
    if (!btRunCols.includes('data_window_label')) {
      db.exec("ALTER TABLE backtest_runs ADD COLUMN data_window_label TEXT");
      console.log('[migration] Added data_window_label to backtest_runs');
    }
    if (!btRunCols.includes('mode')) {
      db.exec("ALTER TABLE backtest_runs ADD COLUMN mode TEXT DEFAULT 'LIVE'");
      console.log('[migration] Added mode to backtest_runs');
    }
  }
  // Re-check for dedup (variable already declared above, reuse hasBtRuns)
  if (hasBtRuns) {
    const hasCascadeDelete = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type='trigger' AND name='_dedup_cascade_bt_trades'
    `).get();

    // Only run dedup once at startup (idempotent — safe to re-run but slow on large DBs)
    const dupCount = db.prepare(`
      SELECT COUNT(*) AS n FROM backtest_runs
      WHERE id NOT IN (
        SELECT MAX(id) FROM backtest_runs
        GROUP BY instrument, ROUND(COALESCE(win_rate,0), 3), COALESCE(trades_found,0)
      )
    `).get()?.n ?? 0;

    if (dupCount > 0) {
      console.log(`[migration] Removing ${dupCount} duplicate backtest_runs rows...`);
      // Remove orphaned trades first (no FK cascade in SQLite unless PRAGMA foreign_keys=ON)
      db.exec(`
        DELETE FROM backtest_trades
        WHERE run_id NOT IN (
          SELECT MAX(id) FROM backtest_runs
          GROUP BY instrument, ROUND(COALESCE(win_rate,0), 3), COALESCE(trades_found,0)
        )
      `);
      db.exec(`
        DELETE FROM backtest_details
        WHERE run_id NOT IN (
          SELECT MAX(id) FROM backtest_runs
          GROUP BY instrument, ROUND(COALESCE(win_rate,0), 3), COALESCE(trades_found,0)
        )
      `);
      db.exec(`
        DELETE FROM backtest_runs
        WHERE id NOT IN (
          SELECT MAX(id) FROM backtest_runs
          GROUP BY instrument, ROUND(COALESCE(win_rate,0), 3), COALESCE(trades_found,0)
        )
      `);
      console.log('[migration] Duplicate backtest_runs cleanup complete');
    }
  }
}
applyMigrations();

// ── One-time startup cleanup: expire all stale open trades ────────────────────
// Runs every time the server starts. Catches any trades left open by downtime,
// using per-strategy max hold times and PT market-close rules.
(function cleanupStaleOpenTrades() {
  try {
    const MAX_HOLD = {
      MGC_SCALP:    1  * 3600000,
      MGC_INTRADAY: 4  * 3600000,
      MNQ_INTRADAY: 4  * 3600000,
      MNQ_50PT:     6  * 3600000,
      MNQ_SWING:    72 * 3600000,
    };
    const NO_WEEKEND = new Set(['MGC_SCALP','MGC_INTRADAY','MNQ_INTRADAY','MNQ_50PT']);
    const NO_OVERNIGHT = NO_WEEKEND;

    const nowMs  = Date.now();
    const now    = new Date();
    const nowPt  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const ptHm   = nowPt.getHours() * 60 + nowPt.getMinutes();
    const ptDow  = nowPt.getDay();
    const isFriClose    = ptDow === 5 && ptHm >= 13 * 60;
    const isWeekend     = ptDow === 6 || (ptDow === 0 && ptHm < 14 * 60);
    const isWeekendClose = isFriClose || isWeekend;
    const isWeekdayClose = ptDow >= 1 && ptDow <= 5 && ptHm >= 13 * 60 && ptHm < 14 * 60;

    const stale = db.prepare(`
      SELECT s.id, s.entry, s.received_at, s.strategy_name, s.trade_style, s.instrument, s.direction
      FROM signals s
      LEFT JOIN outcomes o ON o.signal_id = s.id
      WHERE o.id IS NULL
        AND s.entry IS NOT NULL
        AND (s.trade_status IS NULL OR s.trade_status = 'ACTIVE')
    `).all();

    if (!stale.length) return;

    const setStatus  = db.prepare("UPDATE signals SET trade_status = 'EXPIRED' WHERE id = ?");
    const insOutcome = db.prepare("INSERT OR IGNORE INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts) VALUES (?,?,?,?,?)");
    const setReason  = db.prepare("UPDATE signals SET expiration_reason = ? WHERE id = ?");

    let fixed = 0;
    const nowIso = now.toISOString();

    for (const sig of stale) {
      try {
        const maxMs    = MAX_HOLD[sig.strategy_name] ?? (sig.trade_style === 'swing' ? 72*3600000 : 6*3600000);
        const ageMs    = nowMs - new Date(sig.received_at).getTime();
        const overHold = ageMs > maxMs;
        const wkndExp  = isWeekendClose && NO_WEEKEND.has(sig.strategy_name);
        const mktExp   = isWeekdayClose && NO_OVERNIGHT.has(sig.strategy_name);

        let reason = null;
        if (wkndExp)       reason = 'EXPIRED_WEEKEND_CLOSE';
        else if (mktExp)   reason = 'EXPIRED_MARKET_CLOSE';
        else if (overHold) reason = ageMs > 3 * 24 * 3600000 ? 'EXPIRED_STUCK_TRADE' : 'EXPIRED_MAX_HOLD';

        if (!reason) continue;

        insOutcome.run(sig.id, 'EXPIRED', sig.entry, nowIso, 0);
        setStatus.run(sig.id);
        setReason.run(reason, sig.id);
        fixed++;
      } catch { /* never crash per-row */ }
    }

    if (fixed > 0) console.log(`[startup-cleanup] Expired ${fixed} stale open trade(s) at startup`);
  } catch (err) {
    console.error('[startup-cleanup] Error during stale trade cleanup:', err.message);
  }
})();

db.exec(schema);

// Create new tables added by this release if they don't exist yet (safe no-ops on fresh DBs)
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id            TEXT    UNIQUE NOT NULL,
    report_type          TEXT    NOT NULL,
    scope                TEXT    NOT NULL DEFAULT 'COMBINED',
    status               TEXT    NOT NULL DEFAULT 'completed',
    attempt_count        INTEGER NOT NULL DEFAULT 1,
    generated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    start_date           TEXT    NOT NULL,
    end_date             TEXT    NOT NULL,
    summary              TEXT,
    metrics_json         TEXT,
    strategy_json        TEXT,
    backtest_json        TEXT,
    recommendations_json TEXT,
    version_changes      TEXT,
    failure_analysis     TEXT,
    narrative            TEXT,
    error_message        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(report_type, generated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_reports_id   ON reports(report_id);

  CREATE TABLE IF NOT EXISTS report_schedule (
    schedule_key    TEXT    PRIMARY KEY,
    last_run_at     TEXT,
    last_report_id  TEXT,
    next_run_at     TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    tz              TEXT    NOT NULL DEFAULT 'America/Los_Angeles'
  );
`);

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, strategy_name, entry, sl, tp1, tp2, tp3,
     score, confidence, tier, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
     trade_style, instrument, rr, trade_status, raw_payload)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @strategy_name, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @confidence, @tier, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
     @trade_style, @instrument, @rr, 'ACTIVE', @raw_payload)
`);

const upsertOutcome = db.prepare(`
  INSERT INTO outcomes (signal_id, result, exit_price, exit_at, pnl_pts, pnl_usd, notes)
  VALUES (@signal_id, @result, @exit_price, datetime('now'), @pnl_pts, @pnl_usd, @notes)
  ON CONFLICT(signal_id) DO UPDATE SET
    result     = excluded.result,
    exit_price = excluded.exit_price,
    exit_at    = excluded.exit_at,
    pnl_pts    = excluded.pnl_pts,
    pnl_usd    = excluded.pnl_usd,
    notes      = excluded.notes
`);

// ── NTFY ─────────────────────────────────────────────────────────────────────────────
function sendNtfy(s) {
  if (!NTFY_TOPIC) return;

  const arrow    = s.direction === 'LONG' ? '▲' : '▼';
  const priority = s.grade === 'A+' ? 'urgent' : 'high';
  const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';

  const body = [
    s.setup             ? `Setup:   ${s.setup}`            : null,
    s.entry   != null   ? `Entry:   ${s.entry}`            : null,
    s.sl      != null   ? `SL:      ${s.sl}`               : null,
    s.tp1     != null   ? `TP1:     ${s.tp1}`              : null,
    s.tp2     != null   ? `TP2:     ${s.tp2}`              : null,
    s.tp3     != null   ? `TP3:     ${s.tp3}`              : null,
    s.score   != null   ? `Score:   ${s.score}`            : null,
    s.win_prob_tp1 != null ? `Win%:  ${s.win_prob_tp1}%`   : null,
    s.session           ? `Session: ${s.session}`          : null,
  ].filter(Boolean).join('\n');

  const headers = {
    'Content-Type': 'text/plain',
    'Title':    `${s.direction === 'LONG' ? '[LONG]' : '[SHORT]'} ${s.grade} - ${s.ticker}`,
    'Priority': priority,
    'Tags':     tags,
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;

  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy] send failed:', err.message));
}

// ── WEBHOOK ──────────────────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const b = req.body;
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'Invalid JSON' });

  const raw = JSON.stringify(b);

  let direction = (b.signal || b.direction || '').toUpperCase().trim();
  if (direction !== 'LONG' && direction !== 'SHORT') {
    if      (raw.includes('LONG'))  direction = 'LONG';
    else if (raw.includes('SHORT')) direction = 'SHORT';
    else return res.status(400).json({ error: 'Cannot determine direction' });
  }

  let grade = (b.grade || '').trim() || null;
  if (!grade) grade = raw.includes('A+') ? 'A+' : 'A';

  const num = v => (v != null && v !== '' ? Number(v) : null);

  try {
    const info = insertSignal.run({
      ticker:        b.ticker         || 'NQ1!',
      timeframe:     b.timeframe      || b.interval || null,
      direction,
      grade,
      setup:         b.setup          || null,
      strategy_name: b.strategy_name  || null,
      entry:         num(b.entry),
      sl:            num(b.sl),
      tp1:           num(b.tp1),
      tp2:           num(b.tp2),
      tp3:           num(b.tp3),
      score:         num(b.score),
      confidence:    num(b.confidence) ?? null,
      tier:          b.tier           || null,
      win_prob_tp1:  num(b.win_prob_tp1),
      win_prob_tp2:  num(b.win_prob_tp2),
      win_prob_tp3:  num(b.win_prob_tp3),
      htf_bias:      b.htf_bias       || null,
      session:       b.session        || null,
      trade_style:   b.trade_style    || b.tradeStyle || null,
      instrument:    b.instrument     || null,
      rr:            num(b.rr),
      raw_payload:   raw,
    });
    const stratLabel = b.strategy_name || b.setup || 'TradingView';
    console.log(`[${new Date().toISOString()}] ${direction} ${grade} | ${stratLabel} | score=${b.score||'?'} | id=${info.lastInsertRowid}`);
    res.json({ ok: true, id: info.lastInsertRowid });
    sendNtfy({
      ticker: b.ticker || 'NQ1!', direction, grade,
      setup: b.setup || null,
      entry: num(b.entry), sl: num(b.sl),
      tp1: num(b.tp1), tp2: num(b.tp2), tp3: num(b.tp3),
      score: num(b.score), win_prob_tp1: num(b.win_prob_tp1),
      session: b.session || null,
    });
  } catch (err) {
    console.error('DB insert error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── API ───────────────────────────────────────────────────────────────────────────────
app.get('/api/signals', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(`
    SELECT s.*, o.result, o.exit_price, o.exit_at, o.pnl_pts, o.pnl_usd
    FROM   signals s
    LEFT   JOIN outcomes o ON o.signal_id = s.id
    ORDER  BY s.received_at DESC
    LIMIT  ?
  `).all(limit);
  res.json(rows);
});

app.get('/api/status', (req, res) => {
  const scanner = global._scanner;
  res.json({
    feedType:      scanner?.feedType      ?? 'unknown',
    feedConnected: scanner?._feed?.isConnected() ?? false,
    tradovateConfigured: !!(
      process.env.TRADOVATE_USERNAME &&
      process.env.TRADOVATE_CID &&
      process.env.TRADOVATE_SECRET
    ),
    env:           process.env.TRADOVATE_ENV || 'live',
    scanCount:     scanner?._scanCount ?? 0,
    uptime:        Math.floor(process.uptime()),
  });
});

app.get('/api/stats', (req, res) => {
  const total      = db.prepare('SELECT COUNT(*) n FROM signals').get().n;
  const last24h    = db.prepare(`SELECT COUNT(*) n FROM signals WHERE received_at >= datetime('now','-1 day')`).get().n;
  const byGrade    = db.prepare('SELECT grade, COUNT(*) n FROM signals GROUP BY grade').all();
  const bySetup    = db.prepare('SELECT setup, COUNT(*) n FROM signals GROUP BY setup ORDER BY n DESC').all();
  const byStrategy = db.prepare('SELECT strategy_name, COUNT(*) n FROM signals WHERE strategy_name IS NOT NULL GROUP BY strategy_name ORDER BY n DESC').all();
  const byDir      = db.prepare('SELECT direction, COUNT(*) n FROM signals GROUP BY direction').all();
  const outcomes   = db.prepare('SELECT result, COUNT(*) n FROM outcomes GROUP BY result').all();
  res.json({ total, last24h, byGrade, bySetup, byStrategy, byDir, outcomes });
});

app.post('/api/outcome', (req, res) => {
  const { signal_id, result, exit_price, pnl_pts, pnl_usd, notes } = req.body || {};
  if (!signal_id || !result) return res.status(400).json({ error: 'signal_id and result required' });
  if (!['WIN', 'LOSS', 'BE'].includes(result)) return res.status(400).json({ error: 'result must be WIN, LOSS, or BE' });
  upsertOutcome.run({
    signal_id,
    result,
    exit_price: exit_price ?? null,
    pnl_pts:    pnl_pts    ?? null,
    pnl_usd:    pnl_usd    ?? null,
    notes:      notes      ?? null,
  });
  res.json({ ok: true });
});

// ── LEARNING ─────────────────────────────────────────────────────────────────────────────
app.get('/api/learning', (req, res) => {
  try { res.json(getLearningStats(db)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BACKTEST ──────────────────────────────────────────────────────────────────────────────
app.get('/api/backtest/runs', (req, res) => {
  const instrument = (req.query.instrument || '').toUpperCase() || null;
  const limit      = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare(
    instrument
      ? 'SELECT * FROM backtest_runs WHERE instrument=? ORDER BY run_at DESC LIMIT ?'
      : 'SELECT * FROM backtest_runs ORDER BY run_at DESC LIMIT ?'
  ).all(...(instrument ? [instrument, limit] : [limit]));
  res.json(rows);
});

app.get('/api/backtest/revisions', (req, res) => {
  const instrument = (req.query.instrument || '').toUpperCase() || null;
  const limit      = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(
    instrument
      ? 'SELECT * FROM strategy_revisions WHERE instrument=? ORDER BY revised_at DESC LIMIT ?'
      : 'SELECT * FROM strategy_revisions ORDER BY revised_at DESC LIMIT ?'
  ).all(...(instrument ? [instrument, limit] : [limit]));
  res.json(rows);
});

app.get('/api/backtest/summary', (req, res) => {
  const summary = db.prepare(`
    SELECT instrument,
           COUNT(*)                                              AS total_runs,
           MAX(run_at)                                          AS last_run_at,
           ROUND(AVG(win_rate)*100, 1)                          AS avg_win_pct,
           ROUND(MAX(win_rate)*100, 1)                          AS best_win_pct,
           SUM(trades_found)                                    AS total_trades_tested,
           (SELECT COUNT(*) FROM strategy_revisions r WHERE r.instrument=b.instrument AND r.status='active') AS revisions_active
    FROM backtest_runs b
    GROUP BY instrument
  `).all();
  res.json(summary);
});

// ── BACKTEST DETAILS (per-strategy breakdown) ─────────────────────────────────
app.get('/api/backtest/details', (req, res) => {
  let runId = req.query.run_id;
  if (!runId) {
    // Return details for the latest run
    const latest = db.prepare('SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 1').get();
    if (!latest) return res.json(null);
    runId = latest.id;
  }

  const detail = db.prepare('SELECT * FROM backtest_details WHERE run_id = ?').get(runId);
  if (!detail) return res.json(null);

  const result = { ...detail };
  // Parse existing JSON columns
  try { result.by_regime   = JSON.parse(detail.regime_breakdown ?? '{}'); } catch { result.by_regime = {}; }
  try { result.by_setup    = JSON.parse(detail.setup_breakdown  ?? '{}'); } catch { result.by_setup = {}; }
  try { result.by_style    = JSON.parse(detail.style_breakdown  ?? '{}'); } catch { result.by_style = {}; }

  // Build per-strategy breakdown from actual trade records (accurate, not cached JSON)
  try {
    const stratRows = db.prepare(`
      SELECT strategy_name,
             COUNT(*)                                           AS tradeCount,
             SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)    AS wins,
             AVG(CASE WHEN outcome='WIN' THEN 1.0 ELSE 0 END)  AS winRate,
             AVG(CASE WHEN pnl_pts IS NOT NULL THEN pnl_pts ELSE 0 END) AS avgPnl
      FROM   backtest_trades
      WHERE  run_id = ? AND strategy_name IS NOT NULL
      GROUP  BY strategy_name
    `).all(runId);

    result.by_strategy = {};
    for (const r of stratRows) {
      result.by_strategy[r.strategy_name] = {
        tradeCount:   r.tradeCount,
        wins:         r.wins,
        winRate:      r.winRate != null ? +r.winRate.toFixed(4) : null,
        profitFactor: null, // computed per-strategy below
        avgPnl:       r.avgPnl != null ? +r.avgPnl.toFixed(2) : null,
      };
    }

    // Compute profit factor per strategy
    const pfRows = db.prepare(`
      SELECT strategy_name,
             SUM(CASE WHEN pnl_pts > 0 THEN pnl_pts ELSE 0 END)              AS gross_win,
             ABS(SUM(CASE WHEN pnl_pts < 0 THEN pnl_pts ELSE 0 END))         AS gross_loss
      FROM   backtest_trades
      WHERE  run_id = ? AND strategy_name IS NOT NULL AND pnl_pts IS NOT NULL
      GROUP  BY strategy_name
    `).all(runId);
    for (const r of pfRows) {
      if (result.by_strategy[r.strategy_name]) {
        result.by_strategy[r.strategy_name].profitFactor =
          r.gross_loss > 0 ? +(r.gross_win / r.gross_loss).toFixed(2) : null;
      }
    }
  } catch { result.by_strategy = {}; }

  res.json(result);
});

// ── STRATEGY PARAMS ───────────────────────────────────────────────────────────────────────
app.get('/api/strategy/params', (req, res) => {
  const rows = db.prepare('SELECT * FROM strategy_params').all();
  const result = {};
  for (const row of rows) {
    result[row.instrument] = {
      ...JSON.parse(row.params_json),
      updated_at: row.updated_at,
      version:    row.version,
    };
  }
  for (const inst of ['MNQ', 'MGC']) {
    if (!result[inst]) result[inst] = { ...getParams(db, inst), version: 0 };
  }
  res.json(result);
});

// ── MARKET MODE ───────────────────────────────────────────────────────────────────────────
app.get('/api/market/mode', (req, res) => {
  try {
    const blk = isBlackout();
    const { session, meta } = classifyNow();

    let mode = 'LIVE';
    let isWeekend = false;
    let isMaintenance = false;

    if (blk) {
      const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const dow = ptNow.getDay();
      const hm  = ptNow.getHours() * 60 + ptNow.getMinutes();
      if ((dow === 5 && hm >= 780) || dow === 6 || (dow === 0 && hm < 840)) {
        mode = 'WEEKEND_CLOSE';
        isWeekend = true;
      } else {
        mode = 'MAINTENANCE';
        isMaintenance = true;
      }
    } else if (meta && meta.minTier === 'IGNORE') {
      mode = 'OVERNIGHT';
    }

    const LABELS = {
      LIVE:          'LIVE MODE',
      MAINTENANCE:   'MAINTENANCE WINDOW',
      WEEKEND_CLOSE: 'WEEKEND CLOSE',
      OVERNIGHT:     'OVERNIGHT',
      RESEARCH:      'RESEARCH MODE',
    };

    res.json({
      mode,
      label:          LABELS[mode] ?? mode,
      session,
      isBlackout:     blk,
      isWeekend,
      isMaintenance,
      msUntilOpen:    msUntilOpen(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MARKET PRICES ─────────────────────────────────────────────────────────────────────────
app.get('/api/market/prices', (req, res) => {
  const rows = db.prepare('SELECT * FROM market_snapshots').all();
  const result = {};
  for (const row of rows) result[row.symbol] = row;
  res.json(result);
});

// ── MARKET CANDLES — last N 5m bars from scanner in-memory cache ─────────────
// Used by homepage MNQ/MGC mini-charts. Returns empty array if scanner has no data yet.
app.get('/api/market/candles/:instrument', (req, res) => {
  const inst  = (req.params.instrument ?? '').toUpperCase();
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const scanner = global._scanner;
  let bars = [];
  if (scanner?._lastGoodBars) {
    if (inst === 'MNQ') bars = scanner._lastGoodBars.mnq5m ?? [];
    else if (inst === 'MGC') bars = scanner._lastGoodBars.mgc5m ?? [];
  }
  // Return last `limit` bars with OHLCV fields only
  const out = bars.slice(-limit).map(b => ({
    t: b.timestamp,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume ?? 0,
  }));
  res.json(out);
});

// ── HISTORICAL BACKTEST — manual trigger ─────────────────────────────────────
// POST /api/backtest/historical?instrument=MNQ  →  kicks off 60-day 5m backtest
app.post('/api/backtest/historical', (req, res) => {
  const inst    = ((req.query.instrument ?? req.body?.instrument) || '').toUpperCase();
  const scanner = global._scanner;
  if (!scanner) return res.status(503).json({ error: 'Scanner not running' });
  if (!['MNQ', 'MGC', 'BOTH'].includes(inst)) {
    return res.status(400).json({ error: 'instrument must be MNQ, MGC, or BOTH' });
  }
  const run = (i) => scanner.runDeepHistoricalBacktest(i).catch(err =>
    console.error(`[api] deep historical backtest error (${i}):`, err)
  );
  if (inst === 'BOTH') { run('MNQ'); setTimeout(() => run('MGC'), 8 * 60_000); }
  else run(inst);
  res.json({ ok: true, instrument: inst, message: 'Deep historical backtest triggered' });
});

// ── JOURNAL ───────────────────────────────────────────────────────────────────────────────

app.get('/api/journal/signals', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const rows = db.prepare(`
    SELECT s.id, s.direction, s.grade, s.setup, s.entry, s.sl, s.tp1, s.score,
           s.htf_bias, s.session, s.trade_style, s.instrument, s.received_at,
           o.result, o.pnl_pts, o.notes
    FROM   signals s
    JOIN   outcomes o ON o.signal_id = s.id
    ORDER  BY s.received_at DESC
    LIMIT  ?
  `).all(limit);
  res.json(rows);
});

app.get('/api/journal/backtest', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  const inst  = req.query.instrument?.toUpperCase() || null;
  const baseSQL = `
    SELECT r.*,
           (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id AND (t.outcome='LOSS' OR t.outcome='BE')) AS loss_count,
           (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id AND t.outcome='WIN') AS win_count,
           (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id AND t.note IS NOT NULL AND t.note != '') AS noted_count
    FROM backtest_runs r
    WHERE (
      (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id) > 0
    )
    ${inst ? 'AND r.instrument = ?' : ''}
    ORDER BY r.run_at DESC LIMIT ?`;
  const rows = inst ? db.prepare(baseSQL).all(inst, limit) : db.prepare(baseSQL).all(limit);
  res.json(rows);
});

app.get('/api/journal/backtest/:runId/trades', (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) return res.status(400).json({ error: 'invalid runId' });
  const rows = db.prepare(
    'SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY bar_idx ASC'
  ).all(runId);
  res.json(rows);
});

app.post('/api/journal/signal-note', (req, res) => {
  const { signal_id, note } = req.body || {};
  if (!signal_id) return res.status(400).json({ error: 'signal_id required' });
  const outcome = db.prepare('SELECT id FROM outcomes WHERE signal_id = ?').get(signal_id);
  if (!outcome) return res.status(404).json({ error: 'Outcome not found — log WIN/LOSS/BE first' });
  db.prepare(`UPDATE outcomes SET notes = ? WHERE signal_id = ?`).run(note ?? null, signal_id);
  res.json({ ok: true });
});

app.post('/api/journal/backtest-note', (req, res) => {
  const { trade_id, note } = req.body || {};
  if (!trade_id) return res.status(400).json({ error: 'trade_id required' });
  db.prepare(`UPDATE backtest_trades SET note = ?, noted_at = datetime('now') WHERE id = ?`)
    .run(note ?? null, trade_id);
  res.json({ ok: true });
});

// ── NTFY TEST ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ntfy/test', async (req, res) => {
  if (!NTFY_TOPIC) {
    return res.status(400).json({ ok: false, error: 'NTFY_TOPIC environment variable is not set. Add it in your Render/Railway dashboard and redeploy.' });
  }

  const url     = `${NTFY_URL}/${NTFY_TOPIC}`;
  const headers = {
    'Content-Type': 'text/plain',
    'Title':    'Aurum Signals — Alert',
    'Priority': 'default',
    'Tags':     'bell',
  };
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;

  const body = `Test sent at ${new Date().toISOString()}\nURL: ${NTFY_URL}\nToken: ${NTFY_TOKEN ? 'configured' : 'not set'}`;

  try {
    const r = await fetch(url, { method: 'POST', headers, body });
    const text = await r.text().catch(() => '');
    if (r.ok) {
      res.json({ ok: true, status: r.status, url, topic: NTFY_TOPIC, tokenSet: !!NTFY_TOKEN });
    } else {
      res.status(502).json({ ok: false, status: r.status, error: text || `HTTP ${r.status}`, url, topic: NTFY_TOPIC });
    }
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message, url, topic: NTFY_TOPIC });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    const ok       = !!db.prepare('SELECT 1 n').get();
    const sigCount = db.prepare('SELECT COUNT(*) n FROM signals').get().n;
    const outCount = db.prepare('SELECT COUNT(*) n FROM outcomes').get().n;
    let entCount = 0;
    try { entCount = db.prepare('SELECT COUNT(*) n FROM journal_entries').get().n; } catch {}
    res.json({
      service:            'ok',
      database:           ok ? 'ok' : 'error',
      signals_count:      sigCount,
      outcomes_count:     outCount,
      journal_entries:    entCount,
      ntfy_configured:    !!NTFY_TOPIC,
      webhook_secret_set: !!WEBHOOK_SECRET,
      uptime_s:           Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ service: 'ok', database: 'error', error: err.message });
  }
});

// ── WEEKLY LEARNING SUMMARIES ─────────────────────────────────────────────────────────

// Returns the Monday of the ISO week that contains `date` (default: today).
function getWeekMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, … 6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function fmtWeekLabel(weekStart) {
  const d = new Date(weekStart + 'T12:00:00Z');
  return 'Week of ' + d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const STRATEGY_CONFIGS = [
  { key: 'MGC_SCALP',    label: 'MGC Scalp',         instrument: 'MGC' },
  { key: 'MGC_INTRADAY', label: 'MGC Intraday',       instrument: 'MGC' },
  { key: 'MNQ_INTRADAY', label: 'MNQ Intraday',       instrument: 'MNQ' },
  { key: 'MNQ_SWING',    label: 'MNQ Swing',          instrument: 'MNQ' },
  { key: 'MNQ_50PT',     label: 'MNQ 50-Point',       instrument: 'MNQ' },
];

function generateWeeklySummaryData(db, weekStart) {
  const weekEnd = new Date(weekStart + 'T00:00:00Z');
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  const results = [];

  for (const cfg of STRATEGY_CONFIGS) {
    // Pull all live signals for this strategy/week with outcomes
    const sigs = db.prepare(`
      SELECT s.direction, s.grade, s.session, s.htf_bias, s.score, s.trade_style,
             o.result, o.pnl_pts, o.exit_at
      FROM   signals s
      LEFT   JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.strategy_name = ?
        AND  date(s.received_at) >= ?
        AND  date(s.received_at) <  ?
      ORDER  BY s.received_at ASC
    `).all(cfg.key, weekStart, weekEndStr);

    // Pull backtest trades from runs that ran during this week
    const btTrades = db.prepare(`
      SELECT t.direction, t.outcome, t.regime, t.session, t.confidence, t.pnl_pts, t.note
      FROM   backtest_trades t
      JOIN   backtest_runs   r ON r.id = t.run_id
      WHERE  t.strategy_name = ?
        AND  date(r.run_at) >= ?
        AND  date(r.run_at) <  ?
    `).all(cfg.key, weekStart, weekEndStr);

    const allTrades = sigs.filter(s => s.result);
    const wins   = allTrades.filter(s => s.result === 'WIN').length;
    const losses = allTrades.filter(s => s.result === 'LOSS').length;
    const be     = allTrades.filter(s => s.result === 'BE').length;
    const total  = wins + losses;
    const wr     = total > 0 ? +(wins / total * 100).toFixed(1) : null;

    // ── Previous week's summary for pattern-tracking comparison ───────────────
    const prevWeekStart = new Date(weekStart + 'T00:00:00Z');
    prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);
    const prevWeekStr = prevWeekStart.toISOString().slice(0, 10);
    const prevSummary = db.prepare(
      `SELECT * FROM weekly_summaries WHERE week_start = ? AND strategy_key = ?`
    ).get(prevWeekStr, cfg.key);

    // ── Derive analytical text sections ──────────────────────────��────────────
    const sessionCounts = {};
    const htfMismatches = allTrades.filter(t => {
      if (!t.htf_bias || !t.direction) return false;
      return (t.direction === 'LONG' && t.htf_bias === 'BEAR') ||
             (t.direction === 'SHORT' && t.htf_bias === 'BULL');
    }).length;

    for (const t of allTrades) {
      const s = (t.session || 'unknown').toLowerCase();
      sessionCounts[s] = (sessionCounts[s] || 0) + 1;
    }

    const worstSession = Object.entries(sessionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1)[0]?.[0] || null;

    const btWins   = btTrades.filter(t => t.outcome === 'WIN').length;
    const btLosses = btTrades.filter(t => t.outcome === 'LOSS' || t.outcome === 'BE').length;
    const btTotal  = btWins + btLosses;
    const btWr     = btTotal > 0 ? +(btWins / btTotal * 100).toFixed(1) : null;

    const btRegimes = {};
    for (const t of btTrades) {
      const r = t.regime || 'unknown';
      if (!btRegimes[r]) btRegimes[r] = { win: 0, total: 0 };
      btRegimes[r].total++;
      if (t.outcome === 'WIN') btRegimes[r].win++;
    }
    const worstRegime = Object.entries(btRegimes)
      .filter(([, v]) => v.total >= 3)
      .sort((a, b) => (a[1].win / a[1].total) - (b[1].win / b[1].total))[0]?.[0] || null;

    // ── Performance review (structured) ─────────────────────��───────────────
    const perfLines = [
      `LIVE_SIGNALS: ${sigs.length} total | ${wins}W / ${losses}L / ${be}BE | WR=${wr != null ? wr + '%' : 'N/A (no resolved trades)'}`,
      `BACKTEST: ${btTotal} trades | WR=${btWr != null ? btWr + '%' : 'N/A'}`,
    ];
    if (wr != null) {
      if (wr >= 65) perfLines.push('ASSESSMENT: Strong week — win rate above 65%; strategy is performing at expected edge.');
      else if (wr >= 52) perfLines.push('ASSESSMENT: Acceptable week — win rate within normal range (52-65%); no immediate changes needed.');
      else if (wr >= 40) perfLines.push('ASSESSMENT: Below-average week — win rate under 52%; confidence threshold should be reviewed.');
      else perfLines.push('ASSESSMENT: Poor week — win rate under 40%; confidence threshold escalated; review trade quality.');
    } else {
      perfLines.push('ASSESSMENT: Insufficient live data this week; judgment based on backtest only.');
    }
    if (htfMismatches > 0) {
      perfLines.push(`HTF_COUNTER_TREND: ${htfMismatches} counter-trend entries taken — these carry lower expected WR (~35%); filter required.`);
    }

    const performanceReview = perfLines.join('\n');

    // ── Failure analysis ─────────────────────────────────────────────────────
    const failureLines = [];
    const lostTrades = allTrades.filter(t => t.result === 'LOSS');
    if (lostTrades.length === 0) {
      failureLines.push('NO_LOSSES: No losses recorded this week from live signals.');
    }
    if (htfMismatches > 0) {
      failureLines.push(`COUNTER_TREND_ENTRIES: ${htfMismatches} trades entered against HTF bias — primary risk factor for this week.`);
    }
    if (worstRegime === 'ranging') {
      failureLines.push('RANGING_REGIME_LOSSES: Backtest shows elevated losses in ranging conditions — continuation signals underperform in chop.');
    }
    if (worstRegime === 'volatile') {
      failureLines.push('VOLATILE_REGIME_LOSSES: High-ATR conditions caused stop-outs; SL distance was insufficient for expanded volatility.');
    }
    if (btWr != null && btWr < 45) {
      failureLines.push(`LOW_BT_WIN_RATE: Backtest WR=${btWr}% is below 45% threshold — strategy parameter revision required.`);
    }
    if (failureLines.length === 0) failureLines.push('NO_IDENTIFIED_FAILURES: Performance within acceptable bounds; no systematic failure detected.');

    const failureAnalysis = failureLines.join('\n');

    // ── Corrective actions ───────────────────────────────────────────────────
    const correctiveLines = [];
    if (wr != null && wr < 45) {
      correctiveLines.push(`RAISE_THRESHOLD: Increase minimum confidence for ${cfg.key} by 3-5 pts; current WR=${wr}% requires tighter filter.`);
    }
    if (htfMismatches > 0) {
      correctiveLines.push('ENFORCE_HTF_FILTER: Block entries where direction conflicts with HTF bias; implement hard filter in strategy logic.');
    }
    if (worstRegime === 'ranging') {
      correctiveLines.push('SKIP_CONTINUATION_IN_CHOP: Add regime check before continuation signals; require ADX >= 20 or ATR expansion confirmation.');
    }
    if (worstRegime === 'volatile') {
      correctiveLines.push('WIDEN_SL_IN_VOLATILE: Add 0.5 ATR buffer to SL when ATR > 1.5× 20-bar average; prevents noise-triggered stops.');
    }
    if (correctiveLines.length === 0) {
      correctiveLines.push('MAINTAIN_CURRENT_APPROACH: No corrective actions required; continue monitoring for 2 more weeks before changing parameters.');
    }

    const correctiveActions = correctiveLines.join('\n');

    // ── Pattern tracking — compare with prior week's summary ────────────────
    const patternLines = [];
    let priorRepeats = 0;
    let escalated = 0;

    if (prevSummary) {
      const prevFailures = (prevSummary.failure_analysis || '').split('\n').filter(Boolean);
      const currentFailureKeys = new Set(failureLines.map(l => l.split(':')[0]));

      for (const prevLine of prevFailures) {
        const key = prevLine.split(':')[0];
        if (key !== 'NO_IDENTIFIED_FAILURES' && currentFailureKeys.has(key)) {
          priorRepeats++;
          patternLines.push(`REPEAT_ERROR [${key}]: Same mistake identified for 2nd consecutive week — escalating corrective action required.`);
          escalated = 1;
        }
      }

      // Check if prior week also had escalation
      if (prevSummary.escalated && escalated) {
        patternLines.push(`PERSISTENT_ERROR: This mistake has persisted 3+ weeks — mandatory strategy parameter override recommended; do not wait for optimizer.`);
      }

      const prevWr = prevSummary.win_rate;
      if (prevWr != null && wr != null) {
        const trend = wr - prevWr;
        if (trend >= 10) patternLines.push(`WR_IMPROVING: Win rate improved +${trend.toFixed(1)}pp week-over-week — prior corrective actions appear effective.`);
        else if (trend <= -10) patternLines.push(`WR_DECLINING: Win rate dropped ${Math.abs(trend).toFixed(1)}pp week-over-week — investigate if prior corrections were applied.`);
        else patternLines.push(`WR_STABLE: Win rate change ${trend >= 0 ? '+' : ''}${trend.toFixed(1)}pp — stable performance, continue monitoring.`);
      }
    } else {
      patternLines.push('FIRST_WEEK: No prior week data available for pattern comparison.');
    }

    if (patternLines.length === 0) patternLines.push('NO_REPEAT_PATTERNS: No recurring mistakes detected from prior week.');

    const patternTracking = patternLines.join('\n');

    // ── Raw signal compact log for machine re-analysis ───────────────────────
    const rawLog = allTrades.slice(0, 50).map(t => ({
      dir: t.direction,
      res: t.result,
      htf: t.htf_bias,
      sess: t.session,
      score: t.score,
      pnl: t.pnl_pts,
    }));

    results.push({
      week_start:          weekStart,
      week_label:          fmtWeekLabel(weekStart),
      strategy_key:        cfg.key,
      strategy_label:      cfg.label,
      total_signals:       sigs.length,
      wins,
      losses,
      breakevens:          be,
      win_rate:            wr,
      performance_review:  performanceReview,
      failure_analysis:    failureAnalysis,
      corrective_actions:  correctiveActions,
      pattern_tracking:    patternTracking,
      prior_repeats:       priorRepeats,
      escalated,
      raw_signals_json:    JSON.stringify(rawLog),
    });
  }

  return results;
}

// GET all weekly summaries (paginated, latest first)
app.get('/api/weekly-summary', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows  = db.prepare(
      'SELECT * FROM weekly_summaries ORDER BY week_start DESC, strategy_key ASC LIMIT ?'
    ).all(limit);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET summaries for a specific week
app.get('/api/weekly-summary/:weekStart', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM weekly_summaries WHERE week_start = ? ORDER BY strategy_key ASC'
    ).all(req.params.weekStart);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — generate (or regenerate) the current week's summaries
app.post('/api/weekly-summary/generate', (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized — check DB_PATH env var');
    const weekStart = req.body?.week_start || getWeekMonday();
    const summaries = generateWeeklySummaryData(db, weekStart);

    const upsert = db.prepare(`
      INSERT INTO weekly_summaries
        (week_start, week_label, strategy_key, strategy_label, total_signals,
         wins, losses, breakevens, win_rate, performance_review, failure_analysis,
         corrective_actions, pattern_tracking, prior_repeats, escalated, raw_signals_json, generated_at)
      VALUES
        (@week_start, @week_label, @strategy_key, @strategy_label, @total_signals,
         @wins, @losses, @breakevens, @win_rate, @performance_review, @failure_analysis,
         @corrective_actions, @pattern_tracking, @prior_repeats, @escalated, @raw_signals_json, datetime('now'))
      ON CONFLICT(week_start, strategy_key) DO UPDATE SET
        week_label         = excluded.week_label,
        strategy_label     = excluded.strategy_label,
        total_signals      = excluded.total_signals,
        wins               = excluded.wins,
        losses             = excluded.losses,
        breakevens         = excluded.breakevens,
        win_rate           = excluded.win_rate,
        performance_review = excluded.performance_review,
        failure_analysis   = excluded.failure_analysis,
        corrective_actions = excluded.corrective_actions,
        pattern_tracking   = excluded.pattern_tracking,
        prior_repeats      = excluded.prior_repeats,
        escalated          = excluded.escalated,
        raw_signals_json   = excluded.raw_signals_json,
        generated_at       = datetime('now')
    `);

    db.transaction(() => {
      for (const s of summaries) upsert.run(s);
    })();

    res.json({ ok: true, week_start: weekStart, week_label: fmtWeekLabel(weekStart), count: summaries.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── JOURNAL ENTRIES (free-form composer) ──────────────────────────────────────────────
app.get('/api/journal/entries', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.prepare(
      'SELECT * FROM journal_entries ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    res.json(rows);
  } catch { res.json([]); }
});

app.post('/api/journal/entries', (req, res) => {
  const { entry_type, body, tags } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: 'body required' });
  try {
    const info = db.prepare(
      'INSERT INTO journal_entries (entry_type, body, tags) VALUES (?, ?, ?)'
    ).run(entry_type || 'observation', body.trim(), tags || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/journal/entries/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BACKTEST TRADES ───────────────────────────────────────────────────────────────────────
app.get('/api/backtest/trades/:runId', (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) return res.status(400).json({ error: 'invalid runId' });
  const rows = db.prepare(
    'SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY bar_idx ASC'
  ).all(runId);
  res.json(rows);
});

// ── DIAGNOSTICS ───────────────────────────────────────────────────────────────────────────
// Last N scan diagnostic snapshots — explains what each scan saw and why signals did/didn't fire
app.get('/api/diagnostics', (req, res) => {
  const instrument = (req.query.instrument || '').toUpperCase() || null;
  const limit      = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const rows = instrument
      ? db.prepare('SELECT * FROM scan_diagnostics WHERE instrument=? ORDER BY scanned_at DESC LIMIT ?').all(instrument, limit)
      : db.prepare('SELECT * FROM scan_diagnostics ORDER BY scanned_at DESC LIMIT ?').all(limit);
    // Parse JSON columns before sending
    res.json(rows.map(r => ({
      ...r,
      indicators:      r.indicators      ? JSON.parse(r.indicators)      : null,
      strategies_fired: r.strategies_fired ? JSON.parse(r.strategies_fired) : [],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Summary counts for the diagnostics view
app.get('/api/diagnostics/summary', (req, res) => {
  try {
    const instrument = (req.query.instrument || '').toUpperCase() || null;
    const hours      = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
    const cutoff     = new Date(Date.now() - hours * 3600_000).toISOString();

    if (instrument) {
      const total      = db.prepare('SELECT COUNT(*) n FROM scan_diagnostics WHERE instrument=? AND scanned_at>=?').get(instrument, cutoff).n;
      const fired      = db.prepare('SELECT COUNT(*) n FROM scan_diagnostics WHERE instrument=? AND scanned_at>=? AND fired=1').get(instrument, cutoff).n;
      const byInst     = db.prepare('SELECT instrument, COUNT(*) total, SUM(fired) fired FROM scan_diagnostics WHERE instrument=? AND scanned_at>=? GROUP BY instrument').all(instrument, cutoff);
      const topReasons = db.prepare('SELECT reject_reason, COUNT(*) n FROM scan_diagnostics WHERE instrument=? AND scanned_at>=? AND reject_reason IS NOT NULL GROUP BY reject_reason ORDER BY n DESC LIMIT 10').all(instrument, cutoff);
      res.json({ total, fired, missRate: total > 0 ? +((1 - fired/total)*100).toFixed(1) : 0, byInst, topReasons });
    } else {
      const total      = db.prepare('SELECT COUNT(*) n FROM scan_diagnostics WHERE scanned_at>=?').get(cutoff).n;
      const fired      = db.prepare('SELECT COUNT(*) n FROM scan_diagnostics WHERE scanned_at>=? AND fired=1').get(cutoff).n;
      const byInst     = db.prepare('SELECT instrument, COUNT(*) total, SUM(fired) fired FROM scan_diagnostics WHERE scanned_at>=? GROUP BY instrument').all(cutoff);
      const topReasons = db.prepare('SELECT reject_reason, COUNT(*) n FROM scan_diagnostics WHERE scanned_at>=? AND reject_reason IS NOT NULL GROUP BY reject_reason ORDER BY n DESC LIMIT 10').all(cutoff);
      res.json({ total, fired, missRate: total > 0 ? +((1 - fired/total)*100).toFixed(1) : 0, byInst, topReasons });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REJECTIONS ────────────────────────────────────────────────────────────────────────────
// Every signal that almost fired but was blocked by a filter
app.get('/api/rejections', (req, res) => {
  const instrument = (req.query.instrument || '').toUpperCase() || null;
  const limit      = Math.min(Number(req.query.limit) || 100, 500);
  const strategy   = req.query.strategy || null;
  try {
    let sql = 'SELECT * FROM signal_rejections';
    const args = [];
    const where = [];
    if (instrument) { where.push('instrument=?'); args.push(instrument); }
    if (strategy)   { where.push('strategy=?');   args.push(strategy); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY rejected_at DESC LIMIT ?';
    args.push(limit);
    const rows = db.prepare(sql).all(...args);
    res.json(rows.map(r => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STRATEGY PERFORMANCE ──────────────────────────────────────────────────────────────────
// Per-strategy signal counts, win rates, and recent history
app.get('/api/strategies/performance', (req, res) => {
  try {
    const period = req.query.days ? `datetime('now','-${Number(req.query.days)} days')` : `datetime('now','-30 days')`;
    const byStrategy = db.prepare(`
      SELECT s.setup                                                             AS strategy,
             COUNT(*)                                                            AS total,
             SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)                  AS wins,
             SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END)                  AS losses,
             ROUND(AVG(CASE WHEN o.result='WIN' THEN 1.0 ELSE 0 END)*100, 1)   AS win_pct,
             ROUND(AVG(CASE WHEN o.result IS NOT NULL THEN s.score ELSE NULL END),1) AS avg_score
      FROM   signals s
      LEFT   JOIN outcomes o ON o.signal_id = s.id
      WHERE  s.received_at >= ${period}
      GROUP  BY s.setup
      ORDER  BY total DESC
    `).all();

    const rejectionsByStrategy = db.prepare(`
      SELECT strategy, COUNT(*) n, ROUND(AVG(score),1) avg_score
      FROM   signal_rejections
      WHERE  rejected_at >= ${period}
      GROUP  BY strategy
      ORDER  BY n DESC
    `).all();

    const totalSignals   = db.prepare(`SELECT COUNT(*) n FROM signals WHERE received_at >= ${period}`).get().n;
    const totalRejected  = db.prepare(`SELECT COUNT(*) n FROM signal_rejections WHERE rejected_at >= ${period}`).get().n;

    res.json({ byStrategy, rejectionsByStrategy, totalSignals, totalRejected });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── NEWS ──────────────────────────────────────────────────────────────────────────────────
app.get('/api/news', (req, res) => {
  try {
    const limit    = Math.min(Number(req.query.limit) || 60, 200);
    const category = (req.query.category || '').toUpperCase();
    let sql  = 'SELECT * FROM news_items';
    const args = [];
    if (category && category !== 'ALL') {
      sql += ' WHERE category = ?';
      args.push(category);
    }
    sql += ' ORDER BY fetched_at DESC, id DESC LIMIT ?';
    args.push(limit);
    const items = db.prepare(sql).all(...args);
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SCANNER HEARTBEAT ─────────────────────────────────────────────────────────────────────
app.get('/api/scanner/heartbeat', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scanner_heartbeat WHERE id = 1').get();
    if (!row) return res.json({ online: false, lastScan: null, scanCount: 0, ageMs: null });
    const lastMs = new Date(row.last_scan.replace(' ', 'T') + 'Z').getTime();
    const ageMs  = Date.now() - lastMs;
    res.json({ online: ageMs < 120_000, lastScan: row.last_scan, scanCount: row.scan_count, ageMs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SERVER-SENT EVENTS — real-time scanner feed ───────────────────────────────────────────
// Clients subscribe to /api/scanner/stream and receive scanner events without polling.
const _sseClients = new Set();

app.get('/api/scanner/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send initial heartbeat so client knows it's connected
  res.write('event: connected\ndata: {"connected":true}\n\n');

  // Keep-alive ping every 25 s (prevents proxy/load-balancer timeouts)
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { cleanup(); } }, 25_000);

  function cleanup() {
    clearInterval(ping);
    _sseClients.delete(res);
  }

  _sseClients.add(res);
  req.on('close', cleanup);
});

function _broadcastSSE(event, data) {
  if (!_sseClients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _sseClients) {
    try { client.write(payload); } catch { _sseClients.delete(client); }
  }
}

// ── PERFORMANCE INTELLIGENCE APIs ─────────────────────────────────────────────────────────

// Live vs backtest divergence analysis
app.get('/api/performance/divergence', (req, res) => {
  try {
    res.json(analyzeDivergence(db));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mid-week intelligence report (auto-generated or forced via ?force=1)
app.get('/api/performance/midweek-report', (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!force) {
      const weekStart = (() => {
        const d = new Date(); const diff = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
        d.setUTCDate(d.getUTCDate() + diff); return d.toISOString().slice(0, 10);
      })();
      const cached = loadReport(db, 'MIDWEEK', weekStart);
      if (cached) return res.json(cached);
    }
    res.json(generateMidWeekReport(db));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Weekly deep strategy intelligence report
app.get('/api/performance/weekly-deep', (req, res) => {
  try {
    if (!db) throw new Error('Database not initialized — check DB_PATH env var');
    const weekStart = req.query.week || null;
    const force     = req.query.force === '1' || req.query.force === 'true';
    if (!force && weekStart) {
      try {
        const cached = loadReport(db, 'WEEKLY', weekStart);
        if (cached) return res.json(cached);
      } catch (cacheErr) {
        console.error('[weekly-deep] cache load failed:', cacheErr.message);
      }
    }
    const report = generateWeeklyDeepReport(db, weekStart);
    res.json(report);
  } catch (err) {
    console.error('[weekly-deep] ERROR:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Cumulative performance intelligence for one instrument
app.get('/api/performance/intelligence/:instrument', (req, res) => {
  try {
    const instrument = (req.params.instrument || 'MNQ').toUpperCase();
    res.json(getPerformanceIntelligence(db, instrument));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Instrument behavior profile (session/direction/hour biases)
app.get('/api/performance/behavior/:instrument', (req, res) => {
  try {
    const instrument = (req.params.instrument || 'MNQ').toUpperCase();
    res.json(getInstrumentBehaviorProfile(db, instrument));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edge degradation status for both instruments
app.get('/api/performance/edge-health', (req, res) => {
  try {
    res.json({
      MNQ: detectEdgeDegradation(db, 'MNQ'),
      MGC: detectEdgeDegradation(db, 'MGC'),
      generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REPORT SCHEDULER ENDPOINTS ───────────────────────────────────────────────────────────

// List all generated reports (history log)
app.get('/api/reports/list', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '50'), 200);
    const reports = listReports(db, limit);
    res.json({ reports, count: reports.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Report scheduler status (last run, next scheduled, enabled)
app.get('/api/reports/schedule', (req, res) => {
  try {
    const schedules = getReportScheduleStatus(db);
    const now = new Date().toISOString();
    res.json({ schedules, checked_at: now });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get a specific report by ID
app.get('/api/reports/:reportId', (req, res) => {
  try {
    const row = db.prepare(
      'SELECT * FROM reports WHERE report_id = ?'
    ).get(req.params.reportId);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    const report = { ...row };
    for (const f of ['metrics_json', 'strategy_json', 'backtest_json', 'recommendations_json', 'version_changes', 'failure_analysis']) {
      if (report[f]) try { report[f.replace('_json', '')] = JSON.parse(report[f]); } catch {}
    }
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Force-generate a report immediately (manual refresh)
app.post('/api/reports/generate', (req, res) => {
  try {
    const type = (req.body?.type ?? 'MID_WEEK').toUpperCase();
    let report;
    if (type === 'WEEKLY_DEEP_DIVE' || type === 'WEEKLY') {
      const weekStart = req.body?.week_start ?? null;
      report = generateWeeklyDeepReport(db, weekStart);
    } else {
      report = generateMidWeekReport(db);
    }
    res.json({ status: 'generated', report_type: type, report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OPENING CANDLE ENDPOINTS ──────────────────────────────────────────────────────────────

// Full opening candle statistics (session accuracy, today's candles) per instrument
app.get('/api/opening-candle/report/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    res.json(getOpeningCandleReport(db, instrument));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Current session bias for an instrument (live signal filter context)
app.get('/api/opening-candle/bias/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    const ts         = req.query.ts ?? new Date().toISOString();
    const bias       = getSessionOpenBias(db, instrument, ts);
    res.json({ instrument, bias, generated_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Combined opening candle overview for all instruments
app.get('/api/opening-candle/status', (req, res) => {
  try {
    res.json({
      MNQ: getOpeningCandleReport(db, 'MNQ'),
      MGC: getOpeningCandleReport(db, 'MGC'),
      generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DNA ENDPOINTS ─────────────────────────────────────────────────────────────────────────

// Plain-language DNA insights for an instrument
app.get('/api/dna/insights/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    res.json(getDNAInsights(db, instrument));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DNA optimizer guidance (best sessions, regime hints, threshold hints)
app.get('/api/dna/guidance/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    const dna = loadDNA(db, instrument);
    if (!dna) return res.json({ instrument, guidance: null, message: 'No DNA data yet — run a backtest cycle first' });
    res.json({ instrument, guidance: getDNAGuidance(dna, instrument), dnaVersion: dna.version });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raw DNA data snapshot for an instrument
app.get('/api/dna/snapshot/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    const dna = loadDNA(db, instrument);
    if (!dna) return res.json({ instrument, dna: null, message: 'No DNA data yet' });
    res.json({
      instrument,
      version:      dna.version,
      totalTrades:  dna.totalTrades,
      topCombos:    dna.topCombos?.slice(0, 10) ?? [],
      weakCombos:   dna.weakCombos?.slice(0, 5) ?? [],
      strongWindows: dna.strongWindows?.slice(0, 5) ?? [],
      weakWindows:  dna.weakWindows?.slice(0, 5) ?? [],
      lastUpdated:  dna.lastUpdated,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── EVOLUTION ENDPOINTS ───────────────────────────────────────────────────────────────────

// Evolution history for an instrument
app.get('/api/evolution/history/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    const limit      = parseInt(req.query.limit) || 50;
    const type       = req.query.type || null;
    res.json(getEvolutionHistory(db, instrument, limit, type));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Current variant pool status
app.get('/api/evolution/variants/:instrument', (req, res) => {
  try {
    const instrument = req.params.instrument.toUpperCase();
    res.json(getVariantPoolStatus(db, instrument));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Combined evolution + DNA status for both instruments
app.get('/api/evolution/status', (req, res) => {
  try {
    res.json({
      MNQ: {
        variants: getVariantPoolStatus(db, 'MNQ'),
        dna:      getDNAInsights(db, 'MNQ'),
      },
      MGC: {
        variants: getVariantPoolStatus(db, 'MGC'),
        dna:      getDNAInsights(db, 'MGC'),
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTH + SUBSCRIPTION SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

const SESSION_COOKIE = 'aurum_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(c => {
    const eq = c.indexOf('=');
    if (eq < 0) return;
    try { out[c.slice(0, eq).trim()] = decodeURIComponent(c.slice(eq + 1).trim()); } catch {}
  });
  return out;
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(32).toString('hex');
  const key  = await new Promise((res, rej) =>
    crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
  return `scrypt:${salt}:${key}`;
}

async function verifyPassword(pw, stored) {
  const parts = (stored || '').split(':');
  if (parts[0] !== 'scrypt' || parts.length !== 3) return false;
  const [, salt, hash] = parts;
  try {
    const derived = await new Promise((res, rej) =>
      crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const exp = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO user_sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, exp);
  try { db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(Date.now()); } catch {}
  return { id, expiresAt: exp };
}

function getSessionUser(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  try {
    const row = db.prepare(`
      SELECT s.user_id AS id, u.email, u.name, u.plan,
             u.subscription_status, u.subscription_period_end
      FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?
    `).get(sid, Date.now());
    if (!row) return null;
    const subOk = row.subscription_status === 'active' || row.subscription_status === 'trialing' ||
                  (row.subscription_period_end && row.subscription_period_end > Date.now());
    return { ...row,
      isPro:   (row.plan === 'pro'   || row.plan === 'elite') && subOk,
      isElite: (row.plan === 'elite') && subOk,
    };
  } catch { return null; }
}

function setSessionCookie(res, id, expiresAt) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function requirePro(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });
  if (!user.isPro) return res.status(403).json({ error: 'Pro subscription required', code: 'UPGRADE_REQUIRED', upgrade_url: '/pricing' });
  req.user = user;
  next();
}

// ── Apply paywall to sensitive endpoints ──────────────────────────────────────
// Free users get limited signal list (no entry/SL/TP details — blurred in UI)
// requirePro guards analytics-heavy endpoints entirely

// Wrap the existing /api/signals to support free preview (partial data)
// (The endpoint itself remains; the frontend blurs details for non-subscribers)

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()))
      return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await hashPassword(password);
    const info = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').run(
      email.toLowerCase(), hash, (name || '').trim() || null);
    db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(info.lastInsertRowid);
    const { id: sid, expiresAt } = createSession(info.lastInsertRowid);
    setSessionCookie(res, sid, expiresAt);
    res.json({ ok: true, user: { id: info.lastInsertRowid, email: email.toLowerCase(), name: name || null, plan: 'free' } });
  } catch (err) {
    console.error('[auth/register]', err.message);
    res.status(500).json({ error: 'Registration failed — please try again' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user || !await verifyPassword(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    const { id: sid, expiresAt } = createSession(user.id);
    setSessionCookie(res, sid, expiresAt);
    db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Login failed — please try again' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sid) try { db.prepare('DELETE FROM user_sessions WHERE id = ?').run(sid); } catch {}
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { id: user.id, email: user.email, name: user.name,
    plan: user.plan, isPro: user.isPro, isElite: user.isElite,
    subscriptionStatus: user.subscription_status } });
});

// ── Password Reset ───────────────────────────────────────────────────────────
// Modular design: swap sendResetEmail() for real SMTP later without touching routes.

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

async function sendResetEmail(email, token) {
  const link = `${SITE_URL}/reset-password?token=${token}`;
  // If SMTP is configured, plug in nodemailer here.
  // For now, log the link so admins can share it manually during development.
  console.log(`[auth/forgot-password] Reset link for ${email}: ${link}`);
}

app.post('/api/auth/forgot-password', async (req, res) => {
  // Always return 200 regardless of whether email exists — prevents enumeration.
  try {
    const { email } = req.body || {};
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email.toLowerCase());
    if (user) {
      // Invalidate existing tokens for this user
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      const token = crypto.randomBytes(32).toString('hex');
      const exp   = Date.now() + RESET_TTL_MS;
      db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, exp);
      await sendResetEmail(user.email, token);
    }
    res.json({ ok: true, message: 'If that email is registered you will receive a reset link.' });
  } catch (err) {
    console.error('[auth/forgot-password]', err.message);
    res.status(500).json({ error: 'Request failed — please try again' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const row = db.prepare(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?'
    ).get(token, Date.now());
    if (!row) return res.status(400).json({ error: 'Reset link is invalid or has expired. Please request a new one.' });

    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
    // Mark token used and invalidate all sessions for security
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(row.user_id);

    res.json({ ok: true, message: 'Password updated. Please sign in.' });
  } catch (err) {
    console.error('[auth/reset-password]', err.message);
    res.status(500).json({ error: 'Reset failed — please try again' });
  }
});

app.get('/api/auth/verify-reset-token', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });
  const row = db.prepare(
    'SELECT id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?'
  ).get(token, Date.now());
  res.json({ valid: !!row });
});

// ── Stripe Billing ────────────────────────────────────────────────────────────

const STRIPE_SECRET    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WSECRET   = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_ID_PRO;
const STRIPE_PRICE_ELT = process.env.STRIPE_PRICE_ID_ELITE;
const APP_URL          = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

let stripe = null;
if (STRIPE_SECRET) {
  try { stripe = require('stripe')(STRIPE_SECRET); console.log('[stripe] Billing initialized'); }
  catch { console.warn('[stripe] stripe package missing — run npm install'); }
} else { console.warn('[stripe] STRIPE_SECRET_KEY not set — billing disabled'); }

app.post('/api/stripe/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const plan    = (req.body?.plan || 'pro').toLowerCase();
  const priceId = plan === 'elite' ? STRIPE_PRICE_ELT : STRIPE_PRICE_PRO;
  if (!priceId) return res.status(503).json({ error: `STRIPE_PRICE_ID_${plan.toUpperCase()} not configured` });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: String(user.id),
      success_url: `${APP_URL}/?subscribed=1`,
      cancel_url:  `${APP_URL}/pricing`,
      metadata: { user_id: String(user.id), plan },
    });
    res.json({ url: session.url });
  } catch (err) { console.error('[stripe/checkout]', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/stripe/portal', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const dbUser = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(user.id);
  if (!dbUser?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found. Subscribe first.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: dbUser.stripe_customer_id, return_url: `${APP_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) { console.error('[stripe/portal]', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/subscription/status', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  const dbUser = db.prepare('SELECT plan, subscription_status, subscription_period_end FROM users WHERE id = ?').get(user.id);
  res.json({ plan: dbUser.plan, status: dbUser.subscription_status,
    periodEnd: dbUser.subscription_period_end, isPro: user.isPro, isElite: user.isElite });
});

app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe || !STRIPE_WSECRET) return res.status(503).send('Billing not configured');
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WSECRET); }
  catch (err) { console.error('[webhook] Bad signature:', err.message); return res.status(400).send('Invalid signature'); }

  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const userId = Number(obj.client_reference_id || obj.metadata?.user_id);
      const plan   = obj.metadata?.plan || 'pro';
      if (userId && obj.customer && obj.subscription) {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        db.prepare(`UPDATE users SET stripe_customer_id=?,stripe_subscription_id=?,plan=?,
          subscription_status=?,subscription_period_end=? WHERE id=?`
        ).run(obj.customer, obj.subscription, plan, sub.status, sub.current_period_end * 1000, userId);
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const dbUser = db.prepare('SELECT id,plan FROM users WHERE stripe_subscription_id=?').get(obj.id);
      if (dbUser) {
        const newPlan = event.type === 'customer.subscription.deleted' ? 'free' : dbUser.plan;
        db.prepare(`UPDATE users SET plan=?,subscription_status=?,subscription_period_end=? WHERE id=?`
        ).run(newPlan, obj.status, obj.current_period_end * 1000, dbUser.id);
      }
    } else if (event.type === 'invoice.payment_failed') {
      const dbUser = db.prepare('SELECT id FROM users WHERE stripe_customer_id=?').get(obj.customer);
      if (dbUser) db.prepare('UPDATE users SET subscription_status=? WHERE id=?').run('past_due', dbUser.id);
    }
  } catch (err) { console.error('[webhook] Processing error:', err.message); }
  res.json({ received: true });
});

// ── STATIC ────────────────────────────────────────────────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/landing',  (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/pricing',  (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));
app.get('/login',    (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/signals',  (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/trades',   (req, res) => res.sendFile(path.join(__dirname, 'trades.html')));
app.get('/stats',    (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));
app.get('/calendar', (req, res) => res.sendFile(path.join(__dirname, 'calendar.html')));
app.get('/backtest', (req, res) => res.sendFile(path.join(__dirname, 'backtest-dashboard.html')));
app.get('/journal',  (req, res) => res.sendFile(path.join(__dirname, 'journal.html')));
app.get('/reports',  (req, res) => res.sendFile(path.join(__dirname, 'reports.html')));
app.get('/news',     (req, res) => res.sendFile(path.join(__dirname, 'news.html')));
app.get('/setup',           (req, res) => res.sendFile(path.join(__dirname, 'setup.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'forgot-password.html')));
app.get('/reset-password',  (req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));

// ── START SERVER + SCANNER ────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aurum Signals → http://localhost:${PORT}`);
  console.log(`SQLite            →  ${DB_PATH}`);

  // Start scanner in-process so the scanner is ALWAYS running when the server is running.
  // This eliminates the separate worker service and the "scanner not responding" issue.
  const scanner = new Scanner(db);
  global._scanner = scanner;  // expose to /api/status

  scanner.on('signal',    data => _broadcastSSE('signal',    data));
  scanner.on('scan',      data => _broadcastSSE('scan',      data));
  scanner.on('heartbeat', data => _broadcastSSE('heartbeat', data));
  scanner.on('backtest',  data => _broadcastSSE('backtest',  data));
  scanner.on('outcome',   data => _broadcastSSE('outcome',   data));
  scanner.on('error',     data => _broadcastSSE('scannerError', data));

  scanner.start();

  // Graceful shutdown — flush DB and stop scanner
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      console.log(`[${new Date().toISOString()}] Shutting down gracefully…`);
      scanner.stop();
      process.exit(0);
    });
  }
});
