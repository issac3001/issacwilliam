'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const store = require('../server/db');
const totp = require('../server/totp');
const backupTool = require('../tools/backup');
const { createApp } = require('../server/server');
const { parseWorkbook, parseDate, parseMonth, parseNumber } = require('../shared/parse');
const { analyse } = require('../shared/analysis');
const schema = require('../shared/schema.json');

const ROOT = path.join(__dirname, '..');
const sample = (code, period) => JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'json', code, `${period}.json`), 'utf8'));
const xlsxRows = (file) => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'xlsx_to_json.py'), file], { maxBuffer: 64 << 20 }));

test('value parsers accept Tally and Excel formats', () => {
  assert.strictEqual(parseDate(46266), '2026-09-01');
  assert.strictEqual(parseDate('01-09-2026'), '2026-09-01');
  assert.strictEqual(parseDate('1-Sep-26'), '2026-09-01');
  assert.strictEqual(parseDate('31-02-2026'), null);
  assert.strictEqual(parseMonth('Sep-2026'), '2026-09');
  assert.strictEqual(parseMonth('09/2026'), '2026-09');
  assert.strictEqual(parseNumber('1,23,456.50'), 123456.5);
  assert.strictEqual(parseNumber('(1,000)'), -1000);
  assert.strictEqual(parseNumber('5,000 Cr'), -5000);
  assert.strictEqual(parseNumber('₹ 2,500 Dr'), 2500);
  assert.strictEqual(parseNumber('abc'), null);
});

test('sample workbook round-trips through the parser unchanged', () => {
  const parsed = parseWorkbook(xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0001', '2026-09.xlsx')), schema);
  assert.deepStrictEqual(parsed.errors, []);
  const src = sample('AE-0001', '2026-09');
  src.company = Object.assign({}, src.company, { template_ref: 'AE-0001-2026-09-SAMPLE' }); // added when the sample copy is built
  for (const k of ['company', 'sales', 'purchases', 'receivables', 'inventory', 'cash']) assert.deepStrictEqual(parsed.data[k], src[k], k);
});

test('parser finds headers below Tally title rows, maps aliases and reports bad rows', () => {
  const sheets = {
    'Company & Period': [['Company Code', 'AE-0009'], ['Company Name', 'X'], ['Period (Month)', 'Sep-2026'], ['Prepared By', 'A']],
    Sales: [
      ['Sales Register'], ['1-Sep-2026 to 30-Sep-2026'], [],
      ['Date', 'Voucher No.', 'Party Name', 'Customer Type', 'Stock Item', 'Value'],
      ['01-09-2026', 'S/1', 'Alpha', 'B2B', 'Widget', '1,000'],
      ['02-09-2026', 'S/2', 'Beta', 'Retail', 'Widget', '500'],
      ['Grand Total', null, null, null, null, '1,500'],
    ],
  };
  const r = parseWorkbook(sheets, schema);
  assert.strictEqual(r.data.sales.length, 1);
  assert.strictEqual(r.data.sales[0].customer, 'Alpha');
  assert.strictEqual(r.data.sales[0].taxable_value, 1000);
  assert.ok(r.errors.some((e) => /Sales row 6: Customer Type \(B2B\/B2C\) "Retail"/.test(e)), r.errors.join('\n'));
});

test('analysis finds the storylines planted in the sample data', () => {
  const load = (code) => fs.readdirSync(path.join(ROOT, 'samples', 'json', code)).map((f) => ({ period: f.slice(0, 7), data: sample(code, f.slice(0, 7)) }));
  const a = analyse(load('AE-0001'), { asOf: '2026-10-08' });
  assert.strictEqual(a.months.length, 12);
  const titles = a.highlights.map((h) => h.title).join('\n');
  assert.match(titles, /Gross margin down/);
  assert.match(titles, /receivables is over 90 days/);
  assert.match(titles, /locked in stock/);
  assert.match(titles, /Working capital limits/);
  assert.match(titles, /compliance item overdue/);
  assert.strictEqual(a.highlights[0].severity, 'critical');
  // Each highlight says what opens when it is clicked.
  const over90 = a.highlights.find((h) => /over 90 days/.test(h.title));
  assert.deepStrictEqual(over90.drill, { kind: 'receivables', bucket: '90+' });
  assert.ok(a.highlights.every((h) => h.drill && h.drill.kind), 'every highlight opens a breakdown');
  const b = analyse(load('AE-0002'), { asOf: '2026-10-08' });
  assert.ok(b.highlights.some((h) => h.severity === 'positive' && /Revenue up/.test(h.title)));
  assert.ok(b.highlights.some((h) => /billed in the last five days/.test(h.title)));
});

// ---------- HTTP: authentication and company isolation ----------
function client(port) {
  let cookie = '';
  const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path: url, headers: Object.assign({ 'X-Requested-With': 'assura', Cookie: cookie }, data ? { 'Content-Type': 'application/json' } : {}, headers) }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { const sc = res.headers['set-cookie']; if (sc) cookie = sc[0].split(';')[0]; resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  return { call, login: (email, extra) => call('POST', '/api/login', Object.assign({ email, password: 'test-password-1' }, extra)) };
}

// Completes a team member's first sign-in: enrols two-step login and returns the secret.
async function enrolStaff(c) {
  const start = await c.call('POST', '/api/2fa/start');
  assert.strictEqual(start.status, 200);
  const code = totp.codeAt(start.body.secret, Math.floor(Date.now() / 30000));
  const done = await c.call('POST', '/api/2fa/confirm', { code });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  return start.body.secret;
}

test('a client sees only its own company and is view only; the Assura team uploads and edits', async (t) => {
  const db = store.open(':memory:');
  const a = store.createCompany(db, 'AE-0001', 'Meridian Polymers Private Limited');
  const b = store.createCompany(db, 'AE-0002', 'Coastline Foods Pvt. Ltd.');
  const pw = 'test-password-1';
  store.createUser(db, { email: 'md@a.test', name: 'MD A', role: 'client', companyId: a.id, password: pw });
  store.createUser(db, { email: 'md@b.test', name: 'MD B', role: 'client', companyId: b.id, password: pw });
  store.createUser(db, { email: 'team@x.test', name: 'Team', role: 'team', companyId: null, password: pw });
  for (const p of ['2026-08', '2026-09']) store.saveUpload(db, { companyId: b.id, period: p, userId: null, filename: 'seed', sections: [], warnings: [], data: sample('AE-0002', p) });
  // The sample workbooks carry fixed references; record them as issued, as the portal does when it sends a workbook.
  for (const p of ['2026-07', '2026-08', '2026-09']) store.issueWorkbook(db, { companyId: a.id, period: p, ref: `AE-0001-${p}-SAMPLE`, method: 'download' });
  store.issueWorkbook(db, { companyId: b.id, period: '2026-09', ref: 'AE-0002-2026-09-SAMPLE', method: 'download' });
  assert.throws(() => store.createUser(db, { email: 'x@a.test', name: 'X', role: 'client', companyId: null, password: pw }), 'a client login must belong to a company');

  const server = http.createServer(createApp(db)).listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const anon = client(port);
  assert.strictEqual((await anon.call('GET', '/api/me')).status, 401);
  assert.strictEqual((await anon.call('GET', `/api/dashboard?company=${b.id}`)).status, 401);
  assert.strictEqual((await anon.call('GET', `/api/data?company=${b.id}&period=2026-09`)).status, 401);
  assert.strictEqual((await anon.call('POST', '/api/login', { email: 'md@a.test', password: 'wrong-password' })).status, 401);

  const mdA = client(port);
  assert.strictEqual((await mdA.login('md@a.test')).status, 200);
  const me = await mdA.call('GET', '/api/me');
  assert.deepStrictEqual(me.body.companies.map((c) => c.code), ['AE-0001']);
  assert.strictEqual((await mdA.call('GET', '/api/dashboard')).status, 200);
  assert.strictEqual((await mdA.call('GET', `/api/dashboard?company=${b.id}`)).status, 403, 'client A must not read B');
  assert.strictEqual((await mdA.call('GET', `/api/uploads?company=${b.id}`)).status, 403);
  assert.strictEqual((await mdA.call('GET', `/api/data?company=${b.id}&period=2026-09`)).status, 403, 'client A must not open B\'s detail');
  // A client login is view only: no upload, edit, restore, removal or administration.
  assert.strictEqual((await mdA.call('POST', '/api/upload', { sheets: {} })).status, 403);
  assert.strictEqual((await mdA.call('POST', '/api/data/edit', { period: '2026-09', section: 'expenses', values: [] })).status, 403);
  assert.strictEqual((await mdA.call('POST', '/api/data/restore', { period: '2026-09', version: 1 })).status, 403);
  assert.strictEqual((await mdA.call('POST', '/api/data/remove-month', { period: '2026-09' })).status, 403);
  assert.strictEqual((await mdA.call('GET', '/api/admin/overview')).status, 403);

  const team = client(port);
  assert.strictEqual((await team.login('team@x.test')).body.next, 'enrol-2fa');
  assert.strictEqual((await team.call('GET', `/api/dashboard?company=${a.id}`)).status, 403, 'team must finish two-step setup first');
  await enrolStaff(team);
  assert.strictEqual((await team.call('GET', '/api/me')).body.companies.length, 2);

  // Company B's workbook uploaded with A selected is refused: code, name and B's own customers all give it away.
  const wbB = xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0002', '2026-09.xlsx'));
  const wrong = await team.call('POST', '/api/upload', { company: a.id, filename: 'b.xlsx', sheets: wbB });
  assert.strictEqual(wrong.status, 422);
  assert.match(wrong.body.errors.join('\n'), /company code AE-0002/);
  assert.match(wrong.body.errors.join('\n'), /names the company as "Coastline Foods/);
  // Even with A's code and name typed onto the Company sheet, B's customers and suppliers give it away.
  const disguised = JSON.parse(JSON.stringify(wbB));
  const compSheet = disguised['Company & Period'];
  compSheet.forEach((row) => { if (/Company Code/i.test(row[0])) row[1] = 'AE-0001'; if (/Company Name/i.test(row[0])) row[1] = 'Meridian Polymers Pvt Ltd'; });
  const sneaky = await team.call('POST', '/api/upload', { company: a.id, filename: 'b.xlsx', sheets: disguised });
  assert.strictEqual(sneaky.status, 422, JSON.stringify(sneaky.body));
  assert.match(sneaky.body.errors.join('\n'), /Workbook AE-0002-2026-09-SAMPLE was issued to Coastline Foods Pvt\. Ltd\. \(AE-0002\), not to Meridian/);
  assert.match(sneaky.body.errors.join('\n'), /on record for Coastline Foods Pvt\. Ltd\. \(AE-0002\)/);
  // A workbook that was not issued by the portal is refused, and so is a copy whose locked month was changed.
  const unissued = JSON.parse(JSON.stringify(xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0001', '2026-09.xlsx'))));
  unissued['Company & Period'].forEach((row) => { if (/Workbook Reference/i.test(row[0])) row[1] = null; });
  assert.match((await team.call('POST', '/api/upload', { company: a.id, sheets: unissued })).body.errors[0], /no workbook reference/);
  unissued['Company & Period'].forEach((row) => { if (/Workbook Reference/i.test(row[0])) row[1] = 'AE-0001-2026-09-MADEUP'; });
  assert.match((await team.call('POST', '/api/upload', { company: a.id, sheets: unissued })).body.errors[0], /was not issued by Assura Elevate/);
  unissued['Company & Period'].forEach((row) => { if (/Workbook Reference/i.test(row[0])) row[1] = 'AE-0001-2026-08-SAMPLE'; });
  assert.match((await team.call('POST', '/api/upload', { company: a.id, sheets: unissued })).body.errors[0], /issued for August 2026, but its month now reads September 2026/);
  // A's code with another company's name is refused too.
  const wbA9 = xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0001', '2026-09.xlsx'));
  const renamed = JSON.parse(JSON.stringify(wbA9));
  renamed['Company & Period'].forEach((row) => { if (/Company Name/i.test(row[0])) row[1] = 'Some Other Company Ltd'; });
  const named = await team.call('POST', '/api/upload', { company: a.id, filename: 'a.xlsx', sheets: renamed });
  assert.strictEqual(named.status, 422);
  assert.match(named.body.errors[0], /names the company as "Some Other Company Ltd"/);
  // Missing CSRF header is refused.
  assert.strictEqual((await team.call('POST', '/api/upload', { company: a.id, sheets: {} }, { 'X-Requested-With': '' })).status, 403);

  // The first pass only checks and summarises, for the team to review; nothing is saved.
  const pre = await team.call('POST', '/api/upload', { company: a.id, filename: 'x.xlsx', preview: true, sheets: xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0001', '2026-07.xlsx')) });
  assert.strictEqual(pre.status, 200, JSON.stringify(pre.body));
  assert.strictEqual(pre.body.preview, true);
  assert.strictEqual(pre.body.workbook.ref, 'AE-0001-2026-07-SAMPLE');
  assert.ok(pre.body.summary.sections.find((x) => x.key === 'sales').rows > 0);
  assert.deepStrictEqual((await mdA.call('GET', '/api/dashboard')).body.periods, [], 'a preview saves nothing');
  for (const p of ['2026-07', '2026-08', '2026-09']) {
    const wb = xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0001', `${p}.xlsx`));
    const r = await team.call('POST', '/api/upload', { company: a.id, filename: `${p}.xlsx`, sheets: wb });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
  let dash = await mdA.call('GET', '/api/dashboard');
  assert.deepStrictEqual(dash.body.periods, ['2026-07', '2026-08', '2026-09']);
  const revBefore = dash.body.analysis.months[2].revenue;

  // The client can open the detail behind its own figures; the rows add up to the dashboard.
  const detail = await mdA.call('GET', '/api/data?period=2026-09');
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(Math.round(detail.body.data.sales.reduce((s, x) => s + x.taxable_value, 0)), Math.round(revBefore));
  assert.strictEqual((await mdA.call('GET', '/api/data?period=2026-09&version=1')).status, 403, 'earlier versions are for the team');
  assert.strictEqual((await mdA.call('GET', '/api/uploads')).body.uploads[0].uploaded_by, undefined, 'clients do not see who uploaded');

  // CSV-style single-section upload replaces one section of a month, as a new version.
  const csv = [['Expense Head', 'Expense Group', 'Amount'], ['Salaries and wages', 'Employee Cost', '100']];
  const unconfirmed = await team.call('POST', '/api/upload', { company: a.id, filename: 'expenses.csv', section: 'expenses', period: '2026-09', sheets: { 'expenses.csv': csv } });
  assert.strictEqual(unconfirmed.status, 422, 'a CSV names no company, so the client code must be confirmed');
  assert.match(unconfirmed.body.errors[0], /type the selected client's code \(AE-0001\)/);
  const up = await team.call('POST', '/api/upload', { company: a.id, filename: 'expenses.csv', section: 'expenses', period: '2026-09', confirm_code: 'ae-0001', sheets: { 'expenses.csv': csv } });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.strictEqual(up.body.version, 2);
  dash = await mdA.call('GET', '/api/dashboard');
  assert.strictEqual(dash.body.analysis.months[2].opex, 100);
  assert.strictEqual(dash.body.analysis.months[2].revenue, revBefore);

  // The team edits a section in the portal: bad rows are refused with row numbers, good rows save as a new version.
  const bad = await team.call('POST', '/api/data/edit', { company: a.id, period: '2026-09', section: 'expenses', values: [{ head: 'Rent', group: 'Nonsense', amount: 'abc' }] });
  assert.strictEqual(bad.status, 422);
  assert.match(bad.body.errors.join('\n'), /row 1: .*Expense Group/);
  const stale = await team.call('POST', '/api/data/edit', { company: a.id, period: '2026-09', section: 'expenses', baseVersion: 1, values: [] });
  assert.strictEqual(stale.status, 409, 'an edit based on an old version is refused');
  const edit = await team.call('POST', '/api/data/edit', { company: a.id, period: '2026-09', section: 'expenses', baseVersion: 2,
    values: [{ head: 'Salaries and wages', group: 'Employee Cost', amount: '1,50,000' }, { head: 'Rent', group: 'Occupancy', amount: 25000 }] });
  assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
  assert.strictEqual(edit.body.version, 3);
  dash = await mdA.call('GET', '/api/dashboard');
  assert.strictEqual(dash.body.analysis.months[2].opex, 175000);
  const formEdit = await team.call('POST', '/api/data/edit', { company: a.id, period: '2026-09', section: 'company', values: { company_code: 'AE-0002', period: '2026-01', notes: 'Reviewed with the MD', other_income: '5,000' } });
  assert.strictEqual(formEdit.status, 200, JSON.stringify(formEdit.body));
  const after = (await mdA.call('GET', '/api/data?period=2026-09')).body.data.company;
  assert.strictEqual(after.company_code, 'AE-0001', 'code cannot be changed by an edit');
  assert.strictEqual(after.period, '2026-09', 'month cannot be changed by an edit');
  assert.strictEqual(after.notes, 'Reviewed with the MD');
  assert.strictEqual(after.other_income, 5000);
  assert.strictEqual((await team.call('POST', '/api/data/edit', { company: b.id, period: '2026-07', section: 'expenses', values: [] })).status, 404);

  // Restoring version 1 brings the original expenses back, as a new version.
  const restore = await team.call('POST', '/api/data/restore', { company: a.id, period: '2026-09', version: 1 });
  assert.strictEqual(restore.status, 200);
  dash = await mdA.call('GET', '/api/dashboard');
  assert.notStrictEqual(dash.body.analysis.months[2].opex, 175000);

  // Removing a month takes it off the dashboard; it stays in history and can be restored.
  assert.strictEqual((await team.call('POST', '/api/data/remove-month', { company: a.id, period: '2026-07' })).status, 200);
  assert.deepStrictEqual((await mdA.call('GET', '/api/dashboard')).body.periods, ['2026-08', '2026-09']);
  assert.strictEqual((await mdA.call('GET', '/api/data?period=2026-07')).status, 404);
  assert.strictEqual((await team.call('POST', '/api/data/restore', { company: a.id, period: '2026-07', version: 1 })).status, 200);
  assert.deepStrictEqual((await mdA.call('GET', '/api/dashboard')).body.periods, ['2026-07', '2026-08', '2026-09']);
  const hist = await team.call('GET', `/api/uploads?company=${a.id}`);
  assert.deepStrictEqual(hist.body.uploads.slice(0, 3).map((x) => x.source), ['Restored v1', 'Month removed', 'Restored v1']);

  const mdB = client(port);
  await mdB.login('md@b.test');
  assert.strictEqual((await mdB.call('GET', `/api/dashboard?company=${a.id}`)).status, 403, 'client B must not read A');
  assert.strictEqual((await mdB.call('GET', `/api/data?company=${a.id}&period=2026-09`)).status, 403);
  assert.deepStrictEqual((await mdB.call('GET', '/api/dashboard')).body.periods, ['2026-08', '2026-09']);

  // Explanations: the team sees suggestions and decides; the client sees only what was accepted.
  assert.strictEqual((await mdA.call('GET', '/api/insights?period=2026-09')).status, 403, 'suggestions are for the team');
  assert.strictEqual((await mdA.call('POST', '/api/insights/review', { period: '2026-09', key: 'margin', status: 'accepted', headline: 'x', body: 'y' })).status, 403);
  const ins = await team.call('GET', `/api/insights?company=${a.id}&period=2026-09`);
  assert.strictEqual(ins.status, 200);
  const margin = ins.body.items.find((x) => x.draft && x.draft.key === 'margin');
  assert.ok(margin, 'a margin movement is explained');
  assert.ok(margin.draft.causes.some((c) => /Purchase rates went up/.test(c.text)), 'purchase rates are among the causes');
  assert.ok(margin.draft.suggested.length >= 1);
  assert.deepStrictEqual((await mdA.call('GET', '/api/dashboard')).body.insights, [], 'nothing is shown before review');
  const accept = await team.call('POST', '/api/insights/review', { company: a.id, period: '2026-09', key: 'margin', area: 'Margin', status: 'accepted', headline: 'Margin fell on resin prices', body: 'Resin rates rose.', causes: [margin.draft.causes[0].text] });
  assert.strictEqual(accept.status, 200, JSON.stringify(accept.body));
  await team.call('POST', '/api/insights/review', { company: a.id, period: '2026-09', key: 'expenses', area: 'Expenses', status: 'set-aside', headline: 'Not for the client', body: '' });
  const seen = (await mdA.call('GET', '/api/dashboard')).body.insights;
  assert.deepStrictEqual(seen.map((x) => x.headline), ['Margin fell on resin prices'], 'only accepted explanations reach the client');
  assert.strictEqual(seen[0].reviewed_by, undefined, 'clients do not see reviewer names');
  assert.deepStrictEqual((await mdB.call('GET', '/api/dashboard')).body.insights, [], 'another client sees none of them');
  const reviewed = await team.call('GET', `/api/insights?company=${a.id}&period=2026-09`);
  assert.strictEqual(reviewed.body.items.find((x) => x.draft && x.draft.key === 'margin').review.status, 'accepted');
  // A later edit to the month marks the review as based on older figures.
  await team.call('POST', '/api/data/edit', { company: a.id, period: '2026-09', section: 'company', values: { notes: 'Checked' } });
  assert.strictEqual((await team.call('GET', `/api/insights?company=${a.id}&period=2026-09`)).body.items.find((x) => x.review && x.review.key === 'margin').stale, true);
  assert.strictEqual((await team.call('POST', '/api/insights/review', { company: a.id, period: '2026-09', key: 'margin', status: 'draft' })).status, 200);
  assert.deepStrictEqual((await mdA.call('GET', '/api/dashboard')).body.insights, [], 'withdrawn explanations disappear');

  const actions = db.prepare('SELECT action FROM audit').all().map((x) => x.action);
  for (const x of ['upload.accepted', 'upload.wrong_company', 'insight.accepted', 'insight.withdrawn', 'data.edited', 'data.restored', 'data.month_removed']) assert.ok(actions.includes(x), `audit has ${x}`);
  await mdA.call('POST', '/api/logout');
  assert.strictEqual((await mdA.call('GET', '/api/me')).status, 401);
});

test('first-release logins are carried over to the new roles', (t) => {
  const os = require('os');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE companies (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'accountant', 'advisor')), company_id INTEGER REFERENCES companies(id),
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CHECK (role = 'advisor' OR company_id IS NOT NULL));
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    INSERT INTO companies (code, name) VALUES ('AE-0001', 'Alpha');
    INSERT INTO users (email, name, role, company_id, password_hash) VALUES ('v@a', 'V', 'viewer', 1, 'x'), ('acc@a', 'A', 'accountant', 1, 'x'), ('adv@x', 'D', 'advisor', NULL, 'x');
    INSERT INTO sessions VALUES ('t', 2, 0);`);
  old.close();
  const db = store.open(file);
  assert.deepStrictEqual(db.prepare('SELECT email, role FROM users ORDER BY id').all().map((r) => `${r.email}:${r.role}`), ['v@a:client', 'acc@a:client', 'adv@x:admin']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'sessions survive the change');
  assert.throws(() => db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES ('c@x', 'C', 'client', 'x')").run());
  db.close();
});

test('static files cannot escape the public folder', async (t) => {
  const db = store.open(':memory:');
  const server = http.createServer(createApp(db)).listen(0);
  t.after(() => server.close());
  const res = await new Promise((r) => http.get({ port: server.address().port, path: '/..%2fserver%2fdb.js' }, r));
  assert.strictEqual(res.statusCode, 404);
});

test('first sign-in, two-step login, admin, disable, idle timeout and audit', async (t) => {
  const db = store.open(':memory:');
  const co = store.createCompany(db, 'AE-0001', 'Alpha');
  store.createUser(db, { email: 'lead@assura.test', name: 'Lead', role: 'admin', companyId: null, password: 'test-password-1' });
  const server = http.createServer(createApp(db)).listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const lead = client(port);
  await lead.login('lead@assura.test');
  const secret = await enrolStaff(lead);
  assert.strictEqual((await lead.call('GET', '/api/admin/overview')).status, 200);

  // Second sign-in needs the code; a wrong or replayed code is refused.
  const again = client(port);
  const noCode = await again.login('lead@assura.test');
  assert.strictEqual(noCode.status, 401); assert.strictEqual(noCode.body.needCode, true);
  assert.strictEqual((await again.login('lead@assura.test', { code: '000000' })).status, 401);
  const step = Math.floor(Date.now() / 30000) + 1; // the next step is accepted once, never twice
  const good = totp.codeAt(secret, step);
  assert.strictEqual((await again.login('lead@assura.test', { code: good })).status, 200);
  assert.strictEqual((await client(port).login('lead@assura.test', { code: good })).status, 401, 'a code cannot be reused');

  // The admin adds a client login; it gets a one-time password and must change it.
  const bad = await lead.call('POST', '/api/admin/user', { name: 'X', email: 'not-an-email', role: 'client', company_id: co.id });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await lead.call('POST', '/api/admin/user', { name: 'X', email: 'x@alpha.test', role: 'client' })).status, 400, 'a client login needs a company');
  const add = await lead.call('POST', '/api/admin/user', { name: 'MD Alpha', email: 'MD@alpha.test', role: 'client', company_id: co.id });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const temp = add.body.temporaryPassword;
  assert.match(temp, /^[A-Za-z0-9]{7}-[A-Za-z0-9]{7}$/);
  assert.strictEqual((await lead.call('POST', '/api/admin/user', { name: 'Dup', email: 'md@alpha.test', role: 'client', company_id: co.id })).status, 409);

  // Only an admin adds team logins; a team member manages clients but not the team.
  const addTeam = await lead.call('POST', '/api/admin/user', { name: 'Team One', email: 'one@assura.test', role: 'team' });
  assert.strictEqual(addTeam.status, 200, JSON.stringify(addTeam.body));
  const one = client(port);
  await one.call('POST', '/api/login', { email: 'one@assura.test', password: addTeam.body.temporaryPassword });
  await one.call('POST', '/api/password', { current: addTeam.body.temporaryPassword, next: 'blue-harbour-lantern-42' });
  await enrolStaff(one);
  assert.strictEqual((await one.call('GET', '/api/admin/overview')).status, 200);
  assert.strictEqual((await one.call('POST', '/api/admin/user', { name: 'Two', email: 'two@assura.test', role: 'team' })).status, 403);
  assert.strictEqual((await one.call('POST', '/api/admin/user', { name: 'Two', email: 'two@assura.test', role: 'admin' })).status, 403);
  assert.strictEqual((await one.call('POST', '/api/admin/user/action', { user_id: 1, action: 'disable' })).status, 403, 'team cannot switch off an admin');
  assert.strictEqual((await one.call('POST', '/api/admin/company/update', { company_id: co.id, name: 'Alpha Industries' })).status, 200);
  assert.strictEqual(db.prepare('SELECT name FROM companies WHERE id = ?').get(co.id).name, 'Alpha Industries');

  assert.strictEqual((await client(port).call('POST', '/api/login', { email: 'md@alpha.test', password: 'not-the-password' })).status, 401);
  const md = client(port);
  const first = await md.call('POST', '/api/login', { email: 'md@alpha.test', password: temp });
  assert.strictEqual(first.body.next, 'change-password');
  assert.strictEqual((await md.call('GET', '/api/dashboard')).status, 403, 'no data before the password is changed');
  assert.strictEqual((await md.call('POST', '/api/password', { current: temp, next: 'short' })).status, 400);
  assert.strictEqual((await md.call('POST', '/api/password', { current: 'wrong', next: 'a-long-new-passphrase' })).status, 400);
  const changed = await md.call('POST', '/api/password', { current: temp, next: 'a-long-new-passphrase' });
  assert.strictEqual(changed.status, 200); assert.strictEqual(changed.body.next, null);
  assert.strictEqual((await md.call('GET', '/api/dashboard')).status, 200);
  assert.strictEqual((await md.call('GET', '/api/admin/overview')).status, 403, 'clients cannot reach administration');
  assert.strictEqual((await md.call('POST', '/api/admin/company', { code: 'AE-0002', name: 'Beta' })).status, 403);

  // Idle sessions expire.
  db.prepare('UPDATE sessions SET last_seen = ? WHERE user_id = ?').run(Date.now() - 1000 * 60 * 60 * 24, add.body.user.id);
  assert.strictEqual((await md.call('GET', '/api/me')).status, 401);

  // Switching a login off ends its sessions and blocks sign-in.
  const md2 = client(port);
  await md2.call('POST', '/api/login', { email: 'md@alpha.test', password: 'a-long-new-passphrase' });
  assert.strictEqual((await md2.call('GET', '/api/me')).status, 200);
  assert.strictEqual((await lead.call('POST', '/api/admin/user/action', { user_id: add.body.user.id, action: 'disable' })).status, 200);
  assert.strictEqual((await md2.call('GET', '/api/me')).status, 401);
  assert.strictEqual((await client(port).call('POST', '/api/login', { email: 'md@alpha.test', password: 'a-long-new-passphrase' })).status, 401);
  assert.strictEqual((await lead.call('POST', '/api/admin/user/action', { user_id: 1, action: 'disable' })).status, 400, 'admins cannot switch themselves off');

  // Password reset issues a new one-time password.
  await lead.call('POST', '/api/admin/user/action', { user_id: add.body.user.id, action: 'enable' });
  const reset = await lead.call('POST', '/api/admin/user/action', { user_id: add.body.user.id, action: 'reset-password' });
  assert.ok(reset.body.temporaryPassword);
  assert.strictEqual((await client(port).call('POST', '/api/login', { email: 'md@alpha.test', password: reset.body.temporaryPassword })).body.next, 'change-password');

  const actions = (await lead.call('GET', '/api/admin/overview')).body.activity.map((x) => x.action);
  for (const a of ['login', 'login.failed', 'login.code_failed', 'login.disabled', '2fa.enabled', 'admin.user_added', 'password.changed', 'dashboard.viewed', 'admin.disable', 'admin.reset-password'])
    assert.ok(actions.includes(a), `audit has ${a}`);
});

test('backups are encrypted and restore to the same data', (t) => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.AE_BACKUP_KEY = 'test-backup-key-0123456789';
  const blob = backupTool.encrypt(Buffer.from('hello'));
  assert.ok(!blob.includes(Buffer.from('hello')));
  assert.strictEqual(backupTool.decrypt(blob).toString(), 'hello');
  const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => backupTool.decrypt(tampered));

  const live = path.join(dir, 'live.db');
  const db = store.open(live); store.createCompany(db, 'AE-0042', 'Backup Co'); db.close();
  process.env.AE_BACKUP_DIR = path.join(dir, 'b');
  const file = backupTool.backup(live);
  const restored = path.join(dir, 'restored.db');
  fs.writeFileSync(restored, backupTool.decrypt(fs.readFileSync(file)));
  const r = store.open(restored);
  assert.strictEqual(r.prepare('SELECT name FROM companies WHERE code = ?').get('AE-0042').name, 'Backup Co');
});

test('the monthly workbook is filled for one client and month, sent from the portal, and only that copy is accepted back', async (t) => {
  const net = require('net');
  // A stand-in mail server that records what it receives.
  const received = [];
  const smtp = net.createServer((sock) => {
    let data = false; let msg = '';
    sock.on('error', () => {});
    sock.write('220 test\r\n');
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n')) {
        if (data) { if (line === '.') { data = false; received.push(msg); sock.write('250 queued\r\n'); } else msg += line + '\r\n'; continue; }
        if (/^EHLO/.test(line)) sock.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (/^AUTH LOGIN/.test(line)) sock.write('334 VXNlcm5hbWU6\r\n');
        else if (line === Buffer.from('mailer').toString('base64')) sock.write('334 UGFzc3dvcmQ6\r\n');
        else if (line === Buffer.from('secret').toString('base64')) sock.write('235 ok\r\n');
        else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; msg = ''; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') sock.end('221 bye\r\n');
      }
    });
  }).listen(0);
  t.after(() => smtp.close());

  const db = store.open(':memory:');
  const a = store.createCompany(db, 'AE-0001', 'Meridian Polymers Pvt Ltd');
  const b = store.createCompany(db, 'AE-0002', 'Coastline Foods Pvt Ltd');
  const pw = 'test-password-1';
  store.createUser(db, { email: 'md@a.test', name: 'MD A', role: 'client', companyId: a.id, password: pw });
  store.createUser(db, { email: 'team@x.test', name: 'Farzeen', role: 'team', companyId: null, password: pw });
  const mailCfg = { host: '127.0.0.1', port: smtp.address().port, user: 'mailer', pass: 'secret', from: 'Assura Elevate <data@elevateassura.test>', secure: 'none' };
  const server = http.createServer(createApp(db, { mail: mailCfg })).listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const team = client(port); await team.login('team@x.test'); await enrolStaff(team);
  const mdA = client(port); await mdA.login('md@a.test');

  assert.strictEqual((await mdA.call('POST', '/api/workbooks/send', { period: '2026-09', method: 'download' })).status, 403, 'clients cannot issue workbooks');
  assert.strictEqual((await team.call('POST', '/api/workbooks/send', { company: a.id, period: '2026-09', method: 'email' })).status, 400, 'no accounts email saved yet');
  assert.strictEqual((await team.call('POST', '/api/admin/company/update', { company_id: a.id, data_email: 'not-an-email' })).status, 400);
  assert.strictEqual((await team.call('POST', '/api/admin/company/update', { company_id: a.id, data_email: 'Accounts@Meridian.test' })).status, 200);

  // Emailed from the portal to the saved address, with the filled workbook attached.
  const sent = await team.call('POST', '/api/workbooks/send', { company: a.id, period: '2026-09', method: 'email' });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
  assert.match(sent.body.ref, /^AE-0001-2026-09-[A-Z2-9]{6}$/);
  assert.deepStrictEqual(sent.body.sent_to, ['accounts@meridian.test']);
  assert.strictEqual(received.length, 1);
  assert.match(received[0], /To: accounts@meridian\.test/);
  assert.match(received[0], /Reply-To: Farzeen <team@x\.test>/);
  assert.match(received[0], /filename="AE-0001_Meridian_Polymers_Pvt_Ltd_2026-09\.xlsx"/);
  const attachment = Buffer.from(received[0].split('filename="AE-0001_Meridian_Polymers_Pvt_Ltd_2026-09.xlsx"')[1].split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64');
  const tmp = path.join(require('os').tmpdir(), `ae-wb-${process.pid}.xlsx`); t.after(() => fs.rmSync(tmp, { force: true }));
  fs.writeFileSync(tmp, attachment);
  const filled = xlsxRows(tmp)['Company & Period'];
  const val = (label) => (filled.find((r) => r[0] === label) || [])[1];
  assert.strictEqual(val('Company Code'), 'AE-0001');
  assert.strictEqual(val('Company Name'), 'Meridian Polymers Pvt Ltd');
  assert.strictEqual(val('Period (Month)'), '2026-09');
  assert.strictEqual(val('Workbook Reference'), sent.body.ref);

  // The accountant fills it in and sends it back: it is accepted for Meridian, September only.
  const filledIn = xlsxRows(tmp);
  const data = sample('AE-0001', '2026-09');
  filledIn['Company & Period'].forEach((r) => { if (r[0] === 'Prepared By') r[1] = 'R. Menon'; });
  filledIn.Sales = [['Invoice Date', 'Invoice No', 'Customer', 'Customer Type (B2B/B2C)', 'Product / Service', 'Taxable Value']].concat(data.sales.slice(0, 5).map((x) => [x.date, x.invoice_no, x.customer, x.customer_type, x.product, x.taxable_value]));
  assert.match((await team.call('POST', '/api/upload', { company: b.id, sheets: filledIn })).body.errors.join('\n'), /issued to Meridian Polymers Pvt Ltd \(AE-0001\), not to Coastline/);
  const ok = await team.call('POST', '/api/upload', { company: a.id, sheets: filledIn, filename: 'back.xlsx' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const list = await team.call('GET', `/api/workbooks?company=${a.id}`);
  assert.strictEqual(list.body.mail_ready, true);
  assert.strictEqual(list.body.workbooks[0].ref, sent.body.ref);
  assert.strictEqual(list.body.workbooks[0].received_version, 1);

  // A downloaded copy is a separate copy with its own reference.
  const dl = await team.call('POST', '/api/workbooks/send', { company: a.id, period: '2026-10', method: 'download' });
  assert.strictEqual(dl.status, 200);
  assert.notStrictEqual(dl.body.ref, sent.body.ref);
  assert.ok(Buffer.from(dl.body.file, 'base64').length > 10000);
  const actions = db.prepare('SELECT action FROM audit').all().map((x) => x.action);
  for (const x of ['workbook.emailed', 'workbook.downloaded', 'admin.company_email']) assert.ok(actions.includes(x), x);
});

test('the team sees each client\'s month: sent, received, uploaded, reviewed, with overdue reminders; the client sees a plain note', async (t) => {
  const db = store.open(':memory:');
  const a = store.createCompany(db, 'AE-0001', 'Meridian Polymers Pvt Ltd');
  const b = store.createCompany(db, 'AE-0002', 'Coastline Foods Pvt Ltd');
  const pw = 'test-password-1';
  store.createUser(db, { email: 'md@a.test', name: 'MD A', role: 'client', companyId: a.id, password: pw });
  store.createUser(db, { email: 'team@x.test', name: 'Farzeen', role: 'team', companyId: null, password: pw });
  let clock = new Date('2026-10-05T06:00:00Z');
  const server = http.createServer(createApp(db, { mail: null, now: () => clock })).listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const team = client(port); await team.login('team@x.test'); await enrolStaff(team);
  const mdA = client(port); await mdA.login('md@a.test');
  assert.strictEqual((await mdA.call('GET', '/api/cycle')).status, 403, 'clients do not see the team\'s work');
  assert.strictEqual((await team.call('GET', '/api/me')).body.workflow, fs.existsSync(path.join(ROOT, 'public', 'workflow.html')), 'team logins start in Workflow only where it is installed');
  assert.strictEqual((await mdA.call('GET', '/api/me')).body.workflow, false);

  const states = (row) => row.status.steps.map((s) => `${s.key}:${s.state}`).join(' ');
  let work = await team.call('GET', '/api/cycle');
  assert.strictEqual(work.body.period, '2026-09');
  assert.strictEqual(work.body.clients.length, 2);
  const rowA = () => work.body.clients.find((c) => c.company.id === a.id);
  assert.strictEqual(states(rowA()), 'send:overdue receive:later upload:later review:later', 'the workbook was due out by the 3rd');
  assert.match((await mdA.call('GET', '/api/dashboard')).body.cycle.text, /will send this month's data workbook/);

  const sent = await team.call('POST', '/api/workbooks/send', { company: a.id, period: '2026-09', method: 'download' });
  work = await team.call('GET', '/api/cycle');
  assert.strictEqual(states(rowA()), 'send:done receive:due upload:later review:later');
  assert.match((await mdA.call('GET', '/api/dashboard')).body.cycle.text, /sent to your accountant/);

  clock = new Date('2026-10-11T06:00:00Z');
  work = await team.call('GET', '/api/cycle');
  assert.strictEqual(rowA().status.next.key, 'receive');
  assert.strictEqual(rowA().status.overdue, 1, 'not back by the 10th');
  const note = (await mdA.call('GET', '/api/dashboard')).body.cycle;
  assert.ok(note.overdue && /not been returned yet/.test(note.text));
  assert.ok(!JSON.stringify(note).includes('Farzeen'), 'no team names on the client side');

  assert.strictEqual((await team.call('POST', '/api/workbooks/received', { company: b.id, ref: sent.body.ref })).status, 404, 'another client\'s reference');
  assert.strictEqual((await team.call('POST', '/api/workbooks/received', { company: a.id, ref: sent.body.ref })).status, 200);
  work = await team.call('GET', '/api/cycle');
  assert.strictEqual(states(rowA()), 'send:done receive:done upload:due review:later');

  const up = await team.call('POST', '/api/upload', { company: a.id, sheets: (() => {
    const tmp = path.join(require('os').tmpdir(), `ae-cy-${process.pid}.xlsx`); t.after(() => fs.rmSync(tmp, { force: true }));
    fs.writeFileSync(tmp, Buffer.from(sent.body.file, 'base64'));
    const s = xlsxRows(tmp); const data = sample('AE-0001', '2026-09');
    s['Company & Period'].forEach((r) => { if (r[0] === 'Prepared By') r[1] = 'R. Menon'; });
    s.Sales = [['Invoice Date', 'Invoice No', 'Customer', 'Customer Type (B2B/B2C)', 'Product / Service', 'Taxable Value']].concat(data.sales.map((x) => [x.date, x.invoice_no, x.customer, x.customer_type, x.product, x.taxable_value]));
    return s;
  })() });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  const one = await team.call('GET', `/api/cycle?company=${a.id}`);
  assert.strictEqual(one.body.status.steps.find((s) => s.key === 'upload').state, 'done');
  assert.strictEqual((await mdA.call('GET', '/api/dashboard')).body.cycle, null, 'once the month is on the dashboard the note goes');
  assert.strictEqual((await mdA.call('GET', `/api/cycle?company=${a.id}`)).status, 403);
});
