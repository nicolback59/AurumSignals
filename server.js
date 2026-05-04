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

// ── DATABASE ─────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(schema);

const insertSignal = db.prepare(`
  INSERT INTO signals
    (ticker, timeframe, direction, grade, setup, entry, sl, tp1, tp2, tp3,
     score, win_prob_tp1, win_prob_tp2, win_prob_tp3, htf_bias, session, raw_payload)
  VALUES
    (@ticker, @timeframe, @direction, @grade, @setup, @entry, @sl, @tp1, @tp2, @tp3,
     @score, @win_prob_tp1, @win_prob_tp2, @win_prob_tp3, @htf_bias, @session, @raw_payload)
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

// ── NTFY ─────────────────────────────────────────────────────────────────────
function sendNtfy(s) {
  if (!NTFY_TOPIC) return;

  const arrow    = s.direction === 'LONG' ? '▲' : '▼';
  const priority = s.grade === 'A+' ? 'urgent' : 'high';
  const tags     = s.direction === 'LONG' ? 'chart_increasing,green_circle' : 'chart_decreasing,red_circle';

const priority = s.grade === 'A+' ? 'urgent' : 'high';

const body = [
  `Signal: ${s.direction} ${s.grade} ${s.ticker}`,
  s.setup   ? `Setup: ${s.setup}` : null,
  s.entry != null ? `Entry: ${s.entry}` : null,
  s.sl    != null ? `SL: ${s.sl}` : null,
  s.tp1   != null ? `TP1: ${s.tp1}` : null,
  s.tp2   != null ? `TP2: ${s.tp2}` : null,
  s.tp3   != null ? `TP3: ${s.tp3}` : null,
  s.score != null ? `Score: ${s.score}` : null,
  s.win_prob_tp1 != null ? `Win%: ${s.win_prob_tp1}%` : null,
  s.session ? `Session: ${s.session}` : null,
].filter(Boolean).join('\n');

const headers = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Title': `${s.direction} ${s.grade} ${s.ticker}`,
  'Priority': priority
};
  if (NTFY_TOKEN) headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;

  fetch(`${NTFY_URL}/${NTFY_TOPIC}`, { method: 'POST', headers, body })
    .catch(err => console.error('[ntfy] send failed:', err.message));
}

// ── WEBHOOK ──────────────────────────────────────────────────────────────────
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
      ticker:       b.ticker    || 'NQ1!',
      timeframe:    b.timeframe || b.interval || null,
      direction,
      grade,
      setup:        b.setup     || null,
      entry:        num(b.entry),
      sl:           num(b.sl),
      tp1:          num(b.tp1),
      tp2:          num(b.tp2),
      tp3:          num(b.tp3),
      score:        num(b.score),
      win_prob_tp1: num(b.win_prob_tp1),
      win_prob_tp2: num(b.win_prob_tp2),
      win_prob_tp3: num(b.win_prob_tp3),
      htf_bias:     b.htf_bias || null,
      session:      b.session  || null,
      raw_payload:  raw,
    });
    console.log(`[${new Date().toISOString()}] ${direction} ${grade} | setup=${b.setup||'?'} | score=${b.score||'?'} | id=${info.lastInsertRowid}`);
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

// ── API ───────────────────────────────────────────────────────────────────────
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
  const total   = db.prepare('SELECT COUNT(*) n FROM signals').get().n;
  const last24h = db.prepare(`SELECT COUNT(*) n FROM signals WHERE received_at >= datetime('now','-1 day')`).get().n;
  const byGrade = db.prepare('SELECT grade, COUNT(*) n FROM signals GROUP BY grade').all();
  const bySetup = db.prepare('SELECT setup, COUNT(*) n FROM signals GROUP BY setup ORDER BY n DESC').all();
  const byDir   = db.prepare('SELECT direction, COUNT(*) n FROM signals GROUP BY direction').all();
  const outcomes = db.prepare('SELECT result, COUNT(*) n FROM outcomes GROUP BY result').all();
  res.json({ total, last24h, byGrade, bySetup, byDir, outcomes });
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

// ── LEARNING ──────────────────────────────────────────────────────────────────
app.get('/api/learning', (req, res) => {
  try { res.json(getLearningStats(db)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BACKTEST ──────────────────────────────────────────────────────────────────
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

// ── STRATEGY PARAMS ───────────────────────────────────────────────────────────
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
  // Fill in defaults for instruments not yet in DB
  for (const inst of ['MNQ', 'MGC']) {
    if (!result[inst]) result[inst] = { ...getParams(db, inst), version: 0 };
  }
  res.json(result);
});

// ── MARKET PRICES ─────────────────────────────────────────────────────────────
app.get('/api/market/prices', (req, res) => {
  const rows = db.prepare('SELECT * FROM market_snapshots').all();
  const result = {};
  for (const row of rows) result[row.symbol] = row;
  res.json(result);
});

// ── JOURNAL ───────────────────────────────────────────────────────────────────

// All resolved live signals with notes (for Real Signals journal section)
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

// Recent backtest runs with per-run loss counts (for Backtesting journal section)
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

// Losing/BE trades for a specific backtest run
app.get('/api/journal/backtest/:runId/trades', (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) return res.status(400).json({ error: 'invalid runId' });
  const rows = db.prepare(
    'SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY bar_idx ASC'
  ).all(runId);
  res.json(rows);
});

// Update note on a resolved live signal (outcome must already exist)
app.post('/api/journal/signal-note', (req, res) => {
  const { signal_id, note } = req.body || {};
  if (!signal_id) return res.status(400).json({ error: 'signal_id required' });
  const outcome = db.prepare('SELECT id FROM outcomes WHERE signal_id = ?').get(signal_id);
  if (!outcome) return res.status(404).json({ error: 'Outcome not found — log WIN/LOSS/BE first' });
  db.prepare(`UPDATE outcomes SET notes = ? WHERE signal_id = ?`).run(note ?? null, signal_id);
  res.json({ ok: true });
});

// Update note on a backtest trade
app.post('/api/journal/backtest-note', (req, res) => {
  const { trade_id, note } = req.body || {};
  if (!trade_id) return res.status(400).json({ error: 'trade_id required' });
  db.prepare(`UPDATE backtest_trades SET note = ?, noted_at = datetime('now') WHERE id = ?`)
    .run(note ?? null, trade_id);
  res.json({ ok: true });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
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

// ── JOURNAL ENTRIES (free-form composer) ──────────────────────────────────────
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

// ── STATIC ────────────────────────────────────────────────────────────────────
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
