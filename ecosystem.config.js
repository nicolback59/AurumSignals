// PM2 Ecosystem — Aurum Signals Production
// Deploy:  pm2 start ecosystem.config.js --env production
// Reload:  pm2 reload ecosystem.config.js --env production
// Status:  pm2 status
// Logs:    pm2 logs [worker-name]

'use strict';

module.exports = {
  apps: [

    // ── 1. API SERVER ─────────────────────────────────────────────────────────
    // Express API + SSE. Scanner runs separately — reads state from worker_health.
    {
      name:    'api-server',
      script:  'server.js',
      instances: 1,
      exec_mode: 'fork',
      watch:   false,
      max_memory_restart: '400M',
      node_args: '--max-old-space-size=400',

      env_production: {
        NODE_ENV:      'production',
        PORT:          '3000',
        LOG_LEVEL:     'signal',
        SCANNER_MODE:  'worker',   // scanner runs as separate PM2 process
      },
      env_development: {
        NODE_ENV:      'development',
        PORT:          '3000',
        LOG_LEVEL:     'full',
        SCANNER_MODE:  'inline',   // inline mode for local dev (no worker needed)
      },

      restart_delay:             5000,
      max_restarts:              10,
      min_uptime:                '10s',
      exp_backoff_restart_delay: 100,
      log_date_format:           'YYYY-MM-DD HH:mm:ss Z',
      error_file:                '/root/AurumSignals/logs/api-server-error.log',
      out_file:                  '/root/AurumSignals/logs/api-server-out.log',
      merge_logs:                true,
    },

    // ── 2. SCANNER WORKER ─────────────────────────────────────────────────────
    // Live market scanner — isolated so a crash never takes down the API.
    // Writes state to worker_health, SSE events to sse_queue, bars to bar_cache.
    {
      name:    'scanner-worker',
      script:  'workers/scanner-worker.js',
      instances: 1,
      exec_mode: 'fork',
      watch:   false,
      max_memory_restart: '350M',
      node_args: '--max-old-space-size=350',

      env_production: {
        NODE_ENV:  'production',
        LOG_LEVEL: 'signal',
      },
      env_development: {
        NODE_ENV:  'development',
        LOG_LEVEL: 'full',
      },

      restart_delay:             10000,
      max_restarts:              20,   // scanner must be resilient — allow more restarts
      min_uptime:                '15s',
      exp_backoff_restart_delay: 200,
      log_date_format:           'YYYY-MM-DD HH:mm:ss Z',
      error_file:                '/root/AurumSignals/logs/scanner-worker-error.log',
      out_file:                  '/root/AurumSignals/logs/scanner-worker-out.log',
      merge_logs:                true,
    },

    // ── 3. RECONCILIATION WORKER ──────────────────────────────────────────────
    // Time-based trade lifecycle: sweep expired signals, fix stuck trades.
    // Runs on cron — starts a fresh process every 5 min, runs once, exits.
    // autorestart: false because cron handles scheduling.
    {
      name:         'reconcile-worker',
      script:       'workers/reconciliation-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '*/5 * * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production: { NODE_ENV: 'production' },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/reconcile-worker-error.log',
      out_file:        '/root/AurumSignals/logs/reconcile-worker-out.log',
      merge_logs:      true,
    },

    // ── 4–9. INTELLIGENCE WORKERS (Phase 2–4) ────────────────────────────────
    // Uncomment each when the corresponding worker script is implemented.

    {
      name:         'regime-agent',
      script:       'workers/regime-agent-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      max_memory_restart: '150M',
      restart_delay: 30000,
      max_restarts:  10,
      min_uptime:    '10s',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/regime-agent-error.log',
      out_file:        '/root/AurumSignals/logs/regime-agent-out.log',
      merge_logs:      true,
    },

    {
      name:         'learning-agent',
      script:       'workers/learning-agent.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */6 * * *',
      autorestart:  false,
      max_memory_restart: '200M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/learning-agent-error.log',
      out_file:        '/root/AurumSignals/logs/learning-agent-out.log',
      merge_logs:      true,
    },

    // {
    //   name:         'loss-forensics',
    //   script:       'workers/loss-forensics-worker.js',
    //   cron_restart: '0 */2 * * *',
    //   autorestart:  false,
    //   max_memory_restart: '150M',
    //   env_production: { NODE_ENV: 'production' },
    // },

    // {
    //   name:         'optimizer',
    //   script:       'workers/optimizer-worker.js',
    //   cron_restart: '0 2 * * 2-5',   // Tue–Fri 2 AM only — never during market hours
    //   autorestart:  false,
    //   max_memory_restart: '300M',
    //   env_production: { NODE_ENV: 'production' },
    // },

    // {
    //   name:         'report-worker',
    //   script:       'workers/report-worker.js',
    //   cron_restart: '0 9 * * 1',     // Monday 9 AM
    //   autorestart:  false,
    //   max_memory_restart: '150M',
    //   env_production: { NODE_ENV: 'production' },
    // },

  ],
};
