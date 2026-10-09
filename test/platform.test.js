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

// Completes an advisor's first sign-in: enrols two-step login and returns the secret.
async function enrolAdvisor(c) {
  const start = await c.call('POST', '/api/2fa/start');
  assert.strictEqual(start.status, 200);
  const code = totp.codeAt(start.body.secret, Math.floor(Date.now() / 30000));
  const done = await c.call('POST', '/api/2fa/confirm', { code });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  return start.body.secret;
}

test('each login sees only its own company; uploads build history', async (t) => {
  const db = store.open(':memory:');
  const a = store.createCompany(db, 'AE-0001', 'Alpha');
  const b = store.createCompany(db, 'AE-0002', 'Beta');
  const pw = 'test-password-1';
  store.createUser(db, { email: 'md@a.test', name: 'MD A', role: 'viewer', companyId: a.id, password: pw });
  store.createUser(db, { email: 'acc@a.test', name: 'Acc A', role: 'accountant', companyId: a.id, password: pw });
  store.createUser(db, { email: 'md@b.test', name: 'MD B', role: 'viewer', companyId: b.id, password: pw });
  store.createUser(db, { email: 'adv@x.test', name: 'Adv', role: 'advisor', companyId: null, password: pw });
  for (const p of ['2026-08', '2026-09']) store.saveUpload(db, { companyId: b.id, period: p, userId: null, filename: 'seed', sections: [], warnings: [], data: sample('AE-0002', p) });

  const server = http.createServer(createApp(db)).listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const anon = client(port);
  assert.strictEqual((await anon.call('GET', '/api/me')).status, 401);
  assert.strictEqual((await anon.call('GET', `/api/dashboard?company=${b.id}`)).status, 401);
  assert.strictEqual((await anon.call('POST', '/api/login', { email: 'md@a.test', password: 'wrong-password' })).status, 401);

  const mdA = client(port);
  assert.strictEqual((await mdA.login('md@a.test')).status, 200);
  const me = await mdA.call('GET', '/api/me');
  assert.deepStrictEqual(me.body.companies.map((c) => c.code), ['AE-0001']);
  assert.strictEqual((await mdA.call('GET', '/api/dashboard')).status, 200);
  assert.strictEqual((await mdA.call('GET', `/api/dashboard?company=${b.id}`)).status, 403, 'viewer of A must not read B');
  assert.strictEqual((await mdA.call('GET', `/api/uploads?company=${b.id}`)).status, 403);
  assert.strictEqual((await mdA.call('POST', '/api/upload', { sheets: {} })).status, 403, 'viewers cannot upload');

  const accA = client(port);
  await accA.login('acc@a.test');
  // Upload of company B's workbook into A is refused by company code.
  const wbB = xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0002', '2026-09.xlsx'));
  const wrong = await accA.call('POST', '/api/upload', { filename: 'b.xlsx', sheets: wbB });
  assert.strictEqual(wrong.status, 422);
  assert.match(wrong.body.errors[0], /company code AE-0002/);
  // Explicitly targeting B is refused by access control.
  assert.strictEqual((await accA.call('POST', '/api/upload', { company: b.id, filename: 'b.xlsx', sheets: wbB })).status, 403);
  // Missing CSRF header is refused.
  assert.strictEqual((await accA.call('POST', '/api/upload', { sheets: {} }, { 'X-Requested-With': '' })).status, 403);

  for (const p of ['2026-07', '2026-08', '2026-09']) {
    const wb = xlsxRows(path.join(ROOT, 'samples', 'xlsx', 'AE-0001', `${p}.xlsx`));
    const r = await accA.call('POST', '/api/upload', { filename: `${p}.xlsx`, sheets: wb });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
  let dash = await mdA.call('GET', '/api/dashboard');
  assert.deepStrictEqual(dash.body.periods, ['2026-07', '2026-08', '2026-09']);
  const revBefore = dash.body.analysis.months[2].revenue;

  // CSV-style single-section upload replaces one section of a month, as a new version.
  const csv = [['Expense Head', 'Expense Group', 'Amount'], ['Salaries and wages', 'Employee Cost', '100']];
  const up = await accA.call('POST', '/api/upload', { filename: 'expenses.csv', section: 'expenses', period: '2026-09', sheets: { 'expenses.csv': csv } });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.strictEqual(up.body.version, 2);
  dash = await mdA.call('GET', '/api/dashboard');
  assert.strictEqual(dash.body.analysis.months[2].opex, 100);
  assert.strictEqual(dash.body.analysis.months[2].revenue, revBefore);
  const hist = await mdA.call('GET', '/api/uploads');
  assert.strictEqual(hist.body.uploads.length, 4);

  const mdB = client(port);
  await mdB.login('md@b.test');
  assert.strictEqual((await mdB.call('GET', `/api/dashboard?company=${a.id}`)).status, 403, 'viewer of B must not read A');
  assert.deepStrictEqual((await mdB.call('GET', '/api/dashboard')).body.periods, ['2026-08', '2026-09']);

  const adv = client(port);
  assert.strictEqual((await adv.login('adv@x.test')).body.next, 'enrol-2fa');
  assert.strictEqual((await adv.call('GET', `/api/dashboard?company=${a.id}`)).status, 403, 'advisor must finish two-step setup first');
  await enrolAdvisor(adv);
  assert.strictEqual((await adv.call('GET', '/api/me')).body.companies.length, 2);
  assert.strictEqual((await adv.call('GET', `/api/dashboard?company=${a.id}`)).status, 200);
  assert.strictEqual((await adv.call('GET', `/api/dashboard?company=${b.id}`)).status, 200);

  await mdA.call('POST', '/api/logout');
  assert.strictEqual((await mdA.call('GET', '/api/me')).status, 401);
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
  store.createUser(db, { email: 'lead@assura.test', name: 'Lead', role: 'advisor', companyId: null, password: 'test-password-1' });
  const server = http.createServer(createApp(db)).listen(0);
  t.after(() => server.close());
  const port = server.address().port;

  const lead = client(port);
  await lead.login('lead@assura.test');
  const secret = await enrolAdvisor(lead);
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

  // Advisor adds a management login; it gets a one-time password and must change it.
  const bad = await lead.call('POST', '/api/admin/user', { name: 'X', email: 'not-an-email', role: 'viewer', company_id: co.id });
  assert.strictEqual(bad.status, 400);
  const add = await lead.call('POST', '/api/admin/user', { name: 'MD Alpha', email: 'MD@alpha.test', role: 'viewer', company_id: co.id });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const temp = add.body.temporaryPassword;
  assert.match(temp, /^[A-Za-z0-9]{7}-[A-Za-z0-9]{7}$/);
  assert.strictEqual((await lead.call('POST', '/api/admin/user', { name: 'Dup', email: 'md@alpha.test', role: 'viewer', company_id: co.id })).status, 409);

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
  assert.strictEqual((await lead.call('POST', '/api/admin/user/action', { user_id: 1, action: 'disable' })).status, 400, 'advisors cannot switch themselves off');

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
