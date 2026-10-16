/* ============================================================
   帆顺看板 · 界面细节增强
   文件：public/ui-polish.js        建立日期：2026-10-16
   内容：① 行距/列距可调（3 档预设 + 自己调，记住选择）
         ② 日期框统一样式 + 快捷「今天」
         ③ 点一行看详情抽屉（可跳图纸 / 去装车 / 查发货记录）
   设计原则：只挂事件、只加类名，不改任何原有函数，也不动数据。
             删掉 index.html 里的 <script> 那一行即可完全回滚。
   ============================================================ */
(() => {
  'use strict';

  const LS_DENSITY = 'shipmentBoardDensity';
  const LS_THEME = 'shipmentBoardTheme';
  const LS_HOME = 'shipmentBoardHome';
  const LS_KEY_REMAINING = 'desktopRemainingColumnWidths';
  const LS_KEY_ORDERS = 'desktopOrdersColumnWidths';

  /* ============================================================
     ① 行距 / 列距
     ============================================================ */
  const PRESETS = {
    compact: { y: 6,  x: 6,  fs: 12.5, lh: 1.3 },
    normal:  { y: 10, x: 8,  fs: 13,   lh: 1.4 },
    roomy:   { y: 14, x: 12, fs: 13.5, lh: 1.5 }
  };
  const MODE_LABEL = { compact: '紧凑', normal: '标准', roomy: '宽松', custom: '自定义' };

  let density = { mode: 'normal', ...PRESETS.normal };

  function loadDensity() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_DENSITY) || 'null');
      if (raw && typeof raw === 'object') {
        const mode = MODE_LABEL[raw.mode] ? raw.mode : 'custom';
        density = {
          mode,
          y: clampNum(raw.y, 4, 18, PRESETS.normal.y),
          x: clampNum(raw.x, 4, 24, PRESETS.normal.x),
          fs: clampNum(raw.fs, 12, 15, PRESETS.normal.fs),
          lh: clampNum(raw.lh, 1.2, 1.75, PRESETS.normal.lh)
        };
      }
    } catch { /* 用默认值 */ }
  }
  function saveDensity() {
    try { localStorage.setItem(LS_DENSITY, JSON.stringify(density)); } catch { }
  }
  function clampNum(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function applyDensity() {
    // data-density 既是"启用了 token 层"的开关，也给 CSS 一个可挂钩的属性
    document.body.dataset.density = density.mode;
    const s = document.body.style;
    s.setProperty('--tk-row-y', density.y + 'px');
    s.setProperty('--tk-row-x', density.x + 'px');
    s.setProperty('--tk-cell-fs', density.fs + 'px');
    s.setProperty('--tk-cell-lh', String(density.lh));
    updatePreview();
    syncPopUi();
  }

  /* ---------- 设置面板 ---------- */
  let pop = null, popBtn = null;

  function buildSettingsUi() {
    const foot = document.querySelector('.sidebar-foot');
    if (!foot || document.getElementById('tkDisplayButton')) return;

    popBtn = document.createElement('button');
    popBtn.type = 'button';
    popBtn.id = 'tkDisplayButton';
    popBtn.className = 'tk-display-btn';
    popBtn.setAttribute('aria-expanded', 'false');
    popBtn.setAttribute('aria-haspopup', 'dialog');
    popBtn.textContent = '行距 / 列距';
    foot.insertBefore(popBtn, foot.firstChild);

    pop = document.createElement('div');
    pop.className = 'tk-pop tk-host';
    pop.id = 'tkDisplayPop';
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '行距与列距设置');
    pop.innerHTML = `
      <h4>主题 <span>随时可切回</span></h4>
      <div class="tk-seg" role="group">
        <button type="button" data-theme-pick="teal">墨绿</button>
        <button type="button" data-theme-pick="ui">Ui 试验</button>
      </div>
      <h4>主页 <span>面板＝上面加功能块</span></h4>
      <div class="tk-seg" role="group">
        <button type="button" data-home-pick="list">清单</button>
        <button type="button" data-home-pick="panel">面板</button>
      </div>
      <h4>行距 / 列距 <span>只影响表格</span></h4>
      <div class="tk-seg" role="group">
        <button type="button" data-preset="compact">紧凑</button>
        <button type="button" data-preset="normal">标准</button>
        <button type="button" data-preset="roomy">宽松</button>
      </div>
      <div class="tk-row">
        <div class="lb">行 · 上下内边距 <b data-out="y"></b></div>
        <input type="range" data-in="y" min="4" max="18" step="1">
      </div>
      <div class="tk-row">
        <div class="lb">列 · 左右内边距 <b data-out="x"></b></div>
        <input type="range" data-in="x" min="4" max="24" step="1">
      </div>
      <div class="tk-row">
        <div class="lb">表体字号 <b data-out="fs"></b></div>
        <input type="range" data-in="fs" min="12" max="15" step="0.5">
      </div>
      <div class="tk-preview" data-preview></div>
      <div class="tk-actions">
        <button type="button" data-act="reset-cols">重置列宽</button>
        <button type="button" class="primary" data-act="reset-density">恢复默认</button>
      </div>`;
    document.body.appendChild(pop);

    popBtn.addEventListener('click', () => togglePop());
    pop.addEventListener('click', (e) => {
      const homePick = e.target.closest('[data-home-pick]');
      if (homePick) {
        home = homePick.dataset.homePick === 'panel' ? 'panel' : 'list';
        saveHome(); applyHome(); syncPopUi();
        showTip(home === 'panel' ? '主页已切换成面板视图' : '主页已回到清单视图');
        return;
      }
      const themePick = e.target.closest('[data-theme-pick]');
      if (themePick) {
        theme = themePick.dataset.themePick === 'ui' ? 'ui' : 'teal';
        saveTheme(); applyTheme(); syncPopUi();
        showTip(theme === 'ui' ? '已切到 Ui 主题（试验）' : '已切回墨绿主题');
        return;
      }
      const preset = e.target.closest('[data-preset]');
      if (preset) {
        const key = preset.dataset.preset;
        density = { mode: key, ...PRESETS[key] };
        saveDensity(); applyDensity(); return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'reset-density') {
        density = { mode: 'normal', ...PRESETS.normal };
        saveDensity(); applyDensity();
        showTip('已恢复默认行距列距');
      } else if (act.dataset.act === 'reset-cols') {
        try {
          localStorage.removeItem(LS_KEY_REMAINING);
          localStorage.removeItem(LS_KEY_ORDERS);
        } catch { }
        document.querySelectorAll('table colgroup col').forEach((col, i) => { col.style.width = ''; });
        showTip('列宽已重置，刷新后生效');
      }
    });
    pop.addEventListener('input', (e) => {
      const key = e.target.dataset ? e.target.dataset.in : null;
      if (!key) return;
      density[key] = Number(e.target.value);
      density.mode = 'custom';
      saveDensity(); applyDensity();
    });

    document.addEventListener('click', (e) => {
      if (!pop || pop.hidden) return;
      if (e.target.closest('#tkDisplayPop') || e.target.closest('#tkDisplayButton')) return;
      closePop();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pop && !pop.hidden) closePop();
    });
    window.addEventListener('resize', () => { if (pop && !pop.hidden) positionPop(); });
  }

  function positionPop() {
    if (!pop || !popBtn) return;
    const r = popBtn.getBoundingClientRect();
    const h = pop.offsetHeight || 320;
    pop.style.left = Math.round(r.right + 12) + 'px';
    const top = Math.max(12, Math.min(r.bottom - h, window.innerHeight - h - 12));
    pop.style.top = Math.round(top) + 'px';
  }
  function togglePop() {
    if (!pop) return;
    if (pop.hidden) {
      pop.hidden = false;
      positionPop();
      popBtn.setAttribute('aria-expanded', 'true');
    } else closePop();
  }
  function closePop() {
    if (!pop) return;
    pop.hidden = true;
    if (popBtn) popBtn.setAttribute('aria-expanded', 'false');
  }

  function syncPopUi() {
    if (!pop) return;
    pop.querySelectorAll('[data-theme-pick]').forEach((b) => {
      b.classList.toggle('on', b.dataset.themePick === theme);
    });
    pop.querySelectorAll('[data-home-pick]').forEach((b) => {
      b.classList.toggle('on', b.dataset.homePick === home);
    });
    pop.querySelectorAll('[data-preset]').forEach((b) => {
      b.classList.toggle('on', b.dataset.preset === density.mode);
    });
    ['y', 'x', 'fs'].forEach((k) => {
      const input = pop.querySelector(`[data-in="${k}"]`);
      const out = pop.querySelector(`[data-out="${k}"]`);
      if (input) input.value = density[k];
      if (out) out.textContent = k === 'fs' ? density.fs + 'px' : density[k] + 'px';
    });
  }

  function updatePreview() {
    if (!pop) return;
    const box = pop.querySelector('[data-preview]');
    if (!box) return;
    const rowH = Math.round(density.y * 2 + density.fs * density.lh + 1);
    const perScreen = Math.max(1, Math.floor(720 / rowH));
    box.innerHTML = `<span>单行行高约 <b>${rowH}px</b></span>` + `<span>720px 可见区约 <b>${perScreen}</b> 行</span>`;
  }

  function showTip(text) {
    if (typeof window.showToast === 'function') { window.showToast(text); return; }
    let el = document.getElementById('tkTip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tkTip';
      el.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:9500;'
        + 'padding:9px 16px;border-radius:10px;background:#09282f;color:#fff;font-size:13px;'
        + 'box-shadow:0 12px 30px rgba(9,40,47,.3);opacity:0;transition:opacity .2s ease';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  /* ---------- 主页：清单（默认） / 面板 ---------- */
  let home = 'list';
  // 2026-10-17：加 URL 参数 ?home=panel / ?home=list，方便手机或别的电脑直接打开某一视图
  //（手机宽度下侧栏是隐藏的，点不到那个开关；参数只影响本次打开，不写进 localStorage）
  let homeFromUrl = '';
  function readHomeFromUrl() {
    try {
      const v = String(new URLSearchParams(location.search).get('home') || '').toLowerCase();
      homeFromUrl = (v === 'panel' || v === 'list') ? v : '';
    } catch { homeFromUrl = ''; }
  }
  function loadHome() {
    readHomeFromUrl();
    if (homeFromUrl) { home = homeFromUrl; return; }
    try { home = String(localStorage.getItem(LS_HOME) || '') === 'panel' ? 'panel' : 'list'; }
    catch { home = 'list'; }
  }
  function saveHome() { if (homeFromUrl) return; try { localStorage.setItem(LS_HOME, home); } catch { } }
  function applyHome() {
    if (home === 'panel') document.body.dataset.home = 'panel';
    else delete document.body.dataset.home;
    window.dispatchEvent(new CustomEvent('tk-home-change'));
  }
  /* ---------- 主题：墨绿（默认） / Ui（试验） ---------- */
  let theme = 'ui';   // 2026-10-16 阿泽定：Ui 冷灰设为默认（点「墨绿」可切回）
  function loadTheme() {
    try {
      const raw = String(localStorage.getItem(LS_THEME) || '');
      theme = raw === 'teal' ? 'teal' : 'ui';   // 没存过就默认 ui
    } catch { theme = 'teal'; }
  }
  function saveTheme() {
    try { localStorage.setItem(LS_THEME, theme); } catch { }
  }
  function applyTheme() {
    if (theme === 'ui') document.body.dataset.theme = 'ui';
    else delete document.body.dataset.theme;
  }
  /* ============================================================
     ② 日期框：统一规格 + 快捷「今天」
     ============================================================ */
  const DATE_TITLES = {
    desktopDueDate: '按交货日期筛选',
    historyDate: '按发货日期筛选',
    offsetDate: '按冲抵日期筛选',
    overDate: '按登记日期筛选',
    replacementHistoryDate: '按补发日期筛选',
    recordsDate: '按发货日期查看',
    recordsOffsetDate: '按冲抵日期查看',
    recordsOverDate: '按登记日期查看',
    recordsReplacementDate: '按补发日期查看',
    deliveryDate: '送货日期',
    desktopWorkReportDate: '报工日期',
    desktopWorkEditDate: '要修改哪一天的报工',
    workEntryEditDate: '工作日期',
    mobileWorkReportDate: '报工日期',
    mobileWorkEditDate: '要修改哪一天的报工',
    desktopAttendanceTeamDate: '考勤日期',
    mobileAttendanceTeamDate: '考勤日期',
    replacementDueDate: '补发交期',
    orderEditDue: '交货日期'
  };
  // 这些是"筛选条件"，给它们加「今天」按钮；模态框里的日期不要加
  const QUICK_IDS = new Set([
    'desktopDueDate', 'historyDate', 'offsetDate', 'overDate', 'replacementHistoryDate',
    'recordsDate', 'recordsOffsetDate', 'recordsOverDate', 'recordsReplacementDate',
    'deliveryDate', 'desktopWorkReportDate', 'desktopWorkEditDate', 'workEntryEditDate',
    'mobileWorkReportDate', 'mobileWorkEditDate', 'desktopAttendanceTeamDate', 'mobileAttendanceTeamDate'
  ]);

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function setDateValue(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function polishDates() {
    document.querySelectorAll('input[type="date"]').forEach((input) => {
      if (input.dataset.tkDate === '1') return;
      input.dataset.tkDate = '1';
      input.classList.add('tk-date');
      const title = DATE_TITLES[input.id] || input.title || '选择日期';
      input.title = title;
      if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', title);
      if (QUICK_IDS.has(input.id) && !input.parentElement?.querySelector('.tk-date-quick')) {
        const quick = document.createElement('button');
        quick.type = 'button';
        quick.className = 'tk-date-quick';
        quick.textContent = '今天';
        quick.title = '设为今天';
        quick.addEventListener('click', () => setDateValue(input, todayStr()));
        input.insertAdjacentElement('afterend', quick);
      }
    });
  }

  /* ============================================================
     ③ 点一行 → 详情抽屉
     ============================================================ */
  let drawer = null, backdrop = null, currentRow = null;

  function cellText(td) {
    const clone = td.cloneNode(true);
    clone.querySelectorAll('button, .col-resizer, .tk-date-quick').forEach((n) => n.remove());
    return clone.innerText.replace(/\s+/g, ' ').trim();
  }

  function buildDrawer() {
    if (drawer) return;
    backdrop = document.createElement('div');
    backdrop.className = 'tk-backdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);

    drawer = document.createElement('aside');
    drawer.className = 'tk-drawer tk-host';
    drawer.id = 'tkDrawer';
    drawer.hidden = true;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', '订单详情');
    drawer.innerHTML = '<header><div class="ttl"></div><button type="button" class="tk-x" aria-label="关闭">✕</button></header>'
      + '<div class="tk-body"></div>'
      + '<footer></footer>';
    document.body.appendChild(drawer);

    backdrop.addEventListener('click', closeDrawer);
    drawer.querySelector('.tk-x').addEventListener('click', closeDrawer);
    drawer.querySelector('footer').addEventListener('click', onDrawerAction);
    drawer.querySelector('.tk-body').addEventListener('click', (e) => {
      const copy = e.target.closest('.copy');
      if (!copy) return;
      copyText(copy.dataset.copy || '', '已复制');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer && !drawer.hidden) closeDrawer();
    });
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('on');
    if (backdrop) {
      backdrop.classList.remove('on');
      setTimeout(() => { if (backdrop) backdrop.hidden = true; }, 180);
    }
    setTimeout(() => { if (drawer) drawer.hidden = true; }, 200);
    currentRow = null;
  }

  function copyText(text, tip) {
    if (!text) return;
    const done = () => showTip(tip || '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch { showTip('复制失败，请手动选中'); }
  }

  function rowInfo(tr) {
    const table = tr.closest('table');
    const isOrders = table.classList.contains('orders-table');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.innerText.replace(/\s+/g, ' ').trim());
    const fields = [];
    [...tr.children].forEach((td, i) => {
      if (td.classList.contains('col-spacer') || td.hasAttribute('colspan')) return;
      const value = cellText(td);
      const label = heads[i] || '';
      if (!label && !value) return;
      fields.push({ label, value });
    });
    const pick = (sel, idx) => {
      const el = tr.querySelector(sel);
      if (el) return el.textContent.replace(/\s+/g, ' ').trim();
      const td = tr.children[idx];
      return td ? cellText(td) : '';
    };
    return {
      isOrders,
      fields,
      drawing: tr.querySelector('.drawing-link') || null,
      name: isOrders ? pick('.item-name', 2) : pick(null, 2),
      material: isOrders ? pick('.material-code', 1) : pick(null, 1),
      spec: isOrders ? pick('.spec-code', 3) : pick(null, 3),
      po: isOrders ? pick('.order-id', 0) : ''
    };
  }

  function openDrawerFor(tr) {
    buildDrawer();
    const info = rowInfo(tr);
    currentRow = tr;

    const title = info.name || info.material || '明细';
    const sub = [info.material, info.po, info.spec].filter(Boolean).join(' · ');
    drawer.querySelector('.ttl').innerHTML = `<b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small>`;

    const emphasize = new Set(['未交', '剩余未交', '未交数量', '交货日期', '交期']);
    const list = info.fields.map((f) => {
      const isNum = /^-?[\d,.\s]+$/.test(f.value);
      let cls = '';
      if (f.label.includes('未交') || f.label.includes('剩余')) cls = 'hi';
      if (f.value.includes('逾期')) cls = 'warn';
      const copy = (f.label.includes('编号') || f.label.includes('图号') || f.label.includes('物料'))
        ? `<button type="button" class="copy" data-copy="${escapeHtml(f.value)}">复制</button>` : '';
      const val = f.value ? escapeHtml(f.value) : '<span style="color:#b3c0c3">—</span>';
      return `<dt>${escapeHtml(f.label)}</dt><dd class="${cls}${isNum ? '' : ''}">${val}${copy}</dd>`;
    }).join('');

    drawer.querySelector('.tk-body').innerHTML = `<section class="tk-sec"><b>${info.isOrders ? '订单信息' : '未交明细'}</b><dl>${list}</dl></section>`;

    const hasInlineDrawing = !!info.drawing;
    drawer.querySelector('footer').innerHTML =
      `<button type="button" data-act="drawing">${hasInlineDrawing ? '看图纸' : '去图纸库找'}</button>`
      + '<button type="button" data-act="loading">去装车</button>'
      + '<button type="button" data-act="history">查发货记录</button>'
      + '<button type="button" class="primary" data-act="copy">复制料号</button>';

    drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add('on');
      if (backdrop) backdrop.classList.add('on');
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function goView(name) {
    const link = document.querySelector(`.side-link[data-desktop-view="${name}"]`);
    if (!link) return false;
    link.click();
    return true;
  }
  function prefill(selector, text) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function onDrawerAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (!currentRow) return;
    const info = rowInfo(currentRow);
    if (act === 'copy') { copyText(info.material, '料号已复制：' + info.material); return; }
    if (act === 'drawing') {
      if (info.drawing) { info.drawing.click(); closeDrawer(); return; }
      goView('drawings');
      setTimeout(() => {
        const q = info.spec || info.material;
        if (!prefill('#drawingSearch', q)) showTip('图纸库里搜：' + q);
      }, 60);
      closeDrawer();
      return;
    }
    if (act === 'loading') {
      goView('loading');
      setTimeout(() => prefill('#desktopLoadingSearch', info.material), 60);
      closeDrawer();
      return;
    }
    if (act === 'history') {
      goView('shipments');
      setTimeout(() => prefill('#historySearch', info.material), 60);
      closeDrawer();
    }
  }

  function installRowClicks() {
    document.addEventListener('click', (e) => {
      // 点按钮/链接/输入框/列宽拖动手柄时不打开抽屉
      if (e.target.closest('button, a, input, select, textarea, label, .col-resizer, .history-col-resizer')) return;
      if (e.target.closest('#tkDrawer, #tkDisplayPop')) return;
      const tr = e.target.closest('#desktopTableBody tr, #desktopRemainingBody tr');
      if (!tr) return;
      if (tr.querySelector('[colspan]')) return;           // 「加载更多」那一行
      if (!tr.children.length || tr.children.length < 2) return;
      openDrawerFor(tr);
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  function debounce(fn, ms) {
    let t = 0;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function init() {
    loadDensity();
    loadTheme();
    loadHome();
    buildSettingsUi();
    applyDensity();
    applyTheme();
    applyHome();
    polishDates();
    buildDrawer();
    installRowClicks();
    try {
      new MutationObserver(debounce(polishDates, 400))
        .observe(document.body, { childList: true, subtree: true });
    } catch { }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();


