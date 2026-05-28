'use strict';

/**
 * SIGNAL DEDUPLICATION ENGINE
 *
 * Replaces the basic in-memory fingerprint Map with a professional fuzzy-match
 * system that reasons about TRADE IDEAS, not individual candle events.
 *
 * Key upgrades over signal-fingerprint.js:
 *  • Strategy FAMILY grouping — one fingerprint slot per family prevents
 *    duplicate alerts for the same entry zone.
 *  • Wider fuzzy tolerances — MNQ ±10 pts, MGC ±2.5 pts (was ±7.5 / ±1.5).
 *  • SL zone included in fingerprint — prevents over-blocking setups with
 *    genuinely different risk structures at similar entries.
 *  • Per-strategy suppression windows — swing holds 4 h, scalp holds 15 min.
 *  • Session-aware — intraday fingerprints include the session so the same
 *    setup in a new session is always allowed through.
 *  • SQLite persistence — survives app restarts; unexpired ideas reload on init.
 *  • Lifecycle release — call releaseBySignal() when a trade hits TP or SL
 *    so the slot opens immediately for a fresh setup on the same instrument.
 *  • Detailed suppression logging — every blocked signal logs exactly why.
 */

// ── Strategy family definitions ───────────────────────────────────────────────
// Signals in the same family compete for the same fingerprint slot.
// One alert per family per trade idea per suppression window.
const FAMILY = {
  MNQ_INTRADAY: 'MNQ_MOMENTUM',
  MGC_SCALP:    'MGC',
  NQ_NY_OPEN:   'NQ_NY_OPEN',   // own family — never suppressed by MNQ_INTRADAY
};

// Entry zone bucket sizes.  Half-bucket = the effective ±tolerance per side.
//   MNQ bucket=20 → entries within ±10 pts map to the same bucket
//   MGC bucket=5  → entries within ±2.5 pts map to the same bucket
const ENTRY_BUCKET = { MNQ: 20, MGC: 5 };

// SL zone bucket sizes — kept for logging context but NOT part of the fingerprint key.
// Including SL caused false misses when two strategies describe the same idea with
// marginally different SL placements between strategies in the same family.
const SL_BUCKET = { MNQ: 30, MGC: 8 }; // retained for reference

// Per-strategy suppression window (ms).  A second signal matching the same
// fingerprint within this window is silently suppressed.
const TTL_MS = {
  MNQ_INTRADAY: 30 * 60_000,     // 30 min
  MGC_SCALP:    15 * 60_000,     // 15 min
  NQ_NY_OPEN:   24 * 60 * 60_000, // one per day — suppress any re-fire for 24h
};
const TTL_DEFAULT = 30 * 60_000;

const SESSION_AGNOSTIC = new Set();

// ── In-memory registry ────────────────────────────────────────────────────────
// Map<key, { expiryMs, entry, sl, strategy, session, family, instrument, direction }>
const _registry = new Map();

// ── SQLite persistence ────────────────────────────────────────────────────────
let _db         = null;
let _stmtUpsert = null;
let _stmtClaim  = null;   // INSERT OR IGNORE — used for atomic cross-process dedup claim
let _stmtFetch  = null;   // SELECT by key — cross-process check before registering
let _stmtDel    = null;
let _stmtPurge  = null;

function _initDb(db) {
  if (_db) return;
  _db = db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS dedup_ideas (
      key        TEXT    PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      instrument TEXT    NOT NULL,
      direction  TEXT    NOT NULL,
      family     TEXT    NOT NULL,
      strategy   TEXT    NOT NULL,
      session    TEXT,
      entry      REAL    NOT NULL,
      sl         REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dedup_expires ON dedup_ideas(expires_at);
  `);

  _stmtUpsert = db.prepare(`
    INSERT OR REPLACE INTO dedup_ideas
      (key, expires_at, instrument, direction, family, strategy, session, entry, sl)
    VALUES
      (@key, @expires_at, @instrument, @direction, @family, @strategy, @session, @entry, @sl)
  `);
  // Atomic claim: INSERT OR IGNORE returns changes=0 if another process already holds the key.
  // This is the cross-process dedup guard — only one process wins the INSERT race.
  _stmtClaim = db.prepare(`
    INSERT OR IGNORE INTO dedup_ideas
      (key, expires_at, instrument, direction, family, strategy, session, entry, sl)
    VALUES
      (@key, @expires_at, @instrument, @direction, @family, @strategy, @session, @entry, @sl)
  `);
  _stmtFetch = db.prepare('SELECT * FROM dedup_ideas WHERE key = ? AND expires_at > ?');
  _stmtDel   = db.prepare('DELETE FROM dedup_ideas WHERE key = ?');
  _stmtPurge = db.prepare('DELETE FROM dedup_ideas WHERE expires_at <= ?');

  // Reload unexpired ideas into memory on startup (restart survival)
  const rows = db.prepare('SELECT * FROM dedup_ideas WHERE expires_at > ?').all(Date.now());
  for (const r of rows) {
    _registry.set(r.key, {
      expiryMs:   r.expires_at,
      instrument: r.instrument,
      direction:  r.direction,
      family:     r.family,
      strategy:   r.strategy,
      session:    r.session,
      entry:      r.entry,
      sl:         r.sl,
    });
  }
  if (rows.length > 0) {
    console.log(`[dedup] Restored ${rows.length} active trade idea(s) from DB after restart`);
  }
}

// ── Key construction ──────────────────────────────────────────────────────────
function _buildKey(sig) {
  const family   = FAMILY[sig.strategy_name] || sig.strategy_name;
  const eBkt     = Math.round(sig.entry / (ENTRY_BUCKET[sig.instrument] ?? 20));
  const sessPart = SESSION_AGNOSTIC.has(sig.strategy_name) ? '' : `:${sig.session ?? 'ANY'}`;
  return `${family}:${sig.instrument}:${sig.direction}${sessPart}:${eBkt}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize with the SQLite database.  Call once at startup.
 */
function init(db) {
  _initDb(db);
}

/**
 * Check whether a signal duplicates an active trade idea, and register it if not.
 *
 * @param {object} sig
 * @returns {{ isDuplicate: boolean, key: string, suppressLog: string|null }}
 */
function checkAndRegister(sig) {
  const now = Date.now();

  // Lazy cleanup of expired entries
  for (const [k, v] of _registry) {
    if (v.expiryMs <= now) {
      _registry.delete(k);
      if (_stmtDel) { try { _stmtDel.run(k); } catch { /* non-fatal */ } }
    }
  }

  const key      = _buildKey(sig);
  const existing = _registry.get(key);

  if (existing && existing.expiryMs > now) {
    const entryDiff = Math.abs(existing.entry - sig.entry).toFixed(1);
    const minsLeft  = Math.round((existing.expiryMs - now) / 60_000);
    const suppressLog =
      `Suppressed duplicate ${sig.instrument} ${sig.direction} [${sig.strategy_name}]: ` +
      `entry ${sig.entry} matched active [${existing.strategy}] idea ` +
      `within ${entryDiff} pts, session ${sig.session ?? 'unknown'}, ` +
      `window expires in ${minsLeft} min`;
    return { isDuplicate: true, key, suppressLog };
  }

  // Not in memory — also check DB before registering (cross-process dedup guard).
  // Two processes can pass the in-memory check simultaneously; the DB is the
  // shared source of truth that catches the race.
  if (_stmtFetch) {
    try {
      const dbRow = _stmtFetch.get(key, now);
      if (dbRow) {
        // Another process already registered this idea — sync to memory and suppress.
        _registry.set(key, {
          expiryMs: dbRow.expires_at, instrument: dbRow.instrument,
          direction: dbRow.direction, family: dbRow.family,
          strategy: dbRow.strategy, session: dbRow.session,
          entry: dbRow.entry, sl: dbRow.sl,
        });
        const entryDiff = Math.abs(dbRow.entry - sig.entry).toFixed(1);
        const minsLeft  = Math.round((dbRow.expires_at - now) / 60_000);
        return {
          isDuplicate: true, key,
          suppressLog: `Suppressed cross-process duplicate ${sig.instrument} ${sig.direction} ` +
            `[${sig.strategy_name}]: entry ${sig.entry} matched DB idea [${dbRow.strategy}] ` +
            `within ${entryDiff} pts, session ${sig.session ?? 'unknown'}, ` +
            `window expires in ${minsLeft} min`,
        };
      }
    } catch { /* non-fatal — fall through to normal registration */ }
  }

  // Not a duplicate — register the new idea
  const ttlMs  = TTL_MS[sig.strategy_name] ?? TTL_DEFAULT;
  const expiry = now + ttlMs;

  const record = {
    expiryMs:   expiry,
    instrument: sig.instrument,
    direction:  sig.direction,
    family:     FAMILY[sig.strategy_name] || sig.strategy_name,
    strategy:   sig.strategy_name,
    session:    sig.session ?? null,
    entry:      sig.entry,
    sl:         sig.sl ?? 0,
  };
  _registry.set(key, record);

  if (_stmtClaim) {
    try {
      // Atomic INSERT OR IGNORE: if another process races and inserts first,
      // changes=0 means we're the duplicate — abort our signal.
      const info = _stmtClaim.run({ key, expires_at: expiry, ...record });
      if (info.changes === 0) {
        // Lost the race — the other process's signal is already committed.
        // Remove the in-memory entry we just set so we stay consistent with DB.
        _registry.delete(key);
        return {
          isDuplicate: true, key,
          suppressLog: `Suppressed race-condition duplicate ${sig.instrument} ${sig.direction} ` +
            `[${sig.strategy_name}]: another process claimed dedup slot for entry ${sig.entry}`,
        };
      }
      _stmtPurge.run(now);
    } catch { /* non-fatal */ }
  }

  return { isDuplicate: false, key, suppressLog: null };
}

/**
 * Release a trade idea's fingerprint slot when the signal resolves (TP or SL hit).
 * Allows a genuinely new setup at the same price zone to alert immediately
 * instead of waiting for the suppression window to expire.
 *
 * @param {object} sig  - the resolved signal (needs instrument, direction,
 *                        strategy_name, entry, sl, session fields)
 */
function releaseBySignal(sig) {
  const key = _buildKey(sig);
  _registry.delete(key);
  if (_stmtDel) { try { _stmtDel.run(key); } catch { /* non-fatal */ } }
}

/**
 * Expire a key manually (testing / admin).
 */
function expire(key) {
  _registry.delete(key);
  if (_stmtDel) { try { _stmtDel.run(key); } catch { /* non-fatal */ } }
}

/** Clear entire registry (testing). */
function clear() {
  _registry.clear();
}

module.exports = { init, checkAndRegister, releaseBySignal, expire, clear, FAMILY, TTL_MS, ENTRY_BUCKET, SL_BUCKET };
