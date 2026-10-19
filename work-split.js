/* 报工页：左侧列表 + 右侧详情（不改 app.js，只在渲染后接管布局） 2026-10-19 */
(() => {
  'use strict';
  const VIEW = 'desktopWorkReportView';
  let lastTr = null;

  function build() {
    const v = document.getElementById(VIEW);
    if (!v) return;
    const panel = v.querySelector('.work-live-panel');
    if (!panel) return;
    const table = panel.querySelector('table');
    if (!table || !table.querySelector('tbody')) return;
    if (panel.querySelector('.tk-work-split')) return;

    const split = document.createElement('div');
    split.className = 'tk-work-split';
    const left = document.createElement('div');
    left.className = 'tk-work-left';
    const right = document.createElement('div');
    right.className = 'tk-work-right';
    table.parentNode.insertBefore(split, table);
    split.appendChild(left);
    split.appendChild(right);
    left.appendChild(table);
    right.innerHTML = '<div class="tk-work-empty">点左侧任意一行<br>这里显示该员工当天的逐笔明细</div>';

    table.addEventListener('click', (e) => {
      const tr = e.target.closest('tbody tr');
      if (!tr || tr === lastTr) return;
      lastTr = tr;
      [...table.querySelectorAll('tbody tr')].forEach((x) => x.classList.toggle('on', x === tr));
      const cells = [...tr.children].map((td) => td.textContent.trim().replace(/\s+/g, ' '));
      const no = (cells[0] || '').replace(/[^0-9A-Za-z]/g, '');
      const mine = (window.__tkWorkEntries || []).filter((x) => String(x.employeeNo) === no);
      const money = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
      const pieceHtml = mine.length
        ? mine.map((e) => '<div class="row2"><span>' + (e.name || '') + '</span><i>' + (e.material || '') + ' · ' + (e.process || '') + '</i><b>' + Number(e.quantity || 0) + ' 件</b><em>单价 ' + Number(e.unitPrice || 0) + ' · ' + money(e.amount) + '</em></div>').join('')
        : '<div class="none">今天没有计件记录</div>';
      right.innerHTML = '<h4>' + (cells[0] || '明细') + '</h4>' +
        '<div class="tk-kv"><span>状态</span><b>' + (cells[1] || '—') + '</b></div>' +
        '<button type="button" class="tk-acc" data-acc="time"><span>今日计时</span><b>' + (cells[2] || '—') + '</b><i>▾</i></button>' +
        '<div class="tk-acc-body" data-body="time" hidden><div class="none">' + (cells[2] || '—') + '</div><div class="none">（时段明细接口加好后显示 09:00–11:30 这类区间）</div></div>' +
        '<button type="button" class="tk-acc" data-acc="piece"><span>今日计件</span><b>' + (cells[3] || '—') + '</b><i>▾</i></button>' +
        '<div class="tk-acc-body" data-body="piece" hidden>' + pieceHtml + '</div>' +
        '<div class="tk-work-actions"></div>';
      fillPeriods(right, no);
      right.querySelectorAll('.tk-acc').forEach((btn) => {
        btn.addEventListener('click', () => {
          const body = right.querySelector('[data-body="' + btn.dataset.acc + '"]');
          if (!body) return;
          body.hidden = !body.hidden;
          btn.classList.toggle('open', !body.hidden);
        });
      });
      const src = tr.querySelector('a, button');
      const box = right.querySelector('.tk-work-actions');
      if (src && box) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button primary';
        btn.textContent = '查看该员工明细';
        btn.addEventListener('click', () => src.click());
        box.appendChild(btn);
      }
    });
  }

  /* 取某员工当天的计时/计件时段（board_work_periods） */
  async function fillPeriods(right, no) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return;
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    const code = localStorage.getItem('shipmentBoardAccessCode' + suffix) || '';
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    let arr = [];
    try {
      const r = await fetch(base + '/board_work_periods', { method: 'POST', headers: h, body: JSON.stringify({ p_code: code, p_date: today, p_employee_no: no }) });
      arr = r.ok ? await r.json() : [];
      if (!Array.isArray(arr)) arr = [];
    } catch (e) { arr = []; }
    const hhmm = (s) => { const x = new Date(s); return isNaN(x) ? '--:--' : x.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }); };
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
    const all = arr.map((x) => [new Date(x.start).getTime(), new Date(x.end).getTime()]).filter((p) => !isNaN(p[0]) && !isNaN(p[1]));
    const span = all.length ? Math.round((Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[0]))) / 60000) : 0;
    const pieceMin = Math.max(0, span - tMin);
    const li = (list, cls) => list.length
      ? list.map((x) => '<div class="tk-seg ' + cls + '"><b>' + hhmm(x.start) + ' – ' + hhmm(x.end) + '</b><i>' + Number(x.minutes || 0) + ' 分钟</i></div>').join('')
      : '<div class="none">没有时段记录</div>';
    const tb = right.querySelector('[data-body="time"]');
    const pb = right.querySelector('[data-body="piece"]');
    if (tb) tb.innerHTML = li(timers, 'timer') + '<div class="tk-seg-sum">计时合计 ' + Math.round(tMin / 60 * 10) / 10 + ' 小时</div>';
    if (pb) pb.innerHTML = li(pieces, 'piece') + '<div class="tk-seg-sum">计件总工时 ' + Math.round(pieceMin / 60 * 10) / 10 + ' 小时（全天 ' + Math.round(span / 60 * 10) / 10 + ' − 计时 ' + Math.round(tMin / 60 * 10) / 10 + '）</div>';
  }

  /* 取今天全部计件明细，按员工号分组用 */
  async function loadEntries() {
    try {
      const base = window.SHIPMENT_RPC_BASE || '';
      if (!base) return;
      const mode = new URLSearchParams(location.search).get('mode');
      const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
      const code = localStorage.getItem('shipmentBoardAccessCode' + suffix) || '';
      const h = { 'Content-Type': 'application/json' };
      if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
      const today = new Date().toISOString().slice(0, 10);
      const r = await fetch(base + '/work_admin_report_list', { method: 'POST', headers: h, body: JSON.stringify({ p_code: code, p_date: today, p_employee_id: null, p_status: 'all', p_query: '', p_limit: 500 }) });
      const d = r.ok ? await r.json() : null;
      window.__tkWorkEntries = (d && Array.isArray(d.rows)) ? d.rows : [];
    } catch (e) { window.__tkWorkEntries = []; }
  }
  loadEntries();
  setInterval(() => { if (!window.__tkWorkEntries) loadEntries(); }, 5000);

  /* 隐藏 app.js 原生的重复详情区 */
  function hideNative() {
    [...document.querySelectorAll('div, section')].forEach((el) => {
      if (el.dataset.tkHid === '1') return;
      if (String(el.textContent || '').indexOf('点左侧员工的「查看明细」') >= 0 && el.children.length <= 3) {
        el.dataset.tkHid = '1';
        el.style.display = 'none';
      }
    });
  }
  setInterval(() => { build(); hideNative(); }, 1200);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tk-view="work"]')) setTimeout(build, 400);
  }, true);
})();