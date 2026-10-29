# Going live

Everything runs on one small Linux server in India, with HTTPS on one address:

| Address | What it is |
|---|---|
| `https://elevateassura.com` | The public website (with `www.` forwarding to it) |
| `https://elevateassura.com/client` | Client sign-in: user ID or email, and password. Opens the client's own company dashboard. |
| `https://elevateassura.com/team` | Team sign-in: user ID and password. Opens that person's own workspace page for their seat (Managing Partner, Branch Head, Head, Manager, Supervisor, Associate, Analyst, Accounts). |
| `https://demo.elevateassura.com` (optional) | The demo: one fictional client and two logins, `demo.client` and `demo.staff` (password `demo-password`), reset every night. A separate program and database; it never sees real data. |

The portal needs no other services It needs no other services: the database is a single file on the server, and backups are encrypted copies of that file.

## What you need

| Item | Suggested | Approximate cost |
|---|---|---|
| Server | AWS Lightsail, Mumbai region, Ubuntu 24.04, **2 GB plan** (chosen for up to 300 people at once) | about $12 a month, plus GST |
| Backup copy away from the server | Amazon S3 bucket, Mumbai region (see Backups) | a few rupees a month for about 1 GB |
| Domain | `elevateassura.com` (the demo uses the sub-domain `demo.`, at no extra cost) | about ₹800–1,200 a year |
| HTTPS certificate | Let's Encrypt, issued and renewed automatically by Caddy | free |

A 1 GB server comfortably handles dozens of client companies with several years of monthly data each. For 150 clients and up to 300 people signed in at once, use the **2 GB** plan (about $12 a month): see “How many people it handles” below. A Lightsail server can be moved to a bigger plan later from a snapshot, without losing data. Prices are the providers' published rates and can change; check them before buying.

## Steps

1. Create the server. On **AWS Lightsail** (the chosen option): Create instance → region **Mumbai (ap-south-1)** → Linux/Unix → OS only → **Ubuntu 24.04 LTS** → the **2 GB** plan → name it `assura-portal`. Then:
   - **Networking → Create static IP** and attach it to the instance, so the address never changes (free while attached).
   - **Networking → IPv4 firewall → Add rule → HTTPS (443)**. Lightsail opens only SSH and HTTP by default.
   - **Snapshots → Enable automatic snapshots** for a daily copy of the whole server (about $0.05 per GB a month).
2. At your domain provider, add `A` records pointing to that IP for: `@` (the bare domain), `www`, and `demo` if you want the demo. Wait until they resolve (usually minutes, at most a few hours).
3. Connect to the server (Lightsail: the **Connect using SSH** button), type `sudo -i` to become root, and run:

   ```bash
   git clone https://github.com/issac3001/issacwilliam.git /tmp/ae
   AUTO_UPDATE=1 DEMO_DOMAIN=demo.elevateassura.com bash /tmp/ae/deploy/setup.sh elevateassura.com issac@elevateassura.com "Issac William" issac
   ```

   The last word (`issac`) is your user ID for the team sign-in. Leave out `DEMO_DOMAIN=…` to skip the demo. `AUTO_UPDATE=1` makes the server install each approved change by itself (see Updates). If the portal was set up earlier on `portal.elevateassura.com`, add `REDIRECT_DOMAINS=portal.elevateassura.com` before `bash` so old links forward to the new address. Running the script again is safe: data, logins and the backup key are kept.

   The script installs Node.js 22 and Caddy, starts the portal (and the demo) as services, turns on HTTPS, schedules an hourly encrypted backup and creates the first **admin** login. It prints two things once: the backup key (keep it safe, away from the server) and your one-time password.
4. Open `https://elevateassura.com/team`, sign in with your user ID and the one-time password, and choose your own password.
5. Under **Clients & users**, add each team member's login with a **user ID** (for example `rishad.k`); each gets a one-time password to share privately. Then place each person under **Firm structure** in the workspace (branch, department, level, who they report to). Their seat decides the page they land on.
6. Add each client company and its client logins, then upload its first monthly workbook under **Data & uploads**.

## Roles

| Role | Sees | Can change |
|---|---|---|
| Client (view only) | Its own company's dashboard and the detail behind every figure | Nothing except its own password |
| Assura team | Every client | Uploads, edits and restores data; adds clients and client logins |
| Assura admin | Every client | Everything the team can, plus Assura team logins |

Team members sign in with user ID and password only. For a stricter set-up, add `AE_REQUIRE_STAFF_2FA=1` to `/srv/assura/assura.env` and restart: every team login then also needs a code from an authenticator app. Every sign-in, upload, edit and administrative action is recorded in the activity log.

## Sending the monthly workbook by email

The portal emails each client's monthly workbook from your own mailbox, so replies with the completed workbook come back to the team member who sent it. Until this is set up, the **Email the workbook** button stays off and the team uses **Download a filled copy** instead. Each download still gets its own reference and is recorded.

1. Create or choose the mailbox the workbooks go out from, for example `data@elevateassura.com`, and get its SMTP login:
   - **Google Workspace**: host `smtp.gmail.com`, port `465`, the mailbox address, and an *app password* (Google Account → Security → 2-Step Verification → App passwords).
   - **Microsoft 365**: host `smtp.office365.com`, port `587`, the mailbox address and its password (SMTP AUTH must be allowed for that mailbox).
   - **Zoho Mail (India)**: host `smtp.zoho.in`, port `465`, the mailbox address and an app-specific password.
   - **Amazon SES, Mumbai**: host `email-smtp.ap-south-1.amazonaws.com`, port `587`, and the SMTP credentials created in the SES console (verify the domain first).
2. On the server, add these lines to `/srv/assura/assura.env`:

   ```
   AE_SMTP_HOST=smtp.zoho.in
   AE_SMTP_PORT=465
   AE_SMTP_USER=data@elevateassura.com
   AE_SMTP_PASS=the-app-password
   AE_MAIL_FROM=Assura Elevate <data@elevateassura.com>
   ```
3. Restart the portal: `systemctl restart assura-elevate`. The **Email the workbook** button is now available.
4. Save each client's accounts email under **Clients & users**. The workbook is only ever sent to that saved address.

## Updates

How a change reaches the live site:

1. **Ask for it.** Describe the change in the Assura Elevate project (for example "add a TDS ageing chart to the client dashboard"). The work is done on a separate branch with tests, and a pull request is opened on GitHub, so nothing live changes yet.
2. **Review it.** Look at the pull request (and any preview shared with it). Ask for changes the same way until it is right.
3. **Approve it.** Merge the pull request into `main` on GitHub. That is the only step that sends a change to the live site, so only people with write access to the repository can do it.
4. **It goes live.** With `AUTO_UPDATE=1`, the server notices the new release within 10 minutes and installs it with `update.sh` (backup first, automatic roll-back if it does not start). Without it, run `bash /srv/assura/app/deploy/update.sh` on the server yourself. The log is in `/srv/assura/backups/update.log`.

To undo a change, revert its pull request on GitHub (the **Revert** button) and merge the revert; it goes live the same way.

- Install the latest approved release: `bash /srv/assura/app/deploy/update.sh`. It takes a checked backup first and stops if that fails. If the new release does not start within 30 seconds, it goes back to the previous one by itself.
- Updates change the program only. Client data, logins and uploads stay in `/srv/assura/data` and are not touched.

## Backups

Everything the portal and Workflow keep is in one database file, so each backup is one encrypted copy of it.

- **Every hour**, at five past, `tools/backup.js` takes a copy while the portal keeps running, encrypts it with the backup key, then decrypts it again and checks the database inside is whole before it counts. The result is shown to admins under **Clients & users → Backups**, and logged in `/srv/assura/backups/backup.log`.
- **What is kept** (in `/srv/assura/backups`): every backup from the last 24 hours, the last one of each day for 30 days, and the last one of each month for a year. That is at most about 66 files. Each is the compressed size of the database: about 10–20 MB for 150 clients with a year of data, so roughly 1 GB in all after a year.
- **Before every update** a backup is taken and checked as well.
- Uploads are never overwritten inside the portal either: every upload and edit is a new version, and earlier versions can be restored from **Edit data**.

### A copy away from the server (recommended)

Backups on the server are lost if the server itself is lost, so copy each one to object storage as well. The files are encrypted before they leave, so the storage provider cannot read them.

1. In the AWS console, create an **S3 bucket** in **Mumbai (ap-south-1)**, for example `assura-elevate-backups`, with public access blocked. (A Lightsail bucket also works.) Storage for about 1 GB of backups costs a few rupees a month.
2. In **IAM**, create a user (for example `assura-backups`) with no console access, attach this policy to it (change the bucket name if yours differs), and create an access key for it:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::assura-elevate-backups" },
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::assura-elevate-backups/portal-backups/*" }
     ]
   }
   ```
3. On the server, add to `/srv/assura/assura.env` (never paste these into chat or email):
   ```
   AE_OFFSITE_BUCKET=assura-elevate-backups
   AE_OFFSITE_REGION=ap-south-1
   AE_OFFSITE_ACCESS_KEY=the-access-key-id
   AE_OFFSITE_SECRET_KEY=the-secret-access-key
   ```
4. Run a backup to test it: `sudo -u assura bash -c 'set -a; . /srv/assura/assura.env; set +a; cd /srv/assura/app; node tools/backup.js'`. The **Backups** card then shows the copy away from the server. The same keeping rule is applied there.

**Moving an existing 1 GB server to 2 GB** (Lightsail cannot resize in place, but nothing is lost): Snapshots → Create snapshot → on the snapshot, **Create new instance** → choose the 2 GB plan → when it is running, Networking → detach the static IP from the old instance and attach it to the new one → check the portal opens → delete the old instance. The domain keeps pointing at the same IP, so nothing else changes.

Also keep **Lightsail automatic snapshots** on (step 1 above): that is a daily copy of the whole server, which makes rebuilding it quick.

Keep the **backup key** (printed once by setup, also in `assura.env`) somewhere safe away from the server, for example in the firm's password manager. Without it no backup can be read.

### Restoring

1. See what is kept: `node tools/backup.js status`. Check one: `node tools/backup.js verify <file>`.
2. Decrypt it to a new file (this never touches the live database):
   `sudo -u assura bash -c 'set -a; . /srv/assura/assura.env; set +a; cd /srv/assura/app; node tools/backup.js restore /srv/assura/backups/<file> /srv/assura/data/restored.db'`
3. `systemctl stop assura-elevate`, move the live `assura.db` aside (keep it), rename `restored.db` to `assura.db`, delete any `assura.db-wal` and `assura.db-shm` files, then `systemctl start assura-elevate`.

From the copy away from the server: download the file from the bucket to `/srv/assura/backups` first, then do the same.

## How many people it handles

Tested with 150 client companies, each with 12 months of data (an 82 MB database), and 300 people signed in at the same time:

| | Result |
|---|---|
| 300 people each opening a page every few seconds (about 120 pages a second) | half of pages in 1–3 ms, 95% within 6 ms (client pages) |
| Flat out, with no pause between clicks (about 690 pages a second) | no errors; pages slow to under a second while it lasts |
| The team's list of all 150 clients' monthly data | about 35 ms |
| An hourly backup of that database | under 4 seconds, while the portal keeps serving |

What makes this hold up: each client's figures are worked out once and reused until that client's data changes, and prepared in the background when the portal starts. Passwords are checked without holding up other people's pages. The database lets many people read while one writes. Normal use by 300 people is well inside this; the 2 GB plan gives headroom for the server's other work and for growth.
