'use strict';
/**
 * Worker thread for CPU-intensive backtest computation.
 * Handles all three backtest variants so the main event loop stays free.
 *
 * Input (workerData):
 *   mode          — 'backtest' | 'backtest5m' | 'research'
 *   bars          — bar array (1m for 'backtest', 5m for 'backtest5m'/'research')
 *   params        — strategy params object
 *   opts          — { instrument, targetTrades, slippage, walkForward }
 *   swing1hBars   — 1h bars for MNQ swing supplement (backtest mode only)
 *   swingSlippage — slippage for swing backtest
 *
 * Output:
 *   { success: true,  result }
 *   { success: false, error: '<message>' }
 */

const { workerData, parentPort } = require('worker_threads');
const { runBacktest, runBacktest5m } = require('../backtest-engine');

const { mode, bars, params, opts } = workerData;

try {
  let result;
  if (mode === 'backtest5m' || mode === 'research5m') {
    result = runBacktest5m(bars, params, opts);
  } else {
    result = runBacktest(bars, params, opts);
  }
  parentPort.postMessage({ success: true, result });
} catch (err) {
  parentPort.postMessage({ success: false, error: err.message ?? String(err) });
}
