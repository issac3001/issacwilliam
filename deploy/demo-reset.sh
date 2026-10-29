#!/usr/bin/env bash
# Puts the demo back to its starting state: one fictional client (Meridian Polymers, Demo) and the
# logins demo.client and demo.staff (password demo-password). Run nightly by /etc/cron.d/assura-elevate-demo.
# Touches only /srv/assura/demo; the live portal's data is never involved.
set -euo pipefail
systemctl stop assura-demo
rm -f /srv/assura/demo/demo.db /srv/assura/demo/demo.db-wal /srv/assura/demo/demo.db-shm
sudo -u assura bash -c 'set -a; . /srv/assura/demo.env; set +a; cd /srv/assura/app; node --no-warnings tools/seed_demo.js'
systemctl start assura-demo
