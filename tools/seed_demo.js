#!/usr/bin/env node
/*
 * Loads the two fictional demo companies and their 12 months of sample data.
 * Demo logins (local demo only, password for all: demo-password):
 *   client@meridian.demo   client, AE-0001 only, view only
 *   client@coastline.demo  client, AE-0002 only, view only
 *   team@assura.demo       Assura team: every client, upload and edit
 *   admin@assura.demo      Assura admin: also manages team logins
 */
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../server/db');

const SAMPLES = path.join(__dirname, '..', 'samples', 'json');
const PASSWORD = 'demo-password';

const db = store.open();
const companies = [
  { code: 'AE-0001', name: 'Meridian Polymers Pvt Ltd (Demo)', slug: 'meridian' },
  { code: 'AE-0002', name: 'Coastline Foods Pvt Ltd (Demo)', slug: 'coastline' },
];
for (const c of companies) {
  if (db.prepare('SELECT 1 FROM companies WHERE code = ?').get(c.code)) { console.log(`${c.code} exists, skipped`); continue; }
  const row = store.createCompany(db, c.code, c.name);
  store.createUser(db, { email: `client@${c.slug}.demo`, name: 'Managing Director', role: 'client', companyId: row.id, password: PASSWORD });
  for (const f of fs.readdirSync(path.join(SAMPLES, c.code)).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(SAMPLES, c.code, f), 'utf8'));
    store.saveUpload(db, { companyId: row.id, period: data.company.period, userId: null, filename: `sample ${f.replace('.json', '.xlsx')}`, sections: Object.keys(data), warnings: [], data });
    // The sample workbooks carry this reference, so they can be uploaded again to try the checks.
    store.issueWorkbook(db, { companyId: row.id, period: data.company.period, ref: `${c.code}-${data.company.period}-SAMPLE`, method: 'download' });
  }
  db.prepare('UPDATE companies SET data_email = ? WHERE id = ?').run(`accounts@${c.slug}.demo`, row.id);
  console.log(`${c.code} seeded`);
}
for (const [email, name, role] of [['team@assura.demo', 'Assura Team Member', 'team'], ['admin@assura.demo', 'Assura Admin', 'admin']])
  if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) store.createUser(db, { email, name, role, companyId: null, password: PASSWORD });
console.log(`Demo password for all demo logins: ${PASSWORD}`);

// Internal workflow: placeholder team (password demo-password), four more fictional clients and two months of history.
const W = require('../shared/workflow');
W.install(db);
const wf = W.createWorkflow(db);
const out = require('./demo/workflow-seed').seed(db, wf, {
  today: new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10),
  admin: db.prepare("SELECT * FROM users WHERE email = 'admin@assura.demo'").get(),
  ensureCompany: (code, name) => (db.prepare('SELECT id FROM companies WHERE code = ?').get(code) || store.createCompany(db, code, name)).id,
  makeUser: (email, name, role) => db.prepare('SELECT * FROM users WHERE email = ?').get(email) || store.createUser(db, { email, name, role, companyId: null, password: PASSWORD }),
});
console.log(out.skipped ? 'Workflow demo exists, skipped' : 'Workflow demo seeded: md@assura.demo, ca.director@assura.demo, ca.manager1@assura.demo, ca.senior1@assura.demo, ca.analyst1@assura.demo (and the same for cs, legal, hr)');
