/* 报工页：员工实况（左表 + 右明细）｜报工记录（单独页签）
   2026-10-19 修复：旧版 hideNative 把“员工实况”整个面板误隐藏；
   现在只隐藏原生重复详情区，并把记录表移到「报工记录」页签。 */
(() => {
  'use strict';
  const VIEW = 'desktopWorkReportView';
  let lastTr = null;
  let lastNo = '';
  let mode = 'live'; // live | records

  const shanghaiToday = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());

  const money = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const money2 = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (s) => {
    const x = new Date(s);
    return isNaN(x) ? '--:--' : x.toLocaleTimeString('zh-CN', {
      hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit'
    });
  };

  function findLiveTable(panel) {
    const tables = [...panel.querySelectorAll('table')].filter((x) => x.querySelector('tbody'));
    return tables.find((x) => /今日计时|今日工资|当前状态/.test(String((x.querySelector('thead') || {}).innerText || ''))) || null;
  }

  function ensureSplit(panel, table) {
    let split = panel.querySelector('.tk-work-split');
    if (split) return split;

    const nativeSplit = panel.querySelector('.work-live-split');
    split = document.createElement('div');
    split.className = 'tk-work-split';
    const left = document.createElement('div');
    left.className = 'tk-work-left';
    const right = document.createElement('div');
    right.className = 'tk-work-right';
    split.appendChild(left);
    split.appendChild(right);

    // 放在原生两栏的位置，并把实况表移进左栏
    if (nativeSplit) panel.insertBefore(split, nativeSplit);
    else panel.appendChild(split);
    left.appendChild(table);

    // 原生右栏只负责 app.js 的内部状态；我们用自己的明细栏，原生整栏隐藏
    if (nativeSplit) nativeSplit.style.display = 'none';

    right.innerHTML = '<div class="tk-work-empty">点左侧任意一行<br>这里显示该员工当天的计时与计件明细</div>';

    if (!table.dataset.tkBound) {
      table.dataset.tkBound = '1';
      table.addEventListener('click', (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr || !tr.querySelector('td')) return;
        lastTr = tr;
        const cells = [...tr.children].map((td) => td.textContent.trim().replace(/\s+/g, ' '));
        lastNo = String((tr.querySelector('td:first-child small') || {}).textContent || cells[0] || '').replace(/[^0-9A-Za-z]/g, '');
        [...table.querySelectorAll('tbody tr')].forEach((x) => x.classList.toggle('on', x === tr));
        renderDetail(right, tr, cells);
      });
    }
    return split;
  }

  function renderDetail(right, tr, cells) {
    if (!right) return;
    const name = String((tr.querySelector('td:first-child strong') || {}).textContent || cells[0] || '员工');
    const no = lastNo;
    const status = cells[1] || '—';
    const timerText = cells[2] || '—';
    const pieceText = cells[3] || '—';
    const entriesReady = Array.isArray(window.__tkWorkEntries);
    const mine = (window.__tkWorkEntries || []).filter((x) => String(x.employeeNo) === no);
    const pieceHtml = !entriesReady
      ? '<div class="none">读取计件明细…</div>'
      : mine.length
        ? (() => {
            const qty = mine.reduce((s, e) => s + Number(e.quantity || 0), 0);
            const amount = mine.reduce((s, e) => s + Number(e.amount != null ? e.amount : Number(e.quantity || 0) * Number(e.unitPrice || 0)), 0);
            const row = (e) => {
              const q = Number(e.quantity || 0);
              const price = Number(e.unitPrice != null ? e.unitPrice : (e.submittedUnitPrice || 0));
              const amt = Number(e.amount != null ? e.amount : q * price);
              const st = e.status === 'approved' ? '已通过' : e.status === 'submitted' ? '待审核' : e.status === 'rejected' ? '已退回' : '已撤回';
              return '<div class="tk-piece-row">' +
                '<div class="tk-piece-top"><b>' + esc(e.name || '') + '</b><span>' + hhmm(e.createdAt) + ' · ' + st + '</span></div>' +
                '<div class="tk-piece-sub">' + esc(e.material || '') + (e.process ? ' · ' + esc(e.process) : '') + '</div>' +
                '<div class="tk-piece-math">' + q + ' 件 × ' + money2(price) + ' = <b>' + money2(amt) + '</b></div>' +
              '</div>';
            };
            return '<div class="tk-piece-sum">共 ' + mine.length + ' 笔 · ' + qty + ' 件 · ' + money2(amount) + '</div>' + mine.map(row).join('');
          })()
        : '<div class="none">今天没有计件记录</div>';

    right.innerHTML = '<h4>' + esc(name) + '</h4>' +
      '<div class="tk-kv"><span>状态</span><b>' + esc(status) + '</b></div>' +
      '<div class="tk-kv" data-att-state><span>考勤签退</span><b>读取中…</b></div>' +
      '<button type="button" class="tk-acc open" data-acc="time"><span>今日计时</span><b>' + esc(timerText) + '</b><i>▾</i></button>' +
      '<div class="tk-acc-body" data-body="time"><div class="none">读取计时时段…</div></div>' +
      '<button type="button" class="tk-acc open" data-acc="piece"><span>今日计件</span><b>' + esc(pieceText) + '</b><i>▾</i></button>' +
      '<div class="tk-acc-body" data-body="piece"><div data-piece-list>' + pieceHtml + '</div><div data-piece-periods></div><div class="tk-seg-sum" data-piece-sum></div></div>';

    right.querySelectorAll('.tk-acc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const body = right.querySelector('[data-body="' + btn.dataset.acc + '"]');
        if (!body) return;
        body.hidden = !body.hidden;
        btn.classList.toggle('open', !body.hidden);
      });
    });

    fillPeriods(right, no);
  }

  async function fillPeriods(right, no) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base || !right) return;
    const modeName = new URLSearchParams(location.search).get('mode');
    const suffix = (modeName === 'admin' || modeName === 'user') ? ':' + modeName : '';
    const code = localStorage.getItem('shipmentBoardAccessCode' + suffix) || '';
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) {
      h.apikey = window.SHIPMENT_ANON_KEY;
      h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY;
    }
    const dateInput = document.getElementById('desktopWorkReportDate');
    const day = (dateInput && dateInput.value) || shanghaiToday();
    let arr = [];
    try {
      const r = await fetch(base + '/board_work_periods', {
        method: 'POST', headers: h,
        body: JSON.stringify({ p_code: code, p_date: day, p_employee_no: no })
      });
      arr = r.ok ? await r.json() : [];
      if (!Array.isArray(arr)) arr = [];
    } catch (e) { arr = []; }

    let att = null;
    try {
      const ar = await fetch(base + '/board_attendance_days', {
        method: 'POST', headers: h,
        body: JSON.stringify({ p_code: code, p_from: day, p_to: day, p_employee_no: no })
      });
      const ad = ar.ok ? await ar.json() : null;
      att = (ad && Array.isArray(ad.days) && ad.days[0]) ? ad.days[0] : null;
    } catch (e) { att = null; }
    const checkOut = att && att.checkOut ? String(att.checkOut).slice(0, 5) : '';
    const attState = !checkOut ? 'pending' : (checkOut <= '17:00' ? 'left' : 'ot');

    const norm = (list) => {
      const seen = new Set();
      const out = [];
      list.forEach((x) => {
        const k = String(x.start) + '|' + String(x.end);
        if (seen.has(k)) return;
        seen.add(k);
        const calc = Math.round((new Date(x.end) - new Date(x.start)) / 60000);
        out.push({ start: x.start, end: x.end, minutes: Number(x.minutes || 0) || (calc > 0 ? calc : 0) });
      });
      return out.sort((a, b) => new Date(a.start) - new Date(b.start));
    };
    const timers = norm(arr.filter((x) => x.kind === 'timer'));
    const pieces = norm(arr.filter((x) => x.kind === 'piece'));
    const tMin = timers.reduce((s, x) => s + Number(x.minutes || 0), 0);
    const all = arr.map((x) => [new Date(x.start).getTime(), new Date(x.end).getTime()])
      .filter((p) => !isNaN(p[0]) && !isNaN(p[1]));
    const span = all.length ? Math.round((Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[0]))) / 60000) : 0;
    const pieceMin = Math.max(0, span - tMin);
    const li = (list, cls) => list.length
      ? list.map((x) => '<div class="tk-seg ' + cls + '"><b>' + hhmm(x.start) + ' – ' + hhmm(x.end) + '</b><i>' + Number(x.minutes || 0) + ' 分钟</i></div>').join('')
      : '<div class="none">没有时段记录</div>';

    const after17 = [...timers, ...pieces].some((x) => hhmm(x.end) > '17:00');
    const attLine = '<div class="tk-att-line">考勤签退：<b>' + (checkOut || '未出') + '</b>' +
      (attState === 'left' ? '<em class="tk-att-bad">已下班</em>' : attState === 'ot' ? '<em class="tk-att-ok">加班</em>' : '<em class="tk-att-pending">待核对</em>') + '</div>';
    const attWarn = after17
      ? (attState === 'left'
          ? '<div class="tk-att-warn bad">考勤 ' + checkOut + ' 已下班；17:00 后的时段按“忘记结束”处理，不计加班工资。</div>'
          : attState === 'pending'
            ? '<div class="tk-att-warn pending">考勤签退未出；17:00 后的时段待核对，确认前不计加班工资。</div>'
            : '<div class="tk-att-warn ok">考勤 ' + checkOut + ' 下班；17:00 后的时段按加班核对。</div>')
      : '';
    const attEl = right.querySelector('[data-att-state] b');
    if (attEl) attEl.textContent = checkOut || '未出';
    const tb = right.querySelector('[data-body="time"]');
    const pb = right.querySelector('[data-body="piece"]');
    if (tb) tb.innerHTML = li(timers, 'timer') + '<div class="tk-seg-sum">计时合计 ' + Math.round(tMin / 60 * 10) / 10 + ' 小时</div>' + attLine + attWarn;
    if (pb) {
      const pl = pb.querySelector('[data-piece-periods]');
      if (pl) {
        const tagFor = (x) => {
          if (hhmm(x.end) <= '17:00') return '';
          if (attState === 'left') return ' <em class="tk-ot tk-left">忘记结束</em>';
          if (attState === 'ot') return ' <em class="tk-ot">加班</em>';
          return ' <em class="tk-ot tk-pending">待核对</em>';
        };
        pl.innerHTML = pieces.length
          ? '<div class="tk-sub-h">计件时段</div>' + pieces.map((x) =>
              '<div class="tk-seg piece"><b>' + hhmm(x.start) + ' – ' + hhmm(x.end) + tagFor(x) + '</b><i>' + Number(x.minutes || 0) + ' 分钟</i></div>'
            ).join('')
          : '';
      }
      const ps = pb.querySelector('[data-piece-sum]');
      if (ps) ps.textContent = '计件总工时 ' + Math.round(pieceMin / 60 * 10) / 10 + ' 小时（全天 ' + Math.round(span / 60 * 10) / 10 + ' − 计时 ' + Math.round(tMin / 60 * 10) / 10 + '）';
    }
  }

  async function loadEntries() {
    try {
      const base = window.SHIPMENT_RPC_BASE || '';
      if (!base) return;
      const modeName = new URLSearchParams(location.search).get('mode');
      const suffix = (modeName === 'admin' || modeName === 'user') ? ':' + modeName : '';
      const code = localStorage.getItem('shipmentBoardAccessCode' + suffix) || '';
      const h = { 'Content-Type': 'application/json' };
      if (window.SHIPMENT_ANON_KEY) {
        h.apikey = window.SHIPMENT_ANON_KEY;
        h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY;
      }
      const dateInput = document.getElementById('desktopWorkReportDate');
      const day = (dateInput && dateInput.value) || shanghaiToday();
      const r = await fetch(base + '/work_admin_report_list', {
        method: 'POST', headers: h,
        body: JSON.stringify({ p_code: code, p_date: day, p_employee_id: null, p_status: 'all', p_query: '', p_limit: 1000 })
      });
      const d = r.ok ? await r.json() : null;
      window.__tkWorkEntries = (d && Array.isArray(d.rows)) ? d.rows : [];
      // 点击时明细还没加载完：加载完自动补上
      if (lastTr && document.contains(lastTr)) {
        const right = document.querySelector('#desktopWorkReportView .tk-work-right');
        if (right) {
          const cells = [...lastTr.children].map((td) => td.textContent.trim().replace(/\s+/g, ' '));
          renderDetail(right, lastTr, cells);
        }
      }
    } catch (e) { window.__tkWorkEntries = []; }
  }

  function recordsSection(v) {
    return [...v.children].find((el) => el.matches('section.panel') &&
      !el.classList.contains('work-live-panel') &&
      el.querySelector('.work-report-table') &&
      el.querySelector('#desktopWorkReportBody')) || null;
  }

  function paint(v) {
    const panel = v.querySelector('.work-live-panel');
    const records = recordsSection(v);
    if (panel) panel.style.display = mode === 'records' ? 'none' : '';
    if (records) {
      records.classList.add('tk-work-records');
      records.style.display = mode === 'records' ? '' : 'none';
    }
    v.querySelectorAll('[data-work-view="workReport"]').forEach((b) => b.classList.toggle('on', mode === 'live'));
    v.querySelectorAll('[data-tk-work-mode="records"]').forEach((b) => b.classList.toggle('on', mode === 'records'));
  }

  function ensureRecordTab(v) {
    const bar = v.querySelector('.tk-work-tabs');
    if (!bar) return;
    if (!bar.querySelector('[data-tk-work-mode="records"]')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tkWorkMode = 'records';
      b.textContent = '报工记录';
      bar.appendChild(b);
    }
    if (!bar.dataset.tkModeBound) {
      bar.dataset.tkModeBound = '1';
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.tkWorkMode === 'records') {
          e.preventDefault();
          e.stopPropagation();
          mode = 'records';
          paint(v);
        } else if (b.dataset.workView === 'workReport') {
          mode = 'live';
          paint(v);
        }
      }, true);
    }
  }

  function build() {
    const v = document.getElementById(VIEW);
    if (!v) return;
    const panel = v.querySelector('.work-live-panel');
    if (!panel) return;
    const table = findLiveTable(panel);
    if (!table) return;
    ensureSplit(panel, table);
    ensureRecordTab(v);
    paint(v);
    // 原生重复详情区不再用大范围 textContent 隐藏（旧版就是这样把整个实况面板误藏的）
    const native = panel.querySelector('.work-live-split');
    if (native) native.style.display = 'none';
  }

  loadEntries();
  setInterval(() => { if (!Array.isArray(window.__tkWorkEntries)) loadEntries(); }, 5000);
  setInterval(build, 1200);

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-work-view="workReport"]')) mode = 'live';
    if (e.target.closest('[data-tk-view="work"], [data-desktop-view="workReport"]')) setTimeout(build, 400);
  }, true);
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'desktopWorkReportDate') loadEntries();
  });
})();
