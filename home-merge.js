/* ============================================================
   实时总览整合 + 侧栏精简
   文件：public/home-merge.js         建立日期：2026-10-16
   做三件事（都不动 app.js）：
     ① 把「未交清单」的打印按钮搬到实时总览页头（移动节点，事件监听跟着走）
     ② 把「未交清单」的工具条+表格 和 原实时总览的表格 合并成「未交明细」，
        上面加 [按采购单 | 按料号] 视图切换
     ③ 侧栏精简：原 15 项 → 5 常用 + 「更多 ▾」折叠组；隐藏「功能」切换球
   为什么不影响打印（已核对）：
     · printRemainingList / openLabelPrintModal 的数据都来自内存里的 snapshot，不读表格 DOM
     · 4 个按钮用 addEventListener 绑在元素本身 —— 移动节点不会丢监听
     · 全程只搬位置、不删元素
   回滚：删掉 index.html 里这一行 <script>
   ============================================================ */
(() => {
  'use strict';

  const NAV_MAIN = [
    { view: 'overview',  label: '实时总览' },
    { view: 'shipments', label: '查询' },
    { view: 'drawings',  label: '图纸库' },
    { view: 'files',     label: '云端送货单' }
  ];
  const NAV_MORE = [
    { view: 'loading',    label: '装车登记（电脑端备用）' },
    { view: 'outsource',  label: '外协管理' },
    { view: 'inventory',  label: '库存' },
    { view: 'purchase',   label: '采购 / 来料' },
    { view: 'quality',    label: '质量 / 不良' },
    { view: 'prices',     label: '单价查询', admin: true },
    { view: 'workReport', label: '报工情况', admin: true },
    { view: 'workReview', label: '报工审核', admin: true },
    { view: 'workEdit',   label: '报工修改', admin: true },
    { view: 'attendance', label: '考勤管理', admin: true }
  ];
  const SECTION_TO_VIEW = {
    desktopView: 'overview',
    desktopRemainingView: 'remaining',
    desktopLoadingView: 'loading',
    desktopShipmentsView: 'shipments',
    desktopDrawingsView: 'drawings',
    desktopPricesView: 'prices',
    desktopFilesView: 'files',
    desktopWorkReportView: 'workReport',
    desktopWorkReviewView: 'workReview',
    desktopWorkEditView: 'workEdit',
    desktopAttendanceView: 'attendance',
    desktopOutsourceView: 'outsource',
    desktopInventoryView: 'inventory',
    desktopPurchaseView: 'purchase',
    desktopQualityView: 'quality'
  };

  const $ = (s) => document.querySelector(s);
  const isAdmin = () => document.body.dataset.boardRole === 'admin';
  let mergeView = 'orders';      // orders 按采购单 | material 按料号
  let lastActive = '';

  /* ---------------- ① 搬打印按钮 + ② 建未交明细 ---------------- */
  function mergeEverything() {
    const view = document.getElementById('desktopView');
    if (!view || document.getElementById('tkMerge')) return;

    // ① 4 个打印按钮搬到实时总览页头（保持「打印清单/标签/承认书/导出」的原顺序）
    const topActions = view.querySelector(':scope > .topbar .topbar-actions');
    const pdfBtn = document.getElementById('pdfImportButton');
    const ids = ['desktopRemainingPrint', 'desktopLabelPrint', 'desktopRemainingSampleApproval', 'desktopRemainingExport'];
    const btns = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (topActions && pdfBtn) {
      btns.slice().reverse().forEach((b) => topActions.insertBefore(b, pdfBtn));
    }

    // ② 建「未交明细」容器
    const merge = document.createElement('section');
    merge.id = 'tkMerge';
    merge.className = 'tk-merge';
    merge.innerHTML =
      '<div class="tk-merge-h">' +
        '<b>完整未交清单</b>' +
        '<span class="sub" id="tkMergeSub"></span>' +
        '<div class="tk-merge-tabs" id="tkMergeTabs">' +
          '<button type="button" data-mv="orders">按采购单</button>' +
          '<button type="button" data-mv="material">按料号</button>' +
        '</div>' +
        '<button type="button" class="tk-fold" id="tkMergeFold" aria-expanded="false">展开<span class="caret">▾</span></button>' +
      '</div>' +
      '<div class="tk-merge-view" data-mv="orders"></div>' +
      '<div class="tk-merge-view" data-mv="material"></div>';
    view.appendChild(merge);

    // 搬「按采购单」表格（原实时总览的 .orders-panel）
    const ordersPanel = view.querySelector('.dashboard-grid .orders-panel') || view.querySelector('.orders-panel');
    if (ordersPanel) merge.querySelector('.tk-merge-view[data-mv="orders"]').appendChild(ordersPanel);

    // 搬「按料号」表格（原未交清单的 .desktop-remaining-panel，整块含工具条+表格）
    const remainPanel = document.querySelector('#desktopRemainingView .desktop-remaining-panel');
    if (remainPanel) merge.querySelector('.tk-merge-view[data-mv="material"]').appendChild(remainPanel);

    // 清掉搬空的 dashboard-grid（否则它的 min-width 会撑出空白）
    const grid = view.querySelector('.dashboard-grid');
    if (grid && !grid.children.length) grid.remove();

    // 视图切换
    merge.addEventListener('click', (e) => {
      const b = e.target.closest('#tkMergeTabs [data-mv]');
      if (!b) return;
      setMergeView(b.dataset.mv);
    });
    setMergeView(mergeView, true);

    // 默认折叠：完整清单数据量大，不占页面；要看时点「展开」或从面板进来
    const fold = merge.querySelector('#tkMergeFold');
    const applyFold = (open) => {
      merge.classList.toggle('tk-collapsed', !open);
      if (fold) { fold.setAttribute('aria-expanded', String(open)); fold.firstChild.textContent = open ? '收起' : '展开'; }
    };
    let folded = true;
    try { folded = localStorage.getItem('tkMergeFolded') !== '0'; } catch { }
    applyFold(!folded);
    if (fold) fold.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = merge.classList.contains('tk-collapsed');
      try { localStorage.setItem('tkMergeFolded', open ? '0' : '1'); } catch { }
      applyFold(open);
      if (open) merge.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // 给面板里的「点一行 / 完整清单 →」用
    window.tkOpenMerge = () => {
      applyFold(true);
      try { localStorage.setItem('tkMergeFolded', '0'); } catch { }
      setTimeout(() => merge.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    };
  }

  function setMergeView(v, silent) {
    mergeView = v === 'material' ? 'material' : 'orders';
    try { localStorage.setItem('tkMergeView', mergeView); } catch { }
    const merge = document.getElementById('tkMerge');
    if (!merge) return;
    merge.querySelectorAll('[data-mv]').forEach((el) => {
      if (el.classList.contains('tk-merge-view')) el.hidden = el.dataset.mv !== mergeView;
      else el.classList.toggle('on', el.dataset.mv === mergeView);
    });
    const sub = document.getElementById('tkMergeSub');
    if (sub) sub.textContent = mergeView === 'orders'
      ? '一行 = 一个采购单项次（跟单、看金额用这个）'
      : '一行 = 一个料号（同料号的多张单合并，排产、打标签用这个）';
    if (!silent) { /* 切换后让 app.js 重画一次，保证数据最新 */ }
  }

  /* ---------------- ③ 侧栏 ---------------- */
  function buildNav() {
    const nav = document.querySelector('.side-nav');
    if (!nav || document.getElementById('tkNav')) return;
    nav.classList.add('tk-nav-off');

    const el = document.createElement('nav');
    el.className = 'tk-nav';
    el.id = 'tkNav';
    el.setAttribute('aria-label', '主导航');
    const itemHtml = (it) =>
      '<a href="#" data-tk-view="' + it.view + '"' + (it.admin ? ' data-admin="1"' : '') + '>' +
      '<span class="dot"></span>' + it.label + '</a>';
    el.innerHTML =
      NAV_MAIN.map(itemHtml).join('') +
      '<div class="sep"></div>' +
      '<button type="button" class="tk-more-btn" id="tkMoreBtn" aria-expanded="false">' +
        '<span class="dot"></span>更多<span class="caret">▾</span></button>' +
      '<div class="tk-more-group" id="tkMoreGroup" hidden>' + NAV_MORE.map(itemHtml).join('') + '</div>';

    nav.insertAdjacentElement('afterend', el);

    const btn = el.querySelector('#tkMoreBtn');
    const group = el.querySelector('#tkMoreGroup');
    let open = false;
    try { open = localStorage.getItem('tkMoreOpen') === '1'; } catch { }
    const paint = () => { group.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    paint();
    btn.addEventListener('click', () => {
      open = !open;
      try { localStorage.setItem('tkMoreOpen', open ? '1' : '0'); } catch { }
      paint();
    });

    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-tk-view]');
      if (!a) return;
      e.preventDefault();
      goView(a.dataset.tkView);
    });

    applyRoleVisibility();
    // 角色是异步识别的，识别出来后再刷一次
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      applyRoleVisibility();
      if (document.body.dataset.boardRole || tries > 40) clearInterval(t);
    }, 500);
  }

  // 普通模式：管理员专属项隐藏
  function applyRoleVisibility() {
    const nav = document.getElementById('tkNav');
    if (!nav) return;
    const admin = isAdmin();
    nav.querySelectorAll('a[data-admin="1"]').forEach((a) => a.classList.toggle('tk-off', !admin));
  }

  // 跳转：优先点原始链接（让 app.js 自己的逻辑跑一遍）
  function goView(view) {
    if (view === 'remaining') { openOverviewMaterial(); return; }
    const link = document.querySelector('.side-link[data-desktop-view="' + view + '"]');
    if (link) { link.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    // 兜底：直接切 section
    document.querySelectorAll('.desktop-view').forEach((s) => { s.hidden = SECTION_TO_VIEW[s.id] !== view; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function openOverviewMaterial() {
    const link = document.querySelector('.side-link[data-desktop-view="overview"]');
    if (link) link.click();
    setMergeView('material');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 高亮跟随实际显示的页面（app.js 切页时不会通知我们，用轻量轮询）
  function watchActive() {
    setInterval(() => {
      const shown = [...document.querySelectorAll('.desktop-view')].find((s) => !s.hidden);
      const view = shown ? (SECTION_TO_VIEW[shown.id] || '') : '';
      if (view === lastActive) return;
      lastActive = view;
      const nav = document.getElementById('tkNav');
      if (!nav) return;
      nav.querySelectorAll('a[data-tk-view]').forEach((a) =>
        a.classList.toggle('on', a.dataset.tkView === view));
      // 命中的项在「更多」里时，自动展开，别让人找不到自己在哪
      const hit = NAV_MORE.find((x) => x.view === view);
      if (hit) {
        const g = document.getElementById('tkMoreGroup');
        const b = document.getElementById('tkMoreBtn');
        if (g && g.hidden) { g.hidden = false; if (b) b.setAttribute('aria-expanded', 'true'); }
      }
    }, 600);
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    const isMobile = /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile';
    if (isMobile) return;                      // 手机端不动

    try { const v = localStorage.getItem('tkMergeView'); if (v) mergeView = v; } catch { }

    mergeEverything();
    buildNav();
    watchActive();

    // 老链接兜底：#remaining 或 #overview 直接进实时总览
    const hash = (location.hash || '').replace('#', '');
    if (hash === 'remaining') { openOverviewMaterial(); }
    else if (hash === 'overview') { goView('overview'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
