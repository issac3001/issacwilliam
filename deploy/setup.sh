#!/usr/bin/env bash
# One-time setup of Assura Elevate on a fresh Ubuntu 24.04 server: the website, the client portal and
# the team workspace, all on one domain (website at /, clients at /client, team at /team).
# Usage (as root):
#   bash deploy/setup.sh elevateassura.com issac@elevateassura.com "Issac William" issac
# The fourth argument is the first admin's user ID. Optional settings, given before the command:
#   DEMO_DOMAIN=demo.elevateassura.com   also runs the demo (fictional data, reset nightly) there
#   REDIRECT_DOMAINS=portal.elevateassura.com   earlier addresses that should forward to the domain
#   AUTO_UPDATE=1                        installs each release by itself once it is merged into main
# Point each domain's A record (and www) at the server's IP before running, so HTTPS can be issued.
# Safe to run again: it keeps the data, the backup key and existing logins.
set -euo pipefail
DOMAIN="${1:?domain, e.g. elevateassura.com}"
ADMIN_EMAIL="${2:?first admin email}"
ADMIN_NAME="${3:?first admin name}"
ADMIN_ID="${4:-${ADMIN_EMAIL%%@*}}"
DEMO_DOMAIN="${DEMO_DOMAIN:-}"
REDIRECT_DOMAINS="${REDIRECT_DOMAINS:-}"
REPO="${REPO:-https://github.com/issac3001/issacwilliam.git}"
BRANCH="${BRANCH:-main}"

apt-get update
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22 (the portal uses Node's built-in SQLite).
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy web server (HTTPS).
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

id assura >/dev/null 2>&1 || useradd --system --home /srv/assura --shell /usr/sbin/nologin assura
mkdir -p /srv/assura/data /srv/assura/backups
if [ ! -d /srv/assura/app/.git ]; then git clone --branch "$BRANCH" "$REPO" /srv/assura/app; fi
# The app folder belongs to the assura user; let root's update scripts read it too.
git config --system --get-all safe.directory | grep -qx /srv/assura/app || git config --system --add safe.directory /srv/assura/app

if [ ! -f /srv/assura/assura.env ]; then
  BACKUP_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
  cat > /srv/assura/assura.env <<ENV
PORT=3000
HOST=127.0.0.1
AE_DB=/srv/assura/data/assura.db
AE_BACKUP_DIR=/srv/assura/backups
AE_BACKUP_KEY=$BACKUP_KEY
AE_SECURE_COOKIE=1
ENV
  chmod 600 /srv/assura/assura.env
  echo
  echo "Backup key (store it somewhere safe, away from this server): $BACKUP_KEY"
  echo
fi
# The domains live in assura.env, so updates can rebuild the web server settings (deploy/caddy.sh).
setenv() { grep -v "^$1=" /srv/assura/assura.env > /srv/assura/assura.env.new || true; echo "$1=$2" >> /srv/assura/assura.env.new; mv /srv/assura/assura.env.new /srv/assura/assura.env; chmod 600 /srv/assura/assura.env; }
setenv AE_DOMAIN "$DOMAIN"
setenv AE_DEMO_DOMAIN "$DEMO_DOMAIN"
setenv AE_REDIRECT_DOMAINS "\"$REDIRECT_DOMAINS\""
chown -R assura:assura /srv/assura

install -m 644 /srv/assura/app/deploy/assura-elevate.service /etc/systemd/system/assura-elevate.service
systemctl daemon-reload
systemctl enable --now assura-elevate

# The demo: its own server process and database, with fictional data only.
if [ -n "$DEMO_DOMAIN" ]; then
  mkdir -p /srv/assura/demo
  printf 'PORT=3001\nHOST=127.0.0.1\nAE_DB=/srv/assura/demo/demo.db\nAE_DEMO=1\nAE_SECURE_COOKIE=1\n' > /srv/assura/demo.env
  chown -R assura:assura /srv/assura/demo /srv/assura/demo.env
  install -m 644 /srv/assura/app/deploy/assura-demo.service /etc/systemd/system/assura-demo.service
  systemctl daemon-reload
  systemctl enable assura-demo
  bash /srv/assura/app/deploy/demo-reset.sh
  echo "30 0 * * * root bash /srv/assura/app/deploy/demo-reset.sh >> /srv/assura/demo/reset.log 2>&1" > /etc/cron.d/assura-elevate-demo
fi

bash /srv/assura/app/deploy/caddy.sh

if [ "${AUTO_UPDATE:-}" = 1 ]; then
  echo "*/10 * * * * root bash /srv/assura/app/deploy/auto-update.sh >> /srv/assura/backups/update.log 2>&1" > /etc/cron.d/assura-elevate-update
fi

# Hourly encrypted backup, checked each time (see tools/backup.js).
install -m 644 /srv/assura/app/deploy/assura-backup.cron /etc/cron.d/assura-elevate-backup

# First admin login, signing in with user ID $ADMIN_ID. A one-time password is printed once.
run_admin() { sudo -u assura bash -c "set -a; . /srv/assura/assura.env; cd /srv/assura/app; node --no-warnings tools/admin.js $*"; }
if ! run_admin list | grep -q "$ADMIN_EMAIL"; then
  run_admin add-user "'$ADMIN_EMAIL'" "'$ADMIN_NAME'" admin --id "'$ADMIN_ID'"
else
  run_admin set-id "'$ADMIN_EMAIL'" "'$ADMIN_ID'"
fi
echo "Done."
echo "  Website:        https://$DOMAIN"
echo "  Client sign-in: https://$DOMAIN/client"
echo "  Team sign-in:   https://$DOMAIN/team   (user ID: $ADMIN_ID, with the one-time password above)"
if [ -n "$DEMO_DOMAIN" ]; then echo "  Demo:           https://$DEMO_DOMAIN   (demo.client / demo.staff, password demo-password)"; fi
