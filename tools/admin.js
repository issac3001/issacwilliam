#!/usr/bin/env node
/*
 * Account administration for Assura Elevate (run on the server).
 *   node tools/admin.js add-company AE-0003 "Client Name Pvt Ltd"
 *   node tools/admin.js add-user md@client.com "Full Name" viewer|accountant AE-0003
 *   node tools/admin.js add-user partner@assura.example "Full Name" advisor
 *   node tools/admin.js list
 * New users get a one-time password, printed once, which they must change at first sign-in.
 * Advisors also set up two-step login at first sign-in. Day-to-day, use the "Clients & users" screen instead.
 */
'use strict';
const store = require('../server/db');

const [cmd, ...args] = process.argv.slice(2);
const db = store.open();

if (cmd === 'add-company') {
  const [code, name] = args;
  if (!code || !name) throw new Error('Usage: add-company CODE "Name"');
  const c = store.createCompany(db, code.toUpperCase(), name);
  store.audit(db, { user: null, action: 'admin.company_added', companyId: c.id, detail: `${c.code} ${c.name} (command line)` });
  console.log(c);
} else if (cmd === 'add-user') {
  const [email, name, role, code] = args;
  if (!email || !name || !['viewer', 'accountant', 'advisor'].includes(role)) throw new Error('Usage: add-user EMAIL "Name" viewer|accountant|advisor [COMPANY_CODE]');
  let companyId = null;
  if (role !== 'advisor') {
    const c = db.prepare('SELECT id FROM companies WHERE code = ?').get(String(code || '').toUpperCase());
    if (!c) throw new Error(`Company ${code} not found.`);
    companyId = c.id;
  }
  const password = store.temporaryPassword();
  const u = store.createUser(db, { email: email.toLowerCase(), name, role, companyId, password, mustChange: true });
  store.audit(db, { user: null, action: 'admin.user_added', companyId, detail: `${u.email} as ${u.role} (command line)` });
  console.log(`Created ${u.role} ${u.email}. One-time password: ${password}`);
} else if (cmd === 'list') {
  console.table(db.prepare('SELECT u.email, u.name, u.role, c.code AS company, u.disabled, (u.totp_secret IS NOT NULL) AS two_step FROM users u LEFT JOIN companies c ON c.id = u.company_id ORDER BY c.code, u.role').all());
} else {
  console.log('Commands: add-company, add-user, list');
}
