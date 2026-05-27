'use strict';

const { openDb, heartbeat, bumpCycle, logWorkerError } = require('./worker-utils');

const WORKER_NAME   = 'learning-agent';
const STRATEGIES    = ['MNQ_INTRADAY', 'MGC_SCALP', 'NQ_NY_OPEN'];
const LOOKBACK_DAYS = 90;
const MIN_SAMPLE    = 5;
const WARN_DELTA    = -10;
const CRIT_DELTA    = -20;
const RECENT_N      = 20;

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function classifyRsiZone(rsi) {
  if (rsi == null) return null;
  const v = Number(rsi);
  if (isNaN(v)) return null;
  if (v < 35)  return 'oversold';
  if (v < 45)  return 'low';
  if (v < 55)  return 'mid';
  if (v < 65)  return 'high';
  return 'overbought';
}

function computePercentiles(values) {
  if (!values.length) return { p25: 0, p50: 0, p75: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p) => {
    const pos = (p / 100) * (sorted.length - 1);
    const lo  = Math.floor(pos);
    const hi  = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  return { p25: idx(25), p50: idx(50), p75: idx(75) };
}

function classifyAtrQuartile(atr, p25, p50, p75) {
  if (atr == null) return null;
  const v = Number(atr);
  if (isNaN(v)) return null;
  if (v <= p25) return 'Q1_low_vol';
  if (v <= p50) return 'Q2';
  if (v <= p75) return 'Q3';
  return 'Q4_high_vol';
}

function flagging(winRate, baselineWr) {
  if (baselineWr == null || winRate == null) return { flagged: 0, flag_severity: null };
  const delta = winRate - baselineWr;
  if (delta <= CRIT_DELTA) return { flagged: 1, flag_severity: 'CRITICAL' };
  if (delta <= WARN_DELTA) return { flagged: 1, flag_severity: 'WARNING' };
  return { flagged: 0, flag_severity: null };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function winRate(rows) {
  if (!rows.length) return null;
  const wins = rows.filter(r => r.result === 'WIN').length;
  return (wins / rows.length) * 100;
}

function setupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at          TEXT NOT NULL DEFAULT (datetime('now')),
      strategy_name   TEXT NOT NULL,
      dimension       TEXT NOT NULL,
      dimension_value TEXT NOT NULL,
      sample_size     INTEGER NOT NULL DEFAULT 0,
      win_count       INTEGER NOT NULL DEFAULT 0,
      loss_count      INTEGER NOT NULL DEFAULT 0,
      win_rate        REAL,
      baseline_wr     REAL,
      delta_pp        REAL,
      flagged         INTEGER NOT NULL DEFAULT 0,
      flag_severity   TEXT,
      flag_reason     TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learning_ran_at ON learning_runs(ran_at DESC)`);
  db.exec(`DELETE FROM learning_runs WHERE ran_at < datetime('now', '-30 days')`);
}

function fetchTrades(db, strategy) {
  return db.prepare(`
    SELECT
      s.id,
      s.direction,
      s.session,
      s.htf_bias,
      s.received_at,
      o.result,
      json_extract(s.raw_payload, '$.meta.indicators.rsi')    AS rsi,
      json_extract(s.raw_payload, '$.meta.indicators.atr')    AS atr,
      json_extract(s.raw_payload, '$.meta.indicators.regime') AS regime
    FROM signals s
    JOIN outcomes o ON o.signal_id = s.id
    WHERE s.strategy_name = ?
      AND o.result IN ('WIN', 'LOSS')
      AND s.received_at >= datetime('now', ? )
  `).all(strategy, `-${LOOKBACK_DAYS} days`);
}

function insertRow(stmt, strategy, dimension, value, rows, baselineWr) {
  if (rows.length < MIN_SAMPLE) return;
  const wins   = rows.filter(r => r.result === 'WIN').length;
  const losses = rows.filter(r => r.result === 'LOSS').length;
  const wr     = winRate(rows);
  const delta  = (wr != null && baselineWr != null) ? +(wr - baselineWr).toFixed(2) : null;
  const { flagged, flag_severity } = flagging(wr, baselineWr);
  const flag_reason = flag_severity
    ? `${dimension}=${value} WR ${wr != null ? wr.toFixed(1) : '?'}% vs baseline ${baselineWr != null ? baselineWr.toFixed(1) : '?'}%`
    : null;
  stmt.run({
    strategy_name:   strategy,
    dimension,
    dimension_value: String(value),
    sample_size:     rows.length,
    win_count:       wins,
    loss_count:      losses,
    win_rate:        wr != null ? +wr.toFixed(4) : null,
    baseline_wr:     baselineWr != null ? +baselineWr.toFixed(4) : null,
    delta_pp:        delta,
    flagged,
    flag_severity,
    flag_reason,
  });
}

function analyzeStrategy(db, strategy, insertStmt) {
  const trades = fetchTrades(db, strategy);
  if (!trades.length) return { total: 0, flagged: 0 };

  const overallWr = winRate(trades);

  insertRow(insertStmt, strategy, 'overall', 'all', trades, overallWr);

  const bySession = groupBy(trades, r => r.session || null);
  for (const [val, rows] of bySession) {
    insertRow(insertStmt, strategy, 'session', val, rows, overallWr);
  }

  const byDow = groupBy(trades, r => {
    const d = new Date(r.received_at).getDay();
    return DOW_LABELS[d] ?? null;
  });
  for (const [val, rows] of byDow) {
    insertRow(insertStmt, strategy, 'dow', val, rows, overallWr);
  }

  const byHtfBias = groupBy(trades, r => r.htf_bias || null);
  for (const [val, rows] of byHtfBias) {
    insertRow(insertStmt, strategy, 'htf_bias', val, rows, overallWr);
  }

  const byRsi = groupBy(trades, r => classifyRsiZone(r.rsi));
  for (const [val, rows] of byRsi) {
    insertRow(insertStmt, strategy, 'rsi_zone', val, rows, overallWr);
  }

  const atrValues = trades.map(r => Number(r.atr)).filter(v => !isNaN(v) && v > 0);
  const { p25, p50, p75 } = computePercentiles(atrValues);
  const byAtr = groupBy(trades, r => classifyAtrQuartile(r.atr, p25, p50, p75));
  for (const [val, rows] of byAtr) {
    insertRow(insertStmt, strategy, 'atr_quartile', val, rows, overallWr);
  }

  const byRegime = groupBy(trades, r => r.regime || null);
  for (const [val, rows] of byRegime) {
    insertRow(insertStmt, strategy, 'regime', val, rows, overallWr);
  }

  const byDirection = groupBy(trades, r => r.direction || null);
  for (const [val, rows] of byDirection) {
    insertRow(insertStmt, strategy, 'direction', val, rows, overallWr);
  }

  const recent = trades.slice(-RECENT_N);
  if (recent.length >= MIN_SAMPLE) {
    const recentWr = winRate(recent);
    const delta    = (recentWr != null && overallWr != null) ? +(recentWr - overallWr).toFixed(2) : null;
    const { flagged, flag_severity } = flagging(recentWr, overallWr);
    const flag_reason = flag_severity
      ? `recent_${RECENT_N} WR ${recentWr != null ? recentWr.toFixed(1) : '?'}% vs baseline ${overallWr != null ? overallWr.toFixed(1) : '?'}%`
      : null;
    insertStmt.run({
      strategy_name:   strategy,
      dimension:       'degradation',
      dimension_value: `recent_${RECENT_N}`,
      sample_size:     recent.length,
      win_count:       recent.filter(r => r.result === 'WIN').length,
      loss_count:      recent.filter(r => r.result === 'LOSS').length,
      win_rate:        recentWr != null ? +recentWr.toFixed(4) : null,
      baseline_wr:     overallWr != null ? +overallWr.toFixed(4) : null,
      delta_pp:        delta,
      flagged,
      flag_severity,
      flag_reason,
    });
  }

  const flaggedCount = db.prepare(
    `SELECT COUNT(*) AS n FROM learning_runs WHERE strategy_name = ? AND flagged = 1 AND ran_at >= datetime('now', '-1 minute')`
  ).get(strategy)?.n ?? 0;

  return { total: trades.length, flagged: flaggedCount, overallWr };
}

function run() {
  const db = openDb();

  try {
    setupSchema(db);

    const insertStmt = db.prepare(`
      INSERT INTO learning_runs
        (strategy_name, dimension, dimension_value, sample_size, win_count, loss_count,
         win_rate, baseline_wr, delta_pp, flagged, flag_severity, flag_reason)
      VALUES
        (@strategy_name, @dimension, @dimension_value, @sample_size, @win_count, @loss_count,
         @win_rate, @baseline_wr, @delta_pp, @flagged, @flag_severity, @flag_reason)
    `);

    const summary = {};
    for (const strategy of STRATEGIES) {
      try {
        summary[strategy] = analyzeStrategy(db, strategy, insertStmt);
      } catch (err) {
        logWorkerError(db, WORKER_NAME, err);
        console.error(`[${WORKER_NAME}] strategy ${strategy} error:`, err.message);
        summary[strategy] = { error: err.message };
      }
    }

    bumpCycle(db, WORKER_NAME);
    heartbeat(db, WORKER_NAME, 'IDLE', {
      lastRun: new Date().toISOString(),
      strategies: summary,
    });

    console.log(`[${WORKER_NAME}] done`, JSON.stringify(summary));
  } catch (err) {
    logWorkerError(db, WORKER_NAME, err);
    console.error(`[${WORKER_NAME}] fatal error:`, err.message);
  } finally {
    db.close();
  }

  process.exit(0);
}

run();
