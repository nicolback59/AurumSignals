#!/usr/bin/env bash
# setup-litestream.sh — one-time Litestream install on the Droplet
#
# Run as root: bash /root/AurumSignals/scripts/setup-litestream.sh
#
# What it does:
#   1. Downloads and installs the litestream binary
#   2. Creates /etc/litestream.env with credentials from .env
#   3. Creates a systemd service (litestream.service) that auto-starts on boot
#   4. Starts the replication service immediately
#
# Prerequisites: DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET, DO_SPACES_REGION
# must be set in /root/AurumSignals/.env (or exported in the calling shell).

set -euo pipefail

LITESTREAM_VERSION="0.3.13"
INSTALL_DIR="/usr/local/bin"
CONFIG_FILE="/root/AurumSignals/config/litestream.yml"
ENV_FILE="/etc/litestream.env"
DB_PATH="/root/AurumSignals/signals.db"

echo "==> Installing Litestream ${LITESTREAM_VERSION}"

# Load .env if not already in environment
if [ -f /root/AurumSignals/.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /root/AurumSignals/.env
  set +a
fi

# Validate required env vars
for var in DO_SPACES_KEY DO_SPACES_SECRET DO_SPACES_BUCKET DO_SPACES_REGION; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set. Add it to /root/AurumSignals/.env and re-run."
    exit 1
  fi
done

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  LS_ARCH="amd64" ;;
  aarch64) LS_ARCH="arm64" ;;
  *)
    echo "ERROR: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Download binary
DOWNLOAD_URL="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${LS_ARCH}.tar.gz"
echo "==> Downloading from ${DOWNLOAD_URL}"
TMP_DIR=$(mktemp -d)
curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/litestream.tar.gz"
tar -xzf "$TMP_DIR/litestream.tar.gz" -C "$TMP_DIR"
install -m 755 "$TMP_DIR/litestream" "$INSTALL_DIR/litestream"
rm -rf "$TMP_DIR"
echo "==> Installed: $(litestream version)"

# Expand bucket/region into the config file (create a resolved copy)
# litestream.yml uses ${} syntax — but litestream itself doesn't do env expansion.
# We write the resolved values directly into the service environment instead.
echo "==> Writing credentials to ${ENV_FILE}"
cat > "$ENV_FILE" <<EOF
LITESTREAM_ACCESS_KEY_ID=${DO_SPACES_KEY}
LITESTREAM_SECRET_ACCESS_KEY=${DO_SPACES_SECRET}
DO_SPACES_BUCKET=${DO_SPACES_BUCKET}
DO_SPACES_REGION=${DO_SPACES_REGION}
EOF
chmod 600 "$ENV_FILE"

# Write a resolved config (no shell vars — litestream doesn't expand them)
RESOLVED_CONFIG="/etc/litestream.yml"
echo "==> Writing resolved config to ${RESOLVED_CONFIG}"
cat > "$RESOLVED_CONFIG" <<EOF
dbs:
  - path: ${DB_PATH}
    replicas:
      - name: do-spaces
        type: s3
        bucket: ${DO_SPACES_BUCKET}
        path: aurum/signals.db
        endpoint: https://${DO_SPACES_REGION}.digitaloceanspaces.com
        region: ${DO_SPACES_REGION}
        force-path-style: true
        sync-interval: 1s
        retention: 24h
        retention-check-interval: 1h
        snapshot-interval: 6h
EOF
chmod 644 "$RESOLVED_CONFIG"

# Create systemd service
echo "==> Creating systemd service: litestream.service"
cat > /etc/systemd/system/litestream.service <<EOF
[Unit]
Description=Litestream SQLite replication
After=network.target
# Restart if the DB file is not yet present (e.g. on first boot before PM2 starts)
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/litestream replicate -config ${RESOLVED_CONFIG}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable litestream
systemctl restart litestream

echo ""
echo "==> Litestream is running!"
echo "    Status:   systemctl status litestream"
echo "    Logs:     journalctl -u litestream -f"
echo "    Replicas: litestream replicas -config ${RESOLVED_CONFIG}"
echo ""
echo "==> To restore from Spaces (e.g. after Droplet replacement):"
echo "    systemctl stop litestream"
echo "    litestream restore -config ${RESOLVED_CONFIG} -o ${DB_PATH}"
echo "    systemctl start litestream"
echo "    pm2 restart ecosystem.config.js"
