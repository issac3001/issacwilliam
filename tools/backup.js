#!/usr/bin/env node
/*
 * Encrypted database backups.
 *   AE_BACKUP_KEY=... node tools/backup.js                 snapshot -> backups/assura-<UTC time>.db.gz.enc, keeps the newest 30
 *   AE_BACKUP_KEY=... node tools/backup.js restore FILE OUT decrypts a backup to a .db file (does not touch the live database)
 * Run daily from cron, e.g.  15 2 * * *  cd /srv/assura && AE_BACKUP_KEY=... node tools/backup.js
 * Copy the backups folder off the server (for example to object storage) as well; keep the key separately.
 * Format: "AEBK1" | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(sqlite snapshot)); key = scrypt(AE_BACKUP_KEY, salt).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('../server/db');

const MAGIC = Buffer.from('AEBK1');
const DIR = process.env.AE_BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP = Number(process.env.AE_BACKUP_KEEP || 30);

function key(salt) {
  const secret = process.env.AE_BACKUP_KEY;
  if (!secret || secret.length < 16) throw new Error('Set AE_BACKUP_KEY (at least 16 characters) before running backups.');
  return crypto.scryptSync(secret, salt, 32);
}

function encrypt(plain) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(salt), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

function decrypt(buf) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('Not an Assura Elevate backup file.');
  const salt = buf.subarray(5, 21); const iv = buf.subarray(21, 33); const tag = buf.subarray(33, 49);
  const d = crypto.createDecipheriv('aes-256-gcm', key(salt), iv);
  d.setAuthTag(tag);
  return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(49)), d.final()]));
}

function backup(dbPath = store.DB_PATH) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, `.snapshot-${process.pid}.db`);
  const db = store.open(dbPath);
  try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
  const out = path.join(DIR, `assura-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z.db.gz.enc`);
  fs.writeFileSync(out, encrypt(fs.readFileSync(tmp)), { mode: 0o600 });
  fs.rmSync(tmp);
  const all = fs.readdirSync(DIR).filter((f) => /^assura-.*\.db\.gz\.enc$/.test(f)).sort();
  all.slice(0, Math.max(0, all.length - KEEP)).forEach((f) => fs.rmSync(path.join(DIR, f)));
  return out;
}

if (require.main === module) {
  const [cmd, file, out] = process.argv.slice(2);
  if (cmd === 'restore') {
    if (!file || !out) throw new Error('Usage: restore BACKUP_FILE OUTPUT.db');
    if (fs.existsSync(out)) throw new Error(`${out} already exists; choose a new file name.`);
    fs.writeFileSync(out, decrypt(fs.readFileSync(file)), { mode: 0o600 });
    console.log(`Restored to ${out}. Stop the server and swap it in for data/assura.db to use it.`);
  } else {
    console.log(`Backup written: ${backup()}`);
  }
}

module.exports = { backup, encrypt, decrypt };
