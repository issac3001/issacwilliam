/*
 * Assura Elevate: data editor for the Assura team.
 * Opens one section of one month, lets the team correct, add or delete rows,
 * and saves the result as a new version. The server checks it with the same
 * rules as an uploaded workbook; earlier versions stay and can be restored.
 */
(function () {
  'use strict';

  window.AEEditor = function create(ctx) {
    const { esc, mLong, api } = ctx;
    let cur = null; // { period, section, version, rows | form, original }

    function render(page, company) {
      const schema = window.AE_SCHEMA;
      const periods = ctx.periods();
      if (!cur || !periods.includes(cur.period)) cur = { period: periods[periods.length - 1], section: 'sales' };
      page.innerHTML = ctx.head('Edit data', company.name) + `
        <div class="card"><div class="editor-bar">
          <div><label for="ed-month">Month</label><select id="ed-month" class="field">${periods.slice().reverse().map((p) => `<option value="${p}" ${p === cur.period ? 'selected' : ''}>${mLong(p)}</option>`).join('')}</select></div>
          <div><label for="ed-section">Section</label><select id="ed-section" class="field">${schema.sheets.map((s) => `<option value="${s.key}" ${s.key === cur.section ? 'selected' : ''}>${esc(s.key === 'company' ? 'Company details and notes' : s.name)}</option>`).join('')}</select></div>
          <div style="flex:1"></div>
          <div class="btn-row"><button class="btn secondary" id="ed-remove" type="button">Remove this month</button></div>
        </div>
        <p class="muted small" style="margin:12px 0 0">Changes are saved as a new version of the month and the client's dashboard updates straight away. Earlier versions are kept under Data &amp; uploads, where any of them can be restored. To add a new month, upload its workbook.</p>
        </div>
        <div id="ed-body" class="section"></div>`;
      if (!periods.length) { page.querySelector('#ed-body').innerHTML = '<div class="card empty">No months on record yet. Upload a workbook under Data &amp; uploads first.</div>'; return; }
      page.querySelector('#ed-month').addEventListener('change', (e) => { cur = { period: e.target.value, section: cur.section }; load(page); });
      page.querySelector('#ed-section').addEventListener('change', (e) => { cur = { period: cur.period, section: e.target.value }; load(page); });
      const rm = page.querySelector('#ed-remove');
      rm.addEventListener('click', async () => {
        if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = `Tap again to remove ${mLong(cur.period)}`; rm.classList.add('armed'); setTimeout(() => { if (rm.isConnected) { delete rm.dataset.armed; rm.textContent = 'Remove this month'; } }, 4000); return; }
        try {
          await api.post('/api/data/remove-month', { company: company.id, period: cur.period });
          ctx.notice(`<div class="msg ok">${mLong(cur.period)} was taken off the dashboard. It can be restored from Data &amp; uploads.</div>`);
          cur = null; await ctx.reload();
        } catch (e) { page.querySelector('#ed-body').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      });
      load(page);
    }

    async function load(page) {
      const body = page.querySelector('#ed-body');
      body.innerHTML = '<div class="card empty">Loading…</div>';
      let r;
      try { r = await api.get(`/api/data?company=${ctx.companyId()}&period=${cur.period}`); } catch (e) { body.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
      const def = window.AE_SCHEMA.sheets.find((s) => s.key === cur.section);
      cur.version = r.version;
      if (def.layout === 'form') {
        cur.form = Object.assign({}, r.data.company || {});
        formView(body, def, r);
      } else {
        cur.rows = (r.data[def.key] || []).map((x) => Object.assign({}, x));
        cur.original = cur.rows.map((x) => JSON.stringify(x));
        cur.deleted = new Set();
        tableView(body, def, r);
      }
    }

    function input(col, value, attrs) {
      const v = value == null ? '' : value;
      if (col.type === 'enum') return `<select ${attrs}><option value=""></option>${col.values.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      if (col.type === 'date') return `<input type="date" value="${esc(v)}" ${attrs}>`;
      if (col.type === 'month') return `<input type="month" value="${esc(v)}" ${attrs}>`;
      if (col.type === 'number') return `<input type="text" inputmode="decimal" class="num" value="${esc(v)}" ${attrs}>`;
      return `<input type="text" value="${esc(v)}" ${attrs}>`;
    }

    function formView(body, def) {
      const locked = ['company_code', 'company_name', 'period'];
      body.innerHTML = `<form class="card" id="ed-form"><div class="card-head"><h3>Company details for ${mLong(cur.period)}</h3><span class="muted small">Live version v${cur.version}</span></div>
        <div class="form-grid">${def.fields.map((f) => `<div${f.key === 'notes' ? ' style="grid-column:1/-1"' : ''}><label for="f-${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>
          ${locked.includes(f.key) ? `<input type="text" id="f-${f.key}" value="${esc(cur.form[f.key])}" disabled>` : f.key === 'notes'
            ? `<textarea id="f-${f.key}" data-k="${f.key}" placeholder="Shown to the client as the note for this month">${esc(cur.form[f.key] || '')}</textarea>`
            : input(f, cur.form[f.key], `id="f-${f.key}" data-k="${f.key}" class="field"`)}${f.help ? `<p class="muted small" style="margin:4px 0 0">${esc(f.help)}</p>` : ''}</div>`).join('')}</div>
        <p class="muted small">The company code, name and month identify this data and cannot be edited here. The company name follows the client record under Clients &amp; users. To move data to another month, upload it for that month and remove this one.</p>
        <div id="ed-msg"></div><div class="btn-row" style="margin-top:12px"><button class="btn" type="submit">Save as new version</button></div></form>`;
      body.querySelector('#ed-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = Object.assign({}, cur.form);
        body.querySelectorAll('[data-k]').forEach((el) => { values[el.dataset.k] = el.value === '' ? null : el.value; });
        await save(body, values);
      });
    }

    function tableView(body, def) {
      const cols = def.columns;
      const rowHtml = (r, i) => `<tr data-i="${i}"><td class="rn">${i + 1}</td>${cols.map((c) => `<td>${input(c, r[c.key], `data-k="${c.key}" aria-label="${esc(c.label)} row ${i + 1}"`)}</td>`).join('')}
        <td><button type="button" class="link-btn" data-del="${i}" aria-label="Delete row ${i + 1}">Delete</button></td></tr>`;
      body.innerHTML = `<div class="card"><div class="card-head"><h3>${esc(def.name)} · ${mLong(cur.period)}</h3><span class="muted small">Live version v${cur.version} · <span id="ed-count">${cur.rows.length}</span> rows</span></div>
        <div class="btn-row" style="margin-bottom:10px;align-items:center">
          <button class="btn secondary small" type="button" id="ed-add">Add a row</button>
          <input class="search" type="search" id="ed-find" placeholder="Find rows" aria-label="Find rows">
          <span class="muted small" id="ed-dirty"></span></div>
        <div class="edit-scroll"><table class="grid-edit"><thead><tr><th>#</th>${cols.map((c) => `<th class="${c.type === 'number' ? 'r' : ''}">${esc(c.label)}${c.required ? ' *' : ''}</th>`).join('')}<th></th></tr></thead>
          <tbody>${cur.rows.map(rowHtml).join('')}</tbody></table></div>
        <p class="muted small">Amounts can be typed as in Tally (1,23,456.00 or 1234 Cr). Dates can be typed or picked. * marks a required column.</p>
        <div id="ed-msg"></div>
        <div class="btn-row" style="margin-top:12px"><button class="btn" type="button" id="ed-save">Save as new version</button><button class="btn secondary" type="button" id="ed-undo">Discard changes</button></div></div>`;
      const tbody = body.querySelector('tbody');
      const dirty = () => {
        let changed = cur.deleted.size;
        cur.rows.forEach((r, i) => { const tr = tbody.querySelector(`tr[data-i="${i}"]`); const c = !cur.deleted.has(i) && JSON.stringify(r) !== cur.original[i]; if (tr) tr.classList.toggle('changed', c); if (c) changed++; });
        body.querySelector('#ed-dirty').textContent = changed ? `${changed} row${changed > 1 ? 's' : ''} changed, not yet saved` : '';
        body.querySelector('#ed-count').textContent = cur.rows.length - cur.deleted.size;
      };
      tbody.addEventListener('input', (e) => {
        const tr = e.target.closest('tr[data-i]'); if (!tr || !e.target.dataset.k) return;
        cur.rows[Number(tr.dataset.i)][e.target.dataset.k] = e.target.value === '' ? null : e.target.value;
        dirty();
      });
      tbody.addEventListener('click', (e) => {
        const b = e.target.closest('[data-del]'); if (!b) return;
        const i = Number(b.dataset.del); const tr = b.closest('tr');
        if (cur.deleted.has(i)) { cur.deleted.delete(i); tr.classList.remove('deleted'); b.textContent = 'Delete'; } else { cur.deleted.add(i); tr.classList.add('deleted'); b.textContent = 'Undo'; }
        dirty();
      });
      body.querySelector('#ed-add').addEventListener('click', () => {
        const blank = Object.fromEntries(cols.map((c) => [c.key, null]));
        cur.rows.push(blank); cur.original.push('new');
        tbody.insertAdjacentHTML('beforeend', rowHtml(blank, cur.rows.length - 1));
        const last = tbody.lastElementChild; last.scrollIntoView({ block: 'nearest' }); last.querySelector('input,select').focus();
        dirty();
      });
      body.querySelector('#ed-find').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        tbody.querySelectorAll('tr').forEach((tr) => { const text = [...tr.querySelectorAll('input,select')].map((x) => x.value).join(' ').toLowerCase(); tr.style.display = !q || text.includes(q) ? '' : 'none'; });
      });
      body.querySelector('#ed-undo').addEventListener('click', () => load(body.closest('main')));
      body.querySelector('#ed-save').addEventListener('click', () => save(body, cur.rows.filter((r, i) => !cur.deleted.has(i))));
    }

    async function save(body, values) {
      const msg = body.querySelector('#ed-msg');
      msg.innerHTML = '<div class="msg">Checking and saving…</div>';
      try {
        const r = await api.post('/api/data/edit', { company: ctx.companyId(), period: cur.period, section: cur.section, values, baseVersion: cur.version });
        ctx.notice(`<div class="msg ok"><b>Saved as version ${r.version} of ${mLong(r.period)}.</b> The client's dashboard and highlights now use the corrected figures.${r.warnings.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>`);
        await ctx.reload();
      } catch (e) {
        const errs = (e.data && e.data.errors) || [];
        msg.innerHTML = `<div class="msg err"><b>${esc(e.message)}</b>${errs.length ? `<ul>${errs.slice(0, 15).map((x) => `<li>${esc(x)}</li>`).join('')}${errs.length > 15 ? `<li>and ${errs.length - 15} more</li>` : ''}</ul>` : ''}</div>`;
      }
    }

    return { render, reset() { cur = null; } };
  };
})();
