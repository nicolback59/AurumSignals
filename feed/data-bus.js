'use strict';

/**
 * DATA BUS — singleton EventEmitter for market data distribution
 *
 * Events emitted:
 *   bar:<tf>         e.g. 'bar:1m', 'bar:5m', 'bar:15m', 'bar:30m', 'bar:1h', 'bar:4h', 'bar:1d'
 *                    payload: { instrument, tf, bar, history }
 *
 *   bars:ready       Emitted when a full snapshot of all TFs is available for an instrument.
 *                    payload: { instrument, bars5m, bars15m, bars30m, bars45m, bars1h, bars4h, bars1d }
 *
 *   price:<symbol>   Raw price tick (no OHLCV, just latest close)
 *                    payload: { symbol, price, ts }
 *
 *   feed:error       payload: { provider, error }
 *   feed:connected   payload: { provider }
 *   feed:disconnected payload: { provider }
 */

const EventEmitter = require('events');

class DataBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // many subsystems listen
  }

  /** Publish a completed bar for a specific timeframe. */
  publishBar(instrument, tf, bar, history = []) {
    this.emit(`bar:${tf}`, { instrument, tf, bar, history });
  }

  /** Publish a full multi-TF snapshot (bars:ready). */
  publishReady(instrument, snapshot) {
    this.emit('bars:ready', { instrument, ...snapshot });
  }

  /** Publish a raw price tick. */
  publishPrice(symbol, price, ts = null) {
    this.emit(`price:${symbol}`, { symbol, price, ts: ts ?? new Date().toISOString() });
  }

  /** Publish a feed lifecycle event. */
  publishFeedEvent(type, provider, extra = {}) {
    this.emit(`feed:${type}`, { provider, ...extra });
  }
}

// Singleton — the whole process shares one bus.
const bus = new DataBus();
module.exports = bus;
