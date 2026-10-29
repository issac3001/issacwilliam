#!/usr/bin/env node
/*
 * Account administration for Assura Elevate (run on the server).
 *   node tools/admin.js add-company AE-0003 "Client Name Pvt Ltd"
 *   node tools/admin.js add-user md@client.com "Full Name" client AE-0003      view only, that company only
 *   node tools/admin.js add-user name@assura.example "Full Name" team --id rishad.k   every client, upload and edit
 *   node tools/admin.js add-user name@assura.example "Full Name" admin --id issac    also manages team logins
 *   node tools/admin.js set-id name@assura.example issac                             sets or changes a user ID
 *   node tools/admin.js list
 * Team logins sign in at /team with their user ID; clients at /client with their user ID or email.
 * New users get a one-time password, printed once, which they must change at first sign-in.
 * Use this for the first admin; after that, use the "Clients & users" screen.
 */
'use strict';
const store = require('../server/db');

const argv = process.argv.slice(2);
const idAt = argv.indexOf('--id');
const loginId = idAt >= 0 ? String(argv.splice(idAt, 2)[1] || '').toLowerCase() : null;
const [cmd, ...args] = argv;
if (loginId !== null && !store.LOGIN_ID.test(loginId)) throw new Error('A user ID is 3 to 40 letters or numbers; dots, hyphens and underscores are allowed.');
const db = store.open();

if (cmd === 'add-company') {
  const [code, name] = args;
  if (!code || !name) throw new Error('Usage: add-company CODE "Name"');
  const c = store.createCompany(db, code.toUpperCase(), name);
  store.audit(db, { user: null, action: 'admin.company_added', companyId: c.id, detail: `${c.code} ${c.name} (command line)` });
  console.log(c);
} else if (cmd === 'add-user') {
  const [email, name, role, code] = args;
  if (!email || !name || !store.ROLES.includes(role)) throw new Error('Usage: add-user EMAIL "Name" client|team|admin [COMPANY_CODE for client]');
  let companyId = null;
  if (role === 'client') {
    const c = db.prepare('SELECT id FROM companies WHERE code = ?').get(String(code || '').toUpperCase());
    if (!c) throw new Error(`Company ${code} not found.`);
    companyId = c.id;
  }
  const password = store.temporaryPassword();
  if (store.isStaff(role) && !loginId) throw new Error('Team and admin logins need a user ID: add --id name');
  const u = store.createUser(db, { email: email.toLowerCase(), name, role, companyId, password, mustChange: true, loginId });
  store.audit(db, { user: null, action: 'admin.user_added', companyId, detail: `${u.email} as ${u.role} (command line)` });
  console.log(`Created ${u.role} ${u.email}${u.login_id ? ', user ID ' + u.login_id : ''}. One-time password: ${password}`);
} else if (cmd === 'set-id') {
  const [email, id] = args;
  const want = String(id || '').toLowerCase();
  if (!email || !store.LOGIN_ID.test(want)) throw new Error('Usage: set-id EMAIL USER_ID');
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (!u) throw new Error(`No login with email ${email}.`);
  if (db.prepare('SELECT 1 FROM users WHERE (login_id = ? OR email = ?) AND id <> ?').get(want, want, u.id)) throw new Error(`User ID ${want} is already taken.`);
  db.prepare('UPDATE users SET login_id = ? WHERE id = ?').run(want, u.id);
  console.log(`${email} signs in with user ID ${want}`);
} else if (cmd === 'list') {
  console.table(db.prepare('SELECT u.login_id AS user_id, u.email, u.name, u.role, c.code AS company, u.disabled, (u.totp_secret IS NOT NULL) AS two_step FROM users u LEFT JOIN companies c ON c.id = u.company_id ORDER BY c.code, u.role').all());
} else {
  console.log('Commands: add-company, add-user, set-id, list');
}
