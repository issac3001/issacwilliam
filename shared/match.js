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

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const mLong = (p) => (/^\d{4}-\d{2}$/.test(p || '') ? `${MONTHS[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}` : String(p || 'no month'));

  /**
   * A full workbook must be a copy the portal issued for this client and this month.
   * issue: the record found for the workbook's reference (or null). Returns a list of problems.
   */
  function checkIssued({ selected, fileCompany, issue }) {
    const ref = String((fileCompany && fileCompany.template_ref) || '').trim();
    if (!ref) return [`This workbook has no workbook reference, so it is not a copy sent from the portal. Send the ${mLong(fileCompany && fileCompany.period)} workbook from ${selected.name}'s Data & uploads page and upload the copy the accountant returns.`];
    if (!issue) return [`Workbook reference ${ref} was not issued by Assura Elevate. Upload the copy sent from the portal for ${selected.name}.`];
    const errors = [];
    if (issue.company_id !== selected.id) errors.push(`Workbook ${ref} was issued to ${issue.company_name} (${issue.company_code}), not to ${selected.name} (${selected.code}). Select the right client, or ask for the right copy.`);
    if (fileCompany.period !== issue.period) errors.push(`Workbook ${ref} was issued for ${mLong(issue.period)}, but its month now reads ${mLong(fileCompany.period)}. The month is locked on the sheet, so this copy has been altered: send a fresh workbook for the month.`);
    return errors;
  }

  // What the team sees before accepting an upload: rows per section and the main totals.
  function summary(data, schema) {
    const add = (rows, k) => (rows || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
    return {
      sections: schema.sheets.filter((d) => d.layout === 'table' && data[d.key]).map((d) => ({ key: d.key, name: d.name, rows: data[d.key].length })),
      totals: [
        ['Sales (taxable value)', add(data.sales, 'taxable_value')], ['Purchases (taxable value)', add(data.purchases, 'taxable_value')],
        ['Expenses', add(data.expenses, 'amount')], ['Receivables at month end', add(data.receivables, 'outstanding')],
        ['Payables at month end', add(data.payables, 'outstanding')], ['Closing stock', add(data.inventory, 'value')],
      ].filter((t) => t[1]),
    };
  }

  return { check, checkIssued, summary, parties, partiesOf, normName };
});
