/* Assura Elevate practice workspace: front end. Team logins only; the server refuses client logins. */
(function () {
  'use strict';

  // ---------- API (real server, or the in-browser preview when AE_WF_DEMO is present) ----------
  const demo = window.AE_WF_DEMO || null;
  const api = demo || {
    async request(method, url, body) {
      const res = await fetch(url, {
        method, credentials: 'same-origin',
        headers: Object.assign({ 'X-Requested-With': 'assura' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; e.data = data; throw e; }
      return data;
    },
  };
  const get = (url) => api.request('GET', url);
  const post = (url, body) => api.request('POST', url, body || {});

  const root = document.getElementById('wf');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dShort = (s) => (s ? `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]}` : '–');
  const dLong = (s) => (s ? `${+s.slice(8, 10)} ${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : '–');
  const mLong = (p) => `${FULL[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
  const stamp = (t) => {
    const d = new Date(/Z$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z');
    return isNaN(d) ? String(t) : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const LOGO = `<img class="logo-on-light" src="${window.AE_LOGO || '/brand/assura-elevate-logo.png'}" alt="Assura Elevate"><img class="logo-on-dark" src="${window.AE_LOGO_ON_DARK || '/brand/assura-elevate-logo-on-dark.png'}" alt="Assura Elevate">`;
  const BACK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M10.7 2.3 5 8l5.7 5.7 1.1-1.1L7.2 8l4.6-4.6z"/></svg>';

  const S = { meta: null, period: null, branch: '', depts: {}, divs: {}, levels: {}, stages: {}, branches: {}, entities: {} };
  const me = () => S.meta.me;
  const topSeat = () => me().admin || me().level === 'mp';

  // ---------- routing: every screen has its own address, so the phone's back button works ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '') || 'home';
    const [path, qs] = h.split('?');
    const parts = path.split('/');
    return { view: parts[0], id: parts[1], q: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };
  let moved = false;
  window.addEventListener('hashchange', () => { moved = true; route(); });
  function back(fallback) { if (moved) history.back(); else go(fallback); }
  const backBtn = (fallback, label) => `<button class="wf-back" data-back="${esc(fallback)}">${BACK_ICON}${esc(label || 'Back')}</button>`;

  function toast(text) {
    const t = document.createElement('div'); t.className = 'wf-toast'; t.textContent = text;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
  }
  const errBox = (el, err) => { if (el) el.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; };

  // ---------- boot ----------
  async function loadMeta() {
    S.meta = await get('/api/wf/me');
    const m = S.meta;
    S.depts = Object.fromEntries(m.departments.map((d) => [d.key, d]));
    S.divs = Object.fromEntries(m.divisions.map((d) => [d.key, d]));
    S.levels = Object.fromEntries(m.levels.map((l) => [l.key, l]));
    S.stages = Object.fromEntries(m.stages.map((s) => [s.key, s]));
    S.branches = Object.fromEntries(m.branches.map((b) => [b.id, b]));
    S.entities = Object.fromEntries(m.entity_types.map((e) => [e.key, e]));
    S.period = S.period || m.period;
  }
  async function boot() {
    if (demo && demo.ready) await demo.ready;
    if (demo && !demo.user) { pickDemoUser(); return; }
    try { await loadMeta(); } catch (e) {
      if (e.status === 401 || e.status === 403) { signedOut(e); return; }
      fatal(e); return;
    }
    route();
  }

  function signedOut(e) {
    root.innerHTML = `<main><div class="card empty"><div class="eyebrow">Assura Elevate team</div><h2>${e.status === 401 ? 'Please sign in' : 'This area is for the Assura Elevate team'}</h2>
      <p>${esc(e.status === 401 ? 'Sign in with your team login, then come back to the workspace.' : e.message)}</p><a class="btn" href="/">Go to sign in</a></div></main>`;
  }
  function fatal(e) {
    root.innerHTML = `<main><div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" id="reload">Reload</button></div></main>`;
    root.querySelector('#reload').addEventListener('click', () => location.reload());
  }

  function pickDemoUser() {
    root.innerHTML = `<main><div class="card"><div class="eyebrow">Practice workspace preview</div><h1>Choose who to sign in as</h1>
      <p class="muted">Each login sees the firm from its own seat: its own work, and the work of the people reporting to it. People and clients are placeholders.</p>
      <div class="wf-pick">${demo.logins.map((l) => `<button data-u="${l.id}"><b>${esc(l.name)}</b><small>${esc(l.note)}</small></button>`).join('')}</div></div></main>`;
    root.querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', () => { demo.signIn(Number(b.dataset.u)); S.meta = null; S.period = null; S.branch = ''; location.hash = '#/home'; boot(); }));
  }

  // ---------- shell ----------
  function seat(p) {
    if (!p.level) return p.admin ? 'Admin' : 'Not placed in the structure yet';
    if (p.level === 'mp') return 'Managing Partner';
    const br = p.branch_id && S.branches[p.branch_id] ? S.branches[p.branch_id].name : '';
    if (p.level === 'branch_head') return `Branch Head${br ? ' · ' + br : ''}`;
    return [S.levels[p.level].name, S.depts[p.department] ? S.depts[p.department].name : '', br].filter(Boolean).join(' · ');
  }
  const ICON = {
    home: 'M3 9l7-6 7 6v8h-5v-5H8v5H3z',
    tasks: 'M7 5h10M7 10h10M7 15h10M3 5h1M3 10h1M3 15h1',
    clients: 'M3 17V5l7-2v14M10 7h7v10M6 8h1M6 11h1M6 14h1M13 10h1M13 13h1',
    reports: 'M5 2h7l4 4v12H5zM12 2v4h4M8 10h6M8 13h6M8 16h3',
    billing: 'M4 2h12v16l-2-1.5L12 18l-2-1.5L8 18l-2-1.5L4 18zM7 6h6M7 9h6M7 12h4',
    attendance: 'M3 5h14v12H3zM3 9h14M7 3v4M13 3v4M7 13l2 2 4-4',
    performance: 'M10 18a7 7 0 100-14 7 7 0 000 14zM10 7v4l3 2M8 2h4',
    team: 'M7 9a3 3 0 100-6 3 3 0 000 6zM2 17c0-3 2-5 5-5s5 2 5 5M14 9a2.5 2.5 0 100-5M15 12c2 .5 3 2 3 5',
    portal: 'M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z',
  };
  const icon = (k) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${ICON[k]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function navItems() {
    const c = S.meta.can;
    return [['home', 'Home'], ['tasks', 'Tasks'], ['clients', 'Clients'], ['reports', 'Reports'], c.bill ? ['billing', 'Billing'] : null,
      ['attendance', 'Attendance'], ['performance', 'Timeliness'], ['team', 'Firm structure']].filter(Boolean);
  }
  const PARENT = { task: 'tasks', client: 'clients', report: 'reports', invoice: 'billing' };
  // Same layout as the client portal: side menu on wide screens, a menu button on phones.
  function shell(view, inner, { period = true, branch = false } = {}) {
    const m = S.meta; const p = m.me;
    const periods = Array.from(new Set([S.period].concat(m.periods))).sort().reverse();
    const nav = navItems();
    const active = PARENT[view] || view;
    const current = (nav.find(([k]) => k === active) || [])[1] || '';
    const showBranch = branch && !p.branch_id && m.branches.length > 1;
    root.innerHTML = `
      <div class="shell">
        <aside class="side" aria-label="Main menu">
          <div class="side-top"><a class="wordmark" href="#/home" aria-label="Assura Elevate, workspace home">${LOGO}</a></div>
          ${period ? `<div class="side-client"><label for="period">Month under review</label><select id="period">${periods.map((x) => `<option value="${x}" ${x === S.period ? 'selected' : ''}>${mLong(x)}</option>`).join('')}</select></div>` : ''}
          ${showBranch ? `<div class="side-client"><label for="branch">Branch</label><select id="branch"><option value="">All branches</option>${m.branches.map((b) => `<option value="${b.id}" ${String(b.id) === String(S.branch) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>` : ''}
          <nav class="side-nav" aria-label="Sections">
            <div class="nav-group">Practice</div>
            ${nav.map(([k, l]) => `<a class="nav-item" href="#/${k}" ${active === k ? 'aria-current="page"' : ''}>${icon(k)}<span>${l}</span></a>`).join('')}
            ${demo ? '' : `<div class="nav-group">Assura workspace</div><a class="nav-item" href="/">${icon('portal')}<span>Client portal</span></a>`}
          </nav>
          <div class="side-foot"><div class="who"><b>${esc(p.name)}</b><span>${esc(seat(p))}</span></div></div>
        </aside>
        <div class="scrim" id="scrim"></div>
        <div class="main-col">
          <header class="mbar">
            <button class="menu-btn" id="menu" aria-label="Open the menu" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
            <span class="wordmark">${LOGO}</span><span class="mbar-tab">${esc(current || 'Workspace')}</span>
          </header>
          ${demo ? `<div class="wf-demo">Preview with placeholder people and fictional clients. Signed in as ${esc(p.name)}. <button id="switch">Switch person</button></div>` : ''}
          <main id="page">${inner}</main>
        </div>
      </div>`;
    document.body.classList.remove('menu-open');
    const menu = (open) => { document.body.classList.toggle('menu-open', open); root.querySelector('#menu').setAttribute('aria-expanded', String(open)); };
    root.querySelector('#menu').addEventListener('click', () => menu(true));
    root.querySelector('#scrim').addEventListener('click', () => menu(false));
    root.querySelectorAll('.side a').forEach((a) => a.addEventListener('click', () => menu(false)));
    const sel = root.querySelector('#period');
    if (sel) sel.addEventListener('change', () => { S.period = sel.value; menu(false); route(); });
    const bsel = root.querySelector('#branch');
    if (bsel) bsel.addEventListener('change', () => { S.branch = bsel.value; menu(false); route(); });
    const sw = root.querySelector('#switch');
    if (sw) sw.addEventListener('click', () => { demo.signOut(); S.meta = null; location.hash = ''; boot(); });
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => back(b.dataset.back)));
    return root.querySelector('#page');
  }

  async function route() {
    if (!S.meta) return;
    const r = parseHash();
    const views = { home, tasks, task, clients, client, reports, report, billing, invoice, attendance, performance, team };
    const fn = views[r.view] || home;
    try { await fn(r); } catch (e) {
      shell(r.view, `${backBtn('#/home')}<div class="card empty"><h2>${e.status === 403 ? 'Not available to you' : 'Something went wrong'}</h2><p>${esc(e.message)}</p></div>`);
    }
    window.scrollTo(0, 0);
  }

  // ---------- small parts ----------
  const divShort = (k) => (S.divs[k] ? S.divs[k].short : k);
  const levelName = (k) => (S.levels[k] ? S.levels[k].name : '');
  const branchName = (id) => (id && S.branches[id] ? S.branches[id].name : '');
  function dueText(t) {
    if (t.stage === 'done') return t.timeliness === 'late' ? `<b>${plural(t.days_late, 'day')} late</b>Completed ${dShort(t.completed_on)}` : `<b>On time</b>Completed ${dShort(t.completed_on)}`;
    if (t.timeliness === 'delayed') return `<b>${plural(t.days_late, 'day')} late</b>Target ${dShort(t.due_date)}`;
    if (t.timeliness === 'behind') return `<b>Behind</b>${esc(t.stage_name)} was due ${dShort(t.stage_target)}`;
    return `<b>${t.days_left === 0 ? 'Due today' : `Due in ${plural(t.days_left, 'day')}`}</b>Target ${dShort(t.due_date)}`;
  }
  function taskRow(t, { showCompany = true } = {}) {
    return `<a class="wf-row t-${t.timeliness}" href="#/task/${t.id}">
      <div>${showCompany ? `<div class="co">${esc(t.company_name)}</div>` : ''}<div class="ti">${esc(t.title)}</div>
        <div class="meta"><span class="wf-pill dept">${esc(divShort(t.division))}</span>
          <span class="wf-pill stage ${t.stage === 'done' ? 'done' : ''}">${esc(t.stage_name)}</span>
          ${t.stage !== 'done' && t.owner_name && !t.my_turn ? `<span class="muted small">${esc(t.owner_name)}</span>` : ''}
          ${t.my_turn ? '<span class="wf-pill turn">Your turn</span>' : ''}
          ${t.open_flags ? '<span class="wf-pill flag">Flagged</span>' : ''}
          ${t.unverified_docs ? '<span class="wf-pill flag">Document not verified</span>' : ''}</div></div>
      <div class="due">${dueText(t)}</div></a>`;
  }
  const list = (rows, empty, opts) => (rows.length ? `<div class="wf-list">${rows.map((t) => taskRow(t, opts)).join('')}</div>` : `<p class="muted">${esc(empty)}</p>`);
  const stat = (n, label, cls, href) => `<a class="wf-stat ${n ? cls : ''}" href="${href}" style="text-decoration:none"><div class="n">${n == null ? '–' : n}</div><div class="l">${esc(label)}</div></a>`;
  function bar(s) {
    if (!s.total) return '<div class="wf-bar"></div>';
    return `<div class="wf-bar" title="${s.done} of ${s.total} complete"><span class="d" style="width:${(s.done / s.total) * 100}%"></span><span class="x" style="width:${(s.delayed / s.total) * 100}%"></span></div>`;
  }
  const divisionOptions = (sel, allowed) => S.meta.departments.filter((d) => !d.internal).map((d) => {
    const ds = S.meta.divisions.filter((x) => x.dept === d.key && (!allowed || allowed.includes(x.key)));
    return ds.length ? `<optgroup label="${esc(d.name)}">${ds.map((x) => `<option value="${x.key}" ${sel === x.key ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const branchFilter = (rows) => (S.branch ? rows.filter((x) => String(x.branch_id) === String(S.branch)) : rows);

  // ---------- Home ----------
  async function home() {
    const h = await get(`/api/wf/home?period=${S.period}`);
    const p = me();
    const hour = +new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const m = h.month;
    const att = S.meta.attendance_today;
    const attCard = p.level ? (att
      ? `<div class="wf-note" style="margin-bottom:16px">Today's attendance: <b>${att.present ? 'Present' : 'Absent'}</b>${att.verified ? ' · verified by Accounts' : ' · waiting for Accounts to verify'}. <a href="#/attendance">Attendance</a></div>`
      : `<div class="card wf-attend" style="margin-bottom:16px"><div><b>Mark today's attendance</b><div class="muted small">${dLong(S.meta.today)}. Accounts verifies it.</div></div>
          <div class="btn-row"><button class="btn small" data-present="1">Present</button><button class="btn secondary small" data-present="0">Absent</button></div></div>`) : '';
    const reportRow = (r) => `<a class="wf-row" href="#/report/${r.id}"><div><div class="co">${esc(r.kind_name)}</div><div class="ti">${dShort(r.start_day)} to ${dShort(r.end_day)}</div></div><div class="due"><b>Review</b></div></a>`;
    const actionRow = (a) => `<a class="wf-row" href="#/reports"><div><div class="ti" style="color:var(--ink)">${esc(a.text)}</div><div class="meta"><span class="muted small">Corrective action from ${esc(a.raised_by_name)}</span></div></div>
      <div class="due ${a.due_date && a.due_date < S.meta.today ? 't-delayed' : ''}"><b>${a.due_date ? (a.due_date < S.meta.today ? 'Overdue' : 'Due ' + dShort(a.due_date)) : 'Open'}</b></div></a>`;
    const page = shell('home', `
      <div class="page-head"><div><div class="eyebrow">${esc(seat(p))}</div><h1>${greet}, ${esc(p.name)}.</h1>
        <div class="muted" style="margin-top:6px">Reviewing ${mLong(h.period)} · today is ${dLong(S.meta.today)}</div></div></div>
      ${p.level || p.admin ? '' : '<div class="msg err">Your login has no place in the firm structure yet. Ask the Managing Partner or an admin to place you under Firm structure.</div>'}
      ${attCard}
      <div class="wf-stats">
        ${stat(h.mine.length, 'Waiting on you', 'warn', '#/tasks?status=mine')}
        ${stat(h.delayed.length, 'Past target date', 'alert', '#/tasks?status=delayed')}
        ${stat(h.reportsDue.length, 'Reports to review', 'warn', '#/reports')}
        ${stat(h.flags.length, 'Open flags', 'alert', '#/tasks?status=flagged')}
        ${stat(m.on_time_rate == null ? null : m.on_time_rate + '%', `Completed on time in ${MONTHS[+h.period.slice(5) - 1]}`, 'good', '#/performance')}
      </div>
      ${h.billingReady ? `<a class="wf-note section" href="#/billing" style="display:block;text-decoration:none;color:inherit"><b>${plural(h.billingReady, 'client month')}</b> closed and waiting with Accounts for the advance invoice to be raised or sent. Open Billing ›</a>` : ''}
      <div class="grid g-main section">
        <div class="card"><div class="card-head"><h3>Waiting on you</h3><span class="muted small">Earliest target first</span></div>
          ${list(h.mine, p.level ? 'Nothing is waiting on you.' : 'Tasks appear here once you are placed in the structure.')}</div>
        <div>
          ${h.reportsDue.length || h.myActions.length ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Reports and corrective actions</h3></div>
            ${h.reportsDue.slice(0, 4).map(reportRow).join('')}${h.myActions.map(actionRow).join('')}</div>` : ''}
          <div class="card"><div class="card-head"><h3>${p.level === 'mp' ? 'Flags for your decision' : 'Open flags'}</h3></div>
            ${h.flags.length ? h.flags.map((f) => `<a class="wf-row" href="#/task/${f.task_id}"><div><div class="co">${esc(f.company_name)}</div><div class="ti">${esc(f.reason)}</div>
              <div class="meta"><span class="wf-pill dept">${esc(divShort(f.division))}</span><span class="muted small">Raised by ${esc(f.raised_by_name)} · ${stamp(f.raised_at)}</span></div></div></a>`).join('') : '<p class="muted">No open flags.</p>'}</div>
        </div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="card-head"><h3>Past target date</h3><span class="muted small">Most overdue first</span></div>${list(h.delayed.slice(0, 12), 'Nothing is past its target date.')}</div>
        <div class="card"><div class="card-head"><h3>${mLong(h.period)} by department</h3><span class="muted small">${m.done} of ${m.total} complete</span></div>
          ${h.byDepartment.length ? `<div class="wf-depts">${h.byDepartment.map((d) => `<a class="wf-dept" href="#/tasks?department=${d.key}" style="text-decoration:none;color:inherit">
            <h4>${esc(d.name)}</h4><div class="big">${d.done}<span class="muted" style="font-size:18px"> / ${d.total}</span></div>${bar(d)}
            <div class="small muted" style="margin-top:6px">${d.delayed ? `<span style="color:var(--critical)">${d.delayed} late</span> · ` : ''}${d.on_time_rate == null ? 'None completed yet' : `${d.on_time_rate}% on time`}</div></a>`).join('')}</div>`
            : `<p class="muted">No work for ${mLong(h.period)} yet.${S.meta.can.cycle ? ' Start the month under Clients.' : ''}</p>`}</div>
      </div>`);
    page.querySelectorAll('[data-present]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/api/wf/attendance/mark', { present: b.dataset.present === '1' }); await loadMeta(); toast('Attendance marked'); home(); } catch (err) { toast(err.message); }
    }));
  }

  // ---------- Tasks ----------
  const STATUS = [['', 'All'], ['mine', 'Waiting on me'], ['open', 'Open'], ['delayed', 'Late or behind'], ['flagged', 'Flagged'], ['done', 'Completed']];
  async function tasks(r) {
    const f = Object.assign({ status: '', department: '', division: '' }, r.q);
    const qs = new URLSearchParams({ period: S.period, status: f.status, department: f.department, division: f.division, branch: S.branch }).toString();
    const { tasks: rows } = await get(`/api/wf/tasks?${qs}`);
    const link = (patch) => `#/tasks?${new URLSearchParams(Object.assign({}, f, patch)).toString()}`;
    const page = shell('tasks', `
      <div class="page-head"><div><div class="eyebrow">${mLong(S.period)}${f.department && S.depts[f.department] ? ' · ' + esc(S.depts[f.department].name) : ''}</div><h1>Tasks</h1>
        <div class="muted" style="margin-top:6px">${plural(rows.length, 'task')}. You see the work allotted to you and to the people reporting to you.</div></div>
        ${S.meta.can.create ? '<button class="btn secondary small" id="new">Add a task</button>' : ''}</div>
      <div id="newform"></div>
      <div class="wf-filters">${STATUS.map(([k, l]) => `<a class="wf-chip" href="${link({ status: k })}" aria-pressed="${f.status === k}" style="text-decoration:none">${l}</a>`).join('')}
        <select id="div" aria-label="Division"><option value="">All divisions</option>${divisionOptions(f.division)}</select></div>
      <div class="card">${list(rows, 'No tasks match.')}</div>`, { branch: true });
    page.querySelector('#div').addEventListener('change', (e) => go(link({ division: e.target.value, department: '' })));
    const nb = page.querySelector('#new');
    if (nb) nb.addEventListener('click', () => newTaskForm(page.querySelector('#newform')));
  }

  async function newTaskForm(el) {
    const p = me();
    const { clients: cs } = await get(`/api/wf/clients?period=${S.period}`);
    const allowed = topSeat() || p.level === 'branch_head' ? null : S.meta.divisions.filter((d) => d.dept === p.department).map((d) => d.key);
    el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Add a task</h3><span class="muted small">It goes to the person allotted the client in that division</span></div>
      <form class="wf-form" id="nt">
        <div><label>Client</label><select name="company_id" required>${cs.filter((c) => c.onboarded).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Division</label><select name="division">${divisionOptions('', allowed)}</select></div>
        <div style="grid-column:1/-1"><label>Task</label><input name="title" type="text" required maxlength="200" placeholder="For example: Reply to GST notice for FY 2024-25"></div>
        <div><label>Target date</label><input name="due_date" type="date" required></div>
        <div><button class="btn" type="submit">Add task</button></div>
      </form><div id="ntmsg"></div></div>`;
    el.querySelector('#nt').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target)); body.period = S.period;
      try { const r = await post('/api/wf/task', body); toast('Task added'); go(`#/task/${r.id}`); } catch (err) { errBox(el.querySelector('#ntmsg'), err); }
    });
  }

  // ---------- One task ----------
  const ACTION_LABEL = { create: 'Created', submit: 'Submitted for checking', approve: 'Approved', return: 'Sent back', flag: 'Flagged for the Managing Partner', resolve: 'Flag decided', reschedule: 'Target date changed', reopen: 'Reopened', document: 'Document' };
  const CHANNELS = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['portal', 'Client portal'], ['courier', 'Courier'], ['in person', 'In person']];
  function docRows(docs, canSetAside) {
    if (!docs.length) return '';
    return `<div class="wf-list">${docs.map((d) => `<div class="wf-doc ${d.status === 'rejected' ? 'rejected' : d.verified ? 'ok' : 'bad'}">
      <div><b>${esc(d.title)}</b>${d.task_title ? `<div class="muted small">${esc(d.task_title)}</div>` : ''}
        <div class="small">${d.status === 'rejected' ? '<span class="wf-pill">Set aside</span>' : d.verified ? '<span class="wf-pill ok">✓ Registered source</span>' : '<span class="wf-pill flag">Not from a registered contact</span>'}
          <span class="muted">${esc(d.received_from)} · ${esc(d.channel)}${d.contact_name ? ` · ${esc(d.contact_name)}, ${esc(d.contact_role)}` : ''}</span></div>
        <div class="muted small">Logged by ${esc(d.received_by_name || '')} · ${stamp(d.received_at)}</div>
        ${d.note ? `<div class="small" style="margin-top:4px">${esc(d.note)}</div>` : ''}
        ${canSetAside && !d.verified && d.status === 'received' ? `<form class="wf-inline" data-reject="${d.id}"><input type="text" required maxlength="300" placeholder="Why it is set aside, and what was asked of the client"><button class="btn secondary small">Set aside</button></form>` : ''}</div></div>`).join('')}</div>`;
  }
  const docForm = (id) => `<details class="wf-more"><summary>Log a document received</summary>
    <form class="wf-form" id="${id}" style="margin-top:8px">
      <div style="grid-column:1/-1"><label>Document</label><input name="title" type="text" required maxlength="200" placeholder="For example: Signed board resolution"></div>
      <div><label>Received from (email or mobile)</label><input name="received_from" type="text" required maxlength="200" placeholder="name@company.in or 98450 12345"></div>
      <div><label>How</label><select name="channel">${CHANNELS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      <div><button class="btn small">Log document</button></div></form></details>`;

  async function task(r) {
    const d = await get(`/api/wf/task?id=${encodeURIComponent(r.id)}`);
    const t = d.task;
    const idx = d.chain.findIndex((s) => s.key === t.stage);
    const today = S.meta.today;
    const chain = d.chain.map((s, i) => {
      const cls = t.stage === 'done' || i < idx ? 'past' : i === idx ? 'now' : '';
      const late = i === idx && today > s.target;
      return `<div class="wf-step ${cls} ${late ? 'late' : ''}"><b>${esc(s.name)}</b>${esc(s.person || s.who)}<br><span class="tg">by ${dShort(s.target)}</span></div>`;
    }).join('');
    const can = (a) => d.actions.includes(a);
    const actBox = [];
    if (can('submit') || can('approve')) {
      actBox.push(`<div class="wf-act"><label for="note">Note ${can('return') ? '(required to send back)' : '(optional)'}</label><textarea id="note" maxlength="1000" placeholder="${can('submit') ? 'What was done, and anything the checker should look at' : 'Review comments'}"></textarea>
        <div class="btn-row">${can('submit') ? '<button class="btn" data-act="submit">Submit for checking</button>' : ''}
        ${can('approve') ? `<button class="btn" data-act="approve">${t.stage === 'check' ? 'Quality checked' : t.stage === 'mp' ? 'Approve as Managing Partner' : 'Give final approval'}</button>` : ''}
        ${can('return') ? '<button class="btn secondary" data-act="return">Send back</button>' : ''}</div></div>`);
    } else if (t.stage !== 'done') {
      actBox.push(`<div class="wf-note">${esc(`Waiting on ${t.owner_name || 'the ' + t.waiting_on.toLowerCase()}.`)}</div>`);
    } else actBox.push(`<div class="msg ok" style="margin-top:0">Completed ${dLong(t.completed_on)}${t.timeliness === 'late' ? `, ${plural(t.days_late, 'day')} after the target date` : ', on time'}.</div>`);
    if (d.note) actBox.push(`<div class="msg err" style="margin-top:10px">${esc(d.note)}</div>`);

    const flags = d.flags.map((f) => `<div class="wf-flag ${f.status}"><div>${esc(f.reason)}</div>
      <div class="who">Raised by ${esc(f.raised_by_name)} · ${stamp(f.raised_at)}</div>
      ${f.status === 'resolved' ? `<div style="margin-top:6px"><b>Decision:</b> ${esc(f.resolution)}</div><div class="who">${esc(f.resolved_by_name || '')} · ${stamp(f.resolved_at)}</div>`
        : can('resolve') ? `<form class="wf-act" data-resolve="${f.id}" style="margin-top:8px"><textarea required placeholder="Your decision"></textarea><div><button class="btn small">Record decision</button></div></form>` : ''}</div>`).join('');

    const page = shell('task', `
      ${backBtn('#/tasks', 'Back')}
      <div class="page-head"><div><div class="eyebrow">${esc(S.depts[t.department].name)} · ${esc(S.divs[t.division].name)} · ${mLong(t.period)}${t.branch_id ? ' · ' + esc(branchName(t.branch_id)) : ''}</div><h1>${esc(t.company_name)}</h1>
        <div style="margin-top:6px;font-size:16px">${esc(t.title)}</div>
        <div class="meta" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><span class="wf-pill stage ${t.stage === 'done' ? 'done' : ''}">${esc(t.stage_name)}</span>
          ${t.open_flags ? '<span class="wf-pill flag">Flagged for the Managing Partner</span>' : ''}<span class="wf-pill t-${t.timeliness}">${dueText(t).replace('<b>', '').replace('</b>', ' · ')}</span></div></div></div>
      <div class="grid g-main">
        <div>
          <div class="card"><div class="card-head"><h3>Approval chain</h3><span class="muted small">Target date ${dLong(t.due_date)}</span></div>
            <div class="wf-chain">${chain}</div>
            <div class="muted small">Allotted to ${esc(t.assignee_name || 'no one')}. Department head: ${esc(d.head || 'not set')}. <a href="#/client/${t.company_id}">Client record ›</a></div></div>
          <div class="card section"><div class="card-head"><h3>Documents</h3><span class="muted small">Accepted only from the client's registered contacts</span></div>
            ${docRows(d.documents, can('set_aside')) || '<p class="muted small" style="margin:0">No documents logged on this task.</p>'}
            ${can('document') ? docForm('docf') : ''}</div>
          <div class="card section"><div class="card-head"><h3>History</h3></div>
            <ul class="wf-history">${d.events.slice().reverse().map((e) => `<li class="${e.action}"><span class="when">${stamp(e.at)}</span>
              <div><b>${esc(ACTION_LABEL[e.action] || e.action)}</b> · ${esc(e.user_name || '')}${e.to_stage && e.to_stage !== e.from_stage && e.action !== 'create' ? ` <span class="muted">→ ${esc(S.stages[e.to_stage].name)}</span>` : ''}
              ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</div></li>`).join('')}</ul></div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>${t.stage === 'done' ? 'Status' : 'Next step'}</h3></div>${actBox.join('')}<div id="actmsg"></div></div>
          <div class="card section"><div class="card-head"><h3>Flags</h3></div>${flags || '<p class="muted small" style="margin:0 0 10px">Anything that needs a decision from the top: raise a flag and the task goes to the Managing Partner before it can close.</p>'}
            ${can('flag') ? `<form class="wf-act" id="flagf"><textarea required minlength="5" placeholder="What is the issue and what decision is needed?"></textarea><div><button class="btn secondary small">Flag for the Managing Partner</button></div></form>` : ''}</div>
          ${can('reschedule') ? `<div class="card section"><div class="card-head"><h3>Target date</h3></div><form class="wf-form" id="resch">
            <div><label>New target date</label><input type="date" name="due_date" value="${t.due_date}" required></div>
            <div style="grid-column:1/-1"><label>Reason</label><input type="text" name="note" required maxlength="300"></div><div><button class="btn secondary small">Change date</button></div></form></div>` : ''}
          ${can('reopen') ? `<div class="card section"><form class="wf-act" id="reopen"><label>Reopen completed work</label><textarea required placeholder="Why it needs another look"></textarea><div><button class="btn secondary small">Reopen</button></div></form></div>` : ''}
        </div>
      </div>`, { period: false });

    const msg = (err) => errBox(page.querySelector('#actmsg'), err);
    page.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const out = await post('/api/wf/task/action', { id: t.id, action: b.dataset.act, note: page.querySelector('#note').value });
        toast(out.stage === 'done' ? 'Completed' : b.dataset.act === 'return' ? 'Sent back to preparation' : `Moved to ${S.stages[out.stage].name}`);
        task(r);
      } catch (err) { b.disabled = false; msg(err); }
    }));
    const wire = (sel, fn) => { const f = page.querySelector(sel); if (f) f.addEventListener('submit', async (e) => { e.preventDefault(); try { await fn(e.target); task(r); } catch (err) { msg(err); window.scrollTo(0, 0); } }); };
    wire('#flagf', (f) => post('/api/wf/task/flag', { id: t.id, reason: f.querySelector('textarea').value }).then(() => toast('Flagged for the Managing Partner')));
    wire('#resch', (f) => post('/api/wf/task/reschedule', Object.assign({ id: t.id }, Object.fromEntries(new FormData(f)))).then(() => toast('Target date changed')));
    wire('#reopen', (f) => post('/api/wf/task/action', { id: t.id, action: 'reopen', note: f.querySelector('textarea').value }).then(() => toast('Reopened')));
    wire('#docf', (f) => post('/api/wf/document', Object.assign({ company_id: t.company_id, task_id: t.id }, Object.fromEntries(new FormData(f))))
      .then((o) => toast(o.verified ? `Logged: from ${o.contact}` : 'Logged, but not from a registered contact. It blocks approval until set aside or received properly.')));
    page.querySelectorAll('[data-reject]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/document/reject', { id: Number(f.dataset.reject), note: f.querySelector('input').value }); toast('Set aside'); task(r); } catch (err) { msg(err); }
    }));
    page.querySelectorAll('[data-resolve]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/flag/resolve', { flag_id: Number(f.dataset.resolve), resolution: f.querySelector('textarea').value }); toast('Decision recorded'); task(r); } catch (err) { msg(err); }
    }));
  }

  // ---------- Clients ----------
  async function clients(r, notice) {
    const d = await get(`/api/wf/clients?period=${S.period}${S.branch ? '&branch=' + S.branch : ''}`);
    const can = S.meta.can;
    const divs = S.meta.divisions;
    const cell = (c, dv) => {
      const x = c.divisions[dv.key];
      if (!x) return `<td class="cell" data-label="${esc(dv.short)}"><span class="muted small">–</span></td>`;
      if (!x.applicable) return `<td class="cell na" data-label="${esc(dv.short)}"><span class="muted small">Not applicable${x.tasks ? (x.complete ? ' · reviewed' : ' · review open') : ''}</span></td>`;
      return `<td class="cell" data-label="${esc(dv.short)}"><div class="wf-cell">
        <span>${x.complete ? '<span class="wf-tick">✓ Done</span>' : x.tasks ? `${x.done} / ${x.tasks}${x.delayed ? ' <span style="color:var(--critical);font-size:12px">· late</span>' : ''}${x.flagged ? ' <span class="wf-pill flag">Flag</span>' : ''}` : '<span class="muted small">Not started</span>'}</span>
        <span class="tn">${esc(x.assignee_name || 'Not allotted')}</span></div></td>`;
    };
    const done = d.clients.filter((c) => c.complete).length;
    const page = shell('clients', `
      <div class="page-head"><div><div class="eyebrow">${mLong(d.period)}</div><h1>Clients</h1>
        <div class="muted" style="margin-top:6px">${done} of ${d.clients.length} clients complete for the month. One person is allotted per client in each division.</div></div>
        ${can.onboard ? '<a class="btn secondary small" href="#/client/new">Onboard a client</a>' : ''}</div>
      ${can.cycle ? `<form id="cycle" class="card wf-attend" style="margin-bottom:16px"><div><b>Start a month</b><div class="muted small">Creates each client's monthly work for the person allotted, and an applicability review where a division is marked not applicable. Safe to run again.</div></div>
        <div class="btn-row" style="align-items:end"><input id="cp" type="month" value="${d.period}" required style="width:auto" aria-label="Month"><button class="btn small">Start the month</button></div></form>` : ''}
      <div id="cmsg">${notice || ''}</div>
      <div class="card"><div class="table-wrap"><table class="wf-matrix"><thead><tr><th>Client</th>${divs.map((dv) => `<th title="${esc(dv.name)}">${esc(dv.short)}</th>`).join('')}<th>Month</th></tr></thead><tbody>
        ${d.clients.map((c) => `<tr><td class="name"><a href="#/client/${c.id}">${esc(c.name)}</a><div class="muted small">${esc(c.code)}${c.entity_type ? ' · ' + esc(S.entities[c.entity_type].name) : ''}${c.branch_name ? ' · ' + esc(c.branch_name) : ''}</div></td>${divs.map((dv) => cell(c, dv)).join('')}
          <td class="state">${c.complete ? '<span class="wf-tick">✓ Complete</span>' : c.onboarded ? '<span class="muted small">In progress</span>' : '<span class="muted small">Record not complete</span>'}</td></tr>`).join('') || `<tr><td colspan="${divs.length + 2}" class="muted">No clients to show.</td></tr>`}
      </tbody></table></div></div>`, { branch: true });
    const cf = page.querySelector('#cycle');
    if (cf) cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const out = await post('/api/wf/cycle', { period: page.querySelector('#cp').value });
        await loadMeta(); S.period = out.period;
        await clients(r, `<div class="msg ${out.missing.length ? 'err' : 'ok'}">${out.created ? `${plural(out.created, 'task')} created for ${mLong(out.period)}.` : `Every allotted client already has its ${mLong(out.period)} work.`}
          ${out.missing.length ? `<div style="margin-top:6px">No one is allotted yet, so nothing was created for: ${esc(out.missing.join(', '))}.</div>` : ''}</div>`);
      } catch (err) { errBox(page.querySelector('#cmsg'), err); }
    });
  }

  const CONTACT_ROLES = ['Owner', 'Proprietor', 'Partner', 'Director', 'Trustee', 'Accountant', 'Other'];
  function clientForm(pr, isNew, editable) {
    const v = (k) => esc(pr[k] == null ? '' : pr[k]);
    const dis = editable ? '' : 'disabled';
    const branches = S.meta.branches.filter((b) => topSeat() || !me().branch_id || b.id === me().branch_id);
    return `<form class="wf-form" id="cform">
      ${isNew ? '<div><label>Client code</label><input name="code" required maxlength="20" placeholder="AE-0009"></div>' : ''}
      <div style="grid-column:1/-1"><label>Name</label><input name="name" required maxlength="160" value="${v('name')}" ${dis}></div>
      <div><label>Branch</label><select name="branch_id" ${dis}>${branches.map((b) => `<option value="${b.id}" ${pr.branch_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      <div><label>Entity</label><select name="entity_type" ${dis}>${S.meta.entity_types.map((e) => `<option value="${e.key}" ${pr.entity_type === e.key ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>
      <div><label>PAN</label><input name="pan" maxlength="10" value="${v('pan')}" ${dis}></div>
      <div><label>GSTIN</label><input name="gstin" maxlength="15" value="${v('gstin')}" ${dis}></div>
      <div><label>TAN</label><input name="tan" maxlength="10" value="${v('tan')}" ${dis}></div>
      <div><label>CIN or LLPIN</label><input name="cin" maxlength="21" value="${v('cin')}" ${dis}></div>
      <div style="grid-column:1/-1"><label>Registered address</label><input name="address" maxlength="300" value="${v('address')}" ${dis}></div>
      <div><label>Billing email</label><input name="billing_email" type="email" maxlength="160" value="${v('billing_email')}" ${dis}></div>
      <div><label>Office phone</label><input name="phone" maxlength="30" value="${v('phone')}" ${dis}></div>
      <div><label>Monthly fee (₹, before GST)</label><input name="monthly_fee" type="number" min="0" step="500" value="${pr.monthly_fee == null ? 30000 : pr.monthly_fee}" ${dis}></div>
      <div><label>Target day each month</label><input name="target_day" type="number" min="1" max="31" value="${pr.target_day || 20}" ${dis}></div>
      ${editable ? `<div><button class="btn small">${isNew ? 'Onboard client' : 'Save details'}</button></div>` : ''}</form>`;
  }

  async function client(r) {
    if (r.id === 'new') return newClient();
    const d = await get(`/api/wf/client?id=${encodeURIComponent(r.id)}&period=${S.period}`);
    const c = d.client; const pr = Object.assign({ name: c.name }, d.profile);
    const can = d.can;
    const allotRow = (a) => {
      const dv = S.divs[a.division];
      const editable = can.allot.includes(a.division);
      const people = d.people.filter((x) => x.department === dv.dept);
      const chainTxt = a.assignee_id ? `Checked by ${esc(a.chain.checker || a.chain.approver || '–')}, approved by ${esc(a.chain.approver || '–')}` : 'No one allotted';
      return `<div class="wf-allot ${a.applicable ? '' : 'na'}"><div><b>${esc(dv.name)}</b>${a.applicable ? '' : ' <span class="wf-pill">Not applicable · monthly review only</span>'}<div class="muted small">${chainTxt}${a.since ? ` · since ${dShort(a.since)}` : ''}</div></div>
        ${editable ? `<form class="wf-allot-form" data-div="${a.division}">
          <label class="wf-check"><input type="checkbox" name="applicable" ${a.applicable ? 'checked' : ''}> Applicable</label>
          <select name="assignee_id" aria-label="Allotted to"><option value="">Not allotted</option>${people.map((x) => `<option value="${x.id}" ${x.id === a.assignee_id ? 'selected' : ''}>${esc(x.name)} (${esc(levelName(x.level))})</option>`).join('')}</select>
          <button class="btn secondary small">Save</button></form>`
        : `<div class="small">${esc(a.assignee_name || 'Not allotted')}</div>`}</div>`;
    };
    const order = (k) => S.meta.divisions.findIndex((x) => x.key === k);
    const byDept = S.meta.departments.filter((dp) => !dp.internal).map((dp) => {
      const rows = d.allotments.filter((a) => S.divs[a.division].dept === dp.key).sort((a, b) => order(a.division) - order(b.division));
      return rows.length ? `<div class="wf-allot-group"><div class="eyebrow">${esc(dp.name)}</div>${rows.map(allotRow).join('')}</div>` : '';
    }).join('');
    const contacts = d.contacts.map((x) => `<tr><td>${esc(x.name)}<div class="muted small">${esc(x.role)}</div></td><td>${esc(x.email || '–')}<div class="muted small">${esc(x.phone || '')}</div></td>
      <td>${x.authorised ? '<span class="wf-pill ok">May send documents</span>' : '<span class="muted small">Not authorised</span>'}</td>
      ${can.edit ? `<td class="r"><button class="btn secondary small" data-rmc="${x.id}">Remove</button></td>` : ''}</tr>`).join('');
    const page = shell('client', `
      ${backBtn('#/clients', 'Clients')}
      <div class="page-head"><div><div class="eyebrow">${esc(c.code)}${c.entity_type ? ' · ' + esc(S.entities[c.entity_type].name) : ''}${c.branch_name ? ' · ' + esc(c.branch_name) : ''}</div><h1>${esc(c.name)}</h1>
        <div class="muted" style="margin-top:6px">${c.onboarded ? `Fee ${inr(c.monthly_fee)} a month · target day ${c.target_day}${pr.onboarded_on ? ` · onboarded ${dLong(pr.onboarded_on)}` : ''}` : 'Complete the client record below to allot work.'}</div></div></div>
      <div id="cmsg"></div>
      <div class="grid g-main">
        <div>
          <div class="card"><div class="card-head"><h3>Allotment</h3><span class="muted small">One person per division until replaced; open work moves with the client</span></div>${byDept || '<p class="muted">Complete the record first.</p>'}</div>
          <div class="card section"><div class="card-head"><h3>Work for ${mLong(d.period)}</h3></div>${list(d.tasks, 'No work for this month yet.', { showCompany: false })}</div>
          <div class="card section"><div class="card-head"><h3>Documents received</h3><span class="muted small">Only from the contacts listed here</span></div>
            ${docRows(d.documents, can.set_aside) || '<p class="muted small" style="margin:0">No documents logged yet.</p>'}${docForm('cdocf')}</div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>Owners, partners and contacts</h3></div>
            <p class="muted small" style="margin-top:0">A document from the client counts only when it comes from one of these emails or mobile numbers. Anything else is held and the work cannot be approved.</p>
            ${contacts ? `<div class="table-wrap"><table class="wf-table"><tbody>${contacts}</tbody></table></div>` : '<p class="muted small">No contacts yet.</p>'}
            ${can.edit ? `<details class="wf-more"><summary>Add a contact</summary><form class="wf-form" id="contf" style="margin-top:8px">
              <div><label>Role</label><select name="role">${CONTACT_ROLES.map((x) => `<option>${x}</option>`).join('')}</select></div>
              <div><label>Name</label><input name="name" required maxlength="120"></div>
              <div><label>Email</label><input name="email" type="email" maxlength="160"></div>
              <div><label>Mobile</label><input name="phone" maxlength="20"></div>
              <label class="wf-check"><input type="checkbox" name="authorised" checked> May send documents</label>
              <div><button class="btn small">Add contact</button></div></form></details>` : ''}</div>
          <div class="card section"><div class="card-head"><h3>Client record</h3></div>${clientForm(pr, false, can.edit)}</div>
          ${d.billing.length ? `<div class="card section"><div class="card-head"><h3>Billing</h3></div><div class="table-wrap"><table class="wf-table"><tbody>${d.billing.map((b) => `<tr><td>${mLong(b.bill_month)}<div class="muted small">${esc(b.invoice_no || 'Not invoiced')}</div></td><td class="r">${inr(b.fee)}</td><td>${esc(BILL_STATUS[b.status])}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
          <div class="card section"><div class="card-head"><h3>Allotment history</h3></div>
            <ul class="wf-history">${d.log.map((l) => `<li><span class="when">${stamp(l.at)}</span><div><b>${esc(l.division === 'all' ? 'Client' : S.divs[l.division].name)}</b> · ${esc(l.by_name || '')}<div class="note">${esc(l.change)}</div></div></li>`).join('') || '<li class="muted">No changes yet.</li>'}</ul></div>
        </div>
      </div>`);
    const msg = (err) => { errBox(page.querySelector('#cmsg'), err); window.scrollTo(0, 0); };
    page.querySelectorAll('[data-div]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await post('/api/wf/allot', { company_id: c.id, division: f.dataset.div, applicable: f.querySelector('[name=applicable]').checked, assignee_id: f.querySelector('[name=assignee_id]').value || null });
        toast('Allotment saved'); client(r);
      } catch (err) { msg(err); }
    }));
    const cf = page.querySelector('#cform');
    if (cf && can.edit) cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/client', Object.assign({ company_id: c.id, onboarded_on: pr.onboarded_on }, Object.fromEntries(new FormData(cf)))); toast('Saved'); client(r); } catch (err) { msg(err); }
    });
    const ct = page.querySelector('#contf');
    if (ct) ct.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(ct)); body.authorised = ct.querySelector('[name=authorised]').checked; body.company_id = c.id;
      try { await post('/api/wf/contact', body); toast('Contact added'); client(r); } catch (err) { msg(err); }
    });
    page.querySelectorAll('[data-rmc]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/api/wf/contact', { company_id: c.id, id: Number(b.dataset.rmc), remove: true }); toast('Contact removed'); client(r); } catch (err) { msg(err); }
    }));
    const df = page.querySelector('#cdocf');
    if (df) df.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const o = await post('/api/wf/document', Object.assign({ company_id: c.id }, Object.fromEntries(new FormData(df))));
        toast(o.verified ? `Logged: from ${o.contact}` : 'Logged, but not from a registered contact'); client(r);
      } catch (err) { msg(err); }
    });
    page.querySelectorAll('[data-reject]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/document/reject', { id: Number(f.dataset.reject), note: f.querySelector('input').value }); toast('Set aside'); client(r); } catch (err) { msg(err); }
    }));
  }

  function newClient() {
    if (!S.meta.can.onboard) throw Object.assign(new Error('Onboarding is done by a department head, the branch head or the Managing Partner.'), { status: 403 });
    const page = shell('client', `${backBtn('#/clients', 'Clients')}
      <div class="page-head"><div><div class="eyebrow">New client</div><h1>Onboard a client</h1>
        <div class="muted" style="margin-top:6px">Divisions are set from the type of entity and the GSTIN: Companies Act for a company, LLP for an LLP, Legal for partnerships, proprietorships and NGOs. Each can be changed after.</div></div></div>
      <div id="cmsg"></div><div class="card">${clientForm({ branch_id: me().branch_id || (S.meta.branches[0] || {}).id, entity_type: 'company' }, true, true)}</div>`, { period: false });
    const cf = page.querySelector('#cform');
    cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const o = await post('/api/wf/client', Object.fromEntries(new FormData(cf))); toast('Client onboarded. Now add the partners and allot the work.'); go(`#/client/${o.id}`); }
      catch (err) { errBox(page.querySelector('#cmsg'), err); }
    });
  }

  // ---------- Reports ----------
  async function reports() {
    const d = await get('/api/wf/reports');
    const mine = d.reports.filter((x) => x.reviewer_id === me().id);
    const pending = mine.filter((x) => x.status === 'pending');
    const earlier = mine.filter((x) => x.status !== 'pending');
    const others = d.reports.filter((x) => x.reviewer_id !== me().id);
    const row = (x) => `<a class="wf-row" href="#/report/${x.id}"><div><div class="co">${esc(x.kind_name)}${x.reviewer_id !== me().id ? ` · ${esc(x.reviewer_name)}` : ''}</div>
      <div class="ti">${dShort(x.start_day)} to ${dShort(x.end_day)}</div></div><div class="due ${x.status === 'pending' ? 't-behind' : 't-on_time'}"><b>${x.status === 'pending' ? 'Not reviewed' : 'Reviewed'}</b>${x.reviewed_at ? stamp(x.reviewed_at) : ''}</div></a>`;
    const open = d.actions.filter((a) => a.status === 'open');
    const page = shell('reports', `
      <div class="page-head"><div><div class="eyebrow">Reporting</div><h1>Reports</h1>
        <div class="muted" style="margin-top:6px">Every two days each supervisor and manager gets a status report on the people reporting to them; each department head a weekly report; the branch heads and the Managing Partner a consolidated report. Each is reviewed, and corrective actions are recorded and followed up.</div></div></div>
      <div id="rmsg"></div>
      <div class="grid g-2">
        <div class="card"><div class="card-head"><h3>For you to review</h3></div>${pending.length ? `<div class="wf-list">${pending.map(row).join('')}</div>` : '<p class="muted">Nothing to review.</p>'}</div>
        <div class="card"><div class="card-head"><h3>Corrective actions</h3><span class="muted small">${open.length} open</span></div>
          ${d.actions.length ? `<div class="wf-list">${d.actions.slice(0, 40).map((a) => `<div class="wf-action ${a.status}"><div><div>${esc(a.text)}</div>
            <div class="muted small">${esc(a.owner_name)} · raised by ${esc(a.raised_by_name)}${a.due_date ? ` · due ${dShort(a.due_date)}` : ''}${a.status === 'done' ? ` · done ${stamp(a.done_at)}` : a.due_date && a.due_date < S.meta.today ? ' · <span style="color:var(--critical)">overdue</span>' : ''}</div>
            ${a.done_note ? `<div class="small">${esc(a.done_note)}</div>` : ''}
            ${a.status === 'open' && (a.owner_id === me().id || a.raised_by === me().id) ? `<form class="wf-inline" data-done="${a.id}"><input type="text" required maxlength="300" placeholder="What was done"><button class="btn secondary small">Mark done</button></form>` : ''}</div></div>`).join('')}</div>` : '<p class="muted">No corrective actions.</p>'}</div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="card-head"><h3>Your earlier reports</h3></div>${earlier.length ? `<div class="wf-list">${earlier.slice(0, 20).map(row).join('')}</div>` : '<p class="muted">None yet.</p>'}</div>
        <div class="card"><div class="card-head"><h3>Reports in your line</h3><span class="muted small">Reviewed by the people under you</span></div>${others.length ? `<div class="wf-list">${others.slice(0, 40).map(row).join('')}</div>` : '<p class="muted">None.</p>'}</div>
      </div>`, { period: false });
    page.querySelectorAll('[data-done]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/action/done', { id: Number(f.dataset.done), note: f.querySelector('input').value }); toast('Recorded'); reports(); } catch (err) { errBox(page.querySelector('#rmsg'), err); }
    }));
  }

  function peopleTable(people) {
    if (!people.length) return '<p class="muted">No one in this report.</p>';
    const c = (n, bad) => `<td class="r" style="${n && bad ? 'color:var(--critical);font-weight:600' : ''}">${n}</td>`;
    return `<div class="table-wrap"><table><thead><tr><th>Person</th><th class="r">Open</th><th class="r">Past target</th><th class="r">Completed</th><th class="r">Completed late</th><th class="r">Sent back</th><th class="r">Flags</th><th class="r">Attendance</th></tr></thead><tbody>
      ${people.map((x) => `<tr><td>${esc(x.name)}<div class="muted small">${esc(levelName(x.level))}</div></td>${c(x.open)}${c(x.overdue, true)}${c(x.completed)}${c(x.completed_late, true)}${c(x.returned, true)}${c(x.flags, true)}
        <td class="r">${x.marked ? `${x.present} present${x.absent ? `, <span style="color:var(--critical)">${x.absent} absent</span>` : ''}` : '<span class="muted">Not marked</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const overdueList = (rows) => (rows.length ? `<div class="wf-list">${rows.map((t) => `<a class="wf-row t-delayed" href="#/task/${t.id}"><div><div class="co">${esc(t.company_name)}</div><div class="ti">${esc(t.title)}</div>
    <div class="meta"><span class="wf-pill dept">${esc(divShort(t.division))}</span><span class="wf-pill stage">${esc(t.stage_name)}</span><span class="muted small">${esc(t.assignee_name || '')}</span></div></div><div class="due"><b>${plural(t.days_late, 'day')} late</b></div></a>`).join('')}</div>` : '<p class="muted">Nothing was past its target date.</p>');
  const actionsList = (rows) => (rows && rows.length ? `<div class="wf-list">${rows.map((a) => `<div class="wf-action ${a.status}"><div>${esc(a.text)}<div class="muted small">${esc(a.owner_name)}${a.raised_by_name ? ` · raised by ${esc(a.raised_by_name)}` : ''}${a.due_date ? ` · due ${dShort(a.due_date)}` : ''} · ${a.status === 'done' ? 'done' : 'open'}</div></div></div>`).join('')}</div>` : '<p class="muted">None.</p>');

  async function report(r) {
    const d = await get(`/api/wf/report?id=${encodeURIComponent(r.id)}`);
    const rp = d.report; const s = rp.snapshot;
    let body;
    if (rp.kind === 'consolidated') {
      body = `<div class="card"><div class="card-head"><h3>By department</h3></div><div class="table-wrap"><table><thead><tr><th>Department</th><th class="r">Open</th><th class="r">Past target</th><th class="r">Completed</th><th class="r">Completed late</th></tr></thead><tbody>
        ${s.departments.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.open}</td><td class="r" style="${x.overdue ? 'color:var(--critical);font-weight:600' : ''}">${x.overdue}</td><td class="r">${x.completed}</td><td class="r">${x.completed_late}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card section"><div class="card-head"><h3>Most overdue, by department</h3></div>${s.departments.filter((x) => x.overdue_list.length).map((x) => `<div class="eyebrow" style="margin-top:8px">${esc(x.name)}</div>${overdueList(x.overdue_list)}`).join('') || '<p class="muted">Nothing overdue.</p>'}</div>
        <div class="grid g-2 section"><div class="card"><div class="card-head"><h3>Reviews in this period</h3></div>${s.reviews.length ? `<div class="wf-list">${s.reviews.map((x) => `<div class="wf-action ${x.status === 'reviewed' ? 'done' : 'open'}"><div><b>${esc(x.name)}</b> <span class="muted small">${x.kind === 'weekly' ? 'weekly' : 'two-day'} · ${x.status === 'reviewed' ? 'reviewed' : '<span style="color:var(--critical)">not reviewed</span>'}</span>${x.comment ? `<div class="small">${esc(x.comment)}</div>` : ''}</div></div>`).join('')}</div>` : '<p class="muted">None.</p>'}</div>
          <div class="card"><div class="card-head"><h3>Corrective actions</h3></div>${actionsList(s.actions)}</div></div>`;
    } else {
      body = `<div class="card"><div class="card-head"><h3>People</h3><span class="muted small">${rp.kind === 'weekly' ? 'Everyone in the department' : 'Everyone reporting to ' + esc(rp.reviewer_name)}</span></div>${peopleTable(s.people)}</div>
        <div class="card section"><div class="card-head"><h3>Past target date at the end of the period</h3></div>${overdueList(s.overdue)}</div>
        ${rp.kind === 'weekly' ? `<div class="card section"><div class="card-head"><h3>Corrective actions in the department</h3></div>${actionsList(s.actions)}</div>` : ''}`;
    }
    const review = d.can_review ? `<div class="card section" id="review"><div class="card-head"><h3>Your review</h3></div>
      <form class="wf-act" id="revf"><label for="rc">What you found and what you decided</label><textarea id="rc" required minlength="3" maxlength="2000"></textarea>
        <div class="eyebrow" style="margin-top:6px">Corrective actions</div><div id="acts"></div>
        <div class="btn-row"><button type="button" class="btn secondary small" id="addact">Add a corrective action</button><button class="btn">Record review</button></div></form><div id="revmsg"></div></div>`
      : rp.status === 'reviewed' ? `<div class="card section"><div class="card-head"><h3>Review</h3><span class="muted small">${esc(rp.reviewer_name)} · ${stamp(rp.reviewed_at)}</span></div><p style="margin-top:0">${esc(rp.comment)}</p>
        <div class="eyebrow">Corrective actions</div>${actionsList(d.actions)}</div>` : `<div class="wf-note section">Waiting for ${esc(rp.reviewer_name)} to review.</div>`;
    const page = shell('report', `${backBtn('#/reports', 'Reports')}
      <div class="page-head"><div><div class="eyebrow">${esc(rp.kind_name)} · ${esc(rp.reviewer_name)}</div><h1>${dShort(rp.start_day)} to ${dLong(rp.end_day)}</h1></div></div>
      ${body}${review}`, { period: false });
    const acts = page.querySelector('#acts');
    if (acts) {
      const addAct = () => {
        const div = document.createElement('div'); div.className = 'wf-form wf-actrow';
        div.innerHTML = `<div style="grid-column:1/-1"><label>Action</label><input name="text" maxlength="500" placeholder="What must be done"></div>
          <div><label>Who</label><select name="owner_id">${d.owners.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></div>
          <div><label>By</label><input name="due_date" type="date" value="${addDays(S.meta.today, 3)}"></div>`;
        acts.appendChild(div);
      };
      if (d.owners.length) page.querySelector('#addact').addEventListener('click', addAct); else page.querySelector('#addact').remove();
      page.querySelector('#revf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const actions = [...acts.querySelectorAll('.wf-actrow')].map((x) => ({ text: x.querySelector('[name=text]').value, owner_id: Number(x.querySelector('[name=owner_id]').value), due_date: x.querySelector('[name=due_date]').value || null })).filter((a) => a.text.trim());
        try { await post('/api/wf/report/review', { id: rp.id, comment: page.querySelector('#rc').value, actions }); toast('Review recorded'); report(r); } catch (err) { errBox(page.querySelector('#revmsg'), err); }
      });
    }
  }

  // ---------- Billing (Accounts) ----------
  const BILL_STATUS = { ready: 'Ready to invoice', invoiced: 'Invoice raised, not sent', sent: 'Sent, awaiting payment', paid: 'Paid' };
  async function billing() {
    const d = await get('/api/wf/billing');
    const rows = branchFilter(d.rows);
    const group = (st) => rows.filter((x) => x.status === st);
    const rowHtml = (b) => `<tr><td><a href="#/client/${b.company_id}">${esc(b.name)}</a><div class="muted small">${esc(b.code)}${b.branch_id ? ' · ' + esc(branchName(b.branch_id)) : ''} · ${mLong(b.period)} closed ${dShort(b.closed_on)}</div></td>
      <td>For ${mLong(b.bill_month)}${b.invoice_no ? `<div class="muted small">${esc(b.invoice_no)}</div>` : ''}</td><td class="r">${inr(b.total)}<div class="muted small">${inr(b.fee)} + GST</div></td>
      <td class="r">${b.status === 'ready' ? `<button class="btn small" data-raise="${b.id}">Raise invoice</button>`
        : b.status === 'invoiced' ? `<a class="btn small" href="#/invoice/${b.id}">Review and send</a>`
        : b.status === 'sent' ? `<a class="btn secondary small" href="#/invoice/${b.id}">Record payment</a><div class="muted small">Sent ${stamp(b.sent_at)}</div>`
        : `<a class="small" href="#/invoice/${b.id}">View</a><div class="muted small">Paid ${dShort(b.paid_on)}</div>`}</td></tr>`;
    const table = (st) => (group(st).length ? `<div class="table-wrap"><table class="wf-table"><tbody>${group(st).map(rowHtml).join('')}</tbody></table></div>` : '<p class="muted">None.</p>');
    const s = d.settings;
    const page = shell('billing', `
      <div class="page-head"><div><div class="eyebrow">Accounts</div><h1>Billing</h1>
        <div class="muted" style="margin-top:6px">When every division has completed a client's month, the month comes here and next month's fee is billed in advance. Invoices go to the client's billing email and the partners on record.</div></div></div>
      <div id="bmsg"></div>
      <div class="wf-stats wf-stats-4">
        ${stat(group('ready').length, 'Ready to invoice', 'warn', '#/billing')}
        ${stat(group('invoiced').length, 'Raised, not sent', 'warn', '#/billing')}
        ${stat(group('sent').length, 'Awaiting payment', '', '#/billing')}
        ${stat(inr(group('sent').reduce((a, x) => a + x.total, 0)), 'Outstanding', 'alert', '#/billing')}
      </div>
      <div class="card section"><div class="card-head"><h3>Ready to invoice</h3></div>${table('ready')}</div>
      <div class="card section"><div class="card-head"><h3>Raised, not sent</h3></div>${table('invoiced')}</div>
      <div class="card section"><div class="card-head"><h3>Awaiting payment</h3></div>${table('sent')}</div>
      <div class="card section"><div class="card-head"><h3>Paid</h3></div>${table('paid')}</div>
      ${d.can_settings ? `<details class="card section wf-more"><summary><b>Invoice settings</b> <span class="muted small">Firm name, address, GSTIN, GST rate, bank details</span></summary>
        <form class="wf-form" id="setf" style="margin-top:12px">
          <div><label>Firm name</label><input name="firm_name" value="${esc(s.firm_name)}"></div>
          <div><label>GSTIN</label><input name="firm_gstin" maxlength="15" value="${esc(s.firm_gstin)}"></div>
          <div><label>PAN</label><input name="firm_pan" maxlength="10" value="${esc(s.firm_pan)}"></div>
          <div><label>GST rate (%)</label><input name="gst_rate" type="number" min="0" max="28" value="${esc(s.gst_rate)}"></div>
          <div><label>Invoice prefix</label><input name="invoice_prefix" maxlength="10" value="${esc(s.invoice_prefix)}"></div>
          <div style="grid-column:1/-1"><label>Address</label><textarea name="firm_address">${esc(s.firm_address)}</textarea></div>
          <div style="grid-column:1/-1"><label>Bank details printed on the invoice</label><textarea name="bank_details">${esc(s.bank_details)}</textarea></div>
          <div><button class="btn small">Save settings</button></div></form></details>` : ''}`, { period: false, branch: true });
    page.querySelectorAll('[data-raise]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const o = await post('/api/wf/billing/invoice', { id: Number(b.dataset.raise) }); toast(`Invoice ${o.invoice_no} raised`); go(`#/invoice/${b.dataset.raise}`); } catch (err) { b.disabled = false; errBox(page.querySelector('#bmsg'), err); }
    }));
    const sf = page.querySelector('#setf');
    if (sf) sf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/settings', Object.fromEntries(new FormData(sf))); toast('Settings saved'); billing(); } catch (err) { errBox(page.querySelector('#bmsg'), err); }
    });
  }

  async function invoice(r) {
    const d = await get(`/api/wf/billing/invoice?id=${encodeURIComponent(r.id)}`);
    const b = d.invoice;
    const html = window.AEWorkflow && window.AEWorkflow.renderInvoice ? window.AEWorkflow.renderInvoice(d) : `<p>${esc(b.name)}: ${inr(b.total)}</p>`;
    const page = shell('invoice', `${backBtn('#/billing', 'Billing')}
      <div class="page-head"><div><div class="eyebrow">${esc(BILL_STATUS[b.status])}</div><h1>${esc(b.invoice_no)}</h1>
        <div class="muted" style="margin-top:6px">${esc(b.name)} · for ${mLong(b.bill_month)} · ${inr(b.total)}</div></div>
        <button class="btn secondary small" id="print">Print or save as PDF</button></div>
      <div id="imsg"></div>
      <div class="grid g-main">
        <div class="card wf-invoice">${html}</div>
        <div>
          ${b.status === 'invoiced' ? `<div class="card"><div class="card-head"><h3>Send to the client</h3></div>
            ${d.to.length ? `<form class="wf-act" id="sendf"><div class="muted small">The billing email and the owners or partners on record</div>${d.to.map((a) => `<label class="wf-check"><input type="checkbox" name="to" value="${esc(a)}" checked> ${esc(a)}</label>`).join('')}
              <div class="btn-row"><button class="btn">Email the invoice</button><button type="button" class="btn secondary small" id="manual">Sent another way</button></div></form>`
              : '<p class="muted small">No billing email or partner email is on record. Add one on the client record.</p>'}</div>` : ''}
          ${b.status === 'sent' ? `<div class="card"><div class="card-head"><h3>Record payment</h3></div><p class="muted small" style="margin-top:0">Sent to ${esc(b.sent_to)} · ${stamp(b.sent_at)}</p>
            <form class="wf-form" id="paidf"><div><label>Amount received (₹)</label><input name="amount" type="number" min="1" value="${b.total}" required></div>
              <div><label>Date received</label><input name="paid_on" type="date" value="${S.meta.today}" required></div>
              <div style="grid-column:1/-1"><label>Reference</label><input name="reference" maxlength="100" placeholder="UTR or cheque number"></div>
              <div><button class="btn small">Record payment</button></div></form></div>` : ''}
          ${b.status === 'paid' ? `<div class="card"><div class="msg ok" style="margin:0">Paid ${inr(b.paid_amount)} on ${dLong(b.paid_on)}${b.paid_ref ? ` · ${esc(b.paid_ref)}` : ''}.</div><p class="muted small">Sent to ${esc(b.sent_to)}</p></div>` : ''}
        </div>
      </div>`, { period: false });
    page.querySelector('#print').addEventListener('click', () => {
      const w = window.open('', '_blank');
      if (!w) { window.print(); return; }
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(b.invoice_no)}</title></head><body style="padding:32px">${html}</body></html>`);
      w.document.close(); w.focus(); w.print();
    });
    const msg = (err) => errBox(page.querySelector('#imsg'), err);
    const sf = page.querySelector('#sendf');
    const send = async (manual) => {
      const to = [...sf.querySelectorAll('[name=to]:checked')].map((x) => x.value);
      try {
        await post('/api/wf/billing/sent', { id: b.id, to, manual });
        toast(manual ? 'Recorded as sent' : demo ? 'Recorded as sent. The preview does not send email.' : `Invoice emailed to ${to.join(', ')}`); invoice(r);
      } catch (err) { msg(err); }
    };
    if (sf) {
      sf.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
      page.querySelector('#manual').addEventListener('click', () => send(true));
    }
    const pf = page.querySelector('#paidf');
    if (pf) pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/billing/paid', Object.assign({ id: b.id }, Object.fromEntries(new FormData(pf)))); toast('Payment recorded'); invoice(r); } catch (err) { msg(err); }
    });
  }

  // ---------- Attendance ----------
  async function attendance(r) {
    const month = r.q.month || S.meta.today.slice(0, 7);
    const d = await get(`/api/wf/attendance?month=${month}`);
    const days = [];
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let i = 1; i <= last; i++) {
      const day = `${month}-${String(i).padStart(2, '0')}`;
      if (day > d.today) break;
      days.push({ day, sunday: new Date(`${day}T00:00:00Z`).getUTCDay() === 0 });
    }
    const rec = new Map(d.records.map((x) => [`${x.user_id}:${x.day}`, x]));
    const rankOf = (l) => (S.levels[l] ? S.levels[l].rank : 0);
    const people = branchFilter(d.people).slice().sort((a, b) => (a.department || '').localeCompare(b.department || '') || (rankOf(b.level) - rankOf(a.level)) || a.name.localeCompare(b.name));
    const toVerify = d.can_verify ? d.records.filter((x) => !x.verified && x.user_id !== me().id && people.some((p) => p.id === x.user_id)).sort((a, b) => b.day.localeCompare(a.day)) : [];
    const nameOf = (id) => (people.find((p) => p.id === id) || {}).name;
    const work = days.filter((x) => !x.sunday);
    const att = S.meta.attendance_today;
    const prevM = (() => { let [yy, mm] = month.split('-').map(Number); mm -= 1; if (mm < 1) { mm = 12; yy -= 1; } return `${yy}-${String(mm).padStart(2, '0')}`; })();
    const dot = (p, x) => {
      if (x.sunday) return '<span class="wf-dot off" title="Sunday"></span>';
      const a = rec.get(`${p.id}:${x.day}`);
      const what = a ? `${a.present ? 'present' : 'absent'}${a.verified === 'yes' ? ', verified' : a.verified === 'no' ? ', marked not correct by Accounts' : ', not verified'}` : 'not marked';
      return `<span class="wf-dot ${a ? (a.present ? 'p' : 'a') : ''} ${a && !a.verified ? 'unv' : ''} ${a && a.verified === 'no' ? 'wrong' : ''}" title="${dShort(x.day)}: ${what}"></span>`;
    };
    const page = shell('attendance', `
      <div class="page-head"><div><div class="eyebrow">${mLong(month)}</div><h1>Attendance</h1>
        <div class="muted" style="margin-top:6px">Each person marks yes or no every working day. Accounts verifies it.</div></div>
        <div class="btn-row"><a class="btn secondary small" href="#/attendance?month=${prevM}">${mLong(prevM)}</a>${month !== d.today.slice(0, 7) ? '<a class="btn secondary small" href="#/attendance">This month</a>' : ''}</div></div>
      <div id="amsg"></div>
      ${me().level ? `<div class="card wf-attend" style="margin-bottom:16px"><div><b>Today, ${dLong(d.today)}</b><div class="muted small">${att ? `Marked ${att.present ? 'present' : 'absent'}${att.verified ? ', verified by Accounts' : ''}.` : 'Not marked yet.'}</div></div>
        ${att && att.verified ? '' : '<div class="btn-row"><button class="btn small" data-present="1">Present</button><button class="btn secondary small" data-present="0">Absent</button></div>'}</div>` : ''}
      ${d.can_verify ? `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>To verify</h3><span class="muted small">${plural(toVerify.length, 'marked day')} not yet verified</span></div>
        ${toVerify.length ? `<div class="btn-row" style="margin-bottom:10px">${[...new Set(toVerify.map((x) => x.day))].slice(0, 4).map((day) => `<button class="btn small" data-bulk="${day}">Confirm all marked present on ${dShort(day)}</button>`).join('')}</div>
          <div class="table-wrap"><table class="wf-table"><tbody>${toVerify.slice(0, 30).map((x) => `<tr><td>${esc(nameOf(x.user_id))}</td><td>${dShort(x.day)}</td><td>${x.present ? 'Marked present' : '<span style="color:var(--critical)">Marked absent</span>'}</td>
          <td class="r"><button class="btn small" data-verify="${x.user_id}|${x.day}|yes">Confirm</button> <button class="btn secondary small" data-verify="${x.user_id}|${x.day}|no">Not correct</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Everything marked has been verified.</p>'}</div>` : ''}
      <div class="card"><div class="card-head"><h3>${mLong(month)}</h3><span class="muted small"><span class="wf-dot p"></span> present <span class="wf-dot a"></span> absent <span class="wf-dot"></span> not marked <span class="wf-dot p unv"></span> not verified yet</span></div>
        <div class="table-wrap"><table class="wf-table wf-att"><thead><tr><th>Person</th><th class="r">Present</th><th class="r">Absent</th><th class="r">Not marked</th><th>Days</th></tr></thead><tbody>
        ${people.map((p) => {
          const rs = work.map((x) => rec.get(`${p.id}:${x.day}`));
          const pres = rs.filter((x) => x && x.present).length; const abs = rs.filter((x) => x && !x.present).length;
          return `<tr><td>${esc(p.name)}<div class="muted small">${esc(levelName(p.level))}</div></td><td class="r">${pres}</td><td class="r" style="${abs ? 'color:var(--critical)' : ''}">${abs}</td><td class="r">${work.length - pres - abs}</td>
            <td><div class="wf-days">${days.map((x) => dot(p, x)).join('')}</div></td></tr>`;
        }).join('')}</tbody></table></div></div>`, { period: false, branch: true });
    page.querySelectorAll('[data-present]').forEach((b) => b.addEventListener('click', async () => {
      try { await post('/api/wf/attendance/mark', { present: b.dataset.present === '1' }); await loadMeta(); toast('Attendance marked'); attendance(r); } catch (err) { errBox(page.querySelector('#amsg'), err); }
    }));
    page.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const rows = toVerify.filter((x) => x.day === b.dataset.bulk && x.present);
        for (const x of rows) await post('/api/wf/attendance/verify', { user_id: x.user_id, day: x.day, verified: 'yes' });
        toast(`${plural(rows.length, 'day')} confirmed`); attendance(r);
      } catch (err) { b.disabled = false; errBox(page.querySelector('#amsg'), err); }
    }));
    page.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
      const [uid, day, v] = b.dataset.verify.split('|');
      try { await post('/api/wf/attendance/verify', { user_id: Number(uid), day, verified: v }); attendance(r); } catch (err) { errBox(page.querySelector('#amsg'), err); }
    }));
  }

  // ---------- Timeliness ----------
  async function performance() {
    const d = await get(`/api/wf/performance?period=${S.period}`);
    const o = d.overall;
    const rate = (x) => (x.on_time_rate == null ? '–' : `${x.on_time_rate}%`);
    const row = (name, x) => `<tr><td>${name}</td><td class="r">${x.total}</td><td class="r">${x.done}</td><td class="r">${x.on_time}</td><td class="r" style="${x.late ? 'color:var(--critical)' : ''}">${x.late}</td><td class="r" style="${x.delayed ? 'color:var(--critical)' : ''}">${x.delayed}</td><td class="r"><b>${rate(x)}</b></td></tr>`;
    const head = '<thead><tr><th></th><th class="r">Tasks</th><th class="r">Completed</th><th class="r">On time</th><th class="r">Late</th><th class="r">Open past target</th><th class="r">On-time rate</th></tr></thead>';
    shell('performance', `
      <div class="page-head"><div><div class="eyebrow">${mLong(d.period)}</div><h1>Timeliness</h1>
        <div class="muted" style="margin-top:6px">Each task has a target date set by the client's target day. Preparation is due five days before it and the quality check two days before, so slippage shows early.</div></div></div>
      <div class="wf-stats">
        ${stat(o.total, 'Tasks this month', '', '#/tasks')}
        ${stat(o.done, 'Completed', 'good', '#/tasks?status=done')}
        ${stat(o.delayed, 'Open past target', 'alert', '#/tasks?status=delayed')}
        ${stat(o.late, 'Completed late', 'warn', '#/tasks?status=done')}
        ${stat(o.on_time_rate == null ? null : o.on_time_rate + '%', 'On-time rate', 'good', '#/performance')}
      </div>
      <div class="card section"><div class="card-head"><h3>By division</h3></div><div class="table-wrap"><table>${head}<tbody>${d.byDivision.map((x) => row(`${esc(x.name)}<div class="muted small">${esc(S.depts[x.department].name)}</div>`, x)).join('') || '<tr><td colspan="7" class="muted">No work yet.</td></tr>'}</tbody></table></div></div>
      <div class="card section"><div class="card-head"><h3>By person</h3><span class="muted small">Work allotted to each person this month</span></div><div class="table-wrap"><table>${head}<tbody>
        ${d.byPerson.map((x) => row(`${esc(x.name)}<div class="muted small">${esc(levelName(x.level))}${x.department ? ' · ' + esc(S.depts[x.department].name) : ''}</div>`, x)).join('') || '<tr><td colspan="7" class="muted">No work yet.</td></tr>'}</tbody></table></div></div>`);
  }

  // ---------- Firm structure ----------
  async function team() {
    const d = await get('/api/wf/structure');
    const can = S.meta.can.structure;
    const placed = d.staff.filter((s) => s.level);
    const nameOf = (id) => (d.staff.find((s) => s.id === id) || {}).name || '';
    const mp = placed.filter((s) => s.level === 'mp');
    const rankOf = (l) => (S.levels[l] ? S.levels[l].rank : 0);
    const branchCard = (b) => {
      const inB = placed.filter((s) => s.branch_id === b.id);
      const bh = inB.find((s) => s.level === 'branch_head');
      return `<div class="card"><div class="eyebrow">Branch</div><h2>${esc(b.name)}</h2>
        <div class="small" style="margin:4px 0 10px"><span class="muted">Branch Head:</span> ${bh ? esc(bh.name) : '<span class="muted">Not set</span>'} · ${plural(inB.length, 'person')}</div>
        ${S.meta.departments.map((dp) => {
          const ppl = inB.filter((s) => s.department === dp.key);
          const head = ppl.find((s) => s.level === 'head');
          const counts = S.meta.levels.filter((l) => l.rank <= 4).slice().reverse().map((l) => [l, ppl.filter((s) => s.level === l.key).length]).filter(([, n]) => n);
          return `<div class="wf-team"><b>${esc(dp.name)}</b> <span class="cap">${esc(dp.scope)}</span>
            <div class="wf-who">${head ? esc(head.name) : '<span class="muted">No head</span>'}${counts.length ? ' · ' + counts.map(([l, n]) => `${n} ${esc(l.name)}${n === 1 ? '' : 's'}`).join(', ') : ''}</div></div>`;
        }).join('')}</div>`;
    };
    const opt = (rows, sel, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${rows.map(([v, l]) => `<option value="${v}" ${String(v) === String(sel == null ? '' : sel) ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
    const page = shell('team', `
      <div class="page-head"><div><div class="eyebrow">Structure</div><h1>Firm structure</h1>
        <div class="muted" style="margin-top:6px">Managing Partner; a Branch Head for each branch; in each department a Department Head, Managers, Supervisors, Associates and Analysts. Each person reports to one person, and sees their own work and the work of everyone reporting to them.</div></div></div>
      <div id="tmsg"></div>
      <div class="card"><div class="card-head"><h3>Managing Partner</h3></div>${mp.length ? mp.map((s) => esc(s.name)).join(', ') : '<span class="muted">Not set. Choose the Managing Partner in the people list below.</span>'}</div>
      <div class="wf-org section">${S.meta.branches.map(branchCard).join('') || '<div class="card muted">No branches yet.</div>'}</div>
      ${can ? `<div class="card section"><div class="card-head"><h3>Add a branch</h3><span class="muted small">Each new city is set up the same way: structure, clients, reports</span></div>
        <form class="wf-form" id="brf"><div><label>Branch name</label><input name="name" required maxlength="60" placeholder="Kochi"></div><div><button class="btn small">Add branch</button></div></form></div>` : ''}
      <div class="card section"><div class="card-head"><h3>People</h3><span class="muted small">${can ? 'Place each Assura team login. New logins are added under Clients & users in the portal.' : ''}</span></div>
        <div class="table-wrap"><table class="wf-table"><thead><tr><th>Name</th><th>Designation</th><th>Department</th><th>Branch</th><th>Reports to</th>${can ? '<th></th>' : ''}</tr></thead><tbody>
        ${d.staff.slice().sort((a, b) => rankOf(b.level) - rankOf(a.level) || a.name.localeCompare(b.name)).map((s) => can ? `<tr><td>${esc(s.name)}<div class="muted small">${esc(s.email)}${s.clients ? ` · ${plural(s.clients, 'client')}` : ''}</div></td>
            <td><select name="level">${opt(S.meta.levels.slice().reverse().map((l) => [l.key, l.name]), s.level, 'Not placed')}</select></td>
            <td><select name="department">${opt(S.meta.departments.map((dp) => [dp.key, dp.name]), s.department, '–')}</select></td>
            <td><select name="branch_id">${opt(S.meta.branches.map((b) => [b.id, b.name]), s.branch_id, '–')}</select></td>
            <td><select name="reports_to">${opt(placed.filter((x) => x.id !== s.id).map((x) => [x.id, x.name]), s.reports_to, '–')}</select></td>
            <td><button class="btn secondary small" data-save="${s.id}">Save</button></td></tr>`
          : `<tr><td>${esc(s.name)}${s.clients ? `<div class="muted small">${plural(s.clients, 'client')}</div>` : ''}</td><td>${s.level ? esc(levelName(s.level)) : '<span class="muted">Not placed</span>'}</td><td>${s.department ? esc(S.depts[s.department].name) : '–'}</td><td>${esc(branchName(s.branch_id) || '–')}</td><td>${esc(nameOf(s.reports_to) || '–')}</td></tr>`).join('')}
        </tbody></table></div></div>`, { period: false });
    const msg = (err) => { errBox(page.querySelector('#tmsg'), err); window.scrollTo(0, 0); };
    page.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
      const tr = b.closest('tr'); const v = (n) => tr.querySelector(`[name=${n}]`).value;
      try { await post('/api/wf/staff', { user_id: Number(b.dataset.save), level: v('level'), department: v('department'), branch_id: v('branch_id') || null, reports_to: v('reports_to') || null }); toast('Saved'); await loadMeta(); team(); }
      catch (err) { msg(err); }
    }));
    const bf = page.querySelector('#brf');
    if (bf) bf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/branch', Object.fromEntries(new FormData(bf))); toast('Branch added'); await loadMeta(); team(); } catch (err) { msg(err); }
    });
  }

  boot();
})();
