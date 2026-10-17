/* ============================================================
   客商信息：客户 / 外协厂 / 原材料供应商
   文件：public/partners.js     建立日期：2026-10-17
   数据：board_partners_list / board_partner_save / board_partner_ensure
   另外：外协单、采购单保存时会自动把填的厂名补进客商库
   回滚：删掉 index.html 里这一行 <script> 即可。
   ============================================================ */
(() => {
  'use strict';

  const VIEW = 'partners';
  const ID = 'desktopPartnersView';
  const KINDS = [
    { k: 'customer', label: '客户' },
    { k: 'outsource', label: '外协厂' },
    { k: 'supplier', label: '原材料供应商' }
  ];
  const KIND_LABEL = { customer: '客户', outsource: '外协厂', supplier: '原材料供应商' };

  let S = { kind: 'customer', q: '', list: [], loaded: false, err: '' };

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMobile = () => /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile';
  const isAdmin = () => document.body.dataset.boardRole === 'admin';

  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }
  async function rpc(name, payload = {}) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return { ok: false, error: '没有云端接口' };
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
    try {
      const r = await fetch(base + '/' + name, { method: 'POST', headers: h, body: JSON.stringify({ p_code: readCode(), ...payload }) });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) return { ok: false, error: (data && (data.message || data.error)) || ('HTTP ' + r.status) };
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  /* ---------------- 页面 ---------------- */
  function build() {
    if (document.getElementById(ID)) return;
    const main = document.querySelector('main.main-area');
    if (!main) return;
    const me = document.createElement('section');
    me.id = ID;
    me.className = 'desktop-view desktop-only';
    me.hidden = true;
    me.innerHTML =
      '<header class="topbar"><div><div class="eyebrow">往来单位</div><h1>客商信息</h1></div>' +
      '<div class="topbar-actions"><button id="ptRefresh" class="button">刷新</button>' +
      '<button id="ptNew" class="button primary">新增</button></div></header>' +
      '<section class="panel"><div class="pt-bar">' +
      '<div class="pt-tabs" id="ptTabs"></div>' +
      '<input id="ptSearch" class="pt-search" placeholder="搜名称 / 联系人 / 电话">' +
      '</div><div class="pt-tablewrap"><table class="pt-table"><thead><tr>' +
      '<th>名称</th><th>简称</th><th>联系人</th><th>电话</th><th>地址</th><th>备注</th><th>操作</th>' +
      '</tr></thead><tbody id="ptBody"></tbody></table></div>' +
      '<div id="ptEmpty" class="pt-empty" hidden></div></section>';
    main.appendChild(me);

    document.getElementById('ptRefresh').addEventListener('click', () => load(true));
    document.getElementById('ptNew').addEventListener('click', () => dlgEdit(null));
    document.getElementById('ptSearch').addEventListener('input', (e) => { S.q = e.target.value; render(); });
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.side-link[data-desktop-view]');
      if (!link) return;
      if (link.dataset.desktopView === VIEW) { e.preventDefault(); showMine(); }
      else hideMine();
    }, true);
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-pt-tab]')) { S.kind = e.target.closest('[data-pt-tab]').dataset.ptTab; render(); return; }
      const op = e.target.closest('[data-pt-act]');
      if (!op) return;
      const row = S.list.find((x) => x.id === op.dataset.id);
      if (!row) return;
      if (op.dataset.ptAct === 'edit') dlgEdit(row);
      else if (op.dataset.ptAct === 'toggle') toggle(row);
    });
    render();
  }

  function showMine() {
    document.querySelectorAll('.desktop-view').forEach((v) => { v.hidden = v.id !== ID; });
    if (!S.loaded) load(true);
  }
  function hideMine() { const v = document.getElementById(ID); if (v) v.hidden = true; }

  async function load(force) {
    if (S.loaded && !force) return;
    const r = await rpc('board_partners_list', { p_kind: 'all' });
    if (r.ok && Array.isArray(r.data)) { S.list = r.data; S.loaded = true; S.err = ''; }
    else { S.err = r.error || '读取失败'; }
    render();
    fillDatalists();
  }

  function render() {
    const tabs = document.getElementById('ptTabs');
    const body = document.getElementById('ptBody');
    const empty = document.getElementById('ptEmpty');
    if (!tabs || !body) return;
    tabs.innerHTML = KINDS.map((x) =>
      '<button type="button" data-pt-tab="' + x.k + '"' + (x.k === S.kind ? ' class="on"' : '') + '>' +
      x.label + '<em>' + S.list.filter((p) => p.kind === x.k).length + '</em></button>').join('');
    const q = S.q.trim().toLowerCase();
    const rows = S.list.filter((p) => p.kind === S.kind &&
      (!q || [p.name, p.shortName, p.contact, p.phone].some((v) => String(v || '').toLowerCase().includes(q))));
    body.innerHTML = rows.map((p) =>
      '<tr' + (p.active === false ? ' class="off"' : '') + '>' +
      '<td class="pt-name">' + esc(p.name) + '</td>' +
      '<td>' + esc(p.shortName || '—') + '</td>' +
      '<td>' + esc(p.contact || '—') + '</td>' +
      '<td class="mono">' + esc(p.phone || '—') + '</td>' +
      '<td class="pt-addr">' + esc(p.address || '—') + '</td>' +
      '<td class="pt-note">' + esc(p.note || '—') + '</td>' +
      '<td class="pt-ops"><button data-pt-act="edit" data-id="' + p.id + '">改</button>' +
      '<button data-pt-act="toggle" data-id="' + p.id + '">' + (p.active === false ? '启用' : '停用') + '</button></td>' +
      '</tr>').join('');
    if (empty) {
      empty.hidden = rows.length > 0;
      empty.textContent = S.err ? ('读取失败：' + S.err) : '这个分类下还没有记录，点右上角「新增」。';
    }
  }

  /* ---------------- 新增 / 修改 ---------------- */
  function dlgEdit(row) {
    const isNew = !row;
    const r = row || { kind: S.kind, name: '', shortName: '', contact: '', phone: '', address: '', note: '' };
    let mask = document.getElementById('ptMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'pt-mask';
      mask.id = 'ptMask';
      mask.innerHTML = '<div class="pt-modal" id="ptModal"></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    }
    mask.hidden = false;
    document.getElementById('ptModal').innerHTML =
      '<h3>' + (isNew ? '新增客商' : '修改客商') + '</h3>' +
      '<div class="pt-form">' +
      '<label><span>分类</span><select id="ptKind">' + KINDS.map((x) =>
        '<option value="' + x.k + '"' + (x.k === r.kind ? ' selected' : '') + '>' + x.label + '</option>').join('') + '</select></label>' +
      '<label><span>名称 *</span><input id="ptName" value="' + esc(r.name) + '" placeholder="如：苏州艾沃意特汽车设备有限公司"></label>' +
      '<label><span>简称</span><input id="ptShort" value="' + esc(r.shortName || '') + '" placeholder="如：艾沃意特"></label>' +
      '<label><span>联系人</span><input id="ptContact" value="' + esc(r.contact || '') + '"></label>' +
      '<label><span>电话</span><input id="ptPhone" value="' + esc(r.phone || '') + '"></label>' +
      '<label class="full"><span>地址</span><input id="ptAddr" value="' + esc(r.address || '') + '"></label>' +
      '<label class="full"><span>备注</span><input id="ptNoteIn" value="' + esc(r.note || '') + '"></label>' +
      '</div><div class="pt-foot"><button data-pt-x="cancel">取消</button>' +
      '<button class="pri" data-pt-x="save">保存</button></div>';
    const modal = document.getElementById('ptModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pt-x]');
      if (!b) return;
      if (b.dataset.ptX === 'cancel') { close(); return; }
      const name = modal.querySelector('#ptName').value.trim();
      if (!name) { alert('名称不能为空'); return; }
      b.disabled = true;
      const res = await rpc('board_partner_save', { p_payload: {
        id: isNew ? '' : r.id,
        kind: modal.querySelector('#ptKind').value,
        name,
        shortName: modal.querySelector('#ptShort').value.trim(),
        contact: modal.querySelector('#ptContact').value.trim(),
        phone: modal.querySelector('#ptPhone').value.trim(),
        address: modal.querySelector('#ptAddr').value.trim(),
        note: modal.querySelector('#ptNoteIn').value.trim()
      } });
      b.disabled = false;
      if (!res.ok) { alert('保存失败：' + res.error); return; }
      close();
      S.loaded = false;
      await load(true);
      if (window.showToast) window.showToast(isNew ? '已新增' : '已保存');
    });
  }
  function close() { const m = document.getElementById('ptMask'); if (m) m.hidden = true; }

  async function toggle(row) {
    const next = row.active === false;
    if (!next && !confirm('停用后不出现在推荐列表里，历史单据不受影响。确定停用？')) return;
    const res = await rpc('board_partner_save', { p_payload: { id: row.id, kind: row.kind, name: row.name, active: next } });
    if (!res.ok) { alert('操作失败：' + res.error); return; }
    S.loaded = false; await load(true);
  }

  /* ---------------- 给外协 / 采购弹窗喂候选 ---------------- */
  function fillDatalists() {
    const out = S.list.filter((p) => p.active !== false && p.kind === 'outsource').map((p) => p.name);
    const sup = S.list.filter((p) => p.active !== false && p.kind === 'supplier').map((p) => p.name);
    const paint = (id, names) => {
      const dl = document.getElementById(id);
      if (!dl) return;
      const cur = new Set([...dl.options].map((o) => o.value));
      names.forEach((n) => { if (!cur.has(n)) { const o = document.createElement('option'); o.value = n; dl.appendChild(o); } });
    };
    paint('osVendorList', out);
    paint('puSupList', sup);
  }

  // 外协 / 采购 保存后，把填的厂名自动补进客商库
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#osModal [data-x="save"], #puModal [data-x="save"]');
    if (!btn) return;
    setTimeout(async () => {
      const os = document.getElementById('osVendor');
      const pu = document.getElementById('puSup');
      if (os && os.value.trim()) await rpc('board_partner_ensure', { p_kind: 'outsource', p_name: os.value.trim() });
      if (pu && pu.value.trim()) await rpc('board_partner_ensure', { p_kind: 'supplier', p_name: pu.value.trim() });
      S.loaded = false;
      setTimeout(() => load(true), 800);
    }, 900);
  }, true);

  function init() {
    if (isMobile()) return;
    build();
    // 侧栏入口（和 modules 一样挂在「更多」里由 home-merge 管；这里补一个兜底链接）
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      const nav = document.querySelector('.side-nav');
      if (nav && !nav.querySelector('[data-desktop-view="' + VIEW + '"]')) {
        const a = document.createElement('a');
        a.className = 'side-link';
        a.href = '#partners';
        a.dataset.desktopView = VIEW;
        a.innerHTML = '<span class="nav-dot"></span>客商信息';
        const anchor = nav.querySelector('[data-desktop-view="outsource"]');
        if (anchor) nav.insertBefore(a, anchor); else nav.appendChild(a);
      }
      if (document.body.dataset.boardRole) { clearInterval(t); load(false); }
      else if (tries > 40) clearInterval(t);
    }, 500);
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-tk-view="' + VIEW + '"]')) setTimeout(showMine, 60);
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();