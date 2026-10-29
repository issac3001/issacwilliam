# Assura Elevate: client platform

The technology layer of Assura Elevate. The Assura team uploads one workbook a month for each client; the platform validates it, keeps every month on record, and rebuilds that client's dashboard with automated highlights for the management review. Clients sign in to a view-only dashboard of their own company, where every figure opens the records behind it.

*Built for businesses ready for their next stage.*

## What it does today

| Area | Currently available |
|---|---|
| Data collection | Monthly Excel workbook (`templates/`), one sheet per section, with the Tally report each comes from. CSV upload for a single section. |
| Validation | Header detection below Tally title rows, Tally column aliases, Indian number formats, Dr/Cr, Excel dates. Row-level error messages. Company code must match the login's company. |
| Access | Login per user. Three roles: **client** (view only, one company), **team** (Assura staff: every client, upload and edit, client logins), **admin** (team, plus Assura team logins). A client login can only ever read its own company; this is enforced in one place on the server (`companyFor` in `server/server.js`) and covered by tests. |
| Click-through detail | Every KPI, chart bar or point, ageing bucket, list row and highlight opens a panel with the records behind it (for example receivables over 90 days opens every party and invoice, oldest first), with a month picker, filters and CSV download. |
| Editing | **Edit data** (team): open any month and section, correct, add or delete rows, save as a new version. Checked with the same rules as an upload. Earlier versions can be restored and a wrong month can be taken off the dashboard. |
| Sign-in | One address. Clients sign in at `/client` (user ID or email, and password) and see only their own company. The Assura team signs in at `/team` with **user ID and password only** and lands on their own workspace page for their seat. Each page refuses the other's logins. |
| Account security | New logins get a one-time password and must choose their own at first sign-in (10+ characters). Two-step login (authenticator app, RFC 6238) can be required for every team login with `AE_REQUIRE_STAFF_2FA=1`. Sessions end after 2 hours idle (`AE_IDLE_MINUTES`) and on password change; logins can be switched off. Repeated failed sign-ins are slowed down. |
| Administration | **Clients & users** screen for the team: add and rename companies, add logins with their user IDs, set or change a user ID, reset passwords and two-step login, switch logins off. Only admins manage team logins. |
| Audit log | Every sign-in (and failed attempt), dashboard view, upload, edit, restore, password change and admin action is recorded with time, user, company and IP, and shown to the team. |
| Backups | `tools/backup.js`: an encrypted backup every hour, decrypted and checked before it counts; every backup of the last day, one a day for 30 days and one a month for a year are kept; optional copy to S3 or a Lightsail bucket (`tools/offsite.js`); status shown to admins. A backup is taken before every update. See DEPLOY.md. |
| History | Every upload and edit is kept as a version. The latest version of each month drives the dashboard, so history builds month on month. |
| Dashboard | Overview, Where is the money?, Sales & customers, Expenses, Compliance & governance, Data & uploads. |
| Highlights | Rule-based analysis of the client's own history (`shared/analysis.js`): revenue direction and streaks, gross margin movement, purchase rate increases by item, receivables 90+ and collection days, customer concentration, regular customers who stopped buying, new customers, month-end billing loading, slow-moving stock and cash locked in it, stock build-up, expense heads out of their normal range, overheads outpacing revenue, OD/CC utilisation, net cash decline, supplier payments beyond 60 days (MSME / 43B(h) prompt), overdue, late and upcoming compliance. Each highlight is ranked (act now / watch / positive / information) and carries a point for the management review. |
| Explanations | For each material movement in a month (revenue, gross margin, expenses, profit, receivables, stock, net cash), `shared/insights.js` traces the change to the transactions behind it and lists likely causes with their rupee effect: customers billed more or less, lost and new accounts, price and volume effects, purchase rate changes, sales mix, expense heads, collection days, and a cash bridge. The Assura team ticks the right causes, edits the wording and accepts it under **Explanations**; only accepted explanations appear on the client's overview, and a review is flagged when the month's figures change afterwards. |
| Monthly workbook | Sent from the client's **Data & uploads** page by the Assura team: emailed to the client's saved accounts address through the firm's own mailbox (`server/mail.js`, set up as in DEPLOY.md), or downloaded. Every copy is filled by `shared/workbook.js` with the company code, name, month and its own workbook reference on a locked first sheet, and recorded with who sent it and whether it came back. |
| Monthly data cycle | Team logins start in Workflow when it is installed, otherwise on **Monthly data**. That page shows every client's monthly data cycle for the month being worked on (workbook sent, data received from the accountant, on the dashboard, explanations reviewed), with reminders for steps past their target day (3rd, 10th, 12th and 15th of the following month, set in `shared/cycle.js`). A client opens on its own **This month's work** page with what is pending, before its dashboard. With the workflow module installed, team members see only the clients allotted to them, and Workflow reads the same status from `GET /api/cycle`. A staff link `/?company=<id>&view=<section>` opens one client (default view: its month's work; `overview` for the dashboard). Clients see a plain note on their dashboard while the month's data is with their accountant. |
| Company check on uploads | A returned workbook is accepted only if its reference was issued for the selected client and that month (`shared/match.js`), and its company code and name match (legal suffixes and punctuation ignored). A file whose customers and suppliers are on record for another client is refused, and a one-section CSV needs the client code typed to confirm. Every upload is checked first and shown for review, and changes nothing until the team accepts it. |

### Planned
- Language-model drafting of the explanations' wording (needs a paid API key and data-handling approval; today the drafts come from the built-in analysis).
- Review and sign-off steps for the team's monthly work.
- Email / WhatsApp alerts for critical highlights.
- Direct Tally integration (today: Excel/CSV upload).
- Board pack PDF export; statutory registers and minutes repository.
- Password reset by email (today: the Assura team resets it and shares the one-time password).
- Hosting in India with HTTPS on your own domain: ready to install (see `DEPLOY.md`); the server is chosen with you before any paid service is used.

## Practice workspace (Assura team only)

Team members land here (`/workflow`) after signing in at `/team`. Client logins are refused.

| Area | What it does |
|---|---|
| Branches | Bangalore and Calicut to start; a new city is added under Firm structure and set up the same way. Each branch has a Branch Head. |
| Departments | Taxation (Direct Tax; Indirect Tax/GST), Labour Law (ESI, PF), Corporate Governance (Companies Act; LLP), Legal (partnerships, proprietorships, NGOs), Assurance, and Accounts (internal: billing, attendance). |
| People | Managing Partner > Branch Head > Department Head > Manager > Supervisor > Associate > Analyst. Each person reports to one person. Everyone sees their own work and the work of everyone reporting to them; a department head their department in their branch; a branch head the branch; the Managing Partner everything. |
| Clients | Onboarding with entity type, PAN, GSTIN, TAN, CIN, address, billing email, monthly fee and target day. Owners, partners, directors, trustees and the client's accountant are recorded with email and mobile. |
| Allotment | One person per client per division, until replaced (open work moves with the client; every change is logged). A division can be marked not applicable; it then gets only a monthly applicability review. Department heads and managers allot within their department. |
| Approvals | The allotted person prepares, a Supervisor does the quality check, a Manager gives final approval. Nobody checks work they moved forward. Flags send the task to the Managing Partner. |
| Documents | A document from the client counts only when it comes from a registered contact's email or mobile. Anything else blocks approval until it is received properly or set aside by a supervisor. |
| Month close and billing | When every division has completed a client's month it goes to Accounts, who raise next month's advance invoice (numbered by financial year), email it to the billing email and partners on record, and record payment. Email needs the SMTP settings in `server/mail.js`. |
| Attendance | Each person marks yes or no daily; Accounts verifies it. |
| Reports | Every two days to each supervisor and manager with reportees, weekly to each department head, consolidated to the branch heads and the Managing Partner. Each is reviewed with a comment and corrective actions, which their owners mark done. |
| Timeliness | Preparation is due five days and the quality check two days before the target date. Work shows as on track, behind, or late, with on-time rates by division and person. |

Engine: `shared/workflow.js` (tables prefixed `wf_`, created on start). `npm run seed:demo` loads the demo (see Demo below). `npm run build:workflow-demo` writes a self-contained preview to `dist/workflow-demo.html`.

## Public website

`site/` is the firm's public website: plain HTML and CSS with no build step, no tracking and no third-party scripts beyond Google Fonts. The portal's server serves it at `/` on the same address, so the website, client sign-in (`/client`) and team sign-in (`/team`) are one link. Its **Sign in** corner (`/login`) offers both. Open `site/index.html` in a browser to preview it.

## Demo

One demo, clearly labelled, with two logins (password `demo-password`):

| User ID | What it shows |
|---|---|
| `demo.client` | A client's view: Meridian Polymers Pvt Ltd (Demo), 12 months of fictional data, view only |
| `demo.staff` | An Assura team member's view: the workspace (Managing Partner's seat, with placeholder colleagues) and the client dashboard |

On the server it runs as its own program and database (`demo.elevateassura.com`, `AE_DEMO=1`), reset every night by `deploy/demo-reset.sh`, so it never touches client data. `npm run build:demo` writes the same demo as a single offline page.

## Run it

Requires Node 22.5+ (uses the built-in `node:sqlite`; no npm dependencies) and Python 3 with `openpyxl` only to regenerate workbooks.

```bash
npm run seed:demo     # the demo client (12 months of data) and the demo.client / demo.staff logins
npm start             # http://localhost:3000
npm test              # parser, analysis and access-control tests
```

Then open http://localhost:3000/client (`demo.client`) or http://localhost:3000/team (`demo.staff`), password `demo-password`.

Real clients:

```bash
node tools/admin.js add-company AE-0003 "Client Name Pvt Ltd"
node tools/admin.js add-user md@client.com "Full Name" client AE-0003
node tools/admin.js add-user name@assura.example "Full Name" team --id name.s
```

The command line is for the very first admin; after that, use the **Clients & users** screen. Every new login gets a one-time password. `DEPLOY.md` covers putting the portal on a server with HTTPS.

Set `AE_SECURE_COOKIE=1` when served over HTTPS. The database lives in `data/assura.db` (`AE_DB` to override). Start with `AE_DEMO=1` to show the demo logins on the sign-in pages.

Backups (run daily from cron; keep the key somewhere other than the server):

```bash
AE_BACKUP_KEY='long-random-secret' node tools/backup.js
AE_BACKUP_KEY='long-random-secret' node tools/backup.js verify
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
shared/cycle.js         the monthly data cycle: steps, target days, reminders (browser + Node)
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
