'use strict';

/**
 * REGIME HEALTH WORKER
 *
 * Runs every 30 minutes (cron: every-30-min).
 * For each strategy, evaluates the current market regime, computes a health
 * score (0-100), derives a behavior mode (STANDBY/DEFENSIVE/NORMAL/AGGRESSIVE),
 * updates adaptive overrides if needed, posts agent_messages on state changes,
 * and writes every check to regime_health_log.
 *
 * Sends ntfy notifications only when behavior_mode changes and only for
 * STANDBY (high priority) and AGGRESSIVE (default priority).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'regime-health';

const STRATEGIES = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

const STRATEGY_INSTRUMENT = {
  MNQ_INTRADAY: 'MNQ',
  MNQ_SWING:    'MNQ',
  MNQ_50PT:     'MNQ',
  MGC_SCALP:    'MGC',
};

const REGIME_RECS = {
  TREND_BULL:  { stop: 'WIDEN',   tp: 'EXTEND'  },
  TREND_BEAR:  { stop: 'WIDEN',   tp: 'EXTEND'  },
  EXPANSION:   { stop: 'WIDEN',   tp: 'EXTEND'  },
  COMPRESSION: { stop: 'WIDEN',   tp: 'EXTEND'  },
  SOFT_CHOP:   { stop: 'TIGHTEN', tp: 'TIGHTEN' },
  RANGE_CHOP:  { stop: 'TIGHTEN', tp: 'TIGHTEN' },
  NORMAL:      { stop: 'NORMAL',  tp: 'NORMAL'  },
};

// ─── Health score ────────────────────────────────────────────────────────────

function computeHealthScore(currentRegime, regimeStrength, perfRow, recent7d) {
  let score = 50;

  // Regime type
  if (currentRegime === 'TREND_BULL' || currentRegime === 'TREND_BEAR') score += 10;
  if (currentRegime === 'RANGE_CHOP')  score -= 25;
  if (currentRegime === 'COMPRESSION') score -= 10;
  if (currentRegime === 'EXPANSION')   score += 5;
  if (currentRegime === 'SOFT_CHOP')   score -= 8;

  // Regime strength (from regime_states)
  if (regimeStrength != null) {
    if (regimeStrength > 0.70)      score += 10;
    else if (regimeStrength < 0.40) score -= 5;
  }

  // Historical performance
  if (perfRow) {
    if (perfRow.win_rate >= 0.70)      score += 30;
    else if (perfRow.win_rate >= 0.60) score += 20;
    else if (perfRow.win_rate < 0.35)  score -= 25;
    else if (perfRow.win_rate < 0.45)  score -= 10;

    if (perfRow.profit_factor != null) {
      if (perfRow.profit_factor >= 2.0)     score += 10;
      else if (perfRow.profit_factor < 1.0) score -= 20;
    }

    if (perfRow.trade_count < 10) score -= 10; // insufficient history
  } else {
    score -= 10; // no data for this regime
  }

  // Recent 7d degradation vs historical
  if (recent7d && perfRow && (recent7d.wins + recent7d.losses) >= 5) {
    const recentWr = recent7d.wins / (recent7d.wins + recent7d.losses);
    const delta = recentWr - perfRow.win_rate;
    if (delta < -0.10)      score -= 15;
    else if (delta > 0.10)  score += 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Behavior mode ───────────────────────────────────────────────────────────

function behaviorMode(health) {
  if (health >= 70) return 'AGGRESSIVE';
  if (health >= 40) return 'NORMAL';
  if (health >= 20) return 'DEFENSIVE';
  return 'STANDBY';
}

// ─── Adaptive overrides helpers ──────────────────────────────────────────────

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

// ─── Main run ─────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();

  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  // Bootstrap output table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS regime_health_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name     TEXT NOT NULL,
      instrument        TEXT,
      checked_at        TEXT NOT NULL DEFAULT (datetime('now')),
      current_regime    TEXT,
      regime_strength   REAL,
      regime_wr         REAL,
      regime_expectancy REAL,
      recent_7d_wr      REAL,
      health_score      INTEGER,
      behavior_mode     TEXT,
      stop_rec          TEXT,
      tp_rec            TEXT,
      notes             TEXT
    )
  `).run();

  const insertLog = db.prepare(`
    INSERT INTO regime_health_log
      (strategy_name, instrument, current_regime, regime_strength,
       regime_wr, regime_expectancy, recent_7d_wr,
       health_score, behavior_mode, stop_rec, tp_rec, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  let processed = 0;

  for (const strategy of STRATEGIES) {
    try {
      const instrument = STRATEGY_INSTRUMENT[strategy];

      // ── 1. Current regime ──────────────────────────────────────────────────
      const regimeRow = db.prepare(`
        SELECT regime, strength, atr_percentile, ema_slope, classified_at
        FROM regime_states
        WHERE instrument = ?
        ORDER BY classified_at DESC LIMIT 1
      `).get(instrument);

      const currentRegime   = regimeRow?.regime   ?? 'NORMAL';
      const regimeStrength  = regimeRow?.strength  ?? null;

      // ── 2. Historical performance for (strategy, regime) ───────────────────
      const perfRow = db.prepare(`
        SELECT win_rate, profit_factor, expectancy, avg_mae_pts, avg_mfe_pts, trade_count
        FROM regime_performance_stats
        WHERE strategy_name = ? AND regime = ?
        ORDER BY run_date DESC LIMIT 1
      `).get(strategy, currentRegime);

      // ── 3. Recent 7-day performance in current regime ──────────────────────
      const recent7dRow = db.prepare(`
        SELECT COUNT(*) n,
               SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) wins,
               SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) losses
        FROM trade_dna
        WHERE strategy_name = ? AND regime = ?
          AND outcome IN ('WIN','LOSS')
          AND trade_date >= date('now', '-7 days')
      `).get(strategy, currentRegime);

      const recent7d = recent7dRow
        ? { n: recent7dRow.n ?? 0, wins: recent7dRow.wins ?? 0, losses: recent7dRow.losses ?? 0 }
        : null;

      // ── 4. Compute health & mode ───────────────────────────────────────────
      const healthScore = computeHealthScore(currentRegime, regimeStrength, perfRow, recent7d);
      const mode        = behaviorMode(healthScore);
      const recs        = REGIME_RECS[currentRegime] ?? { stop: 'NORMAL', tp: 'NORMAL' };

      const recent7dWr = (recent7d && (recent7d.wins + recent7d.losses) > 0)
        ? +(recent7d.wins / (recent7d.wins + recent7d.losses)).toFixed(4)
        : null;

      // ── 5. Detect state change vs last run ────────────────────────────────
      const lastLog = db.prepare(`
        SELECT behavior_mode FROM regime_health_log
        WHERE strategy_name = ?
        ORDER BY id DESC LIMIT 1
      `).get(strategy);

      const prevMode   = lastLog?.behavior_mode ?? null;
      const modeChanged = prevMode !== mode;

      // ── 6. Update adaptive overrides ──────────────────────────────────────
      const overrides = loadOverrides(db);
      if (!overrides[strategy]) {
        overrides[strategy] = {
          paused: false, blockLong: false, blockShort: false,
          blockedSessions: [], blockedRegimes: [], reasons: [],
          manualPause: false,
        };
      }
      const ov = overrides[strategy];
      if (!ov.reasons) ov.reasons = [];

      let ovChanged = false;

      if (mode === 'STANDBY') {
        if (!ov.manualPause) {
          const alreadyHasReason = ov.reasons.some(r => r.startsWith('regime-health: STANDBY'));
          if (!alreadyHasReason) {
            ov.reasons.push(`regime-health: STANDBY (REGIME health=${healthScore})`);
            ov.paused = true;
            ovChanged  = true;
          } else if (!ov.paused) {
            ov.paused = true;
            ovChanged  = true;
          }
        }
        // Always clear aggressiveMode when standing down
        if (ov.aggressiveMode) { ov.aggressiveMode = false; ovChanged = true; }
        if (ov.behaviorMode !== 'STANDBY') { ov.behaviorMode = 'STANDBY'; ovChanged = true; }
      } else if (mode === 'NORMAL' || mode === 'AGGRESSIVE') {
        const hasRegimeHealthReasons = ov.reasons.some(r => r.startsWith('regime-health:'));
        const hasOtherReasons        = ov.reasons.some(r => !r.startsWith('regime-health:'));

        if (hasRegimeHealthReasons && !hasOtherReasons && ov.paused && !ov.manualPause) {
          ov.reasons = ov.reasons.filter(r => !r.startsWith('regime-health:'));
          ov.paused  = false;
          ovChanged   = true;
        } else if (hasRegimeHealthReasons && !hasOtherReasons) {
          ov.reasons = ov.reasons.filter(r => !r.startsWith('regime-health:'));
          ovChanged   = true;
        }

        // AGGRESSIVE mode: set flag so adaptive-cooldown applies 0.70× multiplier
        const wantsAggressive = mode === 'AGGRESSIVE';
        if ((ov.aggressiveMode ?? false) !== wantsAggressive) {
          ov.aggressiveMode = wantsAggressive;
          ovChanged = true;
        }
        // DEFENSIVE: do nothing else to overrides
      }

      // Always keep behaviorMode current for portfolio engine + scanner quality scoring
      if (mode !== 'STANDBY' && ov.behaviorMode !== mode) {
        ov.behaviorMode = mode;
        ovChanged = true;
      }

      if (ovChanged) {
        saveOverrides(db, overrides);
      }

      // ── 7. Post agent_messages on state change ────────────────────────────
      if (modeChanged) {
        if (mode === 'STANDBY') {
          insertMsg.run(
            'regime-health',
            'veto',
            strategy,
            1,
            JSON.stringify({
              regime:        currentRegime,
              health_score:  healthScore,
              behavior_mode: mode,
              reason:        `Regime health score ${healthScore} — STANDBY mode, trading paused`,
            }),
          );
        } else if (mode === 'AGGRESSIVE') {
          insertMsg.run(
            'regime-health',
            'observation',
            strategy,
            4,
            JSON.stringify({
              regime:        currentRegime,
              health_score:  healthScore,
              behavior_mode: mode,
              stop_rec:      recs.stop,
              tp_rec:        recs.tp,
            }),
          );
        } else if (mode === 'DEFENSIVE') {
          insertMsg.run(
            'regime-health',
            'observation',
            strategy,
            4,
            JSON.stringify({
              regime:        currentRegime,
              health_score:  healthScore,
              behavior_mode: mode,
              stop_rec:      recs.stop,
              tp_rec:        recs.tp,
            }),
          );
        } else {
          // NORMAL
          insertMsg.run(
            'regime-health',
            'observation',
            strategy,
            4,
            JSON.stringify({
              regime:        currentRegime,
              health_score:  healthScore,
              behavior_mode: mode,
              stop_rec:      recs.stop,
              tp_rec:        recs.tp,
            }),
          );
        }
      }

      // ── 8. Write to regime_health_log ─────────────────────────────────────
      const notes = [];
      if (!regimeRow)  notes.push('no regime_states row');
      if (!perfRow)    notes.push('no regime_performance_stats');
      if (ovChanged)   notes.push(`overrides updated: paused=${ov.paused}`);
      if (modeChanged) notes.push(`mode changed: ${prevMode ?? 'none'} → ${mode}`);

      insertLog.run(
        strategy,
        instrument,
        currentRegime,
        regimeStrength,
        perfRow?.win_rate       ?? null,
        perfRow?.expectancy     ?? null,
        recent7dWr,
        healthScore,
        mode,
        recs.stop,
        recs.tp,
        notes.length ? notes.join('; ') : null,
      );

      // ── 9. Ntfy on mode change (STANDBY or AGGRESSIVE only) ───────────────
      if (modeChanged) {
        if (mode === 'STANDBY') {
          await sendNotification(
            `Regime STANDBY — ${strategy}`,
            `${strategy} entered STANDBY\nRegime: ${currentRegime}\nHealth score: ${healthScore}\nTrading paused until regime improves`,
            { priority: 'high', tags: 'red_circle,no_entry' },
          );
        } else if (mode === 'AGGRESSIVE') {
          await sendNotification(
            `Regime AGGRESSIVE — ${strategy}`,
            `${strategy} entered AGGRESSIVE\nRegime: ${currentRegime}\nHealth score: ${healthScore}\nStop: ${recs.stop} | TP: ${recs.tp}`,
            { priority: 'default', tags: 'green_circle,rocket' },
          );
        }
      }

      console.log(
        `[${WORKER_NAME}] ${strategy}: regime=${currentRegime} strength=${regimeStrength ?? 'n/a'} ` +
        `health=${healthScore} mode=${mode}${modeChanged ? ` (changed from ${prevMode ?? 'none'})` : ''}`,
      );

      processed++;
    } catch (stratErr) {
      console.error(`[${WORKER_NAME}] error on ${strategy}: ${stratErr.message}`);
      logWorkerError(db, WORKER_NAME, stratErr);
    }
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', {
    pid: process.pid, processed,
    completedAt: new Date().toISOString(),
  });

  console.log(`[${WORKER_NAME}] Done — ${processed} strategies checked`);
  db.close();
  process.exit(0);
}

run().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal:`, err.message, err.stack);
  process.exit(1);
});
