#!/usr/bin/env node
/*
 * Encrypted database backups. Everything the portal and Workflow keep is in the one database file,
 * so one snapshot of it is a complete backup.
 *
 *   node tools/backup.js                      take a snapshot, check it opens, copy it off the server, prune old ones
 *   node tools/backup.js verify [FILE]        check that a backup (default: the newest) decrypts and opens cleanly
 *   node tools/backup.js status               what is kept, newest first
 *   node tools/backup.js restore FILE OUT.db  decrypt a backup to a new .db file (never touches the live database)
 *
 * Run hourly from cron (deploy/assura-backup.cron). Kept on the server (see keep() below):
 *   every snapshot from the last 24 hours, the last one of each day for 30 days, the last one of
 *   each month for 12 months. That is about 66 files at most, each the size of the compressed database.
 * With AE_OFFSITE_* set, each snapshot is also copied to object storage (tools/offsite.js), so a
 * lost server does not lose the backups.
 *
 * Needs AE_BACKUP_KEY (keep a copy away from the server: without it no backup can be read).
 * Format AEBK2: "AEBK2" | salt(16) | iv(12) | AES-256-GCM(gzip(sqlite snapshot)) | tag(16); key = scrypt(AE_BACKUP_KEY, salt).
 * Files in the older AEBK1 format (tag before the data) still restore.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const store = require('../server/db');

const MAGIC1 = Buffer.from('AEBK1');
const MAGIC2 = Buffer.from('AEBK2');
const dir = () => process.env.AE_BACKUP_DIR || path.join(__dirname, '..', 'backups');
const NAME = /^assura-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db\.gz\.enc$/;
const STATUS = 'backup-status.json';

function key(salt) {
  const secret = process.env.AE_BACKUP_KEY;
  if (!secret || secret.length < 16) throw new Error('Set AE_BACKUP_KEY (at least 16 characters) before running backups.');
  return crypto.scryptSync(secret, salt, 32);
}

// Small payloads in memory (kept for tests and old callers).
function encrypt(plain) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(salt), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC2, salt, iv, body, c.getAuthTag()]);
}
function decrypt(buf) {
  const v1 = buf.subarray(0, 5).equals(MAGIC1);
  if (!v1 && !buf.subarray(0, 5).equals(MAGIC2)) throw new Error('Not an Assura Elevate backup file.');
  const salt = buf.subarray(5, 21); const iv = buf.subarray(21, 33);
  const tag = v1 ? buf.subarray(33, 49) : buf.subarray(buf.length - 16);
  const body = v1 ? buf.subarray(49) : buf.subarray(33, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key(salt), iv);
  d.setAuthTag(tag);
  return zlib.gunzipSync(Buffer.concat([d.update(body), d.final()]));
}

// Streams so a large database never has to fit in memory.
async function encryptFile(src, out) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(salt), iv);
  const tmp = `${out}.part`;
  const w = fs.createWriteStream(tmp, { mode: 0o600 });
  w.write(Buffer.concat([MAGIC2, salt, iv]));
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), c, w, { end: false });
  await new Promise((resolve, reject) => w.end(c.getAuthTag(), (e) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, out);
}
async function decryptFile(file, out) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(49); fs.readSync(fd, head, 0, 49, 0);
  const v1 = head.subarray(0, 5).equals(MAGIC1);
  if (!v1 && !head.subarray(0, 5).equals(MAGIC2)) { fs.closeSync(fd); throw new Error('Not an Assura Elevate backup file.'); }
  const tag = Buffer.alloc(16);
  fs.readSync(fd, tag, 0, 16, v1 ? 33 : size - 16); fs.closeSync(fd);
  const d = crypto.createDecipheriv('aes-256-gcm', key(head.subarray(5, 21)), head.subarray(21, 33));
  d.setAuthTag(tag);
  const start = v1 ? 49 : 33; const end = v1 ? size - 1 : size - 17;
  await pipeline(fs.createReadStream(file, { start, end }), d, zlib.createGunzip(), fs.createWriteStream(out, { mode: 0o600, flags: 'wx' }));
}

// Decrypts to a scratch file and checks the database inside is whole. Returns what it holds.
async function verify(file) {
  const tmp = path.join(path.dirname(file), `.verify-${process.pid}-${Date.now()}.db`);
  try {
    await decryptFile(file, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      const check = db.prepare('PRAGMA integrity_check').get();
      const result = Object.values(check)[0];
      if (result !== 'ok') throw new Error(`The database inside ${path.basename(file)} is damaged: ${result}`);
      const count = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; } };
      return { ok: true, companies: count('companies'), users: count('users'), uploads: count('uploads') };
    } finally { db.close(); }
  } finally { fs.rmSync(tmp, { force: true }); }
}

const stampOf = (f) => { const m = f.match(NAME); return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null; };
function list(d = dir()) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => NAME.test(f)).sort().reverse()
    .map((f) => ({ file: f, at: stampOf(f), size: fs.statSync(path.join(d, f)).size }));
}

/**
 * Which backups to keep, newest first: everything from the last 24 hours, the newest of each day
 * for 30 days, the newest of each month for 12 months, and always the newest 3 whatever their age.
 */
function keep(files, now = Date.now()) {
  const sorted = files.slice().sort((a, b) => b.at - a.at);
  const kept = new Set(sorted.slice(0, 3).map((x) => x.file));
  const days = new Set(); const months = new Set();
  sorted.forEach((x) => {
    const age = now - x.at; const iso = new Date(x.at).toISOString();
    if (age <= 24 * 3600e3) kept.add(x.file);
    if (age <= 30 * 86400e3 && !days.has(iso.slice(0, 10))) { days.add(iso.slice(0, 10)); kept.add(x.file); }
    if (age <= 366 * 86400e3 && !months.has(iso.slice(0, 7))) { months.add(iso.slice(0, 7)); kept.add(x.file); }
  });
  return kept;
}

function readStatus(d = dir()) {
  try { return JSON.parse(fs.readFileSync(path.join(d, STATUS), 'utf8')); } catch { return null; }
}
function writeStatus(patch, d = dir()) {
  const next = Object.assign(readStatus(d) || {}, patch);
  fs.writeFileSync(path.join(d, STATUS), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Takes a snapshot, checks it, copies it off the server when that is set up, and prunes. Returns the file path. */
async function backup(dbPath = store.DB_PATH, { offsite = require('./offsite') } = {}) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const tmp = path.join(d, `.snapshot-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  // VACUUM INTO makes a consistent copy while the portal keeps running.
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA busy_timeout = 10000'); db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  const name = `assura-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z.db.gz.enc`;
  const out = path.join(d, name);
  try { await encryptFile(tmp, out); } finally { fs.rmSync(tmp, { force: true }); }
  const size = fs.statSync(out).size;
  let checked;
  try { checked = await verify(out); } catch (e) {
    writeStatus({ last_failure: new Date().toISOString(), last_error: `Backup ${name} did not pass its check: ${e.message}` }, d);
    throw e;
  }
  writeStatus({ last_backup: name, last_backup_at: new Date().toISOString(), last_size: size, last_check: checked, last_error: null }, d);

  const all = list(d); const kept = keep(all);
  all.filter((x) => !kept.has(x.file)).forEach((x) => fs.rmSync(path.join(d, x.file), { force: true }));

  const cfg = offsite.config();
  if (cfg) {
    try {
      await offsite.put(cfg, name, out);
      await offsite.prune(cfg, keep);
      writeStatus({ offsite_last: name, offsite_at: new Date().toISOString(), offsite_error: null, offsite_where: offsite.describe(cfg) }, d);
    } catch (e) {
      writeStatus({ offsite_error: `${new Date().toISOString()}: ${e.message}` }, d);
      const err = new Error(`Backup ${name} is saved and checked on the server, but the off-server copy failed: ${e.message}`);
      err.code = 'OFFSITE'; throw err;
    }
  }
  return out;
}

// What the admin page shows: when the last backup ran, whether it checked out, and what is kept.
function summary(d = dir()) {
  const s = readStatus(d) || {};
  const files = list(d);
  return {
    last_backup_at: s.last_backup_at || null, last_size: s.last_size || null, last_check: s.last_check || null,
    last_error: s.last_error || null, kept: files.length, kept_bytes: files.reduce((a, x) => a + x.size, 0),
    oldest_at: files.length ? new Date(files[files.length - 1].at).toISOString() : null,
    offsite: s.offsite_where ? { where: s.offsite_where, last_at: s.offsite_at || null, error: s.offsite_error || null } : (s.offsite_error ? { error: s.offsite_error } : null),
  };
}

if (require.main === module) {
  const [cmd, file, out] = process.argv.slice(2);
  const run = async () => {
    if (cmd === 'restore') {
      if (!file || !out) throw new Error('Usage: restore BACKUP_FILE OUTPUT.db');
      if (fs.existsSync(out)) throw new Error(`${out} already exists; choose a new file name.`);
      await decryptFile(file, out);
      console.log(`Restored to ${out}. Stop the server and swap it in for the live database to use it (see DEPLOY.md).`);
    } else if (cmd === 'verify') {
      const target = file || (list()[0] && path.join(dir(), list()[0].file));
      if (!target) throw new Error('No backups found.');
      console.log(`${path.basename(target)}: ${JSON.stringify(await verify(target))}`);
    } else if (cmd === 'status') {
      console.log(JSON.stringify(summary(), null, 2));
      list().forEach((x) => console.log(`${x.file}  ${(x.size / 1e6).toFixed(1)} MB`));
    } else {
      const f = await backup();
      console.log(`${new Date().toISOString()} Backup written and checked: ${f}`);
    }
  };
  // Exit 2: the backup is safe on the server but was not copied off it; exit 1: no good backup was made.
  run().catch((e) => { console.error(`${new Date().toISOString()} BACKUP ${e.code === 'OFFSITE' ? 'NOT COPIED OFF THE SERVER' : 'FAILED'}: ${e.message}`); process.exit(e.code === 'OFFSITE' ? 2 : 1); });
}

module.exports = { backup, verify, encrypt, decrypt, encryptFile, decryptFile, keep, list, summary };
