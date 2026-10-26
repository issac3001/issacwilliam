'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.AE_DB || path.join(__dirname, '..', 'data', 'assura.db');

function open(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('client', 'team', 'admin')),
      company_id INTEGER REFERENCES companies(id),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (role <> 'client' OR company_id IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    -- Every upload is kept. The newest version of a period is the live one.
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      period TEXT NOT NULL,
      version INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      filename TEXT,
      sections TEXT NOT NULL,
      warnings TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (company_id, period, version)
    );
    -- Who did what, when. Kept for the life of the database.
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      user_id INTEGER,
      email TEXT,
      action TEXT NOT NULL,
      company_id INTEGER,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
    -- Explanations of the month's movements. Drafts are worked out from the data each time;
    -- a row exists once the Assura team has reviewed one. Only 'accepted' rows reach the client.
    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      period TEXT NOT NULL,
      key TEXT NOT NULL,
      area TEXT NOT NULL,
      status TEXT NOT NULL,
      headline TEXT NOT NULL,
      body TEXT NOT NULL,
      causes TEXT NOT NULL DEFAULT '[]',
      data_version INTEGER,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE (company_id, period, key)
    );
    -- Each monthly workbook the Assura team sends (or downloads) for a client. The reference
    -- printed on its locked first sheet must come back with the data.
    CREATE TABLE IF NOT EXISTS workbooks (
      id INTEGER PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      period TEXT NOT NULL,
      ref TEXT UNIQUE NOT NULL,
      method TEXT NOT NULL,
      sent_to TEXT,
      issued_by INTEGER REFERENCES users(id),
      issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      received_version INTEGER,
      received_at TEXT
    );
  `);
  migrate(db);
  return db;
}

// Roles: 'client' (one company, view only), 'team' (Assura staff: every client, upload and edit),
// 'admin' (Assura staff who also manage team logins).
const ROLES = ['client', 'team', 'admin'];
const isStaff = (role) => role === 'team' || role === 'admin';

// Changes made after the first release. Existing data is always kept.
function migrate(db) {
  // First release roles were viewer / accountant / advisor. Clients are now view only, so both
  // client roles become 'client'; advisors become 'admin' so they can still manage the team.
  const usersSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() || {}).sql || '';
  if (usersSql.includes("'viewer'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      db.exec(usersSql.replace(/CREATE TABLE "?users"?/, 'CREATE TABLE users_new')
        .replace("CHECK (role IN ('viewer', 'accountant', 'advisor'))", "CHECK (role IN ('client', 'team', 'admin'))")
        .replace("CHECK (role = 'advisor' OR company_id IS NOT NULL)", "CHECK (role <> 'client' OR company_id IS NOT NULL)"));
      const list = cols.join(', ');
      const sel = cols.map((c) => (c === 'role' ? "CASE role WHEN 'advisor' THEN 'admin' ELSE 'client' END" : c)).join(', ');
      db.exec(`INSERT INTO users_new (${list}) SELECT ${sel} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }

  const have = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const add = (table, col, def) => { if (!have(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'totp_secret', 'TEXT');
  add('users', 'totp_pending', 'TEXT');
  add('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'last_login_at', 'TEXT');
  // stage: 'full', or a restricted session that may only finish setting up the account.
  add('sessions', 'stage', "TEXT NOT NULL DEFAULT 'full'");
  add('sessions', 'last_seen', 'INTEGER NOT NULL DEFAULT 0');
  // How a version was made: a file name for uploads, or a note such as "Edited: Sales" for portal edits.
  add('uploads', 'source', "TEXT NOT NULL DEFAULT 'upload'");
  // Where the monthly workbook is emailed: the client's accounts contact(s), comma separated.
  add('companies', 'data_email', 'TEXT');
}

function audit(db, { user, action, companyId = null, detail = null, ip = null }) {
  db.prepare('INSERT INTO audit (user_id, email, action, company_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user ? user.id ?? null : null, user ? user.email ?? null : null, action, companyId, detail == null ? null : String(detail).slice(0, 500), ip);
}

// ---- passwords: scrypt with per-user salt ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
// The same check without holding up other requests while the hash is worked out (used at sign-in).
function verifyPasswordAsync(pw, stored) {
  const [, saltHex, keyHex] = String(stored || '').split('$');
  if (!saltHex || !keyHex) return Promise.resolve(false);
  return new Promise((resolve, reject) => crypto.scrypt(pw, Buffer.from(saltHex, 'hex'), 64, (err, key) => {
    if (err) return reject(err);
    const want = Buffer.from(keyHex, 'hex');
    resolve(want.length === key.length && crypto.timingSafeEqual(key, want));
  }));
}
function verifyPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

function createCompany(db, code, name) {
  db.prepare('INSERT INTO companies (code, name) VALUES (?, ?)').run(code, name);
  return db.prepare('SELECT * FROM companies WHERE code = ?').get(code);
}
function passwordProblem(pw, email) {
  if (!pw || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (email && pw.toLowerCase().includes(String(email).split('@')[0].toLowerCase())) return 'Do not include your email name in the password.';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password\d*|qwertyuiop)$/i.test(pw)) return 'Choose a less predictable password.';
  return null;
}

// A one-time password for a new user or a reset: readable, 14 characters, about 80 bits.
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${s.slice(0, 7)}-${s.slice(7)}`;
}

function createUser(db, { email, name, role, companyId, password, mustChange = false }) {
  const problem = passwordProblem(password, null);
  if (problem) throw new Error(problem);
  db.prepare('INSERT INTO users (email, name, role, company_id, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(email).toLowerCase(), name, role, companyId ?? null, hashPassword(password), mustChange ? 1 : 0);
  return db.prepare('SELECT id, email, name, role, company_id FROM users WHERE email = ?').get(String(email).toLowerCase());
}

function setPassword(db, userId, password, mustChange) {
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(hashPassword(password), mustChange ? 1 : 0, userId);
}

function saveUpload(db, { companyId, period, userId, filename, sections, warnings, data, source = 'upload' }) {
  const row = db.prepare('SELECT MAX(version) AS v FROM uploads WHERE company_id = ? AND period = ?').get(companyId, period);
  const version = (row && row.v ? row.v : 0) + 1;
  db.prepare(`INSERT INTO uploads (company_id, period, version, uploaded_by, filename, sections, warnings, data, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(companyId, period, version, userId, filename || null, JSON.stringify(sections), JSON.stringify(warnings), JSON.stringify(data), source);
  return version;
}

// Latest version of each period for a company.
function currentDatasets(db, companyId) {
  return db.prepare(`
    SELECT u.period, u.data FROM uploads u
    JOIN (SELECT period, MAX(version) AS v FROM uploads WHERE company_id = ? GROUP BY period) m
      ON m.period = u.period AND m.v = u.version
    WHERE u.company_id = ? ORDER BY u.period`).all(companyId, companyId)
    .map((r) => ({ period: r.period, data: JSON.parse(r.data) }))
    .filter((d) => !d.data.removed); // a removed month stays in history and can be restored
}

function latestDataset(db, companyId, period) {
  const r = db.prepare('SELECT data FROM uploads WHERE company_id = ? AND period = ? ORDER BY version DESC LIMIT 1').get(companyId, period);
  return r ? JSON.parse(r.data) : null;
}

// One stored version (latest when version is omitted), with its version number.
function datasetVersion(db, companyId, period, version) {
  const r = version
    ? db.prepare('SELECT version, data FROM uploads WHERE company_id = ? AND period = ? AND version = ?').get(companyId, period, Number(version))
    : db.prepare('SELECT version, data FROM uploads WHERE company_id = ? AND period = ? ORDER BY version DESC LIMIT 1').get(companyId, period);
  return r ? { version: r.version, data: JSON.parse(r.data) } : null;
}

// Review states for explanations. 'accepted' is shown to the client; 'set-aside' is kept for the
// team only. Later sign-off steps can add states here without a change to the table.
const INSIGHT_STATES = ['accepted', 'set-aside'];
function insightsFor(db, companyId, { period, acceptedOnly } = {}) {
  return db.prepare(`SELECT i.period, i.key, i.area, i.status, i.headline, i.body, i.causes, i.data_version, i.reviewed_at, us.name AS reviewed_by
      FROM insights i LEFT JOIN users us ON us.id = i.reviewed_by
      WHERE i.company_id = ? ${period ? 'AND i.period = ?' : ''} ${acceptedOnly ? "AND i.status = 'accepted'" : ''}
      ORDER BY i.period, i.id`).all(...[companyId].concat(period ? [period] : []))
    .map((r) => Object.assign({}, r, { causes: JSON.parse(r.causes) }));
}
function saveInsight(db, { companyId, period, key, area, status, headline, body, causes, dataVersion, userId }) {
  db.prepare(`INSERT INTO insights (company_id, period, key, area, status, headline, body, causes, data_version, reviewed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (company_id, period, key) DO UPDATE SET area = excluded.area, status = excluded.status, headline = excluded.headline,
        body = excluded.body, causes = excluded.causes, data_version = excluded.data_version, reviewed_by = excluded.reviewed_by,
        reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`)
    .run(companyId, period, key, area, status, headline, body, JSON.stringify(causes || []), dataVersion == null ? null : dataVersion, userId);
}
function deleteInsight(db, companyId, period, key) {
  return db.prepare('DELETE FROM insights WHERE company_id = ? AND period = ? AND key = ?').run(companyId, period, key).changes;
}

function issueWorkbook(db, { companyId, period, ref, method, sentTo, userId }) {
  db.prepare('INSERT INTO workbooks (company_id, period, ref, method, sent_to, issued_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(companyId, period, ref, method, sentTo || null, userId == null ? null : userId);
}
function findWorkbook(db, ref) {
  return db.prepare(`SELECT w.*, c.code AS company_code, c.name AS company_name FROM workbooks w JOIN companies c ON c.id = w.company_id
    WHERE w.ref = ? COLLATE NOCASE`).get(String(ref || '').trim()) || null;
}
function workbooksFor(db, companyId) {
  return db.prepare(`SELECT w.period, w.ref, w.method, w.sent_to, w.issued_at, w.received_version, w.received_at, us.name AS issued_by
    FROM workbooks w LEFT JOIN users us ON us.id = w.issued_by WHERE w.company_id = ? ORDER BY w.id DESC LIMIT 60`).all(companyId);
}
function markWorkbookReceived(db, ref, version) {
  db.prepare("UPDATE workbooks SET received_version = ?, received_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE ref = ? COLLATE NOCASE").run(version, ref);
}

// The month's live data with when it first arrived, or null when the month has no data.
function periodUpload(db, companyId, period) {
  // Reads only the version and the removed mark, not the month's figures.
  const r = db.prepare(`SELECT MAX(version) AS version, MIN(created_at) AS at,
      (SELECT json_extract(data, '$.removed') FROM uploads WHERE company_id = ?1 AND period = ?2 ORDER BY version DESC LIMIT 1) AS removed
    FROM uploads WHERE company_id = ?1 AND period = ?2`).get(companyId, period);
  if (!r || !r.version || r.removed) return null;
  return { version: r.version, created_at: r.at };
}

// The accountant has returned the copy (by email, before it is uploaded).
function markWorkbookArrived(db, companyId, ref) {
  return db.prepare("UPDATE workbooks SET received_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE company_id = ? AND ref = ? COLLATE NOCASE AND received_at IS NULL").run(companyId, ref).changes;
}

function uploadHistory(db, companyId) {
  return db.prepare(`
    SELECT u.period, u.version, u.filename, u.source, u.sections, u.warnings, u.created_at, us.name AS uploaded_by
    FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by
    WHERE u.company_id = ? ORDER BY u.created_at DESC, u.id DESC LIMIT 100`).all(companyId)
    .map((r) => Object.assign({}, r, { sections: JSON.parse(r.sections), warnings: JSON.parse(r.warnings) }));
}

module.exports = { markWorkbookArrived, periodUpload, issueWorkbook, findWorkbook, workbooksFor, markWorkbookReceived, ROLES, isStaff, INSIGHT_STATES, insightsFor, saveInsight, deleteInsight, datasetVersion, open, audit, passwordProblem, temporaryPassword, setPassword, hashPassword, verifyPassword, verifyPasswordAsync, createCompany, createUser, saveUpload, currentDatasets, latestDataset, uploadHistory, DB_PATH };
