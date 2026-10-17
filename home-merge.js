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
    { view: 'remaining', label: '未交清单' },
    { view: 'shipments', label: '查询' },
    { view: 'drawings',  label: '图纸库' },
    { view: 'files',     label: '云端送货单' }
  ];
  const NAV_MORE = [
    { view: 'loading',    label: '装车登记（电脑端备用）' },
    { view: 'partners',   label: '客商信息', admin: true },
    { view: 'outsource',  label: '外协管理', admin: true },
    { view: 'inventory',  label: '库存', admin: true },
    { view: 'purchase',   label: '采购 / 来料', admin: true },
    { view: 'quality',    label: '质量 / 不良', admin: true },
    { view: 'prices',     label: '单价查询', admin: true },
    { view: 'work',       label: '报工', admin: true },
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
  let mergeView = 'material';    // orders 按采购单 | material 按料号（未交清单默认按料号，日期筛打印就在这里）
  let lastActive = '';

  /* ---------------- ① 搬打印按钮 + ② 建未交明细 ---------------- */
  function mergeEverything() {
    const view = document.getElementById('desktopView');
    if (!view || document.getElementById('tkMerge')) return;

    // ① 页头按钮：订单导入 / 承样书 / 打印清单 / 打印标签
    //   （2026-10-17 阿泽定顺序，导出 Excel 直接删掉）
    // 注意：这里给首页复制一份快捷按钮，不要把“未交清单”页里的原按钮搬走。
    // 原按钮一搬走，进入未交清单后就找不到“打印清单/打印标签/承样书”，
    // 日期筛选还在、打印入口却消失了，看起来就像打印功能坏了。
    const topActions = view.querySelector(':scope > .topbar .topbar-actions');
    if (topActions) {
      ['pdfImportButton', 'desktopRemainingSampleApproval', 'desktopRemainingPrint', 'desktopLabelPrint']
        .forEach((id) => {
          const el = document.getElementById(id);
          if (!el || el.closest('#desktopView')) return;
          if (topActions.querySelector(`[data-mirror-for="${id}"]`)) return;
          const mirror = el.cloneNode(true);
          mirror.removeAttribute('id');
          mirror.dataset.mirrorFor = id;
          mirror.addEventListener('click', (event) => {
            event.preventDefault();
            const overview = document.getElementById('desktopView');
            if (id === 'desktopRemainingPrint' && overview && !overview.hidden && typeof window.tkPrintDashboardDue === 'function') {
              window.tkPrintDashboardDue();
              return;
            }
            const target = document.getElementById(id);
            if (target) target.click();
          });
          topActions.appendChild(mirror);
        });
      const gone = document.getElementById('desktopRemainingExport');
      if (gone) gone.remove();
      // 详情页不再承担打印清单；主页的打印清单继续保留。
      const detailPrint = document.getElementById('desktopRemainingPrint');
      if (detailPrint) detailPrint.hidden = true;
    }

    // ② 建「未交明细」容器
    const merge = document.createElement('section');
    merge.id = 'tkMerge';
    merge.className = 'tk-merge';
    merge.innerHTML =
      '<div class="tk-merge-h">' +
        '<b>未交清单详情</b>' +
        '<span class="sub" id="tkMergeSub"></span>' +
        '<button type="button" class="tk-fold" id="tkMergeFold" aria-expanded="false">展开<span class="caret">▾</span></button>' +
      '</div>' +
      '<div class="tk-merge-view" data-mv="orders"></div>';
    // 2026-10-17：完整清单不再挂在主页最底部，改成侧栏「未交清单」独立页
    const remainSection = document.getElementById('desktopRemainingView');
    if (remainSection) remainSection.appendChild(merge); else view.appendChild(merge);

    // 详情页恢复成“详细版”：按采购单的完整表格，带订单量/已发/未交/项次/单价/金额/交期。
    // 打印清单已经放到主页，不在详情页重复一套按料号的打印列表。
    const ordersPanel = view.querySelector('.dashboard-grid .orders-panel') || view.querySelector('.orders-panel');
    if (ordersPanel) merge.querySelector('.tk-merge-view[data-mv="orders"]').appendChild(ordersPanel);
    const remainPanel = document.querySelector('#desktopRemainingView .desktop-remaining-panel');
    if (remainPanel) remainPanel.hidden = true;

    // 清掉搬空的 dashboard-grid（否则它的 min-width 会撑出空白）
    const grid = view.querySelector('.dashboard-grid');
    if (grid && !grid.children.length) grid.remove();

    setMergeView(mergeView, true);

    /* 折叠默认值怎么定（2026-10-17 修白屏）：
       · 阿泽手动点过「展开/收起」 → 听他的（记在 localStorage）
       · 没点过 且 主页=面板 → 默认折叠（面板已经把关键信息摆出来了，整张清单太长）
       · 没点过 且 主页=清单 → 必须默认展开！否则页面只剩一个标题条、下面全白
         （上线当天就是这么白屏的：清单视图 + 默认折叠，两个默认值撞一起了） */
    const fold = merge.querySelector('#tkMergeFold');
    const applyFold = (open) => {
      merge.classList.toggle('tk-collapsed', !open);
      if (fold) { fold.setAttribute('aria-expanded', String(open)); fold.firstChild.textContent = open ? '收起' : '展开'; }
    };
    let folded = false;      // 独立成页了，默认展开
    try { if (localStorage.getItem('tkMergeFolded') === '1') folded = true; } catch { }
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
      openRemainingPage();
    };
  }

  function setMergeView(_v, _silent) {
    mergeView = 'orders';
    const merge = document.getElementById('tkMerge');
    if (!merge) return;
    merge.querySelectorAll('.tk-merge-view').forEach((el) => {
      el.hidden = el.dataset.mv !== 'orders';
    });
    const sub = document.getElementById('tkMergeSub');
    if (sub) sub.textContent = '';
  }

  /* 报工：原来是三个独立页面（报工情况/报工审核/报工修改），现在合成一个「报工」，
     三个视图顶部各插一条页签，点页签就是在三个视图之间切（2026-10-17 阿泽要求）。 */
  const WORK_VIEWS = [
    { view: 'workReport', label: '报工情况', id: 'desktopWorkReportView' },
    { view: 'workReview', label: '待审核',   id: 'desktopWorkReviewView' },
    { view: 'workEdit',   label: '报工修改', id: 'desktopWorkEditView' }
  ];
  function buildWorkTabs() {
    WORK_VIEWS.forEach((w) => {
      const sec = document.getElementById(w.id);
      if (!sec || sec.querySelector('.tk-work-tabs')) return;
      const bar = document.createElement('div');
      bar.className = 'tk-work-tabs';
      bar.innerHTML = WORK_VIEWS.map((x) =>
        '<button type="button" data-work-view="' + x.view + '">' + x.label + '</button>').join('');
      const header = sec.querySelector(':scope > .topbar');
      if (header) header.insertAdjacentElement('afterend', bar);
      else if (sec.firstElementChild) sec.insertBefore(bar, sec.firstElementChild);
      else sec.appendChild(bar);
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-work-view]');
        if (!b) return;
        const link = document.querySelector('.side-link[data-desktop-view="' + b.dataset.workView + '"]');
        if (link) link.click();
      });
    });
  }
  function paintWorkTabs(activeView) {
    document.querySelectorAll('.tk-work-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.workView === activeView);
    });
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
    const admin = isAdmin();
    if (nav) nav.querySelectorAll('a[data-admin="1"]').forEach((a) => a.classList.toggle('tk-off', !admin));
    // 普通端只保留以前的功能：新模块的页面 + 它们自己建的侧栏链接都藏起来（双保险）
    if (admin) return;
    Object.values(MODULE_PAGE_IDS).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    document.querySelectorAll('.side-link[data-desktop-view="outsource"], .side-link[data-desktop-view="inventory"], .side-link[data-desktop-view="purchase"], .side-link[data-desktop-view="quality"]')
      .forEach((a) => { a.hidden = true; });
  }

  /* 四个模块页（外协 / 库存 / 采购 / 质量）是各自 js 建出来的 section。
     两个坑：
       ① app.js 的 showDesktopView 只认它自己那 11 个页面，不认这四个；
       ② app.js 给侧栏项绑点击是它自己加载时一次性做的，而模块的侧栏链接是模块 js 后来才建的 —— 没绑上。
     后果：点「查看 →」过去以后，app.js 一刷新（比如角色识别完 applyRoleUI）又把「实时总览」显回来，
     两个页面叠在一起，用户看着就像"没跳过去"。
     所以这四个模块单独走一条路：先让模块自己的逻辑跑一遍，再把常规页全部藏掉，并加一道护栏。 */
  const MODULE_PAGE_IDS = {
    partners: 'desktopPartnersView',
    outsource: 'desktopOutsourceView', inventory: 'desktopInventoryView',
    purchase: 'desktopPurchaseView',   quality: 'desktopQualityView'
  };
  const BASE_PAGE_IDS = [
    'desktopView', 'desktopRemainingView', 'desktopShipmentsView', 'desktopFilesView',
    'desktopDrawingsView', 'desktopPricesView', 'desktopLoadingView',
    'desktopWorkReportView', 'desktopWorkReviewView', 'desktopWorkEditView', 'desktopAttendanceView'
  ];
  function hideBasePages() {
    BASE_PAGE_IDS.forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
  }
  /* 这四个模块的 css/js 不在 index.html 里了，打开对应页面时才加载（首屏少 8 个请求） */
  const MODULE_ASSETS = {
    outsource: ['outsource.css', 'outsource.js'], inventory: ['inventory.css', 'inventory.js'],
    purchase: ['purchase.css', 'purchase.js'],   quality: ['quality.css', 'quality.js']
  };
  const moduleLoaded = {};
  function assetVersionQuery() {
    try {
      const l = document.querySelector('link[href*="dashboard-home.css"], link[href*="design-tokens.css"]');
      if (l) return new URL(l.href, location.href).search || '';
    } catch { }
    return '';
  }
  function loadModuleAssets(view) {
    const list = MODULE_ASSETS[view];
    if (!list || moduleLoaded[view]) return;
    moduleLoaded[view] = true;
    const v = assetVersionQuery();
    list.forEach((f) => {
      if (f.endsWith('.css')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = f + v;
        document.head.appendChild(l);
      } else {
        const s = document.createElement('script');
        s.src = f + v; s.defer = true;
        document.head.appendChild(s);
      }
    });
  }
  function goModule(view) {
    const id = MODULE_PAGE_IDS[view];
    if (!id) return false;
    if (!isAdmin()) return false;      // 普通端只保留以前的功能：这四个模块不给进
    loadModuleAssets(view);
    const open = () => {
      const sec = document.getElementById(id);
      if (!sec) return false;
      const link = document.querySelector('.side-link[data-desktop-view="' + view + '"]');
      if (link) link.click();     // 让模块自己的逻辑跑（showMine + 拉数据）
      sec.hidden = false;
      hideBasePages();
      return true;
    };
    if (open()) { window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
    // 模块页还没建好（第一次进来它要加载数据）→ 等一下再开
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      const ok = open();
      if (ok || tries > 40) {
        clearInterval(t);
        if (ok) window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 300);
    return true;
  }
  window.tkGoModule = goModule;
  // 护栏：模块页开着的时候，别让 app.js 把「实时总览」之类的常规页显回来
  function guardModulePages() {
    const fix = () => {
      const active = Object.values(MODULE_PAGE_IDS).some((id) => {
        const el = document.getElementById(id);
        return el && !el.hidden;
      });
      if (!active) return;
      BASE_PAGE_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.hidden) el.hidden = true;
      });
    };
    fix();
    try {
      const main = document.querySelector('main.main-area');
      if (main) new MutationObserver(fix).observe(main, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    } catch { }
  }

  // 跳转：优先点原始链接（让 app.js 自己的逻辑跑一遍）
  function openRemainingPage() {
    const link = document.querySelector('.side-link[data-desktop-view="remaining"]');
    if (link) link.click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function goView(view) {
    if (view === 'remaining') { openRemainingPage(); return; }
    if (view === 'work') {
      const l = document.querySelector('.side-link[data-desktop-view="workReport"]');
      if (l) l.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (goModule(view)) return;          // 外协/库存/采购/质量：走上面的专用跳转
    const link = document.querySelector('.side-link[data-desktop-view="' + view + '"]');
    if (link) { link.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    // 兜底：直接切 section
    document.querySelectorAll('.desktop-view').forEach((s) => { s.hidden = SECTION_TO_VIEW[s.id] !== view; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function openOverviewMaterial() {
    openRemainingPage();
    setMergeView('orders');
  }

  // 高亮跟随实际显示的页面（app.js 切页时不会通知我们，用轻量轮询）
  function watchActive() {
    setInterval(() => {
      const shown = [...document.querySelectorAll('.desktop-view')].find((s) => !s.hidden);
      const view = shown ? (SECTION_TO_VIEW[shown.id] || '') : '';
      if (view === lastActive) return;
      lastActive = view;
      paintWorkTabs(view);
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

    mergeEverything();
    buildNav();
    buildWorkTabs();
    watchActive();
    guardModulePages();

    // 老链接兜底：#remaining 或 #overview 直接进实时总览
    const hash = (location.hash || '').replace('#', '');
    if (hash === 'remaining') { openOverviewMaterial(); }
    else if (hash === 'overview') { goView('overview'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
