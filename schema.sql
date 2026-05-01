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
