'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const store = require('../server/db');
const W = require('../shared/workflow');
const { createApp } = require('../server/server');

const PW = 'long-enough-password';

function setup(today = '2026-10-16') {
  const db = store.open(':memory:');
  W.install(db);
  const wf = W.createWorkflow(db, { today: () => today });
  const user = (email, role = 'team', companyId = null) => store.createUser(db, { email, name: email.split('@')[0], role, companyId, password: PW });
  const admin = user('admin@x.in', 'admin');
  const call = (u, route, body = {}, query = {}) => wf.call(u, route, query, body);
  const place = (u, level, department) => call(admin, 'POST /api/wf/staff', { user_id: u.id, level, department });
  const md = user('md@x.in'); place(md, 'md');
  const dir = user('dir@x.in'); place(dir, 'director', 'ca');
  const mgr = user('mgr@x.in'); place(mgr, 'manager', 'ca');
  const sen = user('sen@x.in'); place(sen, 'senior', 'ca');
  const ana = user('ana@x.in'); place(ana, 'analyst', 'ca');
  const other = user('other@x.in'); place(other, 'analyst', 'ca');
  const team = call(admin, 'POST /api/wf/team', { department: 'ca', name: 'CA Team 1', manager_id: mgr.id, senior_id: sen.id, analyst_id: ana.id, capacity: 2 }).id;
  const team2 = call(admin, 'POST /api/wf/team', { department: 'ca', name: 'CA Team 2', analyst_id: other.id }).id;
  const c1 = store.createCompany(db, 'AE-0001', 'One');
  const c2 = store.createCompany(db, 'AE-0002', 'Two');
  call(admin, 'POST /api/wf/allot', { company_id: c1.id, department: 'ca', team_id: team, target_day: 15 });
  return { db, wf, call, admin, md, dir, mgr, sen, ana, other, team, team2, c1, c2, user };
}

test('monthly cycle creates each department task once, due on the client target day', () => {
  const s = setup();
  const r = s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' });
  assert.strictEqual(r.created, W.MONTHLY.ca.length);
  assert.strictEqual(s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' }).created, 0);
  const t = s.db.prepare('SELECT * FROM wf_tasks LIMIT 1').get();
  assert.strictEqual(t.due_date, '2026-10-15');
  assert.strictEqual(W.dueFor('2026-01', 31), '2026-02-28');
});

test('maker-checker chain: analyst, senior, manager, director; nobody checks their own work', () => {
  const s = setup('2026-10-05');
  s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' });
  const id = s.db.prepare('SELECT id FROM wf_tasks LIMIT 1').get().id;
  const act = (u, action, note) => s.call(u, 'POST /api/wf/task/action', { id, action, note });
  assert.throws(() => act(s.sen, 'approve'), /Submit the work first/);
  assert.deepStrictEqual(s.call(s.ana, 'GET /api/wf/home').mine.map((t) => t.id).includes(id), true);
  assert.strictEqual(act(s.ana, 'submit').stage, 'review');
  assert.throws(() => act(s.ana, 'approve'), /waiting on the senior analyst/);
  assert.throws(() => act(s.sen, 'return'), /Say what needs to change/);
  assert.strictEqual(act(s.sen, 'return', 'Attach the reconciliation').stage, 'preparation');
  act(s.ana, 'submit');
  assert.strictEqual(act(s.sen, 'approve').stage, 'manager');
  assert.strictEqual(act(s.mgr, 'approve').stage, 'signoff');
  assert.strictEqual(act(s.dir, 'approve').stage, 'done');
  const t = s.call(s.dir, 'GET /api/wf/task', {}, { id });
  assert.strictEqual(t.task.timeliness, 'on_time');
  assert.deepStrictEqual(t.events.map((e) => e.action), ['create', 'submit', 'return', 'submit', 'approve', 'approve', 'approve']);
});

test('a senior who prepares the work goes straight to the manager; a director approval covers the steps below', () => {
  const s = setup();
  s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' });
  const id = s.db.prepare('SELECT id FROM wf_tasks LIMIT 1').get().id;
  assert.strictEqual(s.call(s.sen, 'POST /api/wf/task/action', { id, action: 'submit' }).stage, 'manager');
  const id2 = s.db.prepare('SELECT id FROM wf_tasks WHERE id <> ? LIMIT 1').get(id).id;
  s.call(s.ana, 'POST /api/wf/task/action', { id: id2, action: 'submit' });
  // The director can step in at any step of the department; their approval covers the steps below them.
  assert.strictEqual(s.call(s.dir, 'POST /api/wf/task/action', { id: id2, action: 'approve' }).stage, 'done');
});

test('a flag sends the task to the MD after department sign-off', () => {
  const s = setup();
  s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' });
  const id = s.db.prepare('SELECT id FROM wf_tasks LIMIT 1').get().id;
  s.call(s.ana, 'POST /api/wf/task/flag', { id, reason: 'Input credit mismatch with GSTR-2B' });
  for (const u of [s.ana, s.sen, s.mgr]) s.call(u, 'POST /api/wf/task/action', { id, action: u === s.ana ? 'submit' : 'approve' });
  assert.strictEqual(s.call(s.dir, 'POST /api/wf/task/action', { id, action: 'approve' }).stage, 'md');
  assert.strictEqual(s.call(s.md, 'GET /api/wf/home').flags.length, 1);
  assert.ok(s.call(s.md, 'GET /api/wf/home').mine.some((t) => t.id === id));
  assert.throws(() => s.call(s.dir, 'POST /api/wf/flag/resolve', { flag_id: 1, resolution: 'ok' }), /Only the Managing Director/);
  assert.throws(() => s.call(s.md, 'POST /api/wf/task/action', { id, action: 'approve' }), /Add a note/);
  assert.strictEqual(s.call(s.md, 'POST /api/wf/task/action', { id, action: 'approve', note: 'Reverse the excess credit' }).stage, 'done');
  assert.strictEqual(s.db.prepare("SELECT COUNT(*) AS n FROM wf_flags WHERE status = 'open'").get().n, 0);
});

test('people see only their own teams; directors their department; client logins are refused', () => {
  const s = setup();
  s.call(s.admin, 'POST /api/wf/allot', { company_id: s.c2.id, department: 'ca', team_id: s.team2, target_day: 20 });
  s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' });
  const n = W.MONTHLY.ca.length;
  assert.strictEqual(s.call(s.ana, 'GET /api/wf/tasks').tasks.length, n);
  assert.strictEqual(s.call(s.other, 'GET /api/wf/tasks').tasks.length, n);
  assert.strictEqual(s.call(s.dir, 'GET /api/wf/tasks').tasks.length, 2 * n);
  const foreign = s.db.prepare('SELECT id FROM wf_tasks WHERE company_id = ?').get(s.c2.id).id;
  assert.throws(() => s.call(s.ana, 'GET /api/wf/task', {}, { id: foreign }), /another team/);
  assert.deepStrictEqual(s.call(s.ana, 'GET /api/wf/clients').clients.map((c) => c.code), ['AE-0001']);
  const client = s.user('c@client.in', 'client', s.c1.id);
  assert.throws(() => s.call(client, 'GET /api/wf/me'), /Assura Elevate team only/);
  const unplaced = s.user('new@x.in');
  assert.throws(() => s.call(unplaced, 'GET /api/wf/home'), /not been given a place/);
  assert.throws(() => s.call(s.ana, 'POST /api/wf/staff', { user_id: s.ana.id, level: 'md' }), /Only the MD or an admin/);
});

test('team capacity is enforced and late work is flagged as delayed', () => {
  const s = setup('2026-10-20');
  s.call(s.admin, 'POST /api/wf/allot', { company_id: s.c2.id, department: 'ca', team_id: s.team, target_day: 25 });
  const c3 = store.createCompany(s.db, 'AE-0003', 'Three');
  assert.throws(() => s.call(s.admin, 'POST /api/wf/allot', { company_id: c3.id, department: 'ca', team_id: s.team }), /full capacity of 2/);
  s.call(s.dir, 'POST /api/wf/cycle', { period: '2026-09' });
  const rows = s.call(s.dir, 'GET /api/wf/tasks', {}, { company: s.c1.id }).tasks;
  assert.ok(rows.every((t) => t.timeliness === 'delayed' && t.days_late === 5));
  const later = s.call(s.dir, 'GET /api/wf/tasks', {}, { company: s.c2.id }).tasks;
  assert.ok(later.every((t) => t.timeliness === 'behind')); // preparation was due 19 Oct
  assert.throws(() => s.call(s.ana, 'POST /api/wf/task/reschedule', { id: rows[0].id, due_date: '2026-10-30', note: 'x' }), /manager or above/);
  s.call(s.mgr, 'POST /api/wf/task/reschedule', { id: rows[0].id, due_date: '2026-10-30', note: 'Client data arrived late' });
  assert.strictEqual(s.call(s.mgr, 'GET /api/wf/task', {}, { id: rows[0].id }).task.timeliness, 'on_track');
});

test('workflow API over HTTP: client logins and signed-out requests are refused; the page is served', async () => {
  const db = store.open(':memory:');
  const app = createApp(db);
  const c = store.createCompany(db, 'AE-0001', 'One');
  store.createUser(db, { email: 'admin@x.in', name: 'Admin', role: 'admin', password: PW });
  store.createUser(db, { email: 'c@x.in', name: 'Client', role: 'client', companyId: c.id, password: PW });
  const prev = process.env.AE_REQUIRE_STAFF_2FA;
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body, cookie, csrf = true) => {
    const res = await fetch(base + url, { method, headers: Object.assign({}, csrf ? { 'X-Requested-With': 'assura' } : {}, body ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}), body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const cl = await req('POST', '/api/login', { email: 'c@x.in', password: PW });
    assert.strictEqual((await req('GET', '/api/wf/me', null, cl.cookie)).status, 403);
    assert.strictEqual((await req('GET', '/api/wf/me')).status, 401);
    const page = await fetch(base + '/workflow');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /workflow\.js/);
  } finally { server.close(); process.env.AE_REQUIRE_STAFF_2FA = prev; }
});
