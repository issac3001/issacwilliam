/*
 * Assura Elevate internal workflow: people, teams, client allotment, maker-checker approvals,
 * department sign-offs, escalations to the Managing Director, target dates and delay tracking.
 *
 * Internal only: every call is made by an Assura staff login; client logins never reach it.
 * Works on any database object with the node:sqlite surface (prepare().get/all/run, exec), so the
 * same code runs on the server (node:sqlite) and in the browser preview (sql.js through an adapter).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEWorkflow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEPARTMENTS = [
    { key: 'ca', name: 'Taxation & Assurance', short: 'CA', head: 'Chartered Accountant', scope: 'Direct tax, indirect tax (GST, TDS, advance tax) and assurance' },
    { key: 'cs', name: 'Corporate Governance', short: 'CS', head: 'Company Secretary', scope: 'Companies Act, LLP, FEMA, ROC/MCA filings, registers, minutes and resolutions' },
    { key: 'legal', name: 'Legal', short: 'Legal', head: 'Advocate', scope: 'General commercial law, contracts and documentation' },
    { key: 'hr', name: 'HR & Labour Compliance', short: 'HR', head: 'HR professional', scope: 'PF, ESI and employee compliance' },
  ];
  const DEPT = Object.fromEntries(DEPARTMENTS.map((d) => [d.key, d]));

  // Seniority, lowest first. Analysts are trainees; senior analysts are semi-qualified.
  const LEVELS = [
    { key: 'analyst', name: 'Analyst', note: 'Trainee', rank: 1 },
    { key: 'senior', name: 'Senior Analyst', note: 'Semi-qualified', rank: 2 },
    { key: 'manager', name: 'Manager', note: 'Qualified professional', rank: 3 },
    { key: 'director', name: 'Director', note: 'Head of department', rank: 4 },
    { key: 'md', name: 'Managing Director', note: 'Final approval and escalations', rank: 5 },
  ];
  const RANK = Object.fromEntries(LEVELS.map((l) => [l.key, l.rank]));
  const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.key, l]));

  // Each task moves up this chain. Each step is checked by someone more senior than the maker.
  // 'md' is used only when the task carries an open flag.
  // daysBefore: when the step should be finished, counted back from the task's target date.
  const STAGES = [
    { key: 'preparation', name: 'Preparation', who: 'Analyst', need: 1, daysBefore: 6 },
    { key: 'review', name: 'Senior review', who: 'Senior Analyst', need: 2, daysBefore: 4 },
    { key: 'manager', name: 'Manager approval', who: 'Manager', need: 3, daysBefore: 2 },
    { key: 'signoff', name: 'Department sign-off', who: 'Director', need: 4, daysBefore: 0 },
    { key: 'md', name: 'MD approval', who: 'Managing Director', need: 5, daysBefore: 0 },
    { key: 'done', name: 'Completed', who: '', need: 99, daysBefore: 0 },
  ];
  const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, s]));
  const ORDER = STAGES.map((s) => s.key);

  // The standard monthly review for each department, created by "Start the month".
  const MONTHLY = {
    ca: [
      ['gst', 'GST review: GSTR-1, GSTR-3B and input credit'],
      ['tds', 'TDS review: deductions, deposits and returns'],
      ['direct-tax', 'Direct tax: advance tax and income tax position'],
      ['financials', 'Monthly financials: validation and management report'],
    ],
    cs: [
      ['registers', 'Statutory registers, minutes and resolutions'],
      ['meetings', 'Board and general meeting compliance'],
      ['roc', 'ROC/MCA filings tracker (AOC-4, MGT-7/7A, DPT-3, DIR-3 KYC, MSME-1)'],
    ],
    legal: [
      ['contracts', 'Contracts and agreements review'],
      ['documentation', 'Legal documentation, notices and open matters'],
    ],
    hr: [
      ['pf-esi', 'PF and ESI contributions and returns'],
      ['payroll', 'Payroll and labour law compliance'],
    ],
  };

  const DEFAULT_TARGET_DAY = 20;
  const DEFAULT_CAPACITY = 30;

  class WfError extends Error { constructor(status, message) { super(message); this.status = status; } }

  function install(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wf_staff (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        level TEXT NOT NULL CHECK (level IN ('analyst', 'senior', 'manager', 'director', 'md')),
        department TEXT CHECK (department IS NULL OR department IN ('ca', 'cs', 'legal', 'hr')),
        CHECK (level = 'md' OR department IS NOT NULL)
      );
      -- A team serves up to "capacity" clients for one department: a manager, a senior analyst and an analyst.
      CREATE TABLE IF NOT EXISTS wf_teams (
        id INTEGER PRIMARY KEY,
        department TEXT NOT NULL,
        name TEXT NOT NULL,
        manager_id INTEGER REFERENCES users(id),
        senior_id INTEGER REFERENCES users(id),
        analyst_id INTEGER REFERENCES users(id),
        capacity INTEGER NOT NULL DEFAULT ${DEFAULT_CAPACITY},
        UNIQUE (department, name)
      );
      -- Each client is allotted to one team in each department, with a target day of the month.
      CREATE TABLE IF NOT EXISTS wf_allotments (
        company_id INTEGER NOT NULL REFERENCES companies(id),
        department TEXT NOT NULL,
        team_id INTEGER NOT NULL REFERENCES wf_teams(id),
        target_day INTEGER NOT NULL DEFAULT ${DEFAULT_TARGET_DAY},
        PRIMARY KEY (company_id, department)
      );
      CREATE TABLE IF NOT EXISTS wf_tasks (
        id INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        department TEXT NOT NULL,
        team_id INTEGER REFERENCES wf_teams(id),
        period TEXT NOT NULL,
        template TEXT,
        title TEXT NOT NULL,
        due_date TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'preparation',
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        completed_at TEXT,
        completed_on TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS wf_tasks_monthly ON wf_tasks (company_id, department, period, template) WHERE template IS NOT NULL;
      CREATE INDEX IF NOT EXISTS wf_tasks_period ON wf_tasks (period, department);
      -- Every move, return, flag and date change on a task, in order.
      CREATE TABLE IF NOT EXISTS wf_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES wf_tasks(id),
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        user_id INTEGER,
        action TEXT NOT NULL,
        from_stage TEXT,
        to_stage TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS wf_events_task ON wf_events (task_id);
      CREATE TABLE IF NOT EXISTS wf_flags (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES wf_tasks(id),
        raised_by INTEGER,
        raised_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        resolved_by INTEGER,
        resolved_at TEXT,
        resolution TEXT
      );
    `);
  }

  // ---------- dates (calendar dates as YYYY-MM-DD strings, India time) ----------
  function todayIST() {
    return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  }
  const toDate = (s) => new Date(`${s}T00:00:00Z`);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toDate(s)) && fmt(toDate(s)) === s;
  const isPeriod = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  // A month's review is due in the following month, on the client's target day.
  function dueFor(period, targetDay) {
    let [y, m] = period.split('-').map(Number);
    m += 1; if (m > 12) { m = 1; y += 1; }
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(targetDay, last)).padStart(2, '0')}`;
  }
  const stageTarget = (task) => addDays(task.due_date, -(STAGE[task.stage] || STAGE.done).daysBefore);

  // on_track | behind (this step is past its own target) | delayed (past the target date) | on_time | late
  function timeliness(task, today) {
    if (task.stage === 'done') return task.completed_on && task.completed_on > task.due_date ? 'late' : 'on_time';
    if (today > task.due_date) return 'delayed';
    if (today > stageTarget(task)) return 'behind';
    return 'on_track';
  }

  function createWorkflow(db, options = {}) {
    const today = () => (options.today ? options.today() : todayIST());
    const q = (sql, ...p) => db.prepare(sql).all(...p);
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const run = (sql, ...p) => db.prepare(sql).run(...p);
    const bad = (m) => { throw new WfError(400, m); };
    const forbid = (m) => { throw new WfError(403, m); };

    function profile(user) {
      const p = one('SELECT level, department FROM wf_staff WHERE user_id = ?', user.id);
      return {
        id: user.id, name: user.name, email: user.email, role: user.role,
        level: p ? p.level : null, department: p ? p.department : null,
        // System admins set the structure up even before they have a place in it.
        admin: user.role === 'admin',
      };
    }
    const isMd = (p) => p.level === 'md';
    const seesAll = (p) => isMd(p) || p.admin;
    const canStructure = (p) => isMd(p) || p.admin;
    const canAllot = (p, dept) => seesAll(p) || (p.level === 'director' && p.department === dept);

    // Which tasks a person can see: MD and admins everything, directors their department,
    // managers their teams, senior analysts and analysts the teams they work in.
    function scope(p, alias = 't') {
      if (seesAll(p)) return ['1 = 1', []];
      if (!p.level) return ['1 = 0', []];
      if (p.level === 'director') return [`${alias}.department = ?`, [p.department]];
      if (p.level === 'manager') return [`${alias}.team_id IN (SELECT id FROM wf_teams WHERE manager_id = ?)`, [p.id]];
      return [`${alias}.team_id IN (SELECT id FROM wf_teams WHERE senior_id = ? OR analyst_id = ?)`, [p.id, p.id]];
    }

    const TASK_SELECT = `SELECT t.*, c.code AS company_code, c.name AS company_name, tm.name AS team_name,
        tm.manager_id, tm.senior_id, tm.analyst_id,
        (SELECT COUNT(*) FROM wf_flags f WHERE f.task_id = t.id AND f.status = 'open') AS open_flags
      FROM wf_tasks t JOIN companies c ON c.id = t.company_id LEFT JOIN wf_teams tm ON tm.id = t.team_id`;

    function decorate(t, p) {
      const now = today();
      const s = STAGE[t.stage];
      return Object.assign({}, t, {
        stage_name: s.name, waiting_on: s.who,
        stage_target: t.stage === 'done' ? null : stageTarget(t),
        timeliness: timeliness(t, now),
        days_left: t.stage === 'done' ? null : daysBetween(now, t.due_date),
        days_late: t.stage === 'done' ? Math.max(0, t.completed_on ? daysBetween(t.due_date, t.completed_on) : 0) : Math.max(0, daysBetween(t.due_date, now)),
        my_turn: p ? designated(p, t) && canAct(p, t) : false,
        can_act: p ? canAct(p, t) : false,
      });
    }

    // The last person who moved the task forward made (or checked) the current version of the work.
    function lastMover(taskId) {
      const e = one("SELECT user_id FROM wf_events WHERE task_id = ? AND action IN ('submit', 'approve') ORDER BY id DESC LIMIT 1", taskId);
      return e ? e.user_id : null;
    }

    // Whether this person may act on the step the task is at now.
    function eligible(p, t) {
      if (t.stage === 'done' || !p.level) return false;
      const need = STAGE[t.stage].need;
      if (isMd(p)) return true;
      if (p.department !== t.department || RANK[p.level] < need) return false;
      if (p.level === 'director') return true;
      if (p.level === 'manager') return t.manager_id === p.id;
      if (p.level === 'senior') return t.senior_id === p.id;
      return t.analyst_id === p.id;
    }
    // The person whose queue the task sits in now. Seniors can step in (eligible) but are not chased for it.
    function designated(p, t) {
      switch (t.stage) {
        case 'preparation': return t.analyst_id ? t.analyst_id === p.id : t.senior_id === p.id;
        case 'review': return t.senior_id ? t.senior_id === p.id : t.manager_id === p.id;
        case 'manager': return t.manager_id === p.id;
        case 'signoff': return p.level === 'director' && p.department === t.department;
        case 'md': return isMd(p);
        default: return false;
      }
    }
    // Maker-checker: nobody checks their own work.
    function canAct(p, t) {
      if (!eligible(p, t)) return false;
      if (t.stage !== 'preparation' && lastMover(t.id) === p.id) return false;
      return true;
    }

    // The next step after `from`, skipping steps the actor's seniority already covers.
    function nextStage(from, actorRank, hasFlag) {
      let i = ORDER.indexOf(from) + 1;
      while (i < ORDER.length) {
        const k = ORDER[i];
        if (k === 'md' && !hasFlag) { i++; continue; }
        if (k === 'done' || STAGE[k].need > actorRank) return k;
        i++;
      }
      return 'done';
    }

    function getTask(id, p) {
      const t = one(`${TASK_SELECT} WHERE t.id = ?`, Number(id));
      if (!t) throw new WfError(404, 'Task not found.');
      const [w, args] = scope(p);
      if (!one(`SELECT 1 FROM wf_tasks t WHERE t.id = ? AND ${w}`, t.id, ...args)) forbid('This task belongs to another team.');
      return t;
    }

    function logEvent(taskId, p, action, from, to, note) {
      run('INSERT INTO wf_events (task_id, user_id, action, from_stage, to_stage, note) VALUES (?, ?, ?, ?, ?, ?)',
        taskId, p.id, action, from || null, to || null, note ? String(note).slice(0, 1000) : null);
    }

    function setStage(t, to) {
      if (to === 'done') run('UPDATE wf_tasks SET stage = ?, completed_at = ?, completed_on = ? WHERE id = ?', to, new Date().toISOString().slice(0, 19) + 'Z', today(), t.id);
      else run('UPDATE wf_tasks SET stage = ?, completed_at = NULL, completed_on = NULL WHERE id = ?', to, t.id);
    }

    function staffList() {
      return q(`SELECT u.id, u.name, u.email, u.role, u.disabled, s.level, s.department FROM users u
        LEFT JOIN wf_staff s ON s.user_id = u.id WHERE u.role IN ('team', 'admin') ORDER BY u.name`);
    }

    function teamsWithLoad(dept) {
      return q(`SELECT tm.*, m.name AS manager_name, s.name AS senior_name, a.name AS analyst_name,
          (SELECT COUNT(*) FROM wf_allotments x WHERE x.team_id = tm.id) AS clients
        FROM wf_teams tm LEFT JOIN users m ON m.id = tm.manager_id LEFT JOIN users s ON s.id = tm.senior_id LEFT JOIN users a ON a.id = tm.analyst_id
        ${dept ? 'WHERE tm.department = ?' : ''} ORDER BY tm.department, tm.name`, ...(dept ? [dept] : []));
    }

    function tasksFor(p, filters = {}) {
      const [w, args] = scope(p);
      const where = [w]; const params = args.slice();
      if (filters.period) { where.push('t.period = ?'); params.push(filters.period); }
      if (filters.department) { where.push('t.department = ?'); params.push(filters.department); }
      if (filters.company) { where.push('t.company_id = ?'); params.push(Number(filters.company)); }
      if (filters.team) { where.push('t.team_id = ?'); params.push(Number(filters.team)); }
      const rows = q(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_date, c.name, t.id`, ...params).map((t) => decorate(t, p));
      if (filters.status === 'open') return rows.filter((t) => t.stage !== 'done');
      if (filters.status === 'delayed') return rows.filter((t) => t.timeliness === 'delayed' || t.timeliness === 'behind');
      if (filters.status === 'flagged') return rows.filter((t) => t.open_flags > 0);
      if (filters.status === 'done') return rows.filter((t) => t.stage === 'done');
      if (filters.status === 'mine') return rows.filter((t) => t.my_turn);
      return rows;
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

    function latestPeriod(p) {
      const [w, args] = scope(p);
      const r = one(`SELECT MAX(period) AS p FROM wf_tasks t WHERE ${w}`, ...args);
      if (r && r.p) return r.p;
      const d = toDate(today()); d.setUTCMonth(d.getUTCMonth() - 1);
      return fmt(d).slice(0, 7);
    }

    // ---------------- calls ----------------
    const calls = {
      'GET /api/wf/me': (p) => ({
        me: p, today: today(), departments: DEPARTMENTS, levels: LEVELS, stages: STAGES,
        can: { structure: canStructure(p), allot: seesAll(p) || p.level === 'director', create: seesAll(p) || RANK[p.level] >= 3 },
        period: latestPeriod(p),
        periods: q('SELECT DISTINCT period FROM wf_tasks ORDER BY period DESC').map((r) => r.period),
      }),

      // The home screen: what is waiting on me, what is late, and what has been flagged.
      'GET /api/wf/home': (p, query) => {
        const period = isPeriod(query.period) ? query.period : latestPeriod(p);
        const all = tasksFor(p, {});
        const month = all.filter((t) => t.period === period);
        const [w, args] = scope(p);
        const flags = q(`SELECT f.*, t.title, t.department, t.stage, c.name AS company_name, c.code AS company_code, u.name AS raised_by_name
          FROM wf_flags f JOIN wf_tasks t ON t.id = f.task_id JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = f.raised_by
          WHERE f.status = 'open' AND ${w} ORDER BY f.id DESC`, ...args);
        return {
          period,
          mine: all.filter((t) => t.my_turn).slice(0, 50),
          delayed: all.filter((t) => t.timeliness === 'delayed').sort((a, b) => b.days_late - a.days_late).slice(0, 50),
          behind: all.filter((t) => t.timeliness === 'behind').slice(0, 50),
          flags,
          month: summarise(month),
          byDepartment: DEPARTMENTS.map((d) => Object.assign({ key: d.key, name: d.name }, summarise(month.filter((t) => t.department === d.key)))).filter((d) => d.total),
        };
      },

      'GET /api/wf/tasks': (p, query) => ({ tasks: tasksFor(p, query) }),

      'GET /api/wf/task': (p, query) => {
        const t = getTask(query.id, p);
        const events = q(`SELECT e.*, u.name AS user_name FROM wf_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.task_id = ? ORDER BY e.id`, t.id);
        const flags = q(`SELECT f.*, a.name AS raised_by_name, b.name AS resolved_by_name FROM wf_flags f
          LEFT JOIN users a ON a.id = f.raised_by LEFT JOIN users b ON b.id = f.resolved_by WHERE f.task_id = ? ORDER BY f.id`, t.id);
        const team = t.team_id ? one(`SELECT tm.name, m.name AS manager, s.name AS senior, a.name AS analyst FROM wf_teams tm
          LEFT JOIN users m ON m.id = tm.manager_id LEFT JOIN users s ON s.id = tm.senior_id LEFT JOIN users a ON a.id = tm.analyst_id WHERE tm.id = ?`, t.team_id) : null;
        const director = one("SELECT u.name FROM wf_staff s JOIN users u ON u.id = s.user_id WHERE s.level = 'director' AND s.department = ?", t.department);
        const d = decorate(t, p);
        const eligibleNow = eligible(p, t);
        const blockedOwn = eligibleNow && !d.can_act;
        const actions = [];
        if (d.can_act) {
          if (t.stage === 'preparation') actions.push('submit');
          else actions.push('approve', 'return');
        }
        if (t.stage !== 'done') actions.push('flag');
        if (isMd(p) && flags.some((f) => f.status === 'open')) actions.push('resolve');
        if (t.stage !== 'done' && (seesAll(p) || (RANK[p.level] >= 3 && p.department === t.department))) actions.push('reschedule');
        if (t.stage === 'done' && (seesAll(p) || (p.level === 'director' && p.department === t.department))) actions.push('reopen');
        // Where each step of the chain should land, for the timeline strip.
        const chain = STAGES.filter((s) => s.key !== 'done' && (s.key !== 'md' || t.stage === 'md' || flags.some((f) => f.status === 'open') || events.some((e) => e.from_stage === 'md')))
          .map((s) => ({ key: s.key, name: s.name, who: s.who, target: addDays(t.due_date, -s.daysBefore) }));
        return { task: d, events, flags, team, director: director ? director.name : null, actions, chain, note: blockedOwn ? 'You moved this task to this step, so someone else must check it.' : null };
      },

      // Body: { id, action: 'submit' | 'approve' | 'return' | 'reopen', note }
      'POST /api/wf/task/action': (p, query, body) => {
        const t = getTask(body.id, p);
        const note = String(body.note || '').trim();
        const action = body.action;
        if (action === 'reopen') {
          if (t.stage !== 'done') bad('This task is still open.');
          if (!(seesAll(p) || (p.level === 'director' && p.department === t.department))) forbid('Only the department director or the MD can reopen completed work.');
          if (!note) bad('Say why the task is being reopened.');
          setStage(t, 'preparation'); logEvent(t.id, p, 'reopen', 'done', 'preparation', note);
          return { ok: true, stage: 'preparation' };
        }
        if (!['submit', 'approve', 'return'].includes(action)) bad('Unknown action.');
        if (!canAct(p, t)) {
          if (eligible(p, t)) forbid('You moved this task to this step, so someone else must check it.');
          forbid(`This step is waiting on the ${STAGE[t.stage].who.toLowerCase()}${t.stage === 'done' ? '' : ' of this team'}.`);
        }
        if (action === 'submit' && t.stage !== 'preparation') bad('This task has already been submitted.');
        if (action !== 'submit' && t.stage === 'preparation') bad('Submit the work first.');
        if (action === 'return') {
          if (!note) bad('Say what needs to change before it comes back.');
          setStage(t, 'preparation'); logEvent(t.id, p, 'return', t.stage, 'preparation', note);
          return { ok: true, stage: 'preparation' };
        }
        const flags = one("SELECT COUNT(*) AS n FROM wf_flags WHERE task_id = ? AND status = 'open'", t.id).n;
        // The MD's approval completes the task and settles any flags on it.
        if (isMd(p)) {
          if (flags && !note) bad('Add a note on how the flagged matter is settled.');
          run("UPDATE wf_flags SET status = 'resolved', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), resolution = ? WHERE task_id = ? AND status = 'open'", p.id, note || 'Approved by the MD', t.id);
        }
        const to = isMd(p) ? 'done' : nextStage(t.stage, RANK[p.level], flags > 0);
        setStage(t, to); logEvent(t.id, p, action, t.stage, to, note);
        return { ok: true, stage: to };
      },

      // Body: { id, reason }. Any flag sends the task to the MD before it can be completed.
      'POST /api/wf/task/flag': (p, query, body) => {
        const t = getTask(body.id, p);
        const reason = String(body.reason || '').trim();
        if (reason.length < 5) bad('Describe the issue so the MD can decide on it.');
        if (t.stage === 'done') bad('This task is complete. Reopen it first.');
        run('INSERT INTO wf_flags (task_id, raised_by, reason) VALUES (?, ?, ?)', t.id, p.id, reason.slice(0, 1000));
        logEvent(t.id, p, 'flag', t.stage, t.stage, reason);
        return { ok: true };
      },

      // Body: { flag_id, resolution }. MD only.
      'POST /api/wf/flag/resolve': (p, query, body) => {
        if (!isMd(p)) forbid('Only the Managing Director resolves flags.');
        const f = one('SELECT * FROM wf_flags WHERE id = ?', Number(body.flag_id));
        if (!f || f.status !== 'open') bad('That flag is not open.');
        const resolution = String(body.resolution || '').trim();
        if (!resolution) bad('Record the decision.');
        run("UPDATE wf_flags SET status = 'resolved', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), resolution = ? WHERE id = ?", p.id, resolution.slice(0, 1000), f.id);
        const t = one('SELECT * FROM wf_tasks WHERE id = ?', f.task_id);
        logEvent(t.id, p, 'resolve', t.stage, t.stage, resolution);
        // With nothing left open, a task waiting on the MD only for this flag is complete.
        if (t.stage === 'md' && !one("SELECT 1 FROM wf_flags WHERE task_id = ? AND status = 'open'", t.id)) {
          setStage(t, 'done'); logEvent(t.id, p, 'approve', 'md', 'done', 'Flag resolved');
        }
        return { ok: true };
      },

      // Body: { id, due_date, note }. Managers and above; always logged with the reason.
      'POST /api/wf/task/reschedule': (p, query, body) => {
        const t = getTask(body.id, p);
        if (!(seesAll(p) || (RANK[p.level] >= 3 && p.department === t.department))) forbid('Only a manager or above can change a target date.');
        if (!isDate(body.due_date)) bad('Choose a valid date.');
        const note = String(body.note || '').trim();
        if (!note) bad('Say why the target date is changing.');
        run('UPDATE wf_tasks SET due_date = ? WHERE id = ?', body.due_date, t.id);
        logEvent(t.id, p, 'reschedule', t.stage, t.stage, `${t.due_date} → ${body.due_date}: ${note}`);
        return { ok: true };
      },

      // Body: { company_id, department, title, due_date, period }. An extra task outside the monthly list.
      'POST /api/wf/task': (p, query, body) => {
        const dept = body.department;
        if (!DEPT[dept]) bad('Choose a department.');
        if (!(seesAll(p) || (RANK[p.level] >= 3 && p.department === dept))) forbid('Only a manager or above in this department can add tasks.');
        const company = one('SELECT id FROM companies WHERE id = ?', Number(body.company_id));
        if (!company) bad('Choose a client.');
        const title = String(body.title || '').trim();
        if (title.length < 3) bad('Describe the task.');
        if (!isDate(body.due_date)) bad('Choose a target date.');
        const period = isPeriod(body.period) ? body.period : body.due_date.slice(0, 7);
        const a = one('SELECT team_id FROM wf_allotments WHERE company_id = ? AND department = ?', company.id, dept);
        if (!a) bad(`This client has no ${DEPT[dept].name} team yet. Allot one under Clients first.`);
        const r = run('INSERT INTO wf_tasks (company_id, department, team_id, period, title, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          company.id, dept, a.team_id, period, title.slice(0, 200), body.due_date, p.id);
        const id = Number(r.lastInsertRowid);
        logEvent(id, p, 'create', null, 'preparation', null);
        return { ok: true, id };
      },

      // Body: { period }. Creates each allotted department's standard monthly tasks for every client.
      // Safe to run again: tasks that already exist are left alone, new allotments are added.
      'POST /api/wf/cycle': (p, query, body) => {
        if (!isPeriod(body.period)) bad('Choose the month.');
        if (!(seesAll(p) || p.level === 'director')) forbid('Only a director or the MD can start the month.');
        const depts = seesAll(p) ? DEPARTMENTS.map((d) => d.key) : [p.department];
        let created = 0;
        const allots = q(`SELECT * FROM wf_allotments WHERE department IN (${depts.map(() => '?').join(',')})`, ...depts);
        for (const a of allots) {
          for (const [tpl, title] of MONTHLY[a.department]) {
            if (one('SELECT 1 FROM wf_tasks WHERE company_id = ? AND department = ? AND period = ? AND template = ?', a.company_id, a.department, body.period, tpl)) continue;
            const r = run('INSERT INTO wf_tasks (company_id, department, team_id, period, template, title, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              a.company_id, a.department, a.team_id, body.period, tpl, title, dueFor(body.period, a.target_day), p.id);
            logEvent(Number(r.lastInsertRowid), p, 'create', null, 'preparation', null);
            created++;
          }
        }
        return { ok: true, created, period: body.period };
      },

      // Every client with its team in each department, target days and this month's sign-off state.
      'GET /api/wf/clients': (p, query) => {
        const period = isPeriod(query.period) ? query.period : latestPeriod(p);
        const companies = q('SELECT id, code, name FROM companies ORDER BY name');
        const allots = q(`SELECT a.*, tm.name AS team_name FROM wf_allotments a JOIN wf_teams tm ON tm.id = a.team_id`);
        // Progress is shown for every department of a client the person serves, so a team can see where the
        // client's other departments stand. Opening a task still needs the task's own team or seniority.
        const month = q(`${TASK_SELECT} WHERE t.period = ?`, period).map((t) => decorate(t, null));
        // Directors see their department's clients; managers and analysts the clients of their teams.
        const myTeams = new Set(q('SELECT id FROM wf_teams WHERE manager_id = ? OR senior_id = ? OR analyst_id = ?', p.id, p.id, p.id).map((r) => r.id));
        const mine = (a) => (p.level === 'director' ? a.department === p.department : myTeams.has(a.team_id));
        const rows = companies.filter((c) => seesAll(p) || allots.some((a) => a.company_id === c.id && mine(a)))
          .map((c) => {
            const depts = {};
            DEPARTMENTS.forEach((d) => {
              const a = allots.find((x) => x.company_id === c.id && x.department === d.key);
              const ts = month.filter((t) => t.company_id === c.id && t.department === d.key);
              const s = summarise(ts);
              depts[d.key] = a ? { team_id: a.team_id, team_name: a.team_name, target_day: a.target_day, due: dueFor(period, a.target_day), tasks: s.total, done: s.done, delayed: s.delayed, flagged: s.flagged, signed_off: s.total > 0 && s.done === s.total } : null;
            });
            const allotted = Object.values(depts).filter(Boolean);
            const withTasks = allotted.filter((d) => d.tasks);
            return { id: c.id, code: c.code, name: c.name, depts, complete: withTasks.length > 0 && withTasks.length === allotted.length && withTasks.every((d) => d.signed_off) };
          });
        return { period, clients: rows, teams: teamsWithLoad() };
      },

      // Body: { company_id, department, team_id, target_day }
      'POST /api/wf/allot': (p, query, body) => {
        const dept = body.department;
        if (!DEPT[dept]) bad('Choose a department.');
        if (!canAllot(p, dept)) forbid('Only the department director or the MD can allot clients.');
        const company = one('SELECT id FROM companies WHERE id = ?', Number(body.company_id));
        if (!company) bad('Choose a client.');
        const team = one('SELECT * FROM wf_teams WHERE id = ? AND department = ?', Number(body.team_id), dept);
        if (!team) bad('Choose a team from this department.');
        const day = Number(body.target_day || DEFAULT_TARGET_DAY);
        if (!Number.isInteger(day) || day < 1 || day > 31) bad('Target day must be between 1 and 31.');
        const cur = one('SELECT * FROM wf_allotments WHERE company_id = ? AND department = ?', company.id, dept);
        if (!cur || cur.team_id !== team.id) {
          const load = one('SELECT COUNT(*) AS n FROM wf_allotments WHERE team_id = ?', team.id).n;
          if (load >= team.capacity) bad(`${team.name} already serves ${load} clients, its full capacity of ${team.capacity}. Choose another team or raise its capacity.`);
        }
        run(`INSERT INTO wf_allotments (company_id, department, team_id, target_day) VALUES (?, ?, ?, ?)
          ON CONFLICT (company_id, department) DO UPDATE SET team_id = excluded.team_id, target_day = excluded.target_day`, company.id, dept, team.id, day);
        // Open work moves with the client to its new team.
        if (cur && cur.team_id !== team.id) run("UPDATE wf_tasks SET team_id = ? WHERE company_id = ? AND department = ? AND stage <> 'done'", team.id, company.id, dept);
        return { ok: true };
      },

      'GET /api/wf/structure': (p) => ({ staff: staffList(), teams: teamsWithLoad() }),

      // Body: { user_id, level, department }. level '' removes the person from the structure.
      'POST /api/wf/staff': (p, query, body) => {
        if (!canStructure(p)) forbid('Only the MD or an admin can change the structure.');
        const u = one("SELECT id FROM users WHERE id = ? AND role IN ('team', 'admin')", Number(body.user_id));
        if (!u) bad('Choose an Assura team login.');
        if (!body.level) { run('DELETE FROM wf_staff WHERE user_id = ?', u.id); return { ok: true }; }
        if (!LEVEL[body.level]) bad('Choose a level.');
        const dept = body.level === 'md' ? null : body.department;
        if (body.level !== 'md' && !DEPT[dept]) bad('Choose a department.');
        if (body.level === 'director') {
          const other = one("SELECT u.name FROM wf_staff s JOIN users u ON u.id = s.user_id WHERE s.level = 'director' AND s.department = ? AND s.user_id <> ?", dept, u.id);
          if (other) bad(`${other.name} already heads ${DEPT[dept].name}. Change their level first.`);
        }
        run(`INSERT INTO wf_staff (user_id, level, department) VALUES (?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET level = excluded.level, department = excluded.department`, u.id, body.level, dept);
        return { ok: true };
      },

      // Body: { id?, department, name, manager_id, senior_id, analyst_id, capacity }
      'POST /api/wf/team': (p, query, body) => {
        if (!canStructure(p)) forbid('Only the MD or an admin can change teams.');
        const dept = body.department;
        if (!DEPT[dept]) bad('Choose a department.');
        const name = String(body.name || '').trim();
        if (name.length < 2 || name.length > 60) bad('Name the team.');
        const check = (id, level, label) => {
          if (!id) return null;
          const s = one('SELECT level, department FROM wf_staff WHERE user_id = ?', Number(id));
          if (!s || s.level !== level || s.department !== dept) bad(`The ${label} must be a ${LEVEL[level].name} in ${DEPT[dept].name}.`);
          return Number(id);
        };
        const m = check(body.manager_id, 'manager', 'manager');
        const s = check(body.senior_id, 'senior', 'senior analyst');
        const a = check(body.analyst_id, 'analyst', 'analyst');
        const cap = Number(body.capacity || DEFAULT_CAPACITY);
        if (!Number.isInteger(cap) || cap < 1 || cap > 200) bad('Capacity must be between 1 and 200 clients.');
        if (body.id) {
          const t = one('SELECT * FROM wf_teams WHERE id = ?', Number(body.id));
          if (!t) bad('Team not found.');
          if (t.department !== dept) bad('A team stays in its department.');
          run('UPDATE wf_teams SET name = ?, manager_id = ?, senior_id = ?, analyst_id = ?, capacity = ? WHERE id = ?', name, m, s, a, cap, t.id);
          return { ok: true, id: t.id };
        }
        if (one('SELECT 1 FROM wf_teams WHERE department = ? AND name = ?', dept, name)) bad('A team with this name already exists in the department.');
        const r = run('INSERT INTO wf_teams (department, name, manager_id, senior_id, analyst_id, capacity) VALUES (?, ?, ?, ?, ?, ?)', dept, name, m, s, a, cap);
        return { ok: true, id: Number(r.lastInsertRowid) };
      },

      // Timely completion by department, team and person for a month.
      'GET /api/wf/performance': (p, query) => {
        const period = isPeriod(query.period) ? query.period : latestPeriod(p);
        const rows = tasksFor(p, { period });
        const teams = teamsWithLoad();
        const byTeam = teams.map((tm) => Object.assign({ id: tm.id, name: tm.name, department: tm.department, manager_name: tm.manager_name, clients: tm.clients, capacity: tm.capacity }, summarise(rows.filter((t) => t.team_id === tm.id)))).filter((x) => x.total);
        // People: who moved work forward this month, and whether it was on its step's target.
        const ids = rows.map((t) => t.id);
        const people = {};
        if (ids.length) {
          const ev = q(`SELECT e.task_id, e.user_id, e.action, e.from_stage, e.at, u.name FROM wf_events e JOIN users u ON u.id = e.user_id
            WHERE e.action IN ('submit', 'approve', 'return') AND e.task_id IN (${ids.map(() => '?').join(',')})`, ...ids);
          const byId = Object.fromEntries(rows.map((t) => [t.id, t]));
          ev.forEach((e) => {
            const t = byId[e.task_id];
            const x = people[e.user_id] || (people[e.user_id] = { id: e.user_id, name: e.name, actions: 0, on_target: 0, returns: 0 });
            if (e.action === 'return') { x.returns++; return; }
            x.actions++;
            const target = addDays(t.due_date, -((STAGE[e.from_stage] || STAGE.signoff).daysBefore));
            if (e.at.slice(0, 10) <= target) x.on_target++;
          });
        }
        return {
          period,
          overall: summarise(rows),
          byDepartment: DEPARTMENTS.map((d) => Object.assign({ key: d.key, name: d.name }, summarise(rows.filter((t) => t.department === d.key)))).filter((d) => d.total),
          byTeam,
          people: Object.values(people).sort((a, b) => b.actions - a.actions),
        };
      },
    };

    // The single entry point: (user, 'GET /api/wf/home', query, body) -> result, or throws WfError.
    function call(user, route, query = {}, body = {}) {
      const fn = calls[route];
      if (!fn) throw new WfError(404, 'Not found');
      if (!user || !(user.role === 'team' || user.role === 'admin')) throw new WfError(403, 'The workflow is for the Assura Elevate team only.');
      const p = profile(user);
      if (!p.level && !p.admin && route !== 'GET /api/wf/me') forbid('Your login has not been given a place in the team structure yet. Ask the MD or an admin.');
      return fn(p, query, body);
    }

    return { call, routes: Object.keys(calls), dueFor, timeliness };
  }

  return { install, createWorkflow, DEPARTMENTS, LEVELS, STAGES, MONTHLY, WfError, dueFor, timeliness, addDays };
});
