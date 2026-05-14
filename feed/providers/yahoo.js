'use strict';

/**
 * YAHOO FINANCE FEED ADAPTER (pull mode)
 *
 * Polls Yahoo Finance on a configurable interval. Not a true streaming feed —
 * Yahoo doesn't offer WebSocket data. This adapter is here for development
 * continuity while a proper Tradovate/CQG feed is wired up.
 *
 * Replace this with tradovate.js in production for real-time data.
 */

const FeedInterface = require('../feed-interface');

const RETRY_DELAYS = [2000, 4000, 8000, 16000]; // exponential backoff ms

class YahooFeed extends FeedInterface {
  /**
   * @param {object} opts
   * @param {string[]} opts.instruments
   * @param {object}   opts.symbolMap     - { MNQ: 'NQ=F', MGC: 'GC=F' }
   * @param {number}   [opts.pollMs]      - poll interval in ms (default 120 000)
   */
  constructor(opts = {}) {
    super(opts);
    this.pollMs  = opts.pollMs ?? 120_000;
    this._timers = [];
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this.bus.publishFeedEvent('connected', 'yahoo');

    // Initial load for all instruments
    await this._pollAll();

    // Schedule recurring polls
    const t = setInterval(() => this._pollAll(), this.pollMs);
    this._timers.push(t);
  }

  async stop() {
    this._running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this.bus.publishFeedEvent('disconnected', 'yahoo');
  }

  isConnected() { return this._running; }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _pollAll() {
    for (const inst of this.instruments) {
      if (!this._running) break;
      try {
        const symbol = this.symbolMap[inst];
        if (!symbol) continue;
        const bars1m = await this._fetch(symbol, '1m', '7d');
        if (bars1m.length > 0) {
          this.loadSnapshot(inst, bars1m);
        }
      } catch (err) {
        this.bus.publishFeedEvent('error', 'yahoo', { error: err.message, instrument: inst });
      }
    }
  }

  async _fetch(symbol, interval, range, attempt = 0) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?interval=${interval}&range=${range}`;
    let res;
    try {
      res = await fetch(url, {
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
        return this._fetch(symbol, interval, range, attempt + 1);
      }
      throw err;
    }
  }
}

module.exports = YahooFeed;
