'use strict';

/**
 * DRAWDOWN PROTECTION WORKER  (Prompt #11 — Phase 6)
 *
 * Runs every 30 minutes. Monitors per-strategy drawdown and consecutive loss
 * streaks from live trade outcomes, then adjusts position sizing automatically.
 *
 * Protection levels:
 *   0  CLEAR   — normal operation                    drawdownSizeMult = 1.00
 *   1  WATCH   — 3+ consecutive losses               drawdownSizeMult = 0.75
 *   2  REDUCE  — 5+ consecutive losses OR DD ≥ 4%    drawdownSizeMult = 0.50
 *   3  PAUSE   — 8+ consecutive losses OR DD ≥ 7%    paused = true
 *
 * Recovery rules (automatic, no manual intervention needed):
 *   Level 3 → 2: 2 consecutive wins while paused (re-enables, keeps 0.50×)
 *   Level 2 → 1: 2 consecutive wins at REDUCE
 *   Level 1 → 0: 1 win at WATCH
 *   Level 0: nothing needed
 *
 * DD% is estimated from trade_dna pnl_pts using 1 MNQ point ≈ $2 / $5,000 account
 * and 1 MGC point ≈ $10 / $5,000 account as conservative floor.
 *
 * Writes to drawdown_log. Updates ADAPTIVE_OVERRIDES:
 *   drawdownProtectionLevel  (0–3)
 *   drawdownSizeMult         (1.00 | 0.75 | 0.50)
 *   and paused = true at level 3 (with regime-health-style reason tagging)
 *
 * Posts veto (level 3 entry) or observation (level 1-2 entry) on level changes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification, withOverridesLock } = require('./worker-utils');

const WORKER_NAME = 'drawdown-protection';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

// Points-per-dollar factor for rough DD% estimation (per 1 contract, $5k account floor)
const PTS_PER_DOLLAR = { MNQ: 2, MGC: 10 };
const ACCOUNT_FLOOR  = 5000;

const SIZE_MULT  = [1.00, 0.75, 0.50, 0.00];
const LEVEL_NAME = ['CLEAR', 'WATCH', 'REDUCE', 'PAUSE'];

// ── Per-strategy drawdown assessment ─────────────────────────────────────────

function assessDrawdown(db, strategy) {
  const instrument = strategy.startsWith('MGC') ? 'MGC' : 'MNQ';

  // Last 25 outcomes from trade_dna (newest first)
  const trades = db.prepare(`
    SELECT outcome, pnl_pts, trade_date
    FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND source = 'LIVE'
    ORDER BY trade_date DESC, rowid DESC
    LIMIT 25
  `).all(strategy);

  if (trades.length < 3) {
    return { skip: true, reason: 'insufficient_data', tradesAvailable: trades.length };
  }

  // Consecutive loss streak (newest first)
  let consecutiveLosses = 0;
  let consecutiveWins   = 0;
  for (const t of trades) {
    if (consecutiveLosses === 0 && t.outcome === 'WIN')  consecutiveWins++;
    else break;
  }
  for (const t of trades) {
    if (consecutiveWins === 0 && t.outcome === 'LOSS') consecutiveLosses++;
    else break;
  }
  // If we're in a win streak, consecutive losses resets
  if (consecutiveWins > 0) consecutiveLosses = 0;

  // Daily PnL DD%: sum today's pnl_pts, convert to rough $, divide by account floor
  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = db.prepare(`
    SELECT SUM(pnl_pts) AS total_pts FROM trade_dna
    WHERE strategy_name = ? AND outcome IN ('WIN','LOSS')
      AND source = 'LIVE' AND trade_date = ?
  `).get(strategy, today);
  const dailyPts  = todayPnl?.total_pts ?? 0;
  const dailyDollar = dailyPts * PTS_PER_DOLLAR[instrument];
  const dailyDDPct  = dailyDollar < 0 ? Math.abs(dailyDollar) / ACCOUNT_FLOOR : 0;

  return {
    skip: false,
    consecutiveLosses,
    consecutiveWins,
    dailyDDPct,
    dailyPts,
    tradesAvailable: trades.length,
  };
}

// ── Protection level determination ───────────────────────────────────────────

function determineLevel(consecutiveLosses, dailyDDPct) {
  if (consecutiveLosses >= 8 || dailyDDPct >= 0.07) return 3; // PAUSE
  if (consecutiveLosses >= 5 || dailyDDPct >= 0.04) return 2; // REDUCE
  if (consecutiveLosses >= 3)                        return 1; // WATCH
  return 0;                                                     // CLEAR
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  const db = openDb();
  heartbeat(db, WORKER_NAME, 'RUNNING', { pid: process.pid, startedAt: new Date().toISOString() });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS drawdown_log (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name          TEXT NOT NULL,
      instrument             TEXT,
      checked_at             TEXT NOT NULL DEFAULT (datetime('now')),
      protection_level       INTEGER,
      level_name             TEXT,
      consecutive_losses     INTEGER,
      consecutive_wins       INTEGER,
      daily_dd_pct           REAL,
      daily_pts              REAL,
      drawdown_size_mult     REAL,
      prev_protection_level  INTEGER,
      level_changed          INTEGER DEFAULT 0,
      notes                  TEXT
    )
  `).run();

  const insertLog = db.prepare(`
    INSERT INTO drawdown_log
      (strategy_name, instrument, protection_level, level_name,
       consecutive_losses, consecutive_wins, daily_dd_pct, daily_pts,
       drawdown_size_mult, prev_protection_level, level_changed, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO agent_messages
      (from_agent, msg_type, strategy_name, priority, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  // ── Phase A: collect all assessments BEFORE acquiring the lock ───────────────
  // DB reads happen here; the lock is held for the minimum time (modification only).
  const assessments = [];
  for (const strategy of STRATEGIES) {
    const instrument = strategy.startsWith('MGC') ? 'MGC' : 'MNQ';
    const result     = assessDrawdown(db, strategy);
    assessments.push({ strategy, instrument, result });
  }

  // ── Phase B: apply all assessed levels atomically under BEGIN IMMEDIATE ───────
  // No other worker can interleave between the read and write of this JSON blob.
  const changes = [];   // carries the per-strategy outcome for Phase C logging
  withOverridesLock(db, overrides => {
    for (const { strategy, instrument, result } of assessments) {
      if (result.skip) {
        changes.push({ strategy, instrument, skip: true, ...result });
        continue;
      }
      const { consecutiveLosses, consecutiveWins, dailyDDPct, dailyPts, tradesAvailable } = result;

      if (!overrides[strategy]) {
        overrides[strategy] = {
          paused: false, blockLong: false, blockShort: false,
          blockedSessions: [], blockedRegimes: [], reasons: [],
          manualPause: false,
        };
      }
      const ov = overrides[strategy];
      if (!ov.reasons) ov.reasons = [];

      const prevLevel = ov.drawdownProtectionLevel ?? 0;

      let targetLevel = determineLevel(consecutiveLosses, dailyDDPct);
      if (consecutiveWins >= 2 && prevLevel >= 2) targetLevel = Math.min(targetLevel, prevLevel - 1);
      if (consecutiveWins >= 1 && prevLevel === 1) targetLevel = 0;
      targetLevel = Math.max(targetLevel, determineLevel(consecutiveLosses, dailyDDPct));

      const newLevel     = targetLevel;
      const sizeMult     = newLevel < 3 ? SIZE_MULT[newLevel] : 0;
      const levelName    = LEVEL_NAME[newLevel];
      const levelChanged = newLevel !== prevLevel;

      ov.drawdownProtectionLevel = newLevel;
      ov.drawdownSizeMult        = sizeMult;

      if (newLevel === 3 && !ov.manualPause) {
        const alreadyTagged = ov.reasons.some(r => r.startsWith('drawdown-protection: PAUSE'));
        if (!alreadyTagged) {
          ov.reasons.push(`drawdown-protection: PAUSE (${consecutiveLosses} consecutive losses, DD ${(dailyDDPct * 100).toFixed(1)}%)`);
          ov.paused = true;
        }
      } else if (newLevel < 3) {
        const hasDDReason    = ov.reasons.some(r => r.startsWith('drawdown-protection:'));
        const hasOtherReason = ov.reasons.some(r => !r.startsWith('drawdown-protection:'));
        if (hasDDReason) {
          ov.reasons = ov.reasons.filter(r => !r.startsWith('drawdown-protection:'));
          if (!hasOtherReason && !ov.manualPause) ov.paused = false;
        }
      }

      changes.push({ strategy, instrument, result,
        newLevel, sizeMult, levelName, levelChanged, prevLevel });
    }
  });

  // ── Phase C: log and notify OUTSIDE the lock (notifications are async HTTP) ──
  let processed = 0;
  for (const ch of changes) {
    if (ch.skip) {
      console.log(`[${WORKER_NAME}] ${ch.strategy}: skip — ${ch.reason} (${ch.tradesAvailable} trades)`);
      continue;
    }

    const { strategy, instrument, result, newLevel, sizeMult, levelName, levelChanged, prevLevel } = ch;
    const { consecutiveLosses, consecutiveWins, dailyDDPct, dailyPts } = result;

    const notes = [];
    if (levelChanged)           notes.push(`level ${prevLevel}→${newLevel}`);
    if (consecutiveLosses > 0)  notes.push(`${consecutiveLosses} consec losses`);
    if (dailyDDPct > 0)         notes.push(`daily DD ${(dailyDDPct * 100).toFixed(1)}%`);
    if (consecutiveWins > 0)    notes.push(`${consecutiveWins} consec wins`);

    try {
      insertLog.run(
        strategy, instrument,
        newLevel, levelName,
        consecutiveLosses, consecutiveWins,
        +dailyDDPct.toFixed(4), +dailyPts.toFixed(2),
        sizeMult, prevLevel, levelChanged ? 1 : 0,
        notes.join('; ') || null,
      );
    } catch (logErr) {
      console.error(`[${WORKER_NAME}] insertLog error for ${strategy}: ${logErr.message}`);
    }

    console.log(
      `[${WORKER_NAME}] ${strategy}: level=${levelName}(${newLevel}) ` +
      `losses=${consecutiveLosses} wins=${consecutiveWins} ` +
      `DD=${(dailyDDPct * 100).toFixed(1)}% sizeMult=${sizeMult}` +
      (levelChanged ? ` ⟵ changed from ${LEVEL_NAME[prevLevel]}` : ''),
    );

    if (levelChanged) {
      try {
        const msgType  = newLevel === 3 ? 'veto' : 'observation';
        const priority = newLevel >= 2 ? 2 : 4;
        insertMsg.run(
          'drawdown-protection', msgType, strategy, priority,
          JSON.stringify({
            protection_level:   newLevel,
            level_name:         levelName,
            prev_level:         LEVEL_NAME[prevLevel],
            consecutive_losses: consecutiveLosses,
            daily_dd_pct:       +(dailyDDPct * 100).toFixed(1),
            drawdown_size_mult: sizeMult,
            action: newLevel === 3 ? 'strategy_paused' :
                    newLevel > prevLevel ? `size_reduced_to_${(sizeMult * 100).toFixed(0)}pct` :
                    `size_restored_to_${(sizeMult * 100).toFixed(0)}pct`,
          }),
        );
      } catch (_) {}

      if (newLevel >= 2) {
        await sendNotification(
          newLevel === 3 ? `DD PAUSE — ${strategy}` : `DD REDUCE — ${strategy}`,
          `${strategy} drawdown protection level ${newLevel} (${levelName})\n` +
          `Consecutive losses: ${consecutiveLosses}\n` +
          `Daily DD: ${(dailyDDPct * 100).toFixed(1)}%\n` +
          `Size multiplier: ${sizeMult === 0 ? 'PAUSED' : (sizeMult * 100).toFixed(0) + '%'}`,
          { priority: newLevel === 3 ? 'high' : 'default',
            tags: newLevel === 3 ? 'red_circle,no_entry' : 'orange_circle,warning' },
        );
      }
    }

    processed++;
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
