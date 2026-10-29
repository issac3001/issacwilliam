/*
 * Fictional firm structure, clients and two months of history for the demo and the local preview:
 * Bangalore and Calicut branches, every department, reporting lines, client contacts, documents,
 * billing, attendance and reports. Placeholder people only ("Taxation Head, Bangalore" and so on);
 * the real team is set up under Team.
 * Works with the server database (tools/seed_demo.js) and the in-browser preview (tools/demo/workflow-demo-api.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../shared/workflow'));
  else root.AEWorkflowSeed = factory(root.AEWorkflow);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';

  const BRANCHES = [{ key: 'blr', name: 'Bangalore' }, { key: 'clt', name: 'Calicut' }];
  const DEPT_SLUG = { taxation: 'tax', labour: 'labour', governance: 'gov', legal: 'legal', assurance: 'assurance', accounts: 'accounts' };

  // [code, name, branch, entity type, monthly fee, target day, labour applies, contacts: [role, name]]
  const CLIENTS = [
    ['AE-0001', 'Meridian Polymers Pvt Ltd (Demo)', 'blr', 'company', 30000, 15, true, [['Director', 'Director A'], ['Director', 'Director B'], ['Accountant', 'Accountant']]],
    ['AE-0002', 'Coastline Foods Pvt Ltd (Demo)', 'blr', 'company', 30000, 20, true, [['Director', 'Director A'], ['Accountant', 'Accountant']]],
    ['AE-0003', 'Northfield Engineering Pvt Ltd (Demo)', 'blr', 'company', 25000, 10, false, [['Director', 'Director A'], ['Director', 'Director B'], ['Accountant', 'Accountant']]],
    ['AE-0004', 'Saffron Textiles LLP (Demo)', 'blr', 'llp', 20000, 25, true, [['Partner', 'Partner A'], ['Partner', 'Partner B'], ['Accountant', 'Accountant']]],
    ['AE-0005', 'Kaveri Traders (Demo)', 'blr', 'partnership', 20000, 28, false, [['Partner', 'Partner A'], ['Partner', 'Partner B'], ['Partner', 'Partner C']]],
    ['AE-0006', 'Harbourline Logistics Pvt Ltd (Demo)', 'clt', 'company', 30000, 12, true, [['Director', 'Director A'], ['Accountant', 'Accountant']]],
    ['AE-0007', 'Malabar Spices (Demo)', 'clt', 'proprietorship', 20000, 18, false, [['Proprietor', 'Proprietor'], ['Accountant', 'Accountant']]],
    ['AE-0008', 'Coastal Care Foundation (Demo)', 'clt', 'ngo', 20000, 30, true, [['Trustee', 'Managing Trustee'], ['Trustee', 'Trustee'], ['Accountant', 'Accountant']]],
  ];
  const FLAGS = [
    // [client code, division, stage to leave it at, reason]
    ['AE-0001', 'indirect_tax', 'mp', 'Input credit claimed in GSTR-3B is higher than GSTR-2B by ₹4.2 lakh. The client wants to keep the claim; needs a Managing Partner decision.'],
    ['AE-0003', 'companies_act', 'approval', 'Minutes of the last board meeting are not yet signed by the chairman. Register of contracts with related parties is incomplete.'],
    ['AE-0006', 'labour', 'check', 'PF for the month was deposited after the due date. Interest and damages are payable; client to be advised.'],
  ];
  const REVIEWS = [
    'Two items are past their target. Agreed the order of work with the team.',
    'Work is on track. Reminded the team to log documents as they arrive.',
    'Returns are being sent back for missing workings. Corrective action set below.',
  ];
  const ACTIONS = [
    'Send the client a list of the documents still pending, from the registered email only',
    'Attach the reconciliation working before submitting the return for checking',
    'Clear the overdue items before taking up next month\'s work',
  ];

  function prevMonth(period, n) {
    let [y, m] = period.split('-').map(Number);
    m -= n; while (m < 1) { m += 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  const slugOf = (s) => s.toLowerCase().replace(/[^a-z]+/g, '');

  // makeUser(email, name, role) -> user row; ensureCompany(code, name) -> company id; admin: an admin user row; only: client codes to seed.
  function seed(db, wf, { today, makeUser, ensureCompany, admin, only }) {
    if (db.prepare('SELECT 1 FROM wf_branches LIMIT 1').get()) return { skipped: true };
    const call = (u, route, body, query) => wf.call(u, route, query || {}, body || {});
    const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

    const branch = {};
    BRANCHES.forEach((b) => { branch[b.key] = call(admin, 'POST /api/wf/branch', { name: b.name }).id; });
    const place = (u, level, department, br, to) => { call(admin, 'POST /api/wf/staff', { user_id: u.id, level, department, branch_id: br ? branch[br] : null, reports_to: to ? to.id : null }); return u; };

    const mp = place(makeUser('mp@assura.demo', 'Managing Partner', 'team'), 'mp');
    // people[branch][department] = { head, manager, supervisor, doers: [...] }
    const people = {}; const branchHead = {};
    for (const b of BRANCHES) {
      const full = b.key === 'blr';
      const bh = branchHead[b.key] = place(makeUser(`branchhead.${b.key}@assura.demo`, `Branch Head, ${b.name}`, 'team'), 'branch_head', null, b.key, mp);
      people[b.key] = {};
      for (const d of W.DEPARTMENTS) {
        const slug = DEPT_SLUG[d.key];
        const mk = (role, label, level, to) => place(makeUser(`${slug}.${role}.${b.key}@assura.demo`, `${d.name} ${label}, ${b.name}`, 'team'), level, d.key, b.key, to);
        if (d.key === 'accounts') {
          const lead = full ? mk('head', 'Head', 'head', bh) : null;
          people[b.key].accounts = { head: lead, doers: [mk('associate', 'Associate', 'associate', lead || bh)] };
          continue;
        }
        const head = mk('head', 'Head', 'head', bh);
        const manager = full ? mk('manager', 'Manager', 'manager', head) : null;
        const supervisor = mk('supervisor', 'Supervisor', 'supervisor', manager || head);
        const doers = [mk('associate1', 'Associate 1', 'associate', supervisor)];
        if (full) doers.push(mk('analyst1', 'Analyst 1', 'analyst', supervisor));
        if (full && d.key === 'taxation') doers.push(mk('associate2', 'Associate 2', 'associate', supervisor));
        people[b.key][d.key] = { head, manager, supervisor, doers };
      }
    }

    // Clients, their partners and accountants, and one person per division.
    const ids = {}; let rr = 0;
    // only: a list of client codes, to seed fewer clients (the demo server uses one).
    CLIENTS.filter((c) => !only || only.includes(c[0])).forEach(([code, name, br, entity, fee, day, labour, contacts], i) => {
      const domain = `${slugOf(name.replace(/\(Demo\)|Pvt Ltd|LLP/g, '')).slice(0, 14)}.example`;
      const id = ensureCompany(code, name);
      ids[code] = id;
      const gst = entity !== 'ngo';
      call(admin, 'POST /api/wf/client', {
        company_id: id, name, branch_id: branch[br], entity_type: entity, monthly_fee: fee, target_day: day,
        pan: `AAA${'CFPFT'[i % 5]}D${String(1000 + i * 137).slice(-4)}${'KLMNP'[i % 5]}`,
        gstin: gst ? `${br === 'blr' ? '29' : '32'}AAA${'CFPFT'[i % 5]}D${String(1000 + i * 137).slice(-4)}${'KLMNP'[i % 5]}1Z${i}` : '',
        cin: entity === 'company' ? `U${String(17000 + i * 311)}KA2014PTC0${String(70000 + i * 977)}` : '',
        billing_email: `accounts@${domain}`, phone: `080 4000 ${String(1000 + i * 11)}`,
        onboarded_on: W.addDays(today, -120 - i * 9),
      });
      contacts.forEach(([role, cname], k) => call(admin, 'POST /api/wf/contact', {
        company_id: id, role, name: `${cname} (${code})`, email: `${slugOf(cname)}@${domain}`, phone: `98${String(450 + i).padStart(3, '0')}${String(10000 + k * 1111).slice(-5)}`,
      }));
      for (const dv of W.DIVISIONS) {
        const team = people[br][dv.dept];
        const assignee = team.doers[(rr++ + i) % team.doers.length];
        call(admin, 'POST /api/wf/allot', { company_id: id, division: dv.key, assignee_id: assignee.id, applicable: dv.key === 'labour' ? labour : undefined });
      }
    });

    const p1 = prevMonth(today.slice(0, 7), 1);
    const p0 = prevMonth(today.slice(0, 7), 2);
    call(mp, 'POST /api/wf/cycle', { period: p0 });
    call(mp, 'POST /api/wf/cycle', { period: p1 });

    // Moves a task forward with the right person at each step until it reaches `target`.
    const ORDER = ['preparation', 'check', 'approval', 'mp', 'done'];
    function advance(id, target, opts = {}) {
      for (let guard = 0; guard < 12; guard++) {
        const t = call(mp, 'GET /api/wf/task', null, { id }).task;
        if (t.stage === target || t.stage === 'done' || ORDER.indexOf(t.stage) > ORDER.indexOf(target)) return;
        const actor = t.stage === 'mp' ? mp : userById(t.owner_id);
        if (opts.returnOnce && t.stage === 'check') {
          call(actor, 'POST /api/wf/task/action', { id, action: 'return', note: 'Reconcile the figures with the return filed and attach the working.' });
          opts.returnOnce = false; continue;
        }
        const note = t.stage === 'preparation' ? 'Prepared and checked against the client\'s data.' : t.stage === 'mp' ? 'Discussed with the client. Proceed with the conservative position.' : '';
        call(actor, 'POST /api/wf/task/action', { id, action: t.stage === 'preparation' ? 'submit' : 'approve', note });
      }
    }

    const all = db.prepare('SELECT * FROM wf_tasks ORDER BY id').all();
    const codeOf = Object.fromEntries(Object.entries(ids).map(([c, id]) => [id, c]));
    const branchOf = (companyId) => CLIENTS.find((c) => c[0] === codeOf[companyId])[2];
    const supOf = (t) => people[branchOf(t.company_id)][W.DIVISIONS.find((d) => d.key === t.division).dept].supervisor;

    // Documents: received from the registered contacts, and one that was not.
    const contactsOf = (cid) => db.prepare('SELECT * FROM wf_contacts WHERE company_id = ? ORDER BY id').all(cid);
    const DOCS = { direct_tax: 'TDS challans and deduction register', indirect_tax: 'Sales and purchase registers', labour: 'Salary register and attendance', companies_act: 'Signed board minutes', llp: 'Partner contribution statement', legal: 'Partnership deed (amended)', assurance: 'Trial balance and bank statements' };
    all.filter((t) => t.period === p1 && t.template === t.division).forEach((t, n) => {
      if (n % 3) return;
      const c = contactsOf(t.company_id)[n % 2];
      call(userById(t.assignee_id), 'POST /api/wf/document', { company_id: t.company_id, task_id: t.id, title: DOCS[t.division], received_from: n % 2 ? c.phone : c.email, channel: n % 2 ? 'whatsapp' : 'email' });
    });

    const flagged = new Set();
    for (const [code, div, stage, reason] of FLAGS) {
      const t = all.find((x) => x.period === p1 && x.company_id === ids[code] && x.division === div);
      if (!t) continue;
      call(supOf(t), 'POST /api/wf/task/flag', { id: t.id, reason });
      advance(t.id, stage); flagged.add(t.id);
    }
    // These clients' months are complete, so they wait with Accounts for the advance invoice.
    const DONE_EARLY = ['AE-0002', 'AE-0007'];
    const lateDone = new Set();
    let blocked = null;
    all.forEach((t, n) => {
      if (flagged.has(t.id)) return;
      const ret = n % 7 === 3;
      if (t.period === p0) { if (n % 9 === 4) lateDone.add(t.id); advance(t.id, 'done', { returnOnce: ret }); return; }
      if (t.due_date < today) {
        // Most work due already is finished; some is stuck and shows as delayed.
        if (DONE_EARLY.includes(codeOf[t.company_id])) { advance(t.id, 'done', { returnOnce: ret }); return; }
        if (n % 6 === 0) advance(t.id, ['preparation', 'check', 'approval'][n % 3], { returnOnce: ret && n % 3 > 0 });
        else { if (n % 6 === 1) lateDone.add(t.id); advance(t.id, 'done', { returnOnce: ret }); }
        return;
      }
      const days = Math.round((Date.parse(t.due_date) - Date.parse(today)) / 86400000);
      if (DONE_EARLY.includes(codeOf[t.company_id])) { advance(t.id, 'done'); return; }
      const stage = days > 6 ? (n % 3 ? 'preparation' : 'check') : days > 2 ? ['check', 'approval', 'preparation'][n % 3] : ['approval', 'check', 'done'][n % 3];
      advance(t.id, stage, { returnOnce: ret && stage !== 'preparation' });
      if (!blocked && stage === 'check' && t.template === t.division) blocked = t;
    });
    if (blocked) {
      call(userById(blocked.assignee_id), 'POST /api/wf/document', { company_id: blocked.company_id, task_id: blocked.id, title: 'Revised board resolution (scanned copy)', received_from: 'accounts.office.desk@gmail.example', channel: 'email' });
    }

    // Spread the history over the month so the dates read like real work.
    const BEFORE = { preparation: 5, check: 2, approval: 0, mp: 0 };
    for (const t of db.prepare('SELECT * FROM wf_tasks').all()) {
      const evs = db.prepare('SELECT * FROM wf_events WHERE task_id = ? ORDER BY id').all(t.id);
      const created = `${W.nextPeriod(t.period)}-01`;
      let last = created; let doneOn = null;
      evs.forEach((e, k) => {
        let day;
        if (e.action === 'create') day = created;
        else if (!e.from_stage) day = W.addDays(t.due_date, -8 + (t.id % 3));
        else {
          const jitter = ((t.id * 7 + k * 3) % 4) - 2;
          day = W.addDays(t.due_date, -(BEFORE[e.from_stage] ?? 0) + jitter);
          if (e.to_stage === 'done' && lateDone.has(t.id)) day = W.addDays(t.due_date, 1 + (t.id % 4));
          if (e.to_stage === 'done' && !lateDone.has(t.id) && day > t.due_date) day = t.due_date;
        }
        if (day < last) day = last;
        if (day > today) day = today;
        last = day;
        if (e.to_stage === 'done') doneOn = day;
        db.prepare('UPDATE wf_events SET at = ? WHERE id = ?').run(`${day}T0${4 + (k % 6)}:${10 + ((t.id * 13) % 49)}:00Z`, e.id);
      });
      if (doneOn) db.prepare('UPDATE wf_tasks SET completed_on = ?, completed_at = ? WHERE id = ?').run(doneOn, `${doneOn}T10:00:00Z`, t.id);
      db.prepare('UPDATE wf_tasks SET created_at = ? WHERE id = ?').run(`${created}T03:30:00Z`, t.id);
      db.prepare("UPDATE wf_documents SET received_at = (SELECT at FROM wf_events WHERE task_id = ? AND action = 'document' LIMIT 1) WHERE task_id = ?").run(t.id, t.id);
    }
    for (const f of db.prepare('SELECT id, task_id FROM wf_flags').all()) {
      const e = db.prepare("SELECT at FROM wf_events WHERE task_id = ? AND action = 'flag' ORDER BY id LIMIT 1").get(f.task_id);
      if (e) db.prepare('UPDATE wf_flags SET raised_at = ? WHERE id = ?').run(e.at, f.id);
    }

    // Billing: last-but-one month is billed and mostly paid; last month's closed clients wait for an invoice.
    for (const b of db.prepare('SELECT * FROM wf_billing ORDER BY id').all()) {
      const last = db.prepare('SELECT MAX(completed_on) AS d FROM wf_tasks WHERE company_id = ? AND period = ?').get(b.company_id, b.period).d || today;
      db.prepare('UPDATE wf_billing SET closed_on = ? WHERE id = ?').run(last, b.id);
    }
    const accBy = (cid) => { const a = people[branchOf(cid)].accounts; return a.doers[0]; };
    db.prepare('SELECT * FROM wf_billing WHERE period = ? ORDER BY closed_on, id').all(p0).forEach((b, n) => {
      const acc = accBy(b.company_id);
      call(acc, 'POST /api/wf/billing/invoice', { id: b.id });
      const inv = call(acc, 'GET /api/wf/billing/invoice', null, { id: b.id });
      call(acc, 'POST /api/wf/billing/sent', { id: b.id, to: inv.to });
      if (n % 4 !== 3) call(acc, 'POST /api/wf/billing/paid', { id: b.id, amount: inv.invoice.total, paid_on: W.addDays(b.closed_on, 6 + n), reference: `NEFT ${String(400000 + n * 7919)}` });
      db.prepare('UPDATE wf_billing SET invoice_date = ?, sent_at = ? WHERE id = ?').run(W.addDays(b.closed_on, 1), `${W.addDays(b.closed_on, 1)}T06:00:00Z`, b.id);
    });

    // Attendance for the last two weeks (Sundays off); Accounts has verified all but the last two days.
    const everyone = db.prepare('SELECT s.user_id, s.branch_id FROM wf_staff s').all();
    for (let k = 14; k >= 1; k--) {
      const day = W.addDays(today, -k);
      if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) continue;
      everyone.forEach((s, i) => {
        const present = (i * 7 + k * 3) % 23 === 0 ? 0 : 1;
        const br = BRANCHES.find((b) => branch[b.key] === s.branch_id);
        const verifier = br ? people[br.key].accounts.doers[0] : null;
        const verified = k > 2 && verifier && verifier.id !== s.user_id ? 'yes' : null;
        db.prepare('INSERT OR REPLACE INTO wf_attendance (user_id, day, present, marked_at, verified, verified_by, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(s.user_id, day, present, `${day}T04:${10 + (i % 40)}:00Z`, verified, verified ? verifier.id : null, verified ? `${W.addDays(day, 1)}T05:00:00Z` : null);
      });
    }

    // Reports: older ones reviewed with corrective actions; the latest of each wait for review.
    call(mp, 'GET /api/wf/reports');
    const reps = db.prepare('SELECT * FROM wf_reports ORDER BY reviewer_id, start_day').all();
    const latest = new Map();
    reps.forEach((r) => latest.set(`${r.kind}:${r.reviewer_id}`, r.id));
    reps.forEach((r, n) => {
      if (latest.get(`${r.kind}:${r.reviewer_id}`) === r.id) return;
      const reviewer = userById(r.reviewer_id);
      const owners = call(reviewer, 'GET /api/wf/report', null, { id: r.id }).owners;
      const actions = n % 3 === 2 && owners.length ? [{ text: ACTIONS[n % ACTIONS.length], owner_id: owners[n % owners.length].id, due_date: W.addDays(r.end_day, 4) }] : [];
      call(reviewer, 'POST /api/wf/report/review', { id: r.id, comment: REVIEWS[n % REVIEWS.length], actions });
      db.prepare('UPDATE wf_reports SET reviewed_at = ? WHERE id = ?').run(`${W.addDays(r.end_day, 1)}T12:00:00Z`, r.id);
      db.prepare('UPDATE wf_actions SET raised_at = ? WHERE report_id = ?').run(`${W.addDays(r.end_day, 1)}T12:00:00Z`, r.id);
    });
    db.prepare("SELECT * FROM wf_actions WHERE due_date < ? ORDER BY id").all(W.addDays(today, -3)).forEach((a, n) => {
      if (n % 2) return;
      db.prepare("UPDATE wf_actions SET status = 'done', done_at = ?, done_note = ? WHERE id = ?").run(`${a.due_date}T11:00:00Z`, 'Done and confirmed with the supervisor.', a.id);
    });

    return { mp, people, branchHead, ids, periods: [p0, p1] };
  }

  return { seed, CLIENTS, BRANCHES };
});
