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
const { runBacktest, runBacktest5m, runSwingBacktest1h, calcEnhancedMetrics } = require('../backtest-engine');

const { mode, bars, params, opts, swing1hBars, swingSlippage } = workerData;

try {
  let result;

  if (mode === 'backtest5m' || mode === 'research5m') {
    result = runBacktest5m(bars, params, opts);
  } else {
    // default: 'backtest' or 'research'
    result = runBacktest(bars, params, opts);
  }

  // Supplement with swing 1h backtest if bars provided (MNQ only, full backtest mode)
  if (mode === 'backtest' && swing1hBars && swing1hBars.length >= 60) {
    try {
      const swingResult = runSwingBacktest1h(swing1hBars, { slippage: swingSlippage });
      if (swingResult.signalLog.length > 0) {
        const merged = [...(result.signalLog ?? []), ...swingResult.signalLog];
        result.signalLog = merged;
        result.trades    = merged.map(r => r.outcome);
        result.metrics   = calcEnhancedMetrics(merged);
      }
    } catch { /* swing errors are non-fatal */ }
  }

  parentPort.postMessage({ success: true, result });
} catch (err) {
  parentPort.postMessage({ success: false, error: err.message ?? String(err) });
}
