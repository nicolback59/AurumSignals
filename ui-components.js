/* ═══════════════════════════════════════════════════════
   NQ Signal Pro V3 — Shared UI Components
   ═══════════════════════════════════════════════════════ */
'use strict';

/* ── Utility helpers ─────────────────────────────────── */
const fmt  = (v, d = 2) => v != null ? Number(v).toFixed(d) : '—';
const fmtP = v => v != null ? Number(v).toFixed(0) + '%' : '—';

// Format a P&L point value cleanly: rounds to 2dp, +/- prefix, ' pts' suffix
function fmtPts(v) {
  if (v == null) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(2) + ' pts';
}

function escH(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Normalize SQLite "YYYY-MM-DD HH:MM:SS" to ISO "YYYY-MM-DDTHH:MM:SSZ"
// so Safari (strict date parser) doesn't return Invalid Date / NaN
function normalizeTs(ts) {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ts)) return ts.replace(' ', 'T') + 'Z';
  return ts;
}

function timeAgo(ts) {
  const iso = normalizeTs(ts);
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(s)) return '';
  if (s < 60)    return Math.floor(s) + 's ago';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function hhmm(ts) {
  const iso = normalizeTs(ts);
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dateKey(ts) {
  const iso = normalizeTs(ts);
  if (!iso) return '?';
  const d = new Date(iso);
  if (isNaN(d)) return '?';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Full datetime: "Mon May 13, 1:04 PM"
function fmtDatetime(ts) {
  const iso = normalizeTs(ts);
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }

/* ── Setup classification ────────────────────────────── */
function setupClass(s) {
  if (!s) return '';
  const u = s.toUpperCase();
  if (u.includes('OTE') && u.includes('STDV')) return 'combo';
  if (u.includes('OTE'))                        return 'ote';
  if (u.includes('RST') || u.includes('RESET')) return 'rst';
  if (u.includes('STDV'))                       return 'stdv';
  return '';
}

function setupColor(s) {
  const map = {
    combo: 'var(--yellow)',
    ote:   'var(--blue)',
    stdv:  'var(--purple)',
    rst:   'var(--tp2)',
  };
  return map[setupClass(s)] || 'var(--blue)';
}

/* ── Badge builders ──────────────────────────────────── */
function directionBadge(dir) {
  const isLong = dir === 'LONG';
  return `<span class="badge badge-${isLong ? 'long' : 'short'}">${isLong ? '▲ LONG' : '▼ SHORT'}</span>`;
}

function gradeBadge(grade) {
  const isAp = grade === 'A+';
  return `<span class="badge badge-${isAp ? 'aplus' : 'a'}">${escH(grade || 'A')}</span>`;
}

function setupBadge(setup) {
  if (!setup) return '';
  const sc = setupClass(setup);
  const cls = sc ? `badge-${sc}` : 'badge-ote';
  return `<span class="badge ${cls}">${escH(setup)}</span>`;
}

function outcomeBadge(result, pnlPts) {
  if (!result) return '';
  const pts = pnlPts != null ? ` ${Number(pnlPts) > 0 ? '+' : ''}${Number(pnlPts).toFixed(2)}` : '';
  return `<span class="badge badge-${result.toLowerCase()}">${result}${pts}</span>`;
}

function tierBadge(tier) {
  if (!tier || tier === 'IGNORE') return '';
  const cls = tier === 'S' ? 'badge-tier-s' : tier === 'A' ? 'badge-tier-a' : 'badge-tier-b';
  return `<span class="badge ${cls}">${tier}</span>`;
}

function statusBadge(status) {
  if (status === 'active')     return '<span class="badge badge-active">ACTIVE</span>';
  if (status === 'shadow')     return '<span class="badge badge-shadow">SHADOW</span>';
  if (status === 'rolled_back') return '<span class="badge badge-muted">ROLLED BACK</span>';
  return '<span class="badge badge-muted">DISCARDED</span>';
}

function instrumentBadge(inst) {
  const cls = inst === 'MNQ' ? 'mnq' : 'mgc';
  return `<span style="color:var(--${cls});font-weight:700;font-size:11px">${inst}</span>`;
}

/* ── Prob bar ────────────────────────────────────────── */
function probBar(label, val, cls) {
  const w = Math.min(Math.max(val || 0, 0), 100);
  return `<div class="prob-bar">
    <div class="prob-bar-header">
      <span class="prob-bar-label">${label}</span>
      <span class="prob-bar-value">${fmtP(val)}</span>
    </div>
    <div class="prob-bar-track">
      <div class="prob-bar-fill ${cls}" style="width:${w}%"></div>
    </div>
  </div>`;
}

/* ── Outcome section ─────────────────────────────────── */
function outcomeSection(sig) {
  if (sig.result) {
    const pts = sig.pnl_pts != null && sig.result !== 'EXPIRED'
      ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-left:6px">${fmtPts(sig.pnl_pts)}</span>`
      : '';
    const exitTs = sig.exit_at
      ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-left:8px">${fmtDatetime(sig.exit_at)}</span>`
      : '';
    return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">${outcomeBadge(sig.result)}${pts}${exitTs}</div>`;
  }
  // Show the live trade_status when no outcome recorded yet
  const status = sig.trade_status || 'ACTIVE';
  if (status === 'ACTIVE') {
    return `<span style="font-family:var(--font-mono);font-size:10px;color:var(--green);letter-spacing:.05em">ACTIVE — watching</span>`;
  }
  return `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);letter-spacing:.05em">${status}</span>`;
}

/* ── Strategy label (human-readable) ─────────────────── */
function strategyLabel(sig) {
  const map = {
    MNQ_INTRADAY: 'MNQ Intraday',
    MNQ_SWING:    'MNQ Swing',
    MNQ_50PT:     'MNQ 50-Point',
    MGC_SCALP:    'MGC Scalp',
    MGC_INTRADAY: 'MGC Intraday',
  };
  return map[sig.strategy_name] || sig.setup || sig.strategy_name || '—';
}

/* ── Signal Card ─────────────────────────────────────── */
function buildSignalCard(sig) {
  const isLong = sig.direction === 'LONG';
  const htfCls = sig.htf_bias
    ? (sig.htf_bias.includes('BULL') ? 'bull' : sig.htf_bias.includes('BEAR') ? 'bear' : '')
    : '';

  // Confidence display — prefer raw confidence, fall back to score×4
  const confVal = sig.confidence ?? (sig.score != null ? sig.score * 4 : null);
  const confChip = confVal != null
    ? `<span class="score-chip" title="Strategy confidence">${confVal}/100</span>`
    : '';

  // TP labels vary by strategy
  const isMgc = (sig.instrument === 'MGC');
  const tp1Label = isMgc ? 'TP1 +10pts' : 'TP1 +25pts';
  const tp2Label = isMgc ? 'TP2 +14pts' : 'TP2 +50pts';
  const tp3Label = isMgc ? 'TP3 +20pts' : 'TP3 +75pts';

  return `<div class="signal-card ${isLong ? 'long' : 'short'}" data-id="${sig.id}">
    <div class="signal-card-header">
      ${directionBadge(sig.direction)}
      ${tierBadge(sig.tier)}
      ${gradeBadge(sig.grade)}
      ${confChip}
      <span class="signal-card-time" title="${fmtDatetime(sig.received_at)}">${timeAgo(sig.received_at)}</span>
    </div>
    <div style="font-family:var(--font-mono);font-size:10px;color:rgba(255,255,255,.5);padding:2px 0 6px;letter-spacing:.03em;display:flex;gap:8px;align-items:center">
      <span style="color:rgba(255,255,255,.7);font-weight:600">${escH(strategyLabel(sig))}</span>
      <span style="color:rgba(255,255,255,.25)">·</span>
      <span>${fmtDatetime(sig.received_at)}</span>
    </div>
    <div class="signal-card-body">
      <div class="signal-card-levels">
        <div class="level-row"><span class="level-label">ENTRY</span><span class="level-value entry">${fmt(sig.entry)}</span></div>
        <div class="level-row"><span class="level-label">STOP</span><span class="level-value sl">${fmt(sig.sl)}</span></div>
        <div class="level-row"><span class="level-label">${tp1Label}</span><span class="level-value tp1">${fmt(sig.tp1)}</span></div>
        <div class="level-row"><span class="level-label">${tp2Label}</span><span class="level-value tp2">${fmt(sig.tp2)}</span></div>
        <div class="level-row"><span class="level-label">${tp3Label}</span><span class="level-value tp3">${fmt(sig.tp3)}</span></div>
      </div>
      <div class="signal-card-probs">
        ${probBar('TP1 Win Prob', sig.win_prob_tp1, 'tp1')}
        ${probBar('TP2 Win Prob', sig.win_prob_tp2, 'tp2')}
        ${probBar('TP3 Win Prob', sig.win_prob_tp3, 'tp3')}
      </div>
    </div>
    <div class="signal-card-footer">
      <div class="tag-list">
        ${sig.htf_bias    ? `<span class="tag ${htfCls}">HTF: ${escH(sig.htf_bias)}</span>` : ''}
        ${sig.session     ? `<span class="tag sess">${escH(sig.session)}</span>` : ''}
        ${sig.trade_style ? `<span class="tag">${escH(sig.trade_style)}</span>` : ''}
        ${sig.rr          ? `<span class="tag">RR ${fmt(sig.rr, 1)}</span>` : ''}
      </div>
      ${outcomeSection(sig)}
    </div>
  </div>`;
}

/* ── Empty State ─────────────────────────────────────── */
function buildEmptyState(icon, title, desc) {
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-title">${title}</div>
    <div class="empty-state-desc">${desc}</div>
  </div>`;
}

/* ── Loading Skeletons ───────────────────────────────── */
function buildSkeletons(n = 3) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton skeleton-card"></div>`
  ).join('');
}

/* ── Stat bar item ───────────────────────────────────── */
function buildStatBarItem(label, id, color) {
  return `<div class="stat-bar-item">
    <div class="stat-bar-label">${label}</div>
    <div class="stat-bar-value" style="color:${color}" id="${id}">—</div>
  </div>`;
}

/* ── WR cell color class ─────────────────────────────── */
function wrClass(rate) {
  if (rate >= 0.60) return 'wr-hi';
  if (rate >= 0.45) return 'wr-mid';
  return 'wr-lo';
}

/* ── Bottom nav ──────────────────────────────────────── */
function buildBottomNav(activePage) {
  const pages = [
    { href: '/',         icon: '◈', label: 'Signals',  key: 'signals'  },
    { href: '/backtest', icon: '◉', label: 'Backtest', key: 'backtest' },
    { href: '/journal',  icon: '◎', label: 'Journal',  key: 'journal'  },
  ];
  return `<nav class="bottom-nav">
    <div class="bottom-nav-items">
      ${pages.map(p => `
        <a href="${p.href}" class="bottom-nav-item${p.key === activePage ? ' active' : ''}">
          <span class="bottom-nav-icon">${p.icon}</span>
          <span class="bottom-nav-label">${p.label}</span>
        </a>`).join('')}
    </div>
  </nav>`;
}
