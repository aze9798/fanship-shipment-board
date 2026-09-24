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
const PRINT_HELPER_BASE = 'http://127.0.0.1:8790';
let deliveryPlan = null;

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
let desktopCompany = 'all';
let remainingSearch = '';
let remainingDue = 'all';
let remainingDueDate = '';
let desktopDueFilter = 'all';
let desktopDueDate = '';
let desktopSearch = '';
let mobileSearch = '';
let historyDate = '';
let recordsSearch = '';
let recordsDate = '';
let historyQuery = '';
const expandedShipments = new Set();
let autoOffsetNote = '';
let cartOpen = false;
const sessionOver = new Map();
let autoOffsetRunning = false;
const isBangfanName = (name) => /护栏|护脚栏/.test(String(name || ''));
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
  pdfImportButton: $('#pdfImportButton'),
  pdfFileInput: $('#pdfFileInput'),
  pdfModal: $('#pdfModal'),
  pdfPreview: $('#pdfPreview'),
  confirmPdf: $('#confirmPdf'),
  cancelPdf: $('#cancelPdf'),
  closePdfModal: $('#closePdfModal'),
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
  desktopSuggest: $('#desktopSuggest'),
  desktopCompanyFilter: $('#desktopCompanyFilter'),
  desktopDueSelect: $('#desktopDueSelect'),
  desktopDueBox: $('#desktopDueBox'),
  desktopDueDate: $('#desktopDueDate'),
  desktopDueRow: $('#desktopDueRow'),
  desktopTableBody: $('#desktopTableBody'),
  desktopEmpty: $('#desktopEmpty'),
  shipmentHistory: $('#shipmentHistory'),
  historySummary: $('#historySummary'),
  historySearch: $('#historySearch'),
  historyDate: $('#historyDate'),
  historyClear: $('#historyClear'),
  mobileSelectedQty: $('#mobileSelectedQty'),
  mobileSelectedItems: $('#mobileSelectedItems'),
  mobileRemainingQty: $('#mobileRemainingQty'),
  mobileSearch: $('#mobileSearch'),
  mobileSuggest: $('#mobileSuggest'),
  mobileFilters: $('#mobileFilters'),
  mobileOrderList: $('#mobileOrderList'),
  mobileAllocNotice: $('#mobileAllocNotice'),
  mobileOffsetBox: $('#mobileOffsetBox'),
  mobileEmpty: $('#mobileEmpty'),
  mobileEntryPanel: $('#mobileEntryPanel'),
  mobileRemainingPanel: $('#mobileRemainingPanel'),
  remainingSearch: $('#remainingSearch'),
  remainingDueSelect: $('#remainingDueSelect'),
  remainingDueDate: $('#remainingDueDate'),
  remainingList: $('#remainingList'),
  mobileRecordsPanel: $('#mobileRecordsPanel'),
  recordsSearch: $('#recordsSearch'),
  recordsDate: $('#recordsDate'),
  recordsClear: $('#recordsClear'),
  recordsList: $('#recordsList'),
  mobileCartBar: $('#mobileCartBar'),
  mobileCartSummary: $('#mobileCartSummary'),
  cartDetail: $('#cartDetail'),
  cartQty: $('#cartQty'),
  cartItems: $('#cartItems'),
  submitModal: $('#submitModal'),
  submitSummary: $('#submitSummary'),
  shipmentForm: $('#shipmentForm'),
  generateDeliveryNote: $('#generateDeliveryNote'),
  deliveryModal: $('#deliveryModal'),
  deliveryForm: $('#deliveryForm'),
  deliveryDate: $('#deliveryDate'),
  deliveryBatch: $('#deliveryBatch'),
  deliveryStatus: $('#deliveryStatus'),
  deliveryPreview: $('#deliveryPreview'),
  closeDeliveryModal: $('#closeDeliveryModal'),
  closeDeliveryModalAction: $('#closeDeliveryModalAction'),
  refreshDeliveryPreview: $('#refreshDeliveryPreview'),
  printDeliveryNotes: $('#printDeliveryNotes'),
  toast: $('#toast'),
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const fmt = (value) => numberFormat.format(Number(value || 0));
const searchable = (order) => [order.po, order.material, order.name, order.spec, order.batch, order.seq, order.customer].join(' ').toLowerCase();

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

// 公司编号存在订单的 customer 字段：4074 老公司（无锡市帆顺金属制品厂）/ 4137 新公司（无锡市帆顺金属科技有限公司）
const COMPANY_NAMES = {
  '4074': '无锡市帆顺金属制品厂',
  '4137': '无锡市帆顺金属科技有限公司',
};
const orderCompany = (order) => String(order.customer || '').trim();
const companyName = (code) => COMPANY_NAMES[code] || code || '未标注公司';

function filteredOrders(filter) {
  const active = snapshot.orders.filter((order) => order.remaining > 0);
  if (filter === 'urgent') return active.filter((order) => order.dueDate <= TODAY);
  if (filter === 'dueToday') return active.filter((order) => order.dueDate === TODAY);
  if (filter === 'overdue') return active.filter((order) => order.dueDate < TODAY);
  if (filter === 'partial') return active.filter((order) => order.shipped > 0);
  return active;
}

// 交期列：显示具体日期 + 逾期/今天到期/几天后
function dueStatus(order) {
  const badge = dueBadge(order);
  const text = String(badge.text).replace(`${formatDate(order.dueDate)} `, '');
  return { className: badge.className, text };
}

// 交期筛选统一判断（列表和下拉建议共用）
function matchDueFilter(order, filter, customDate) {
  if (filter === 'all') return true;
  const diff = dayDiff(order.dueDate);
  if (!Number.isFinite(diff)) return false;
  if (filter === 'overdue') return diff < 0;
  if (filter === 'today') return diff === 0;
  if (filter === 'tomorrow') return diff === 1;
  if (filter === 'week') return diff >= 0 && diff <= 7;
  if (filter === 'custom') return customDate ? order.dueDate === customDate : true;
  return true;
}

// 当前筛选（交期+公司）之后的结果集——搜索、下拉建议都在这个范围里做
function desktopDueRows() {
  let rows = filteredOrders('active');
  if (desktopCompany !== 'all') rows = rows.filter((order) => orderCompany(order) === desktopCompany);
  rows = rows.filter((order) => matchDueFilter(order, desktopDueFilter, desktopDueDate));
  return rows;
}

function desktopRows() {
  const query = desktopSearch.trim().toLowerCase();
  let rows = filteredOrders('active');
  rows = desktopDueRows();
  if (query) rows = rows.filter((order) => searchable(order).includes(query));
  return rows;
}

// 搜索时给出相近的料号/名称下拉，点一下精准选中
function materialOptions(query, sourceRows) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const pool = Array.isArray(sourceRows) ? sourceRows : snapshot.orders;
  const map = new Map();
  for (const order of pool) {
    if (!(order.remaining > 0)) continue;
    const material = String(order.material || '').trim();
    if (!material) continue;
    const name = String(order.name || '');
    if (!(material.toLowerCase().includes(q) || name.toLowerCase().includes(q))) continue;
    const row = map.get(material) || { material, name, spec: String(order.spec || ''), total: 0, count: 0 };
    row.total += Number(order.remaining || 0);
    row.count += 1;
    map.set(material, row);
  }
  return [...map.values()]
    .sort((a, b) => a.material.localeCompare(b.material, 'zh-CN'))
    .slice(0, 20);
}

function renderSuggestFor(input, box, sourceRows) {
  if (!box || !snapshot) return;
  const rows = materialOptions(input ? input.value : '', sourceRows);
  if (!rows.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = rows.map((row) => `
    <button type="button" class="suggest-row" data-suggest="${escapeHtml(row.material)}">
      <span class="mono">${escapeHtml(row.material)}</span>
      <span>${escapeHtml(row.name)}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</span>
      <em>共 ${fmt(row.total)} 件 · ${row.count} 单</em>
    </button>`).join('');
}

function renderSuggestions() {
  // 先按顶部筛选（全部未交/今日到期/已逾期），再在这个范围里给建议
  renderSuggestFor(els.mobileSearch, els.mobileSuggest, filteredOrders(mobileFilter));
}

function pickSuggestion(button, input, box) {
  const value = button.dataset.suggest;
  if (input) input.value = value;
  box.hidden = true;
  return value;
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
    const nextSnapshot = await response.json();
    nextSnapshot.overDeliveries = await loadOverDeliveries();
    nextSnapshot.overOffsets = await loadOverOffsets();
    nextSnapshot.deliveryFiles = await loadDeliveryFiles();
    const changed = !snapshot || nextSnapshot.revision !== snapshot.revision;
    snapshot = nextSnapshot;
    if (snapshot.today) TODAY = snapshot.today;
    reconcileSelection();
    if (!quiet || changed) renderAll();
  } catch (error) {
    setLiveStatus('offline');
    if (!quiet) showToast(error.message || '数据加载失败');
  } finally {
    refreshing = false;
  }
  // 数据到位后，护栏/护脚栏类的前期多送自动冲抵
  setTimeout(() => { autoOffsetBangfan(); }, 0);
}

// ================= 采购订单 PDF 识别导入 =================
const PDF_ITEM_RE = /^(\d+)\s+(\S+)\s+(\d{4}\/\d{2}\/\d{2})\s+([\d,]+(?:\.\d+)?)\s+(\S+)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)/;
const PDF_NAME_RE = /^(.*?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)$/;
const pdfNum = (v) => Number(String(v || '').replace(/,/g, '')) || 0;
const pdfIso = (v) => {
  const m = String(v || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : null;
};

async function pdfToLines(file) {
  const data = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data }).promise;
  const lines = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const rows = [];
    for (const item of content.items) {
      const text = String(item.str || '');
      if (!text.trim()) continue;
      const y = item.transform[5];
      const x = item.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, text });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      lines.push(row.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  return lines;
}

async function parsePdfOrder(file) {
  const lines = await pdfToLines(file);
  const text = lines.join('\n');
  const doc = { file: file.name, po: null, purchaseDate: null, vendor: null, pdfTotal: null, items: [], error: '' };
  let m = text.match(/采购单号[:：]\s*(\S+)/); doc.po = m ? m[1].trim() : null;
  m = text.match(/采购日期[:：]\s*(\S+)/); doc.purchaseDate = pdfIso(m ? m[1] : null);
  m = text.match(/供应厂商[:：]\s*(\S+)/); doc.vendor = m ? m[1].trim() : null;
  m = text.match(/含税金额总和[:：]\s*([\d,]+(?:\.\d+)?)/); doc.pdfTotal = m ? pdfNum(m[1]) : null;
  for (let i = 0; i < lines.length; i += 1) {
    const item = lines[i].match(PDF_ITEM_RE);
    if (!item) continue;
    const row = { seq: Number(item[1]), material: item[2], dueDate: pdfIso(item[3]), quantity: pdfNum(item[4]), netAmount: pdfNum(item[7]), name: '', spec: '', grossAmount: null };
    const named = (lines[i + 1] || '').match(PDF_NAME_RE);
    if (named) {
      row.name = named[1].trim();
      row.grossAmount = pdfNum(named[3]);
      const next = lines[i + 2] || '';
      if (next && !PDF_ITEM_RE.test(next) && !next.includes('总和') && !next.includes('备注')) row.spec = next.trim();
    }
    doc.items.push(row);
  }
  doc.qtyTotal = doc.items.reduce((sum, x) => sum + x.quantity, 0);
  doc.amountTotal = Math.round(doc.items.reduce((sum, x) => sum + (x.grossAmount != null ? x.grossAmount : x.netAmount * 1.13), 0) * 100) / 100;
  if (!doc.items.length) doc.error = '没有识别到明细行';
  return doc;
}

let pendingPdfRows = [];

function closePdfModal() {
  if (els.pdfModal) els.pdfModal.hidden = true;
  if (els.pdfFileInput) els.pdfFileInput.value = '';
  pendingPdfRows = [];
}

function renderPdfPreview(docs) {
  const existing = new Set(snapshot.orders.map((o) => String(o.po || '').trim()));
  const rows = [];
  const blocks = docs.map((doc) => {
    const problems = [];
    if (doc.error) problems.push(doc.error);
    if (!doc.po) problems.push('读不到采购单号');
    if (doc.pdfTotal != null && Math.abs(doc.amountTotal - doc.pdfTotal) > 0.02) {
      problems.push(`金额对不上：明细算出 ${doc.amountTotal}，PDF 合计 ${doc.pdfTotal}`);
    }
    const company = /科技/.test(doc.vendor || '') ? '4137' : (/制品厂/.test(doc.vendor || '') ? '4074' : '');
    if (!company) problems.push('认不出公司（供应厂商）');
    const duplicated = Boolean(doc.po) && existing.has(doc.po);
    if (!problems.length && !duplicated) {
      for (const item of doc.items) {
        rows.push({ id: `${doc.po}#${String(item.seq).padStart(3, '0')}`, customer: company, po: doc.po, purchaseDate: doc.purchaseDate, seq: item.seq, material: item.material, name: item.name, spec: item.spec, orderQty: item.quantity, openingRemaining: item.quantity, dueDate: item.dueDate });
      }
    }
    return { doc, problems, duplicated, company };
  });
  pendingPdfRows = rows;
  const totalQty = rows.reduce((sum, r) => sum + r.openingRemaining, 0);
  const bad = blocks.filter((b) => b.problems.length);
  const html = blocks.map((b) => `
    <div class="pdf-doc${b.problems.length ? ' bad' : b.duplicated ? ' dup' : ''}">
      <div class="pdf-doc-head">
        <strong>${escapeHtml(b.doc.po || b.doc.file)}</strong>
        <span>${b.company ? (b.company === '4137' ? '帆顺金属科技' : '帆顺金属(老)') : '公司未知'} · ${b.doc.items.length} 行 · 数量 ${fmt(b.doc.qtyTotal)} · 金额 ${fmt(b.doc.amountTotal)}${b.doc.pdfTotal != null ? ` / PDF ${fmt(b.doc.pdfTotal)}` : ''}</span>
      </div>
      ${b.duplicated ? '<div class="pdf-note">系统里已有这个采购单号，将跳过</div>' : ''}
      ${b.problems.map((p) => `<div class="pdf-note bad">${escapeHtml(p)}</div>`).join('')}
    </div>`).join('');
  els.pdfPreview.innerHTML = `
    <div class="submit-summary-row"><span>识别到</span><strong>${docs.length} 个 PDF</strong></div>
    <div class="submit-summary-row"><span>本次将新增</span><strong>${new Set(rows.map((r) => r.po)).size} 张单 · ${rows.length} 行 · 数量 ${fmt(totalQty)}</strong></div>
    ${bad.length ? `<div class="submit-summary-row"><span>有问题（不会导入）</span><strong class="bad">${bad.length} 个</strong></div>` : ''}
    ${html}`;
  els.confirmPdf.disabled = !rows.length || bad.length > 0;
  els.pdfModal.hidden = false;
}

async function confirmPdfImport() {
  if (!pendingPdfRows.length) return;
  els.confirmPdf.disabled = true;
  try {
    const result = await callRpc('board_add_orders', { p_code: getAccessCode(), p_orders: pendingPdfRows });
    if (!result.response.ok) throw new Error(result.data?.message || '导入失败');
    const count = Number(result.data?.count || pendingPdfRows.length);
    closePdfModal();
    showToast(`已导入 ${count} 行新订单（未交已更新）`);
    await loadState({ quiet: true });
    renderAll();
  } catch (error) {
    showToast(error.message || '导入失败');
    els.confirmPdf.disabled = false;
  }
}

async function loadOverDeliveries() {
  if (!RPC_BASE) return [];
  const accessCode = getAccessCode();
  if (!accessCode) return [];
  try {
    const result = await callRpc('board_get_over_deliveries', { p_code: accessCode });
    if (!result.response.ok) return [];
    return Array.isArray(result.data) ? result.data : [];
  } catch { return []; }
}

async function loadOverOffsets() {
  if (!RPC_BASE) return [];
  const accessCode = getAccessCode();
  if (!accessCode) return [];
  try {
    const result = await callRpc('board_get_over_delivery_offsets', { p_code: accessCode, p_limit: 30 });
    if (!result.response.ok) return [];
    return Array.isArray(result.data) ? result.data : [];
  } catch { return []; }
}

async function loadDeliveryFiles() {
  if (!RPC_BASE) return [];
  const accessCode = getAccessCode();
  if (!accessCode) return [];
  try {
    const result = await callRpc('board_get_delivery_files', { p_code: accessCode, p_limit: 200 });
    if (!result.response.ok) return [];
    return Array.isArray(result.data) ? result.data : [];
  } catch { return []; }
}

function deliveryFiles() {
  return (snapshot && Array.isArray(snapshot.deliveryFiles)) ? snapshot.deliveryFiles : [];
}

// 云端送货单清单：按“发货日期 / 批次号 / 文件名”筛选，点一下就能下载 Excel
function renderDeliveryFiles(dateFilter, queryText) {
  const query = String(queryText || '').trim().toLowerCase();
  const rows = deliveryFiles().filter((row) => {
    if (dateFilter && String(row.deliveryDate || '') !== String(dateFilter)) return false;
    if (!query) return true;
    return [row.deliveryDate, row.batch, row.fileName, row.kind].join(' ').toLowerCase().includes(query);
  });
  if (!rows.length && !dateFilter && !query) return '';
  return `
    <section class="file-box">
      <div class="over-head"><strong>云端送货单（已上传的 Excel）</strong><span>${rows.length} 个文件</span></div>
      ${rows.length ? rows.map((row) => `
        <div class="over-row file-row">
          <span class="mono">${escapeHtml(row.deliveryDate)}</span>
          <span>${escapeHtml(row.fileName)}${row.kind ? ` · ${escapeHtml(row.kind)}` : ''}${row.noteCount ? ` · ${fmt(row.noteCount)} 张` : ''}</span>
          <button type="button" class="file-download" data-file-id="${escapeHtml(row.id)}">下载 Excel</button>
        </div>`).join('')
        : '<p class="over-tip">这几天还没有上传送货单，或换个日期再找。</p>'}
    </section>`;
}

async function downloadDeliveryFile(id, button) {
  const row = deliveryFiles().find((item) => String(item.id) === String(id));
  const original = button ? button.textContent : '';
  if (button) { button.disabled = true; button.textContent = '下载中...'; }
  try {
    const result = await callRpc('board_get_delivery_file', { p_code: getAccessCode(), p_id: id });
    if (!result.response.ok) throw new Error(result.data?.message || '下载失败');
    const data = result.data || {};
    const binary = atob(String(data.contentBase64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = data.fileName || row?.fileName || '送货单.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(`已开始下载 ${link.download}`);
  } catch (error) {
    showToast(error.message || '下载失败');
  } finally {
    if (button) { button.disabled = false; button.textContent = original || '下载 Excel'; }
  }
}

function overOffsets() {
  return (snapshot && Array.isArray(snapshot.overOffsets)) ? snapshot.overOffsets : [];
}

function overDeliveries() {
  return (snapshot && Array.isArray(snapshot.overDeliveries)) ? snapshot.overDeliveries : [];
}

function overDeliveryFor(material) {
  const key = String(material || '').trim();
  return overDeliveries().filter((row) => String(row.material || '').trim() === key);
}

async function registerOverDelivery(payload) {
  const accessCode = getAccessCode();
  if (!accessCode) { showToast('缺少访问码'); return false; }
  try {
    const result = await callRpc('board_add_over_delivery', { p_code: accessCode, p_payload: payload });
    if (!result.response.ok) throw new Error(result.data?.message || '登记失败');
    return result.data || { ok: true };
  } catch (error) {
    showToast(error.message || '登记超发失败');
    return false;
  }
}

// 无订单发货清单（等后续同料号订单来了再冲抵）
function renderOverDeliveryList() {
  const rows = overDeliveries();
  if (!rows.length) return '';
  const total = rows.reduce((sum, row) => sum + Number(row.remaining || 0), 0);
  return `
    <section class="over-box">
      <div class="over-head"><strong>无订单发货（待后续订单冲抵）</strong><span>${rows.length} 项 · ${fmt(total)} 件</span></div>
      ${rows.map((row) => `
        <div class="over-row">
          <span class="mono">${escapeHtml(row.material)}</span>
          <span>${escapeHtml(row.name)}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</span>
          <strong>${fmt(row.remaining)} 件</strong>
        </div>`).join('')}
      <p class="over-tip">这些货已经发出但没有对应采购单；等出现同料号的新订单时，导入新订单会提示你冲抵。</p>
    </section>`;
}

// 之前多送、现在有订单可以冲抵的候选
function offsetCandidates() {
  const rows = overDeliveries();
  if (!rows.length) return [];
  const out = [];
  for (const over of rows) {
    const material = String(over.material || '').trim();
    const remaining = Number(over.remaining || 0);
    if (!material || remaining <= 0) continue;
    const orders = materialOrders(material).filter((order) => !over.customer || String(order.customer || '') === String(over.customer));
    if (!orders.length) continue;
    const total = orders.reduce((sum, order) => sum + Number(order.remaining || 0), 0);
    out.push({ over, orders, total, take: Math.min(remaining, Number(orders[0].remaining || 0)) });
  }
  return out;
}

// 护栏/护脚栏类：不用手工点，自动冲抵，并把结果告诉用户（不影响送货单）
async function autoOffsetBangfan() {
  if (autoOffsetRunning || !snapshot) return;
  // 本次装车还有未提交的勾选时先不自动冲抵，避免和正在装的货冲突
  if (selected.size > 0) return;
  const list = offsetCandidates().filter((item) => isBangfanName(item.over.name));
  if (!list.length) return;
  autoOffsetRunning = true;
  const done = [];
  try {
    for (const item of list) {
      let over = item.over;
      for (let guard = 0; guard < 20; guard += 1) {
        const remaining = Number(over.remaining || 0);
        if (remaining <= 0) break;
        const target = materialOrders(over.material)
          .filter((order) => !over.customer || String(order.customer || '') === String(over.customer))[0];
        if (!target) break;
        const result = await callRpc('board_apply_offset', {
          p_code: getAccessCode(), p_over_id: over.id, p_order_id: target.id,
        });
        if (!result.response.ok) break;
        const applied = Number(result.data?.applied || 0);
        if (applied <= 0) break;
        done.push({ material: over.material, quantity: applied });
        over = Object.assign({}, over, { remaining: remaining - applied });
      }
    }
  } finally {
    autoOffsetRunning = false;
  }
  if (!done.length) return;
  const merged = new Map();
  for (const item of done) merged.set(item.material, (merged.get(item.material) || 0) + item.quantity);
  const summary = [...merged.entries()].map(([material, quantity]) => `${material} ${fmt(quantity)} 件`).join('、');
  autoOffsetNote = `已自动冲抵前期多送：${summary}（护栏/护脚栏类，不影响送货单）`;
  showToast(autoOffsetNote);
  await loadState({ quiet: true });
  renderAll();
}

function renderOffsetBox() {
  if (!els.mobileOffsetBox) return;
  const list = offsetCandidates().filter((item) => !isBangfanName(item.over.name));
  if (!list.length && !autoOffsetNote) {
    els.mobileOffsetBox.hidden = true;
    els.mobileOffsetBox.innerHTML = '';
    return;
  }
  els.mobileOffsetBox.hidden = false;
  const noteHtml = autoOffsetNote ? `<div class="offset-note">${escapeHtml(autoOffsetNote)}</div>` : '';
  els.mobileOffsetBox.innerHTML = noteHtml + list.map((item) => `
    <div class="offset-row">
      <div class="offset-text">
        <strong>前期多送可以冲抵了</strong>
        <span class="mono">${escapeHtml(item.over.material)}</span>
        <span>${escapeHtml(item.over.name)}${item.over.spec ? ' · ' + escapeHtml(item.over.spec) : ''}</span>
        <span>之前多送 <b>${fmt(item.over.remaining)}</b> 件；现有未交 ${fmt(item.total)} 件（最早 ${escapeHtml(item.orders[0].po)} 项次${escapeHtml(item.orders[0].seq)}）</span>
      </div>
      <button type="button" class="over-button" data-offset-over="${escapeHtml(item.over.id)}">冲抵 ${fmt(item.take)} 件</button>
    </div>`).join('');
}

// 冲抵记录（把前期多送的货冲抵到新订单上的流水）
function renderOverOffsetList() {
  const rows = overOffsets().slice(0, 12);
  if (!rows.length) return '';
  const stamp = (value) => {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
  };
  return `
    <section class="over-box offset-history">
      <div class="over-head"><strong>冲抵记录</strong><span>最近 ${rows.length} 笔</span></div>
      ${rows.map((row) => {
        const orderId = String(row.orderId || '');
        const [po, seq] = orderId.split('#');
        return `<div class="over-row">
          <span class="mono">${escapeHtml(row.material)}</span>
          <span>${escapeHtml(row.name || '')}<br><em>冲抵到 ${escapeHtml(po)}${seq ? ' 项次' + escapeHtml(seq) : ''} · ${escapeHtml(stamp(row.appliedAt))}</em></span>
          <strong>${fmt(row.quantity)} 件</strong>
          <button type="button" class="over-revoke" data-revoke-offset="${escapeHtml(row.id)}">撤回</button>
        </div>`;
      }).join('')}
    </section>`;
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

// 电脑端两个页面：实时总览 / 发货记录
function showDesktopView(name) {
  const overview = document.getElementById('desktopView');
  const shipments = document.getElementById('desktopShipmentsView');
  if (!overview || !shipments) return;
  const isShipments = name === 'shipments';
  overview.hidden = isShipments;
  shipments.hidden = !isShipments;
  document.querySelectorAll('[data-desktop-view]').forEach((link) => {
    link.classList.toggle('active', link.dataset.desktopView === name);
  });
  if (isShipments) renderDesktopHistory();
  window.scrollTo({ top: 0 });
}

function renderAll() {
  if (!snapshot) return;
  renderDesktopMetrics();
  renderDesktopTable();
  renderDesktopHistory();
  renderOffsetBox();
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
  if (els.metricUrgent) els.metricUrgent.textContent = fmt(summary.overdue + summary.dueToday);
}

const DESKTOP_COLUMN_WIDTH_KEY = 'shipmentDesktopColumnWidths';
const DESKTOP_COLUMN_DEFAULT_WIDTHS = [118, 92, 220, 170, 64, 118, 68, 76];

function readDesktopColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(DESKTOP_COLUMN_WIDTH_KEY) || '[]');
    if (Array.isArray(saved) && saved.length === DESKTOP_COLUMN_DEFAULT_WIDTHS.length) {
      return saved.map((value, index) => {
        const width = Number(value);
        return Number.isFinite(width) ? Math.max(44, Math.min(420, Math.round(width))) : DESKTOP_COLUMN_DEFAULT_WIDTHS[index];
      });
    }
  } catch {}
  return [...DESKTOP_COLUMN_DEFAULT_WIDTHS];
}

function writeDesktopColumnWidths(widths) {
  try { localStorage.setItem(DESKTOP_COLUMN_WIDTH_KEY, JSON.stringify(widths)); } catch {}
}

function applyDesktopColumnWidths(widths = readDesktopColumnWidths()) {
  const columns = [...document.querySelectorAll('#desktopOrdersColgroup col')];
  if (!columns.length) return;
  const normalized = columns.map((_, index) => {
    const width = Number(widths[index]);
    return Number.isFinite(width)
      ? Math.max(44, Math.min(420, Math.round(width)))
      : DESKTOP_COLUMN_DEFAULT_WIDTHS[index];
  });
  const total = normalized.reduce((sum, width) => sum + width, 0);
  columns.forEach((column, index) => { column.style.width = `${normalized[index]}px`; });
  const table = columns[0].closest('table');
  if (table) table.style.minWidth = `${Math.max(760, total)}px`;
}

function setupDesktopColumnResize() {
  const table = document.querySelector('.orders-table');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')];
  headers.forEach((header, index) => {
    const handle = header.querySelector('.col-resizer');
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const widths = readDesktopColumnWidths();
      const startWidth = widths[index];
      const onMove = (moveEvent) => {
        widths[index] = Math.max(44, Math.min(420, Math.round(startWidth + moveEvent.clientX - startX)));
        applyDesktopColumnWidths(widths);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        handle.classList.remove('dragging');
        writeDesktopColumnWidths(widths);
      };
      handle.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    handle.addEventListener('dblclick', () => {
      const widths = readDesktopColumnWidths();
      widths[index] = DESKTOP_COLUMN_DEFAULT_WIDTHS[index];
      applyDesktopColumnWidths(widths);
      writeDesktopColumnWidths(widths);
    });
  });
}

function renderDesktopTable() {
  const rows = desktopRows();
  els.desktopTableBody.innerHTML = rows.map((order) => {
    const badge = dueBadge(order);
    return `
      <tr>
        <td><span class="order-id">${escapeHtml(order.po)}</span><span class="company-tag" title="${escapeHtml(companyName(orderCompany(order)))}">${escapeHtml(orderCompany(order) || '—')}</span></td>
        <td><span class="material-code mono">${escapeHtml(order.material)}</span>${(() => { const info = materialSummary(order); return info.count > 1 ? `<span class="material-total-tag" title="同一物料编号所有采购单合计未交">共${fmt(info.total)}/${info.count}单</span>` : ''; })()}</td>
        <td><span class="item-name">${escapeHtml(order.name)}</span></td>
        <td><span class="spec-code mono">${escapeHtml(order.spec || '—')}</span></td>
        <td class="number">${escapeHtml(order.seq)}</td>
        <td><span class="due-date">${escapeHtml(formatDate(order.dueDate))}</span><span class="due-badge ${badge.className}">${escapeHtml(dueStatus(order).text)}</span></td>
        <td class="number"><span class="remaining-number">${fmt(order.remaining)}</span></td>
        <td class="number"><span class="shipped-number">${fmt(order.shipped)}</span></td>
      </tr>`;
  }).join('');
  els.desktopEmpty.hidden = rows.length > 0;
}

function shipmentDate(shipment) {
  const text = shipShanghaiDate(shipment.createdAt);
  return text;
}

function shipShanghaiDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const shanghai = new Date(date.getTime() + 8 * 3600 * 1000);
  return shanghai.toISOString().slice(0, 10);
}

function shipmentMatches(shipment, query) {
  if (!query) return true;
  const text = [
    shipment.id, shipment.vehicle, shipment.operator, shipment.note,
    ...shipment.items.flatMap((line) => [line.material, line.name, line.spec, line.orderId]),
  ].join(' ').toLowerCase();
  return text.includes(query);
}

function filterShipments(date, queryText) {
  const query = String(queryText || '').trim().toLowerCase();
  return snapshot.shipments.filter((shipment) => {
    if (date && shipShanghaiDate(shipment.createdAt) !== date) return false;
    return shipmentMatches(shipment, query);
  });
}

function filteredShipments() {
  return filterShipments(historyDate, historyQuery);
}

// 把同一天的多笔发货合并成一张汇总（按物料汇总数量）
function mergedShipmentsByDate(shipments) {
  const map = new Map();
  for (const shipment of shipments) {
    const day = shipShanghaiDate(shipment.createdAt);
    if (!map.has(day)) map.set(day, { day, count: 0, total: 0, items: new Map() });
    const row = map.get(day);
    row.count += 1;
    row.total += Number(shipment.totalQuantity || 0);
    for (const item of shipment.items || []) {
      const key = [item.material, item.name, item.spec].map((v) => String(v || '')).join('|');
      row.items.set(key, (row.items.get(key) || 0) + Number(item.quantity || 0));
    }
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

function renderHistoryCards(shipments) {
  if (!shipments.length) return '<div class="empty-state"><strong>没有符合条件的发货记录</strong><span>换个日期或清空搜索词再试。</span></div>';
  return shipments.map((shipment) => {
    const items = shipment.items || [];
    const expanded = expandedShipments.has(shipment.id);
    const shown = expanded ? items : items.slice(0, 5);
    const hidden = items.length - shown.length;
    const time = new Date(shipment.createdAt);
    const stamp = Number.isNaN(time.getTime())
      ? ''
      : `${time.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai' })} ${time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}`;
    return `
    <article class="history-card">
      <div class="history-head">
        <strong>${escapeHtml(shipment.vehicle)}</strong>
        <span>${escapeHtml(stamp)}</span>
      </div>
      <div class="history-meta">${escapeHtml(shipment.id)} · ${escapeHtml(shipment.operator)}${shipment.note ? ` · ${escapeHtml(shipment.note)}` : ''}</div>
      <div class="history-lines">
        ${shown.map((line) => `<div class="history-line"><span>${escapeHtml(line.material)} ${escapeHtml(line.name)}</span><strong>${fmt(line.quantity)} 件</strong></div>`).join('')}
      </div>
      ${items.length > 5 ? `<button class="history-expand" type="button" data-expand="${escapeHtml(shipment.id)}">${expanded ? '收起明细' : `展开全部 ${items.length} 项（还有 ${hidden} 项）`}</button>` : ''}
      <div class="history-total">合计 ${fmt(shipment.totalQuantity)} 件 · ${items.length} 项</div>
      <button class="undo-button" type="button" data-undo="${escapeHtml(shipment.id)}">撤销这笔发货</button>
    </article>`;
  }).join('');
}

function renderDesktopHistory() {
  if (!snapshot) return;
  const rows = filteredShipments();
  const quantity = rows.reduce((sum, item) => sum + Number(item.totalQuantity || 0), 0);
  if (els.historySummary) {
    els.historySummary.textContent = rows.length === snapshot.shipments.length
      ? `共 ${rows.length} 笔 · 合计 ${fmt(quantity)} 件`
      : `筛选出 ${rows.length} 笔 · 合计 ${fmt(quantity)} 件`;
  }
  els.shipmentHistory.innerHTML = renderDeliveryFiles(historyDate, historyQuery)
    + renderOverDeliveryList() + renderOverOffsetList() + renderHistoryCards(rows);
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
      ${(() => { const info = materialSummary(order); return info.count > 1
        ? `<div class="material-total">同料号共 ${info.count} 单 · 未交合计 <b>${fmt(info.total)}</b></div>` : ''; })()}
      ${overDeliveryFor(order.material).length ? `<div class="material-total over">该料号已有无订单发货 <b>${fmt(overDeliveryFor(order.material).reduce((sum, row) => sum + Number(row.remaining || 0), 0))}</b> 件待冲抵</div>` : ''}
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
}

function remainingRows() {
  let rows = filteredOrders('active');
  const query = remainingSearch.trim().toLowerCase();
  if (query) rows = rows.filter((order) => searchable(order).includes(query));
  if (remainingDue !== 'all') {
    rows = rows.filter((order) => {
      const diff = dayDiff(order.dueDate);
      if (!Number.isFinite(diff)) return false;
      if (remainingDue === 'overdue') return diff < 0;
      if (remainingDue === 'today') return diff === 0;
      if (remainingDue === 'tomorrow') return diff === 1;
      if (remainingDue === 'week') return diff >= 0 && diff <= 7;
      if (remainingDue === 'custom') return remainingDueDate ? order.dueDate === remainingDueDate : true;
      return true;
    });
  }
  return rows;
}

function renderMobileRemaining() {
  if (!els.remainingList) return;
  const all = remainingRows();
  const rows = all.slice(0, 120);
  els.remainingList.innerHTML = `
    <div class="records-head"><strong>未交清单</strong><span>共 ${fmt(all.length)} 项${all.length > 120 ? `，显示交期优先的前 120 项` : ''}。</span></div>
    ${rows.map((order) => {
      const badge = dueBadge(order);
      return `<article class="mobile-remaining-card">
        <div class="mobile-remaining-row">
          <div class="remaining-cell order-cell">
            <span>订单号</span>
            <strong class="mono">${escapeHtml(order.po)}</strong>
          </div>
          <div class="remaining-cell detail-cell">
            <div class="detail-line"><span>编号</span><strong class="mono">${escapeHtml(order.material)}</strong></div>
            <div class="detail-line"><span>品名</span><strong>${escapeHtml(order.name)}</strong></div>
            <div class="detail-line"><span>图号</span><strong class="mono">${escapeHtml(order.spec || '—')}</strong></div>
          </div>
          <div class="remaining-cell meta-cell">
            <div class="meta-line"><span>数量</span><strong class="quantity-value">${fmt(order.remaining)}</strong></div>
            <div class="meta-line"><span>项次</span><strong>${escapeHtml(order.seq)}</strong></div>
          </div>
          <div class="remaining-cell due-cell">
            <span>交期</span>
            <strong>${escapeHtml(formatDate(order.dueDate))}</strong>
            <em class="due-badge ${badge.className}">${escapeHtml(badge.text)}</em>
          </div>
        </div>
      </article>`;
    }).join('')}`;
}

function renderMobileRecords() {
  if (!els.recordsList) return;
  const filtering = Boolean(recordsDate) || Boolean(recordsSearch.trim());
  const rows = filterShipments(recordsDate, recordsSearch);
  const merged = filtering ? mergedShipmentsByDate(rows) : [];
  const mergedTotal = merged.reduce((sum, row) => sum + row.total, 0);
  const mergedHtml = filtering ? `
    <div class="records-head"><strong>按日期合并查看</strong><span>${merged.length} 天 · 合计 ${fmt(mergedTotal)} 件 · ${rows.length} 笔发货</span></div>
    ${merged.length ? merged.map((row) => `
      <article class="over-box merged-day">
        <div class="over-head"><strong>${escapeHtml(row.day)}</strong><span>${row.count} 笔 · ${fmt(row.total)} 件</span></div>
        ${[...row.items.entries()].map(([key, quantity]) => {
          const [material, name, spec] = key.split('|');
          return `<div class="over-row"><span class="mono">${escapeHtml(material)}</span><span>${escapeHtml(name)}${spec ? ' · ' + escapeHtml(spec) : ''}</span><strong>${fmt(quantity)} 件</strong></div>`;
        }).join('')}
      </article>`).join('') : '<div class="empty-state"><strong>这几天没有发货记录</strong><span>换个日期或清空搜索词再试。</span></div>'}` : '';
  els.recordsList.innerHTML = renderDeliveryFiles(recordsDate, recordsSearch)
    + renderOverDeliveryList() + renderOverOffsetList() + mergedHtml + renderHistoryCards(rows);
  els.recordsList.querySelectorAll('[data-expand]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.expand;
    if (expandedShipments.has(id)) expandedShipments.delete(id);
    else expandedShipments.add(id);
    renderMobileRecords();
    renderDesktopHistory();
  }));
}

async function revokeOffset(offsetId) {
  if (!window.confirm('要把这笔冲抵撤回吗？\n撤回后：订单未交会加回去，前期多送记录会恢复。')) return;
  const result = await callRpc('board_revoke_offset', { p_code: getAccessCode(), p_offset_id: offsetId });
  if (!result.response.ok) { showToast(result.data?.message || '撤回失败'); return; }
  showToast('已撤回这笔冲抵');
  await loadState({ quiet: true });
  renderAll();
}

async function revokeOverDelivery(overId) {
  if (!window.confirm('要把这笔“无订单发货”撤回吗？\n会同时撤销它引起的冲抵，订单未交恢复原样。')) return;
  const result = await callRpc('board_revoke_over_delivery', { p_code: getAccessCode(), p_over_id: overId });
  if (!result.response.ok) { showToast(result.data?.message || '撤回失败'); return; }
  sessionOver.clear();
  showToast('已撤回这笔无订单发货');
  await loadState({ quiet: true });
  renderAll();
}

function renderCartDetail() {
  if (!els.cartDetail) return;
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  const overRows = [...sessionOver.entries()];
  if (!cartOpen || (!entries.length && !overRows.length)) {
    els.cartDetail.hidden = true;
    els.cartDetail.innerHTML = '';
    return;
  }
  els.cartDetail.hidden = false;
  const lines = entries.map(([id, quantity]) => {
    const order = snapshot.orders.find((item) => item.id === id);
    if (!order) return '';
    return `<div class="cart-line">
      <div class="cart-line-info">
        <strong>${escapeHtml(order.material)} ${escapeHtml(order.name)}</strong>
        <span>${escapeHtml(order.po)} 项次${escapeHtml(order.seq)} · 本行最多 ${fmt(order.remaining)}</span>
      </div>
      <input type="number" min="0" max="${order.remaining}" step="1" inputmode="decimal" value="${quantity}" data-cart-id="${escapeHtml(id)}" aria-label="本次数量">
      <button type="button" class="cart-remove" data-cart-remove="${escapeHtml(id)}">取消</button>
    </div>`;
  }).join('');
  const overLines = overRows.map(([material, item]) => `<div class="cart-line over">
      <div class="cart-line-info">
        <strong>${escapeHtml(material)} ${escapeHtml(item.name || '')}</strong>
        <span>${item.pending ? '无订单发货（提交装车时自动登记）' : '无订单发货（已登记，可撤回）'}</span>
      </div>
      <strong class="cart-over-qty">${fmt(item.quantity)} 件</strong>
      ${item.pending
        ? `<button type="button" class="cart-remove" data-cart-over-cancel="${escapeHtml(material)}">取消</button>`
        : `<button type="button" class="cart-remove" data-cart-over="${escapeHtml(item.id)}">撤回</button>`}
    </div>`).join('');
  els.cartDetail.innerHTML = `<div class="cart-detail-head"><strong>本次装车明细</strong>`
    + `<span>${entries.length} 项订单${overRows.length ? ` + ${overRows.length} 项无订单发货` : ''}，可直接改数量或取消</span></div>`
    + lines + overLines;
}

function renderCart() {
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  const quantity = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  els.cartQty.textContent = fmt(quantity);
  els.cartItems.textContent = fmt(entries.length);
  const overCount = [...sessionOver.values()].filter((item) => Number(item.quantity) > 0).length;
  els.mobileCartBar.hidden = mobileTab !== 'entry' || (!entries.length && !overCount);
  renderCartDetail();
}

// 同一物料编号在多个采购单上都还有未交时的汇总（物料编号 -> 总未交/单数）
function materialSummary(order) {
  const key = String(order.material || '').trim();
  const map = new Map();
  for (const item of snapshot.orders) {
    if (!(item.remaining > 0)) continue;
    const itemKey = String(item.material || '').trim();
    if (!itemKey) continue;
    const row = map.get(itemKey) || { total: 0, count: 0 };
    row.total += Number(item.remaining || 0);
    row.count += 1;
    map.set(itemKey, row);
  }
  return map.get(key) || { total: Number(order.remaining || 0), count: 1 };
}

// 同一物料的所有未交行，按交期从早到晚（同交期按项次）
function materialOrders(material) {
  const key = String(material || '').trim();
  return snapshot.orders
    .filter((item) => String(item.material || '').trim() === key && item.remaining > 0)
    .sort((a, b) => {
      const left = String(a.dueDate || '9999-12-31');
      const right = String(b.dueDate || '9999-12-31');
      if (left !== right) return left < right ? -1 : 1;
      return Number(a.seq || 0) - Number(b.seq || 0);
    });
}

function showAllocationNotice(text, level = '', actionHtml = '') {
  if (!els.mobileAllocNotice) return;
  els.mobileAllocNotice.hidden = !text;
  els.mobileAllocNotice.className = `alloc-notice${level ? ' ' + level : ''}`;
  els.mobileAllocNotice.innerHTML = escapeHtml(text || '') + (actionHtml || '');
}

// 输入的总数超过本行未交时：按交期把这个总数分配到该物料的所有未交行
function allocateByDueDate(order, requested) {
  const rows = materialOrders(order.material);
  const totalRemaining = rows.reduce((sum, item) => sum + Number(item.remaining || 0), 0);
  if (totalRemaining <= 0) return;
  const target = Math.min(requested, totalRemaining);
  let left = target;
  const parts = [];
  for (const item of rows) {
    const take = left > 0 ? Math.min(left, Number(item.remaining || 0)) : 0;
    left -= take;
    if (take > 0) {
      selected.set(item.id, take);
      parts.push(`${fmt(take)}`);
    } else {
      selected.delete(item.id);
    }
    updateOrderCardSelection(item.id);
  }
  renderMobileSummary();
  renderCart();
  const excess = Math.max(0, requested - totalRemaining);
  const head = `${order.material} 共 ${rows.length} 单、合计未交 ${fmt(totalRemaining)}，本次 ${fmt(requested)} 件`;
  if (excess > 0) {
    // 超出所有未交订单的部分先记在本次装车里，等提交装车时自动登记成“无订单发货”
    sessionOver.set(String(order.material || '').trim(), {
      id: '',
      pending: true,
      quantity: excess,
      name: order.name || '',
      spec: order.spec || '',
      customer: orderCompany(order),
    });
    const action = `<button type="button" class="over-button" data-over-cancel="${escapeHtml(order.material)}">`
      + `取消这部分无订单发货</button>`;
    showAllocationNotice(`${head}：已按交期分配 ${parts.join(' + ')} = ${fmt(target)} 件；`
      + `还有 ${fmt(excess)} 件没有对应订单，已自动记为「无订单发货」，提交装车时一起保存。`, 'warn', action);
  } else {
    clearPendingOver(order.material);
    showAllocationNotice(`${head}：已按交期分配 ${parts.join(' + ')} = ${fmt(target)} 件。`, 'ok');
  }
}

// 本次装车里还没真正登记的无订单发货（改了数量或取消时清掉）
function clearPendingOver(material) {
  const key = String(material || '').trim();
  const entry = sessionOver.get(key);
  if (entry && entry.pending) sessionOver.delete(key);
}

function updateOrderCardSelection(orderId) {
  const card = [...document.querySelectorAll('[data-order-card]')].find((item) => item.dataset.orderCard === orderId);
  if (!card) return;
  const quantity = Number(selected.get(orderId) || 0);
  const input = card.querySelector('[data-action="input"]');
  if (input) input.value = quantity > 0 ? quantity : '';
  card.classList.toggle('selected', quantity > 0);
  let tag = card.querySelector('.selected-tag');
  if (quantity > 0) {
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'selected-tag';
      card.prepend(tag);
    }
    tag.textContent = `已选 ${fmt(quantity)}`;
  } else if (tag) {
    tag.remove();
  }
}

function addQuantity(orderId, delta) {
  const order = snapshot.orders.find((item) => item.id === orderId);
  if (!order) return;
  const current = Number(selected.get(orderId) || 0);
  const next = Math.max(0, Math.min(order.remaining, current + delta));
  if (next > 0) selected.set(orderId, next);
  else selected.delete(orderId);
  clearPendingOver(order.material);
  updateOrderCardSelection(orderId);
  renderMobileSummary();
  renderCart();
}

function setQuantity(orderId, value) {
  const order = snapshot.orders.find((item) => item.id === orderId);
  if (!order) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    selected.delete(orderId);
    updateOrderCardSelection(orderId);
    renderMobileSummary();
    renderCart();
    return;
  }
  // 本行够装就只填本行；超过本行未交，就把这个总数按交期分配到该物料的后续采购单
  if (numeric <= Number(order.remaining || 0)) {
    selected.set(orderId, numeric);
    clearPendingOver(order.material);
    updateOrderCardSelection(orderId);
    renderMobileSummary();
    renderCart();
    return;
  }
  allocateByDueDate(order, numeric);
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
  const overRows = [...sessionOver.values()].filter((item) => item.pending && Number(item.quantity) > 0);
  const overTotal = overRows.reduce((sum, item) => sum + Number(item.quantity), 0);
  els.submitSummary.innerHTML = `
    <div class="submit-summary-row"><span>本次物料</span><strong>${entries.length} 项</strong></div>
    <div class="submit-summary-row"><span>本次总数量</span><strong>${fmt(total)} 件</strong></div>
    ${overTotal ? `<div class="submit-summary-row"><span>其中无订单发货</span><strong>${fmt(overTotal)} 件（提交时自动登记）</strong></div>` : ''}
    <div class="submit-summary-row"><span>提交后</span><strong>电脑端自动扣减未交</strong></div>`;
  els.submitModal.hidden = false;
}

function closeSubmitModal() {
  els.submitModal.hidden = true;
}

function setDeliveryStatus(message, type = '') {
  els.deliveryStatus.textContent = message;
  els.deliveryStatus.className = `delivery-status${type ? ` ${type}` : ''}`;
}

function deliveryPayload() {
  return {
    date: els.deliveryDate.value,
    batch: Number(els.deliveryBatch.value),
    shipments: snapshot?.shipments || [],
    orders: snapshot?.orders || [],
  };
}

async function deliveryHelper(path, payload) {
  const options = payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    : { cache: 'no-store' };
  const response = await fetch(`${PRINT_HELPER_BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `打印助手请求失败（HTTP ${response.status}）`);
  return data;
}

function renderDeliveryPlan(plan) {
  const notes = plan.notes || [];
  if (!notes.length) {
    els.deliveryPreview.innerHTML = '<div class="empty-state"><strong>当天没有可生成的发货数据</strong><span>请先完成装车提交。</span></div>';
    return;
  }
  const zzNotes = notes.filter((note) => note.group === '镀锌/ZZ');
  const totalQuantity = notes.reduce((sum, note) => sum + Number(note.totalQuantity || 0), 0);
  els.deliveryPreview.innerHTML = `
    <div class="delivery-summary">
      <div><span>送货单</span><strong>${notes.length} 张</strong></div>
      <div><span>镀锌 / ZZ</span><strong>${zzNotes.length} 张</strong></div>
      <div><span>合计数量</span><strong>${fmt(totalQuantity)}</strong></div>
    </div>
    ${notes.map((note) => `
      <article class="delivery-note-preview">
        <div class="delivery-note-head">
          <strong>${escapeHtml(note.number)} · ${escapeHtml(note.group)}</strong>
          <span>${note.items.length} 项 · ${fmt(note.totalQuantity)} 件</span>
        </div>
        <div class="delivery-note-lines">
          ${note.items.map((line) => `
            <div class="delivery-note-line">
              <span>${escapeHtml(line.po)} · 项次 ${escapeHtml(line.seq)}</span>
              <span>${escapeHtml(line.material)} · ${escapeHtml(line.name)} · ${escapeHtml(line.spec || '—')}</span>
              <strong>${fmt(line.quantity)} 件</strong>
            </div>`).join('')}
        </div>
      </article>`).join('')}`;
}

async function refreshDeliveryPreview() {
  if (!snapshot) return;
  const date = els.deliveryDate.value;
  const batch = Number(els.deliveryBatch.value);
  if (!date) return setDeliveryStatus('请先选择送货日期。', 'error');
  if (!Number.isInteger(batch) || batch < 1) return setDeliveryStatus('批次号必须是大于 0 的整数。', 'error');
  els.printDeliveryNotes.disabled = true;
  els.refreshDeliveryPreview.disabled = true;
  setDeliveryStatus('正在汇总当天发货记录...');
  try {
    deliveryPlan = await deliveryHelper('/prepare', deliveryPayload());
    renderDeliveryPlan(deliveryPlan);
    setDeliveryStatus(`预览已生成：共 ${deliveryPlan.notes.length} 张送货单。修改日期或批次号后会自动重算。`, 'success');
    els.printDeliveryNotes.disabled = false;
  } catch (error) {
    deliveryPlan = null;
    renderDeliveryPlan({ notes: [] });
    setDeliveryStatus(`${error.message || '生成预览失败'}。请确认连接 EPSON 的电脑已启动“启动打印助手.cmd”。`, 'error');
  } finally {
    els.refreshDeliveryPreview.disabled = false;
  }
}

function openDeliveryModal() {
  const date = snapshot?.today || TODAY;
  const url = `${PRINT_HELPER_BASE}/preview?date=${encodeURIComponent(date)}`;
  showToast('正在打开本地送货单预览...');
  window.location.href = url;
}
function closeDeliveryModal() {
  els.deliveryModal.hidden = true;
}

async function printDeliveryNotes() {
  if (!deliveryPlan) return refreshDeliveryPreview();
  els.printDeliveryNotes.disabled = true;
  els.refreshDeliveryPreview.disabled = true;
  setDeliveryStatus('正在生成 Excel 并发送到 EPSON 打印机...');
  try {
    const result = await deliveryHelper('/print', deliveryPayload());
    els.deliveryBatch.value = String(result.nextBatch || Number(els.deliveryBatch.value) + 1);
    setDeliveryStatus(`已发送打印：共 ${result.noteCount} 张送货单，下一批次为 ${result.nextBatch}。`, 'success');
    showToast(`${result.noteCount} 张送货单已发送打印机`);
  } catch (error) {
    setDeliveryStatus(`${error.message || '打印失败'}。Excel 文件可能已生成，请查看打印助手窗口。`, 'error');
  } finally {
    els.printDeliveryNotes.disabled = false;
    els.refreshDeliveryPreview.disabled = false;
  }
}

async function submitShipment() {
  if (!els.shipmentForm.reportValidity()) return;
  const form = new FormData(els.shipmentForm);
  const payload = {
    customer: snapshot.customer,
    operator: String(form.get('operator') || '').trim() || '未填写',
    vehicle: String(form.get('vehicle') || '').trim() || '未填写',
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
    const shipmentId = result.shipmentId || result.shipment?.id || '本次发货';
    // 超出所有未交订单的部分：提交时自动登记成“无订单发货”，不用再手动点一次
    const pendingOvers = [...sessionOver.entries()].filter(([, item]) => item.pending && Number(item.quantity) > 0);
    const overSaved = [];
    const overFailed = [];
    for (const [material, item] of pendingOvers) {
      const created = await registerOverDelivery({
        material,
        name: item.name,
        spec: item.spec,
        customer: item.customer,
        quantity: Number(item.quantity),
        note: '装车时超出所有未交采购单的部分',
      });
      if (created && created.ok !== false) {
        sessionOver.delete(material);
        overSaved.push(`${material} ${fmt(item.quantity)} 件`);
      } else {
        overFailed.push(material);
      }
    }
    selected.clear();
    els.shipmentForm.reset();
    closeSubmitModal();
    showToast(`${shipmentId} 已保存${overSaved.length ? `，含无订单发货 ${overSaved.join('、')}` : ''}`);
    await loadState();
    if (overFailed.length) showToast(`无订单发货登记失败：${overFailed.join('、')}，请在本次装车明细里重新提交`);
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

// 点搜索框任意位置都能直接输入
[els.desktopSearch, els.remainingSearch, els.recordsSearch].forEach((input) => {
  if (!input) return;
  const box = input.closest('label');
  if (!box) return;
  box.addEventListener('mousedown', (event) => {
    if (event.target !== input) { event.preventDefault(); input.focus(); }
  });
});

els.desktopSearch.addEventListener('input', (event) => { desktopSearch = event.target.value; renderDesktopTable(); renderSuggestFor(els.desktopSearch, els.desktopSuggest, desktopDueRows()); });
els.desktopSearch.addEventListener('focus', () => renderSuggestFor(els.desktopSearch, els.desktopSuggest, desktopDueRows()));
if (els.desktopSuggest) {
  els.desktopSuggest.addEventListener('click', (event) => {
    const button = event.target.closest('[data-suggest]');
    if (!button) return;
    desktopSearch = pickSuggestion(button, els.desktopSearch, els.desktopSuggest);
    renderDesktopTable();
  });
}
els.desktopCompanyFilter.addEventListener('change', (event) => { desktopCompany = event.target.value; renderDesktopTable(); });
if (els.desktopDueSelect) els.desktopDueSelect.addEventListener('change', (event) => {
  desktopDueFilter = event.target.value;
  if (desktopDueFilter !== 'custom') desktopDueDate = '';
  if (els.desktopDueRow) els.desktopDueRow.hidden = desktopDueFilter !== 'custom';
  else if (els.desktopDueDate) els.desktopDueDate.hidden = desktopDueFilter !== 'custom';
  renderDesktopTable();
});
if (els.desktopDueDate) els.desktopDueDate.addEventListener('change', (event) => {
  desktopDueDate = event.target.value;
  renderDesktopTable();
});
els.mobileSearch.addEventListener('input', (event) => { mobileSearch = event.target.value; renderMobileList(); renderSuggestions(); });
els.mobileSearch.addEventListener('focus', () => { renderSuggestions(); });
if (els.mobileSuggest) {
  els.mobileSuggest.addEventListener('click', (event) => {
    const button = event.target.closest('[data-suggest]');
    if (!button) return;
    mobileSearch = button.dataset.suggest;
    if (els.mobileSearch) els.mobileSearch.value = mobileSearch;
    els.mobileSuggest.hidden = true;
    renderMobileList();
  });
}
document.addEventListener('click', (event) => {
  for (const [box, input] of [[els.mobileSuggest, els.mobileSearch], [els.desktopSuggest, els.desktopSearch]]) {
    if (!box || box.hidden) continue;
    if (box.contains(event.target) || event.target === input) continue;
    box.hidden = true;
  }
});
document.querySelectorAll('.mobile-tab').forEach((button) => button.addEventListener('click', () => switchMobileTab(button.dataset.tab)));
els.mobileFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  mobileFilter = button.dataset.filter;
  document.querySelectorAll('#mobileFilters .chip').forEach((chip) => chip.classList.toggle('active', chip === button));
  renderMobileList();
});
if (els.mobileCartSummary) {
  const toggleCart = () => { cartOpen = !cartOpen; renderCartDetail(); };
  els.mobileCartSummary.addEventListener('click', toggleCart);
  els.mobileCartSummary.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleCart(); } });
}
if (els.cartDetail) {
  els.cartDetail.addEventListener('change', (event) => {
    const input = event.target.closest('[data-cart-id]');
    if (!input) return;
    const order = snapshot.orders.find((item) => item.id === input.dataset.cartId);
    if (!order) return;
    const numeric = Number(input.value);
    if (!Number.isFinite(numeric) || numeric <= 0) selected.delete(order.id);
    else selected.set(order.id, Math.min(Number(order.remaining || 0), numeric));
    updateOrderCardSelection(order.id);
    renderMobileSummary();
    renderCart();
  });
  els.cartDetail.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-cart-remove]');
    if (remove) {
      selected.delete(remove.dataset.cartRemove);
      updateOrderCardSelection(remove.dataset.cartRemove);
      renderMobileSummary();
      renderCart();
      return;
    }
    const overCancel = event.target.closest('[data-cart-over-cancel]');
    if (overCancel) {
      sessionOver.delete(String(overCancel.dataset.cartOverCancel || '').trim());
      renderCart();
      showAllocationNotice(`已取消 ${overCancel.dataset.cartOverCancel} 的无订单发货。`, 'ok');
      return;
    }
    const over = event.target.closest('[data-cart-over]');
    if (over) revokeOverDelivery(over.dataset.cartOver);
  });
}
if (els.shipmentHistory) els.shipmentHistory.addEventListener('click', (event) => {
  const button = event.target.closest('[data-revoke-offset]');
  if (button) revokeOffset(button.dataset.revokeOffset);
});
if (els.mobileRecordsPanel) els.mobileRecordsPanel.addEventListener('click', (event) => {
  const fileButton = event.target.closest('[data-file-id]');
  if (fileButton) { downloadDeliveryFile(fileButton.dataset.fileId, fileButton); return; }
  const button = event.target.closest('[data-revoke-offset]');
  if (button) revokeOffset(button.dataset.revokeOffset);
});

if (els.mobileOffsetBox) els.mobileOffsetBox.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-offset-over]');
  if (!button) return;
  const overId = button.dataset.offsetOver;
  const over = overDeliveries().find((row) => String(row.id) === String(overId));
  if (!over) { showToast('找不到这条无订单发货记录'); return; }
  const target = materialOrders(over.material).filter((order) => !over.customer || String(order.customer || '') === String(over.customer))[0];
  if (!target) { showToast('暂时没有可以冲抵的订单'); return; }
  button.disabled = true;
  try {
    const result = await callRpc('board_apply_offset', {
      p_code: getAccessCode(), p_over_id: overId, p_order_id: target.id,
    });
    if (!result.response.ok) throw new Error(result.data?.message || '冲抵失败');
    const applied = Number(result.data?.applied || 0);
    showToast(`已冲抵 ${fmt(applied)} 件到 ${target.po} 项次${target.seq}`);
    await loadState({ quiet: true });
    renderAll();
  } catch (error) {
    showToast(error.message || '冲抵失败');
    button.disabled = false;
  }
});

if (els.mobileAllocNotice) els.mobileAllocNotice.addEventListener('click', (event) => {
  const button = event.target.closest('[data-over-cancel]');
  if (!button) return;
  const material = button.dataset.overCancel;
  sessionOver.delete(String(material || '').trim());
  renderCart();
  showAllocationNotice(`已取消 ${material} 的无订单发货，只保留有采购单的数量。`, 'ok');
});

if (els.mobileRemainingPanel) {
  els.mobileRemainingPanel.addEventListener('input', (event) => {
    if (event.target.id !== 'remainingSearch') return;
    remainingSearch = event.target.value;
    renderMobileRemaining();
  });
  els.mobileRemainingPanel.addEventListener('change', (event) => {
    if (event.target.id === 'remainingDueSelect') {
      remainingDue = event.target.value;
      if (remainingDue !== 'custom') remainingDueDate = '';
      if (els.remainingDueDate) {
        els.remainingDueDate.hidden = remainingDue !== 'custom';
        if (remainingDue !== 'custom') els.remainingDueDate.value = '';
      }
      renderMobileRemaining();
    }
    if (event.target.id === 'remainingDueDate') {
      remainingDueDate = event.target.value;
      renderMobileRemaining();
    }
  });
}

if (els.mobileRecordsPanel) {
  els.mobileRecordsPanel.addEventListener('input', (event) => {
    if (event.target.id !== 'recordsSearch') return;
    recordsSearch = event.target.value;
    renderMobileRecords();
  });
  els.mobileRecordsPanel.addEventListener('change', (event) => {
    if (event.target.id !== 'recordsDate') return;
    recordsDate = event.target.value;
    renderMobileRecords();
  });
  els.mobileRecordsPanel.addEventListener('click', (event) => {
    if (event.target.id !== 'recordsClear') return;
    recordsDate = '';
    if (els.recordsDate) els.recordsDate.value = '';
    renderMobileRecords();
  });
}

document.querySelectorAll('[data-desktop-view]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showDesktopView(link.dataset.desktopView);
  });
});

if (els.historySearch) els.historySearch.addEventListener('input', (event) => { historyQuery = event.target.value; renderDesktopHistory(); });
if (els.historyDate) els.historyDate.addEventListener('change', (event) => { historyDate = event.target.value; renderDesktopHistory(); });
if (els.historyClear) els.historyClear.addEventListener('click', () => { historyDate = ''; if (els.historyDate) els.historyDate.value = ''; renderDesktopHistory(); });
function handleHistoryClick(event) {
  const fileButton = event.target.closest('[data-file-id]');
  if (fileButton) { downloadDeliveryFile(fileButton.dataset.fileId, fileButton); return; }
  const expand = event.target.closest('[data-expand]');
  if (expand) {
    const id = expand.dataset.expand;
    if (expandedShipments.has(id)) expandedShipments.delete(id);
    else expandedShipments.add(id);
    renderDesktopHistory();
    renderMobileRecords();
  }
}
if (els.shipmentHistory) els.shipmentHistory.addEventListener('click', handleHistoryClick);
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
    clearPendingOver(order.material);
    updateOrderCardSelection(id);
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
  updateOrderCardSelection(input.dataset.id);
});
$('#openSubmit').addEventListener('click', openSubmitModal);
$('#closeModal').addEventListener('click', closeSubmitModal);
$('#clearSelection').addEventListener('click', () => { selected.clear(); closeSubmitModal(); renderMobileList(); renderMobileSummary(); renderCart(); });
$('#submitShipment').addEventListener('click', submitShipment);
els.generateDeliveryNote.addEventListener('click', openDeliveryModal);
els.closeDeliveryModal.addEventListener('click', closeDeliveryModal);
els.closeDeliveryModalAction.addEventListener('click', closeDeliveryModal);
els.refreshDeliveryPreview.addEventListener('click', refreshDeliveryPreview);
els.printDeliveryNotes.addEventListener('click', printDeliveryNotes);
els.deliveryDate.addEventListener('change', refreshDeliveryPreview);
els.deliveryBatch.addEventListener('change', refreshDeliveryPreview);
$('#mobileRefresh').addEventListener('click', () => loadState());
$('#resetButton').addEventListener('click', resetRecords);
$('#importButton').addEventListener('click', () => els.importFileInput.click());

// 采购订单 PDF 导入
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}
if (els.pdfImportButton && els.pdfFileInput) {
  els.pdfImportButton.addEventListener('click', () => els.pdfFileInput.click());
  els.pdfFileInput.addEventListener('change', (event) => handlePdfFiles(event.target.files));
}
if (els.confirmPdf) els.confirmPdf.addEventListener('click', confirmPdfImport);
if (els.cancelPdf) els.cancelPdf.addEventListener('click', closePdfModal);
if (els.closePdfModal) els.closePdfModal.addEventListener('click', closePdfModal);
els.importFileInput.addEventListener('change', handleImportFile);
els.confirmImport.addEventListener('click', confirmImportOrders);
els.closeImportModal.addEventListener('click', closeImportDialog);
els.cancelImport.addEventListener('click', closeImportDialog);
els.submitModal.addEventListener('click', (event) => { if (event.target === els.submitModal) closeSubmitModal(); });
els.deliveryModal.addEventListener('click', (event) => { if (event.target === els.deliveryModal) closeDeliveryModal(); });
els.shipmentHistory.addEventListener('click', (event) => {
  const button = event.target.closest('[data-undo]');
  if (button) undoShipment(button.dataset.undo);
});
els.mobileRecordsPanel.addEventListener('click', (event) => {
  const button = event.target.closest('[data-undo]');
  if (button) undoShipment(button.dataset.undo);
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeSubmitModal(); closeDeliveryModal(); } });

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

applyDesktopColumnWidths();
setupDesktopColumnResize();
setupRpcExportLink();
await loadState();
connectEvents();



















