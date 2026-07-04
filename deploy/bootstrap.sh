#!/usr/bin/env bash
# Idempotent install/redeploy script for the Furiosa Discord bot.
# Safe to re-run: first run bootstraps the box, later runs redeploy new code.
set -euo pipefail

APP_USER="furiosa"
APP_DIR="/opt/furiosa"
REPO_URL="https://github.com/dmason1974/furiosa.git"
NODE_MAJOR="20"

if [ "$EUID" -ne 0 ]; then
  echo "Run this script as root (sudo bash bootstrap.sh)." >&2
  exit 1
fi

# --- Node ---
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" -lt "$NODE_MAJOR" ]; then
  echo "Installing Node ${NODE_MAJOR}.x via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "Node $(node --version) already present, skipping install."
fi

# --- App user ---
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  echo "Creating system user ${APP_USER}..."
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# --- Clone or pull ---
if [ -d "$APP_DIR/.git" ]; then
  echo "Pulling latest code in ${APP_DIR}..."
  git -C "$APP_DIR" pull --ff-only
else
  echo "Cloning repo into ${APP_DIR}..."
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- .env (never overwrite an existing one) ---
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "!!! Created ${APP_DIR}/.env from .env.example — fill in real secrets, then run:"
  echo "!!!   sudo systemctl restart furiosa"
fi

# --- Runtime data dir (gitignored, not created by git clone) ---
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"

# --- Dependencies ---
echo "Installing dependencies..."
sudo -u "$APP_USER" npm ci --omit=dev --prefix "$APP_DIR"

# --- systemd unit ---
cp "$APP_DIR/deploy/furiosa.service" /etc/systemd/system/furiosa.service
systemctl daemon-reload
systemctl enable furiosa

# --- (Re)start ---
systemctl restart furiosa
systemctl status furiosa --no-pager
