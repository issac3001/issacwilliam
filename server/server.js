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

  function currentUser(req) {
    const token = cookies(req).ae_session;
    if (!token) return null;
    const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.company_id, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }

  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in.');
    return u;
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
    return { id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id };
  }

  const routes = {
    'POST /api/login': async (req, res) => {
      const { email, password } = await readJson(req);
      const key = String(email || '').toLowerCase();
      const a = attempts.get(key);
      if (a && a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(key);
      if (!u || !store.verifyPassword(String(password || ''), u.password_hash)) {
        const n = (a ? a.n : 0) + 1;
        attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + SESSION_DAYS * 86400000);
      send(res, 200, { user: publicUser(u) }, {
        'Set-Cookie': `ae_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`,
      });
    },

    'POST /api/logout': async (req, res) => {
      const token = cookies(req).ae_session;
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
      send(res, 200, { ok: true }, { 'Set-Cookie': 'ae_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    },

    'GET /api/me': async (req, res) => {
      const u = requireUser(req);
      const companies = u.role === 'advisor'
        ? db.prepare('SELECT id, code, name FROM companies ORDER BY name').all()
        : db.prepare('SELECT id, code, name FROM companies WHERE id = ?').all(u.company_id);
      send(res, 200, { user: publicUser(u), companies });
    },

    'GET /api/dashboard': async (req, res, url) => {
      const u = requireUser(req);
      const c = companyFor(u, url.searchParams.get('company'));
      const datasets = store.currentDatasets(db, c.id);
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
        if (errors.length) throw new HttpError(422, 'The file needs fixing before it can be accepted.', { errors, warnings: parsed.warnings });
        period = comp.period; data = parsed.data; warnings = parsed.warnings; sections = parsed.sections;
      }
      const version = store.saveUpload(db, { companyId: c.id, period, userId: u.id, filename: String(body.filename || '').slice(0, 200), sections, warnings, data });
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
