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

    {
      name:         'optimizer',
      script:       'workers/optimizer-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 14 * * 0-5',
      autorestart:  false,
      max_memory_restart: '300M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/optimizer-error.log',
      out_file:        '/root/AurumSignals/logs/optimizer-out.log',
      merge_logs:      true,
    },

    // ── NY OPEN PRE-OPEN ANALYSIS WORKER ──────────────────────────────────────
    // Runs at 9:20 ET Mon–Fri, calculates the day's LONG/SHORT thesis, logs to DB.
    // Provides an audit trail of pre-open analysis independent of the live signal.
    // Cron uses system timezone; set TZ=America/New_York on the Droplet, OR adjust
    // the cron offset to match UTC (13:20 UTC during EST, 12:20 UTC during EDT).
    {
      name:         'ny-open-worker',
      script:       'workers/ny-open-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '20 9 * * 1-5',
      autorestart:  false,
      max_memory_restart: '200M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/ny-open-worker-error.log',
      out_file:        '/root/AurumSignals/logs/ny-open-worker-out.log',
      merge_logs:      true,
    },

    // {
    //   name:         'report-worker',
    //   script:       'workers/report-worker.js',
    //   cron_restart: '0 9 * * 1',     // Monday 9 AM
    //   autorestart:  false,
    //   max_memory_restart: '150M',
    //   env_production: { NODE_ENV: 'production' },
    // },

    // ── FEATURE INTELLIGENCE WORKER ──────────────────────────────────────────
    // Daily 6:30 AM UTC: analyzes signal_features + outcomes to find which
    // indicator dimensions (regime/session/archetype/HTF/RSI) have significant
    // WR delta vs baseline. Writes to feature_correlations + agent_messages.
    {
      name:         'feature-intelligence',
      script:       'workers/feature-intelligence-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '30 6 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/feature-intelligence-error.log',
      out_file:        '/root/AurumSignals/logs/feature-intelligence-out.log',
      merge_logs:      true,
    },

    // ── CONSENSUS COORDINATOR ─────────────────────────────────────────────────
    // Every 4h: reads pending agent_messages, computes trust-weighted consensus,
    // logs actionable recommendations to intervention_log. Also evaluates past
    // interventions (14d lookback) and updates agent trust scores.
    {
      name:         'consensus-coordinator',
      script:       'workers/consensus-coordinator.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */4 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/consensus-coordinator-error.log',
      out_file:        '/root/AurumSignals/logs/consensus-coordinator-out.log',
      merge_logs:      true,
    },

    // ── NIGHTLY DB BACKUP ─────────────────────────────────────────────────────
    // Runs at 04:00 UTC (midnight ET) every day. Keeps last 7 daily snapshots.
    // Uses better-sqlite3 hot-backup API — safe under concurrent writes (WAL mode).
    // Backup destination: /root/AurumSignals/backups/signals-YYYY-MM-DD.db
    // Override destination with BACKUP_DIR env var.
    {
      name:         'backup-worker',
      script:       'workers/backup-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 4 * * *',
      autorestart:  false,
      max_memory_restart: '200M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/backup-worker-error.log',
      out_file:        '/root/AurumSignals/logs/backup-worker-out.log',
      merge_logs:      true,
    },

  ],
};
