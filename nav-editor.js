/* 可编辑导航（分组 + 拖动） 2026-10-19 */
(() => {
  'use strict';
  const LS = 'tkNavConfig';
  const ALL = {
    overview: '实时总览', remaining: '未交清单',
    shipments: '发货查询', drawings: '图纸查询', prices: '单价查询', files: '送货单查询',
    outsource: '外协管理', purchase: '采购 / 来料', quality: '质量 / 不良', inventory: '库存',
    partners: '客商信息', work: '报工', attendance: '考勤管理'
  };
  const def = () => ([
    { id: 'g1', name: '总览', items: ['overview', 'remaining'] },
    { id: 'g2', name: '查询', items: ['shipments', 'drawings', 'prices', 'files'] },
    { id: 'g3', name: '业务', items: ['outsource', 'purchase', 'quality', 'inventory'] },
    { id: 'g4', name: '信息', items: ['partners'] },
    { id: 'g5', name: '报表', items: ['work', 'attendance'] }
  ]);
  let cfg = null, editing = false, dragId = '';

  function load() {
    try { const c = JSON.parse(localStorage.getItem(LS) || 'null'); cfg = (c && Array.isArray(c.groups) && c.groups.length) ? c : def(); }
    catch { cfg = def(); }
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch { } }

  function go(view) {
    const link = document.querySelector('.side-link[data-desktop-view="' + view + '"]') ||
      document.querySelector('[data-tk-view="' + view + '"]');
    if (link) link.click();
  }

  function render() {
    const nav = document.getElementById('tkNav2');
    if (!nav) return;
    const active = (() => {
      const shown = [...document.querySelectorAll('.desktop-view')].find((s) => !s.hidden);
      if (!shown) return '';
      const m = { desktopView: 'overview', desktopRemainingView: 'remaining', desktopShipmentsView: 'shipments', desktopDrawingsView: 'drawings', desktopPricesView: 'prices', desktopFilesView: 'files', desktopOutsourceView: 'outsource', desktopPurchaseView: 'purchase', desktopQualityView: 'quality', desktopInventoryView: 'inventory', desktopPartnersView: 'partners', desktopWorkReportView: 'work', desktopAttendanceView: 'attendance' };
      return m[shown.id] || '';
    })();
    nav.innerHTML = cfg.groups.map((g) => (
      '<div class="tk-grp" data-grp="' + g.id + '">' +
      '<div class="tk-grp-h" data-grp-h="' + g.id + '"><b>' + esc(g.name) + '</b>' +
      (editing ? '<button class="tk-grp-del" data-del="' + g.id + '" title="删除分组">×</button>' : '<span class="c">▾</span>') +
      '</div>' +
      '<div class="tk-grp-items" data-drop="' + g.id + '">' +
      (g.items.length ? g.items.map((v) => (
        '<a class="tk-grp-item' + (v === active ? ' on' : '') + '" data-view="' + v + '"' + (editing ? ' draggable="true"' : '') + '>' +
        esc(ALL[v] || v) + '</a>'
      )).join('') : '<div class="tk-grp-empty">（空）把功能拖到这里</div>') +
      '</div></div>'
    )).join('') +
      (editing ? '<div class="tk-nav-tools"><button id="tkNavAddGrp">＋ 新建分组</button><button id="tkNavReset">恢复默认</button><button class="pri" id="tkNavDone">完成</button></div>' : '');
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function findGroupWith(view) { return cfg.groups.find((g) => g.items.includes(view)); }

  function build() {
    const side = document.querySelector('.sidebar');
    const old = document.getElementById('tkNav');
    if (!side || !old) return;
    if (document.getElementById('tkNav2')) return;
    const nav = document.createElement('nav');
    nav.id = 'tkNav2';
    nav.className = 'tk-nav2';
    old.insertAdjacentElement('afterend', nav);
    try { render(); } catch (err) { nav.remove(); return; }
    if (!nav.children.length) { nav.remove(); return; }   // 渲染没内容就保留旧导航
    old.style.display = 'none';
    const foot = document.querySelector('.sidebar-foot');
    if (foot && !document.getElementById('tkNavEditBtn')) {
      const b = document.createElement('button');
      b.id = 'tkNavEditBtn';
      b.className = 'tk-nav-edit';
      b.type = 'button';
      b.textContent = '编辑导航';
      foot.insertBefore(b, foot.firstChild);
    }
    render();
    watchActive();
  }

  function watchActive() {
    let last = '';
    setInterval(() => {
      const shown = [...document.querySelectorAll('.desktop-view')].find((s) => !s.hidden);
      const id = shown ? shown.id : '';
      if (id !== last) { last = id; render(); }
    }, 700);
  }

  document.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const id = del.dataset.del;
      const g = cfg.groups.find((x) => x.id === id);
      if (g && g.items.length) { alert('先把里面的功能拖到别的分组，再删这个分组'); return; }
      if (!confirm('删除这个分组？')) return;
      cfg.groups = cfg.groups.filter((x) => x.id !== id); save(); render(); return;
    }
    const grpH = e.target.closest('[data-grp-h]');
    if (grpH && editing) {
      const id = grpH.dataset.grpH;
      const g = cfg.groups.find((x) => x.id === id);
      if (!g) return;
      const name = prompt('分组名称', g.name);
      if (name != null && name.trim()) { g.name = name.trim(); save(); render(); }
      return;
    }
    if (e.target.id === 'tkNavEditBtn') { editing = !editing; render(); return; }
    if (e.target.id === 'tkNavAddGrp') {
      cfg.groups.push({ id: 'g' + Date.now(), name: '新分组', items: [] }); save(); render(); return;
    }
    if (e.target.id === 'tkNavReset') {
      if (!confirm('恢复默认导航？你自定义的分组会丢掉')) return;
      cfg = def(); save(); render(); return;
    }
    if (e.target.id === 'tkNavDone') { editing = false; render(); return; }
    const item = e.target.closest('.tk-grp-item');
    if (item && !editing) { e.preventDefault(); go(item.dataset.view); }
  });

  document.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.tk-grp-item[draggable="true"]');
    if (!item) return;
    dragId = item.dataset.view;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch { }
    item.classList.add('dragging');
  });
  document.addEventListener('dragend', (e) => {
    const item = e.target.closest('.tk-grp-item');
    if (item) item.classList.remove('dragging');
  });
  document.addEventListener('dragover', (e) => {
    const box = e.target.closest('[data-drop]');
    if (!box || !dragId) return;
    e.preventDefault();
    box.classList.add('drop-on');
  });
  document.addEventListener('dragleave', (e) => {
    const box = e.target.closest('[data-drop]');
    if (box) box.classList.remove('drop-on');
  });
  document.addEventListener('drop', (e) => {
    const box = e.target.closest('[data-drop]');
    if (!box || !dragId) return;
    e.preventDefault();
    box.classList.remove('drop-on');
    const to = cfg.groups.find((g) => g.id === box.dataset.drop);
    const from = findGroupWith(dragId);
    if (!to || !from || to.id === from.id) { dragId = ''; return; }
    from.items = from.items.filter((v) => v !== dragId);
    to.items.push(dragId);
    dragId = '';
    save(); render();
  });

  function init() {
    load();
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (document.getElementById('tkNav')) { clearInterval(t); build(); }
      else if (tries > 60) clearInterval(t);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();