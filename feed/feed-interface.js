'use strict';

/**
 * FEED INTERFACE — abstract adapter contract
 *
 * All feed providers extend this class. They are responsible for:
 *   1. Fetching/streaming 1m bars for a given symbol
 *   2. Calling this.onBar(symbol, bar) for each new bar
 *   3. Handling reconnection internally
 *
 * The FeedInterface wires each onBar call into a BarAggregator and then
 * publishes the resulting multi-TF snapshot to the data bus.
 */

const EventEmitter  = require('events');
const BarAggregator = require('./bar-aggregator');
const bus           = require('./data-bus');

class FeedInterface extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string[]} opts.instruments  - e.g. ['MNQ', 'MGC']
   * @param {object}   opts.symbolMap    - { MNQ: 'NQ=F', MGC: 'GC=F' }
   */
  constructor(opts = {}) {
    super();
    this.instruments = opts.instruments || ['MNQ', 'MGC'];
    this.symbolMap   = opts.symbolMap   || { MNQ: 'NQ=F', MGC: 'GC=F' };
    this.bus         = bus;

    // One BarAggregator per instrument
    this._aggs = {};
    for (const inst of this.instruments) {
      this._aggs[inst] = new BarAggregator(inst, bus);
    }

    this._running = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Start streaming. Subclasses must implement. */
  async start() { throw new Error('FeedInterface.start() must be implemented'); }

  /** Stop streaming. Subclasses must implement. */
  async stop()  { throw new Error('FeedInterface.stop() must be implemented'); }

  /** True if feed is actively connected. Subclasses should override. */
  isConnected() { return this._running; }

  // ── Snapshot (pull mode) ─────────────────────────────────────────────────

  /**
   * Fetch a full history snapshot for an instrument and push it into the aggregator.
   * Used by pull-mode providers (e.g. Yahoo Finance polling) where there is no
   * WebSocket stream. The scanner calls this on each scan tick.
   *
   * @param {string}   instrument  - 'MNQ' or 'MGC'
   * @param {object[]} bars1m      - array of 1m bars { timestamp, open, high, low, close, volume }
   */
  loadSnapshot(instrument, bars1m) {
    if (!this._aggs[instrument]) {
      this._aggs[instrument] = new BarAggregator(instrument, this.bus);
    }
    this._aggs[instrument].loadHistory(bars1m);
    const snap = this._aggs[instrument].snapshot();
    this.bus.publishReady(instrument, snap);
    return snap;
  }

  /**
   * Get the latest multi-TF snapshot without reloading.
   */
  getSnapshot(instrument) {
    return this._aggs[instrument]?.snapshot() ?? null;
  }

  // ── Called by subclasses when a new streaming bar arrives ────────────────

  /**
   * Handle a new 1m bar arriving from the feed.
   * @param {string} instrument
   * @param {object} bar  - { timestamp, open, high, low, close, volume }
   */
  onBar(instrument, bar) {
    if (!this._aggs[instrument]) {
      this._aggs[instrument] = new BarAggregator(instrument, this.bus);
    }
    this._aggs[instrument].addBar(bar);

    // After each 1m bar, publish the current snapshot so listeners can act
    const snap = this._aggs[instrument].snapshot();
    this.bus.publishReady(instrument, snap);
  }
}

module.exports = FeedInterface;
