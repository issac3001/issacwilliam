/*
 * Assura Elevate: edits made in the portal by the Assura team.
 * An edited section is checked with exactly the same rules as an uploaded
 * workbook, then saved as a new version of that month. Browser and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parse'));
  else root.AEEdit = factory(root.AEParse);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const MAX_ROWS = 20000;

  /**
   * data: the month's current dataset. section: a schema sheet key.
   * values: for a table section, an array of { columnKey: value }; for the company form, { fieldKey: value }.
   * Returns { data, errors, warnings } where data is a new dataset (the input is not changed).
   */
  function applyEdit(data, section, values, schema) {
    const def = schema.sheets.find((s) => s.key === section);
    if (!def) return { data, errors: ['Unknown section.'], warnings: [] };
    let sheet;
    if (def.layout === 'form') {
      if (!values || typeof values !== 'object' || Array.isArray(values)) return { data, errors: ['No details received.'], warnings: [] };
      // Fields not sent keep their current value.
      const fixed = Object.assign({}, data.company, values, { company_code: data.company && data.company.company_code, company_name: data.company && data.company.company_name, period: data.company && data.company.period, template_ref: data.company && data.company.template_ref });
      sheet = def.fields.map((f) => [f.key, fixed[f.key] == null ? null : fixed[f.key]]);
    } else {
      if (!Array.isArray(values)) return { data, errors: ['No rows received.'], warnings: [] };
      if (values.length > MAX_ROWS) return { data, errors: [`At most ${MAX_ROWS} rows can be saved at once.`], warnings: [] };
      sheet = [def.columns.map((c) => c.key)].concat(values.map((r) => def.columns.map((c) => (r && r[c.key] != null ? r[c.key] : null))));
    }
    const parsed = P.parseWorkbook({ [def.name]: sheet }, schema, { only: [section] });
    // The parser counts the header as row 1; the editor counts the first data row as row 1.
    const errors = parsed.errors.map((e) => e.replace(/ row (\d+):/, (m, n) => ` row ${Number(n) - 1}:`));
    const out = Object.assign({}, data);
    if (def.layout === 'form') {
      // The company code, name and month identify the dataset and cannot be changed by an edit.
      out.company = Object.assign({}, parsed.data.company);
    } else out[section] = parsed.data[section];
    return { data: out, errors, warnings: parsed.warnings };
  }

  return { applyEdit };
});
