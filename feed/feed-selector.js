'use strict';

/**
 * FEED SELECTOR
 *
 * Returns the best available feed adapter based on configured credentials.
 * Priority:
 *   1. TradovateFeed — if TRADOVATE_USERNAME + TRADOVATE_CID + TRADOVATE_SECRET are set
 *   2. YahooFeed     — always available (no credentials required)
 *
 * Usage:
 *   const feed = createFeed({ instruments: ['MNQ','MGC'] });
 *   await feed.start();
 */

const TradovateFeed = require('./providers/tradovate');
const YahooFeed     = require('./providers/yahoo');

/**
 * @param {object} opts  - passed through to whichever feed is selected
 * @returns {FeedInterface}
 */
function createFeed(opts = {}) {
  const hasTradovate = !!(
    (opts.username  || process.env.TRADOVATE_USERNAME) &&
    (opts.cid       || process.env.TRADOVATE_CID) &&
    (opts.secret    || process.env.TRADOVATE_SECRET)
  );

  if (hasTradovate) {
    console.log('[feed-selector] Using TradovateFeed (real-time WebSocket)');
    return new TradovateFeed(opts);
  }

  console.log('[feed-selector] Using YahooFeed (pull-mode polling) — set TRADOVATE_* env vars for real-time data');
  return new YahooFeed({
    ...opts,
    symbolMap: opts.symbolMap || { MNQ: 'NQ=F', MGC: 'GC=F' },
  });
}

module.exports = { createFeed, TradovateFeed, YahooFeed };
