#!/usr/bin/env bash
# Idempotent install/redeploy script for the Furiosa Discord bot.
# Safe to re-run: first run bootstraps the box, later runs redeploy new code.
set -euo pipefail

APP_USER="${APP_USER:-furiosa}"
APP_DIR="${APP_DIR:-/opt/furiosa}"
REPO_URL="${REPO_URL:-https://github.com/dmason1974/furiosa.git}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_NAME="${SERVICE_NAME:-furiosa}"

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
# Repo dir ends up owned by $APP_USER (chown below), but this script runs as
# root, so git's "dubious ownership" guard needs an explicit exemption.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
  || git config --global --add safe.directory "$APP_DIR"

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
  echo "!!!   sudo systemctl restart ${SERVICE_NAME}"
fi

# --- Dependencies ---
echo "Installing dependencies..."
sudo -u "$APP_USER" npm ci --omit=dev --prefix "$APP_DIR"

# --- systemd unit (render from template, don't just copy) ---
sed -e "s#{{APP_USER}}#$APP_USER#g" \
    -e "s#{{APP_DIR}}#$APP_DIR#g" \
    "$APP_DIR/deploy/furiosa.service.tmpl" \
    > "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# --- (Re)start ---
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager
