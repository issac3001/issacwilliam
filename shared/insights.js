/*
 * Assura Elevate intelligence: suggested explanations for what moved this month.
 * For each material movement (revenue, margin, expenses, profit, receivables,
 * stock, cash) it traces the change back to the transactions behind it and
 * lists the likely causes, largest first, each with its rupee effect.
 *
 * These are drafts for the Assura team. A team member picks the causes that are
 * right, edits the wording and accepts it; only accepted explanations are shown
 * to the client. Browser (window.AEInsights) and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analysis'));
  else root.AEInsights = factory(root.AEAnalysis);
})(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const { inr } = A;
  const sum = (arr, f) => arr.reduce((s, x) => s + ((f ? f(x) : x) || 0), 0);
  const pc = (x, d = 0) => `${(Math.abs(x) * 100).toFixed(d)}%`;
  const signed = (v) => `${v >= 0 ? '+' : '−'}${inr(Math.abs(v)).replace('-', '')}`;
  const list = (names, n = 3) => names.slice(0, n).join(', ') + (names.length > n ? ` and ${names.length - n} other${names.length - n > 1 ? 's' : ''}` : '');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const mLong = (p) => `${MONTHS[+p.slice(5, 7) - 1]} ${p.slice(0, 4)}`;
  function group(rows, key, val) {
    const m = new Map();
    (rows || []).forEach((r) => { const k = r[key] || '(not given)'; m.set(k, (m.get(k) || 0) + (Number(r[val]) || 0)); });
    return m;
  }
  // Change per name between two months, largest movement first.
  function deltas(now, before) {
    const names = new Set([...now.keys(), ...before.keys()]);
    return [...names].map((name) => ({ name, now: now.get(name) || 0, before: before.get(name) || 0 }))
      .map((x) => Object.assign(x, { change: x.now - x.before })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  }
  // Selling price and volume effects by product, where quantities are given.
  function priceVolume(salesNow, salesBefore, key) {
    const agg = (rows) => { const m = new Map(); (rows || []).filter((r) => Number(r.qty) > 0).forEach((r) => { const k = r[key]; const x = m.get(k) || { v: 0, q: 0 }; x.v += r.taxable_value || 0; x.q += Number(r.qty); m.set(k, x); }); return m; };
    const a = agg(salesNow); const b = agg(salesBefore);
    let price = 0; let volume = 0; const items = [];
    a.forEach((x, k) => {
      const y = b.get(k); if (!y || !y.q) return;
      const p1 = x.v / x.q; const p0 = y.v / y.q;
      const pe = (p1 - p0) * x.q; const ve = (x.q - y.q) * p0;
      price += pe; volume += ve;
      items.push({ name: k, priceCh: p1 / p0 - 1, qtyCh: x.q / y.q - 1, pe, ve });
    });
    return { price, volume, items };
  }

  /**
   * entries: [{ period, data }] for one company (any order).
   * analysis: the result of AEAnalysis.analyse(entries).
   * period: the month to explain (defaults to the latest). Needs the month before it.
   * Returns [{ key, area, period, headline, movement, causes: [{ id, text, impact }], suggested: [ids] }].
   */
  function draft(entries, analysis, period) {
    const sorted = entries.slice().sort((a, b) => a.period.localeCompare(b.period));
    const months = analysis.months;
    const i = months.findIndex((m) => m.period === (period || months[months.length - 1].period));
    if (i < 1) return [];
    const cur = months[i]; const prev = months[i - 1];
    const dn = sorted[i].data; const dp = sorted[i - 1].data;
    const lastYear = months.find((m) => m.period === `${+cur.period.slice(0, 4) - 1}${cur.period.slice(4)}`);
    const lastYearPrev = lastYear && months[months.indexOf(lastYear) - 1];
    const note = dn.company && dn.company.notes ? String(dn.company.notes) : '';
    const out = [];
    const add = (key, area, headline, movement, causes) => {
      causes = causes.filter(Boolean).map((c, n) => Object.assign({ id: `${key}-${n + 1}` }, c));
      if (!causes.length) return;
      const ranked = causes.slice().sort((a, b) => Math.abs(b.impact || 0) - Math.abs(a.impact || 0));
      out.push({ key, area, period: cur.period, headline, movement, causes: ranked, suggested: ranked.slice(0, 3).map((c) => c.id) });
    };
    const noteCause = (words) => {
      const hit = words.find((w) => new RegExp(`\\b${w}`, 'i').test(note));
      return hit ? { text: `The accountant's note for the month says: "${note.slice(0, 220)}${note.length > 220 ? '…' : ''}"`, impact: 0, source: 'note' } : null;
    };

    // ---------- Revenue ----------
    const pv = priceVolume(dn.sales, dp.sales, 'product');
    if (prev.revenue && Math.abs(cur.revenue / prev.revenue - 1) >= 0.03) {
      const ch = cur.revenue - prev.revenue; const up = ch > 0;
      const byCust = deltas(group(dn.sales, 'customer', 'taxable_value'), group(dp.sales, 'customer', 'taxable_value'));
      const lost = byCust.filter((x) => x.before > 0 && x.now === 0);
      const fresh = byCust.filter((x) => x.now > 0 && x.before === 0);
      const movers = byCust.filter((x) => x.before > 0 && x.now > 0 && (x.change > 0) === up).slice(0, 3);
      const byCat = deltas(group(dn.sales, 'category', 'taxable_value'), group(dp.sales, 'category', 'taxable_value')).filter((x) => (x.change > 0) === up && x.name !== '(not given)').slice(0, 2);
      const priceItems = pv.items.filter((x) => Math.abs(x.priceCh) >= 0.03).sort((a, b) => Math.abs(b.pe) - Math.abs(a.pe));
      add('revenue', 'Revenue', `Revenue ${up ? 'rose' : 'fell'} ${pc(ch / prev.revenue)} to ${inr(cur.revenue)}`,
        `Revenue was ${inr(cur.revenue)} in ${mLong(cur.period)} against ${inr(prev.revenue)} the month before (${signed(ch)}).`, [
          movers.length && { text: `${up ? 'Higher' : 'Lower'} billing to existing customers, mainly ${movers.map((x) => `${x.name} (${signed(x.change)})`).join(', ')}.`, impact: sum(movers, (x) => x.change) },
          lost.length && !up && { text: `${lost.length} customer${lost.length > 1 ? 's' : ''} billed last month ${lost.length > 1 ? 'were' : 'was'} not billed this month: ${list(lost.map((x) => x.name))}, together ${inr(sum(lost, (x) => x.before))} last month.`, impact: -sum(lost, (x) => x.before) },
          fresh.length && up && { text: `New customers added ${inr(sum(fresh, (x) => x.now))}: ${list(fresh.map((x) => x.name))}.`, impact: sum(fresh, (x) => x.now) },
          Math.abs(pv.price) >= Math.abs(ch) * 0.2 && priceItems.length && { text: `Selling prices ${pv.price > 0 ? 'rose' : 'fell'} on ${list(priceItems.map((x) => `${x.name} (${x.priceCh > 0 ? '+' : '−'}${pc(x.priceCh)})`), 2)}, worth about ${inr(Math.abs(pv.price))}.`, impact: pv.price },
          Math.abs(pv.volume) >= Math.abs(ch) * 0.2 && { text: `Quantities sold ${pv.volume > 0 ? 'increased' : 'dropped'}, worth about ${inr(Math.abs(pv.volume))} at last month's prices.`, impact: pv.volume },
          byCat.length && { text: `By product group, the change came mostly from ${byCat.map((x) => `${x.name} (${signed(x.change)})`).join(' and ')}.`, impact: sum(byCat, (x) => x.change) * 0.5 },
          prev.invoiceCount && Math.abs(cur.invoiceCount / prev.invoiceCount - 1) >= 0.1 && { text: `${cur.invoiceCount} invoices were raised against ${prev.invoiceCount} last month.`, impact: ch * 0.3 },
          cur.monthEndShare != null && prev.monthEndShare != null && Math.abs(cur.monthEndShare - prev.monthEndShare) >= 0.1 && { text: `${pc(cur.monthEndShare)} of sales was billed in the last five days of the month, against ${pc(prev.monthEndShare)} last month, so billing timing moved revenue between months.`, impact: ch * 0.25 },
          lastYear && lastYearPrev && lastYearPrev.revenue && ((lastYear.revenue - lastYearPrev.revenue) > 0) === up && Math.abs(lastYear.revenue / lastYearPrev.revenue - 1) >= 0.03 && { text: `The same month last year also ${up ? 'rose' : 'fell'} (${pc(lastYear.revenue / lastYearPrev.revenue - 1)}), which points to a seasonal pattern.`, impact: ch * 0.2 },
          noteCause(['sale', 'revenue', 'order', 'customer', 'dispatch', 'billing']),
        ]);
    }

    // ---------- Gross margin ----------
    if (cur.gmPct != null && prev.gmPct != null && Math.abs(cur.gmPct - prev.gmPct) >= 0.01) {
      const pts = (cur.gmPct - prev.gmPct) * 100; const up = pts > 0;
      const rate = (rows) => { const m = new Map(); (rows || []).filter((p) => Number(p.qty) > 0).forEach((p) => { const r = m.get(p.item) || { v: 0, q: 0 }; r.v += p.taxable_value || 0; r.q += Number(p.qty); m.set(p.item, r); }); return m; };
      // Rates are compared with the average of up to three earlier months, so a rise that began last month still shows.
      const rn = rate(dn.purchases); const rp = rate([].concat(...sorted.slice(Math.max(0, i - 3), i).map((e) => e.data.purchases || [])));
      const rates = []; rn.forEach((r, k) => { const b = rp.get(k); if (b && b.q) { const chg = (r.v / r.q) / (b.v / b.q) - 1; if (Math.abs(chg) >= 0.03) rates.push({ name: k, chg, effect: (r.v / r.q - b.v / b.q) * r.q }); } });
      const costMoves = rates.filter((x) => (x.effect < 0) === up).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
      const share = (rows, k) => { const g = group(rows, k, 'taxable_value'); const t = sum([...g.values()]); return new Map([...g].map(([n, v]) => [n, t ? v / t : 0])); };
      const mix = deltas(share(dn.sales, 'category'), share(dp.sales, 'category')).filter((x) => x.name !== '(not given)' && Math.abs(x.change) >= 0.05).slice(0, 2);
      const invCh = cur.inventory != null && prev.inventory != null ? cur.inventory - prev.inventory : null;
      add('margin', 'Margin', `Gross margin ${up ? 'up' : 'down'} ${Math.abs(pts).toFixed(1)} points to ${(cur.gmPct * 100).toFixed(1)}%`,
        `Gross margin was ${(cur.gmPct * 100).toFixed(1)}% against ${(prev.gmPct * 100).toFixed(1)}% last month, ${up ? 'adding' : 'taking'} about ${inr(Math.abs(pts / 100 * cur.revenue))} ${up ? 'to' : 'off'} gross profit.`, [
          costMoves.length && { text: `Purchase rates ${up ? 'eased' : 'went up'} on ${list(costMoves.map((x) => `${x.name} (${x.chg > 0 ? '+' : '−'}${pc(x.chg)})`), 3)}, worth about ${inr(Math.abs(sum(costMoves, (x) => x.effect)))}.`, impact: -sum(costMoves, (x) => x.effect) },
          Math.abs(pv.price) >= cur.revenue * 0.005 && (pv.price > 0) === up && { text: `Selling prices ${up ? 'rose' : 'fell'}, worth about ${inr(Math.abs(pv.price))}, without a matching change in purchase cost.`, impact: pv.price },
          mix.length && { text: `Sales mix shifted: ${mix.map((x) => `${x.name} ${(x.before * 100).toFixed(0)}% → ${(x.now * 100).toFixed(0)}% of sales`).join('; ')}. Product groups earn different margins.`, impact: pts / 100 * cur.revenue * 0.4 },
          invCh != null && Math.abs(invCh) >= cur.revenue * 0.05 && { text: `Closing stock ${invCh > 0 ? 'rose' : 'fell'} by ${inr(Math.abs(invCh))}. Cost of sales depends on the month-end stock value, so a valuation or count difference moves the margin directly.`, impact: pts / 100 * cur.revenue * 0.5 },
          prev.revenue && cur.revenue && Math.abs(cur.purchases / cur.revenue - prev.purchases / prev.revenue) >= 0.05 && { text: `Purchases were ${pc(cur.purchases / cur.revenue)} of sales against ${pc(prev.purchases / prev.revenue)} last month.`, impact: pts / 100 * cur.revenue * 0.3 },
          noteCause(['price', 'rate', 'margin', 'discount', 'cost', 'stock', 'resin', 'raw material']),
        ]);
    }

    // ---------- Expenses ----------
    if (prev.opex && Math.abs(cur.opex / prev.opex - 1) >= 0.05) {
      const ch = cur.opex - prev.opex; const up = ch > 0;
      const heads = deltas(group(dn.expenses, 'head', 'amount'), group(dp.expenses, 'head', 'amount'));
      const drivers = heads.filter((x) => (x.change > 0) === up && x.before > 0 && x.now > 0).slice(0, 3);
      const added = heads.filter((x) => x.before === 0 && x.now > 0);
      const gone = heads.filter((x) => x.now === 0 && x.before > 0);
      const hist = (head) => { const vals = sorted.slice(Math.max(0, i - 6), i).map((e) => sum((e.data.expenses || []).filter((x) => x.head === head), (x) => x.amount)).filter((v) => v > 0); return vals.length ? sum(vals) / vals.length : null; };
      const oneOff = drivers.filter((x) => { const h = hist(x.name); return h && x.now > h * 1.4; });
      add('expenses', 'Expenses', `Expenses ${up ? 'rose' : 'fell'} ${pc(ch / prev.opex)} to ${inr(cur.opex)}`,
        `Operating expenses were ${inr(cur.opex)} against ${inr(prev.opex)} last month (${signed(ch)}).`, [
          drivers.length && { text: `${drivers.map((x) => `${x.name} ${inr(x.now)} against ${inr(x.before)}`).join('; ')}.`, impact: sum(drivers, (x) => x.change) },
          oneOff.length && { text: `${list(oneOff.map((x) => x.name))} ${oneOff.length > 1 ? 'are' : 'is'} well above the usual monthly level, which suggests a one-off cost rather than a new run-rate.`, impact: sum(oneOff, (x) => x.change) * 0.8 },
          added.length && { text: `New expense heads this month: ${list(added.map((x) => `${x.name} (${inr(x.now)})`))}.`, impact: sum(added, (x) => x.now) },
          gone.length && { text: `No cost was booked this month under ${list(gone.map((x) => x.name))}, which had ${inr(sum(gone, (x) => x.before))} last month. Check whether a provision or bill is still to be booked.`, impact: -sum(gone, (x) => x.before) },
          noteCause(['repair', 'expense', 'salary', 'bonus', 'provision', 'one-off', 'rent', 'freight', 'legal']),
        ]);
    }

    // ---------- Net profit ----------
    if (cur.netProfit != null && prev.netProfit != null && prev.grossProfit != null) {
      const ch = cur.netProfit - prev.netProfit;
      if (Math.abs(ch) >= Math.max(Math.abs(prev.netProfit) * 0.1, cur.revenue * 0.01)) {
        const volume = (cur.revenue - prev.revenue) * (prev.gmPct || 0);
        const margin = ((cur.gmPct || 0) - (prev.gmPct || 0)) * cur.revenue;
        const opex = -(cur.opex - prev.opex);
        const other = (cur.otherIncome || 0) - (prev.otherIncome || 0);
        const res = (v) => (v < 0 ? `a loss of ${inr(-v)}` : `a profit of ${inr(v)}`);
        const headline = cur.netProfit < 0
          ? (prev.netProfit < 0 ? `Net loss ${ch < 0 ? 'widened' : 'narrowed'} to ${inr(-cur.netProfit)}` : `Moved from profit to a net loss of ${inr(-cur.netProfit)}`)
          : (prev.netProfit < 0 ? `Back to a net profit of ${inr(cur.netProfit)}` : `Net profit ${ch > 0 ? 'up' : 'down'} ${inr(Math.abs(ch))} to ${inr(cur.netProfit)}`);
        add('profit', 'Profit', headline,
          `The month closed with ${res(cur.netProfit)} (estimated) against ${res(prev.netProfit)} last month, a swing of ${signed(ch)}.`, [
            Math.abs(volume) >= Math.abs(ch) * 0.1 && { text: `${volume > 0 ? 'Higher' : 'Lower'} sales at last month's margin: ${signed(volume)}.`, impact: volume },
            Math.abs(margin) >= Math.abs(ch) * 0.1 && { text: `${margin > 0 ? 'Better' : 'Weaker'} gross margin: ${signed(margin)}.`, impact: margin },
            Math.abs(opex) >= Math.abs(ch) * 0.1 && { text: `${opex > 0 ? 'Lower' : 'Higher'} operating expenses: ${signed(opex)}.`, impact: opex },
            Math.abs(other) >= Math.abs(ch) * 0.1 && { text: `${other > 0 ? 'More' : 'Less'} other income (interest, rent and similar): ${signed(other)}.`, impact: other },
          ]);
      }
    }

    // ---------- Receivables ----------
    if (prev.receivables && Math.abs(cur.receivables / prev.receivables - 1) >= 0.05) {
      const ch = cur.receivables - prev.receivables; const up = ch > 0;
      const parties = deltas(group(dn.receivables, 'customer', 'outstanding'), group(dp.receivables, 'customer', 'outstanding')).filter((x) => (x.change > 0) === up).slice(0, 3);
      const ra = analysis.latest && analysis.latest.period === cur.period ? analysis.latest.recvAgeing : null;
      const old = ra ? ra['90+'] || 0 : null;
      add('receivables', 'Receivables', `Receivables ${up ? 'up' : 'down'} ${inr(Math.abs(ch))} to ${inr(cur.receivables)}`,
        `Amounts due from customers were ${inr(cur.receivables)} at month end against ${inr(prev.receivables)} (${signed(ch)}).`, [
          parties.length && { text: `${up ? 'Higher' : 'Lower'} dues from ${parties.map((x) => `${x.name} (${signed(x.change)})`).join(', ')}.`, impact: sum(parties, (x) => x.change) },
          Math.abs(cur.revenue - prev.revenue) >= Math.abs(ch) * 0.3 && ((cur.revenue - prev.revenue) > 0) === up && { text: `Sales were ${up ? 'higher' : 'lower'} this month (${signed(cur.revenue - prev.revenue)}), which moves receivables in the same direction.`, impact: (cur.revenue - prev.revenue) * 0.5 },
          cur.dso != null && prev.dso != null && Math.abs(cur.dso - prev.dso) >= 3 && { text: `Customers are taking ${cur.dso} days to pay against ${prev.dso} days last month${cur.dso > prev.dso ? ', so collections slowed' : ', so collections improved'}.`, impact: ch * 0.6 },
          old && cur.receivables && old / cur.receivables > 0.1 && up && { text: `${inr(old)} (${pc(old / cur.receivables)}) is more than 90 days old and is not being collected.`, impact: old * 0.3 },
        ]);
    }

    // ---------- Inventory ----------
    if (cur.inventory != null && prev.inventory && Math.abs(cur.inventory / prev.inventory - 1) >= 0.08) {
      const ch = cur.inventory - prev.inventory; const up = ch > 0;
      const items = deltas(group(dn.inventory, 'item', 'value'), group(dp.inventory, 'item', 'value')).filter((x) => (x.change > 0) === up).slice(0, 3);
      add('inventory', 'Inventory', `Stock ${up ? 'up' : 'down'} ${inr(Math.abs(ch))} to ${inr(cur.inventory)}`,
        `Closing stock was ${inr(cur.inventory)} against ${inr(prev.inventory)} last month (${signed(ch)}).`, [
          cur.cogs != null && { text: `Purchases of ${inr(cur.purchases)} were ${cur.purchases > cur.cogs ? 'more' : 'less'} than the ${inr(cur.cogs)} of stock consumed in sales.`, impact: cur.purchases - (cur.cogs || 0) },
          items.length && { text: `Largest movements: ${items.map((x) => `${x.name} (${signed(x.change)})`).join(', ')}.`, impact: sum(items, (x) => x.change) },
          up && cur.revenue < prev.revenue && { text: 'Stock rose while sales fell, so buying is running ahead of demand.', impact: ch * 0.4 },
          noteCause(['stock', 'inventory', 'purchase', 'advance buying']),
        ]);
    }

    // ---------- Cash ----------
    if (Math.abs(cur.netCash - prev.netCash) >= Math.max(cur.revenue * 0.03, Math.abs(prev.netCash) * 0.1)) {
      const ch = cur.netCash - prev.netCash;
      const dRecv = cur.receivables - prev.receivables;
      const dInv = cur.inventory != null && prev.inventory != null ? cur.inventory - prev.inventory : 0;
      const dPay = cur.payables - prev.payables;
      const np = cur.netProfit || 0;
      const rest = ch - (np - dRecv - dInv + dPay);
      const big = (v) => Math.abs(v) >= Math.abs(ch) * 0.1;
      add('cash', 'Cash', `Net cash ${ch > 0 ? 'up' : 'down'} ${inr(Math.abs(ch))} to ${inr(cur.netCash)}`,
        `Cash and bank less borrowings drawn was ${inr(cur.netCash)} against ${inr(prev.netCash)} last month (${signed(ch)}).`, [
          cur.netProfit != null && big(np) && { text: np > 0 ? `Profit for the month added about ${inr(np)}.` : `The loss for the month took out about ${inr(-np)}.`, impact: np },
          big(dRecv) && { text: dRecv > 0 ? `Customers owe ${inr(dRecv)} more than last month, so that much of the month's sales has not come in as cash yet.` : `Collections ran ahead of billing, bringing in ${inr(-dRecv)} of older dues.`, impact: -dRecv },
          big(dInv) && { text: dInv > 0 ? `${inr(dInv)} more is held in stock.` : `Stock came down by ${inr(-dInv)}, releasing cash.`, impact: -dInv },
          big(dPay) && { text: dPay > 0 ? `${inr(dPay)} more credit was taken from suppliers.` : `Suppliers were paid down by ${inr(-dPay)}.`, impact: dPay },
          Math.abs(rest) >= Math.abs(ch) * 0.15 && { text: `Movements outside the monthly data (capital spend, loan repayments, tax and GST, owners' drawings or new funding) account for about ${signed(rest)}.`, impact: rest },
        ]);
    }

    return out;
  }

  return { draft };
});
