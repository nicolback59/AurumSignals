-- Aurum Signals — SQLite schema

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
  trade_status       TEXT    NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | WIN | LOSS | BE | EXPIRED | INVALIDATED
  raw_payload        TEXT,
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  quant_score        INTEGER,       -- composite quant score at signal time (0–100)
  quant_grade        TEXT,          -- S | A | B | IGNORE
  live_gated         INTEGER DEFAULT 0,  -- 1 = research-only at emit time
  expiration_reason  TEXT               -- EXPIRED_MARKET_CLOSE | EXPIRED_WEEKEND_CLOSE | EXPIRED_MAX_HOLD | EXPIRED_STUCK_TRADE
);

-- Migration: add strategy_name to existing signals tables (safe no-op if already present)
CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy_name);

CREATE TABLE IF NOT EXISTS outcomes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id      INTEGER NOT NULL REFERENCES signals(id),
  result         TEXT    CHECK(result IN ('WIN','LOSS','BE','EXPIRED')),
  exit_price     REAL,
  exit_at        TEXT,
  pnl_pts        REAL,
  pnl_usd        REAL,
  notes          TEXT,
  mfe_pts        REAL,         -- Maximum Favorable Excursion (best price reached)
  mae_pts        REAL,         -- Maximum Adverse Excursion (worst drawdown reached)
  hold_time_min  REAL,         -- minutes from entry to exit
  failure_reason    TEXT,         -- chop_fakeout | volatility_sweep | exhaustion | late_entry | news | etc
  quant_score       INTEGER,      -- composite quant score at signal time (0-100)
  quant_grade       TEXT,         -- S | A | B | IGNORE
  expiration_reason TEXT,         -- EXPIRED_MARKET_CLOSE | EXPIRED_WEEKEND_CLOSE | EXPIRED_MAX_HOLD | EXPIRED_STUCK_TRADE
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

-- Per-strategy live/research mode
-- Strategies start in RESEARCH_ONLY and are promoted to LIVE_ENABLED once
-- they meet quality criteria (sample size, win rate, expectancy, drawdown).
CREATE TABLE IF NOT EXISTS strategy_status (
  strategy_name  TEXT    PRIMARY KEY,
  mode           TEXT    NOT NULL DEFAULT 'RESEARCH_ONLY'
                         CHECK(mode IN ('RESEARCH_ONLY','LIVE_ENABLED')),
  live_since     TEXT,
  notes          TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
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
  pnl_pts        REAL,    -- realized P&L in points (positive=win, negative=loss, 0=BE)
  mfe_pts        REAL,    -- Maximum Favorable Excursion (best price reached, points)
  mae_pts        REAL,    -- Maximum Adverse Excursion (worst drawdown, points)
  hold_time_min  REAL,    -- minutes from entry bar to exit bar (durationBars × 5)
  exit_type      TEXT,    -- TP_HIT | SL_HIT | TIMEOUT
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

-- ── TP hits — tracks TP2/TP3 strikes after a signal reaches WIN (TP1 hit) ────
-- Separate from outcomes so the WIN record is immutable once written.
CREATE TABLE IF NOT EXISTS tp_hits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  tp_level  INTEGER NOT NULL,   -- 2 or 3
  hit_at    TEXT    NOT NULL,
  pnl_pts   REAL,
  UNIQUE(signal_id, tp_level)
);
CREATE INDEX IF NOT EXISTS idx_tp_hits_signal ON tp_hits(signal_id);

-- ── Schema migrations (safe no-ops on fresh DBs) ─────────────────────────────
-- Add strategy_name to signals if missing (existing databases)
CREATE TABLE IF NOT EXISTS _schema_migrations (migration TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));

-- ── AUTH — Users & Sessions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  email                  TEXT    UNIQUE NOT NULL COLLATE NOCASE,
  password_hash          TEXT    NOT NULL,
  name                   TEXT,
  plan                   TEXT    NOT NULL DEFAULT 'free',  -- free | pro | elite
  stripe_customer_id     TEXT    UNIQUE,
  stripe_subscription_id TEXT    UNIQUE,
  subscription_status    TEXT    DEFAULT 'inactive',       -- inactive|trialing|active|past_due|canceled
  subscription_period_end INTEGER,                         -- unix timestamp ms
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login             TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_cust ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_sub  ON users(stripe_subscription_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id         TEXT    PRIMARY KEY,   -- 64-char hex random token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,      -- unix ms timestamp
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);

-- Password reset tokens — one-time use, expires in 1 hour
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token       TEXT    PRIMARY KEY,              -- 64-char hex
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,                 -- unix ms
  used        INTEGER NOT NULL DEFAULT 0,       -- 0=unused 1=consumed
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user    ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_expires ON password_reset_tokens(expires_at);

-- Historical OHLCV bar archive — accumulates over time as backtest cycles run.
-- 1m bars are saved on every regular backtest fetch; 5m bars are saved during
-- deep historical backtest runs. Both are keyed by (symbol, interval, timestamp)
-- so INSERT OR IGNORE is safe and idempotent.
CREATE TABLE IF NOT EXISTS historical_bars (
  symbol    TEXT NOT NULL,
  interval  TEXT NOT NULL,  -- '1m' | '5m' | '1h'
  timestamp TEXT NOT NULL,
  open      REAL NOT NULL,
  high      REAL NOT NULL,
  low       REAL NOT NULL,
  close     REAL NOT NULL,
  volume    REAL DEFAULT 0,
  PRIMARY KEY (symbol, interval, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_hist_bars ON historical_bars(symbol, interval, timestamp DESC);

-- ── Loss forensics — one row per non-WIN outcome ────────────────────────────────
CREATE TABLE IF NOT EXISTS loss_forensics (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id            INTEGER NOT NULL,
  strategy_name        TEXT    NOT NULL,
  instrument           TEXT    NOT NULL,
  direction            TEXT,
  result               TEXT    NOT NULL,
  failure_category     TEXT    NOT NULL,
  failure_subcategory  TEXT,
  classifier_version   TEXT    DEFAULT '1.0',
  session              TEXT,
  day_of_week          INTEGER,
  regime               TEXT,
  htf_bias             TEXT,
  confidence           INTEGER,
  quant_score          INTEGER,
  quant_grade          TEXT,
  setup_type           TEXT,
  hold_time_min        REAL,
  mfe_pts              REAL,
  mae_pts              REAL,
  pnl_pts              REAL,
  entry                REAL,
  sl                   REAL,
  data_quality         TEXT,
  auto_flagged         INTEGER DEFAULT 0,
  analyst_note         TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loss_forensics_strategy ON loss_forensics(strategy_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loss_forensics_category ON loss_forensics(failure_category);
CREATE INDEX IF NOT EXISTS idx_loss_forensics_signal   ON loss_forensics(signal_id);

-- These are handled via the migration runner in server.js startup instead of
-- raw SQL here, since SQLite does not support IF NOT EXISTS on ALTER TABLE.
-- See server.js applyMigrations() for the actual column additions.

-- ── Automated Report Scheduler ────────────────────────────────────────────────
-- Persists every auto-generated and manual report with full metrics and narrative.
-- report_id is unique e.g. 'WEEKLY_DEEP_2025-05-12' or 'MID_WEEK_2025-05-12'.
-- scope distinguishes live-only, backtest-only, or combined analysis.

CREATE TABLE IF NOT EXISTS reports (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id            TEXT    UNIQUE NOT NULL,
  report_type          TEXT    NOT NULL,   -- 'WEEKLY_DEEP_DIVE' | 'MID_WEEK'
  scope                TEXT    NOT NULL DEFAULT 'COMBINED', -- 'LIVE' | 'BACKTEST' | 'COMBINED'
  status               TEXT    NOT NULL DEFAULT 'completed', -- 'generating' | 'completed' | 'failed'
  attempt_count        INTEGER NOT NULL DEFAULT 1,
  generated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  start_date           TEXT    NOT NULL,
  end_date             TEXT    NOT NULL,
  summary              TEXT,
  metrics_json         TEXT,   -- JSON: all live performance metrics
  strategy_json        TEXT,   -- JSON: per-strategy breakdown
  backtest_json        TEXT,   -- JSON: backtest performance section
  recommendations_json TEXT,   -- JSON: recommended actions
  version_changes      TEXT,   -- JSON: strategy version deltas this period
  failure_analysis     TEXT,   -- text: failure modes identified
  narrative            TEXT,   -- full plain-text report narrative
  error_message        TEXT    -- populated if status = 'failed'
);
CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(report_type, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_id   ON reports(report_id);

-- Report scheduler state — tracks next scheduled generation to prevent duplicates
CREATE TABLE IF NOT EXISTS report_schedule (
  schedule_key    TEXT    PRIMARY KEY,  -- 'WEEKLY_DEEP_DIVE' | 'MID_WEEK'
  last_run_at     TEXT,
  last_report_id  TEXT,
  next_run_at     TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  tz              TEXT    NOT NULL DEFAULT 'America/Los_Angeles'
);

-- ════════════════════════════════════════════════════════════════════════════
-- INTELLIGENCE ENGINE — Phase 1 Foundation (Tier 1 Master Prompt #4)
-- ════════════════════════════════════════════════════════════════════════════

-- Full indicator snapshot captured at signal emit time.
-- Enables feature importance analysis, calibration audits, and ML regression.
CREATE TABLE IF NOT EXISTS signal_features (
  signal_id          INTEGER PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  -- price / volatility
  atr                REAL,
  atr_percentile     REAL,    -- where current ATR sits in 90-day distribution (0–1)
  vwap_dist_atr      REAL,    -- (close - VWAP) / ATR  (negative = below VWAP)
  -- momentum / trend
  rsi                REAL,
  adx                REAL,
  macd_hist          REAL,    -- MACD histogram value (positive = bullish momentum)
  ema9_vs_ema21      REAL,    -- ema9 - ema21 in points (sign = direction)
  htf_15m_bias       INTEGER, -- -1/0/1
  htf_1h_bias        INTEGER,
  htf_4h_bias        INTEGER,
  -- structure
  chop_score         REAL,    -- 0–1 choppiness score
  disp_strength      REAL,    -- current bar body / avg prior 10 bar bodies
  mtf_agreed         INTEGER, -- count of TF layers agreeing with trade direction
  -- session / timing
  session            TEXT,
  time_in_session    REAL,    -- 0=session open, 1=session close
  prior_signal_gap_m INTEGER, -- minutes since last signal in same direction
  -- regime
  regime             TEXT,
  vol_regime         TEXT,    -- LOW / NORMAL / HIGH
  vwap_state         TEXT,    -- ABOVE / BELOW / RECLAIMING / REJECTING / CHOPPING
  -- setup quality
  archetype          TEXT,    -- continuation_pullback / sweep_reversal / etc.
  entry_type         TEXT,    -- reclaim / sweep / continuation / breakout / fade
  confluence_bonus   INTEGER,
  -- raw dump for future fields
  raw_json           TEXT,    -- full signal.indicators JSON
  recorded_at        TEXT     NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sf_recorded ON signal_features(recorded_at DESC);

-- Daily rolling health snapshot per strategy.
-- The time-series backbone of edge degradation detection.
CREATE TABLE IF NOT EXISTS strategy_health_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name  TEXT    NOT NULL,
  snapshot_date  TEXT    NOT NULL,  -- YYYY-MM-DD
  -- rolling win rates
  wr_7d          REAL,
  wr_14d         REAL,
  wr_30d         REAL,
  wr_90d         REAL,             -- baseline reference
  -- rolling expectancy (avg pts/trade)
  exp_7d         REAL,
  exp_14d        REAL,
  exp_30d        REAL,
  -- rolling profit factor
  pf_7d          REAL,
  pf_30d         REAL,
  -- signal frequency (signals per trading day)
  freq_7d        REAL,
  freq_30d       REAL,
  -- sample sizes
  trades_7d      INTEGER,
  trades_14d     INTEGER,
  trades_30d     INTEGER,
  -- trend direction: UP / DOWN / FLAT
  wr_trend       TEXT,
  exp_trend      TEXT,
  freq_trend     TEXT,
  -- failure category breakdown (JSON: {chop_fakeout: 0.34, ...})
  failure_breakdown TEXT,
  top_failure    TEXT,            -- name of top failure category
  top_failure_pct REAL,
  -- composite health score (0–100) and status
  health_score   REAL,
  health_status  TEXT,            -- HEALTHY / CAUTION / DEGRADED / CRITICAL
  computed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  is_latest      INTEGER NOT NULL DEFAULT 0,  -- 1 = current snapshot for this strategy
  UNIQUE(strategy_name, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_shs_strategy  ON strategy_health_snapshots(strategy_name, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_shs_is_latest ON strategy_health_snapshots(is_latest) WHERE is_latest = 1;

-- Confidence calibration audit: does confidence=75 actually predict 65% WR?
CREATE TABLE IF NOT EXISTS calibration_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name   TEXT    NOT NULL,
  conf_bucket     TEXT    NOT NULL,  -- '55-60', '60-65', '65-70', '70-75', '75-80', '80+'
  period_days     INTEGER NOT NULL,  -- 30 or 90
  total_signals   INTEGER,
  wins            INTEGER,
  actual_wr       REAL,              -- observed win rate
  avg_predicted   REAL,              -- avg win_prob_tp1 in this bucket
  calibration_err REAL,              -- actual_wr - avg_predicted (negative = overconfident)
  computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, conf_bucket, period_days)
);
CREATE INDEX IF NOT EXISTS idx_ca_strategy ON calibration_audit(strategy_name, computed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ca_unique ON calibration_audit(strategy_name, conf_bucket, period_days);

-- Every corrective action applied plus its measured effect 2 weeks later.
-- Closes the forensics loop: intervention → measure → learn.
CREATE TABLE IF NOT EXISTS intervention_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  applied_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  strategy_name  TEXT,
  agent_source   TEXT    NOT NULL,  -- loss_forensics / learning_agent / optimizer / manual
  description    TEXT    NOT NULL,
  param_before   TEXT,              -- JSON snapshot of params before change
  param_after    TEXT,              -- JSON snapshot of params after change
  -- filled by evaluation job ~14 days after application
  eval_at        TEXT,
  wr_before      REAL,
  wr_after       REAL,
  wr_delta       REAL,              -- positive = improvement
  failure_before TEXT,              -- JSON {category: pct, ...}
  failure_after  TEXT,
  net_effect     REAL,              -- composite: positive = helped
  eval_status    TEXT    DEFAULT 'pending'  -- pending / evaluated / insufficient_data
);
CREATE INDEX IF NOT EXISTS idx_il_strategy ON intervention_log(strategy_name, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_il_eval     ON intervention_log(eval_status, applied_at);

-- Agent-to-agent message bus (SQLite as shared IPC).
-- Agents publish observations and recommendations; consensus-coordinator reads.
CREATE TABLE IF NOT EXISTS agent_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent  TEXT    NOT NULL,
  to_agent    TEXT    NOT NULL DEFAULT 'consensus',  -- 'consensus' | specific worker name
  msg_type    TEXT    NOT NULL,  -- observation / recommendation / vote / veto
  strategy    TEXT,
  payload     TEXT    NOT NULL,  -- JSON
  priority    INTEGER NOT NULL DEFAULT 3,  -- 1 (critical) to 5 (low)
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending / consumed / rejected
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_am_status   ON agent_messages(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_am_toagent  ON agent_messages(to_agent, status);

-- Track accuracy of each agent's recommendations over time.
-- High-accuracy agents earn more weight in consensus decisions.
CREATE TABLE IF NOT EXISTS agent_trust_scores (
  agent_name      TEXT    PRIMARY KEY,
  recommendations INTEGER NOT NULL DEFAULT 0,
  correct_calls   INTEGER NOT NULL DEFAULT 0,
  incorrect_calls INTEGER NOT NULL DEFAULT 0,
  trust_weight    REAL    NOT NULL DEFAULT 1.0,  -- 0.5–2.0
  last_calibrated TEXT
);

-- Regime change event log: tracks transitions between regime states.
-- Enables: transition probability matrix, WR by regime phase, regime stability.
CREATE TABLE IF NOT EXISTS regime_transitions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument           TEXT    NOT NULL,
  from_regime          TEXT    NOT NULL,
  to_regime            TEXT    NOT NULL,
  transitioned_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  duration_bars        INTEGER,   -- how many 15-min snapshots prior regime lasted
  duration_min         INTEGER,   -- minutes the prior regime persisted
  signals_fired_in_prior INTEGER,
  wr_in_prior          REAL,      -- WR of signals fired during prior regime
  atr_at_transition    REAL
);
CREATE INDEX IF NOT EXISTS idx_rt_instrument ON regime_transitions(instrument, transitioned_at DESC);

-- ── Quant-engine migration block (safe no-ops if columns already exist) ───────
-- These run in server.js applyMigrations() via ALTER TABLE ... IF NOT EXISTS logic.
-- Listed here as documentation; actual migration is handled by the migration runner.
-- ALTER TABLE signals  ADD COLUMN quant_score INTEGER;
-- ALTER TABLE signals  ADD COLUMN quant_grade  TEXT;
-- ALTER TABLE outcomes ADD COLUMN mfe_pts          REAL;
-- ALTER TABLE outcomes ADD COLUMN mae_pts          REAL;
-- ALTER TABLE outcomes ADD COLUMN hold_time_min    REAL;
-- ALTER TABLE outcomes ADD COLUMN failure_reason   TEXT;
-- ALTER TABLE outcomes ADD COLUMN quant_score      INTEGER;
-- ALTER TABLE outcomes ADD COLUMN quant_grade      TEXT;

-- ── Win forensics — one row per WIN outcome ──────────────────────────────────
-- Mirrors loss_forensics but captures what made trades succeed.
-- Populated by workers/win-forensics-worker.js every 4h.
CREATE TABLE IF NOT EXISTS win_forensics (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id            INTEGER NOT NULL,
  strategy_name        TEXT    NOT NULL,
  instrument           TEXT    NOT NULL,
  direction            TEXT,
  result               TEXT    NOT NULL,         -- WIN | BE
  win_category         TEXT    NOT NULL,         -- primary win archetype
  win_subcategory      TEXT,                     -- secondary detail
  classifier_version   TEXT    DEFAULT '1.0',
  session              TEXT,
  day_of_week          INTEGER,
  regime               TEXT,
  htf_bias             TEXT,
  confidence           INTEGER,
  archetype            TEXT,                     -- signal archetype from signal_features
  htf_alignment        INTEGER,                  -- count of HTF biases aligned (0-3)
  tp_reached           INTEGER,                  -- highest TP hit (1-4, or 0 = BE)
  hold_time_min        REAL,
  mfe_pts              REAL,
  pnl_pts              REAL,
  rr_achieved          REAL,                     -- actual RR at exit vs planned
  entry                REAL,
  data_quality         TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_win_forensics_strategy ON win_forensics(strategy_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_win_forensics_category ON win_forensics(win_category);
CREATE INDEX IF NOT EXISTS idx_win_forensics_signal   ON win_forensics(signal_id);

-- ── Feature correlations — which indicator dimensions predict wins ────────────
-- Populated by workers/feature-intelligence-worker.js daily.
CREATE TABLE IF NOT EXISTS feature_correlations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name TEXT    NOT NULL,
  feature_key   TEXT    NOT NULL,
  feature_value TEXT    NOT NULL,
  period_days   INTEGER NOT NULL,
  sample_size   INTEGER NOT NULL,
  win_rate      REAL    NOT NULL,
  baseline_wr   REAL    NOT NULL,
  wr_delta      REAL    NOT NULL,
  significance  TEXT,
  computed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, feature_key, feature_value, period_days)
);
CREATE INDEX IF NOT EXISTS idx_fc_strategy ON feature_correlations(strategy_name, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fc_delta    ON feature_correlations(wr_delta DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- INTELLIGENCE ENGINE — Phase 4: Edge Health + Intelligence Report
-- ════════════════════════════════════════════════════════════════════════════

-- Rolling edge-decay log written by workers/edge-health-worker.js every 2h.
-- Tracks short-window WR decay across last 5/10/20 resolved trades per strategy.
CREATE TABLE IF NOT EXISTS edge_health_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name       TEXT    NOT NULL,
  instrument          TEXT    NOT NULL,
  checked_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  decay_score         INTEGER NOT NULL,         -- 0-100+ composite decay score
  edge_status         TEXT    NOT NULL,         -- HEALTHY | WATCH | WARNING | CRITICAL | COLLAPSE
  wr_last5            REAL,                     -- WR over last 5 resolved trades (0.0–1.0)
  wr_last10           REAL,                     -- WR over last 10 resolved trades
  wr_last20           REAL,                     -- WR over last 20 resolved trades
  baseline_wr         REAL,                     -- 90-day baseline WR
  consecutive_losses  INTEGER DEFAULT 0,
  trades_available    INTEGER DEFAULT 0,        -- resolved trades available for rolling calc
  veto_posted         INTEGER DEFAULT 0,        -- 1 if a veto was posted to agent_messages
  notes               TEXT                      -- comma-separated list of triggered factors
);
CREATE INDEX IF NOT EXISTS idx_ehl_strategy ON edge_health_log(strategy_name, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ehl_status   ON edge_health_log(edge_status, checked_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- INTELLIGENCE ENGINE — Phase 5: Adaptive Signal Gate
-- ════════════════════════════════════════════════════════════════════════════

-- Per-strategy gate state computed every 30 min by workers/signal-gate-worker.js.
-- Synthesizes edge health, strategy health, calibration, vetoes, and feature
-- correlations into a single gating decision fed back into the live scanner
-- via the adaptive overrides blob (strategy_params table).
CREATE TABLE IF NOT EXISTS signal_gates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name        TEXT    NOT NULL,
  evaluated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  gate_status          TEXT    NOT NULL,         -- OPEN | CAUTIOUS | RESTRICTED | GATED
  adjusted_min_conf    INTEGER NOT NULL,         -- effective minimum confidence for live signals
  base_min_conf        INTEGER NOT NULL,         -- baseline before adjustments
  conf_adjustment      INTEGER NOT NULL,         -- delta applied to base (0 / +5 / +10 / +20)
  edge_contribution    INTEGER DEFAULT 0,        -- points from edge health (Phase 4)
  health_contribution  INTEGER DEFAULT 0,        -- points from strategy health (Phase 1)
  calibration_factor   REAL    DEFAULT 1.0,      -- multiplier from calibration overconfidence
  active_vetoes        INTEGER DEFAULT 0,        -- count of active vetoes considered
  rationale            TEXT,                     -- JSON array of trigger strings
  applied_count        INTEGER DEFAULT 0         -- signals blocked since last gate change
);
CREATE INDEX IF NOT EXISTS idx_sg_strategy ON signal_gates(strategy_name, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sg_status   ON signal_gates(gate_status, evaluated_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- INTELLIGENCE ENGINE — Phase 6: Entry / Stop / TP / Frequency Agents
-- ════════════════════════════════════════════════════════════════════════════

-- Entry type performance analysis — workers/entry-agent-worker.js (daily 7 AM UTC).
-- Cross-dimensional: entry_type, entry_type × session, entry_type × regime, time_in_session.
CREATE TABLE IF NOT EXISTS entry_analysis (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name   TEXT    NOT NULL,
  dimension       TEXT    NOT NULL,
  dimension_value TEXT    NOT NULL,
  period_days     INTEGER NOT NULL DEFAULT 30,
  sample_size     INTEGER NOT NULL DEFAULT 0,
  win_rate        REAL,
  baseline_wr     REAL,
  wr_delta        REAL,
  significance    TEXT,
  computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, dimension, dimension_value, period_days)
);
CREATE INDEX IF NOT EXISTS idx_enta_strategy ON entry_analysis(strategy_name, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_enta_sig      ON entry_analysis(significance, wr_delta DESC);

-- Stop-loss quality analysis — workers/stop-agent-worker.js (every 6h).
-- Tracks stop distance vs MAE; detects stops that are too tight.
CREATE TABLE IF NOT EXISTS stop_analysis (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name        TEXT    NOT NULL,
  dimension            TEXT    NOT NULL,
  dimension_value      TEXT    NOT NULL,
  period_days          INTEGER NOT NULL DEFAULT 90,
  sample_size          INTEGER NOT NULL DEFAULT 0,
  avg_sl_pts           REAL,
  avg_mae_pts          REAL,
  mae_sl_ratio         REAL,
  stop_too_tight_pct   REAL,   -- % wins where MAE > stop distance
  avg_sl_atr_ratio     REAL,   -- avg stop / ATR
  optimal_sl_atr       REAL,   -- empirical p80 MAE/ATR (floor for stop sizing)
  win_rate             REAL,
  computed_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, dimension, dimension_value, period_days)
);
CREATE INDEX IF NOT EXISTS idx_stpa_strategy ON stop_analysis(strategy_name, computed_at DESC);

-- Take-profit efficiency analysis — workers/tp-agent-worker.js (every 6h).
-- Computes TP hit rates using MFE vs TP level distance.
CREATE TABLE IF NOT EXISTS tp_analysis (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name   TEXT    NOT NULL,
  dimension       TEXT    NOT NULL,
  dimension_value TEXT    NOT NULL,
  period_days     INTEGER NOT NULL DEFAULT 90,
  sample_size     INTEGER NOT NULL DEFAULT 0,
  tp1_hit_rate    REAL,   -- % of resolved trades where mfe_pts >= tp1 distance
  tp2_hit_rate    REAL,
  tp3_hit_rate    REAL,
  avg_mfe_pts     REAL,
  avg_tp1_pts     REAL,
  avg_tp2_pts     REAL,
  avg_rr          REAL,
  win_rate        REAL,
  computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, dimension, dimension_value, period_days)
);
CREATE INDEX IF NOT EXISTS idx_tpa_strategy ON tp_analysis(strategy_name, computed_at DESC);

-- Signal rejection frequency analysis — workers/frequency-agent-worker.js (every 4h).
-- Analyzes near-miss rejections from signal_rejections to find over-filtered setups.
CREATE TABLE IF NOT EXISTS frequency_analysis (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_name    TEXT    NOT NULL,
  instrument       TEXT    NOT NULL DEFAULT 'ALL',
  dimension        TEXT    NOT NULL,
  dimension_value  TEXT    NOT NULL,
  period_days      INTEGER NOT NULL DEFAULT 30,
  rejection_count  INTEGER NOT NULL DEFAULT 0,
  avg_score_gap    REAL,
  pct_of_total     REAL,
  computed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(strategy_name, instrument, dimension, dimension_value, period_days)
);
CREATE INDEX IF NOT EXISTS idx_frqa_strategy ON frequency_analysis(strategy_name, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_frqa_pct      ON frequency_analysis(pct_of_total DESC, computed_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- DB PARTS 1 & 2 — Signal Lifecycle + Notification Log (Prompt #7)
-- ════════════════════════════════════════════════════════════════════════════

-- Notification delivery log — one row per notification event per signal.
-- Tracks every ntfy push and email fallback: latency, success, channel.
-- Enables: delivery rate, avg latency, per-channel success rate, /api/health.
CREATE TABLE IF NOT EXISTS notification_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   INTEGER REFERENCES signals(id) ON DELETE CASCADE,
  event_type  TEXT    NOT NULL,  -- TRADE_ENTRY | WIN | LOSS | BE | EXPIRED | TEST
  channel     TEXT    NOT NULL DEFAULT 'ntfy',  -- ntfy | email | both
  title       TEXT,
  sent_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  success     INTEGER NOT NULL DEFAULT 1,  -- 1=delivered 0=failed
  latency_s   REAL,                        -- seconds from signal received_at to sent_at
  error_msg   TEXT                         -- populated if success=0
);
CREATE INDEX IF NOT EXISTS idx_notif_signal ON notification_log(signal_id);
CREATE INDEX IF NOT EXISTS idx_notif_type   ON notification_log(event_type, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_sent   ON notification_log(sent_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- DB PART 5 — trade_dna materialized table (Prompt #7)
-- ════════════════════════════════════════════════════════════════════════════

-- Materialized join of signals + outcomes + backtest_trades.
-- Rebuilt nightly by workers/trade-dna-worker.js (4:30 AM UTC).
-- Provides a single flat table of all resolved trades with pre-computed
-- ratios that stop-agent, tp-agent, and future ML models can query directly.
CREATE TABLE IF NOT EXISTS trade_dna (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,   -- LIVE | BACKTEST
  signal_id     INTEGER,            -- live trades: references signals(id)
  bt_trade_id   INTEGER,            -- backtest trades: references backtest_trades(id)
  strategy_name TEXT    NOT NULL,
  instrument    TEXT,
  direction     TEXT,
  outcome       TEXT    NOT NULL,   -- WIN | LOSS | BE
  session       TEXT,
  regime        TEXT,
  hour_et       INTEGER,            -- 0–23 ET hour at entry bar
  trade_date    TEXT,               -- YYYY-MM-DD
  entry         REAL,
  sl            REAL,
  tp1           REAL,
  sl_pts        REAL,               -- ABS(entry - sl)
  tp1_pts       REAL,               -- ABS(tp1 - entry)
  rr_planned    REAL,               -- tp1_pts / sl_pts
  pnl_pts       REAL,
  mfe_pts       REAL,               -- Maximum Favorable Excursion
  mae_pts       REAL,               -- Maximum Adverse Excursion
  hold_time_min REAL,
  exit_type     TEXT,               -- TP_HIT | SL_HIT | TIMEOUT
  -- pre-computed ratios (key ML features)
  mfe_sl_ratio  REAL,               -- mfe_pts / sl_pts (1.0 = full risk recovered)
  mae_sl_ratio  REAL,               -- mae_pts / sl_pts (1.0 = touched stop)
  rr_achieved   REAL,               -- mfe_pts / tp1_pts (1.0 = TP fully hit)
  -- from signal_features (live trades only)
  confidence    INTEGER,
  archetype     TEXT,
  entry_type    TEXT,
  htf_bias      TEXT,
  atr           REAL,
  rsi           REAL,
  refreshed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dna_strategy  ON trade_dna(strategy_name, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_dna_outcome   ON trade_dna(outcome, strategy_name);
CREATE INDEX IF NOT EXISTS idx_dna_source    ON trade_dna(source, strategy_name);
CREATE INDEX IF NOT EXISTS idx_dna_refreshed ON trade_dna(refreshed_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- DB PART 6 — Performance indexes + query planner hints (Prompt #7)
-- ════════════════════════════════════════════════════════════════════════════

-- Compound index for reconcile-worker _getPending: strategy + status + time
CREATE INDEX IF NOT EXISTS idx_signals_status_strat
  ON signals(strategy_name, trade_status, received_at DESC);

-- Outcome result lookups for stop-agent and tp-agent rolling windows
CREATE INDEX IF NOT EXISTS idx_outcomes_result
  ON outcomes(result, exit_at DESC);

-- Loss forensics grouping by strategy + category
CREATE INDEX IF NOT EXISTS idx_lf_strat_cat
  ON loss_forensics(strategy_name, failure_category, created_at DESC);

-- Partial index: consensus reads only pending messages (eliminates full-table scan)
CREATE INDEX IF NOT EXISTS idx_am_pending
  ON agent_messages(priority, created_at) WHERE status = 'pending';

-- Frequency-agent near-miss scans by strategy + time
CREATE INDEX IF NOT EXISTS idx_rejections_strat
  ON signal_rejections(strategy, rejected_at DESC);

-- is_latest flag: replaces correlated subquery in digest-worker + health queries.
-- strategy-health-worker sets is_latest=1 on new snapshot, clears 0 on older rows.
-- Migration: ALTER TABLE adds column to existing DBs (server.js applyMigrations).
-- ALTER TABLE strategy_health_snapshots ADD COLUMN is_latest INTEGER NOT NULL DEFAULT 0;

-- ════════════════════════════════════════════════════════════════════════════
-- EDGE AUDIT — Part 4: Multi-TP Backtest Results
-- ════════════════════════════════════════════════════════════════════════════

-- Weekly comparison written by workers/multi-tp-backtest-worker.js (Tue 06:30 UTC).
-- Simulates BASE vs M1.5 (50%@TP1+trail to 1.5R) vs M2.0 (50%@TP1+trail to 2R)
-- against stored trade_dna data. rr_achieved >= tp2_ratio → TP2 would have been hit.
CREATE TABLE IF NOT EXISTS backtest_multi_tp (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date             TEXT    NOT NULL,
  strategy_name        TEXT    NOT NULL,
  lookback_days        INTEGER NOT NULL DEFAULT 90,
  total_trades         INTEGER,
  -- Base model (current — all-in at TP1)
  base_wr              REAL,
  base_total_pnl       REAL,
  base_avg_pnl         REAL,
  -- Multi-TP 1.5R model
  m15_wr               REAL,
  m15_total_pnl        REAL,
  m15_avg_pnl          REAL,
  m15_tp2_hit_pct      REAL,   -- fraction of WIN trades where MFE reached 1.5× TP1
  -- Multi-TP 2.0R model
  m20_wr               REAL,
  m20_total_pnl        REAL,
  m20_avg_pnl          REAL,
  m20_tp2_hit_pct      REAL,   -- fraction of WIN trades where MFE reached 2.0× TP1
  -- Summary
  best_model           TEXT,   -- BASE | M15 | M20
  pnl_improvement_pct  REAL,   -- best_model P&L vs base_total_pnl (percent)
  computed_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_date, strategy_name)
);
CREATE INDEX IF NOT EXISTS idx_mtp_date ON backtest_multi_tp(run_date DESC);
