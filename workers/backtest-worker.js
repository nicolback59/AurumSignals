'use strict';
/**
 * Worker thread for CPU-intensive backtest computation.
 * Runs runBacktest (and optionally runSwingBacktest1h) on a separate OS thread
 * so the main event loop stays free for HTTP health checks and SSE clients.
 *
 * Input (workerData):
 *   bars1m        — array of 1-min bars
 *   params        — strategy params object
 *   opts          — { instrument, targetTrades, slippage, walkForward }
 *   swing1hBars   — array of 1h bars for MNQ swing supplement (may be empty)
 *   swingSlippage — slippage for swing backtest
 *
 * Output (parentPort message):
 *   { success: true,  result: { metrics, signalLog, trades, walkForward, slippageUsed, cooldownUsed } }
 *   { success: false, error: '<message>' }
 */

const { workerData, parentPort } = require('worker_threads');
const { runBacktest, runSwingBacktest1h, calcEnhancedMetrics } = require('../backtest-engine');

const { bars1m, params, opts, swing1hBars, swingSlippage } = workerData;

try {
  const result = runBacktest(bars1m, params, opts);

  // Supplement with swing 1h backtest if bars provided (MNQ only)
  if (swing1hBars && swing1hBars.length >= 60) {
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
