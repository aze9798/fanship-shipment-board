/* ============================================================
   库存模块（第一梯队第 2 步）
   文件：public/inventory.js        建立日期：2026-10-16
   依赖：cloud/outsource-schema.sql（建了 inventory_items / inventory_moves）
         + cloud/inventory-schema.sql（提供下面三个接口）
   设计：不动 app.js，自管侧栏入口与视图切换；列表样式复用 outsource.css 的 os-* 类。
   数据：board_inventory_overview / board_inventory_list
         board_inventory_adjust / board_inventory_moves
   回滚：删掉 index.html 里这一行 <script>
   ============================================================ */
(() => {
  'use strict';

  const VIEW = 'inventory';
  const KIND = { finished: '完工品', outsource: '外协件', raw: '原材料', wip: '在制' };
  const REASON = { adjust: '盘点调整', stocktake: '盘点', manual_in: '手工入库', manual_out: '手工出库',
                   production_in: '完工入库', production_out: '生产领用', shipping_out: '发货出库' };
  const S = { tab: 'all', list: [], ov: null, loaded: false, err: '', busy: false, q: '' };

  const $ = (s) => document.querySelector(s);
  const num = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ts = (v) => { const s = String(v || ''); return s ? s.slice(5, 16).replace('T', ' ') : '—'; };

  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }
  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
    return h;
  }
  async function rpc(name, payload = {}) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return { ok: false, error: '本地模式没有云端接口' };
    try {
      const r = await fetch(base + '/' + name, {
        method: 'POST', headers: headers(), body: JSON.stringify({ p_code: readCode(), ...payload })
      });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
        return { ok: false, error: msg, missingTable: /does not exist|could not find|42883|PGRST202/i.test(msg) };
      }
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  /* ---------- 视图切换 ---------- */
  function showMine() {
    document.querySelectorAll('.desktop-view').forEach((v) => { v.hidden = v.id !== 'desktopInventoryView'; });
    document.querySelectorAll('[data-desktop-view]').forEach((l) =>
      l.classList.toggle('active', l.dataset.desktopView === VIEW));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!S.loaded) load(true);
  }
  function hideMine() { const v = document.getElementById('desktopInventoryView'); if (v) v.hidden = true; }

  /* ---------- 取数 ---------- */
  let loadSeq = 0;
  async function load(force) {
    const seq = ++loadSeq;
    renderBanner('正在读取库存…');
    const [ov, list] = await Promise.all([
      rpc('board_inventory_overview'),
      rpc('board_inventory_list', { p_kind: S.tab === 'all' ? 'all' : S.tab })
    ]);
    if (seq !== loadSeq) return;
    if (!ov.ok || !list.ok) {
      const e = ov.ok ? list : ov;
      S.err = e.missingTable
        ? '库存接口还没建。请先在 Supabase → SQL Editor 里执行 cloud\\inventory-schema.sql，然后点「刷新」。'
        : (String(e.error).includes('本地模式') ? '本地演示模式读不到云端接口。库存模块要在云端管理端使用。'
          : ('读取失败：' + e.error));
      S.list = []; S.ov = null; S.loaded = false;
    } else {
      S.err = ''; S.loaded = true; S.ov = ov.data; S.list = Array.isArray(list.data) ? list.data : [];
    }
    render();
  }

  /* ---------- 渲染 ---------- */
  function renderBanner(text, warn) {
    const b = $('#ivBanner'); if (!b) return;
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.className = 'os-banner' + (warn ? ' warn' : ''); b.innerHTML = text;
  }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    if (!q) return S.list;
    return S.list.filter((r) => [r.material, r.name, r.spec].join(' ').toLowerCase().includes(q));
  }

  function row(r) {
    const q = Number(r.qty || 0);
    return `<tr data-mat="${esc(r.material)}" data-spec="${esc(r.spec || '')}" data-kind="${esc(r.kind)}" data-item="${esc(r.id)}">
      <td><span class="iv-kind ${esc(r.kind)}">${KIND[r.kind] || esc(r.kind)}</span></td>
      <td class="mono">${esc(r.material)}<span class="sub">${esc(r.spec || '—')}</span></td>
      <td class="wide">${esc(r.name || '—')}</td>
      <td class="num"><span class="iv-qty${q < 0 ? ' neg' : (q === 0 ? ' zero' : '')}">${num(q)}</span></td>
      <td>${esc(ts(r.updatedAt))}</td>
      <td><div class="acts">
        <button class="ops pri" data-act="adjust">调整</button>
        <button class="ops" data-act="moves">流水</button>
      </div></td>
    </tr>`;
  }

  function render() {
    if (!$('#ivKpis')) return;
    const ov = S.ov || {}; const k = ov.kinds || {}; const q = ov.qty || {};
    $('#ivKpis').innerHTML = `
      <div class="os-kpi"><span>完工品在库</span><b>${num(q.finished)}</b><i>件 · ${num(k.finished)} 个料号</i></div>
      <div class="os-kpi"><span>外协件在库</span><b>${num(q.outsource)}</b><i>件 · ${num(k.outsource)} 个料号</i></div>
      <div class="os-kpi"><span>原材料在库</span><b>${num(q.raw)}</b><i>件 · ${num(k.raw)} 个料号</i></div>
      <div class="os-kpi${Number(ov.negative) ? ' hot' : ''}"><span>库存为负</span><b>${num(ov.negative)}</b><i>个料号（要查一下）</i></div>`;

    const tabs = [['all', '全部'], ['finished', '完工品'], ['outsource', '外协件'], ['raw', '原材料'], ['wip', '在制']];
    $('#ivTabs').innerHTML = tabs.map(([kk, label]) =>
      `<button data-tab="${kk}" class="${S.tab === kk ? 'on' : ''}">${label}</button>`).join('');

    if (S.err) {
      renderBanner(esc(S.err), true);
      $('#ivBody').innerHTML = '';
      $('#ivEmpty').hidden = false;
      $('#ivEmpty').innerHTML = `<b>还没有数据</b>${esc(S.err)}`;
      return;
    }
    renderBanner('');
    const rows = filtered();
    $('#ivEmpty').hidden = rows.length > 0;
    $('#ivEmpty').innerHTML = '<b>没有库存记录</b>外协到货确认入库后，这里会自动出现外协件；其它类型的库存用「调整」手工录入。';
    $('#ivBody').innerHTML = rows.map(row).join('');
  }

  /* ---------- 弹窗 ---------- */
  function openModal(html) {
    closeModal();
    const mask = document.createElement('div'); mask.className = 'os-mask'; mask.id = 'ivMask';
    const modal = document.createElement('div'); modal.className = 'os-modal'; modal.id = 'ivModal';
    modal.innerHTML = `<div class="os-card">${html}</div>`;
    document.body.appendChild(mask); document.body.appendChild(modal);
    mask.addEventListener('click', closeModal);
    document.addEventListener('keydown', escClose);
    return modal;
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    document.getElementById('ivMask')?.remove();
    document.getElementById('ivModal')?.remove();
    document.removeEventListener('keydown', escClose);
  }
  function formErr(modal, msg) {
    let el = modal.querySelector('.os-err');
    if (!el) { el = document.createElement('div'); el.className = 'os-err'; modal.querySelector('.os-card').appendChild(el); }
    el.textContent = msg;
  }
  function toast(msg) { if (window.showToast) window.showToast(msg); else console.log(msg); }

  function dlgAdjust(r) {
    const isNew = !r;
    const opts = Object.entries(KIND).map(([kk, v]) => `<option value="${kk}">${v}</option>`).join('');
    const rOpts = Object.entries(REASON).map(([kk, v]) => `<option value="${kk}">${v}</option>`).join('');
    openModal(`
      <h3>${isNew ? '手工录入库存' : '调整库存'}</h3>
      <div class="os-sub">${isNew ? '原材料、完工品、在制这些系统还没自动算的，先手工录。' : `${esc(r.material)} ${esc(r.name || '')}`}</div>
      <div class="os-form">
        ${isNew ? `
        <label><span>库存类型 *</span><select id="ivK">${opts}</select></label>
        <label><span>料号 *</span><input id="ivM" placeholder="如 410151020"></label>
        <label><span>图号 / 规格</span><input id="ivS"></label>
        <label><span>品名</span><input id="ivN"></label>` : `
        <label><span>当前库存</span><input value="${num(r.qty)}" disabled></label>
        <label><span>类型</span><input value="${KIND[r.kind] || r.kind}" disabled></label>`}
        <label><span>调整数量 *（正数=入库，负数=出库）</span><input id="ivD" type="number" step="1" placeholder="如 100 或 -20"></label>
        <label><span>原因</span><select id="ivR">${rOpts}</select></label>
        <label class="full"><span>备注</span><input id="ivNote" placeholder="如：盘点差异、钢板到货"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">确认</button></div>`);
    const modal = document.getElementById('ivModal');
    if (isNew) modal.querySelector('#ivR').value = 'manual_in';
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const payload = isNew
        ? { kind: modal.querySelector('#ivK').value, material: modal.querySelector('#ivM').value.trim(),
            spec: modal.querySelector('#ivS').value.trim(), name: modal.querySelector('#ivN').value.trim() }
        : { kind: r.kind, material: r.material, spec: r.spec || '', name: r.name || '' };
      payload.delta = modal.querySelector('#ivD').value.trim();
      payload.reason = modal.querySelector('#ivR').value;
      payload.note = modal.querySelector('#ivNote').value.trim();
      if (!payload.material) { formErr(modal, '料号不能为空'); return; }
      if (!payload.delta || Number(payload.delta) === 0) { formErr(modal, '调整数量不能是 0'); return; }
      b.disabled = true;
      const res = await rpc('board_inventory_adjust', { p_payload: payload });
      b.disabled = false;
      if (!res.ok) { formErr(modal, res.missingTable ? '库存接口还没建，先执行 inventory-schema.sql' : ('调整失败：' + res.error)); return; }
      closeModal(); toast('库存已调整'); load(true);
    });
  }

  async function dlgMoves(r) {
    const res = await rpc('board_inventory_moves', { p_payload: { itemId: r.id, material: r.material, spec: r.spec || '' } });
    const list = (res.ok && Array.isArray(res.data)) ? res.data : [];
    openModal(`
      <h3>库存流水</h3>
      <div class="os-sub">${esc(r.material)} ${esc(r.name || '')} · 当前 ${num(r.qty)} 件</div>
      ${list.length ? `<div class="os-receipts"><table>
        <thead><tr><th>时间</th><th>增减</th><th>原因</th><th>备注</th><th>经手</th></tr></thead>
        <tbody>${list.map((m) => `<tr>
          <td>${esc(ts(m.at))}</td>
          <td class="${Number(m.delta) >= 0 ? 'iv-move-in' : 'iv-move-out'}">${Number(m.delta) >= 0 ? '+' : ''}${num(m.delta)}</td>
          <td>${esc(REASON[m.reason] || m.reason)}</td>
          <td>${esc(m.note || m.refId || '—')}</td>
          <td>${esc(m.operator || '—')}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="os-sub">还没有流水记录。</div>'}
      <div class="os-foot"><button data-x="cancel">关闭</button></div>`);
    document.getElementById('ivModal').addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeModal(); });
  }

  /* ---------- 装 UI ---------- */
  function build() {
    if (document.getElementById('desktopInventoryView')) return;

    const nav = document.querySelector('.side-nav');
    if (nav && !nav.querySelector('[data-desktop-view="inventory"]')) {
      const a = document.createElement('a');
      a.className = 'side-link'; a.href = '#inventory'; a.dataset.desktopView = 'inventory';
      a.innerHTML = '<span class="nav-dot"></span>库存';
      const after = nav.querySelector('[data-desktop-view="outsource"]');
      const anchor = nav.querySelector('[data-desktop-view="files"]');
      if (after && after.nextSibling) nav.insertBefore(a, after.nextSibling);
      else if (anchor) nav.insertBefore(a, anchor);
      else nav.appendChild(a);
    }

    const main = document.querySelector('main.main-area');
    if (main) {
      const sec = document.createElement('section');
      sec.id = 'desktopInventoryView';
      sec.className = 'desktop-view desktop-only';
      sec.hidden = true;
      sec.innerHTML = `
        <header class="topbar">
          <div><div class="eyebrow">仓库</div><h1>库存</h1></div>
          <div class="topbar-actions">
            <button id="ivRefresh" class="button">刷新</button>
            <button id="ivNew" class="button primary">手工录入 / 调整</button>
          </div>
        </header>
        <section class="panel os-panel">
          <div id="ivKpis" class="os-kpis"></div>
          <div id="ivTabs" class="os-tabs"></div>
          <div class="iv-search"><input id="ivSearch" type="search" placeholder="搜料号 / 品名 / 图号" autocomplete="off"></div>
          <div id="ivBanner" class="os-banner" hidden></div>
          <div class="os-tablewrap">
            <table class="os-table">
              <thead><tr>
                <th>类型</th><th>料号 / 图号</th><th>品名</th><th>库存</th><th>更新时间</th><th>操作</th>
              </tr></thead>
              <tbody id="ivBody"></tbody>
            </table>
          </div>
          <div id="ivEmpty" class="os-empty" hidden></div>
        </section>`;
      main.appendChild(sec);
    }

    document.addEventListener('click', (e) => {
      const link = e.target.closest('.side-link[data-desktop-view]');
      if (!link) return;
      if (link.dataset.desktopView === VIEW) { e.preventDefault(); showMine(); }
      else hideMine();
    }, true);

    document.addEventListener('click', (e) => {
      if (e.target.closest('#ivRefresh')) { load(true); return; }
      if (e.target.closest('#ivNew')) { dlgAdjust(null); return; }
      const tab = e.target.closest('#ivTabs [data-tab]');
      if (tab) { S.tab = tab.dataset.tab; S.loaded = false; render(); load(true); return; }
      const op = e.target.closest('#ivBody [data-act]');
      if (op) {
        const tr = op.closest('tr');
        const r = S.list.find((x) => String(x.id) === tr.dataset.item)
               || { id: tr.dataset.item, kind: tr.dataset.kind, material: tr.dataset.mat, spec: tr.dataset.spec };
        if (op.dataset.act === 'adjust') dlgAdjust(r);
        else if (op.dataset.act === 'moves') dlgMoves(r);
      }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id === 'ivSearch') { S.q = e.target.value; render(); }
    });
  }

  function init() {
    const isMobile = /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile';
    if (isMobile) return;
    build();
    if ((location.hash || '').replace('#', '') === VIEW) setTimeout(showMine, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
