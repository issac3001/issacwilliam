#!/usr/bin/env bash
# Pull the latest release and restart. Run as root on the server: bash /srv/assura/app/deploy/update.sh
set -euo pipefail
cd /srv/assura/app
sudo -u assura bash -c 'set -a; . /srv/assura/assura.env; set +a; node --no-warnings tools/backup.js'
sudo -u assura git pull --ff-only
systemctl restart assura-elevate
echo "Updated to $(git log -1 --format='%h %s')"
