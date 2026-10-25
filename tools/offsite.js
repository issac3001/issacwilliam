/*
 * Copies backups to object storage away from the server: Amazon S3 or an AWS Lightsail bucket
 * (both speak the S3 API), signed with AWS Signature Version 4. No SDK needed.
 * Backups are already encrypted, so the storage provider only ever holds unreadable files.
 *
 * Set on the server (in assura.env), all four to switch it on:
 *   AE_OFFSITE_BUCKET      bucket name, e.g. assura-elevate-backups
 *   AE_OFFSITE_REGION      e.g. ap-south-1 (Mumbai)
 *   AE_OFFSITE_ACCESS_KEY  AE_OFFSITE_SECRET_KEY   an access key allowed to put, list and delete in that bucket only
 * Optional: AE_OFFSITE_PREFIX (default "portal-backups/"), AE_OFFSITE_ENDPOINT (another S3-compatible host).
 */
'use strict';
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function config(env = process.env) {
  if (!env.AE_OFFSITE_BUCKET || !env.AE_OFFSITE_ACCESS_KEY || !env.AE_OFFSITE_SECRET_KEY) return null;
  const region = env.AE_OFFSITE_REGION || 'ap-south-1';
  const cfg = {
    bucket: env.AE_OFFSITE_BUCKET, region, accessKey: env.AE_OFFSITE_ACCESS_KEY, secretKey: env.AE_OFFSITE_SECRET_KEY,
    prefix: env.AE_OFFSITE_PREFIX == null ? 'portal-backups/' : env.AE_OFFSITE_PREFIX,
    host: `${env.AE_OFFSITE_BUCKET}.s3.${region}.amazonaws.com`, port: null, insecure: false,
  };
  if (env.AE_OFFSITE_ENDPOINT) {
    // Another S3-compatible service, addressed as https://host[:port] (path-style is not used).
    const u = new URL(/^https?:\/\//.test(env.AE_OFFSITE_ENDPOINT) ? env.AE_OFFSITE_ENDPOINT : `https://${env.AE_OFFSITE_ENDPOINT}`);
    cfg.host = u.host; cfg.port = u.port || null; cfg.insecure = u.protocol === 'http:';
  }
  return cfg;
}
const describe = (cfg) => `${cfg.bucket} (${cfg.region})`;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (k, data) => crypto.createHmac('sha256', k).update(data).digest();
// RFC 3986 encoding, as Signature Version 4 requires.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request. req: { method, host, path (already encoded), query: {k: v}, headers: {lower-case: value}, payloadHash }.
 * Returns the headers to send, including Authorization.
 */
function sign(cfg, req, now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = Object.assign({}, req.headers, { host: req.host, 'x-amz-content-sha256': req.payloadHash, 'x-amz-date': amzDate });
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = Object.keys(req.query || {}).sort().map((k) => `${enc(k)}=${enc(req.query[k])}`).join('&');
  const canonical = [req.method, req.path, query, names.map((h) => `${h}:${lower[h]}\n`).join(''), names.join(';'), req.payloadHash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretKey}`, day), cfg.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return Object.assign(lower, { authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` });
}

function request(cfg, { method, key = '', query = {}, body = null, file = null, payloadHash, headers = {} }) {
  const path = `/${key.split('/').map(enc).join('/')}`;
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const signed = sign(cfg, { method, host: cfg.host, path, query, headers, payloadHash: payloadHash || sha256(body || '') });
  return new Promise((resolve, reject) => {
    const r = (cfg.insecure ? http : https).request({ host: cfg.host.split(':')[0], port: cfg.port || undefined, method, path: qs ? `${path}?${qs}` : path, headers: signed, timeout: 120000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 300) {
          const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || `HTTP ${res.statusCode}`;
          reject(new Error(`object storage said ${code}`)); return;
        }
        resolve(text);
      });
    });
    r.on('timeout', () => r.destroy(new Error('object storage did not answer in time')));
    r.on('error', reject);
    if (file) fs.createReadStream(file).on('error', reject).pipe(r);
    else r.end(body || undefined);
  });
}

async function put(cfg, name, file) {
  const hash = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
  await request(cfg, { method: 'PUT', key: cfg.prefix + name, file, payloadHash: hash,
    headers: { 'content-length': fs.statSync(file).size, 'content-type': 'application/octet-stream' } });
}

async function listNames(cfg) {
  const names = []; let token = null;
  do {
    const query = Object.assign({ 'list-type': '2', prefix: cfg.prefix }, token ? { 'continuation-token': token } : {});
    const xml = await request(cfg, { method: 'GET', query });
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) names.push(m[1].slice(cfg.prefix.length));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] : null;
  } while (token);
  return names;
}

// Applies the same keeping rule as the server's own copies (keep is tools/backup.js keep()).
async function prune(cfg, keep) {
  const NAME = /^assura-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db\.gz\.enc$/;
  const files = (await listNames(cfg)).map((f) => { const m = f.match(NAME); return m ? { file: f, at: Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) } : null; }).filter(Boolean);
  const kept = keep(files);
  for (const x of files) if (!kept.has(x.file)) await request(cfg, { method: 'DELETE', key: cfg.prefix + x.file });
}

module.exports = { config, describe, sign, put, prune, listNames };
