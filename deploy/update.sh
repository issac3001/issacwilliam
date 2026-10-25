#!/usr/bin/env bash
# Install the latest approved release. Run as root on the server: bash /srv/assura/app/deploy/update.sh
# 1. Takes a checked backup first, and stops if it fails.
# 2. Pulls the new code and restarts the portal.
# 3. If the portal does not answer within 30 seconds, goes back to the previous code and says so.
# Client data is never changed by an update; it stays in /srv/assura/data.
set -euo pipefail
cd /srv/assura/app
rc=0; sudo -u assura bash -c 'set -a; . /srv/assura/assura.env; set +a; node --no-warnings tools/backup.js' || rc=$?
if [ "$rc" = 1 ]; then echo "No good backup could be made, so nothing was updated." >&2; exit 1; fi
if [ "$rc" = 2 ]; then echo "Warning: the backup is on the server but was not copied off it. Continuing." >&2; fi
PREV="$(git rev-parse HEAD)"
sudo -u assura git pull --ff-only
install -m 644 deploy/assura-backup.cron /etc/cron.d/assura-elevate-backup
systemctl restart assura-elevate
PORT="$(grep -E '^PORT=' /srv/assura/assura.env | cut -d= -f2)"; PORT="${PORT:-3000}"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then echo "Updated to $(git log -1 --format='%h %s')"; exit 0; fi
  sleep 1
done
echo "The new release did not start. Going back to the previous one." >&2
sudo -u assura git reset --hard "$PREV"
systemctl restart assura-elevate
journalctl -u assura-elevate -n 30 --no-pager >&2 || true
exit 1
