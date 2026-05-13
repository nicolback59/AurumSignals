'use strict';

/**
 * strategy-evolution.js
 *
 * Continuous A/B experimentation and strategy evolution engine.
 *
 * Responsibilities:
 *   - Maintain a pool of shadow variant parameter sets per instrument
 *   - Run shadow backtests against the champion (current live params)
 *   - Promote variants that beat the champion on multi-objective criteria
 *   - Track full evolution history and experiment lineage
 *   - Use DNA guidance to seed better variant candidates
 *   - Detect and retire stale or degraded variants automatically
 */

const { runBacktest, calcEnhancedMetrics } = require('./backtest-engine');
const {
  getParams, saveParams, saveRevision,
  generateCandidates, crossoverParams,
  multiObjectiveScore, validateImprovement,
  SAFEGUARDS,
} = require('./strategy-params');
const { getDNAGuidance, loadDNA } = require('./strategy-dna');

// ── Constants ─────────────────────────────────────────────────────────────────

const EVOLUTION_KEY      = (instrument) => `EVOLUTION_STATE_${instrument}`;
const MAX_VARIANTS       = 8;     // max shadow variants tracked simultaneously
const PROMOTION_MARGIN   = 0.03;  // variant must beat champion by this multi-obj delta
const MIN_TRADES         = 40;    // discard variants with too few trades
const STALE_CYCLES       = 4;     // retire a variant after this many cycles without improvement
const MAX_HISTORY        = 200;   // evolution history entries to retain per instrument

// ── State persistence ─────────────────────────────────────────────────────────

function loadEvolutionState(db, instrument) {
  try {
    const row = db.prepare(
      `SELECT value FROM strategy_params WHERE key = ?`
    ).get(EVOLUTION_KEY(instrument));
    if (row) return JSON.parse(row.value);
  } catch {}
  return {
    instrument,
    generation:  0,
    champion:    null,       // { params, score, metrics, promotedAt }
    variants:    [],         // array of VariantRecord
    history:     [],         // array of HistoryEntry
    lastRunAt:   null,
  };
}

function saveEvolutionState(db, instrument, state) {
  const json = JSON.stringify(state);
  db.prepare(`
    INSERT INTO strategy_params (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(EVOLUTION_KEY(instrument), json);
}

// ── Variant record helpers ────────────────────────────────────────────────────

function makeVariant(params, parentId, source, generation) {
  return {
    id:          `v${generation}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    parentId,
    source,       // 'perturb' | 'crossover' | 'dna_guided' | 'random'
    generation,
    params,
    lastScore:    null,
    lastMetrics:  null,
    staleCycles:  0,
    createdAt:    new Date().toISOString(),
    lastEvalAt:   null,
  };
}

function makeHistoryEntry(type, instrument, generation, data) {
  return {
    type,          // 'promoted' | 'retired' | 'evaluated' | 'seeded'
    instrument,
    generation,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

// ── DNA-guided candidate generation ──────────────────────────────────────────

/**
 * Generate candidates biased toward DNA-identified winning conditions.
 * Falls back to standard perturbation when DNA is unavailable.
 */
function generateDNAGuidedCandidates(baseParams, instrument, dna, count) {
  const candidates = [];

  if (dna) {
    const guidance = getDNAGuidance(dna, instrument);

    // Bias ATR minimum toward regimes where DNA shows highest win rates
    if (guidance.regimeHints) {
      for (const hint of guidance.regimeHints.slice(0, 2)) {
        const variant = { ...baseParams };
        // If trending regime dominates DNA wins, slightly relax ATR floor to catch more trends
        if (hint.regime === 'trending' && hint.winRate > 0.65) {
          variant.atrMin = Math.max((baseParams.atrMin ?? 1.0) * 0.92, 0.5);
        }
        // If volatile regime wins, raise ATR floor to filter choppy noise
        if (hint.regime === 'volatile' && hint.winRate > 0.65) {
          variant.atrMin = Math.min((baseParams.atrMin ?? 1.0) * 1.08, 3.0);
        }
        candidates.push(makeVariant(variant, 'dna', 'dna_guided', 0));
      }
    }

    // Bias confidence threshold based on DNA top combos
    if (guidance.thresholdHint != null) {
      const variant = { ...baseParams, minConfidence: guidance.thresholdHint };
      candidates.push(makeVariant(variant, 'dna', 'dna_guided', 0));
    }

    // Session-focused variants: tighten params for strong sessions
    if (guidance.bestSessions && guidance.bestSessions.length > 0) {
      const variant = { ...baseParams };
      // Best session hint drives a slightly more aggressive confidence floor
      if (guidance.bestSessions[0].winRate > 0.68) {
        variant.minConfidence = Math.max((baseParams.minConfidence ?? 60) - 2, 55);
      }
      candidates.push(makeVariant(variant, 'dna', 'dna_guided', 0));
    }
  }

  // Fill remaining slots with standard perturbation
  const standardCount = Math.max(0, count - candidates.length);
  if (standardCount > 0) {
    const standardCandidates = generateCandidates(baseParams, instrument, standardCount);
    for (const p of standardCandidates) {
      candidates.push(makeVariant(p, 'perturb', 'perturb', 0));
    }
  }

  return candidates.slice(0, count);
}

// ── Variant evaluation ────────────────────────────────────────────────────────

function evaluateVariant(variant, bars1m, opts) {
  try {
    const result = runBacktest(bars1m, variant.params, {
      cooldown: opts.cooldown ?? 2,
      slippage: opts.slippage ?? 0.5,
    });
    const metrics = result.metrics;
    const score   = multiObjectiveScore(metrics);

    return {
      ...variant,
      lastScore:   score,
      lastMetrics: metrics,
      lastEvalAt:  new Date().toISOString(),
      valid:       metrics.tradeCount >= MIN_TRADES,
    };
  } catch (err) {
    return { ...variant, lastScore: null, lastMetrics: null, valid: false };
  }
}

// ── Promotion logic ───────────────────────────────────────────────────────────

function shouldPromote(variantScore, championScore, variantMetrics, championMetrics) {
  if (variantScore == null || championScore == null) return false;
  if (!validateImprovement(championMetrics, variantMetrics))  return false;
  return (variantScore - championScore) >= PROMOTION_MARGIN;
}

// ── Main evolution cycle ──────────────────────────────────────────────────────

/**
 * Run one evolution cycle for an instrument.
 *
 * Steps:
 *   1. Load current champion + variants from DB
 *   2. Seed new variants if pool is under capacity (DNA-guided + perturbation)
 *   3. Evaluate all variants against current bars
 *   4. Promote best variant if it beats champion
 *   5. Retire stale/weak variants
 *   6. Persist updated state and history
 *
 * @param {Object} db          - better-sqlite3 instance
 * @param {string} instrument  - 'MNQ' | 'MGC'
 * @param {Array}  bars1m      - 1m OHLCV bars
 * @param {Object} [opts]
 * @returns {Object} cycle report
 */
function runEvolutionCycle(db, instrument, bars1m, opts = {}) {
  const state      = loadEvolutionState(db, instrument);
  const liveParams = getParams(db, instrument);
  const dna        = loadDNA(db, instrument);

  state.generation += 1;

  // ── Champion initialisation ───────────────────────────────────────────────
  if (!state.champion) {
    const baseline = runBacktest(bars1m, liveParams, {
      cooldown: opts.cooldown ?? 2,
      slippage: opts.slippage ?? 0.5,
    });
    state.champion = {
      params:      liveParams,
      score:       multiObjectiveScore(baseline.metrics),
      metrics:     baseline.metrics,
      promotedAt:  new Date().toISOString(),
    };
  } else {
    // Re-evaluate champion on fresh bars each cycle
    const baseline = runBacktest(bars1m, state.champion.params, {
      cooldown: opts.cooldown ?? 2,
      slippage: opts.slippage ?? 0.5,
    });
    state.champion.score   = multiObjectiveScore(baseline.metrics);
    state.champion.metrics = baseline.metrics;
  }

  const champScore = state.champion.score;

  // ── Seed new variants ─────────────────────────────────────────────────────
  const seedCount = MAX_VARIANTS - state.variants.length;
  if (seedCount > 0) {
    const newVariants = generateDNAGuidedCandidates(liveParams, instrument, dna, seedCount);
    for (const v of newVariants) {
      v.generation = state.generation;
    }
    state.variants.push(...newVariants);
    state.history.push(makeHistoryEntry('seeded', instrument, state.generation, {
      count: newVariants.length,
      sources: newVariants.map(v => v.source),
    }));
  }

  // ── Evaluate all variants ─────────────────────────────────────────────────
  const evalOpts = { cooldown: opts.cooldown ?? 2, slippage: opts.slippage ?? 0.5 };
  state.variants = state.variants.map(v => evaluateVariant(v, bars1m, evalOpts));

  // ── Evaluate each variant and track improvements ──────────────────────────
  for (const v of state.variants) {
    if (v.lastScore != null && v.lastScore > (v.previousScore ?? -Infinity)) {
      v.staleCycles = 0;
    } else {
      v.staleCycles = (v.staleCycles ?? 0) + 1;
    }
    v.previousScore = v.lastScore;

    state.history.push(makeHistoryEntry('evaluated', instrument, state.generation, {
      variantId: v.id,
      score:     v.lastScore,
      winRate:   v.lastMetrics?.winRate ?? null,
      source:    v.source,
    }));
  }

  // ── Find best variant ─────────────────────────────────────────────────────
  const validVariants = state.variants.filter(v => v.valid && v.lastScore != null);
  validVariants.sort((a, b) => b.lastScore - a.lastScore);
  const best = validVariants[0] ?? null;

  // ── Promotion check ───────────────────────────────────────────────────────
  let promoted = false;
  let promotedVariant = null;

  if (best && shouldPromote(best.lastScore, champScore, best.lastMetrics, state.champion.metrics)) {
    // Save revision record in DB for traceability
    try {
      saveRevision(db, instrument, state.champion.params, best.params,
        state.champion.metrics, best.lastMetrics, null, 'evolution');
    } catch {}

    // Promote to live params
    saveParams(db, instrument, best.params);

    state.history.push(makeHistoryEntry('promoted', instrument, state.generation, {
      variantId:      best.id,
      source:         best.source,
      oldScore:       champScore,
      newScore:       best.lastScore,
      oldWinRate:     state.champion.metrics.winRate,
      newWinRate:     best.lastMetrics.winRate,
      delta:          best.lastScore - champScore,
    }));

    // Update champion
    state.champion = {
      params:      best.params,
      score:       best.lastScore,
      metrics:     best.lastMetrics,
      promotedAt:  new Date().toISOString(),
      promotedFrom: best.id,
    };

    promotedVariant = best;
    promoted = true;

    // Remove the promoted variant from the pool — it is now the champion
    state.variants = state.variants.filter(v => v.id !== best.id);
  }

  // ── Retire stale / invalid variants ──────────────────────────────────────
  const retired = [];
  state.variants = state.variants.filter(v => {
    const tooStale    = v.staleCycles >= STALE_CYCLES;
    const tooWeak     = v.valid && v.lastScore != null && v.lastScore < (champScore * 0.7);
    const invalid     = !v.valid && v.lastEvalAt != null; // evaluated but no trades
    if (tooStale || tooWeak || invalid) {
      retired.push(v.id);
      return false;
    }
    return true;
  });

  if (retired.length > 0) {
    state.history.push(makeHistoryEntry('retired', instrument, state.generation, {
      variantIds: retired,
      reason: 'stale_or_weak',
    }));
  }

  // ── Trim history ──────────────────────────────────────────────────────────
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }

  state.lastRunAt = new Date().toISOString();

  // ── Persist ───────────────────────────────────────────────────────────────
  saveEvolutionState(db, instrument, state);

  return buildEvolutionReport({
    instrument,
    generation:  state.generation,
    champScore,
    champion:    state.champion,
    variants:    state.variants,
    best,
    promoted,
    promotedVariant,
    retired,
    dnaActive:   !!dna,
  });
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildEvolutionReport(data) {
  const {
    instrument, generation, champScore, champion, variants,
    best, promoted, promotedVariant, retired, dnaActive,
  } = data;

  const pct = v => `${((v ?? 0) * 100).toFixed(1)}%`;

  const lines = [
    `──── EVOLUTION REPORT: ${instrument} (gen ${generation}) ────────────────────`,
    `Champion  score=${champScore?.toFixed(3) ?? 'n/a'}  win=${pct(champion?.metrics?.winRate)}  pf=${champion?.metrics?.profitFactor?.toFixed(2) ?? 'n/a'}`,
    `DNA-guided: ${dnaActive ? 'YES' : 'no'}`,
    ``,
    `VARIANTS (${variants.length}/${MAX_VARIANTS})`,
    ...variants.map(v =>
      `  [${v.id.slice(0, 12)}] src=${v.source.padEnd(10)} score=${v.lastScore?.toFixed(3) ?? 'n/a'}  win=${pct(v.lastMetrics?.winRate)}  stale=${v.staleCycles}`
    ),
    ``,
  ];

  if (promoted && promotedVariant) {
    lines.push(`✓ PROMOTED variant ${promotedVariant.id.slice(0, 12)} (src=${promotedVariant.source})`);
    lines.push(`  Δ score ${champScore?.toFixed(3)} → ${promotedVariant.lastScore?.toFixed(3)}`);
    lines.push(`  Δ winRate ${pct(champion?.metrics?.winRate)} → ${pct(promotedVariant.lastMetrics?.winRate)}`);
  } else {
    lines.push(`  No promotion this cycle (best delta: ${best ? (best.lastScore - champScore).toFixed(3) : 'n/a'})`);
  }

  if (retired.length > 0) {
    lines.push(`  Retired ${retired.length} stale/weak variant(s)`);
  }

  return {
    report:     lines.join('\n'),
    instrument,
    generation,
    champScore,
    promoted,
    promotedVariant: promotedVariant ? {
      id:      promotedVariant.id,
      source:  promotedVariant.source,
      score:   promotedVariant.lastScore,
      winRate: promotedVariant.lastMetrics?.winRate,
    } : null,
    variantCount: variants.length,
    retired,
  };
}

// ── Evolution history query ───────────────────────────────────────────────────

/**
 * Return evolution history for an instrument, optionally filtered by type.
 */
function getEvolutionHistory(db, instrument, limit = 50, type = null) {
  const state = loadEvolutionState(db, instrument);
  let history = state.history ?? [];
  if (type) history = history.filter(e => e.type === type);
  return {
    instrument,
    generation:  state.generation,
    champion:    state.champion ? {
      score:    state.champion.score,
      winRate:  state.champion.metrics?.winRate,
      promotedAt: state.champion.promotedAt,
    } : null,
    history: history.slice(-limit).reverse(),
  };
}

/**
 * Return the current variant pool summary.
 */
function getVariantPoolStatus(db, instrument) {
  const state = loadEvolutionState(db, instrument);
  return {
    instrument,
    generation:  state.generation,
    champion:    state.champion,
    variants:    (state.variants ?? []).map(v => ({
      id:          v.id,
      source:      v.source,
      generation:  v.generation,
      score:       v.lastScore,
      winRate:     v.lastMetrics?.winRate ?? null,
      tradeCount:  v.lastMetrics?.tradeCount ?? null,
      staleCycles: v.staleCycles,
      createdAt:   v.createdAt,
      lastEvalAt:  v.lastEvalAt,
    })),
    lastRunAt:   state.lastRunAt,
  };
}

module.exports = {
  runEvolutionCycle,
  getEvolutionHistory,
  getVariantPoolStatus,
  loadEvolutionState,
  saveEvolutionState,
};
