/* ============================================================
   主页「面板」视图 —— 一进来就能读到关键信息
   文件：public/dashboard-home.js     建立日期：2026-10-16（第 2 版）
   第 2 版改了什么：
     ① 加「下一次交货的未交详情」「今日报工（计时/计件）详情」「今日考勤详情」
     ② 删掉「快捷动作」块（实际不好用、不显眼、别人不知道能点）
     ③ 数字块改成"静态"，每个区块右上角给明确的「查看 →」，不再靠猜能不能点
   数据来源（全部只读）：
     发货：/api/state（本地）或 board_get_state（云端）
     报工：work_admin_report_list / work_admin_work_overview
     考勤：board_attendance_summary
   权限：报工与考勤只对管理员取；普通模式自动隐藏这两块。
   回滚：删掉 index.html 底部这一行 <script> 即可。
   ============================================================ */
(() => {
  'use strict';

  const REFRESH_MS = 60000;
  let state = null, work = null, att = null, os = null, inv = null, pur = null, ql = null;
  let osList = [], puList = [], qlList = [];   // 三个模块的完整列表（板块的页签要用）
  let workErr = false, attErr = false, osErr = false;
  let lastFetch = 0, timer = 0, inflight = false, stateAt = 0, modulesTried = false;
  let duePicks = new Set();   // 未交明细小板块的交期多选（空 = 全部）

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const isAdmin = () => document.body.dataset.boardRole === 'admin';

  /* ---------------- 取数 ---------------- */
  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }
  function rpcHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) {
      h.apikey = window.SHIPMENT_ANON_KEY;
      h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY;
    }
    return h;
  }
  // 统一返回 { ok, data }：成功 ok=true + 解析后的 JSON；失败 ok=false + error
  async function rpc(name, payload) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return { ok: false, error: '本地模式没有云端接口' };
    try {
      const r = await fetch(base + '/' + name, {
        method: 'POST', headers: rpcHeaders(),
        body: JSON.stringify({ p_code: readCode(), ...payload })
      });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
        return { ok: false, error: msg, missingTable: /does not exist|could not find|42883|PGRST202/i.test(msg) };
      }
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function fetchState() {
    const code = readCode();
    const base = window.SHIPMENT_RPC_BASE || '';
    try {
      if (base) { const gs = await rpc('board_get_state', {}); return gs.ok ? gs.data : null; }
      const h = rpcHeaders();
      if (code) h['X-Board-Code'] = code;
      const r = await fetch((window.SHIPMENT_API_BASE || '') + '/api/state', { headers: h, cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  /* 读 app.js 写在本地的数据缓存（{code, savedAt, snapshot}）——
     有它就能毫秒级先把面板画出来，不用干等 385KB 的接口回来。 */
  function readStateCache() {
    try {
      const mode = new URLSearchParams(location.search).get('mode');
      const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
      const c = JSON.parse(localStorage.getItem('shipmentBoardStateCache' + suffix) || 'null');
      if (!c || !c.snapshot || !Array.isArray(c.snapshot.orders)) return null;
      if (!c.code || c.code !== readCode()) return null;
      return { snapshot: c.snapshot, savedAt: Number(c.savedAt || 0) };
    } catch { return null; }
  }
  function monthBounds(day) {
    const [y, m] = String(day).split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const p = (n) => String(n).padStart(2, '0');
    return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(last)}` };
  }

  /* ---------------- 算 ---------------- */
  const dayDiff = (iso, today) => Math.round(
    (Date.parse(String(iso).slice(0, 10) + 'T00:00:00') - Date.parse(today + 'T00:00:00')) / 86400000);
  const md = (iso) => { const p = String(iso || '').slice(5, 10).split('-'); return p.length === 2 ? `${+p[0]}月${+p[1]}日` : '—'; };
  const hm = (min) => { const m = Number(min || 0); return m >= 60 ? `${Math.floor(m / 60)}小时${m % 60 ? (m % 60) + '分' : ''}` : `${m}分`; };

  function computeAll() {
    if (!state || !Array.isArray(state.orders)) return null;
    const today = String(state.today || '').slice(0, 10);
    const open = state.orders.filter((o) => Number(o.remaining) > 0);
    const shipments = Array.isArray(state.shipments) ? state.shipments : [];
    const sum = (rows) => rows.reduce((s, o) => s + Number(o.remaining || 0), 0);

    const overdue = open.filter((o) => dayDiff(o.dueDate, today) < 0);
    const dueToday = open.filter((o) => dayDiff(o.dueDate, today) === 0);
    const future = open.filter((o) => dayDiff(o.dueDate, today) >= 0)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const nextDate = future.length ? String(future[0].dueDate).slice(0, 10) : '';
    const nextRows = nextDate ? future.filter((o) => String(o.dueDate).slice(0, 10) === nextDate) : [];

    const bucket = { tomorrow: [], week: [], half: [], far: [] };
    for (const o of future) {
      const d = dayDiff(o.dueDate, today);
      if (d === 1) bucket.tomorrow.push(o);
      else if (d >= 2 && d <= 7) bucket.week.push(o);
      else if (d >= 8 && d <= 15) bucket.half.push(o);
      else if (d > 15) bucket.far.push(o);
    }

    const shippedAll = state.orders.reduce((s, o) => s + Number(o.shipped || 0), 0);
    const remainQty = sum(open);
    const total = shippedAll + remainQty;

    const byMaterial = new Map();
    for (const o of open) {
      const k = String(o.material || '—').trim();
      if (!byMaterial.has(k)) byMaterial.set(k, { material: k, name: o.name || '', qty: 0, orders: 0, earliest: o.dueDate });
      const g = byMaterial.get(k);
      g.qty += Number(o.remaining || 0); g.orders += 1;
      if (String(o.dueDate) < String(g.earliest)) g.earliest = o.dueDate;
    }

    const todayShips = shipments.filter((s) => String(s.createdAt || '').slice(0, 10) === today)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const recentShips = (todayShips.length ? todayShips : shipments.slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))).slice(0, 6);

    return {
      today, open, overdue, dueToday, nextDate, nextRows,
      overdueQty: sum(overdue), todayQty: sum(dueToday),
      nextQty: sum(nextRows),
      bucketQty: { tomorrow: sum(bucket.tomorrow), week: sum(bucket.week), half: sum(bucket.half), far: sum(bucket.far) },
      bucketRows: bucket,
      remainQty, shippedQty: shippedAll,
      doneRate: total ? Math.round((shippedAll / total) * 100) : 0,
      shipCount: shipments.length,
      top: [...byMaterial.values()].sort((a, b) => b.qty - a.qty).slice(0, 6),
      todayShipCount: todayShips.length,
      todayShipQty: todayShips.reduce((s, x) => s + Number(x.totalQuantity || 0), 0),
      recentShips
    };
  }

  function computeWork(c) {
    if (!work) return null;
    const rows = Array.isArray(work.live) ? work.live : [];
    const rep = work.report || {};
    const summary = rep.summary || {};
    const entries = Array.isArray(rep.rows) ? rep.rows : [];
    const onDuty = rows.filter((r) => Number(r.timerMinutes || 0) > 0 || Number(r.pieceQuantity || 0) > 0 || (r.activeTimer && !r.activeTimer.endedAt));
    const counting = rows.filter((r) => r.activeTimer && !r.activeTimer.endedAt);
    return {
      entries, onDuty, counting,
      entriesCount: Number(summary.entries || entries.length || 0),
      quantity: Number(summary.quantity || 0),
      amount: Number(summary.amount || 0),
      pending: Number(summary.pending || 0),
      approved: Number(summary.approved || 0)
    };
  }

  function computeAtt(c) {
    if (!att) return null;
    const rows = Array.isArray(att.summary) ? att.summary : [];
    const s = (k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
    const bad = rows
      .map((r) => ({ ...r, score: Number(r.absentDays || 0) * 3 + Number(r.missingOnceDays || 0) * 2 + Number(r.lateDays || 0) + Number(r.overdueDays || 0) * 2 }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
    return {
      headcount: rows.length,
      attendanceDays: s('attendanceDays'),
      absentDays: s('absentDays'),
      lateDays: s('lateDays'),
      missingOnce: s('missingOnceDays'),
      overtimeAmount: s('overtimeAmount'),
      bad
    };
  }

  /* ---------------- 渲染 ---------------- */
  const stat = ({ label, value, unit, hint, hot, tone }) =>
    `<div class="tk-stat is-static${hot ? ' hot' : ''}${tone === 'quiet' ? ' quiet' : ''}">
      <span>${esc(label)}</span><b>${esc(value)}</b><i>${esc(unit || '')}${hint ? (unit ? ' · ' : '') + esc(hint) : ''}</i>
    </div>`;

  const secHead = (title, sub, view, viewLabel) =>
    `<div class="tk-dash-h"><b>${esc(title)}</b>
      ${sub ? `<span class="tk-dash-sub">${esc(sub)}</span>` : ''}
      ${view ? `<button type="button" class="tk-more" data-act="go" data-view="${esc(view)}">${esc(viewLabel || '查看')} →</button>` : ''}
    </div>`;

  /* 小板块的列标题：跟 .tk-md-row 共用一套网格，一眼就知道每列是什么 */
  const mdHead = (a, b, c, d) =>
    '<div class="tk-md-head"><em>' + a + '</em><span>' + b + '</span><b>' + c + '</b><i>' + d + '</i></div>';

  /* ---- 顶部两块：未交明细（小板块·内部滚动）+ 试制/承样 ---- */
  function buildTop(c) {
    const byDate = new Map();
    for (const o of c.open) {
      const d = String(o.dueDate || '').slice(0, 10);
      if (d) byDate.set(d, (byDate.get(d) || 0) + 1);
    }
    const dates = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const chips = `<button type="button" class="tk-due-chip${duePicks.size ? '' : ' on'}" data-act="due-pick" data-d="">全部<em>${c.open.length}</em></button>`
      + dates.map(([d, n]) => {
        const diff = dayDiff(d, c.today);
        const cls = 'tk-due-chip' + (duePicks.has(d) ? ' on' : '') + (diff < 0 ? ' late' : (diff === 0 ? ' today' : ''));
        const label = md(d) + (diff < 0 ? '·逾期' : (diff === 0 ? '·今天' : ''));
        return `<button type="button" class="${cls}" data-act="due-pick" data-d="${d}" title="可多选日期">${label}<em>${n}</em></button>`;
      }).join('');

    const rows = c.open
      .filter((o) => duePicks.size === 0 || duePicks.has(String(o.dueDate || '').slice(0, 10)))
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || (Number(b.remaining) - Number(a.remaining)))
      .slice(0, 300);
    const listHtml = rows.length ? rows.map((o) => {
      const d = String(o.dueDate || '').slice(0, 10);
      const diff = dayDiff(d, c.today);
      const late = diff < 0;
      return `<button type="button" class="tk-md-row" data-act="mk" data-q="${esc(o.material)}">
          <em class="po">${esc(o.po || '—')}</em>
          <em class="mk">${esc(o.material)}</em>
          <span>${esc(o.name || '')}</span>
          <em class="spec">${esc(o.spec || '—')}</em>
          <b class="qty${late ? ' late' : ''}">${num(o.remaining)}</b>
          <i class="due${late ? ' late' : ''}">${md(d)}${late ? ' 逾期' + (-diff) + '天' : (diff === 0 ? ' 今天' : '')}</i>
        </button>`;
    }).join('') : '<div class="tk-empty">这个交期下没有未交</div>';

    const TYPE = { trial: '试制', sample: '承样', tooling: '工装' };
    const special = c.open.filter((o) => TYPE[String(o.orderType || '')])
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const spHtml = special.length ? special.slice(0, 200).map((o) => {
      const d = String(o.dueDate || '').slice(0, 10);
      const diff = dayDiff(d, c.today);
      return `<button type="button" class="tk-md-row" data-act="mk" data-q="${esc(o.material || 'MISC')}">
          <em class="kind k-${esc(String(o.orderType || ''))}">${TYPE[o.orderType]}</em>
          <em class="mk">${esc(o.material || 'MISC')}</em>
          <span>${esc(o.name || '')}</span>
          <b class="qty">${num(o.remaining)}</b>
          <i class="due${diff < 0 ? ' late' : ''}">${md(d)}${diff < 0 ? ' 逾期' : ''}</i>
        </button>`;
    }).join('') : '<div class="tk-empty">没有试制 / 承样 / 工装的未交</div>';

    const lateN = c.overdue.length;
    const qlOpen = ql ? Number(ql.openCount || 0) : 0;
    const sub = [
      lateN ? ('逾期 ' + lateN + ' 行') : '没有逾期',
      '下次交期 ' + md(c.nextDate) + ' · ' + c.nextRows.length + ' 行 / ' + num(c.nextQty) + ' 件'
    ].join(' · ');

    return `<div class="tk-dash-2col tk-top">
      <div class="tk-dash-sec tk-sec-due">
        <div class="tk-dash-h">
          <b>未交明细</b>
          <span class="tk-dash-sub${lateN ? ' hot' : ''}">${esc(sub)}</span>
          ${qlOpen ? `<span class="tk-dash-sub hot">质量未结案 ${qlOpen} 条</span>` : ''}
          <button type="button" class="tk-more tk-due-print" data-act="print-due">打印清单</button>
          <button type="button" class="tk-more" data-act="openfull">未交详情 →</button>
        </div>
        <div class="tk-due-bar">${chips}</div>
        <div class="tk-md-head tk-head-due"><em>采购单号</em><em>编号</em><span>名称</span><em class="spec">图号</em><b>未交</b><i>交期</i></div>
        <div class="tk-md-list">${listHtml}</div>
        <div class="tk-more-hint">当前显示 ${rows.length} 行${duePicks.size ? (' · 已选 ' + duePicks.size + ' 个交期') : ' · 全部交期'}；选好后点“打印清单”</div>
      </div>
      <div class="tk-dash-sec tk-sec-special">
        ${secHead('试制 / 承样', special.length ? (special.length + ' 行') : '没有', 'remaining')}
        <div class="tk-md-head tk-head-special"><em>类型</em><em>编号</em><span>名称</span><b>未交</b><i>交期</i></div>
        <div class="tk-md-list">${spHtml}</div>
      </div>
    </div>`;
  }
  /* ============================================================
     三个功能板块（外协 / 采购 / 质量）：一个功能一个板块，板块头切页签
     页签选择记在 localStorage，下次打开还是上次那页
     ============================================================ */
  const BLK_TAB = {};
  function tabBlock(cfg) {
    const active = BLK_TAB[cfg.key] || cfg.tabs[0].k;
    const tabs = cfg.tabs.map((t) =>
      '<button type="button" data-blk="' + cfg.key + '" data-tab="' + t.k + '"' +
      (t.k === active ? ' class="on"' : '') + '>' + esc(t.label) + '</button>').join('');
    const panes = cfg.tabs.map((t) =>
      '<div class="tk-block-pane" data-blk="' + cfg.key + '" data-tab="' + t.k + '"' +
      (t.k === active ? '' : ' hidden') + '>' + t.html + '</div>').join('');
    return '<div class="tk-dash-sec">' +
      '<div class="tk-block-head">' +
        '<div class="tk-block-h1">' +
          '<b>' + esc(cfg.title) + '</b>' +
          (cfg.sub ? '<span class="tk-dash-sub' + (cfg.hot ? ' hot' : '') + '">' + esc(cfg.sub) + '</span>' : '') +
        '</div>' +
        '<div class="tk-block-h2">' +
          '<div class="tk-block-tabs" role="tablist">' + tabs + '</div>' +
          (cfg.view ? '<button type="button" class="tk-more" data-act="go" data-view="' + esc(cfg.view) + '">' + esc(cfg.viewLabel || '查看') + ' →</button>' : '') +
        '</div>' +
      '</div>' + panes + '</div>';
  }
  const pane = (html) => '<div class="tk-md-list">' + html + '</div>';
  const paneH = (h, html) => mdHead(h[0], h[1], h[2], h[3]) + pane(html);
  /* 模块数据还没到时的占位块（避免这一行先空出来、一会儿又冒出来，布局跳一下） */
  const pendingBlock = (title) =>
    '<div class="tk-dash-sec"><div class="tk-block-head"><div class="tk-block-h1"><b>' + esc(title) +
    '</b><span class="tk-dash-sub">读取中…</span></div></div><div class="tk-empty">正在读取…</div></div>';
  const plainRow = (a, b, c, d, o) => {
    o = o || {};
    return '<div class="tk-md-row tk-plain">' +
      '<em' + (o.mono === false ? '' : ' class="mk"') + '>' + a + '</em>' +
      '<span>' + b + '</span>' +
      '<b class="qty' + (o.hot ? ' late' : '') + '">' + c + '</b>' +
      '<i class="due' + (o.hot ? ' late' : '') + '">' + d + '</i></div>';
  };
  const OS_ST = { issued: '在途', partial: '部分到货', received: '已交齐', closed: '已结单', cancelled: '已作废' };
  const Q_DISP = { pending: '待定', rework: '返工', scrap: '报废', concession: '让步接收', return_supplier: '退回供应商', return_outsource: '退回外协厂' };
  const Q_RESP = { self: '本厂', outsource: '外协厂', supplier: '供应商', unknown: '待定' };

  function buildOs() {
    if (!os) return (isAdmin() && !modulesTried) ? pendingBlock('外协') : '';
    const list = Array.isArray(osList) ? osList : [];
    const open = list.filter((r) => r.status === 'issued' || r.status === 'partial');
    const lateN = open.filter((r) => Number(r.overdueDays) > 0).length;

    const planHtml = open.length
      ? open.slice().sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))).slice(0, 80)
          .map((r) => {
            const od = Number(r.overdueDays) || 0;
            return plainRow(esc(md(r.dueDate)) + (od ? '<small class="late">逾期' + od + '天</small>' : ''),
              esc(r.vendor) + '<small>' + esc(r.material) + ' ' + esc(r.name || '') + '</small>',
              num(r.openQty), od ? '催货' : (r.status === 'partial' ? '部分到货' : '在途'), { hot: od > 0 });
          }).join('')
      : '<div class="tk-empty">没有在途外协单</div>';

    const ordHtml = list.length
      ? list.slice().sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || ''))).slice(0, 80)
          .map((r) => plainRow(esc(md(r.issuedAt)),
            esc(r.vendor) + '<small>' + esc(r.material) + ' ' + esc(r.name || '') + '</small>',
            num(r.qty) + ' → ' + num(r.receivedQty), esc(OS_ST[r.status] || r.status))).join('')
      : '<div class="tk-empty">还没有外协单</div>';

    const byV = new Map();
    for (const r of list) {
      const k = String(r.vendor || '—');
      if (!byV.has(k)) byV.set(k, { v: k, n: 0, qty: 0, got: 0, open: 0, late: 0 });
      const g = byV.get(k);
      g.n += 1; g.qty += Number(r.qty || 0); g.got += Number(r.receivedQty || 0); g.open += Number(r.openQty || 0);
      if (Number(r.overdueDays || 0) > 0) g.late += 1;
    }
    const progHtml = byV.size
      ? [...byV.values()].sort((a, b) => b.open - a.open).slice(0, 40).map((g) => {
          const pct = g.qty ? Math.round((g.got / g.qty) * 100) : 0;
          return plainRow(esc(g.v),
            g.n + ' 单 · 已到 ' + num(g.got) + ' / ' + num(g.qty) +
              '<small>' + pct + '% 到货率' + (g.late ? ' · 逾期 ' + g.late + ' 单' : '') + '</small>',
            num(g.open), pct + '%', { hot: g.late > 0, mono: false });
        }).join('')
      : '<div class="tk-empty">还没有外协厂</div>';

    return tabBlock({ key: 'os', title: '外协',
      sub: open.length ? (open.length + ' 单在途 · 欠 ' + num(os.openQty) + ' 件' + (lateN ? ' · 逾期 ' + lateN : '')) : '没有在途外协',
      hot: lateN > 0, view: 'outsource', viewLabel: '外协管理',
      tabs: [ { k: 'plan', label: '计划', html: paneH(['交期', '外协厂 · 料号', '欠数', '状态'], planHtml) },
              { k: 'orders', label: '订单', html: paneH(['下单', '外协厂 · 料号', '数量', '状态'], ordHtml) },
              { k: 'progress', label: '进度', html: paneH(['外协厂', '汇总', '欠数', '到货率'], progHtml) } ] });
  }

  function buildPu() {
    if (!pur) return (isAdmin() && !modulesTried) ? pendingBlock('采购 / 来料') : '';
    const list = Array.isArray(puList) ? puList : [];
    const open = list.filter((r) => r.status === 'ordered' || r.status === 'partial');
    const lateN = open.filter((r) => Number(r.overdueDays) > 0).length;

    const planHtml = open.length
      ? open.slice().sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))).slice(0, 80)
          .map((r) => {
            const od = Number(r.overdueDays) || 0;
            return plainRow(esc(md(r.dueDate)) + (od ? '<small class="late">逾期' + od + '天</small>' : ''),
              esc(r.supplier) + '<small>' + esc(r.material) + ' ' + esc(r.name || '') + '</small>',
              num(r.openQty) + ' ' + esc(r.unit || ''), od ? '催货' : (r.status === 'partial' ? '部分到货' : '在途'), { hot: od > 0 });
          }).join('')
      : '<div class="tk-empty">没有在途采购单</div>';

    const ordHtml = list.length
      ? list.slice().sort((a, b) => String(b.orderedAt || '').localeCompare(String(a.orderedAt || ''))).slice(0, 80)
          .map((r) => plainRow(esc(md(r.orderedAt)),
            esc(r.supplier) + '<small>' + esc(r.material) + ' ' + esc(r.name || '') + '</small>',
            num(r.qty) + ' ' + esc(r.unit || ''), esc(OS_ST[r.status] || r.status))).join('')
      : '<div class="tk-empty">还没有采购单</div>';

    const byS = new Map();
    for (const r of list) {
      const k = String(r.supplier || '—');
      if (!byS.has(k)) byS.set(k, { v: k, n: 0, qty: 0, got: 0, open: 0, late: 0 });
      const g = byS.get(k);
      g.n += 1; g.qty += Number(r.qty || 0); g.got += Number(r.receivedQty || 0); g.open += Number(r.openQty || 0);
      if (Number(r.overdueDays || 0) > 0) g.late += 1;
    }
    const progHtml = byS.size
      ? [...byS.values()].sort((a, b) => b.open - a.open).slice(0, 40).map((g) => {
          const pct = g.qty ? Math.round((g.got / g.qty) * 100) : 0;
          return plainRow(esc(g.v),
            g.n + ' 单 · 已到 ' + num(g.got) + ' / ' + num(g.qty) +
              '<small>' + pct + '% 到货率' + (g.late ? ' · 逾期 ' + g.late + ' 单' : '') + '</small>',
            num(g.open), pct + '%', { hot: g.late > 0, mono: false });
        }).join('')
      : '<div class="tk-empty">还没有供应商</div>';

    return tabBlock({ key: 'pu', title: '采购 / 来料',
      sub: open.length ? (open.length + ' 单在途' + (lateN ? ' · 逾期 ' + lateN : '')) : '没有在途采购',
      hot: lateN > 0, view: 'purchase', viewLabel: '采购 / 来料',
      tabs: [ { k: 'plan', label: '计划', html: paneH(['到货', '供应商 · 料号', '欠数', '状态'], planHtml) },
              { k: 'orders', label: '订单', html: paneH(['下单', '供应商 · 料号', '数量', '状态'], ordHtml) },
              { k: 'recv', label: '到货', html: paneH(['供应商', '汇总', '欠数', '到货率'], progHtml) } ] });
  }

  function buildQl() {
    if (!ql) return (isAdmin() && !modulesTried) ? pendingBlock('质量 / 不良') : '';
    const list = Array.isArray(qlList) ? qlList : [];
    const openRows = list.filter((r) => r.status === 'open');

    const openHtml = openRows.length
      ? openRows.slice(0, 80).map((r) => plainRow(esc(r.process || '未填工序'),
          esc(r.material) + ' ' + esc(r.name || '') + '<small>' + esc(md(r.foundAt)) + ' · ' + esc(r.defect || '未填现象') + '</small>',
          num(r.qty) + ' 件', esc(Q_DISP[r.disposition] || r.disposition), { hot: true, mono: false })).join('')
      : '<div class="tk-empty">没有未结案的不良记录</div>';

    const maxP = Math.max(...((ql.byProcess || []).map((x) => Number(x.qty) || 0)), 1);
    const bar = (x) => '<div class="tk-bar' + (false ? ' hot' : '') + '"><span>' + esc(x.key) + '</span>' +
      '<i><b style="width:' + Math.max(2, Math.round((Number(x.qty) || 0) / maxP * 100)) + '%"></b></i>' +
      '<em>' + num(x.qty) + ' 件<small>' + num(x.count) + ' 条</small></em></div>';
    const statHtml = (Array.isArray(ql.byProcess) && ql.byProcess.length)
      ? '<div class="tk-bars">' + ql.byProcess.map(bar).join('') + '</div>'
      : '<div class="tk-empty">本月还没有不良记录</div>';
    const maxR = Math.max(...((ql.byResponsibility || []).map((x) => Number(x.qty) || 0)), 1);
    const barR = (x) => '<div class="tk-bar"><span>' + esc(x.key) + '</span>' +
      '<i><b style="width:' + Math.max(2, Math.round((Number(x.qty) || 0) / maxR * 100)) + '%"></b></i>' +
      '<em>' + num(x.qty) + ' 件<small>' + num(x.count) + ' 条</small></em></div>';
    const statBlock = statHtml + ((Array.isArray(ql.byResponsibility) && ql.byResponsibility.length)
      ? '<div class="tk-dash-h" style="margin:12px 0 8px"><b style="font-size:12.5px">按责任方</b></div><div class="tk-bars">' + ql.byResponsibility.map(barR).join('') + '</div>'
      : '');

    const allHtml = list.length
      ? list.slice(0, 80).map((r) => plainRow(esc(md(r.foundAt)),
          esc(r.material) + ' ' + esc(r.name || '') + '<small>' + esc(r.process || '未填工序') + ' · ' + esc(r.defect || '未填现象') + '</small>',
          num(r.qty) + ' 件', esc(r.status === 'open' ? '未结案' : '已结案'), { hot: r.status === 'open', mono: false })).join('')
      : '<div class="tk-empty">还没有不良记录</div>';

    return tabBlock({ key: 'ql', title: '质量 / 不良',
      sub: '本月 ' + num(ql.monthQty) + ' 件 · 未结案 ' + num(ql.openCount) + ' 条 · 报废 ' + num(ql.scrapQty) + ' 件',
      hot: Number(ql.openCount) > 0, view: 'quality', viewLabel: '质量 / 不良',
      tabs: [ { k: 'open', label: '未结案', html: paneH(['工序', '料号 · 现象', '数量', '处置'], openHtml) },
              { k: 'stat', label: '统计', html: statBlock },
              { k: 'all', label: '记录', html: paneH(['发现', '料号 · 工序', '数量', '状态'], allHtml) } ] });
  }
  function render() {
    const box = $('#tkDash');
    if (!box) return;
    const c = computeAll();
    if (!c) { box.innerHTML = '<div class="tk-dash-sec"><div class="tk-empty">数据还没到，稍等一下…</div></div>'; return; }
    box.classList.remove('loading');

    const w = computeWork(c);
    const a = computeAtt(c);

    /* 今日报工详情 */
    let workBlock = '';
    if (isAdmin()) {
      if (!w) {
        workBlock = `<div class="tk-dash-sec">${secHead('今日报工（计时 / 计件）', workErr ? '读不到' : '读取中…', 'workReport')}<div class="tk-empty">${workErr ? '要连云端管理端才读得到报工数据（本地演示模式没有这个接口）。点右上角「查看」可打开报工情况页。' : '正在读取报工数据…'}</div></div>`;
      } else {
        const entryRows = w.entries.length
          ? w.entries.slice(0, 6).map((e) => `<div class="tk-li is-static">
              <em>${esc(e.employeeName || e.employeeNo)}</em>
              <span>${esc(e.name || '')}<small>${esc(e.process || '')} · 单价 ${num(e.unitPrice)}${e.variantLabel ? ' · ' + esc(e.variantLabel) : ''}</small></span>
              <b>${num(e.quantity)} 件 <small style="color:var(--muted);font-weight:400">¥${num(e.amount)}</small></b>
            </div>`).join('')
          : '<div class="tk-empty">今天还没有报工记录</div>';
        const countingRows = w.counting.length
          ? w.counting.map((r) => `<div class="tk-li is-static">
              <em>${esc(r.employeeNo)}</em>
              <span>${esc(r.name)}<small>开始 ${String(r.activeTimer.startedAt).slice(11, 16)}</small></span>
              <b class="hot">${hm(r.activeTimer.minutes)}</b>
            </div>`).join('')
          : '<div class="tk-empty">现在没有人正在计时</div>';
        workBlock = `<div class="tk-dash-sec">
          ${secHead('今日报工（计时 / 计件）', `${w.entriesCount} 笔 · ${num(w.quantity)} 件 · ¥${num(w.amount)}`, 'workReport')}
          <div class="tk-stats four" style="margin-bottom:12px">
            ${stat({ label: '报工笔数', value: w.entriesCount, unit: '笔' })}
            ${stat({ label: '报工数量', value: num(w.quantity), unit: '件' })}
            ${stat({ label: '已通过金额', value: '¥' + num(w.amount), unit: `${w.approved} 笔已通过` })}
            ${stat({ label: '待审核', value: w.pending, unit: '笔', hot: w.pending > 0 })}
          </div>
          <div class="tk-dash-h" style="margin:2px 0 8px"><b style="font-size:12.5px">正在计时（${w.counting.length} 人）</b></div>
          <div class="tk-list">${countingRows}</div>
          <div class="tk-dash-h" style="margin:14px 0 8px"><b style="font-size:12.5px">今日计件明细</b></div>
          <div class="tk-list">${entryRows}</div>
        </div>`;
      }
    }

    /* 今日考勤详情 */
    let attBlock = '';
    if (isAdmin()) {
      if (!a) {
        attBlock = `<div class="tk-dash-sec">${secHead('今日考勤', attErr ? '读不到' : '读取中…', 'attendance')}<div class="tk-empty">${attErr ? '要连云端管理端才读得到考勤数据（本地演示模式没有这个接口）。点右上角「查看」可打开考勤管理页。' : '正在读取考勤数据…'}</div></div>`;
      } else {
        const badRows = a.bad.length
          ? a.bad.map((r) => `<div class="tk-li is-static">
              <em>${esc(r.employeeNo)}</em>
              <span>${esc(r.employeeName)}<small>${esc(r.shiftName || '')} · 本月出勤 ${r.attendanceDays}/${r.shouldAttendDays} 天</small></span>
              <b class="hot">${[
                Number(r.absentDays) ? `缺勤 ${r.absentDays}` : '',
                Number(r.missingOnceDays) ? `漏刷 ${r.missingOnceDays}` : '',
                Number(r.lateDays) ? `迟到 ${r.lateDays}` : ''
              ].filter(Boolean).join(' · ')}</b>
            </div>`).join('')
          : '<div class="tk-empty">本月没有考勤异常</div>';
        attBlock = `<div class="tk-dash-sec">
          ${secHead('今日考勤', `在岗 ${w ? w.onDuty.length : '—'} 人 · 计时中 ${w ? w.counting.length : '—'} 人`, 'attendance')}
          <div class="tk-stats four" style="margin-bottom:12px">
            ${stat({ label: '在职员工', value: a.headcount, unit: '人' })}
            ${stat({ label: '今日在岗', value: w ? w.onDuty.length : '—', unit: '人（有报工）' })}
            ${stat({ label: '本月缺勤', value: a.absentDays, unit: `天 · 漏刷 ${a.missingOnce} 次`, hot: a.absentDays > 0 })}
            ${stat({ label: '本月加班费', value: '¥' + num(a.overtimeAmount), unit: '合计' })}
          </div>
          <div class="tk-dash-h" style="margin:6px 0 8px"><b style="font-size:12.5px">本月考勤异常（前 6 人）</b></div>
          <div class="tk-list">${badRows}</div>
        </div>`;
      }
    }

    /* 今天装车 */
    const shipRows = c.recentShips.length
      ? c.recentShips.map((s) => `<div class="tk-li is-static">
          <em>${esc(String(s.createdAt).slice(11, 16))}</em>
          <span>${esc(s.id)}<small>${esc(s.customer && s.customer !== '未填写' ? s.customer : (s.operator || '—'))} · ${(s.items || []).length} 项</small></span>
          <b>${num(s.totalQuantity)} 件</b>
        </div>`).join('')
      : '<div class="tk-empty">还没有发货记录</div>';


    /* 库存概览（数据来自 board_inventory_overview） */
    let invBlock = '';
    if (inv) {
      const q = inv.qty || {}, k = inv.kinds || {};
      invBlock = `<div class="tk-dash-sec">
        ${secHead('库存概览', '一个仓库 · 不分库位', 'inventory', '库存')}
        <div class="tk-stats four">
          ${stat({ label: '完工品在库', value: num(q.finished), unit: `件 · ${num(k.finished)} 个料号` })}
          ${stat({ label: '外协件在库', value: num(q.outsource), unit: `件 · ${num(k.outsource)} 个料号` })}
          ${stat({ label: '原材料在库', value: num(q.raw), unit: `件 · ${num(k.raw)} 个料号` })}
          ${stat({ label: '库存为负', value: num(inv.negative), unit: '个料号', hot: Number(inv.negative) > 0 })}
        </div></div>`;
    }
    /* 三个功能板块（外协 / 采购 / 质量）：一个功能一个板块，板块头切页签 */
    const osBlock = buildOs();
    const puBlock = buildPu();
    const qlBlock = buildQl();
    const topRow = buildTop(c);

    // 给全局搜索用：主页已经拿到的数据挂到 window 上，避免重复请求
    window.__tkData = {
      orders: c.open,
      shipments: (state && Array.isArray(state.shipments)) ? state.shipments : [],
      osList, puList, qlList
    };

    box.innerHTML = `
      ${topRow}

      <div class="tk-dash-3col">
        ${osBlock}
        ${puBlock}
        ${qlBlock}
      </div>

      <div class="tk-dash-2col${(workBlock && attBlock) ? '' : ' is-single'}">
        ${workBlock || `<div class="tk-dash-sec">${secHead('未交总览', '口径：按订单项', 'remaining')}
          <div class="tk-stats four">
            ${stat({ label: '未交', value: num(c.open.length), unit: `行 · ${num(c.remainQty)} 件` })}
            ${stat({ label: '已发', value: num(c.shippedQty), unit: '件（累计）' })}
            ${stat({ label: '履约完成率', value: c.doneRate + '%', unit: '已发 ÷ 总量' })}
            ${stat({ label: '发货车次', value: num(c.shipCount), unit: '张发货单' })}
          </div></div>`}
        ${attBlock}
      </div>

      <div class="tk-dash-2col is-single">
        <div class="tk-dash-sec">
          ${secHead('今天装车', c.todayShipCount ? `今日 ${c.todayShipCount} 车 · ${num(c.todayShipQty)} 件` : '今天还没装车，下面是最近 6 次', 'shipments')}
          <div class="tk-list">${shipRows}</div>
        </div>
      </div>

      ${invBlock}
    `;
  }

  /* ---------------- 交互（只保留「查看 →」跳转） ---------------- */
  function goView(name) {
    // 外协 / 库存 / 采购 / 质量：走 home-merge 的模块专用跳转
    //（那边会把「实时总览」藏掉并加护栏，否则模块页会和总览叠在一起，看着像没跳过去）
    if (window.tkGoModule && window.tkGoModule(name)) return;
    const link = document.querySelector(`.side-link[data-desktop-view="${name}"]`);
    if (link) { link.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (name === 'outsource' || name === 'inventory' || name === 'purchase' || name === 'quality') {
      const li = document.querySelector('[data-desktop-view="' + name + '"]'); if (li) li.click(); return;
    }
    if (name === 'workReport' || name === 'attendance') {
      const mod = name === 'attendance' ? 'attendance' : 'workReport';
      const b = document.querySelector(`[data-desktop-module="${mod}"]`);
      if (b) {
        b.click();
        setTimeout(() => {
          const l = document.getElementById(mod === 'attendance' ? 'desktopAttendanceLink' : 'desktopWorkReportLink');
          if (l) l.click();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 400);
      }
    }
  }
  // 点小板块里的一行 → 展开完整清单并搜索该料号
  function openInFullList(q) {
    if (window.tkOpenMerge) window.tkOpenMerge();
    setTimeout(() => {
      const el = document.getElementById('desktopRemainingSearch') || document.getElementById('desktopSearch');
      if (el) { el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }, 60);
  }

  function printDueDates() {
    const dates = [...duePicks].sort();
    if (typeof window.tkPrintRemainingListByDates === 'function') {
      window.tkPrintRemainingListByDates(dates);
      return;
    }
    window.alert('打印组件还在加载，请稍后再点一次');
  }
  window.tkPrintDashboardDue = printDueDates;

  function onClick(e) {
    // 板块页签（没有 data-act，所以要单独认）
    const tabBtn = e.target.closest('.tk-block-tabs button[data-blk]');
    if (tabBtn) {
      const key = tabBtn.dataset.blk, tab = tabBtn.dataset.tab;
      BLK_TAB[key] = tab;
      try { localStorage.setItem('tkBlkTab_' + key, tab); } catch { }
      const sec = tabBtn.closest('.tk-dash-sec');
      if (sec) {
        sec.querySelectorAll('.tk-block-tabs button').forEach((b) => b.classList.toggle('on', b === tabBtn));
        sec.querySelectorAll('.tk-block-pane').forEach((p) => { p.hidden = p.dataset.tab !== tab; });
      }
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'go') goView(el.dataset.view);
    else if (act === 'due-pick') {
      const d = String(el.dataset.d || '').trim();
      if (!d) duePicks.clear();
      else if (duePicks.has(d)) duePicks.delete(d);
      else duePicks.add(d);
      render();
    }
    else if (act === 'print-due') { printDueDates(); }
    else if (act === 'mk') { openInFullList(el.dataset.q || ''); }
    else if (act === 'openfull') { if (window.tkOpenMerge) window.tkOpenMerge(); }
  }
  /* ---------------- 开关 ---------------- */
  const isPanel = () => document.body.dataset.home === 'panel';
  function build() {
    if ($('#tkDash')) return;
    const view = $('#desktopView');
    if (!view) return;
    const wrap = document.createElement('section');
    wrap.id = 'tkDash';
    wrap.className = 'tk-dash';
    wrap.hidden = true;
    const grid = view.querySelector('.dashboard-grid');
    if (grid && grid.parentElement === view) view.insertBefore(wrap, grid);
    else view.appendChild(wrap);
    wrap.addEventListener('click', onClick);
  }
  /* 首屏速度优化（2026-10-17）：
     以前是「主数据 → 7 个模块接口 → 3 个报工考勤接口」一路 await 到底，首屏要 4 秒多才出内容。
     现在分三段，每段一到位就先画一次：
       第 1 段 发货主数据（20 秒内拿过的不重复拿，省掉一次 385KB 的 board_get_state）
       第 2 段 四个模块的汇总+列表（管理端才取）
       第 3 段 报工 / 考勤（管理端才取）
     普通端（非管理码）只保留以前的功能：新模块整块不参与，接口也不去调。 */
  async function refresh(force) {
    if (!isPanel() || inflight) return;
    if (!force && Date.now() - lastFetch < 5000) return;
    inflight = true; lastFetch = Date.now();
    try {
      /* 第 1 段：发货主数据
         ① 先用 app.js 写在本地的缓存**立刻**画一版（毫秒级，不占网络）
         ② 缓存超过 20 秒就走接口拿最新的，回来再覆盖一次 */
      if (!state) {
        const cached = readStateCache();
        if (cached) { state = cached.snapshot; stateAt = cached.savedAt; render(); }
      }
      if (!state || Date.now() - stateAt > 20000) {
        const s = await fetchState();
        if (s) { state = s; stateAt = Date.now(); }
      }

      if (!isAdmin()) {
        os = null; pur = null; ql = null; inv = null;
        osList = []; puList = []; qlList = [];
        work = null; att = null; workErr = false; attErr = false;
        modulesTried = true;
        render();
        return;
      }

      render();   // 先把主体画出来（三个模块块这时显示「读取中」）

      /* 第 2 段：四个模块的汇总 + 列表 */
      const [osRes, invRes, purRes, qlRes, osL, puL, qlL] = await Promise.all([
        rpc('board_outsource_overview', {}),
        rpc('board_inventory_overview', {}),
        rpc('board_purchase_overview', {}),
        rpc('board_quality_overview', {}),
        rpc('board_outsource_list', { p_status: 'all' }),
        rpc('board_purchase_list', { p_status: 'all' }),
        rpc('board_quality_list', { p_status: 'all', p_days: 180 })
      ]);
      osList = (osL && osL.ok && Array.isArray(osL.data)) ? osL.data : [];
      puList = (puL && puL.ok && Array.isArray(puL.data)) ? puL.data : [];
      qlList = (qlL && qlL.ok && Array.isArray(qlL.data)) ? qlL.data : [];
      pur = (purRes && purRes.ok) ? purRes.data : null;
      ql = (qlRes && qlRes.ok) ? qlRes.data : null;
      inv = (invRes && invRes.ok) ? invRes.data : null;
      os = (osRes && osRes.ok) ? osRes.data : null;
      osErr = !os;
      modulesTried = true;
      render();

      /* 第 3 段：报工 / 考勤（只有管理员有权限） */
      if (state) {
        const today = String(state.today || '').slice(0, 10);
        const { from, to } = monthBounds(today);
        const [rep, live, attRes] = await Promise.all([
          rpc('work_admin_report_list', { p_date: today, p_employee_id: null, p_status: 'all', p_query: '', p_limit: 500 }),
          rpc('work_admin_work_overview', { p_date: today }),
          rpc('board_attendance_summary', { p_from: from, p_to: to })
        ]);
        const hasRep = !!(rep && rep.ok), hasLive = !!(live && live.ok && Array.isArray(live.data.rows));
        work = (hasRep || hasLive)
          ? { report: hasRep ? rep.data : null, live: hasLive ? live.data.rows : null }
          : null;
        att = (attRes && attRes.ok) ? attRes.data : null;
        workErr = !(hasRep && hasLive);
        attErr = !att;
        render();
      }
    } finally { inflight = false; }
  }
  function applyVisibility() {
    const box = $('#tkDash');
    if (!box) return;
    const on = isPanel();
    box.hidden = !on;
    if (on) { box.classList.add('loading'); refresh(true); }
    if (timer) { clearInterval(timer); timer = 0; }
    if (on) timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }
  function init() {
    // 读回上次选的板块页签
    try { ['os', 'pu', 'ql'].forEach((k) => { const v = localStorage.getItem('tkBlkTab_' + k); if (v) BLK_TAB[k] = v; }); } catch { }
    const isMobile = /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile';
    if (isMobile) return;
    build();
    applyVisibility();
    window.addEventListener('tk-home-change', applyVisibility);
    // 角色是异步识别的，识别出来之后再补一次（管理员才取报工/考勤）
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (isPanel() && document.body.dataset.boardRole) { refresh(true); clearInterval(t); }
      if (tries > 40) clearInterval(t);
    }, 500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && isPanel()) refresh(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
