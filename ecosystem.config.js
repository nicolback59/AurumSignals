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

    // ── 3. SCANNER STANDBY ────────────────────────────────────────────────────
    // Hot-standby scanner — stays silent while 'scanner-worker' is alive.
    // Polls the primary heartbeat every 30 s; auto-promotes if primary goes
    // silent for > 3 min. Registers as 'scanner-standby' in worker_health.
    // To enable: uncomment this block and set SCANNER_ROLE=standby below.
    // {
    //   name:    'scanner-standby',
    //   script:  'workers/scanner-worker.js',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   watch:   false,
    //   max_memory_restart: '350M',
    //   node_args: '--max-old-space-size=350',
    //
    //   env_production: {
    //     NODE_ENV:      'production',
    //     LOG_LEVEL:     'signal',
    //     SCANNER_ROLE:  'standby',
    //   },
    //   env_development: {
    //     NODE_ENV:  'development',
    //     LOG_LEVEL: 'full',
    //     SCANNER_ROLE: 'standby',
    //   },
    //
    //   restart_delay:             10000,
    //   max_restarts:              20,
    //   min_uptime:                '15s',
    //   exp_backoff_restart_delay: 200,
    //   log_date_format:           'YYYY-MM-DD HH:mm:ss Z',
    //   error_file:                '/root/AurumSignals/logs/scanner-standby-error.log',
    //   out_file:                  '/root/AurumSignals/logs/scanner-standby-out.log',
    //   merge_logs:                true,
    // },

    // ── 4. RECONCILIATION WORKER ──────────────────────────────────────────────
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

    // ── LOSS FORENSICS WORKER ─────────────────────────────────────────────────
    // Every 2h: classifies unclassified losses into failure_category buckets.
    // Posts systemic alerts to agent_messages when one category > 45% of losses.
    {
      name:         'loss-forensics',
      script:       'workers/loss-forensics-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */2 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/loss-forensics-error.log',
      out_file:        '/root/AurumSignals/logs/loss-forensics-out.log',
      merge_logs:      true,
    },

    // ── WIN FORENSICS WORKER ──────────────────────────────────────────────────
    // Every 4h: classifies wins into win_category archetypes.
    // Posts dominant pattern alerts to agent_messages.
    {
      name:         'win-forensics',
      script:       'workers/win-forensics-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */4 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/win-forensics-error.log',
      out_file:        '/root/AurumSignals/logs/win-forensics-out.log',
      merge_logs:      true,
    },

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

    // ── STRATEGY HEALTH WORKER ───────────────────────────────────────────────
    // Daily rolling metrics snapshot: WR, expectancy, PF, health score (0-100).
    // Sends ntfy if any strategy hits DEGRADED or CRITICAL.
    {
      name:         'strategy-health-worker',
      script:       'workers/strategy-health-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 5 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/strategy-health-worker-error.log',
      out_file:        '/root/AurumSignals/logs/strategy-health-worker-out.log',
      merge_logs:      true,
    },

    // ── CALIBRATION AUDIT WORKER ──────────────────────────────────────────────
    // Weekly: groups signals by confidence bucket, computes actual vs predicted WR.
    // Results written to calibration_audit table for the learning agent to consume.
    {
      name:         'calibration-audit-worker',
      script:       'workers/calibration-audit-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 6 * * 1',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/calibration-audit-worker-error.log',
      out_file:        '/root/AurumSignals/logs/calibration-audit-worker-out.log',
      merge_logs:      true,
    },

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

    // ── EDGE HEALTH WORKER ────────────────────────────────────────────────────
    // Every 2h: rolling WR decay detector across last 5/10/20 resolved trades.
    // Posts veto to agent_messages + ntfy alert on CRITICAL/COLLAPSE status.
    {
      name:         'edge-health',
      script:       'workers/edge-health-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */2 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/edge-health-error.log',
      out_file:        '/root/AurumSignals/logs/edge-health-out.log',
      merge_logs:      true,
    },

    // ── INTELLIGENCE REPORT WORKER ────────────────────────────────────────────
    // Weekly Monday 07:00 UTC: full intelligence digest across all phases.
    // Writes to reports table (report_type = INTELLIGENCE_WEEKLY), sends ntfy.
    {
      name:         'intelligence-report',
      script:       'workers/intelligence-report-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 7 * * 1',
      autorestart:  false,
      max_memory_restart: '200M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/intelligence-report-error.log',
      out_file:        '/root/AurumSignals/logs/intelligence-report-out.log',
      merge_logs:      true,
    },

    // ── SIGNAL GATE WORKER ───────────────────────────────────────────────────
    // Every 30 min: synthesizes Phase 1-4 intelligence into per-strategy gates.
    // Writes to signal_gates table + injects GATED pauses into adaptive overrides
    // so the scanner respects them on the next scan cycle.
    {
      name:         'signal-gate',
      script:       'workers/signal-gate-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '*/30 * * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/signal-gate-error.log',
      out_file:        '/root/AurumSignals/logs/signal-gate-out.log',
      merge_logs:      true,
    },

    // ── ENTRY AGENT ───────────────────────────────────────────────────────────
    // Daily 7:00 AM UTC: analyzes entry_type + cross-dimensional combos
    // (entry × session, entry × regime, time_in_session buckets).
    // Writes STRONG/MODERATE findings to entry_analysis + agent_messages.
    {
      name:         'entry-agent',
      script:       'workers/entry-agent-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 7 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/entry-agent-error.log',
      out_file:        '/root/AurumSignals/logs/entry-agent-out.log',
      merge_logs:      true,
    },

    // ── STOP LOSS AGENT ───────────────────────────────────────────────────────
    // Every 6h: analyzes stop distance vs MAE (maximum adverse excursion).
    // Detects when stops are too tight. Recommends optimal stop in ATR multiples.
    {
      name:         'stop-agent',
      script:       'workers/stop-agent-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */6 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/stop-agent-error.log',
      out_file:        '/root/AurumSignals/logs/stop-agent-out.log',
      merge_logs:      true,
    },

    // ── TAKE PROFIT AGENT ─────────────────────────────────────────────────────
    // Every 6h: analyzes TP hit rates using MFE vs TP distances.
    // Detects over/under-extended TP targets. Posts alerts to agent_messages.
    {
      name:         'tp-agent',
      script:       'workers/tp-agent-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */6 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/tp-agent-error.log',
      out_file:        '/root/AurumSignals/logs/tp-agent-out.log',
      merge_logs:      true,
    },

    // ── FREQUENCY AGENT ───────────────────────────────────────────────────────
    // Every 4h: analyzes signal_rejections to find valid setups being blocked.
    // Groups near-miss rejections by reason category, hour, and instrument.
    // Alerts when one filter reason is blocking > 60% of near-misses.
    {
      name:         'frequency-agent',
      script:       'workers/frequency-agent-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 */4 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/frequency-agent-error.log',
      out_file:        '/root/AurumSignals/logs/frequency-agent-out.log',
      merge_logs:      true,
    },

    // ── FEED WATCHDOG ─────────────────────────────────────────────────────────
    // Every 5 min: checks scanner heartbeat + bar data freshness.
    // Fires ntfy CRITICAL if scanner dies or feed goes stale during market hours.
    // Recovery alert sent when condition clears.
    {
      name:         'feed-watchdog',
      script:       'workers/feed-watchdog-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '*/5 * * * *',
      autorestart:  false,
      max_memory_restart: '100M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/feed-watchdog-error.log',
      out_file:        '/root/AurumSignals/logs/feed-watchdog-out.log',
      merge_logs:      true,
    },

    // ── DROPLET HEALTH MONITOR ────────────────────────────────────────────────
    // Every 5 min: CPU load, RAM %, disk %, SQLite WAL size.
    // Alerts via ntfy (+email fallback) at warning and critical thresholds.
    // Auto-checkpoints WAL if it exceeds 50 MB.
    // CPU >70%/90% | RAM >80%/90% | Disk >75%/85% | WAL >50 MB
    {
      name:         'droplet-health',
      script:       'workers/droplet-health-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '*/5 * * * *',
      autorestart:  false,
      max_memory_restart: '100M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/droplet-health-error.log',
      out_file:        '/root/AurumSignals/logs/droplet-health-out.log',
      merge_logs:      true,
    },

    // ── DAILY DIGEST ─────────────────────────────────────────────────────────
    // 11:30 UTC (7:30 AM EDT / 6:30 AM EST) — before market open every day.
    // Sends one ntfy push with overnight summary: scanner, signals, strategy
    // health, edge health, Droplet resources, overnight alerts, worker status.
    // Priority: min (silent notification — informational only, not an alert).
    {
      name:         'digest-worker',
      script:       'workers/digest-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '30 11 * * *',
      autorestart:  false,
      max_memory_restart: '100M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/digest-worker-error.log',
      out_file:        '/root/AurumSignals/logs/digest-worker-out.log',
      merge_logs:      true,
    },

    // ── TRADE DNA WORKER ──────────────────────────────────────────────────────
    // 04:30 UTC daily — 30 min after nightly backup. Full-refresh of trade_dna
    // materialized table (signals + outcomes + backtest_trades JOIN with
    // pre-computed mfe_sl_ratio, mae_sl_ratio, rr_achieved for ML/agents).
    {
      name:         'trade-dna-worker',
      script:       'workers/trade-dna-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '30 4 * * *',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/trade-dna-worker-error.log',
      out_file:        '/root/AurumSignals/logs/trade-dna-worker-out.log',
      merge_logs:      true,
    },

    // ── MFE/MAE DIAGNOSTIC WORKER ────────────────────────────────────────────
    // Monday 06:15 UTC — after trade-dna refresh (04:30) and backup (04:00).
    // Queries trade_dna for BE trigger potential, MAE stop health, MFE vs TP1
    // gap, regime WR breakdown, and confidence bucket P&L. Sends weekly ntfy
    // report with top actionable findings. Writes to mfe_diagnostic_log.
    {
      name:         'mfe-diagnostic-worker',
      script:       'workers/mfe-diagnostic-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '15 6 * * 1',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/mfe-diagnostic-worker-error.log',
      out_file:        '/root/AurumSignals/logs/mfe-diagnostic-worker-out.log',
      merge_logs:      true,
    },

    // ── EDGE AUDIT PART 4 — Multi-TP backtest ────────────────────────────────
    // Tuesday 06:30 UTC — after trade-dna refresh (04:30) and MFE diagnostic (Mon 06:15).
    // Simulates M1.5 and M2.0 split-exit models against trade_dna.
    // Recommends split exit when net P&L improvement >= 5% over single-exit baseline.
    // Writes to backtest_multi_tp table; sends consolidated ntfy summary.
    {
      name:         'multi-tp-backtest-worker',
      script:       'workers/multi-tp-backtest-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '30 6 * * 2',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/multi-tp-backtest-worker-error.log',
      out_file:        '/root/AurumSignals/logs/multi-tp-backtest-worker-out.log',
      merge_logs:      true,
    },

    // ── EDGE AUDIT PART 6 — Circuit breaker ──────────────────────────────────
    // Every 30 minutes. Detects loss clusters (3+ consecutive losses or ≥60%
    // loss rate in the last 4 hours with ≥5 trades) and auto-pauses strategies
    // via adaptive overrides. Lifts pause automatically after 2h cooldown once
    // conditions clear. Sends ntfy on every state change.
    {
      name:         'circuit-breaker-worker',
      script:       'workers/circuit-breaker-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '*/30 * * * *',
      autorestart:  false,
      max_memory_restart: '100M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/circuit-breaker-worker-error.log',
      out_file:        '/root/AurumSignals/logs/circuit-breaker-worker-out.log',
      merge_logs:      true,
    },

    // ── OUTCOME INTELLIGENCE WORKER ──────────────────────────────────────────
    // Friday 07:00 UTC — after trade-dna refresh. Runs 5 phases: MAE deep
    // analysis, expectancy decomposition, regime/session WR breakdown, and
    // edge discovery (regime×session cross-products, hour-of-day patterns).
    // Writes to outcome_intelligence_log; posts agent_messages for strong edges.
    {
      name:         'outcome-intelligence-worker',
      script:       'workers/outcome-intelligence-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '0 7 * * 5',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/outcome-intelligence-worker-error.log',
      out_file:        '/root/AurumSignals/logs/outcome-intelligence-worker-out.log',
      merge_logs:      true,
    },

    // ── STOP OPTIMIZER WORKER ─────────────────────────────────────────────────
    // Wednesday 06:30 UTC — Phase 5 Stop Intelligence. Computes p50/p75/p90
    // MAE percentiles for winners, derives optimal SL ATR ratio, detects
    // near-stop and recoverable losses. Writes to stop_intelligence_log.
    {
      name:         'stop-optimizer-worker',
      script:       'workers/stop-optimizer-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '30 6 * * 3',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/stop-optimizer-worker-error.log',
      out_file:        '/root/AurumSignals/logs/stop-optimizer-worker-out.log',
      merge_logs:      true,
    },

    // ── STRATEGY EVOLUTION WORKER ─────────────────────────────────────────────
    // Thursday 06:30 UTC — Phases 11-12 Strategy Evolution. Rolling WR
    // comparison (30d recent vs 31-90d prior) per archetype and regime.
    // Anti-overfitting: ≥15 recent + ≥5 prior trades required.
    // Posts DEGRADING/IMPROVING to agent_messages. Writes to strategy_evolution_log.
    {
      name:         'strategy-evolution-worker',
      script:       'workers/strategy-evolution-worker.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      cron_restart: '30 6 * * 4',
      autorestart:  false,
      max_memory_restart: '150M',

      env_production:  { NODE_ENV: 'production'  },
      env_development: { NODE_ENV: 'development' },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file:      '/root/AurumSignals/logs/strategy-evolution-worker-error.log',
      out_file:        '/root/AurumSignals/logs/strategy-evolution-worker-out.log',
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
