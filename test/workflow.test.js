'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const store = require('../server/db');
const W = require('../shared/workflow');
const { createApp } = require('../server/server');

const PW = 'long-enough-password';

// Two branches. Bangalore has a full Taxation line (head > manager > supervisor > associate, analyst) and
// an Accounts associate; Calicut has a Taxation head and one associate.
function setup(today = '2026-10-05') {
  const db = store.open(':memory:');
  W.install(db);
  let now = today;
  const wf = W.createWorkflow(db, { today: () => now });
  const user = (email, role = 'team', companyId = null) => store.createUser(db, { email, name: email.split('@')[0], role, companyId, password: PW });
  const admin = user('admin@x.in', 'admin');
  const call = (u, route, body = {}, query = {}) => wf.call(u, route, query, body);
  const blr = call(admin, 'POST /api/wf/branch', { name: 'Bangalore' }).id;
  const clt = call(admin, 'POST /api/wf/branch', { name: 'Calicut' }).id;
  const place = (u, level, department, branch_id, reports_to) => { call(admin, 'POST /api/wf/staff', { user_id: u.id, level, department, branch_id, reports_to: reports_to && reports_to.id }); return u; };
  const mp = place(user('mp@x.in'), 'mp');
  const bh = place(user('bh@x.in'), 'branch_head', null, blr, mp);
  const head = place(user('head@x.in'), 'head', 'taxation', blr, bh);
  const mgr = place(user('mgr@x.in'), 'manager', 'taxation', blr, head);
  const sup = place(user('sup@x.in'), 'supervisor', 'taxation', blr, mgr);
  const asc = place(user('asc@x.in'), 'associate', 'taxation', blr, sup);
  const ana = place(user('ana@x.in'), 'analyst', 'taxation', blr, sup);
  const acc = place(user('acc@x.in'), 'associate', 'accounts', blr, bh);
  const bh2 = place(user('bh2@x.in'), 'branch_head', null, clt, mp);
  const head2 = place(user('head2@x.in'), 'head', 'taxation', clt, bh2);
  const asc2 = place(user('asc2@x.in'), 'associate', 'taxation', clt, head2);
  const onboard = (code, name, branch_id, extra = {}) => call(admin, 'POST /api/wf/client', Object.assign({ code, name, branch_id, entity_type: 'company', gstin: '29ABCDE1234F1Z5', monthly_fee: 30000, target_day: 15, billing_email: `accounts@${code.toLowerCase()}.in` }, extra)).id;
  const c1 = onboard('AE-0001', 'One', blr);
  const c2 = onboard('AE-0002', 'Two', clt);
  call(head, 'POST /api/wf/allot', { company_id: c1, division: 'direct_tax', assignee_id: asc.id });
  call(head, 'POST /api/wf/allot', { company_id: c1, division: 'indirect_tax', applicable: false, assignee_id: ana.id });
  call(head2, 'POST /api/wf/allot', { company_id: c2, division: 'direct_tax', assignee_id: asc2.id });
  return { db, wf, call, user, admin, blr, clt, mp, bh, head, mgr, sup, asc, ana, acc, bh2, head2, asc2, c1, c2, setToday: (d) => { now = d; } };
}
const taskOf = (s, company, division) => s.db.prepare('SELECT id FROM wf_tasks WHERE company_id = ? AND division = ?').get(company, division).id;

test('onboarding sets divisions by entity type; the month gives work, applicability reviews, and lists who is not allotted', () => {
  const s = setup();
  const divs = s.db.prepare('SELECT division, applicable FROM wf_allotments WHERE company_id = ? ORDER BY division').all(s.c1);
  assert.deepStrictEqual(Object.fromEntries(divs.map((d) => [d.division, d.applicable])),
    { assurance: 1, companies_act: 1, direct_tax: 1, indirect_tax: 0, labour: 0, legal: 0, llp: 0 });
  const firm = s.call(s.admin, 'POST /api/wf/client', { code: 'AE-0003', name: 'Firm', branch_id: s.blr, entity_type: 'partnership' }).id;
  const legal = s.db.prepare("SELECT applicable FROM wf_allotments WHERE company_id = ? AND division = 'legal'").get(firm);
  assert.strictEqual(legal.applicable, 1);

  const r = s.call(s.head, 'POST /api/wf/cycle', { period: '2026-09' });
  // The Bangalore Taxation head starts only Bangalore Taxation work.
  assert.strictEqual(r.created, 2);
  assert.ok(r.missing.some((m) => /Firm \(Direct Tax\)/.test(m)));
  assert.strictEqual(s.call(s.head, 'POST /api/wf/cycle', { period: '2026-09' }).created, 0);
  const review = s.db.prepare("SELECT * FROM wf_tasks WHERE division = 'indirect_tax'").get();
  assert.match(review.title, /^Applicability review/);
  assert.strictEqual(s.db.prepare("SELECT due_date FROM wf_tasks WHERE division = 'direct_tax'").get().due_date, '2026-10-15');
  assert.strictEqual(W.dueFor('2026-01', 31), '2026-02-28');
  assert.throws(() => s.call(s.mgr, 'POST /api/wf/cycle', { period: '2026-09' }), /department head/);
});

test('associate prepares, supervisor checks, manager approves; nobody checks their own work; month close goes to Accounts', () => {
  const s = setup();
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  const id = taskOf(s, s.c1, 'direct_tax');
  const act = (u, action, note) => s.call(u, 'POST /api/wf/task/action', { id, action, note });
  assert.throws(() => act(s.sup, 'approve'), /Submit the work first/);
  assert.ok(s.call(s.asc, 'GET /api/wf/home').mine.some((t) => t.id === id));
  assert.strictEqual(act(s.asc, 'submit').stage, 'check');
  assert.throws(() => act(s.asc, 'approve'), /waiting on sup/);
  assert.throws(() => act(s.sup, 'return'), /Say what needs to change/);
  assert.strictEqual(act(s.sup, 'return', 'Attach the TDS reconciliation').stage, 'preparation');
  act(s.asc, 'submit');
  assert.strictEqual(act(s.sup, 'approve').stage, 'approval');
  assert.throws(() => act(s.sup, 'approve'), /waiting on mgr/);
  assert.strictEqual(act(s.mgr, 'approve').stage, 'done');
  const t = s.call(s.mgr, 'GET /api/wf/task', {}, { id });
  assert.strictEqual(t.task.timeliness, 'on_time');
  assert.deepStrictEqual(t.events.map((e) => e.action), ['create', 'submit', 'return', 'submit', 'approve', 'approve']);
  assert.deepStrictEqual(t.chain.map((c) => c.person), ['asc', 'sup', 'mgr']);

  // The month is not closed while the applicability review is open.
  assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM wf_billing').get().n, 0);
  const rv = taskOf(s, s.c1, 'indirect_tax');
  s.call(s.ana, 'POST /api/wf/task/action', { id: rv, action: 'submit', note: 'Still below the GST threshold' });
  s.call(s.sup, 'POST /api/wf/task/action', { id: rv, action: 'approve' });
  s.call(s.mgr, 'POST /api/wf/task/action', { id: rv, action: 'approve' });
  const bill = s.db.prepare('SELECT * FROM wf_billing WHERE company_id = ?').get(s.c1);
  assert.strictEqual(bill.bill_month, '2026-10');
  assert.strictEqual(bill.fee, 30000);
});

test('a supervisor who prepares goes straight to the manager; a flag goes to the Managing Partner', () => {
  const s = setup();
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  const id = taskOf(s, s.c1, 'direct_tax');
  assert.strictEqual(s.call(s.sup, 'POST /api/wf/task/action', { id, action: 'submit' }).stage, 'approval');
  s.call(s.sup, 'POST /api/wf/task/flag', { id, reason: 'Advance tax shortfall; client disputes the estimate' });
  assert.strictEqual(s.call(s.mgr, 'POST /api/wf/task/action', { id, action: 'approve' }).stage, 'mp');
  assert.ok(s.call(s.mp, 'GET /api/wf/home').mine.some((t) => t.id === id));
  assert.throws(() => s.call(s.bh, 'POST /api/wf/flag/resolve', { flag_id: 1, resolution: 'ok' }), /Only the Managing Partner/);
  assert.throws(() => s.call(s.mp, 'POST /api/wf/task/action', { id, action: 'approve' }), /Add a note/);
  assert.strictEqual(s.call(s.mp, 'POST /api/wf/task/action', { id, action: 'approve', note: 'Pay the shortfall with interest' }).stage, 'done');
  assert.strictEqual(s.db.prepare("SELECT COUNT(*) AS n FROM wf_flags WHERE status = 'open'").get().n, 0);
});

test('each person sees their own work, managers their juniors, branches stay apart; client logins are refused', () => {
  const s = setup();
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  const ids = (u) => s.call(u, 'GET /api/wf/tasks').tasks.map((t) => t.company_id + ':' + t.division).sort();
  assert.deepStrictEqual(ids(s.asc), [`${s.c1}:direct_tax`]);
  assert.deepStrictEqual(ids(s.ana), [`${s.c1}:indirect_tax`]);
  assert.strictEqual(ids(s.sup).length, 2);
  assert.strictEqual(ids(s.head).length, 2);
  assert.deepStrictEqual(ids(s.head2), [`${s.c2}:direct_tax`]);
  assert.strictEqual(ids(s.mp).length, 3);
  assert.throws(() => s.call(s.ana, 'GET /api/wf/task', {}, { id: taskOf(s, s.c1, 'direct_tax') }), /outside your reporting line/);
  assert.throws(() => s.call(s.head2, 'GET /api/wf/task', {}, { id: taskOf(s, s.c1, 'direct_tax') }), /outside your reporting line/);
  assert.deepStrictEqual(s.call(s.asc2, 'GET /api/wf/clients').clients.map((c) => c.code), ['AE-0002']);
  assert.deepStrictEqual(s.call(s.bh, 'GET /api/wf/clients').clients.map((c) => c.code), ['AE-0001']);
  assert.throws(() => s.call(s.head2, 'POST /api/wf/allot', { company_id: s.c1, division: 'direct_tax', assignee_id: s.asc2.id }), /Only the department head/);
  assert.throws(() => s.call(s.head, 'POST /api/wf/allot', { company_id: s.c1, division: 'labour', assignee_id: s.asc.id }), /Only the department head/);
  // The portal's "My work" uses the same lines.
  assert.deepStrictEqual(store.assignedCompanies(s.db, s.asc), [s.c1]);
  assert.deepStrictEqual(store.assignedCompanies(s.db, s.sup), [s.c1]);
  assert.deepStrictEqual(store.assignedCompanies(s.db, s.head2), [s.c2]);
  assert.deepStrictEqual(store.assignedCompanies(s.db, s.bh), [s.c1]);
  assert.strictEqual(store.assignedCompanies(s.db, s.mp), null);
  const client = s.user('c@client.in', 'client', s.c1);
  assert.throws(() => s.call(client, 'GET /api/wf/me'), /Assura Elevate team only/);
  assert.throws(() => s.call(s.user('new@x.in'), 'GET /api/wf/home'), /not been given a place/);
  assert.throws(() => s.call(s.head, 'POST /api/wf/staff', { user_id: s.asc.id, level: 'mp' }), /Only the Managing Partner or an admin/);
});

test('replacing the allotted person moves their open work and is logged', () => {
  const s = setup();
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  s.call(s.mgr, 'POST /api/wf/allot', { company_id: s.c1, division: 'direct_tax', assignee_id: s.ana.id, note: 'asc on leave' });
  assert.strictEqual(s.db.prepare('SELECT assignee_id FROM wf_tasks WHERE id = ?').get(taskOf(s, s.c1, 'direct_tax')).assignee_id, s.ana.id);
  const log = s.call(s.mgr, 'GET /api/wf/client', {}, { id: s.c1 }).log;
  assert.match(log[0].change, /asc → ana \(asc on leave\)/);
  assert.throws(() => s.call(s.mgr, 'POST /api/wf/allot', { company_id: s.c1, division: 'direct_tax', assignee_id: s.asc2.id }), /client's branch/);
});

test('documents count only when they come from a registered contact of the client', () => {
  const s = setup();
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  s.call(s.admin, 'POST /api/wf/contact', { company_id: s.c1, role: 'Partner', name: 'P One', email: 'p1@one.in', phone: '+91 98450 12345' });
  assert.throws(() => s.call(s.asc, 'POST /api/wf/contact', { company_id: s.c1, role: 'Partner', name: 'X', email: 'x@x.in' }), /Only a department head/);
  const id = taskOf(s, s.c1, 'direct_tax');
  const doc = (from, title = 'Form 16A') => s.call(s.asc, 'POST /api/wf/document', { company_id: s.c1, task_id: id, title, received_from: from, channel: 'email' });
  assert.strictEqual(doc('P One <P1@one.in>').verified, true);
  assert.strictEqual(doc('9845012345', 'Bank statement').verified, true);
  assert.strictEqual(doc('p1@one-in.co', 'Board resolution').verified, false);
  s.call(s.asc, 'POST /api/wf/task/action', { id, action: 'submit' });
  assert.throws(() => s.call(s.sup, 'POST /api/wf/task/action', { id, action: 'approve' }), /did not come from a registered contact/);
  const bad = s.db.prepare('SELECT id FROM wf_documents WHERE verified = 0').get().id;
  assert.throws(() => s.call(s.asc, 'POST /api/wf/document/reject', { id: bad, note: 'x' }), /supervisor or above/);
  s.call(s.sup, 'POST /api/wf/document/reject', { id: bad, note: 'Asked the partner to send it from the registered email' });
  assert.strictEqual(s.call(s.sup, 'POST /api/wf/task/action', { id, action: 'approve' }).stage, 'approval');
});

test('Accounts raises, sends and records payment of the advance invoice', () => {
  const s = setup('2026-10-05');
  s.call(s.admin, 'POST /api/wf/contact', { company_id: s.c1, role: 'Partner', name: 'P One', email: 'p1@one.in' });
  s.call(s.admin, 'POST /api/wf/contact', { company_id: s.c1, role: 'Accountant', name: 'Acct', email: 'acct@one.in' });
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  for (const div of ['direct_tax', 'indirect_tax']) {
    const id = taskOf(s, s.c1, div);
    s.call(div === 'direct_tax' ? s.asc : s.ana, 'POST /api/wf/task/action', { id, action: 'submit' });
    s.call(s.sup, 'POST /api/wf/task/action', { id, action: 'approve' });
    s.call(s.mgr, 'POST /api/wf/task/action', { id, action: 'approve' });
  }
  assert.throws(() => s.call(s.asc, 'GET /api/wf/billing'), /Billing is for the Accounts/);
  assert.throws(() => s.call(s.bh2, 'POST /api/wf/billing/invoice', { id: 1 }), /not found/);
  const rows = s.call(s.acc, 'GET /api/wf/billing').rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total, 35400);
  assert.strictEqual(s.call(s.acc, 'POST /api/wf/billing/invoice', { id: rows[0].id }).invoice_no, 'AE/2026-27/0001');
  const inv = s.call(s.acc, 'GET /api/wf/billing/invoice', {}, { id: rows[0].id });
  assert.deepStrictEqual(inv.to, ['accounts@ae-0001.in', 'p1@one.in']);
  s.call(s.acc, 'POST /api/wf/billing/sent', { id: rows[0].id, to: inv.to });
  s.call(s.acc, 'POST /api/wf/billing/paid', { id: rows[0].id, amount: 35400, paid_on: '2026-10-10', reference: 'NEFT 123' });
  assert.strictEqual(s.call(s.acc, 'GET /api/wf/billing').rows[0].status, 'paid');
  assert.strictEqual(W.fyOf('2027-03-31'), '2026-27');
  assert.strictEqual(W.fyOf('2027-04-01'), '2027-28');
});

test('attendance is marked by each person and verified by Accounts', () => {
  const s = setup('2026-10-05');
  s.call(s.asc, 'POST /api/wf/attendance/mark', { present: true });
  s.call(s.acc, 'POST /api/wf/attendance/mark', { present: true });
  assert.strictEqual(s.call(s.asc, 'GET /api/wf/me').attendance_today.present, 1);
  assert.throws(() => s.call(s.mgr, 'POST /api/wf/attendance/verify', { user_id: s.asc.id, day: '2026-10-05', verified: 'yes' }), /Accounts/);
  assert.throws(() => s.call(s.acc, 'POST /api/wf/attendance/verify', { user_id: s.acc.id, day: '2026-10-05', verified: 'yes' }), /Someone else/);
  assert.throws(() => s.call(s.acc, 'POST /api/wf/attendance/verify', { user_id: s.asc2.id, day: '2026-10-05', verified: 'yes' }), /not in your branch/);
  s.call(s.acc, 'POST /api/wf/attendance/verify', { user_id: s.asc.id, day: '2026-10-05', verified: 'yes' });
  assert.throws(() => s.call(s.asc, 'POST /api/wf/attendance/mark', { present: false }), /already been verified/);
  const view = s.call(s.sup, 'GET /api/wf/attendance');
  assert.deepStrictEqual(view.people.map((p) => p.name).sort(), ['ana', 'asc', 'sup']);
});

test('two-day reports go to the person above, weekly to the head, consolidated to the top; corrective actions are tracked', () => {
  const s = setup('2026-10-20');
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  s.call(s.asc, 'GET /api/wf/home');
  const kinds = (u) => s.call(u, 'GET /api/wf/home').reportsDue.map((r) => r.kind);
  assert.ok(kinds(s.sup).length >= 1 && kinds(s.sup).every((k) => k === 'two_day'));
  assert.ok(kinds(s.mgr).every((k) => k === 'two_day'));
  assert.ok(kinds(s.head).length >= 1 && kinds(s.head).every((k) => k === 'weekly'));
  assert.ok(kinds(s.mp).length >= 1 && kinds(s.mp).every((k) => k === 'consolidated'));
  assert.deepStrictEqual(kinds(s.asc), []);
  const rid = s.call(s.sup, 'GET /api/wf/home').reportsDue[0].id;
  const rep = s.call(s.sup, 'GET /api/wf/report', {}, { id: rid });
  assert.ok(rep.report.snapshot.overdue.length >= 1, 'the overdue work shows in the report');
  assert.deepStrictEqual(rep.owners.map((o) => o.name).sort(), ['ana', 'asc']);
  assert.throws(() => s.call(s.asc, 'GET /api/wf/report', {}, { id: rid }), /not in your reporting line/);
  assert.throws(() => s.call(s.mgr, 'POST /api/wf/report/review', { id: rid, comment: 'Seen' }), /Only the person/);
  s.call(s.sup, 'POST /api/wf/report/review', { id: rid, comment: 'Direct tax is overdue', actions: [{ text: 'File the TDS return by Friday', owner_id: s.asc.id, due_date: '2026-10-23' }] });
  // The manager above and the branch head see the reviewed report and its corrective action.
  assert.strictEqual(s.call(s.mgr, 'GET /api/wf/report', {}, { id: rid }).actions.length, 1);
  assert.ok(s.call(s.bh, 'GET /api/wf/reports').actions.some((a) => a.text === 'File the TDS return by Friday'));
  const mine = s.call(s.asc, 'GET /api/wf/home').myActions;
  assert.strictEqual(mine.length, 1);
  assert.throws(() => s.call(s.asc, 'POST /api/wf/action/done', { id: mine[0].id }), /Record what was done/);
  s.call(s.asc, 'POST /api/wf/action/done', { id: mine[0].id, note: 'Filed' });
  assert.strictEqual(s.call(s.asc, 'GET /api/wf/home').myActions.length, 0);
  const mpRep = s.call(s.mp, 'GET /api/wf/report', {}, { id: s.call(s.mp, 'GET /api/wf/home').reportsDue[0].id });
  assert.ok(mpRep.report.snapshot.departments.some((d) => d.key === 'taxation'));
});

test('late work shows as delayed; only a manager or above changes a target date', () => {
  const s = setup('2026-10-20');
  s.call(s.mp, 'POST /api/wf/cycle', { period: '2026-09' });
  const id = taskOf(s, s.c1, 'direct_tax');
  const t = s.call(s.mgr, 'GET /api/wf/task', {}, { id }).task;
  assert.strictEqual(t.timeliness, 'delayed');
  assert.strictEqual(t.days_late, 5);
  assert.throws(() => s.call(s.asc, 'POST /api/wf/task/reschedule', { id, due_date: '2026-10-30', note: 'x' }), /manager or above/);
  s.call(s.mgr, 'POST /api/wf/task/reschedule', { id, due_date: '2026-10-30', note: 'Client data arrived late' });
  assert.strictEqual(s.call(s.mgr, 'GET /api/wf/task', {}, { id }).task.timeliness, 'on_track');
  s.setToday('2026-10-27');
  assert.strictEqual(s.call(s.mgr, 'GET /api/wf/task', {}, { id }).task.timeliness, 'behind');
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
