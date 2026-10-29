/*
 * Assura Elevate: click-through details.
 * Every figure on the dashboard opens a panel with the rows behind it: the
 * invoices behind revenue, the parties behind receivables over 90 days, the
 * items behind slow stock, and so on. Rows come from the month's own data,
 * so the panel always adds up to the figure that was clicked.
 */
(function () {
  'use strict';

  window.AEDrill = function create(ctx) {
    const { esc, inr, pctTxt, mLong, dLong } = ctx;
    const A = window.AEAnalysis;
    const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
    const days = (iso, ref) => (iso ? A.daysBetween(iso, ref) : null);
    const n0 = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-IN'));
    const rate = (v) => (v == null ? '–' : `₹${(Math.round(v * 100) / 100).toLocaleString('en-IN')}`);
    const groupBy = (rows, key) => { const m = new Map(); rows.forEach((r) => { const k = key(r) || '(not given)'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };

    // Ageing buckets, matching the dashboard (days from the document date to month end).
    const RECV_BUCKETS = { '0-30': [0, 30], '31-60': [31, 60], '61-90': [61, 90], '90+': [91, Infinity], '61+': [61, Infinity] };
    const INV_BUCKETS = { '0-90': [0, 90], '91-180': [91, 180], '181-365': [181, 365], '365+': [366, Infinity], '181+': [181, Infinity] };
    const inBucket = (d, b, table) => { if (!b) return true; const [lo, hi] = table[b]; return d != null && d >= lo && d <= hi; };

    let stack = []; // breadcrumb of opened views, newest last
    let root = null;
    let links = []; // specs for clickable elements in the current view
    const link = (spec) => { links.push(spec); return links.length - 1; };
    const L = (spec, html) => `<button type="button" class="row-link" data-d="${link(spec)}">${html}</button>`;

    function table(headers, rows, opts) {
      opts = opts || {};
      if (!rows.length) return `<p class="muted">${esc(opts.empty || 'Nothing to show.')}</p>`;
      return `<div class="table-wrap"><table${opts.cls ? ` class="${opts.cls}"` : ''}><thead><tr>${headers.map((h) => `<th class="${h.num ? 'r' : ''}">${esc(h.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}${r.spec ? ` data-d="${link(r.spec)}"` : ''}>${r.cells.map((c, i) => `<td class="${headers[i] && headers[i].num ? 'r' : ''}${r.tdCls && r.tdCls[i] ? ' ' + r.tdCls[i] : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    const sumrow = (items) => `<div class="sumrow">${items.map(([k, v, note]) => `<div><span class="muted small">${esc(k)}</span><b>${v}</b>${note ? `<span class="muted small">${note}</span>` : ''}</div>`).join('')}</div>`;
    const card = (title, inner, sub) => `<div class="card"><div class="card-head"><h3>${esc(title)}</h3>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>${inner}</div>`;
    const chips = (name, options, current) => `<div class="filter-chips" role="group" aria-label="${esc(name)}">${options.map(([v, l]) => `<button type="button" data-filter="${esc(v)}" aria-pressed="${String(v) === String(current || '')}">${esc(l)}</button>`).join('')}</div>`;

    // ---------- views: each returns { eyebrow, title, sub, html, csv?, monthly? } ----------
    const views = {
      async revenue(s) {
        const d = await ctx.month(s.period); const sales = d.sales || [];
        const rev = sum(sales, (x) => x.taxable_value);
        const invoices = new Set(sales.map((x) => x.invoice_no));
        const byCust = [...groupBy(sales, (x) => x.customer)].map(([k, r]) => ({ k, v: sum(r, (x) => x.taxable_value), n: new Set(r.map((x) => x.invoice_no)).size })).sort((a, b) => b.v - a.v);
        const byCat = [...groupBy(sales, (x) => x.category || x.product)].map(([k, r]) => ({ k, v: sum(r, (x) => x.taxable_value), q: sum(r, (x) => x.qty) })).sort((a, b) => b.v - a.v);
        const byType = [...groupBy(sales, (x) => x.customer_type)].map(([k, r]) => ({ k, v: sum(r, (x) => x.taxable_value) })).sort((a, b) => b.v - a.v);
        const list = sales.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.invoice_no).localeCompare(String(b.invoice_no)));
        return {
          eyebrow: 'Revenue', title: inr(rev), sub: `${mLong(s.period)} · taxable value of sales`, monthly: true,
          html: sumrow([['Invoices', n0(invoices.size)], ['Customers billed', n0(byCust.length)], ['Average invoice', inr(invoices.size ? rev / invoices.size : null)], ['Largest customer', byCust[0] ? pctTxt(byCust[0].v / rev, 0) : '–', byCust[0] ? esc(byCust[0].k) : '']])
            + card('By customer', table([{ label: 'Customer' }, { label: 'Invoices', num: true }, { label: 'Revenue', num: true }, { label: 'Share', num: true }],
              byCust.map((c) => ({ spec: { kind: 'customer', name: c.k, period: s.period }, cls: 'clickable', cells: [L({ kind: 'customer', name: c.k, period: s.period }, esc(c.k)), n0(c.n), inr(c.v), pctTxt(c.v / rev, 1)] }))), 'Click a customer for their invoices and dues')
            + card('By product category', table([{ label: 'Category' }, { label: 'Quantity', num: true }, { label: 'Revenue', num: true }, { label: 'Share', num: true }],
              byCat.map((c) => ({ spec: { kind: 'category', name: c.k, period: s.period }, cls: 'clickable', cells: [L({ kind: 'category', name: c.k, period: s.period }, esc(c.k)), n0(c.q), inr(c.v), pctTxt(c.v / rev, 1)] }))))
            + card('By customer type', table([{ label: 'Type' }, { label: 'Revenue', num: true }, { label: 'Share', num: true }], byType.map((c) => ({ cells: [esc(c.k), inr(c.v), pctTxt(c.v / rev, 1)] }))))
            + card(`All invoice lines (${list.length})`, invoiceTable(list, s.period)),
          csv: { name: `sales-${s.period}`, headers: ['Date', 'Invoice', 'Customer', 'Type', 'Product', 'Category', 'Region', 'Qty', 'Taxable value', 'GST', 'Total'], rows: list.map((x) => [x.date, x.invoice_no, x.customer, x.customer_type, x.product, x.category, x.region, x.qty, x.taxable_value, x.gst, x.total]) },
        };
      },

      async customer(s) {
        const d = await ctx.month(s.period); const ref = A.monthEnd(s.period);
        const sales = (d.sales || []).filter((x) => x.customer === s.name);
        const rev = sum(d.sales || [], (x) => x.taxable_value);
        const billed = sum(sales, (x) => x.taxable_value);
        const dues = (d.receivables || []).filter((x) => x.customer === s.name).map((x) => Object.assign({ age: days(x.invoice_date, ref) }, x)).sort((a, b) => (b.age || 0) - (a.age || 0));
        const due = sum(dues, (x) => x.outstanding); const old = sum(dues.filter((x) => x.age > 90), (x) => x.outstanding);
        return {
          eyebrow: 'Customer', title: s.name, sub: mLong(s.period), monthly: true,
          html: sumrow([['Billed this month', inr(billed), rev ? pctTxt(billed / rev, 1) + ' of revenue' : ''], ['Invoices', n0(new Set(sales.map((x) => x.invoice_no)).size)], ['Outstanding', inr(due)], ['Over 90 days', inr(old)]])
            + card('Outstanding invoices', receivableTable(dues, false), 'Oldest first')
            + card('Invoices this month', invoiceTable(sales, s.period, true)),
          csv: { name: `customer-${s.period}`, headers: ['Invoice', 'Invoice date', 'Due date', 'Days', 'Outstanding'], rows: dues.map((x) => [x.invoice_no, x.invoice_date, x.due_date, x.age, x.outstanding]) },
        };
      },

      async category(s) { return salesSlice(s, 'category', 'Product category', (x) => (x.category || x.product) === s.name); },
      async region(s) { return salesSlice(s, 'region', 'Region', (x) => x.region === s.name); },
      async 'new-customers'(s) { return salesSlice(s, 'new', 'New customers', (x) => s.names.includes(x.customer), `${s.names.length} customers billed for the first time`); },
      async 'month-end'(s) {
        const ref = A.monthEnd(s.period);
        return salesSlice(s, 'month-end', 'Month-end billing', (x) => ref.getUTCDate() - Number(x.date.slice(8, 10)) < 5, 'Invoices dated in the last five days of the month');
      },

      async gross(s) {
        const m = ctx.metrics(s.period); const d = await ctx.month(s.period);
        if (!m || m.cogs == null) return { eyebrow: 'Gross profit', title: 'Not available', sub: mLong(s.period), monthly: true, html: '<p class="muted">Gross profit needs opening and closing stock. Add the Inventory sheet (or the opening stock on the Company sheet) for this month.</p>' };
        const opening = m.cogs + (m.inventory || 0) - m.purchases;
        return {
          eyebrow: 'Gross profit', title: `${inr(m.grossProfit)} · ${pctTxt(m.gmPct)}`, sub: `${mLong(s.period)} · how it is worked out`, monthly: true,
          html: card('Calculation', `<table class="calc"><tbody>
              <tr><td>Revenue</td><td class="r">${L({ kind: 'revenue', period: s.period }, inr(m.revenue))}</td></tr>
              <tr><td>Opening stock</td><td class="r">${inr(opening)}</td></tr>
              <tr><td>+ Purchases</td><td class="r">${L({ kind: 'purchases', period: s.period }, inr(m.purchases))}</td></tr>
              <tr><td>− Closing stock</td><td class="r">${L({ kind: 'inventory', period: s.period }, inr(m.inventory))}</td></tr>
              <tr><td>= Cost of goods sold</td><td class="r">${inr(m.cogs)}</td></tr>
              <tr class="total"><td>Gross profit (revenue − cost of goods sold)</td><td class="r">${inr(m.grossProfit)}</td></tr>
              <tr><td>Gross margin</td><td class="r">${pctTxt(m.gmPct)}</td></tr></tbody></table>`)
            + card('Purchases by item', purchaseItems(d.purchases || [], s.period)),
        };
      },

      async net(s) {
        const m = ctx.metrics(s.period); const d = await ctx.month(s.period);
        const groups = [...groupBy(d.expenses || [], (x) => x.group)].map(([k, r]) => ({ k, v: sum(r, (x) => x.amount) })).sort((a, b) => b.v - a.v);
        return {
          eyebrow: 'Net profit (estimate)', title: inr(m && m.netProfit), sub: `${mLong(s.period)} · management estimate, unaudited`, monthly: true,
          html: card('Calculation', `<table class="calc"><tbody>
              <tr><td>Gross profit</td><td class="r">${L({ kind: 'gross', period: s.period }, inr(m && m.grossProfit))}</td></tr>
              <tr><td>− Operating expenses</td><td class="r">${L({ kind: 'expenses', period: s.period }, inr(m && m.opex))}</td></tr>
              <tr><td>+ Other income</td><td class="r">${inr(m && m.otherIncome)}</td></tr>
              <tr class="total"><td>Net profit (estimate)</td><td class="r">${inr(m && m.netProfit)}</td></tr>
              <tr><td>Net margin</td><td class="r">${pctTxt(m && m.npPct)}</td></tr></tbody></table>`)
            + card('Expenses by group', table([{ label: 'Group' }, { label: 'Amount', num: true }, { label: '% of revenue', num: true }],
              groups.map((g) => ({ spec: { kind: 'expenses', period: s.period, group: g.k }, cls: 'clickable', cells: [L({ kind: 'expenses', period: s.period, group: g.k }, esc(g.k)), inr(g.v), pctTxt(m && m.revenue ? g.v / m.revenue : null)] })))),
        };
      },

      async expenses(s) {
        const d = await ctx.month(s.period); const m = ctx.metrics(s.period);
        const prior = ctx.periods().filter((p) => p < s.period).slice(-3);
        const priorData = await Promise.all(prior.map((p) => ctx.month(p).catch(() => ({}))));
        const avgOf = (head) => (priorData.length ? sum(priorData, (pd) => sum((pd.expenses || []).filter((x) => x.head === head), (x) => x.amount)) / priorData.length : null);
        const rows = (d.expenses || []).filter((x) => !s.group || x.group === s.group).slice().sort((a, b) => b.amount - a.amount);
        const total = sum(rows, (x) => x.amount);
        const groups = [...new Set((d.expenses || []).map((x) => x.group))];
        return {
          eyebrow: s.group ? `Expenses · ${s.group}` : 'Operating expenses', title: inr(total), sub: mLong(s.period), monthly: true,
          html: (groups.length > 1 ? chips('Group', [['', 'All groups']].concat(groups.map((g) => [g, g])), s.group) + '<div style="height:12px"></div>' : '')
            + card('Expense heads', table([{ label: 'Head' }, { label: 'Group' }, { label: 'Amount', num: true }, { label: `Average of prior ${prior.length} months`, num: true }, { label: 'Change', num: true }, { label: '% of revenue', num: true }],
              rows.map((x) => { const a = avgOf(x.head); const ch = a ? x.amount / a - 1 : null; return { spec: { kind: 'expense-head', head: x.head, period: s.period }, cls: 'clickable', tdCls: { 4: ch != null && ch > 0.2 ? 'age-old' : '' }, cells: [L({ kind: 'expense-head', head: x.head, period: s.period }, esc(x.head)), esc(x.group), inr(x.amount), inr(a), ch == null ? '–' : (ch > 0 ? '+' : '') + pctTxt(ch, 0), pctTxt(m && m.revenue ? x.amount / m.revenue : null)] }; })), 'Click a head for its month-by-month history'),
          csv: { name: `expenses-${s.period}`, headers: ['Head', 'Group', 'Amount'], rows: rows.map((x) => [x.head, x.group, x.amount]) },
          filter: (v) => Object.assign({}, s, { group: v || undefined }),
        };
      },

      async 'expense-head'(s) {
        const ps = ctx.periods().filter((p) => p <= s.period).slice(-12);
        const data = await Promise.all(ps.map((p) => ctx.month(p).catch(() => ({}))));
        const vals = data.map((d) => sum((d.expenses || []).filter((x) => x.head === s.head), (x) => x.amount));
        const avg = vals.length > 1 ? sum(vals.slice(0, -1), (v) => v) / (vals.length - 1) : null;
        return {
          eyebrow: 'Expense head', title: s.head, sub: `Last ${ps.length} months to ${mLong(s.period)}`,
          html: sumrow([['This month', inr(vals[vals.length - 1])], ['Average before', inr(avg)], ['Highest', inr(Math.max(...vals))], ['Lowest', inr(Math.min(...vals))]])
            + card('Month by month', table([{ label: 'Month' }, { label: 'Amount', num: true }], ps.map((p, i) => ({ spec: { kind: 'expenses', period: p }, cls: 'clickable', cells: [L({ kind: 'expenses', period: p }, mLong(p)), inr(vals[i])] })).reverse())),
          csv: { name: `expense-head`, headers: ['Month', 'Amount'], rows: ps.map((p, i) => [p, vals[i]]) },
        };
      },

      async 'expense-spikes'(s) {
        return {
          eyebrow: 'Unusual spend', title: `${s.rows.length} expense head${s.rows.length > 1 ? 's' : ''} above their usual range`, sub: mLong(s.period),
          html: card('Heads flagged', table([{ label: 'Head' }, { label: 'This month', num: true }, { label: 'Usual (average)', num: true }, { label: 'Above usual', num: true }],
            s.rows.map((r) => ({ spec: { kind: 'expense-head', head: r.head, period: s.period }, cls: 'clickable', cells: [L({ kind: 'expense-head', head: r.head, period: s.period }, esc(r.head)), inr(r.amount), inr(r.avg), inr(r.amount - r.avg)] })))),
        };
      },

      async purchases(s) {
        const d = await ctx.month(s.period); const rows = d.purchases || [];
        const total = sum(rows, (x) => x.taxable_value);
        const bySup = [...groupBy(rows, (x) => x.supplier)].map(([k, r]) => ({ k, v: sum(r, (x) => x.taxable_value), n: new Set(r.map((x) => x.bill_no)).size })).sort((a, b) => b.v - a.v);
        const list = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
        return {
          eyebrow: 'Purchases', title: inr(total), sub: `${mLong(s.period)} · taxable value`, monthly: true,
          html: sumrow([['Bills', n0(new Set(rows.map((x) => x.bill_no)).size)], ['Suppliers', n0(bySup.length)], ['Largest supplier', bySup[0] ? pctTxt(bySup[0].v / total, 0) : '–', bySup[0] ? esc(bySup[0].k) : '']])
            + card('By supplier', table([{ label: 'Supplier' }, { label: 'Bills', num: true }, { label: 'Amount', num: true }, { label: 'Share', num: true }],
              bySup.map((x) => ({ spec: { kind: 'supplier', name: x.k, period: s.period }, cls: 'clickable', cells: [L({ kind: 'supplier', name: x.k, period: s.period }, esc(x.k)), n0(x.n), inr(x.v), pctTxt(x.v / total, 1)] }))))
            + card('By item', purchaseItems(rows, s.period))
            + card(`All purchase lines (${list.length})`, table([{ label: 'Date' }, { label: 'Bill' }, { label: 'Supplier' }, { label: 'Item' }, { label: 'Qty', num: true }, { label: 'Rate', num: true }, { label: 'Taxable value', num: true }],
              list.map((x) => ({ cells: [dLong(x.date), esc(x.bill_no), esc(x.supplier), esc(x.item), n0(x.qty), rate(x.qty ? x.taxable_value / x.qty : null), inr(x.taxable_value)] })))),
          csv: { name: `purchases-${s.period}`, headers: ['Date', 'Bill', 'Supplier', 'Item', 'Category', 'Qty', 'Taxable value', 'GST', 'Total'], rows: list.map((x) => [x.date, x.bill_no, x.supplier, x.item, x.category, x.qty, x.taxable_value, x.gst, x.total]) },
        };
      },

      async supplier(s) {
        const d = await ctx.month(s.period); const ref = A.monthEnd(s.period);
        const bills = (d.purchases || []).filter((x) => x.supplier === s.name);
        const dues = (d.payables || []).filter((x) => x.supplier === s.name).map((x) => Object.assign({ age: days(x.bill_date, ref) }, x)).sort((a, b) => (b.age || 0) - (a.age || 0));
        return {
          eyebrow: 'Supplier', title: s.name, sub: mLong(s.period), monthly: true,
          html: sumrow([['Bought this month', inr(sum(bills, (x) => x.taxable_value))], ['Owed', inr(sum(dues, (x) => x.outstanding))], ['Owed over 60 days', inr(sum(dues.filter((x) => x.age > 60), (x) => x.outstanding))]])
            + card('Unpaid bills', payableTable(dues, false), 'Oldest first')
            + card('Bills this month', table([{ label: 'Date' }, { label: 'Bill' }, { label: 'Item' }, { label: 'Qty', num: true }, { label: 'Taxable value', num: true }], bills.map((x) => ({ cells: [dLong(x.date), esc(x.bill_no), esc(x.item), n0(x.qty), inr(x.taxable_value)] })))),
        };
      },

      async 'purchase-rates'(s) {
        return {
          eyebrow: 'Purchase rates', title: `${s.rows.length} item${s.rows.length > 1 ? 's' : ''} costing more`, sub: `${mLong(s.period)} against the prior three-month average rate`,
          html: card('Items', table([{ label: 'Item' }, { label: 'Earlier rate', num: true }, { label: 'This month', num: true }, { label: 'Change', num: true }, { label: 'Bought this month', num: true }],
            s.rows.map((r) => ({ cells: [esc(r.item), rate(r.before), rate(r.now), '+' + pctTxt(r.change, 1), inr(r.value)] }))))
            + `<p class="muted small">Rate is taxable value divided by quantity, weighted across all bills for the item.</p>`,
        };
      },

      async receivables(s) {
        const d = await ctx.month(s.period); const ref = A.monthEnd(s.period);
        const all = (d.receivables || []).map((x) => Object.assign({ age: days(x.invoice_date, ref) }, x));
        const rows = all.filter((x) => inBucket(x.age, s.bucket, RECV_BUCKETS)).sort((a, b) => (b.age || 0) - (a.age || 0));
        const total = sum(rows, (x) => x.outstanding);
        const byCust = [...groupBy(rows, (x) => x.customer)].map(([k, r]) => ({ k, v: sum(r, (x) => x.outstanding), n: r.length, oldest: Math.max(...r.map((x) => x.age || 0)), over90: sum(r.filter((x) => x.age > 90), (x) => x.outstanding) })).sort((a, b) => b.v - a.v);
        return {
          eyebrow: 'Receivables', title: inr(total), sub: `${mLong(s.period)} · owed by customers${s.bucket ? ' · ' + bucketText(s.bucket) : ''}`, monthly: true,
          html: chips('Age', [['', 'All'], ['0-30', '0–30 days'], ['31-60', '31–60'], ['61-90', '61–90'], ['90+', 'Over 90 days']], s.bucket) + '<div style="height:12px"></div>'
            + sumrow([['Customers', n0(byCust.length)], ['Invoices', n0(rows.length)], ['Share of all receivables', pctTxt(total / (sum(all, (x) => x.outstanding) || 1), 0)]])
            + card('By customer', table([{ label: 'Customer' }, { label: 'Invoices', num: true }, { label: 'Oldest', num: true }, { label: 'Over 90 days', num: true }, { label: 'Outstanding', num: true }],
              byCust.map((c) => ({ spec: { kind: 'customer', name: c.k, period: s.period }, cls: 'clickable', tdCls: { 2: c.oldest > 90 ? 'age-old' : '' }, cells: [L({ kind: 'customer', name: c.k, period: s.period }, esc(c.k)), n0(c.n), `${c.oldest} days`, inr(c.over90), inr(c.v)] }))), 'Click a customer for their invoices')
            + card('Invoices', receivableTable(rows, true), 'Oldest first'),
          csv: { name: `receivables-${s.period}${s.bucket ? '-' + s.bucket : ''}`, headers: ['Customer', 'Invoice', 'Invoice date', 'Due date', 'Days', 'Outstanding'], rows: rows.map((x) => [x.customer, x.invoice_no, x.invoice_date, x.due_date, x.age, x.outstanding]) },
          filter: (v) => Object.assign({}, s, { bucket: v || undefined }),
        };
      },

      async payables(s) {
        const d = await ctx.month(s.period); const ref = A.monthEnd(s.period);
        const all = (d.payables || []).map((x) => Object.assign({ age: days(x.bill_date, ref) }, x));
        const rows = all.filter((x) => inBucket(x.age, s.bucket, RECV_BUCKETS)).sort((a, b) => (b.age || 0) - (a.age || 0));
        const total = sum(rows, (x) => x.outstanding);
        const bySup = [...groupBy(rows, (x) => x.supplier)].map(([k, r]) => ({ k, v: sum(r, (x) => x.outstanding), n: r.length, oldest: Math.max(...r.map((x) => x.age || 0)) })).sort((a, b) => b.v - a.v);
        return {
          eyebrow: 'Payables', title: inr(total), sub: `${mLong(s.period)} · owed to suppliers${s.bucket ? ' · ' + bucketText(s.bucket) : ''}`, monthly: true,
          html: chips('Age', [['', 'All'], ['0-30', '0–30 days'], ['31-60', '31–60'], ['61+', 'Over 60 days'], ['90+', 'Over 90 days']], s.bucket) + '<div style="height:12px"></div>'
            + card('By supplier', table([{ label: 'Supplier' }, { label: 'Bills', num: true }, { label: 'Oldest', num: true }, { label: 'Owed', num: true }],
              bySup.map((c) => ({ spec: { kind: 'supplier', name: c.k, period: s.period }, cls: 'clickable', tdCls: { 2: c.oldest > 45 ? 'age-old' : '' }, cells: [L({ kind: 'supplier', name: c.k, period: s.period }, esc(c.k)), n0(c.n), `${c.oldest} days`, inr(c.v)] }))))
            + card('Bills', payableTable(rows, true), 'Oldest first')
            + `<p class="muted small">Payments to micro and small enterprise suppliers beyond 45 days can affect tax deductibility (Section 43B(h)).</p>`,
          csv: { name: `payables-${s.period}${s.bucket ? '-' + s.bucket : ''}`, headers: ['Supplier', 'Bill', 'Bill date', 'Due date', 'Days', 'Outstanding'], rows: rows.map((x) => [x.supplier, x.bill_no, x.bill_date, x.due_date, x.age, x.outstanding]) },
          filter: (v) => Object.assign({}, s, { bucket: v || undefined }),
        };
      },

      async inventory(s) {
        const d = await ctx.month(s.period); const ref = A.monthEnd(s.period);
        const all = (d.inventory || []).map((x) => Object.assign({ age: days(x.last_movement, ref) }, x));
        const rows = all.filter((x) => inBucket(x.age, s.bucket, INV_BUCKETS)).sort((a, b) => b.value - a.value);
        const total = sum(rows, (x) => x.value);
        const byCat = [...groupBy(rows, (x) => x.category)].map(([k, r]) => ({ k, v: sum(r, (x) => x.value), n: r.length })).sort((a, b) => b.v - a.v);
        return {
          eyebrow: 'Inventory', title: inr(total), sub: `${mLong(s.period)} · closing stock${s.bucket ? ' · ' + bucketText(s.bucket, true) : ''}`, monthly: true,
          html: chips('Age', [['', 'All'], ['0-90', '0–90 days'], ['91-180', '91–180'], ['181+', 'Over 6 months'], ['365+', 'Over a year']], s.bucket) + '<div style="height:12px"></div>'
            + card('By category', table([{ label: 'Category' }, { label: 'Items', num: true }, { label: 'Value', num: true }, { label: 'Share', num: true }], byCat.map((c) => ({ cells: [esc(c.k), n0(c.n), inr(c.v), pctTxt(c.v / (total || 1), 0)] }))))
            + card('Items', table([{ label: 'Item' }, { label: 'Category' }, { label: 'Quantity', num: true }, { label: 'Value', num: true }, { label: 'Last movement' }, { label: 'Days since', num: true }],
              rows.map((x) => ({ tdCls: { 5: x.age > 180 ? 'age-old' : '' }, cells: [esc(x.item), esc(x.category || ''), n0(x.qty), inr(x.value), dLong(x.last_movement), x.age == null ? '–' : n0(x.age)] }))), 'Largest value first'),
          csv: { name: `inventory-${s.period}${s.bucket ? '-' + s.bucket : ''}`, headers: ['Item', 'Category', 'Qty', 'Value', 'Last movement', 'Days since'], rows: rows.map((x) => [x.item, x.category, x.qty, x.value, x.last_movement, x.age]) },
          filter: (v) => Object.assign({}, s, { bucket: v || undefined }),
        };
      },

      async cash(s) {
        const d = await ctx.month(s.period); const m = ctx.metrics(s.period) || {};
        const accts = d.cash || [];
        return {
          eyebrow: 'Cash and bank', title: `Net cash ${inr(m.netCash)}`, sub: mLong(s.period), monthly: true,
          html: card('Calculation', `<table class="calc"><tbody>
              <tr><td>Cash and bank balances</td><td class="r">${inr(m.cash)}</td></tr>
              <tr><td>− Bank OD / CC drawn</td><td class="r">${inr(m.odUsed)}</td></tr>
              <tr class="total"><td>Net cash</td><td class="r">${inr(m.netCash)}</td></tr>
              ${m.odLimit ? `<tr><td>OD / CC limits sanctioned</td><td class="r">${inr(m.odLimit)} · ${pctTxt(m.odUsed / m.odLimit, 0)} used</td></tr>` : ''}</tbody></table>`)
            + card('Accounts', table([{ label: 'Account' }, { label: 'Type' }, { label: 'Closing balance', num: true }, { label: 'Limit', num: true }, { label: 'Utilised', num: true }],
              accts.map((c) => ({ cells: [esc(c.account), esc(c.type), inr(c.closing), c.limit ? inr(c.limit) : '–', c.limit && c.closing < 0 ? pctTxt(-c.closing / c.limit, 0) : '–'] })))),
          csv: { name: `cash-${s.period}`, headers: ['Account', 'Type', 'Closing', 'Limit'], rows: accts.map((c) => [c.account, c.type, c.closing, c.limit]) },
        };
      },

      async 'working-capital'(s) {
        const m = ctx.metrics(s.period) || {};
        return {
          eyebrow: 'Working capital', title: inr(m.workingCapital), sub: `${mLong(s.period)} · cash tied up in day-to-day trading`, monthly: true,
          html: card('Calculation', `<table class="calc"><tbody>
              <tr><td>Receivables (owed by customers)</td><td class="r">${L({ kind: 'receivables', period: s.period }, inr(m.receivables))}</td></tr>
              <tr><td>+ Inventory</td><td class="r">${L({ kind: 'inventory', period: s.period }, inr(m.inventory))}</td></tr>
              <tr><td>− Payables (owed to suppliers)</td><td class="r">${L({ kind: 'payables', period: s.period }, inr(m.payables))}</td></tr>
              <tr class="total"><td>Working capital</td><td class="r">${inr(m.workingCapital)}</td></tr></tbody></table>`)
            + card('Cycle', `<table class="calc"><tbody>
              <tr><td>Customers pay in</td><td class="r">${m.dso == null ? '–' : m.dso + ' days'}</td></tr>
              <tr><td>Stock is held for</td><td class="r">${m.dio == null ? '–' : m.dio + ' days'}</td></tr>
              <tr><td>Suppliers paid in</td><td class="r">${m.dpo == null ? '–' : m.dpo + ' days'}</td></tr>
              <tr class="total"><td>Cash conversion cycle</td><td class="r">${m.ccc == null ? '–' : m.ccc + ' days'}</td></tr></tbody></table>
              <p class="muted small">Days are based on the trailing three months of sales, purchases and cost of goods sold.</p>`),
        };
      },

      async compliance(s) {
        const L2 = ctx.latest();
        const order = { overdue: 0, 'due-soon': 1, pending: 2, done: 3, na: 4 };
        const items = L2.compliance.filter((c) => (!s.state || (s.state === 'late' ? c.late : c.state === s.state)) && (!s.area || c.area === s.area))
          .sort((x, y) => order[x.state] - order[y.state] || x.due_date.localeCompare(y.due_date));
        const STATE = { done: 'Filed / paid', overdue: 'Overdue', 'due-soon': 'Due soon', pending: 'Upcoming', na: 'Not applicable' };
        return {
          eyebrow: 'Compliance', title: s.area || ({ overdue: 'Overdue items', 'due-soon': 'Due in the next 15 days', late: 'Filed after the due date' }[s.state] || 'Compliance calendar'), sub: mLong(L2.period),
          html: chips('Status', [['', 'All'], ['overdue', 'Overdue'], ['due-soon', 'Due soon'], ['late', 'Filed late'], ['done', 'Filed / paid']], s.state) + '<div style="height:12px"></div>'
            + card(`${items.length} item${items.length === 1 ? '' : 's'}`, table([{ label: 'Area' }, { label: 'Item' }, { label: 'Period' }, { label: 'Due' }, { label: 'Status' }, { label: 'Filed / paid on' }, { label: 'Remarks' }],
              items.map((c) => ({ tdCls: { 4: c.state === 'overdue' ? 'age-old' : '' }, cells: [esc(c.area), esc(c.item), esc(c.period_covered || ''), dLong(c.due_date), esc(STATE[c.state]) + (c.late ? ' (late)' : ''), dLong(c.done_on), esc(c.remarks || '')] })), { empty: 'No items match.' })),
          csv: { name: 'compliance', headers: ['Area', 'Item', 'Period', 'Due', 'Status', 'Done on', 'Remarks'], rows: items.map((c) => [c.area, c.item, c.period_covered, c.due_date, STATE[c.state], c.done_on, c.remarks]) },
          filter: (v) => Object.assign({}, s, { state: v || undefined }),
        };
      },

      async 'lost-customers'(s) {
        return {
          eyebrow: 'Customers', title: `${s.rows.length} regular customer${s.rows.length > 1 ? 's' : ''} did not buy`, sub: `${mLong(s.period)} · bought in each of the three months before`,
          html: card('Customers', table([{ label: 'Customer' }, { label: 'Average monthly revenue before', num: true }],
            s.rows.map((r) => ({ cells: [esc(r.customer), inr(r.average)] })))),
        };
      },
    };

    function bucketText(b, inv) {
      return ({ '0-30': '0 to 30 days old', '31-60': '31 to 60 days old', '61-90': '61 to 90 days old', '90+': 'over 90 days old', '61+': 'over 60 days old',
        '0-90': 'moved in the last 90 days', '91-180': 'not moved for 91 to 180 days', '181+': 'not moved for over 6 months', '365+': 'not moved for over a year', '181-365': 'not moved for 6 to 12 months' })[b] || b;
    }

    async function salesSlice(s, key, eyebrow, pred, sub) {
      const d = await ctx.month(s.period); const all = d.sales || [];
      const rows = all.filter(pred);
      const rev = sum(all, (x) => x.taxable_value); const v = sum(rows, (x) => x.taxable_value);
      const byCust = [...groupBy(rows, (x) => x.customer)].map(([k, r]) => ({ k, v: sum(r, (x) => x.taxable_value) })).sort((a, b) => b.v - a.v);
      return {
        eyebrow, title: s.name || inr(v), sub: `${mLong(s.period)} · ${sub || inr(v) + ' · ' + pctTxt(v / (rev || 1), 1) + ' of revenue'}`, monthly: true,
        html: sumrow([['Revenue', inr(v)], ['Share of month', pctTxt(v / (rev || 1), 1)], ['Customers', n0(byCust.length)], ['Invoice lines', n0(rows.length)]])
          + card('By customer', table([{ label: 'Customer' }, { label: 'Revenue', num: true }, { label: 'Share', num: true }],
            byCust.map((c) => ({ spec: { kind: 'customer', name: c.k, period: s.period }, cls: 'clickable', cells: [L({ kind: 'customer', name: c.k, period: s.period }, esc(c.k)), inr(c.v), pctTxt(c.v / (v || 1), 1)] }))))
          + card('Invoice lines', invoiceTable(rows, s.period)),
        csv: { name: `${key}-${s.period}`, headers: ['Date', 'Invoice', 'Customer', 'Product', 'Qty', 'Taxable value'], rows: rows.map((x) => [x.date, x.invoice_no, x.customer, x.product, x.qty, x.taxable_value]) },
      };
    }

    function invoiceTable(rows, period, hideCustomer) {
      const h = [{ label: 'Date' }, { label: 'Invoice' }].concat(hideCustomer ? [] : [{ label: 'Customer' }], [{ label: 'Product' }, { label: 'Qty', num: true }, { label: 'Taxable value', num: true }]);
      return `${rows.length > 12 ? `<input class="search" type="search" placeholder="Search these rows" aria-label="Search rows" data-search>` : ''}` + table(h, rows.map((x) => ({
        cells: [dLong(x.date), esc(x.invoice_no)].concat(hideCustomer ? [] : [L({ kind: 'customer', name: x.customer, period }, esc(x.customer))], [esc(x.product), n0(x.qty), inr(x.taxable_value)]),
      })), { empty: 'No invoices.' });
    }
    function receivableTable(rows, withCustomer) {
      const h = (withCustomer ? [{ label: 'Customer' }] : []).concat([{ label: 'Invoice' }, { label: 'Invoice date' }, { label: 'Due date' }, { label: 'Days', num: true }, { label: 'Outstanding', num: true }]);
      return table(h, rows.map((x) => ({ tdCls: withCustomer ? { 4: x.age > 90 ? 'age-old' : '' } : { 3: x.age > 90 ? 'age-old' : '' },
        cells: (withCustomer ? [esc(x.customer)] : []).concat([esc(x.invoice_no || ''), dLong(x.invoice_date), dLong(x.due_date), x.age == null ? '–' : n0(x.age), inr(x.outstanding)]) })), { empty: 'Nothing outstanding.' });
    }
    function payableTable(rows, withSupplier) {
      const h = (withSupplier ? [{ label: 'Supplier' }] : []).concat([{ label: 'Bill' }, { label: 'Bill date' }, { label: 'Due date' }, { label: 'Days', num: true }, { label: 'Owed', num: true }]);
      return table(h, rows.map((x) => ({ tdCls: withSupplier ? { 4: x.age > 60 ? 'age-old' : '' } : { 3: x.age > 60 ? 'age-old' : '' },
        cells: (withSupplier ? [esc(x.supplier)] : []).concat([esc(x.bill_no || ''), dLong(x.bill_date), dLong(x.due_date), x.age == null ? '–' : n0(x.age), inr(x.outstanding)]) })), { empty: 'Nothing owed.' });
    }
    function purchaseItems(rows, period) {
      const byItem = [...groupBy(rows, (x) => x.item)].map(([k, r]) => { const q = sum(r, (x) => x.qty); const v = sum(r, (x) => x.taxable_value); return { k, q, v, rt: q ? v / q : null }; }).sort((a, b) => b.v - a.v);
      return table([{ label: 'Item' }, { label: 'Quantity', num: true }, { label: 'Average rate', num: true }, { label: 'Amount', num: true }], byItem.map((x) => ({ cells: [esc(x.k), n0(x.q), rate(x.rt), inr(x.v)] })), { empty: 'No purchases.' });
    }

    function downloadCsv(csv) {
      const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const text = [csv.headers].concat(csv.rows).map((r) => r.map(cell).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
      a.download = `${(ctx.company() || {}).code || 'assura'}-${csv.name}.csv`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }

    // Each view opened in the panel is a browser history entry, so the phone's
    // back button (or the browser's) steps back through the panel and then closes it.
    const H = typeof history !== 'undefined' && history.pushState ? history : null;
    const depthOf = (st) => (st && st.aeDrill) || 0;
    function pushEntry() { if (H) H.pushState(Object.assign({}, H.state, { aeDrill: stack.length }), ''); }
    function back() { if (H && depthOf(H.state) === stack.length) H.back(); else { stack.pop(); if (stack.length) show(); else teardown(); } }
    function close() {
      if (!root) return;
      if (H && depthOf(H.state) === stack.length && stack.length) H.go(-stack.length); else teardown();
    }
    function teardown() {
      if (!root) return;
      root.remove(); root = null; stack = [];
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
      if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    }
    if (typeof window !== 'undefined') window.addEventListener('popstate', (e) => {
      if (!root) return;
      const d = depthOf(e.state);
      if (d <= 0) teardown();
      else if (d < stack.length) { stack.length = d; show(); }
    });
    function onKey(e) { if (e.key === 'Escape') close(); }
    // On phones, a swipe to the right across the panel goes back one step.
    function swipeStart(e) {
      if (e.touches.length !== 1 || e.target.closest('.table-wrap,.edit-scroll,input,select')) return;
      const x0 = e.touches[0].clientX; const y0 = e.touches[0].clientY; const t0 = Date.now();
      const end = (ev) => {
        ev.currentTarget.removeEventListener('touchend', end);
        const t = ev.changedTouches[0]; const dx = t.clientX - x0; const dy = Math.abs(t.clientY - y0);
        if (dx > 80 && dy < dx / 2 && Date.now() - t0 < 600) back();
      };
      e.currentTarget.addEventListener('touchend', end);
    }
    let lastFocus = null;

    async function show() {
      const spec = stack[stack.length - 1];
      if (!root) {
        lastFocus = document.activeElement;
        root = document.createElement('div');
        root.innerHTML = '<div class="drawer-back"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Details"></aside>';
        document.body.appendChild(root);
        document.body.style.overflow = 'hidden';
        root.querySelector('.drawer-back').addEventListener('click', close);
        root.querySelector('.drawer').addEventListener('touchstart', swipeStart, { passive: true });
        document.addEventListener('keydown', onKey);
      }
      const panel = root.querySelector('.drawer');
      panel.innerHTML = '<div class="drawer-head"><div><div class="eyebrow">Loading</div><h2>…</h2></div></div>';
      links = [];
      let v;
      try {
        const fn = views[spec.kind];
        if (!fn) throw new Error('No breakdown for this item yet.');
        v = await fn(spec);
      } catch (e) { v = { eyebrow: 'Details', title: 'Not available', html: `<p class="muted">${esc(e.status === 404 ? 'No data has been uploaded for this month.' : e.message)}</p>` }; }
      if (!root) return;
      const periods = ctx.periods();
      panel.innerHTML = `<div class="drawer-head"><button class="drawer-backbtn" data-back aria-label="${stack.length > 1 ? 'Back to the previous view' : 'Back to the dashboard'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${stack.length > 1 ? 'Back' : 'Dashboard'}</span></button><div class="drawer-title"><div class="eyebrow">${esc(v.eyebrow)}</div><h2>${esc(v.title)}</h2>${v.sub ? `<div class="sub">${esc(v.sub)}</div>` : ''}</div>
          <span class="spacer"></span><button class="btn-ghost" data-close aria-label="Close details">Close</button></div>
        <div class="drawer-nav">${stack.length > 1 ? `<nav class="crumbs" aria-label="Where you are">${stack.map((x, i) => i < stack.length - 1 ? `<button type="button" data-crumb="${i + 1}">${esc(x._title || 'Back')}</button><span aria-hidden="true">/</span>` : `<b>${esc(v.title)}</b>`).join('')}</nav>` : ''}
          ${v.monthly && spec.period && periods.length > 1 ? `<label class="small muted" style="margin:0">Month <select class="field" data-month style="width:auto;display:inline-block;padding:5px 8px">${periods.slice().reverse().map((p) => `<option value="${p}" ${p === spec.period ? 'selected' : ''}>${mLong(p)}</option>`).join('')}</select></label>` : ''}
          <span style="flex:1"></span>${v.csv && v.csv.rows.length ? '<button class="btn secondary small" data-csv>Download as CSV</button>' : ''}</div>
        <div class="drawer-body">${v.html}</div>`;
      panel.querySelector('[data-close]').addEventListener('click', close);
      spec._title = /^[-−₹\d]/.test(v.title) ? v.eyebrow : v.title; // breadcrumb label: the name, not a figure
      panel.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', back));
      panel.querySelectorAll('[data-crumb]').forEach((b) => b.addEventListener('click', () => { const steps = stack.length - Number(b.dataset.crumb); if (H && depthOf(H.state) === stack.length) H.go(-steps); else { stack.length = Number(b.dataset.crumb); show(); } }));
      const month = panel.querySelector('[data-month]'); if (month) month.addEventListener('change', () => { stack[stack.length - 1] = Object.assign({}, spec, { period: month.value }); show(); });
      const csv = panel.querySelector('[data-csv]'); if (csv) csv.addEventListener('click', () => downloadCsv(v.csv));
      panel.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { stack[stack.length - 1] = v.filter(b.dataset.filter); show(); }));
      panel.querySelectorAll('[data-d]').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = links[Number(el.dataset.d)];
        if (next) { stack.push(next); pushEntry(); show(); }
      }));
      panel.querySelectorAll('[data-search]').forEach((inp) => inp.addEventListener('input', () => {
        const q = inp.value.toLowerCase();
        inp.nextElementSibling.querySelectorAll('tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
      }));
      panel.querySelector('.drawer-body').scrollTop = 0;
      panel.querySelector('[data-close]').focus();
    }

    return {
      open(spec) {
        if (!spec) return;
        const fresh = !root;
        stack = [Object.assign({ period: ctx.latestPeriod() }, spec)];
        if (fresh) pushEntry(); else if (H) H.replaceState(Object.assign({}, H.state, { aeDrill: 1 }), '');
        show();
      },
      isOpen: () => !!root,
      close,
    };
  };
})();
