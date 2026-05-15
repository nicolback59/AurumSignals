'use strict';

/**
 * ALERT PAYLOAD SCHEMA — canonical signal object
 *
 * Every signal emitted to the SSE stream, ntfy, and stored in raw_payload
 * uses this exact shape. Version-stamped so consumers can evolve safely.
 *
 * Schema version: 2
 *   v1 — original ad-hoc shape (no version field)
 *   v2 — this module; structured, typed, internal fields stripped
 *
 * Field groups:
 *   identity     — what signal this is
 *   quality      — tier / confidence / grade / win probabilities
 *   levels       — entry, SL, TP1-4, RR
 *   context      — session, HTF bias, prediction
 *   state        — trade_status, timestamps
 *   meta         — trigger reason, strategy-specific indicators (compact)
 */

const SCHEMA_VERSION = 2;

// Internal fields that should never appear in the emitted payload
const STRIP_KEYS = new Set([
  '_ocSessionKey', '_ocBias', 'openingCandleAdj',
  'predicted_wr_factors', 'predicted_wr_regime',
  'predicted_wr_dynamic_note',
  'indicators',   // moved to meta.indicators
  'trade_status', // top-level; added separately as state.trade_status
]);

/**
 * Build the canonical alert payload from a raw strategy signal + enrichment.
 *
 * @param {object} raw        - raw signal from strategy + scanner enrichment
 * @param {object} [extras]   - additional fields: { id, received_at, rank }
 * @returns {object}          - canonical alert payload (schema v2)
 */
function buildAlertPayload(raw, extras = {}) {
  const {
    id          = null,
    received_at = new Date().toISOString(),
    rank        = null,   // result of rankSignal() — { tier, adjustedConfidence, session, sessionModifier }
  } = extras;

  // ── Identity ───────────────────────────────────────────────────────────────
  const identity = {
    v:             SCHEMA_VERSION,
    id,
    fingerprint:   raw.fingerprint   ?? null,
    instrument:    raw.instrument    ?? null,
    ticker:        raw.ticker        ?? `${raw.instrument ?? ''}1!`,
    strategy_name: raw.strategy_name ?? null,
    trade_style:   raw.trade_style   ?? null,
    timeframe:     raw.timeframe     ?? '5m',
    direction:     raw.direction,
  };

  // ── Quality ────────────────────────────────────────────────────────────────
  const quality = {
    tier:               rank?.tier               ?? raw.tier               ?? null,
    session_modifier:   rank?.sessionModifier     ?? null,
    adjusted_confidence:rank?.adjustedConfidence  ?? raw.adjusted_confidence ?? raw.confidence ?? null,
    confidence:         raw.confidence            ?? null,
    grade:              raw.grade                 ?? null,
    score:              raw.score                 ?? null,
    win_prob_tp1:       raw.win_prob_tp1          ?? null,
    win_prob_tp2:       raw.win_prob_tp2          ?? null,
    win_prob_tp3:       raw.win_prob_tp3          ?? null,
    win_prob_tp4:       raw.win_prob_tp4          ?? null,
    dna_score:          raw.dnaScore              ?? null,
  };

  // ── Levels ─────────────────────────────────────────────────────────────────
  const levels = {
    entry: raw.entry ?? null,
    sl:    raw.sl    ?? null,
    tp1:   raw.tp1   ?? null,
    tp2:   raw.tp2   ?? null,
    tp3:   raw.tp3   ?? null,
    tp4:   raw.tp4   ?? null,
    rr:    raw.rr    ?? null,
  };

  // ── Context ────────────────────────────────────────────────────────────────
  const context = {
    session:  rank?.session ?? raw.session  ?? null,
    htf_bias: raw.htf_bias  ?? null,
    setup:    raw.setup      ?? null,
    prediction: _buildPrediction(raw),
  };

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    trade_status: raw.trade_status ?? 'ACTIVE',
    received_at,
    bar_time:     raw.timestamp    ?? null,
  };

  // ── Meta ───────────────────────────────────────────────────────────────────
  const meta = {
    trigger_reason: raw.trigger_reason  ?? null,
    indicators:     _compactIndicators(raw.indicators ?? {}),
  };

  return { ...identity, quality, levels, context, state, meta };
}

/**
 * Flatten a v2 payload back to a flat object for DB storage / backwards compat.
 * API endpoints and the SSE stream may need this.
 */
function flattenPayload(p) {
  if (!p || p.v !== SCHEMA_VERSION) return p;  // already flat or unknown version
  return {
    v:             p.v,
    id:            p.id,
    fingerprint:   p.fingerprint,
    instrument:    p.instrument,
    ticker:        p.ticker,
    strategy_name: p.strategy_name,
    trade_style:   p.trade_style,
    timeframe:     p.timeframe,
    direction:     p.direction,

    tier:                p.quality?.tier,
    session_modifier:    p.quality?.session_modifier,
    adjusted_confidence: p.quality?.adjusted_confidence,
    confidence:          p.quality?.confidence,
    grade:               p.quality?.grade,
    score:               p.quality?.score,
    win_prob_tp1:        p.quality?.win_prob_tp1,
    win_prob_tp2:        p.quality?.win_prob_tp2,
    win_prob_tp3:        p.quality?.win_prob_tp3,
    win_prob_tp4:        p.quality?.win_prob_tp4,

    entry: p.levels?.entry,
    sl:    p.levels?.sl,
    tp1:   p.levels?.tp1,
    tp2:   p.levels?.tp2,
    tp3:   p.levels?.tp3,
    tp4:   p.levels?.tp4,
    rr:    p.levels?.rr,

    session:          p.context?.session,
    htf_bias:         p.context?.htf_bias,
    setup:            p.context?.setup,
    predicted_wr_pct: p.context?.prediction?.win_rate_pct,
    predicted_wr_band:p.context?.prediction?.band,
    predicted_wr_source: p.context?.prediction?.source,
    predicted_wr_atr_spike: p.context?.prediction?.atr_spike,
    predicted_wr_high_news: p.context?.prediction?.high_news,

    trade_status: p.state?.trade_status,
    received_at:  p.state?.received_at,
    bar_time:     p.state?.bar_time,

    trigger_reason: p.meta?.trigger_reason,
  };
}

/**
 * Build the ntfy notification body from a canonical payload.
 * Always ASCII-safe in headers; emoji allowed in body.
 */
function buildNtfyBody(p) {
  const flat = p.v === SCHEMA_VERSION ? flattenPayload(p) : p;
  const dir  = flat.direction === 'LONG' ? '▲ LONG' : '▼ SHORT';
  const tier = flat.tier ? `[${flat.tier}]` : '';
  const conf = flat.confidence != null ? `Conf: ${flat.confidence}/100` : null;

  // TP1-specific win rate — prefer data-driven predicted WR, fall back to confidence-based estimate
  let tp1WrLine = null;
  if (flat.predicted_wr_pct != null) {
    const band = flat.predicted_wr_band ?? 9;
    const src  = flat.predicted_wr_source === 'confidence-estimate' ? 'est'
               : flat.predicted_wr_source === 'live+backtest'       ? 'live+bt'
               : flat.predicted_wr_source === 'backtest'            ? 'bt'
               : flat.predicted_wr_source === 'live'                ? 'live'
               : (flat.predicted_wr_source ?? '?');
    const spike = flat.predicted_wr_atr_spike ? ' [SPIKE]' : '';
    tp1WrLine = `TP1 WR: ${flat.predicted_wr_pct}%\xb1${band}% (${src})${spike}`;
  } else if (flat.win_prob_tp1 != null) {
    tp1WrLine = `TP1 WR: ${flat.win_prob_tp1}% (est)`;
  }

  const stratMap = {
    MNQ_INTRADAY: 'MNQ Intraday', MNQ_SWING: 'MNQ Swing',
    MNQ_50PT: 'MNQ 50-Point', MGC_SCALP: 'MGC Scalp', MGC_INTRADAY: 'MGC Intraday',
  };
  const stratLabel = stratMap[flat.strategy_name] || flat.setup || flat.strategy_name || '';

  return [
    `${dir} ${tier}  |  ${flat.ticker ?? flat.instrument}`,
    stratLabel      ? `Strategy: ${stratLabel}`         : null,
    flat.trade_style? `Style:    ${flat.trade_style}`   : null,
    flat.entry != null ? `Entry:    ${flat.entry}`      : null,
    flat.sl    != null ? `SL:       ${flat.sl}`         : null,
    flat.tp1   != null ? `TP1:      ${flat.tp1}`        : null,
    flat.tp2   != null ? `TP2:      ${flat.tp2}`        : null,
    flat.tp3   != null ? `TP3:      ${flat.tp3}`        : null,
    flat.tp4   != null ? `TP4:      ${flat.tp4}`        : null,
    flat.rr    != null ? `RR:       ${flat.rr}`         : null,
    conf,
    tp1WrLine,
    flat.session    ? `Session:  ${flat.session}`       : null,
  ].filter(Boolean).join('\n');
}

/**
 * Build ntfy headers (all ASCII — no emoji).
 */
function buildNtfyHeaders(p, cfg = {}) {
  const flat   = p.v === SCHEMA_VERSION ? flattenPayload(p) : p;
  const arrow  = flat.direction === 'LONG' ? '[LONG]' : '[SHORT]';
  const tier   = flat.tier ? `[${flat.tier}]` : '';
  const prio   = (flat.tier === 'S' || flat.grade === 'A+') ? 'urgent' : 'high';
  const tags   = flat.direction === 'LONG'
    ? 'chart_increasing,green_circle'
    : 'chart_decreasing,red_circle';
  const headers = {
    'Content-Type': 'text/plain',
    'Title':    `${arrow} ${tier} ${flat.grade ?? ''} - ${flat.ticker ?? flat.instrument}`.trim(),
    'Priority': prio,
    'Tags':     tags,
  };
  if (cfg.ntfyToken) headers['Authorization'] = `Bearer ${cfg.ntfyToken}`;
  return headers;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildPrediction(raw) {
  if (raw.predicted_wr_pct == null) return null;
  return {
    win_rate_pct: raw.predicted_wr_pct   ?? null,
    band:         raw.predicted_wr_band  ?? null,
    source:       raw.predicted_wr_source ?? null,
    atr_spike:    raw.predicted_wr_atr_spike  ?? false,
    high_news:    raw.predicted_wr_high_news  ?? false,
  };
}

function _compactIndicators(ind) {
  if (!ind || typeof ind !== 'object') return null;
  // Return only numeric/boolean scalar values — strip arrays and nested objects
  const compact = {};
  for (const [k, v] of Object.entries(ind)) {
    if (v !== null && v !== undefined && typeof v !== 'object') {
      compact[k] = v;
    }
  }
  return Object.keys(compact).length ? compact : null;
}

module.exports = { buildAlertPayload, flattenPayload, buildNtfyBody, buildNtfyHeaders, SCHEMA_VERSION };
