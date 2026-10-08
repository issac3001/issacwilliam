#!/usr/bin/env node
/*
 * Bundles the front end, shared engine, demo API and sample data into one
 * self-contained page (dist/assura-elevate-demo.html) for sharing as a demo.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const companies = [['AE-0001', 'Meridian Polymers Pvt Ltd (Demo)'], ['AE-0002', 'Coastline Foods Pvt Ltd (Demo)']].map(([code, name], i) => {
  const dir = path.join(__dirname, '..', 'samples', 'json', code);
  const months = {};
  fs.readdirSync(dir).sort().forEach((f) => { months[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); });
  return { id: i + 1, code, name, months };
});
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const script = (code) => `<script>\n${safe(code)}\n</script>`;

const html = `<title>Assura Elevate Client Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Manrope:wght@400;500;600;700&display=swap">
<style>
${R('public', 'styles.css')}
</style>
<div id="app"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
${script(`window.AE_SCHEMA = ${R('shared', 'schema.json')};
window.AE_DEMO_DATA = ${JSON.stringify({ companies })};
window.AE_TEMPLATE_NOTE = 'Downloads are switched off in this demo page. The blank workbook and a filled sample for Meridian Polymers (September 2026) are attached in the project thread; upload the sample here as accounts@meridian.demo or advisor@assura.demo to see the dashboard update.';`)}
${script(R('shared', 'parse.js'))}
${script(R('shared', 'analysis.js'))}
${script(R('public', 'charts.js'))}
${script(R('tools', 'demo', 'demo-api.js'))}
${script(R('public', 'app.js'))}
`;
fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
const out = path.join(__dirname, '..', 'dist', 'assura-elevate-demo.html');
fs.writeFileSync(out, html);
console.log(`${path.relative(process.cwd(), out)} (${(html.length / 1024).toFixed(0)} KB)`);
