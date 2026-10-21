/*
 * In-browser stand-in for the server API, used only by the shareable demo page.
 * Mirrors the server's access rules: a client login sees only its own company and
 * is view only; the Assura team sees every company, uploads and edits data and
 * manages client logins; admins also manage team logins.
 * Two-step login and the first-login password change run on the real server only. Data resets on reload.
 */
(function () {
  'use strict';
  const D = window.AE_DEMO_DATA; // { companies: [{id, code, name, months: {period: data}}] }
  const users = [
    { id: 1, email: 'client@meridian.demo', name: 'Managing Director', role: 'client', company_id: 1, note: 'Client: Meridian Polymers only, view only' },
    { id: 2, email: 'client@coastline.demo', name: 'Managing Director', role: 'client', company_id: 2, note: 'Client: Coastline Foods only, view only' },
    { id: 3, email: 'team@assura.demo', name: 'Assura Team Member', role: 'team', company_id: null, note: 'Assura team: every client, upload and edit' },
    { id: 4, email: 'admin@assura.demo', name: 'Assura Admin', role: 'admin', company_id: null, note: 'Assura admin: also manages team logins' },
  ];
  const staff = (u) => u.role === 'team' || u.role === 'admin';
  const needStaff = () => { const u = me(); if (!staff(u)) fail(403, 'Only the Assura Elevate team can do this. Client logins are view only.'); return u; };
  const uploads = []; // { company_id, period, version, filename, sections, warnings, data, created_at, uploaded_by }
  D.companies.forEach((c) => Object.keys(c.months).sort().forEach((p) => uploads.push({
    company_id: c.id, period: p, version: 1, filename: `sample ${p}.xlsx`, source: 'upload', sections: Object.keys(c.months[p]), warnings: [], data: c.months[p], created_at: '2026-10-07T04:30:00Z', uploaded_by: null,
  })));
  // Monthly workbooks already sent and returned, one per sample month (their references are printed in the sample files).
  const EMAIL = { 1: 'accounts@meridian.demo', 2: 'accounts@coastline.demo' };
  D.companies.forEach((c) => { c.data_email = EMAIL[c.id] || null; });
  const issued = [];
  D.companies.forEach((c) => Object.keys(c.months).sort().forEach((p) => issued.push({ company_id: c.id, period: p, ref: `${c.code}-${p}-SAMPLE`, method: 'email', sent_to: c.data_email, issued_by: 'Assura Team Member', issued_at: `${p}-28T05:30:00Z`, received_version: 1, received_at: '2026-10-07T04:30:00Z' })));
  const reviews = []; // reviewed explanations: { company_id, period, key, status, headline, body, ... }
  // The demo opens with a few explanations already accepted, so the client view shows them.
  D.companies.forEach((c) => {
    const ds = current(c.id); if (ds.length < 2) return;
    const last = ds[ds.length - 1];
    window.AEInsights.draft(ds, window.AEAnalysis.analyse(ds), last.period).slice(0, 3).forEach((d) => {
      const picked = d.causes.filter((x) => d.suggested.includes(x.id)).map((x) => x.text);
      reviews.push({ company_id: c.id, period: last.period, key: d.key, area: d.area, status: 'accepted', headline: d.headline, body: [d.movement].concat(picked).join(' '), causes: picked, data_version: 1, reviewed_by: 'Assura Team Member', reviewed_at: '2026-10-08T06:00:00Z' });
    });
  });
  let session = null;
  const audit = [];
  const log = (u, action, companyId, detail) => audit.unshift({ at: new Date().toISOString(), email: u ? u.email : null, action, company_code: (D.companies.find((c) => c.id === companyId) || {}).code || null, detail: detail || null });
  users.forEach((u) => { u.disabled = 0; u.must_change_password = 0; u.last_login_at = null; });

  const fail = (status, message, extra) => { const e = new Error(message); e.status = status; e.data = Object.assign({ error: message }, extra || {}); throw e; };
  const me = () => session || fail(401, 'Please sign in.');
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id });
  function companyFor(u, requested) {
    const id = requested == null || requested === '' ? u.company_id : Number(requested);
    if (!staff(u) && id !== u.company_id) fail(403, 'You do not have access to this company.');
    const c = D.companies.find((x) => x.id === id) || fail(404, 'Company not found.');
    return { id: c.id, code: c.code, name: c.name };
  }
  function current(cid) {
    const latest = {};
    uploads.filter((x) => x.company_id === cid).forEach((x) => { if (!latest[x.period] || latest[x.period].version < x.version) latest[x.period] = x; });
    return Object.keys(latest).sort().map((p) => ({ period: p, version: latest[p].version, data: latest[p].data })).filter((d) => !d.data.removed);
  }
  const versionOf = (cid, period, version) => {
    const list = uploads.filter((x) => x.company_id === cid && x.period === period).sort((a, b) => b.version - a.version);
    return version ? list.find((x) => x.version === Number(version)) : list[0];
  };
  const save = (u, c, period, data, sections, warnings, source, filename) => {
    const version = 1 + Math.max(0, ...uploads.filter((x) => x.company_id === c.id && x.period === period).map((x) => x.version));
    uploads.push({ company_id: c.id, period, version, filename: filename || null, source, sections, warnings, data, created_at: new Date().toISOString(), uploaded_by: u.name });
    return version;
  };

  const routes = {
    'GET /api/me': () => {
      const u = me();
      return { next: null, user: pub(u), companies: D.companies.filter((c) => staff(u) || c.id === u.company_id).map((c) => ({ id: c.id, code: c.code, name: c.name })) };
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
      needStaff();
      const months = (cid) => current(cid).map((d) => d.period);
      return {
        companies: D.companies.map((c) => ({ id: c.id, code: c.code, name: c.name, data_email: c.data_email || null, users: users.filter((x) => x.company_id === c.id).length, months: months(c.id).length, latest: months(c.id).slice(-1)[0] || null, last_upload: uploads.filter((x) => x.company_id === c.id).map((x) => x.created_at).sort().slice(-1)[0] || null })),
        users: users.slice().sort((a, b) => (a.role === 'client') - (b.role === 'client')).map((x) => ({ id: x.id, email: x.email, name: x.name, role: x.role, company_id: x.company_id, company_code: (D.companies.find((c) => c.id === x.company_id) || {}).code || null, disabled: x.disabled, must_change_password: x.must_change_password, two_step: staff(x) && !x.must_change_password ? 1 : 0, last_login_at: x.last_login_at })),
        activity: audit.slice(0, 200),
      };
    },
    'POST /api/admin/company': (q, body) => {
      const u = needStaff();
      const code = String(body.code || '').trim().toUpperCase(); const name = String(body.name || '').trim();
      if (!/^[A-Z0-9-]{3,20}$/.test(code)) fail(400, 'Use a company code of 3 to 20 letters, digits or dashes, for example AE-0003.');
      if (!name) fail(400, 'Enter the company name.');
      if (D.companies.some((c) => c.code === code)) fail(409, `Company code ${code} is already in use.`);
      const c = { id: D.companies.length + 1, code, name, months: {} }; D.companies.push(c); log(u, 'admin.company_added', c.id, `${code} ${name}`);
      return { company: { id: c.id, code, name } };
    },
    'POST /api/admin/company/update': (q, body) => {
      const u = needStaff(); const c = companyFor(u, body.company_id); const rec = D.companies.find((x) => x.id === c.id);
      if (body.data_email !== undefined) {
        const emails = String(body.data_email || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (emails.length > 3 || emails.some((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))) fail(400, 'Enter up to three valid email addresses, separated by commas.');
        rec.data_email = emails.join(', ') || null; log(u, 'admin.company_email', c.id, rec.data_email || '(removed)');
      }
      const name = body.name === undefined ? c.name : String(body.name || '').trim(); if (name.length < 2) fail(400, 'Enter the company name.');
      if (name !== c.name) { rec.name = name; log(u, 'admin.company_renamed', c.id, `${c.name} → ${name}`); }
      return { company: Object.assign({}, c, { name }) };
    },
    'GET /api/workbooks': (q) => {
      const c = companyFor(needStaff(), q.get('company'));
      const rec = D.companies.find((x) => x.id === c.id);
      return { company: c, data_email: rec.data_email || '', mail_ready: true, workbooks: issued.filter((x) => x.company_id === c.id).slice().reverse() };
    },
    // The demo makes the filled workbook in the browser; emails are recorded but not sent.
    'POST /api/workbooks/send': (q, body) => {
      const u = needStaff(); const c = companyFor(u, body.company); const rec = D.companies.find((x) => x.id === c.id);
      const period = window.AEParse.parseMonth(body.period) || fail(400, 'Choose the month the workbook is for.');
      const method = body.method === 'email' ? 'email' : 'download';
      const to = String(rec.data_email || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (method === 'email' && !to.length) fail(400, `No accounts email is saved for ${c.name}. Add it under Clients & users first.`);
      const W = window.AEWorkbook;
      const ref = W.newRef(c.code, period, (n) => crypto.getRandomValues(new Uint8Array(n)));
      const tpl = Uint8Array.from(atob(window.AE_TEMPLATE_B64), (ch) => ch.charCodeAt(0));
      const file = W.fill(tpl, { company_code: c.code, company_name: c.name, period, template_ref: ref });
      issued.push({ company_id: c.id, period, ref, method, sent_to: method === 'email' ? to.join(', ') : null, issued_by: u.name, issued_at: new Date().toISOString(), received_version: null, received_at: null });
      log(u, method === 'email' ? 'workbook.emailed' : 'workbook.downloaded', c.id, `${period} ${ref}`);
      let b64 = ''; for (let i = 0; i < file.length; i += 0x8000) b64 += String.fromCharCode.apply(null, file.subarray(i, i + 0x8000));
      return { ok: true, ref, period, method, sent_to: to, filename: W.fileName(c, period), file: method === 'download' ? btoa(b64) : undefined, demo: method === 'email' };
    },
    'POST /api/admin/user': (q, body) => {
      const u = needStaff();
      if (!['client', 'team', 'admin'].includes(body.role)) fail(400, 'Choose a role.');
      if (body.role !== 'client' && u.role !== 'admin') fail(403, 'Only an Assura Elevate admin can add team logins.');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
      if (users.some((x) => x.email === email)) fail(409, 'A login with this email already exists.');
      const temp = 'Demo' + Math.random().toString(36).slice(2, 8) + '-' + Math.random().toString(36).slice(2, 8);
      const nu = { id: users.length + 1, email, name: String(body.name || '').trim(), role: body.role, company_id: body.role === 'client' ? Number(body.company_id) : null, note: 'Added in this session', password: temp, disabled: 0, must_change_password: 1, last_login_at: null };
      users.push(nu); log(u, 'admin.user_added', nu.company_id, `${email} as ${nu.role}`);
      return { user: pub(nu), temporaryPassword: temp };
    },
    'POST /api/admin/user/action': (q, body) => {
      const u = needStaff();
      const t = users.find((x) => x.id === Number(body.user_id)) || fail(404, 'User not found.');
      if (staff(t) && u.role !== 'admin') fail(403, 'Only an Assura Elevate admin can change team logins.');
      if (t.id === u.id) fail(400, 'You cannot change this for your own login. Ask another admin.');
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
      return { company: c, analysis: window.AEAnalysis.analyse(ds), periods: ds.map((d) => d.period),
        insights: reviews.filter((r) => r.company_id === c.id && r.status === 'accepted').map((r) => ({ period: r.period, key: r.key, area: r.area, headline: r.headline, body: r.body, reviewed_at: r.reviewed_at })) };
    },
    'GET /api/insights': (q) => {
      const u = needStaff(); const c = companyFor(u, q.get('company'));
      const ds = current(c.id); const periods = ds.map((d) => d.period);
      const period = window.AEParse.parseMonth(q.get('period')) || periods[periods.length - 1];
      if (!period || !periods.includes(period)) fail(404, 'No data for this month.');
      const cur = versionOf(c.id, period);
      const drafts = window.AEInsights.draft(ds, window.AEAnalysis.analyse(ds), period);
      const saved = reviews.filter((r) => r.company_id === c.id && r.period === period);
      const items = drafts.map((d) => ({ draft: d, review: saved.find((r) => r.key === d.key) || null }))
        .concat(saved.filter((r) => !drafts.some((d) => d.key === r.key)).map((r) => ({ draft: null, review: r })))
        .map((x) => Object.assign(x, { stale: !!(x.review && x.review.data_version !== cur.version) }));
      return { company: c, period, periods, version: cur.version, items, first: periods[0] === period };
    },
    'POST /api/insights/review': (q, body) => {
      const u = needStaff(); const c = companyFor(u, body.company);
      const period = window.AEParse.parseMonth(body.period); const cur = period && versionOf(c.id, period);
      if (!cur || cur.data.removed) fail(404, 'No data for this month.');
      const key = String(body.key || '');
      if (!/^[a-z0-9-]{2,40}$/.test(key)) fail(400, 'Choose the explanation to review.');
      const at = reviews.findIndex((r) => r.company_id === c.id && r.period === period && r.key === key);
      if (body.status === 'draft') { if (at >= 0) reviews.splice(at, 1); log(u, 'insight.withdrawn', c.id, `${period} ${key}`); return { ok: true }; }
      if (!['accepted', 'set-aside'].includes(body.status)) fail(400, 'Choose accept or set aside.');
      const headline = String(body.headline || '').trim(); const text = String(body.body || '').trim();
      if (body.status === 'accepted' && (!headline || !text)) fail(400, 'Write a headline and the explanation before accepting it.');
      const row = { company_id: c.id, period, key, area: String(body.area || 'General'), status: body.status, headline: headline || '(untitled)', body: text, causes: body.causes || [], data_version: cur.version, reviewed_by: u.name, reviewed_at: new Date().toISOString() };
      if (at >= 0) reviews[at] = row; else reviews.push(row);
      log(u, body.status === 'accepted' ? 'insight.accepted' : 'insight.set_aside', c.id, `${period} ${key}: ${headline}`);
      return { ok: true };
    },
    'GET /api/uploads': (q) => {
      const c = companyFor(me(), q.get('company'));
      return { company: c, uploads: uploads.filter((x) => x.company_id === c.id).slice().reverse().map((x) => Object.assign({}, x, { uploaded_by: x.uploaded_by || 'Setup', data: undefined })) };
    },
    'GET /api/data': (q) => {
      const u = me(); const c = companyFor(u, q.get('company'));
      const period = window.AEParse.parseMonth(q.get('period')) || fail(400, 'Choose a month.');
      const v = versionOf(c.id, period, q.get('version'));
      if (!v || v.data.removed) fail(404, 'No data for this month.');
      return { company: c, period, version: v.version, data: v.data };
    },
    'POST /api/data/edit': (q, body) => {
      const u = needStaff(); const c = companyFor(u, body.company);
      const period = window.AEParse.parseMonth(body.period); const cur = period && versionOf(c.id, period);
      if (!cur || cur.data.removed) fail(404, 'No data for this month. Upload the workbook first.');
      const def = window.AE_SCHEMA.sheets.find((x) => x.key === body.section) || fail(400, 'Unknown section.');
      if (body.baseVersion && Number(body.baseVersion) !== cur.version) fail(409, `Someone saved a newer version (v${cur.version}) of this month while you were editing. Reload it and make your change again.`);
      const out = window.AEEdit.applyEdit(cur.data, body.section, body.values, window.AE_SCHEMA);
      if (out.errors.length) fail(422, 'Some rows need fixing before they can be saved.', { errors: out.errors });
      const version = save(u, c, period, out.data, [body.section], out.warnings, `Edited: ${def.name}`);
      log(u, 'data.edited', c.id, `${period} ${def.name} v${version}`);
      return { ok: true, period, version, warnings: out.warnings };
    },
    'POST /api/data/restore': (q, body) => {
      const u = needStaff(); const c = companyFor(u, body.company);
      const period = window.AEParse.parseMonth(body.period); const old = period && body.version && versionOf(c.id, period, body.version);
      if (!old) fail(404, 'That version was not found.');
      const version = save(u, c, period, old.data, Object.keys(old.data), [], `Restored v${old.version}`);
      log(u, 'data.restored', c.id, `${period} v${old.version} as v${version}`);
      return { ok: true, period, version };
    },
    'POST /api/data/remove-month': (q, body) => {
      const u = needStaff(); const c = companyFor(u, body.company);
      const period = window.AEParse.parseMonth(body.period); const cur = period && versionOf(c.id, period);
      if (!cur || cur.data.removed) fail(404, 'No data for this month.');
      const version = save(u, c, period, { removed: true }, [], [], 'Month removed');
      log(u, 'data.month_removed', c.id, `${period} v${version}`);
      return { ok: true, period, version };
    },
    'POST /api/upload': (q, body) => {
      const u = needStaff();
      const c = companyFor(u, body.company);
      const P = window.AEParse; const schema = window.AE_SCHEMA;
      let data; let period; let parsed; let rows; let fileCompany = null;
      if (body.section) {
        period = P.parseMonth(body.period) || fail(422, 'Choose the month this file relates to.', { errors: ['Choose the month this file relates to.'] });
        parsed = P.parseWorkbook(body.sheets, schema, { only: [body.section] });
        if (parsed.errors.length) fail(422, 'The file needs fixing before it can be accepted.', { errors: parsed.errors });
        const prev = current(c.id).find((d) => d.period === period);
        data = Object.assign({}, prev ? prev.data : { company: { company_code: c.code, company_name: c.name, period, prepared_by: u.name } });
        data[body.section] = parsed.data[body.section];
        rows = { [body.section]: parsed.data[body.section] };
      } else {
        parsed = P.parseWorkbook(body.sheets, schema);
        if (parsed.errors.length) fail(422, 'The file needs fixing before it can be accepted.', { errors: parsed.errors });
        data = parsed.data; rows = parsed.data; fileCompany = parsed.data.company || {}; period = fileCompany.period;
      }
      // Same check as the server: the file must belong to the client selected for the upload.
      const M = window.AEMatch; const recent = (id) => M.partiesOf(current(id).slice(-6));
      const mismatch = M.check({ selected: c, fileCompany, confirmCode: body.confirm_code, data: rows, own: recent(c.id),
        others: D.companies.filter((o) => o.id !== c.id).map((o) => ({ code: o.code, name: o.name, parties: recent(o.id) })) });
      const ref = fileCompany && String(fileCompany.template_ref || '').trim().toUpperCase();
      const issue = ref ? issued.find((x) => x.ref.toUpperCase() === ref) : null;
      const issueRec = issue && Object.assign({}, issue, { company_code: D.companies.find((x) => x.id === issue.company_id).code, company_name: D.companies.find((x) => x.id === issue.company_id).name });
      if (fileCompany) mismatch.unshift(...M.checkIssued({ selected: c, fileCompany, issue: issueRec }));
      if (mismatch.length) { log(u, 'upload.wrong_company', c.id, body.filename); fail(422, `This file does not look like ${c.name}'s data, so it was not uploaded.`, { errors: mismatch }); }
      if (body.preview) {
        const live = versionOf(c.id, period);
        return { ok: true, preview: true, period, sections: body.section ? [body.section] : parsed.sections, warnings: parsed.warnings, summary: M.summary(rows, schema), replaces: live && !live.data.removed ? live.version : null,
          workbook: issue ? { ref: issue.ref, issued_at: issue.issued_at, sent_to: issue.sent_to, received_version: issue.received_version } : null };
      }
      const version = save(u, c, period, data, body.section ? [body.section] : parsed.sections, parsed.warnings, 'upload', body.filename);
      if (issue) { issue.received_version = version; issue.received_at = new Date().toISOString(); }
      log(u, 'upload.accepted', c.id, `${period} v${version} ${body.filename || ''}`);
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
