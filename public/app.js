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

  const state = { me: null, companies: [], companyId: null, dash: null, tab: 'overview', showAllHighlights: false, upload: null };
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

  // The logo sits on navy (top bar, login panel), so the light-on-dark cut is used.
  const LOGO = `<img src="${window.AE_LOGO_ON_DARK || '/brand/assura-elevate-logo-on-dark.png'}" alt="Assura Elevate">`;

  // ---------- data loading ----------
  async function boot() {
    try {
      if (!window.AE_SCHEMA) window.AE_SCHEMA = await fetch('/shared/schema.json').then((r) => r.json()).catch(() => null);
      const me = await api.get('/api/me');
      state.me = me.user; state.companies = me.companies;
      state.companyId = state.companyId && me.companies.some((c) => c.id === state.companyId) ? state.companyId : (me.companies[0] || {}).id;
      await loadDashboard();
    } catch (e) {
      if (e.status === 401) { state.me = null; renderLogin(); } else renderFatal(e);
    }
  }
  async function loadDashboard() {
    if (!state.companyId) { state.dash = null; render(); return; }
    state.dash = await api.get(`/api/dashboard?company=${state.companyId}`);
    state.history = await api.get(`/api/uploads?company=${state.companyId}`);
    render();
  }

  // ---------- login ----------
  function renderLogin(error) {
    const demo = window.AE_DEMO_API ? `
      <div class="demo-box"><b>Demo logins</b> (fictional sample companies). Password for all: <code>demo-password</code><br>
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
          <p class="small">We don't replace your accountant. We elevate your finance function.</p>
        </section>
        <section class="login-form">
          <form id="login" autocomplete="on">
            <div><div class="eyebrow">Client login</div><h2>Sign in</h2></div>
            <div><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
            <div><label for="pw">Password</label><input id="pw" type="password" required autocomplete="current-password"></div>
            ${error ? `<div class="msg err">${esc(error)}</div>` : ''}
            <button class="btn" type="submit">Sign in</button>
            <p class="small muted">Each login sees only its own company's data. Contact your Assura Elevate partner for access.</p>
            ${demo}
          </form>
        </section>
      </div>`;
    app.querySelectorAll('[data-email]').forEach((b) => b.addEventListener('click', () => {
      app.querySelector('#email').value = b.dataset.email; app.querySelector('#pw').value = 'demo-password';
    }));
    app.querySelector('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        await api.post('/api/login', { email: app.querySelector('#email').value.trim(), password: app.querySelector('#pw').value });
        state.tab = 'overview';
        await boot();
      } catch (err) { renderLogin(err.message); }
    });
  }

  function renderFatal(e) {
    app.innerHTML = `<main><div class="card empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" id="reload">Reload</button></div></main>`;
    app.querySelector('#reload').addEventListener('click', () => location.reload());
  }

  // ---------- shell ----------
  const TABS = [
    ['overview', 'Overview'], ['money', 'Where is the money?'], ['sales', 'Sales & customers'],
    ['expenses', 'Expenses'], ['compliance', 'Compliance & governance'], ['upload', 'Data & uploads'],
  ];

  function render() {
    C.hideTip();
    const u = state.me;
    const company = state.companies.find((c) => c.id === state.companyId);
    app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="wordmark" href="#">${LOGO}</a>
        <span class="spacer"></span>
        ${u.role === 'advisor' && state.companies.length ? `<select id="company" aria-label="Company">${state.companies.map((c) => `<option value="${c.id}" ${c.id === state.companyId ? 'selected' : ''}>${esc(c.code)} · ${esc(c.name)}</option>`).join('')}</select>` : ''}
        <div class="user-chip">${esc(u.name)}<br><span>${esc({ viewer: 'Management', accountant: 'Finance team', advisor: 'Assura Elevate advisor' }[u.role])}${company && u.role !== 'advisor' ? ' · ' + esc(company.code) : ''}</span></div>
        <button class="btn-ghost" id="logout">Sign out</button>
      </div></header>
      <nav class="tabs" aria-label="Sections"><div class="tabs-inner" role="tablist">
        ${TABS.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join('')}
      </div></nav>
      <main id="page"></main>`;
    app.querySelector('#logout').addEventListener('click', async () => { await api.post('/api/logout'); state.me = null; state.companyId = null; state.dash = null; state.upload = null; state.tab = 'overview'; renderLogin(); });
    const sel = app.querySelector('#company');
    if (sel) sel.addEventListener('change', async () => { state.companyId = Number(sel.value); state.upload = null; await loadDashboard(); });
    app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.showAllHighlights = false; render(); window.scrollTo(0, 0); }));

    const page = app.querySelector('#page');
    if (!company) { page.innerHTML = `<div class="card empty">No company is linked to this login yet.</div>`; return; }
    const a = state.dash && state.dash.analysis;
    if (state.tab !== 'upload' && (!a || !a.months.length)) {
      page.innerHTML = `<div class="card empty"><h2>No data yet</h2><p>Once your accountant uploads the first monthly workbook, the dashboard builds itself here.</p>
        <button class="btn" data-go="upload">Go to Data & uploads</button></div>`;
      page.querySelector('[data-go]').addEventListener('click', () => { state.tab = 'upload'; render(); });
      return;
    }
    ({ overview, money, sales, expenses, compliance, upload: uploadPage })[state.tab](page, a, company);
    page.insertAdjacentHTML('beforeend', `<footer class="page-foot"><span>Prepared from data provided by your finance team. Figures are management estimates and unaudited.</span><span>Built for businesses ready for their next stage.</span></footer>`);
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
      const tile = document.createElement('div'); tile.className = 'kpi';
      tile.innerHTML = `<div class="label">${esc(d.label)}</div><div class="value">${esc(d.fmt(cur[d.key]))}</div>${delta(cur[d.key], prev && prev[d.key], d)}`;
      tile.appendChild(C.sparkline(ms.map((m) => m[d.key])));
      wrap.appendChild(tile);
    });
    container.appendChild(wrap);
  }

  function highlightList(list, limit) {
    const shown = limit ? list.slice(0, limit) : list;
    return `<div class="hl-list">${shown.map((h) => `
      <article class="hl ${h.severity}">
        <div class="hl-top">${chip(h.severity)}<span class="hl-area">${esc(h.area)}</span></div>
        <div class="hl-title">${esc(h.title)}</div>
        <div class="hl-detail">${esc(h.detail)}</div>
        ${h.action ? `<div class="hl-action"><b>For management review:</b> ${esc(h.action)}</div>` : ''}
      </article>`).join('')}</div>`;
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

  // ---------- Overview ----------
  function overview(page, a, company) {
    const ms = a.months; const cur = ms[ms.length - 1];
    const counts = ['critical', 'watch', 'positive', 'info'].map((s) => [s, a.highlights.filter((h) => h.severity === s).length]).filter((x) => x[1]);
    page.innerHTML = head('Management dashboard', company.name, a) + `<div id="kpis"></div>
      <div class="grid g-main section">
        <div class="card">
          <div class="card-head"><h3>Highlights this month</h3><div class="hl-summary">${counts.map(([s, n]) => chip(s, `${n} ${SEV_LABEL[s]}`)).join('')}</div></div>
          <p class="muted small" style="margin:-6px 0 12px">Found automatically by comparing this month with your own history: trends, ageing, concentration, unusual spend and due dates.</p>
          <div id="hl">${a.highlights.length ? highlightList(a.highlights, state.showAllHighlights ? 0 : 6) : '<p class="muted">Nothing unusual this month.</p>'}</div>
          ${a.highlights.length > 6 ? `<button class="hl-more" id="hl-more" style="margin-top:10px;width:100%">${state.showAllHighlights ? 'Show fewer' : `Show all ${a.highlights.length} highlights`}</button>` : ''}
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>Six-month direction</h3></div>
            <table><tbody>${a.trends.map((t) => `<tr><td>${esc(t.label)}</td><td class="r">${t.dir === 'flat' ? '<span class="muted">Flat</span>' : `<span class="chip ${t.tone === 'good' ? 'positive' : t.tone === 'bad' ? 'watch' : 'info'}">${t.dir === 'rising' ? '▲ Rising' : '▼ Falling'}</span>`}</td><td class="r muted small">${t.dir === 'flat' ? '' : esc(t.perMonth.replace('-', '')) + ' a month'}</td></tr>`).join('')}</tbody></table>
          </div>
          <div class="card"><div class="card-head"><h3>Compliance health</h3><a href="#" data-go="compliance" class="small">Details</a></div>
            <table><tbody>${Object.entries(a.latest.complianceByArea).map(([area, st]) => `<tr><td>${esc(area)}</td><td class="r">${chip(STATE_CHIP[st][0], STATE_CHIP[st][1])}</td></tr>`).join('') || '<tr><td class="muted">No compliance items in this upload.</td></tr>'}</tbody></table>
          </div>
          ${a.latest.notes ? `<div class="card"><div class="card-head"><h3>Accountant's note</h3></div><p style="margin:0">${esc(a.latest.notes)}</p></div>` : ''}
        </div>
      </div>
      <div class="grid g-2 section">
        ${card('Revenue and gross profit', 'Monthly, ₹', 'c-rev', legend([['Revenue', 'var(--series-1)'], ['Gross profit', 'var(--series-3)']]))}
        ${card('Margins', '% of revenue', 'c-margin', legend([['Gross margin', 'var(--series-1)'], ['Net margin (estimate)', 'var(--series-3)']]))}
      </div>
      <div class="section card"><div class="card-head"><h3>Platform status</h3></div>
        <div class="status-list">
          <div><b>Currently available</b><ul>
            <li>Monthly data collection workbook (Excel), Tally-export friendly</li>
            <li>Secure login for each company: management, finance team and Assura advisor roles</li>
            <li>Dashboard rebuilt on every upload, with full month-on-month history</li>
            <li>Automated highlights: trends, ageing, concentration, unusual spend, purchase rates, compliance due dates</li></ul></div>
          <div><b>Planned</b><ul>
            <li>AI-written monthly commentary for the management review</li>
            <li>Email and WhatsApp alerts for critical highlights</li>
            <li>Direct Tally integration (today: Excel/CSV upload)</li>
            <li>Board pack PDF export, statutory registers and minutes repository</li></ul></div>
        </div>
      </div>`;
    kpiTiles(page.querySelector('#kpis'), a, [
      { label: 'Revenue', key: 'revenue', fmt: inr },
      { label: 'Gross margin', key: 'gmPct', fmt: (v) => pctTxt(v), asPts: true },
      { label: 'Net profit (estimate)', key: 'netProfit', fmt: inr },
      { label: 'Net cash', key: 'netCash', fmt: inr },
      { label: 'Receivables', key: 'receivables', fmt: inr, goodUp: false },
      { label: 'Payables', key: 'payables', fmt: inr, goodUp: false },
      { label: 'Inventory', key: 'inventory', fmt: inr, goodUp: false },
    ]);
    const labels = mAxis(ms.map((m) => m.period)); const full = ms.map((m) => mLong(m.period));
    C.columns(page.querySelector('#c-rev'), { labels, fullLabels: full, format: inr, axisFormat: axisInr, title: 'Revenue and gross profit by month',
      series: [{ name: 'Revenue', values: ms.map((m) => m.revenue), color: 'var(--series-1)' }, { name: 'Gross profit', values: ms.map((m) => m.grossProfit), color: 'var(--series-3)' }] });
    C.lines(page.querySelector('#c-margin'), { labels, fullLabels: full, format: (v) => pctTxt(v), axisFormat: (v) => (v * 100).toFixed(0) + '%', title: 'Margins by month',
      series: [{ name: 'Gross margin', values: ms.map((m) => m.gmPct), color: 'var(--series-1)' }, { name: 'Net margin (estimate)', values: ms.map((m) => m.npPct), color: 'var(--series-3)' }] });
    page.querySelector('#c-rev').insertAdjacentHTML('beforeend', `<details class="data-view"><summary>View as table</summary>${dataTable(['Month', 'Revenue', 'Gross profit', 'Gross margin', 'Expenses', 'Net profit'], ms.map((m) => [mShort(m.period), inr(m.revenue), inr(m.grossProfit), pctTxt(m.gmPct), inr(m.opex), inr(m.netProfit)]))}</details>`);
    const more = page.querySelector('#hl-more');
    if (more) more.addEventListener('click', () => { state.showAllHighlights = !state.showAllHighlights; render(); });
    page.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); state.tab = x.dataset.go; render(); }));
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
          <div class="cell"><div class="muted small">Cash and bank</div><div class="v">${inr(cur.cash)}</div></div>
          <div class="cell"><div class="muted small">With customers (receivables)</div><div class="v">${inr(cur.receivables)}</div></div>
          <div class="cell"><div class="muted small">In stock (inventory)</div><div class="v">${inr(cur.inventory)}</div></div>
          <div class="cell out"><div class="muted small">Owed to suppliers</div><div class="v">−${inr(cur.payables)}</div></div>
          <div class="cell out"><div class="muted small">Bank OD / CC drawn</div><div class="v">−${inr(cur.odUsed)}</div></div>
          <div class="cell total"><div class="muted small">Locked in receivables and stock</div><div class="v">${inr(locked)}</div><div class="small muted">${pctTxt(locked / ((cur.revenue || 1) * 12), 0)} of annualised revenue</div></div>
        </div>
      </div>
      <div class="card section"><div class="card-head"><h3>Working capital cycle</h3><span class="muted small">Based on the trailing three months</span></div>
        <div class="ratio">
          <div><span class="muted small">Customers pay in</span><b>${days(cur.dso)}</b>${cmp('dso', false)}</div>
          <div><span class="muted small">Stock is held for</span><b>${days(cur.dio)}</b>${cmp('dio', false)}</div>
          <div><span class="muted small">Suppliers paid in</span><b>${days(cur.dpo)}</b>${cmp('dpo', true)}</div>
          <div><span class="muted small">Cash conversion cycle</span><b>${days(cur.ccc)}</b>${cmp('ccc', false)}</div>
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
    C.lines(page.querySelector('#c-days'), { labels, fullLabels: full, height: 180, format: days, axisFormat: (v) => v.toFixed(0) + 'd', title: 'Working capital days',
      series: [{ name: 'Customers pay in', values: ms.map((m) => m.dso), color: 'var(--series-1)' }, { name: 'Stock held for', values: ms.map((m) => m.dio), color: 'var(--series-3)' }, { name: 'Suppliers paid in', values: ms.map((m) => m.dpo), color: 'var(--series-2)', dashed: true }] });
    const ageParts = (obj, keys, labelsMap) => keys.map((k, i) => ({ label: labelsMap ? labelsMap[i] : `${k} days`, value: obj[k] || 0, color: SEQ[i] }));
    const ra = page.querySelector('#c-ra');
    C.stack(ra, ageParts(L.recvAgeing, ['0-30', '31-60', '61-90', '90+']), inr);
    ra.insertAdjacentHTML('beforeend', L.topOverdue.length ? `<h3 style="margin:18px 0 8px">Largest balances over 90 days</h3>` : '<p class="muted small" style="margin-top:14px">No balances over 90 days.</p>');
    if (L.topOverdue.length) C.hbars(ra, L.topOverdue, inr);
    const ia = page.querySelector('#c-ia');
    C.stack(ia, ageParts(L.invAgeing, ['0-90', '91-180', '181-365', '365+']), inr);
    ia.insertAdjacentHTML('beforeend', L.slowStock.length ? `<h3 style="margin:18px 0 8px">Stock not moved for 6+ months</h3>` : '<p class="muted small" style="margin-top:14px">No stock older than six months.</p>');
    if (L.slowStock.length) C.hbars(ia, L.slowStock.map((s) => ({ name: s.name, value: s.value, note: `${s.days} days` })), inr);
    C.stack(page.querySelector('#c-pa'), ageParts(L.payAgeing, ['0-30', '31-60', '61-90', '90+']), inr);
    page.querySelector('#c-pa').insertAdjacentHTML('beforeend', `<p class="muted small" style="margin-top:14px">Payments to micro and small enterprise suppliers beyond 45 days can affect tax deductibility (Section 43B(h)). Keep supplier MSME status up to date.</p>`);
    C.lines(page.querySelector('#c-wc'), { labels, fullLabels: full, format: inr, axisFormat: axisInr, zero: true, title: 'Working capital components',
      series: [{ name: 'Receivables', values: ms.map((m) => m.receivables), color: 'var(--series-1)' }, { name: 'Inventory', values: ms.map((m) => m.inventory), color: 'var(--series-3)' }, { name: 'Payables', values: ms.map((m) => m.payables), color: 'var(--series-2)', dashed: true }] });
    page.querySelector('#t-cash').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th class="r">Closing balance</th><th class="r">Limit</th><th class="r">Utilised</th></tr></thead><tbody>
      ${L.cashAccounts.map((c) => `<tr><td>${esc(c.account)}</td><td>${esc(c.type)}</td><td class="r">${inr(c.closing)}</td><td class="r">${c.limit ? inr(c.limit) : '–'}</td><td class="r">${c.limit && c.closing < 0 ? pctTxt(-c.closing / c.limit, 0) : '–'}</td></tr>`).join('')}</tbody></table></div>`;
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
      { label: 'Revenue', key: 'revenue', fmt: inr },
      { label: 'Customers billed', key: 'customerCount', fmt: (v) => String(v) },
      { label: 'Invoices', key: 'invoiceCount', fmt: (v) => String(v) },
      { label: 'Average invoice', key: 'avgInvoice', fmt: inr },
      { label: 'B2B share', key: 'b2bShare', fmt: (v) => pctTxt(v, 0), asPts: true },
      { label: 'Largest customer share', key: 'topCustomerShare', fmt: (v) => pctTxt(v, 0), asPts: true, goodUp: false },
    ]);
    C.hbars(page.querySelector('#c-cust'), L.topCustomers.map((c) => ({ name: c.name, value: c.value, note: pctTxt(c.value / cur.revenue, 0) })), inr);
    C.hbars(page.querySelector('#c-prod'), L.productMix.map((c) => ({ name: c.name, value: c.value, note: pctTxt(c.value / cur.revenue, 0) })), inr);
    if (L.regionMix.length) C.hbars(page.querySelector('#c-reg'), L.regionMix.map((c) => ({ name: c.name, value: c.value, note: pctTxt(c.value / cur.revenue, 0) })), inr);
    else page.querySelector('#c-reg').innerHTML = '<p class="muted">Add the Region / State column in the Sales sheet to see this.</p>';
    const labels = mAxis(ms.map((m) => m.period));
    C.lines(page.querySelector('#c-conc'), { labels, fullLabels: ms.map((m) => mLong(m.period)), format: (v) => pctTxt(v, 0), axisFormat: (v) => (v * 100).toFixed(0) + '%', title: 'Customer concentration',
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
      { label: 'Operating expenses', key: 'opex', fmt: inr, goodUp: false },
      { label: 'Purchases', key: 'purchases', fmt: inr, goodUp: false },
      { label: 'Cost of goods sold', key: 'cogs', fmt: inr, goodUp: false },
      { label: 'Net profit (estimate)', key: 'netProfit', fmt: inr },
    ]);
    C.columns(page.querySelector('#c-grp'), { labels: groups.map((g) => g.split(' ')[0]), fullLabels: groups, format: inr, axisFormat: axisInr, title: 'Expenses by group',
      series: [{ name: mShort(cur.period), values: groups.map((g) => cur.expenseByGroup[g] || 0), color: 'var(--series-1)' }, { name: 'Prior average', values: groups.map(avg), color: 'var(--series-2)' }] });
    C.lines(page.querySelector('#c-ratio'), { labels: mAxis(ms.map((m) => m.period)), fullLabels: ms.map((m) => mLong(m.period)), format: (v) => pctTxt(v), axisFormat: (v) => (v * 100).toFixed(0) + '%', title: 'Expenses as share of revenue',
      series: [{ name: 'Operating expenses / revenue', values: ms.map((m) => (m.revenue ? m.opex / m.revenue : null)), color: 'var(--series-1)' }] });
    page.querySelector('#t-heads').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Head</th><th>Group</th><th class="r">Amount</th><th class="r">% of revenue</th></tr></thead><tbody>
      ${L.expenseHeads.map((e) => `<tr><td>${esc(e.head)}</td><td>${esc(e.group)}</td><td class="r">${inr(e.amount)}</td><td class="r">${pctTxt(e.amount / cur.revenue)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Compliance & governance ----------
  function compliance(page, a, company) {
    const L = a.latest;
    const order = { overdue: 0, 'due-soon': 1, pending: 2, done: 3, na: 4 };
    const items = L.compliance.slice().sort((x, y) => order[x.state] - order[y.state] || x.due_date.localeCompare(y.due_date));
    page.innerHTML = head('Compliance & governance', company.name, a) + `
      <div class="card"><div class="card-head"><h3>Status by area</h3><span class="muted small">As reported in the ${mLong(L.period)} workbook, checked against today's date</span></div>
        <div class="comp-areas">${Object.entries(L.complianceByArea).map(([area, st]) => `<div class="comp-area"><span class="name">${esc(area)}</span>${chip(STATE_CHIP[st][0], STATE_CHIP[st][1])}</div>`).join('')}</div>
      </div>
      <div class="card section"><div class="card-head"><h3>Compliance calendar</h3></div>
        <div class="table-wrap"><table><thead><tr><th>Area</th><th>Item</th><th>Period</th><th>Due</th><th>Status</th><th>Filed / paid on</th><th>Remarks</th></tr></thead><tbody>
        ${items.map((c) => `<tr><td>${esc(c.area)}</td><td>${esc(c.item)}</td><td>${esc(c.period_covered || '')}</td><td class="num">${dLong(c.due_date)}</td>
          <td>${chip(STATE_CHIP[c.state][0], STATE_CHIP[c.state][1])}${c.late ? ' ' + chip('watch', 'Filed late') : ''}</td><td class="num">${dLong(c.done_on)}</td><td>${esc(c.remarks || '')}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="muted small" style="margin-top:12px">Assura Elevate reviews this calendar each month. Statutory registers, minutes and resolutions are maintained as part of the governance engagement; an online repository for them is planned.</p>
      </div>`;
  }

  // ---------- Data & uploads ----------
  function uploadPage(page, a, company) {
    const canUpload = state.me.role !== 'viewer';
    const hist = (state.history && state.history.uploads) || [];
    const periods = (state.dash && state.dash.periods) || [];
    const schema = window.AE_SCHEMA;
    const tableSections = schema ? schema.sheets.filter((s) => s.layout === 'table') : [];
    page.innerHTML = head('Data & uploads', company.name, null) + `
      <div class="grid g-2">
        <div class="card"><div class="card-head"><h3>1. Monthly data workbook</h3></div>
          <p style="margin-top:0">Your accountant fills one workbook a month: sales and purchase registers, expenses, receivables, payables, stock, bank balances and compliance status. Each sheet says which Tally report to paste from.</p>
          ${window.AE_TEMPLATE_NOTE ? `<p class="small">${window.AE_TEMPLATE_NOTE}</p>` : `<a class="btn secondary" href="/template.xlsx" download="Assura_Elevate_Monthly_Data_Template.xlsx">Download the blank workbook</a>`}
          <p class="muted small">Company code for this workbook: <b>${esc(company.code)}</b></p>
        </div>
        <div class="card"><div class="card-head"><h3>2. Upload</h3></div>
          ${canUpload ? `
          <div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose a file to upload">
            <b>Drop the completed workbook here</b><br><span class="muted small">or click to choose. Excel (.xlsx) for the full month, or CSV for one section.</span>
            <input type="file" id="file" accept=".xlsx,.xls,.csv" hidden>
          </div>
          <div class="form-row hidden" id="csv-opts">
            <div><label for="csv-section">This CSV contains</label><select id="csv-section" class="field">${tableSections.map((s) => `<option value="${s.key}">${esc(s.name)}</option>`).join('')}</select></div>
            <div><label for="csv-period">For the month</label><input type="month" id="csv-period" value="${periods.length ? periods[periods.length - 1] : ''}"></div>
            <div style="align-self:end"><button class="btn" id="csv-go">Upload CSV</button></div>
          </div>
          <div id="up-msg">${state.upload || ''}</div>` : `<p>Your login can view the dashboard. Uploads are made by your finance team.</p>`}
        </div>
      </div>
      <div class="card section"><div class="card-head"><h3>Months on record</h3><span class="muted small">${periods.length} month${periods.length === 1 ? '' : 's'}</span></div>
        <div class="hl-summary">${periods.map((p) => `<span class="chip outline">${mShort(p)}</span>`).join('') || '<span class="muted">None yet</span>'}</div>
      </div>
      <div class="card section"><div class="card-head"><h3>Upload history</h3><span class="muted small">Re-uploading a month replaces it on the dashboard; earlier versions are kept</span></div>
        <div class="table-wrap"><table><thead><tr><th>Uploaded</th><th>Month</th><th>Version</th><th>File</th><th>By</th><th>Sections</th><th>Checks</th></tr></thead><tbody>
        ${hist.map((h) => `<tr><td class="num">${esc(stamp(h.created_at))}</td><td>${mShort(h.period)}</td><td class="num">v${h.version}</td><td>${esc(h.filename || '')}</td><td>${esc(h.uploaded_by || 'Setup')}</td><td>${h.sections.length}</td><td>${h.warnings.length ? chip('watch', `${h.warnings.length} note${h.warnings.length > 1 ? 's' : ''}`) : chip('positive', 'Clean')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No uploads yet.</td></tr>'}
        </tbody></table></div>
      </div>`;
    if (!canUpload) return;
    const drop = page.querySelector('#drop'); const input = page.querySelector('#file');
    let pendingCsv = null;
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => input.files[0] && handle(input.files[0]));
    page.querySelector('#csv-go').addEventListener('click', () => pendingCsv && send(pendingCsv.name, { [pendingCsv.name]: pendingCsv.rows }, { section: page.querySelector('#csv-section').value, period: page.querySelector('#csv-period').value }));

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
          msg.innerHTML = `<div class="msg">${esc(file.name)} read: ${pendingCsv.rows.length} rows. Choose the section and month, then upload.</div>`;
          return;
        }
        await send(file.name, sheets, {});
      } catch (e) { msg.innerHTML = `<div class="msg err">Could not read this file: ${esc(e.message)}</div>`; }
    }

    async function send(filename, sheets, extra) {
      const msg = page.querySelector('#up-msg');
      msg.innerHTML = `<div class="msg">Checking and uploading…</div>`;
      try {
        const r = await api.post('/api/upload', Object.assign({ company: state.companyId, filename, sheets }, extra));
        state.upload = `<div class="msg ok"><b>${mLong(r.period)} uploaded (version ${r.version}).</b> The dashboard and highlights have been updated.
          ${r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>`;
        await loadDashboard();
      } catch (e) {
        const errs = (e.data && e.data.errors) || [];
        msg.innerHTML = `<div class="msg err"><b>${esc(e.message)}</b>${errs.length ? `<ul>${errs.slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join('')}${errs.length > 12 ? `<li>and ${errs.length - 12} more</li>` : ''}</ul>` : ''}</div>`;
      }
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
