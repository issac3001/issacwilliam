/*
 * In-browser stand-in for the server API, used only by the shareable demo page.
 * Mirrors the server's access rules: viewers and accountants see only their own
 * company, viewers cannot upload, advisors see every company and manage logins.
 * Two-step login and the first-login password change run on the real server only. Data resets on reload.
 */
(function () {
  'use strict';
  const D = window.AE_DEMO_DATA; // { companies: [{id, code, name, months: {period: data}}] }
  const users = [
    { id: 1, email: 'md@meridian.demo', name: 'Managing Director', role: 'viewer', company_id: 1, note: 'Meridian Polymers, management view' },
    { id: 2, email: 'accounts@meridian.demo', name: 'Accounts Team', role: 'accountant', company_id: 1, note: 'Meridian Polymers, can upload' },
    { id: 3, email: 'md@coastline.demo', name: 'Managing Director', role: 'viewer', company_id: 2, note: 'Coastline Foods, management view' },
    { id: 4, email: 'advisor@assura.demo', name: 'Assura Advisor', role: 'advisor', company_id: null, note: 'All client companies' },
  ];
  const uploads = []; // { company_id, period, version, filename, sections, warnings, data, created_at, uploaded_by }
  D.companies.forEach((c) => Object.keys(c.months).sort().forEach((p) => uploads.push({
    company_id: c.id, period: p, version: 1, filename: `sample ${p}.xlsx`, sections: Object.keys(c.months[p]), warnings: [], data: c.months[p], created_at: '2026-10-07T04:30:00Z', uploaded_by: null,
  })));
  let session = null;
  const audit = [];
  const log = (u, action, companyId, detail) => audit.unshift({ at: new Date().toISOString(), email: u ? u.email : null, action, company_code: (D.companies.find((c) => c.id === companyId) || {}).code || null, detail: detail || null });
  users.forEach((u) => { u.disabled = 0; u.must_change_password = 0; u.last_login_at = null; });

  const fail = (status, message, extra) => { const e = new Error(message); e.status = status; e.data = Object.assign({ error: message }, extra || {}); throw e; };
  const me = () => session || fail(401, 'Please sign in.');
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id });
  function companyFor(u, requested) {
    const id = requested == null || requested === '' ? u.company_id : Number(requested);
    if (u.role !== 'advisor' && id !== u.company_id) fail(403, 'You do not have access to this company.');
    const c = D.companies.find((x) => x.id === id) || fail(404, 'Company not found.');
    return { id: c.id, code: c.code, name: c.name };
  }
  function current(cid) {
    const latest = {};
    uploads.filter((x) => x.company_id === cid).forEach((x) => { if (!latest[x.period] || latest[x.period].version < x.version) latest[x.period] = x; });
    return Object.keys(latest).sort().map((p) => ({ period: p, data: latest[p].data }));
  }

  const routes = {
    'GET /api/me': () => {
      const u = me();
      return { next: null, user: pub(u), companies: D.companies.filter((c) => u.role === 'advisor' || c.id === u.company_id).map((c) => ({ id: c.id, code: c.code, name: c.name })) };
    },
    'POST /api/login': (q, body) => {
      const u = users.find((x) => x.email === String(body.email || '').toLowerCase());
      if (!u || (body.password !== (u.password || 'demo-password'))) { log({ email: body.email }, 'login.failed'); fail(401, 'Email or password is incorrect.'); }
      if (u.disabled) { log(u, 'login.disabled'); fail(401, 'This login has been switched off. Contact your Assura Elevate partner.'); }
      session = u; u.last_login_at = new Date().toISOString(); log(u, 'login', u.company_id);
      return { user: pub(u), next: null };
    },
    'POST /api/logout': () => { if (session) log(session, 'logout'); session = null; return { ok: true }; },
    'POST /api/password': (q, body) => {
      const u = me();
      if (body.current !== (u.password || 'demo-password')) fail(400, 'Your current password is not correct.');
      if (String(body.next || '').length < 10) fail(400, 'Use at least 10 characters.');
      u.password = body.next; log(u, 'password.changed', u.company_id); return { ok: true, next: null };
    },
    'GET /api/admin/overview': () => {
      const u = me(); if (u.role !== 'advisor') fail(403, 'Only Assura Elevate advisors can manage clients and users.');
      const months = (cid) => [...new Set(uploads.filter((x) => x.company_id === cid).map((x) => x.period))].sort();
      return {
        companies: D.companies.map((c) => ({ id: c.id, code: c.code, name: c.name, users: users.filter((x) => x.company_id === c.id).length, months: months(c.id).length, latest: months(c.id).slice(-1)[0] || null, last_upload: uploads.filter((x) => x.company_id === c.id).map((x) => x.created_at).sort().slice(-1)[0] || null })),
        users: users.map((x) => ({ id: x.id, email: x.email, name: x.name, role: x.role, company_id: x.company_id, company_code: (D.companies.find((c) => c.id === x.company_id) || {}).code || null, disabled: x.disabled, must_change_password: x.must_change_password, two_step: x.role === 'advisor' ? 1 : 0, last_login_at: x.last_login_at })),
        activity: audit.slice(0, 200),
      };
    },
    'POST /api/admin/company': (q, body) => {
      const u = me(); if (u.role !== 'advisor') fail(403, 'Only Assura Elevate advisors can manage clients and users.');
      const code = String(body.code || '').trim().toUpperCase(); const name = String(body.name || '').trim();
      if (!/^[A-Z0-9-]{3,20}$/.test(code)) fail(400, 'Use a company code of 3 to 20 letters, digits or dashes, for example AE-0003.');
      if (!name) fail(400, 'Enter the company name.');
      if (D.companies.some((c) => c.code === code)) fail(409, `Company code ${code} is already in use.`);
      const c = { id: D.companies.length + 1, code, name, months: {} }; D.companies.push(c); log(u, 'admin.company_added', c.id, `${code} ${name}`);
      return { company: { id: c.id, code, name } };
    },
    'POST /api/admin/user': (q, body) => {
      const u = me(); if (u.role !== 'advisor') fail(403, 'Only Assura Elevate advisors can manage clients and users.');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
      if (users.some((x) => x.email === email)) fail(409, 'A login with this email already exists.');
      const temp = 'Demo' + Math.random().toString(36).slice(2, 8) + '-' + Math.random().toString(36).slice(2, 8);
      const nu = { id: users.length + 1, email, name: String(body.name || '').trim(), role: body.role, company_id: body.role === 'advisor' ? null : Number(body.company_id), note: 'Added in this session', password: temp, disabled: 0, must_change_password: 1, last_login_at: null };
      users.push(nu); log(u, 'admin.user_added', nu.company_id, `${email} as ${nu.role}`);
      return { user: pub(nu), temporaryPassword: temp };
    },
    'POST /api/admin/user/action': (q, body) => {
      const u = me(); if (u.role !== 'advisor') fail(403, 'Only Assura Elevate advisors can manage clients and users.');
      const t = users.find((x) => x.id === Number(body.user_id)) || fail(404, 'User not found.');
      if (t.id === u.id) fail(400, 'You cannot change this for your own login. Ask another advisor.');
      const out = { ok: true };
      if (body.action === 'reset-password') { t.password = out.temporaryPassword = 'Demo' + Math.random().toString(36).slice(2, 8) + '-' + Math.random().toString(36).slice(2, 8); t.must_change_password = 1; }
      else if (body.action === 'disable') t.disabled = 1;
      else if (body.action === 'enable') t.disabled = 0;
      log(u, `admin.${body.action}`, t.company_id, t.email);
      return out;
    },
    'GET /api/dashboard': (q) => {
      const c = companyFor(me(), q.get('company'));
      const ds = current(c.id);
      log(session, 'dashboard.viewed', c.id);
      return { company: c, analysis: window.AEAnalysis.analyse(ds), periods: ds.map((d) => d.period) };
    },
    'GET /api/uploads': (q) => {
      const c = companyFor(me(), q.get('company'));
      return { company: c, uploads: uploads.filter((x) => x.company_id === c.id).slice().reverse().map((x) => Object.assign({}, x, { uploaded_by: x.uploaded_by || 'Setup' })) };
    },
    'POST /api/upload': (q, body) => {
      const u = me();
      if (u.role === 'viewer') fail(403, 'Your login can view the dashboard but not upload data.');
      const c = companyFor(u, body.company);
      const P = window.AEParse; const schema = window.AE_SCHEMA;
      let data; let period; let parsed;
      if (body.section) {
        period = P.parseMonth(body.period) || fail(422, 'Choose the month this file relates to.', { errors: ['Choose the month this file relates to.'] });
        parsed = P.parseWorkbook(body.sheets, schema, { only: [body.section] });
        if (parsed.errors.length) fail(422, 'The file needs fixing before it can be accepted.', { errors: parsed.errors });
        const prev = current(c.id).find((d) => d.period === period);
        data = Object.assign({}, prev ? prev.data : { company: { company_code: c.code, company_name: c.name, period, prepared_by: u.name } });
        data[body.section] = parsed.data[body.section];
      } else {
        parsed = P.parseWorkbook(body.sheets, schema);
        const errors = parsed.errors.slice(); const comp = parsed.data.company || {};
        if (comp.company_code && comp.company_code.toUpperCase() !== c.code) errors.unshift(`This workbook is for company code ${comp.company_code}, but you are uploading to ${c.code}. Check the "Company & Period" sheet.`);
        if (errors.length) fail(422, 'The file needs fixing before it can be accepted.', { errors });
        data = parsed.data; period = comp.period;
      }
      const version = 1 + Math.max(0, ...uploads.filter((x) => x.company_id === c.id && x.period === period).map((x) => x.version));
      log(u, 'upload.accepted', c.id, `${period} v${version} ${body.filename || ''}`);
      uploads.push({ company_id: c.id, period, version, filename: body.filename, sections: body.section ? [body.section] : parsed.sections, warnings: parsed.warnings, data, created_at: new Date().toISOString(), uploaded_by: u.name });
      return { ok: true, period, version, sections: parsed.sections, warnings: parsed.warnings };
    },
  };

  window.AE_DEMO_API = {
    logins: users.map((u) => ({ email: u.email, note: u.note })),
    async request(method, url, body) {
      const q = new URL(url, 'http://demo');
      const fn = routes[`${method} ${q.pathname}`] || (() => fail(404, 'Not found'));
      await new Promise((r) => setTimeout(r, 60));
      return JSON.parse(JSON.stringify(fn(q.searchParams, body || {})));
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body); },
  };
})();
