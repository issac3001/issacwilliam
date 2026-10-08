#!/usr/bin/env node
/*
 * Loads the two fictional demo companies and their 12 months of sample data.
 * Demo logins (local demo only, password for all: demo-password):
 *   md@meridian.demo (viewer, AE-0001)    accounts@meridian.demo (accountant, AE-0001)
 *   md@coastline.demo (viewer, AE-0002)   accounts@coastline.demo (accountant, AE-0002)
 *   advisor@assura.demo (advisor, all companies)
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
  store.createUser(db, { email: `md@${c.slug}.demo`, name: 'Managing Director', role: 'viewer', companyId: row.id, password: PASSWORD });
  store.createUser(db, { email: `accounts@${c.slug}.demo`, name: 'Accounts Team', role: 'accountant', companyId: row.id, password: PASSWORD });
  for (const f of fs.readdirSync(path.join(SAMPLES, c.code)).sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(SAMPLES, c.code, f), 'utf8'));
    store.saveUpload(db, { companyId: row.id, period: data.company.period, userId: null, filename: `sample ${f.replace('.json', '.xlsx')}`, sections: Object.keys(data), warnings: [], data });
  }
  console.log(`${c.code} seeded`);
}
if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get('advisor@assura.demo'))
  store.createUser(db, { email: 'advisor@assura.demo', name: 'Assura Advisor', role: 'advisor', companyId: null, password: PASSWORD });
console.log(`Demo password for all demo logins: ${PASSWORD}`);
