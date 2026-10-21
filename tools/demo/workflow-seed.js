/*
 * Fictional team, clients and two months of workflow history for the demo and the local preview.
 * Placeholder people only ("CA Manager 1" and so on): the real team is set up by an admin under Team.
 * Works with the server database (tools/seed_demo.js) and the in-browser preview (tools/demo/workflow-demo-api.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../shared/workflow'));
  else root.AEWorkflowSeed = factory(root.AEWorkflow);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';

  const COMPANIES = [
    ['AE-0001', 'Meridian Polymers Pvt Ltd (Demo)', 10],
    ['AE-0002', 'Coastline Foods Pvt Ltd (Demo)', 15],
    ['AE-0003', 'Harbourline Logistics Pvt Ltd (Demo)', 20],
    ['AE-0004', 'Northfield Engineering Pvt Ltd (Demo)', 12],
    ['AE-0005', 'Saffron Textiles LLP (Demo)', 18],
    ['AE-0006', 'Vantage Healthcare Pvt Ltd (Demo)', 25],
  ];
  const SHORT = { ca: 'CA', cs: 'CS', legal: 'Legal', hr: 'HR' };
  const FLAGS = [
    // [company index, department, template, stage to leave it at, reason]
    [0, 'ca', 'gst', 'md', 'Input credit claimed in GSTR-3B is higher than GSTR-2B by ₹4.2 lakh. The client wants to keep the claim; needs an MD decision before sign-off.'],
    [3, 'cs', 'registers', 'manager', 'Minutes of the last board meeting are not yet signed by the chairman. Register of contracts with related parties is incomplete.'],
    [1, 'hr', 'pf-esi', 'review', 'PF for the month was deposited after the due date. Interest and damages are payable; client to be advised.'],
  ];

  function prevMonth(period, n) {
    let [y, m] = period.split('-').map(Number);
    m -= n; while (m < 1) { m += 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  // makeUser(email, name, role) -> user row; ensureCompany(code, name) -> company id; admin: an admin user row.
  function seed(db, wf, { today, makeUser, ensureCompany, admin }) {
    if (db.prepare('SELECT 1 FROM wf_teams LIMIT 1').get()) return { skipped: true };
    const call = (u, route, body) => wf.call(u, route, {}, body);
    const companyIds = COMPANIES.map(([code, name]) => ensureCompany(code, name));

    const md = makeUser('md@assura.demo', 'Managing Director', 'admin');
    call(admin, 'POST /api/wf/staff', { user_id: md.id, level: 'md' });
    const people = {};
    for (const d of W.DEPARTMENTS) {
      const s = SHORT[d.key]; const slug = d.key;
      const p = people[d.key] = { director: makeUser(`${slug}.director@assura.demo`, `${s} Director`, 'team') };
      call(admin, 'POST /api/wf/staff', { user_id: p.director.id, level: 'director', department: d.key });
      for (const [level, label] of [['manager', 'Manager'], ['senior', 'Senior Analyst'], ['analyst', 'Analyst']]) {
        p[level] = [1, 2].map((n) => {
          const u = makeUser(`${slug}.${level}${n}@assura.demo`, `${s} ${label} ${n}`, 'team');
          call(admin, 'POST /api/wf/staff', { user_id: u.id, level, department: d.key });
          return u;
        });
      }
      p.teams = [0, 1].map((i) => call(admin, 'POST /api/wf/team', {
        department: d.key, name: `${s} Team ${i + 1}`, manager_id: p.manager[i].id, senior_id: p.senior[i].id, analyst_id: p.analyst[i].id, capacity: 30,
      }).id);
      companyIds.forEach((cid, i) => call(admin, 'POST /api/wf/allot', { company_id: cid, department: d.key, team_id: p.teams[i < 3 ? 0 : 1], target_day: COMPANIES[i][2] }));
    }

    const p1 = prevMonth(today.slice(0, 7), 1);
    const p0 = prevMonth(today.slice(0, 7), 2);
    call(admin, 'POST /api/wf/cycle', { period: p0 });
    call(admin, 'POST /api/wf/cycle', { period: p1 });

    // Moves a task forward with the right person at each step until it reaches `target`.
    const ORDER = ['preparation', 'review', 'manager', 'signoff', 'md', 'done'];
    function advance(t, target, opts = {}) {
      const p = people[t.department]; const i = p.teams.indexOf(t.team_id);
      const actor = { preparation: p.analyst[i], review: p.senior[i], manager: p.manager[i], signoff: p.director, md: md };
      let guard = 0;
      for (;;) {
        const cur = db.prepare('SELECT stage FROM wf_tasks WHERE id = ?').get(t.id).stage;
        if (cur === target || cur === 'done' || ORDER.indexOf(cur) > ORDER.indexOf(target) || guard++ > 10) return;
        if (opts.returnOnce && cur === 'review') {
          call(actor.review, 'POST /api/wf/task/action', { id: t.id, action: 'return', note: 'Reconcile the figures with the return filed and attach the working.' });
          opts.returnOnce = false; continue;
        }
        const note = cur === 'preparation' ? 'Prepared and checked against the client\'s data.' : cur === 'md' ? 'Discussed with the client. Proceed with the conservative position; reverse the excess credit.' : '';
        call(actor[cur], 'POST /api/wf/task/action', { id: t.id, action: cur === 'preparation' ? 'submit' : 'approve', note });
      }
    }

    const all = db.prepare('SELECT * FROM wf_tasks ORDER BY id').all();
    const flagged = new Set();
    for (const [ci, dept, tpl, stage, reason] of FLAGS) {
      const t = all.find((x) => x.period === p1 && x.company_id === companyIds[ci] && x.department === dept && x.template === tpl);
      if (!t) continue;
      call(people[dept].senior[people[dept].teams.indexOf(t.team_id)], 'POST /api/wf/task/flag', { id: t.id, reason });
      advance(t, stage); flagged.add(t.id);
    }
    const lateDone = new Set();
    all.forEach((t, n) => {
      if (flagged.has(t.id)) return;
      const ret = n % 7 === 3;
      if (t.period === p0) { if (n % 9 === 4) lateDone.add(t.id); advance(t, 'done', { returnOnce: ret }); return; }
      if (t.due_date < today) {
        // Most work due already is finished; some is stuck and shows as late.
        if (n % 5 === 0) advance(t, n % 2 ? 'manager' : 'review', { returnOnce: ret });
        else { if (n % 6 === 1) lateDone.add(t.id); advance(t, 'done', { returnOnce: ret }); }
        return;
      }
      const days = Math.round((Date.parse(t.due_date) - Date.parse(today)) / 86400000);
      const stage = days > 7 ? (n % 3 ? 'preparation' : 'review') : days > 3 ? ['review', 'manager', 'preparation'][n % 3] : ['signoff', 'manager', 'done'][n % 3];
      advance(t, stage, { returnOnce: ret && stage !== 'preparation' });
    });

    // Spread the history over the month so the dates read like real work.
    const BEFORE = { preparation: 6, review: 4, manager: 2, signoff: 0, md: 0 };
    for (const t of db.prepare('SELECT * FROM wf_tasks').all()) {
      const evs = db.prepare('SELECT * FROM wf_events WHERE task_id = ? ORDER BY id').all(t.id);
      const created = W.addDays(`${t.period}-01`, 31).slice(0, 8) + '01';
      let last = created; let doneOn = null;
      evs.forEach((e, k) => {
        let day;
        if (e.action === 'create') day = created;
        else {
          const jitter = ((t.id * 7 + k * 3) % 4) - 2;
          day = W.addDays(t.due_date, -(BEFORE[e.from_stage] ?? 0) + jitter);
          if (e.to_stage === 'done' && lateDone.has(t.id)) day = W.addDays(t.due_date, 1 + (t.id % 4));
          if (e.to_stage === 'done' && !lateDone.has(t.id) && day > t.due_date) day = t.due_date;
          if (day < last) day = last;
          if (day > today) day = today;
        }
        last = day;
        if (e.to_stage === 'done') doneOn = day;
        db.prepare('UPDATE wf_events SET at = ? WHERE id = ?').run(`${day}T0${4 + (k % 6)}:${10 + ((t.id * 13) % 49)}:00Z`, e.id);
      });
      if (doneOn) db.prepare('UPDATE wf_tasks SET completed_on = ?, completed_at = ? WHERE id = ?').run(doneOn, `${doneOn}T10:00:00Z`, t.id);
      db.prepare('UPDATE wf_tasks SET created_at = ? WHERE id = ?').run(`${created}T03:30:00Z`, t.id);
    }
    // A flag is dated when its 'flag' event happened.
    for (const f of db.prepare('SELECT id, task_id FROM wf_flags').all()) {
      const e = db.prepare("SELECT at FROM wf_events WHERE task_id = ? AND action = 'flag' ORDER BY id LIMIT 1").get(f.task_id);
      if (e) db.prepare('UPDATE wf_flags SET raised_at = ? WHERE id = ?').run(e.at, f.id);
    }
    return { md, people, companyIds, periods: [p0, p1] };
  }

  return { seed, COMPANIES };
});
