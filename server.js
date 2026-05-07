'use strict';
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { getLearningStats } = require('./learning');
const { getParams }        = require('./strategy-params');

const PORT           = process.env.PORT           || 3000;
const DB_PATH        = process.env.DB_PATH        || path.join(__dirname, 'signals.db');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const NTFY_URL       = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC     = process.env.NTFY_TOPIC || '';
const NTFY_TOKEN     = process.env.NTFY_TOKEN || '';

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(__dirname));

// ── DATABASE ─────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

// ── Safe column migrations for existing databases ─────────────────────────────
function applyMigrations() {
  const cols = db.prepare("PRAGMA table_info(signals)").all().map(r => r.name);
  if (!cols.includes('strategy_name')) {
    db.exec("ALTER TABLE signals ADD COLUMN strategy_name TEXT");
    console.log('[migration] Added strategy_name to signals');
  }
  const btCols = db.prepare("PRAGMA table_info(backtest_trades)").all().map(r => r.name);
  if (!btCols.includes('strategy_name')) {
    db.exec("ALTER TABLE backtest_trades ADD COLUMN strategy_name TEXT");
    console.log('[migration] Added strategy_name to backtest_trades');
  }
  if (!btCols.includes('confidence')) {
    db.exec("ALTER TABLE backtest_trades ADD COLUMN confidence INTEGER");
    console.log('[migration] Added confidence to backtest_trades');
  }
}
applyMigrations();

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, strategy_name, entry, sl, tp1, tp2, tp3,
     score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session,
     trade_style, instrument, rr, raw_payload)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @strategy_name, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session,
     @trade_style, @instrument, @rr, @raw_payload)
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
    'Title':    `${arrow} ${s.direction} ${s.grade}  •  ${s.ticker}`,
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
    SELECT s.*, o.result, o.exit_price, o.pnl_pts, o.pnl_usd
    FROM   signals s
    LEFT   JOIN outcomes o ON o.signal_id = s.id
    ORDER  BY s.received_at DESC
    LIMIT  ?
  `).all(limit);
  res.json(rows);
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
  const runId = req.query.run_id;
  if (!runId) {
    // Return details for the latest run
    const latest = db.prepare('SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 1').get();
    if (!latest) return res.json(null);
    req.query.run_id = latest.id;
    return res.redirect(`/api/backtest/details?run_id=${latest.id}`);
  }

  const detail = db.prepare('SELECT * FROM backtest_details WHERE run_id = ?').get(runId);
  if (!detail) return res.json(null);

  const result = { ...detail };
  // Parse per-strategy breakdown stored in style_breakdown JSON
  try { result.by_strategy = JSON.parse(detail.style_breakdown ?? '{}'); } catch { result.by_strategy = {}; }
  try { result.by_regime   = JSON.parse(detail.regime_breakdown ?? '{}'); } catch { result.by_regime = {}; }
  try { result.by_setup    = JSON.parse(detail.setup_breakdown  ?? '{}'); } catch { result.by_setup = {}; }
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

// ── MARKET PRICES ─────────────────────────────────────────────────────────────────────────
app.get('/api/market/prices', (req, res) => {
  const rows = db.prepare('SELECT * FROM market_snapshots').all();
  const result = {};
  for (const row of rows) result[row.symbol] = row;
  res.json(result);
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
  const sql   = inst
    ? `SELECT r.*,
              (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id) AS loss_count,
              (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id AND t.note IS NOT NULL AND t.note != '') AS noted_count
       FROM backtest_runs r WHERE r.instrument = ? ORDER BY r.run_at DESC LIMIT ?`
    : `SELECT r.*,
              (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id) AS loss_count,
              (SELECT COUNT(*) FROM backtest_trades t WHERE t.run_id = r.id AND t.note IS NOT NULL AND t.note != '') AS noted_count
       FROM backtest_runs r ORDER BY r.run_at DESC LIMIT ?`;
  const rows = inst ? db.prepare(sql).all(inst, limit) : db.prepare(sql).all(limit);
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
      ntfy_url:           NTFY_URL,
      ntfy_topic:         NTFY_TOPIC || null,
      uptime_s:           Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ service: 'ok', database: 'error', error: err.message });
  }
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
    const hours      = Number(req.query.hours) || 24;
    const since      = `datetime('now', '-${hours} hours')`;
    const base = instrument
      ? `FROM scan_diagnostics WHERE instrument='${instrument}' AND scanned_at >= ${since}`
      : `FROM scan_diagnostics WHERE scanned_at >= ${since}`;
    const total    = db.prepare(`SELECT COUNT(*) n ${base}`).get().n;
    const fired    = db.prepare(`SELECT COUNT(*) n ${base} AND fired=1`).get().n;
    const byInst   = db.prepare(`SELECT instrument, COUNT(*) total, SUM(fired) fired ${base} GROUP BY instrument`).all();
    const topReasons = db.prepare(`
      SELECT reject_reason, COUNT(*) n ${base} AND reject_reason IS NOT NULL
      GROUP BY reject_reason ORDER BY n DESC LIMIT 10
    `).all();
    res.json({ total, fired, missRate: total > 0 ? +((1 - fired/total)*100).toFixed(1) : 0, byInst, topReasons });
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
    // SQLite stores datetime('now') in UTC without trailing Z — parse accordingly
    const lastMs = new Date(row.last_scan.replace(' ', 'T') + 'Z').getTime();
    const ageMs  = Date.now() - lastMs;
    res.json({ online: ageMs < 120_000, lastScan: row.last_scan, scanCount: row.scan_count, ageMs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATIC ────────────────────────────────────────────────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/signals',  (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/trades',   (req, res) => res.sendFile(path.join(__dirname, 'trades.html')));
app.get('/stats',    (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));
app.get('/calendar', (req, res) => res.sendFile(path.join(__dirname, 'calendar.html')));
app.get('/backtest', (req, res) => res.sendFile(path.join(__dirname, 'backtest-dashboard.html')));
app.get('/journal',  (req, res) => res.sendFile(path.join(__dirname, 'journal.html')));
app.get('/news',     (req, res) => res.sendFile(path.join(__dirname, 'news.html')));
app.get('/setup',    (req, res) => res.sendFile(path.join(__dirname, 'setup.html')));

app.listen(PORT, () => {
  console.log(`NQ Signal Pro V3  →  http://localhost:${PORT}`);
  console.log(`SQLite            →  ${DB_PATH}`);
});
