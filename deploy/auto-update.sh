#!/usr/bin/env bash
# Installs a new release by itself once it is merged into main: checks every 10 minutes
# (/etc/cron.d/assura-elevate-update) and runs update.sh, which backs up first and rolls back if the
# new release does not start. Turned on by setup.sh with AUTO_UPDATE=1.
set -euo pipefail
cd /srv/assura/app
sudo -u assura git fetch --quiet origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
  echo "$(date -Is) new release on $BRANCH: $(git log -1 --format='%h %s' "origin/$BRANCH")"
  bash deploy/update.sh
fi
