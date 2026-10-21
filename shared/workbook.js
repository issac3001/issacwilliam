/*
 * Assura Elevate: makes one client's copy of the monthly workbook.
 * The template's "Company & Period" sheet holds locked placeholders ({{company_code}},
 * {{company_name}}, {{period}}, {{template_ref}}) and is stored uncompressed inside the
 * .xlsx file (see tools/build_workbooks.py). Filling them is a text replacement in that
 * one entry, after which the zip directory is rebuilt. No unzip library is needed, so the
 * same code runs on the server and in the demo page. Browser (window.AEWorkbook) and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEWorkbook = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SHEET = 'xl/worksheets/sheet1.xml';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let table = null;
  function crc32(bytes) {
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Reads the zip's central directory: [{ name, header (central record bytes), data (raw entry bytes), method }].
  function readZip(buf) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('The workbook template is not a valid .xlsx file.');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The workbook template is damaged.');
      const method = v.getUint16(p + 10, true);
      const size = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true); const extraLen = v.getUint16(p + 30, true); const commentLen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = v.getUint16(local + 26, true); const lExtraLen = v.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      entries.push({ name, method, central: buf.slice(p, p + 46 + nameLen + extraLen + commentLen), localHead: buf.slice(local, local + 30 + lNameLen), data: buf.subarray(start, start + size) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /**
   * template: Uint8Array of the template .xlsx. values: { company_code, company_name, period, template_ref }.
   * Returns a Uint8Array of the filled workbook. Throws if a placeholder is missing.
   */
  function fill(template, values) {
    const entries = readZip(template);
    const sheet = entries.find((e) => e.name === SHEET);
    if (!sheet || sheet.method !== 0) throw new Error('The workbook template was not built for filling. Rebuild it with tools/build_workbooks.py.');
    let text = dec.decode(sheet.data);
    Object.keys(values).forEach((k) => {
      const token = `{{${k}}}`;
      if (!text.includes(token)) throw new Error(`The workbook template has no place for ${k}.`);
      text = text.split(token).join(xml(values[k]));
    });
    sheet.data = enc.encode(text);
    sheet.crc = crc32(sheet.data);

    const parts = []; const central = []; let offset = 0;
    entries.forEach((e) => {
      const head = e.localHead.slice(); const hv = new DataView(head.buffer);
      head[28] = 0; head[29] = 0; // drop the local extra field
      hv.setUint16(6, hv.getUint16(6, true) & ~0x08, true); // sizes are in the header, no data descriptor
      const cen = e.central.slice(); const cv = new DataView(cen.buffer);
      if (e.crc != null) {
        [hv, cv].forEach((x, i) => { const base = i ? 16 : 14; x.setUint32(base, e.crc, true); x.setUint32(base + 4, e.data.length, true); x.setUint32(base + 8, e.data.length, true); });
      } else {
        hv.setUint32(14, cv.getUint32(16, true), true); hv.setUint32(18, cv.getUint32(20, true), true); hv.setUint32(22, cv.getUint32(24, true), true);
      }
      cv.setUint32(42, offset, true);
      parts.push(head, e.data); central.push(cen);
      offset += head.length + e.data.length;
    });
    const cenSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22); const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cenSize + 22); let p = 0;
    parts.concat(central, [end]).forEach((b) => { out.set(b, p); p += b.length; });
    return out;
  }

  // Workbook reference: client code, month and a random part, e.g. AE-0001-2026-09-K7Q3MX.
  function newRef(code, period, random) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = random(6);
    return `${code}-${period}-${Array.from(bytes, (b) => A[b % A.length]).join('')}`;
  }
  const fileName = (company, period) => `${company.code}_${String(company.name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${period}.xlsx`;

  return { fill, newRef, fileName, crc32 };
});
