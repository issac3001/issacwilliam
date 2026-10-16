/*
 * Assura Elevate: checks that an uploaded file belongs to the client selected
 * for the upload, so one company's figures can never land on another's dashboard.
 *
 *  1. A full workbook names its company on the "Company & Period" sheet: the
 *     code and the name must both match the selected client.
 *  2. A one-section CSV carries no company details, so the person uploading
 *     confirms the client's code.
 *  3. For both, the customers and suppliers in the file are compared with each
 *     client's own records. A file whose parties belong to another client is refused.
 * Browser (window.AEMatch) and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Legal suffixes and punctuation are ignored: "Meridian Polymers Pvt. Ltd." = "MERIDIAN POLYMERS PRIVATE LIMITED".
  const NOISE = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'the', 'co', 'company', 'demo', 'opc', 'inc', 'and', 'm/s', 'ms']);
  function normName(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ')
      .split(' ').filter((w) => w && !NOISE.has(w)).join(' ');
  }
  const normParty = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Customer and supplier names found in a dataset.
  function parties(data) {
    const out = new Set();
    if (!data) return out;
    [['sales', 'customer'], ['receivables', 'customer'], ['purchases', 'supplier'], ['payables', 'supplier']].forEach(([sheet, key]) =>
      (data[sheet] || []).forEach((r) => { const p = normParty(r[key]); if (p) out.add(p); }));
    return out;
  }
  function partiesOf(datasets) {
    const out = new Set();
    datasets.forEach((d) => parties(d.data || d).forEach((p) => out.add(p)));
    return out;
  }

  const MIN_PARTIES = 5; // too few names to judge reliably

  /**
   * selected: { code, name } of the client chosen for the upload.
   * fileCompany: the workbook's company details, or null for a one-section CSV.
   * confirmCode: for a CSV, the code typed by the person uploading.
   * data: the parsed rows ({ sales, purchases, ... }).
   * own: Set of parties already on record for the selected client.
   * others: [{ code, name, parties: Set }] for every other client.
   * Returns a list of problems; an empty list means the file can be accepted.
   */
  function check({ selected, fileCompany, confirmCode, data, own, others }) {
    const errors = [];
    if (fileCompany) {
      const code = String(fileCompany.company_code || '').trim().toUpperCase();
      if (code && code !== selected.code.toUpperCase())
        errors.push(`This workbook is for company code ${code}, but the client selected for this upload is ${selected.name} (${selected.code}). Select the right client, or correct the "Company & Period" sheet.`);
      if (fileCompany.company_name && normName(fileCompany.company_name) !== normName(selected.name))
        errors.push(`This workbook names the company as "${fileCompany.company_name}", but the client selected for this upload is ${selected.name}. Select the right client, or correct the company name on the "Company & Period" sheet.`);
    } else if (String(confirmCode || '').trim().toUpperCase() !== selected.code.toUpperCase()) {
      errors.push(`A CSV file does not name its company, so type the selected client's code (${selected.code}) to confirm this file is for ${selected.name}.`);
    }
    const mine = parties(data);
    if (mine.size >= MIN_PARTIES) {
      const share = (set) => { let n = 0; mine.forEach((p) => { if (set.has(p)) n++; }); return n / mine.size; };
      const ownShare = own && own.size ? share(own) : 0;
      const best = (others || []).map((o) => ({ o, s: o.parties && o.parties.size ? share(o.parties) : 0 })).sort((a, b) => b.s - a.s)[0];
      // A new client has no records yet, so it takes a stronger match before its file is refused.
      const bar = own && own.size ? 0.5 : 0.7;
      if (best && best.s >= bar && best.s > ownShare + 0.2)
        errors.push(`${Math.round(best.s * 100)}% of the customers and suppliers in this file are on record for ${best.o.name} (${best.o.code}), not ${selected.name}. This looks like another client's data: select the right client before uploading.`);
    }
    return errors;
  }

  return { check, parties, partiesOf, normName };
});
