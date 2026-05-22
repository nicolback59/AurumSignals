'use strict';

/**
 * FORENSICS ANALYST AGENT — Layer 2
 *
 * Sends loss forensics data to the Claude API weekly. Uses tool use to
 * apply concrete threshold changes directly to the DB via ThresholdManager,
 * and returns plain-English strategy adjustments.
 *
 * Required env var : ANTHROPIC_API_KEY
 * Optional env var : FORENSICS_MODEL  (default: claude-sonnet-4-6)
 *
 * Output is persisted to strategy_params as AI_FORENSICS_<weekStart>
 * and exposed via GET /api/forensics/ai-analysis.
 */

const { getForensicsSummary, detectClusters } = require('../signals/loss-forensics');
const thresholdManager = require('./threshold-manager');

const MODEL       = process.env.FORENSICS_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS  = 2048;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // re-run at most every 6 h

const ALL_STRATEGIES  = ['MGC_SCALP', 'MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_INTRADAY'];
const LIVE_STRATEGIES = new Set(['MGC_SCALP', 'MNQ_INTRADAY']);

// ── Tool definition for threshold adjustments ────────────────────────────────

const ADJUST_TOOL = {
  name: 'apply_adjustments',
  description: [
    'Apply quantitative threshold adjustments based on loss forensics analysis.',
    'Call this once with all changes. Omit a field to leave it unchanged.',
    'Safety bounds are enforced server-side — propose the ideal value; the system will clamp if needed.',
    'Only adjust LIVE strategies (MGC_SCALP, MNQ_INTRADAY) unless clearly specified.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      live_threshold_changes: {
        type: 'array',
        description: 'Changes to per-strategy minimum confidence thresholds (MNQ_INTRADAY or MGC_SCALP only).',
        items: {
          type: 'object',
          properties: {
            strategy:  { type: 'string', description: 'e.g. MNQ_INTRADAY or MGC_SCALP' },
            new_value: { type: 'number', description: 'New confidence minimum (integer 0–100)' },
            rationale: { type: 'string', description: '1-sentence reason' },
          },
          required: ['strategy', 'new_value', 'rationale'],
        },
      },
      strong_a_change: {
        type: 'object',
        description: 'Change to the quant score minimum for an A-grade signal to fire live.',
        properties: {
          new_value: { type: 'number', description: 'New STRONG_A threshold (integer 60–85)' },
          rationale: { type: 'string' },
        },
        required: ['new_value', 'rationale'],
      },
      session_blocks: {
        type: 'array',
        description: 'Block or unblock a strategy from trading during a specific session.',
        items: {
          type: 'object',
          properties: {
            strategy: { type: 'string', description: 'e.g. MGC_SCALP' },
            session:  { type: 'string', description: 'e.g. ASIAN, OVERNIGHT, NY_PRE' },
            action:   { type: 'string', enum: ['BLOCK', 'ALLOW'], description: 'Block or re-allow' },
            rationale: { type: 'string' },
          },
          required: ['strategy', 'session', 'action', 'rationale'],
        },
      },
      summary: {
        type: 'string',
        description: '2–4 sentence plain-English summary of what changes were made and why.',
      },
    },
    required: ['summary'],
  },
};

// ── Prompt builder ────────────────────────────────────────────────────────────

function _buildPrompt(forensicsData, metrics, effectiveThresholds) {
  const m  = metrics ?? {};
  const et = effectiveThresholds ?? {};
  const lt = et.live_thresholds ?? {};

  const lines = [
    '# AurumSignals — Weekly Loss Forensics Analysis',
    '',
    'You are a quantitative trading strategy analyst reviewing loss forensics data for an',
    'automated futures trading system. The system trades MNQ (Micro E-mini Nasdaq-100) and',
    'MGC (Micro Gold) futures via a rule-based scanner with dynamic confidence scoring.',
    '',
    '## Overall Weekly Performance',
    `- Win rate        : ${m.win_rate_pct ?? 'N/A'}%`,
    `- Profit factor   : ${m.profit_factor ?? 'N/A'}`,
    `- Total trades    : ${m.total_trades ?? 0}`,
    `- Expectancy      : ${m.expectancy_pts ?? 'N/A'} pts/trade`,
    `- Max drawdown    : ${m.max_drawdown_pts ?? 'N/A'} pts`,
    `- Max loss streak : ${m.max_loss_streak ?? 'N/A'}`,
    '',
    '## Strategy Status',
    '- LIVE  (real money): MGC_SCALP, MNQ_INTRADAY',
    '- RESEARCH (paper)  : MNQ_SWING, MNQ_50PT, MGC_INTRADAY',
    '',
    '## Current Effective Thresholds',
    `- MNQ_INTRADAY live confidence min : ${lt.MNQ_INTRADAY ?? 67}`,
    `- MGC_SCALP    live confidence min : ${lt.MGC_SCALP    ?? 60}`,
    `- STRONG_A quant score min         : ${et.strong_a     ?? 71}  (A-grade signals below this are research-only)`,
    '',
    '## Loss Forensics by Strategy — last 14 days',
    '',
  ];

  const summary  = forensicsData.summary  ?? {};
  const clusters = forensicsData.clusters ?? [];

  for (const [strategy, rows] of Object.entries(summary)) {
    const totalLosses = rows.reduce((s, r) => s + (r.count ?? 0), 0);
    const tag = LIVE_STRATEGIES.has(strategy) ? '[LIVE]' : '[RESEARCH]';
    lines.push(`### ${strategy} ${tag} — ${totalLosses} losing/expired trades`);

    if (rows.length === 0) {
      lines.push('  No loss data for this period.');
      lines.push('');
      continue;
    }

    for (const row of rows.slice(0, 6)) {
      const pct = totalLosses > 0 ? Math.round((row.count / totalLosses) * 100) : 0;
      lines.push(`  - **${row.failure_category}**: ${row.count} trades (${pct}%)`);

      const details = [];
      if (row.avg_hold  != null) details.push(`avg hold ${row.avg_hold.toFixed(1)} min`);
      if (row.avg_mfe   != null) details.push(`avg MFE ${row.avg_mfe.toFixed(1)} pts`);
      if (row.avg_mae   != null) details.push(`avg MAE ${row.avg_mae.toFixed(1)} pts`);
      if (row.avg_conf  != null) details.push(`avg confidence ${row.avg_conf.toFixed(1)}%`);
      if (row.avg_quant != null) details.push(`avg quant score ${row.avg_quant.toFixed(1)}`);
      if (details.length) lines.push(`    (${details.join(', ')})`);
    }
    lines.push('');
  }

  if (clusters.length > 0) {
    lines.push('## Active Cluster Warnings');
    for (const c of clusters) {
      lines.push(`- **${c.strategy}** — ${c.type}`);
      for (const p of c.patterns ?? []) {
        const consec = p.consecutive ? ` — ${p.consecutive} consecutive` : '';
        lines.push(`  * ${p.dimension}: ${p.value} (${p.count}/${c.total} = ${p.pct}%${consec})`);
      }
    }
    lines.push('');
  }

  lines.push(
    '## Your Task',
    '',
    'Analyze the failure taxonomy above and use the `apply_adjustments` tool to make specific,',
    'quantitative threshold changes. You MUST call the tool — even if only to confirm no changes',
    'are needed (set changes to empty arrays and explain in the summary field).',
    '',
    'Levers available via the tool:',
    '  • live_threshold_changes — raise/lower confidence minimum for MGC_SCALP or MNQ_INTRADAY',
    '  • strong_a_change        — raise/lower the quant score minimum for live A-grade signals',
    '  • session_blocks         — block a strategy from trading in a specific session',
    '',
    'Prioritise LIVE strategies. Be conservative — max ±5 pts/week on confidence thresholds.',
    'After calling the tool, write a plain-English analysis with these sections:',
    '',
    '## PRIORITY ADJUSTMENTS',
    '1–3 numbered items explaining what was adjusted and why.',
    '',
    '## PER-STRATEGY ANALYSIS',
    'For each strategy with meaningful data (≥3 losses): 2–4 bullet points.',
    '',
    '## MONITORING FLAGS',
    'Patterns that need more data before acting. 2–4 items.',
  );

  return lines.join('\n');
}

// ── Main agent function ───────────────────────────────────────────────────────

/**
 * Run the forensics analyst agent.
 * Calls Claude API with this week's loss forensics data and returns
 * plain-English strategy adjustments persisted to the DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} reportMetrics - from generateWeeklyDeepReport().metrics (may be partial)
 * @param {string} [weekStart]   - ISO date e.g. '2025-05-19'
 * @returns {Promise<{adjustments:string, model:string, generated_at:string}|null>}
 */
async function runForensicsAnalysis(db, reportMetrics = {}, weekStart) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[forensics-analyst] ANTHROPIC_API_KEY not set — skipping AI analysis');
    return null;
  }

  const ws       = weekStart ?? new Date().toISOString().slice(0, 10);
  const cacheKey = `AI_FORENSICS_${ws}`;

  // Return cached result if fresh
  try {
    const cached = db.prepare(
      'SELECT params_json, updated_at FROM strategy_params WHERE instrument = ?'
    ).get(cacheKey);
    if (cached?.params_json) {
      const ageMs = Date.now() - new Date(cached.updated_at ?? 0).getTime();
      if (ageMs < CACHE_TTL_MS) {
        console.log(`[forensics-analyst] Returning cached analysis (age ${Math.round(ageMs / 60000)} min)`);
        return JSON.parse(cached.params_json);
      }
    }
  } catch {}

  // Gather forensics data for all strategies
  const summary = {};
  const clusterWarnings = [];
  for (const strat of ALL_STRATEGIES) {
    summary[strat] = getForensicsSummary(db, strat, 14);
    const cluster  = detectClusters(db, strat, 10);
    if (cluster) clusterWarnings.push(cluster);
  }

  const hasData = Object.values(summary).some(rows => rows.length > 0);
  if (!hasData) {
    console.log('[forensics-analyst] No loss forensics data yet — skipping AI analysis (run will retry next week)');
    return null;
  }

  // Pass current effective thresholds so Claude knows the baseline
  const effectiveThresholds = thresholdManager.initialized
    ? thresholdManager.getCurrentEffective()
    : null;

  const prompt = _buildPrompt({ summary, clusters: clusterWarnings }, reportMetrics, effectiveThresholds);

  // Lazy-load the SDK — server starts fine even without the package installed
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    console.error('[forensics-analyst] @anthropic-ai/sdk not installed. Run: npm install @anthropic-ai/sdk');
    return null;
  }

  try {
    const client = new Anthropic.default({ apiKey });
    console.log(`[forensics-analyst] Calling Claude (${MODEL}) for weekly forensics analysis…`);

    // First turn: ask Claude to analyze and call the tool
    const msg = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     'You are a precise quantitative trading analyst. Use the apply_adjustments tool to record your threshold changes, then write a concise analysis. Base decisions only on the data provided.',
      tools:      [ADJUST_TOOL],
      messages:   [{ role: 'user', content: prompt }],
    });

    // Extract tool use block and apply changes
    const toolBlock = msg.content?.find(b => b.type === 'tool_use' && b.name === 'apply_adjustments');
    const appliedChanges = [];

    if (toolBlock?.input && thresholdManager.initialized) {
      const inp = toolBlock.input;

      // Apply live threshold changes
      for (const change of inp.live_threshold_changes ?? []) {
        const key    = `LIVE_THRESHOLD:${change.strategy}`;
        const result = thresholdManager.applyChange(key, change.new_value, change.rationale, ws);
        appliedChanges.push({ key, ...change, result });
        console.log(`[forensics-analyst] ${key}: ${result.ok ? (result.id ? `changed → ${change.new_value}${result.clamped ? ` (clamped from ${change.new_value} to ${result.effective})` : ''}` : result.reason) : `REJECTED — ${result.reason}`}`);
      }

      // Apply STRONG_A change
      if (inp.strong_a_change) {
        const result = thresholdManager.applyChange('STRONG_A', inp.strong_a_change.new_value, inp.strong_a_change.rationale, ws);
        appliedChanges.push({ key: 'STRONG_A', ...inp.strong_a_change, result });
        console.log(`[forensics-analyst] STRONG_A: ${result.ok ? (result.id ? `changed → ${inp.strong_a_change.new_value}` : result.reason) : `REJECTED — ${result.reason}`}`);
      }

      // Apply session blocks
      for (const block of inp.session_blocks ?? []) {
        const key    = `SESSION_BLOCK:${block.strategy}:${block.session}`;
        const result = thresholdManager.applyChange(key, block.action, block.rationale, ws);
        appliedChanges.push({ key, ...block, result });
        console.log(`[forensics-analyst] ${key}: ${result.ok ? (result.id ? block.action : result.reason) : `REJECTED — ${result.reason}`}`);
      }
    } else if (toolBlock && !thresholdManager.initialized) {
      console.warn('[forensics-analyst] ThresholdManager not initialized — changes logged but not applied');
    }

    // Second turn: get the plain-English analysis text
    const assistantTurn = { role: 'assistant', content: msg.content };
    const toolResult    = toolBlock
      ? { type: 'tool_result', tool_use_id: toolBlock.id, content: 'Changes applied successfully.' }
      : null;

    let analysisText = '';
    if (toolResult) {
      const followUp = await client.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     'You are a precise quantitative trading analyst.',
        tools:      [ADJUST_TOOL],
        messages:   [
          { role: 'user',      content: prompt },
          assistantTurn,
          { role: 'user',      content: [toolResult] },
        ],
      });
      analysisText = followUp.content?.find(b => b.type === 'text')?.text ?? '';
    } else {
      // Claude didn't call the tool — grab any text it produced
      analysisText = msg.content?.find(b => b.type === 'text')?.text ?? '';
    }

    const result = {
      adjustments:      analysisText,
      applied_changes:  appliedChanges,
      model:            MODEL,
      week_start:       ws,
      input_tokens:     msg.usage?.input_tokens  ?? null,
      output_tokens:    msg.usage?.output_tokens ?? null,
      generated_at:     new Date().toISOString(),
      strategies_analyzed: ALL_STRATEGIES.filter(s => (summary[s] ?? []).length > 0),
      cluster_count:    clusterWarnings.length,
    };

    db.prepare(`
      INSERT INTO strategy_params (instrument, params_json, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(instrument) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = datetime('now')
    `).run(cacheKey, JSON.stringify(result));

    console.log(
      `[forensics-analyst] Analysis done — ${result.input_tokens ?? '?'} in / ${result.output_tokens ?? '?'} out tokens, ${appliedChanges.filter(c => c.result?.id).length} threshold(s) changed`
    );
    return result;
  } catch (err) {
    console.error('[forensics-analyst] Claude API error:', err.message);
    return null;
  }
}

// ── DB loader ─────────────────────────────────────────────────────────────────

/**
 * Load the most recent AI forensics analysis.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [weekStart] - if omitted, returns the latest entry
 */
function loadForensicsAnalysis(db, weekStart = null) {
  try {
    if (weekStart) {
      const row = db.prepare(
        'SELECT params_json FROM strategy_params WHERE instrument = ?'
      ).get(`AI_FORENSICS_${weekStart}`);
      return row ? JSON.parse(row.params_json) : null;
    }
    const row = db.prepare(`
      SELECT params_json FROM strategy_params
      WHERE  instrument LIKE 'AI_FORENSICS_%'
      ORDER  BY updated_at DESC
      LIMIT  1
    `).get();
    return row ? JSON.parse(row.params_json) : null;
  } catch {
    return null;
  }
}

module.exports = { runForensicsAnalysis, loadForensicsAnalysis };
