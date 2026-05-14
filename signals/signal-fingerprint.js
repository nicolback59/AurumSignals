'use strict';

/**
 * SIGNAL FINGERPRINT — deduplication within a rolling time window
 *
 * Builds a compact hash from:
 *   instrument : strategy_name : direction : entry (quantized to 0.5 pts)
 *
 * If the same fingerprint was seen within TTL_MS (default 2 hours), the signal
 * is considered a duplicate and is rejected. This prevents the same setup from
 * firing repeatedly across consecutive scan ticks when the market is ranging.
 *
 * The registry is in-process memory (Map). It is cleared on process restart,
 * which is acceptable — a crash-restart naturally resets the dedup window.
 */

const crypto = require('crypto');

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Map<fingerprint, expiryMs>
const _registry = new Map();

/**
 * Quantize entry price to the nearest bucket so small price drifts between
 * scans don't generate a unique fingerprint for what is effectively the same setup.
 *
 * MNQ: bucket = 2.5 pts  (5 ticks × 0.5 per tick)
 * MGC: bucket = 0.5 pts
 */
function _quantize(entry, instrument) {
  const bucket = instrument === 'MNQ' ? 2.5 : 0.5;
  return Math.round(entry / bucket) * bucket;
}

/**
 * Compute the fingerprint string (hex, first 16 chars).
 */
function fingerprint(sig) {
  const qEntry = _quantize(sig.entry ?? 0, sig.instrument ?? 'MNQ');
  const key    = `${sig.instrument}:${sig.strategy_name}:${sig.direction}:${qEntry}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Check if a signal is a duplicate and register it if not.
 *
 * @param {object} sig
 * @param {number} [ttlMs] - override TTL in ms
 * @returns {{ isDuplicate: boolean, fp: string }}
 */
function checkAndRegister(sig, ttlMs = TTL_MS) {
  // Evict expired entries (lazy cleanup)
  const now = Date.now();
  for (const [fp, expiry] of _registry) {
    if (expiry <= now) _registry.delete(fp);
  }

  const fp = fingerprint(sig);
  if (_registry.has(fp)) {
    return { isDuplicate: true, fp };
  }

  _registry.set(fp, now + ttlMs);
  return { isDuplicate: false, fp };
}

/**
 * Manually expire a fingerprint (e.g., if a signal was rejected, allow retry sooner).
 */
function expire(fp) {
  _registry.delete(fp);
}

/**
 * Clear the entire registry (testing / process restart).
 */
function clear() {
  _registry.clear();
}

module.exports = { checkAndRegister, fingerprint, expire, clear, TTL_MS };
