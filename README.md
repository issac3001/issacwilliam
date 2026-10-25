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
| Explanations | For each material movement in a month (revenue, gross margin, expenses, profit, receivables, stock, net cash), `shared/insights.js` traces the change to the transactions behind it and lists likely causes with their rupee effect: customers billed more or less, lost and new accounts, price and volume effects, purchase rate changes, sales mix, expense heads, collection days, and a cash bridge. The Assura team ticks the right causes, edits the wording and accepts it under **Explanations**; only accepted explanations appear on the client's overview, and a review is flagged when the month's figures change afterwards. |
| Monthly workbook | Sent from the client's **Data & uploads** page by the Assura team: emailed to the client's saved accounts address through the firm's own mailbox (`server/mail.js`, set up as in DEPLOY.md), or downloaded. Every copy is filled by `shared/workbook.js` with the company code, name, month and its own workbook reference on a locked first sheet, and recorded with who sent it and whether it came back. |
| Company check on uploads | A returned workbook is accepted only if its reference was issued for the selected client and that month (`shared/match.js`), and its company code and name match (legal suffixes and punctuation ignored). A file whose customers and suppliers are on record for another client is refused, and a one-section CSV needs the client code typed to confirm. Every upload is checked first and shown for review, and changes nothing until the team accepts it. |

### Planned
- Language-model drafting of the explanations' wording (needs a paid API key and data-handling approval; today the drafts come from the built-in analysis).
- Review and sign-off steps for the team's monthly work.
- Email / WhatsApp alerts for critical highlights.
- Direct Tally integration (today: Excel/CSV upload).
- Board pack PDF export; statutory registers and minutes repository.
- Password reset by email (today: the Assura team resets it and shares the one-time password).
- Hosting in India with HTTPS on your own domain: ready to install (see `DEPLOY.md`); the server is chosen with you before any paid service is used.

## Internal workflow (Assura team only)

Open `/workflow` with a team or admin login. Client logins are refused. The same sign-in and two-step login apply.

| Area | What it does |
|---|---|
| Structure | Managing Director; a Director heading each department (Taxation & Assurance, Corporate Governance, Legal, HR & Labour Compliance); Managers, Senior Analysts (semi-qualified) and Analysts (trainees). Each team is a manager, a senior analyst and an analyst serving up to 30 clients (capacity is editable). |
| Allotment | Each client is allotted to one team in every department, with a target day of the month per client and department. |
| Monthly cycle | "Start the month" creates each department's standard review tasks for every allotted client, due on that client's target day in the following month. Extra tasks can be added by managers and above. |
| Maker-checker | Analyst prepares, Senior Analyst reviews, Manager approves, Director signs off for the department. Nobody can check work they moved forward. Any step can send work back with a note. |
| Flags | Anyone on the task can flag an issue; the task then needs the MD's approval after department sign-off, and the MD records the decision. |
| Timeliness | Every step has its own target ahead of the task's target date. Tasks show as on track, behind a step target, or late; completed work is on time or late. The Timeliness page gives on-time rates by department, team and person. |
| Client sign-off | The Clients page shows, for each client and month, every department's progress and sign-off; the month is complete when all have signed off. |

Engine: `shared/workflow.js` (tables prefixed `wf_`, created on start). Placeholder team for the demo: `npm run seed:demo` adds `md@assura.demo`, `ca.director@assura.demo`, `ca.manager1@assura.demo`, `ca.senior1@assura.demo`, `ca.analyst1@assura.demo` and the same for `cs`, `legal` and `hr` (password `demo-password`). `npm run build:workflow-demo` writes a self-contained preview to `dist/workflow-demo.html`.

## Public website

`site/` is the firm's public website (elevateassura.com): plain HTML and CSS with no build step, no tracking and no third-party scripts beyond Google Fonts. Its **Sign in** corner (`site/login.html`) leads to the portal: team members go to `portal.elevateassura.com/?next=workflow`, which opens Workflow straight after sign-in; clients go to the portal's sign-in and see only their own company. `deploy/setup.sh` serves the site on the same server when the website domain is given as a fourth argument (see DEPLOY.md). Open `site/index.html` in a browser to preview it.

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
shared/insights.js      suggested explanations of each month's movements (browser + Node)
shared/match.js         checks that an upload belongs to the selected client (browser + Node)
shared/workbook.js      fills one client's copy of the monthly workbook (browser + Node)
server/mail.js          sends email through the firm's own mailbox (SMTP)
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
