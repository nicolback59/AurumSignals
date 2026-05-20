#!/bin/bash
# ── Aurum Signals — VPS Deploy Script ────────────────────────────────────────
# Usage: ./deploy.sh
# Pulls latest code, installs deps, restarts scanner via PM2

set -e  # exit on any error

DEPLOY_DIR="/opt/aurumsignals"
BRANCH="${BRANCH:-main}"

echo "=== Aurum Signals Deploy ==="
echo "Branch: $BRANCH"
echo "Dir: $DEPLOY_DIR"
echo "Time: $(date)"

cd "$DEPLOY_DIR"

# Pull latest code
echo ""
echo "--- Pulling latest code ---"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Install/update dependencies
echo ""
echo "--- Installing dependencies ---"
npm install --silent --omit=dev

# Ensure logs directory exists
mkdir -p logs

# Restart scanner via PM2
echo ""
echo "--- Restarting scanner ---"
if pm2 list | grep -q "aurum-scanner"; then
  pm2 restart aurum-scanner
else
  pm2 start ecosystem.config.js
  pm2 save
fi

echo ""
echo "=== Deploy complete ==="
pm2 status aurum-scanner
