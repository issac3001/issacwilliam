#!/usr/bin/env bash
# Writes /etc/caddy/Caddyfile from the domains in /srv/assura/assura.env and reloads Caddy.
# Run by setup.sh and update.sh, so a change to the files in deploy/ goes live with the next update.
set -euo pipefail
set -a; . /srv/assura/assura.env; set +a
: "${AE_DOMAIN:?AE_DOMAIN is not set in /srv/assura/assura.env}"
D=/srv/assura/app/deploy
{
  sed "s/example\.com/$AE_DOMAIN/g" "$D/Caddyfile"
  if [ -n "${AE_DEMO_DOMAIN:-}" ]; then echo; sed "s/demo\.example\.com/$AE_DEMO_DOMAIN/g" "$D/Caddyfile.demo"; fi
  for old in ${AE_REDIRECT_DOMAINS:-}; do echo; sed "s/old\.example\.com/$old/; s/example\.com/$AE_DOMAIN/" "$D/Caddyfile.redirect"; done
} > /etc/caddy/Caddyfile.new
caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
