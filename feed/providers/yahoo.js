'use strict';

/**
 * YAHOO FINANCE FEED ADAPTER (pull mode)
 *
 * Polls Yahoo Finance on an adaptive interval based on market phase.
 * Also runs a fast v7/finance/quote refresh between full bar polls to
 * patch the last bar's close with a near-real-time price, reducing
 * effective lag from ~90s to ~20-30s during RTH.
 *
 * Market phases and poll cadences:
 *   RTH     (09:30–16:00 ET):   full bar poll 30s, quote refresh 20s
 *   GLOBEX  (18:00–09:30 ET):   full bar poll 45s, quote refresh 40s
 *   SETTLE  (17:00–18:00 ET):   full bar poll 90s, no quote refresh
 *
 * Instruments are staggered by STAGGER_MS to avoid simultaneous requests.
 */

const FeedInterface = require('../feed-interface');

const RETRY_DELAYS = [2000, 4000, 8000, 16000];

// Stagger between instruments to reduce simultaneous request spikes
const STAGGER_MS = 8_000;

// Adaptive cadence per market phase (all in ms)
const BAR_POLL_MS   = { RTH: 30_000, GLOBEX: 45_000, SETTLE: 90_000 };
const QUOTE_POLL_MS = { RTH: 20_000, GLOBEX: 40_000, SETTLE:   null }; // null = skip

class YahooFeed extends FeedInterface {
  /**
   * @param {object} opts
   * @param {string[]} opts.instruments
   * @param {object}   opts.symbolMap     - { MNQ: 'NQ=F', MGC: 'GC=F' }
   * @param {number}   [opts.pollMs]      - ignored; adaptive scheduling used instead
   */
  constructor(opts = {}) {
    super(opts);
    this.pollMs    = opts.pollMs ?? 30_000; // kept for external callers reading the property
    this._timers   = [];
    this._lastBars = {}; // symbol → most recent bar array for quote-patching
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this.bus.publishFeedEvent('connected', 'yahoo');

    await this._pollAll();

    this._scheduleBar();
    this._scheduleQuote();
  }

  async stop() {
    this._running = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    this.bus.publishFeedEvent('disconnected', 'yahoo');
  }

  isConnected() { return this._running; }

  // ── Market phase ────────────────────────────────────────────────────────────

  _marketPhase() {
    const now = new Date();
    const utc = now.getUTCHours() + now.getUTCMinutes() / 60;
    // RTH: 09:30–16:00 ET = 13:30–20:00 UTC
    if (utc >= 13.5 && utc < 20) return 'RTH';
    // CME settlement break: 17:00–18:00 ET = 21:00–22:00 UTC
    if (utc >= 21 && utc < 22)   return 'SETTLE';
    return 'GLOBEX';
  }

  // ── Adaptive scheduling ──────────────────────────────────────────────────────

  _scheduleBar() {
    if (!this._running) return;
    const ms = BAR_POLL_MS[this._marketPhase()];
    const t = setTimeout(async () => {
      await this._pollAll();
      this._scheduleBar();
    }, ms);
    this._timers.push(t);
  }

  _scheduleQuote() {
    if (!this._running) return;
    const ms = QUOTE_POLL_MS[this._marketPhase()];
    if (!ms) {
      // Settlement break: skip quote refresh, retry after 5 min
      const t = setTimeout(() => this._scheduleQuote(), 5 * 60_000);
      this._timers.push(t);
      return;
    }
    const t = setTimeout(async () => {
      await this._quickRefresh();
      this._scheduleQuote();
    }, ms);
    this._timers.push(t);
  }

  // ── Full bar poll (v8/finance/chart) ────────────────────────────────────────

  async _pollAll() {
    const instList = [...this.instruments];
    for (let i = 0; i < instList.length; i++) {
      const inst = instList[i];
      if (!this._running) break;

      // Stagger successive instruments to spread load
      if (i > 0) await new Promise(r => setTimeout(r, STAGGER_MS));

      try {
        const symbol = this.symbolMap[inst];
        if (!symbol) continue;
        const bars1m = await this._fetchBars(symbol, '1m', '7d');
        if (bars1m.length > 0) {
          this._lastBars[symbol] = bars1m;
          this.loadSnapshot(inst, bars1m);
        }
      } catch (err) {
        this.bus.publishFeedEvent('error', 'yahoo', { error: err.message, instrument: inst });
      }
    }
  }

  // ── Fast quote refresh (v7/finance/quote) ───────────────────────────────────
  // Fetches current market price for all symbols in one request and patches the
  // last bar's close (and high/low if needed). This cuts effective lag from
  // ~90s to ~20s without the cost of a full bar history re-fetch.

  async _quickRefresh() {
    const symbols = Object.values(this.symbolMap).filter(Boolean);
    if (!symbols.length) return;

    const quotes = await this._fetchQuotes(symbols);
    if (!quotes) return;

    for (const inst of this.instruments) {
      const symbol = this.symbolMap[inst];
      if (!symbol) continue;
      const q = quotes.find(x => x.symbol === symbol);
      if (!q?.price) continue;

      const prevBars = this._lastBars[symbol];
      if (!prevBars?.length) continue;

      // Patch only the last (forming) bar — confirmed bars are immutable
      const patched = prevBars.slice();
      const last = { ...patched[patched.length - 1], close: q.price };
      if (q.price > last.high) last.high = q.price;
      if (q.price < last.low)  last.low  = q.price;
      patched[patched.length - 1] = last;

      this._lastBars[symbol] = patched;
      this.loadSnapshot(inst, patched);
    }
  }

  async _fetchQuotes(symbols) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote`
      + `?symbols=${encodeURIComponent(symbols.join(','))}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const json = await res.json();
      return (json.quoteResponse?.result ?? []).map(q => ({
        symbol: q.symbol,
        price:  q.regularMarketPrice,
      }));
    } catch {
      return null;
    }
  }

  // ── Bar history fetch (v8/finance/chart) ────────────────────────────────────

  async _fetchBars(symbol, interval, range, attempt = 0) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=${interval}&range=${range}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json   = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) return [];
      const tsList = result.timestamp ?? [];
      const quote  = result.indicators?.quote?.[0] ?? {};
      return tsList.map((t, i) => ({
        timestamp: new Date(t * 1000).toISOString(),
        open:      quote.open?.[i],
        high:      quote.high?.[i],
        low:       quote.low?.[i],
        close:     quote.close?.[i],
        volume:    quote.volume?.[i] ?? 0,
      })).filter(b => b.open != null && b.close != null);
    } catch (err) {
      if (attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        return this._fetchBars(symbol, interval, range, attempt + 1);
      }
      throw err;
    }
  }

  // ── Legacy compat alias ──────────────────────────────────────────────────────
  _fetch(symbol, interval, range, attempt = 0) {
    return this._fetchBars(symbol, interval, range, attempt);
  }
}

module.exports = YahooFeed;
