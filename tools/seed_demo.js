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
  }
  console.log(`${c.code} seeded`);
}
for (const [email, name, role] of [['team@assura.demo', 'Assura Team Member', 'team'], ['admin@assura.demo', 'Assura Admin', 'admin']])
  if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) store.createUser(db, { email, name, role, companyId: null, password: PASSWORD });
console.log(`Demo password for all demo logins: ${PASSWORD}`);
