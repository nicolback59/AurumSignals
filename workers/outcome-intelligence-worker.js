'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { openDb, heartbeat, logWorkerError, sendNotification } = require('./worker-utils');

const WORKER_NAME = 'outcome-intelligence';
const STRATEGIES  = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT', 'MGC_SCALP'];

function percentile(sorted, p) {
  return sorted[Math.floor(p * sorted.length)];
}

function upsertLog(db, runDate, strategyName, phase, metricKey, metricValue, metricJson, sampleSize, notes) {
  db.prepare(`
    INSERT OR REPLACE INTO outcome_intelligence_log
      (run_date, strategy_name, phase, metric_key, metric_value, metric_json, sample_size, notes, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(runDate, strategyName, phase, metricKey, metricValue, metricJson, sampleSize, notes ?? null);
}

function postAgentMessage(db, strategy, msgType, payload, priority) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (from_agent, to_agent, msg_type, strategy, payload, priority)
      VALUES ('outcome-intelligence', 'consensus', ?, ?, ?, ?)
    `).run(msgType, strategy, JSON.stringify(payload), priority);
  } catch (err) {
    console.warn(`[${WORKER_NAME}] agent_messages insert failed: ${err.message}`);
  }
}

// ── Phase 1 — Trade DNA review ────────────────────────────────────────────────

function runPhase1(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 1 DNA review: ${strategy}`);

  const all = db.prepare(`
    SELECT outcome, direction, pnl_pts, archetype, entry_type, trade_date
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN','LOSS','BE')
    ORDER BY trade_date ASC
  `).all(strategy);

  if (all.length < 5) {
    console.log(`[${WORKER_NAME}] Phase 1 ${strategy}: skipped (N=${all.length} < 5)`);
    return {};
  }

  const wins   = all.filter(r => r.outcome === 'WIN');
  const losses = all.filter(r => r.outcome === 'LOSS');
  const wr     = (wins.length + losses.length) > 0
    ? wins.length / (wins.length + losses.length) : 0;

  const avgPnl     = all.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / all.length;
  const avgWinPts  = wins.length  ? wins.reduce((s, r)   => s + (r.pnl_pts ?? 0), 0) / wins.length   : 0;
  const avgLossPts = losses.length ? losses.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / losses.length : 0;
  const sumWins    = wins.reduce((s, r)   => s + Math.max(r.pnl_pts ?? 0, 0), 0);
  const sumLosses  = losses.reduce((s, r) => s + Math.abs(r.pnl_pts ?? 0), 0);
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : null;

  // Max consecutive losses (chronological order already assured by ORDER BY)
  let maxConsecLosses = 0;
  let curStreak = 0;
  for (const r of all) {
    if (r.outcome === 'LOSS') { curStreak++; maxConsecLosses = Math.max(maxConsecLosses, curStreak); }
    else curStreak = 0;
  }

  // Direction breakdown
  const longRows  = all.filter(r => r.direction === 'LONG');
  const shortRows = all.filter(r => r.direction === 'SHORT');
  const longWins  = longRows.filter(r => r.outcome === 'WIN').length;
  const shortWins = shortRows.filter(r => r.outcome === 'WIN').length;
  const longLosses  = longRows.filter(r => r.outcome === 'LOSS').length;
  const shortLosses = shortRows.filter(r => r.outcome === 'LOSS').length;
  const longWr  = (longWins + longLosses)   > 0 ? longWins  / (longWins  + longLosses)  : null;
  const shortWr = (shortWins + shortLosses) > 0 ? shortWins / (shortWins + shortLosses) : null;

  // Best / worst archetype (≥5 trades)
  const archetypeMap = {};
  for (const r of all) {
    if (!r.archetype) continue;
    if (!archetypeMap[r.archetype]) archetypeMap[r.archetype] = { wins: 0, losses: 0 };
    if (r.outcome === 'WIN')  archetypeMap[r.archetype].wins++;
    if (r.outcome === 'LOSS') archetypeMap[r.archetype].losses++;
  }
  let bestArch = null, worstArch = null, bestArchWr = -1, worstArchWr = 2;
  for (const [arch, s] of Object.entries(archetypeMap)) {
    const total = s.wins + s.losses;
    if (total < 5) continue;
    const aWr = s.wins / total;
    if (aWr > bestArchWr)  { bestArchWr  = aWr;  bestArch  = arch; }
    if (aWr < worstArchWr) { worstArchWr = aWr;  worstArch = arch; }
  }

  // Best / worst entry_type (≥5 trades)
  const entryMap = {};
  for (const r of all) {
    if (!r.entry_type) continue;
    if (!entryMap[r.entry_type]) entryMap[r.entry_type] = { wins: 0, losses: 0 };
    if (r.outcome === 'WIN')  entryMap[r.entry_type].wins++;
    if (r.outcome === 'LOSS') entryMap[r.entry_type].losses++;
  }
  let bestEntry = null, worstEntry = null, bestEntryWr = -1, worstEntryWr = 2;
  for (const [et, s] of Object.entries(entryMap)) {
    const total = s.wins + s.losses;
    if (total < 5) continue;
    const eWr = s.wins / total;
    if (eWr > bestEntryWr)  { bestEntryWr  = eWr;  bestEntry  = et; }
    if (eWr < worstEntryWr) { worstEntryWr = eWr;  worstEntry = et; }
  }

  const summary = {
    total_trades: all.length, win_count: wins.length, loss_count: losses.length,
    be_count: all.filter(r => r.outcome === 'BE').length,
    win_rate: +wr.toFixed(4), avg_pnl_pts: +avgPnl.toFixed(4),
    avg_win_pts: +avgWinPts.toFixed(4), avg_loss_pts: +avgLossPts.toFixed(4),
    profit_factor: profitFactor != null ? +profitFactor.toFixed(4) : null,
    max_consecutive_losses: maxConsecLosses,
    long_wr: longWr != null ? +longWr.toFixed(4) : null,
    short_wr: shortWr != null ? +shortWr.toFixed(4) : null,
    best_archetype: bestArch, best_archetype_wr: bestArchWr > -1 ? +bestArchWr.toFixed(4) : null,
    worst_archetype: worstArch, worst_archetype_wr: worstArchWr < 2 ? +worstArchWr.toFixed(4) : null,
    best_entry_type: bestEntry, best_entry_wr: bestEntryWr > -1 ? +bestEntryWr.toFixed(4) : null,
    worst_entry_type: worstEntry, worst_entry_wr: worstEntryWr < 2 ? +worstEntryWr.toFixed(4) : null,
  };

  upsertLog(db, runDate, strategy, 'dna_review', 'summary', +wr.toFixed(4), JSON.stringify(summary), all.length, null);
  upsertLog(db, runDate, strategy, 'dna_review', 'win_rate',          +wr.toFixed(4),                  null, all.length, null);
  upsertLog(db, runDate, strategy, 'dna_review', 'avg_pnl_pts',       +avgPnl.toFixed(4),              null, all.length, null);
  upsertLog(db, runDate, strategy, 'dna_review', 'profit_factor',     profitFactor != null ? +profitFactor.toFixed(4) : null, null, all.length, null);
  upsertLog(db, runDate, strategy, 'dna_review', 'max_consec_losses', maxConsecLosses,                 null, all.length, null);
  if (longWr  != null) upsertLog(db, runDate, strategy, 'dna_review', 'long_wr',  +longWr.toFixed(4),  null, longRows.length,  null);
  if (shortWr != null) upsertLog(db, runDate, strategy, 'dna_review', 'short_wr', +shortWr.toFixed(4), null, shortRows.length, null);
  if (bestArch)  upsertLog(db, runDate, strategy, 'dna_review', 'best_archetype',  +bestArchWr.toFixed(4),  null, null, bestArch);
  if (worstArch) upsertLog(db, runDate, strategy, 'dna_review', 'worst_archetype', +worstArchWr.toFixed(4), null, null, worstArch);
  if (bestEntry)  upsertLog(db, runDate, strategy, 'dna_review', 'best_entry_type',  +bestEntryWr.toFixed(4),  null, null, bestEntry);
  if (worstEntry) upsertLog(db, runDate, strategy, 'dna_review', 'worst_entry_type', +worstEntryWr.toFixed(4), null, null, worstEntry);

  console.log(`[${WORKER_NAME}] Phase 1 ${strategy}: N=${all.length} WR=${(wr*100).toFixed(1)}% PF=${profitFactor?.toFixed(2) ?? 'n/a'} maxConsecL=${maxConsecLosses}`);
  return { wr, avgPnl, profitFactor, maxConsecLosses };
}

// ── Phase 2 — MFE/MAE extended analysis ──────────────────────────────────────

function runPhase2(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 2 MFE/MAE ext: ${strategy}`);

  // Winner MFE distribution (mfe_sl_ratio = mfe / sl_distance)
  const winRows = db.prepare(`
    SELECT mfe_pts, mfe_sl_ratio, tp1_pts
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome = 'WIN'
      AND mfe_pts IS NOT NULL
    ORDER BY mfe_sl_ratio ASC
  `).all(strategy);

  if (winRows.length >= 10) {
    const mfeSl = winRows.map(r => r.mfe_sl_ratio ?? 0).sort((a, b) => a - b);
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'win_mfe_sl_p25', percentile(mfeSl, 0.25), null, winRows.length, null);
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'win_mfe_sl_p50', percentile(mfeSl, 0.50), null, winRows.length, null);
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'win_mfe_sl_p75', percentile(mfeSl, 0.75), null, winRows.length, null);
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'win_mfe_sl_p90', percentile(mfeSl, 0.90), null, winRows.length, null);

    // MFE efficiency: how much of TP1 did price reach on average (for winners with tp1_pts > 0)
    const withTp1 = winRows.filter(r => r.tp1_pts != null && r.tp1_pts > 0);
    if (withTp1.length >= 5) {
      const efficiency = withTp1.map(r => r.mfe_pts / r.tp1_pts);
      const avgEfficiency = efficiency.reduce((s, v) => s + v, 0) / efficiency.length;
      upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'mfe_tp1_efficiency', +avgEfficiency.toFixed(4), null, withTp1.length, null);
    }
  }

  // Loss MFE distribution — how far in profit did losing trades go before reversing
  const lossRows = db.prepare(`
    SELECT mfe_pts, mfe_sl_ratio
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome = 'LOSS'
      AND mfe_pts IS NOT NULL
    ORDER BY mfe_sl_ratio ASC
  `).all(strategy);

  if (lossRows.length >= 5) {
    const lossMfeSl = lossRows.map(r => r.mfe_sl_ratio ?? 0).sort((a, b) => a - b);
    const avgLossMfe = lossMfeSl.reduce((s, v) => s + v, 0) / lossMfeSl.length;
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'loss_avg_mfe_sl_ratio', +avgLossMfe.toFixed(4), null, lossRows.length, null);
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'loss_mfe_sl_p50',       percentile(lossMfeSl, 0.50), null, lossRows.length, null);

    // "Reversed winners" — losses where price was ≥ 0.75× SL in profit before reversing
    const reversedCount = lossRows.filter(r => (r.mfe_sl_ratio ?? 0) >= 0.75).length;
    const reversedPct   = reversedCount / lossRows.length;
    upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'reversed_winner_pct', +reversedPct.toFixed(4), null, lossRows.length,
      reversedPct >= 0.20 ? 'HIGH_REVERSAL_RATE' : null);
  }

  // TP too tight signal: if median winner mfe_sl_ratio > 1.5 (MFE regularly 1.5× SL = TP is leaving big gains on table)
  if (winRows.length >= 10) {
    const mfeSl = winRows.map(r => r.mfe_sl_ratio ?? 0).sort((a, b) => a - b);
    const medianWinMfe = percentile(mfeSl, 0.50);
    if (medianWinMfe > 1.5) {
      upsertLog(db, runDate, strategy, 'mfe_mae_ext', 'tp_tight_signal', medianWinMfe, null, winRows.length, 'TP_TOO_TIGHT');
      postAgentMessage(db, strategy, 'observation', {
        observation: 'tp_too_tight',
        strategy,
        median_winner_mfe_sl_ratio: +medianWinMfe.toFixed(4),
        note: 'Winners regularly exceed TP1 distance by >1.5x — TP target may be leaving significant gains on table',
        timestamp: new Date().toISOString(),
      }, 3);
    }
  }

  console.log(`[${WORKER_NAME}] Phase 2 ${strategy}: winners=${winRows.length} losses=${lossRows.length}`);
  return { winCount: winRows.length, lossCount: lossRows.length };
}

// ── Phase 3 — MAE deep analysis ───────────────────────────────────────────────

function runPhase3(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 3 MAE analysis: ${strategy}`);

  const rows = db.prepare(`
    SELECT mae_pts, atr, mae_sl_ratio
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome = 'WIN'
      AND mae_pts IS NOT NULL
      AND atr > 0
  `).all(strategy);

  if (rows.length < 10) {
    console.log(`[${WORKER_NAME}] Phase 3 ${strategy}: skipped (N=${rows.length} < 10)`);
    return {};
  }

  const maeAtrValues = rows.map(r => r.mae_pts / r.atr).sort((a, b) => a - b);

  const p50 = percentile(maeAtrValues, 0.5);
  const p75 = percentile(maeAtrValues, 0.75);
  const p90 = percentile(maeAtrValues, 0.9);

  const nearStopCount = rows.filter(r => r.mae_sl_ratio != null && r.mae_sl_ratio >= 0.70).length;
  const nearStopPct   = nearStopCount / rows.length;

  upsertLog(db, runDate, strategy, 'mae_analysis', 'mae_winner_p50_atr',  p50,         null, rows.length, null);
  upsertLog(db, runDate, strategy, 'mae_analysis', 'mae_winner_p75_atr',  p75,         null, rows.length, null);
  upsertLog(db, runDate, strategy, 'mae_analysis', 'mae_winner_p90_atr',  p90,         null, rows.length, null);
  upsertLog(db, runDate, strategy, 'mae_analysis', 'near_stop_winner_pct', nearStopPct, null, rows.length, null);

  console.log(`[${WORKER_NAME}] Phase 3 ${strategy}: N=${rows.length} p50=${p50.toFixed(3)} p75=${p75.toFixed(3)} p90=${p90.toFixed(3)} near_stop=${(nearStopPct*100).toFixed(1)}%`);
  return { p50, p75, p90, nearStopPct, n: rows.length };
}

// ── Phase 8 — Expectancy decomposition ───────────────────────────────────────

function runPhase8(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 8 expectancy decomposition: ${strategy}`);

  const allRows = db.prepare(`
    SELECT outcome, confidence, htf_bias, session, pnl_pts
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS', 'BE')
  `).all(strategy);

  function bucket(rows, key) {
    if (rows.length < 5) return;
    const wins    = rows.filter(r => r.outcome === 'WIN').length;
    const wr      = wins / rows.length;
    const avg_pnl = rows.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / rows.length;
    upsertLog(
      db, runDate, strategy, 'expectancy', key,
      +avg_pnl.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: rows.length }),
      rows.length,
      null,
    );
  }

  const withConf = allRows.filter(r => r.confidence != null);
  bucket(withConf.filter(r => r.confidence >= 80), 'conf_high');
  bucket(withConf.filter(r => r.confidence >= 60 && r.confidence < 80), 'conf_med');
  bucket(withConf.filter(r => r.confidence < 60), 'conf_low');

  const htfGroups = {};
  for (const r of allRows) {
    if (r.htf_bias == null) continue;
    const k = String(r.htf_bias);
    if (!htfGroups[k]) htfGroups[k] = [];
    htfGroups[k].push(r);
  }
  for (const [val, rows] of Object.entries(htfGroups)) {
    if (rows.length >= 5) bucket(rows, `htf_${val}`);
  }

  const sessionGroups = {};
  for (const r of allRows) {
    if (r.session == null) continue;
    if (!sessionGroups[r.session]) sessionGroups[r.session] = [];
    sessionGroups[r.session].push(r);
  }
  for (const [val, rows] of Object.entries(sessionGroups)) {
    if (rows.length >= 5) bucket(rows, `session_${val}`);
  }

  console.log(`[${WORKER_NAME}] Phase 8 ${strategy}: done`);
}

// ── Phase 9 — Regime outcome analysis ────────────────────────────────────────

function runPhase9(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 9 regime analysis: ${strategy}`);

  const rows = db.prepare(`
    SELECT regime,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total,
           AVG(pnl_pts) AS avg_pnl
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
      AND regime IS NOT NULL
    GROUP BY regime
  `).all(strategy);

  const results = [];

  for (const r of rows) {
    const counted = r.wins + r.losses;
    if (counted < 5) continue;

    const wr      = r.wins / counted;
    const avg_pnl = r.avg_pnl ?? 0;

    upsertLog(
      db, runDate, strategy, 'regime', r.regime,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: r.total }),
      r.total,
      null,
    );

    results.push({ regime: r.regime, wr, trade_count: r.total, avg_pnl });

    if (counted >= 10 && (wr > 0.70 || wr < 0.40)) {
      postAgentMessage(db, strategy, 'observation', {
        observation: 'regime_edge_detected',
        strategy,
        regime:      r.regime,
        wr:          +wr.toFixed(4),
        avg_pnl:     +avg_pnl.toFixed(4),
        trade_count: r.total,
        timestamp:   new Date().toISOString(),
      }, wr > 0.70 ? 2 : 3);
    }
  }

  console.log(`[${WORKER_NAME}] Phase 9 ${strategy}: ${results.length} regimes`);
  return results;
}

// ── Phase 10 — Session outcome analysis ──────────────────────────────────────

function runPhase10(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 10 session analysis: ${strategy}`);

  const rows = db.prepare(`
    SELECT session,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total,
           AVG(pnl_pts) AS avg_pnl,
           AVG(hold_time_min) AS avg_hold
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS', 'BE')
      AND session IS NOT NULL
    GROUP BY session
  `).all(strategy);

  const results = [];

  for (const r of rows) {
    if (r.total < 5) continue;

    const counted = r.wins + r.losses;
    const wr      = counted > 0 ? r.wins / counted : 0;
    const avg_pnl = r.avg_pnl ?? 0;
    const avg_hold = r.avg_hold ?? 0;

    upsertLog(
      db, runDate, strategy, 'session', r.session,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: r.total, avg_hold_min: +avg_hold.toFixed(2) }),
      r.total,
      null,
    );

    results.push({ session: r.session, wr, avg_pnl, trade_count: r.total, avg_hold_min: avg_hold });
  }

  console.log(`[${WORKER_NAME}] Phase 10 ${strategy}: ${results.length} sessions`);
  return results;
}

// ── Phase 13 — Edge discovery ─────────────────────────────────────────────────

function runPhase13(db, strategy, runDate) {
  console.log(`[${WORKER_NAME}] Phase 13 edge discovery: ${strategy}`);

  const allRows = db.prepare(`
    SELECT outcome, regime, session, hour_et, pnl_pts
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
      AND regime IS NOT NULL
      AND session IS NOT NULL
  `).all(strategy);

  const totalRows = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
  `).get(strategy);

  const baselineWr = (totalRows && totalRows.n > 0)
    ? totalRows.wins / totalRows.n
    : 0;

  let edgesFound = 0;

  // ── Regime × Session cross ────────────────────────────────────────────────
  const crossMap = {};
  for (const r of allRows) {
    const k = `${r.regime}_${r.session}`;
    if (!crossMap[k]) crossMap[k] = { wins: 0, losses: 0, pnl: 0 };
    if (r.outcome === 'WIN')  crossMap[k].wins++;
    else                      crossMap[k].losses++;
    crossMap[k].pnl += r.pnl_pts ?? 0;
  }

  for (const [key, s] of Object.entries(crossMap)) {
    const total = s.wins + s.losses;
    if (total < 8) continue;

    const wr      = s.wins / total;
    const avg_pnl = s.pnl / total;

    upsertLog(
      db, runDate, strategy, 'edge_cross', key,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: total }),
      total,
      wr >= baselineWr + 0.15 ? 'EDGE_FOUND' : null,
    );

    if (wr >= 0.75) {
      postAgentMessage(db, strategy, 'observation', {
        observation: 'cross_edge_detected',
        strategy,
        combo:       key,
        wr:          +wr.toFixed(4),
        avg_pnl:     +avg_pnl.toFixed(4),
        trade_count: total,
        timestamp:   new Date().toISOString(),
      }, 2);
      edgesFound++;
    }
  }

  // ── Hour-of-day patterns ──────────────────────────────────────────────────
  const hourRows = db.prepare(`
    SELECT hour_et,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total,
           AVG(pnl_pts) AS avg_pnl
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN', 'LOSS')
      AND hour_et IS NOT NULL
    GROUP BY hour_et
  `).all(strategy);

  for (const r of hourRows) {
    const counted = r.wins + r.losses;
    if (counted < 5) continue;

    const wr      = r.wins / counted;
    const avg_pnl = r.avg_pnl ?? 0;
    const isEdge  = wr >= baselineWr + 0.15;

    upsertLog(
      db, runDate, strategy, 'edge_hour', `hour_${r.hour_et}`,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avg_pnl.toFixed(4), trade_count: r.total }),
      r.total,
      isEdge ? 'EDGE_FOUND' : null,
    );
  }

  console.log(`[${WORKER_NAME}] Phase 13 ${strategy}: baseline=${(baselineWr*100).toFixed(1)}% edges=${edgesFound}`);
  return { edgesFound, baselineWr };
}

// ── Phase 6 — MGC Scalp instrument deep review ───────────────────────────────

function runPhase6(db, runDate) {
  const strategy = 'MGC_SCALP';
  console.log(`[${WORKER_NAME}] Phase 6 MGC deep review`);

  const rows = db.prepare(`
    SELECT outcome, direction, pnl_pts, hold_time_min, exit_type, atr, hour_et, session
    FROM trade_dna
    WHERE strategy_name = ?
      AND outcome IN ('WIN','LOSS','BE')
  `).all(strategy);

  if (rows.length < 5) {
    console.log(`[${WORKER_NAME}] Phase 6: skipped (N=${rows.length} < 5)`);
    return;
  }

  // ── Direction bias ────────────────────────────────────────────────────────
  for (const dir of ['LONG', 'SHORT']) {
    const dirRows = rows.filter(r => r.direction === dir);
    const w = dirRows.filter(r => r.outcome === 'WIN').length;
    const l = dirRows.filter(r => r.outcome === 'LOSS').length;
    if (w + l < 5) continue;
    const wr     = w / (w + l);
    const avgPnl = dirRows.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / dirRows.length;
    upsertLog(db, runDate, strategy, 'mgc_review', `direction_${dir.toLowerCase()}`,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avgPnl.toFixed(4), trade_count: dirRows.length }),
      dirRows.length, null);
  }

  // ── ATR vol tier performance (tertiles) ───────────────────────────────────
  const withAtr = rows.filter(r => r.atr != null && r.atr > 0).sort((a, b) => a.atr - b.atr);
  if (withAtr.length >= 15) {
    const t1 = Math.floor(withAtr.length / 3);
    const t2 = Math.floor(withAtr.length * 2 / 3);
    const tiers = [
      { label: 'atr_low',  slice: withAtr.slice(0, t1) },
      { label: 'atr_med',  slice: withAtr.slice(t1, t2) },
      { label: 'atr_high', slice: withAtr.slice(t2) },
    ];
    for (const { label, slice } of tiers) {
      const w = slice.filter(r => r.outcome === 'WIN').length;
      const l = slice.filter(r => r.outcome === 'LOSS').length;
      if (w + l < 3) continue;
      const wr     = w / (w + l);
      const avgPnl = slice.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / slice.length;
      upsertLog(db, runDate, strategy, 'mgc_review', label,
        +wr.toFixed(4),
        JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avgPnl.toFixed(4), trade_count: slice.length }),
        slice.length, null);
    }
  }

  // ── Hold time buckets ─────────────────────────────────────────────────────
  const holdBuckets = [
    { label: 'hold_lt15m',   fn: r => r.hold_time_min != null && r.hold_time_min <  15 },
    { label: 'hold_15_30m',  fn: r => r.hold_time_min != null && r.hold_time_min >= 15 && r.hold_time_min < 30 },
    { label: 'hold_30_60m',  fn: r => r.hold_time_min != null && r.hold_time_min >= 30 && r.hold_time_min < 60 },
    { label: 'hold_gt60m',   fn: r => r.hold_time_min != null && r.hold_time_min >= 60 },
  ];
  for (const { label, fn } of holdBuckets) {
    const bucket = rows.filter(fn);
    const w = bucket.filter(r => r.outcome === 'WIN').length;
    const l = bucket.filter(r => r.outcome === 'LOSS').length;
    if (w + l < 3) continue;
    const wr     = w / (w + l);
    const avgPnl = bucket.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / bucket.length;
    upsertLog(db, runDate, strategy, 'mgc_review', label,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avgPnl.toFixed(4), trade_count: bucket.length }),
      bucket.length, null);
  }

  // ── Exit type breakdown ───────────────────────────────────────────────────
  const exitMap = {};
  for (const r of rows) {
    if (!r.exit_type) continue;
    exitMap[r.exit_type] = (exitMap[r.exit_type] ?? 0) + 1;
  }
  const totalWithExit = Object.values(exitMap).reduce((s, v) => s + v, 0);
  for (const [et, count] of Object.entries(exitMap)) {
    upsertLog(db, runDate, strategy, 'mgc_review', `exit_${et.toLowerCase()}`,
      totalWithExit > 0 ? +(count / totalWithExit).toFixed(4) : null,
      null, count, null);
  }

  // ── Granular intraday session bands (ET hours) ────────────────────────────
  const sessionBands = [
    { label: 'mgc_band_overnight',  fn: r => r.hour_et != null && (r.hour_et < 3 || r.hour_et >= 20) },
    { label: 'mgc_band_london',     fn: r => r.hour_et != null && r.hour_et >= 3  && r.hour_et <  5  },
    { label: 'mgc_band_premarket',  fn: r => r.hour_et != null && r.hour_et >= 7  && r.hour_et <  9  },
    { label: 'mgc_band_ny_open',    fn: r => r.hour_et != null && r.hour_et >= 9  && r.hour_et <  11 },
    { label: 'mgc_band_ny_midday',  fn: r => r.hour_et != null && r.hour_et >= 11 && r.hour_et <  14 },
    { label: 'mgc_band_afternoon',  fn: r => r.hour_et != null && r.hour_et >= 14 && r.hour_et <  17 },
  ];
  for (const { label, fn } of sessionBands) {
    const band = rows.filter(fn);
    const w = band.filter(r => r.outcome === 'WIN').length;
    const l = band.filter(r => r.outcome === 'LOSS').length;
    if (w + l < 3) continue;
    const wr     = w / (w + l);
    const avgPnl = band.reduce((s, r) => s + (r.pnl_pts ?? 0), 0) / band.length;
    upsertLog(db, runDate, strategy, 'mgc_review', label,
      +wr.toFixed(4),
      JSON.stringify({ wr: +wr.toFixed(4), avg_pnl: +avgPnl.toFixed(4), trade_count: band.length }),
      band.length, null);
  }

  console.log(`[${WORKER_NAME}] Phase 6 MGC: N=${rows.length} done`);
  return { tradeCount: rows.length };
}

// ── Phase 7 — MNQ cross-strategy instrument deep review ──────────────────────

function runPhase7(db, runDate) {
  const MNQ_STRATEGIES = ['MNQ_INTRADAY', 'MNQ_SWING', 'MNQ_50PT'];
  console.log(`[${WORKER_NAME}] Phase 7 MNQ deep review`);

  // ── Cross-strategy scorecard ──────────────────────────────────────────────
  const scorecardParts = [];
  for (const strat of MNQ_STRATEGIES) {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
             AVG(pnl_pts) AS avg_pnl,
             AVG(CASE WHEN outcome = 'WIN'  THEN pnl_pts END) AS avg_win,
             AVG(CASE WHEN outcome = 'LOSS' THEN pnl_pts END) AS avg_loss,
             SUM(CASE WHEN outcome = 'WIN'  AND pnl_pts > 0 THEN pnl_pts ELSE 0 END) AS gross_win,
             SUM(CASE WHEN outcome = 'LOSS' AND pnl_pts < 0 THEN ABS(pnl_pts) ELSE 0 END) AS gross_loss
      FROM trade_dna
      WHERE strategy_name = ?
        AND outcome IN ('WIN','LOSS','BE')
    `).get(strat);

    if (!r || r.total < 5) continue;

    const wr = (r.wins + r.losses) > 0 ? r.wins / (r.wins + r.losses) : 0;
    const pf = (r.gross_loss ?? 0) > 0 ? (r.gross_win ?? 0) / r.gross_loss : null;

    upsertLog(db, runDate, strat, 'mnq_review', 'scorecard',
      +wr.toFixed(4),
      JSON.stringify({
        strategy: strat, wr: +wr.toFixed(4), avg_pnl: +(r.avg_pnl ?? 0).toFixed(4),
        avg_win: +(r.avg_win ?? 0).toFixed(4), avg_loss: +(r.avg_loss ?? 0).toFixed(4),
        profit_factor: pf != null ? +pf.toFixed(4) : null, trade_count: r.total,
      }),
      r.total, null);

    scorecardParts.push(`${strat}: WR=${(wr*100).toFixed(1)}% PF=${pf?.toFixed(2) ?? 'n/a'}`);
  }

  // ── Regime fit matrix: best MNQ strategy per regime ──────────────────────
  const regimeRows = db.prepare(`
    SELECT strategy_name, regime,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses
    FROM trade_dna
    WHERE strategy_name IN ('MNQ_INTRADAY','MNQ_SWING','MNQ_50PT')
      AND outcome IN ('WIN','LOSS')
      AND regime IS NOT NULL
    GROUP BY strategy_name, regime
  `).all();

  // Build { regime → { strategy → {wins, losses} } }
  const regimeMatrix = {};
  for (const r of regimeRows) {
    if (!regimeMatrix[r.regime]) regimeMatrix[r.regime] = {};
    regimeMatrix[r.regime][r.strategy_name] = { wins: r.wins, losses: r.losses };
  }

  for (const [regime, stratMap] of Object.entries(regimeMatrix)) {
    let bestStrat = null, bestWr = -1;
    const detail = {};
    for (const [strat, s] of Object.entries(stratMap)) {
      const total = s.wins + s.losses;
      if (total < 5) continue;
      const wr = s.wins / total;
      detail[strat] = { wr: +wr.toFixed(4), trade_count: total };
      if (wr > bestWr) { bestWr = wr; bestStrat = strat; }
    }
    if (!bestStrat) continue;
    // Write one row per MNQ strategy for this regime under mnq_review
    for (const [strat, d] of Object.entries(detail)) {
      upsertLog(db, runDate, strat, 'mnq_review', `regime_fit_${regime}`,
        d.wr, JSON.stringify({ regime, wr: d.wr, trade_count: d.trade_count, best_strategy: bestStrat }),
        d.trade_count, strat === bestStrat ? 'BEST_FIT' : null);
    }
  }

  // ── MNQ_50PT realism check ────────────────────────────────────────────────
  const pt50Rows = db.prepare(`
    SELECT mfe_pts, tp1_pts, outcome
    FROM trade_dna
    WHERE strategy_name = 'MNQ_50PT'
      AND outcome IN ('WIN','LOSS')
      AND mfe_pts IS NOT NULL
      AND tp1_pts IS NOT NULL AND tp1_pts > 0
  `).all();

  if (pt50Rows.length >= 5) {
    const reached50 = pt50Rows.filter(r => r.mfe_pts >= 50).length;
    const reached50Pct = reached50 / pt50Rows.length;
    const avgMfe = pt50Rows.reduce((s, r) => s + r.mfe_pts, 0) / pt50Rows.length;
    const mfeSorted = pt50Rows.map(r => r.mfe_pts).sort((a, b) => a - b);
    const mfeP50 = mfeSorted[Math.floor(0.5 * mfeSorted.length)];

    upsertLog(db, runDate, 'MNQ_50PT', 'mnq_review', '50pt_mfe_reach_pct',
      +reached50Pct.toFixed(4),
      JSON.stringify({ reached_50pt_pct: +reached50Pct.toFixed(4), avg_mfe_pts: +avgMfe.toFixed(2), median_mfe_pts: +mfeP50.toFixed(2), sample: pt50Rows.length }),
      pt50Rows.length,
      reached50Pct < 0.40 ? 'TP_UNREALISTIC' : reached50Pct > 0.70 ? 'TP_CONSERVATIVE' : null);
  }

  // ── MNQ_SWING hold time: wins vs losses ───────────────────────────────────
  const swingRows = db.prepare(`
    SELECT outcome, hold_time_min
    FROM trade_dna
    WHERE strategy_name = 'MNQ_SWING'
      AND outcome IN ('WIN','LOSS')
      AND hold_time_min IS NOT NULL
  `).all();

  if (swingRows.length >= 5) {
    const swingWins   = swingRows.filter(r => r.outcome === 'WIN');
    const swingLosses = swingRows.filter(r => r.outcome === 'LOSS');
    const avgWinHold  = swingWins.length   ? swingWins.reduce((s, r)   => s + r.hold_time_min, 0) / swingWins.length   : null;
    const avgLossHold = swingLosses.length ? swingLosses.reduce((s, r) => s + r.hold_time_min, 0) / swingLosses.length : null;
    upsertLog(db, runDate, 'MNQ_SWING', 'mnq_review', 'swing_hold_win_avg',
      avgWinHold != null ? +avgWinHold.toFixed(2) : null, null, swingWins.length, null);
    upsertLog(db, runDate, 'MNQ_SWING', 'mnq_review', 'swing_hold_loss_avg',
      avgLossHold != null ? +avgLossHold.toFixed(2) : null, null, swingLosses.length, null);
  }

  // ── Best session per MNQ strategy ─────────────────────────────────────────
  const sessionRows = db.prepare(`
    SELECT strategy_name, session,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
           COUNT(*) AS total
    FROM trade_dna
    WHERE strategy_name IN ('MNQ_INTRADAY','MNQ_SWING','MNQ_50PT')
      AND outcome IN ('WIN','LOSS')
      AND session IS NOT NULL
    GROUP BY strategy_name, session
  `).all();

  const bestSessions = {};
  for (const r of sessionRows) {
    const total = r.wins + r.losses;
    if (total < 5) continue;
    const wr = r.wins / total;
    if (!bestSessions[r.strategy_name] || wr > bestSessions[r.strategy_name].wr) {
      bestSessions[r.strategy_name] = { session: r.session, wr, trade_count: total };
    }
  }
  for (const [strat, best] of Object.entries(bestSessions)) {
    upsertLog(db, runDate, strat, 'mnq_review', 'best_session',
      +best.wr.toFixed(4),
      JSON.stringify({ session: best.session, wr: +best.wr.toFixed(4), trade_count: best.trade_count }),
      best.trade_count, null);
  }

  console.log(`[${WORKER_NAME}] Phase 7 MNQ: ${scorecardParts.join(' | ')}`);
  return { scorecardParts };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const db      = openDb();
  const runDate = new Date().toISOString().slice(0, 10);

  heartbeat(db, WORKER_NAME, 'RUNNING', { startedAt: new Date().toISOString() });

  const summaryParts = [];

  for (const strategy of STRATEGIES) {
    try {
      const dna      = runPhase1(db, strategy, runDate);
      runPhase2(db, strategy, runDate);
      const mae      = runPhase3(db, strategy, runDate);
      runPhase8(db, strategy, runDate);
      const regimes  = runPhase9(db, strategy, runDate);
      const sessions = runPhase10(db, strategy, runDate);
      const edges    = runPhase13(db, strategy, runDate);

      const topRegime  = regimes.sort((a, b) => b.wr - a.wr)[0];
      const topSession = sessions.sort((a, b) => b.wr - a.wr)[0];

      const parts = [`[${strategy}]`];
      if (dna.wr != null) parts.push(`WR=${(dna.wr*100).toFixed(1)}% PF=${dna.profitFactor?.toFixed(2) ?? 'n/a'}`);
      if (topRegime)  parts.push(`top regime: ${topRegime.regime} WR=${(topRegime.wr*100).toFixed(0)}%`);
      if (topSession) parts.push(`top session: ${topSession.session} WR=${(topSession.wr*100).toFixed(0)}%`);
      if (edges.edgesFound > 0) parts.push(`${edges.edgesFound} edge cross(es) found`);
      if (mae.nearStopPct != null) parts.push(`near-stop winners: ${(mae.nearStopPct*100).toFixed(0)}%`);

      summaryParts.push(parts.join(' | '));
    } catch (err) {
      console.error(`[${WORKER_NAME}] ${strategy} error: ${err.message}`);
      logWorkerError(db, WORKER_NAME, err);
    }
  }

  // Instrument deep reviews run once (not per-strategy loop)
  let mgcSummary = null, mnqSummary = null;
  try {
    mgcSummary = runPhase6(db, runDate);
  } catch (err) {
    console.error(`[${WORKER_NAME}] Phase 6 error: ${err.message}`);
    logWorkerError(db, WORKER_NAME, err);
  }
  try {
    mnqSummary = runPhase7(db, runDate);
  } catch (err) {
    console.error(`[${WORKER_NAME}] Phase 7 error: ${err.message}`);
    logWorkerError(db, WORKER_NAME, err);
  }

  heartbeat(db, WORKER_NAME, 'COMPLETED', { completedAt: new Date().toISOString() });

  const mgcLine = mgcSummary ? `[MGC] ${mgcSummary.tradeCount} trades reviewed` : null;
  const mnqLine = mnqSummary?.scorecardParts?.length
    ? `[MNQ] ${mnqSummary.scorecardParts.join(' | ')}`
    : null;

  const allParts = [...summaryParts, mgcLine, mnqLine].filter(Boolean);
  const body = allParts.length > 0 ? allParts.join('\n') : 'No significant findings this week.';

  await sendNotification(
    'Outcome Intelligence — Weekly Analysis Complete',
    body,
    { priority: 'default', tags: 'brain,chart_increasing' },
  );

  db.close();

  console.log(`[${WORKER_NAME}] Done`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[${WORKER_NAME}] Fatal: ${err.message}`);
  process.exit(1);
});
