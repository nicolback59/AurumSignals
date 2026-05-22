// PM2 Ecosystem — Aurum Signals Production
// Deploy: pm2 start ecosystem.config.js --env production
// Reload:  pm2 reload ecosystem.config.js --env production
// Status:  pm2 status
// Logs:    pm2 logs

'use strict';

module.exports = {
  apps: [
    // ── Primary process: API server + live scanner (combined) ─────────────────
    // Single process for now — SQLite WAL handles concurrent reads from the
    // reconciliation worker. Split scanner out when traffic warrants it.
    {
      name:           'aurum-api',
      script:         'server.js',
      instances:      1,
      exec_mode:      'fork',
      watch:          false,
      max_memory_restart: '400M',
      node_args:      '--max-old-space-size=400 --expose-gc',

      env_production: {
        NODE_ENV:    'production',
        PORT:        '3000',
        LOG_LEVEL:   'signal',
      },
      env_development: {
        NODE_ENV:    'development',
        PORT:        '3000',
        LOG_LEVEL:   'full',
      },

      // Restart policy
      restart_delay:  5000,   // wait 5 s before restart
      max_restarts:   10,     // give up after 10 rapid crashes
      min_uptime:     '10s',  // must stay up 10s to count as "started"
      exp_backoff_restart_delay: 100,

      // Log rotation (requires pm2-logrotate module)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/aurum-api-error.log',
      out_file:        '/root/AurumSignals/logs/aurum-api-out.log',
      merge_logs:      true,
    },

    // ── Reconciliation worker ─────────────────────────────────────────────────
    // Runs the trade expiry sweep every 5 minutes independently.
    // If this crashes, the API server keeps running.
    // NOTE: Currently the sweep runs inside server.js — this is a placeholder
    //       for when the sweep is extracted into its own process.
    // {
    //   name:    'aurum-reconcile',
    //   script:  'workers/reconciliation-worker.js',
    //   cron_restart: '*/5 * * * *',
    //   autorestart: false,
    //   watch: false,
    //   env_production: { NODE_ENV: 'production' },
    // },

    // ── Research / backtest worker ────────────────────────────────────────────
    // CPU-intensive backtests run in a separate process so they never block
    // the API or scanner. Triggered by POST /api/backtest/run.
    // Currently uses worker_threads inside server.js — uncomment to extract.
    // {
    //   name:    'aurum-research',
    //   script:  'workers/research-worker.js',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   autorestart: true,
    //   watch: false,
    //   max_memory_restart: '300M',
    //   env_production: { NODE_ENV: 'production' },
    // },
  ],
};
