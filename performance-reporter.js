'use strict';

/**
 * PERFORMANCE REPORTER
 *
 * Generates three categories of intelligence reports:
 *
 *   1. Mid-Week Intelligence Report  — detailed diagnostic (auto-generated Wednesday)
 *   2. Weekly Deep Strategy Report   — comprehensive end-of-week review with comparisons
 *   3. Divergence Analysis           — live vs backtest discrepancy breakdown with root-cause attribution
 *
 * All reports are built from live DB data and explain every finding in plain language.
 * Reports are persisted to the strategy_params table (key = REPORT_<type>_<weekStart>).
 */

// ── DB helpers ────────────────────────────────────────────────────────────────

function _q(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function _g(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function _pct(v) { return v != null ? `${(v * 100).toFixed(1)}%` : 'N/A'; }

function _wr(wins, total) { return total > 0 ? wins / total : null; }

function _currentWeekStart() {
  const d = new Date();
  const diff = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function _addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Divergence Analysis ───────────────────────────────────────────────────────

/**
 * Compares backtest win rates (last 5 runs) against live signal outcomes (last 30 days)
 * per strategy. Returns severity-classified divergence for each strategy plus
 * a plain-English root-cause explanation for each significant gap.
 */
function analyzeDivergence(db) {
  const btRows = _q(db, `
    SELECT t.strategy_name, t.direction,
           COUNT(*)                                            AS total,
           SUM(CASE WHEN t.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
    FROM   backtest_trades t
    WHERE  t.run_id IN (SELECT id FROM backtest_runs ORDER BY run_at DESC LIMIT 5)
    GROUP  BY t.strategy_name, t.direction
  `);

  const liveRows = _q(db, `
    SELECT s.strategy_name, s.direction,
           COUNT(*)                                              AS total,
           SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END)   AS wins
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= datetime('now', '-30 days')
    GROUP  BY s.strategy_name, s.direction
  `);

  // Index live data
  const liveIdx = {};
  for (const r of liveRows) {
    const k = `${r.strategy_name}::${r.direction}`;
    liveIdx[k] = r;
  }

  const divergenceMap = {};

  for (const bt of btRows) {
    if (bt.total < 5) continue;
    const k = `${bt.strategy_name}::${bt.direction}`;
    const live = liveIdx[k];
    if (!live || live.total < 5) continue;

    const btWR   = _wr(bt.wins, bt.total);
    const liveWR = _wr(live.wins, live.total);
    const delta  = btWR - liveWR;

    const severity  = Math.abs(delta) > 0.20 ? 'HIGH' : Math.abs(delta) > 0.10 ? 'MEDIUM' : 'LOW';
    const direction = delta > 0.01 ? 'backtest_overperforms' : delta < -0.01 ? 'live_overperforms' : 'aligned';

    const rootCauses = [];
    if (delta > 0.15) {
      rootCauses.push('Cooldown mismatch: backtest default was 1 bar vs live 10-min — now fixed to 2 bars');
      rootCauses.push('Forming-bar evaluation: live scanner included unconfirmed bar — now fixed (confirmed bars only)');
    }
    if (delta > 0.08) {
      rootCauses.push('Adaptive filters not simulated in backtest: learned thresholds and pattern memory only apply live');
      rootCauses.push('Daily cap (20 signals) applies live but not in backtest — live opportunity capture reduced');
    }
    if (delta > 0.05) {
      rootCauses.push('Slippage: backtest uses 0.5 pts; real execution may have higher effective spread');
      rootCauses.push('Data timing: Yahoo Finance 5m bars may lag real CME/COMEX tick prices by 1–3 seconds');
    }
    if (rootCauses.length === 0) {
      rootCauses.push('Divergence within acceptable range — strategies are well-calibrated');
    }

    divergenceMap[k] = {
      strategy:      bt.strategy_name,
      direction:     bt.direction,
      bt_wr:         +btWR.toFixed(3),
      live_wr:       +liveWR.toFixed(3),
      delta:         +delta.toFixed(3),
      delta_pct:     +(delta * 100).toFixed(1),
      bt_count:      bt.total,
      live_count:    live.total,
      severity,
      direction_label: direction,
      root_causes:   rootCauses,
    };
  }

  // Summary
  const highCount   = Object.values(divergenceMap).filter(d => d.severity === 'HIGH').length;
  const medCount    = Object.values(divergenceMap).filter(d => d.severity === 'MEDIUM').length;
  const avgDelta    = Object.values(divergenceMap).reduce((s, d) => s + Math.abs(d.delta), 0) /
                      Math.max(1, Object.values(divergenceMap).length);

  return {
    generated_at: new Date().toISOString(),
    divergenceMap,
    summary: {
      high_count:   highCount,
      medium_count: medCount,
      avg_abs_delta: +(avgDelta * 100).toFixed(1),
      overall_status: highCount > 0 ? 'DIVERGENT' : medCount > 0 ? 'MODERATE' : 'ALIGNED',
    },
    known_causes: [
      'FIXED: Forming-bar evaluation (live now excludes unconfirmed last bar)',
      'FIXED: Backtest cooldown now matches live default (2 bars = 10 min)',
      'ONGOING: Adaptive learned thresholds apply live only — intentional design',
      'ONGOING: Daily signal cap (20/instrument) applies live only',
      'ONGOING: Slippage modeling is approximate — real spread varies by session/volatility',
    ],
  };
}

// ── Mid-Week Intelligence Report ──────────────────────────────────────────────

function generateMidWeekReport(db) {
  const weekStart = _currentWeekStart();

  // Core performance since Monday
  const core = _g(db, `
    SELECT COUNT(*)                                                          AS total_signals,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)                 AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END)                 AS losses,
           SUM(CASE WHEN o.result='BE'   THEN 1 ELSE 0 END)                 AS breakevens,
           SUM(o.pnl_pts)                                                    AS total_pnl,
           AVG(o.pnl_pts)                                                    AS avg_pnl,
           MIN(o.pnl_pts)                                                    AS worst_trade,
           MAX(o.pnl_pts)                                                    AS best_trade,
           AVG(CAST(s.score AS REAL))                                        AS avg_confidence
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
  `, [weekStart]);

  const total = (core?.wins ?? 0) + (core?.losses ?? 0);
  const wr    = _wr(core?.wins ?? 0, total);

  const byStrategy = _q(db, `
    SELECT s.strategy_name, s.instrument,
           COUNT(*)                                            AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)   AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END)   AS losses,
           SUM(o.pnl_pts)                                      AS total_pnl,
           AVG(CAST(s.score AS REAL))                          AS avg_confidence
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
    GROUP  BY s.strategy_name, s.instrument ORDER BY (wins+losses) DESC
  `, [weekStart]);

  const bySession = _q(db, `
    SELECT s.session, s.instrument,
           COUNT(*)                                            AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)   AS wins,
           SUM(o.pnl_pts)                                      AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
    GROUP  BY s.session, s.instrument ORDER BY total DESC
  `, [weekStart]);

  const byInstrument = _q(db, `
    SELECT s.instrument,
           COUNT(*)                                            AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)   AS wins,
           SUM(o.pnl_pts)                                      AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
    GROUP  BY s.instrument
  `, [weekStart]);

  const byDay = _q(db, `
    SELECT date(s.received_at) AS trade_day,
           COUNT(*)                                            AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)   AS wins,
           SUM(o.pnl_pts)                                      AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
    GROUP  BY date(s.received_at) ORDER BY trade_day
  `, [weekStart]);

  const byConfBand = _q(db, `
    SELECT CASE
             WHEN s.score >= 85 THEN 'A+(85+)'
             WHEN s.score >= 75 THEN 'B(75-84)'
             WHEN s.score >= 65 THEN 'C(65-74)'
             ELSE 'D(<65)'
           END AS band,
           COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins,
           AVG(o.pnl_pts) AS avg_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
    GROUP  BY band ORDER BY band
  `, [weekStart]);

  const htfMismatches = _g(db, `
    SELECT COUNT(*) AS cnt
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
      AND  ((s.direction='LONG' AND s.htf_bias='BEAR') OR (s.direction='SHORT' AND s.htf_bias='BULL'))
  `, [weekStart])?.cnt ?? 0;

  // Streak analysis
  const allResults = _q(db, `
    SELECT o.result, o.pnl_pts
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ?
    ORDER  BY s.received_at ASC
  `, [weekStart]);

  let maxLoss = 0, curLoss = 0, maxWin = 0, curWin = 0;
  for (const r of allResults) {
    if (r.result === 'LOSS') { curLoss++; curWin = 0;  maxLoss = Math.max(maxLoss, curLoss); }
    else if (r.result === 'WIN')  { curWin++;  curLoss = 0; maxWin  = Math.max(maxWin, curWin); }
    else { curLoss = 0; curWin = 0; }
  }

  const grossWin  = allResults.filter(r => r.result === 'WIN').reduce((s, r) => s + Math.max(0, r.pnl_pts ?? 0), 0);
  const grossLoss = allResults.filter(r => r.result === 'LOSS').reduce((s, r) => s + Math.abs(Math.min(0, r.pnl_pts ?? 0)), 0);
  const pf        = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 9.99 : 0);
  const expectancy = total > 0 ? +((grossWin - grossLoss) / total).toFixed(2) : 0;

  const divergence = analyzeDivergence(db);
  const narrative  = _buildMidWeekNarrative({
    wr, total, byStrategy, bySession, byInstrument, byDay,
    byConfBand, htfMismatches, maxLoss, maxWin, divergence, pf, expectancy,
  });

  const report = {
    generated_at: new Date().toISOString(),
    week_start:   weekStart,
    report_type:  'MID_WEEK',
    metrics: {
      total_trades:    total,
      win_rate_pct:    wr != null ? +(wr * 100).toFixed(1) : null,
      profit_factor:   pf,
      expectancy_pts:  expectancy,
      total_pnl:       +(core?.total_pnl ?? 0).toFixed(2),
      best_trade:      +(core?.best_trade  ?? 0).toFixed(2),
      worst_trade:     +(core?.worst_trade ?? 0).toFixed(2),
      max_win_streak:  maxWin,
      max_loss_streak: maxLoss,
      avg_confidence:  core?.avg_confidence != null ? +core.avg_confidence.toFixed(1) : null,
      htf_mismatches:  htfMismatches,
    },
    breakdowns:    { byStrategy, bySession, byInstrument, byDay, byConfBand },
    divergence:    divergence.divergenceMap,
    narrative,
  };

  _persistReport(db, 'MIDWEEK', weekStart, report);
  return report;
}

function _buildMidWeekNarrative(d) {
  const { wr, total, byStrategy, bySession, byInstrument, byDay,
          byConfBand, htfMismatches, maxLoss, maxWin, divergence, pf, expectancy } = d;

  const lines = [];
  lines.push('=== MID-WEEK INTELLIGENCE REPORT ===');
  lines.push(`Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
  lines.push('');

  // ── Overall assessment ────────────────────────────────────────────────
  if (wr === null || total === 0) {
    lines.push('PERFORMANCE: No resolved trades yet this week.');
  } else {
    const grade = wr >= 0.65 ? 'STRONG' : wr >= 0.52 ? 'ACCEPTABLE' : 'BELOW TARGET';
    lines.push(`PERFORMANCE [${grade}]: WR=${_pct(wr)} on ${total} resolved trades | PF=${pf} | Expectancy=${expectancy} pts`);
    if (wr >= 0.65) {
      lines.push('  System performing above threshold. Preserve current conditions through week-end.');
    } else if (wr >= 0.52) {
      lines.push('  Meeting minimum standard. Review weakest strategies for threshold recalibration.');
    } else {
      lines.push('  Below 52% target. Confidence thresholds should increase. Consider reducing size on borderline setups.');
    }
  }

  // ── Strategy breakdown ────────────────────────────────────────────────
  lines.push('');
  lines.push('STRATEGY PERFORMANCE:');
  for (const s of byStrategy) {
    const t = s.wins + s.losses;
    const w = _wr(s.wins, t);
    const pnlStr = s.total_pnl != null ? ` | P&L: ${s.total_pnl >= 0 ? '+' : ''}${s.total_pnl.toFixed(1)} pts` : '';
    const confStr = s.avg_confidence != null ? ` | avg conf: ${s.avg_confidence.toFixed(0)}` : '';
    lines.push(`  ${s.strategy_name} (${s.instrument}): ${s.wins}W/${s.losses}L = ${_pct(w)} WR${pnlStr}${confStr}`);
  }

  // ── Session breakdown ─────────────────────────────────────────────────
  if (bySession.length > 0) {
    lines.push('');
    lines.push('SESSION PERFORMANCE:');
    for (const s of bySession.filter(s => s.total >= 2)) {
      const w = _wr(s.wins, s.total);
      lines.push(`  ${s.session} (${s.instrument}): ${s.total} trades | WR=${_pct(w)} | P&L: ${(s.total_pnl ?? 0).toFixed(1)} pts`);
    }
  }

  // ── Day-by-day ────────────────────────────────────────────────────────
  if (byDay.length > 1) {
    lines.push('');
    lines.push('DAY-BY-DAY:');
    for (const d2 of byDay) {
      const w = _wr(d2.wins, d2.total);
      const pnl = (d2.total_pnl ?? 0).toFixed(1);
      const day = new Date(d2.trade_day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      lines.push(`  ${day}: ${d2.total} trades | WR=${_pct(w)} | P&L: ${pnl >= 0 ? '+' : ''}${pnl} pts`);
    }
  }

  // ── Confidence band effectiveness ─────────────────────────────────────
  if (byConfBand.length > 0) {
    lines.push('');
    lines.push('CONFIDENCE BAND EFFECTIVENESS:');
    for (const b of byConfBand) {
      const w = _wr(b.wins, b.total);
      const avgP = b.avg_pnl != null ? ` | avg: ${b.avg_pnl.toFixed(1)} pts` : '';
      lines.push(`  ${b.band}: ${b.total} trades | WR=${_pct(w)}${avgP}`);
    }
  }

  // ── Warnings ──────────────────────────────────────────────────────────
  lines.push('');
  lines.push('WARNINGS:');
  const warnings = [];

  if (htfMismatches > 0) {
    warnings.push(`HTF_COUNTER_TREND: ${htfMismatches} counter-trend entries taken — HTF alignment filter may be too loose`);
  }
  if (maxLoss >= 4) {
    warnings.push(`LOSS_STREAK: Max consecutive losses = ${maxLoss} — potential regime shift; consider pausing until WR recovers`);
  }

  const highDiv = Object.values(divergence.divergenceMap ?? {}).filter(v => v.severity === 'HIGH');
  for (const dv of highDiv) {
    warnings.push(`DIVERGENCE_HIGH [${dv.strategy}/${dv.direction}]: BT=${_pct(dv.bt_wr)} vs LIVE=${_pct(dv.live_wr)} (Δ${dv.delta_pct}%)`);
  }

  const underperforming = byStrategy.filter(s => {
    const t = s.wins + s.losses;
    return t >= 5 && (s.wins / t) < 0.42;
  });
  for (const s of underperforming) {
    warnings.push(`UNDERPERFORMING [${s.strategy_name}]: WR=${_pct(_wr(s.wins, s.wins+s.losses))} on ${s.wins+s.losses} trades — threshold review needed`);
  }

  if (warnings.length === 0) warnings.push('No critical warnings — system operating within normal parameters');
  for (const w of warnings) lines.push(`  ⚠ ${w}`);

  // ── Mid-week recommendations ──────────────────────────────────────────
  lines.push('');
  lines.push('RECOMMENDATIONS (to apply for remainder of week):');
  const recs = [];

  if (wr !== null && wr < 0.52) {
    recs.push('Raise learned confidence thresholds for underperforming strategies (learning system will do this automatically after next backtest cycle)');
    recs.push('Require stronger HTF alignment — both 15m and 1h EMA must agree before entry');
  }
  if (maxLoss >= 5) {
    recs.push('Reduce position size 50% until WR stabilises above 55%');
  }
  if (highDiv.length > 0) {
    recs.push('Verify live conditions match backtest simulation — cooldown and confirmed-bar fixes applied; monitor signal frequency');
  }
  if (htfMismatches >= 3) {
    recs.push('Enforce strict HTF filter in strategy config — no counter-trend entries');
  }
  if (recs.length === 0) recs.push('Maintain current approach — no adjustments needed at mid-week');
  for (let i = 0; i < recs.length; i++) lines.push(`  ${i+1}. ${recs[i]}`);

  return lines.join('\n');
}

// ── Weekly Deep Strategy Intelligence Report ──────────────────────────────────

function generateWeeklyDeepReport(db, weekStart = null) {
  const ws  = weekStart ?? _currentWeekStart();
  const we  = _addDays(ws, 7);
  const pws = _addDays(ws, -7);  // prior week start

  const core = _g(db, `
    SELECT COUNT(*)                                                  AS total_signals,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END)         AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END)         AS losses,
           SUM(CASE WHEN o.result='BE'   THEN 1 ELSE 0 END)         AS breakevens,
           SUM(o.pnl_pts)                                            AS total_pnl,
           AVG(o.pnl_pts)                                            AS avg_pnl,
           MIN(o.pnl_pts)                                            AS worst_trade,
           MAX(o.pnl_pts)                                            AS best_trade,
           AVG(CAST(s.score AS REAL))                                AS avg_confidence
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
  `, [ws, we]);

  const prevCore = _g(db, `
    SELECT SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END) AS losses,
           SUM(o.pnl_pts) AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
  `, [pws, ws]);

  const total    = (core?.wins ?? 0) + (core?.losses ?? 0);
  const wr       = _wr(core?.wins ?? 0, total);
  const prevTotal = (prevCore?.wins ?? 0) + (prevCore?.losses ?? 0);
  const prevWR   = _wr(prevCore?.wins ?? 0, prevTotal);

  // Full breakdowns
  const byStrategy = _q(db, `
    SELECT s.strategy_name, s.instrument,
           COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN o.result='LOSS' THEN 1 ELSE 0 END) AS losses,
           SUM(o.pnl_pts) AS total_pnl,
           AVG(o.pnl_pts) AS avg_pnl,
           AVG(CAST(s.score AS REAL)) AS avg_confidence
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    GROUP  BY s.strategy_name, s.instrument ORDER BY (wins+losses) DESC
  `, [ws, we]);

  const byDay = _q(db, `
    SELECT date(s.received_at) AS trade_day,
           COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins,
           SUM(o.pnl_pts) AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    GROUP  BY trade_day ORDER BY trade_day
  `, [ws, we]);

  const bySession = _q(db, `
    SELECT s.session, s.instrument,
           COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins,
           SUM(o.pnl_pts) AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    GROUP  BY s.session, s.instrument ORDER BY total DESC
  `, [ws, we]);

  const bySetup = _q(db, `
    SELECT s.setup, COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins,
           SUM(o.pnl_pts) AS total_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    GROUP  BY s.setup ORDER BY total DESC
  `, [ws, we]);

  const byDirection = _q(db, `
    SELECT s.direction, s.instrument,
           COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    GROUP  BY s.direction, s.instrument
  `, [ws, we]);

  const byGrade = _q(db, `
    SELECT s.grade, COUNT(*) AS total,
           SUM(CASE WHEN o.result='WIN' THEN 1 ELSE 0 END) AS wins,
           AVG(o.pnl_pts) AS avg_pnl
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    GROUP  BY s.grade
  `, [ws, we]);

  // P&L analysis
  const allTrades = _q(db, `
    SELECT o.result, o.pnl_pts
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.received_at >= ? AND s.received_at < ?
    ORDER  BY s.received_at
  `, [ws, we]);

  const wins       = allTrades.filter(t => t.result === 'WIN');
  const losses     = allTrades.filter(t => t.result === 'LOSS');
  const grossW     = wins.reduce((s, t) => s + Math.max(0, t.pnl_pts ?? 0), 0);
  const grossL     = losses.reduce((s, t) => s + Math.abs(Math.min(0, t.pnl_pts ?? 0)), 0);
  const pf         = grossL > 0 ? +(grossW / grossL).toFixed(2) : (grossW > 0 ? 9.99 : 0);
  const avgWin     = wins.length   > 0 ? +(grossW / wins.length).toFixed(2)   : 0;
  const avgLoss    = losses.length > 0 ? +(grossL / losses.length).toFixed(2) : 0;
  const expectancy = total > 0 ? +((grossW - grossL) / total).toFixed(2) : 0;

  // Max drawdown
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of allTrades) { equity += t.pnl_pts ?? 0; if (equity > peak) peak = equity; maxDD = Math.max(maxDD, peak - equity); }

  // Recovery factor
  const recoveryFactor = maxDD > 0 ? +((core?.total_pnl ?? 0) / maxDD).toFixed(2) : null;

  // Streak analysis
  let maxLoss = 0, curLoss = 0, maxWin = 0, curWin = 0;
  for (const t of allTrades) {
    if (t.result === 'LOSS') { curLoss++; curWin = 0;  maxLoss = Math.max(maxLoss, curLoss); }
    else if (t.result === 'WIN') { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else { curLoss = 0; curWin = 0; }
  }

  // False signal ratio (total signals vs resolved wins)
  const falseRatio = core?.total_signals > 0
    ? +((core.total_signals - (core.wins ?? 0)) / core.total_signals).toFixed(3) : null;

  // Signal efficiency (wins / total signals including unresolved)
  const signalEff  = core?.total_signals > 0
    ? +((core?.wins ?? 0) / core.total_signals).toFixed(3) : null;

  const divergence = analyzeDivergence(db);
  const edgeStrengths = _analyzeEdgeStrengths(bySession, bySetup, byDay);
  const narrative  = _buildWeeklyNarrative({
    ws, we, wr, prevWR, total, prevTotal, pf, avgWin, avgLoss,
    expectancy, maxDD, recoveryFactor, maxLoss, maxWin,
    byStrategy, bySession, bySetup, byDay, byDirection, byGrade,
    falseRatio, signalEff, divergence, edgeStrengths,
  });

  const report = {
    generated_at: new Date().toISOString(),
    week_start:   ws,
    week_end:     we,
    report_type:  'WEEKLY_DEEP',
    metrics: {
      total_signals:    core?.total_signals ?? 0,
      total_trades:     total,
      win_rate_pct:     wr != null ? +(wr * 100).toFixed(1) : null,
      prev_win_rate_pct: prevWR != null ? +(prevWR * 100).toFixed(1) : null,
      wr_delta_pct:     (wr !== null && prevWR !== null) ? +((wr - prevWR) * 100).toFixed(1) : null,
      profit_factor:    pf,
      expectancy_pts:   expectancy,
      total_pnl:        +(core?.total_pnl ?? 0).toFixed(2),
      avg_win_pts:      avgWin,
      avg_loss_pts:     avgLoss,
      max_drawdown_pts: +maxDD.toFixed(2),
      recovery_factor:  recoveryFactor,
      max_win_streak:   maxWin,
      max_loss_streak:  maxLoss,
      false_signal_ratio: falseRatio,
      signal_efficiency:  signalEff,
      avg_confidence:   core?.avg_confidence != null ? +core.avg_confidence.toFixed(1) : null,
    },
    breakdowns:    { byStrategy, byDay, bySession, bySetup, byDirection, byGrade },
    divergence:    divergence.divergenceMap,
    edge_strengths: edgeStrengths,
    narrative,
  };

  _persistReport(db, 'WEEKLY', ws, report);
  return report;
}

function _analyzeEdgeStrengths(bySession, bySetup, byDay) {
  const edges = { strengths: [], weaknesses: [] };

  // Sessions
  for (const s of bySession.filter(s => s.total >= 3)) {
    const w = _wr(s.wins, s.total);
    if (w >= 0.65) edges.strengths.push({ type: 'session', label: `${s.session}(${s.instrument})`, wr: w, n: s.total });
    else if (w !== null && w < 0.42) edges.weaknesses.push({ type: 'session', label: `${s.session}(${s.instrument})`, wr: w, n: s.total });
  }

  // Setups
  for (const s of bySetup.filter(s => s.total >= 5)) {
    const w = _wr(s.wins, s.total);
    if (w >= 0.65) edges.strengths.push({ type: 'setup', label: s.setup, wr: w, n: s.total });
    else if (w !== null && w < 0.42) edges.weaknesses.push({ type: 'setup', label: s.setup, wr: w, n: s.total });
  }

  // Days
  for (const d of byDay.filter(d => d.total >= 3)) {
    const w = _wr(d.wins, d.total);
    const dayLabel = new Date(d.trade_day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' });
    if (w >= 0.70) edges.strengths.push({ type: 'day', label: dayLabel, wr: w, n: d.total });
    else if (w !== null && w < 0.38) edges.weaknesses.push({ type: 'day', label: dayLabel, wr: w, n: d.total });
  }

  return edges;
}

function _buildWeeklyNarrative(d) {
  const { ws, we, wr, prevWR, total, prevTotal, pf, avgWin, avgLoss,
          expectancy, maxDD, recoveryFactor, maxLoss, maxWin,
          byStrategy, bySession, bySetup, byDay, falseRatio, signalEff,
          divergence, edgeStrengths } = d;

  const lines = [];
  lines.push('=== WEEKLY DEEP STRATEGY INTELLIGENCE REPORT ===');
  lines.push(`Week: ${ws} → ${we}`);
  lines.push(`Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
  lines.push('');

  // ── Week-over-week comparison ─────────────────────────────────────────
  lines.push('PERFORMANCE SUMMARY:');
  if (total === 0) {
    lines.push('  No resolved trades this week.');
  } else {
    const trend = prevWR !== null
      ? (wr > prevWR + 0.03 ? ' ↑ IMPROVING' : wr < prevWR - 0.03 ? ' ↓ DECLINING' : ' → STABLE')
      : '';
    const prevStr = prevWR !== null ? ` (prev week: ${_pct(prevWR)})` : '';
    lines.push(`  Win Rate: ${_pct(wr)}${prevStr}${trend}`);
    lines.push(`  Profit Factor: ${pf} | Expectancy: ${expectancy} pts/trade`);
    lines.push(`  Max Drawdown: ${maxDD.toFixed(1)} pts | Recovery Factor: ${recoveryFactor ?? 'N/A'}`);
    lines.push(`  Avg Win: ${avgWin} pts | Avg Loss: ${avgLoss} pts | Ratio: ${avgLoss > 0 ? +(avgWin/avgLoss).toFixed(2) : 'N/A'}R`);
    lines.push(`  Max Win Streak: ${maxWin} | Max Loss Streak: ${maxLoss}`);
    if (falseRatio !== null) lines.push(`  False Signal Ratio: ${_pct(falseRatio)} | Signal Efficiency: ${_pct(signalEff)}`);
  }

  // ── Strategy deep dive ────────────────────────────────────────────────
  lines.push('');
  lines.push('STRATEGY DEEP DIVE:');
  for (const s of byStrategy) {
    const t  = s.wins + s.losses;
    const w  = _wr(s.wins, t);
    const pnl = s.total_pnl != null ? ` | P&L: ${(s.total_pnl >= 0 ? '+' : '') + s.total_pnl.toFixed(1)} pts` : '';
    lines.push(`  ${s.strategy_name} (${s.instrument}): ${s.wins}W/${s.losses}L = ${_pct(w)} WR | avg conf: ${s.avg_confidence?.toFixed(0) ?? '?'}${pnl}`);
    if (w !== null && w < 0.45) {
      lines.push(`    → WHY: WR below 45% — likely causes: overfiltered or underfiltered setups, session mismatch, or regime shift`);
      lines.push(`    → ACTION: Learning system will raise confidence threshold after next backtest cycle`);
    } else if (w !== null && w >= 0.70) {
      lines.push(`    → STRENGTH: Above 70% WR — strong edge; learning system will slightly lower threshold to capture more trades`);
    }
  }

  // ── Edge conditions ───────────────────────────────────────────────────
  if (edgeStrengths.strengths.length > 0 || edgeStrengths.weaknesses.length > 0) {
    lines.push('');
    lines.push('EDGE CONDITIONS:');
    for (const e of edgeStrengths.strengths) {
      lines.push(`  ✓ STRONG EDGE [${e.type}:${e.label}]: WR=${_pct(e.wr)} (${e.n} trades) — preserve and prioritize`);
    }
    for (const e of edgeStrengths.weaknesses) {
      lines.push(`  ✗ WEAKNESS [${e.type}:${e.label}]: WR=${_pct(e.wr)} (${e.n} trades) — consider session/setup gate`);
    }
  }

  // ── Live vs backtest divergence ───────────────────────────────────────
  const highDiv = Object.values(divergence.divergenceMap ?? {}).filter(v => v.severity !== 'LOW');
  if (highDiv.length > 0) {
    lines.push('');
    lines.push('LIVE vs BACKTEST DIVERGENCE (remaining gaps post-fix):');
    for (const dv of highDiv) {
      lines.push(`  ${dv.strategy}/${dv.direction}: BT=${_pct(dv.bt_wr)} vs LIVE=${_pct(dv.live_wr)} (Δ${dv.delta_pct}%) — ${dv.direction_label}`);
      for (const rc of dv.root_causes.slice(0, 2)) lines.push(`    • ${rc}`);
    }
  }

  // ── Adaptive learning effectiveness ──────────────────────────────────
  lines.push('');
  lines.push('ADAPTIVE LEARNING EFFECTIVENESS:');
  const thresholdChanges = _g(db, `
    SELECT params_json FROM strategy_params WHERE instrument='THRESHOLDS'
  `);
  if (thresholdChanges) {
    lines.push('  Learned thresholds active — system has calibrated confidence gates from backtest outcomes');
    lines.push('  Pattern memory active — per-context (strategy+direction+HTF+session) WR tracking applied live');
    lines.push('  Adaptive overrides active — auto-pause/block rules applied to sustained underperformers');
  }

  // ── Forward optimization recommendations ─────────────────────────────
  lines.push('');
  lines.push('FORWARD OPTIMIZATION RECOMMENDATIONS:');

  const allRecs = [];
  if (wr !== null && wr >= 0.65) {
    allRecs.push('PRESERVE: Strategy performing well — avoid parameter changes; focus on opportunity capture');
    allRecs.push('LEVERAGE: Scale into high-WR sessions and setups identified above');
  } else if (wr !== null && wr >= 0.52) {
    allRecs.push('RECALIBRATE: Fine-tune confidence thresholds for strategies below 55% WR');
    allRecs.push('REVIEW: Confirm HTF alignment is enforced — counter-trend entries significantly degrade WR');
    allRecs.push('TEST: Consider tightening session filter — overnight and low-liquidity sessions drag results');
  } else if (wr !== null) {
    allRecs.push('REDUCE: Raise confidence thresholds across all underperforming strategies');
    allRecs.push('INVESTIGATE: Check for persistent regime shift — if market is ranging, continuation setups will underperform');
    allRecs.push('PROTECT: Disable or weight-down weakest strategies until WR recovers above 52%');
    allRecs.push('DIAGNOSE: Run manual review of losing trades — confirm entries are structurally valid');
  }
  if (maxLoss >= 5) {
    allRecs.push('RISK: Consecutive loss streak ≥5 — reduce size until 3-trade recovery confirmed');
  }
  if (avgWin > 0 && avgLoss > 0) {
    const rr = avgWin / avgLoss;
    if (rr < 1.2) allRecs.push(`TARGETS: Avg R:R = ${rr.toFixed(2)} (low) — consider extending TP1 or tightening SL to improve ratio`);
  }
  if (allRecs.length === 0) allRecs.push('No changes recommended — system within normal operating parameters');
  for (let i = 0; i < allRecs.length; i++) lines.push(`  ${i+1}. ${allRecs[i]}`);

  // ── Hypotheses for next week ──────────────────────────────────────────
  lines.push('');
  lines.push('HYPOTHESES TO TEST NEXT WEEK:');
  if (edgeStrengths.weaknesses.length > 0) {
    const ws2 = edgeStrengths.weaknesses[0];
    lines.push(`  H1: Blocking ${ws2.type}:${ws2.label} (WR=${_pct(ws2.wr)}) will improve overall WR by reducing low-quality trades`);
  }
  if (wr !== null && wr < 0.55) {
    lines.push('  H2: Raising minimum confidence to 70 will reduce signal count but increase win rate above 60%');
  }
  lines.push('  H3: Confirm that confirmed-bar-only evaluation (forming bar fix) reduces signal count — expected ~1 fewer signal/instrument/day');

  return lines.join('\n');
}

// ── Performance Intelligence (cumulative backtest trend) ──────────────────────

function getPerformanceIntelligence(db, instrument) {
  const rows = _q(db, `
    SELECT br.id, br.run_at, br.win_rate, br.profit_factor, br.sharpe,
           br.trade_count, bd.walk_forward_consistency, bd.multi_obj_score
    FROM   backtest_runs br
    LEFT   JOIN backtest_details bd ON bd.run_id = br.id
    WHERE  br.instrument = ?
    ORDER  BY br.run_at DESC LIMIT 20
  `, [instrument]);

  if (!rows.length) return { instrument, status: 'no_data' };

  const wrs     = rows.map(r => r.win_rate).filter(v => v != null);
  const avgWR   = wrs.reduce((a, b) => a + b, 0) / wrs.length;
  const wrStdev = Math.sqrt(wrs.reduce((s, v) => s + (v - avgWR) ** 2, 0) / wrs.length);

  // Trend: compare avg of last 3 vs avg of previous 3
  let trend = 'stable', degradationAlert = false;
  if (wrs.length >= 6) {
    const r3 = (wrs[0] + wrs[1] + wrs[2]) / 3;
    const p3 = (wrs[3] + wrs[4] + wrs[5]) / 3;
    if (r3 > p3 + 0.04) trend = 'improving';
    else if (r3 < p3 - 0.06) { trend = 'declining'; degradationAlert = true; }
  } else if (wrs.length >= 3) {
    const recent = wrs[0], prev = wrs[wrs.length - 1];
    trend = recent > prev + 0.04 ? 'improving' : recent < prev - 0.06 ? 'declining' : 'stable';
    degradationAlert = recent < prev - 0.10;
  }

  // Stability score: 1 - (stdev * 4), capped 0-1
  const stabilityScore = Math.max(0, Math.min(1, +(1 - wrStdev * 4).toFixed(3)));

  return {
    instrument,
    status: 'ok',
    latest_wr_pct:    wrs[0] != null ? +(wrs[0] * 100).toFixed(1) : null,
    avg_wr_pct:       +(avgWR * 100).toFixed(1),
    wr_stdev_pct:     +(wrStdev * 100).toFixed(1),
    stability_score:  stabilityScore,
    trend,
    degradation_alert: degradationAlert,
    degradation_explanation: degradationAlert
      ? 'Win rate has dropped >6% over last 3 backtest runs vs prior 3 — review strategy parameters and market regime'
      : null,
    history: rows.slice(0, 10).map(r => ({
      id:             r.id,
      run_at:         r.run_at,
      win_rate_pct:   r.win_rate != null ? +(r.win_rate * 100).toFixed(1) : null,
      sharpe:         r.sharpe,
      trade_count:    r.trade_count,
      wf_consistency: r.walk_forward_consistency,
      multi_obj_score: r.multi_obj_score,
    })),
  };
}

// ── Instrument Behavior Profile ───────────────────────────────────────────────
// Builds a statistical behavioral model for each instrument.
// Shows what conditions make each instrument perform differently.

function getInstrumentBehaviorProfile(db, instrument) {
  const rows = _q(db, `
    SELECT s.session, s.htf_bias, s.direction, s.trade_style, s.strategy_name,
           o.result, o.pnl_pts,
           CAST(strftime('%H', s.received_at) AS INTEGER) AS hour_et
    FROM   signals s JOIN outcomes o ON o.signal_id = s.id
    WHERE  s.instrument = ?
      AND  s.received_at >= datetime('now', '-60 days')
    ORDER  BY s.received_at DESC
  `, [instrument]);

  if (rows.length < 10) return { instrument, status: 'insufficient_data', rows_found: rows.length };

  const groupWR = (key) => {
    const m = {};
    for (const r of rows) {
      const k = r[key] ?? 'unknown';
      if (!m[k]) m[k] = { wins: 0, total: 0 };
      m[k].total++;
      if (r.result === 'WIN') m[k].wins++;
    }
    return Object.entries(m)
      .filter(([, v]) => v.total >= 3)
      .map(([k, v]) => ({ label: k, wr: +_wr(v.wins, v.total).toFixed(3), n: v.total }))
      .sort((a, b) => b.wr - a.wr);
  };

  const bestSessions  = groupWR('session');
  const bestHtfBias   = groupWR('htf_bias');
  const bestDirection = groupWR('direction');
  const bestStyle     = groupWR('trade_style');

  // Hour-of-day WR
  const byHour = {};
  for (const r of rows) {
    const h = r.hour_et ?? -1;
    if (!byHour[h]) byHour[h] = { wins: 0, total: 0 };
    byHour[h].total++;
    if (r.result === 'WIN') byHour[h].wins++;
  }
  const bestHours = Object.entries(byHour)
    .filter(([, v]) => v.total >= 3)
    .map(([h, v]) => ({ hour_et: +h, wr: +_wr(v.wins, v.total).toFixed(3), n: v.total }))
    .sort((a, b) => b.wr - a.wr);

  const overall_wr = _wr(rows.filter(r => r.result === 'WIN').length, rows.length);

  return {
    instrument,
    status: 'ok',
    sample_size:     rows.length,
    overall_wr_pct:  overall_wr != null ? +(overall_wr * 100).toFixed(1) : null,
    best_sessions:   bestSessions.slice(0, 5),
    worst_sessions:  [...bestSessions].reverse().slice(0, 3),
    best_htf_bias:   bestHtfBias,
    best_direction:  bestDirection,
    best_style:      bestStyle,
    best_hours_et:   bestHours.slice(0, 5),
    worst_hours_et:  [...bestHours].reverse().slice(0, 3),
    behavioral_notes: _buildBehaviorNotes(instrument, bestSessions, bestDirection, bestStyle, bestHours),
  };
}

function _buildBehaviorNotes(instrument, sessions, direction, style, hours) {
  const notes = [];

  if (sessions.length > 0) {
    const best = sessions[0];
    notes.push(`${instrument} performs best during "${best.label}" session (WR=${_pct(best.wr)}, ${best.n} trades)`);
    if (sessions.length > 1) {
      const worst = sessions[sessions.length - 1];
      notes.push(`${instrument} performs worst during "${worst.label}" session (WR=${_pct(worst.wr)}, ${worst.n} trades) — consider session block`);
    }
  }

  if (direction.length === 2) {
    const d0 = direction[0], d1 = direction[1];
    if (Math.abs(d0.wr - d1.wr) > 0.10) {
      notes.push(`${instrument} shows directional bias: ${d0.label} WR=${_pct(d0.wr)} vs ${d1.label} WR=${_pct(d1.wr)} — weight ${d0.label} trades`);
    }
  }

  if (hours.length > 0 && hours[0].hour_et >= 0) {
    notes.push(`${instrument} best hour of day: ${hours[0].hour_et}:00 ET (WR=${_pct(hours[0].wr)}, ${hours[0].n} trades)`);
  }

  return notes;
}

// ── Explainability Engine ─────────────────────────────────────────────────────

function explainThresholdChange(strategy, from, to, wr, tradeCount) {
  const dir    = to > from ? 'increased' : 'decreased';
  const reason = to > from
    ? `WR=${_pct(wr)} on ${tradeCount} trades is below the target range — threshold raised to reduce false signals`
    : `WR=${_pct(wr)} on ${tradeCount} trades is strong — threshold lowered to capture more high-quality opportunities`;

  return {
    strategy, from, to, direction: dir,
    win_rate_pct: wr != null ? +(wr * 100).toFixed(1) : null,
    trade_count:  tradeCount,
    explanation:  reason,
    impact:       to > from
      ? `Signals from ${strategy} will now require confidence ≥${to} (was ${from}) — fewer but higher-quality entries`
      : `Signals from ${strategy} will now fire at confidence ≥${to} (was ${from}) — more entries from proven patterns`,
  };
}

function explainRegimeClassification(regime, atrRatio, dirEfficiency, structuralTrend) {
  const explanations = {
    volatile: `ATR expansion ratio ${atrRatio.toFixed(2)}× (≥1.5) — unusually large candles indicate news/event. SL-hit risk elevated; WR estimate reduced.`,
    trending: `Directional efficiency ${_pct(dirEfficiency)} (>45%) + structural higher-highs/lower-lows confirm trend. Continuation setups have highest edge here.`,
    ranging:  `Low ATR ratio ${atrRatio.toFixed(2)}× and low directional efficiency ${_pct(dirEfficiency)} — price oscillating in tight range. Avoid continuation setups; favor mean-reversion.`,
    choppy:   `Moderate ATR with no clear direction (efficiency=${_pct(dirEfficiency)}) — mixed signals. Use stricter filters; wait for regime clarification.`,
    unknown:  'Insufficient historical data to classify regime.',
  };
  return {
    regime,
    explanation: explanations[regime] ?? 'Unknown regime.',
    atr_ratio:   +atrRatio.toFixed(3),
    dir_efficiency: +dirEfficiency.toFixed(3),
    structural_trend: structuralTrend,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _persistReport(db, type, weekStart, report) {
  try {
    db.prepare(`
      INSERT INTO strategy_params (instrument, params_json, updated_at, version)
      VALUES (?, ?, datetime('now'), 1)
      ON CONFLICT(instrument) DO UPDATE SET
        params_json = excluded.params_json,
        updated_at  = excluded.updated_at,
        version     = version + 1
    `).run(`REPORT_${type}_${weekStart}`, JSON.stringify(report));
  } catch { /* never crash */ }
}

function loadReport(db, type, weekStart) {
  const ws = weekStart ?? _currentWeekStart();
  try {
    const row = db.prepare(
      `SELECT params_json FROM strategy_params WHERE instrument = ?`
    ).get(`REPORT_${type}_${ws}`);
    return row ? JSON.parse(row.params_json) : null;
  } catch { return null; }
}

module.exports = {
  analyzeDivergence,
  generateMidWeekReport,
  generateWeeklyDeepReport,
  getPerformanceIntelligence,
  getInstrumentBehaviorProfile,
  explainThresholdChange,
  explainRegimeClassification,
  loadReport,
};
