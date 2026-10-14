# Assura Elevate: client platform

The technology layer of Assura Elevate. The Assura team uploads one workbook a month for each client; the platform validates it, keeps every month on record, and rebuilds that client's dashboard with automated highlights for the management review. Clients sign in to a view-only dashboard of their own company, where every figure opens the records behind it.

*We don't replace your accountant. We elevate your finance function.*

## What it does today

| Area | Currently available |
|---|---|
| Data collection | Monthly Excel workbook (`templates/`), one sheet per section, with the Tally report each comes from. CSV upload for a single section. |
| Validation | Header detection below Tally title rows, Tally column aliases, Indian number formats, Dr/Cr, Excel dates. Row-level error messages. Company code must match the login's company. |
| Access | Login per user. Three roles: **client** (view only, one company), **team** (Assura staff: every client, upload and edit, client logins), **admin** (team, plus Assura team logins). A client login can only ever read its own company; this is enforced in one place on the server (`companyFor` in `server/server.js`) and covered by tests. |
| Click-through detail | Every KPI, chart bar or point, ageing bucket, list row and highlight opens a panel with the records behind it (for example receivables over 90 days opens every party and invoice, oldest first), with a month picker, filters and CSV download. |
| Editing | **Edit data** (team): open any month and section, correct, add or delete rows, save as a new version. Checked with the same rules as an upload. Earlier versions can be restored and a wrong month can be taken off the dashboard. |
| Account security | New logins get a one-time password and must choose their own at first sign-in (10+ characters). Team and admin logins must set up two-step login (authenticator app, RFC 6238) before they see any client. Sessions end after 2 hours idle (`AE_IDLE_MINUTES`) and on password change; logins can be switched off. Repeated failed sign-ins are slowed down. |
| Administration | **Clients & users** screen for the team: add and rename companies, add logins, reset passwords and two-step login, switch logins off. Only admins manage team logins. |
| Audit log | Every sign-in (and failed attempt), dashboard view, upload, edit, restore, password change and admin action is recorded with time, user, company and IP, and shown to the team. |
| Backups | `tools/backup.js`: daily encrypted snapshots (AES-256-GCM, key from `AE_BACKUP_KEY`), newest 30 kept, with a restore command. |
| History | Every upload and edit is kept as a version. The latest version of each month drives the dashboard, so history builds month on month. |
| Dashboard | Overview, Where is the money?, Sales & customers, Expenses, Compliance & governance, Data & uploads. |
| Highlights | Rule-based analysis of the client's own history (`shared/analysis.js`): revenue direction and streaks, gross margin movement, purchase rate increases by item, receivables 90+ and collection days, customer concentration, regular customers who stopped buying, new customers, month-end billing loading, slow-moving stock and cash locked in it, stock build-up, expense heads out of their normal range, overheads outpacing revenue, OD/CC utilisation, net cash decline, supplier payments beyond 60 days (MSME / 43B(h) prompt), overdue, late and upcoming compliance. Each highlight is ranked (act now / watch / positive / information) and carries a point for the management review. |

### Planned
- AI-written monthly commentary on top of the highlights (needs an LLM API key and data-handling approval).
- Email / WhatsApp alerts for critical highlights.
- Direct Tally integration (today: Excel/CSV upload).
- Board pack PDF export; statutory registers and minutes repository.
- Password reset by email (today: the Assura team resets it and shares the one-time password).
- Hosting in India with HTTPS on your own domain: ready to install (see `DEPLOY.md`); the server is chosen with you before any paid service is used.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`; no npm dependencies) and Python 3 with `openpyxl` only to regenerate workbooks.

```bash
npm run seed:demo     # two fictional demo companies with 12 months of data
npm start             # http://localhost:3000
npm test              # parser, analysis and access-control tests
```

Demo logins (password `demo-password`): `client@meridian.demo`, `client@coastline.demo` (view only), `team@assura.demo`, `admin@assura.demo`.

Real clients:

```bash
node tools/admin.js add-company AE-0003 "Client Name Pvt Ltd"
node tools/admin.js add-user md@client.com "Full Name" client AE-0003
node tools/admin.js add-user name@assura.example "Full Name" team
```

The command line is for the very first admin; after that, use the **Clients & users** screen. Every new login gets a one-time password. `DEPLOY.md` covers putting the portal on a server with HTTPS.

Set `AE_SECURE_COOKIE=1` when served over HTTPS. The database lives in `data/assura.db` (`AE_DB` to override). For a local demo without two-step login for the demo team logins, start with `AE_REQUIRE_STAFF_2FA=0`.

Backups (run daily from cron; keep the key somewhere other than the server):

```bash
AE_BACKUP_KEY='long-random-secret' node tools/backup.js
AE_BACKUP_KEY='long-random-secret' node tools/backup.js restore backups/assura-<time>.db.gz.enc restored.db
```

## Layout

```
shared/schema.json      the workbook definition (single source for template, parser and UI)
shared/parse.js         workbook -> validated monthly dataset (browser + Node)
shared/analysis.js      metrics, ageing, trends and highlights (browser + Node)
shared/edit.js          checks edits made in the portal with the upload rules
server/                 HTTP server, auth, storage
public/                 dashboard front end (drill.js: click-through detail, editor.js: data editor)
deploy/                 server setup, service and HTTPS configuration
templates/              blank monthly workbook for clients
samples/                fictional demo data (JSON and filled workbooks)
tools/                  workbook builder, sample generator, admin CLI, demo bundler
```

`npm run build:demo` bundles everything into `dist/assura-elevate-demo.html`, a self-contained demo that runs the same parser and analysis in the browser with the sample data.

Sample companies, customers and suppliers are invented for demonstration. Figures on the dashboard are management estimates from data provided by the client's finance team and are unaudited.
