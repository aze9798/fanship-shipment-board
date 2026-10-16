/* ============================================================
   全局搜索：一个框搜料号，把相关的都列出来
   文件：public/global-search.js      建立日期：2026-10-16
   搜什么：未交 / 发货记录 / 外协单 / 采购单 / 质量不良 / 图纸 / 单价
   数据：前 5 类用主页已经拿到的（window.__tkData）；图纸和单价体量大（72KB / 234KB）
         在第一次聚焦搜索框时才懒加载。
   入口：侧栏一个搜索框，或 Ctrl+K
   回滚：删掉 index.html 里这一行 <script>
   ============================================================ */
(() => {
  'use strict';

  const S = { q: '', q2: '', idx: 0, items: [], extra: null, loadingExtra: false };

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const md = (iso) => { const p = String(iso || '').slice(5, 10).split('-'); return p.length === 2 ? `${+p[0]}月${+p[1]}日` : '—'; };

  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }
  async function rpc(name, payload = {}) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return null;
    try {
      const h = { 'Content-Type': 'application/json' };
      if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
      const r = await fetch(base + '/' + name, { method: 'POST', headers: h, body: JSON.stringify({ p_code: readCode(), ...payload }) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  /* ---- 懒加载图纸 + 单价 ---- */
  async function loadExtra() {
    if (S.extra || S.loadingExtra) return;
    S.loadingExtra = true;
    const [dw, am] = await Promise.all([rpc('board_get_drawings'), rpc('board_get_amounts')]);
    S.extra = {
      drawings: Array.isArray(dw) ? dw : [],
      amounts: Array.isArray(am) ? am : []
    };
    S.loadingExtra = false;
    if (S.q.length >= 2) run();
  }

  /* ---- 搜索 ---- */
  function match(text, q) { return String(text || '').toLowerCase().includes(q); }

  function run() {
    const q = S.q.trim().toLowerCase();
    const panel = $('#tkGsPanel');
    if (!panel) return;
    if (q.length < 2) {
      panel.hidden = false;
      panel.innerHTML = '<div class="tk-gs-hint">输入 <b>料号 / 采购单号 / 品名 / 图号</b>，至少 2 个字符。<br>' +
        (S.extra ? '' : '（图纸和单价会在你输入时自动加载）') + '</div>';
      return;
    }
    const d = window.__tkData || {};
    const out = [];

    const orders = (d.orders || []).filter((o) => match(o.material, q) || match(o.name, q) || match(o.po, q) || match(o.spec, q));
    if (orders.length) out.push({ title: '未交', act: 'orders', rows: orders.slice(0, 8).map((o) => ({
      k: o.material, t: o.name || '', s: (o.po || '无采购单号') + ' · 项次 ' + (o.seq || ''), v: num(o.remaining) + ' 件', hot: true,
      jump: { view: 'overview', q: o.material }
    })), more: orders.length - 8 });

    /* 发货记录：同一个料号「同一天」的发货合并成一条，只给合计数（阿泽 2026-10-16） */
    const shipByDay = new Map();
    for (const sh of (d.shipments || [])) {
      const day = String(sh.createdAt || '').slice(0, 10);
      for (const it of (sh.items || [])) {
        if (!(match(it.material, q) || match(it.name, q))) continue;
        const key = it.material + '@' + day;
        if (!shipByDay.has(key)) shipByDay.set(key, { material: it.material, name: it.name || '', day, qty: 0, n: 0, orders: new Set() });
        const g = shipByDay.get(key);
        g.qty += Number(it.quantity || 0);
        g.n += 1;
        g.orders.add(String(sh.id));
      }
    }
    const shipDays = [...shipByDay.values()].sort((a, b) => String(b.day).localeCompare(String(a.day)));
    if (shipDays.length) out.push({ title: '发货记录', act: 'ship', rows: shipDays.slice(0, 8).map((g) => {
      const tail = g.n > 1 ? (' · 合并 ' + g.n + ' 笔' + (g.orders.size > 1 ? ' / ' + g.orders.size + ' 张单' : '')) : '';
      return { k: g.material, t: g.name, s: md(g.day) + tail, v: num(g.qty) + ' 件', jump: { view: 'shipments', q: g.material } };
    }), more: shipDays.length - 8 });

    const osRows = (d.osList || []).filter((r) => match(r.material, q) || match(r.name, q) || match(r.vendor, q));
    if (osRows.length) out.push({ title: '外协', act: 'os', rows: osRows.slice(0, 6).map((r) => ({
      k: r.material, t: r.name || '', s: r.vendor + ' · 交期 ' + md(r.dueDate), v: '欠 ' + num(r.openQty),
      hot: Number(r.overdueDays) > 0, jump: { view: 'outsource' }
    })), more: osRows.length - 6 });

    const puRows = (d.puList || []).filter((r) => match(r.material, q) || match(r.name, q) || match(r.supplier, q));
    if (puRows.length) out.push({ title: '采购', act: 'pu', rows: puRows.slice(0, 6).map((r) => ({
      k: r.material, t: r.name || '', s: r.supplier + ' · 到货 ' + md(r.dueDate), v: '欠 ' + num(r.openQty),
      hot: Number(r.overdueDays) > 0, jump: { view: 'purchase' }
    })), more: puRows.length - 6 });

    const qlRows = (d.qlList || []).filter((r) => match(r.material, q) || match(r.name, q) || match(r.process, q) || match(r.defect, q));
    if (qlRows.length) out.push({ title: '质量 / 不良', act: 'ql', rows: qlRows.slice(0, 6).map((r) => ({
      k: r.material, t: r.name || '', s: md(r.foundAt) + ' · ' + (r.process || '未填工序') + ' · ' + (r.defect || '未填现象'), v: num(r.qty) + ' 件',
      hot: r.status === 'open', jump: { view: 'quality' }
    })), more: qlRows.length - 6 });

    if (S.extra) {
      const dwRows = S.extra.drawings.filter((r) => match(r.material, q) || match(r.name, q) || match(r.spec, q) || match(r.fileName, q));
      if (dwRows.length) out.push({ title: '图纸', act: 'dw', rows: dwRows.slice(0, 6).map((r) => ({
        k: r.material, t: r.name || '', s: r.spec || r.fileName || '', v: '看图纸', jump: { view: 'drawings', q: r.material }
      })), more: dwRows.length - 6 });
      const amRows = S.extra.amounts.filter((r) => match(r.material, q) || match(r.name, q) || match(r.po, q));
      if (amRows.length) out.push({ title: '单价 / 金额', act: 'am', rows: amRows.slice(0, 6).map((r) => ({
        k: r.material, t: r.name || '', s: (r.po || '—') + ' · 数量 ' + num(r.orderQty), v: '¥' + num(r.unitPrice), jump: { view: 'prices', q: r.material }
      })), more: amRows.length - 6 });
    }

    if (!out.length) {
      panel.innerHTML = '<div class="tk-gs-hint">没有匹配的：<b>' + esc(S.q) + '</b></div>';
      return;
    }
    let idx = 0;
    S.items = out;
    panel.innerHTML = out.map((g) => '<div class="tk-gs-grp"><b>' + esc(g.title) + ' · ' + (g.rows.length + Math.max(0, g.more)) + '</b>' +
      g.rows.map((r) => {
        const i = idx++;
        r._i = i;
        return '<button type="button" class="tk-gs-item" data-gi="' + i + '">' +
          '<em>' + esc(r.k) + '</em><span>' + esc(r.t) + '<small>' + esc(r.s) + '</small></span>' +
          '<b class="' + (r.hot ? 'hot' : '') + '">' + esc(r.v) + '</b></button>';
      }).join('') +
      (g.more > 0 ? '<div class="tk-gs-more">还有 ' + g.more + ' 条，点上面任一条去完整页面看</div>' : '') + '</div>').join('');
    S.flat = out.reduce((a, g) => a.concat(g.rows), []);
    panel.hidden = false;
    position();
  }

  function position() {
    const box = $('.tk-gs input');
    const panel = $('#tkGsPanel');
    if (!box || !panel) return;
    const r = box.getBoundingClientRect();
    panel.style.left = Math.round(r.left) + 'px';
    panel.style.top = Math.round(r.bottom + 6) + 'px';
  }

  function goto(jump) {
    if (!jump) return;
    close();
    if (jump.view) {
      const link = document.querySelector('.side-link[data-desktop-view="' + jump.view + '"]');
      if (link) link.click();
      else if (window.tkOpenMerge) window.tkOpenMerge();
    }
    if (jump.q) {
      setTimeout(() => {
        if (jump.view === 'overview' && window.tkOpenMerge) window.tkOpenMerge();
        const map = {
          overview: '#desktopSearch',
          remaining: '#desktopRemainingSearch',
          shipments: '#historySearch',
          drawings: '#drawingSearch',
          prices: '#priceSearch',
          outsource: null, purchase: null, quality: null
        };
        const sel = map[jump.view];
        const el = sel ? document.querySelector(sel) : null;
        if (el) { el.value = jump.q; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }, 220);
    }
  }

  function close() { const p = $('#tkGsPanel'); if (p) p.hidden = true; }

  function build() {
    if ($('.tk-gs')) return;
    const nav = document.getElementById('tkNav');
    if (!nav) return;
    const box = document.createElement('div');
    box.className = 'tk-gs';
    box.innerHTML = '<input id="tkGsInput" type="search" placeholder="搜料号 / 单号 / 品名（Ctrl+K）" autocomplete="off">' +
      '<div class="tk-gs-panel" id="tkGsPanel" hidden></div>';
    nav.insertAdjacentElement('beforebegin', box);

    const input = box.querySelector('#tkGsInput');
    input.addEventListener('focus', () => { loadExtra(); run(); });
    input.addEventListener('input', () => { S.q = input.value; run(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); input.blur(); }
      if (e.key === 'Enter') { const first = S.flat && S.flat[0]; if (first) goto(first.jump); }
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('.tk-gs')) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault(); input.focus(); input.select(); loadExtra();
      }
      if (e.key === 'Escape') close();
    });
    window.addEventListener('resize', () => { const p = $('#tkGsPanel'); if (p && !p.hidden) position(); });
    // 点结果
    const panel = box.querySelector('#tkGsPanel');
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gi]');
      if (!b) return;
      const r = S.flat && S.flat[Number(b.dataset.gi)];
      if (r) goto(r.jump);
    });
  }

  function init() {
    const isMobile = /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile';
    if (isMobile) return;
    // 侧栏是 home-merge.js 建的，等它一下
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (document.getElementById('tkNav') || tries > 40) { clearInterval(t); build(); }
    }, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
