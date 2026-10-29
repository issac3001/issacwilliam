#!/usr/bin/env node
/*
 * Fills a demo database: one fictional client company with 12 months of sample data, and two demo logins.
 *   demo.client   client: Meridian Polymers Pvt Ltd (Demo) only, view only
 *   demo.staff    Assura team member: the practice workspace (Managing Partner's seat) and the client dashboard
 * Password for both: demo-password. The firm structure behind the workspace uses placeholder people
 * ("Taxation Head, Bangalore" and so on) who cannot sign in.
 * Runs only against a demo or local database, never the live portal's (see deploy/demo-reset.sh).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../server/db');

if (process.env.AE_SECURE_COOKIE === '1' && process.env.AE_DEMO !== '1') {
  console.error('Refusing to load demo data: this looks like the live portal. The demo runs as its own server with AE_DEMO=1.');
  process.exit(1);
}

const SAMPLES = path.join(__dirname, '..', 'samples', 'json');
const PASSWORD = 'demo-password';
const db = store.open();
const code = 'AE-0001';
const name = 'Meridian Polymers Pvt Ltd (Demo)';

if (db.prepare('SELECT 1 FROM companies WHERE code = ?').get(code)) { console.log('Demo data exists, skipped'); process.exit(0); }
const company = store.createCompany(db, code, name);
for (const f of fs.readdirSync(path.join(SAMPLES, code)).sort()) {
  const data = JSON.parse(fs.readFileSync(path.join(SAMPLES, code, f), 'utf8'));
  store.saveUpload(db, { companyId: company.id, period: data.company.period, userId: null, filename: `sample ${f.replace('.json', '.xlsx')}`, sections: Object.keys(data), warnings: [], data });
  // The sample workbooks carry this reference, so they can be uploaded again to try the checks.
  store.issueWorkbook(db, { companyId: company.id, period: data.company.period, ref: `${code}-${data.company.period}-SAMPLE`, method: 'download' });
}
db.prepare('UPDATE companies SET data_email = ? WHERE id = ?').run('accounts@meridian.demo', company.id);

store.createUser(db, { email: 'client@meridian.demo', loginId: 'demo.client', name: 'Managing Director (Demo)', role: 'client', companyId: company.id, password: PASSWORD });
const staff = store.createUser(db, { email: 'staff@assura.demo', loginId: 'demo.staff', name: 'Demo Staff', role: 'team', companyId: null, password: PASSWORD });
// Sets up the firm structure; nobody signs in with it.
const setup = store.createUser(db, { email: 'setup@assura.demo', name: 'Demo setup', role: 'admin', companyId: null, password: crypto.randomBytes(24).toString('base64url') });
db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(setup.id);

// Practice workspace: placeholder firm in Bangalore and Calicut, the one demo client and two months of history.
const W = require('../shared/workflow');
W.install(db);
const wf = W.createWorkflow(db);
require('./demo/workflow-seed').seed(db, wf, {
  today: new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10),
  admin: db.prepare('SELECT * FROM users WHERE id = ?').get(setup.id),
  only: [code],
  ensureCompany: (c, n) => (db.prepare('SELECT id FROM companies WHERE code = ?').get(c) || store.createCompany(db, c, n)).id,
  // demo.staff takes the Managing Partner's seat, so the demo shows the whole firm. Everyone else is a placeholder with no usable password.
  makeUser: (email, n, role) => (email === 'mp@assura.demo' ? db.prepare('SELECT * FROM users WHERE id = ?').get(staff.id)
    : db.prepare('SELECT * FROM users WHERE email = ?').get(email) || store.createUser(db, { email, name: n, role, companyId: null, password: crypto.randomBytes(24).toString('base64url') })),
});
console.log(`Demo ready. Client: demo.client  Team: demo.staff  Password: ${PASSWORD}`);
