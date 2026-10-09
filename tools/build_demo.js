#!/usr/bin/env node
/*
 * Bundles the front end, shared engine, demo API and sample data into self-contained demo pages:
 *   dist/assura-elevate-demo.html   page body for an embedded viewer (downloads switched off)
 *   dist/standalone/index.html      complete web page for any static host, with workbook downloads
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const B64 = (...p) => fs.readFileSync(path.join(ROOT, ...p)).toString('base64');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const companies = [['AE-0001', 'Meridian Polymers Pvt Ltd (Demo)'], ['AE-0002', 'Coastline Foods Pvt Ltd (Demo)']].map(([code, name], i) => {
  const dir = path.join(ROOT, 'samples', 'json', code);
  const months = {};
  fs.readdirSync(dir).sort().forEach((f) => { months[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); });
  return { id: i + 1, code, name, months };
});
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const script = (code) => `<script>\n${safe(code)}\n</script>`;

function body(extraGlobals) {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Manrope:wght@400;500;600;700&display=swap">
<style>
${R('public', 'styles.css')}
</style>
<div id="app"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
${script(`window.AE_SCHEMA = ${R('shared', 'schema.json')};
window.AE_DEMO_DATA = ${JSON.stringify({ companies })};
window.AE_LOGO_ON_DARK = 'data:image/png;base64,${B64('public', 'brand', 'assura-elevate-logo-on-dark.png')}';
${extraGlobals}`)}
${script(R('shared', 'parse.js'))}
${script(R('shared', 'analysis.js'))}
${script(R('public', 'charts.js'))}
${script(R('tools', 'demo', 'demo-api.js'))}
${script(R('public', 'app.js'))}
`;
}

fs.mkdirSync(path.join(ROOT, 'dist', 'standalone'), { recursive: true });

const embedded = `<title>Assura Elevate Client Dashboard</title>\n` + body(
  "window.AE_TEMPLATE_NOTE = 'Downloads are switched off in this preview. Ask your Assura Elevate partner for the blank workbook and a filled sample to try an upload.';");
fs.writeFileSync(path.join(ROOT, 'dist', 'assura-elevate-demo.html'), embedded);

const standalone = `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assura Elevate · Client Dashboard</title>
<meta name="description" content="Assura Elevate client dashboard: monthly financial intelligence, compliance oversight and management highlights.">
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="data:image/png;base64,${B64('public', 'brand', 'favicon.png')}">
</head>
<body>
${body(`window.AE_TEMPLATE_URL = 'data:${XLSX_MIME};base64,${B64('templates', 'Assura_Elevate_Monthly_Data_Template.xlsx')}';
window.AE_SAMPLE_URL = 'data:${XLSX_MIME};base64,${B64('samples', 'xlsx', 'AE-0001', '2026-09.xlsx')}';`)}
</body>
</html>
`;
fs.writeFileSync(path.join(ROOT, 'dist', 'standalone', 'index.html'), standalone);
console.log(`dist/assura-elevate-demo.html (${(embedded.length / 1024).toFixed(0)} KB)`);
console.log(`dist/standalone/index.html (${(standalone.length / 1024).toFixed(0)} KB)`);
