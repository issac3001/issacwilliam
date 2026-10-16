'use strict';
/*
 * Assura Elevate client platform: HTTP server.
 * Dependency-free (Node 22+: node:http, node:sqlite, node:crypto).
 * Every company-scoped request goes through companyFor(), which is the single
 * place that enforces "a client user sees only their own company".
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const totp = require('./totp');
const { parseWorkbook, parseMonth } = require('../shared/parse');
const { analyse } = require('../shared/analysis');
const { applyEdit } = require('../shared/edit');
const workflow = require('../shared/workflow');
const schema = require('../shared/schema.json');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC_EXTRA = {
  '/shared/parse.js': path.join(__dirname, '..', 'shared', 'parse.js'),
  '/shared/analysis.js': path.join(__dirname, '..', 'shared', 'analysis.js'),
  '/shared/edit.js': path.join(__dirname, '..', 'shared', 'edit.js'),
  '/shared/schema.json': path.join(__dirname, '..', 'shared', 'schema.json'),
  '/workflow': path.join(__dirname, '..', 'public', 'workflow.html'),
  '/template.xlsx': path.join(__dirname, '..', 'templates', 'Assura_Elevate_Monthly_Data_Template.xlsx'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const SESSION_DAYS = 7;
const MAX_BODY = 25 * 1024 * 1024;
const SECURE_COOKIE = process.env.AE_SECURE_COOKIE === '1';
const IDLE_MINUTES = Number(process.env.AE_IDLE_MINUTES || 120);
// Assura staff can see and change every client, so their logins need a second step by default.
const STAFF_2FA = (process.env.AE_REQUIRE_STAFF_2FA || process.env.AE_REQUIRE_ADVISOR_2FA) !== '0';
const { isStaff } = store;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function createApp(db) {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const attempts = new Map(); // login throttling: key -> { n, until }
  workflow.install(db);
  const wf = workflow.createWorkflow(db);

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({
      'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain',
      'Cache-Control': 'no-store',
    }, headers));
    res.end(data);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Expected JSON.'));
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'File too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'Invalid JSON.')); } });
      req.on('error', reject);
    });
  }

  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  }

  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);
  const log = (req, user, action, extra = {}) => store.audit(db, Object.assign({ user, action, ip: ipOf(req) }, extra));

  function currentUser(req) {
    const token = cookies(req).ae_session;
    if (!token) return null;
    const h = sha(token);
    const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.company_id, u.disabled, u.must_change_password, u.totp_secret,
      s.expires_at, s.stage, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(h);
    const now = Date.now();
    if (!row || row.disabled || row.expires_at < now || (row.last_seen && now - row.last_seen > IDLE_MINUTES * 60000)) {
      if (row) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
      return null;
    }
    if (now - row.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, h);
    row.tokenHash = h;
    return row;
  }

  // What a signed-in user must do before using the platform, if anything.
  function nextStep(u) {
    if (u.must_change_password) return 'change-password';
    if (isStaff(u.role) && STAFF_2FA && !u.totp_secret) return 'enrol-2fa';
    return null;
  }

  // Full access needs a finished account; restricted routes (password, 2FA setup) pass allowSetup.
  function requireUser(req, { allowSetup = false } = {}) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in.');
    if (!allowSetup && (u.stage !== 'full' || nextStep(u))) throw new HttpError(403, 'Finish setting up your account first.', { next: nextStep(u) });
    return u;
  }

  // Assura team and admins: every client, upload, edit and client logins.
  function requireStaff(req) {
    const u = requireUser(req);
    if (!isStaff(u.role)) throw new HttpError(403, 'Only the Assura Elevate team can do this. Client logins are view only.');
    return u;
  }
  // Admins only: logins for the Assura team itself.
  function requireAdmin(req) {
    const u = requireStaff(req);
    if (u.role !== 'admin') throw new HttpError(403, 'Only an Assura Elevate admin can manage team logins.');
    return u;
  }

  function upgradeIfReady(u) {
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    if (!nextStep(fresh)) db.prepare("UPDATE sessions SET stage = 'full' WHERE token_hash = ?").run(u.tokenHash);
    return nextStep(fresh);
  }

  // The one access rule: the Assura team sees every company, a client login only its own.
  function companyFor(user, requestedId) {
    const id = requestedId == null || requestedId === '' ? user.company_id : Number(requestedId);
    if (!id) throw new HttpError(400, 'Choose a company.');
    if (!isStaff(user.role) && id !== user.company_id) throw new HttpError(403, 'You do not have access to this company.');
    const c = db.prepare('SELECT id, code, name FROM companies WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Company not found.');
    return c;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id, twoStep: !!u.totp_secret };
  }

  const routes = {
    // Body: { email, password, code? }. Advisors with two-step login on must send the 6-digit code.
    'POST /api/login': async (req, res) => {
      const { email, password, code } = await readJson(req);
      const key = String(email || '').toLowerCase().trim();
      const a = attempts.get(key);
      if (a && a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const failed = (message, action, extra) => {
        const n = (a ? a.n : 0) + 1;
        attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
        log(req, { email: key }, action);
        throw new HttpError(401, message, extra);
      };
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(key);
      if (!u || !store.verifyPassword(String(password || ''), u.password_hash)) failed('Email or password is incorrect.', 'login.failed');
      if (u.disabled) failed('This login has been switched off. Contact your Assura Elevate partner.', 'login.disabled');
      if (u.totp_secret) {
        if (!code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', { needCode: true });
        const step = totp.verify(u.totp_secret, code, u.totp_last_step);
        if (step == null) failed('That code did not match. Use the current code from your authenticator app.', 'login.code_failed', { needCode: true });
        db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
      }
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, stage, last_seen) VALUES (?, ?, ?, ?, ?)')
        .run(sha(token), u.id, now + SESSION_DAYS * 86400000, nextStep(u) ? 'setup' : 'full', now);
      db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(u.id);
      log(req, u, 'login', { companyId: u.company_id });
      send(res, 200, { user: publicUser(u), next: nextStep(u) }, {
        'Set-Cookie': `ae_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`,
      });
    },

    'POST /api/logout': async (req, res) => {
      const token = cookies(req).ae_session;
      if (token) {
        const u = currentUser(req);
        if (u) log(req, u, 'logout');
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
      }
      send(res, 200, { ok: true }, { 'Set-Cookie': 'ae_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    },

    'GET /api/me': async (req, res) => {
      const u = requireUser(req, { allowSetup: true });
      const next = nextStep(u);
      const companies = next ? [] : isStaff(u.role)
        ? db.prepare('SELECT id, code, name FROM companies ORDER BY name').all()
        : db.prepare('SELECT id, code, name FROM companies WHERE id = ?').all(u.company_id);
      send(res, 200, { user: publicUser(u), companies, next });
    },

    // Body: { current, next }. Signs out the user's other sessions.
    'POST /api/password': async (req, res) => {
      const u = requireUser(req, { allowSetup: true });
      const body = await readJson(req);
      const full = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      if (!store.verifyPassword(String(body.current || ''), full.password_hash)) throw new HttpError(400, 'Your current password is not correct.');
      const pw = String(body.next || '');
      const problem = store.passwordProblem(pw, u.email);
      if (problem) throw new HttpError(400, problem);
      if (store.verifyPassword(pw, full.password_hash)) throw new HttpError(400, 'Choose a password different from the current one.');
      store.setPassword(db, u.id, pw, false);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(u.id, u.tokenHash);
      log(req, u, 'password.changed', { companyId: u.company_id });
      send(res, 200, { ok: true, next: upgradeIfReady(u) });
    },

    // Two-step login setup: start returns a new secret; confirm proves the app is set up.
    'POST /api/2fa/start': async (req, res) => {
      const u = requireUser(req, { allowSetup: true });
      if (u.must_change_password) throw new HttpError(403, 'Change your password first.');
      const secret = totp.newSecret();
      db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, u.id);
      send(res, 200, { secret, uri: totp.otpauthUri(secret, u.email) });
    },
    'POST /api/2fa/confirm': async (req, res) => {
      const u = requireUser(req, { allowSetup: true });
      const { code } = await readJson(req);
      const full = db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(u.id);
      if (!full.totp_pending) throw new HttpError(400, 'Start the setup again.');
      const step = totp.verify(full.totp_pending, code, 0);
      if (step == null) throw new HttpError(400, 'That code did not match. Check the time on your phone and try the current code.');
      db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(step, u.id);
      log(req, u, '2fa.enabled');
      send(res, 200, { ok: true, next: upgradeIfReady(u) });
    },

    // ---------- Administration (Assura team) ----------
    'GET /api/admin/overview': async (req, res) => {
      requireStaff(req);
      const companies = db.prepare(`SELECT c.id, c.code, c.name, c.created_at,
          (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users,
          (SELECT COUNT(DISTINCT period) FROM uploads x WHERE x.company_id = c.id) AS months,
          (SELECT MAX(period) FROM uploads x WHERE x.company_id = c.id) AS latest,
          (SELECT MAX(created_at) FROM uploads x WHERE x.company_id = c.id) AS last_upload
        FROM companies c ORDER BY c.name`).all();
      const users = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.company_id, c.code AS company_code, u.disabled,
          u.must_change_password, (u.totp_secret IS NOT NULL) AS two_step, u.last_login_at, u.created_at
        FROM users u LEFT JOIN companies c ON c.id = u.company_id ORDER BY u.role = 'client', c.code, u.email`).all();
      const activity = db.prepare(`SELECT a.at, a.email, a.action, c.code AS company_code, a.detail, a.ip
        FROM audit a LEFT JOIN companies c ON c.id = a.company_id ORDER BY a.id DESC LIMIT 200`).all();
      send(res, 200, { companies, users, activity });
    },
    'POST /api/admin/company': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const code = String(body.code || '').trim().toUpperCase();
      const name = String(body.name || '').trim();
      if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw new HttpError(400, 'Use a company code of 3 to 20 letters, digits or dashes, for example AE-0003.');
      if (name.length < 2 || name.length > 160) throw new HttpError(400, 'Enter the company name.');
      if (db.prepare('SELECT 1 FROM companies WHERE code = ?').get(code)) throw new HttpError(409, `Company code ${code} is already in use.`);
      const c = store.createCompany(db, code, name);
      log(req, u, 'admin.company_added', { companyId: c.id, detail: `${code} ${name}` });
      send(res, 200, { company: c });
    },
    // Body: { company_id, name }. The company code stays fixed because workbooks carry it.
    'POST /api/admin/company/update': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const c = companyFor(u, body.company_id);
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 160) throw new HttpError(400, 'Enter the company name.');
      db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, c.id);
      log(req, u, 'admin.company_renamed', { companyId: c.id, detail: `${c.name} → ${name}` });
      send(res, 200, { company: Object.assign({}, c, { name }) });
    },
    // Creates a login with a one-time password that must be changed at first sign-in.
    'POST /api/admin/user': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const role = body.role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Enter the person\'s name.');
      if (!store.ROLES.includes(role)) throw new HttpError(400, 'Choose a role.');
      if (isStaff(role) && u.role !== 'admin') throw new HttpError(403, 'Only an Assura Elevate admin can add team logins.');
      let companyId = null;
      if (role === 'client') {
        companyId = Number(body.company_id);
        if (!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) throw new HttpError(400, 'Choose the company this login belongs to.');
      }
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'A login with this email already exists.');
      const password = store.temporaryPassword();
      const created = store.createUser(db, { email, name, role, companyId, password, mustChange: true });
      log(req, u, 'admin.user_added', { companyId, detail: `${email} as ${role}` });
      send(res, 200, { user: created, temporaryPassword: password });
    },
    // Body: { user_id, action: 'reset-password' | 'reset-2fa' | 'disable' | 'enable' }
    'POST /api/admin/user/action': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(body.user_id));
      if (!target) throw new HttpError(404, 'User not found.');
      if (isStaff(target.role) && u.role !== 'admin') throw new HttpError(403, 'Only an Assura Elevate admin can change team logins.');
      if (target.id === u.id && body.action !== 'reset-password') throw new HttpError(400, 'You cannot change this for your own login. Ask another admin.');
      const endSessions = () => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      let out = { ok: true };
      if (body.action === 'reset-password') {
        if (target.id === u.id) throw new HttpError(400, 'Use Account to change your own password.');
        const password = store.temporaryPassword();
        store.setPassword(db, target.id, password, true);
        endSessions(); out.temporaryPassword = password;
      } else if (body.action === 'reset-2fa') {
        db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0 WHERE id = ?').run(target.id); endSessions();
      } else if (body.action === 'disable') {
        db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(target.id); endSessions();
      } else if (body.action === 'enable') {
        db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(target.id);
      } else throw new HttpError(400, 'Unknown action.');
      log(req, u, `admin.${body.action}`, { companyId: target.company_id, detail: target.email });
      send(res, 200, out);
    },

    'GET /api/dashboard': async (req, res, url) => {
      const u = requireUser(req);
      const c = companyFor(u, url.searchParams.get('company'));
      const datasets = store.currentDatasets(db, c.id);
      log(req, u, 'dashboard.viewed', { companyId: c.id });
      send(res, 200, { company: c, analysis: analyse(datasets), periods: datasets.map((d) => d.period) });
    },

    // One month's figures, for drill-downs (all users) and the data editor (Assura team).
    'GET /api/data': async (req, res, url) => {
      const u = requireUser(req);
      const c = companyFor(u, url.searchParams.get('company'));
      const period = parseMonth(url.searchParams.get('period'));
      if (!period) throw new HttpError(400, 'Choose a month.');
      const version = url.searchParams.get('version');
      if (version && !isStaff(u.role)) throw new HttpError(403, 'Only the Assura Elevate team can open earlier versions.');
      const d = store.datasetVersion(db, c.id, period, version);
      if (!d || (!version && d.data.removed)) throw new HttpError(404, 'No data for this month.');
      send(res, 200, { company: c, period, version: d.version, data: d.data });
    },

    // Body: { company, period, section, values }. Saves the edited section as a new version.
    'POST /api/data/edit': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const c = companyFor(u, body.company);
      const period = parseMonth(body.period);
      const cur = period && store.datasetVersion(db, c.id, period);
      if (!cur || cur.data.removed) throw new HttpError(404, 'No data for this month. Upload the workbook first.');
      const def = schema.sheets.find((s) => s.key === body.section);
      if (!def) throw new HttpError(400, 'Unknown section.');
      if (body.baseVersion && Number(body.baseVersion) !== cur.version)
        throw new HttpError(409, `Someone saved a newer version (v${cur.version}) of this month while you were editing. Reload it and make your change again.`);
      const out = applyEdit(cur.data, body.section, body.values, schema);
      if (out.errors.length) throw new HttpError(422, 'Some rows need fixing before they can be saved.', { errors: out.errors, warnings: out.warnings });
      const version = store.saveUpload(db, { companyId: c.id, period, userId: u.id, filename: null, sections: [body.section], warnings: out.warnings, data: out.data, source: `Edited: ${def.name}` });
      log(req, u, 'data.edited', { companyId: c.id, detail: `${period} ${def.name} v${version}` });
      send(res, 200, { ok: true, period, version, warnings: out.warnings });
    },

    // Body: { company, period, version }. Makes an earlier version live again, as a new version.
    'POST /api/data/restore': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const c = companyFor(u, body.company);
      const period = parseMonth(body.period);
      const old = period && store.datasetVersion(db, c.id, period, body.version);
      if (!old || !body.version) throw new HttpError(404, 'That version was not found.');
      const version = store.saveUpload(db, { companyId: c.id, period, userId: u.id, filename: null, sections: Object.keys(old.data), warnings: [], data: old.data, source: `Restored v${old.version}` });
      log(req, u, 'data.restored', { companyId: c.id, detail: `${period} v${old.version} as v${version}` });
      send(res, 200, { ok: true, period, version });
    },

    // Body: { company, period }. Takes a month off the dashboard; earlier versions stay and can be restored.
    'POST /api/data/remove-month': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const c = companyFor(u, body.company);
      const period = parseMonth(body.period);
      const cur = period && store.datasetVersion(db, c.id, period);
      if (!cur || cur.data.removed) throw new HttpError(404, 'No data for this month.');
      const version = store.saveUpload(db, { companyId: c.id, period, userId: u.id, filename: null, sections: [], warnings: [], data: { removed: true }, source: 'Month removed' });
      log(req, u, 'data.month_removed', { companyId: c.id, detail: `${period} v${version}` });
      send(res, 200, { ok: true, period, version });
    },

    'GET /api/uploads': async (req, res, url) => {
      const u = requireUser(req);
      const c = companyFor(u, url.searchParams.get('company'));
      // Who uploaded what is internal to the Assura team.
      const uploads = store.uploadHistory(db, c.id).map((x) => (isStaff(u.role) ? x : { period: x.period, version: x.version, created_at: x.created_at, sections: x.sections, warnings: [] }));
      send(res, 200, { company: c, uploads });
    },

    // Body: { company?, filename, sheets: {name: rows[][]} }            full workbook
    //   or: { company?, filename, section, period, sheets: {name: rows} } one section from CSV
    'POST /api/upload': async (req, res) => {
      const u = requireStaff(req);
      const body = await readJson(req);
      const c = companyFor(u, body.company);
      if (!body.sheets || typeof body.sheets !== 'object') throw new HttpError(400, 'No file content received.');

      let data, period, warnings, sections;
      if (body.section) {
        if (!schema.sheets.some((s) => s.key === body.section && s.layout === 'table')) throw new HttpError(400, 'Unknown section.');
        period = parseMonth(body.period);
        if (!period) throw new HttpError(422, 'Choose the month this file relates to.', { errors: ['Choose the month this file relates to.'] });
        const parsed = parseWorkbook(body.sheets, schema, { only: [body.section] });
        if (parsed.errors.length) throw new HttpError(422, 'The file needs fixing before it can be accepted.', { errors: parsed.errors, warnings: parsed.warnings });
        const prev = store.latestDataset(db, c.id, period);
        data = prev && !prev.removed ? Object.assign({}, prev) : {
          company: { company_code: c.code, company_name: c.name, period, prepared_by: u.name },
        };
        data[body.section] = parsed.data[body.section];
        warnings = parsed.warnings; sections = [body.section];
      } else {
        const parsed = parseWorkbook(body.sheets, schema);
        const errors = parsed.errors.slice();
        const comp = parsed.data.company || {};
        if (comp.company_code && comp.company_code.toUpperCase() !== c.code.toUpperCase())
          errors.unshift(`This workbook is for company code ${comp.company_code}, but you are uploading to ${c.code}. Check the "Company & Period" sheet.`);
        if (errors.length) {
          log(req, u, 'upload.rejected', { companyId: c.id, detail: `${body.filename || ''}: ${errors.length} problem(s)` });
          throw new HttpError(422, 'The file needs fixing before it can be accepted.', { errors, warnings: parsed.warnings });
        }
        period = comp.period; data = parsed.data; warnings = parsed.warnings; sections = parsed.sections;
      }
      const version = store.saveUpload(db, { companyId: c.id, period, userId: u.id, filename: String(body.filename || '').slice(0, 200), sections, warnings, data });
      log(req, u, 'upload.accepted', { companyId: c.id, detail: `${period} v${version} ${body.filename || ''}` });
      send(res, 200, { ok: true, period, version, sections, warnings });
    },
  };

  async function serveStatic(req, res, url) {
    let file = STATIC_EXTRA[url.pathname];
    if (!file) {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      file = path.join(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found');
    }
    let buf;
    try { buf = await fs.promises.readFile(file); } catch { throw new HttpError(404, 'Not found'); }
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (url.pathname === '/template.xlsx') headers['Content-Disposition'] = 'attachment; filename="Assura_Elevate_Monthly_Data_Template.xlsx"';
    send(res, 200, buf, headers);
  }

  return async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (url.pathname.startsWith('/api/wf/')) {
        // Internal workflow (Assura team only). Same login, same 2FA and same CSRF rule as the portal.
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'assura') throw new HttpError(403, 'Forbidden');
        const u = requireStaff(req);
        const body = req.method === 'POST' ? await readJson(req) : {};
        let out;
        try { out = wf.call(u, `${req.method} ${url.pathname}`, Object.fromEntries(url.searchParams), body); }
        catch (e) { if (e instanceof workflow.WfError) throw new HttpError(e.status, e.message); throw e; }
        if (req.method === 'POST') log(req, u, `workflow.${url.pathname.slice(8).replace(/\//g, '.')}`, { detail: JSON.stringify(body).slice(0, 300) });
        send(res, 200, out);
      } else if (route) {
        // Same-origin check for state-changing calls (in addition to SameSite cookies).
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'assura') throw new HttpError(403, 'Forbidden');
        await route(req, res, url);
      } else if (req.method === 'GET' && !url.pathname.startsWith('/api/')) await serveStatic(req, res, url);
      else throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) send(res, status, Object.assign({ error: status === 500 ? 'Something went wrong.' : e.message }, e.extra || {}));
    }
  };
}

if (require.main === module) {
  const db = store.open();
  const port = Number(process.env.PORT || 3000);
  // In production the server sits behind Caddy (HTTPS), so it listens on 127.0.0.1 only (HOST).
  const host = process.env.HOST || '0.0.0.0';
  http.createServer(createApp(db)).listen(port, host, () => console.log(`Assura Elevate running on http://${host}:${port}`));
}

module.exports = { createApp };
