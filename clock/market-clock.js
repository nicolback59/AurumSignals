'use strict';

/**
 * MARKET CLOCK — Pacific-time market hours + session classification
 *
 * All logic is America/Los_Angeles (PT). Times shown are PT:
 *   Weekly blackout  : Fri 13:00 → Sun 15:00  (CME Globex weekend close)
 *   Daily blackout   : Mon–Fri 13:00–14:59     (CME daily maintenance window)
 *
 * Session windows (all PT):
 *   ASIAN       : 18:00–22:59 (prior day)
 *   LONDON      : 23:00–05:59
 *   NY_PRE      : 06:00–08:29
 *   NY_OPEN     : 08:30–09:44  (RTH open — highest volatility)
 *   POWER_HOUR  : 09:45–10:59
 *   MIDDAY      : 11:00–12:59
 *   NY_CLOSE    : 15:00–16:59  (RTH close)
 *   OVERNIGHT   : 17:00–17:59  (brief globex transition)
 *   BLACKOUT    : maintenance / weekend
 */

const { DateTime } = require('luxon');

const TZ = 'America/Los_Angeles';

// Session definitions (ranges are inclusive, hour:minute in PT)
const SESSIONS = [
  {
    name: 'BLACKOUT',
    confidenceModifier: 0,
    sessionWeight: 0,
    minTier: 'IGNORE',
  },
  {
    name: 'NY_OPEN',
    startH: 8, startM: 30, endH: 9, endM: 44,
    confidenceModifier: 1.15,
    sessionWeight: 10,
    minTier: 'B',
  },
  {
    name: 'POWER_HOUR',
    startH: 9, startM: 45, endH: 10, endM: 59,
    confidenceModifier: 1.10,
    sessionWeight: 9,
    minTier: 'B',
  },
  {
    name: 'LONDON',
    startH: 23, startM: 0, endH: 5, endM: 59,
    confidenceModifier: 1.05,
    sessionWeight: 8,
    minTier: 'B',
  },
  {
    name: 'NY_PRE',
    startH: 6, startM: 0, endH: 8, endM: 29,
    confidenceModifier: 0.95,
    sessionWeight: 6,
    minTier: 'A',
  },
  {
    name: 'MIDDAY',
    startH: 11, startM: 0, endH: 12, endM: 59,
    confidenceModifier: 0.90,
    sessionWeight: 5,
    minTier: 'A',
  },
  {
    name: 'NY_CLOSE',
    startH: 15, startM: 0, endH: 16, endM: 59,
    confidenceModifier: 0.88,
    sessionWeight: 5,
    minTier: 'A',
  },
  {
    name: 'ASIAN',
    startH: 18, startM: 0, endH: 22, endM: 59,
    confidenceModifier: 0.80,
    sessionWeight: 3,
    minTier: 'S',
  },
  {
    name: 'OVERNIGHT',
    startH: 17, startM: 0, endH: 17, endM: 59,
    confidenceModifier: 0.70,
    sessionWeight: 1,
    minTier: 'IGNORE',
  },
];

/**
 * Determine if a given DateTime (PT) falls in a hard blackout.
 * Blackout = weekly (Fri 13:00 → Sun 15:00) or daily maintenance (Mon–Fri 13:00–14:59).
 */
function isBlackout(dt) {
  const dow  = dt.weekday; // 1=Mon … 7=Sun
  const hour = dt.hour;
  const min  = dt.minute;
  const hm   = hour * 60 + min;

  // Weekly: Friday 13:00 PT onward
  if (dow === 5 && hm >= 13 * 60) return true;
  // Weekly: Saturday all day
  if (dow === 6) return true;
  // Weekly: Sunday before 15:00 PT
  if (dow === 7 && hm < 15 * 60) return true;

  // Daily maintenance: Mon–Thu 13:00–14:59 PT
  if (dow >= 1 && dow <= 4 && hm >= 13 * 60 && hm < 15 * 60) return true;
  // Friday maintenance: 13:00+ already covered by weekly blackout above

  return false;
}

/**
 * Match a Pacific-time hour+minute against a session that may wrap midnight.
 */
function inSessionWindow(dt, sess) {
  const startHm = sess.startH * 60 + sess.startM;
  const endHm   = sess.endH  * 60 + sess.endM;
  const nowHm   = dt.hour    * 60 + dt.minute;

  if (startHm <= endHm) {
    return nowHm >= startHm && nowHm <= endHm;
  } else {
    // Wraps midnight (e.g., LONDON 23:00 → 05:59)
    return nowHm >= startHm || nowHm <= endHm;
  }
}

/**
 * Classify the current moment into a session.
 *
 * @param {Date|string|null} [now]  - optional override for testing; defaults to Date.now()
 * @returns {{ session: string, meta: object, isBlackout: boolean, dt: DateTime }}
 */
function classifyNow(now = null) {
  const dt = now
    ? DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone: TZ })
    : DateTime.now().setZone(TZ);

  if (isBlackout(dt)) {
    return {
      session:    'BLACKOUT',
      meta:       SESSIONS[0],
      isBlackout: true,
      dt,
    };
  }

  for (const sess of SESSIONS.slice(1)) {
    if (inSessionWindow(dt, sess)) {
      return { session: sess.name, meta: sess, isBlackout: false, dt };
    }
  }

  // No window matched — treat as OVERNIGHT (gap between sessions)
  const overnight = SESSIONS.find(s => s.name === 'OVERNIGHT');
  return { session: 'OVERNIGHT', meta: overnight, isBlackout: false, dt };
}

/**
 * Return ms until the next non-blackout window opens.
 * Useful for watcher to schedule a wake-up instead of burning CPU in blackout.
 */
function msUntilOpen() {
  const now = DateTime.now().setZone(TZ);
  if (!isBlackout(now)) return 0;

  // Walk forward minute-by-minute (max 3 days = 4320 minutes)
  for (let i = 1; i <= 4320; i++) {
    const candidate = now.plus({ minutes: i });
    if (!isBlackout(candidate)) {
      return i * 60 * 1000;
    }
  }
  return 24 * 60 * 60 * 1000; // fallback 24h
}

/**
 * Backwards-compatible session info matching the shape that shared-indicators
 * `getSessionInfo()` returns, so existing strategy code works unchanged.
 * Strategy files read: isLondon, isLondonNY, isNYOpen, isMidDay, isAftNoon,
 * quality, name.
 */
function getSessionInfoCompat(ts) {
  const { session, meta, isBlackout: blk } = classifyNow(ts ? new Date(ts) : null);
  return {
    name:        session,
    quality:     blk ? 0 : meta.confidenceModifier ?? 0.8,
    isLondon:    session === 'LONDON',
    isLondonNY:  session === 'NY_PRE',
    isNYOpen:    session === 'NY_OPEN' || session === 'POWER_HOUR',
    isMidDay:    session === 'MIDDAY',
    isAftNoon:   session === 'NY_CLOSE',
    isBlackout:  blk,
    sessionMeta: meta,
  };
}

module.exports = {
  classifyNow,
  isBlackout,
  msUntilOpen,
  getSessionInfoCompat,
  SESSIONS,
  TZ,
};
