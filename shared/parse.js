/*
 * Assura Elevate: workbook parser.
 * Turns raw sheet rows (arrays of cell values, as produced by SheetJS in the
 * browser or openpyxl in tests) into a validated monthly dataset.
 * Works in the browser (window.AEParse) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function isoFromParts(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  // Accepts Excel serials, Date objects, ISO, dd-mm-yyyy, dd/mm/yy, 1-Sep-2026, Sep 1 2026.
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return isoFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number' && isFinite(v)) {
      if (v < 20000 || v > 80000) return null;
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return isoFromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return isoFromParts(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) return isoFromParts(+m[3], +m[2], +m[1]);
    if ((m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]*(\d{2,4})$/))) {
      const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      if (mi >= 0) return isoFromParts(+m[3], mi + 1, +m[1]);
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/))) {
      const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mi >= 0) return isoFromParts(+m[3], mi + 1, +m[2]);
    }
    return null;
  }

  // Accepts 2026-09, 09/2026, Sep-2026, September 2026, Sep-26, or any full date.
  function parseMonth(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || v instanceof Date) {
      const d = parseDate(v);
      return d ? d.slice(0, 7) : null;
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${pad(+m[2])}` : null;
    if ((m = s.match(/^(\d{1,2})[\/\-](\d{4})$/))) return +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${pad(+m[1])}` : null;
    if ((m = s.match(/^([A-Za-z]{3,9})[\s\-',]*(\d{2,4})$/))) {
      const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      let y = +m[2];
      if (y < 100) y += 2000;
      if (mi >= 0) return `${y}-${pad(mi + 1)}`;
    }
    const d = parseDate(s);
    return d ? d.slice(0, 7) : null;
  }

  // Accepts 1,23,456.00 / (1,234) / 1234 Dr / 1234 Cr / ₹ 1,000.
  function parseNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim();
    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
    if (/\bcr\.?$/i.test(s)) { sign = -sign; s = s.replace(/\bcr\.?$/i, ''); }
    s = s.replace(/\bdr\.?$/i, '').replace(/[₹,\s]|rs\.?|inr/gi, '');
    if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
    if (!/^\d*\.?\d+$/.test(s)) return null;
    return sign * parseFloat(s);
  }

  function parseEnum(v, values) {
    const n = norm(v);
    if (!n) return null;
    return values.find((x) => norm(x) === n) || null;
  }

  function isBlankRow(row) {
    return !row || row.every((c) => c == null || String(c).trim() === '');
  }

  function convert(col, raw) {
    switch (col.type) {
      case 'date': return parseDate(raw);
      case 'month': return parseMonth(raw);
      case 'number': return parseNumber(raw);
      case 'enum': return parseEnum(raw, col.values);
      default: {
        if (raw == null) return null;
        const s = (raw instanceof Date ? parseDate(raw) : String(raw)).trim();
        return s === '' ? null : s;
      }
    }
  }

  function findSheet(sheets, def) {
    const names = Object.keys(sheets);
    const want = [def.name, def.key].map(norm);
    return names.find((n) => want.includes(norm(n))) ||
      names.find((n) => want.some((w) => norm(n).startsWith(w)));
  }

  // Tally exports carry title rows above the header; find the first row that
  // matches at least two known column names.
  function locateHeader(rows, columns) {
    const lookup = new Map();
    columns.forEach((c) => [c.label, c.key, ...(c.aliases || [])].forEach((a) => {
      if (!lookup.has(norm(a))) lookup.set(norm(a), c.key);
    }));
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const row = rows[r] || [];
      const map = {};
      row.forEach((cell, i) => {
        const key = lookup.get(norm(cell));
        if (key && map[key] === undefined) map[key] = i;
      });
      if (Object.keys(map).length >= 2) return { headerRow: r, map };
    }
    return null;
  }

  function parseTable(rows, def, errors, warnings) {
    const found = locateHeader(rows, def.columns);
    if (!found) {
      errors.push(`${def.name}: could not find the header row. Use the column names from the template.`);
      return [];
    }
    const missingCols = def.columns.filter((c) => c.required && found.map[c.key] === undefined);
    if (missingCols.length) {
      errors.push(`${def.name}: missing required column(s): ${missingCols.map((c) => c.label).join(', ')}.`);
      return [];
    }
    const out = [];
    for (let r = found.headerRow + 1; r < rows.length; r++) {
      const row = rows[r];
      if (isBlankRow(row)) continue;
      const first = norm(row.find((c) => c != null && String(c).trim() !== ''));
      if (first === 'total' || first === 'grandtotal') continue; // Tally totals line
      const rec = {};
      const problems = [];
      def.columns.forEach((c) => {
        const idx = found.map[c.key];
        const raw = idx === undefined ? null : row[idx];
        const val = convert(c, raw);
        if (val == null && raw != null && String(raw).trim() !== '') problems.push(`${c.label} "${raw}" is not a valid ${c.type === 'enum' ? 'option (' + c.values.join('/') + ')' : c.type}`);
        else if (val == null && c.required) problems.push(`${c.label} is empty`);
        rec[c.key] = val;
      });
      if (problems.length) {
        errors.push(`${def.name} row ${r + 1}: ${problems.join('; ')}.`);
        continue;
      }
      out.push(rec);
    }
    if (!out.length) warnings.push(`${def.name}: no rows found.`);
    return out;
  }

  function parseForm(rows, def, errors) {
    const rec = {};
    const byLabel = new Map();
    def.fields.forEach((f) => { byLabel.set(norm(f.label), f); byLabel.set(norm(f.key), f); });
    rows.forEach((row) => {
      if (!row) return;
      const f = byLabel.get(norm(row[0]));
      if (f) rec[f.key] = convert(f, row[1]);
    });
    def.fields.forEach((f) => {
      if (rec[f.key] === undefined) rec[f.key] = null;
      if (f.required && rec[f.key] == null) errors.push(`${def.name}: "${f.label}" is missing or invalid.`);
    });
    return rec;
  }

  /**
   * sheets: { [sheetName]: any[][] }
   * opts.only: restrict to these section keys (used for single-section CSV uploads)
   * Returns { data, errors, warnings, sections } where sections lists what was found.
   */
  function parseWorkbook(sheets, schema, opts) {
    opts = opts || {};
    const errors = [];
    const warnings = [];
    const data = {};
    const sections = [];
    schema.sheets.forEach((def) => {
      if (opts.only && !opts.only.includes(def.key)) return;
      const name = opts.only && Object.keys(sheets).length === 1 ? Object.keys(sheets)[0] : findSheet(sheets, def);
      if (!name) {
        if (!opts.only) {
          if (def.key === 'company') errors.push('The "Company & Period" sheet is missing.');
          else warnings.push(`${def.name}: sheet not found, section skipped.`);
        }
        return;
      }
      sections.push(def.key);
      data[def.key] = def.layout === 'form'
        ? parseForm(sheets[name], def, errors)
        : parseTable(sheets[name], def, errors, warnings);
    });

    // Cross-checks that catch common export mistakes.
    const period = data.company && data.company.period;
    if (period && data.sales) {
      const outside = data.sales.filter((s) => s.date.slice(0, 7) !== period).length;
      if (outside) warnings.push(`Sales: ${outside} invoice(s) are dated outside ${period}. Check the export period.`);
    }
    if (data.sales) {
      const seen = new Set();
      const dup = data.sales.filter((s) => { const k = s.invoice_no + '|' + s.product; if (seen.has(k)) return true; seen.add(k); return false; }).length;
      if (dup) warnings.push(`Sales: ${dup} duplicate invoice line(s) found (same invoice number and product).`);
    }
    return { data, errors, warnings, sections };
  }

  return { parseWorkbook, parseDate, parseMonth, parseNumber, norm };
});
