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
const schema = require('../shared/schema.json');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC_EXTRA = {
  '/shared/parse.js': path.join(__dirname, '..', 'shared', 'parse.js'),
  '/shared/analysis.js': path.join(__dirname, '..', 'shared', 'analysis.js'),
  '/shared/schema.json': path.join(__dirname, '..', 'shared', 'schema.json'),
  '/template.xlsx': path.join(__dirname, '..', 'templates', 'Assura_Elevate_Monthly_Data_Template.xlsx'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const SESSION_DAYS = 7;
const MAX_BODY = 25 * 1024 * 1024;
const SECURE_COOKIE = process.env.AE_SECURE_COOKIE === '1';
const IDLE_MINUTES = Number(process.env.AE_IDLE_MINUTES || 120);
// Assura staff can see every client, so their logins need a second step by default.
const ADVISOR_2FA = process.env.AE_REQUIRE_ADVISOR_2FA !== '0';

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function createApp(db) {
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const attempts = new Map(); // login throttling: key -> { n, until }

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
    if (u.role === 'advisor' && ADVISOR_2FA && !u.totp_secret) return 'enrol-2fa';
    return null;
  }

  // Full access needs a finished account; restricted routes (password, 2FA setup) pass allowSetup.
  function requireUser(req, { allowSetup = false } = {}) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in.');
    if (!allowSetup && (u.stage !== 'full' || nextStep(u))) throw new HttpError(403, 'Finish setting up your account first.', { next: nextStep(u) });
    return u;
  }

  function requireAdvisor(req) {
    const u = requireUser(req);
    if (u.role !== 'advisor') throw new HttpError(403, 'Only Assura Elevate advisors can manage clients and users.');
    return u;
  }

  function upgradeIfReady(u) {
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    if (!nextStep(fresh)) db.prepare("UPDATE sessions SET stage = 'full' WHERE token_hash = ?").run(u.tokenHash);
    return nextStep(fresh);
  }

  // The one access rule: advisors see every company, everyone else only their own.
  function companyFor(user, requestedId) {
    const id = requestedId == null || requestedId === '' ? user.company_id : Number(requestedId);
    if (!id) throw new HttpError(400, 'Choose a company.');
    if (user.role !== 'advisor' && id !== user.company_id) throw new HttpError(403, 'You do not have access to this company.');
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
      const companies = next ? [] : u.role === 'advisor'
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

    // ---------- Advisor administration ----------
    'GET /api/admin/overview': async (req, res) => {
      requireAdvisor(req);
      const companies = db.prepare(`SELECT c.id, c.code, c.name, c.created_at,
          (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users,
          (SELECT COUNT(DISTINCT period) FROM uploads x WHERE x.company_id = c.id) AS months,
          (SELECT MAX(period) FROM uploads x WHERE x.company_id = c.id) AS latest,
          (SELECT MAX(created_at) FROM uploads x WHERE x.company_id = c.id) AS last_upload
        FROM companies c ORDER BY c.name`).all();
      const users = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.company_id, c.code AS company_code, u.disabled,
          u.must_change_password, (u.totp_secret IS NOT NULL) AS two_step, u.last_login_at, u.created_at
        FROM users u LEFT JOIN companies c ON c.id = u.company_id ORDER BY u.role = 'advisor' DESC, c.code, u.email`).all();
      const activity = db.prepare(`SELECT a.at, a.email, a.action, c.code AS company_code, a.detail, a.ip
        FROM audit a LEFT JOIN companies c ON c.id = a.company_id ORDER BY a.id DESC LIMIT 200`).all();
      send(res, 200, { companies, users, activity });
    },
    'POST /api/admin/company': async (req, res) => {
      const u = requireAdvisor(req);
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
    // Creates a login with a one-time password that must be changed at first sign-in.
    'POST /api/admin/user': async (req, res) => {
      const u = requireAdvisor(req);
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const role = body.role;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Enter the person\'s name.');
      if (!['viewer', 'accountant', 'advisor'].includes(role)) throw new HttpError(400, 'Choose a role.');
      let companyId = null;
      if (role !== 'advisor') {
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
      const u = requireAdvisor(req);
      const body = await readJson(req);
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(body.user_id));
      if (!target) throw new HttpError(404, 'User not found.');
      if (target.id === u.id && body.action !== 'reset-password') throw new HttpError(400, 'You cannot change this for your own login. Ask another advisor.');
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

    'GET /api/uploads': async (req, res, url) => {
      const u = requireUser(req);
      const c = companyFor(u, url.searchParams.get('company'));
      send(res, 200, { company: c, uploads: store.uploadHistory(db, c.id) });
    },

    // Body: { company?, filename, sheets: {name: rows[][]} }            full workbook
    //   or: { company?, filename, section, period, sheets: {name: rows} } one section from CSV
    'POST /api/upload': async (req, res) => {
      const u = requireUser(req);
      if (u.role === 'viewer') throw new HttpError(403, 'Your login can view the dashboard but not upload data.');
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
        data = store.latestDataset(db, c.id, period) || {
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
      if (route) {
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
  http.createServer(createApp(db)).listen(port, () => console.log(`Assura Elevate running on http://localhost:${port}`));
}

module.exports = { createApp };
