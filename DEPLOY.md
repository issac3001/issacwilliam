# Going live

The portal runs on one small Linux server in India, with HTTPS on your own domain. It needs no other services: the database is a single file on the server, and backups are encrypted copies of that file.

## What you need

| Item | Suggested | Approximate cost |
|---|---|---|
| Server | AWS Lightsail, Mumbai region, Ubuntu 24.04, 1 GB plan | about $7 a month, plus GST |
| or | DigitalOcean, Bangalore region, Ubuntu 24.04, 1 GB Basic droplet with weekly backups | about $7.20 a month, plus GST |
| Domain | for example `portal.assuraelevate.in` (a sub-domain of a domain you already own costs nothing extra) | about ₹800–1,200 a year for a new `.in` domain |
| HTTPS certificate | Let's Encrypt, issued and renewed automatically by Caddy | free |

A 1 GB server comfortably handles dozens of client companies with several years of monthly data each. Prices are the providers' published rates and can change; check them before buying.

## Steps

1. Create the server. On **AWS Lightsail** (the chosen option): Create instance → region **Mumbai (ap-south-1)** → Linux/Unix → OS only → **Ubuntu 24.04 LTS** → the **1 GB** plan → name it `assura-portal`. Then:
   - **Networking → Create static IP** and attach it to the instance, so the address never changes (free while attached).
   - **Networking → IPv4 firewall → Add rule → HTTPS (443)**. Lightsail opens only SSH and HTTP by default.
   - **Snapshots → Enable automatic snapshots** for a daily copy of the whole server (about $0.05 per GB a month).
2. At your domain provider, add an `A` record for the portal sub-domain pointing to that IP.
3. Connect to the server (Lightsail: the **Connect using SSH** button), type `sudo -i` to become root, and run:

   ```bash
   git clone https://github.com/issac3001/issacwilliam.git /tmp/ae
   bash /tmp/ae/deploy/setup.sh portal.yourdomain.in you@yourdomain.in "Your Name"
   ```

   The script installs Node.js 22 and Caddy, starts the portal as a service, turns on HTTPS, schedules a daily encrypted backup and creates the first **admin** login. It prints two things once: the backup key (keep it safe, away from the server) and your one-time password.
4. Open `https://portal.yourdomain.in`, sign in, choose your own password and set up two-step login with an authenticator app.
5. Under **Clients & users**, add the Assura team logins (each gets a one-time password), then each client company and its view-only client logins.
6. Select a client and upload its first monthly workbook under **Data & uploads**.

## Roles

| Role | Sees | Can change |
|---|---|---|
| Client (view only) | Its own company's dashboard and the detail behind every figure | Nothing except its own password |
| Assura team | Every client | Uploads, edits and restores data; adds clients and client logins |
| Assura admin | Every client | Everything the team can, plus Assura team logins |

Team and admin logins must use two-step login. Every sign-in, upload, edit and administrative action is recorded in the activity log.

## Updates and backups

- Update to the latest release: `bash /srv/assura/app/deploy/update.sh` (takes a backup first).
- Backups: `/srv/assura/backups`, one encrypted file a day, newest 30 kept. Copy them off the server as well (for example with the provider's snapshot feature).
- Restore a backup: `AE_BACKUP_KEY=... node tools/backup.js restore <file> restored.db`, stop the service, replace `/srv/assura/data/assura.db`, start it again.
