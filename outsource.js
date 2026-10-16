/* ============================================================
   外协（委外加工）模块
   文件：public/outsource.js        建立日期：2026-10-16
   依赖：cloud/outsource-schema.sql（表没建之前页面会给明确提示）
   设计：不动 app.js。自己插侧栏入口 + 自己的视图，自己管切换。
   数据（全部只读 + 写入走 RPC）：
     board_outsource_overview / board_outsource_list / board_outsource_create
     board_outsource_receipt / board_outsource_mark_ng / board_outsource_note_arrived
     board_outsource_update / board_outsource_set_status / board_outsource_receipts
   回滚：删掉 index.html 里这一行 <script>
   ============================================================ */
(() => {
  'use strict';

  const VIEW = 'outsource';
  const S = { tab: 'open', list: [], ov: null, orders: [], loaded: false, err: '', busy: false };

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
    if (!base) return { ok: false, offline: true, error: '本地演示模式没有云端接口' };
    try {
      const r = await fetch(base + '/' + name, {
        method: 'POST', headers: headers(), body: JSON.stringify({ p_code: readCode(), ...payload })
      });
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) {
        const msg = (data && (data.message || data.error)) || ('HTTP ' + r.status);
        const missing = /does not exist|could not find|42883|PGRST202/i.test(msg);
        return { ok: false, missingTable: missing, error: msg };
      }
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  /* ---------------- 视图切换（自己管） ---------------- */
  function allViews() { return [...document.querySelectorAll('.desktop-view')]; }
  function showMine() {
    allViews().forEach((v) => { v.hidden = v.id !== 'desktopOutsourceView'; });
    document.querySelectorAll('[data-desktop-view]').forEach((l) =>
      l.classList.toggle('active', l.dataset.desktopView === VIEW));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!S.loaded) load(true);
  }
  function hideMine() {
    const v = document.getElementById('desktopOutsourceView');
    if (v) v.hidden = true;
  }

  /* ---------------- 取数 ---------------- */
  let loadSeq = 0;
  async function load(force) {
    const seq = ++loadSeq;   // 连点页签时，后发的请求为准，不再被吞
    S.busy = true;
    renderBanner('正在读取外协数据…');
    const ov = await rpc('board_outsource_overview');
    // 「已结单」页签要同时看已结单和已作废（SQL 里 all 排除了 cancelled，只能分开取再合并）
    const lists = S.tab === 'closed'
      ? await Promise.all([rpc('board_outsource_list', { p_status: 'closed' }),
                           rpc('board_outsource_list', { p_status: 'cancelled' })])
      : [await rpc('board_outsource_list', { p_status: S.tab === 'open' ? 'open' : S.tab })];
    if (seq !== loadSeq) return;   // 有更新的请求了，这次结果丢弃
    S.busy = false;
    const list = lists.every((x) => x.ok)
      ? {
          ok: true,
          data: [].concat(...lists.map((x) => (Array.isArray(x.data) ? x.data : [])))
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        }
      : (lists.find((x) => !x.ok) || lists[0]);
    if (!ov.ok || !list.ok) {
      const e = ov.ok ? list : ov;
      S.err = e.missingTable
        ? '外协的表还没建。请先在 Supabase → SQL Editor 里执行 cloud\\outsource-schema.sql（整段粘贴，执行一次即可），然后点「刷新」。'
        : (e.offline ? '本地演示模式读不到云端接口。外协模块要在云端管理端使用。' : ('读取失败：' + e.error));
      S.list = []; S.ov = null;
      render();
      return;
    }
    S.err = ''; S.loaded = true;
    S.ov = ov.data; S.list = Array.isArray(list.data) ? list.data : [];
    render();
  }
  async function loadOrders() {
    if (S.orders.length) return;
    try {
      const base = window.SHIPMENT_RPC_BASE;
      let data = null;
      if (base) {
        const r = await rpc('board_get_state');
        if (r.ok) data = r.data;
      } else {
        const h = headers(); const code = readCode(); if (code) h['X-Board-Code'] = code;
        const r = await fetch((window.SHIPMENT_API_BASE || '') + '/api/state', { headers: h, cache: 'no-store' });
        if (r.ok) data = await r.json();
      }
      const open = ((data && data.orders) || []).filter((o) => Number(o.remaining) > 0);
      S.orders = open.map((o) => ({
        id: o.id, po: o.po, seq: o.seq, material: o.material, name: o.name, spec: o.spec,
        remaining: Number(o.remaining || 0), dueDate: o.dueDate,
        label: `${o.po || '无采购单号'} · 项次 ${o.seq} — ${o.material} ${o.name || ''}`.trim()
      }));
    } catch { S.orders = []; }
  }

  /* ---------------- 渲染 ---------------- */
  function renderBanner(text, warn) {
    const b = $('#osBanner');
    if (!b) return;
    if (!text) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'os-banner' + (warn ? ' warn' : '');
    b.innerHTML = text;
  }

  const STATUS_TEXT = { issued: '在途', partial: '部分到货', received: '已交齐', closed: '已结单', cancelled: '已作废' };

  function statusPill(r) {
    if (r.overdueDays > 0) return `<span class="os-pill late">逾期 ${r.overdueDays} 天</span>`;
    if (r.dueToday) return `<span class="os-pill today">今天到期</span>`;
    return `<span class="os-pill${r.status === 'partial' ? ' part' : ' done'}">${STATUS_TEXT[r.status] || r.status}</span>`;
  }

  function row(r) {
    const open = Number(r.openQty || 0);
    const canOps = r.status === 'issued' || r.status === 'partial';
    return `<tr data-id="${esc(r.id)}">
      <td class="wide">${esc(r.vendor)}<span class="sub">${esc(r.name || '')}</span></td>
      <td class="mono">${esc(r.material)}<span class="sub">${esc(r.spec || '—')}</span></td>
      <td class="num">${num(r.qty)}<span class="sub">发 ${md(r.issuedAt)}</span></td>
      <td class="num">${num(r.receivedQty)}${Number(r.ngQty) ? `<span class="sub" style="color:var(--accent)">不良 ${num(r.ngQty)}</span>` : ''}</td>
      <td class="num" style="color:${open > 0 ? 'var(--accent)' : 'var(--muted)'}">${num(open)}</td>
      <td>${esc(md(r.dueDate))}<span class="sub">${statusPill(r)}</span></td>
      <td class="mono">${esc(r.sourcePo || '—')}<span class="sub">项次 ${esc(r.sourceSeq || '—')}</span></td>
      <td><div class="acts">
        <button class="ops pri" data-act="receipt" ${canOps ? '' : 'disabled'}>到货登记</button>
        <button class="ops" data-act="arrived" ${canOps && !r.waitingReceipt ? '' : 'disabled'} title="货到了但还没空登记时先点一下">货已到</button>
        <button class="ops" data-act="history">记录</button>
        <button class="ops" data-act="edit" ${canOps ? '' : 'disabled'}>改</button>
        <button class="ops ng" data-act="ng" ${Number(r.receivedQty) > 0 ? '' : 'disabled'}>标不良</button>
        <button class="ops" data-act="close" ${canOps ? '' : 'disabled'}>结单</button>
      </div></td>
    </tr>`;
  }

  function render() {
    const kp = $('#osKpis');
    if (!kp) return;
    const ov = S.ov || {};
    kp.innerHTML = `
      <div class="os-kpi"><span>在途外协单</span><b>${num(ov.openCount)}</b><i>单 · 欠 ${num(ov.openQty)} 件</i></div>
      <div class="os-kpi${Number(ov.lateCount) ? ' hot' : ''}"><span>到交期还没交齐</span><b>${num(ov.lateCount)}</b><i>单 · 欠 ${num(ov.lateQty)} 件</i></div>
      <div class="os-kpi${Number(ov.waitingCount) ? ' hot' : ''}"><span>货已到待登记</span><b>${num(ov.waitingCount)}</b><i>单</i></div>
      <div class="os-kpi"><span>外协件在库</span><b>${num(ov.stock && ov.stock.qty)}</b><i>件 · ${num(ov.stock && ov.stock.kinds)} 个料号</i></div>`;

    const tabs = [['open', '在途'], ['late', '逾期未交齐'], ['all', '全部'], ['closed', '已结单 / 已作废']];
    $('#osTabs').innerHTML = tabs.map(([k, label]) =>
      `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${label}</button>`).join('');

    if (S.err) {
      renderBanner(esc(S.err), true);
      $('#osBody').innerHTML = '';
      $('#osEmpty').hidden = false;
      $('#osEmpty').innerHTML = `<b>还没有数据</b>${esc(S.err)}`;
      return;
    }
    renderBanner('');
    $('#osEmpty').hidden = S.list.length > 0;
    $('#osEmpty').innerHTML = '<b>这个筛选下没有外协单</b>点右上角「新建外协单」开始。';
    $('#osBody').innerHTML = S.list.map(row).join('');
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(html) {
    closeModal();
    const mask = document.createElement('div'); mask.className = 'os-mask'; mask.id = 'osMask';
    const modal = document.createElement('div'); modal.className = 'os-modal'; modal.id = 'osModal';
    modal.innerHTML = `<div class="os-card">${html}</div>`;
    document.body.appendChild(mask); document.body.appendChild(modal);
    mask.addEventListener('click', closeModal);
    document.addEventListener('keydown', escClose);
    return modal;
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    document.getElementById('osMask')?.remove();
    document.getElementById('osModal')?.remove();
    document.removeEventListener('keydown', escClose);
  }
  function formErr(modal, msg) {
    let el = modal.querySelector('.os-err');
    if (!el) { el = document.createElement('div'); el.className = 'os-err'; modal.querySelector('.os-card').appendChild(el); }
    el.textContent = msg;
  }

  /* ---- 新建外协单 ---- */
  async function dlgNew() {
    openModal(`
      <h3>新建外协单</h3>
      <div class="os-sub">填好发出去的数量和交期。关联本厂订单后，就能看出“哪张单因为外协没到货卡住了”。</div>
      <div class="os-form">
        <label class="full"><span>关联本厂订单（可搜索采购单号 / 料号 / 品名）</span>
          <input id="osPick" list="osPickList" placeholder="输入采购单号或料号，选一条" autocomplete="off">
          <datalist id="osPickList"></datalist>
          <div class="hint2">选中后自动带出料号 / 品名 / 图号；也可以不选，手工填。</div>
        </label>
        <label><span>外协厂 *</span><input id="osVendor" placeholder="如：华鑫喷涂" list="osVendorList"><datalist id="osVendorList"></datalist></label>
        <label><span>数量 *</span><input id="osQty" type="number" step="1" min="1" placeholder="发出数量"></label>
        <label><span>料号 *</span><input id="osMaterial" placeholder="如 614004030B"></label>
        <label><span>图号 / 规格</span><input id="osSpec" placeholder="如 6254E-MDN-A10-B4"></label>
        <label class="full"><span>品名</span><input id="osName" placeholder="如 护栏组焊件(喷涂后)(ZZ)"></label>
        <label><span>外协单价（元）</span><input id="osPrice" type="number" step="0.0001" min="0" placeholder="可不填"></label>
        <label><span>要求交期</span><input id="osDue" type="date" value="${todayStr()}"></label>
        <label class="full"><span>备注</span><textarea id="osNote" placeholder="工艺要求 / 颜色 / 包装要求…"></textarea></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">建单</button></div>`);

    const modal = document.getElementById('osModal');
    await loadOrders();
    const dl = modal.querySelector('#osPickList');
    dl.innerHTML = S.orders.slice(0, 800).map((o) => `<option value="${esc(o.label)}"></option>`).join('');
    const vdl = modal.querySelector('#osVendorList');
    const vendors = [...new Set(S.list.map((r) => r.vendor).filter(Boolean))];
    vdl.innerHTML = vendors.map((v) => `<option value="${esc(v)}"></option>`).join('');

    modal.querySelector('#osPick').addEventListener('change', (e) => {
      const hit = S.orders.find((o) => o.label === e.target.value.trim());
      if (!hit) return;
      modal.querySelector('#osMaterial').value = hit.material || '';
      modal.querySelector('#osName').value = hit.name || '';
      modal.querySelector('#osSpec').value = hit.spec || '';
    });

    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const pick = S.orders.find((o) => o.label === modal.querySelector('#osPick').value.trim()) || null;
      const payload = {
        vendor: modal.querySelector('#osVendor').value.trim(),
        material: modal.querySelector('#osMaterial').value.trim(),
        name: modal.querySelector('#osName').value.trim(),
        spec: modal.querySelector('#osSpec').value.trim(),
        qty: modal.querySelector('#osQty').value.trim(),
        unitPrice: modal.querySelector('#osPrice').value.trim(),
        dueDate: modal.querySelector('#osDue').value,
        note: modal.querySelector('#osNote').value.trim(),
        sourceOrderId: pick ? pick.id : '', sourcePo: pick ? pick.po : '', sourceSeq: pick ? pick.seq : ''
      };
      if (!payload.vendor || !payload.material || !payload.qty) { formErr(modal, '外协厂、料号、数量都要填'); return; }
      b.disabled = true;
      const r = await rpc('board_outsource_create', { p_payload: payload });
      b.disabled = false;
      if (!r.ok) { formErr(modal, r.missingTable ? '表还没建，先执行 outsource-schema.sql' : ('建单失败：' + r.error)); return; }
      closeModal(); toast('外协单已建'); load(true);
    });
  }

  /* ---- 到货登记 ---- */
  function dlgReceipt(r) {
    openModal(`
      <h3>到货登记（确认入库）</h3>
      <div class="os-sub">${esc(r.vendor)} · ${esc(r.material)} ${esc(r.name || '')}</div>
      <div class="os-kv">
        <i>发出数量</i><span>${num(r.qty)} 件</span>
        <i>已到货</i><span>${num(r.receivedQty)} 件</span>
        <i>还欠</i><span style="color:var(--accent)">${num(r.openQty)} 件</span>
        <i>要求交期</i><span>${esc(md(r.dueDate))}</span>
      </div>
      <div class="os-form">
        <label><span>本次到货数量 *</span><input id="osRq" type="number" step="1" min="1" value="${Number(r.openQty) || ''}"></label>
        <label><span>到货日期</span><input id="osRd" type="date" value="${todayStr()}"></label>
        <label class="full"><span>备注</span><input id="osRn" placeholder="如：分两次送，先送一半"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">确认入库</button></div>`);
    const modal = document.getElementById('osModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const qty = modal.querySelector('#osRq').value.trim();
      if (!qty || Number(qty) <= 0) { formErr(modal, '到货数量要大于 0'); return; }
      b.disabled = true;
      const res = await rpc('board_outsource_receipt', { p_payload: {
        outsourceOrderId: r.id, qty, receivedAt: modal.querySelector('#osRd').value,
        note: modal.querySelector('#osRn').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '登记失败：' + res.error); return; }
      closeModal(); toast('已确认入库 ' + num(qty) + ' 件'); load(true);
    });
  }

  /* ---- 标记不良 ---- */
  async function dlgNg(r) {
    const rec = await rpc('board_outsource_receipts', { p_order_id: r.id });
    if (!rec.ok) { toast('读不到到货记录'); return; }
    const list = Array.isArray(rec.data) ? rec.data : [];
    if (!list.length) { toast('这张单还没有到货记录，先登记到货'); return; }
    openModal(`
      <h3>标记不良</h3>
      <div class="os-sub">生产过程中发现的不良，打在对应的到货批次上，方便追溯是哪一批来的。</div>
      <div class="os-receipts"><table>
        <thead><tr><th>到货日期</th><th>数量</th><th>已标不良</th><th>操作</th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td>${esc(md(x.receivedAt))}</td>
          <td>${num(x.qty)} 件</td>
          <td>${Number(x.ngQty) ? '<span style="color:var(--accent)">' + num(x.ngQty) + ' 件</span>' : '—'}</td>
          <td><button class="ops ng" data-ng="${esc(x.id)}" data-max="${Number(x.qty) - Number(x.ngQty)}">标记</button></td>
        </tr>`).join('')}</tbody></table></div>
      <div class="os-form" id="osNgForm" hidden>
        <label><span>不良数量 *</span><input id="osNgQ" type="number" step="1" min="1"></label>
        <label><span>&nbsp;</span><input id="osNgT" placeholder="不良原因（可空）" style="width:100%"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">关闭</button><button class="pri" data-x="save" hidden>确认标记</button></div>`);
    const modal = document.getElementById('osModal');
    let pickId = '';
    modal.addEventListener('click', async (e) => {
      const nb = e.target.closest('[data-ng]');
      if (nb) {
        pickId = nb.dataset.ng;
        modal.querySelector('#osNgForm').hidden = false;
        modal.querySelector('#osNgQ').value = nb.dataset.max;
        modal.querySelector('#osNgQ').max = nb.dataset.max;
        modal.querySelector('[data-x="save"]').hidden = false;
        modal.querySelector('#osNgQ').focus();
        return;
      }
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const q = modal.querySelector('#osNgQ').value.trim();
      if (!q || Number(q) <= 0) { formErr(modal, '不良数量要大于 0'); return; }
      b.disabled = true;
      const res = await rpc('board_outsource_mark_ng', { p_payload: { receiptId: pickId, qty: q, note: modal.querySelector('#osNgT').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '标记失败：' + res.error); return; }
      closeModal(); toast('已标不良 ' + num(q) + ' 件'); load(true);
    });
  }

  /* ---- 改交期 / 数量 / 单价 ---- */
  function dlgEdit(r) {
    openModal(`
      <h3>修改外协单</h3>
      <div class="os-sub">${esc(r.vendor)} · ${esc(r.material)} ${esc(r.name || '')}</div>
      <div class="os-form">
        <label><span>发出数量</span><input id="osEq" type="number" step="1" min="1" value="${Number(r.qty)}"></label>
        <label><span>要求交期</span><input id="osEd" type="date" value="${esc(String(r.dueDate || '').slice(0, 10))}"></label>
        <label><span>外协单价（元）</span><input id="osEp" type="number" step="0.0001" min="0" value="${r.unitPrice == null ? '' : Number(r.unitPrice)}"></label>
        <label><span>&nbsp;</span><div class="hint2" style="margin-top:8px">数量改了以后，欠交会自动跟着变。</div></label>
        <label class="full"><span>备注</span><input id="osEn" value="${esc(r.note || '')}"></label>
      </div>
      <div class="os-foot">
        <button data-x="cancel">取消</button>
        <button data-x="cancel2" style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)">作废这张</button>
        <button class="pri" data-x="save">保存</button>
      </div>`);
    const modal = document.getElementById('osModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      if (b.dataset.x === 'cancel2') {
        if (!confirm('作废后这张外协单不再出现在在途列表里，确定吗？')) return;
        const res = await rpc('board_outsource_set_status', { p_id: r.id, p_status: 'cancelled' });
        if (!res.ok) { formErr(modal, '作废失败：' + res.error); return; }
        closeModal(); toast('已作废'); load(true); return;
      }
      b.disabled = true;
      const res = await rpc('board_outsource_update', { p_payload: {
        id: r.id, qty: modal.querySelector('#osEq').value.trim(),
        dueDate: modal.querySelector('#osEd').value, unitPrice: modal.querySelector('#osEp').value.trim(),
        note: modal.querySelector('#osEn').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '保存失败：' + res.error); return; }
      closeModal(); toast('已保存'); load(true);
    });
  }

  /* ---- 到货记录 ---- */
  async function dlgHistory(r) {
    const rec = await rpc('board_outsource_receipts', { p_order_id: r.id });
    const list = (rec.ok && Array.isArray(rec.data)) ? rec.data : [];
    openModal(`
      <h3>到货记录</h3>
      <div class="os-sub">${esc(r.vendor)} · ${esc(r.material)} · 发出 ${num(r.qty)} 件 / 已到 ${num(r.receivedQty)} 件</div>
      ${list.length ? `<div class="os-receipts"><table>
        <thead><tr><th>到货日期</th><th>数量</th><th>不良</th><th>经手</th><th>备注</th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td>${esc(md(x.receivedAt))}</td>
          <td>${num(x.qty)} 件</td>
          <td>${Number(x.ngQty) ? '<span style="color:var(--accent)">' + num(x.ngQty) + ' 件' + (x.ngNote ? '：' + esc(x.ngNote) : '') + '</span>' : '—'}</td>
          <td>${esc(x.operator || '—')}</td>
          <td>${esc(x.note || '—')}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="os-sub">还没有到货记录。</div>'}
      <div class="os-foot"><button data-x="cancel">关闭</button></div>`);
    document.getElementById('osModal').addEventListener('click', (e) => {
      if (e.target.closest('[data-x]')) closeModal();
    });
  }

  function toast(msg) { if (window.showToast) window.showToast(msg); else console.log(msg); }

  /* ---------------- 装 UI ---------------- */
  function build() {
    if (document.getElementById('desktopOutsourceView')) return;

    const nav = document.querySelector('.side-nav');
    if (nav && !nav.querySelector('[data-desktop-view="outsource"]')) {
      const a = document.createElement('a');
      a.className = 'side-link';
      a.href = '#outsource';
      a.dataset.desktopView = 'outsource';
      a.innerHTML = '<span class="nav-dot"></span>外协管理';
      const anchor = nav.querySelector('[data-desktop-view="files"]');
      if (anchor) nav.insertBefore(a, anchor); else nav.appendChild(a);
    }

    const main = document.querySelector('main.main-area');
    if (main) {
      const sec = document.createElement('section');
      sec.id = 'desktopOutsourceView';
      sec.className = 'desktop-view desktop-only';
      sec.hidden = true;
      sec.innerHTML = `
        <header class="topbar">
          <div><div class="eyebrow">委外加工</div><h1>外协管理</h1></div>
          <div class="topbar-actions">
            <button id="osRefresh" class="button">刷新</button>
            <button id="osNew" class="button primary">新建外协单</button>
          </div>
        </header>
        <section class="panel os-panel">
          <div id="osKpis" class="os-kpis"></div>
          <div id="osTabs" class="os-tabs"></div>
          <div id="osBanner" class="os-banner" hidden></div>
          <div class="os-tablewrap">
            <table class="os-table">
              <thead><tr>
                <th>外协厂 / 品名</th><th>料号 / 图号</th><th>发出</th><th>已到</th>
                <th>欠交</th><th>交期</th><th>关联订单</th><th>操作</th>
              </tr></thead>
              <tbody id="osBody"></tbody>
            </table>
          </div>
          <div id="osEmpty" class="os-empty" hidden></div>
        </section>`;
      main.appendChild(sec);
    }

    // 点我自己的入口 → 显示我的视图
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.side-link[data-desktop-view]');
      if (!link) return;
      if (link.dataset.desktopView === VIEW) { e.preventDefault(); showMine(); }
      else hideMine();
    }, true);
    // 视图切换按钮 / 刷新 / 新建 / 表格操作
    document.addEventListener('click', (e) => {
      if (e.target.closest('#osRefresh')) { load(true); return; }
      if (e.target.closest('#osNew')) { dlgNew(); return; }
      const tab = e.target.closest('#osTabs [data-tab]');
      if (tab) { S.tab = tab.dataset.tab; render(); load(true); return; }
      const op = e.target.closest('#osBody [data-act]');
      if (op) {
        const tr = op.closest('tr'); const r = S.list.find((x) => String(x.id) === tr.dataset.id);
        if (!r) return;
        const act = op.dataset.act;
        if (act === 'receipt') dlgReceipt(r);
        else if (act === 'arrived') rpc('board_outsource_note_arrived', { p_id: r.id }).then((res) => {
          if (!res.ok) { toast('标记失败：' + res.error); return; } toast('已标记「货已到，待登记」'); load(true); });
        else if (act === 'history') dlgHistory(r);
        else if (act === 'edit') dlgEdit(r);
        else if (act === 'ng') dlgNg(r);
        else if (act === 'close') {
          if (!confirm('结单后这张外协单不再出现在在途列表，确定已经交齐/对完账了吗？')) return;
          rpc('board_outsource_set_status', { p_id: r.id, p_status: 'closed' }).then((res) => {
            if (!res.ok) { toast('结单失败：' + res.error); return; } toast('已结单'); load(true); });
        }
      }
    });
  }

  function init() {
    const isMobile = /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile';
    if (isMobile) return;            // 这一版只做网页端
    build();
    if ((location.hash || '').replace('#', '') === VIEW) setTimeout(showMine, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
