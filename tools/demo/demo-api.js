/*
 * In-browser stand-in for the server API, used only by the shareable demo page.
 * Mirrors the server's access rules: viewers and accountants see only their own
 * company, viewers cannot upload, advisors see every company. Data resets on reload.
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
      return { user: pub(u), companies: D.companies.filter((c) => u.role === 'advisor' || c.id === u.company_id).map((c) => ({ id: c.id, code: c.code, name: c.name })) };
    },
    'POST /api/login': (q, body) => {
      const u = users.find((x) => x.email === String(body.email || '').toLowerCase());
      if (!u || body.password !== 'demo-password') fail(401, 'Email or password is incorrect.');
      session = u; return { user: pub(u) };
    },
    'POST /api/logout': () => { session = null; return { ok: true }; },
    'GET /api/dashboard': (q) => {
      const c = companyFor(me(), q.get('company'));
      const ds = current(c.id);
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
