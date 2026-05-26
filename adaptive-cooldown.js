'use strict';

/**
 * Adaptive Cooldown Engine
 *
 * Replaces the blunt global SCANNER_COOLDOWN with a context-aware, per-strategy
 * timer that adapts to session quality, market regime, loss type, and streak depth.
 *
 * Architecture:
 *   Scanner duplicate guard (3-5 min) → spam/duplicate protection only
 *   Adaptive cooldown engine          → actual trade-quality timing control
 *
 * Formula:
 *   cooldown = baseCooldown × sessionMult × regimeMult × lossSeverityMult × streakMult
 *   capped at cfg.maxMin, floored at duplicateGuard, anti-starvation halves it after silence.
 */

// ── Per-strategy cooldown configuration ──────────────────────────────────────

const STRATEGY_CONFIGS = {
  MNQ_INTRADAY: {
    baseMin:      10,   // baseline between signals (no recent outcome context)
    afterWinMin:   5,   // faster re-entry after a win
    afterLossMin: 15,   // mandatory pause after a loss
    chopMin:      30,   // override when regime = choppy
    maxMin:       45,   // hard cap regardless of multipliers
  },
  MGC_SCALP: {
    baseMin:       5,
    afterWinMin:   3,
    afterLossMin:  7,  // was 10 — gold scalps recover faster than intraday positions
    chopMin:      15,  // was 20 — VWAP/liquidity confirmation still required
    maxMin:       25,  // was 30
  },
};

// ── Session quality multipliers ───────────────────────────────────────────────
// < 1.0 = liquid session, allow faster re-entry
// > 1.0 = degraded session, enforce longer wait
const SESSION_MULTIPLIERS = {
  'NY Open ★':         0.70,  // peak liquidity → tightest cooldown
  'London/NY Overlap': 0.80,
  'London':            0.90,
  'Midday':            1.00,
  'Afternoon ✓':       1.00,
  'Pre-Market':        1.30,
  'After Hours':       2.50,  // illiquid → heavy restriction
};

// Sessions considered "liquid" for anti-starvation logic (shared-indicators names)
const LIQUID_SESSIONS = new Set([
  'NY Open ★', 'London/NY Overlap', 'London', 'Midday', 'Afternoon ✓',
]);

// Same set using market-clock.js naming (MGC strategies use PT-zone names)
// Forensic finding: MGC signals always returned 'NY_OPEN' etc., which never
// matched LIQUID_SESSIONS, silently disabling anti-starvation for all MGC signals.
const LIQUID_SESSIONS_MCK = new Set([
  'NY_OPEN', 'POWER_HOUR', 'LONDON', 'NY_PRE', 'MIDDAY', 'NY_CLOSE',
]);

function _isLiquidSession(session) {
  return LIQUID_SESSIONS.has(session) || LIQUID_SESSIONS_MCK.has(session);
}

// ── Market regime multipliers ─────────────────────────────────────────────────
// Accepts both old vocabulary (trending/mixed/choppy/unknown) from getMarketRegime()
// and new vocabulary (TREND_BULL/TREND_BEAR/etc) from regime-agent-worker via regime_states.
const REGIME_MULTIPLIERS = {
  // Old vocabulary (learning.js getMarketRegime)
  trending: 0.80,  // clean trend → allow re-entry sooner
  mixed:    1.00,
  choppy:   1.80,  // chop → enforce extended pause
  unknown:  1.10,
  // New vocabulary (regime-agent-worker → regime_states table)
  TREND_BULL:  0.75,  // strong uptrend — allow re-entry quickly
  TREND_BEAR:  0.75,  // strong downtrend — allow re-entry quickly
  EXPANSION:   0.90,  // volatile spike — slight reduction (high momentum)
  NORMAL:      1.00,
  COMPRESSION: 1.20,  // coiling — slightly cautious, breakout direction unknown
  SOFT_CHOP:   1.70,  // low efficiency — enforce pause
  RANGE_CHOP:  2.20,  // tight range + no direction — hardest stop
  UNKNOWN:     1.10,
};

// ── Consecutive loss streak escalation ───────────────────────────────────────
// Index = number of consecutive losses.  Index ≥ KILL_SWITCH_STREAK → strategy disabled.
const STREAK_MULTIPLIERS    = [1.0, 1.5, 2.5, Infinity];
const KILL_SWITCH_STREAK    = 4;  // 4 consecutive losses → disabled until session reset

// Minimum confidence required for the new-session probe after a kill switch.
// High bar ensures only strong setups break the deadlock.
const NEW_SESSION_PROBE_CONF = 75;

// ── Anti-starvation ───────────────────────────────────────────────────────────
// If no signal has fired for this long during a liquid session, cut cooldown pressure.
const ANTI_STARVATION_MIN   = 60;   // minutes of silence before anti-starvation kicks in
const ANTI_STARVATION_SCALE = 0.50; // halve the computed cooldown

// ── Loss classification ───────────────────────────────────────────────────────
// Infer loss type from available signal + outcome data to set severity multiplier.

function classifyLoss(lastSignal, lastOutcome, consecutiveLosses) {
  if (!lastOutcome || lastOutcome.result !== 'LOSS') {
    return { type: 'none', multiplier: 1.0 };
  }

  const session = lastSignal?.session ?? '';
  const pnlPts  = lastOutcome.pnl_pts ?? 0;

  // Illiquid session — session conditions caused the failure, not the setup
  if (session === 'After Hours' || session === 'Pre-Market') {
    return { type: 'illiquid_failure', multiplier: 2.50 };
  }

  // Chop fakeout — midday grind or repeated losses in the same regime
  if (session === 'Midday' || consecutiveLosses >= 2) {
    return { type: 'chop_fakeout', multiplier: 1.80 };
  }

  // Volatility sweep — stop was hit cleanly but the loss was small (< 25 pts on MNQ / < 15 on MGC)
  // Setup thesis may still be intact; allow moderate recovery window
  if (pnlPts !== 0 && Math.abs(pnlPts) < 25) {
    return { type: 'volatility_sweep', multiplier: 0.80 };
  }

  return { type: 'normal_technical', multiplier: 1.00 };
}

// ── DB queries ────────────────────────────────────────────────────────────────

function getOutcomeContext(db, strategyName, instrument) {
  try {
    const last = db.prepare(`
      SELECT s.session, s.direction, s.confidence,
             o.result, o.pnl_pts
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.strategy_name = ?
        AND  s.instrument    = ?
        AND  o.result IS NOT NULL
      ORDER  BY s.received_at DESC
      LIMIT  1
    `).get(strategyName, instrument);

    if (!last) return { lastResult: null, consecutiveLosses: 0, lastSignal: null, lastOutcome: null };

    const recent = db.prepare(`
      SELECT o.result
      FROM   signals s
      JOIN   outcomes o ON o.signal_id = s.id
      WHERE  s.strategy_name = ?
        AND  s.instrument    = ?
        AND  o.result IS NOT NULL
      ORDER  BY s.received_at DESC
      LIMIT  6
    `).all(strategyName, instrument);

    let consecutiveLosses = 0;
    for (const r of recent) {
      if (r.result === 'LOSS') consecutiveLosses++;
      else break;
    }

    return {
      lastResult:        last.result,
      consecutiveLosses,
      lastSignal:        last,
      lastOutcome:       { result: last.result, pnl_pts: last.pnl_pts },
    };
  } catch {
    return { lastResult: null, consecutiveLosses: 0, lastSignal: null, lastOutcome: null };
  }
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a signal candidate should be allowed through the adaptive cooldown.
 *
 * @param {object} opts
 * @param {string} opts.strategyName
 * @param {string} opts.instrument
 * @param {string} opts.session         - current session name from getSessionInfo()
 * @param {string} opts.regime          - 'trending' | 'mixed' | 'choppy' | 'unknown'
 * @param {number} opts.confidence      - signal confidence score 0-100
 * @param {number} opts.lastSignalTime  - epoch ms of last fired signal (0 = never)
 * @param {object} opts.db              - better-sqlite3 database instance
 *
 * @returns {{ allowed: boolean, remainingMin: number, reason: string, details: object }}
 */
function checkAdaptiveCooldown({ strategyName, instrument, session, regime, confidence, lastSignalTime, db }) {
  const cfg       = STRATEGY_CONFIGS[strategyName] ?? _defaultConfig();
  const now       = Date.now();
  const elapsedMin = lastSignalTime > 0 ? (now - lastSignalTime) / 60_000 : Infinity;

  // No prior signal in this session — always allow
  if (elapsedMin === Infinity) {
    return _allow('no_prior_signal', elapsedMin, 0);
  }

  // ── Outcome context ───────────────────────────────────────────────────────
  const { lastResult, consecutiveLosses, lastSignal, lastOutcome } =
    getOutcomeContext(db, strategyName, instrument);

  // ── Kill switch with new-session escape valve ─────────────────────────────
  // After KILL_SWITCH_STREAK consecutive losses the strategy is paused.
  // The intended "reset after win in new session" behaviour requires a probe:
  // allow ONE high-confidence attempt when we detect a session boundary crossed
  // since the last loss.  If it wins, the consecutive loss count resets naturally.
  // If it loses, the kill switch reactivates immediately.
  if (consecutiveLosses >= KILL_SWITCH_STREAK) {
    const lastLossSess     = lastSignal?.session ?? null;
    const inNewSession     = lastLossSess != null && lastLossSess !== session;
    const inLiquidSession  = _isLiquidSession(session);
    const probeAllowed     = inNewSession && inLiquidSession && confidence >= NEW_SESSION_PROBE_CONF;

    if (!probeAllowed) {
      return {
        allowed: false, remainingMin: Infinity,
        reason: `kill_switch`,
        details: {
          blocked_by:           'adaptive_cooldown_kill_switch',
          consecutive_losses:   consecutiveLosses,
          kill_switch_at:       KILL_SWITCH_STREAK,
          strategy:             strategyName, instrument,
          last_loss_session:    lastLossSess,
          current_session:      session,
          probe_available:      inNewSession && inLiquidSession,
          probe_conf_needed:    NEW_SESSION_PROBE_CONF,
          probe_conf_current:   confidence,
          reset_condition:      `high-conf (≥${NEW_SESSION_PROBE_CONF}) probe in next liquid session, then win to reset`,
        },
      };
    }
    // Escape: new liquid session + sufficient confidence → allow cautious probe
  }

  // ── Select base cooldown ──────────────────────────────────────────────────
  let baseMin;
  let cooldownContext;

  if (!lastResult || lastResult === 'BE' || lastResult === 'EXPIRED') {
    baseMin        = cfg.baseMin;
    cooldownContext = 'base';
  } else if (lastResult === 'WIN') {
    baseMin        = cfg.afterWinMin;
    cooldownContext = 'after_win';
  } else {
    baseMin        = cfg.afterLossMin;
    cooldownContext = 'after_loss';
  }

  // ── Regime override for chop ──────────────────────────────────────────────
  if (regime === 'choppy') {
    baseMin        = Math.max(baseMin, cfg.chopMin);
    cooldownContext = 'chop_regime';
  }

  // ── Multipliers ───────────────────────────────────────────────────────────
  const sessionMult = SESSION_MULTIPLIERS[session] ?? 1.0;
  const regimeMult  = REGIME_MULTIPLIERS[regime]   ?? 1.0;

  const { type: lossType, multiplier: lossMult } = lastResult === 'LOSS'
    ? classifyLoss(lastSignal, lastOutcome, consecutiveLosses)
    : { type: 'none', multiplier: 1.0 };

  const streakIdx  = Math.min(consecutiveLosses, STREAK_MULTIPLIERS.length - 1);
  const streakMult = STREAK_MULTIPLIERS[streakIdx];

  // ── Dynamic cooldown formula ──────────────────────────────────────────────
  let computedMin = baseMin * sessionMult * regimeMult * lossMult * streakMult;
  computedMin     = Math.min(computedMin, cfg.maxMin);

  // ── Anti-starvation ───────────────────────────────────────────────────────
  let antiStarvation = false;
  if (_isLiquidSession(session) && elapsedMin >= ANTI_STARVATION_MIN) {
    computedMin   *= ANTI_STARVATION_SCALE;
    antiStarvation = true;
  }

  // ── Premium mode quality gate ─────────────────────────────────────────────
  // After a loss on a premium-mode strategy, require stronger confirmation
  // before allowing re-entry even when the cooldown has elapsed.
  if (cfg.premiumMode && lastResult === 'LOSS' && elapsedMin >= computedMin) {
    const premiumConfMin = 78;
    if (confidence < premiumConfMin) {
      return {
        allowed: false, remainingMin: 0,
        reason: 'premium_quality_gate',
        details: {
          blocked_by:           'adaptive_cooldown_premium_gate',
          strategy:             strategyName, instrument,
          confidence,
          required_confidence:  premiumConfMin,
          note:                 'cooldown elapsed but confidence below premium re-entry threshold',
        },
      };
    }
  }

  // ── Decision ──────────────────────────────────────────────────────────────
  const remainingMin = Math.max(0, computedMin - elapsedMin);

  if (remainingMin > 0) {
    return {
      allowed: false, remainingMin,
      reason: cooldownContext,
      details: {
        blocked_by:              'adaptive_strategy_cooldown',
        remaining_minutes:       +remainingMin.toFixed(1),
        elapsed_minutes:         +elapsedMin.toFixed(1),
        computed_cooldown_min:   +computedMin.toFixed(1),
        base_min:                baseMin,
        session,                 session_multiplier:  sessionMult,
        regime,                  regime_multiplier:   regimeMult,
        loss_type:               lossType,            loss_multiplier: lossMult,
        consecutive_losses:      consecutiveLosses,   streak_multiplier: streakMult,
        anti_starvation:         antiStarvation,
        confidence,
        strategy:                strategyName, instrument,
      },
    };
  }

  return _allow(cooldownContext, elapsedMin, computedMin, {
    last_result: lastResult, consecutive_losses: consecutiveLosses, anti_starvation: antiStarvation,
  });
}

// ── Logging ───────────────────────────────────────────────────────────────────

/**
 * Format a full diagnostic block for a blocked signal.
 * Matches the log format requested in the architecture spec.
 */
function formatBlockLog(strategyName, instrument, session, confidence, regime, result) {
  const d = result.details ?? {};
  const lines = [
    `🚦 Signal blocked:`,
    `   strategy:         ${strategyName}`,
    `   instrument:       ${instrument}`,
    `   blocked_by:       ${d.blocked_by ?? 'adaptive_cooldown'}`,
    `   remaining_min:    ${result.remainingMin === Infinity ? '∞' : result.remainingMin?.toFixed?.(1) ?? '?'}`,
    `   reason:           ${result.reason}`,
    `   session:          ${session}` + (d.session_multiplier != null ? ` (×${d.session_multiplier})` : ''),
    `   regime:           ${regime}` + (d.regime_multiplier != null ? ` (×${d.regime_multiplier})` : ''),
    `   loss_type:        ${d.loss_type ?? 'n/a'}`,
    `   loss_streak:      ${d.consecutive_losses ?? 0}`,
    `   streak_mult:      ${d.streak_multiplier ?? 1.0}`,
    `   computed_min:     ${d.computed_cooldown_min ?? '?'}`,
    `   confidence:       ${confidence}`,
    `   anti_starvation:  ${d.anti_starvation ? 'YES' : 'no'}`,
  ];
  if (d.required_confidence != null) {
    lines.push(`   required_conf:    ${d.required_confidence}`);
  }
  return lines.join('\n');
}

/**
 * One-line summary for non-verbose log levels.
 */
function formatBlockSummary(strategyName, instrument, result) {
  const rem = result.remainingMin === Infinity ? '∞' : `${result.remainingMin?.toFixed?.(1) ?? '?'}min`;
  return `⏳ Adaptive cooldown [${strategyName}/${instrument}] — ${rem} remaining (${result.reason})`;
}

/**
 * Format startup config dump.
 */
function formatStartupConfig(duplicateGuardMin) {
  const lines = [
    `Adaptive cooldown engine active — duplicate guard: ${duplicateGuardMin}min`,
    `Strategy configs:`,
  ];
  for (const [name, cfg] of Object.entries(STRATEGY_CONFIGS)) {
    lines.push(
      `  ${name.padEnd(15)} base=${cfg.baseMin}m  win=${cfg.afterWinMin}m  loss=${cfg.afterLossMin}m  chop=${cfg.chopMin}m  max=${cfg.maxMin}m` +
      (cfg.premiumMode ? '  [PREMIUM]' : '')
    );
  }
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _allow(reason, elapsedMin, computedMin, extra = {}) {
  return {
    allowed: true, remainingMin: 0, reason,
    details: { elapsed_minutes: +elapsedMin.toFixed?.(1), computed_cooldown_min: +computedMin.toFixed?.(1), ...extra },
  };
}

function _defaultConfig() {
  return { baseMin: 15, afterWinMin: 8, afterLossMin: 20, chopMin: 35, maxMin: 60 };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  checkAdaptiveCooldown,
  formatBlockLog,
  formatBlockSummary,
  formatStartupConfig,
  STRATEGY_CONFIGS,
  SESSION_MULTIPLIERS,
  REGIME_MULTIPLIERS,
  STREAK_MULTIPLIERS,
  KILL_SWITCH_STREAK,
  LIQUID_SESSIONS,
};
