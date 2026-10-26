/*
 * Assura Elevate practice system: branches, departments and divisions, people and reporting lines, the
 * client database with partner contacts, monthly allotment of each client to one person per division,
 * maker-checker approvals, the source-verified document policy, month close to Accounts for advance
 * billing, invoices, attendance, and the two-day, weekly and consolidated reports with corrective actions.
 *
 * Internal only: every call is made by an Assura staff login; client logins never reach it.
 * Works on any database object with the node:sqlite surface (prepare().get/all/run, exec), so the same
 * code runs on the server (node:sqlite) and in the browser preview (sql.js through an adapter).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEWorkflow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 3;

  // Departments are where people sit. Accounts is internal: invoicing, collection, attendance.
  const DEPARTMENTS = [
    { key: 'taxation', name: 'Taxation', scope: 'Direct tax and indirect tax' },
    { key: 'labour', name: 'Labour Law', scope: 'ESI, PF and labour law compliance' },
    { key: 'governance', name: 'Corporate Governance', scope: 'Companies Act and LLP: ROC/MCA filings, registers, minutes, meetings' },
    { key: 'legal', name: 'Legal', scope: 'Governance of partnerships, proprietorships and NGOs; agreements and legal scope' },
    { key: 'assurance', name: 'Assurance', scope: 'Monthly figures, insights and the management dashboard' },
    { key: 'accounts', name: 'Accounts', scope: 'Internal: invoicing, collection and attendance verification', internal: true },
  ];
  const DEPT = Object.fromEntries(DEPARTMENTS.map((d) => [d.key, d]));

  // Divisions are what a client is allotted to: one person per client per division.
  const DIVISIONS = [
    { key: 'direct_tax', dept: 'taxation', name: 'Direct Tax', short: 'Direct tax', task: 'Direct tax: TDS deductions, deposits and returns; advance tax position' },
    { key: 'indirect_tax', dept: 'taxation', name: 'Indirect Tax (GST)', short: 'GST', task: 'GST: GSTR-1, GSTR-3B and input credit reconciliation' },
    { key: 'labour', dept: 'labour', name: 'ESI, PF & Labour Law', short: 'ESI/PF', task: 'PF and ESI contributions and returns; labour law registers' },
    { key: 'companies_act', dept: 'governance', name: 'Companies Act', short: 'Companies Act', task: 'Companies Act: ROC/MCA filings, statutory registers, board and general meetings, minutes' },
    { key: 'llp', dept: 'governance', name: 'LLP', short: 'LLP', task: 'LLP: ROC/MCA filings, LLP agreement and partner changes, registers' },
    { key: 'legal', dept: 'legal', name: 'Legal', short: 'Legal', task: 'Legal: governance records, agreements and documentation review' },
    { key: 'assurance', dept: 'assurance', name: 'Assurance', short: 'Assurance', task: 'Assurance: monthly figures validated, insights and management dashboard' },
  ];
  const DIV = Object.fromEntries(DIVISIONS.map((d) => [d.key, d]));
  const DIV_KEYS = DIVISIONS.map((d) => d.key);
  const deptOf = (div) => (DIV[div] ? DIV[div].dept : null);

  const ENTITY_TYPES = [
    { key: 'company', name: 'Company (Companies Act)' },
    { key: 'llp', name: 'LLP' },
    { key: 'partnership', name: 'Partnership firm' },
    { key: 'proprietorship', name: 'Sole proprietorship' },
    { key: 'ngo', name: 'NGO (trust or society)' },
  ];
  const ENTITY = Object.fromEntries(ENTITY_TYPES.map((e) => [e.key, e]));

  const LEVELS = [
    { key: 'analyst', name: 'Analyst', rank: 1 },
    { key: 'associate', name: 'Associate', rank: 2 },
    { key: 'supervisor', name: 'Supervisor', rank: 3 },
    { key: 'manager', name: 'Manager', rank: 4 },
    { key: 'head', name: 'Department Head', rank: 5 },
    { key: 'branch_head', name: 'Branch Head', rank: 6 },
    { key: 'mp', name: 'Managing Partner', rank: 7 },
  ];
  const RANK = Object.fromEntries(LEVELS.map((l) => [l.key, l.rank]));
  const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.key, l]));

  // The allotted person prepares, a Supervisor checks quality, a Manager gives final approval.
  // 'mp' is used only when the task carries an open flag. daysBefore: the step's own target,
  // counted back from the task's target date.
  const STAGES = [
    { key: 'preparation', name: 'Preparation', who: 'Allotted person', need: 1, daysBefore: 5 },
    { key: 'check', name: 'Quality check', who: 'Supervisor', need: 3, daysBefore: 2 },
    { key: 'approval', name: 'Final approval', who: 'Manager', need: 4, daysBefore: 0 },
    { key: 'mp', name: 'Managing Partner', who: 'Managing Partner', need: 7, daysBefore: 0 },
    { key: 'done', name: 'Completed', who: '', need: 99, daysBefore: 0 },
  ];
  const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, s]));
  const ORDER = STAGES.map((s) => s.key);
  const reviewTitle = (div) => `Applicability review: does ${DIV[div].name} apply this month?`;

  const DEFAULT_TARGET_DAY = 20;
  const DEFAULT_SETTINGS = { firm_name: 'Assura Elevate', firm_address: '', firm_gstin: '', firm_pan: '', gst_rate: '18', invoice_prefix: 'AE', bank_details: '' };

  class WfError extends Error { constructor(status, message) { super(message); this.status = status; } }

  function install(db) {
    db.exec('CREATE TABLE IF NOT EXISTS wf_meta (key TEXT PRIMARY KEY, value TEXT)');
    const v = db.prepare("SELECT value FROM wf_meta WHERE key = 'schema'").get();
    if (!v || Number(v.value) < SCHEMA_VERSION) {
      // Earlier versions were only ever used for previews; their tables are replaced.
      db.exec(`DROP TABLE IF EXISTS wf_flags; DROP TABLE IF EXISTS wf_events; DROP TABLE IF EXISTS wf_documents; DROP TABLE IF EXISTS wf_billing;
        DROP TABLE IF EXISTS wf_actions; DROP TABLE IF EXISTS wf_reports; DROP TABLE IF EXISTS wf_attendance; DROP TABLE IF EXISTS wf_tasks;
        DROP TABLE IF EXISTS wf_allot_log; DROP TABLE IF EXISTS wf_allotments; DROP TABLE IF EXISTS wf_contacts; DROP TABLE IF EXISTS wf_clients;
        DROP TABLE IF EXISTS wf_teams; DROP TABLE IF EXISTS wf_staff; DROP TABLE IF EXISTS wf_branches;`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS wf_branches (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, city TEXT, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS wf_staff (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        level TEXT NOT NULL,
        department TEXT,
        branch_id INTEGER REFERENCES wf_branches(id),
        reports_to INTEGER REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS wf_clients (
        company_id INTEGER PRIMARY KEY REFERENCES companies(id),
        branch_id INTEGER REFERENCES wf_branches(id),
        entity_type TEXT NOT NULL DEFAULT 'company',
        pan TEXT, gstin TEXT, tan TEXT, cin TEXT, address TEXT,
        billing_email TEXT, phone TEXT,
        monthly_fee INTEGER NOT NULL DEFAULT 0,
        target_day INTEGER NOT NULL DEFAULT ${DEFAULT_TARGET_DAY},
        onboarded_on TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      -- Owners, partners, directors, trustees, the client's accountant. Only authorised contacts may send documents.
      CREATE TABLE IF NOT EXISTS wf_contacts (
        id INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        role TEXT NOT NULL, name TEXT NOT NULL, email TEXT, phone TEXT,
        authorised INTEGER NOT NULL DEFAULT 1,
        removed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wf_allotments (
        company_id INTEGER NOT NULL REFERENCES companies(id),
        division TEXT NOT NULL,
        applicable INTEGER NOT NULL DEFAULT 1,
        assignee_id INTEGER REFERENCES users(id),
        since TEXT,
        PRIMARY KEY (company_id, division)
      );
      CREATE TABLE IF NOT EXISTS wf_allot_log (
        id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, division TEXT NOT NULL,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), by_id INTEGER, change TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wf_tasks (
        id INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        division TEXT NOT NULL,
        assignee_id INTEGER REFERENCES users(id),
        period TEXT NOT NULL,
        template TEXT,
        title TEXT NOT NULL,
        due_date TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'preparation',
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        completed_at TEXT, completed_on TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wf_tasks_monthly ON wf_tasks (company_id, division, period, template) WHERE template IS NOT NULL;
      CREATE INDEX IF NOT EXISTS wf_tasks_period ON wf_tasks (period, division);
      CREATE TABLE IF NOT EXISTS wf_events (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES wf_tasks(id),
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        user_id INTEGER, action TEXT NOT NULL, from_stage TEXT, to_stage TEXT, note TEXT
      );
      CREATE INDEX IF NOT EXISTS wf_events_task ON wf_events (task_id);
      CREATE TABLE IF NOT EXISTS wf_flags (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES wf_tasks(id),
        raised_by INTEGER, raised_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        resolved_by INTEGER, resolved_at TEXT, resolution TEXT
      );
      -- Documents received from clients. 'verified' only when the sender is a registered authorised contact.
      CREATE TABLE IF NOT EXISTS wf_documents (
        id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), task_id INTEGER REFERENCES wf_tasks(id),
        title TEXT NOT NULL, received_from TEXT NOT NULL, channel TEXT NOT NULL,
        contact_id INTEGER, verified INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'received',
        received_by INTEGER, received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), note TEXT
      );
      -- A client's month, once every division is done, goes to Accounts for next month's advance billing.
      CREATE TABLE IF NOT EXISTS wf_billing (
        id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
        period TEXT NOT NULL, bill_month TEXT NOT NULL, closed_on TEXT NOT NULL,
        fee INTEGER NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 18,
        status TEXT NOT NULL DEFAULT 'ready',
        invoice_no TEXT, invoice_date TEXT, sent_at TEXT, sent_to TEXT,
        paid_on TEXT, paid_amount INTEGER, paid_ref TEXT,
        UNIQUE (company_id, period)
      );
      CREATE TABLE IF NOT EXISTS wf_attendance (
        user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, present INTEGER NOT NULL,
        marked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        verified TEXT, verified_by INTEGER, verified_at TEXT,
        PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS wf_reports (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, reviewer_id INTEGER NOT NULL REFERENCES users(id),
        start_day TEXT NOT NULL, end_day TEXT NOT NULL, snapshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', reviewed_at TEXT, comment TEXT,
        UNIQUE (kind, reviewer_id, start_day)
      );
      CREATE TABLE IF NOT EXISTS wf_actions (
        id INTEGER PRIMARY KEY, report_id INTEGER REFERENCES wf_reports(id),
        raised_by INTEGER NOT NULL, owner_id INTEGER NOT NULL, text TEXT NOT NULL, due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open', raised_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        done_at TEXT, done_note TEXT
      );
      CREATE TABLE IF NOT EXISTS wf_settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare("INSERT OR REPLACE INTO wf_meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  }

  // ---------- dates (calendar dates as YYYY-MM-DD strings, India time) ----------
  const todayIST = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const toDate = (s) => new Date(`${s}T00:00:00Z`);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toDate(s)) && fmt(toDate(s)) === s;
  const isPeriod = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  const nextPeriod = (p) => { let [y, m] = p.split('-').map(Number); m += 1; if (m > 12) { m = 1; y += 1; } return `${y}-${String(m).padStart(2, '0')}`; };
  function dueFor(period, targetDay) {
    const [y, m] = nextPeriod(period).split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(targetDay, last)).padStart(2, '0')}`;
  }
  const stageTarget = (t) => addDays(t.due_date, -(STAGE[t.stage] || STAGE.done).daysBefore);
  function timeliness(t, today) {
    if (t.stage === 'done') return t.completed_on && t.completed_on > t.due_date ? 'late' : 'on_time';
    if (today > t.due_date) return 'delayed';
    if (today > stageTarget(t)) return 'behind';
    return 'on_track';
  }
  // Indian financial year for invoice numbers: 2026-10-25 -> 2026-27.
  const fyOf = (day) => { const y = +day.slice(0, 4); const s = +day.slice(5, 7) >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
  const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);
  const normEmail = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };

  function createWorkflow(db, options = {}) {
    const today = () => (options.today ? options.today() : todayIST());
    const q = (sql, ...p) => db.prepare(sql).all(...p);
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const run = (sql, ...p) => db.prepare(sql).run(...p);
    const bad = (m) => { throw new WfError(400, m); };
    const forbid = (m) => { throw new WfError(403, m); };
    const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';

    // ---------- people, branches and reporting lines ----------
    function staffMap() {
      const rows = q(`SELECT u.id, u.name, u.email, u.role, u.disabled, s.level, s.department, s.branch_id, s.reports_to FROM users u
        LEFT JOIN wf_staff s ON s.user_id = u.id WHERE u.role IN ('team', 'admin') ORDER BY u.name`);
      return new Map(rows.map((r) => [r.id, r]));
    }
    function profile(user) {
      const s = one('SELECT level, department, branch_id, reports_to FROM wf_staff WHERE user_id = ?', user.id) || {};
      return { id: user.id, name: user.name, email: user.email, role: user.role, level: s.level || null, department: s.department || null, branch_id: s.branch_id || null, reports_to: s.reports_to || null, admin: user.role === 'admin' };
    }
    const rank = (p) => (p && p.level ? RANK[p.level] : 0);
    const isMp = (p) => p.level === 'mp';
    const seesAll = (p) => isMp(p) || p.admin;
    const inAccounts = (p) => p.department === 'accounts';
    const sameBranch = (p, branchId) => !p.branch_id || !branchId || p.branch_id === branchId;
    const isBranchHead = (p, branchId) => p.level === 'branch_head' && sameBranch(p, branchId);
    const canStructure = (p) => seesAll(p);
    const canOnboard = (p, branchId) => seesAll(p) || isBranchHead(p, branchId) || (p.level === 'head' && sameBranch(p, branchId));
    const canAllot = (p, div, branchId) => seesAll(p) || isBranchHead(p, branchId) || ((p.level === 'head' || p.level === 'manager') && p.department === deptOf(div) && sameBranch(p, branchId));
    const canBill = (p) => seesAll(p) || inAccounts(p) || p.level === 'branch_head';
    // A head or branch head with a branch sees only that branch; the MP and admins see every branch.
    const branchOk = (p, branchId) => seesAll(p) || !p.branch_id || !branchId || p.branch_id === branchId;

    function subordinates(id, staff) {
      const out = new Set(); let grew = true;
      while (grew) {
        grew = false;
        for (const s of staff.values()) if (s.reports_to && (s.reports_to === id || out.has(s.reports_to)) && !out.has(s.id) && s.id !== id) { out.add(s.id); grew = true; }
      }
      return out;
    }
    function upTo(id, minRank, staff) {
      let cur = staff.get(id); const seen = new Set();
      while (cur && cur.reports_to && !seen.has(cur.id)) {
        seen.add(cur.id); cur = staff.get(cur.reports_to);
        if (cur && RANK[cur.level] >= minRank) return cur.id;
      }
      return null;
    }
    function headOf(dept, branchId, staff) {
      const all = [...staff.values()].filter((s) => s.level === 'head' && s.department === dept);
      const h = all.find((s) => s.branch_id === branchId) || all[0];
      return h ? h.id : null;
    }
    function chainOf(assigneeId, div, staff) {
      const a = staff.get(assigneeId);
      const head = headOf(deptOf(div), a ? a.branch_id : null, staff);
      const checker = a && RANK[a.level] >= 3 ? null : upTo(assigneeId, 3, staff) || head;
      const approver = upTo(checker || assigneeId, 4, staff) || head;
      return { assignee: assigneeId || null, checker, approver, head };
    }
    function lastMover(taskId) {
      const e = one("SELECT user_id FROM wf_events WHERE task_id = ? AND action IN ('submit', 'approve') ORDER BY id DESC LIMIT 1", taskId);
      return e ? e.user_id : null;
    }
    function owner(t, chain) {
      if (t.stage === 'preparation') return chain.assignee;
      if (t.stage === 'check') return chain.checker || chain.approver;
      if (t.stage === 'approval') return chain.approver;
      return null;
    }
    // The step's owner, anyone above them in the reporting line, the department head, the branch head
    // or the Managing Partner may act. Never on work they moved themselves.
    function eligible(p, t, chain, staff) {
      if (t.stage === 'done' || !p.level) return false;
      if (isMp(p)) return true;
      if (t.stage === 'mp') return false;
      if (isBranchHead(p, t.branch_id)) return true;
      if (p.department !== deptOf(t.division)) return false;
      if (p.level === 'head' && sameBranch(p, t.branch_id)) return true;
      const o = owner(t, chain);
      if (o === p.id) return true;
      return o != null && subordinates(p.id, staff).has(o) && rank(p) >= STAGE[t.stage].need;
    }
    function canAct(p, t, chain, staff) {
      if (!eligible(p, t, chain, staff)) return false;
      if (t.stage !== 'preparation' && lastMover(t.id) === p.id) return false;
      return true;
    }
    // After a submit or approval: skip steps the actor's seniority already covers, but a submit always
    // goes to at least one more person.
    function nextStage(from, actorRank, hasFlag, isSubmit) {
      let i = ORDER.indexOf(from) + 1;
      while (i < ORDER.length) {
        const k = ORDER[i];
        if (k === 'mp' && !hasFlag) { i++; continue; }
        if (k === 'done' || STAGE[k].need > actorRank) return k;
        i++;
      }
      return isSubmit ? 'approval' : 'done';
    }

    const TASK_SELECT = `SELECT t.*, c.code AS company_code, c.name AS company_name, u.name AS assignee_name, cl.branch_id,
        (SELECT COUNT(*) FROM wf_flags f WHERE f.task_id = t.id AND f.status = 'open') AS open_flags,
        (SELECT COUNT(*) FROM wf_documents d WHERE d.task_id = t.id AND d.verified = 0 AND d.status = 'received') AS unverified_docs
      FROM wf_tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN wf_clients cl ON cl.company_id = t.company_id`;

    function decorate(t, p, staff) {
      const now = today();
      const chain = chainOf(t.assignee_id, t.division, staff);
      const s = STAGE[t.stage];
      const ownerId = owner(t, chain);
      const can = p ? canAct(p, t, chain, staff) : false;
      return Object.assign({}, t, {
        department: deptOf(t.division),
        stage_name: s.name, waiting_on: s.who,
        owner_id: ownerId, owner_name: ownerId && staff.get(ownerId) ? staff.get(ownerId).name : (t.stage === 'mp' ? 'Managing Partner' : null),
        checker_id: chain.checker, approver_id: chain.approver,
        stage_target: t.stage === 'done' ? null : stageTarget(t),
        timeliness: timeliness(t, now),
        days_left: t.stage === 'done' ? null : daysBetween(now, t.due_date),
        days_late: t.stage === 'done' ? Math.max(0, t.completed_on ? daysBetween(t.due_date, t.completed_on) : 0) : Math.max(0, daysBetween(t.due_date, now)),
        can_act: can,
        my_turn: !!p && can && (ownerId === p.id || (t.stage === 'mp' && isMp(p))),
      });
    }

    // Each person sees only the work allotted to them and to people reporting to them; a department head
    // their department in their branch; a branch head the branch; the Managing Partner everything.
    function visibleFilter(p, staff) {
      if (seesAll(p)) return () => true;
      if (!p.level) return () => false;
      if (p.level === 'branch_head') return (t) => sameBranch(p, t.branch_id);
      if (p.level === 'head') return (t) => t.department === p.department && sameBranch(p, t.branch_id);
      const subs = subordinates(p.id, staff);
      return (t) => t.assignee_id === p.id || subs.has(t.assignee_id) || t.checker_id === p.id || t.approver_id === p.id;
    }

    function tasksFor(p, filters = {}) {
      const staff = staffMap();
      const where = []; const params = [];
      if (filters.period) { where.push('t.period = ?'); params.push(filters.period); }
      if (filters.division) { where.push('t.division = ?'); params.push(filters.division); }
      if (filters.company) { where.push('t.company_id = ?'); params.push(Number(filters.company)); }
      if (filters.assignee) { where.push('t.assignee_id = ?'); params.push(Number(filters.assignee)); }
      if (filters.branch) { where.push('cl.branch_id = ?'); params.push(Number(filters.branch)); }
      let rows = q(`${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.due_date, c.name, t.id`, ...params)
        .map((t) => decorate(t, p, staff));
      if (filters.department) rows = rows.filter((t) => t.department === filters.department);
      const mine = rows.filter(visibleFilter(p, staff));
      const st = filters.status;
      if (st === 'open') return mine.filter((t) => t.stage !== 'done');
      if (st === 'delayed') return mine.filter((t) => t.timeliness === 'delayed' || t.timeliness === 'behind');
      if (st === 'flagged') return mine.filter((t) => t.open_flags > 0);
      if (st === 'done') return mine.filter((t) => t.stage === 'done');
      if (st === 'mine') return mine.filter((t) => t.my_turn);
      return mine;
    }

    function getTask(id, p) {
      const staff = staffMap();
      const t = one(`${TASK_SELECT} WHERE t.id = ?`, Number(id));
      if (!t) throw new WfError(404, 'Task not found.');
      const d = decorate(t, p, staff);
      if (!visibleFilter(p, staff)(d)) forbid('This task is allotted to someone outside your reporting line.');
      return { t: d, staff };
    }

    function summarise(rows) {
      const s = { total: rows.length, done: 0, on_time: 0, late: 0, delayed: 0, behind: 0, open: 0, flagged: 0 };
      rows.forEach((t) => {
        if (t.stage === 'done') { s.done++; s[t.timeliness]++; } else { s.open++; if (t.timeliness === 'delayed') s.delayed++; if (t.timeliness === 'behind') s.behind++; }
        if (t.open_flags) s.flagged++;
      });
      s.on_time_rate = s.done ? Math.round((s.on_time / s.done) * 100) : null;
      return s;
    }
    function latestPeriod() {
      const r = one('SELECT MAX(period) AS p FROM wf_tasks');
      if (r && r.p) return r.p;
      const d = toDate(today()); d.setUTCMonth(d.getUTCMonth() - 1);
      return fmt(d).slice(0, 7);
    }
    function logEvent(taskId, p, action, from, to, note) {
      run('INSERT INTO wf_events (task_id, user_id, action, from_stage, to_stage, note) VALUES (?, ?, ?, ?, ?, ?)',
        taskId, p.id, action, from || null, to || null, note ? String(note).slice(0, 1000) : null);
    }
    const settings = () => Object.assign({}, DEFAULT_SETTINGS, Object.fromEntries(q('SELECT key, value FROM wf_settings').map((r) => [r.key, r.value])));

    // When the last task of a client's month is done, the month goes to Accounts for advance billing.
    function closeMonthIfDone(companyId, period) {
      const r = one("SELECT COUNT(*) AS total, SUM(stage <> 'done') AS open FROM wf_tasks WHERE company_id = ? AND period = ?", companyId, period);
      if (!r.total || r.open) return false;
      if (one('SELECT 1 FROM wf_billing WHERE company_id = ? AND period = ?', companyId, period)) return false;
      const c = one('SELECT monthly_fee FROM wf_clients WHERE company_id = ?', companyId) || { monthly_fee: 0 };
      run('INSERT INTO wf_billing (company_id, period, bill_month, closed_on, fee, gst_rate) VALUES (?, ?, ?, ?, ?, ?)',
        companyId, period, nextPeriod(period), today(), c.monthly_fee || 0, Number(settings().gst_rate) || 0);
      return true;
    }
    function setStage(t, to) {
      if (to === 'done') {
        run('UPDATE wf_tasks SET stage = ?, completed_at = ?, completed_on = ? WHERE id = ?', to, nowIso(), today(), t.id);
        closeMonthIfDone(t.company_id, t.period);
      } else run('UPDATE wf_tasks SET stage = ?, completed_at = NULL, completed_on = NULL WHERE id = ?', to, t.id);
    }

    function matchContact(companyId, from) {
      const contacts = q('SELECT * FROM wf_contacts WHERE company_id = ? AND removed = 0 AND authorised = 1', companyId);
      const e = normEmail(from); const ph = normPhone(from);
      return contacts.find((c) => (c.email && normEmail(c.email) === e) || (ph.length === 10 && normPhone(c.phone) === ph)) || null;
    }

    // ---------- clients ----------
    function clientRow(c, cl, allots, month, staff, branches) {
      const divs = {};
      DIV_KEYS.forEach((dk) => {
        const a = allots.find((x) => x.company_id === c.id && x.division === dk);
        const ts = month.filter((t) => t.company_id === c.id && t.division === dk);
        const s = summarise(ts);
        divs[dk] = a ? {
          applicable: !!a.applicable, assignee_id: a.assignee_id, assignee_name: a.assignee_id && staff.get(a.assignee_id) ? staff.get(a.assignee_id).name : null,
          tasks: s.total, done: s.done, delayed: s.delayed, flagged: s.flagged, complete: s.total > 0 && s.done === s.total,
        } : null;
      });
      const withTasks = Object.values(divs).filter((d) => d && d.tasks);
      const br = cl && branches.get(cl.branch_id);
      return {
        id: c.id, code: c.code, name: c.name, entity_type: cl ? cl.entity_type : null, monthly_fee: cl ? cl.monthly_fee : 0, target_day: cl ? cl.target_day : DEFAULT_TARGET_DAY,
        branch_id: cl ? cl.branch_id : null, branch_name: br ? br.name : null, active: cl ? !!cl.active : true, onboarded: !!cl,
        divisions: divs, complete: withTasks.length > 0 && withTasks.every((d) => d.complete),
      };
    }
    function visibleClients(p, period) {
      const staff = staffMap();
      const branches = new Map(q('SELECT * FROM wf_branches').map((b) => [b.id, b]));
      const companies = q('SELECT id, code, name FROM companies ORDER BY name');
      const cls = new Map(q('SELECT * FROM wf_clients').map((c) => [c.company_id, c]));
      const allots = q('SELECT * FROM wf_allotments');
      const month = q(`${TASK_SELECT} WHERE t.period = ?`, period).map((t) => decorate(t, null, staff));
      const br = (c) => (cls.get(c.id) || {}).branch_id;
      let visible;
      if (seesAll(p)) visible = () => true;
      else if (p.level === 'branch_head' || inAccounts(p)) visible = (c) => branchOk(p, br(c));
      else if (p.level === 'head' || p.level === 'manager') visible = (c) => branchOk(p, br(c)) && allots.some((a) => a.company_id === c.id && deptOf(a.division) === p.department);
      else { const subs = subordinates(p.id, staff); visible = (c) => allots.some((a) => a.company_id === c.id && (a.assignee_id === p.id || subs.has(a.assignee_id))); }
      return { staff, branches, rows: companies.filter(visible).map((c) => clientRow(c, cls.get(c.id), allots, month, staff, branches)) };
    }

    // ---------- reports ----------
    const EPOCH = '2026-01-01';
    function windowsFor(kind, now) {
      if (kind === 'two_day') {
        const k = Math.floor(daysBetween(EPOCH, now) / 2);
        return [k - 1, k - 2, k - 3].filter((i) => i >= 0).map((i) => [addDays(EPOCH, i * 2), addDays(EPOCH, i * 2 + 1)]);
      }
      const dow = (toDate(now).getUTCDay() + 6) % 7;
      const thisMon = addDays(now, -dow);
      return [1, 2].map((w) => [addDays(thisMon, -7 * w), addDays(thisMon, -7 * w + 6)]);
    }
    function snapshot(inScope, start, end, staff) {
      const all = q(TASK_SELECT).map((t) => decorate(t, null, staff));
      const tasks = all.filter((t) => inScope.task(t));
      const people = new Map();
      const personOf = (id) => {
        if (!people.has(id)) { const s = staff.get(id); people.set(id, { id, name: s ? s.name : 'Not allotted', level: s ? s.level : null, department: s ? s.department : null, open: 0, overdue: 0, completed: 0, completed_late: 0, returned: 0, flags: 0, present: 0, absent: 0, marked: 0 }); }
        return people.get(id);
      };
      staff.forEach((s) => { if (s.level && inScope.person(s)) personOf(s.id); });
      tasks.forEach((t) => {
        const x = personOf(t.assignee_id);
        if (!(t.completed_on && t.completed_on <= end) && t.created_at.slice(0, 10) <= end) { x.open++; if (end > t.due_date) x.overdue++; }
        if (t.completed_on && t.completed_on >= start && t.completed_on <= end) { x.completed++; if (t.completed_on > t.due_date) x.completed_late++; }
      });
      const byId = new Map(tasks.map((t) => [t.id, t]));
      q("SELECT task_id, action FROM wf_events WHERE action IN ('return', 'flag') AND substr(at, 1, 10) BETWEEN ? AND ?", start, end).forEach((e) => {
        const t = byId.get(e.task_id); if (!t) return;
        personOf(t.assignee_id)[e.action === 'return' ? 'returned' : 'flags']++;
      });
      q('SELECT user_id, present FROM wf_attendance WHERE day BETWEEN ? AND ?', start, end).forEach((a) => {
        if (!people.has(a.user_id)) return;
        const x = people.get(a.user_id); x.marked++; if (a.present) x.present++; else x.absent++;
      });
      const overdue = tasks.filter((t) => t.stage !== 'done' && end > t.due_date)
        .map((t) => ({ id: t.id, company_name: t.company_name, title: t.title, division: t.division, assignee_name: t.assignee_name, stage_name: t.stage_name, days_late: daysBetween(t.due_date, end) }))
        .sort((a, b) => b.days_late - a.days_late).slice(0, 40);
      return { people: [...people.values()].filter((x) => x.id), overdue };
    }
    const totals = (people) => people.reduce((a, x) => ({ open: a.open + x.open, overdue: a.overdue + x.overdue, completed: a.completed + x.completed, completed_late: a.completed_late + x.completed_late }), { open: 0, overdue: 0, completed: 0, completed_late: 0 });
    // Reviews of the reports below, read when the consolidated report is opened, so a review recorded
    // after the period still shows.
    function reviewsIn(start, end, reviewer) {
      const inBranch = (b) => !reviewer.branch_id || reviewer.level === 'mp' || !b || b === reviewer.branch_id;
      return q(`SELECT r.kind, r.status, r.comment, u.name, st.department, st.branch_id FROM wf_reports r JOIN users u ON u.id = r.reviewer_id
        LEFT JOIN wf_staff st ON st.user_id = r.reviewer_id WHERE r.kind <> 'consolidated' AND r.end_day BETWEEN ? AND ? ORDER BY r.status, u.name`, start, end).filter((r) => inBranch(r.branch_id));
    }
    function ensureReports(staff) {
      const now = today();
      for (const s of staff.values()) {
        if (!s.level || s.disabled) continue;
        let kind = null;
        if (s.level === 'mp' || s.level === 'branch_head') kind = 'consolidated';
        else if (s.level === 'head') kind = 'weekly';
        else if (RANK[s.level] >= 3 && [...staff.values()].some((x) => x.reports_to === s.id)) kind = 'two_day';
        if (!kind) continue;
        for (const [start, end] of windowsFor(kind === 'two_day' ? 'two_day' : 'weekly', now)) {
          if (one('SELECT 1 FROM wf_reports WHERE kind = ? AND reviewer_id = ? AND start_day = ?', kind, s.id, start)) continue;
          let snap;
          const inBranch = (b) => !s.branch_id || s.level === 'mp' || !b || b === s.branch_id;
          if (kind === 'consolidated') {
            snap = { departments: DEPARTMENTS.filter((d) => !d.internal).map((d) => {
              const sn = snapshot({ task: (t) => t.department === d.key && inBranch(t.branch_id), person: (x) => x.department === d.key && inBranch(x.branch_id) && x.level !== 'head' }, start, end, staff);
              return Object.assign({ key: d.key, name: d.name, overdue_list: sn.overdue.slice(0, 5) }, totals(sn.people));
            }) };
            snap.actions = q(`SELECT a.text, a.status, a.due_date, o.name AS owner_name, b.name AS raised_by_name, st.branch_id FROM wf_actions a JOIN users o ON o.id = a.owner_id
              JOIN users b ON b.id = a.raised_by LEFT JOIN wf_staff st ON st.user_id = a.owner_id
              WHERE substr(a.raised_at, 1, 10) BETWEEN ? AND ? OR a.status = 'open' ORDER BY a.id DESC LIMIT 80`, start, end).filter((a) => inBranch(a.branch_id));
          } else if (kind === 'weekly') {
            snap = snapshot({ task: (t) => t.department === s.department && inBranch(t.branch_id), person: (x) => x.department === s.department && inBranch(x.branch_id) && x.id !== s.id }, start, end, staff);
            snap.actions = q(`SELECT a.text, a.status, o.name AS owner_name, st.branch_id FROM wf_actions a JOIN users o ON o.id = a.owner_id JOIN wf_staff st ON st.user_id = a.owner_id
              WHERE st.department = ? AND (a.status = 'open' OR substr(a.raised_at, 1, 10) BETWEEN ? AND ?)`, s.department, start, end).filter((a) => inBranch(a.branch_id));
          } else {
            const subs = subordinates(s.id, staff);
            snap = snapshot({ task: (t) => subs.has(t.assignee_id), person: (x) => subs.has(x.id) }, start, end, staff);
          }
          run('INSERT INTO wf_reports (kind, reviewer_id, start_day, end_day, snapshot) VALUES (?, ?, ?, ?, ?)', kind, s.id, start, end, JSON.stringify(snap));
        }
      }
    }
    function canSeeReport(p, r, staff) {
      if (seesAll(p) || r.reviewer_id === p.id) return true;
      const rev = staff.get(r.reviewer_id);
      if (!rev) return false;
      if (p.level === 'branch_head' && sameBranch(p, rev.branch_id)) return true;
      if (p.level === 'head' && rev.department === p.department && sameBranch(p, rev.branch_id)) return true;
      return subordinates(p.id, staff).has(r.reviewer_id);
    }
    const KIND_NAME = { two_day: 'Two-day status report', weekly: 'Weekly department report', consolidated: 'Consolidated report' };

    // ---------------- calls ----------------
    const calls = {
      'GET /api/wf/me': (p) => {
        const staff = staffMap();
        return {
          me: p, today: today(), departments: DEPARTMENTS, divisions: DIVISIONS, levels: LEVELS, stages: STAGES, entity_types: ENTITY_TYPES,
          branches: q('SELECT * FROM wf_branches ORDER BY name'),
          can: { structure: canStructure(p), onboard: seesAll(p) || p.level === 'branch_head' || p.level === 'head', allot: seesAll(p) || ['branch_head', 'head', 'manager'].includes(p.level),
            create: seesAll(p) || rank(p) >= 4, cycle: seesAll(p) || p.level === 'branch_head' || p.level === 'head', bill: canBill(p), verify_attendance: canBill(p) },
          period: latestPeriod(),
          periods: q('SELECT DISTINCT period FROM wf_tasks ORDER BY period DESC').map((r) => r.period),
          attendance_today: one('SELECT present, verified FROM wf_attendance WHERE user_id = ? AND day = ?', p.id, today()) || null,
          reviews_reports: seesAll(p) || rank(p) >= 5 || [...staff.values()].some((s) => s.reports_to === p.id),
        };
      },

      'GET /api/wf/home': (p, query) => {
        const period = isPeriod(query.period) ? query.period : latestPeriod();
        const all = tasksFor(p, {});
        const month = all.filter((t) => t.period === period);
        ensureReports(staffMap());
        const reportsDue = q("SELECT id, kind, start_day, end_day FROM wf_reports WHERE reviewer_id = ? AND status = 'pending' ORDER BY start_day DESC", p.id)
          .map((r) => Object.assign(r, { kind_name: KIND_NAME[r.kind] }));
        const myActions = q("SELECT a.*, b.name AS raised_by_name FROM wf_actions a JOIN users b ON b.id = a.raised_by WHERE a.owner_id = ? AND a.status = 'open' ORDER BY a.due_date", p.id);
        const ids = new Set(all.map((t) => t.id));
        const flags = q(`SELECT f.*, t.title, t.division, t.company_id, c.name AS company_name, u.name AS raised_by_name FROM wf_flags f JOIN wf_tasks t ON t.id = f.task_id
          JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = f.raised_by WHERE f.status = 'open' ORDER BY f.id DESC`).filter((f) => ids.has(f.task_id));
        return {
          period,
          mine: all.filter((t) => t.my_turn).slice(0, 60),
          delayed: all.filter((t) => t.timeliness === 'delayed').sort((a, b) => b.days_late - a.days_late).slice(0, 60),
          behind: all.filter((t) => t.timeliness === 'behind').slice(0, 60),
          flags, reportsDue, myActions,
          billingReady: canBill(p) ? one("SELECT COUNT(*) AS n FROM wf_billing WHERE status IN ('ready', 'invoiced')").n : null,
          month: summarise(month),
          byDepartment: DEPARTMENTS.filter((d) => !d.internal).map((d) => Object.assign({ key: d.key, name: d.name }, summarise(month.filter((t) => t.department === d.key)))).filter((d) => d.total),
        };
      },

      'GET /api/wf/tasks': (p, query) => ({ tasks: tasksFor(p, query) }),

      'GET /api/wf/task': (p, query) => {
        const { t, staff } = getTask(query.id, p);
        const events = q('SELECT e.*, u.name AS user_name FROM wf_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.id', t.id);
        const flags = q(`SELECT f.*, a.name AS raised_by_name, b.name AS resolved_by_name FROM wf_flags f LEFT JOIN users a ON a.id = f.raised_by
          LEFT JOIN users b ON b.id = f.resolved_by WHERE f.task_id = ? ORDER BY f.id`, t.id);
        const docs = q(`SELECT d.*, c.name AS contact_name, c.role AS contact_role, u.name AS received_by_name FROM wf_documents d LEFT JOIN wf_contacts c ON c.id = d.contact_id
          LEFT JOIN users u ON u.id = d.received_by WHERE d.task_id = ? ORDER BY d.id`, t.id);
        const chain = chainOf(t.assignee_id, t.division, staff);
        const nm = (id) => (id && staff.get(id) ? staff.get(id).name : null);
        const actions = [];
        if (t.can_act) { if (t.stage === 'preparation') actions.push('submit'); else actions.push('approve', 'return'); }
        if (t.stage !== 'done') actions.push('flag', 'document');
        if (isMp(p) && flags.some((f) => f.status === 'open')) actions.push('resolve');
        if (t.stage !== 'done' && (seesAll(p) || isBranchHead(p, t.branch_id) || (rank(p) >= 4 && p.department === t.department))) actions.push('reschedule');
        if (t.stage === 'done' && (seesAll(p) || isBranchHead(p, t.branch_id) || (p.level === 'head' && p.department === t.department))) actions.push('reopen');
        if (rank(p) >= 3 || seesAll(p)) actions.push('set_aside');
        const hasFlag = flags.some((f) => f.status === 'open') || events.some((e) => e.from_stage === 'mp' || e.to_stage === 'mp');
        const steps = STAGES.filter((s) => s.key !== 'done' && (s.key !== 'mp' || hasFlag)).map((s) => ({
          key: s.key, name: s.name, who: s.who, target: addDays(t.due_date, -s.daysBefore),
          person: s.key === 'preparation' ? nm(chain.assignee) : s.key === 'check' ? nm(chain.checker || chain.approver) : s.key === 'approval' ? nm(chain.approver) : null,
        }));
        let note = null;
        if (!t.can_act && t.stage !== 'done' && eligible(p, t, chain, staff)) note = 'You moved this task to this step, so someone else must check it.';
        if (t.unverified_docs && ['check', 'approval', 'mp'].includes(t.stage)) note = 'A document on this task did not come from a registered contact of the client. It cannot be approved until it is received from the proper source or set aside.';
        return { task: t, events, flags, documents: docs, actions, chain: steps, head: nm(chain.head), note };
      },

      // Body: { id, action: 'submit' | 'approve' | 'return' | 'reopen', note }
      'POST /api/wf/task/action': (p, query, body) => {
        const { t, staff } = getTask(body.id, p);
        const note = String(body.note || '').trim();
        const action = body.action;
        if (action === 'reopen') {
          if (t.stage !== 'done') bad('This task is still open.');
          if (!(seesAll(p) || isBranchHead(p, t.branch_id) || (p.level === 'head' && p.department === t.department))) forbid('Only the department head, the branch head or the Managing Partner can reopen completed work.');
          if (!note) bad('Say why the task is being reopened.');
          setStage(t, 'preparation'); logEvent(t.id, p, 'reopen', 'done', 'preparation', note);
          return { ok: true, stage: 'preparation' };
        }
        if (!['submit', 'approve', 'return'].includes(action)) bad('Unknown action.');
        const chain = chainOf(t.assignee_id, t.division, staff);
        if (!canAct(p, t, chain, staff)) {
          if (eligible(p, t, chain, staff)) forbid('You moved this task to this step, so someone else must check it.');
          forbid(`This step is waiting on ${t.owner_name || 'the ' + STAGE[t.stage].who.toLowerCase()}.`);
        }
        if (action === 'submit' && t.stage !== 'preparation') bad('This task has already been submitted.');
        if (action !== 'submit' && t.stage === 'preparation') bad('Submit the work first.');
        if (action === 'return') {
          if (!note) bad('Say what needs to change before it comes back.');
          setStage(t, 'preparation'); logEvent(t.id, p, 'return', t.stage, 'preparation', note);
          return { ok: true, stage: 'preparation' };
        }
        if (action === 'approve' && t.unverified_docs) bad('A document on this task did not come from a registered contact of the client. Get it from the proper source, or set it aside, before approving.');
        const flags = one("SELECT COUNT(*) AS n FROM wf_flags WHERE task_id = ? AND status = 'open'", t.id).n;
        if (isMp(p) && action === 'approve') {
          if (flags && !note) bad('Add a note on how the flagged matter is settled.');
          run("UPDATE wf_flags SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE task_id = ? AND status = 'open'", p.id, nowIso(), note || 'Approved by the Managing Partner', t.id);
        }
        const to = isMp(p) && action === 'approve' ? 'done' : nextStage(t.stage, rank(p), flags > 0, action === 'submit');
        setStage(t, to); logEvent(t.id, p, action, t.stage, to, note);
        return { ok: true, stage: to };
      },

      'POST /api/wf/task/flag': (p, query, body) => {
        const { t } = getTask(body.id, p);
        const reason = String(body.reason || '').trim();
        if (reason.length < 5) bad('Describe the issue so the Managing Partner can decide on it.');
        if (t.stage === 'done') bad('This task is complete. Reopen it first.');
        run('INSERT INTO wf_flags (task_id, raised_by, reason) VALUES (?, ?, ?)', t.id, p.id, reason.slice(0, 1000));
        logEvent(t.id, p, 'flag', t.stage, t.stage, reason);
        return { ok: true };
      },

      'POST /api/wf/flag/resolve': (p, query, body) => {
        if (!isMp(p)) forbid('Only the Managing Partner resolves flags.');
        const f = one('SELECT * FROM wf_flags WHERE id = ?', Number(body.flag_id));
        if (!f || f.status !== 'open') bad('That flag is not open.');
        const resolution = String(body.resolution || '').trim();
        if (!resolution) bad('Record the decision.');
        run("UPDATE wf_flags SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?", p.id, nowIso(), resolution.slice(0, 1000), f.id);
        const t = one('SELECT * FROM wf_tasks WHERE id = ?', f.task_id);
        logEvent(t.id, p, 'resolve', t.stage, t.stage, resolution);
        if (t.stage === 'mp' && !one("SELECT 1 FROM wf_flags WHERE task_id = ? AND status = 'open'", t.id)) { setStage(t, 'done'); logEvent(t.id, p, 'approve', 'mp', 'done', 'Flag resolved'); }
        return { ok: true };
      },

      'POST /api/wf/task/reschedule': (p, query, body) => {
        const { t } = getTask(body.id, p);
        if (!(seesAll(p) || isBranchHead(p, t.branch_id) || (rank(p) >= 4 && p.department === t.department))) forbid('Only a manager or above can change a target date.');
        if (!isDate(body.due_date)) bad('Choose a valid date.');
        const note = String(body.note || '').trim();
        if (!note) bad('Say why the target date is changing.');
        run('UPDATE wf_tasks SET due_date = ? WHERE id = ?', body.due_date, t.id);
        logEvent(t.id, p, 'reschedule', t.stage, t.stage, `${t.due_date} → ${body.due_date}: ${note}`);
        return { ok: true };
      },

      // Body: { company_id, division, title, due_date, period }
      'POST /api/wf/task': (p, query, body) => {
        const div = body.division;
        if (!DIV[div]) bad('Choose a division.');
        const cl = one('SELECT * FROM wf_clients WHERE company_id = ?', Number(body.company_id));
        if (!cl) bad('Choose a client.');
        if (!(seesAll(p) || isBranchHead(p, cl.branch_id) || (rank(p) >= 4 && p.department === deptOf(div)))) forbid('Only a manager or above in this department can add tasks.');
        const title = String(body.title || '').trim();
        if (title.length < 3) bad('Describe the task.');
        if (!isDate(body.due_date)) bad('Choose a target date.');
        const a = one('SELECT assignee_id FROM wf_allotments WHERE company_id = ? AND division = ?', cl.company_id, div);
        if (!a || !a.assignee_id) bad(`No one is allotted this client in ${DIV[div].name} yet. Allot someone on the client's page first.`);
        const period = isPeriod(body.period) ? body.period : body.due_date.slice(0, 7);
        const r = run('INSERT INTO wf_tasks (company_id, division, assignee_id, period, title, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          cl.company_id, div, a.assignee_id, period, title.slice(0, 200), body.due_date, p.id);
        const id = Number(r.lastInsertRowid);
        logEvent(id, p, 'create', null, 'preparation', null);
        return { ok: true, id };
      },

      // Body: { period }. Each applicable division gets its monthly work; a division marked not applicable
      // gets the monthly applicability review. Safe to run again.
      'POST /api/wf/cycle': (p, query, body) => {
        if (!isPeriod(body.period)) bad('Choose the month.');
        if (!(seesAll(p) || p.level === 'branch_head' || p.level === 'head')) forbid('Only a department head, a branch head or the Managing Partner can start the month.');
        let created = 0; const missing = [];
        const allots = q(`SELECT a.*, c.target_day, c.active, c.branch_id, co.name AS company_name FROM wf_allotments a JOIN wf_clients c ON c.company_id = a.company_id
          JOIN companies co ON co.id = a.company_id`).filter((a) => (seesAll(p) || branchOk(p, a.branch_id)) && (p.level !== 'head' || deptOf(a.division) === p.department));
        for (const a of allots) {
          if (!a.active) continue;
          if (!a.assignee_id) { missing.push(`${a.company_name} (${DIV[a.division].name})`); continue; }
          const [tpl, title] = a.applicable ? [a.division, DIV[a.division].task] : [`review-${a.division}`, reviewTitle(a.division)];
          if (one('SELECT 1 FROM wf_tasks WHERE company_id = ? AND division = ? AND period = ? AND template = ?', a.company_id, a.division, body.period, tpl)) continue;
          const r = run('INSERT INTO wf_tasks (company_id, division, assignee_id, period, template, title, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            a.company_id, a.division, a.assignee_id, body.period, tpl, title, dueFor(body.period, a.target_day), p.id);
          logEvent(Number(r.lastInsertRowid), p, 'create', null, 'preparation', null);
          created++;
        }
        return { ok: true, created, period: body.period, missing };
      },

      // ---------- the client database ----------
      'GET /api/wf/clients': (p, query) => {
        const period = isPeriod(query.period) ? query.period : latestPeriod();
        let rows = visibleClients(p, period).rows;
        if (query.branch) rows = rows.filter((c) => String(c.branch_id) === String(query.branch));
        return { period, clients: rows };
      },

      'GET /api/wf/client': (p, query) => {
        const id = Number(query.id);
        const period = isPeriod(query.period) ? query.period : latestPeriod();
        const { rows, staff } = visibleClients(p, period);
        const listed = rows.find((c) => c.id === id);
        if (!listed) forbid('This client is not allotted to you or your reporting line.');
        const profileRow = one('SELECT * FROM wf_clients WHERE company_id = ?', id) || { company_id: id };
        const contacts = q('SELECT * FROM wf_contacts WHERE company_id = ? AND removed = 0 ORDER BY role, name', id);
        const nm = (x) => (x && staff.get(x) ? staff.get(x).name : null);
        const allots = q('SELECT * FROM wf_allotments WHERE company_id = ?', id).map((a) => {
          const ch = chainOf(a.assignee_id, a.division, staff);
          return Object.assign(a, { department: deptOf(a.division), assignee_name: nm(a.assignee_id), chain: { checker: nm(ch.checker), approver: nm(ch.approver), head: nm(ch.head) } });
        });
        const log = q('SELECT l.*, u.name AS by_name FROM wf_allot_log l LEFT JOIN users u ON u.id = l.by_id WHERE l.company_id = ? ORDER BY l.id DESC LIMIT 40', id);
        const documents = q(`SELECT d.*, c.name AS contact_name, c.role AS contact_role, u.name AS received_by_name, t.title AS task_title FROM wf_documents d
          LEFT JOIN wf_contacts c ON c.id = d.contact_id LEFT JOIN users u ON u.id = d.received_by LEFT JOIN wf_tasks t ON t.id = d.task_id
          WHERE d.company_id = ? ORDER BY d.id DESC LIMIT 60`, id);
        const billing = canBill(p) ? q('SELECT * FROM wf_billing WHERE company_id = ? ORDER BY period DESC LIMIT 12', id) : [];
        const people = [...staff.values()].filter((s) => s.level && RANK[s.level] <= 4 && s.department && !DEPT[s.department].internal && (!profileRow.branch_id || !s.branch_id || s.branch_id === profileRow.branch_id))
          .map((s) => ({ id: s.id, name: s.name, level: s.level, department: s.department }));
        return {
          period, client: listed, profile: profileRow, contacts, allotments: allots, log, documents, billing,
          tasks: tasksFor(p, { period, company: id }),
          can: { edit: canOnboard(p, profileRow.branch_id), allot: DIV_KEYS.filter((d) => canAllot(p, d, profileRow.branch_id)), set_aside: rank(p) >= 3 || seesAll(p) },
          people,
        };
      },

      // Body: { company_id?, code?, name, branch_id, entity_type, pan, gstin, tan, cin, address, billing_email, phone, monthly_fee, target_day, onboarded_on, active }
      // Without company_id this onboards a new client (added to the portal's companies too). The divisions
      // are set from the entity type and the GSTIN; each can be changed afterwards.
      'POST /api/wf/client': (p, query, body) => {
        const branchId = body.branch_id ? Number(body.branch_id) : (p.branch_id || null);
        if (branchId && !one('SELECT 1 FROM wf_branches WHERE id = ?', branchId)) bad('Choose a branch.');
        if (!canOnboard(p, branchId)) forbid('Only a department head, the branch head, the Managing Partner or an admin can onboard or change clients.');
        const entity = body.entity_type;
        if (!ENTITY[entity]) bad('Choose the type of entity.');
        const name = String(body.name || '').trim();
        if (name.length < 2 || name.length > 160) bad('Enter the client\'s name.');
        const fee = Math.round(Number(body.monthly_fee || 0));
        if (!(fee >= 0)) bad('Enter the monthly fee in rupees.');
        const day = Number(body.target_day || DEFAULT_TARGET_DAY);
        if (!Number.isInteger(day) || day < 1 || day > 31) bad('Target day must be between 1 and 31.');
        const email = String(body.billing_email || '').trim().toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid billing email.');
        const gstin = String(body.gstin || '').trim().toUpperCase();
        if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) bad('A GSTIN has 15 characters, for example 32ABCDE1234F1Z5.');
        const pan = String(body.pan || '').trim().toUpperCase();
        if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) bad('A PAN has 10 characters, for example ABCDE1234F.');
        let id = Number(body.company_id) || null;
        let created = false;
        if (!id) {
          const code = String(body.code || '').trim().toUpperCase();
          if (!/^[A-Z0-9-]{3,20}$/.test(code)) bad('Use a client code of 3 to 20 letters, digits or dashes, for example AE-0007.');
          if (one('SELECT 1 FROM companies WHERE code = ?', code)) bad(`Client code ${code} is already in use.`);
          id = Number(run('INSERT INTO companies (code, name) VALUES (?, ?)', code, name).lastInsertRowid);
          created = true;
        } else {
          if (!one('SELECT 1 FROM companies WHERE id = ?', id)) bad('Client not found.');
          const cur = one('SELECT branch_id FROM wf_clients WHERE company_id = ?', id);
          if (cur && !canOnboard(p, cur.branch_id)) forbid('This client belongs to another branch.');
          run('UPDATE companies SET name = ? WHERE id = ?', name, id);
        }
        const prev = one('SELECT entity_type FROM wf_clients WHERE company_id = ?', id);
        run(`INSERT INTO wf_clients (company_id, branch_id, entity_type, pan, gstin, tan, cin, address, billing_email, phone, monthly_fee, target_day, onboarded_on, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (company_id) DO UPDATE SET branch_id = excluded.branch_id, entity_type = excluded.entity_type, pan = excluded.pan, gstin = excluded.gstin,
            tan = excluded.tan, cin = excluded.cin, address = excluded.address, billing_email = excluded.billing_email, phone = excluded.phone,
            monthly_fee = excluded.monthly_fee, target_day = excluded.target_day, onboarded_on = COALESCE(excluded.onboarded_on, wf_clients.onboarded_on), active = excluded.active`,
          id, branchId, entity, pan || null, gstin || null, String(body.tan || '').trim().toUpperCase() || null, String(body.cin || '').trim().toUpperCase() || null,
          String(body.address || '').trim() || null, email || null, String(body.phone || '').trim() || null, fee, day,
          isDate(body.onboarded_on) ? body.onboarded_on : (prev ? null : today()), body.active === false || body.active === 0 ? 0 : 1);
        if (!prev || prev.entity_type !== entity) {
          const defaults = { direct_tax: 1, indirect_tax: gstin ? 1 : 0, labour: 0, companies_act: entity === 'company' ? 1 : 0, llp: entity === 'llp' ? 1 : 0,
            legal: ['partnership', 'proprietorship', 'ngo'].includes(entity) ? 1 : 0, assurance: 1 };
          const governance = ['companies_act', 'llp', 'legal'];
          for (const dk of DIV_KEYS) {
            if (!one('SELECT 1 FROM wf_allotments WHERE company_id = ? AND division = ?', id, dk)) run('INSERT INTO wf_allotments (company_id, division, applicable) VALUES (?, ?, ?)', id, dk, defaults[dk]);
            else if (governance.includes(dk)) run('UPDATE wf_allotments SET applicable = ? WHERE company_id = ? AND division = ?', defaults[dk], id, dk);
          }
          run('INSERT INTO wf_allot_log (company_id, division, by_id, change) VALUES (?, ?, ?, ?)', id, 'all', p.id, created ? `Client onboarded as ${ENTITY[entity].name}` : `Entity type changed to ${ENTITY[entity].name}`);
        }
        return { ok: true, id, created };
      },

      // Body: { company_id, id?, role, name, email, phone, authorised, remove }
      'POST /api/wf/contact': (p, query, body) => {
        const cid = Number(body.company_id);
        const cl = one('SELECT branch_id FROM wf_clients WHERE company_id = ?', cid);
        if (!cl) bad('Client not found.');
        if (!canOnboard(p, cl.branch_id)) forbid('Only a department head, the branch head, the Managing Partner or an admin can change client contacts.');
        if (body.id && body.remove) { run('UPDATE wf_contacts SET removed = 1 WHERE id = ? AND company_id = ?', Number(body.id), cid); return { ok: true }; }
        const role = String(body.role || '').trim();
        const name = String(body.name || '').trim();
        if (!role) bad('Choose the contact\'s role.');
        if (name.length < 2) bad('Enter the contact\'s name.');
        const email = String(body.email || '').trim().toLowerCase();
        const phone = String(body.phone || '').trim();
        if (!email && !phone) bad('Enter an email or a phone number. Documents are accepted only from these.');
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email.');
        if (phone && normPhone(phone).length !== 10) bad('Enter a 10-digit mobile number.');
        const auth = body.authorised === false || body.authorised === 0 ? 0 : 1;
        if (body.id) run('UPDATE wf_contacts SET role = ?, name = ?, email = ?, phone = ?, authorised = ? WHERE id = ? AND company_id = ?', role, name, email || null, phone || null, auth, Number(body.id), cid);
        else run('INSERT INTO wf_contacts (company_id, role, name, email, phone, authorised) VALUES (?, ?, ?, ?, ?, ?)', cid, role, name, email || null, phone || null, auth);
        return { ok: true };
      },

      // Body: { company_id, division, applicable, assignee_id, note }. One person per client per division.
      'POST /api/wf/allot': (p, query, body) => {
        const div = body.division;
        if (!DIV[div]) bad('Choose a division.');
        const cid = Number(body.company_id);
        const cl = one('SELECT branch_id FROM wf_clients WHERE company_id = ?', cid);
        if (!cl) bad('Complete the client\'s record first.');
        if (!canAllot(p, div, cl.branch_id)) forbid('Only the department head, a manager of the department, the branch head or the Managing Partner can allot this client.');
        const staff = staffMap();
        const assignee = body.assignee_id ? Number(body.assignee_id) : null;
        if (assignee) {
          const s = staff.get(assignee);
          if (!s || s.department !== deptOf(div) || !s.level || RANK[s.level] > 4) bad(`Choose a person in ${DEPT[deptOf(div)].name}.`);
          if (cl.branch_id && s.branch_id && s.branch_id !== cl.branch_id) bad('Choose a person from the client\'s branch.');
        }
        const cur = one('SELECT * FROM wf_allotments WHERE company_id = ? AND division = ?', cid, div) || {};
        const applicable = body.applicable === undefined ? (cur.applicable ?? 1) : (body.applicable ? 1 : 0);
        run(`INSERT INTO wf_allotments (company_id, division, applicable, assignee_id, since) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (company_id, division) DO UPDATE SET applicable = excluded.applicable, assignee_id = excluded.assignee_id,
            since = CASE WHEN wf_allotments.assignee_id IS excluded.assignee_id THEN wf_allotments.since ELSE excluded.since END`,
          cid, div, applicable, assignee, today());
        const changes = [];
        if ((cur.assignee_id || null) !== assignee) {
          const nm = (x) => (x && staff.get(x) ? staff.get(x).name : 'no one');
          changes.push(`${nm(cur.assignee_id)} → ${nm(assignee)}`);
          // Open work moves with the client to the new person.
          if (assignee) run("UPDATE wf_tasks SET assignee_id = ? WHERE company_id = ? AND division = ? AND stage <> 'done'", assignee, cid, div);
        }
        if (cur.applicable !== undefined && !!cur.applicable !== !!applicable) changes.push(applicable ? 'now applicable' : 'marked not applicable');
        const note = String(body.note || '').trim();
        if (changes.length) run('INSERT INTO wf_allot_log (company_id, division, by_id, change) VALUES (?, ?, ?, ?)', cid, div, p.id, changes.join('; ') + (note ? ` (${note})` : ''));
        return { ok: true };
      },

      // ---------- documents (source-verified) ----------
      // Body: { company_id, task_id?, title, received_from, channel }
      'POST /api/wf/document': (p, query, body) => {
        const cid = Number(body.company_id);
        if (!visibleClients(p, latestPeriod()).rows.some((c) => c.id === cid)) forbid('This client is not allotted to you or your reporting line.');
        const title = String(body.title || '').trim();
        if (title.length < 3) bad('Describe the document.');
        const from = String(body.received_from || '').trim();
        if (!from) bad('Enter the email or phone number it came from.');
        const channel = ['email', 'whatsapp', 'portal', 'courier', 'in person'].includes(body.channel) ? body.channel : bad('Choose how it was received.');
        let taskId = null;
        if (body.task_id) { const { t } = getTask(body.task_id, p); if (t.company_id !== cid) bad('That task belongs to another client.'); taskId = t.id; }
        const match = matchContact(cid, from);
        run('INSERT INTO wf_documents (company_id, task_id, title, received_from, channel, contact_id, verified, received_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          cid, taskId, title.slice(0, 200), from.slice(0, 200), channel, match ? match.id : null, match ? 1 : 0, p.id);
        if (taskId) logEvent(taskId, p, 'document', null, null, `${title} from ${from}${match ? ` (${match.name}, ${match.role})` : ': not a registered contact'}`);
        return { ok: true, verified: !!match, contact: match ? `${match.name}, ${match.role}` : null };
      },
      // Body: { id, note }. Sets aside a document that did not come from a registered source.
      'POST /api/wf/document/reject': (p, query, body) => {
        const d = one('SELECT * FROM wf_documents WHERE id = ?', Number(body.id));
        if (!d) bad('Document not found.');
        if (!(seesAll(p) || rank(p) >= 3)) forbid('A supervisor or above sets documents aside.');
        if (!visibleClients(p, latestPeriod()).rows.some((c) => c.id === d.company_id)) forbid('This client is not allotted to you or your reporting line.');
        const note = String(body.note || '').trim();
        if (!note) bad('Say why it is set aside, and what was asked of the client.');
        run("UPDATE wf_documents SET status = 'rejected', note = ? WHERE id = ?", note.slice(0, 500), d.id);
        if (d.task_id) logEvent(d.task_id, p, 'document', null, null, `Set aside: ${d.title}. ${note}`);
        return { ok: true };
      },

      // ---------- billing (Accounts) ----------
      'GET /api/wf/billing': (p) => {
        if (!canBill(p)) forbid('Billing is for the Accounts department, the branch head and the Managing Partner.');
        const rows = q(`SELECT b.*, c.code, c.name, cl.billing_email, cl.gstin, cl.branch_id FROM wf_billing b JOIN companies c ON c.id = b.company_id
          LEFT JOIN wf_clients cl ON cl.company_id = b.company_id ORDER BY CASE b.status WHEN 'ready' THEN 0 WHEN 'invoiced' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END, b.closed_on DESC, c.name`)
          .filter((r) => branchOk(p, r.branch_id));
        rows.forEach((r) => { r.gst = Math.round((r.fee * r.gst_rate) / 100); r.total = r.fee + r.gst; });
        const outstanding = rows.filter((r) => r.status === 'sent').reduce((a, r) => a + r.total, 0);
        return { rows, outstanding, settings: settings(), can_settings: seesAll(p) || (inAccounts(p) && rank(p) >= 5) };
      },
      'POST /api/wf/billing/invoice': (p, query, body) => {
        if (!canBill(p)) forbid('Billing is for the Accounts department, the branch head and the Managing Partner.');
        const b = one('SELECT b.*, cl.branch_id FROM wf_billing b LEFT JOIN wf_clients cl ON cl.company_id = b.company_id WHERE b.id = ?', Number(body.id));
        if (!b || !branchOk(p, b.branch_id)) bad('Billing item not found.');
        if (b.status !== 'ready') bad('This invoice has already been raised.');
        const fee = (one('SELECT monthly_fee FROM wf_clients WHERE company_id = ?', b.company_id) || {}).monthly_fee || b.fee;
        if (!fee) bad('Set the client\'s monthly fee on the client record first.');
        const s = settings(); const day = today(); const fy = fyOf(day);
        const n = one('SELECT COUNT(*) AS n FROM wf_billing WHERE invoice_no LIKE ?', `${s.invoice_prefix}/${fy}/%`).n + 1;
        const no = `${s.invoice_prefix}/${fy}/${String(n).padStart(4, '0')}`;
        run("UPDATE wf_billing SET status = 'invoiced', invoice_no = ?, invoice_date = ?, fee = ? WHERE id = ?", no, day, fee, b.id);
        return { ok: true, invoice_no: no };
      },
      'GET /api/wf/billing/invoice': (p, query) => {
        if (!canBill(p)) forbid('Billing is for the Accounts department, the branch head and the Managing Partner.');
        const b = one('SELECT b.*, c.code, c.name FROM wf_billing b JOIN companies c ON c.id = b.company_id WHERE b.id = ?', Number(query.id));
        if (!b || !b.invoice_no) bad('Raise the invoice first.');
        const cl = one('SELECT * FROM wf_clients WHERE company_id = ?', b.company_id) || {};
        if (!branchOk(p, cl.branch_id)) bad('Billing item not found.');
        const contacts = q("SELECT * FROM wf_contacts WHERE company_id = ? AND removed = 0 AND email IS NOT NULL AND role IN ('Owner', 'Partner', 'Director', 'Proprietor', 'Trustee')", b.company_id);
        const gst = Math.round((b.fee * b.gst_rate) / 100);
        const to = Array.from(new Set([cl.billing_email].concat(contacts.map((c) => c.email)).filter(Boolean)));
        return { invoice: Object.assign(b, { gst, total: b.fee + gst }), client: cl, to, settings: settings() };
      },
      // Body: { id, to }. The server sends the invoice email when mail is set up, then records it here.
      'POST /api/wf/billing/sent': (p, query, body) => {
        if (!canBill(p)) forbid('Billing is for the Accounts department, the branch head and the Managing Partner.');
        const b = one('SELECT * FROM wf_billing WHERE id = ?', Number(body.id));
        if (!b || b.status !== 'invoiced') bad('Raise the invoice before sending it.');
        const to = (Array.isArray(body.to) ? body.to : []).join(', ');
        if (!to) bad('The client has no billing email or partner email on record.');
        run("UPDATE wf_billing SET status = 'sent', sent_at = ?, sent_to = ? WHERE id = ?", nowIso(), to.slice(0, 500), b.id);
        return { ok: true };
      },
      // Body: { id, amount, paid_on, reference }
      'POST /api/wf/billing/paid': (p, query, body) => {
        if (!canBill(p)) forbid('Billing is for the Accounts department, the branch head and the Managing Partner.');
        const b = one('SELECT * FROM wf_billing WHERE id = ?', Number(body.id));
        if (!b || !['sent', 'invoiced'].includes(b.status)) bad('Only an invoiced item can be marked paid.');
        const amount = Math.round(Number(body.amount));
        if (!(amount > 0)) bad('Enter the amount received.');
        if (!isDate(body.paid_on)) bad('Enter the date received.');
        run("UPDATE wf_billing SET status = 'paid', paid_on = ?, paid_amount = ?, paid_ref = ? WHERE id = ?", body.paid_on, amount, String(body.reference || '').slice(0, 100) || null, b.id);
        return { ok: true };
      },
      'POST /api/wf/settings': (p, query, body) => {
        if (!seesAll(p) && !(inAccounts(p) && rank(p) >= 5)) forbid('Only the Managing Partner, an admin or the head of Accounts can change invoice settings.');
        for (const k of Object.keys(DEFAULT_SETTINGS)) if (body[k] !== undefined) run('INSERT OR REPLACE INTO wf_settings (key, value) VALUES (?, ?)', k, String(body[k]).slice(0, 500));
        return { ok: true, settings: settings() };
      },

      // ---------- attendance ----------
      'POST /api/wf/attendance/mark': (p, query, body) => {
        if (!p.level) forbid('You are not placed in the firm structure yet.');
        const day = today();
        const cur = one('SELECT verified FROM wf_attendance WHERE user_id = ? AND day = ?', p.id, day);
        if (cur && cur.verified) bad('Today\'s attendance has already been verified by Accounts.');
        run(`INSERT INTO wf_attendance (user_id, day, present, marked_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (user_id, day) DO UPDATE SET present = excluded.present, marked_at = excluded.marked_at`, p.id, day, body.present ? 1 : 0, nowIso());
        return { ok: true, day };
      },
      'GET /api/wf/attendance': (p, query) => {
        const month = isPeriod(query.month) ? query.month : today().slice(0, 7);
        const staff = staffMap();
        let people;
        if (seesAll(p)) people = [...staff.values()].filter((s) => s.level);
        else if (canBill(p)) people = [...staff.values()].filter((s) => s.level && branchOk(p, s.branch_id));
        else if (p.level === 'head') people = [...staff.values()].filter((s) => s.department === p.department && sameBranch(p, s.branch_id));
        else { const subs = subordinates(p.id, staff); people = [...staff.values()].filter((s) => s.id === p.id || subs.has(s.id)); }
        const rows = q('SELECT a.*, v.name AS verified_by_name FROM wf_attendance a LEFT JOIN users v ON v.id = a.verified_by WHERE substr(a.day, 1, 7) = ?', month);
        const ids = new Set(people.map((x) => x.id));
        return {
          month, today: today(), can_verify: canBill(p),
          people: people.map((x) => ({ id: x.id, name: x.name, level: x.level, department: x.department, branch_id: x.branch_id })),
          records: rows.filter((r) => ids.has(r.user_id)),
        };
      },
      // Body: { user_id, day, verified: 'yes' | 'no' }
      'POST /api/wf/attendance/verify': (p, query, body) => {
        if (!canBill(p)) forbid('Attendance is verified by the Accounts department.');
        if (Number(body.user_id) === p.id) bad('Someone else verifies your own attendance.');
        if (!['yes', 'no'].includes(body.verified)) bad('Choose yes or no.');
        const s = staffMap().get(Number(body.user_id));
        if (!s || !branchOk(p, s.branch_id)) bad('That person is not in your branch.');
        const r = run('UPDATE wf_attendance SET verified = ?, verified_by = ?, verified_at = ? WHERE user_id = ? AND day = ?', body.verified, p.id, nowIso(), Number(body.user_id), body.day);
        if (!r.changes) bad('That day has not been marked.');
        return { ok: true };
      },

      // ---------- reports ----------
      'GET /api/wf/reports': (p) => {
        const staff = staffMap();
        ensureReports(staff);
        const subs = subordinates(p.id, staff);
        const rows = q('SELECT r.id, r.kind, r.reviewer_id, r.start_day, r.end_day, r.status, r.reviewed_at, u.name AS reviewer_name FROM wf_reports r JOIN users u ON u.id = r.reviewer_id ORDER BY r.start_day DESC, r.id DESC LIMIT 500')
          .filter((r) => canSeeReport(p, r, staff)).map((r) => Object.assign(r, { kind_name: KIND_NAME[r.kind] }));
        const actions = q('SELECT a.*, o.name AS owner_name, b.name AS raised_by_name FROM wf_actions a JOIN users o ON o.id = a.owner_id JOIN users b ON b.id = a.raised_by ORDER BY a.status = \'done\', a.due_date, a.id DESC LIMIT 300')
          .filter((a) => {
            if (seesAll(p) || a.owner_id === p.id || a.raised_by === p.id || subs.has(a.owner_id)) return true;
            const o = staff.get(a.owner_id);
            if (!o) return false;
            if (p.level === 'branch_head') return sameBranch(p, o.branch_id);
            return p.level === 'head' && o.department === p.department && sameBranch(p, o.branch_id);
          });
        return { reports: rows, actions };
      },
      'GET /api/wf/report': (p, query) => {
        const staff = staffMap();
        const r = one('SELECT r.*, u.name AS reviewer_name FROM wf_reports r JOIN users u ON u.id = r.reviewer_id WHERE r.id = ?', Number(query.id));
        if (!r || !canSeeReport(p, r, staff)) forbid('This report is not in your reporting line.');
        r.snapshot = JSON.parse(r.snapshot); r.kind_name = KIND_NAME[r.kind];
        if (r.kind === 'consolidated') r.snapshot.reviews = reviewsIn(r.start_day, r.end_day, staff.get(r.reviewer_id));
        const actions = q('SELECT a.*, o.name AS owner_name FROM wf_actions a JOIN users o ON o.id = a.owner_id WHERE a.report_id = ? ORDER BY a.id', r.id);
        const rev = staff.get(r.reviewer_id);
        const subs = subordinates(r.reviewer_id, staff);
        const owners = [...staff.values()].filter((s) => s.level && s.id !== r.reviewer_id && (r.kind === 'consolidated' ? (rev.level === 'mp' || sameBranch(rev, s.branch_id))
          : r.kind === 'weekly' ? (s.department === rev.department && sameBranch(rev, s.branch_id)) : subs.has(s.id))).map((s) => ({ id: s.id, name: s.name }));
        return { report: r, actions, owners, can_review: r.reviewer_id === p.id && r.status === 'pending' };
      },
      // Body: { id, comment, actions: [{ text, owner_id, due_date }] }
      'POST /api/wf/report/review': (p, query, body) => {
        const r = one('SELECT * FROM wf_reports WHERE id = ?', Number(body.id));
        if (!r) bad('Report not found.');
        if (r.reviewer_id !== p.id) forbid('Only the person this report was sent to can review it.');
        if (r.status !== 'pending') bad('This report has already been reviewed.');
        const comment = String(body.comment || '').trim();
        if (comment.length < 3) bad('Record your review: what you found and what you decided.');
        const acts = Array.isArray(body.actions) ? body.actions.filter((a) => a && String(a.text || '').trim()) : [];
        for (const a of acts) {
          if (!one('SELECT 1 FROM users WHERE id = ?', Number(a.owner_id))) bad('Choose who takes each corrective action.');
          if (a.due_date && !isDate(a.due_date)) bad('Choose a valid date for each corrective action.');
        }
        acts.forEach((a) => run('INSERT INTO wf_actions (report_id, raised_by, owner_id, text, due_date) VALUES (?, ?, ?, ?, ?)', r.id, p.id, Number(a.owner_id), String(a.text).trim().slice(0, 500), a.due_date || null));
        run("UPDATE wf_reports SET status = 'reviewed', reviewed_at = ?, comment = ? WHERE id = ?", nowIso(), comment.slice(0, 2000), r.id);
        return { ok: true, actions: acts.length };
      },
      'POST /api/wf/action/done': (p, query, body) => {
        const a = one('SELECT * FROM wf_actions WHERE id = ?', Number(body.id));
        if (!a) bad('Action not found.');
        if (a.owner_id !== p.id && a.raised_by !== p.id && !seesAll(p)) forbid('Only the person responsible records this.');
        const note = String(body.note || '').trim();
        if (!note) bad('Record what was done.');
        run("UPDATE wf_actions SET status = 'done', done_at = ?, done_note = ? WHERE id = ?", nowIso(), note.slice(0, 1000), a.id);
        return { ok: true };
      },

      // ---------- timeliness ----------
      'GET /api/wf/performance': (p, query) => {
        const period = isPeriod(query.period) ? query.period : latestPeriod();
        const rows = tasksFor(p, { period });
        const staff = staffMap();
        const byPerson = new Map();
        rows.forEach((t) => { const k = t.assignee_id || 0; if (!byPerson.has(k)) byPerson.set(k, []); byPerson.get(k).push(t); });
        return {
          period, overall: summarise(rows),
          byDivision: DIVISIONS.map((d) => Object.assign({ key: d.key, name: d.name, department: d.dept }, summarise(rows.filter((t) => t.division === d.key)))).filter((d) => d.total),
          byPerson: [...byPerson.entries()].map(([id, ts]) => Object.assign({ id, name: staff.get(id) ? staff.get(id).name : 'Not allotted', level: staff.get(id) ? staff.get(id).level : null, department: ts[0].department }, summarise(ts)))
            .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name)),
        };
      },

      // ---------- structure ----------
      'GET /api/wf/structure': () => {
        const staff = [...staffMap().values()];
        const load = Object.fromEntries(q('SELECT assignee_id, COUNT(*) AS n FROM wf_allotments WHERE assignee_id IS NOT NULL GROUP BY assignee_id').map((a) => [a.assignee_id, a.n]));
        return { staff: staff.map((s) => Object.assign(s, { clients: load[s.id] || 0 })), branches: q('SELECT * FROM wf_branches ORDER BY name') };
      },
      // Body: { name, city }
      'POST /api/wf/branch': (p, query, body) => {
        if (!canStructure(p)) forbid('Only the Managing Partner or an admin can add branches.');
        const name = String(body.name || '').trim();
        if (name.length < 2 || name.length > 60) bad('Name the branch, for example Bangalore.');
        if (one('SELECT 1 FROM wf_branches WHERE name = ?', name)) bad('A branch with this name already exists.');
        const id = Number(run('INSERT INTO wf_branches (name, city) VALUES (?, ?)', name, String(body.city || name).trim()).lastInsertRowid);
        return { ok: true, id };
      },
      // Body: { user_id, level, department, branch_id, reports_to }. level '' removes the person from the structure.
      'POST /api/wf/staff': (p, query, body) => {
        if (!canStructure(p)) forbid('Only the Managing Partner or an admin can change the structure.');
        const u = one("SELECT id FROM users WHERE id = ? AND role IN ('team', 'admin')", Number(body.user_id));
        if (!u) bad('Choose an Assura team login.');
        if (!body.level) { run('DELETE FROM wf_staff WHERE user_id = ?', u.id); return { ok: true }; }
        if (!LEVEL[body.level]) bad('Choose a designation.');
        const top = body.level === 'mp' || body.level === 'branch_head';
        const dept = top ? null : body.department;
        if (!top && !DEPT[dept]) bad('Choose a department.');
        const branch = body.level === 'mp' ? null : (body.branch_id ? Number(body.branch_id) : null);
        if (branch && !one('SELECT 1 FROM wf_branches WHERE id = ?', branch)) bad('Choose a branch.');
        if (body.level === 'branch_head' && !branch) bad('Choose the branch this person heads.');
        let to = body.reports_to ? Number(body.reports_to) : null;
        if (body.level === 'mp') to = null;
        else {
          const sup = to && one('SELECT level, department, branch_id FROM wf_staff WHERE user_id = ?', to);
          if (!sup) bad('Choose who this person reports to.');
          if (to === u.id) bad('A person cannot report to themselves.');
          if (RANK[sup.level] <= RANK[body.level]) bad('A person reports to someone more senior.');
          if (RANK[sup.level] < 6 && sup.department !== dept) bad('A person reports to someone in their own department, the branch head or the Managing Partner.');
        }
        if (body.level === 'head') {
          const other = one("SELECT u.name FROM wf_staff s JOIN users u ON u.id = s.user_id WHERE s.level = 'head' AND s.department = ? AND s.branch_id IS ? AND s.user_id <> ?", dept, branch, u.id);
          if (other) bad(`${other.name} already heads ${DEPT[dept].name} in this branch. Change their designation first.`);
        }
        if (body.level === 'branch_head') {
          const other = one("SELECT u.name FROM wf_staff s JOIN users u ON u.id = s.user_id WHERE s.level = 'branch_head' AND s.branch_id = ? AND s.user_id <> ?", branch, u.id);
          if (other) bad(`${other.name} already heads this branch.`);
        }
        run(`INSERT INTO wf_staff (user_id, level, department, branch_id, reports_to) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET level = excluded.level, department = excluded.department, branch_id = excluded.branch_id, reports_to = excluded.reports_to`,
          u.id, body.level, dept, branch, to);
        return { ok: true };
      },
    };

    // The single entry point: (user, 'GET /api/wf/home', query, body) -> result, or throws WfError.
    function call(user, route, query = {}, body = {}) {
      const fn = calls[route];
      if (!fn) throw new WfError(404, 'Not found');
      if (!user || !(user.role === 'team' || user.role === 'admin')) throw new WfError(403, 'The practice workspace is for the Assura Elevate team only.');
      const p = profile(user);
      if (!p.level && !p.admin && !['GET /api/wf/me', 'GET /api/wf/structure'].includes(route)) forbid('Your login has not been given a place in the firm structure yet. Ask the Managing Partner or an admin.');
      return fn(p, query, body);
    }

    return { call, routes: Object.keys(calls), dueFor, timeliness };
  }

  // The invoice as HTML with inline styles: shown in the workspace, printed, and sent as the email body.
  // inv: the result of GET /api/wf/billing/invoice.
  function renderInvoice({ invoice: b, client: cl, settings: s }) {
    const e = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const month = (p) => `${MONTHS[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
    const day = (d) => (d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1].slice(0, 3)} ${d.slice(0, 4)}` : '');
    const firmState = (s.firm_gstin || '').slice(0, 2); const clientState = (cl.gstin || '').slice(0, 2);
    const intra = firmState && clientState && firmState === clientState;
    const half = Math.round(b.gst / 2);
    const taxRows = intra
      ? `<tr><td style="padding:6px 0">CGST @ ${b.gst_rate / 2}%</td><td style="text-align:right">${inr(half)}</td></tr><tr><td style="padding:6px 0">SGST @ ${b.gst_rate / 2}%</td><td style="text-align:right">${inr(b.gst - half)}</td></tr>`
      : `<tr><td style="padding:6px 0">${firmState && clientState ? 'IGST' : 'GST'} @ ${b.gst_rate}%</td><td style="text-align:right">${inr(b.gst)}</td></tr>`;
    return `<div style="font-family:Georgia,'Times New Roman',serif;color:#372F24;max-width:680px;margin:0 auto;line-height:1.45">
      <table style="width:100%;border-collapse:collapse"><tr>
        <td style="vertical-align:top"><div style="font-size:22px;font-weight:600">${e(s.firm_name)}</div>
          <div style="font-size:12px;color:#6b6257;white-space:pre-line">${e(s.firm_address)}</div>
          ${s.firm_gstin ? `<div style="font-size:12px;color:#6b6257">GSTIN ${e(s.firm_gstin)}</div>` : ''}${s.firm_pan ? `<div style="font-size:12px;color:#6b6257">PAN ${e(s.firm_pan)}</div>` : ''}</td>
        <td style="vertical-align:top;text-align:right"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#E0A708;font-weight:700">Tax invoice</div>
          <div style="font-size:15px;font-weight:600;margin-top:4px">${e(b.invoice_no)}</div><div style="font-size:12px;color:#6b6257">Dated ${day(b.invoice_date)}</div></td></tr></table>
      <hr style="border:none;border-top:2px solid #E0A708;margin:16px 0">
      <div style="font-size:12px;color:#6b6257;text-transform:uppercase;letter-spacing:.08em">Billed to</div>
      <div style="font-size:16px;font-weight:600">${e(b.name)}</div>
      <div style="font-size:13px;white-space:pre-line">${e(cl.address || '')}</div>
      <div style="font-size:13px">${cl.gstin ? `GSTIN ${e(cl.gstin)}` : ''}${cl.gstin && cl.pan ? ' · ' : ''}${cl.pan ? `PAN ${e(cl.pan)}` : ''}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:20px;font-size:14px">
        <tr style="border-bottom:1px solid #d9d2c5"><th style="text-align:left;padding:8px 0">Description</th><th style="text-align:right;padding:8px 0">Amount</th></tr>
        <tr><td style="padding:10px 0">Professional fees for ${month(b.bill_month)}, billed in advance<div style="font-size:12px;color:#6b6257">Practice and advisory services as agreed in the engagement letter</div></td><td style="text-align:right">${inr(b.fee)}</td></tr>
        ${taxRows}
        <tr style="border-top:2px solid #372F24"><td style="padding:10px 0;font-weight:700">Total payable</td><td style="text-align:right;font-weight:700;font-size:18px">${inr(b.total)}</td></tr>
      </table>
      ${s.bank_details ? `<div style="margin-top:18px;font-size:13px"><div style="font-size:12px;color:#6b6257;text-transform:uppercase;letter-spacing:.08em">Payment details</div><div style="white-space:pre-line">${e(s.bank_details)}</div></div>` : ''}
      <div style="margin-top:22px;font-size:12px;color:#6b6257">Thank you. Please quote ${e(b.invoice_no)} with your payment.</div></div>`;
  }

  return { install, createWorkflow, renderInvoice, DEPARTMENTS, DIVISIONS, LEVELS, STAGES, ENTITY_TYPES, WfError, dueFor, timeliness, addDays, nextPeriod, fyOf };
});
