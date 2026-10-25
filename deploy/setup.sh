#!/usr/bin/env bash
# One-time setup of the Assura Elevate portal on a fresh Ubuntu 24.04 server.
# Usage (as root):  bash deploy/setup.sh portal.yourdomain.in admin@yourdomain.in "Admin Name" [yourdomain.in]
# The optional fourth argument also serves the public website (site/) on that domain and its www.
# Point each domain's A record at the server's IP before running, so HTTPS can be issued.
set -euo pipefail
DOMAIN="${1:?domain, e.g. portal.assuraelevate.in}"
ADMIN_EMAIL="${2:?first admin email}"
ADMIN_NAME="${3:?first admin name}"
SITE_DOMAIN="${4:-}"
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
chown -R assura:assura /srv/assura

install -m 644 /srv/assura/app/deploy/assura-elevate.service /etc/systemd/system/assura-elevate.service
sed "s/portal.example.com/$DOMAIN/" /srv/assura/app/deploy/Caddyfile > /etc/caddy/Caddyfile
if [ -n "$SITE_DOMAIN" ]; then sed "s/example.com/$SITE_DOMAIN/g" /srv/assura/app/deploy/Caddyfile.site >> /etc/caddy/Caddyfile; fi
systemctl daemon-reload
systemctl enable --now assura-elevate
systemctl reload caddy || systemctl restart caddy

# Daily encrypted backup at 02:15 server time.
cat > /etc/cron.d/assura-elevate-backup <<CRON
15 2 * * * assura cd /srv/assura/app && set -a && . /srv/assura/assura.env && set +a && /usr/bin/node --no-warnings tools/backup.js >> /srv/assura/backups/backup.log 2>&1
CRON

# First admin login. A one-time password is printed once.
if ! sudo -u assura bash -c "set -a; . /srv/assura/assura.env; cd /srv/assura/app; node --no-warnings tools/admin.js list" | grep -q "$ADMIN_EMAIL"; then
  sudo -u assura bash -c "set -a; . /srv/assura/assura.env; cd /srv/assura/app; node --no-warnings tools/admin.js add-user '$ADMIN_EMAIL' '$ADMIN_NAME' admin"
fi
if [ -n "$SITE_DOMAIN" ]; then echo "Website: https://$SITE_DOMAIN"; fi
echo "Done. Open https://$DOMAIN and sign in as $ADMIN_EMAIL with the one-time password above."
