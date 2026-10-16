#!/usr/bin/env node
/*
 * Bundles the internal workflow into one self-contained preview page with a placeholder team and
 * fictional clients: dist/workflow-demo.html. The workflow engine runs in the browser on sql.js.
 * Needs sql.js 1.10.3 (npm install, or SQLJS_DIR pointing at its dist folder).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const B64 = (...p) => fs.readFileSync(path.join(ROOT, ...p)).toString('base64');
const SQLJS = process.env.SQLJS_DIR || path.join(ROOT, 'node_modules', 'sql.js', 'dist');
if (!fs.existsSync(path.join(SQLJS, 'sql-wasm.wasm'))) { console.error('sql.js not found. Run npm install, or set SQLJS_DIR.'); process.exit(1); }
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const script = (code) => `<script>\n${safe(code)}\n</script>`;

const html = `<!doctype html>
<html lang="en-IN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assura Elevate · Workflow</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="data:image/png;base64,${B64('public', 'brand', 'favicon.png')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500;1,600&family=Manrope:wght@400;500;600;700&display=swap">
<style>
${R('public', 'styles.css')}
${R('public', 'workflow.css')}
</style>
</head>
<body>
<div id="wf"></div>
${script(`window.AE_LOGO = 'data:image/png;base64,${B64('public', 'brand', 'assura-elevate-logo.png')}';
window.AE_LOGO_ON_DARK = 'data:image/png;base64,${B64('public', 'brand', 'assura-elevate-logo-on-dark.png')}';
window.AE_SQLJS_WASM = '${fs.readFileSync(path.join(SQLJS, 'sql-wasm.wasm')).toString('base64')}';`)}
${script(fs.readFileSync(path.join(SQLJS, 'sql-wasm.js'), 'utf8'))}
${script(R('shared', 'workflow.js'))}
${script(R('tools', 'demo', 'workflow-seed.js'))}
${script(R('tools', 'demo', 'workflow-demo-api.js'))}
${script(R('public', 'workflow.js'))}
</body>
</html>
`;
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist', 'workflow-demo.html'), html);
console.log(`dist/workflow-demo.html (${(html.length / 1024).toFixed(0)} KB)`);
