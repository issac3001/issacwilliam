'use strict';
/*
 * Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30-second step),
 * compatible with Google Authenticator, Microsoft Authenticator and similar apps.
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, '0');
}

/** Returns the matched time step (to block replays) or null. Accepts one step of clock drift. */
function verify(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

function otpauthUri(secret, email) {
  const label = encodeURIComponent(`Assura Elevate:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Assura Elevate')}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { newSecret, verify, codeAt, otpauthUri, base32Encode, base32Decode };
