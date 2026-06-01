'use strict';

/**
 * REGIME TRANSITION DETECTOR WORKER  (Prompt #15 Phase 8 — Red Team Foundation)
 *
 * Addresses the red-team finding: the scanner applies static regime multipliers
 * but ignores when regimes are in flux. Transitioning regimes have historically
 * lower hit rates — sizing should be reduced until stability is confirmed.
 *
 * Every 30 minutes (cron: every-30-min):
 *   1. Reads regime_states for each instrument over the last 6 hours
 *   2. Detects TRANSITION: regime changed within last 60 min
 *   3. Detects OSCILLATION: ≥ 3 distinct regimes within last 6 hours
 *   4. On detection → sets transitionSizeMult = 0.50 in ADAPTIVE_OVERRIDES
 *      for strategies using that instrument
 *   5. Auto-clears (transitionSizeMult = 1.00) after ≥ 2 hours of stable regime
 *   6. Writes to regime_transition_log
 *
 * scanner-core.js reads transitionSizeMult from ADAPTIVE_OVERRIDES and applies
 * it as a sizing factor (clamped [0.30, 1.00]).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME         = 'regime-transition-detector';
const LOOKBACK_HOURS      = 6;
const TRANSITION_MULT     = 0.50;
const STABLE_HOURS        = 2;    // hours of single regime before clearing transition flag

// Maps instrument → strategies that trade it
const INSTRUMENT_STRATEGIES = {
  MNQ: ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT'],
  MGC: ['MGC_SCALP'],
};
const INSTRUMENTS = Object.keys(INSTRUMENT_STRATEGIES);

// ── ADAPTIVE_OVERRIDES helpers ────────────────────────────────────────────────

function loadOverrides(db) {
  try {
    const row = db.prepare(
      "SELECT params_json FROM strategy_params WHERE key = 'ADAPTIVE_OVERRIDES'"
    ).get();
    return row?.params_json ? JSON.parse(row.params_json) : {};
  } catch (_) { return {}; }
}

function saveOverrides(db, overrides) {
  db.prepare(`
    INSERT INTO strategy_params (key, params_json, updated_at)
    VALUES ('ADAPTIVE_OVERRIDES', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      params_json = excluded.params_json,
      updated_at  = excluded.updated_at
  `).run(JSON.stringify(overrides));
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS regime_transition_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at          TEXT NOT NULL DEFAULT (datetime('now')),
      instrument          TEXT NOT NULL,
      detection_type      TEXT,
      current_regime      TEXT,
      previous_regime     TEXT,
      distinct_regimes    INTEGER,
      stable_hours        REAL,
      action              TEXT,
      strategies_affected TEXT,
      notes               TEXT
    )
  `).run();

  const insertLog = db.prepare(`
    INSERT INTO regime_transition_log
      (instrument, detection_type, current_regime, previous_regime,
       distinct_regimes, stable_hours, action, strategies_affected, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const overrides = loadOverrides(db);
  let overridesChanged = false;
  const newTransitions = [];

  for (const instrument of INSTRUMENTS) {
    try {
      // Pull regime history for last LOOKBACK_HOURS
      const history = db.prepare(`
        SELECT regime, classified_at
        FROM regime_states
        WHERE instrument = ?
          AND classified_at > datetime('now', '-${LOOKBACK_HOURS} hours')
        ORDER BY classified_at DESC
      `).all(instrument);

      if (!history.length) {
        insertLog.run(instrument, 'NO_DATA', null, null, 0, null, 'SKIP', null, 'No regime data in window');
        continue;
      }

      const currentRegime  = history[0].regime;
      const previousRegime = history.length > 1 ? history[1].regime : null;
      const distinctRegimes = new Set(history.map(r => r.regime)).size;

      // When did the current regime start?
      let stableHours = 0;
      for (const r of history) {
        if (r.regime === currentRegime) stableHours = (Date.now() - new Date(r.classified_at + 'Z').getTime()) / 3600000;
        else break;
      }
      // stableHours = hours since last regime that wasn't currentRegime
      let consecutiveCurrentCount = 0;
      for (const r of history) {
        if (r.regime === currentRegime) consecutiveCurrentCount++;
        else break;
      }
      // Approximate: stable since oldest consecutive entry of current regime
      if (consecutiveCurrentCount > 0 && consecutiveCurrentCount < history.length) {
        const oldestStable = history[consecutiveCurrentCount - 1];
        stableHours = (Date.now() - new Date(oldestStable.classified_at + 'Z').getTime()) / 3600000;
      } else if (consecutiveCurrentCount === history.length) {
        const oldestEntry = history[history.length - 1];
        stableHours = (Date.now() - new Date(oldestEntry.classified_at + 'Z').getTime()) / 3600000;
      }

      const isTransition = previousRegime && previousRegime !== currentRegime;
      const isOscillation = distinctRegimes >= 3;
      const isUnstable = isTransition || isOscillation;
      const isNowStable = !isUnstable && stableHours >= STABLE_HOURS;

      const strategies = INSTRUMENT_STRATEGIES[instrument] ?? [];
      let action = 'CLEAR';
      let detectionType = null;

      if (isUnstable) {
        detectionType = isOscillation ? 'OSCILLATION' : 'TRANSITION';
        action = `SET_TRANSITION_MULT_${TRANSITION_MULT}`;

        for (const strategy of strategies) {
          const ov = overrides[strategy] ?? {};
          if ((ov.transitionSizeMult ?? 1.0) !== TRANSITION_MULT) {
            ov.transitionSizeMult = TRANSITION_MULT;
            ov.transitionReason   = `${instrument}_${detectionType.toLowerCase()}_${currentRegime}`;
            overrides[strategy]   = ov;
            overridesChanged      = true;
          }
        }

        newTransitions.push({ instrument, detectionType, currentRegime, previousRegime, distinctRegimes });
        console.log(
          `[${WORKER_NAME}] ${instrument}: ${detectionType} detected ` +
          `(${currentRegime} after ${previousRegime ?? '?'}, ${distinctRegimes} distinct in ${LOOKBACK_HOURS}h) ` +
          `→ transitionSizeMult=${TRANSITION_MULT}`
        );
      } else if (isNowStable) {
        detectionType = 'STABLE_CLEARED';
        action = 'CLEARED_TRANSITION_MULT';

        for (const strategy of strategies) {
          const ov = overrides[strategy] ?? {};
          if (ov.transitionSizeMult && ov.transitionSizeMult !== 1.0) {
            ov.transitionSizeMult = 1.0;
            delete ov.transitionReason;
            overrides[strategy]   = ov;
            overridesChanged      = true;
          }
        }

        console.log(
          `[${WORKER_NAME}] ${instrument}: STABLE for ${stableHours.toFixed(1)}h in ${currentRegime} ` +
          `→ transitionSizeMult cleared`
        );
      } else {
        detectionType = 'STABLE';
        console.log(`[${WORKER_NAME}] ${instrument}: ${currentRegime} stable (${stableHours.toFixed(1)}h, ${distinctRegimes} distinct) — no change`);
      }

      insertLog.run(
        instrument, detectionType, currentRegime, previousRegime,
        distinctRegimes, +stableHours.toFixed(2), action,
        strategies.join(','),
        isOscillation ? `${distinctRegimes} distinct regimes in ${LOOKBACK_HOURS}h` : null,
      );

    } catch (instErr) {
      logWorkerError(db, WORKER_NAME, instErr);
      console.error(`[${WORKER_NAME}] ${instrument} error: ${instErr.message}`);
    }
  }

  if (overridesChanged) {
    saveOverrides(db, overrides);

    if (newTransitions.length) {
      const summary = newTransitions.map(t =>
        `${t.instrument}: ${t.detectionType} (${t.currentRegime}, ${t.distinctRegimes} regimes in ${LOOKBACK_HOURS}h)`
      ).join('\n');
      await sendNotification(
        `REGIME TRANSITION DETECTED — sizing reduced 50%`,
        summary,
        { priority: 'default', tags: 'arrows_counterclockwise' },
      );
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, transitionsDetected: newTransitions.length,
    overridesChanged: overridesChanged ? 1 : 0,
    completedAt: new Date().toISOString(),
  });

  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
