/* ============================================================
   采购 / 来料模块（第一梯队第 3 步）
   文件：public/purchase.js         建立日期：2026-10-16
   依赖：cloud/purchase-schema.sql（表 + 11 个接口）
   说明：到货登记会自动入「原材料」库存 + 写流水；
         不良沿用外协一致规则（入库后生产中发现才打标签）。
   回滚：删掉 index.html 里这一行 <script>
   ============================================================ */
(() => {
  'use strict';

  const VIEW = 'purchase';
  const S = { tab: 'open', list: [], ov: null, suppliers: [], orders: [], loaded: false, err: '', q: '' };
  const CACHE_KEY = 'shipmentBoardPurchaseCacheV1';

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
      if (live && live.pur && Array.isArray(live.puList)) {
        const rows = live.puList.filter((row) => S.tab === 'open'
          ? row.status === 'ordered' || row.status === 'partial'
          : S.tab === 'closed' ? row.status === 'closed' || row.status === 'cancelled' : row.status === S.tab);
        S.ov = live.pur; S.list = rows; S.loaded = true; S.err = '';
        render();
        return true;
      }      const cached = JSON.parse(localStorage.getItem('shipmentBoardDashboardCacheV2') || 'null');
      const d = cached && Date.now() - Number(cached.savedAt || 0) < 2 * 60 * 60 * 1000 ? cached.data : null;
      if (!d || !d.pur || !Array.isArray(d.puList)) return false;
      const rows = d.puList.filter((row) => S.tab === 'open'
        ? row.status === 'ordered' || row.status === 'partial'
        : S.tab === 'closed' ? row.status === 'closed' || row.status === 'cancelled' : row.status === S.tab);
      S.ov = d.pur; S.list = rows; S.loaded = true; S.err = '';
      render();
      return true;
    } catch { return false; }
  }
  function showMine() {
    document.querySelectorAll('.desktop-view').forEach((v) => { v.hidden = v.id !== 'desktopPurchaseView'; });
    document.querySelectorAll('[data-desktop-view]').forEach((l) =>
      l.classList.toggle('active', l.dataset.desktopView === VIEW));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (!S.loaded) { previewFromDashboard(); load(true); }
  }
  function hideMine() { const v = document.getElementById('desktopPurchaseView'); if (v) v.hidden = true; }

  let loadSeq = 0;
  async function load(force) {
    const seq = ++loadSeq;
    renderBanner('正在读取采购数据…');
    const listsPromise = S.tab === 'closed'
      ? Promise.all([rpc('board_purchase_list', { p_status: 'closed' }),
                     rpc('board_purchase_list', { p_status: 'cancelled' })])
      : rpc('board_purchase_list', { p_status: S.tab === 'open' ? 'open' : S.tab });
    const [ov, listResult] = await Promise.all([rpc('board_purchase_overview'), listsPromise]);
    const lists = Array.isArray(listResult) ? listResult : [listResult];
    if (seq !== loadSeq) return;
    const list = lists.every((x) => x.ok)
      ? { ok: true, data: [].concat(...lists.map((x) => (Array.isArray(x.data) ? x.data : [])))
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) }
      : (lists.find((x) => !x.ok) || lists[0]);
    if (!ov.ok || !list.ok) {
      const e = ov.ok ? list : ov;
      S.err = e.missingTable
        ? '采购的表还没建。请先在 Supabase → SQL Editor 里执行 cloud\\purchase-schema.sql，然后点「刷新」。'
        : (String(e.error).includes('本地模式') ? '本地演示模式读不到云端接口。采购模块要在云端管理端使用。'
          : ('读取失败：' + e.error));
      S.list = []; S.ov = null; S.loaded = false;
    } else {
      S.err = ''; S.loaded = true; S.ov = ov.data; S.list = Array.isArray(list.data) ? list.data : [];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), tab: S.tab, ov: S.ov, list: S.list })); } catch { }
    }
    render();
  }

  function renderBanner(text, warn) {
    const b = $('#puBanner'); if (!b) return;
    if (!text) { b.hidden = true; return; }
    b.hidden = false; b.className = 'os-banner' + (warn ? ' warn' : ''); b.innerHTML = text;
  }
  const ST = { ordered: '在途', partial: '部分到货', received: '已到齐', closed: '已结单', cancelled: '已作废' };
  function pill(r) {
    if (r.overdueDays > 0) return `<span class="os-pill late">逾期 ${r.overdueDays} 天</span>`;
    if (r.dueToday) return `<span class="os-pill today">今天到货</span>`;
    return `<span class="os-pill${r.status === 'partial' ? ' part' : ' done'}">${ST[r.status] || r.status}</span>`;
  }
  function filtered() {
    const q = S.q.trim().toLowerCase();
    if (!q) return S.list;
    return S.list.filter((r) => [r.supplier, r.material, r.name, r.spec, r.sourcePo].join(' ').toLowerCase().includes(q));
  }
  function row(r) {
    const open = Number(r.openQty || 0);
    const canOps = r.status === 'ordered' || r.status === 'partial';
    return `<tr data-id="${esc(r.id)}">
      <td class="wide">${esc(r.supplier)}<span class="sub">${esc(r.name || '')}</span></td>
      <td class="mono">${esc(r.material)}<span class="sub">${esc(r.spec || '—')}</span></td>
      <td class="num">${num(r.qty)}<span class="unit">${esc(r.unit || '件')}</span><span class="sub">订 ${esc(md(r.orderedAt))}</span></td>
      <td class="num">${num(r.receivedQty)}${Number(r.ngQty) ? `<span class="sub" style="color:var(--accent)">不良 ${num(r.ngQty)}</span>` : ''}</td>
      <td class="num" style="color:${open > 0 ? 'var(--accent)' : 'var(--muted)'}">${num(open)}</td>
      <td>${esc(md(r.dueDate))}<span class="sub">${pill(r)}</span></td>
      <td><div class="acts">
        <button class="ops pri" data-act="receipt" ${canOps ? '' : 'disabled'}>到货登记</button>
        <button class="ops" data-act="arrived" ${canOps && !r.waitingReceipt ? '' : 'disabled'} title="货到了但还没空登记时先点一下">货已到</button>
        <button class="ops" data-act="history">记录</button>
        <button class="ops" data-act="edit" ${canOps ? '' : 'disabled'}>改</button>
        <button class="ops ng" data-act="ng" ${Number(r.receivedQty) > 0 ? '' : 'disabled'}>标不良</button>
        <button class="ops" data-act="po" title="按单号打印采购单">采购单</button>
        <button class="ops" data-act="close" ${canOps ? '' : 'disabled'}>结单</button>
      </div></td>
    </tr>`;
  }
  function render() {
    if (!$('#puKpis')) return;
    const ov = S.ov || {};
    $('#puKpis').innerHTML = `
      <div class="os-kpi"><span>在途采购单</span><b>${num(ov.openCount)}</b><i>单 · 欠 ${num(ov.openQty)}</i></div>
      <div class="os-kpi${Number(ov.lateCount) ? ' hot' : ''}"><span>到货日还没到齐</span><b>${num(ov.lateCount)}</b><i>单</i></div>
      <div class="os-kpi${Number(ov.waitingCount) ? ' hot' : ''}"><span>货已到待登记</span><b>${num(ov.waitingCount)}</b><i>单</i></div>
      <div class="os-kpi"><span>供应商</span><b>${num((S.suppliers || []).length)}</b><i>家</i></div>`;

    $('#puTabs').innerHTML = [['open', '在途'], ['late', '逾期未到'], ['all', '全部'], ['closed', '已结单 / 已作废']]
      .map(([k, label]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${label}</button>`).join('');

    if (S.err) {
      renderBanner(esc(S.err), true);
      $('#puBody').innerHTML = ''; $('#puEmpty').hidden = false;
      $('#puEmpty').innerHTML = `<b>还没有数据</b>${esc(S.err)}`;
      return;
    }
    renderBanner('');
    const rows = filtered();
    $('#puEmpty').hidden = rows.length > 0;
    $('#puEmpty').innerHTML = '<b>这个筛选下没有采购单</b>';
    $('#puBody').innerHTML = rows.map(row).join('');
  }

  /* ---------- 弹窗 ---------- */
  function openModal(html) {
    closeModal();
    const mask = document.createElement('div'); mask.className = 'os-mask'; mask.id = 'puMask';
    const modal = document.createElement('div'); modal.className = 'os-modal'; modal.id = 'puModal';
    modal.innerHTML = `<div class="os-card">${html}</div>`;
    document.body.appendChild(mask); document.body.appendChild(modal);
    mask.addEventListener('click', closeModal);
    document.addEventListener('keydown', escClose);
    return modal;
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    document.getElementById('puMask')?.remove();
    document.getElementById('puModal')?.remove();
    document.removeEventListener('keydown', escClose);
  }
  function formErr(modal, msg) {
    let el = modal.querySelector('.os-err');
    if (!el) { el = document.createElement('div'); el.className = 'os-err'; modal.querySelector('.os-card').appendChild(el); }
    el.textContent = msg;
  }
  function toast(m) { if (window.showToast) window.showToast(m); else console.log(m); }

  async function ensureSuppliers() {
    if (S.suppliers.length) return;
    const r = await rpc('board_supplier_list');
    S.suppliers = (r.ok && Array.isArray(r.data)) ? r.data : [];
  }
  async function loadOpenOrders() {
    if (S.orders.length) return;
    try {
      const r = await rpc('board_get_state');
      const data = r.ok ? r.data : null;
      S.orders = ((data && data.orders) || []).filter((o) => Number(o.remaining) > 0)
        .map((o) => ({ id: o.id, po: o.po, material: o.material, name: o.name, spec: o.spec,
          label: `${o.po || '无采购单号'} · 项次 ${o.seq} — ${o.material} ${o.name || ''}`.trim() }));
    } catch { S.orders = []; }
  }

  async function dlgNew() {
    openModal(`
      <h3>新建采购单</h3>
      <div class="os-sub">买进来的钢板、型材、标准件、辅料。到货登记时会自动入「原材料」库存。</div>
      <div class="os-form">
        <label><span>供应商 *</span><input id="puSup" list="puSupList" placeholder="如：沙钢 / 无锡钢材"><datalist id="puSupList"></datalist></label>
        <label><span>数量 *</span><input id="puQty" type="number" step="0.01" min="0.01" placeholder="如 2"></label>
        <label><span>料号 / 材质 *</span><input id="puMat" placeholder="如 Q235B-10mm / 410151020"></label>
        <label><span>规格</span><input id="puSpec" placeholder="如 1500×6000×10"></label>
        <label class="full"><span>品名</span><input id="puName" placeholder="如：钢板 / 方管 40×40"></label>
        <label><span>单位</span><input id="puUnit" value="件" list="puUnitList"><datalist id="puUnitList">
          <option value="件"></option><option value="张"></option><option value="吨"></option><option value="米"></option><option value="公斤"></option><option value="套"></option></datalist></label>
        <label><span>单价（元）</span><input id="puPrice" type="number" step="0.0001" min="0" placeholder="可不填"></label>
        <label><span>约定到货日</span><input id="puDue" type="date" value="${todayStr()}"></label>
        <label><span>下单日</span><input id="puOrdered" type="date" value="${todayStr()}"></label>
        <label class="full"><span>关联生产订单（备料给哪张单，可不填）</span><input id="puPick" list="puPickList" placeholder="输入采购单号或料号，选一条"><datalist id="puPickList"></datalist></label>
        <label class="full"><span>备注</span><input id="puNote" placeholder="材质要求 / 送货地址…"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">建单</button></div>`);

    const modal = document.getElementById('puModal');
    await Promise.all([ensureSuppliers(), loadOpenOrders()]);
    modal.querySelector('#puSupList').innerHTML = S.suppliers.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
    modal.querySelector('#puPickList').innerHTML = S.orders.slice(0, 800).map((o) => `<option value="${esc(o.label)}"></option>`).join('');
    modal.querySelector('#puPick').addEventListener('change', (e) => {
      const hit = S.orders.find((o) => o.label === e.target.value.trim());
      if (!hit) return;
      modal.querySelector('#puMat').value = hit.material || '';
      modal.querySelector('#puName').value = hit.name || '';
      modal.querySelector('#puSpec').value = hit.spec || '';
    });

    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const pick = S.orders.find((o) => o.label === modal.querySelector('#puPick').value.trim()) || null;
      const payload = {
        supplier: modal.querySelector('#puSup').value.trim(),
        material: modal.querySelector('#puMat').value.trim(),
        name: modal.querySelector('#puName').value.trim(),
        spec: modal.querySelector('#puSpec').value.trim(),
        qty: modal.querySelector('#puQty').value.trim(),
        unit: modal.querySelector('#puUnit').value.trim(),
        unitPrice: modal.querySelector('#puPrice').value.trim(),
        dueDate: modal.querySelector('#puDue').value,
        orderedAt: modal.querySelector('#puOrdered').value,
        note: modal.querySelector('#puNote').value.trim(),
        sourceOrderId: pick ? pick.id : '', sourcePo: pick ? pick.po : ''
      };
      if (!payload.supplier || !payload.material || !payload.qty) { formErr(modal, '供应商、料号、数量都要填'); return; }
      b.disabled = true;
      const r = await rpc('board_purchase_create', { p_payload: payload });
      b.disabled = false;
      if (!r.ok) { formErr(modal, r.missingTable ? '表还没建，先执行 purchase-schema.sql' : ('建单失败：' + r.error)); return; }
      closeModal(); toast('采购单已建'); S.loaded = false; load(true);
    });
  }

  function dlgReceipt(r) {
    openModal(`
      <h3>到货登记（确认入库）</h3>
      <div class="os-sub">${esc(r.supplier)} · ${esc(r.material)} ${esc(r.name || '')}</div>
      <div class="os-kv">
        <i>订购数量</i><span>${num(r.qty)} ${esc(r.unit || '件')}</span>
        <i>已到货</i><span>${num(r.receivedQty)}</span>
        <i>还欠</i><span style="color:var(--accent)">${num(r.openQty)}</span>
        <i>约定到货日</i><span>${esc(md(r.dueDate))}</span>
      </div>
      <div class="os-form">
        <label><span>本次到货数量 *</span><input id="puRq" type="number" step="0.01" min="0.01" value="${Number(r.openQty) || ''}"></label>
        <label><span>到货日期</span><input id="puRd" type="date" value="${todayStr()}"></label>
        <label class="full"><span>备注</span><input id="puRn" placeholder="如：分两车送，先送一车"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">取消</button><button class="pri" data-x="save">确认入库</button></div>`);
    const modal = document.getElementById('puModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const qty = modal.querySelector('#puRq').value.trim();
      if (!qty || Number(qty) <= 0) { formErr(modal, '到货数量要大于 0'); return; }
      b.disabled = true;
      const res = await rpc('board_purchase_receipt', { p_payload: {
        purchaseOrderId: r.id, qty, receivedAt: modal.querySelector('#puRd').value,
        note: modal.querySelector('#puRn').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '登记失败：' + res.error); return; }
      closeModal(); toast('已确认入库 ' + num(qty) + ' ' + (r.unit || '件')); S.loaded = false; load(true);
    });
  }

  async function dlgNg(r) {
    const rec = await rpc('board_purchase_receipts', { p_order_id: r.id });
    const list = (rec.ok && Array.isArray(rec.data)) ? rec.data : [];
    if (!list.length) { toast('这张单还没有到货记录，先登记到货'); return; }
    openModal(`
      <h3>标记不良</h3>
      <div class="os-sub">生产过程中发现的不良，打在对应的到货批次上，方便追溯是哪一批来的。</div>
      <div class="os-receipts"><table>
        <thead><tr><th>到货日期</th><th>数量</th><th>已标不良</th><th>操作</th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td>${esc(md(x.receivedAt))}</td><td>${num(x.qty)}</td>
          <td>${Number(x.ngQty) ? '<span style="color:var(--accent)">' + num(x.ngQty) + '</span>' : '—'}</td>
          <td><button class="ops ng" data-ng="${esc(x.id)}" data-max="${Number(x.qty) - Number(x.ngQty)}">标记</button></td>
        </tr>`).join('')}</tbody></table></div>
      <div class="os-form" id="puNgForm" hidden>
        <label><span>不良数量 *</span><input id="puNgQ" type="number" step="0.01" min="0.01"></label>
        <label><span>不良原因</span><input id="puNgT" placeholder="如：厚度不够 / 有锈"></label>
      </div>
      <div class="os-foot"><button data-x="cancel">关闭</button><button class="pri" data-x="save" hidden>确认标记</button></div>`);
    const modal = document.getElementById('puModal');
    let pickId = '';
    modal.addEventListener('click', async (e) => {
      const nb = e.target.closest('[data-ng]');
      if (nb) {
        pickId = nb.dataset.ng;
        modal.querySelector('#puNgForm').hidden = false;
        const qi = modal.querySelector('#puNgQ'); qi.value = nb.dataset.max; qi.max = nb.dataset.max;
        modal.querySelector('[data-x="save"]').hidden = false; qi.focus(); return;
      }
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      const q = modal.querySelector('#puNgQ').value.trim();
      if (!q || Number(q) <= 0) { formErr(modal, '不良数量要大于 0'); return; }
      b.disabled = true;
      const res = await rpc('board_purchase_mark_ng', { p_payload: { receiptId: pickId, qty: q, note: modal.querySelector('#puNgT').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '标记失败：' + res.error); return; }
      closeModal(); toast('已标不良 ' + num(q)); S.loaded = false; load(true);
    });
  }

  function dlgEdit(r) {
    openModal(`
      <h3>修改采购单</h3>
      <div class="os-sub">${esc(r.supplier)} · ${esc(r.material)} ${esc(r.name || '')}</div>
      <div class="os-form">
        <label><span>订购数量</span><input id="puEq" type="number" step="0.01" min="0.01" value="${Number(r.qty)}"></label>
        <label><span>单位</span><input id="puEu" value="${esc(r.unit || '件')}"></label>
        <label><span>约定到货日</span><input id="puEd" type="date" value="${esc(String(r.dueDate || '').slice(0, 10))}"></label>
        <label><span>单价（元）</span><input id="puEp" type="number" step="0.0001" min="0" value="${r.unitPrice == null ? '' : Number(r.unitPrice)}"></label>
        <label class="full"><span>备注</span><input id="puEn" value="${esc(r.note || '')}"></label>
      </div>
      <div class="os-foot">
        <button data-x="cancel">取消</button>
        <button data-x="cancel2" style="color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)">作废这张</button>
        <button class="pri" data-x="save">保存</button>
      </div>`);
    const modal = document.getElementById('puModal');
    modal.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeModal(); return; }
      if (b.dataset.x === 'cancel2') {
        if (!confirm('作废后这张采购单不再出现在在途列表里，确定吗？')) return;
        const res = await rpc('board_purchase_set_status', { p_id: r.id, p_status: 'cancelled' });
        if (!res.ok) { formErr(modal, '作废失败：' + res.error); return; }
        closeModal(); toast('已作废'); S.loaded = false; load(true); return;
      }
      b.disabled = true;
      const res = await rpc('board_purchase_update', { p_payload: {
        id: r.id, qty: modal.querySelector('#puEq').value.trim(), unit: modal.querySelector('#puEu').value.trim(),
        dueDate: modal.querySelector('#puEd').value, unitPrice: modal.querySelector('#puEp').value.trim(),
        note: modal.querySelector('#puEn').value.trim() } });
      b.disabled = false;
      if (!res.ok) { formErr(modal, '保存失败：' + res.error); return; }
      closeModal(); toast('已保存'); S.loaded = false; load(true);
    });
  }

  async function dlgHistory(r) {
    const rec = await rpc('board_purchase_receipts', { p_order_id: r.id });
    const list = (rec.ok && Array.isArray(rec.data)) ? rec.data : [];
    openModal(`
      <h3>到货记录</h3>
      <div class="os-sub">${esc(r.supplier)} · ${esc(r.material)} · 订购 ${num(r.qty)} / 已到 ${num(r.receivedQty)}</div>
      ${list.length ? `<div class="os-receipts"><table>
        <thead><tr><th>到货日期</th><th>数量</th><th>不良</th><th>经手</th><th>备注</th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td>${esc(md(x.receivedAt))}</td><td>${num(x.qty)}</td>
          <td>${Number(x.ngQty) ? '<span style="color:var(--accent)">' + num(x.ngQty) + (x.ngNote ? '：' + esc(x.ngNote) : '') + '</span>' : '—'}</td>
          <td>${esc(x.operator || '—')}</td><td>${esc(x.note || '—')}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="os-sub">还没有到货记录。</div>'}
      <div class="os-foot"><button data-x="cancel">关闭</button></div>`);
    document.getElementById('puModal').addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeModal(); });
  }

  /* ---------- 装 UI ---------- */
  function build() {
    if (document.getElementById('desktopPurchaseView')) return;

    const nav = document.querySelector('.side-nav');
    if (nav && !nav.querySelector('[data-desktop-view="purchase"]')) {
      const a = document.createElement('a');
      a.className = 'side-link'; a.href = '#purchase'; a.dataset.desktopView = 'purchase';
      a.innerHTML = '<span class="nav-dot"></span>采购 / 来料';
      const inv = nav.querySelector('[data-desktop-view="inventory"]');
      const anchor = nav.querySelector('[data-desktop-view="files"]');
      if (inv && inv.nextSibling) nav.insertBefore(a, inv.nextSibling);
      else if (anchor) nav.insertBefore(a, anchor);
      else nav.appendChild(a);
    }

    const main = document.querySelector('main.main-area');
    if (main) {
      const sec = document.createElement('section');
      sec.id = 'desktopPurchaseView';
      sec.className = 'desktop-view desktop-only';
      sec.hidden = true;
      sec.innerHTML = `
        <header class="topbar">
          <div><div class="eyebrow">买料进货</div><h1>采购 / 来料</h1></div>
          <div class="topbar-actions">
            <button id="puRefresh" class="button">刷新</button>
            <button id="puNew" class="button primary">新建采购单</button>
          </div>
        </header>
        <section class="panel os-panel">
          <div id="puKpis" class="os-kpis"></div>
          <div id="puTabs" class="os-tabs"></div>
          <div class="iv-search"><input id="puSearch" type="search" placeholder="搜供应商 / 料号 / 品名 / 规格" autocomplete="off"></div>
          <div id="puBanner" class="os-banner" hidden></div>
          <div class="os-tablewrap">
            <table class="os-table">
              <thead><tr>
                <th>供应商 / 品名</th><th>料号 / 规格</th><th>订购</th><th>已到</th>
                <th>欠交</th><th>到货日</th><th>操作</th>
              </tr></thead>
              <tbody id="puBody"></tbody>
            </table>
          </div>
          <div id="puEmpty" class="os-empty" hidden></div>
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
      if (e.target.closest('#puRefresh')) { S.loaded = false; load(true); return; }
      if (e.target.closest('#puNew')) { dlgNew(); return; }
      const tab = e.target.closest('#puTabs [data-tab]');
      if (tab) { S.tab = tab.dataset.tab; S.loaded = false; render(); load(true); return; }
      const op = e.target.closest('#puBody [data-act]');
      if (op) {
        const r = S.list.find((x) => String(x.id) === op.closest('tr').dataset.id);
        if (!r) return;
        const act = op.dataset.act;
        if (act === 'receipt') dlgReceipt(r);
        else if (act === 'arrived') rpc('board_purchase_note_arrived', { p_id: r.id }).then((res) => {
          if (!res.ok) { toast('标记失败：' + res.error); return; } toast('已标记「货已到，待登记」'); S.loaded = false; load(true); });
        else if (act === 'po') window.tkPrintPo && window.tkPrintPo('01', r);
        else if (act === 'history') dlgHistory(r);
        else if (act === 'edit') dlgEdit(r);
        else if (act === 'ng') dlgNg(r);
        else if (act === 'close') {
          if (!confirm('结单后这张采购单不再出现在在途列表，确定已经到齐/对完账了吗？')) return;
          rpc('board_purchase_set_status', { p_id: r.id, p_status: 'closed' }).then((res) => {
            if (!res.ok) { toast('结单失败：' + res.error); return; } toast('已结单'); S.loaded = false; load(true); });
        }
      }
    });
    document.addEventListener('input', (e) => { if (e.target.id === 'puSearch') { S.q = e.target.value; render(); } });
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
