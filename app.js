let TODAY = '2026-09-22';
const view = /\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile' ? 'mobile' : 'desktop';
const functionMarker = '/functions/v1/';
const functionMarkerIndex = location.pathname.indexOf(functionMarker);
const API_BASE = window.SHIPMENT_API_BASE || (functionMarkerIndex >= 0
  ? `${location.origin}${functionMarker}${location.pathname.slice(functionMarkerIndex + functionMarker.length).split('/')[0]}`
  : '');
const apiUrl = (path) => `${API_BASE}${path}`;
const RPC_BASE = window.SHIPMENT_RPC_BASE || '';
const ACCESS_CODE_KEY = 'shipmentBoardAccessCode';

function getAccessCode() {
  return localStorage.getItem(ACCESS_CODE_KEY) || '';
}

function askAccessCode() {
  const entered = prompt('请输入发货看板访问码');
  if (!entered) return '';
  const trimmed = entered.trim();
  localStorage.setItem(ACCESS_CODE_KEY, trimmed);
  return trimmed;
}

function rpcHeaders() {
  const anonKey = window.SHIPMENT_ANON_KEY || '';
  return {
    'Content-Type': 'application/json',
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

async function callRpc(name, body) {
  const response = await fetch(`${RPC_BASE}/${name}`, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const message = data?.message || data?.error || `云端请求失败（HTTP ${response.status}）`;
    return { response: new Response(JSON.stringify({ error: message }), { status: response.status, headers: { 'Content-Type': 'application/json' } }) };
  }
  return { response: new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }), data };
}

async function requestRpc(url, options = {}) {
  const pathname = new URL(url, location.href).pathname;
  let accessCode = getAccessCode() || askAccessCode();
  if (!accessCode) return new Response(JSON.stringify({ error: '需要输入访问码' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  if (pathname.endsWith('/api/state') || pathname.endsWith('/api/health')) {
    return (await callRpc('board_get_state', { p_code: accessCode })).response;
  }

  if (pathname.endsWith('/api/export.csv')) {
    const result = await callRpc('board_get_state', { p_code: accessCode });
    if (!result.response.ok) return result.response;
    const header = ['采购单号', '项次', '物料编号', '名称', '规格', '计划未交', '实时已发', '当前剩余', '交货日期'];
    const rows = result.data.orders
      .filter((order) => order.remaining > 0)
      .map((order) => [order.po, order.seq, order.material, order.name, order.spec, order.openingRemaining, order.shipped, order.remaining, order.dueDate]);
    const csv = '\ufeff' + [header, ...rows]
      .map((row) => row.map((cell) => '"' + String(cell ?? '').replaceAll('"', '""') + '"').join(','))
      .join('\r\n');
    return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
  }

  if (pathname.endsWith('/api/shipments') && String(options.method || 'GET').toUpperCase() === 'POST') {
    const payload = JSON.parse(options.body || '{}');
    const result = await callRpc('board_create_shipment', { p_code: accessCode, p_payload: payload });
    return result.response;
  }

  const deleteMatch = pathname.match(/\/api\/shipments\/([^/]+)$/);
  if (deleteMatch && String(options.method || '').toUpperCase() === 'DELETE') {
    return (await callRpc('board_delete_shipment', { p_code: accessCode, p_shipment_id: decodeURIComponent(deleteMatch[1]) })).response;
  }

  if (pathname.endsWith('/api/reset')) {
    return new Response(JSON.stringify({ error: '云端正式数据禁止从看板一键清空。' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: '接口不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

async function requestWithAccessCode(url, options = {}, retry = true) {
  if (RPC_BASE) return requestRpc(url, options);
  const headers = new Headers(options.headers || {});
  if (window.SHIPMENT_ANON_KEY) {
    headers.set('apikey', window.SHIPMENT_ANON_KEY);
    headers.set('Authorization', `Bearer ${window.SHIPMENT_ANON_KEY}`);
  }
  const accessCode = getAccessCode();
  if (accessCode) headers.set('X-Board-Code', accessCode);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && retry) {
    localStorage.removeItem(ACCESS_CODE_KEY);
    const entered = askAccessCode();
    if (entered) return requestWithAccessCode(url, options, false);
  }
  return response;
}

document.body.dataset.view = view;

const $ = (selector) => document.querySelector(selector);
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
let snapshot = null;
let selected = new Map();
let mobileFilter = 'task';
let mobileTab = 'entry';
let desktopFilter = 'active';
let desktopSearch = '';
let mobileSearch = '';
let eventSource = null;
let refreshing = false;

const els = {
  liveDot: $('#liveDot'),
  liveText: $('#liveText'),
  desktopLiveDot: $('#desktopLiveDot'),
  desktopLiveText: $('#desktopLiveText'),
  mobileLiveLabel: $('#mobileLiveLabel'),
  sourceTitle: $('#sourceTitle'),
  sourceStamp: $('#sourceStamp'),
  resetButton: $('#resetButton'),
  metricRemaining: $('#metricRemaining'),
  metricRemainingHint: $('#metricRemainingHint'),
  metricItems: $('#metricItems'),
  metricShipped: $('#metricShipped'),
  metricShipmentCount: $('#metricShipmentCount'),
  metricUrgent: $('#metricUrgent'),
  desktopSearch: $('#desktopSearch'),
  desktopFilter: $('#desktopFilter'),
  desktopTableBody: $('#desktopTableBody'),
  desktopEmpty: $('#desktopEmpty'),
  shipmentHistory: $('#shipmentHistory'),
  mobileSelectedQty: $('#mobileSelectedQty'),
  mobileSelectedItems: $('#mobileSelectedItems'),
  mobileRemainingQty: $('#mobileRemainingQty'),
  mobileTaskCount: $('#mobileTaskCount'),
  mobileSearch: $('#mobileSearch'),
  mobileFilters: $('#mobileFilters'),
  mobileOrderList: $('#mobileOrderList'),
  mobileEmpty: $('#mobileEmpty'),
  mobileEntryPanel: $('#mobileEntryPanel'),
  mobileRemainingPanel: $('#mobileRemainingPanel'),
  mobileRecordsPanel: $('#mobileRecordsPanel'),
  mobileCartBar: $('#mobileCartBar'),
  cartQty: $('#cartQty'),
  cartItems: $('#cartItems'),
  submitModal: $('#submitModal'),
  submitSummary: $('#submitSummary'),
  shipmentForm: $('#shipmentForm'),
  toast: $('#toast'),
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const fmt = (value) => numberFormat.format(Number(value || 0));
const searchable = (order) => [order.po, order.material, order.name, order.spec, order.batch, order.seq].join(' ').toLowerCase();

function dayDiff(dateText) {
  const a = new Date(`${TODAY}T00:00:00+08:00`).getTime();
  const b = new Date(`${dateText}T00:00:00+08:00`).getTime();
  return Math.round((b - a) / 86400000);
}

function formatDate(dateText) {
  if (!dateText) return '未填';
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateText;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function dueBadge(order) {
  if (order.remaining <= 0) return { className: 'done', text: '已交清' };
  const diff = dayDiff(order.dueDate);
  if (Number.isFinite(diff) && diff < 0) return { className: 'overdue', text: `逾期${Math.abs(diff)}天` };
  if (diff === 0) return { className: 'today', text: '今天到期' };
  if (diff === 1) return { className: '', text: '明天到期' };
  if (diff > 1 && diff <= 7) return { className: '', text: `${diff}天后` };
  return { className: '', text: `${formatDate(order.dueDate)} 到期` };
}

function filteredOrders(filter) {
  const active = snapshot.orders.filter((order) => order.remaining > 0);
  if (filter === 'urgent') return active.filter((order) => order.dueDate <= TODAY);
  if (filter === 'task') return active.filter((order) => order.todayTask);
  if (filter === 'dueToday') return active.filter((order) => order.dueDate === TODAY);
  if (filter === 'overdue') return active.filter((order) => order.dueDate < TODAY);
  if (filter === 'partial') return active.filter((order) => order.shipped > 0);
  return active;
}

function desktopRows() {
  const query = desktopSearch.trim().toLowerCase();
  let rows = filteredOrders(desktopFilter);
  if (query) rows = rows.filter((order) => searchable(order).includes(query));
  return rows;
}

function mobileRows() {
  const query = mobileSearch.trim().toLowerCase();
  let rows = filteredOrders(mobileFilter);
  if (query) rows = rows.filter((order) => searchable(order).includes(query));
  return rows;
}

function setLiveStatus(status) {
  const text = status === 'online' ? '实时同步中' : status === 'offline' ? '连接中断' : '正在连接';
  els.liveText.textContent = text;
  els.desktopLiveText.textContent = status === 'online' ? '实时同步' : text;
  els.mobileLiveLabel.textContent = status === 'online' ? '数据实时同步' : text;
  for (const dot of [els.liveDot, els.desktopLiveDot]) dot.classList.toggle('online', status === 'online');
  for (const dot of [els.liveDot, els.desktopLiveDot]) dot.classList.toggle('offline', status === 'offline');
}

async function loadState({ quiet = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await requestWithAccessCode(apiUrl('/api/state'), { cache: 'no-store' });
    if (!response.ok) throw new Error('数据加载失败');
    snapshot = await response.json();
    if (snapshot.today) TODAY = snapshot.today;
    reconcileSelection();
    renderAll();
  } catch (error) {
    setLiveStatus('offline');
    if (!quiet) showToast(error.message || '数据加载失败');
  } finally {
    refreshing = false;
  }
}

function reconcileSelection() {
  const map = new Map(snapshot.orders.map((order) => [order.id, order]));
  for (const [id, quantity] of [...selected.entries()]) {
    const order = map.get(id);
    if (!order || order.remaining <= 0) {
      selected.delete(id);
      continue;
    }
    if (quantity > order.remaining) selected.set(id, order.remaining);
  }
}

function renderAll() {
  if (!snapshot) return;
  renderDesktopMetrics();
  renderDesktopTable();
  renderDesktopHistory();
  renderMobileSummary();
  renderMobileList();
  renderMobileRemaining();
  renderMobileRecords();
  renderCart();
  els.sourceTitle.textContent = snapshot.storage?.label || '现有计划表导入';
  els.sourceStamp.textContent = snapshot.storage?.cloud
    ? `${snapshot.source.sheet} · 实时同步`
    : `生成于 ${snapshot.source.generatedAt}`;
  els.resetButton.hidden = Boolean(snapshot.storage?.cloud);
}

function renderDesktopMetrics() {
  const { summary } = snapshot;
  els.metricRemaining.textContent = fmt(summary.remainingQuantity);
  els.metricRemainingHint.textContent = `源数据未交 ${fmt(summary.sourceRemainingQuantity)} 件起算`;
  els.metricItems.textContent = fmt(summary.activeItems);
  els.metricShipped.textContent = fmt(summary.shippedQuantity);
  els.metricShipmentCount.textContent = summary.shipmentCount ? `${summary.shipmentCount} 笔发货记录` : '尚未提交发货';
  els.metricUrgent.textContent = fmt(summary.overdue + summary.dueToday);
}

function renderDesktopTable() {
  const rows = desktopRows();
  els.desktopTableBody.innerHTML = rows.map((order) => {
    const badge = dueBadge(order);
    const progress = order.openingRemaining > 0 ? Math.min(100, Math.round(order.shipped / order.openingRemaining * 100)) : 100;
    return `
      <tr>
        <td>
          <div class="item-main">
            <strong>${escapeHtml(order.name)}</strong>
            <span class="mono">${escapeHtml(order.material)} · ${escapeHtml(order.spec)}</span>
          </div>
        </td>
        <td>
          <span class="order-id">${escapeHtml(order.po)}</span>
          <span class="subtle">项次 ${escapeHtml(order.seq)}</span>
        </td>
        <td><span class="due-badge ${badge.className}">${escapeHtml(badge.text)}</span></td>
        <td class="number">${fmt(order.openingRemaining)}</td>
        <td class="number">${fmt(order.shipped)}</td>
        <td class="number"><span class="remaining-number">${fmt(order.remaining)}</span></td>
        <td>
          <div class="progress">
            <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
            <small>${progress}% 已录入</small>
          </div>
        </td>
      </tr>`;
  }).join('');
  els.desktopEmpty.hidden = rows.length > 0;
}

function renderHistoryCards(shipments) {
  if (!shipments.length) return '<div class="empty-state"><strong>还没有发货记录</strong><span>打开手机录入页，提交后会显示在这里。</span></div>';
  return shipments.map((shipment) => `
    <article class="history-card">
      <div class="history-head">
        <strong>${escapeHtml(shipment.vehicle)}</strong>
        <span>${new Date(shipment.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="history-meta">${escapeHtml(shipment.id)} · ${escapeHtml(shipment.operator)}${shipment.note ? ` · ${escapeHtml(shipment.note)}` : ''}</div>
      <div class="history-lines">
        ${shipment.items.slice(0, 5).map((line) => `<div class="history-line"><span>${escapeHtml(line.material)} ${escapeHtml(line.name)}</span><strong>${fmt(line.quantity)} 件</strong></div>`).join('')}
        ${shipment.items.length > 5 ? `<div class="history-line"><span>还有 ${shipment.items.length - 5} 项</span><strong>${fmt(shipment.totalQuantity)} 件</strong></div>` : ''}
      </div>
      <button class="undo-button" type="button" data-undo="${escapeHtml(shipment.id)}">撤销这笔发货</button>
    </article>`).join('');
}

function renderDesktopHistory() {
  els.shipmentHistory.innerHTML = renderHistoryCards(snapshot.shipments);
}

function orderCard(order) {
  const badge = dueBadge(order);
  const selectedQuantity = Number(selected.get(order.id) || 0);
  const complete = order.remaining <= 0;
  return `
    <article class="order-card ${selectedQuantity ? 'selected' : ''} ${complete ? 'complete' : ''}" data-order-card="${escapeHtml(order.id)}">
      ${selectedQuantity ? `<span class="selected-tag">已选 ${fmt(selectedQuantity)}</span>` : ''}
      <div class="card-top">
        <div class="order-title">
          <strong>${escapeHtml(order.name)}</strong>
          <span class="mono">${escapeHtml(order.material)} · ${escapeHtml(order.spec)}</span>
          <span>${escapeHtml(order.po)} · 项次 ${escapeHtml(order.seq)}</span>
        </div>
        <span class="due-badge ${badge.className}">${escapeHtml(badge.text)}</span>
      </div>
      <div class="order-numbers">
        <div class="order-number"><span>计划未交</span><strong>${fmt(order.openingRemaining)}</strong></div>
        <div class="order-number"><span>已录发货</span><strong>${fmt(order.shipped)}</strong></div>
        <div class="order-number remaining"><span>当前剩余</span><strong>${fmt(order.remaining)}</strong></div>
      </div>
      <div class="entry-row">
        <div class="qty-stepper">
          <button type="button" data-action="minus" data-id="${escapeHtml(order.id)}" aria-label="减少数量">−</button>
          <input type="number" min="0" max="${order.remaining}" step="1" inputmode="decimal" value="${selectedQuantity || ''}" placeholder="本次数量" data-action="input" data-id="${escapeHtml(order.id)}" aria-label="${escapeHtml(order.name)} 本次数量">
          <button type="button" data-action="plus" data-id="${escapeHtml(order.id)}" aria-label="增加数量">＋</button>
        </div>
        <button class="fill-button" type="button" data-action="fill" data-id="${escapeHtml(order.id)}">装完 ${fmt(order.remaining)}</button>
      </div>
    </article>`;
}

function renderMobileList() {
  if (!snapshot) return;
  const rows = mobileRows();
  const limit = 80;
  const shown = rows.slice(0, limit);
  els.mobileOrderList.innerHTML = shown.map(orderCard).join('');
  if (rows.length > limit) {
    els.mobileOrderList.insertAdjacentHTML('beforeend', `<div class="empty-state mobile-empty"><strong>还有 ${rows.length - limit} 项未显示</strong><span>请用搜索快速定位物料。</span></div>`);
  }
  els.mobileEmpty.hidden = rows.length > 0;
  els.mobileEmpty.innerHTML = '<strong>没有符合条件的数据</strong><span>换个筛选条件或清空搜索词。</span>';
}

function renderMobileSummary() {
  const selectedItems = [...selected.values()].filter((value) => value > 0).length;
  const selectedQty = [...selected.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  els.mobileSelectedQty.textContent = fmt(selectedQty);
  els.mobileSelectedItems.textContent = `${selectedItems} 项物料`;
  els.mobileRemainingQty.textContent = fmt(snapshot.summary.remainingQuantity);
  els.mobileTaskCount.textContent = fmt(snapshot.summary.overdue + snapshot.summary.dueToday);
}

function renderMobileRemaining() {
  const rows = filteredOrders('active').slice(0, 120);
  els.mobileRemainingPanel.innerHTML = `
    <div class="records-head"><strong>全部未交清单</strong><span>共 ${fmt(snapshot.summary.activeItems)} 项，显示交期优先的前 ${Math.min(120, rows.length)} 项。</span></div>
    ${rows.map((order) => {
      const badge = dueBadge(order);
      return `<article class="mobile-remaining-card">
        <div class="mobile-remaining-head">
          <div><strong>${escapeHtml(order.name)}</strong><span class="mono">${escapeHtml(order.material)} · ${escapeHtml(order.spec)}</span></div>
          <span class="mobile-remaining-qty">${fmt(order.remaining)}</span>
        </div>
        <span>${escapeHtml(order.po)} · 项次 ${escapeHtml(order.seq)} · ${escapeHtml(badge.text)}</span>
      </article>`;
    }).join('')}`;
}

function renderMobileRecords() {
  els.mobileRecordsPanel.innerHTML = `<div class="records-head"><strong>发货记录</strong><span>电脑端会同步显示这些记录。</span></div>${renderHistoryCards(snapshot.shipments)}`;
}

function renderCart() {
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  const quantity = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  els.cartQty.textContent = fmt(quantity);
  els.cartItems.textContent = fmt(entries.length);
  els.mobileCartBar.hidden = mobileTab !== 'entry' || !entries.length;
}

function addQuantity(orderId, delta) {
  const order = snapshot.orders.find((item) => item.id === orderId);
  if (!order) return;
  const current = Number(selected.get(orderId) || 0);
  const next = Math.max(0, Math.min(order.remaining, current + delta));
  if (next > 0) selected.set(orderId, next);
  else selected.delete(orderId);
  renderMobileList();
  renderMobileSummary();
  renderCart();
}

function setQuantity(orderId, value) {
  const order = snapshot.orders.find((item) => item.id === orderId);
  if (!order) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) selected.delete(orderId);
  else selected.set(orderId, Math.min(order.remaining, numeric));
  renderMobileSummary();
  renderCart();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function openSubmitModal() {
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  if (!entries.length) {
    showToast('请先录入至少一项装车数量');
    return;
  }
  const total = entries.reduce((sum, [, quantity]) => sum + Number(quantity), 0);
  els.submitSummary.innerHTML = `
    <div class="submit-summary-row"><span>本次物料</span><strong>${entries.length} 项</strong></div>
    <div class="submit-summary-row"><span>本次总数量</span><strong>${fmt(total)} 件</strong></div>
    <div class="submit-summary-row"><span>提交后</span><strong>电脑端自动扣减未交</strong></div>`;
  els.submitModal.hidden = false;
}

function closeSubmitModal() {
  els.submitModal.hidden = true;
}

async function submitShipment() {
  if (!els.shipmentForm.reportValidity()) return;
  const form = new FormData(els.shipmentForm);
  const payload = {
    customer: snapshot.customer,
    operator: form.get('operator'),
    vehicle: form.get('vehicle'),
    note: form.get('note'),
    items: [...selected.entries()].map(([orderId, quantity]) => ({ orderId, quantity })),
  };
  const button = $('#submitShipment');
  button.disabled = true;
  button.textContent = '正在同步...';
  try {
    const response = await requestWithAccessCode(apiUrl('/api/shipments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '提交失败');
    selected.clear();
    els.shipmentForm.reset();
    closeSubmitModal();
    showToast(`${result.shipment.id} 已保存，电脑端正在更新`);
    await loadState();
  } catch (error) {
    showToast(error.message || '提交失败');
  } finally {
    button.disabled = false;
    button.textContent = '保存并同步电脑';
  }
}

async function undoShipment(id) {
  if (!confirm(`确定撤销 ${id} 吗？剩余未交数量会恢复。`)) return;
  try {
    const response = await requestWithAccessCode(apiUrl(`/api/shipments/${encodeURIComponent(id)}`), { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '撤销失败');
    showToast(`${id} 已撤销`);
    await loadState();
  } catch (error) {
    showToast(error.message || '撤销失败');
  }
}

async function resetRecords() {
  if (!confirm('确定清空所有原型发货记录吗？订单源头数据不会变化。')) return;
  try {
    const response = await requestWithAccessCode(apiUrl('/api/reset'), { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '清空失败');
    selected.clear();
    showToast('发货记录已清空');
    await loadState();
  } catch (error) {
    showToast(error.message || '清空失败');
  }
}

function switchMobileTab(tab) {
  mobileTab = tab;
  for (const button of document.querySelectorAll('.mobile-tab')) button.classList.toggle('active', button.dataset.tab === tab);
  els.mobileEntryPanel.hidden = tab !== 'entry';
  els.mobileRemainingPanel.hidden = tab !== 'remaining';
  els.mobileRecordsPanel.hidden = tab !== 'records';
  renderCart();
}

els.desktopSearch.addEventListener('input', (event) => { desktopSearch = event.target.value; renderDesktopTable(); });
els.desktopFilter.addEventListener('change', (event) => { desktopFilter = event.target.value; renderDesktopTable(); });
els.mobileSearch.addEventListener('input', (event) => { mobileSearch = event.target.value; renderMobileList(); });
document.querySelectorAll('.mobile-tab').forEach((button) => button.addEventListener('click', () => switchMobileTab(button.dataset.tab)));
els.mobileFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  mobileFilter = button.dataset.filter;
  document.querySelectorAll('#mobileFilters .chip').forEach((chip) => chip.classList.toggle('active', chip === button));
  renderMobileList();
});
els.mobileOrderList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.dataset.action === 'input') return;
  const { action, id } = button.dataset;
  const order = snapshot.orders.find((item) => item.id === id);
  if (!order) return;
  if (action === 'plus') addQuantity(id, 1);
  if (action === 'minus') addQuantity(id, -1);
  if (action === 'fill') {
    selected.set(id, order.remaining);
    renderMobileList();
    renderMobileSummary();
    renderCart();
  }
});
els.mobileOrderList.addEventListener('input', (event) => {
  const input = event.target.closest('[data-action="input"]');
  if (!input) return;
  setQuantity(input.dataset.id, input.value);
});
els.mobileOrderList.addEventListener('change', (event) => {
  const input = event.target.closest('[data-action="input"]');
  if (!input) return;
  renderMobileList();
});
$('#openSubmit').addEventListener('click', openSubmitModal);
$('#closeModal').addEventListener('click', closeSubmitModal);
$('#clearSelection').addEventListener('click', () => { selected.clear(); closeSubmitModal(); renderMobileList(); renderMobileSummary(); renderCart(); });
$('#submitShipment').addEventListener('click', submitShipment);
$('#mobileRefresh').addEventListener('click', () => loadState());
$('#resetButton').addEventListener('click', resetRecords);
els.submitModal.addEventListener('click', (event) => { if (event.target === els.submitModal) closeSubmitModal(); });
els.shipmentHistory.addEventListener('click', (event) => {
  const button = event.target.closest('[data-undo]');
  if (button) undoShipment(button.dataset.undo);
});
els.mobileRecordsPanel.addEventListener('click', (event) => {
  const button = event.target.closest('[data-undo]');
  if (button) undoShipment(button.dataset.undo);
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSubmitModal(); });

function connectEvents() {
  if (eventSource) eventSource.close();
  setLiveStatus('connecting');
  if (API_BASE) {
    setLiveStatus('online');
    clearInterval(connectEvents.pollTimer);
    connectEvents.pollTimer = setInterval(() => loadState({ quiet: true }), 5000);
    return;
  }
  eventSource = new EventSource(apiUrl('/api/events'));
  eventSource.addEventListener('connected', () => setLiveStatus('online'));
  eventSource.addEventListener('update', () => loadState({ quiet: true }));
  eventSource.onerror = () => setLiveStatus('offline');
}

function setupRpcExportLink() {
  if (!RPC_BASE) return;
  for (const link of document.querySelectorAll('a[href$="/api/export.csv"]')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      const response = await requestRpc(apiUrl('/api/export.csv'));
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        showToast(result.error || '导出失败');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `未交明细-${TODAY}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }
}

setupRpcExportLink();
await loadState();
connectEvents();










