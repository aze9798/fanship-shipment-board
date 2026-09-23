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
  const url = new URL(location.href);
  const queryCode = url.searchParams.get('code');
  if (queryCode) {
    const normalized = queryCode.trim();
    localStorage.setItem(ACCESS_CODE_KEY, normalized);
    url.searchParams.delete('code');
    history.replaceState(null, '', url);
    return normalized;
  }
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

  if (pathname.endsWith('/api/import-orders') && String(options.method || 'GET').toUpperCase() === 'POST') {
    const payload = JSON.parse(options.body || '{}');
    return (await callRpc('board_import_orders', { p_code: accessCode, p_orders: payload.items || [] })).response;
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
let mobileFilter = 'active';
let mobileTab = 'entry';
let desktopFilter = 'active';
let desktopSearch = '';
let mobileSearch = '';
let eventSource = null;
let refreshing = false;
let pendingImportOrders = null;

const els = {
  liveDot: $('#liveDot'),
  liveText: $('#liveText'),
  desktopLiveDot: $('#desktopLiveDot'),
  desktopLiveText: $('#desktopLiveText'),
  mobileLiveLabel: $('#mobileLiveLabel'),
  sourceTitle: $('#sourceTitle'),
  sourceStamp: $('#sourceStamp'),
  resetButton: $('#resetButton'),
  importButton: $('#importButton'),
  importFileInput: $('#importFileInput'),
  importModal: $('#importModal'),
  importPreview: $('#importPreview'),
  confirmImport: $('#confirmImport'),
  closeImportModal: $('#closeImportModal'),
  cancelImport: $('#cancelImport'),
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
  els.importButton.hidden = !RPC_BASE;
}

function renderDesktopMetrics() {
  const { summary } = snapshot;
  els.metricRemaining.textContent = fmt(summary.remainingQuantity);
  els.metricRemainingHint.textContent = `源数据未交 ${fmt(summary.sourceRemainingQuantity)} 件起算`;
  els.metricShipped.textContent = fmt(summary.shippedQuantity);
  els.metricShipmentCount.textContent = summary.shipmentCount ? `${summary.shipmentCount} 笔发货记录` : '尚未提交发货';
  els.metricUrgent.textContent = fmt(summary.overdue + summary.dueToday);
}

function renderDesktopTable() {
  const rows = desktopRows();
  els.desktopTableBody.innerHTML = rows.map((order) => {
    const badge = dueBadge(order);
    return `
      <tr>
        <td><span class="order-id">${escapeHtml(order.po)}</span></td>
        <td><span class="material-code mono">${escapeHtml(order.material)}</span></td>
        <td><span class="item-name">${escapeHtml(order.name)}</span></td>
        <td><span class="spec-code mono">${escapeHtml(order.spec || '—')}</span></td>
        <td class="number">${escapeHtml(order.seq)}</td>
        <td><span class="due-badge ${badge.className}">${escapeHtml(badge.text)}</span></td>
        <td class="number"><span class="remaining-number">${fmt(order.remaining)}</span></td>
        <td class="number"><span class="shipped-number">${fmt(order.shipped)}</span></td>
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
        <div class="mobile-remaining-grid">
          <div class="remaining-field">
            <span>订单号</span>
            <strong class="mono">${escapeHtml(order.po)}</strong>
          </div>
          <div class="remaining-field">
            <span>编号</span>
            <strong class="mono">${escapeHtml(order.material)}</strong>
          </div>
          <div class="remaining-field span-2">
            <span>品名</span>
            <strong>${escapeHtml(order.name)}</strong>
          </div>
          <div class="remaining-field span-2">
            <span>图号</span>
            <strong class="mono">${escapeHtml(order.spec || '—')}</strong>
          </div>
          <div class="remaining-field">
            <span>项次</span>
            <strong>${escapeHtml(order.seq)}</strong>
          </div>
          <div class="remaining-field quantity">
            <span>数量</span>
            <strong>${fmt(order.remaining)}</strong>
          </div>
          <div class="remaining-field span-2 due-field">
            <span>交期</span>
            <div><strong>${escapeHtml(formatDate(order.dueDate))}</strong><em class="due-badge ${badge.className}">${escapeHtml(badge.text)}</em></div>
          </div>
        </div>
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

function excelNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function excelDate(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && window.XLSX?.SSF?.parse_date_code) {
    const parsed = window.XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{2})\/(\d{1,2})\/(\d{1,2})$/);
  if (match) return `20${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  match = text.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  return null;
}

function parseExcelRows(workbook) {
  const sheetNames = workbook.SheetNames || [];
  const preferred = ['艾沃意特', '复制最新采购订单', '未交清单打印', '粘贴', '公式', ...sheetNames];
  const tried = new Set();
  for (const sheetName of preferred) {
    if (!sheetName || tried.has(sheetName) || !workbook.Sheets[sheetName]) continue;
    tried.add(sheetName);
    const matrix = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    let headerIndex = -1;
    let headers = [];
    for (let index = 0; index < Math.min(matrix.length, 25); index += 1) {
      const candidate = matrix[index].map((value) => String(value ?? '').trim());
      const has = (name) => candidate.includes(name);
      if ((has('订单号') && has('物料编号') && has('未交') && has('项次')) ||
          (has('采购单号') && has('未交') && has('项次')) ||
          (has('采购单号') && has('未交量') && has('项次'))) {
        headerIndex = index;
        headers = candidate;
        break;
      }
    }
    if (headerIndex < 0) continue;

    const at = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
    const poIndex = at('订单号', '采购单号');
    const materialIndex = at('物料编号', '料件编号');
    const nameIndex = at('名称', '品名');
    const specIndex = at('图号', '规格');
    const orderQtyIndex = at('订单量', '采购数量');
    const returnQtyIndex = at('验退量');
    const remainingIndex = at('未交', '未交量');
    const seqIndex = at('项次');
    const dueDateIndex = at('交货日期', '交货日');
    const purchaseDateIndex = at('采购日期');
    const batchIndex = at('批号', '备注');
    const orders = [];

    for (let rowIndex = headerIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
      const row = matrix[rowIndex];
      const po = String(row[poIndex] ?? '').trim();
      const material = String(row[materialIndex] ?? '').trim();
      const name = String(row[nameIndex] ?? '').trim();
      const seq = Math.trunc(excelNumber(row[seqIndex]));
      const openingRemaining = excelNumber(row[remainingIndex]);
      if (!po || !material || !name || seq <= 0 || openingRemaining <= 0) continue;
      orders.push({
        id: `${po}#${String(seq).padStart(3, '0')}`,
        customer: '艾沃意特',
        po,
        purchaseDate: excelDate(row[purchaseDateIndex]),
        seq,
        material,
        name,
        spec: String(row[specIndex] ?? '').trim(),
        orderQty: excelNumber(row[orderQtyIndex]) || openingRemaining,
        returnQty: excelNumber(row[returnQtyIndex]),
        openingRemaining,
        dueDate: excelDate(row[dueDateIndex]),
        batch: String(row[batchIndex] ?? '').trim(),
        todayTask: false,
        sourceRow: rowIndex + 1,
      });
    }
    if (orders.length) return { orders, sheetName };
  }
  return { orders: [], sheetName: '' };
}

function closeImportDialog() {
  els.importModal.hidden = true;
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!window.XLSX) {
    showToast('Excel 解析组件加载失败，请刷新页面后重试');
    return;
  }
  try {
    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const { orders, sheetName } = parseExcelRows(workbook);
    if (!orders.length) throw new Error('没有识别到未交数量大于 0 的订单');
    pendingImportOrders = orders;
    const total = orders.reduce((sum, order) => sum + order.openingRemaining, 0);
    const poCount = new Set(orders.map((order) => order.po)).size;
    els.importPreview.innerHTML = [
      `<div class="submit-summary-row"><span>工作表</span><strong>${escapeHtml(sheetName)}</strong></div>`,
      `<div class="submit-summary-row"><span>有效未交</span><strong>${fmt(orders.length)} 行</strong></div>`,
      `<div class="submit-summary-row"><span>未交总量</span><strong>${fmt(total)} 件</strong></div>`,
      `<div class="submit-summary-row"><span>采购单数</span><strong>${fmt(poCount)} 个</strong></div>`,
    ].join('');
    els.confirmImport.disabled = false;
    els.importModal.hidden = false;
  } catch (error) {
    pendingImportOrders = null;
    els.confirmImport.disabled = true;
    showToast(error.message || 'Excel 解析失败');
  } finally {
    event.target.value = '';
  }
}

async function confirmImportOrders() {
  if (!pendingImportOrders?.length) return;
  const button = els.confirmImport;
  button.disabled = true;
  button.textContent = '正在覆盖云端...';
  try {
    const response = await requestWithAccessCode(apiUrl('/api/import-orders'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: pendingImportOrders }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '导入失败');
    showToast(`已导入 ${fmt(result.count)} 行，共 ${fmt(result.totalQuantity)} 件`);
    pendingImportOrders = null;
    closeImportDialog();
    await loadState();
  } catch (error) {
    showToast(error.message || '导入失败');
  } finally {
    button.disabled = false;
    button.textContent = '确认覆盖导入';
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
$('#importButton').addEventListener('click', () => els.importFileInput.click());
els.importFileInput.addEventListener('change', handleImportFile);
els.confirmImport.addEventListener('click', confirmImportOrders);
els.closeImportModal.addEventListener('click', closeImportDialog);
els.cancelImport.addEventListener('click', closeImportDialog);
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
  if (API_BASE || RPC_BASE) {
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













