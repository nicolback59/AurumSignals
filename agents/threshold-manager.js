'use strict';

/**
 * THRESHOLD MANAGER — AI-driven live threshold store
 *
 * Singleton that owns the effective thresholds used by signal-ranker and
 * quant-scorer.  The AI forensics analyst writes changes here; all other
 * code reads from here.
 *
 * Priority chain:
 *   1. DB row in ai_thresholds (written by forensics analyst)
 *   2. Inline fallback constants (matches code defaults)
 *
 * Hot-path safety: values are cached in memory (5-min TTL) so rankSignal()
 * never touches the DB synchronously during a scan cycle.
 *
 * Keys stored in ai_thresholds.key:
 *   LIVE_THRESHOLD:<strategy>      — raw confidence minimum for live ntfy
 *   STRONG_A                       — quant-scorer A-grade minimum to be live
 *   SESSION_BLOCK:<strategy>:<session>  — 'BLOCK' | 'ALLOW'
 */

// ── Inline defaults (kept in sync with confidence-scorer.js / quant-scorer.js) ─
const DEFAULT_LIVE = {
  MNQ_INTRADAY: 67,
  MGC_SCALP:    57,
  MNQ_SWING:    85,
  MNQ_50PT:     86,
  MGC_INTRADAY: 60,
};
const DEFAULT_STRONG_A = 71;

// ── Safety bounds for AI changes ─────────────────────────────────────────────
// max_delta: max change allowed in a single weekly run
const BOUNDS = {
  'LIVE_THRESHOLD:MNQ_INTRADAY': { min: 65, max: 82, max_delta: 5 },
  'LIVE_THRESHOLD:MGC_SCALP':    { min: 57, max: 75, max_delta: 5 },
  'STRONG_A':                    { min: 68, max: 78, max_delta: 4 },
};

const CACHE_TTL_MS = 5 * 60 * 1000;

class ThresholdManager {
  constructor() {
    this._db          = null;
    this._cache       = null;
    this._cacheAt     = 0;
    this.initialized  = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  init(db) {
    this._db         = db;
    this.initialized = true;
    this._createTable();
    this._refresh();
  }

  _createTable() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS ai_thresholds (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        key            TEXT    NOT NULL,
        value          TEXT    NOT NULL,
        previous_value TEXT,
        reason         TEXT,
        week_start     TEXT,
        applied_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        rolled_back    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ai_thresholds_key
        ON ai_thresholds(key, rolled_back, applied_at DESC);
    `);
  }

  // ── Cache ────────────────────────────────────────────────────────────────────

  _refresh() {
    if (!this._db) return;
    try {
      const rows = this._db.prepare(
        `SELECT key, value FROM ai_thresholds
         WHERE  rolled_back = 0
         ORDER  BY applied_at DESC`
      ).all();

      const live     = { ...DEFAULT_LIVE };
      const blocks   = {};   // 'MGC_SCALP:ASIAN' → true/false
      let   strongA  = DEFAULT_STRONG_A;
      const seen     = new Set();

      for (const row of rows) {
        if (seen.has(row.key)) continue; // keep most recent per key
        seen.add(row.key);

        if (row.key.startsWith('LIVE_THRESHOLD:')) {
          const strat = row.key.slice('LIVE_THRESHOLD:'.length);
          live[strat] = Number(row.value);
        } else if (row.key === 'STRONG_A') {
          strongA = Number(row.value);
        } else if (row.key.startsWith('SESSION_BLOCK:')) {
          const parts = row.key.split(':');
          blocks[`${parts[1]}:${parts[2]}`] = row.value === 'BLOCK';
        }
      }

      this._cache   = { live, strongA, blocks };
      this._cacheAt = Date.now();
    } catch (err) {
      console.error('[threshold-manager] cache refresh failed:', err.message);
    }
  }

  _get() {
    if (!this._cache || Date.now() - this._cacheAt > CACHE_TTL_MS) {
      this._refresh();
    }
    return this._cache ?? { live: DEFAULT_LIVE, strongA: DEFAULT_STRONG_A, blocks: {} };
  }

  // ── Read API (hot path — uses cache) ─────────────────────────────────────────

  getLiveThreshold(strategy) {
    return this._get().live[strategy] ?? DEFAULT_LIVE[strategy] ?? 0;
  }

  getStrongA() {
    return this._get().strongA ?? DEFAULT_STRONG_A;
  }

  isSessionBlocked(strategy, session) {
    return this._get().blocks[`${strategy}:${session}`] === true;
  }

  // ── Write API (called by forensics analyst) ──────────────────────────────────

  /**
   * Apply a single threshold change with safety checks.
   * Returns { ok, id, clamped, reason } — id is null if rejected or no-op.
   */
  applyChange(key, rawNewValue, reason, weekStart) {
    if (!this._db) return { ok: false, reason: 'not initialised' };

    const newValue = Number(rawNewValue);
    if (isNaN(newValue) && !['BLOCK', 'ALLOW'].includes(rawNewValue)) {
      return { ok: false, reason: `invalid value: ${rawNewValue}` };
    }

    // Get current effective value
    let currentValue;
    if (key.startsWith('LIVE_THRESHOLD:')) {
      currentValue = this.getLiveThreshold(key.slice('LIVE_THRESHOLD:'.length));
    } else if (key === 'STRONG_A') {
      currentValue = this.getStrongA();
    } else if (key.startsWith('SESSION_BLOCK:')) {
      const parts = key.split(':');
      currentValue = this.isSessionBlocked(parts[1], parts[2]) ? 'BLOCK' : 'ALLOW';
    } else {
      return { ok: false, reason: `unknown key: ${key}` };
    }

    // Session blocks don't need bounds/delta checks
    if (key.startsWith('SESSION_BLOCK:')) {
      if (currentValue === rawNewValue) return { ok: true, id: null, reason: 'no change' };
      const id = this._write(key, rawNewValue, currentValue, reason, weekStart);
      this._refresh();
      return { ok: true, id, clamped: false };
    }

    // Numeric: bounds + max delta
    const bounds = BOUNDS[key];
    if (bounds) {
      if (newValue < bounds.min || newValue > bounds.max) {
        return { ok: false, reason: `${newValue} out of bounds [${bounds.min}, ${bounds.max}]` };
      }
      const delta = newValue - currentValue;
      if (Math.abs(delta) > bounds.max_delta) {
        // Clamp to max_delta — still apply but limited change
        const clamped = currentValue + Math.sign(delta) * bounds.max_delta;
        console.log(`[threshold-manager] ${key}: clamped ${newValue} → ${clamped} (max delta ${bounds.max_delta})`);
        if (clamped === currentValue) return { ok: true, id: null, reason: 'no change after clamp' };
        const id = this._write(key, clamped, currentValue, reason + ` [clamped from ${newValue}]`, weekStart);
        this._refresh();
        return { ok: true, id, clamped: true, effective: clamped };
      }
    }

    if (newValue === currentValue) return { ok: true, id: null, reason: 'no change' };

    const id = this._write(key, newValue, currentValue, reason, weekStart);
    this._refresh();
    return { ok: true, id, clamped: false };
  }

  _write(key, value, previousValue, reason, weekStart) {
    return this._db.prepare(`
      INSERT INTO ai_thresholds (key, value, previous_value, reason, week_start)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, String(value), String(previousValue ?? ''), reason ?? '', weekStart ?? '').lastInsertRowid;
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

  rollback(id) {
    if (!this._db) return false;
    const info = this._db.prepare(
      `UPDATE ai_thresholds SET rolled_back = 1 WHERE id = ? AND rolled_back = 0`
    ).run(id);
    if (info.changes) this._refresh();
    return info.changes > 0;
  }

  getChangeLog(limit = 50) {
    if (!this._db) return [];
    return this._db.prepare(
      `SELECT * FROM ai_thresholds ORDER BY applied_at DESC LIMIT ?`
    ).all(limit);
  }

  getCurrentEffective() {
    const c = this._get();
    return {
      live_thresholds: c.live,
      strong_a:        c.strongA,
      session_blocks:  c.blocks,
      code_defaults: {
        live_thresholds: DEFAULT_LIVE,
        strong_a:        DEFAULT_STRONG_A,
      },
    };
  }
}

// Singleton — one instance per process
module.exports = new ThresholdManager();
