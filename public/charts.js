/* Assura Elevate: small dependency-free SVG chart helpers. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
    if (parent) parent.appendChild(n);
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let tip;
  function showTip(evt, html) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; document.body.appendChild(tip); }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const x = evt.clientX + 14; const y = evt.clientY - 10;
    const w = tip.offsetWidth;
    tip.style.left = (x + w > window.innerWidth - 8 ? evt.clientX - w - 14 : x) + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(raw));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  // Round axis bounds out to a tidy step so gridlines land on readable values.
  function niceScale(lo, hi, ticks) {
    if (lo === hi) { hi = lo + (Math.abs(lo) || 1); }
    const step = niceStep((hi - lo) / (ticks || 4));
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  }
  function widthOf(container) { return Math.max(300, Math.round(container.clientWidth || 640)); }
  // Thin x labels so they never collide (roughly 46px per label).
  function labelEvery(n, plotW) { return Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 46)))); }

  function sparkline(values, opts) {
    opts = opts || {};
    const w = 140; const h = 30;
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const vals = values.filter((v) => v != null);
    if (vals.length < 2) return svg;
    const min = Math.min(...vals); const max = Math.max(...vals);
    const y = (v) => h - 3 - ((v - min) / (max - min || 1)) * (h - 6);
    const x = (i) => (i / (values.length - 1)) * (w - 4) + 2;
    const d = values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' L');
    el('path', { d: 'M' + d, fill: 'none', stroke: opts.color || 'var(--series-1)', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const li = values.length - 1;
    if (values[li] != null) el('circle', { cx: x(li), cy: y(values[li]), r: 2.5, fill: opts.color || 'var(--series-1)' }, svg);
    return svg;
  }

  // Grouped vertical bars. series: [{ name, values, color }]
  function columns(container, cfg) {
    const W = widthOf(container); const H = cfg.height || 240; const pad = { l: 56, r: 8, t: 10, b: 26 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cfg.title || 'chart' });
    const all = [].concat(...cfg.series.map((s) => s.values)).filter((v) => v != null);
    const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all), 4);
    const lo = sc.lo; const maxV = sc.hi;
    const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
    const y = (v) => pad.t + ih - ((v - lo) / (maxV - lo)) * ih;
    for (let v = lo; v <= maxV + sc.step / 2; v += sc.step) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid-line' }, svg);
      el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg).textContent = cfg.axisFormat ? cfg.axisFormat(v) : v;
    }
    const n = cfg.labels.length; const groupW = iw / n; const k = cfg.series.length;
    const barW = Math.min(26, (groupW * 0.72) / k);
    cfg.labels.forEach((lab, i) => {
      const gx = pad.l + groupW * i + (groupW - barW * k - 2 * (k - 1)) / 2;
      if (i % labelEvery(n, iw) === 0) el('text', { x: pad.l + groupW * i + groupW / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis-text' }, svg).textContent = lab;
      cfg.series.forEach((s, si) => {
        const v = s.values[i]; if (v == null) return;
        const x = gx + si * (barW + 2);
        const y0 = y(0); const y1 = y(v);
        const top = Math.min(y0, y1); const hgt = Math.max(1, Math.abs(y1 - y0));
        const r = Math.min(4, barW / 2, hgt);
        // Rounded data end, square baseline end.
        const d = v >= 0
          ? `M${x},${y0} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${y0} Z`
          : `M${x},${y0} V${top + hgt - r} Q${x},${top + hgt} ${x + r},${top + hgt} H${x + barW - r} Q${x + barW},${top + hgt} ${x + barW},${top + hgt - r} V${y0} Z`;
        el('path', { d, fill: s.color }, svg);
      });
      const hit = el('rect', { x: pad.l + groupW * i, y: pad.t, width: groupW, height: ih, fill: 'transparent' }, svg);
      hit.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(cfg.fullLabels ? cfg.fullLabels[i] : lab)}</b><br>` +
        cfg.series.map((s) => `${esc(s.name)}: ${s.values[i] == null ? '–' : esc(cfg.format(s.values[i]))}`).join('<br>')));
      hit.addEventListener('mouseleave', hideTip);
    });
    container.appendChild(svg);
  }

  // Multi-series line with crosshair tooltip.
  function lines(container, cfg) {
    const W = widthOf(container); const H = cfg.height || 220; const pad = { l: 56, r: 12, t: 10, b: 26 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cfg.title || 'chart' });
    const all = [].concat(...cfg.series.map((s) => s.values)).filter((v) => v != null);
    const sc = niceScale(cfg.zero ? Math.min(0, ...all) : Math.min(...all), Math.max(...all), 4);
    const lo = sc.lo; const hi = sc.hi;
    const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
    const n = cfg.labels.length;
    const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
    for (let v = lo; v <= hi + sc.step / 2; v += sc.step) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid-line' }, svg);
      el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg).textContent = cfg.axisFormat ? cfg.axisFormat(v) : v.toFixed(0);
    }
    cfg.labels.forEach((lab, i) => { if (i % labelEvery(n, iw) === 0) el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'axis-text' }, svg).textContent = lab; });
    cfg.series.forEach((s) => {
      const pts = s.values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
      if (pts.length) el('path', { d: 'M' + pts.join(' L'), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-dasharray': s.dashed ? '5 4' : '' }, svg);
      const li = s.values.length - 1;
      if (s.values[li] != null) el('circle', { cx: x(li), cy: y(s.values[li]), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    });
    const cross = el('line', { y1: pad.t, y2: pad.t + ih, stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' }, svg);
    const hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / iw) * (n - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      showTip(e, `<b>${esc(cfg.fullLabels ? cfg.fullLabels[i] : cfg.labels[i])}</b><br>` + cfg.series.map((s) => `${esc(s.name)}: ${s.values[i] == null ? '–' : esc(cfg.format(s.values[i]))}`).join('<br>'));
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    container.appendChild(svg);
  }

  // Horizontal bars as HTML (readable names at any width). items: [{ name, value, note }]
  function hbars(container, items, format, opts) {
    opts = opts || {};
    const max = Math.max(...items.map((i) => i.value), 1);
    const wrap = document.createElement('div'); wrap.className = 'hbar';
    items.forEach((it) => {
      const row = document.createElement('div'); row.className = 'hbar-row';
      row.innerHTML = `<span class="name" title="${esc(it.name)}">${esc(it.name)}</span>
        <div class="hbar-track"><div class="hbar-fill" style="width:${(it.value / max) * 100}%;${it.color ? 'background:' + it.color : ''}"></div></div>
        <span class="num small">${esc(format(it.value))}${it.note ? ` <span class="muted">${esc(it.note)}</span>` : ''}</span>`;
      row.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(it.name)}</b><br>${esc(format(it.value))}${it.note ? ' · ' + esc(it.note) : ''}`));
      row.addEventListener('mouseleave', hideTip);
      wrap.appendChild(row);
    });
    if (opts.title) wrap.setAttribute('aria-label', opts.title);
    container.appendChild(wrap);
  }

  // Single stacked bar with a value legend underneath. parts: [{ label, value, color }]
  function stack(container, parts, format) {
    const total = parts.reduce((a, p) => a + p.value, 0) || 1;
    const bar = document.createElement('div'); bar.className = 'stack';
    parts.forEach((p) => {
      if (!p.value) return;
      const s = document.createElement('span');
      s.style.width = (p.value / total) * 100 + '%'; s.style.background = p.color;
      s.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(p.label)}</b><br>${esc(format(p.value))} · ${((p.value / total) * 100).toFixed(0)}%`));
      s.addEventListener('mouseleave', hideTip);
      bar.appendChild(s);
    });
    const leg = document.createElement('div'); leg.className = 'stack-legend';
    leg.innerHTML = parts.map((p) => `<div><i style="background:${p.color}"></i>${esc(p.label)}<b>${esc(format(p.value))}</b><span class="muted">${((p.value / total) * 100).toFixed(0)}%</span></div>`).join('');
    container.appendChild(bar); container.appendChild(leg);
  }

  root.AECharts = { sparkline, columns, lines, hbars, stack, hideTip };
})(window);
