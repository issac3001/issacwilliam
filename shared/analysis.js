/*
 * Assura Elevate: automated analysis engine.
 * Reads every uploaded month for one company and produces month-on-month
 * metrics, ageing, patterns found in transactions, and ranked highlights.
 * Deterministic, rule-based statistics: every highlight can be traced back to
 * the numbers that produced it. Works in the browser (window.AEAnalysis) and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AEAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const SEVERITY_ORDER = { critical: 0, watch: 1, positive: 2, info: 3 };

  const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) || 0 : x || 0), 0);
  const mean = (arr) => (arr.length ? sum(arr) / arr.length : null);
  const pct = (a, b) => (b ? a / b : null);
  const round = (n, d = 0) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

  function stdev(arr) {
    if (arr.length < 2) return null;
    const m = mean(arr);
    return Math.sqrt(sum(arr.map((x) => (x - m) ** 2)) / (arr.length - 1));
  }

  // Least-squares slope per period, used to describe direction over several months.
  function slope(values) {
    const pts = values.map((y, x) => [x, y]).filter((p) => p[1] != null);
    if (pts.length < 3) return null;
    const mx = mean(pts.map((p) => p[0]));
    const my = mean(pts.map((p) => p[1]));
    const num = sum(pts.map((p) => (p[0] - mx) * (p[1] - my)));
    const den = sum(pts.map((p) => (p[0] - mx) ** 2));
    return den ? num / den : null;
  }

  function monthEnd(period) {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0));
  }
  function daysBetween(iso, ref) { return Math.floor((ref - Date.parse(iso)) / DAY); }

  function inr(n) {
    if (n == null) return '–';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)} L`;
    return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dmy(iso) { return iso ? `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : ''; }
  function pctTxt(x, d = 1) { return x == null ? '–' : `${(x * 100).toFixed(d)}%`; }

  const BUCKETS = [
    { key: '0-30', max: 30 }, { key: '31-60', max: 60 }, { key: '61-90', max: 90 }, { key: '90+', max: Infinity },
  ];
  const INV_BUCKETS = [
    { key: '0-90', max: 90 }, { key: '91-180', max: 180 }, { key: '181-365', max: 365 }, { key: '365+', max: Infinity },
  ];

  function age(rows, dateKey, amountKey, ref, buckets) {
    const out = Object.fromEntries(buckets.map((b) => [b.key, 0]));
    let unknown = 0;
    rows.forEach((r) => {
      if (!r[dateKey]) { unknown += r[amountKey] || 0; return; }
      const d = daysBetween(r[dateKey], ref);
      const b = buckets.find((x) => d <= x.max);
      out[b.key] += r[amountKey] || 0;
    });
    if (unknown) out.unknown = unknown;
    return out;
  }

  function groupSum(rows, keyF, valF) {
    const m = new Map();
    rows.forEach((r) => { const k = keyF(r); m.set(k, (m.get(k) || 0) + (valF(r) || 0)); });
    return m;
  }
  function topN(map, n) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, value]) => ({ name, value }));
  }

  // ---------- per-month metrics ----------

  function monthMetrics(entry, prevEntry) {
    const d = entry.data;
    const period = entry.period;
    const ref = monthEnd(period);
    const sales = d.sales || [];
    const purchases = d.purchases || [];
    const expenses = d.expenses || [];
    const inventory = d.inventory || [];
    const recv = d.receivables || [];
    const pay = d.payables || [];
    const cash = d.cash || [];

    const revenue = sum(sales, (s) => s.taxable_value);
    const purchaseTotal = sum(purchases, (p) => p.taxable_value);
    const closingStock = d.inventory ? sum(inventory, (i) => i.value) : null;
    let openingStock = null;
    if (prevEntry && prevEntry.data.inventory) openingStock = sum(prevEntry.data.inventory, (i) => i.value);
    else if (d.company && d.company.opening_stock != null) openingStock = d.company.opening_stock;
    const cogs = openingStock != null && closingStock != null ? openingStock + purchaseTotal - closingStock : null;
    const grossProfit = cogs != null ? revenue - cogs : null;
    const opex = sum(expenses, (e) => e.amount);
    const otherIncome = (d.company && d.company.other_income) || 0;
    const netProfit = grossProfit != null ? grossProfit - opex + otherIncome : null;

    const cashBal = sum(cash.filter((c) => !['OD', 'CC'].includes(c.type)), (c) => c.closing);
    const borrowings = cash.filter((c) => ['OD', 'CC'].includes(c.type));
    const odUsed = sum(borrowings, (c) => Math.abs(Math.min(c.closing, 0)));
    const odLimit = sum(borrowings, (c) => c.limit);

    const receivables = sum(recv, (r) => r.outstanding);
    const payables = sum(pay, (p) => p.outstanding);

    const byCustomer = groupSum(sales, (s) => s.customer, (s) => s.taxable_value);
    const top = topN(byCustomer, 5);
    const b2b = sum(sales.filter((s) => s.customer_type === 'B2B'), (s) => s.taxable_value);
    const invoices = new Set(sales.map((s) => s.invoice_no));
    const lastDays = sales.filter((s) => ref.getUTCDate() - Number(s.date.slice(8, 10)) < 5);

    return {
      period,
      revenue, purchases: purchaseTotal, cogs, grossProfit,
      gmPct: grossProfit != null ? pct(grossProfit, revenue) : null,
      opex, otherIncome, netProfit, npPct: netProfit != null ? pct(netProfit, revenue) : null,
      cash: cashBal, odUsed, odLimit, netCash: cashBal - odUsed,
      receivables, payables, inventory: closingStock,
      workingCapital: receivables + (closingStock || 0) - payables,
      b2bShare: pct(b2b, revenue),
      customerCount: byCustomer.size,
      invoiceCount: invoices.size,
      avgInvoice: invoices.size ? revenue / invoices.size : null,
      topCustomerShare: top.length ? pct(top[0].value, revenue) : null,
      top5Share: pct(sum(top, (t) => t.value), revenue),
      monthEndShare: pct(sum(lastDays, (s) => s.taxable_value), revenue),
      expenseByGroup: Object.fromEntries(groupSum(expenses, (e) => e.group, (e) => e.amount)),
    };
  }

  // Trailing-window ratios (days of sales, purchases and stock).
  function addDayRatios(months) {
    months.forEach((m, i) => {
      const win = months.slice(Math.max(0, i - 2), i + 1);
      const avgRev = mean(win.map((x) => x.revenue));
      const avgPur = mean(win.map((x) => x.purchases));
      const cogsVals = win.map((x) => x.cogs).filter((x) => x != null);
      const avgCogs = cogsVals.length ? mean(cogsVals) : null;
      m.dso = avgRev ? round((m.receivables / avgRev) * 30) : null;
      m.dpo = avgPur ? round((m.payables / avgPur) * 30) : null;
      m.dio = avgCogs && m.inventory != null ? round((m.inventory / avgCogs) * 30) : null;
      m.ccc = m.dso != null && m.dio != null && m.dpo != null ? m.dso + m.dio - m.dpo : null;
    });
  }

  // ---------- latest-month detail ----------

  function latestDetail(entry, history, asOf) {
    const d = entry.data;
    const ref = monthEnd(entry.period);
    const recv = d.receivables || [];
    const pay = d.payables || [];
    const inv = d.inventory || [];

    const recvAgeing = age(recv, 'invoice_date', 'outstanding', ref, BUCKETS);
    const payAgeing = age(pay, 'bill_date', 'outstanding', ref, BUCKETS);
    const invAgeing = age(inv, 'last_movement', 'value', ref, INV_BUCKETS);

    const overdueByCustomer = groupSum(
      recv.filter((r) => daysBetween(r.invoice_date, ref) > 90), (r) => r.customer, (r) => r.outstanding);
    const slowStock = inv.filter((i) => i.last_movement && daysBetween(i.last_movement, ref) > 180)
      .sort((a, b) => b.value - a.value).slice(0, 5)
      .map((i) => ({ name: i.item, value: i.value, days: daysBetween(i.last_movement, ref) }));

    const sales = d.sales || [];
    const byProduct = groupSum(sales, (s) => s.category || s.product, (s) => s.taxable_value);
    const byCustomer = groupSum(sales, (s) => s.customer, (s) => s.taxable_value);
    const byRegion = groupSum(sales.filter((s) => s.region), (s) => s.region, (s) => s.taxable_value);

    const compliance = (d.compliance || []).map((c) => {
      let state = c.status === 'Filed' || c.status === 'Paid' ? 'done' : c.status === 'Not Applicable' ? 'na' : 'pending';
      const daysLeft = Math.floor((Date.parse(c.due_date) - asOf) / DAY);
      if (state === 'pending') state = daysLeft < 0 ? 'overdue' : daysLeft <= 15 ? 'due-soon' : 'pending';
      const late = (state === 'done' && c.done_on && c.done_on > c.due_date);
      return Object.assign({}, c, { state, daysLeft, late });
    });
    const complianceByArea = {};
    compliance.forEach((c) => {
      const rank = { overdue: 0, 'due-soon': 1, pending: 2, done: 3, na: 4 };
      const cur = complianceByArea[c.area];
      if (!cur || rank[c.state] < rank[cur]) complianceByArea[c.area] = c.state;
    });

    return {
      period: entry.period,
      prepared_by: d.company && d.company.prepared_by,
      notes: d.company && d.company.notes,
      recvAgeing, payAgeing, invAgeing,
      topOverdue: topN(overdueByCustomer, 5),
      slowStock,
      topCustomers: topN(byCustomer, 8),
      productMix: topN(byProduct, 8),
      regionMix: topN(byRegion, 8),
      expenseHeads: (d.expenses || []).slice().sort((a, b) => b.amount - a.amount),
      cashAccounts: d.cash || [],
      compliance, complianceByArea,
    };
  }

  // ---------- highlights ----------

  function buildHighlights(months, entries, detail) {
    const H = [];
    const add = (severity, area, title, detail, action) => H.push({ severity, area, title, detail, action });
    const n = months.length;
    const cur = months[n - 1];
    const prev = months[n - 2];
    const trail = months.slice(Math.max(0, n - 4), n - 1); // up to 3 prior months

    // Revenue movement and direction
    if (prev && prev.revenue) {
      const ch = cur.revenue / prev.revenue - 1;
      if (ch <= -0.1) add('watch', 'Revenue', `Revenue down ${pctTxt(-ch, 0)} on last month`,
        `${inr(cur.revenue)} against ${inr(prev.revenue)} last month.`, 'Confirm whether this is seasonal, a lost account or delayed billing.');
      else if (ch >= 0.1) add('positive', 'Revenue', `Revenue up ${pctTxt(ch, 0)} on last month`,
        `${inr(cur.revenue)} against ${inr(prev.revenue)} last month.`, 'Check that receivables and stock are keeping pace with the growth.');
    }
    if (n >= 4) {
      const last = months.slice(-4).map((m) => m.revenue);
      if (last[1] < last[0] && last[2] < last[1] && last[3] < last[2]) add('critical', 'Revenue', 'Revenue has fallen three months in a row',
        `From ${inr(last[0])} to ${inr(last[3])} over the last three months.`, 'Review pipeline, pricing and top-customer volumes at the management review.');
      const high = Math.max(...months.slice(-12).map((m) => m.revenue));
      if (n >= 6 && cur.revenue === high) add('positive', 'Revenue', 'Highest monthly revenue in the period on record',
        `${inr(cur.revenue)} is the best month of the last ${Math.min(n, 12)}.`, null);
    }

    // Margin
    const gmTrail = trail.map((m) => m.gmPct).filter((x) => x != null);
    if (cur.gmPct != null && gmTrail.length >= 2) {
      const diff = cur.gmPct - mean(gmTrail);
      if (diff <= -0.02) add(diff <= -0.04 ? 'critical' : 'watch', 'Margin', `Gross margin down ${(Math.abs(diff) * 100).toFixed(1)} points`,
        `${pctTxt(cur.gmPct)} this month against a ${gmTrail.length}-month average of ${pctTxt(mean(gmTrail))}.`, 'Look at purchase rates, discounts and product mix.');
      else if (diff >= 0.02) add('positive', 'Margin', `Gross margin up ${(diff * 100).toFixed(1)} points`,
        `${pctTxt(cur.gmPct)} this month against a ${gmTrail.length}-month average of ${pctTxt(mean(gmTrail))}.`, null);
    }

    // Purchase price movement by item (weighted unit rate)
    if (n >= 2) {
      const rate = (rows) => {
        const m = new Map();
        rows.filter((p) => p.qty > 0).forEach((p) => {
          const r = m.get(p.item) || { v: 0, q: 0 };
          r.v += p.taxable_value; r.q += p.qty; m.set(p.item, r);
        });
        return m;
      };
      const now = rate(entries[n - 1].data.purchases || []);
      const before = rate([].concat(...entries.slice(Math.max(0, n - 4), n - 1).map((e) => e.data.purchases || [])));
      const rises = [];
      now.forEach((r, item) => {
        const b = before.get(item);
        if (!b || !b.q) return;
        const ch = (r.v / r.q) / (b.v / b.q) - 1;
        if (ch >= 0.08 && r.v > cur.purchases * 0.03) rises.push({ item, ch, value: r.v });
      });
      rises.sort((a, b) => b.value - a.value);
      if (rises.length) add('watch', 'Purchases', `Purchase rates up on ${rises.length} key item${rises.length > 1 ? 's' : ''}`,
        rises.slice(0, 3).map((r) => `${r.item} +${pctTxt(r.ch, 0)}`).join(', ') + ' against the prior three-month average rate.',
        'Check whether selling prices have moved with input costs.');
    }

    // Receivables
    const ra = detail.recvAgeing;
    const recvTotal = sum(Object.values(ra));
    const over90 = pct(ra['90+'], recvTotal);
    if (over90 != null && over90 > 0.15) {
      const names = detail.topOverdue.slice(0, 3).map((t) => `${t.name} (${inr(t.value)})`).join(', ');
      add(over90 > 0.25 ? 'critical' : 'watch', 'Receivables', `${inr(ra['90+'])} of receivables is over 90 days old`,
        `${pctTxt(over90, 0)} of total receivables. Largest: ${names}.`, 'Agree a collection plan for each account and consider credit holds.');
    }
    const dsoSeries = months.slice(-4).map((m) => m.dso);
    if (dsoSeries.length === 4 && dsoSeries.every((x, i) => i === 0 || x > dsoSeries[i - 1]))
      add('watch', 'Receivables', 'Customers are taking longer to pay',
        `Collection period has stretched for three months running, from ${dsoSeries[0]} to ${dsoSeries[3]} days.`, 'Review credit terms on the largest accounts.');
    else if (prev && prev.dso && cur.dso && cur.dso <= prev.dso - 7)
      add('positive', 'Receivables', `Collections improved by ${prev.dso - cur.dso} days`, `Collection period is now ${cur.dso} days.`, null);

    // Customers: concentration, lost and new accounts
    if (n >= 1) {
      const window = entries.slice(-3);
      const rev3 = groupSum([].concat(...window.map((e) => e.data.sales || [])), (s) => s.customer, (s) => s.taxable_value);
      const total3 = sum([...rev3.values()]);
      const top = topN(rev3, 1)[0];
      if (top && total3 && top.value / total3 > 0.25)
        add('watch', 'Concentration', `${top.name} is ${pctTxt(top.value / total3, 0)} of revenue`,
          `Based on the last ${window.length} month(s). Losing or delaying this account would move results materially.`, 'Track this account closely and widen the customer base.');
    }
    if (n >= 4) {
      const custSet = (e) => new Set((e.data.sales || []).map((s) => s.customer));
      const priorSets = entries.slice(n - 4, n - 1).map(custSet);
      const nowSet = custSet(entries[n - 1]);
      const regular = [...priorSets[0]].filter((c) => priorSets.every((s) => s.has(c)));
      const lost = regular.filter((c) => !nowSet.has(c));
      if (lost.length) {
        const priorRev = groupSum([].concat(...entries.slice(n - 4, n - 1).map((e) => e.data.sales || [])), (s) => s.customer, (s) => s.taxable_value);
        const ranked = lost.map((c) => ({ c, v: (priorRev.get(c) || 0) / 3 })).sort((a, b) => b.v - a.v);
        const atRisk = sum(ranked, (r) => r.v);
        add(atRisk > cur.revenue * 0.05 ? 'watch' : 'info', 'Customers', `${lost.length} regular customer${lost.length > 1 ? 's' : ''} did not buy this month`,
          `${ranked.slice(0, 3).map((r) => r.c).join(', ')}${lost.length > 3 ? ' and others' : ''}. Together they averaged ${inr(atRisk)} a month.`,
          'Check with sales whether these accounts are lost or delayed.');
      }
      const ever = new Set([].concat(...entries.slice(0, n - 1).map((e) => [...custSet(e)])));
      const fresh = [...nowSet].filter((c) => !ever.has(c));
      if (fresh.length >= 2) add('positive', 'Customers', `${fresh.length} new customers billed this month`, fresh.slice(0, 4).join(', ') + (fresh.length > 4 ? ' and others.' : '.'), null);
    }

    // Billing pattern: month-end loading
    const meTrail = mean(trail.map((m) => m.monthEndShare).filter((x) => x != null));
    if (cur.monthEndShare != null && cur.monthEndShare > 0.4 && (meTrail == null || cur.monthEndShare > meTrail + 0.1))
      add('watch', 'Billing pattern', `${pctTxt(cur.monthEndShare, 0)} of sales billed in the last five days`,
        meTrail != null ? `Usually ${pctTxt(meTrail, 0)}. Heavy month-end billing can signal pushed sales or cut-off issues.` : 'Heavy month-end billing can signal pushed sales or cut-off issues.',
        'Ask the accountant to confirm dispatch dates for late invoices.');

    // Inventory
    const ia = detail.invAgeing;
    const invTotal = sum(Object.values(ia));
    const slow = (ia['181-365'] || 0) + (ia['365+'] || 0);
    if (invTotal && slow / invTotal > 0.15)
      add(slow / invTotal > 0.3 ? 'critical' : 'watch', 'Inventory', `${inr(slow)} of cash is locked in stock not moved for 6+ months`,
        `${pctTxt(slow / invTotal, 0)} of closing stock. Largest: ${detail.slowStock.slice(0, 3).map((s) => s.name).join(', ')}.`, 'Decide on liquidation, return or write-down for slow items.');
    const dioS = months.slice(-4).map((m) => m.dio).filter((x) => x != null);
    if (dioS.length === 4 && dioS[3] > dioS[0] * 1.2)
      add('watch', 'Inventory', 'Stock is building up faster than sales',
        `Days of inventory rose from ${dioS[0]} to ${dioS[3]} over three months.`, 'Align purchase planning with the sales run-rate.');

    // Expenses: anomaly against each head's own history
    if (n >= 4) {
      const flagged = [];
      (entries[n - 1].data.expenses || []).forEach((e) => {
        const hist = entries.slice(0, n - 1).map((x) => sum((x.data.expenses || []).filter((y) => y.head === e.head), (y) => y.amount)).filter((v) => v > 0);
        if (hist.length < 3) return;
        const m = mean(hist); const sd = stdev(hist) || 0;
        if (e.amount > m * 1.2 && e.amount - m > 2 * sd && e.amount - m > cur.revenue * 0.002)
          flagged.push({ head: e.head, amount: e.amount, avg: m });
      });
      flagged.sort((a, b) => (b.amount - b.avg) - (a.amount - a.avg));
      if (flagged.length) add('watch', 'Expenses', `Unusual spend on ${flagged.map((f) => f.head).slice(0, 3).join(', ')}`,
        flagged.slice(0, 3).map((f) => `${f.head} ${inr(f.amount)} vs usual ${inr(f.avg)}`).join('; ') + '.', 'Confirm whether these are one-offs or a new run-rate.');
      const r3 = sum(months.slice(-3), (m) => m.revenue); const r3p = sum(months.slice(-6, -3), (m) => m.revenue);
      const e3 = sum(months.slice(-3), (m) => m.opex); const e3p = sum(months.slice(-6, -3), (m) => m.opex);
      if (n >= 6 && r3p && e3p && e3 / e3p - 1 > (r3 / r3p - 1) + 0.08)
        add('watch', 'Expenses', 'Overheads are growing faster than revenue',
          `Last quarter: expenses ${pctTxt(e3 / e3p - 1, 0)}, revenue ${pctTxt(r3 / r3p - 1, 0)} against the quarter before.`, 'Review discretionary spend and headcount additions.');
    }

    // Cash and borrowing
    if (cur.odLimit && cur.odUsed / cur.odLimit > 0.85)
      add(cur.odUsed / cur.odLimit > 0.95 ? 'critical' : 'watch', 'Cash', `Working capital limits ${pctTxt(cur.odUsed / cur.odLimit, 0)} utilised`,
        `${inr(cur.odUsed)} drawn of ${inr(cur.odLimit)} sanctioned.`, 'Plan collections and payments for the coming weeks; consider a limit review with the bank.');
    if (n >= 4) {
      const nc = months.slice(-4).map((m) => m.netCash);
      if (nc[1] < nc[0] && nc[2] < nc[1] && nc[3] < nc[2])
        add('watch', 'Cash', 'Net cash position has declined three months in a row', `From ${inr(nc[0])} to ${inr(nc[3])}.`, 'Look at where cash is going: receivables, stock or overheads.');
    }
    if (prev) {
      const wcCh = cur.workingCapital - prev.workingCapital;
      if (prev.workingCapital && Math.abs(wcCh) / prev.workingCapital > 0.1)
        add(wcCh > 0 && cur.revenue <= prev.revenue ? 'watch' : 'info', 'Working capital',
          `${inr(Math.abs(wcCh))} ${wcCh > 0 ? 'more' : 'less'} cash tied up in working capital`,
          `Receivables plus stock less payables is now ${inr(cur.workingCapital)}.`, wcCh > 0 ? 'See "Where is the money" for the breakdown.' : null);
    }

    // Payables to possible MSME suppliers
    const pa = detail.payAgeing;
    const payOld = (pa['61-90'] || 0) + (pa['90+'] || 0);
    if (payOld > 0 && cur.payables && payOld / cur.payables > 0.2)
      add('watch', 'Payables', `${inr(payOld)} owed to suppliers for over 60 days`,
        'Delayed payments strain supply and, for micro and small enterprise suppliers, payments beyond 45 days can affect tax deductibility (Section 43B(h)).',
        'Confirm the MSME status of these suppliers and prioritise them.');

    // Compliance
    const overdue = detail.compliance.filter((c) => c.state === 'overdue');
    const soon = detail.compliance.filter((c) => c.state === 'due-soon');
    const late = detail.compliance.filter((c) => c.late);
    if (overdue.length) add('critical', 'Compliance', `${overdue.length} compliance item${overdue.length > 1 ? 's' : ''} overdue`,
      overdue.map((c) => `${c.item} (due ${dmy(c.due_date)})`).join(', ') + '.', 'File immediately to limit interest and late fees.');
    if (soon.length) add('info', 'Compliance', `${soon.length} item${soon.length > 1 ? 's' : ''} due in the next 15 days`,
      soon.map((c) => `${c.item} by ${dmy(c.due_date)}`).join(', ') + '.', null);
    if (late.length) add('watch', 'Compliance', `${late.length} item${late.length > 1 ? 's were' : ' was'} filed after the due date`,
      late.map((c) => c.item).join(', ') + '.', 'Check for interest or fees and fix the cause in the monthly calendar.');
    if (!overdue.length && !late.length && detail.compliance.length)
      add('positive', 'Compliance', 'All compliance items this month are on time', `${detail.compliance.filter((c) => c.state === 'done').length} items filed or paid.`, null);

    H.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return H;
  }

  // Short plain-language trend lines for the trend panel.
  function trends(months) {
    const last6 = months.slice(-6);
    const out = [];
    const describe = (label, vals, fmt, goodUp) => {
      const s = slope(vals);
      const avg = mean(vals.filter((v) => v != null));
      if (s == null || !avg) return;
      const rel = s / Math.abs(avg);
      const dir = Math.abs(rel) < 0.01 ? 'flat' : rel > 0 ? 'rising' : 'falling';
      const tone = dir === 'flat' ? 'neutral' : (dir === 'rising') === goodUp ? 'good' : 'bad';
      out.push({ label, dir, tone, perMonth: fmt(s), values: vals });
    };
    describe('Revenue', last6.map((m) => m.revenue), inr, true);
    describe('Gross margin', last6.map((m) => m.gmPct), (s) => `${(s * 100).toFixed(1)} pts`, true);
    describe('Expenses', last6.map((m) => m.opex), inr, false);
    describe('Receivables', last6.map((m) => m.receivables), inr, false);
    describe('Inventory', last6.map((m) => m.inventory), inr, false);
    describe('Net cash', last6.map((m) => m.netCash), inr, true);
    return out;
  }

  /**
   * entries: [{ period: 'YYYY-MM', data }] for one company, any order.
   * opts.asOf: Date used for compliance due-date checks (defaults to now).
   */
  function analyse(entries, opts) {
    opts = opts || {};
    const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
    const sorted = entries.slice().sort((a, b) => a.period.localeCompare(b.period));
    if (!sorted.length) return { months: [], highlights: [], latest: null, trends: [] };
    const months = sorted.map((e, i) => monthMetrics(e, sorted[i - 1]));
    addDayRatios(months);
    const latest = latestDetail(sorted[sorted.length - 1], sorted, asOf);
    const highlights = buildHighlights(months, sorted, latest);
    return { months, latest, highlights, trends: trends(months), generatedAt: new Date().toISOString() };
  }

  return { analyse, inr, pctTxt };
});
