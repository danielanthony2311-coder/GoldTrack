#!/usr/bin/env bash
# Provision a fresh Debian VM to run GoldTrack 24/7.
# Run as root ON THE VM, after the repo + .env.local are in /opt/goldtrack.
set -euo pipefail

APP_DIR=/opt/goldtrack
APP_USER=goldtrack

echo "==> swap (insurance for npm ci on a 1GB e2-micro)"
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Node 22 LTS"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git

echo "==> app user + perms"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
touch /var/log/goldtrack.log && chown "$APP_USER":"$APP_USER" /var/log/goldtrack.log

echo "==> install deps (as $APP_USER)"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci
# Frontend is pre-built and shipped in dist/ (built locally to avoid an OOM
# build on the 1GB VM). Only build here if dist/ is somehow missing.
if [[ ! -d "$APP_DIR/dist" ]]; then
  echo "==> dist/ missing, building on VM (needs swap)"
  sudo -u "$APP_USER" npm run build
fi

echo "==> systemd service"
cp "$APP_DIR/deploy/goldtrack.service" /etc/systemd/system/goldtrack.service
systemctl daemon-reload
systemctl enable --now goldtrack.service
sleep 4
systemctl --no-pager status goldtrack.service | head -18
echo "==> done. logs: journalctl -u goldtrack -f  (or /var/log/goldtrack.log)"
