/*
 * Assura Elevate: sends email through the firm's own mail account (SMTP).
 * Works with any provider that offers SMTP with a username and password: Google Workspace,
 * Microsoft 365, Zoho Mail or Amazon SES. Nothing is sent until these are set on the server:
 *
 *   AE_SMTP_HOST   e.g. smtp.zoho.in, smtp.gmail.com, email-smtp.ap-south-1.amazonaws.com
 *   AE_SMTP_PORT   465 (TLS from the start) or 587 (STARTTLS). Default 587.
 *   AE_SMTP_USER   AE_SMTP_PASS   the mail account's SMTP login (an app password for Google or Microsoft)
 *   AE_MAIL_FROM   the address mail is sent from, e.g. "Assura Elevate <data@elevateassura.com>"
 */
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function config(env = process.env) {
  if (!env.AE_SMTP_HOST || !env.AE_MAIL_FROM) return null;
  const port = Number(env.AE_SMTP_PORT || 587);
  return {
    host: env.AE_SMTP_HOST, port, user: env.AE_SMTP_USER || '', pass: env.AE_SMTP_PASS || '', from: env.AE_MAIL_FROM,
    // 'tls' on 465, otherwise STARTTLS. 'none' is only for local testing against a mail catcher.
    secure: env.AE_SMTP_SECURE || (port === 465 ? 'tls' : 'starttls'),
  };
}

const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/.{76}/g, '$&\r\n');
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const addr = (s) => { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : String(s)).trim(); };
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ');

// msg: { to: [emails], replyTo, subject, text, html, attachments: [{ filename, content (Buffer), type }] }
function build(cfg, msg) {
  const mixed = `mixed-${crypto.randomBytes(8).toString('hex')}`;
  const alt = `alt-${crypto.randomBytes(8).toString('hex')}`;
  const domain = addr(cfg.from).split('@')[1] || 'localhost';
  const lines = [
    `From: ${clean(cfg.from)}`,
    `To: ${msg.to.map(clean).join(', ')}`,
    msg.replyTo ? `Reply-To: ${clean(msg.replyTo)}` : null,
    `Subject: ${header(clean(msg.subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(msg.text),
    `--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(msg.html || msg.text),
    `--${alt}--`,
  ];
  (msg.attachments || []).forEach((a) => lines.push(`--${mixed}`,
    `Content-Type: ${a.type || 'application/octet-stream'}; name="${clean(a.filename)}"`,
    `Content-Disposition: attachment; filename="${clean(a.filename)}"`,
    'Content-Transfer-Encoding: base64', '', b64(a.content)));
  lines.push(`--${mixed}--`, '');
  return lines.filter((l) => l !== null).join('\r\n').replace(/\r\n\./g, '\r\n..');
}

// Talks SMTP: one command at a time, each answered by a (possibly multi-line) reply.
function session(socket) {
  let buf = ''; let waiting = null;
  const onData = (d) => {
    buf += d.toString('utf8');
    const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
    if (m && waiting) { const w = waiting; waiting = null; const text = buf; buf = ''; w.resolve({ code: Number(m[1]), text }); }
  };
  const attach = (s) => { s.on('data', onData); s.on('error', (e) => { if (waiting) { waiting.reject(e); waiting = null; } }); };
  attach(socket);
  return {
    attach,
    read() { return new Promise((resolve, reject) => { waiting = { resolve, reject }; if (buf) onData(''); }); },
  };
}

async function sendMail(cfg, msg, { timeoutMs = 20000 } = {}) {
  if (!cfg) throw new Error('Email is not set up on this server yet.');
  const connect = () => new Promise((resolve, reject) => {
    const s = cfg.secure === 'tls' ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    s.once(cfg.secure === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  let socket = await connect();
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The mail server did not answer in time.')));
  const io = session(socket);
  const step = async (line, ok) => {
    if (line != null) socket.write(line + '\r\n');
    const r = await io.read();
    if (!ok.includes(r.code)) throw new Error(`The mail server refused the message (${r.text.trim().split('\r\n').pop()}).`);
    return r;
  };
  try {
    await step(null, [220]);
    const name = 'assura-elevate';
    let ehlo = await step(`EHLO ${name}`, [250]);
    if (cfg.secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('The mail server does not offer a secure connection on this port.');
      await step('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket = await new Promise((resolve, reject) => { const t = tls.connect({ socket, servername: cfg.host }, () => resolve(t)); t.once('error', reject); });
      io.attach(socket);
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The mail server did not answer in time.')));
      ehlo = await step(`EHLO ${name}`, [250]);
    }
    if (cfg.user) {
      await step('AUTH LOGIN', [334]);
      await step(Buffer.from(cfg.user).toString('base64'), [334]);
      await step(Buffer.from(cfg.pass).toString('base64'), [235]);
    }
    await step(`MAIL FROM:<${addr(cfg.from)}>`, [250]);
    for (const to of msg.to) await step(`RCPT TO:<${addr(to)}>`, [250, 251]);
    await step('DATA', [354]);
    await step(build(cfg, msg) + '\r\n.', [250]);
    await step('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

module.exports = { config, sendMail, build };
