#!/usr/bin/env bash
# =============================================================================
# Aurum Signals — One-time monitoring setup
# Run once on the Droplet after initial deploy:
#   bash /root/AurumSignals/scripts/setup-monitoring.sh
#
# What this does:
#   1. Installs pm2-logrotate (prevents disk exhaustion from PM2 logs)
#   2. Installs Uptime Kuma (external HTTP uptime monitor on port 3001)
#
# After running, visit http://<droplet-ip>:3001 to configure Uptime Kuma.
# =============================================================================

set -euo pipefail

DROPLET_IP="${1:-$(hostname -I | awk '{print $1}')}"
APP_DIR="/root/AurumSignals"
KUMA_DIR="/root/uptime-kuma"

echo ""
echo "=========================================="
echo "  Aurum Signals — Monitoring Setup"
echo "=========================================="
echo ""

# ── PART 1: PM2 log rotation ──────────────────────────────────────────────────
echo ">>> Installing pm2-logrotate..."
pm2 install pm2-logrotate

echo ">>> Configuring log rotation..."
# Rotate when log file hits 20 MB
pm2 set pm2-logrotate:max_size 20M
# Keep 7 rotated files per process
pm2 set pm2-logrotate:retain 7
# No compression (keep logs readable without gunzip)
pm2 set pm2-logrotate:compress false
# Rotate daily at midnight UTC
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
# Use date-based filenames for rotated files
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:workerInterval 30
pm2 set pm2-logrotate:rotateModule true

echo "    ✓ Log rotation configured (20 MB max, 7 files retained, daily)"
echo ""

# ── PART 2: Uptime Kuma ───────────────────────────────────────────────────────
echo ">>> Installing Uptime Kuma..."

if command -v docker &>/dev/null; then
  echo "    Docker detected — using Docker installation"
  docker pull louislam/uptime-kuma:1

  # Stop + remove existing container if present
  docker rm -f uptime-kuma 2>/dev/null || true

  docker run -d \
    --name uptime-kuma \
    --restart unless-stopped \
    -p 3001:3001 \
    -v uptime-kuma:/app/data \
    louislam/uptime-kuma:1

  echo "    ✓ Uptime Kuma running via Docker on port 3001"

else
  echo "    Docker not found — using PM2 + git installation"

  # Install Node 18+ is required; check version
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$NODE_VER" -lt 18 ]; then
    echo "    ERROR: Node.js 18+ required for Uptime Kuma. Current: $(node -v)"
    exit 1
  fi

  if [ -d "$KUMA_DIR" ]; then
    echo "    Found existing install at $KUMA_DIR — pulling latest..."
    git -C "$KUMA_DIR" pull origin master
  else
    git clone https://github.com/louislam/uptime-kuma.git "$KUMA_DIR"
  fi

  cd "$KUMA_DIR"
  npm install --omit=dev
  npm run build 2>/dev/null || true  # build step optional for older versions

  # Register in PM2 if not already present
  if ! pm2 list | grep -q "uptime-kuma"; then
    pm2 start server/server.js \
      --name uptime-kuma \
      --node-args "--max-old-space-size=200" \
      --max-memory-restart 250M \
      -- --port 3001
    pm2 save
  else
    pm2 reload uptime-kuma
  fi

  cd "$APP_DIR"
  echo "    ✓ Uptime Kuma running via PM2 on port 3001"
fi

# ── Print next steps ──────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Setup complete. Next steps:"
echo "=========================================="
echo ""
echo "1. Open Uptime Kuma in your browser:"
echo "   http://${DROPLET_IP}:3001"
echo ""
echo "2. Create an admin account on first visit."
echo ""
echo "3. Add the following monitors:"
echo ""
echo "   ┌─────────────────────────────────────────────────────┐"
echo "   │ Monitor 1: API Health                               │"
echo "   │   Type:     HTTP(s) — Keyword                       │"
echo "   │   URL:      http://localhost:3000/api/health        │"
echo "   │   Keyword:  \"healthy\"                               │"
echo "   │   Interval: 60 seconds                              │"
echo "   │   Name:     Aurum API Health                        │"
echo "   └─────────────────────────────────────────────────────┘"
echo ""
echo "   ┌─────────────────────────────────────────────────────┐"
echo "   │ Monitor 2: API Reachability (basic HTTP)            │"
echo "   │   Type:     HTTP(s)                                 │"
echo "   │   URL:      http://localhost:3000/api/health        │"
echo "   │   Expected: Status code 200                         │"
echo "   │   Interval: 60 seconds                              │"
echo "   │   Name:     Aurum API Up                            │"
echo "   └─────────────────────────────────────────────────────┘"
echo ""
echo "4. Configure notifications in Uptime Kuma:"
echo "   Settings → Notifications → Add Notification"
echo "   Type: ntfy"
echo "   Topic: (your NTFY_TOPIC value from .env)"
echo "   Server: (your NTFY_URL value from .env)"
echo ""
echo "5. To expose Uptime Kuma externally (optional):"
echo "   nginx proxy_pass to http://localhost:3001 on a subdomain"
echo "   OR keep it internal — SSH tunnel to view: ssh -L 3001:localhost:3001 root@<droplet>"
echo ""
echo "6. Remember to open port 3001 in DigitalOcean firewall if accessing directly:"
echo "   DigitalOcean → Networking → Firewalls → Add inbound rule: TCP 3001"
echo ""
