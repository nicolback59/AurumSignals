/* ═══════════════════════════════════════════════════════
   Aurum Signals — Shared UI Components
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

function fmtExpiryReason(reason) {
  const map = {
    EXPIRED_MAX_HOLD:      'Expired — Max Hold',
    EXPIRED_MARKET_CLOSE:  'Expired — Market Close',
    EXPIRED_WEEKEND_CLOSE: 'Expired — Weekend Close',
    EXPIRED_STUCK_TRADE:   'Expired — Session End',
    MAX_HOLD_TIME:         'Expired — Max Hold',
  };
  if (!reason) return 'Expired';
  return map[reason] || reason.replace(/_/g, ' ').replace(/^EXPIRED /, 'Expired — ');
}

// ── Hard expiry rule (mirrors trades.html getTradeExpiry) ─────────────────
const _NO_OVERNIGHT_UI = new Set(['MGC_SCALP', 'MGC_INTRADAY', 'MNQ_INTRADAY', 'MNQ_50PT']);
const _MAX_HOLD_MIN_UI = { MGC_SCALP: 60, MGC_INTRADAY: 240, MNQ_INTRADAY: 240, MNQ_50PT: 360, MNQ_SWING: 72 * 60 };

function _toPtUI(d) {
  return new Date((d instanceof Date ? d : new Date(
    typeof d === 'string' && !d.includes('T') ? d + 'Z' : d
  )).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function getTradeExpiryUI(sig) {
  if (sig.result === 'WIN' || sig.result === 'LOSS' || sig.result === 'BE') return null;
  if (sig.result === 'EXPIRED') return sig.expiration_reason || 'EXPIRED_STUCK_TRADE';
  if (sig.trade_status === 'EXPIRED') return sig.expiration_reason || 'EXPIRED_STUCK_TRADE';

  const isNoOvernight = _NO_OVERNIGHT_UI.has(sig.strategy_name) ||
    (sig.trade_style && sig.trade_style !== 'swing' && sig.strategy_name && !sig.strategy_name.toUpperCase().includes('SWING'));

  const nowPt = _toPtUI(new Date());
  const ptDow = nowPt.getDay();
  const ptHm  = nowPt.getHours() * 60 + nowPt.getMinutes();

  const isWeekendClose = (ptDow === 5 && ptHm >= 13 * 60) || ptDow === 6 || (ptDow === 0 && ptHm < 14 * 60);
  if (isWeekendClose && isNoOvernight) return 'EXPIRED_WEEKEND_CLOSE';

  if (ptDow >= 1 && ptDow <= 5 && ptHm >= 13 * 60 && isNoOvernight) {
    const sigPt = _toPtUI(sig.received_at);
    const sameDay = nowPt.getFullYear() === sigPt.getFullYear() &&
                    nowPt.getMonth()    === sigPt.getMonth()    &&
                    nowPt.getDate()     === sigPt.getDate();
    const sigHm = sigPt.getHours() * 60 + sigPt.getMinutes();
    if (!sameDay || sigHm < 13 * 60) return 'EXPIRED_MARKET_CLOSE';
  }

  const maxMin = _MAX_HOLD_MIN_UI[sig.strategy_name] || (sig.trade_style === 'swing' ? 72 * 60 : 360);
  const ageMin = (Date.now() - _toPtUI(sig.received_at).getTime()) / 60000;
  if (ageMin > maxMin) return 'EXPIRED_MAX_HOLD';

  return null;
}

function outcomeBadge(result, pnlPts, expiryReason) {
  if (!result) return '';
  if (result === 'EXPIRED') {
    return `<span class="badge badge-expired" title="${escH(expiryReason || 'EXPIRED')}">${escH(fmtExpiryReason(expiryReason))}</span>`;
  }
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
  // Resolve WIN/LOSS/BE from backend
  if (sig.result && sig.result !== 'EXPIRED') {
    const pts = sig.pnl_pts != null
      ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-left:6px">${fmtPts(sig.pnl_pts)}</span>`
      : '';
    const exitTs = sig.exit_at
      ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-left:8px">${fmtDatetime(sig.exit_at)}</span>`
      : '';
    return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">${outcomeBadge(sig.result, sig.pnl_pts, null)}${pts}${exitTs}</div>`;
  }

  // Apply hard expiry rule — covers backend EXPIRED, trade_status=EXPIRED, and client-side time check
  const expiryReason = getTradeExpiryUI(sig);
  if (expiryReason) {
    const exitTs = sig.exit_at
      ? `<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-left:8px">${fmtDatetime(sig.exit_at)}</span>`
      : '';
    return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">${outcomeBadge('EXPIRED', null, expiryReason)}${exitTs}</div>`;
  }

  // Genuinely active
  return `<span style="font-family:var(--font-mono);font-size:10px;color:var(--green);letter-spacing:.05em">ACTIVE — watching</span>`;
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

/* ── SVG icon strings for bottom nav ─────────────────── */
const _ICON_HOME     = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
const _ICON_SIGNAL   = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
const _ICON_TRADES   = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
const _ICON_JOURNAL  = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

/* ── Bottom nav ──────────────────────────────────────── */
function buildBottomNav(activePage) {
  const pages = [
    { href: '/',         icon: _ICON_HOME,    label: 'Home',    key: 'home'     },
    { href: '/signals',  icon: _ICON_SIGNAL,  label: 'Signals', key: 'signals'  },
    { href: '/trades',   icon: _ICON_TRADES,  label: 'Trades',  key: 'trades'   },
    { href: '/journal',  icon: _ICON_JOURNAL, label: 'Journal', key: 'journal'  },
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

/* ── User auth menu (top-nav) ────────────────────────── */
const _ICON_CHEVRON = `<svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

async function initUserMenu(containerId = 'navUser') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.style.cssText = 'position:relative;display:flex;align-items:center';

  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });

    if (!res.ok) {
      el.innerHTML = `
        <a href="/login" style="font-size:12px;font-weight:500;color:var(--text-muted);text-decoration:none;padding:4px 10px;border:1px solid var(--border-default);border-radius:6px;transition:150ms ease">Sign In</a>
        <a href="/register" style="font-size:12px;font-weight:600;color:#fff;background:var(--accent);text-decoration:none;padding:4px 12px;border-radius:6px;margin-left:6px">Start Free</a>`;
      return;
    }

    const u = await res.json();
    const initial    = (u.name || u.email || '?')[0].toUpperCase();
    const planColor  = u.plan === 'elite' ? 'var(--yellow)' : u.plan === 'pro' ? 'var(--accent)' : 'var(--text-muted)';
    const planTxt    = (u.plan || 'free').toUpperCase();
    const displayName = escH(u.name || u.email.split('@')[0]);

    el.innerHTML = `
      <button id="_nuBtn"
        style="display:flex;align-items:center;gap:6px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:20px;padding:3px 10px 3px 3px;cursor:pointer;color:var(--text-secondary);transition:150ms ease"
        onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border-default)'">
        <span style="width:22px;height:22px;border-radius:50%;background:var(--accent-glow);border:1px solid var(--accent-border);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--accent);flex-shrink:0">${escH(initial)}</span>
        <span style="font-size:11px;font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayName}</span>
        <span style="font-size:9px;font-weight:700;letter-spacing:.05em;color:${planColor}">${escH(planTxt)}</span>
        ${_ICON_CHEVRON}
      </button>
      <div id="_nud" style="display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:200px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.55);padding:6px;z-index:9999">
        <div style="padding:8px 12px 10px;border-bottom:1px solid var(--border-subtle);margin-bottom:4px">
          <div style="font-size:12px;font-weight:600;color:var(--text-primary)">${displayName}</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${escH(u.email)}</div>
          <div style="margin-top:6px"><span style="font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:20px;color:${planColor};border:1px solid;border-color:currentColor;background:rgba(255,255,255,.04)">${escH(planTxt)}</span></div>
        </div>
        ${u.plan !== 'elite' ? `<a href="/pricing" style="display:block;padding:7px 12px;border-radius:7px;font-size:12px;color:var(--accent);text-decoration:none;font-weight:500;transition:150ms ease" onmouseover="this.style.background='var(--accent-glow)'" onmouseout="this.style.background='transparent'">Upgrade Plan</a>` : ''}
        <button onclick="signOut()" style="display:block;width:100%;padding:7px 12px;border-radius:7px;background:transparent;border:none;font:inherit;font-size:12px;color:var(--red);cursor:pointer;text-align:left;transition:150ms ease" onmouseover="this.style.background='var(--red-glow)'" onmouseout="this.style.background='transparent'">Sign Out</button>
      </div>`;

    // Toggle dropdown
    document.getElementById('_nuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = document.getElementById('_nud');
      dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
    });

    // Close on outside click
    document.addEventListener('click', () => {
      const dd = document.getElementById('_nud');
      if (dd) dd.style.display = 'none';
    });
  } catch { /* auth is optional — silent fail */ }
}

async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  window.location.href = '/login';
}
