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
      role TEXT NOT NULL CHECK (role IN ('viewer', 'accountant', 'advisor')),
      company_id INTEGER REFERENCES companies(id),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (role = 'advisor' OR company_id IS NOT NULL)
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
  `);
  return db;
}

// ---- passwords: scrypt with per-user salt ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
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
function createUser(db, { email, name, role, companyId, password }) {
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters.');
  db.prepare('INSERT INTO users (email, name, role, company_id, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, role, companyId ?? null, hashPassword(password));
  return db.prepare('SELECT id, email, name, role, company_id FROM users WHERE email = ?').get(email);
}

function saveUpload(db, { companyId, period, userId, filename, sections, warnings, data }) {
  const row = db.prepare('SELECT MAX(version) AS v FROM uploads WHERE company_id = ? AND period = ?').get(companyId, period);
  const version = (row && row.v ? row.v : 0) + 1;
  db.prepare(`INSERT INTO uploads (company_id, period, version, uploaded_by, filename, sections, warnings, data)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(companyId, period, version, userId, filename || null, JSON.stringify(sections), JSON.stringify(warnings), JSON.stringify(data));
  return version;
}

// Latest version of each period for a company.
function currentDatasets(db, companyId) {
  return db.prepare(`
    SELECT u.period, u.data FROM uploads u
    JOIN (SELECT period, MAX(version) AS v FROM uploads WHERE company_id = ? GROUP BY period) m
      ON m.period = u.period AND m.v = u.version
    WHERE u.company_id = ? ORDER BY u.period`).all(companyId, companyId)
    .map((r) => ({ period: r.period, data: JSON.parse(r.data) }));
}

function latestDataset(db, companyId, period) {
  const r = db.prepare('SELECT data FROM uploads WHERE company_id = ? AND period = ? ORDER BY version DESC LIMIT 1').get(companyId, period);
  return r ? JSON.parse(r.data) : null;
}

function uploadHistory(db, companyId) {
  return db.prepare(`
    SELECT u.period, u.version, u.filename, u.sections, u.warnings, u.created_at, us.name AS uploaded_by
    FROM uploads u LEFT JOIN users us ON us.id = u.uploaded_by
    WHERE u.company_id = ? ORDER BY u.created_at DESC, u.id DESC LIMIT 100`).all(companyId)
    .map((r) => Object.assign({}, r, { sections: JSON.parse(r.sections), warnings: JSON.parse(r.warnings) }));
}

module.exports = { open, hashPassword, verifyPassword, createCompany, createUser, saveUpload, currentDatasets, latestDataset, uploadHistory, DB_PATH };
