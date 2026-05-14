'use strict';

/**
 * BAR AGGREGATOR
 *
 * Accepts raw 1-minute bars for an instrument and maintains rolling windows
 * for every required timeframe. On each new 1m bar, checks whether a higher-TF
 * bar has just completed and emits it via the data bus.
 *
 * Supported output TFs: 3m, 5m, 15m, 30m, 45m, 1h, 4h, 1d
 *
 * Usage (snapshot mode — existing scanner feeds a full 1m history at once):
 *   const agg = new BarAggregator('MNQ', bus);
 *   agg.loadHistory(bars1m);     // build all windows from historical data
 *   const snap = agg.snapshot(); // { bars5m, bars15m, bars30m, bars45m, bars1h, bars4h, bars1d }
 *
 * Usage (streaming mode — feed calls addBar on every new 1m bar):
 *   agg.addBar(bar);   // emits bar:5m etc. when a TF boundary completes
 */

const bus = require('./data-bus');

// TF definitions: label → minutes per bar
const TF_MINUTES = {
  '3m':  3,
  '5m':  5,
  '15m': 15,
  '30m': 30,
  '45m': 45,
  '1h':  60,
  '4h':  240,
  '1d':  1440,
};

// Maximum number of closed bars to keep per TF (memory cap)
const MAX_BARS = {
  '3m':  500,
  '5m':  400,
  '15m': 300,
  '30m': 200,
  '45m': 150,
  '1h':  200,
  '4h':  100,
  '1d':  120,
};

class BarAggregator {
  /**
   * @param {string} instrument  - e.g. 'MNQ', 'MGC'
   * @param {object} [dataBus]   - optional override (for testing); defaults to singleton bus
   */
  constructor(instrument, dataBus = bus) {
    this.instrument = instrument;
    this.bus        = dataBus;

    // Closed bars per TF
    this._bars = {};
    // Current in-progress bar per TF
    this._open = {};

    for (const tf of Object.keys(TF_MINUTES)) {
      this._bars[tf] = [];
      this._open[tf] = null;
    }
  }

  /**
   * Load a full 1m history and build all TF windows.
   * Does NOT emit events — call snapshot() after to read results.
   */
  loadHistory(bars1m) {
    // Reset state
    for (const tf of Object.keys(TF_MINUTES)) {
      this._bars[tf] = [];
      this._open[tf] = null;
    }
    for (const bar of bars1m) {
      this._ingest(bar, false);
    }
    // Close any partially-open bars so we have the most recent candle
    for (const tf of Object.keys(TF_MINUTES)) {
      if (this._open[tf]) {
        const closed = { ...this._open[tf] };
        delete closed._bucket;
        delete closed._bucketMs;
        this._bars[tf].push(closed);
        if (this._bars[tf].length > MAX_BARS[tf]) this._bars[tf].shift();
      }
    }
  }

  /**
   * Add a single new 1m bar (streaming mode).
   * Emits bar:<tf> on the data bus for each completed higher-TF bar.
   */
  addBar(bar1m) {
    this._ingest(bar1m, true);
  }

  /**
   * Return a snapshot of all TF histories.
   */
  snapshot() {
    return {
      bars3m:  this._bars['3m'].slice(),
      bars5m:  this._bars['5m'].slice(),
      bars15m: this._bars['15m'].slice(),
      bars30m: this._bars['30m'].slice(),
      bars45m: this._bars['45m'].slice(),
      bars1h:  this._bars['1h'].slice(),
      bars4h:  this._bars['4h'].slice(),
      bars1d:  this._bars['1d'].slice(),
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _ingest(bar, emit) {
    for (const [tf, minutes] of Object.entries(TF_MINUTES)) {
      this._updateTf(tf, minutes, bar, emit);
    }
  }

  _updateTf(tf, minutes, bar1m, emit) {
    const barTs      = new Date(bar1m.timestamp);
    const bucket     = this._bucketTs(barTs, minutes);
    const bucketMs   = bucket.getTime();

    const cur = this._open[tf];

    if (cur && cur._bucketMs === bucketMs) {
      // Extend current open bar
      cur.high   = Math.max(cur.high,   bar1m.high);
      cur.low    = Math.min(cur.low,    bar1m.low);
      cur.close  = bar1m.close;
      cur.volume = (cur.volume ?? 0) + (bar1m.volume ?? 0);
    } else {
      // A new bucket starts — close the previous one if any
      if (cur) {
        const closed = { ...cur };
        delete closed._bucket;
        delete closed._bucketMs;
        this._bars[tf].push(closed);
        if (this._bars[tf].length > MAX_BARS[tf]) this._bars[tf].shift();
        if (emit) {
          this.bus.publishBar(this.instrument, tf, closed, this._bars[tf].slice());
        }
      }
      // Open a new bar
      this._open[tf] = {
        _bucket:   bucket,
        _bucketMs: bucketMs,
        timestamp: bucket.toISOString(),
        open:      bar1m.open,
        high:      bar1m.high,
        low:       bar1m.low,
        close:     bar1m.close,
        volume:    bar1m.volume ?? 0,
      };
    }
  }

  /**
   * Truncate a timestamp to the nearest TF bucket boundary (UTC).
   */
  _bucketTs(date, minutes) {
    const ms     = date.getTime();
    const bucket = Math.floor(ms / (minutes * 60 * 1000)) * (minutes * 60 * 1000);
    return new Date(bucket);
  }
}

module.exports = BarAggregator;
