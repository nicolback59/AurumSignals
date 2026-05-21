'use strict';

/**
 * FORENSICS ANALYST AGENT — Layer 2
 *
 * Sends loss forensics data to the Claude API weekly and returns
 * plain-English strategy adjustments. This is the first real AI agent
 * layer — it reads proprietary labeled failure data and recommends
 * specific, quantitative threshold changes.
 *
 * Required env var : ANTHROPIC_API_KEY
 * Optional env var : FORENSICS_MODEL  (default: claude-sonnet-4-6)
 *
 * Output is persisted to strategy_params as AI_FORENSICS_<weekStart>
 * and exposed via GET /api/forensics/ai-analysis.
 */

const { getForensicsSummary, detectClusters } = require('../signals/loss-forensics');

const MODEL       = process.env.FORENSICS_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS  = 2048;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // re-run at most every 6 h

const ALL_STRATEGIES  = ['MGC_SCALP', 'MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_INTRADAY'];
const LIVE_STRATEGIES = new Set(['MGC_SCALP', 'MNQ_INTRADAY']);

// ── Prompt builder ────────────────────────────────────────────────────────────

function _buildPrompt(forensicsData, metrics) {
  const m = metrics ?? {};

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
    'Analyze the failure taxonomy above and return **specific, quantitative, actionable adjustments**.',
    'You have access to these levers:',
    '  • Confidence score minimum per strategy (currently ~60–68 range)',
    '  • Quant score minimum per strategy (currently ~60–65 range)',
    '  • Session blocklist (which sessions to skip signals for)',
    '  • HTF bias strictness (require BULL/BEAR, reject MIXED)',
    '  • Regime filter (pause in RANGE_CHOP, SOFT_CHOP)',
    '  • Hold-time caps (exit after N minutes if no progress)',
    '',
    'Prioritise LIVE strategies (MGC_SCALP, MNQ_INTRADAY) for immediate action.',
    'Be specific — say "raise MGC_SCALP confidence minimum from 62 to 68" not "increase confidence".',
    '',
    '**Response format (use exactly these section headers):**',
    '',
    '## PRIORITY ADJUSTMENTS',
    '1–3 numbered items. LIVE strategies only. Implement this week.',
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

  const prompt = _buildPrompt({ summary, clusters: clusterWarnings }, reportMetrics);

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

    const msg = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     'You are a precise quantitative trading analyst. Return concise, numbered, specific recommendations based only on the data provided. No preamble.',
      messages:   [{ role: 'user', content: prompt }],
    });

    const text = msg.content?.find(b => b.type === 'text')?.text ?? '';
    if (!text) {
      console.error('[forensics-analyst] Empty response from Claude');
      return null;
    }

    const result = {
      adjustments:   text,
      model:         MODEL,
      week_start:    ws,
      input_tokens:  msg.usage?.input_tokens  ?? null,
      output_tokens: msg.usage?.output_tokens ?? null,
      generated_at:  new Date().toISOString(),
      strategies_analyzed: ALL_STRATEGIES.filter(s => (summary[s] ?? []).length > 0),
      cluster_count: clusterWarnings.length,
    };

    db.prepare(`
      INSERT INTO strategy_params (instrument, params_json, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(instrument) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = datetime('now')
    `).run(cacheKey, JSON.stringify(result));

    console.log(
      `[forensics-analyst] Analysis done — ${result.input_tokens ?? '?'} in / ${result.output_tokens ?? '?'} out tokens`
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
