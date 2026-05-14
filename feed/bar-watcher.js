'use strict';

/**
 * BAR WATCHER — event-driven scan trigger
 *
 * Listens to the data bus for completed 5-minute bars and fires a callback
 * with the full multi-TF snapshot, replacing the dumb timer-based scan loop.
 *
 * Two trigger paths:
 *
 *   Tradovate (streaming):
 *     BarAggregator.addBar() → detects 5m bucket boundary → emits 'bar:5m'
 *     → BarWatcher fires onReady(instrument, snapshot) within ~1s of bar close.
 *
 *   Yahoo / pull mode:
 *     YahooFeed.loadSnapshot() → emits 'bars:ready'
 *     → BarWatcher fires onReady for each polled instrument.
 *     (Timer-based fallback in scanner-core still runs every 5 min.)
 *
 * Dedup guard: per-instrument bucket tracking prevents double-firing when
 * both 'bar:5m' and 'bars:ready' arrive for the same bar in streaming mode.
 */

const bus = require('./data-bus');

class BarWatcher {
  /**
   * @param {Function} onReady  - callback(instrument, snapshot)
   *   snapshot: { bars5m, bars15m, bars30m, bars45m, bars1h, bars4h, bars1d }
   * @param {object}   [dataBus] - override for testing
   */
  constructor(onReady, dataBus = bus) {
    this._onReady       = onReady;
    this._bus           = dataBus;
    this._lastBucket    = {};   // instrument → last fired bucket ISO string
    this._listeners     = [];   // [event, fn] pairs for clean teardown

    this._wire();
  }

  _wire() {
    // Tradovate path: fires when BarAggregator closes a 5m bar
    const on5m = ({ instrument, bar, history }) => {
      const snap = this._bus._getSnapshot?.(instrument);
      // Use the history array from the event for bars5m; other TFs come from the agg's snapshot
      const bars5m = history ?? [];
      this._maybeFire(instrument, bar.timestamp, { bars5m });
    };
    this._bus.on('bar:5m', on5m);
    this._listeners.push(['bar:5m', on5m]);

    // Yahoo / pull path: fires after each full snapshot load
    const onReady = (payload) => {
      const { instrument, bars5m = [], bars15m = [], bars30m = [],
              bars45m = [], bars1h = [], bars4h = [], bars1d = [] } = payload;
      const lastBar = bars5m[bars5m.length - 1];
      if (!lastBar) return;
      // Use the bar's timestamp as the bucket key
      const bucket = this._snapBucket(lastBar.timestamp);
      this._maybeFire(instrument, bucket, { bars5m, bars15m, bars30m, bars45m, bars1h, bars4h, bars1d });
    };
    this._bus.on('bars:ready', onReady);
    this._listeners.push(['bars:ready', onReady]);
  }

  /** Fire the callback if this instrument hasn't fired for this 5m bucket yet. */
  _maybeFire(instrument, rawTs, snapshot) {
    const bucket = this._snapBucket(rawTs);
    if (this._lastBucket[instrument] === bucket) return;  // already fired for this bar
    this._lastBucket[instrument] = bucket;
    try {
      this._onReady(instrument, snapshot);
    } catch (err) {
      console.error(`[BarWatcher] onReady error for ${instrument}:`, err.message);
    }
  }

  /** Quantize a timestamp to its 5-minute bucket ISO string. */
  _snapBucket(ts) {
    if (!ts) return String(Date.now());
    const ms     = new Date(ts).getTime();
    const bucket = Math.floor(ms / (5 * 60 * 1000)) * (5 * 60 * 1000);
    return new Date(bucket).toISOString();
  }

  /** Stop watching — remove all bus listeners. */
  destroy() {
    for (const [event, fn] of this._listeners) {
      this._bus.off(event, fn);
    }
    this._listeners = [];
  }
}

module.exports = BarWatcher;
