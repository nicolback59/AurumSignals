-- NQ Signal Pro V3 — SQLite schema

CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker       TEXT    NOT NULL DEFAULT 'NQ1!',
  timeframe    TEXT,
  direction    TEXT    NOT NULL CHECK(direction IN ('LONG','SHORT')),
  grade        TEXT             CHECK(grade IN ('A+','A','BE')),
  setup        TEXT,
  entry        REAL,
  sl           REAL,
  tp1          REAL,
  tp2          REAL,
  tp3          REAL,
  score        INTEGER,
  win_prob_tp1 INTEGER,
  win_prob_tp2 INTEGER,
  win_prob_tp3 INTEGER,
  htf_bias     TEXT,
  session      TEXT,
  raw_payload  TEXT,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   INTEGER NOT NULL REFERENCES signals(id),
  result      TEXT    CHECK(result IN ('WIN','LOSS','BE')),
  exit_price  REAL,
  exit_at     TEXT,
  pnl_pts     REAL,
  pnl_usd     REAL,
  notes       TEXT,
  UNIQUE (signal_id)
);

CREATE INDEX IF NOT EXISTS idx_signals_received  ON signals(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals(direction);
CREATE INDEX IF NOT EXISTS idx_signals_grade     ON signals(grade);

-- Backtest run history
CREATE TABLE IF NOT EXISTS backtest_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument   TEXT    NOT NULL,
  run_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  bars_tested  INTEGER,
  trades_found INTEGER,
  win_rate     REAL,
  profit_factor REAL,
  sharpe       REAL,
  max_drawdown REAL,
  params_json  TEXT,
  triggered_by TEXT    DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs ON backtest_runs(instrument, run_at DESC);

-- Strategy revision log
CREATE TABLE IF NOT EXISTS strategy_revisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument       TEXT    NOT NULL,
  revised_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  reason           TEXT,
  old_params_json  TEXT,
  new_params_json  TEXT,
  backtest_run_id  INTEGER REFERENCES backtest_runs(id),
  win_rate_before  REAL,
  win_rate_after   REAL,
  status           TEXT    DEFAULT 'shadow'  -- shadow | active | discarded | rolled_back
);
CREATE INDEX IF NOT EXISTS idx_revisions ON strategy_revisions(instrument, revised_at DESC);

-- Current live strategy parameters (one row per instrument)
CREATE TABLE IF NOT EXISTS strategy_params (
  instrument  TEXT    PRIMARY KEY,
  params_json TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  version     INTEGER DEFAULT 1
);

-- Latest market price per symbol (single-row upsert)
CREATE TABLE IF NOT EXISTS market_snapshots (
  symbol      TEXT    PRIMARY KEY,
  price       REAL    NOT NULL,
  open_price  REAL,
  change_pct  REAL,
  high_24h    REAL,
  low_24h     REAL,
  snapped_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
