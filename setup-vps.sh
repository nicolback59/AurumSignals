#!/bin/bash
# ── Aurum Signals — VPS Initial Setup Script ─────────────────────────────────
# Run this ONCE on a fresh Ubuntu 24.04 droplet as root
# Usage: bash setup-vps.sh

set -e

echo "=== Aurum Signals VPS Setup ==="
echo "Time: $(date)"

# ── 1. System updates ─────────────────────────────────────────────────────────
echo ""
echo "--- System update ---"
apt-get update -qq
apt-get upgrade -y -qq

# ── 2. Install Node.js 20 ─────────────────────────────────────────────────────
echo ""
echo "--- Installing Node.js 20 ---"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "Node: $(node --version)"
echo "NPM:  $(npm --version)"

# ── 3. Install PM2 ───────────────────────────────────────────────────────────
echo ""
echo "--- Installing PM2 ---"
npm install -g pm2

# Set PM2 to auto-start on reboot
pm2 startup systemd -u root --hp /root
# Note: copy and run the command PM2 prints above

# ── 4. Install git ───────────────────────────────────────────────────────────
echo ""
echo "--- Installing git ---"
apt-get install -y git

# ── 5. Clone repository ──────────────────────────────────────────────────────
echo ""
echo "--- Cloning repository ---"
mkdir -p /opt/aurumsignals
git clone https://github.com/nicolback59/AurumSignals.git /opt/aurumsignals
cd /opt/aurumsignals
git checkout main

# ── 6. Install dependencies ──────────────────────────────────────────────────
echo ""
echo "--- Installing npm dependencies ---"
cd /opt/aurumsignals
npm install --omit=dev

# ── 7. Create logs directory ─────────────────────────────────────────────────
mkdir -p /opt/aurumsignals/logs

# ── 8. Create .env file ──────────────────────────────────────────────────────
echo ""
echo "--- Creating .env template ---"
cat > /opt/aurumsignals/.env << 'ENVEOF'
# Aurum Signals — Environment Variables
# Fill these in before starting the scanner

NODE_ENV=production

# Scanner settings
SCAN_INTERVAL=30
SCANNER_LOG_LEVEL=signal
DAILY_SIGNAL_CAP=20
SCANNER_DUPLICATE_GUARD_MIN=5

# Data feed symbols
SCANNER_SYMBOL=NQ=F
SCANNER_SYMBOL_MGC=GC=F

# Notifications (required for alerts)
NTFY_URL=https://ntfy.sh
NTFY_TOPIC=your-ntfy-topic-here
NTFY_TOKEN=

# Database
DB_PATH=/opt/aurumsignals/aurum.db

# Optional: Polygon.io (replaces Yahoo Finance for reliable data)
# POLYGON_API_KEY=your-polygon-key-here
ENVEOF

echo ""
echo "=== Setup complete ==="
echo ""
echo "NEXT STEPS:"
echo "1. Edit your environment variables: nano /opt/aurumsignals/.env"
echo "2. Add NTFY_TOPIC and any API keys"
echo "3. Start the scanner: cd /opt/aurumsignals && pm2 start ecosystem.config.js"
echo "4. Save PM2 process list: pm2 save"
echo "5. Watch logs: pm2 logs aurum-scanner"
echo ""
echo "Server IP: $(curl -s ifconfig.me 2>/dev/null || echo 'check DigitalOcean dashboard')"
