/* ============================================================
   质量 / 不良模块（第一梯队第 5 步）
   文件：public/quality.js          建立日期：2026-10-16
   依赖：cloud/quality-schema.sql（quality_issues + 5 个接口）
   说明：外协页 / 采购页的「标不良」会自动在这里建档，你只需补充
         工序 / 现象 / 责任方 / 处理方式。
   回滚：删掉 index.html 里这一行 <script>
   ============================================================ */
(() => {
  'use strict';

  const VIEW = 'quality';
  const DISP = { pending: '待定', rework: '返工', scrap: '报废', concession: '让步接收',
                 return_supplier: '退回供应商', return_outsource: '退回外协厂' };
  const RESP = { self: '本厂', outsource: '外协厂', supplier: '供应商', unknown: '待定' };
  const SRC = { outsource: '外协', purchase: '采购', production: '生产', other: '其它' };
  const PROCESSES = ['下料','剪板','折弯','焊接','打磨','攻丝','钻孔','喷涂','镀锌','包装','装配'];
  const DEFECTS = ['尺寸不对','焊缝缺陷','涂层不良','镀层不良','生锈','材质不对','来料变形','划伤','孔位偏差','数量不对'];

  const S = { tab: 'open', list: [], ov: null, loaded: false, err: '', q: '' };
  const CACHE_KEY = 'shipmentBoardQualityCacheV1';

  const $ = (s) => document.querySelector(s);
  const num = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = (iso) => { const p = String(iso || '').slice(5, 10).split('-'); return p.length === 2 ? `${+p[0]}月${+p[1]}日` : '—'; };
  const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

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
      const r = await fetch(base + '/' + name, { method: 'POST', headers: headers(),
        body: JSON.stringify({ p_code: readCode(), ...payload }) });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
        return { ok: false, error: msg, missingTable: /does not exist|could not find|42883|PGRST202/i.test(msg) };
      }
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  function previewFromDashboard() {
    try {
      const own = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (own && own.tab === S.tab && Date.now() - Number(own.savedAt || 0) < 2 * 60 * 60 * 1000 && own.ov && Array.isArray(own.list)) {
        S.ov = own.ov; S.list = own.list; S.loaded = true; S.err = '';
        render();
        return true;
      }
      const live = window.__tkData;
      if (live && live.ql && Array.isArray(live.qlList)) {
        const rows = live.qlList.filter((row) => S.tab === 'open' ? row.status === 'open' : S.tab === 'closed' ? row.status === 'closed' : true);
        S.ov = live.ql; S.list = rows; S.loaded = true; S.err = '';
        render();
        return true;
      }      const cached = JSON.parse(localStorage.getItem('shipmentBoardDashboardCacheV2') || 'null');
      const d = cached && Date.now() - Number(cached.savedAt || 0) < 2 * 60 * 60 * 1000 ? cached.data : null;
      if (!d || !d.ql || !Array.isArray(d.qlList)) return false;
      const rows = d.qlList.filter((row) => S.tab === 'open' ? row.status === 'open' : S.tab === 'closed' ? row.status === 'closed' : true);
      S.ov = d.ql; S.list = rows; S.loaded = true; S.err = '';
      render();
      return true;
    } catch { return false; }
  }
  function showMine() {
    document.querySelectorAll('.desktop-view').forEach((v) => { v.hidden = v.id !== 'desktopQualityView'; });
    document.querySelectorAll('[data-desktop-view]').forEach((l) =>
      l.classList.toggle('active', l.dataset.desktopView === VIEW));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!S.loaded) { previewFromDashboard(); load(true); }
  }
  function hideMine() { const v = document.getElementById('desktopQualityView'); if (v) v.hidden = true; }

  let loadSeq = 0;
  async function load(force) {
    const seq = ++loadSeq;
    renderBanner('正在读取质量数据…');
    const [ov, list] = await Promise.all([
      rpc('board_quality_overview'),
      rpc('board_quality_list', { p_status: S.tab, p_days: 180 })
    ]);
    if (seq !== loadSeq) return;
    if (!ov.ok || !list.ok) {
      const e = ov.ok ? list : ov;
      S.err = e.missingTable
        ? '质量模块的表还没建。请先在 Supabase → SQL Editor 里执行 cloud\\quality-schema.sql，然后点「刷新」。'
        : (String(e.error).includes('本地模式') ? '本地演示模式读不到云端接口。质量模块要在云端管理端使用。'
          : ('读取失败：' + e.error));
      S.list = []; S.ov = null; S.loaded = false;
    } else {
      S.err = ''; S.loaded = true; S.ov = ov.data; S.list = Array.isArray(list.data) ? list.data : [];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), tab: S.tab, ov: S.ov, list: S.list })); } catch { }
    }
    render();
  }

  function renderBanner(text, warn) {
    const b = $('#qlBanner'); if (!b) return;
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.className = 'os-banner' + (warn ? ' warn' : ''); b.innerHTML = text;
  }
  function filtered() {
    const q = S.q.trim().toLowerCase();
    if (!q) return S.list;
    return S.list.filter((r) => [r.material, r.name, r.spec, r.process, r.defect, r.responsibility, r.sourceLabel]
      .join(' ').toLowerCase().includes(q));
  }
  function row(r) {
    const open = r.status === 'open';
    return `<tr data-id="${esc(r.id)}">
      <td>${esc(md(r.foundAt))}<span class="sub">${esc(SRC[r.sourceKind] || '')}${r.sourceLabel ? ' · ' + esc(r.sourceLabel) : ''}</span></td>
      <td class="mono">${esc(r.material)}<span class="sub">${esc(r.name || '')}${r.spec ? ' · ' + esc(r.spec) : ''}</span></td>
      <td>${esc(r.process || '—')}</td>
      <td class="num" style="color:var(--accent)">${num(r.qty)}</td>
      <td>${esc(r.defect || '—')}</td>
      <td><span class="ql-disp ${esc(r.disposition)}">${esc(DISP[r.disposition] || r.disposition)}</span></td>
      <td class="ql-resp${r.responsibilityKind === 'self' ? ' self' : ''}">${esc(RESP[r.responsibilityKind] || '待定')}${r.responsibility ? `<span class="sub">${esc(r.responsibility)}</span>` : ''}</td>
      <td>${open ? '<span class="os-pill late">未结案</span>' : '<span class="os-pill done">已结案</span>'}</td>
      <td><div class="acts">
        <button class="ops pri" data-act="edit">补充 / 修改</button>
        <button class="ops" data-act="toggle">${open ? '结案' : '重新打开'}</button>
      </div></td>
    </tr>`;
  }
  function bars(list, unit) {
    if (!list || !list.length) return '<div class="tk-empty">本月还没有记录</div>';
    const max = Math.max(...list.map((x) => Number(x.qty) || 0), 1);
    return list.map((x) => `<div class="ql-bar">
      <span title="${esc(x.key)}">${esc(x.key)}</span>
      <i><b style="width:${Math.max(2, Math.round((Number(x.qty) || 0) / max * 100))}%"></b></i>
      <em>${num(x.qty)}${esc(unit)}<small>${num(x.count)} 条</small></em>
    </div>`).join('');
  }
  function render() {
    if (!$('#qlKpis')) return;
    const ov = S.ov || {};
    $('#qlKpis').innerHTML = `
      <div class="os-kpi"><span>本月不良</span><b>${num(ov.monthQty)}</b><i>件 · ${num(ov.monthCount)} 条</i></div>
      <div class="os-kpi${Number(ov.openCount) ? ' hot' : ''}"><span>未结案</span><b>${num(ov.openCount)}</b><i>条 · ${num(ov.openQty)} 件</i></div>
      <div class="os-kpi${Number(ov.scrapQty) ? ' hot' : ''}"><span>本月报废</span><b>${num(ov.scrapQty)}</b><i>件（直接损失）</i></div>
      <div class="os-kpi"><span>本月退回</span><b>${num(ov.returnCount)}</b><i>条（供应商 / 外协厂）</i></div>`;
    $('#qlStats').innerHTML = `
      <div class="ql-statbox"><b>按工序（本月 · 按不良件数）</b>${bars(ov.byProcess, ' 件')}</div>
      <div class="ql-statbox"><b>按责任方（本月）</b>${bars(ov.byResponsibility, ' 件')}</div>`;

    const tabs = [['open', '未结案'], ['all', '全部'], ['rework', '返工'], ['scrap', '报废'],
                  ['return', '退回供应商/外协'], ['pending', '处理待定'], ['closed', '已结案']];
    $('#qlTabs').innerHTML = tabs.map(([k, label]) =>
      `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${label}</button>`).join('');

    if (S.err) {
      renderBanner(esc(S.err), true);
      $('#qlBody').innerHTML = ''; $('#qlEmpty').hidden = false;
      $('#qlEmpty').innerHTML = `<b>还没有数据</b>${esc(S.err)}`;
      return;
    }
    renderBanner('');
    const rows = filtered();
    $('#qlEmpty').hidden = rows.length > 0;
    $('#qlEmpty').innerHTML = '<b>这个筛选下没有不良记录</b>';
    $('#qlBody').innerHTML = rows.map(row).join('');
  }

  function openModal(html) {
    closeModal();
    const mask = document.createElement('div'); mask.className = 'os-mask'; mask.id = 'qlMask';
    const modal = document.createElement('div'); modal.className = 'os-modal'; modal.id = 'qlModal';
    modal.innerHTML = `<div class="os-card">${html}</div>`;
    document.body.appendChild(mask); document.body.appendChild(modal);
    mask.addEventListener('click', closeModal);
    document.addEventListener('keydown', escClose);
    return modal;
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    document.getElementById('qlMask')?.remove();
    document.getElementById('qlModal')?.remove();
    document.removeEventListener('keydown', escClose);
  }
  function formErr(modal, msg) {
    let el = modal.querySelector('.os-err');
    if (!el) { el = document.createElement('div'); el.className = 'os-err'; modal.querySelector('.os-card').appendChild(el); }
    el.textContent = msg;
  }
  function toast(m) { if (window.showToast) window.showToast(m); else console.log(m); }
  const opts = (o, cur) => Object.entries(o).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v}</option>`).join('');
  const dl = (id, arr) => `<datalist id="${id}">${arr.map((x) => `<option value="${x}"></option>`).join('')}</datalist>`;

  function dlgCreate() {
    openModal(`
      <h3>记一条不良</h3>
      <div class="os-sub">生产过程中发现的、或外协/采购之外的不良，在这里手工记。</div>
      <div class="os-form">
        <label><span>发现日期</span><input id="qlD" type="date" value="${todayStr()}"></label>
        <label><span>不良数量 *</span><input id="qlQ" type="number" step="0.01" min="0.01"></label>
        <label><span>料号 *</span><input id="qlM" placeholder="如 614004030B"></label>
        <label><span>图号 / 规格</span><input id="qlS"></label>
        <label class="full"><span>品名</span><input id="qlN" placeholder="如 护栏组焊件(喷涂后)(ZZ)"></label>
        <label><span>工序</span><input id="qlP" list="qlProc">${dl('qlProc', PROCESSES)}</label>
        <label><span>不良现象</span><input id="qlF" list="qlDef">${dl('qlDef', DEFECTS)}</label>
        <label><span>处理方式</span><select id="qlDisp">${opts(DISP, 'pending')}</select></label>
        <label><span>责任方</span><select id="qlRespK">${opts(RESP, 'unknown')}</select></label>
        <label class="full"><span>责任说明（填了更清楚，如"华鑫喷涂"）</span><input id="qlResp"></label>
        <label><span>损失金额（元，可不填）</span><input id="qlCost" type="number" step="0.01" min="0"></label>
        <label><span>发现人</span><input id="qlBy" placeholder="如 陶德超"></label>
        <label class="full"><span>备注</span><input id="qlNote" placeholder="怎么发现的 / 后续怎么处理"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">记下来</button></div>`);
    const modal = document.getElementById('qlModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const payload = {
        foundAt: modal.querySelector('#qlD').value,
        material: modal.querySelector('#qlM').value.trim(),
        spec: modal.querySelector('#qlS').value.trim(),
        name: modal.querySelector('#qlN').value.trim(),
        qty: modal.querySelector('#qlQ').value.trim(),
        process: modal.querySelector('#qlP').value.trim(),
        defect: modal.querySelector('#qlF').value.trim(),
        disposition: modal.querySelector('#qlDisp').value,
        responsibilityKind: modal.querySelector('#qlRespK').value,
        responsibility: modal.querySelector('#qlResp').value.trim(),
        cost: modal.querySelector('#qlCost').value.trim(),
        foundBy: modal.querySelector('#qlBy').value.trim(),
        note: modal.querySelector('#qlNote').value.trim(),
        sourceKind: 'production'
      };
      if (!payload.material || !payload.qty) { formErr(modal, '料号和不良数量都要填'); return; }
      b.disabled = true;
      const r = await rpc('board_quality_create', { p_payload: payload });
      b.disabled = false;
      if (!r.ok) { formErr(modal, r.missingTable ? '表还没建，先执行 quality-schema.sql' : ('记录失败：' + r.error)); return; }
      closeModal(); toast('已记下'); S.loaded = false; load(true);
    });
  }

  function dlgEdit(r) {
    openModal(`
      <h3>补充 / 修改不良记录</h3>
      <div class="os-sub">${esc(r.material)} ${esc(r.name || '')} · ${esc(md(r.foundAt))} · ${esc(SRC[r.sourceKind] || '')}${r.sourceLabel ? ' · ' + esc(r.sourceLabel) : ''}</div>
      <div class="os-kv">
        <i>不良数量</i><span style="color:var(--accent)">${num(r.qty)}</span>
        <i>图号</i><span>${esc(r.spec || '—')}</span>
      </div>
      <div class="os-form">
        <label><span>工序</span><input id="qlP" list="qlProc2" value="${esc(r.process || '')}">${dl('qlProc2', PROCESSES)}</label>
        <label><span>不良现象</span><input id="qlF" list="qlDef2" value="${esc(r.defect || '')}">${dl('qlDef2', DEFECTS)}</label>
        <label><span>处理方式</span><select id="qlDisp">${opts(DISP, r.disposition)}</select></label>
        <label><span>责任方</span><select id="qlRespK">${opts(RESP, r.responsibilityKind || 'unknown')}</select></label>
        <label class="full"><span>责任说明</span><input id="qlResp" value="${esc(r.responsibility || '')}" placeholder="如 华鑫喷涂 / 本厂折弯"></label>
        <label><span>损失金额（元）</span><input id="qlCost" type="number" step="0.01" min="0" value="${r.cost == null ? '' : Number(r.cost)}"></label>
        <label><span>处理人</span><input id="qlH" value="${esc(r.handler || '')}"></label>
        <label class="full"><span>备注</span><input id="qlNote" value="${esc(r.note || '')}"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">保存</button></div>`);
    const modal = document.getElementById('qlModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      b.disabled = true;
      const res = await rpc('board_quality_update', { p_payload: {
        id: r.id,
        process: modal.querySelector('#qlP').value.trim(),
        defect: modal.querySelector('#qlF').value.trim(),
        disposition: modal.querySelector('#qlDisp').value,
        responsibilityKind: modal.querySelector('#qlRespK').value,
        responsibility: modal.querySelector('#qlResp').value.trim(),
        cost: modal.querySelector('#qlCost').value.trim(),
        handler: modal.querySelector('#qlH').value.trim(),
        note: modal.querySelector('#qlNote').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '保存失败：' + res.error); return; }
      closeModal(); toast('已保存'); S.loaded = false; load(true);
    });
  }

  function build() {
    if (document.getElementById('desktopQualityView')) return;

    const nav = document.querySelector('.side-nav');
    if (nav && !nav.querySelector('[data-desktop-view="quality"]')) {
      const a = document.createElement('a');
      a.className = 'side-link'; a.href = '#quality'; a.dataset.desktopView = 'quality';
      a.innerHTML = '<span class="nav-dot"></span>质量 / 不良';
      const pu = nav.querySelector('[data-desktop-view="purchase"]');
      const anchor = nav.querySelector('[data-desktop-view="files"]');
      if (pu && pu.nextSibling) nav.insertBefore(a, pu.nextSibling);
      else if (anchor) nav.insertBefore(a, anchor);
      else nav.appendChild(a);
    }

    const main = document.querySelector('main.main-area');
    if (main) {
      const sec = document.createElement('section');
      sec.id = 'desktopQualityView';
      sec.className = 'desktop-view desktop-only';
      sec.hidden = true;
      sec.innerHTML = `
        <header class="topbar">
          <div><div class="eyebrow">不良与返工</div><h1>质量 / 不良</h1></div>
          <div class="topbar-actions">
            <button id="qlRefresh" class="button">刷新</button>
            <button id="qlNew" class="button primary">记一条不良</button>
          </div>
        </header>
        <section class="panel os-panel">
          <div id="qlKpis" class="os-kpis"></div>
          <div id="qlStats" class="ql-stats"></div>
          <div id="qlTabs" class="os-tabs"></div>
          <div class="iv-search"><input id="qlSearch" type="search" placeholder="搜料号 / 品名 / 工序 / 现象 / 责任方" autocomplete="off"></div>
          <div id="qlBanner" class="os-banner" hidden></div>
          <div class="os-tablewrap">
            <table class="os-table">
              <thead><tr>
                <th>发现日期 / 来源</th><th>料号 / 品名</th><th>工序</th><th>不良数</th>
                <th>现象</th><th>处理方式</th><th>责任方</th><th>状态</th><th>操作</th>
              </tr></thead>
              <tbody id="qlBody"></tbody>
            </table>
          </div>
          <div id="qlEmpty" class="os-empty" hidden></div>
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
      if (e.target.closest('#qlRefresh')) { S.loaded = false; load(true); return; }
      if (e.target.closest('#qlNew')) { dlgCreate(); return; }
      const tab = e.target.closest('#qlTabs [data-tab]');
      if (tab) { S.tab = tab.dataset.tab; S.loaded = false; render(); load(true); return; }
      const op = e.target.closest('#qlBody [data-act]');
      if (op) {
        const r = S.list.find((x) => String(x.id) === op.closest('tr').dataset.id);
        if (!r) return;
        if (op.dataset.act === 'edit') dlgEdit(r);
        else if (op.dataset.act === 'toggle') {
          const next = r.status === 'open' ? 'closed' : 'open';
          if (next === 'closed' && !confirm('确认这条不良已经处理完了吗？')) return;
          rpc('board_quality_set_status', { p_id: r.id, p_status: next }).then((res) => {
            if (!res.ok) { toast('操作失败：' + res.error); return; }
            toast(next === 'closed' ? '已结案' : '已重新打开'); S.loaded = false; load(true);
          });
        }
      }
    });
    document.addEventListener('input', (e) => { if (e.target.id === 'qlSearch') { S.q = e.target.value; render(); } });
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
