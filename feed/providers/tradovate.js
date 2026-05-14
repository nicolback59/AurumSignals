'use strict';

/**
 * TRADOVATE FEED ADAPTER — WebSocket streaming (production feed)
 *
 * Replaces Yahoo Finance polling with real-time 1-minute bar data from
 * Tradovate's market data WebSocket. Free with any Tradovate account.
 *
 * Required environment variables (or opts passed to constructor):
 *   TRADOVATE_USERNAME    — your Tradovate login username
 *   TRADOVATE_PASSWORD    — your Tradovate login password
 *   TRADOVATE_APP_ID      — application name registered in developer portal (e.g. "NQSignalPro")
 *   TRADOVATE_APP_VERSION — e.g. "1.0"
 *   TRADOVATE_CID         — client ID from developer portal
 *   TRADOVATE_SECRET      — client secret from developer portal
 *   TRADOVATE_ENV         — "live" (default) or "demo"
 *
 * Symbol map (instrument → front-month contract):
 *   MNQ → resolved automatically via /contract/find at connect time
 *   MGC → resolved automatically
 *
 * Protocol notes:
 *   - Tradovate WS uses text frames with format: `{endpoint}\n{reqId}\n\n{json}`
 *   - Server sends `[]` heartbeat every ~2.5 s; client must echo `[]`
 *   - Authorization frame:  `authorize\n0\n\n{"token":"<accessToken>"}`
 *   - Chart subscribe:       `md/subscribeChart\n{id}\n\n{...}`
 *   - Chart response format: `{"s":"ok","i":{id},"d":{"charts":[{"id":{id},"td":{"bars":[...]}}]}}`
 *   - Real-time update:      `{"d":{"charts":[{"id":{id},"td":{"bars":[...]}}]}}`
 */

const WebSocket     = require('ws');
const FeedInterface = require('../feed-interface');

const ENDPOINTS = {
  live: {
    rest: 'https://live.tradovateapi.com/v1',
    md:   'wss://md.tradovateapi.com/v1/websocket',
  },
  demo: {
    rest: 'https://demo.tradovateapi.com/v1',
    md:   'wss://md-d.tradovateapi.com/v1/websocket',
  },
};

// Contract search: instrument key → Tradovate product code
const PRODUCT_CODES = {
  MNQ: 'MNQ',
  MGC: 'MGC',
};

const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 30000]; // ms
const HEARTBEAT_TIMEOUT_MS = 10_000; // consider connection dead if no heartbeat for 10s
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

class TradovateFeed extends FeedInterface {
  /**
   * @param {object} opts
   * @param {string}   opts.username
   * @param {string}   opts.password
   * @param {string}   opts.appId
   * @param {string}   opts.appVersion
   * @param {number}   opts.cid
   * @param {string}   opts.secret
   * @param {string}   [opts.env]         'live' | 'demo'  (default 'live')
   * @param {string[]} [opts.instruments] e.g. ['MNQ','MGC']
   * @param {object}   [opts.symbolMap]   override auto-resolve: { MNQ: 'MNQM5', MGC: 'MGCM5' }
   */
  constructor(opts = {}) {
    super({
      instruments: opts.instruments || ['MNQ', 'MGC'],
      symbolMap:   opts.symbolMap   || {},
    });

    this._creds = {
      username:   opts.username   || process.env.TRADOVATE_USERNAME    || '',
      password:   opts.password   || process.env.TRADOVATE_PASSWORD    || '',
      appId:      opts.appId      || process.env.TRADOVATE_APP_ID      || 'NQSignalPro',
      appVersion: opts.appVersion || process.env.TRADOVATE_APP_VERSION || '1.0',
      cid:        Number(opts.cid    || process.env.TRADOVATE_CID    || 0),
      secret:     opts.secret     || process.env.TRADOVATE_SECRET    || '',
    };
    this._env      = (opts.env || process.env.TRADOVATE_ENV || 'live').toLowerCase();
    this._ep       = ENDPOINTS[this._env] ?? ENDPOINTS.live;

    this._ws          = null;
    this._accessToken = null;
    this._tokenExpiry = 0;  // epoch ms
    this._reqId       = 1;
    this._reconnects  = 0;
    this._reconnTimer = null;
    this._hbTimer     = null;
    this._tokenTimer  = null;

    // subscriptionId → instrument mapping (for routing incoming bar data)
    this._subMap = new Map();  // subscriptionId (number) → instrument string
    // instrument → resolved contract name
    this._contracts = { ...opts.symbolMap };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Returns true when credentials are configured. */
  isConfigured() {
    return !!(this._creds.username && this._creds.password && this._creds.cid && this._creds.secret);
  }

  async start() {
    if (this._running) return;
    if (!this.isConfigured()) {
      this.bus.publishFeedEvent('error', 'tradovate', {
        error: 'Tradovate credentials not configured — set TRADOVATE_USERNAME/PASSWORD/CID/SECRET env vars',
      });
      return;
    }
    this._running = true;
    await this._connect();
  }

  async stop() {
    this._running = false;
    clearTimeout(this._reconnTimer);
    clearTimeout(this._hbTimer);
    clearTimeout(this._tokenTimer);
    if (this._ws) {
      this._ws.removeAllListeners();
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this.bus.publishFeedEvent('disconnected', 'tradovate');
  }

  isConnected() {
    return this._running && this._ws?.readyState === WebSocket.OPEN;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  async _authenticate() {
    const body = {
      name:       this._creds.username,
      password:   this._creds.password,
      appId:      this._creds.appId,
      appVersion: this._creds.appVersion,
      cid:        this._creds.cid,
      sec:        this._creds.secret,
    };
    const res = await fetch(`${this._ep.rest}/auth/accesstokenrequest`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tradovate auth failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.accessToken) throw new Error(`Tradovate auth: no accessToken in response`);
    this._accessToken = data.accessToken;
    this._tokenExpiry = data.expirationTime
      ? new Date(data.expirationTime).getTime()
      : Date.now() + 23 * 60 * 60 * 1000;  // fallback: 23h from now
    this._scheduleTokenRefresh();
    return data.accessToken;
  }

  _scheduleTokenRefresh() {
    clearTimeout(this._tokenTimer);
    const msUntilRefresh = Math.max(60_000, this._tokenExpiry - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this._tokenTimer = setTimeout(async () => {
      try {
        await this._authenticate();
        // Re-send auth frame if WS is open
        if (this.isConnected()) this._sendAuth();
      } catch (err) {
        this.bus.publishFeedEvent('error', 'tradovate', { error: `Token refresh failed: ${err.message}` });
      }
    }, msUntilRefresh);
  }

  // ── Contract resolution ──────────────────────────────────────────────────────

  async _resolveContracts() {
    for (const inst of this.instruments) {
      if (this._contracts[inst]) continue; // already resolved (or explicitly set)
      try {
        const code = PRODUCT_CODES[inst] || inst;
        const res  = await fetch(
          `${this._ep.rest}/contract/find?name=${encodeURIComponent(code)}`,
          {
            headers: { Authorization: `Bearer ${this._accessToken}` },
            signal:  AbortSignal.timeout(10_000),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contracts = await res.json();
        // Pick the first live, non-expired continuous or front-month contract
        const front = Array.isArray(contracts) ? contracts[0] : contracts;
        if (front?.name) {
          this._contracts[inst] = front.name;
          this._log(`Resolved ${inst} → ${front.name}`);
        } else {
          throw new Error(`No contract found for ${code}`);
        }
      } catch (err) {
        // Fallback: build a plausible contract name from current date
        this._contracts[inst] = this._guessContractName(inst);
        this._log(`Contract auto-resolve failed for ${inst}: ${err.message} — using ${this._contracts[inst]}`);
      }
    }
  }

  /** Guess the front-month Tradovate contract symbol from current date. */
  _guessContractName(inst) {
    const now     = new Date();
    const year    = now.getFullYear();
    const month   = now.getMonth() + 1;  // 1-based
    // Quarterly expirations: H(Mar), M(Jun), U(Sep), Z(Dec)
    const quarters = [[3,'H'],[6,'M'],[9,'U'],[12,'Z']];
    const next    = quarters.find(([m]) => m >= month) || quarters[0];
    const expY    = (next[0] < month) ? year + 1 : year;
    return `${inst}${next[1]}${String(expY).slice(-1)}`; // e.g. MNQM5
  }

  _log(msg) {
    console.log(`[TradovateFeed] ${msg}`);
  }

  // ── WebSocket connection ─────────────────────────────────────────────────────

  async _connect() {
    try {
      await this._authenticate();
      await this._resolveContracts();
    } catch (err) {
      this.bus.publishFeedEvent('error', 'tradovate', { error: `Pre-connect failed: ${err.message}` });
      this._scheduleReconnect();
      return;
    }

    const ws = new WebSocket(this._ep.md, {
      headers: { 'User-Agent': 'NQSignalPro/1.0' },
    });
    this._ws = ws;

    ws.on('open', () => {
      this._reconnects = 0;
      this._log(`WS connected (${this._env})`);
      this._sendAuth();
    });

    ws.on('message', data => {
      const text = data.toString();
      this._resetHeartbeat();
      this._handleMessage(text);
    });

    ws.on('close', (code, reason) => {
      this._log(`WS closed: ${code} ${reason}`);
      this.bus.publishFeedEvent('disconnected', 'tradovate', { code, reason: reason.toString() });
      if (this._running) this._scheduleReconnect();
    });

    ws.on('error', err => {
      this._log(`WS error: ${err.message}`);
      this.bus.publishFeedEvent('error', 'tradovate', { error: err.message });
    });

    this._resetHeartbeat();
  }

  _sendAuth() {
    this._send(`authorize\n0\n\n${JSON.stringify({ token: this._accessToken })}`);
  }

  _send(text) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(text);
    }
  }

  _resetHeartbeat() {
    clearTimeout(this._hbTimer);
    this._hbTimer = setTimeout(() => {
      this._log('Heartbeat timeout — reconnecting');
      this.bus.publishFeedEvent('error', 'tradovate', { error: 'heartbeat timeout' });
      try { this._ws?.close(); } catch {}
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnTimer);
    const delay = RECONNECT_DELAYS[Math.min(this._reconnects, RECONNECT_DELAYS.length - 1)];
    this._reconnects++;
    this._log(`Reconnect in ${delay}ms (attempt ${this._reconnects})`);
    this._reconnTimer = setTimeout(() => {
      if (this._running) this._connect();
    }, delay);
  }

  // ── Message parsing ──────────────────────────────────────────────────────────

  _handleMessage(text) {
    // Server heartbeat
    if (text === '[]' || text.trim() === '') {
      this._send('[]');  // echo heartbeat
      return;
    }

    // Tradovate frame: `{endpoint}\n{reqId}\n\n{json}`
    // Or plain JSON for push updates: `{json}`
    let payload;
    try {
      // Try plain JSON first (push updates)
      payload = JSON.parse(text);
    } catch {
      // Try the framed format
      const nlIdx = text.indexOf('\n');
      if (nlIdx === -1) return;
      const bodyStart = text.indexOf('\n\n');
      if (bodyStart === -1) return;
      const body = text.slice(bodyStart + 2).trim();
      if (!body) return;
      try { payload = JSON.parse(body); } catch { return; }
    }

    if (!payload) return;

    // Authorization response
    if (payload.i === 0 || (payload.s === 'ok' && payload.i === undefined && !payload.d?.charts)) {
      if (payload.s === 'ok' || payload.accessToken != null) {
        this._log('Authorized — subscribing to chart data');
        this._subscribeAll();
        this.bus.publishFeedEvent('connected', 'tradovate');
      }
      return;
    }

    // Chart data (initial batch or real-time update)
    const charts = payload.d?.charts ?? payload.charts;
    if (charts) {
      this._handleCharts(charts);
      return;
    }
  }

  _subscribeAll() {
    this._subMap.clear();
    for (const inst of this.instruments) {
      const symbol = this._contracts[inst];
      if (!symbol) continue;
      const id = this._reqId++;
      this._subMap.set(id, inst);
      const frame = JSON.stringify({
        symbol,
        chartDescription: {
          underlyingType:    'MinuteBar',
          elementSize:       1,
          elementSizeUnit:   'UnderlyingUnits',
          withHistogram:     false,
        },
        timeRange: {
          asMuchAsElements: 500,  // up to 500 historical 1m bars on connect
        },
      });
      this._send(`md/subscribeChart\n${id}\n\n${frame}`);
      this._log(`Subscribed to ${symbol} 1m bars (sub id ${id})`);
    }
  }

  _handleCharts(charts) {
    for (const chart of charts) {
      const subId = chart.id;
      const inst  = this._subMap.get(subId);
      if (!inst) continue;

      const bars = chart.td?.bars ?? chart.bars ?? [];
      if (!bars.length) continue;

      // Determine if this is a historical batch (many bars) or a real-time tick (1–2 bars)
      const isBatch = bars.length > 2;

      if (isBatch) {
        // Load full history into the aggregator
        const normalized = bars.map(b => this._normalizeBar(b)).filter(Boolean);
        if (normalized.length) {
          this.loadSnapshot(inst, normalized);
          this._log(`${inst}: loaded ${normalized.length} historical 1m bars`);
        }
      } else {
        // Real-time: stream individual bars through the aggregator
        for (const b of bars) {
          const bar = this._normalizeBar(b);
          if (bar) this.onBar(inst, bar);
        }
      }
    }
  }

  _normalizeBar(b) {
    if (!b) return null;
    // Tradovate bar timestamps are ms epoch integers
    const ts = typeof b.timestamp === 'number'
      ? new Date(b.timestamp).toISOString()
      : b.timestamp;
    const open  = b.open;
    const high  = b.high;
    const low   = b.low;
    const close = b.close;
    if (open == null || close == null) return null;
    return {
      timestamp: ts,
      open,
      high:   high  ?? open,
      low:    low   ?? open,
      close,
      volume: (b.upVolume ?? 0) + (b.downVolume ?? 0),
    };
  }
}

module.exports = TradovateFeed;
