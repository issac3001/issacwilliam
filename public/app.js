/* Assura Elevate client platform: single-page front end. */
(function () {
  'use strict';
  const { inr, pctTxt } = window.AEAnalysis;
  const C = window.AECharts;

  // ---------- API (real server, or the in-browser demo when AE_DEMO_API is present) ----------
  const api = window.AE_DEMO_API || {
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
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body || {}); },
  };

  const state = { me: null, companies: [], companyId: null, clientOpen: false, dash: null, tab: 'overview', showAllHighlights: false, upload: null, monthCache: {} };
  // Assura team and admins work across every client; client logins are view only.
  const isStaff = (u) => !!u && (u.role === 'team' || u.role === 'admin');
  const app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const mShort = (p) => `${MONTHS[+p.slice(5, 7) - 1]} ${p.slice(2, 4)}`;
  // Axis labels: month only, with the year on the first month and each January.
  const mAxis = (ps) => ps.map((p, i) => (i === 0 || p.slice(5, 7) === '01' ? `${MONTHS[+p.slice(5, 7) - 1]} ’${p.slice(2, 4)}` : MONTHS[+p.slice(5, 7) - 1]));
  const mLong = (p) => `${FULL_MONTHS[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
  const dLong = (iso) => iso ? `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : '–';
  const axisInr = (v) => { const a = Math.abs(v); return a >= 1e7 ? `${(v / 1e7).toFixed(1)} Cr` : a >= 1e5 ? `${(v / 1e5).toFixed(0)} L` : Math.round(v).toLocaleString('en-IN'); };
  // Upload times are stored in UTC; show them in Indian Standard Time.
  const stamp = (t) => {
    const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(t) ? t : String(t).replace(' ', 'T') + 'Z');
    return isNaN(d) ? String(t) : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const days = (v) => (v == null ? '–' : `${v} days`);

  const ICONS = {
    critical: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 1h6l4 4v6l-4 4H5l-4-4V5zM7.2 4v5h1.6V4zm0 6.4V12h1.6v-1.6z"/></svg>',
    watch: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1l7.5 13h-15zM7.2 6v4h1.6V6zm0 5v1.6h1.6V11z"/></svg>',
    positive: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.3 4.8L7 9.1 4.9 7 3.8 8.1 7 11.3l5.4-5.4z"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0a8 8 0 110 16A8 8 0 018 0zM7.2 7v5h1.6V7zm0-3v1.6h1.6V4z"/></svg>',
  };
  const SEV_LABEL = { critical: 'Act now', watch: 'Watch', positive: 'Positive', info: 'For information' };
  const chip = (sev, text) => `<span class="chip ${sev}">${ICONS[sev]}${esc(text || SEV_LABEL[sev])}</span>`;
  const STATE_CHIP = {
    done: ['positive', 'Filed / paid'], overdue: ['critical', 'Overdue'], 'due-soon': ['watch', 'Due soon'],
    pending: ['info', 'Upcoming'], na: ['info', 'Not applicable'],
  };
  const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)'];

  // Beige panels carry the dark logo; dark mode swaps in the light-on-dark cut (see .logo-on-dark in the CSS).
  const LOGO = `<img class="logo-on-light" src="${window.AE_LOGO || '/brand/assura-elevate-logo.png'}" alt="Assura Elevate"><img class="logo-on-dark" src="${window.AE_LOGO_ON_DARK || '/brand/assura-elevate-logo-on-dark.png'}" alt="Assura Elevate">`;

  // ---------- click-through details and the data editor ----------
  const ctx = {
    esc, inr, pctTxt, mLong, mShort, dLong, api,
    companyId: () => state.companyId,
    company: () => state.companies.find((c) => c.id === state.companyId),
    periods: () => (state.dash && state.dash.periods) || [],
    metrics: (p) => state.dash && state.dash.analysis.months.find((m) => m.period === p),
    latest: () => state.dash && state.dash.analysis.latest,
    latestPeriod: () => { const ps = (state.dash && state.dash.periods) || []; return ps[ps.length - 1]; },
    month(p) {
      const key = `${state.companyId}|${p}`;
      if (!state.monthCache[key]) state.monthCache[key] = api.get(`/api/data?company=${state.companyId}&period=${p}`).then((r) => r.data).catch((e) => { delete state.monthCache[key]; throw e; });
      return state.monthCache[key];
    },
    head: (eyebrow, title) => head(eyebrow, title, null),
    notice(html) { state.upload = html; },
    async reload() { await loadDashboard(); },
  };
  const drill = window.AEDrill(ctx);
  const editor = window.AEEditor(ctx);
  // Wires every [data-drill] element in a container to open its breakdown.
  function wireDrills(root) {
    root.querySelectorAll('[data-drill]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('a,[data-go]') && e.target.closest('a,[data-go]') !== el) return;
      e.preventDefault(); drill.open(JSON.parse(el.dataset.drill));
    }));
  }
  const dAttr = (spec) => `data-drill="${esc(JSON.stringify(spec))}"`;

  // ---------- data loading ----------
  async function boot() {
    try {
      if (!window.AE_SCHEMA) window.AE_SCHEMA = await fetch('/shared/schema.json').then((r) => r.json()).catch(() => null);
      const me = await api.get('/api/me');
      state.me = me.user; state.companies = me.companies; state.workflow = !!me.workflow;
      if (me.next) { renderSetup(me.next); return; }
      // Straight after signing in, the Assura team starts in Workflow when it is installed.
      if (state.justSignedIn && state.workflow) { state.justSignedIn = false; location.assign('/workflow'); return; }
      state.justSignedIn = false;
      // Deep link for the team: /?company=<id>&view=<section> opens that client (view defaults to its month's work).
      const q = new URLSearchParams(location.search);
      const link = Number(q.get('company'));
      if (q.has('company')) history.replaceState(null, '', location.pathname);
      if (isStaff(state.me) && link && me.companies.some((c) => c.id === link)) {
        const view = q.get('view');
        await openClient(link, view && (STAFF_TABS.concat(TABS)).some(([k]) => k === view) ? view : 'client'); return;
      }
      state.companyId = state.companyId && me.companies.some((c) => c.id === state.companyId) ? state.companyId : (me.companies[0] || {}).id;
      // The Assura team starts on its own work page and opens a client from there.
      if (isStaff(state.me) && !state.clientOpen && !(history.state && history.state.aeTab)) state.tab = 'work';
      await loadDashboard();
    } catch (e) {
      if (e.status === 401) { state.me = null; renderLogin(); } else renderFatal(e);
    }
  }
  async function loadDashboard() {
    state.monthCache = {};
    if (!state.companyId) { state.dash = null; state.history = null; render(); return; }
    state.dash = await api.get(`/api/dashboard?company=${state.companyId}`);
    state.history = await api.get(`/api/uploads?company=${state.companyId}`);
    if (!history.state || !history.state.aeTab) history.replaceState({ aeTab: state.tab }, '');
    render();
  }

  // ---------- login ----------
  function renderLogin(error, needCode) {
    const demo = window.AE_DEMO_API ? `
      <div class="demo-box"><b>Try the demo.</b> Tap a login to sign in. The companies and figures are fictional. Password for all: <code>demo-password</code><br>
        ${window.AE_DEMO_API.logins.map((l) => `<button type="button" data-email="${esc(l.email)}">${esc(l.email)}</button> <span class="muted">${esc(l.note)}</span>`).join('<br>')}
      </div>` : '';
    app.innerHTML = `
      <div class="login-wrap">
        <section class="login-brand">
          <div class="wordmark">${LOGO}</div>
          <div>
            <h1>Your business, <em>on one screen.</em></h1>
            <p>Monthly financial intelligence, compliance oversight and management highlights, prepared from data your finance team provides.</p>
          </div>
          <p class="small">Built for businesses ready for their next stage.</p>
        </section>
        <section class="login-form">
          <form id="login" autocomplete="on">
            <div><div class="eyebrow">${new URLSearchParams(location.search).get('next') === 'workflow' ? 'Team login' : 'Client and team login'}</div><h2>Sign in</h2></div>
            <div><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
            <div><label for="pw">Password</label><input id="pw" type="password" required autocomplete="current-password"></div>
            ${needCode ? `<div><label for="code">Code from your authenticator app</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></div>` : ''}
            ${error ? `<div class="msg ${needCode && /Enter the 6-digit/.test(error) ? '' : 'err'}">${esc(error)}</div>` : ''}
            <button class="btn" type="submit">Sign in</button>
            <p class="small muted">A client login sees only its own company's data. Contact your Assura Elevate partner for access.</p>
            ${window.AE_DEMO_API ? '' : '<p class="small"><a href="https://elevateassura.com/">← elevateassura.com</a></p>'}
            ${demo}
          </form>
        </section>
      </div>`;
    // Demo logins sign in with one tap.
    app.querySelectorAll('[data-email]').forEach((b) => b.addEventListener('click', () => {
      app.querySelector('#email').value = b.dataset.email; app.querySelector('#pw').value = 'demo-password';
      app.querySelector('#login').requestSubmit();
    }));
    if (loginDraft.email) { app.querySelector('#email').value = loginDraft.email; app.querySelector('#pw').value = loginDraft.password; }
    const focus = app.querySelector(needCode ? '#code' : '#email'); if (focus) focus.focus();
    app.querySelector('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      const codeEl = app.querySelector('#code');
      const body = { email: app.querySelector('#email').value.trim(), password: app.querySelector('#pw').value, code: codeEl ? codeEl.value.trim() : undefined };
      try {
        await api.post('/api/login', body);
        loginDraft = {};
        state.tab = 'work'; state.clientOpen = false; state.justSignedIn = true;
        await boot();
      } catch (err) {
        const code = !!(err.data && err.data.needCode);
        loginDraft = code ? { email: body.email, password: body.password } : {};
        renderLogin(err.message, code);
      }
    });
  }
  let loginDraft = {};

  // ---------- account setup: first-login password change and team two-step login ----------
  function setupShell(inner) {
    app.innerHTML = `<header class="topbar"><div class="topbar-inner"><span class="wordmark">${LOGO}</span><span class="spacer"></span>
      <button class="btn-ghost" id="logout">Sign out</button></div></header>
      <main><div class="setup card">${inner}</div></main>`;
    app.querySelector('#logout').addEventListener('click', signOut);
  }

  function passwordForm(prefix) {
    return `<form id="${prefix}-pw" class="stack-form">
      <div><label for="${prefix}-cur">Current password</label><input id="${prefix}-cur" type="password" required autocomplete="current-password"></div>
      <div><label for="${prefix}-new">New password</label><input id="${prefix}-new" type="password" required minlength="10" autocomplete="new-password">
        <p class="muted small">At least 10 characters. A short phrase of four or five words works well.</p></div>
      <div><label for="${prefix}-new2">Repeat new password</label><input id="${prefix}-new2" type="password" required minlength="10" autocomplete="new-password"></div>
      <div id="${prefix}-msg"></div>
      <button class="btn" type="submit">Save new password</button></form>`;
  }

  function wirePasswordForm(prefix, onDone) {
    app.querySelector(`#${prefix}-pw`).addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = app.querySelector(`#${prefix}-msg`);
      const cur = app.querySelector(`#${prefix}-cur`).value; const nw = app.querySelector(`#${prefix}-new`).value;
      if (nw !== app.querySelector(`#${prefix}-new2`).value) { msg.innerHTML = '<div class="msg err">The two new passwords do not match.</div>'; return; }
      try { const r = await api.post('/api/password', { current: cur, next: nw }); onDone(r); }
      catch (err) { msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  }

  function renderSetup(next) {
    if (next === 'change-password') {
      setupShell(`<div class="eyebrow">Welcome, ${esc(state.me.name)}</div><h2>Choose your own password</h2>
        <p>You signed in with a one-time password. Choose a password only you know before continuing.</p>${passwordForm('setup')}`);
      wirePasswordForm('setup', (r) => (r.next ? renderSetup(r.next) : boot()));
      return;
    }
    // enrol-2fa
    setupShell(`<div class="eyebrow">Assura Elevate team</div><h2>Set up two-step login</h2>
      <p>Your login can see and change every client's data, so it needs a second step. Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator or similar), then scan this code.</p>
      <div id="qr" class="qr"><span class="muted small">Preparing…</span></div>
      <p class="small">Can't scan? Enter this key in the app instead: <code id="secret" class="secret"></code></p>
      <form id="confirm-2fa" class="stack-form"><div><label for="code2fa">6-digit code shown in the app</label>
        <input id="code2fa" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div>
        <div id="twofa-msg"></div><button class="btn" type="submit">Turn on two-step login</button></form>`);
    api.post('/api/2fa/start').then((r) => {
      app.querySelector('#secret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
      const qrEl = app.querySelector('#qr');
      if (window.qrcode) {
        const q = window.qrcode(0, 'M'); q.addData(r.uri); q.make();
        qrEl.innerHTML = q.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
      } else qrEl.innerHTML = '<span class="muted small">Enter the key below in your app.</span>';
    }).catch((err) => { app.querySelector('#twofa-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; });
    app.querySelector('#confirm-2fa').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api.post('/api/2fa/confirm', { code: app.querySelector('#code2fa').value.trim() }); if (r.next) renderSetup(r.next); else boot(); }
      catch (err) { app.querySelector('#twofa-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
  }

  async function signOut() {
    await api.post('/api/logout').catch(() => {});
    drill.close(); editor.reset();
    state.me = null; state.companyId = null; state.clientOpen = false; state.dash = null; state.history = null; state.upload = null; state.tab = 'overview'; state.admin = null; state.monthCache = {};
    renderLogin();
  }

  function renderFatal(e) {
    app.innerHTML = `<main><div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" id="reload">Reload</button></div></main>`;
    app.querySelector('#reload').addEventListener('click', () => location.reload());
  }

  // ---------- shell ----------
  const TABS = [
    ['overview', 'Overview'], ['money', 'Where is the money?'], ['sales', 'Sales & customers'],
    ['expenses', 'Expenses'], ['compliance', 'Compliance & governance'],
  ];
  // The Assura team: its own work and the firm's clients, then the chosen client's work and dashboard.
  const FIRM_TABS = [['work', 'Monthly data'], ['admin', 'Clients & users']];
  const STAFF_TABS = [['client', 'This month\'s work'], ['insights', 'Explanations'], ['upload', 'Data & uploads'], ['edit', 'Edit data']];
  const tabsFor = (u) => (isStaff(u)
    ? FIRM_TABS.concat(state.clientOpen ? STAFF_TABS.concat(TABS) : [], [['account', 'Account']])
    : TABS.concat([['account', 'Account']]));
  const homeTab = (u) => (isStaff(u) ? 'work' : 'overview');
  const ROLE_LABEL = { client: 'Client (view only)', team: 'Assura team', admin: 'Assura admin' };
  const NAV_ICON = {
    overview: 'M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z',
    money: 'M2 6h16v9H2zM5 9.5h2M13 9.5h2M10 12.5a2 2 0 100-4 2 2 0 000 4z',
    sales: 'M3 16V9M8 16V5M13 16v-5M18 16V3',
    expenses: 'M4 3h12v14l-3-2-3 2-3-2-3 2zM7 7h6M7 10h6',
    compliance: 'M10 2l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V5zM7 10l2 2 4-4',
    insights: 'M10 2a5 5 0 00-3 9v3h6v-3a5 5 0 00-3-9zM8 17h4',
    upload: 'M10 13V3M6 7l4-4 4 4M3 13v4h14v-4',
    edit: 'M4 16l1-4 8-8 3 3-8 8zM12 5l3 3',
    admin: 'M7 9a3 3 0 100-6 3 3 0 000 6zM2 17c0-3 2-5 5-5s5 2 5 5M14 9a2.5 2.5 0 100-5M15 12c2 .5 3 2 3 5',
    workflow: 'M3 4h5v4H3zM12 12h5v4h-5zM5.5 8v6h6.5M12 6h5M14.5 6v4',
    work: 'M3 5h14v12H3zM7 5V3h6v2M3 10h14M9 10v2h2v-2',
    client: 'M4 3h9l3 3v11H4zM7 9l2 2 4-4M7 14h6',
    account: 'M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 18c0-4 3-6 7-6s7 2 7 6',
  };
  const navIcon = (k) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${NAV_ICON[k]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // Moving between sections is a browser history step, so the phone's back button returns to the previous section.
  function goTab(tab) {
    if (tab !== state.tab) history.pushState({ aeTab: tab }, '');
    state.tab = tab; state.showAllHighlights = false;
    if (tab !== 'upload' && tab !== 'edit') state.upload = null;
    render(); window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', (e) => {
    const st = e.state || {};
    if (st.aeDrill || !state.me) return;
    if (menuOpen && !st.aeMenu) { setMenu(false); return; }
    const tab = st.aeTab || homeTab(state.me);
    if (st.aeCompany && st.aeCompany !== state.companyId && state.companies.some((c) => c.id === st.aeCompany)) {
      state.companyId = st.aeCompany; state.clientOpen = true; state.tab = tab; state.upload = null; editor.reset(); loadDashboard(); return;
    }
    if (tab !== state.tab && tabsFor(state.me).some(([k]) => k === tab)) { state.tab = tab; state.showAllHighlights = false; render(); window.scrollTo(0, 0); }
  });
  // A team member opens a client: its work page first, then its dashboard and data.
  async function openClient(id, tab) {
    tab = tab || 'client';
    if (id !== state.companyId) { state.companyId = id; editor.reset(); }
    state.clientOpen = true; state.upload = null; state.showAllHighlights = false;
    history.pushState({ aeTab: tab, aeCompany: id }, '');
    state.tab = tab; await loadDashboard(); window.scrollTo(0, 0);
  }
  let menuOpen = false;
  function setMenu(open) {
    menuOpen = open;
    document.body.classList.toggle('menu-open', open);
    const btn = app.querySelector('#menu'); if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  function render() {
    C.hideTip();
    const u = state.me;
    const company = state.companies.find((c) => c.id === state.companyId);
    const navItem = ([k, l], i) => `<button class="nav-item" data-tab="${k}" ${state.tab === k ? 'aria-current="page"' : ''}>${navIcon(k)}<span>${l}</span>${i != null ? `<i>${String(i + 1).padStart(2, '0')}</i>` : ''}</button>`;
    menuOpen = false; document.body.classList.remove('menu-open');
    app.innerHTML = `
      <div class="shell">
        <aside class="side" aria-label="Main menu">
          <div class="side-top"><a class="wordmark" href="#" data-tab="${homeTab(u)}" aria-label="Assura Elevate, ${isStaff(u) ? 'monthly data' : 'overview'}">${LOGO}</a></div>
          ${isStaff(u) ? `<nav class="side-nav firm" aria-label="Assura workspace">${FIRM_TABS.map((t) => navItem(t)).join('')}</nav>` : ''}
          ${isStaff(u) && state.companies.length
            ? `<div class="side-client"><label for="company">Client</label><select id="company">${state.clientOpen ? '' : '<option value="" selected>Choose a client…</option>'}${state.companies.map((c) => `<option value="${c.id}" ${state.clientOpen && c.id === state.companyId ? 'selected' : ''}>${esc(c.name)} · ${esc(c.code)}</option>`).join('')}</select></div>`
            : company && !isStaff(u) ? `<div class="side-client"><span class="lbl">Company</span><b>${esc(company.name)}</b><span class="code">${esc(company.code)}</span></div>` : ''}
          <nav class="side-nav" aria-label="Sections">
            ${isStaff(u)
              ? (state.clientOpen ? `<div class="nav-group">Client work</div>${STAFF_TABS.map((t) => navItem(t)).join('')}<div class="nav-group">Client dashboard</div>${TABS.map(navItem).join('')}`
                : '<p class="side-hint">Choose a client, or open one from Monthly data, to see its work and dashboard.</p>')
                + (window.AE_DEMO_API ? '' : `<div class="nav-group">Assura workspace</div><a class="nav-item" href="/workflow">${navIcon('workflow')}<span>Practice workspace</span></a>`)
              : `<div class="nav-group">Dashboard</div>${TABS.map(navItem).join('')}`}
          </nav>
          <div class="side-foot">
            ${navItem(['account', 'Account'])}
            <div class="who"><b>${esc(u.name)}</b><span>${esc(ROLE_LABEL[u.role] || '')}</span></div>
            <button class="btn-ghost" id="logout">Sign out</button>
          </div>
        </aside>
        <div class="scrim" id="scrim"></div>
        <div class="main-col">
          <header class="mbar">
            <button class="menu-btn" id="menu" aria-label="Open the menu" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
            <span class="wordmark">${LOGO}</span>
            <span class="mbar-tab">${esc((tabsFor(u).find(([k]) => k === state.tab) || [])[1] || '')}</span>
          </header>
          <main id="page"></main>
        </div>
      </div>`;
    app.querySelector('#logout').addEventListener('click', signOut);
    const sel = app.querySelector('#company');
    if (sel) sel.addEventListener('change', () => { if (sel.value) openClient(Number(sel.value), state.clientOpen && state.tab !== 'work' && state.tab !== 'admin' ? state.tab : 'client'); });
    // From the open phone menu, the menu's own history step becomes the new section's step.
    app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      if (menuOpen) { history.replaceState({ aeTab: b.dataset.tab }, ''); setMenu(false); state.tab = b.dataset.tab; state.showAllHighlights = false; render(); window.scrollTo(0, 0); return; }
      goTab(b.dataset.tab);
    }));
    app.querySelector('#menu').addEventListener('click', () => { history.pushState(Object.assign({}, history.state, { aeMenu: 1 }), ''); setMenu(true); });
    app.querySelector('#scrim').addEventListener('click', () => history.back());

    const page = app.querySelector('#page');
    if (!tabsFor(u).some(([k]) => k === state.tab)) state.tab = homeTab(u);
    if (state.tab === 'work') { workPage(page); return; }
    if (state.tab === 'admin') { adminPage(page); return; }
    if (state.tab === 'account') { accountPage(page); return; }
    if (!company) { page.innerHTML = `<div class="card empty">${isStaff(u) ? 'No client companies yet. Add one under Clients &amp; users.' : 'No company is linked to this login yet.'}</div>`; return; }
    if (state.tab === 'client') { clientWorkPage(page, company); return; }
    if (state.tab === 'edit') { editor.render(page, company); if (state.upload) { page.querySelector('.page-head').insertAdjacentHTML('afterend', state.upload); state.upload = null; } return; }
    const a = state.dash && state.dash.analysis;
    if (state.tab !== 'upload' && (!a || !a.months.length)) {
      page.innerHTML = isStaff(u)
        ? `<div class="card empty"><h2>No data yet</h2><p>Upload the first monthly workbook for ${esc(company.name)} and the dashboard builds itself here.</p><button class="btn" data-go="upload">Go to Data & uploads</button></div>`
        : `<div class="card empty"><h2>Your dashboard is being prepared</h2><p>Your Assura Elevate team uploads your monthly figures. The dashboard appears here as soon as the first month is in.</p>${state.dash && state.dash.cycle ? `<p class="muted">${esc(state.dash.cycle.text)}</p>` : ''}</div>`;
      const go = page.querySelector('[data-go]'); if (go) go.addEventListener('click', () => goTab('upload'));
      return;
    }
    if (state.tab === 'insights') { insightsPage(page, a, company); return; }
    ({ overview, money, sales, expenses, compliance, upload: uploadPage })[state.tab](page, a, company);
    if (state.tab !== 'upload') page.insertAdjacentHTML('beforeend', `<footer class="page-foot"><span>Prepared from data provided by your finance team. Figures are management estimates and unaudited. Click any figure to see the detail behind it.</span><span>Assura Elevate · Compliance, control, intelligence</span></footer>`);
    wireDrills(page);
  }

  function head(eyebrow, title, a, extra) {
    const latest = a && a.latest;
    return `<div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>
      ${latest ? `<div class="muted" style="margin-top:6px">${mLong(latest.period)} · ${a.months.length} month${a.months.length > 1 ? 's' : ''} of history${latest.prepared_by ? ' · Data from ' + esc(latest.prepared_by) : ''}</div>` : ''}</div>
      ${extra || ''}</div>`;
  }

  function delta(cur, prev, { goodUp = true, asPts = false } = {}) {
    if (cur == null || prev == null) return '<div class="delta">–</div>';
    // Percent change against the size of last month's figure, so movements on negative
    // balances (losses, net borrowing) read the right way round.
    const ch = asPts ? (cur - prev) * 100 : prev ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    if (ch == null || !isFinite(ch)) return '<div class="delta">–</div>';
    const up = ch > 0; const flat = Math.abs(ch) < 0.5;
    const cls = flat ? '' : (up === goodUp ? 'good' : 'bad');
    const size = !asPts && Math.abs(ch) > 100 ? inr(Math.abs(cur - prev)) : Math.abs(ch).toFixed(1) + (asPts ? ' pts' : '%');
    return `<div class="delta ${cls}">${flat ? 'Flat' : (up ? '▲ ' : '▼ ') + size} vs last month</div>`;
  }

  function kpiTiles(container, a, defs) {
    const ms = a.months; const cur = ms[ms.length - 1]; const prev = ms[ms.length - 2];
    const wrap = document.createElement('div'); wrap.className = 'kpis';
    defs.forEach((d) => {
      const tile = document.createElement(d.drill ? 'button' : 'div'); tile.className = 'kpi';
      if (d.drill) { tile.type = 'button'; tile.setAttribute('aria-label', `${d.label}: ${d.fmt(cur[d.key])}. Show details`); tile.addEventListener('click', () => drill.open(Object.assign({ period: cur.period }, d.drill))); }
      tile.innerHTML = `<div class="label">${esc(d.label)}${d.drill ? '<span class="more" aria-hidden="true">›</span>' : ''}</div><div class="value">${esc(d.fmt(cur[d.key]))}</div>${delta(cur[d.key], prev && prev[d.key], d)}`;
      tile.appendChild(C.sparkline(ms.map((m) => m[d.key])));
      wrap.appendChild(tile);
    });
    container.appendChild(wrap);
  }
  // Opens a monthly breakdown for the i-th month of a chart.
  const byMonth = (ms, kind, extra) => (i) => drill.open(Object.assign({ kind, period: ms[i].period }, extra || {}));

  function highlightList(list, limit) {
    const shown = limit ? list.slice(0, limit) : list;
    return `<div class="hl-list">${shown.map((h) => `
      <${h.drill ? 'button type="button"' : 'article'} class="hl ${h.severity}${h.drill ? ' clickable' : ''}" ${h.drill ? dAttr(h.drill) : ''}>
        <div class="hl-top">${chip(h.severity)}<span class="hl-area">${esc(h.area)}</span>${h.drill ? '<span style="flex:1"></span><span class="more">See the detail ›</span>' : ''}</div>
        <div class="hl-title">${esc(h.title)}</div>
        <div class="hl-detail">${esc(h.detail)}</div>
        ${h.action ? `<div class="hl-action"><b>For management review:</b> ${esc(h.action)}</div>` : ''}
      </${h.drill ? 'button' : 'article'}>`).join('')}</div>`;
  }

  function card(title, sub, id, extra) {
    return `<div class="card"><div class="card-head"><h3>${esc(title)}</h3>${sub ? `<span class="muted small">${esc(sub)}</span>` : ''}</div>${extra || ''}<div id="${id}"></div></div>`;
  }

  function legend(items) {
    return `<div class="legend">${items.map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;
  }

  function dataTable(headers, rows) {
    return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) => `<th class="${i ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  const TREND_DRILL = { Revenue: 'revenue', 'Gross margin': 'gross', Expenses: 'expenses', Receivables: 'receivables', Inventory: 'inventory', 'Net cash': 'cash' };

  // ---------- Overview ----------
  function overview(page, a, company) {
    const ms = a.months; const cur = ms[ms.length - 1];
    const counts = ['critical', 'watch', 'positive', 'info'].map((s) => [s, a.highlights.filter((h) => h.severity === s).length]).filter((x) => x[1]);
    const note = state.dash && state.dash.cycle;
    page.innerHTML = head('Management dashboard', company.name, a) + (note ? `<div class="cycle-note${note.overdue ? ' late' : ''}" role="status"><b>${mLong(note.period)} figures</b><span>${esc(note.text)}</span></div>` : '') + `<div id="kpis"></div>
      ${explained(a)}
      <div class="grid g-main section">
        <div class="card">
          <div class="card-head"><h3>Highlights this month</h3><div class="hl-summary">${counts.map(([s, n]) => chip(s, `${n} ${SEV_LABEL[s]}`)).join('')}</div></div>
          <p class="muted small" style="margin:-6px 0 12px">Found automatically by comparing this month with your own history: trends, ageing, concentration, unusual spend and due dates. Click a highlight to see the records behind it.</p>
          <div id="hl">${a.highlights.length ? highlightList(a.highlights, state.showAllHighlights ? 0 : 6) : '<p class="muted">Nothing unusual this month.</p>'}</div>
          ${a.highlights.length > 6 ? `<button class="hl-more" id="hl-more" style="margin-top:10px;width:100%">${state.showAllHighlights ? 'Show fewer' : `Show all ${a.highlights.length} highlights`}</button>` : ''}
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>Six-month direction</h3></div>
            <table><tbody>${a.trends.map((t) => `<tr class="clickable" ${dAttr({ kind: TREND_DRILL[t.label] })}><td><button type="button" class="row-link">${esc(t.label)}</button></td><td class="r">${t.dir === 'flat' ? '<span class="muted">Flat</span>' : `<span class="chip ${t.tone === 'good' ? 'positive' : t.tone === 'bad' ? 'watch' : 'info'}">${t.dir === 'rising' ? '▲ Rising' : '▼ Falling'}</span>`}</td><td class="r muted small">${t.dir === 'flat' ? '' : esc(t.perMonth.replace('-', '')) + ' a month'}</td></tr>`).join('')}</tbody></table>
          </div>
          <div class="card"><div class="card-head"><h3>Compliance health</h3><a href="#" data-go="compliance" class="small">Details</a></div>
            <table><tbody>${Object.entries(a.latest.complianceByArea).map(([area, st]) => `<tr class="clickable" ${dAttr({ kind: 'compliance', area })}><td><button type="button" class="row-link">${esc(area)}</button></td><td class="r">${chip(STATE_CHIP[st][0], STATE_CHIP[st][1])}</td></tr>`).join('') || '<tr><td class="muted">No compliance items in this upload.</td></tr>'}</tbody></table>
          </div>
          ${a.latest.notes ? `<div class="card"><div class="card-head"><h3>Note for this month</h3></div><p style="margin:0">${esc(a.latest.notes)}</p></div>` : ''}
        </div>
      </div>
      <div class="grid g-2 section">
        ${card('Revenue and gross profit', 'Monthly, ₹', 'c-rev', legend([['Revenue', 'var(--series-1)'], ['Gross profit', 'var(--series-3)']]))}
        ${card('Margins', '% of revenue', 'c-margin', legend([['Gross margin', 'var(--series-1)'], ['Net margin (estimate)', 'var(--series-3)']]))}
      </div>
      <div class="section card"><div class="card-head"><h3>Platform status</h3></div>
        <div class="status-list">
          <div><b>Currently available</b><ul>
            <li>Secure, view-only login for each client company; each client sees only its own data</li>
            <li>Assura team logins to upload, correct and manage every client's data, with an activity log</li>
            <li>Dashboard rebuilt on every upload, with full month-on-month history</li>
            <li>Click any figure, chart or highlight for the detail behind it, with CSV download</li>
            <li>Automated highlights: trends, ageing, concentration, unusual spend, purchase rates, compliance due dates</li>
            <li>Explanations of what moved each month and why, traced to the transactions and reviewed by the Assura team before they appear here</li>
            <li>Monthly workbook made for each client and month, with company, month and reference locked on its first sheet, sent from the portal</li>
            <li>Monthly data page for the team: each client's monthly data cycle with overdue reminders</li>
            <li>Every upload is checked against the selected company, month and workbook reference, and reviewed before it is accepted</li></ul></div>
          <div><b>Planned</b><ul>
            <li>Review and sign-off steps for the Assura team's monthly work</li>
            <li>Email and WhatsApp alerts for critical highlights</li>
            <li>Direct Tally integration (today: Excel/CSV upload)</li>
            <li>Board pack PDF export, statutory registers and minutes repository</li></ul></div>
        </div>
      </div>`;
    kpiTiles(page.querySelector('#kpis'), a, [
      { label: 'Revenue', key: 'revenue', fmt: inr, drill: { kind: 'revenue' } },
      { label: 'Gross margin', key: 'gmPct', fmt: (v) => pctTxt(v), asPts: true, drill: { kind: 'gross' } },
      { label: 'Net profit (estimate)', key: 'netProfit', fmt: inr, drill: { kind: 'net' } },
      { label: 'Net cash', key: 'netCash', fmt: inr, drill: { kind: 'cash' } },
      { label: 'Receivables', key: 'receivables', fmt: inr, goodUp: false, drill: { kind: 'receivables' } },
      { label: 'Payables', key: 'payables', fmt: inr, goodUp: false, drill: { kind: 'payables' } },
      { label: 'Inventory', key: 'inventory', fmt: inr, goodUp: false, drill: { kind: 'inventory' } },
    ]);
    const labels = mAxis(ms.map((m) => m.period)); const full = ms.map((m) => mLong(m.period));
    C.columns(page.querySelector('#c-rev'), { labels, fullLabels: full, format: inr, axisFormat: axisInr, title: 'Revenue and gross profit by month', onClick: byMonth(ms, 'revenue'),
      series: [{ name: 'Revenue', values: ms.map((m) => m.revenue), color: 'var(--series-1)' }, { name: 'Gross profit', values: ms.map((m) => m.grossProfit), color: 'var(--series-3)' }] });
    C.lines(page.querySelector('#c-margin'), { labels, fullLabels: full, format: (v) => pctTxt(v), axisFormat: (v) => (v * 100).toFixed(0) + '%', title: 'Margins by month', onClick: byMonth(ms, 'gross'),
      series: [{ name: 'Gross margin', values: ms.map((m) => m.gmPct), color: 'var(--series-1)' }, { name: 'Net margin (estimate)', values: ms.map((m) => m.npPct), color: 'var(--series-3)' }] });
    page.querySelector('#c-rev').insertAdjacentHTML('beforeend', `<details class="data-view"><summary>View as table</summary><div class="table-wrap"><table><thead><tr>${['Month', 'Revenue', 'Gross profit', 'Gross margin', 'Expenses', 'Net profit'].map((h, i) => `<th class="${i ? 'r' : ''}">${h}</th>`).join('')}</tr></thead><tbody>
      ${ms.map((m) => `<tr><td>${mShort(m.period)}</td><td class="r"><button type="button" class="row-link" ${dAttr({ kind: 'revenue', period: m.period })}>${inr(m.revenue)}</button></td><td class="r"><button type="button" class="row-link" ${dAttr({ kind: 'gross', period: m.period })}>${inr(m.grossProfit)}</button></td><td class="r">${pctTxt(m.gmPct)}</td><td class="r"><button type="button" class="row-link" ${dAttr({ kind: 'expenses', period: m.period })}>${inr(m.opex)}</button></td><td class="r"><button type="button" class="row-link" ${dAttr({ kind: 'net', period: m.period })}>${inr(m.netProfit)}</button></td></tr>`).join('')}</tbody></table></div></details>`);
    const more = page.querySelector('#hl-more');
    if (more) more.addEventListener('click', () => { state.showAllHighlights = !state.showAllHighlights; render(); });
    page.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); goTab(x.dataset.go); }));
  }

  // ---------- What moved, and why (explanations accepted by the Assura team) ----------
  const AREA_DRILL = { revenue: 'revenue', margin: 'gross', expenses: 'expenses', profit: 'net', receivables: 'receivables', inventory: 'inventory', cash: 'cash' };
  function explained(a) {
    const period = a.latest.period;
    const list = ((state.dash && state.dash.insights) || []).filter((x) => x.period === period);
    if (!list.length) {
      return isStaff(state.me) ? `<div class="section ins-empty"><span>No explanations have been accepted for ${mLong(period)} yet, so the client sees none.</span><a href="#" data-go="insights">Review the suggested explanations ›</a></div>` : '';
    }
    return `<section class="section explained" aria-labelledby="exp-h">
      <div class="explained-head"><div><div class="eyebrow">${mLong(period)}</div><h2 id="exp-h">What moved this month, and why</h2></div>
        <span class="muted small">Reviewed by your Assura Elevate team${isStaff(state.me) ? ' · <a href="#" data-go="insights">Edit</a>' : ''}</span></div>
      <div class="explained-list">${list.map((x, i) => `
        <article class="exp${AREA_DRILL[x.key] ? ' clickable' : ''}" ${AREA_DRILL[x.key] ? dAttr({ kind: AREA_DRILL[x.key], period }) : ''}>
          <div class="exp-n">${String(i + 1).padStart(2, '0')}</div>
          <div><div class="exp-area">${esc(x.area)}</div><h3 class="exp-title">${esc(x.headline)}</h3><p>${esc(x.body)}</p>
          ${AREA_DRILL[x.key] ? '<span class="more">See the figures ›</span>' : ''}</div>
        </article>`).join('')}</div>
    </section>`;
  }

  // ---------- Explanations review (Assura team) ----------
  let insView = { period: null };
  async function insightsPage(page, a, company) {
    const periods = (state.dash && state.dash.periods) || [];
    if (!insView.period || !periods.includes(insView.period) || insView.company !== company.id) insView = { period: periods[periods.length - 1], company: company.id };
    page.innerHTML = head('Assura workspace', 'Explanations', null) + `
      <div class="card ins-intro">
        <div class="editor-bar"><div><label for="ins-month">Month</label><select id="ins-month" class="field">${periods.slice().reverse().map((p) => `<option value="${p}" ${p === insView.period ? 'selected' : ''}>${mLong(p)}</option>`).join('')}</select></div>
          <div style="flex:1"><p class="muted small" style="margin:0">Elevate Intelligence compares ${esc(company.name)}'s month with the month before, traces each material movement to the transactions behind it and suggests the likely causes, largest effect first. Tick the causes that are right, adjust the wording, and accept. Only accepted explanations appear on the client's dashboard.</p></div></div>
      </div>
      ${state.upload || ''}
      <div id="ins-body" class="section"><div class="card empty">Working through ${mLong(insView.period)}…</div></div>`;
    state.upload = null;
    page.querySelector('#ins-month').addEventListener('change', (e) => { insView.period = e.target.value; insightsPage(page, a, company); });
    let r;
    try { r = await api.get(`/api/insights?company=${company.id}&period=${insView.period}`); } catch (e) { page.querySelector('#ins-body').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const body = page.querySelector('#ins-body');
    if (!body) return;
    const STATUS = { accepted: ['positive', 'Shown to client'], 'set-aside': ['info', 'Set aside'] };
    const cardHtml = (it, n) => {
      const d = it.draft; const rv = it.review;
      const key = d ? d.key : rv.key;
      const ticked = rv ? (rv.causes || []) : d.causes.filter((c) => d.suggested.includes(c.id)).map((c) => c.text);
      const text = rv ? rv.body : [d.movement].concat(ticked).join(' ');
      const st = rv ? STATUS[rv.status] : ['watch', 'Draft, not shown'];
      return `<article class="card ins" data-n="${n}">
        <div class="ins-top"><span class="exp-area">${esc(d ? d.area : rv.area)}</span>${chip(st[0], st[1])}${it.stale ? chip('critical', 'Figures changed since review') : ''}
          <span style="flex:1"></span>${AREA_DRILL[key] ? `<button type="button" class="link-btn" ${dAttr({ kind: AREA_DRILL[key], period: r.period })}>See the figures ›</button>` : ''}</div>
        <label for="ins-h-${n}">Headline</label><input type="text" id="ins-h-${n}" class="ins-h" value="${esc(rv ? rv.headline : d.headline)}">
        ${d ? `<p class="ins-move">${esc(d.movement)}</p>
        <div class="ins-causes"><div class="lbl">Likely causes, largest effect first</div>
          ${d.causes.map((c) => `<label class="cause"><input type="checkbox" value="${esc(c.text)}" ${ticked.includes(c.text) ? 'checked' : ''}><span>${esc(c.text)}</span>${c.impact ? `<b class="num">${c.impact > 0 ? '+' : '−'}${esc(inr(Math.abs(c.impact)))}</b>` : '<b class="muted small">note</b>'}</label>`).join('')}
        </div>` : '<p class="muted small">Written by the team. The figures no longer show this movement, so check it still applies.</p>'}
        <label for="ins-t-${n}">Explanation the client will read</label>
        <textarea id="ins-t-${n}" class="ins-t" rows="4">${esc(text)}</textarea>
        <div class="btn-row ins-actions">
          <button class="btn" type="button" data-act="accepted">${rv && rv.status === 'accepted' ? 'Save changes' : 'Accept and show to client'}</button>
          ${!rv || rv.status !== 'set-aside' ? '<button class="btn secondary" type="button" data-act="set-aside">Set aside</button>' : ''}
          ${rv ? '<button class="btn secondary" type="button" data-act="draft">Back to draft</button>' : ''}
          ${rv ? `<span class="muted small">${esc(rv.status === 'accepted' ? 'Accepted' : 'Set aside')} by ${esc(rv.reviewed_by || 'the team')}, ${esc(stamp(rv.reviewed_at))}</span>` : ''}
          ${!d ? '' : '<button class="link-btn" type="button" data-rebuild>Rebuild the text from the ticked causes</button>'}
        </div><div class="ins-msg"></div>
      </article>`;
    };
    body.innerHTML = (r.items.length ? r.items.map(cardHtml).join('') : `<div class="card empty">${r.first ? 'This is the first month on record, so there is no earlier month to compare with.' : `No material movements in ${mLong(r.period)}: revenue, margin, expenses, profit, receivables, stock and cash all moved within normal limits.`}</div>`)
      + `<form class="card ins own" id="ins-own"><h3>Add an explanation of your own</h3>
        <div class="form-row" style="margin-top:8px"><div><label for="own-area">Area</label><select id="own-area" class="field">${['Revenue', 'Margin', 'Expenses', 'Profit', 'Receivables', 'Inventory', 'Cash', 'Compliance', 'General'].map((x) => `<option>${x}</option>`).join('')}</select></div>
          <div style="grid-column:span 2"><label for="own-h">Headline</label><input type="text" id="own-h" required></div></div>
        <label for="own-t" style="margin-top:12px">Explanation the client will read</label><textarea id="own-t" class="ins-t" rows="3" required></textarea>
        <div class="btn-row" style="margin-top:10px"><button class="btn" type="submit">Accept and show to client</button></div><div class="ins-msg"></div></form>`;
    wireDrills(body);
    const save = async (el, payload) => {
      const msg = el.querySelector('.ins-msg');
      try {
        await api.post('/api/insights/review', Object.assign({ company: company.id, period: r.period }, payload));
        state.dash = await api.get(`/api/dashboard?company=${company.id}`);
        state.upload = `<div class="msg ok">${payload.status === 'accepted' ? `Saved. The client now sees “${esc(payload.headline)}” on their dashboard.` : payload.status === 'set-aside' ? 'Set aside. The client does not see it.' : 'Back to draft. The client no longer sees it.'}</div>`;
        insightsPage(page, a, company);
      } catch (e) { msg.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    body.querySelectorAll('article.ins').forEach((el) => {
      const it = r.items[Number(el.dataset.n)]; const d = it.draft;
      const ta = el.querySelector('.ins-t');
      const ticks = () => [...el.querySelectorAll('.cause input:checked')].map((x) => x.value);
      // The text follows the ticked causes until someone edits it by hand.
      let edited = !!it.review;
      ta.addEventListener('input', () => { edited = true; });
      el.querySelectorAll('.cause input').forEach((cb) => cb.addEventListener('change', () => { if (!edited && d) ta.value = [d.movement].concat(ticks()).join(' '); }));
      const rb = el.querySelector('[data-rebuild]'); if (rb) rb.addEventListener('click', () => { ta.value = [d.movement].concat(ticks()).join(' '); edited = false; });
      el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => save(el, {
        key: d ? d.key : it.review.key, area: d ? d.area : it.review.area, status: b.dataset.act,
        headline: el.querySelector('.ins-h').value, body: ta.value, causes: d ? ticks() : (it.review.causes || []),
      })));
    });
    const own = body.querySelector('#ins-own');
    own.addEventListener('submit', (e) => {
      e.preventDefault();
      save(own, { key: `own-${Date.now().toString(36)}`, area: own.querySelector('#own-area').value, status: 'accepted', headline: own.querySelector('#own-h').value, body: own.querySelector('#own-t').value, causes: [] });
    });
  }

  // ---------- Where is the money ----------
  function money(page, a, company) {
    const ms = a.months; const cur = ms[ms.length - 1]; const prev = ms[ms.length - 2] || {};
    const L = a.latest;
    const locked = cur.receivables + (cur.inventory || 0);
    const cmp = (k, goodUp) => {
      if (prev[k] == null || cur[k] == null) return '';
      const d = cur[k] - prev[k]; if (!d) return '<span class="muted small">no change</span>';
      return `<span class="small" style="color:var(--${(d > 0) === goodUp ? 'positive' : 'critical'})">${d > 0 ? '+' : ''}${d} vs last month</span>`;
    };
    page.innerHTML = head('Where is the money?', company.name, a) + `
      <div class="card"><div class="card-head"><h3>Money in the business at month end</h3><span class="muted small">${mLong(cur.period)}</span></div>
        <div class="money">
          <button type="button" class="cell clickable" ${dAttr({ kind: 'cash' })}><div class="muted small">Cash and bank</div><div class="v">${inr(cur.cash)}</div></button>
          <button type="button" class="cell clickable" ${dAttr({ kind: 'receivables' })}><div class="muted small">With customers (receivables)</div><div class="v">${inr(cur.receivables)}</div></button>
          <button type="button" class="cell clickable" ${dAttr({ kind: 'inventory' })}><div class="muted small">In stock (inventory)</div><div class="v">${inr(cur.inventory)}</div></button>
          <button type="button" class="cell out clickable" ${dAttr({ kind: 'payables' })}><div class="muted small">Owed to suppliers</div><div class="v">−${inr(cur.payables)}</div></button>
          <button type="button" class="cell out clickable" ${dAttr({ kind: 'cash' })}><div class="muted small">Bank OD / CC drawn</div><div class="v">−${inr(cur.odUsed)}</div></button>
          <button type="button" class="cell total clickable" ${dAttr({ kind: 'working-capital' })}><div class="muted small">Locked in receivables and stock</div><div class="v">${inr(locked)}</div><div class="small muted">${pctTxt(locked / ((cur.revenue || 1) * 12), 0)} of annualised revenue</div></button>
        </div>
      </div>
      <div class="card section"><div class="card-head"><h3>Working capital cycle</h3><span class="muted small">Based on the trailing three months</span></div>
        <div class="ratio">
          <button type="button" class="clickable" ${dAttr({ kind: 'receivables' })}><span class="muted small">Customers pay in</span><b>${days(cur.dso)}</b>${cmp('dso', false)}</button>
          <button type="button" class="clickable" ${dAttr({ kind: 'inventory' })}><span class="muted small">Stock is held for</span><b>${days(cur.dio)}</b>${cmp('dio', false)}</button>
          <button type="button" class="clickable" ${dAttr({ kind: 'payables' })}><span class="muted small">Suppliers paid in</span><b>${days(cur.dpo)}</b>${cmp('dpo', true)}</button>
          <button type="button" class="clickable" ${dAttr({ kind: 'working-capital' })}><span class="muted small">Cash conversion cycle</span><b>${days(cur.ccc)}</b>${cmp('ccc', false)}</button>
        </div>
        <div id="c-days" style="margin-top:16px"></div>
      </div>
      <div class="grid g-2 section">
        ${card('Receivables ageing', 'By invoice date', 'c-ra')}
        ${card('Inventory ageing', 'By last movement', 'c-ia')}
      </div>
      <div class="grid g-2 section">
        ${card('Payables ageing', 'By bill date', 'c-pa')}
        ${card('Working capital, month by month', '₹', 'c-wc', legend([['Receivables', 'var(--series-1)'], ['Inventory', 'var(--series-3)'], ['Payables', 'var(--series-2)']]))}
      </div>
      <div class="card section"><div class="card-head"><h3>Cash and bank accounts</h3></div><div id="t-cash"></div></div>`;
    const labels = mAxis(ms.map((m) => m.period)); const full = ms.map((m) => mLong(m.period));
    page.querySelector('#c-days').insertAdjacentHTML('beforeend', legend([['Customers pay in', 'var(--series-1)'], ['Stock held for', 'var(--series-3)'], ['Suppliers paid in', 'var(--series-2)']]));
    C.lines(page.querySelector('#c-days'), { labels, fullLabels: full, height: 180, format: days, axisFormat: (v) => v.toFixed(0) + 'd', title: 'Working capital days', onClick: byMonth(ms, 'working-capital'),
      series: [{ name: 'Customers pay in', values: ms.map((m) => m.dso), color: 'var(--series-1)' }, { name: 'Stock held for', values: ms.map((m) => m.dio), color: 'var(--series-3)' }, { name: 'Suppliers paid in', values: ms.map((m) => m.dpo), color: 'var(--series-2)', dashed: true }] });
    const ageParts = (obj, keys, kind) => keys.map((k, i) => ({ label: `${k} days`, value: obj[k] || 0, color: SEQ[i], onClick: () => drill.open({ kind, bucket: k === '181-365' ? '181+' : k }) }));
    const ra = page.querySelector('#c-ra');
    C.stack(ra, ageParts(L.recvAgeing, ['0-30', '31-60', '61-90', '90+'], 'receivables'), inr);
    ra.insertAdjacentHTML('beforeend', L.topOverdue.length ? `<h3 style="margin:18px 0 8px">Largest balances over 90 days</h3>` : '<p class="muted small" style="margin-top:14px">No balances over 90 days.</p>');
    if (L.topOverdue.length) C.hbars(ra, L.topOverdue, inr, { onClick: (it) => drill.open({ kind: 'customer', name: it.name }) });
    if (L.topOverdue.length) ra.insertAdjacentHTML('beforeend', `<button type="button" class="btn secondary small" style="margin-top:12px" ${dAttr({ kind: 'receivables', bucket: '90+' })}>See every party over 90 days</button>`);
    const ia = page.querySelector('#c-ia');
    C.stack(ia, ageParts(L.invAgeing, ['0-90', '91-180', '181-365', '365+'], 'inventory'), inr);
    ia.insertAdjacentHTML('beforeend', L.slowStock.length ? `<h3 style="margin:18px 0 8px">Stock not moved for 6+ months</h3>` : '<p class="muted small" style="margin-top:14px">No stock older than six months.</p>');
    if (L.slowStock.length) C.hbars(ia, L.slowStock.map((s) => ({ name: s.name, value: s.value, note: `${s.days} days` })), inr, { onClick: () => drill.open({ kind: 'inventory', bucket: '181+' }) });
    C.stack(page.querySelector('#c-pa'), ageParts(L.payAgeing, ['0-30', '31-60', '61-90', '90+'], 'payables'), inr);
    page.querySelector('#c-pa').insertAdjacentHTML('beforeend', `<p class="muted small" style="margin-top:14px">Payments to micro and small enterprise suppliers beyond 45 days can affect tax deductibility (Section 43B(h)). Keep supplier MSME status up to date.</p>`);
    C.lines(page.querySelector('#c-wc'), { labels, fullLabels: full, format: inr, axisFormat: axisInr, zero: true, title: 'Working capital components', onClick: byMonth(ms, 'working-capital'),
      series: [{ name: 'Receivables', values: ms.map((m) => m.receivables), color: 'var(--series-1)' }, { name: 'Inventory', values: ms.map((m) => m.inventory), color: 'var(--series-3)' }, { name: 'Payables', values: ms.map((m) => m.payables), color: 'var(--series-2)', dashed: true }] });
    page.querySelector('#t-cash').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th class="r">Closing balance</th><th class="r">Limit</th><th class="r">Utilised</th></tr></thead><tbody>
      ${L.cashAccounts.map((c) => `<tr class="clickable" ${dAttr({ kind: 'cash' })}><td>${esc(c.account)}</td><td>${esc(c.type)}</td><td class="r">${inr(c.closing)}</td><td class="r">${c.limit ? inr(c.limit) : '–'}</td><td class="r">${c.limit && c.closing < 0 ? pctTxt(-c.closing / c.limit, 0) : '–'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Sales & customers ----------
  function sales(page, a, company) {
    const ms = a.months; const L = a.latest; const cur = ms[ms.length - 1];
    page.innerHTML = head('Sales & customers', company.name, a) + `<div id="kpis"></div>
      <div class="grid g-2 section">
        ${card('Top customers', `${mLong(cur.period)}, share of revenue`, 'c-cust')}
        ${card('Revenue by product category', mLong(cur.period), 'c-prod')}
      </div>
      <div class="grid g-2 section">
        ${card('Customer concentration', 'Share of monthly revenue', 'c-conc', legend([['Largest customer', 'var(--series-1)'], ['Top five customers', 'var(--series-3)']]))}
        ${card('Revenue by region', mLong(cur.period), 'c-reg')}
      </div>`;
    kpiTiles(page.querySelector('#kpis'), a, [
      { label: 'Revenue', key: 'revenue', fmt: inr, drill: { kind: 'revenue' } },
      { label: 'Customers billed', key: 'customerCount', fmt: (v) => String(v), drill: { kind: 'revenue' } },
      { label: 'Invoices', key: 'invoiceCount', fmt: (v) => String(v), drill: { kind: 'revenue' } },
      { label: 'Average invoice', key: 'avgInvoice', fmt: inr, drill: { kind: 'revenue' } },
      { label: 'B2B share', key: 'b2bShare', fmt: (v) => pctTxt(v, 0), asPts: true, drill: { kind: 'revenue' } },
      { label: 'Largest customer share', key: 'topCustomerShare', fmt: (v) => pctTxt(v, 0), asPts: true, goodUp: false, drill: L.topCustomers[0] ? { kind: 'customer', name: L.topCustomers[0].name } : null },
    ]);
    C.hbars(page.querySelector('#c-cust'), L.topCustomers.map((c) => ({ name: c.name, value: c.value, note: pctTxt(c.value / cur.revenue, 0) })), inr, { onClick: (it) => drill.open({ kind: 'customer', name: it.name }) });
    C.hbars(page.querySelector('#c-prod'), L.productMix.map((c) => ({ name: c.name, value: c.value, note: pctTxt(c.value / cur.revenue, 0) })), inr, { onClick: (it) => drill.open({ kind: 'category', name: it.name }) });
    if (L.regionMix.length) C.hbars(page.querySelector('#c-reg'), L.regionMix.map((c) => ({ name: c.name, value: c.value, note: pctTxt(c.value / cur.revenue, 0) })), inr, { onClick: (it) => drill.open({ kind: 'region', name: it.name }) });
    else page.querySelector('#c-reg').innerHTML = '<p class="muted">Add the Region / State column in the Sales sheet to see this.</p>';
    const labels = mAxis(ms.map((m) => m.period));
    C.lines(page.querySelector('#c-conc'), { labels, fullLabels: ms.map((m) => mLong(m.period)), format: (v) => pctTxt(v, 0), axisFormat: (v) => (v * 100).toFixed(0) + '%', title: 'Customer concentration', onClick: byMonth(ms, 'revenue'),
      series: [{ name: 'Largest customer', values: ms.map((m) => m.topCustomerShare), color: 'var(--series-1)' }, { name: 'Top five customers', values: ms.map((m) => m.top5Share), color: 'var(--series-3)' }] });
  }

  // ---------- Expenses ----------
  function expenses(page, a, company) {
    const ms = a.months; const L = a.latest; const cur = ms[ms.length - 1];
    const groups = [...new Set([].concat(...ms.map((m) => Object.keys(m.expenseByGroup))))];
    const prior = ms.slice(-4, -1);
    const avg = (g) => prior.length ? prior.reduce((s, m) => s + (m.expenseByGroup[g] || 0), 0) / prior.length : null;
    page.innerHTML = head('Expenses', company.name, a) + `<div id="kpis"></div>
      <div class="grid g-2 section">
        ${card('Expenses by group', `${mLong(cur.period)} against the ${prior.length}-month average`, 'c-grp', legend([[mShort(cur.period), 'var(--series-1)'], ['Prior average', 'var(--series-2)']]))}
        ${card('Expenses as a share of revenue', 'Monthly', 'c-ratio')}
      </div>
      <div class="card section"><div class="card-head"><h3>Expense heads</h3><span class="muted small">${mLong(cur.period)}</span></div><div id="t-heads"></div></div>`;
    kpiTiles(page.querySelector('#kpis'), a, [
      { label: 'Operating expenses', key: 'opex', fmt: inr, goodUp: false, drill: { kind: 'expenses' } },
      { label: 'Purchases', key: 'purchases', fmt: inr, goodUp: false, drill: { kind: 'purchases' } },
      { label: 'Cost of goods sold', key: 'cogs', fmt: inr, goodUp: false, drill: { kind: 'gross' } },
      { label: 'Net profit (estimate)', key: 'netProfit', fmt: inr, drill: { kind: 'net' } },
    ]);
    C.columns(page.querySelector('#c-grp'), { labels: groups.map((g) => g.split(' ')[0]), fullLabels: groups, format: inr, axisFormat: axisInr, title: 'Expenses by group', onClick: (i) => drill.open({ kind: 'expenses', group: groups[i] }),
      series: [{ name: mShort(cur.period), values: groups.map((g) => cur.expenseByGroup[g] || 0), color: 'var(--series-1)' }, { name: 'Prior average', values: groups.map(avg), color: 'var(--series-2)' }] });
    C.lines(page.querySelector('#c-ratio'), { labels: mAxis(ms.map((m) => m.period)), fullLabels: ms.map((m) => mLong(m.period)), format: (v) => pctTxt(v), axisFormat: (v) => (v * 100).toFixed(0) + '%', title: 'Expenses as share of revenue', onClick: byMonth(ms, 'expenses'),
      series: [{ name: 'Operating expenses / revenue', values: ms.map((m) => (m.revenue ? m.opex / m.revenue : null)), color: 'var(--series-1)' }] });
    page.querySelector('#t-heads').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Head</th><th>Group</th><th class="r">Amount</th><th class="r">% of revenue</th></tr></thead><tbody>
      ${L.expenseHeads.map((e) => `<tr class="clickable" ${dAttr({ kind: 'expense-head', head: e.head })}><td><button type="button" class="row-link">${esc(e.head)}</button></td><td>${esc(e.group)}</td><td class="r">${inr(e.amount)}</td><td class="r">${pctTxt(e.amount / cur.revenue)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Compliance & governance ----------
  function compliance(page, a, company) {
    const L = a.latest;
    const order = { overdue: 0, 'due-soon': 1, pending: 2, done: 3, na: 4 };
    const items = L.compliance.slice().sort((x, y) => order[x.state] - order[y.state] || x.due_date.localeCompare(y.due_date));
    page.innerHTML = head('Compliance & governance', company.name, a) + `
      <div class="card"><div class="card-head"><h3>Status by area</h3><span class="muted small">As reported in the ${mLong(L.period)} workbook, checked against today's date</span></div>
        <div class="comp-areas">${Object.entries(L.complianceByArea).map(([area, st]) => `<button type="button" class="comp-area clickable" ${dAttr({ kind: 'compliance', area })}><span class="name">${esc(area)}</span>${chip(STATE_CHIP[st][0], STATE_CHIP[st][1])}</button>`).join('')}</div>
      </div>
      <div class="card section"><div class="card-head"><h3>Compliance calendar</h3></div>
        <div class="table-wrap"><table><thead><tr><th>Area</th><th>Item</th><th>Period</th><th>Due</th><th>Status</th><th>Filed / paid on</th><th>Remarks</th></tr></thead><tbody>
        ${items.map((c) => `<tr><td>${esc(c.area)}</td><td>${esc(c.item)}</td><td>${esc(c.period_covered || '')}</td><td class="num">${dLong(c.due_date)}</td>
          <td>${chip(STATE_CHIP[c.state][0], STATE_CHIP[c.state][1])}${c.late ? ' ' + chip('watch', 'Filed late') : ''}</td><td class="num">${dLong(c.done_on)}</td><td>${esc(c.remarks || '')}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="muted small" style="margin-top:12px">Assura Elevate reviews this calendar each month. Statutory registers, minutes and resolutions are maintained as part of the governance engagement; an online repository for them is planned.</p>
      </div>`;
  }

  // ---------- Account ----------
  function accountPage(page) {
    const u = state.me;
    page.innerHTML = head('Account', u.name, null) + `
      <div class="grid g-2">
        <div class="card"><div class="card-head"><h3>Change password</h3></div>${passwordForm('acct')}</div>
        <div class="card"><div class="card-head"><h3>Your login</h3></div>
          <table><tbody>
            <tr><td>Email</td><td class="r">${esc(u.email)}</td></tr>
            <tr><td>Role</td><td class="r">${esc({ client: 'Client (view only, own company)', team: 'Assura team (all clients, upload and edit)', admin: 'Assura admin (all clients and team logins)' }[u.role])}</td></tr>
            <tr><td>Two-step login</td><td class="r">${u.twoStep ? chip('positive', 'On') : chip('info', isStaff(u) ? 'Off' : 'Not required')}</td></tr>
          </tbody></table>
          <p class="muted small" style="margin-top:12px">You are signed out after ${esc(window.AE_IDLE_MINUTES || 120)} minutes without activity. Changing your password signs out your other devices.</p>
        </div>
      </div>`;
    wirePasswordForm('acct', () => { page.querySelector('#acct-msg').innerHTML = '<div class="msg ok">Password changed. Your other devices have been signed out.</div>'; page.querySelector('#acct-pw').reset(); });
  }

  // ---------- Clients & users (Assura team) ----------
  const ACTION_LABEL = {
    login: 'Signed in', logout: 'Signed out', 'login.failed': 'Failed sign-in', 'login.code_failed': 'Wrong two-step code', 'login.disabled': 'Sign-in by a switched-off login',
    'dashboard.viewed': 'Viewed dashboard', 'upload.accepted': 'Upload accepted', 'upload.rejected': 'Upload rejected', 'password.changed': 'Changed password', '2fa.enabled': 'Turned on two-step login',
    'admin.company_added': 'Added company', 'admin.company_renamed': 'Renamed company', 'admin.user_added': 'Added login',
    'upload.wrong_company': 'Upload refused: wrong company', 'workbook.emailed': 'Emailed monthly workbook', 'workbook.downloaded': 'Downloaded monthly workbook', 'workbook.email_failed': 'Workbook email failed',
    'admin.company_email': 'Changed accounts email', 'insight.accepted': 'Accepted an explanation', 'insight.set_aside': 'Set aside an explanation', 'insight.withdrawn': 'Withdrew an explanation',
    'data.edited': 'Edited data', 'data.restored': 'Restored a version', 'data.month_removed': 'Removed a month', 'admin.reset-password': 'Reset password', 'admin.reset-2fa': 'Reset two-step login', 'admin.disable': 'Switched off login', 'admin.enable': 'Switched on login',
  };

  // Backups: the last one, whether it opened cleanly, what is kept, and the copy away from the server.
  function backupCard(b) {
    const mb = (n) => (n == null ? '–' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);
    const hoursAgo = b.last_backup_at ? (Date.now() - Date.parse(b.last_backup_at)) / 3600e3 : null;
    const state = b.last_error ? chip('critical', 'Last backup failed')
      : hoursAgo == null ? chip('critical', 'No backup yet')
      : hoursAgo > 3 ? chip('critical', 'No backup for over 3 hours') : chip('positive', 'Running hourly');
    const off = b.offsite;
    return `<div class="card section"><div class="card-head"><h3>Backups</h3>${state}</div>
      <div class="sumrow-grid">
        <div><span class="lbl">Last backup</span><b>${b.last_backup_at ? esc(stamp(b.last_backup_at)) : '–'}</b><span class="muted small">${b.last_check && b.last_check.ok ? `Opened and checked: ${b.last_check.companies} clients, ${b.last_check.uploads} data versions` : ''}</span></div>
        <div><span class="lbl">Kept on the server</span><b>${b.kept} backups · ${mb(b.kept_bytes)}</b><span class="muted small">${b.oldest_at ? `Going back to ${esc(stamp(b.oldest_at))}` : ''}</span></div>
        <div><span class="lbl">Copy away from the server</span>${off && off.where ? `<b>${off.error ? chip('critical', 'Failing') : esc(stamp(off.last_at))}</b><span class="muted small">${esc(off.error || off.where)}</span>` : '<b>Not set up yet</b><span class="muted small">See DEPLOY.md, “Backups”</span>'}</div>
      </div>
      ${b.last_error ? `<div class="msg err">${esc(b.last_error)}</div>` : ''}
      <p class="muted small" style="margin:12px 0 0">A backup is taken every hour and kept for a day, one a day is kept for 30 days and one a month for a year. Each is encrypted and opened again to check it before it counts.</p></div>`;
  }

  async function adminPage(page) {
    page.innerHTML = head('Clients & users', 'Manage client companies and logins', null) + '<div class="card empty">Loading…</div>';
    let d;
    try { d = await api.get('/api/admin/overview'); } catch (e) { page.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const notice = state.adminNotice || ''; state.adminNotice = '';
    const admin = state.me.role === 'admin';
    const canManage = (x) => admin || x.role === 'client';
    page.innerHTML = head('Clients & users', 'Manage client companies and logins', null) + notice + `
      <div class="grid g-2">
        <form class="card stack-form" id="f-company"><div class="card-head"><h3>Add a client company</h3></div>
          <div class="form-row" style="margin-top:0"><div><label for="c-code">Company code</label><input id="c-code" type="text" placeholder="AE-0003" required maxlength="20"></div>
          <div><label for="c-name">Company name</label><input id="c-name" type="text" required maxlength="160"></div></div>
          <div><label for="c-email">Accounts email</label><input id="c-email" type="email" multiple placeholder="accounts@client.com"><p class="muted small" style="margin:4px 0 0">Where the monthly workbook is emailed. Up to three addresses, separated by commas.</p></div>
          <div id="c-msg"></div><div><button class="btn" type="submit">Add company</button></div></form>
        <form class="card stack-form" id="f-user"><div class="card-head"><h3>Add a login</h3></div>
          <div class="form-row" style="margin-top:0"><div><label for="u-name">Name</label><input id="u-name" type="text" required maxlength="120"></div>
          <div><label for="u-email">Email</label><input id="u-email" type="email" required></div></div>
          <div class="form-row" style="margin-top:0"><div><label for="u-role">Role</label><select id="u-role" class="field">
            <option value="client">Client (view only, one company)</option>${admin ? '<option value="team">Assura team (all clients, upload and edit)</option><option value="admin">Assura admin (also manages team logins)</option>' : ''}</select></div>
          <div id="u-company-wrap"><label for="u-company">Company</label><select id="u-company" class="field">${d.companies.map((c) => `<option value="${c.id}">${esc(c.code)} · ${esc(c.name)}</option>`).join('')}</select></div></div>
          <p class="muted small" style="margin:0">A one-time password is shown once. The person must change it at first sign-in; Assura team logins also set up two-step login.${admin ? '' : ' Only an Assura admin can add team logins.'}</p>
          <div id="u-msg"></div><div><button class="btn" type="submit">Add login</button></div></form>
      </div>
      ${d.backups ? backupCard(d.backups) : ''}
      <div class="card section"><div class="card-head"><h3>Client companies</h3><span class="muted small">${d.companies.length}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Code</th><th>Company</th><th>Accounts email</th><th class="r">Client logins</th><th class="r">Months on record</th><th>Latest month</th><th>Last change</th><th></th></tr></thead><tbody>
        ${d.companies.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td><td data-email-cell>${c.data_email ? esc(c.data_email) : '<span class="muted">Not set</span>'} <button class="link-btn" data-email="${c.id}" data-value="${esc(c.data_email || '')}">${c.data_email ? 'Change' : 'Add'}</button></td><td class="r">${c.users}</td><td class="r">${c.months}</td><td>${c.latest ? mShort(c.latest) : '–'}</td><td>${c.last_upload ? esc(stamp(c.last_upload)) : '–'}</td>
          <td class="r nowrap"><button class="link-btn" data-open="${c.id}">Open dashboard</button> <button class="link-btn" data-rename="${c.id}" data-name="${esc(c.name)}">Rename</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No companies yet.</td></tr>'}
        </tbody></table></div></div>
      <div class="card section"><div class="card-head"><h3>Logins</h3><span class="muted small">${d.users.length}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Company</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
        ${d.users.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${esc(ROLE_LABEL[x.role])}</td><td>${esc(x.company_code || 'All')}</td>
          <td>${x.disabled ? chip('critical', 'Switched off') : x.must_change_password ? chip('info', 'Not yet signed in') : chip('positive', 'Active')}${x.role !== 'client' ? ' ' + (x.two_step ? chip('positive', 'Two-step on') : chip('watch', 'Two-step pending')) : ''}</td>
          <td>${x.last_login_at ? esc(stamp(x.last_login_at)) : '–'}</td>
          <td class="r nowrap">${x.id === state.me.id ? '<span class="muted small">You</span>' : !canManage(x) ? '<span class="muted small">Admin only</span>' : `
            <button class="link-btn" data-act="reset-password" data-id="${x.id}" data-name="${esc(x.name)}">Reset password</button>
            ${x.role !== 'client' && x.two_step ? `<button class="link-btn" data-act="reset-2fa" data-id="${x.id}" data-name="${esc(x.name)}">Reset two-step</button>` : ''}
            <button class="link-btn" data-act="${x.disabled ? 'enable' : 'disable'}" data-id="${x.id}" data-name="${esc(x.name)}">${x.disabled ? 'Switch on' : 'Switch off'}</button>`}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card section"><div class="card-head"><h3>Activity log</h3><span class="muted small">Latest 200 events · times in IST</span></div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Company</th><th>Detail</th></tr></thead><tbody>
        ${d.activity.map((x) => `<tr><td class="num nowrap">${esc(stamp(x.at))}</td><td>${esc(x.email || '–')}</td><td>${esc(ACTION_LABEL[x.action] || x.action)}</td><td>${esc(x.company_code || '')}</td><td class="muted">${esc(x.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No activity yet.</td></tr>'}
        </tbody></table></div></div>`;

    const role = page.querySelector('#u-role'); const cw = page.querySelector('#u-company-wrap');
    const syncRole = () => { cw.style.visibility = role.value === 'client' ? 'visible' : 'hidden'; };
    role.addEventListener('change', syncRole); syncRole();
    const oneTime = (name, email, pw) => `<div class="msg ok onetime"><b>One-time password for ${esc(name)}${email ? ' (' + esc(email) + ')' : ''}:</b>
      <code class="secret">${esc(pw)}</code> <button type="button" class="link-btn" data-copy="${esc(pw)}">Copy</button>
      <div class="small">Shown only once. Share it with them privately; they will be asked to choose their own password.</div></div>`;
    const wireCopy = () => page.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; }, () => {});
    }));
    wireCopy();
    page.querySelector('#f-company').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/admin/company', { code: page.querySelector('#c-code').value, name: page.querySelector('#c-name').value });
        const em = page.querySelector('#c-email').value.trim();
        if (em) await api.post('/api/admin/company/update', { company_id: r.company.id, data_email: em });
        state.adminNotice = `<div class="msg ok">${esc(r.company.code)} · ${esc(r.company.name)} added. Add the client's view-only logins next, then upload its first month under Data &amp; uploads.</div>`;
        const me = await api.get('/api/me'); state.companies = me.companies; if (!state.companyId) state.companyId = r.company.id;
        adminPage(page);
      } catch (err) { page.querySelector('#c-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    page.querySelector('#f-user').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = page.querySelector('#u-name').value; const email = page.querySelector('#u-email').value;
      try {
        const r = await api.post('/api/admin/user', { name, email, role: role.value, company_id: page.querySelector('#u-company').value });
        state.adminNotice = oneTime(name, email, r.temporaryPassword);
        adminPage(page);
      } catch (err) { page.querySelector('#u-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    page.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      openClient(Number(b.dataset.open), 'client');
    }));
    page.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => {
      const td = b.closest('tr').children[1];
      td.innerHTML = `<form class="btn-row" data-rf><input type="text" value="${esc(b.dataset.name)}" maxlength="160" aria-label="New company name" style="max-width:260px"><button class="btn small" type="submit">Save</button></form>`;
      const f = td.querySelector('form'); f.querySelector('input').focus();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/admin/company/update', { company_id: Number(b.dataset.rename), name: f.querySelector('input').value });
          const me = await api.get('/api/me'); state.companies = me.companies;
          state.adminNotice = '<div class="msg ok">Company renamed.</div>'; adminPage(page);
        } catch (err) { state.adminNotice = `<div class="msg err">${esc(err.message)}</div>`; adminPage(page); }
      });
    }));
    page.querySelectorAll('[data-email]').forEach((b) => b.addEventListener('click', () => {
      const td = b.closest('td');
      td.innerHTML = `<form class="btn-row" data-ef><input type="text" value="${esc(b.dataset.value)}" placeholder="accounts@client.com" aria-label="Accounts email" style="max-width:260px"><button class="btn small" type="submit">Save</button></form>`;
      const f = td.querySelector('form'); f.querySelector('input').focus();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/admin/company/update', { company_id: Number(b.dataset.email), data_email: f.querySelector('input').value });
          state.adminNotice = '<div class="msg ok">Accounts email saved. The monthly workbook goes to this address.</div>'; adminPage(page);
        } catch (err) { state.adminNotice = `<div class="msg err">${esc(err.message)}</div>`; adminPage(page); }
      });
    }));
    page.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      // Two-tap confirm: the first tap arms the button, the second carries it out.
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.dataset.label = b.textContent; b.textContent = 'Tap again to confirm'; b.classList.add('armed'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = b.dataset.label; b.classList.remove('armed'); } }, 4000); return; }
      try {
        const r = await api.post('/api/admin/user/action', { user_id: Number(b.dataset.id), action: b.dataset.act });
        state.adminNotice = r.temporaryPassword ? oneTime(b.dataset.name, '', r.temporaryPassword) : `<div class="msg ok">Done for ${esc(b.dataset.name)}.</div>`;
        adminPage(page);
      } catch (err) { state.adminNotice = `<div class="msg err">${esc(err.message)}</div>`; adminPage(page); }
    }));
  }

  // ---------- Data & uploads ----------
  // ---------- the team's work ----------
  const STEP_CHIP = { done: ['positive', 'Done'], overdue: ['critical', 'Overdue'], due: ['watch', 'To do'], later: ['info', 'Not yet'] };
  // Where each step is done in the portal.
  const STEP_TAB = { send: ['upload', 'Send the workbook'], receive: ['upload', 'Upload the returned copy'], upload: ['upload', 'Check and upload'], review: ['insights', 'Review explanations'] };
  const dayMonth = (iso) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}`;
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const whenText = (s, today) => (s.state === 'done' ? (s.at ? `Done ${dayMonth(String(s.at).slice(0, 10))}` : 'Done')
    : s.state === 'overdue' ? `Was due ${dayMonth(s.target)} · ${daysBetween(s.target, today)} day${daysBetween(s.target, today) === 1 ? '' : 's'} late`
    : `Due ${dayMonth(s.target)}`);
  const greeting = () => { const h = +new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
  let workView = { period: null };

  async function workPage(page) {
    const u = state.me;
    page.innerHTML = head('Monthly data', `${greeting()}, ${u.name.split(' ')[0]}`, null) + '<div id="work-body"><div class="card empty">Gathering your clients…</div></div>';
    let r;
    try { r = await api.get(`/api/cycle${workView.period ? `?period=${workView.period}` : ''}`); } catch (e) { page.querySelector('#work-body').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const body = page.querySelector('#work-body'); if (!body) return;
    const rows = r.clients;
    const reminders = [];
    rows.forEach((x) => x.status.steps.forEach((s) => { if (s.state === 'overdue' || s.state === 'due') reminders.push({ c: x.company, s }); }));
    reminders.sort((a, b) => (a.s.state === 'overdue' ? 0 : 1) - (b.s.state === 'overdue' ? 0 : 1) || a.s.target.localeCompare(b.s.target) || a.c.name.localeCompare(b.c.name));
    const count = (f) => rows.filter(f).length;
    const awaiting = count((x) => x.status.steps.some((s) => s.key === 'receive' && s.state !== 'done' && s.state !== 'later'));
    const COL = { send: 'Workbook sent', receive: 'Data received', upload: 'On dashboard', review: 'Explanations' };
    const stepCell = (x, key) => { const s = x.status.steps.find((t) => t.key === key); return `<td data-label="${COL[key]}">${chip(STEP_CHIP[s.state][0], STEP_CHIP[s.state][1])}</td>`; };
    const T = r.targets;
    body.innerHTML = `
      <div class="editor-bar work-bar"><div><label for="work-month">Month being worked on</label><input type="month" id="work-month" value="${r.period}"></div>
        <p class="muted small" style="margin:0;flex:1">${rows.length} client${rows.length === 1 ? '' : 's'}${r.assigned ? ' allotted to you' : ''}. Each month's data is due in the month after: workbook sent by the ${T.send}${T.send === 3 ? 'rd' : 'th'}, back from the accountant by the ${T.receive}th, on the dashboard by the ${T.upload}th and explanations reviewed by the ${T.review}th.</p></div>
      <div class="kpis work-stats">
        <div class="kpi"><div class="label">Overdue</div><div class="value${reminders.some((x) => x.s.state === 'overdue') ? ' late' : ''}">${reminders.filter((x) => x.s.state === 'overdue').length}</div><div class="delta">reminders past their date</div></div>
        <div class="kpi"><div class="label">To do</div><div class="value">${reminders.filter((x) => x.s.state === 'due').length}</div><div class="delta">due this month</div></div>
        <div class="kpi"><div class="label">Awaiting data</div><div class="value">${awaiting}</div><div class="delta">workbook with the accountant</div></div>
        <div class="kpi"><div class="label">Complete</div><div class="value">${count((x) => x.status.done)}<small> / ${rows.length}</small></div><div class="delta">${mLong(r.period)} done</div></div>
      </div>
      <div class="grid g-main section">
        <div class="card"><div class="card-head"><h3>Reminders</h3><span class="muted small">${mLong(r.period)}</span></div>
          ${reminders.length ? `<div class="rem-list">${reminders.map((x) => `
            <div class="rem ${x.s.state}">
              <div class="rem-main"><div class="rem-top">${chip(STEP_CHIP[x.s.state][0], STEP_CHIP[x.s.state][1])}<span class="hl-area">${esc(x.c.name)}</span></div>
                <div class="rem-title">${esc(x.s.label)}</div>
                <div class="muted small">${esc(whenText(x.s, r.today))}${x.s.detail ? ' · ' + esc(x.s.detail) : ''}</div></div>
              <div class="rem-act"><button class="btn secondary" type="button" data-open-client="${x.c.id}" data-tab-to="${STEP_TAB[x.s.key][0]}">${esc(STEP_TAB[x.s.key][1])}</button></div>
            </div>`).join('')}</div>` : `<p class="muted">Nothing pending for ${mLong(r.period)}. Every client's data is in and reviewed.</p>`}
        </div>
        <div class="card"><div class="card-head"><h3>What each step means</h3></div>
          <ol class="step-guide">
            <li><b>Workbook sent</b> From the client's Data &amp; uploads page, by email or as a download. Each copy is locked to the client and month.</li>
            <li><b>Data received</b> The accountant returns the workbook. Mark it received when it arrives, or upload it straight away.</li>
            <li><b>On the dashboard</b> The returned copy is checked against the client and month and accepted.</li>
            <li><b>Explanations reviewed</b> The month's suggested explanations are accepted or set aside, so the client reads only what the team has approved.</li>
          </ol>
        </div>
      </div>
      <div class="card section"><div class="card-head"><h3>Clients</h3><span class="muted small">Open a client to work on it and see its dashboard</span></div>
        <div class="table-wrap"><table class="work-table"><thead><tr><th>Client</th><th>Workbook sent</th><th>Data received</th><th>On dashboard</th><th>Explanations</th><th>Next step</th><th></th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td><b>${esc(x.company.name)}</b><div class="muted small">${esc(x.company.code)}</div></td>
          ${stepCell(x, 'send')}${stepCell(x, 'receive')}${stepCell(x, 'upload')}${stepCell(x, 'review')}
          <td class="small" data-label="Next step">${x.status.next ? esc(x.status.next.label) : '<span class="muted">All done</span>'}</td>
          <td class="r"><button class="link-btn" type="button" data-open-client="${x.company.id}" data-tab-to="client">Open ›</button></td></tr>`).join('')}
        </tbody></table></div>
        ${state.workflow ? '<p class="muted small" style="margin:10px 0 0">Allotments, tasks, approvals and sign-offs are in <a href="/workflow">Workflow</a>.</p>' : ''}
      </div>`;
    body.querySelector('#work-month').addEventListener('change', (e) => { workView.period = e.target.value || null; workPage(page); });
    body.querySelectorAll('[data-open-client]').forEach((b) => b.addEventListener('click', () => openClient(Number(b.dataset.openClient), b.dataset.tabTo)));
  }

  // One client's month: what is done, what is pending and who it is waiting on, before its dashboard.
  async function clientWorkPage(page, company) {
    const period = workView.period;
    page.innerHTML = head('This month\'s work', company.name, null, `<button class="btn secondary" type="button" data-to="overview">Open the dashboard ›</button>`) + '<div id="cw-body"><div class="card empty">Loading…</div></div>';
    page.querySelector('[data-to]').addEventListener('click', () => goTab('overview'));
    let r;
    try { r = await api.get(`/api/cycle?company=${company.id}${period ? `&period=${period}` : ''}`); } catch (e) { page.querySelector('#cw-body').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
    const body = page.querySelector('#cw-body'); if (!body) return;
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const st = r.status;
    const open = r.history.filter((w) => w.period === r.period && !w.received_at && !w.received_version);
    const action = (s) => {
      if (s.state === 'done' || s.state === 'later') return '';
      const go = `<button class="btn${s.state === 'overdue' ? '' : ' secondary'}" type="button" data-go-tab="${STEP_TAB[s.key][0]}">${esc(STEP_TAB[s.key][1])}</button>`;
      return s.key === 'receive' && open.length ? `<button class="btn secondary" type="button" data-received="${esc(open[0].ref)}">Mark as received</button>${go}` : go;
    };
    body.innerHTML = `
      <div class="grid g-main">
        <div class="card"><div class="card-head"><h3>${mLong(r.period)} data</h3>${st.done ? chip('positive', 'Complete') : st.overdue ? chip('critical', `${st.overdue} overdue`) : chip('watch', `${st.pending} to do`)}</div>
          <ol class="steps">${st.steps.map((s) => `
            <li class="step ${s.state}"><span class="dot" aria-hidden="true"></span>
              <div class="step-main"><div class="step-title">${esc(s.label)} ${s.state === 'done' ? '' : chip(STEP_CHIP[s.state][0], STEP_CHIP[s.state][1])}</div>
                <div class="muted small">${esc(whenText(s, today))}${s.detail ? ' · ' + esc(s.detail) : ''}</div></div>
              <div class="step-act">${action(s)}</div></li>`).join('')}
          </ol>
          <div id="cw-msg"></div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>What the client sees</h3></div>
            ${r.client_note ? `<div class="cycle-note${r.client_note.overdue ? ' late' : ''}"><b>${mLong(r.client_note.period)} figures</b><span>${esc(r.client_note.text)}</span></div>
              <p class="muted small" style="margin:10px 0 0">Shown on the client's dashboard until the month's data is in. It names no one and gives no internal detail.</p>`
              : `<p class="muted" style="margin:0">${mLong(r.period)} is on the client's dashboard${st.steps.find((s) => s.key === 'review').state === 'done' ? ' with its reviewed explanations.' : '. Explanations still to review are not shown to the client until they are accepted.'}</p>`}
          </div>
          ${state.workflow ? `<div class="card"><div class="card-head"><h3>Workflow</h3></div><p style="margin:0">Tasks, approvals and sign-offs for ${esc(company.name)} are in <a href="/workflow">Workflow</a>.</p></div>` : ''}
        </div>
      </div>
      <div class="card section"><div class="card-head"><h3>Workbooks sent</h3><span class="muted small">Every copy, with its reference</span></div>
        ${r.history.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Reference</th><th>How</th><th>Sent</th><th>Status</th></tr></thead><tbody>
          ${r.history.map((x) => `<tr><td>${mShort(x.period)}</td><td class="num nowrap">${esc(x.ref)}</td><td>${x.method === 'email' ? 'Emailed to ' + esc(x.sent_to || '') : 'Downloaded'}</td><td class="num nowrap">${esc(stamp(x.issued_at))}</td>
            <td>${x.received_version ? chip('positive', `Uploaded, v${x.received_version}`) : x.received_at ? chip('watch', 'Received, to upload') : chip('info', 'With the accountant')}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No workbooks sent yet. Send the first from Data &amp; uploads.</p>'}
      </div>`;
    body.querySelectorAll('[data-go-tab]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.goTab)));
    body.querySelectorAll('[data-received]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api.post('/api/workbooks/received', { company: company.id, ref: b.dataset.received }); clientWorkPage(page, company); }
      catch (e) { body.querySelector('#cw-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; b.disabled = false; }
    }));
  }

  function uploadPage(page, a, company) {
    const canUpload = isStaff(state.me);
    const hist = (state.history && state.history.uploads) || [];
    const liveVersion = {};
    hist.forEach((h) => { if (!liveVersion[h.period] || h.version > liveVersion[h.period]) liveVersion[h.period] = h.version; });
    const periods = (state.dash && state.dash.periods) || [];
    const schema = window.AE_SCHEMA;
    const tableSections = schema ? schema.sheets.filter((s) => s.layout === 'table') : [];
    // Default month: the last complete calendar month.
    const now = new Date(); const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    page.innerHTML = head('Data & uploads', company.name, null) + `
      <div class="grid g-2">
        <div class="card" id="wb-card"><div class="card-head"><h3>1. Send the monthly workbook</h3></div>
          <p style="margin-top:0">Each copy is made for ${esc(company.name)} and one month. The company, client code, month and a workbook reference are filled in and locked on its first sheet, and only that copy is accepted back for that month.</p>
          ${canUpload ? `<div class="form-row" style="margin-top:0"><div><label for="wb-month">Month</label><input type="month" id="wb-month" value="${lastMonth}"></div>
            <div><label>Sent to</label><div id="wb-to" class="wb-to muted">Loading…</div></div></div>
          <div class="btn-row" style="margin-top:12px"><button class="btn" id="wb-email" type="button">Email the workbook</button><button class="btn secondary" id="wb-download" type="button">Download a filled copy</button></div>
          <div id="wb-msg"></div>` : ''}
        </div>
        <div class="card"><div class="card-head"><h3>2. Upload the returned workbook</h3></div>
          ${canUpload ? `
          <div class="target"><span class="lbl">Uploading to</span><b>${esc(company.name)}</b><span class="code">${esc(company.code)}</span>
            <p class="muted small">The file is checked first and nothing changes until you accept it. It must be a workbook sent from this page for ${esc(company.name)}: its reference, company code, name and month must all match, and its customers and suppliers must not belong to another client.</p></div>
          <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose a file to check">
            <b>Drop the returned workbook here</b><br><span class="muted small">or click to choose. Excel (.xlsx) for the full month, or CSV for one section.</span>
            <input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
          </div>
          <div class="form-row hidden" id="csv-opts">
            <div><label for="csv-section">This CSV contains</label><select id="csv-section" class="field">${tableSections.map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('')}</select></div>
            <div><label for="csv-period">For the month</label><input type="month" id="csv-period" value="${periods.length ? periods[periods.length - 1] : ''}"></div>
            <div><label for="csv-code">Type the client code to confirm</label><input type="text" id="csv-code" placeholder="${esc(company.code)}" autocomplete="off" spellcheck="false"></div>
            <div style="align-self:end"><button class="btn" id="csv-go">Check CSV</button></div>
          </div>
          <div id="up-msg">${state.upload || ''}</div>
          ${window.AE_SAMPLE_URL ? `<p class="small" style="margin-top:12px">To try it, <a href="${window.AE_SAMPLE_URL}" download="AE-0001_Meridian_Polymers_2026-09_completed.xlsx">download a completed sample</a> (Meridian Polymers, September 2026) and drop it here with Meridian selected, then with Coastline selected to see it refused.</p>` : ''}
          <p class="muted small" style="margin-top:12px">Accepting a month that is already on record replaces it on the dashboard; the earlier version is kept below. To correct a few figures instead, use Edit data.</p>` : `<p>Your login can view the dashboard. Uploads are made by the Assura Elevate team.</p>`}
        </div>
      </div>
      ${canUpload ? '<div class="card section"><div class="card-head"><h3>Workbooks sent</h3><span class="muted small">Every copy, who sent it and whether it has come back</span></div><div id="wb-list"><p class="muted">Loading…</p></div></div>' : ''}
      <div class="card section"><div class="card-head"><h3>Months on record</h3><span class="muted small">${periods.length} month${periods.length === 1 ? '' : 's'}</span></div>
        <div class="hl-summary">${periods.map((p) => `<span class="chip outline">${mShort(p)}</span>`).join('') || '<span class="muted">None yet</span>'}</div>
      </div>
      <div class="card section"><div class="card-head"><h3>Version history</h3><span class="muted small">Every upload and edit is kept. The newest version of each month is the live one; restore any earlier version to make it live again.</span></div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>Month</th><th>Version</th><th>What</th><th>By</th><th>Checks</th><th></th></tr></thead><tbody>
        ${hist.map((h) => { const live = liveVersion[h.period] === h.version; return `<tr><td class="num nowrap">${esc(stamp(h.created_at))}</td><td>${mShort(h.period)}</td><td class="num">v${h.version}${live ? ' ' + (h.source === 'Month removed' ? chip('watch', 'Off dashboard') : chip('positive', 'Live')) : ''}</td>
          <td>${esc(h.source && h.source !== 'upload' ? h.source : 'Upload' + (h.filename ? ': ' + h.filename : ''))}</td><td>${esc(h.uploaded_by || 'Setup')}</td>
          <td>${h.warnings.length ? chip('watch', `${h.warnings.length} note${h.warnings.length > 1 ? 's' : ''}`) : chip('positive', 'Clean')}</td>
          <td class="r nowrap">${!live && h.source !== 'Month removed' ? `<button class="link-btn" data-restore="${h.version}" data-period="${h.period}">Restore this version</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No uploads yet.</td></tr>'}
        </tbody></table></div>
      </div>`;
    if (!canUpload) return;
    page.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to restore'; b.classList.add('armed'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Restore this version'; b.classList.remove('armed'); } }, 4000); return; }
      try {
        const r = await api.post('/api/data/restore', { company: state.companyId, period: b.dataset.period, version: Number(b.dataset.restore) });
        state.upload = `<div class="msg ok">${mLong(r.period)}: version ${b.dataset.restore} restored as version ${r.version}. The dashboard has been updated.</div>`;
        await loadDashboard();
      } catch (e) { page.querySelector('#up-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    }));
    const drop = page.querySelector('#drop'); const input = page.querySelector('#file');
    let pendingCsv = null;
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => input.files[0] && handle(input.files[0]));
    page.querySelector('#csv-go').addEventListener('click', () => pendingCsv && send(pendingCsv.name, { [pendingCsv.name]: pendingCsv.rows }, { section: page.querySelector('#csv-section').value, period: page.querySelector('#csv-period').value, confirm_code: page.querySelector('#csv-code').value }));
    workbooks(page, company);

    async function handle(file) {
      const msg = page.querySelector('#up-msg');
      if (!window.XLSX) { msg.innerHTML = `<div class="msg err">The spreadsheet reader did not load. Check your connection and reload.</div>`; return; }
      msg.innerHTML = `<div class="msg">Reading ${esc(file.name)}…</div>`;
      try {
        const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
        const sheets = {};
        wb.SheetNames.forEach((n) => { sheets[n] = window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }); });
        if (/\.csv$/i.test(file.name)) {
          pendingCsv = { name: file.name, rows: sheets[wb.SheetNames[0]] };
          const guess = tableSections.find((s) => file.name.toLowerCase().includes(s.key));
          if (guess) page.querySelector('#csv-section').value = guess.key;
          page.querySelector('#csv-opts').classList.remove('hidden');
          msg.innerHTML = `<div class="msg">${esc(file.name)} read: ${pendingCsv.rows.length} rows. A CSV does not name its company, so choose the section and month, type ${esc(company.code)} to confirm it is ${esc(company.name)}'s file, then check it.</div>`;
          return;
        }
        await send(file.name, sheets, {});
      } catch (e) { msg.innerHTML = `<div class="msg err">Could not read this file: ${esc(e.message)}</div>`; }
    }

    // Two steps: the server checks the file and returns a summary; the team reviews it and accepts.
    async function send(filename, sheets, extra) {
      const msg = page.querySelector('#up-msg');
      const payload = Object.assign({ company: state.companyId, filename, sheets }, extra);
      msg.innerHTML = '<div class="msg">Checking the file…</div>';
      let p;
      try { p = await api.post('/api/upload', Object.assign({ preview: true }, payload)); } catch (e) { msg.innerHTML = problems(e); return; }
      msg.innerHTML = `<div class="review">
        <div class="review-head"><span class="chip positive">${ICONS.positive}Checks passed</span><b>${esc(company.name)} · ${mLong(p.period)}</b></div>
        <ul class="review-checks">
          ${p.workbook ? `<li>Workbook ${esc(p.workbook.ref)}, sent ${esc(stamp(p.workbook.issued_at))}${p.workbook.sent_to ? ' to ' + esc(p.workbook.sent_to) : ''}${p.workbook.received_version ? `. <b>This copy was already accepted once</b> (version ${p.workbook.received_version}).` : ''}</li>` : `<li>${esc(p.sections.map((k) => (window.AE_SCHEMA.sheets.find((x) => x.key === k) || {}).name || k).join(', '))} for ${mLong(p.period)}, confirmed with the client code</li>`}
          <li>Company code, name and month match ${esc(company.code)}</li>
          <li>Customers and suppliers do not belong to another client</li>
          ${p.replaces ? `<li><b>Replaces version ${p.replaces}</b> of ${mLong(p.period)} on the dashboard (it stays in the history)</li>` : `<li>New month for the dashboard</li>`}
        </ul>
        <table class="review-table"><tbody>${p.summary.sections.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.rows} rows</td></tr>`).join('')}
          ${p.summary.totals.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${esc(inr(v))}</td></tr>`).join('')}</tbody></table>
        ${p.warnings.length ? `<div class="msg"><b>Notes to look at</b><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        <div class="btn-row" style="margin-top:12px"><button class="btn" type="button" data-accept>Accept into the dashboard</button><button class="btn secondary" type="button" data-cancel>Cancel</button></div></div>`;
      msg.querySelector('[data-cancel]').addEventListener('click', () => { msg.innerHTML = '<div class="msg">Cancelled. Nothing was changed.</div>'; });
      msg.querySelector('[data-accept]').addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        try {
          const r = await api.post('/api/upload', payload);
          state.upload = `<div class="msg ok"><b>${mLong(r.period)} accepted (version ${r.version}).</b> The dashboard and highlights have been updated. Review the month's explanations under Explanations before the client reads them.</div>`;
          await loadDashboard();
        } catch (e) { msg.innerHTML = problems(e); }
      });
    }
    function problems(e) {
      const errs = (e.data && e.data.errors) || [];
      return `<div class="msg err"><b>${esc(e.message)}</b>${errs.length ? `<ul>${errs.slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join('')}${errs.length > 12 ? `<li>and ${errs.length - 12} more</li>` : ''}</ul>` : ''}</div>`;
    }
  }

  // Monthly workbook: who it goes to, sending it, and every copy sent so far.
  async function workbooks(page, company) {
    const toEl = page.querySelector('#wb-to'); const list = page.querySelector('#wb-list'); const msg = page.querySelector('#wb-msg');
    if (!toEl) return;
    let w;
    try { w = await api.get(`/api/workbooks?company=${company.id}`); } catch (e) { toEl.textContent = e.message; return; }
    if (!toEl.isConnected) return;
    toEl.innerHTML = w.data_email ? `<b>${esc(w.data_email)}</b>` : `<span>No accounts email saved. <a href="#" data-go="admin">Add it under Clients &amp; users</a>.</span>`;
    const emailBtn = page.querySelector('#wb-email');
    if (!w.mail_ready) { emailBtn.disabled = true; emailBtn.title = 'Email is not set up on this server yet'; if (!msg.innerHTML) msg.innerHTML = '<p class="muted small" style="margin:10px 0 0">Email is not set up on this server yet, so download a filled copy and send it from your mailbox. Each download is recorded with its own reference.</p>'; }
    else if (!w.data_email) emailBtn.disabled = true;
    const go = page.querySelector('#wb-card [data-go]'); if (go) go.addEventListener('click', (e) => { e.preventDefault(); goTab('admin'); });
    const STATUS = (x) => (x.received_version ? chip('positive', `Uploaded, v${x.received_version}`) : x.received_at ? chip('watch', 'Received, to upload') : chip('watch', 'Awaiting return'));
    list.innerHTML = w.workbooks.length ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Reference</th><th>How</th><th>By</th><th>When</th><th>Status</th></tr></thead><tbody>
      ${w.workbooks.map((x) => `<tr><td>${mShort(x.period)}</td><td class="num nowrap">${esc(x.ref)}</td><td>${x.method === 'email' ? 'Emailed to ' + esc(x.sent_to || '') : 'Downloaded'}</td><td>${esc(x.issued_by || '–')}</td><td class="num nowrap">${esc(stamp(x.issued_at))}</td><td>${STATUS(x)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No workbooks sent for this client yet.</p>';
    const issue = async (method, btn) => {
      const period = page.querySelector('#wb-month').value;
      if (!period) { msg.innerHTML = '<div class="msg err">Choose the month.</div>'; return; }
      btn.disabled = true;
      try {
        const r = await api.post('/api/workbooks/send', { company: company.id, period, method });
        if (r.file) {
          const bytes = Uint8Array.from(atob(r.file), (c) => c.charCodeAt(0));
          const link = document.createElement('a');
          link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
          link.download = r.filename; document.body.appendChild(link); link.click(); setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 500);
        }
        msg.innerHTML = `<div class="msg ok">${r.method === 'email' ? `${mLong(r.period)} workbook emailed to ${esc(r.sent_to.join(', '))}${r.demo ? ' (in this demo nothing is actually sent)' : ''}.` : `${mLong(r.period)} workbook downloaded as ${esc(r.filename)}.`} Reference ${esc(r.ref)}.</div>`;
        workbooks(page, company);
      } catch (e) { msg.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      btn.disabled = false;
    };
    if (!emailBtn.dataset.wired) {
      emailBtn.dataset.wired = '1';
      emailBtn.addEventListener('click', () => issue('email', emailBtn));
      const dl = page.querySelector('#wb-download'); dl.addEventListener('click', () => issue('download', dl));
    }
  }

  // Charts are drawn at the container's width; redraw when the window size changes.
  let resizeTimer; let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.me && state.dash && window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; render(); } }, 200);
  });

  boot();
})();
