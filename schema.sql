-- NQ Signal Pro V3 — SQLite schema

CREATE TABLE IF NOT EXISTS signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker         TEXT    NOT NULL DEFAULT 'NQ1!',
  timeframe      TEXT,
  direction      TEXT    NOT NULL CHECK(direction IN ('LONG','SHORT')),
  grade          TEXT             CHECK(grade IN ('A+','A','BE')),
  setup          TEXT,
  strategy_name  TEXT,          -- 'MNQ_INTRADAY' | 'MNQ_SWING' | 'MNQ_50PT' | 'MGC_SCALP'
  entry          REAL,
  sl             REAL,
  tp1            REAL,
  tp2            REAL,
  tp3            REAL,
  score          INTEGER,
  confidence     INTEGER,       -- 0–100 raw confidence from strategy scorer
  tier           TEXT,          -- 'S' | 'A' | 'B' | 'IGNORE' (institutional tier from signal-ranker)
  win_prob_tp1   INTEGER,
  win_prob_tp2   INTEGER,
  win_prob_tp3   INTEGER,
  htf_bias       TEXT,
  session        TEXT,
  trade_style    TEXT,          -- 'scalp' | 'intraday' | 'swing'
  instrument     TEXT,          -- 'MNQ' | 'MGC' | 'NQ'
  rr             REAL,          -- risk:reward ratio
  trade_status   TEXT    NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | WIN | LOSS | BE | EXPIRED | INVALIDATED
  raw_payload    TEXT,
  received_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Migration: add strategy_name to existing signals tables (safe no-op if already present)
CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy_name);

CREATE TABLE IF NOT EXISTS outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   INTEGER NOT NULL REFERENCES signals(id),
  result      TEXT    CHECK(result IN ('WIN','LOSS','BE','EXPIRED')),
  exit_price  REAL,
  exit_at     TEXT,
  pnl_pts     REAL,
  pnl_usd     REAL,
  notes       TEXT,
  UNIQUE (signal_id)
);

CREATE INDEX IF NOT EXISTS idx_signals_received    ON signals(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_direction   ON signals(direction);
CREATE INDEX IF NOT EXISTS idx_signals_grade       ON signals(grade);
CREATE INDEX IF NOT EXISTS idx_signals_trade_style ON signals(trade_style);
CREATE INDEX IF NOT EXISTS idx_signals_instrument  ON signals(instrument);

-- Backtest run summary
CREATE TABLE IF NOT EXISTS backtest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument    TEXT    NOT NULL,
  run_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  bars_tested   INTEGER,
  trades_found  INTEGER,
  win_rate      REAL,
  profit_factor REAL,
  sharpe        REAL,
  max_drawdown  REAL,
  params_json   TEXT,
  triggered_by  TEXT    DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs ON backtest_runs(instrument, run_at DESC);

-- Extended backtest detail (regime/style/setup breakdowns + walk-forward)
CREATE TABLE IF NOT EXISTS backtest_details (
  run_id                    INTEGER PRIMARY KEY REFERENCES backtest_runs(id),
  regime_breakdown          TEXT,   -- JSON: { trending:{winRate,...}, ranging:{...}, ... }
  style_breakdown           TEXT,   -- JSON: { scalp:{...}, intraday:{...}, swing:{...} }
  setup_breakdown           TEXT,   -- JSON: { 'OTE PB':{...}, 'STDV REV':{...}, ... }
  walk_forward_consistency  REAL,   -- 0–1 score from runWalkForward
  walk_forward_avg_wr       REAL,
  max_win_streak            INTEGER,
  max_loss_streak           INTEGER,
  slippage_used             REAL,
  cooldown_used             INTEGER,
  target_trades             INTEGER,
  multi_obj_score           REAL    -- multiObjectiveScore()
);

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

-- Per-style strategy parameters (one row per instrument+style key)
CREATE TABLE IF NOT EXISTS style_params (
  key         TEXT    PRIMARY KEY,   -- e.g. 'MNQ_SCALP', 'MNQ_SWING', 'MGC_SCALP'
  params_json TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  version     INTEGER DEFAULT 1
);

-- Optimization run history (tracks each 50-candidate search cycle)
CREATE TABLE IF NOT EXISTS optimization_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument          TEXT    NOT NULL,
  trade_style         TEXT,
  run_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  candidates_tested   INTEGER,
  best_win_rate       REAL,
  best_sharpe         REAL,
  best_consistency    REAL,
  best_multi_obj      REAL,
  best_params_json    TEXT,
  baseline_win_rate   REAL,
  promoted            INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_optim_runs ON optimization_runs(instrument, run_at DESC);

-- Individual trades from backtest runs
CREATE TABLE IF NOT EXISTS backtest_trades (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES backtest_runs(id),
  instrument     TEXT    NOT NULL,
  bar_idx        INTEGER,
  timestamp      TEXT,
  direction      TEXT,
  setup          TEXT,
  strategy_name  TEXT,   -- 'MNQ_INTRADAY' | 'MNQ_SWING' | 'MNQ_50PT' | 'MGC_SCALP'
  trade_style    TEXT,
  regime         TEXT,
  entry          REAL,
  sl             REAL,
  tp1            REAL,
  outcome        TEXT,    -- WIN | LOSS | BE
  score          INTEGER,
  confidence     INTEGER, -- 0–100 from new engine
  note           TEXT,
  noted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_trades_run ON backtest_trades(run_id, outcome);

-- Free-form journal entries (composer notes)
CREATE TABLE IF NOT EXISTS journal_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT    NOT NULL DEFAULT 'observation',  -- observation | lesson | plan | risk | review
  body       TEXT    NOT NULL,
  tags       TEXT,                                    -- comma-separated
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_entries ON journal_entries(created_at DESC);

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

-- Signals that almost fired but failed a filter (diagnostic)
CREATE TABLE IF NOT EXISTS signal_rejections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument  TEXT    NOT NULL,
  direction   TEXT,
  setup       TEXT,
  strategy    TEXT,
  score       INTEGER,
  min_score   INTEGER,
  reason      TEXT    NOT NULL,
  details     TEXT,   -- JSON: indicator snapshot at rejection time
  rejected_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rejections ON signal_rejections(instrument, rejected_at DESC);

-- Per-scan diagnostic snapshot (one row per instrument per scan cycle)
CREATE TABLE IF NOT EXISTS scan_diagnostics (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument       TEXT    NOT NULL,
  scanned_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_close       REAL,
  htf_bias         TEXT,
  chop             INTEGER,
  atr              REAL,
  score_l          INTEGER,
  score_s          INTEGER,
  any_setup_l      INTEGER DEFAULT 0,
  any_setup_s      INTEGER DEFAULT 0,
  fired            INTEGER DEFAULT 0,
  strategies_fired TEXT,   -- JSON array of strategy names that fired
  reject_reason    TEXT,
  indicators       TEXT    -- JSON snapshot of key indicator values
);
CREATE INDEX IF NOT EXISTS idx_scan_diag ON scan_diagnostics(instrument, scanned_at DESC);

-- Scanner heartbeat — single row updated every scan for live status tracking
CREATE TABLE IF NOT EXISTS scanner_heartbeat (
  id         INTEGER PRIMARY KEY CHECK(id = 1),
  last_scan  TEXT    NOT NULL DEFAULT (datetime('now')),
  scan_count INTEGER NOT NULL DEFAULT 0
);

-- Google News RSS items — geopolitical, macro, MNQ, MGC
CREATE TABLE IF NOT EXISTS news_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  source       TEXT,
  link         TEXT,
  summary      TEXT,
  published_at TEXT,
  fetched_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(title, category)
);
CREATE INDEX IF NOT EXISTS idx_news_items ON news_items(fetched_at DESC);

-- Weekly learning summaries — one row per strategy per calendar week.
-- Preserves full history so the assistant can detect recurring mistakes across weeks.
-- week_start is the Monday of the week (ISO format: YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start           TEXT    NOT NULL,  -- Monday date, e.g. "2025-05-05"
  week_label           TEXT    NOT NULL,  -- human label, e.g. "Week of May 5, 2025"
  strategy_key         TEXT    NOT NULL,  -- MGC_SCALP | MNQ_INTRADAY | MNQ_SWING | MNQ_50PT | MGC_INTRADAY
  strategy_label       TEXT    NOT NULL,  -- human label
  total_signals        INTEGER DEFAULT 0,
  wins                 INTEGER DEFAULT 0,
  losses               INTEGER DEFAULT 0,
  breakevens           INTEGER DEFAULT 0,
  win_rate             REAL    DEFAULT 0,
  performance_review   TEXT,   -- JSON or text block
  failure_analysis     TEXT,
  corrective_actions   TEXT,
  pattern_tracking     TEXT,
  prior_repeats        INTEGER DEFAULT 0, -- count of mistakes flagged as repeat from prior week
  escalated            INTEGER DEFAULT 0, -- 1 if same mistake repeated 2 weeks in a row
  raw_signals_json     TEXT,              -- compact signal log for machine re-analysis
  generated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(week_start, strategy_key)
);
CREATE INDEX IF NOT EXISTS idx_weekly_summaries ON weekly_summaries(week_start DESC, strategy_key);

-- ── Schema migrations (safe no-ops on fresh DBs) ─────────────────────────────
-- Add strategy_name to signals if missing (existing databases)
CREATE TABLE IF NOT EXISTS _schema_migrations (migration TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));

-- These are handled via the migration runner in server.js startup instead of
-- raw SQL here, since SQLite does not support IF NOT EXISTS on ALTER TABLE.
-- See server.js applyMigrations() for the actual column additions.
