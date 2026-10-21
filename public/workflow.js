/* Assura Elevate internal workflow: front end. Team logins only; the server refuses client logins. */
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
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const LOGO = `<img class="logo-on-light" src="${window.AE_LOGO || '/brand/assura-elevate-logo.png'}" alt="Assura Elevate"><img class="logo-on-dark" src="${window.AE_LOGO_ON_DARK || '/brand/assura-elevate-logo-on-dark.png'}" alt="Assura Elevate">`;
  const BACK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M10.7 2.3 5 8l5.7 5.7 1.1-1.1L7.2 8l4.6-4.6z"/></svg>';

  const S = { meta: null, period: null, depts: {}, levels: {}, stages: {} };

  // ---------- routing: every screen has its own address, so the phone's back button works ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '') || 'home';
    const [path, qs] = h.split('?');
    const parts = path.split('/');
    return { view: parts[0], id: parts[1], q: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };
  // Back within the workflow when we came from another screen here, otherwise to a sensible parent.
  let moved = false;
  window.addEventListener('hashchange', () => { moved = true; route(); });
  function back(fallback) { if (moved) history.back(); else go(fallback); }
  const backBtn = (fallback, label) => `<button class="wf-back" data-back="${esc(fallback)}">${BACK_ICON}${esc(label || 'Back')}</button>`;

  function toast(text) {
    const t = document.createElement('div'); t.className = 'wf-toast'; t.textContent = text;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
  }

  // ---------- boot ----------
  async function boot() {
    if (demo && demo.ready) await demo.ready;
    if (demo && !demo.user) { pickDemoUser(); return; }
    try {
      S.meta = await get('/api/wf/me');
    } catch (e) {
      if (e.status === 401 || e.status === 403) { signedOut(e); return; }
      fatal(e); return;
    }
    S.depts = Object.fromEntries(S.meta.departments.map((d) => [d.key, d]));
    S.levels = Object.fromEntries(S.meta.levels.map((l) => [l.key, l]));
    S.stages = Object.fromEntries(S.meta.stages.map((s) => [s.key, s]));
    S.period = S.period || S.meta.period;
    route();
  }

  function signedOut(e) {
    root.innerHTML = `<main><div class="card empty"><div class="eyebrow">Assura Elevate team</div><h2>${e.status === 401 ? 'Please sign in' : 'This area is for the Assura Elevate team'}</h2>
      <p>${esc(e.status === 401 ? 'Sign in with your team login, then come back to Workflow.' : e.message)}</p><a class="btn" href="/">Go to sign in</a></div></main>`;
  }
  function fatal(e) {
    root.innerHTML = `<main><div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" id="reload">Reload</button></div></main>`;
    root.querySelector('#reload').addEventListener('click', () => location.reload());
  }

  function pickDemoUser() {
    root.innerHTML = `<main><div class="card"><div class="eyebrow">Workflow preview</div><h1>Choose who to sign in as</h1>
      <p class="muted">Each login sees the workflow from its own seat. Clients and figures are fictional.</p>
      <div class="wf-pick">${demo.logins.map((l) => `<button data-u="${l.id}"><b>${esc(l.name)}</b><small>${esc(l.note)}</small></button>`).join('')}</div></div></main>`;
    root.querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', () => { demo.signIn(Number(b.dataset.u)); S.meta = null; S.period = null; location.hash = '#/home'; boot(); }));
  }

  // ---------- shell ----------
  const NAV = [['home', 'Home'], ['tasks', 'Tasks'], ['clients', 'Clients'], ['performance', 'Timeliness'], ['team', 'Team']];
  function seat(me) {
    if (me.level === 'md') return 'Managing Director';
    if (me.level) return `${S.levels[me.level].name} · ${S.depts[me.department].name}`;
    return me.admin ? 'Admin' : 'Not placed in a team yet';
  }
  const ICON = {
    home: 'M3 9l7-6 7 6v8h-5v-5H8v5H3z',
    tasks: 'M7 5h10M7 10h10M7 15h10M3 5h1M3 10h1M3 15h1',
    clients: 'M3 17V5l7-2v14M10 7h7v10M6 8h1M6 11h1M6 14h1M13 10h1M13 13h1',
    performance: 'M10 18a7 7 0 100-14 7 7 0 000 14zM10 7v4l3 2M8 2h4',
    team: 'M7 9a3 3 0 100-6 3 3 0 000 6zM2 17c0-3 2-5 5-5s5 2 5 5M14 9a2.5 2.5 0 100-5M15 12c2 .5 3 2 3 5',
    portal: 'M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z',
  };
  const icon = (k) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${ICON[k]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Same layout as the client portal: side menu on wide screens, a menu button on phones.
  function shell(view, inner, { period = true } = {}) {
    const m = S.meta; const me = m.me;
    const periods = Array.from(new Set([S.period].concat(m.periods))).sort().reverse();
    const nav = NAV.filter(([k]) => k !== 'team' || m.can.structure || me.level);
    const current = (nav.find(([k]) => k === view) || [])[1] || '';
    root.innerHTML = `
      <div class="shell">
        <aside class="side" aria-label="Main menu">
          <div class="side-top"><a class="wordmark" href="#/home" aria-label="Assura Elevate, workflow home">${LOGO}</a></div>
          ${period ? `<div class="side-client"><label for="period">Month under review</label><select id="period">${periods.map((p) => `<option value="${p}" ${p === S.period ? 'selected' : ''}>${mLong(p)}</option>`).join('')}</select></div>` : ''}
          <nav class="side-nav" aria-label="Sections">
            <div class="nav-group">Workflow</div>
            ${nav.map(([k, l]) => `<a class="nav-item" href="#/${k}" ${view === k ? 'aria-current="page"' : ''}>${icon(k)}<span>${l}</span></a>`).join('')}
            ${demo ? '' : `<div class="nav-group">Assura workspace</div><a class="nav-item" href="/">${icon('portal')}<span>Client portal</span></a>`}
          </nav>
          <div class="side-foot"><div class="who"><b>${esc(me.name)}</b><span>${esc(seat(me))}</span></div></div>
        </aside>
        <div class="scrim" id="scrim"></div>
        <div class="main-col">
          <header class="mbar">
            <button class="menu-btn" id="menu" aria-label="Open the menu" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
            <span class="wordmark">${LOGO}</span><span class="mbar-tab">${esc(current || 'Workflow')}</span>
          </header>
          ${demo ? `<div class="wf-demo">Preview with fictional clients. Signed in as ${esc(me.name)}. <button id="switch">Switch person</button></div>` : ''}
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
    const sw = root.querySelector('#switch');
    if (sw) sw.addEventListener('click', () => { demo.signOut(); location.hash = ''; boot(); });
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => back(b.dataset.back)));
    return root.querySelector('#page');
  }

  async function route() {
    if (!S.meta) return;
    const r = parseHash();
    const views = { home, tasks, task, clients, client, performance, team };
    const fn = views[r.view] || home;
    try { await fn(r); } catch (e) {
      shell(r.view, `${backBtn('#/home')}<div class="card empty"><h2>${e.status === 403 ? 'Not available to you' : 'Something went wrong'}</h2><p>${esc(e.message)}</p></div>`);
    }
    window.scrollTo(0, 0);
  }

  // ---------- small parts ----------
  function dueText(t) {
    if (t.stage === 'done') return t.timeliness === 'late' ? `<b>${plural(t.days_late, 'day')} late</b>Completed ${dShort(t.completed_on)}` : `<b>On time</b>Completed ${dShort(t.completed_on)}`;
    if (t.timeliness === 'delayed') return `<b>${plural(t.days_late, 'day')} late</b>Target ${dShort(t.due_date)}`;
    if (t.timeliness === 'behind') return `<b>Behind</b>${esc(t.stage_name)} was due ${dShort(t.stage_target)}`;
    return `<b>${t.days_left === 0 ? 'Due today' : `Due in ${plural(t.days_left, 'day')}`}</b>Target ${dShort(t.due_date)}`;
  }
  function taskRow(t, { showCompany = true } = {}) {
    return `<a class="wf-row t-${t.timeliness}" href="#/task/${t.id}">
      <div>${showCompany ? `<div class="co">${esc(t.company_name)}</div>` : ''}<div class="ti">${esc(t.title)}</div>
        <div class="meta"><span class="wf-pill dept">${esc(S.depts[t.department].short)}</span>
          <span class="wf-pill stage ${t.stage === 'done' ? 'done' : ''}">${esc(t.stage_name)}</span>
          ${t.my_turn ? '<span class="wf-pill turn">Your turn</span>' : ''}
          ${t.open_flags ? `<span class="wf-pill flag">Flagged</span>` : ''}</div></div>
      <div class="due">${dueText(t)}</div></a>`;
  }
  const list = (rows, empty, opts) => (rows.length ? `<div class="wf-list">${rows.map((t) => taskRow(t, opts)).join('')}</div>` : `<p class="muted">${esc(empty)}</p>`);
  const stat = (n, label, cls, href) => `<a class="wf-stat ${n ? cls : ''}" href="${href}" style="text-decoration:none"><div class="n">${n == null ? '–' : n}</div><div class="l">${esc(label)}</div></a>`;
  function bar(s) {
    if (!s.total) return '<div class="wf-bar"></div>';
    return `<div class="wf-bar" title="${s.done} of ${s.total} complete"><span class="d" style="width:${(s.done / s.total) * 100}%"></span><span class="x" style="width:${(s.delayed / s.total) * 100}%"></span></div>`;
  }

  // ---------- Home ----------
  async function home() {
    const h = await get(`/api/wf/home?period=${S.period}`);
    const me = S.meta.me;
    const hour = +new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const m = h.month;
    const placed = me.level || me.admin;
    const page = shell('home', `
      <div class="page-head"><div><div class="eyebrow">${esc(seat(me))}</div><h1>${greet}, ${esc(me.name)}.</h1>
        <div class="muted" style="margin-top:6px">Reviewing ${mLong(h.period)} · today is ${dLong(S.meta.today)}</div></div></div>
      ${placed ? '' : '<div class="msg err">Your login has no place in the team structure yet. Ask the MD or an admin to add you under Team.</div>'}
      <div class="wf-stats">
        ${stat(h.mine.length, 'Waiting on you', 'warn', '#/tasks?status=mine')}
        ${stat(h.delayed.length, 'Past target date', 'alert', '#/tasks?status=delayed')}
        ${stat(h.behind.length, 'Behind a step target', 'warn', '#/tasks?status=delayed')}
        ${stat(h.flags.length, 'Open flags for the MD', 'alert', '#/tasks?status=flagged')}
        ${stat(m.on_time_rate == null ? null : m.on_time_rate + '%', `Completed on time in ${MONTHS[+h.period.slice(5) - 1]}`, 'good', '#/performance')}
      </div>
      <div class="grid g-main section">
        <div class="card"><div class="card-head"><h3>Waiting on you</h3><span class="muted small">Earliest target first</span></div>
          ${list(h.mine, me.level ? 'Nothing is waiting on you. Well done.' : 'Tasks appear here once you are placed in a team.')}</div>
        <div class="card"><div class="card-head"><h3>${me.level === 'md' ? 'Flags for your decision' : 'Open flags'}</h3></div>
          ${h.flags.length ? h.flags.map((f) => `<a class="wf-row" href="#/task/${f.task_id}"><div><div class="co">${esc(f.company_name)}</div><div class="ti">${esc(f.reason)}</div>
            <div class="meta"><span class="wf-pill dept">${esc(S.depts[f.department].short)}</span><span class="muted small">Raised by ${esc(f.raised_by_name)} · ${stamp(f.raised_at)}</span></div></div></a>`).join('') : '<p class="muted">No open flags.</p>'}</div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="card-head"><h3>Past target date</h3><span class="muted small">Most overdue first</span></div>${list(h.delayed.slice(0, 12), 'Nothing is past its target date.')}</div>
        <div class="card"><div class="card-head"><h3>${mLong(h.period)} by department</h3><span class="muted small">${m.done} of ${m.total} complete</span></div>
          ${h.byDepartment.length ? `<div class="wf-depts">${h.byDepartment.map((d) => `<a class="wf-dept" href="#/tasks?department=${d.key}" style="text-decoration:none;color:inherit">
            <h4>${esc(d.name)}</h4><div class="big">${d.done}<span class="muted" style="font-size:18px"> / ${d.total}</span></div>${bar(d)}
            <div class="small muted" style="margin-top:6px">${d.delayed ? `<span style="color:var(--critical)">${d.delayed} late</span> · ` : ''}${d.on_time_rate == null ? 'None completed yet' : `${d.on_time_rate}% on time`}</div></a>`).join('')}</div>`
            : `<p class="muted">No tasks for ${mLong(h.period)} yet.${S.meta.can.allot ? ' Start the month under Clients.' : ''}</p>`}</div>
      </div>`);
    return page;
  }

  // ---------- Tasks ----------
  const STATUS = [['', 'All'], ['mine', 'Waiting on me'], ['open', 'Open'], ['delayed', 'Late or behind'], ['flagged', 'Flagged'], ['done', 'Completed']];
  async function tasks(r) {
    const f = Object.assign({ status: '', department: '' }, r.q);
    const qs = new URLSearchParams({ period: S.period, status: f.status, department: f.department }).toString();
    const { tasks: rows } = await get(`/api/wf/tasks?${qs}`);
    const link = (patch) => `#/tasks?${new URLSearchParams(Object.assign({}, f, patch)).toString()}`;
    const page = shell('tasks', `
      <div class="page-head"><div><div class="eyebrow">${mLong(S.period)}</div><h1>Tasks</h1></div>
        ${S.meta.can.create ? '<button class="btn secondary small" id="new">Add a task</button>' : ''}</div>
      <div id="newform"></div>
      <div class="wf-filters">${STATUS.map(([k, l]) => `<a class="wf-chip" href="${link({ status: k })}" aria-pressed="${f.status === k}" style="text-decoration:none">${l}</a>`).join('')}
        <select id="dept" aria-label="Department"><option value="">All departments</option>${S.meta.departments.map((d) => `<option value="${d.key}" ${f.department === d.key ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
      <div class="card">${list(rows, 'No tasks match.')}</div>`);
    page.querySelector('#dept').addEventListener('change', (e) => go(link({ department: e.target.value })));
    const nb = page.querySelector('#new');
    if (nb) nb.addEventListener('click', () => newTaskForm(page.querySelector('#newform')));
  }

  async function newTaskForm(el) {
    const me = S.meta.me;
    const { clients: cs } = await get(`/api/wf/clients?period=${S.period}`);
    const depts = me.level === 'md' || me.admin ? S.meta.departments : [S.depts[me.department]];
    el.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-head"><h3>Add a task</h3></div>
      <form class="wf-form" id="nt">
        <div><label>Client</label><select name="company_id" required>${cs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div><label>Department</label><select name="department">${depts.map((d) => `<option value="${d.key}">${esc(d.name)}</option>`).join('')}</select></div>
        <div style="grid-column:1/-1"><label>Task</label><input name="title" type="text" required maxlength="200" placeholder="For example: Reply to GST notice for FY 2024-25"></div>
        <div><label>Target date</label><input name="due_date" type="date" required></div>
        <div><button class="btn" type="submit">Add task</button></div>
      </form><div id="ntmsg"></div></div>`;
    el.querySelector('#nt').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target)); body.period = S.period;
      try { const r = await post('/api/wf/task', body); toast('Task added'); go(`#/task/${r.id}`); }
      catch (err) { el.querySelector('#ntmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  }

  // ---------- One task ----------
  const ACTION_LABEL = { create: 'Created', submit: 'Submitted for review', approve: 'Approved', return: 'Sent back', flag: 'Flagged for the MD', resolve: 'Flag resolved', reschedule: 'Target date changed', reopen: 'Reopened' };
  async function task(r) {
    const d = await get(`/api/wf/task?id=${encodeURIComponent(r.id)}`);
    const t = d.task;
    const idx = d.chain.findIndex((s) => s.key === t.stage);
    const today = S.meta.today;
    const chain = d.chain.map((s, i) => {
      const cls = t.stage === 'done' || i < idx ? 'past' : i === idx ? 'now' : '';
      const late = i === idx && today > s.target;
      return `<div class="wf-step ${cls} ${late ? 'late' : ''}"><b>${esc(s.name)}</b>${esc(s.who)}<br><span class="tg">by ${dShort(s.target)}</span></div>`;
    }).join('');
    const can = (a) => d.actions.includes(a);
    const actBox = [];
    if (can('submit') || can('approve')) {
      actBox.push(`<div class="wf-act"><label for="note">Note ${can('return') ? '(required to send back)' : '(optional)'}</label><textarea id="note" maxlength="1000" placeholder="${can('submit') ? 'What was done, and anything the reviewer should look at' : 'Review comments'}"></textarea>
        <div class="btn-row">${can('submit') ? '<button class="btn" data-act="submit">Submit for review</button>' : ''}
        ${can('approve') ? `<button class="btn" data-act="approve">${t.stage === 'signoff' ? 'Sign off for the department' : t.stage === 'md' ? 'Approve as MD' : 'Approve'}</button>` : ''}
        ${can('return') ? '<button class="btn secondary" data-act="return">Send back</button>' : ''}</div></div>`);
    } else if (t.stage !== 'done') {
      actBox.push(`<div class="wf-note">${esc(d.note || `Waiting on the ${t.waiting_on.toLowerCase()}${t.stage === 'md' ? '' : ' of this team'}.`)}</div>`);
    } else actBox.push(`<div class="msg ok" style="margin-top:0">Completed ${dLong(t.completed_on)}${t.timeliness === 'late' ? `, ${plural(t.days_late, 'day')} after the target date` : ', on time'}.</div>`);

    const flags = d.flags.map((f) => `<div class="wf-flag ${f.status}"><div>${esc(f.reason)}</div>
      <div class="who">Raised by ${esc(f.raised_by_name)} · ${stamp(f.raised_at)}</div>
      ${f.status === 'resolved' ? `<div style="margin-top:6px"><b>Decision:</b> ${esc(f.resolution)}</div><div class="who">${esc(f.resolved_by_name || '')} · ${stamp(f.resolved_at)}</div>`
        : can('resolve') ? `<form class="wf-act" data-resolve="${f.id}" style="margin-top:8px"><textarea required placeholder="Your decision"></textarea><div><button class="btn small">Record decision</button></div></form>` : ''}</div>`).join('');

    const page = shell('task', `
      ${backBtn('#/tasks', 'Back')}
      <div class="page-head"><div><div class="eyebrow">${esc(S.depts[t.department].name)} · ${mLong(t.period)}</div><h1>${esc(t.company_name)}</h1>
        <div style="margin-top:6px;font-size:16px">${esc(t.title)}</div>
        <div class="meta" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><span class="wf-pill stage ${t.stage === 'done' ? 'done' : ''}">${esc(t.stage_name)}</span>
          ${t.open_flags ? '<span class="wf-pill flag">Flagged for the MD</span>' : ''}<span class="wf-pill t-${t.timeliness}">${dueText(t).replace('<b>', '').replace('</b>', ' · ')}</span></div></div></div>
      <div class="grid g-main">
        <div>
          <div class="card"><div class="card-head"><h3>Approval chain</h3><span class="muted small">Target date ${dLong(t.due_date)}</span></div>
            <div class="wf-chain">${chain}</div></div>
          <div class="card section"><div class="card-head"><h3>History</h3></div>
            <ul class="wf-history">${d.events.slice().reverse().map((e) => `<li class="${e.action}"><span class="when">${stamp(e.at)}</span>
              <div><b>${esc(ACTION_LABEL[e.action] || e.action)}</b> · ${esc(e.user_name || '')}${e.to_stage && e.to_stage !== e.from_stage && e.action !== 'create' ? ` <span class="muted">→ ${esc(S.stages[e.to_stage].name)}</span>` : ''}
              ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</div></li>`).join('')}</ul></div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>${t.stage === 'done' ? 'Status' : 'Next step'}</h3></div>${actBox.join('')}<div id="actmsg"></div></div>
          <div class="card section"><div class="card-head"><h3>Team</h3></div>
            <div class="small" style="display:grid;gap:4px">
              <div><span class="muted">Director:</span> ${esc(d.director || 'Not set')}</div>
              ${d.team ? `<div><span class="muted">Manager:</span> ${esc(d.team.manager || 'Not set')}</div><div><span class="muted">Senior Analyst:</span> ${esc(d.team.senior || 'Not set')}</div><div><span class="muted">Analyst:</span> ${esc(d.team.analyst || 'Not set')}</div><div class="muted">${esc(d.team.name)}</div>` : ''}
              <a href="#/client/${t.company_id}" style="margin-top:6px">All work for this client ›</a></div></div>
          <div class="card section"><div class="card-head"><h3>Flags</h3></div>${flags || '<p class="muted small" style="margin:0 0 10px">Anything that needs a decision from the top: raise a flag and the task goes to the MD before it can close.</p>'}
            ${can('flag') ? `<form class="wf-act" id="flagf"><textarea required minlength="5" placeholder="What is the issue and what decision is needed?"></textarea><div><button class="btn secondary small">Flag for the MD</button></div></form>` : ''}</div>
          ${can('reschedule') ? `<div class="card section"><div class="card-head"><h3>Target date</h3></div><form class="wf-form" id="resch">
            <div><label>New target date</label><input type="date" name="due_date" value="${t.due_date}" required></div>
            <div style="grid-column:1/-1"><label>Reason</label><input type="text" name="note" required maxlength="300"></div><div><button class="btn secondary small">Change date</button></div></form></div>` : ''}
          ${can('reopen') ? `<div class="card section"><form class="wf-act" id="reopen"><label>Reopen completed work</label><textarea required placeholder="Why it needs another look"></textarea><div><button class="btn secondary small">Reopen</button></div></form></div>` : ''}
        </div>
      </div>`, { period: false });

    const msg = (err) => { page.querySelector('#actmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; };
    page.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const out = await post('/api/wf/task/action', { id: t.id, action: b.dataset.act, note: page.querySelector('#note').value });
        toast(out.stage === 'done' ? 'Completed' : b.dataset.act === 'return' ? 'Sent back to preparation' : `Moved to ${S.stages[out.stage].name}`);
        task(r);
      } catch (err) { b.disabled = false; msg(err); }
    }));
    const wire = (sel, fn) => { const f = page.querySelector(sel); if (f) f.addEventListener('submit', async (e) => { e.preventDefault(); try { await fn(e.target); task(r); } catch (err) { msg(err); } }); };
    wire('#flagf', (f) => post('/api/wf/task/flag', { id: t.id, reason: f.querySelector('textarea').value }).then(() => toast('Flagged for the MD')));
    wire('#resch', (f) => post('/api/wf/task/reschedule', Object.assign({ id: t.id }, Object.fromEntries(new FormData(f)))).then(() => toast('Target date changed')));
    wire('#reopen', (f) => post('/api/wf/task/action', { id: t.id, action: 'reopen', note: f.querySelector('textarea').value }).then(() => toast('Reopened')));
    page.querySelectorAll('[data-resolve]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/flag/resolve', { flag_id: Number(f.dataset.resolve), resolution: f.querySelector('textarea').value }); toast('Decision recorded'); task(r); } catch (err) { msg(err); }
    }));
  }

  // ---------- Clients ----------
  async function clients() {
    const d = await get(`/api/wf/clients?period=${S.period}`);
    const can = S.meta.can;
    const deptsCells = (c) => S.meta.departments.map((dp) => {
      const x = c.depts[dp.key];
      if (!x) return `<td class="cell" data-label="${esc(dp.short)}"><span class="muted small">Not allotted</span></td>`;
      return `<td class="cell" data-label="${esc(dp.short)}"><div class="wf-cell">
        <span>${x.signed_off ? '<span class="wf-tick">✓ Signed off</span>' : x.tasks ? `${x.done} / ${x.tasks}${x.delayed ? ` <span style="color:var(--critical);font-size:12px">· ${x.delayed} late</span>` : ''}${x.flagged ? ' <span class="wf-pill flag">Flag</span>' : ''}` : '<span class="muted small">Not started</span>'}</span>
        ${bar({ total: x.tasks, done: x.done, delayed: x.delayed })}<span class="tn">${esc(x.team_name)} · target ${dShort(x.due)}</span></div></td>`;
    }).join('');
    const done = d.clients.filter((c) => c.complete).length;
    const page = shell('clients', `
      <div class="page-head"><div><div class="eyebrow">${mLong(d.period)}</div><h1>Clients</h1>
        <div class="muted" style="margin-top:6px">${done} of ${d.clients.length} clients signed off by every department</div></div>
        ${can.allot ? `<form id="cycle" class="btn-row" style="align-items:end"><div><label for="cp">Start the monthly review for</label><input id="cp" type="month" value="${d.period}" required style="width:auto"></div><button class="btn">Start the month</button></form>` : ''}</div>
      <div id="cmsg"></div>
      <div class="card"><div class="table-wrap"><table class="wf-matrix"><thead><tr><th>Client</th>${S.meta.departments.map((dp) => `<th>${esc(dp.name)}</th>`).join('')}<th>Month</th></tr></thead><tbody>
        ${d.clients.map((c) => `<tr><td class="name"><a href="#/client/${c.id}">${esc(c.name)}</a><div class="muted small">${esc(c.code)}</div></td>${deptsCells(c)}
          <td class="state">${c.complete ? '<span class="wf-tick">✓ Complete</span>' : '<span class="muted small">In progress</span>'}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">No clients to show.</td></tr>`}
      </tbody></table></div></div>`);
    const cf = page.querySelector('#cycle');
    if (cf) cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const out = await post('/api/wf/cycle', { period: page.querySelector('#cp').value });
        S.meta = await get('/api/wf/me'); S.period = out.period;
        toast(out.created ? `${plural(out.created, 'task')} created for ${mLong(out.period)}` : `Every allotted client already has its ${mLong(out.period)} tasks`);
        clients();
      } catch (err) { page.querySelector('#cmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  }

  async function client(r) {
    const [d, tl] = await Promise.all([get(`/api/wf/clients?period=${S.period}`), get(`/api/wf/tasks?period=${S.period}&company=${encodeURIComponent(r.id)}`)]);
    const c = d.clients.find((x) => String(x.id) === String(r.id));
    if (!c) throw Object.assign(new Error('This client is not served by your team.'), { status: 403 });
    const me = S.meta.me;
    const mayAllot = (dk) => me.admin || me.level === 'md' || (me.level === 'director' && me.department === dk);
    const page = shell('client', `
      ${backBtn('#/clients', 'Clients')}
      <div class="page-head"><div><div class="eyebrow">${esc(c.code)} · ${mLong(d.period)}</div><h1>${esc(c.name)}</h1>
        <div class="muted" style="margin-top:6px">${c.complete ? 'Signed off by every department for this month.' : 'Each department signs off its own work. The month is complete when all have.'}</div></div></div>
      <div class="wf-depts">${S.meta.departments.map((dp) => {
        const x = c.depts[dp.key];
        const teams = d.teams.filter((t) => t.department === dp.key);
        return `<div class="wf-dept"><h4>${esc(dp.name)}</h4><div class="muted small">${esc(dp.scope)}</div>
          ${x ? `<div class="big">${x.signed_off ? '<span class="wf-tick" style="font-size:20px">✓ Signed off</span>' : `${x.done}<span class="muted" style="font-size:18px"> / ${x.tasks}</span>`}</div>${bar({ total: x.tasks, done: x.done, delayed: x.delayed })}
            <div class="small" style="margin-top:6px">${esc(x.team_name)} · target day ${x.target_day} (${dShort(x.due)})</div>` : '<p class="muted small">No team allotted.</p>'}
          ${mayAllot(dp.key) ? `<details style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--link)">${x ? 'Change team or target day' : 'Allot a team'}</summary>
            <form class="wf-form" data-allot="${dp.key}" style="margin-top:8px">
              <div><label>Team</label><select name="team_id" required>${teams.map((t) => `<option value="${t.id}" ${x && x.team_id === t.id ? 'selected' : ''}>${esc(t.name)} (${t.clients}/${t.capacity})</option>`).join('')}</select></div>
              <div><label>Target day of month</label><input type="number" name="target_day" min="1" max="31" value="${x ? x.target_day : 20}" required></div>
              <div><button class="btn small">Save</button></div></form></details>` : ''}</div>`;
      }).join('')}</div>
      <div id="amsg"></div>
      <div class="card section"><div class="card-head"><h3>Work for ${mLong(d.period)}</h3></div>${list(tl.tasks, 'No tasks for this month yet.', { showCompany: false })}</div>`);
    page.querySelectorAll('[data-allot]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await post('/api/wf/allot', Object.assign({ company_id: c.id, department: f.dataset.allot }, Object.fromEntries(new FormData(f)))); toast('Saved'); client(r); }
      catch (err) { page.querySelector('#amsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    }));
  }

  // ---------- Timeliness ----------
  async function performance() {
    const d = await get(`/api/wf/performance?period=${S.period}`);
    const o = d.overall;
    const rate = (x) => (x.on_time_rate == null ? '–' : `${x.on_time_rate}%`);
    const row = (name, x, extra) => `<tr><td>${name}</td><td class="r">${x.total}</td><td class="r">${x.done}</td><td class="r">${x.on_time}</td><td class="r" style="${x.late ? 'color:var(--critical)' : ''}">${x.late}</td><td class="r" style="${x.delayed ? 'color:var(--critical)' : ''}">${x.delayed}</td><td class="r"><b>${rate(x)}</b></td>${extra || ''}</tr>`;
    const head = (extra) => `<thead><tr><th></th><th class="r">Tasks</th><th class="r">Completed</th><th class="r">On time</th><th class="r">Late</th><th class="r">Open past target</th><th class="r">On-time rate</th>${extra || ''}</tr></thead>`;
    shell('performance', `
      <div class="page-head"><div><div class="eyebrow">${mLong(d.period)}</div><h1>Timeliness</h1>
        <div class="muted" style="margin-top:6px">Each task has a target date per client. Every step in the chain has its own target ahead of it, so slippage shows early.</div></div></div>
      <div class="wf-stats">
        ${stat(o.total, 'Tasks this month', '', '#/tasks')}
        ${stat(o.done, 'Completed', 'good', '#/tasks?status=done')}
        ${stat(o.delayed, 'Open past target', 'alert', '#/tasks?status=delayed')}
        ${stat(o.late, 'Completed late', 'warn', '#/tasks?status=done')}
        ${stat(o.on_time_rate == null ? null : o.on_time_rate + '%', 'On-time rate', 'good', '#/performance')}
      </div>
      <div class="card section"><div class="card-head"><h3>By department</h3></div><div class="table-wrap"><table>${head()}<tbody>${d.byDepartment.map((x) => row(esc(x.name), x)).join('')}</tbody></table></div></div>
      <div class="card section"><div class="card-head"><h3>By team</h3><span class="muted small">Clients served against capacity</span></div><div class="table-wrap"><table>${head('<th class="r">Clients</th>')}<tbody>
        ${d.byTeam.map((x) => row(`${esc(x.name)}<div class="muted small">${esc(S.depts[x.department].short)}${x.manager_name ? ' · ' + esc(x.manager_name) : ''}</div>`, x, `<td class="r">${x.clients} / ${x.capacity}</td>`)).join('')}</tbody></table></div></div>
      <div class="card section"><div class="card-head"><h3>By person</h3><span class="muted small">Steps moved forward this month, and how many met their step target</span></div><div class="table-wrap"><table>
        <thead><tr><th></th><th class="r">Steps completed</th><th class="r">On step target</th><th class="r">Sent back</th></tr></thead><tbody>
        ${d.people.map((p) => `<tr><td>${esc(p.name)}</td><td class="r">${p.actions}</td><td class="r">${p.actions ? Math.round((p.on_target / p.actions) * 100) + '%' : '–'}</td><td class="r">${p.returns}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody></table></div></div>`);
  }

  // ---------- Team structure ----------
  async function team() {
    const d = await get('/api/wf/structure');
    const can = S.meta.can.structure;
    const byDept = (k) => d.teams.filter((t) => t.department === k);
    const person = (id) => d.staff.find((s) => s.id === id);
    const md = d.staff.filter((s) => s.level === 'md');
    const opts = (dept, level, sel) => `<option value="">Not set</option>${d.staff.filter((s) => s.level === level && s.department === dept).map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
    const teamForm = (dk, t) => `<form class="wf-form" data-team="${dk}" ${t ? `data-id="${t.id}"` : ''} style="margin-top:8px">
      <div><label>Team name</label><input name="name" type="text" value="${esc(t ? t.name : '')}" required maxlength="60"></div>
      <div><label>Manager</label><select name="manager_id">${opts(dk, 'manager', t && t.manager_id)}</select></div>
      <div><label>Senior Analyst</label><select name="senior_id">${opts(dk, 'senior', t && t.senior_id)}</select></div>
      <div><label>Analyst</label><select name="analyst_id">${opts(dk, 'analyst', t && t.analyst_id)}</select></div>
      <div><label>Client capacity</label><input name="capacity" type="number" min="1" max="200" value="${t ? t.capacity : 30}"></div>
      <div><button class="btn small">${t ? 'Save team' : 'Add team'}</button></div></form>`;
    const page = shell('team', `
      <div class="page-head"><div><div class="eyebrow">Structure</div><h1>Team</h1>
        <div class="muted" style="margin-top:6px">Managing Director, a Director heading each department, Managers, Senior Analysts and Analysts. Each team serves up to its capacity of clients in one department.</div></div></div>
      <div id="tmsg"></div>
      <div class="card"><div class="card-head"><h3>Managing Director</h3></div>${md.length ? md.map((s) => esc(s.name)).join(', ') : '<span class="muted">Not set. Choose the MD in the people list below.</span>'}</div>
      <div class="wf-org section">${S.meta.departments.map((dp) => {
        const dir = d.staff.find((s) => s.level === 'director' && s.department === dp.key);
        const people = d.staff.filter((s) => s.department === dp.key);
        return `<div class="card"><div class="eyebrow">${esc(dp.short)}</div><h2>${esc(dp.name)}</h2><div class="muted small" style="margin:4px 0 10px">${esc(dp.scope)}</div>
          <div class="small"><span class="muted">Director:</span> ${dir ? esc(dir.name) : '<span class="muted">Not set</span>'}</div>
          <div class="small muted" style="margin-bottom:6px">${['manager', 'senior', 'analyst'].map((l) => `${people.filter((p) => p.level === l).length} ${S.levels[l].name}${people.filter((p) => p.level === l).length === 1 ? '' : 's'}`).join(' · ')}</div>
          ${byDept(dp.key).map((t) => `<div class="wf-team"><b>${esc(t.name)}</b> <span class="cap">${t.clients} / ${t.capacity} clients</span>
            <div class="wf-who">${['manager_id', 'senior_id', 'analyst_id'].map((k) => (person(t[k]) ? esc(person(t[k]).name) : '<span class="muted">vacant</span>')).join(' · ')}</div>
            ${can ? `<details><summary class="small" style="cursor:pointer;color:var(--link)">Edit</summary>${teamForm(dp.key, t)}</details>` : ''}</div>`).join('') || '<p class="muted small">No teams yet.</p>'}
          ${can ? `<details class="wf-team"><summary class="small" style="cursor:pointer;color:var(--link)">Add a team</summary>${teamForm(dp.key, null)}</details>` : ''}</div>`;
      }).join('')}</div>
      <div class="card section"><div class="card-head"><h3>People</h3><span class="muted small">${can ? 'Place each Assura team login in the structure. New logins are added under Clients & users in the portal.' : ''}</span></div>
        <div class="table-wrap"><table class="wf-table"><thead><tr><th>Name</th><th>Level</th><th>Department</th>${can ? '<th></th>' : ''}</tr></thead><tbody>
        ${d.staff.map((s) => can ? `<tr data-staff="${s.id}"><td>${esc(s.name)}<div class="muted small">${esc(s.email)}</div></td>
            <td><select name="level"><option value="">Not placed</option>${S.meta.levels.slice().reverse().map((l) => `<option value="${l.key}" ${s.level === l.key ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></td>
            <td><select name="department"><option value="">–</option>${S.meta.departments.map((dp) => `<option value="${dp.key}" ${s.department === dp.key ? 'selected' : ''}>${esc(dp.name)}</option>`).join('')}</select></td>
            <td><button class="btn secondary small" data-save="${s.id}">Save</button></td></tr>`
          : `<tr><td>${esc(s.name)}</td><td>${s.level ? esc(S.levels[s.level].name) : '<span class="muted">Not placed</span>'}</td><td>${s.department ? esc(S.depts[s.department].name) : '–'}</td></tr>`).join('')}
        </tbody></table></div></div>`, { period: false });
    const msg = (err) => { page.querySelector('#tmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; window.scrollTo(0, 0); };
    page.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      try { await post('/api/wf/staff', { user_id: Number(b.dataset.save), level: tr.querySelector('[name=level]').value, department: tr.querySelector('[name=department]').value }); toast('Saved'); S.meta = await get('/api/wf/me'); team(); }
      catch (err) { msg(err); }
    }));
    page.querySelectorAll('[data-team]').forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f)); body.department = f.dataset.team; if (f.dataset.id) body.id = Number(f.dataset.id);
      try { await post('/api/wf/team', body); toast('Team saved'); team(); } catch (err) { msg(err); }
    }));
  }

  boot();
})();
