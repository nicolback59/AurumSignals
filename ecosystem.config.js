'use strict';

/**
 * PM2 Ecosystem Config — Aurum Signals VPS deployment
 *
 * Commands:
 *   pm2 start ecosystem.config.js       — start all processes
 *   pm2 restart aurum-scanner           — restart scanner
 *   pm2 logs aurum-scanner              — tail logs
 *   pm2 status                          — check all process health
 *   pm2 save                            — persist process list across reboots
 */

module.exports = {
  apps: [
    {
      name:             'aurum-scanner',
      script:           './workers/scanner-worker.js',
      instances:        1,
      autorestart:      true,
      watch:            false,
      max_memory_restart: '600M',
      restart_delay:    5000,      // wait 5s before restart on crash
      max_restarts:     10,        // stop restarting after 10 consecutive crashes
      min_uptime:       '10s',     // must be up 10s to count as successful start
      env: {
        NODE_ENV:       'production',
        SCANNER_LOG_LEVEL: 'signal',
      },
      error_file:   './logs/scanner-error.log',
      out_file:     './logs/scanner-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:   true,
    },
  ],
};
