#!/usr/bin/env node
/*
 * Generates 12 months of fictional sample data for two demo companies.
 * Output: samples/json/<company_code>/<period>.json (normalized datasets).
 * The companies, customers and suppliers are invented for demonstration.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'samples', 'json');
const PERIODS = [];
for (let i = 0; i < 12; i++) {
  const d = new Date(Date.UTC(2025, 9 + i, 1));
  PERIODS.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(Date.parse(isoDate) + n * 86400000));
const monthEnd = (p) => { const [y, m] = p.split('-').map(Number); return iso(new Date(Date.UTC(y, m, 0))); };
const r2 = (n) => Math.round(n * 100) / 100;

function company(cfg) {
  const R = rng(cfg.seed);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const weighted = (arr) => { const t = arr.reduce((a, x) => a + x.w, 0); let v = R() * t; for (const x of arr) { v -= x.w; if (v <= 0) return x; } return arr[arr.length - 1]; };

  const invoices = []; // all sales across months, with paid date for receivables simulation
  const bills = [];
  const stock = new Map(cfg.products.map((p) => [p.name, { value: p.stock, last: '2025-09-20', cat: p.cat }]));
  const months = {};

  PERIODS.forEach((period, mi) => {
    const [y, m] = period.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const story = cfg.story(mi, R);
    const target = cfg.baseRevenue * (1 + cfg.growth * mi) * (1 + 0.06 * Math.sin((mi + cfg.phase) / 1.9)) * story.revenueFactor;

    // ---- Sales ----
    const sales = [];
    let total = 0; let inv = 1;
    const custs = cfg.customers.filter((c) => !(story.absent || []).includes(c.name));
    while (total < target) {
      const c = weighted(custs);
      const prod = pick(cfg.products.filter((p) => !(story.deadProducts || []).includes(p.name)));
      const lateBias = story.monthEndBias && R() < story.monthEndBias;
      const day = lateBias ? days - Math.floor(R() * 5) : 1 + Math.floor(R() * days);
      const date = `${period}-${String(day).padStart(2, '0')}`;
      const value = Math.round(c.ticket * (0.6 + R() * 0.8));
      const qty = Math.max(1, Math.round(value / prod.price));
      const no = `${cfg.prefix}/${period.replace('-', '')}/${String(inv++).padStart(4, '0')}`;
      const gst = Math.round(value * prod.gst);
      const rec = { date, invoice_no: no, customer: c.name, customer_type: c.type, product: prod.name, category: prod.cat, region: c.region, qty, taxable_value: value, gst, total: value + gst };
      sales.push(rec);
      const lag = c.type === 'B2C' ? 0 : Math.max(0, Math.round(c.pays * (story.slowPayers && story.slowPayers[c.name] ? story.slowPayers[c.name] : 1) * (0.7 + R() * 0.6)));
      invoices.push({ customer: c.name, invoice_no: no, invoice_date: date, due_date: addDays(date, c.terms), amount: value + gst, paid: addDays(date, lag) });
      total += value;
      const st = stock.get(prod.name);
      st.last = st.last > date ? st.last : date;
    }

    // ---- Inventory and purchases (purchases back-solved from target margin) ----
    const gm = cfg.margin + story.marginShift + (R() - 0.5) * 0.01;
    const cogs = total * (1 - gm);
    const openStock = [...stock.values()].reduce((a, s) => a + s.value, 0);
    stock.forEach((s, name) => {
      const p = cfg.products.find((x) => x.name === name);
      const dead = (story.deadProducts || []).includes(name);
      s.value = Math.round(dead ? s.value * (1 + (story.deadGrowth || 0)) : p.stock * (story.stockFactor || 1) * (0.85 + R() * 0.3));
    });
    const closeStock = [...stock.values()].reduce((a, s) => a + s.value, 0);
    const purchaseTotal = cogs + closeStock - openStock;
    const purchases = [];
    let pt = 0; let b = 1;
    while (pt < purchaseTotal) {
      const sup = weighted(cfg.suppliers);
      const item = pick(sup.items);
      const rate = item.rate * (story.rateRise && story.rateRise[item.name] ? story.rateRise[item.name] : 1) * (0.98 + R() * 0.04);
      let value = Math.round(sup.ticket * (0.6 + R() * 0.8));
      if (pt + value > purchaseTotal) value = Math.max(1000, Math.round(purchaseTotal - pt));
      const qty = Math.max(1, Math.round(value / rate));
      const date = `${period}-${String(1 + Math.floor(R() * days)).padStart(2, '0')}`;
      const gst = Math.round(value * 0.18);
      const no = `${sup.code}-${period.replace('-', '')}-${b++}`;
      purchases.push({ date, bill_no: no, supplier: sup.name, item: item.name, category: item.cat, qty, taxable_value: value, gst, total: value + gst });
      bills.push({ supplier: sup.name, bill_no: no, bill_date: date, due_date: addDays(date, sup.terms), amount: value + gst, paid: addDays(date, Math.round(sup.pays * (story.payLate || 1) * (0.8 + R() * 0.4))) });
      pt += value;
    }

    // ---- Expenses ----
    const expenses = cfg.expenses.map((e) => {
      let amt = e.base * (1 + e.growth * mi) * (0.95 + R() * 0.1);
      if (story.spike && story.spike[e.head]) amt *= story.spike[e.head];
      return { head: e.head, group: e.group, amount: Math.round(amt) };
    });

    // ---- Receivables / payables open at month end ----
    const end = monthEnd(period);
    const receivables = invoices.filter((x) => x.invoice_date <= end && x.paid > end && x.amount > 0)
      .map((x) => ({ customer: x.customer, invoice_no: x.invoice_no, invoice_date: x.invoice_date, due_date: x.due_date, outstanding: x.amount }));
    const payables = bills.filter((x) => x.bill_date <= end && x.paid > end)
      .map((x) => ({ supplier: x.supplier, bill_no: x.bill_no, bill_date: x.bill_date, due_date: x.due_date, outstanding: x.amount }));

    const inventory = [...stock.entries()].map(([name, s]) => {
      const p = cfg.products.find((x) => x.name === name);
      return { item: name, category: s.cat, qty: Math.round(s.value / (p.price * 0.7)), value: s.value, last_movement: s.last };
    });

    const cash = cfg.cash(mi, R).map((c) => Object.assign({}, c, { closing: Math.round(c.closing) }));

    months[period] = {
      company: {
        company_code: cfg.code, company_name: cfg.name, period, prepared_by: cfg.accountant,
        prepared_on: addDays(end, 6), opening_stock: mi === 0 ? openStock : null,
        other_income: Math.round(cfg.otherIncome * (0.8 + R() * 0.4)), notes: story.note || null,
      },
      sales, purchases, expenses, receivables, payables, inventory, cash,
      compliance: cfg.compliance(period, mi),
    };
  });
  return months;
}

// Statutory calendar for a month's workbook (items due in the following weeks).
function calendar(overrides) {
  return (period) => {
    const [y, m] = period.split('-').map(Number);
    const next = (d) => { const dt = new Date(Date.UTC(y, m, d)); return iso(dt); };
    const prevLabel = new Date(Date.UTC(y, m - 2, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const thisMonth = (d) => iso(new Date(Date.UTC(y, m - 1, d)));
    const items = [
      { area: 'GST', item: 'GSTR-1', period_covered: prevLabel, due_date: thisMonth(11), status: 'Filed', done_on: thisMonth(10) },
      { area: 'GST', item: 'GSTR-3B', period_covered: prevLabel, due_date: thisMonth(20), status: 'Filed', done_on: thisMonth(19) },
      { area: 'TDS', item: 'TDS payment', period_covered: prevLabel, due_date: thisMonth(7), status: 'Paid', done_on: thisMonth(6) },
      { area: 'PF', item: 'PF ECR and payment', period_covered: prevLabel, due_date: thisMonth(15), status: 'Paid', done_on: thisMonth(13) },
      { area: 'ESI', item: 'ESI contribution', period_covered: prevLabel, due_date: thisMonth(15), status: 'Paid', done_on: thisMonth(14) },
      { area: 'GST', item: 'GSTR-1', period_covered: label, due_date: next(11), status: 'Pending', done_on: null },
    ];
    if ([3, 6, 9, 12].includes(m)) items.push({ area: 'Advance Tax', item: 'Advance tax instalment', period_covered: `FY ${m >= 4 ? y : y - 1}-${String((m >= 4 ? y : y - 1) + 1).slice(2)}`, due_date: thisMonth(15), status: 'Paid', done_on: thisMonth(14) });
    if ([1, 5, 7, 10].includes(m)) items.push({ area: 'TDS', item: 'TDS return (24Q/26Q)', period_covered: 'Previous quarter', due_date: monthEnd(period), status: 'Filed', done_on: thisMonth(28) });
    if ([3, 6, 9, 12].includes(m)) items.push({ area: 'Governance', item: 'Quarterly board meeting', period_covered: label, due_date: thisMonth(28), status: 'Filed', done_on: thisMonth(24), remarks: 'Minutes signed' });
    if (m === 9) {
      items.push({ area: 'ROC/MCA', item: 'DIR-3 KYC', period_covered: 'FY 2026-27', due_date: thisMonth(30), status: 'Filed', done_on: thisMonth(22) });
      items.push({ area: 'Governance', item: 'Annual general meeting', period_covered: 'FY 2025-26', due_date: thisMonth(30), status: 'Filed', done_on: thisMonth(27), remarks: 'Minutes and attendance register updated' });
      items.push({ area: 'ROC/MCA', item: 'AOC-4 (financial statements)', period_covered: 'FY 2025-26', due_date: next(29), status: 'Pending', done_on: null });
      items.push({ area: 'ROC/MCA', item: 'MSME-1 (half-yearly)', period_covered: 'Apr-Sep 2026', due_date: next(31), status: 'Pending', done_on: null });
    }
    if (m === 6) items.push({ area: 'ROC/MCA', item: 'DPT-3', period_covered: 'FY 2025-26', due_date: thisMonth(30), status: 'Filed', done_on: thisMonth(25) });
    return overrides ? overrides(period, items) : items;
  };
}

const meridian = {
  code: 'AE-0001', name: 'Meridian Polymers Pvt Ltd (Demo)', prefix: 'MPL', accountant: 'R. Menon (Accounts)',
  seed: 42, baseRevenue: 23000000, growth: 0.012, phase: 0, margin: 0.27, otherIncome: 60000,
  customers: [
    { name: 'Vardhan Auto Components', type: 'B2B', region: 'Tamil Nadu', w: 14, ticket: 900000, pays: 55, terms: 45 },
    { name: 'Kaveri Appliances', type: 'B2B', region: 'Karnataka', w: 14, ticket: 450000, pays: 40, terms: 45 },
    { name: 'Sahyadri Packaging', type: 'B2B', region: 'Maharashtra', w: 12, ticket: 300000, pays: 35, terms: 30 },
    { name: 'Nilgiri Electricals', type: 'B2B', region: 'Kerala', w: 10, ticket: 250000, pays: 30, terms: 30 },
    { name: 'Deccan Pipes & Fittings', type: 'B2B', region: 'Telangana', w: 9, ticket: 280000, pays: 50, terms: 45 },
    { name: 'Coromandel Toys', type: 'B2B', region: 'Tamil Nadu', w: 7, ticket: 150000, pays: 25, terms: 30 },
    { name: 'Malabar Housewares', type: 'B2B', region: 'Kerala', w: 7, ticket: 180000, pays: 40, terms: 30 },
    { name: 'Konkan Agro Tools', type: 'B2B', region: 'Goa', w: 5, ticket: 120000, pays: 30, terms: 30 },
    { name: 'Godavari Medical Supplies', type: 'B2B', region: 'Andhra Pradesh', w: 6, ticket: 160000, pays: 35, terms: 30 },
  ],
  products: [
    { name: 'Moulded auto trims', cat: 'Automotive', price: 85, gst: 0.18, stock: 5200000 },
    { name: 'Appliance housings', cat: 'Consumer durables', price: 140, gst: 0.18, stock: 3800000 },
    { name: 'HDPE containers', cat: 'Packaging', price: 22, gst: 0.18, stock: 2400000 },
    { name: 'Electrical enclosures', cat: 'Electrical', price: 310, gst: 0.18, stock: 1900000 },
    { name: 'Pipe fittings', cat: 'Building products', price: 48, gst: 0.18, stock: 1500000 },
    { name: 'Custom tooling jobs', cat: 'Tooling', price: 25000, gst: 0.18, stock: 900000 },
  ],
  suppliers: [
    { name: 'Reliance Polymers Distributor - South', code: 'RPD', w: 40, ticket: 1200000, pays: 40, terms: 45, items: [{ name: 'PP granules', cat: 'Resin', rate: 98 }, { name: 'HDPE granules', cat: 'Resin', rate: 105 }] },
    { name: 'Chennai Masterbatch Co', code: 'CMB', w: 15, ticket: 300000, pays: 50, terms: 30, items: [{ name: 'Colour masterbatch', cat: 'Additives', rate: 240 }] },
    { name: 'Precision Moulds Hosur', code: 'PMH', w: 10, ticket: 250000, pays: 70, terms: 30, items: [{ name: 'Mould spares', cat: 'Tooling', rate: 4200 }] },
    { name: 'Sri Lakshmi Corrugators', code: 'SLC', w: 15, ticket: 120000, pays: 75, terms: 30, items: [{ name: 'Corrugated boxes', cat: 'Packing material', rate: 38 }] },
    { name: 'Ambattur Inserts', code: 'AMI', w: 10, ticket: 180000, pays: 65, terms: 30, items: [{ name: 'Brass inserts', cat: 'Components', rate: 6.5 }] },
  ],
  expenses: [
    { head: 'Salaries and wages', group: 'Employee Cost', base: 2100000, growth: 0.006 },
    { head: 'PF and ESI contribution', group: 'Employee Cost', base: 240000, growth: 0.006 },
    { head: 'Factory rent', group: 'Occupancy', base: 450000, growth: 0 },
    { head: 'Power and fuel', group: 'Administrative', base: 980000, growth: 0.01 },
    { head: 'Repairs and maintenance', group: 'Administrative', base: 160000, growth: 0 },
    { head: 'Freight outward', group: 'Selling & Distribution', base: 380000, growth: 0.01 },
    { head: 'Sales promotion', group: 'Selling & Distribution', base: 90000, growth: 0 },
    { head: 'Professional fees', group: 'Administrative', base: 120000, growth: 0 },
    { head: 'Office and admin', group: 'Administrative', base: 140000, growth: 0.004 },
    { head: 'Interest on CC', group: 'Finance Cost', base: 210000, growth: 0.02 },
    { head: 'Depreciation', group: 'Depreciation', base: 520000, growth: 0 },
  ],
  // Storyline: resin costs rise and squeeze margin in the last quarter, the largest
  // customer slows payments, an obsolete product line piles up, CC limit tightens.
  story: (mi) => ({
    revenueFactor: mi >= 9 ? 0.96 - (mi - 9) * 0.03 : 1,
    marginShift: mi >= 10 ? -0.035 * (mi - 9) : 0,
    rateRise: mi >= 10 ? { 'PP granules': 1.14, 'HDPE granules': 1.11 } : null,
    slowPayers: mi >= 6 ? { 'Vardhan Auto Components': 1 + (mi - 5) * 0.55 } : null,
    deadProducts: mi >= 4 ? ['Appliance housings'] : [],
    deadGrowth: 0.02,
    absent: mi === 11 ? ['Konkan Agro Tools', 'Godavari Medical Supplies'] : [],
    spike: mi === 11 ? { 'Repairs and maintenance': 3.2 } : null,
    payLate: mi >= 8 ? 1.4 : 1,
    note: mi === 11 ? 'Major mould repair on press line 3 booked under repairs. Resin prices increased from August.' : null,
  }),
  cash: (mi, R) => [
    { account: 'HDFC Bank current account', type: 'Bank', closing: 4200000 - mi * 260000 + R() * 300000, limit: null },
    { account: 'SBI cash credit', type: 'CC', closing: -(19000000 + mi * 900000 + R() * 300000), limit: 32000000 },
    { account: 'Cash in hand', type: 'Cash', closing: 45000 + R() * 20000, limit: null },
  ],
  compliance: calendar((period, items) => {
    if (period === '2026-09') {
      const esi = items.find((i) => i.item === 'ESI contribution');
      esi.status = 'Pending'; esi.done_on = null; esi.remarks = 'Portal issue, to be paid';
      const pf = items.find((i) => i.item === 'PF ECR and payment');
      pf.done_on = '2026-09-18';
    }
    return items;
  }),
};

const coastline = {
  code: 'AE-0002', name: 'Coastline Foods Pvt Ltd (Demo)', prefix: 'CFP', accountant: 'S. Fathima (Finance)',
  seed: 7, baseRevenue: 12500000, growth: 0.022, phase: 2, margin: 0.22, otherIncome: 25000,
  customers: [
    { name: 'FreshMart Retail Chain', type: 'B2B', region: 'Kerala', w: 26, ticket: 320000, pays: 32, terms: 30 },
    { name: 'Spice Route Distributors', type: 'B2B', region: 'Karnataka', w: 14, ticket: 210000, pays: 28, terms: 30 },
    { name: 'Hotel Sagara Group', type: 'B2B', region: 'Kerala', w: 10, ticket: 90000, pays: 20, terms: 15 },
    { name: 'GreenBasket Online', type: 'B2B', region: 'Tamil Nadu', w: 12, ticket: 140000, pays: 25, terms: 30 },
    { name: 'Lakeview Supermarkets', type: 'B2B', region: 'Kerala', w: 9, ticket: 110000, pays: 30, terms: 30 },
    { name: 'Walk-in and online retail', type: 'B2C', region: 'Kerala', w: 22, ticket: 6000, pays: 0, terms: 0 },
    { name: 'Canteen Stores (Institutional)', type: 'B2B', region: 'Kerala', w: 7, ticket: 160000, pays: 45, terms: 45 },
  ],
  products: [
    { name: 'Ready-to-cook curries', cat: 'Ready to cook', price: 95, gst: 0.12, stock: 1300000 },
    { name: 'Spice blends', cat: 'Spices', price: 60, gst: 0.05, stock: 1700000 },
    { name: 'Frozen snacks', cat: 'Frozen', price: 140, gst: 0.12, stock: 900000 },
    { name: 'Coconut oil (1L)', cat: 'Edible oil', price: 210, gst: 0.05, stock: 1100000 },
    { name: 'Breakfast mixes', cat: 'Ready to cook', price: 70, gst: 0.18, stock: 700000 },
  ],
  suppliers: [
    { name: 'Idukki Spice Farmers Co-op', code: 'ISF', w: 30, ticket: 260000, pays: 20, terms: 30, items: [{ name: 'Whole spices', cat: 'Raw material', rate: 420 }] },
    { name: 'Kuttanad Coconut Mills', code: 'KCM', w: 25, ticket: 300000, pays: 25, terms: 30, items: [{ name: 'Coconut oil bulk', cat: 'Raw material', rate: 165 }] },
    { name: 'Malanad Packaging', code: 'MPK', w: 15, ticket: 120000, pays: 30, terms: 30, items: [{ name: 'Laminated pouches', cat: 'Packing material', rate: 3.2 }] },
    { name: 'Cold Chain Logistics Kochi', code: 'CCL', w: 10, ticket: 90000, pays: 30, terms: 30, items: [{ name: 'Frozen storage', cat: 'Services', rate: 1800 }] },
    { name: 'Vembanad Vegetables', code: 'VVG', w: 20, ticket: 150000, pays: 15, terms: 15, items: [{ name: 'Fresh vegetables', cat: 'Raw material', rate: 32 }] },
  ],
  expenses: [
    { head: 'Salaries and wages', group: 'Employee Cost', base: 1050000, growth: 0.01 },
    { head: 'PF and ESI contribution', group: 'Employee Cost', base: 120000, growth: 0.01 },
    { head: 'Warehouse rent', group: 'Occupancy', base: 260000, growth: 0 },
    { head: 'Power and cold storage', group: 'Administrative', base: 210000, growth: 0.008 },
    { head: 'Freight and delivery', group: 'Selling & Distribution', base: 340000, growth: 0.02 },
    { head: 'Marketing and listing fees', group: 'Selling & Distribution', base: 220000, growth: 0.015 },
    { head: 'Professional fees', group: 'Administrative', base: 70000, growth: 0 },
    { head: 'Office and admin', group: 'Administrative', base: 80000, growth: 0 },
    { head: 'Interest on term loan', group: 'Finance Cost', base: 65000, growth: -0.01 },
    { head: 'Depreciation', group: 'Depreciation', base: 150000, growth: 0 },
  ],
  // Storyline: steady growth, improving margin, faster collections, but heavy
  // dependence on one retail chain and month-end billing in the latest month.
  story: (mi) => ({
    revenueFactor: mi === 11 ? 1.12 : 1,
    marginShift: mi >= 9 ? 0.012 * (mi - 8) : 0,
    slowPayers: mi >= 8 ? { 'Spice Route Distributors': 0.7, 'Canteen Stores (Institutional)': 0.8 } : null,
    monthEndBias: mi === 11 ? 0.6 : 0.08,
    note: mi === 11 ? 'Onam season demand. Festival orders from FreshMart billed in the last week.' : null,
  }),
  cash: (mi, R) => [
    { account: 'Federal Bank current account', type: 'Bank', closing: 2600000 + mi * 210000 + R() * 250000, limit: null },
    { account: 'Federal Bank overdraft', type: 'OD', closing: -(3000000 - mi * 120000) * (0.8 + R() * 0.2), limit: 6000000 },
    { account: 'Fixed deposit', type: 'Deposit', closing: 2500000, limit: null },
    { account: 'Cash in hand', type: 'Cash', closing: 80000 + R() * 30000, limit: null },
  ],
  compliance: calendar(),
};

fs.rmSync(OUT, { recursive: true, force: true });
[meridian, coastline].forEach((cfg) => {
  const months = company(cfg);
  const dir = path.join(OUT, cfg.code);
  fs.mkdirSync(dir, { recursive: true });
  Object.entries(months).forEach(([period, data]) => fs.writeFileSync(path.join(dir, `${period}.json`), JSON.stringify(data)));
  console.log(`${cfg.code}: ${Object.keys(months).length} months written`);
});
