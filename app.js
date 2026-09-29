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
const BOARD_MODE = (() => {
  const value = new URLSearchParams(location.search).get('mode');
  return value === 'admin' || value === 'user' ? value : '';
})();
const MODE_KEY_SUFFIX = BOARD_MODE ? ':' + BOARD_MODE : '';
const ACCESS_CODE_STORAGE_KEY = ACCESS_CODE_KEY + MODE_KEY_SUFFIX;
const ROLE_STORAGE_KEY = 'shipmentBoardRole' + MODE_KEY_SUFFIX;
const PRINT_HELPER_BASE = 'http://127.0.0.1:8790';
let deliveryPlan = null;
let boardRole = 'user';            // user=普通，admin=管理（可看金额）
let boardCanSeeAmount = false;
let billedShipmentIds = new Set();
let billedExtraIds = new Set();

function boardModeName(mode = BOARD_MODE) {
  return mode === 'admin' ? '管理员模式' : mode === 'user' ? '普通模式' : '通用模式';
}

function canUseRole(role) {
  return !BOARD_MODE || role === BOARD_MODE;
}

async function loadBoardRole() {
  // 角色始终和访问码绑定。管理员网址、普通网址各用自己的缓存，互不覆盖。
  let cachedRole = '';
  let cachedCode = '';
  try {
    const raw = String(localStorage.getItem(ROLE_STORAGE_KEY) || '');
    const parts = raw.split('|');
    cachedRole = parts[0] || '';
    cachedCode = parts.slice(1).join('|') || '';
    if ((cachedRole === 'admin' || cachedRole === 'user') && canUseRole(cachedRole) && cachedCode === getAccessCode()) {
      boardRole = cachedRole;
      boardCanSeeAmount = cachedRole === 'admin';
    }
  } catch { }

  const code = getAccessCode();
  if (!RPC_BASE || !code) {
    if (!code) {
      boardRole = 'user';
      boardCanSeeAmount = false;
    }
    applyRoleUI();
    return;
  }

  try {
    const r = await callRpc('board_whoami', { p_code: code });
    const role = String((r.data && r.data.role) || '');
    if (r.response.ok && (role === 'admin' || role === 'user')) {
      if (!canUseRole(role)) {
        boardRole = 'user';
        boardCanSeeAmount = false;
        try {
          localStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
          localStorage.removeItem(ROLE_STORAGE_KEY);
        } catch { }
        setTimeout(() => showToast(BOARD_MODE === 'admin' ? '这个管理员网址需要管理员访问码' : '这个普通网址需要普通访问码', 4500), 0);
      } else {
        boardRole = role;
        boardCanSeeAmount = Boolean(r.data.canSeeAmount);
        try { localStorage.setItem(ROLE_STORAGE_KEY, role + '|' + code); } catch { }
      }
    } else if (cachedCode !== code) {
      boardRole = 'user';
      boardCanSeeAmount = false;
    }
  } catch {
    // 保留同一访问码下已经验证过的角色，不让短时网络抖动把管理员切回普通。
  }
  applyRoleUI();
}

function getAccessCode() {
  const url = new URL(location.href);
  const queryCode = url.searchParams.get('code');
  if (queryCode) {
    const normalized = queryCode.trim();
    try { localStorage.setItem(ACCESS_CODE_STORAGE_KEY, normalized); } catch { }
    url.searchParams.delete('code');
    history.replaceState(null, '', url);
    return normalized;
  }
  try { return localStorage.getItem(ACCESS_CODE_STORAGE_KEY) || ''; } catch { return ''; }
}

function askAccessCode() {
  const label = BOARD_MODE === 'admin' ? '管理员访问码' : BOARD_MODE === 'user' ? '普通访问码' : '发货看板访问码';
  const entered = prompt('请输入' + label);
  if (!entered) return '';
  const trimmed = entered.trim();
  try { localStorage.setItem(ACCESS_CODE_STORAGE_KEY, trimmed); } catch { }
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
    localStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
    const entered = askAccessCode();
    if (entered) return requestWithAccessCode(url, options, false);
  }
  return response;
}


let markMaterials = new Set();

async function loadMarkMaterials() {
  try {
    const response = await fetch(new URL('mark-materials.json', document.baseURI), { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const materials = Array.isArray(payload) ? payload : payload.materials;
    markMaterials = new Set((materials || []).map((value) => String(value || '').trim()).filter(Boolean));
  } catch (error) {
    console.warn('打标料号加载失败', error);
  }
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
let desktopRemainingSearch = '';
const remainingDates = new Set();
let desktopDueFilter = 'all';
let desktopDueDate = '';
let desktopSearch = '';
const desktopPicked = new Set();   // 下拉里勾选多个料号一起看
let mobileSearch = '';
let historyDate = '';
let recordsSearch = '';
let recordsDate = '';
let historyQuery = '';
let queryTab = 'shipments';
let offsetQuery = '';
let offsetDate = '';
let overQuery = '';
let overDate = '';
let cloudFileFormat = 'excel';
let cloudFileCompany = '艾沃意特';   // 云端送货单：再按公司分开   // 云端送货单：pdf / excel 分开看
let filesQuery = '';
let filesDate = '';
let mobileFilesQuery = '';
let mobileFilesDate = '';
const expandedShipments = new Set();
let autoOffsetNote = '';
let cartOpen = false;
const sessionOver = new Map();

// 本次装车里的补发（不良补货）：不扣未交，直接进送货单
const sessionReplacements = [];
let replacementPick = null;

// 手工撤回过的冲抵：这条多送记录不再自动冲抵（本地立刻生效，云端也会记一笔）
const MANUAL_OFFSET_SKIP_KEY = 'shipmentManualOffsetSkip';
const manualOffsetSkip = new Set((() => {
  try { return JSON.parse(localStorage.getItem(MANUAL_OFFSET_SKIP_KEY) || '[]'); } catch { return []; }
})());

function writeManualOffsetSkip() {
  try { localStorage.setItem(MANUAL_OFFSET_SKIP_KEY, JSON.stringify([...manualOffsetSkip])); } catch {}
}

function replacementTotalQty() {
  return sessionReplacements.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
}

// 搜索用：把所有出现过的物料都列出来（包括已交清、未交为 0 的，补发常用到）
function replacementProducts(queryText) {
  const query = String(queryText || '').trim().toLowerCase();
  const map = new Map();
  for (const order of (snapshot?.orders || [])) {
    const key = [String(order.material || '').trim(), String(order.spec || '').trim()].join('|');
    if (!map.has(key)) {
      map.set(key, { material: order.material, name: order.name, spec: order.spec, customer: order.customer });
    }
  }
  const rows = [...map.values()];
  if (!query) return rows.slice(0, 12);
  return rows.filter((row) => [row.material, row.name, row.spec].join(' ').toLowerCase().includes(query)).slice(0, 20);
}

function renderReplacementSuggest() {
  if (!els.replacementSuggest || !els.replacementSearch) return;
  const rows = replacementProducts(els.replacementSearch.value);
  if (!rows.length) { els.replacementSuggest.hidden = true; els.replacementSuggest.innerHTML = ''; return; }
  els.replacementSuggest.innerHTML = rows.map((row) => `<button type="button" class="suggest-item" data-replacement-pick="${escapeHtml([row.material, row.name, row.spec, row.customer].join('|'))}">
      <strong>${escapeHtml(row.material)}</strong>
      <span>${escapeHtml(row.name || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</span>
    </button>`).join('');
  els.replacementSuggest.hidden = false;
}

function renderReplacementPicked() {
  if (!els.replacementPicked) return;
  if (!replacementPick) { els.replacementPicked.hidden = true; els.replacementPicked.innerHTML = ''; return; }
  els.replacementPicked.hidden = false;
  els.replacementPicked.innerHTML = `已选：<b>${escapeHtml(replacementPick.material)}</b> ${escapeHtml(replacementPick.name || '')}`
    + `${replacementPick.spec ? ' · ' + escapeHtml(replacementPick.spec) : ''}`
    + `${replacementPick.customer ? `（${escapeHtml(replacementPick.customer)}）` : ''}`;
}

function addReplacement() {
  if (!replacementPick) { showToast('请先搜索并选择要补发的产品'); return; }
  const quantity = Number(els.replacementQty?.value || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) { showToast('请填写补发数量'); return; }
  const remark = String(els.replacementRemark?.value || '').trim();
  sessionReplacements.push({
    material: replacementPick.material,
    name: replacementPick.name || '',
    spec: replacementPick.spec || '',
    customer: replacementPick.customer || '',
    quantity,
    remark,
  });
  replacementPick = null;
  if (els.replacementQty) els.replacementQty.value = '';
  if (els.replacementRemark) els.replacementRemark.value = '';
  if (els.replacementSearch) els.replacementSearch.value = '';
  renderReplacementPicked();
  renderMobileSummary();
  renderCart();
  showToast(`已加入补发：${quantity} 件${remark ? '（备注：' + remark + '）' : ''}`);
}

function offsetSkipped(over) {
  if (!over) return false;
  if (over.autoOffset === false) return true;
  return manualOffsetSkip.has(String(over.id));
}

async function markAutoOffset(overId, enabled) {
  if (!overId) return;
  if (enabled) manualOffsetSkip.delete(String(overId));
  else manualOffsetSkip.add(String(overId));
  writeManualOffsetSkip();
  try {
    await callRpc('board_set_auto_offset', { p_code: getAccessCode(), p_over_id: overId, p_enabled: enabled });
  } catch { /* 云端脚本还没跑时忽略，本地仍然生效 */ }
}
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
  offsetHistory: $('#offsetHistory'),
  overHistory: $('#overHistory'),
  replacementHistory: $('#replacementHistory'),
  recordsReplacementList: $('#recordsReplacementList'),
  queryTitle: $('#queryTitle'),
  offsetSearch: $('#offsetSearch'),
  offsetDate: $('#offsetDate'),
  offsetClear: $('#offsetClear'),
  overSearch: $('#overSearch'),
  overDate: $('#overDate'),
  overClear: $('#overClear'),
  recordsOffsetSearch: $('#recordsOffsetSearch'),
  recordsOffsetDate: $('#recordsOffsetDate'),
  recordsOffsetClear: $('#recordsOffsetClear'),
  recordsOverSearch: $('#recordsOverSearch'),
  recordsOverDate: $('#recordsOverDate'),
  recordsOverClear: $('#recordsOverClear'),
  desktopFilesView: $('#desktopFilesView'),
  cloudFileList: $('#cloudFileList'),
  filesSummary: $('#filesSummary'),
  filesSearch: $('#filesSearch'),
  filesDate: $('#filesDate'),
  filesClear: $('#filesClear'),
  mobileFilesPanel: $('#mobileFilesPanel'),
  mobileCloudFileList: $('#mobileCloudFileList'),
  mobileFilesSearch: $('#mobileFilesSearch'),
  mobileFilesDate: $('#mobileFilesDate'),
  mobileFilesClear: $('#mobileFilesClear'),
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
  replacementOpen: $('#replacementOpen'),
  replacementBox: $('#replacementBox'),
  replacementClose: $('#replacementClose'),
  replacementSearch: $('#replacementSearch'),
  replacementSuggest: $('#replacementSuggest'),
  replacementPicked: $('#replacementPicked'),
  replacementQty: $('#replacementQty'),
  replacementRemark: $('#replacementRemark'),
  replacementAdd: $('#replacementAdd'),
  mobileOffsetBox: $('#mobileOffsetBox'),
  mobileEmpty: $('#mobileEmpty'),
  mobileEntryPanel: $('#mobileEntryPanel'),
  mobileRemainingPanel: $('#mobileRemainingPanel'),
  remainingSearch: $('#remainingSearch'),
  remainingDateChips: $('#remainingDateChips'),
  remainingDateClear: $('#remainingDateClear'),
  remainingPrint: $('#remainingPrint'),
  remainingExport: $('#remainingExport'),
  remainingList: $('#remainingList'),
  desktopRemainingSearch: $('#desktopRemainingSearch'),
  desktopRemainingDateChips: $('#desktopRemainingDateChips'),
  desktopRemainingDateClear: $('#desktopRemainingDateClear'),
  desktopRemainingPrint: $('#desktopRemainingPrint'),
  desktopRemainingExport: $('#desktopRemainingExport'),
  desktopRemainingSummary: $('#desktopRemainingSummary'),
  desktopRemainingBody: $('#desktopRemainingBody'),
  desktopRemainingEmpty: $('#desktopRemainingEmpty'),
  mobileRecordsPanel: $('#mobileRecordsPanel'),
  recordsSearch: $('#recordsSearch'),
  recordsDate: $('#recordsDate'),
  recordsClear: $('#recordsClear'),
  recordsList: $('#recordsList'),
  recordsOffsetList: $('#recordsOffsetList'),
  recordsOverList: $('#recordsOverList'),
  mobileCartBar: $('#mobileCartBar'),
  mobileCartSummary: $('#mobileCartSummary'),
  cartDetail: $('#cartDetail'),
  cartQty: $('#cartQty'),
  cartItems: $('#cartItems'),
  submitModal: $('#submitModal'),
  submitSummary: $('#submitSummary'),
  submitError: $('#submitError'),
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
  brandTitle: $('#brandTitle'),
  mobileBrandTitle: $('#mobileBrandTitle'),
  switchCodeButton: $('#switchCodeButton'),
  mobileSwitchCode: $('#mobileSwitchCode'),
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
    if (desktopPicked.size) {
    const picks = [...desktopPicked].map((v) => String(v).toLowerCase());
    rows = rows.filter((order) => picks.some((pick) => searchable(order).includes(pick)));
  }
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
    // 并行拉取，避免一个个排队等（页面卡顿的主因）
    const [amounts, overDeliveries, overOffsets, deliveryFiles, replacements] = await Promise.all([
      boardRole === 'admin' ? loadAmounts() : Promise.resolve([]),
      loadOverDeliveries(),
      loadOverOffsets(),
      loadDeliveryFiles(),
      loadReplacements(),
      loadBilledStatus(),
    ]);
    nextSnapshot.amounts = amounts;
    nextSnapshot.overDeliveries = overDeliveries;
    nextSnapshot.overOffsets = overOffsets;
    nextSnapshot.deliveryFiles = deliveryFiles;
    nextSnapshot.replacements = replacements;
    const changed = !snapshot || nextSnapshot.revision !== snapshot.revision;
    snapshot = nextSnapshot;
    rebuildAmountMap();
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
// pdf.js 抽出来的中文常带多余空格，这里统一收紧（只用于名称/图号）
const tidyText = (v) => String(v || '')
  .replace(/\s*([()])\s*/g, '$1')
  .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
  .replace(/\s{2,}/g, ' ')
  .trim();

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
  // pdf.js 常把“采购单号 : PN01-…”抽成冒号前带空格，先统一成紧贴冒号再识别
  const flat = text.replace(/[ \t]*([:：])[ \t]*/g, '$1').replace(/[ \t]+/g, ' ');
  const doc = { file: file.name, po: null, purchaseDate: null, vendor: null, pdfTotal: null, items: [], error: '', warnings: [], poFromFile: false };
  let m = flat.match(/采购单号[:：]\s*(\S+)/); doc.po = m ? m[1].trim() : null;
  if (!doc.po) {
    // 读不到表头单号时，用文件名兜底（采购订单 PDF 的文件名就是单号）
    const fromName = String(file.name || '').match(/PN0?\d{1,2}-?\d{5,}/i);
    if (fromName) { doc.po = fromName[0].replace(/[()（）]/g, ''); doc.poFromFile = true; }
  }
  m = flat.match(/采购日期[:：]\s*(\S+)/); doc.purchaseDate = pdfIso(m ? m[1] : null);
  m = flat.match(/供应厂商[:：]\s*(\S+)/); doc.vendor = m ? m[1].trim() : null;
  if (!doc.vendor) {
    const vendorLine = flat.match(/(无锡市帆顺金属[^\s]*)/);
    if (vendorLine) doc.vendor = vendorLine[1];
  }
  m = flat.match(/含税金额总和[:：]\s*([\d,]+(?:\.\d+)?)/); doc.pdfTotal = m ? pdfNum(m[1]) : null;
  const isLikelyContinuation = (line) => {
    const text = tidyText(line);
    if (!text) return false;
    if (/采购单号|采购日期|供货厂商|公司地址|公司电话|单据时间|页码|合计|备注/.test(text)) return false;
    if (/^[1-6]\.\s*/.test(text)) return false;
    if (/\d+\s*Hrs/i.test(text)) return false;
    return true;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const item = lines[i].match(PDF_ITEM_RE);
    if (!item) continue;
    const row = { seq: Number(item[1]), material: item[2], dueDate: pdfIso(item[3]), quantity: pdfNum(item[4]), netAmount: pdfNum(item[7]), name: '', spec: '', grossAmount: null, unitPrice: null, grossUnitPrice: null };
    let named = null;
    let namedIndex = -1;
    // 明细第二行可能被分页到下一页顶部，不能只看固定下一行。
    for (let j = i + 1; j < lines.length && j <= i + 40; j += 1) {
      const candidate = lines[j] || '';
      if (PDF_ITEM_RE.test(candidate)) break;
      const maybe = candidate.match(PDF_NAME_RE);
      if (maybe) { named = maybe; namedIndex = j; break; }
    }
    if (named) {
      row.name = tidyText(named[1]);
      row.grossAmount = pdfNum(named[3]);
      row.grossUnitPrice = pdfNum(named[2]);   // 含税单价
      row.unitPrice = row.grossUnitPrice;
      let next = '';
      for (let j = namedIndex + 1; j < lines.length && j <= namedIndex + 25; j += 1) {
        const candidate = lines[j] || '';
        if (PDF_ITEM_RE.test(candidate)) break;
        if (!isLikelyContinuation(candidate)) continue;
        const nextText = tidyText(candidate);
        // 只认“纯编号型”图号，避免把条款或页头当图号。
        const looksLikeSpec = nextText.length > 0 && nextText.length <= 40
          && !/[\u4e00-\u9fa5：。，、；]/.test(nextText)
          && !/\d+\s*Hrs/i.test(nextText);
        if (looksLikeSpec) { next = candidate; row.spec = nextText; break; }
      }
    }
    doc.items.push(row);
  }
  doc.qtyTotal = doc.items.reduce((sum, x) => sum + x.quantity, 0);
  doc.amountTotal = Math.round(doc.items.reduce((sum, x) => sum + (x.grossAmount != null ? x.grossAmount : x.netAmount * 1.13), 0) * 100) / 100;
  if (!doc.items.length) doc.error = '没有识别到明细行';
  return doc;
}

let pendingPdfRows = [];

// 选择 PDF 后：逐个识别 -> 弹出核对窗口
async function handlePdfFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  if (!window.pdfjsLib) {
    showToast('PDF 识别组件没加载成功，请刷新页面（Ctrl+F5）后重试');
    if (els.pdfFileInput) els.pdfFileInput.value = '';
    return;
  }
  showToast(`正在识别 ${files.length} 个采购订单 PDF...`);
  if (els.pdfPreview) {
    els.pdfPreview.innerHTML = '<div class="submit-summary-row"><span>正在识别</span><strong>请稍等…</strong></div>';
    els.pdfModal.hidden = false;
  }
  try {
    const docs = [];
    for (const file of files) docs.push(await parsePdfOrder(file));
    renderPdfPreview(docs);
    const okCount = docs.filter((d) => !d.error && d.items.length).length;
    if (okCount !== docs.length) showToast(`${docs.length} 个文件里只有 ${okCount} 个识别成功，请看核对窗口里的提示`);
  } catch (error) {
    if (els.pdfModal) els.pdfModal.hidden = true;
    showToast(error.message || 'PDF 识别失败');
  } finally {
    if (els.pdfFileInput) els.pdfFileInput.value = '';
  }
}

function closePdfModal() {
  if (els.pdfModal) els.pdfModal.hidden = true;
  if (els.pdfFileInput) els.pdfFileInput.value = '';
  pendingPdfRows = [];
}

function renderPdfPreview(docs) {
  const showAmounts = boardRole === 'admin' && boardCanSeeAmount;
  const existing = new Set(snapshot.orders.map((o) => String(o.po || '').trim()));
  const rows = [];
  const blocks = docs.map((doc) => {
    const problems = [];
    const warnings = [];
    if (doc.poFromFile) warnings.push('采购单号取自文件名，请核对一下');
    if (doc.error) problems.push(doc.error);
    if (!doc.po) problems.push('读不到采购单号');
    if (doc.pdfTotal == null) {
      problems.push('没有读到 PDF 含税金额总和，不能导入');
    } else if (Math.abs(doc.amountTotal - doc.pdfTotal) > 0.02) {
      problems.push(`总金额对不上：明细算出 ${doc.amountTotal}，PDF 合计 ${doc.pdfTotal}`);
    }
    const missingAmountCount = doc.items.filter((x) => x.grossAmount == null).length;
    if (missingAmountCount) problems.push(`有 ${missingAmountCount} 行没有读到含税金额，不能导入`);
    const company = /科技/.test(doc.vendor || '') ? '4137' : (/制品厂/.test(doc.vendor || '') ? '4074' : '');
    if (!company) problems.push('认不出公司（供应厂商）');
    const duplicated = Boolean(doc.po) && existing.has(doc.po);
    const priceNotes = [];
    if (!problems.length && !duplicated) {
      for (const item of doc.items) {
        const id = `${doc.po}#${String(item.seq).padStart(3, '0')}`;
        // 单价变动提醒：和系统里已有的同明细单价对比
        const old = showAmounts ? amountFor(id) : null;
        if (showAmounts && old && old.unitPrice != null && item.unitPrice != null && Math.abs(Number(old.unitPrice) - Number(item.unitPrice)) > 0.0001) {
          const diff = Number(item.unitPrice) - Number(old.unitPrice);
          const pct = Number(old.unitPrice) ? Math.round((diff / Number(old.unitPrice)) * 1000) / 10 : 0;
          priceNotes.push(`${item.material} 单价 ${old.unitPrice} → ${item.unitPrice}（${diff > 0 ? '+' : ''}${pct}%）`);
        }
        rows.push({ id, customer: company, po: doc.po, purchaseDate: doc.purchaseDate, seq: item.seq, material: item.material, name: item.name, spec: item.spec, orderQty: item.quantity, openingRemaining: item.quantity, dueDate: item.dueDate, unitPrice: item.unitPrice });
      }
    }
    if (priceNotes.length) warnings.push('单价有变动：' + priceNotes.slice(0, 5).join('；') + (priceNotes.length > 5 ? ` 等 ${priceNotes.length} 处` : ''));
    return { doc, problems, warnings, duplicated, company };
  });
  pendingPdfRows = rows;
  const totalQty = rows.reduce((sum, r) => sum + r.openingRemaining, 0);
  const bad = blocks.filter((b) => b.problems.length);
  const html = blocks.map((b) => `
    <div class="pdf-doc${b.problems.length ? ' bad' : b.duplicated ? ' dup' : ''}">
      <div class="pdf-doc-head">
        <strong>${escapeHtml(b.doc.po || b.doc.file)}</strong>
        <span>${b.company ? (b.company === '4137' ? '帆顺金属科技' : '帆顺金属(老)') : '公司未知'} · ${b.doc.items.length} 行 · 数量 ${fmt(b.doc.qtyTotal)}${showAmounts ? ` · 含税金额 ${fmt(b.doc.amountTotal)} · 单价 ${fmt(b.doc.items[0]?.unitPrice)}${b.doc.pdfTotal != null ? ` / PDF ${fmt(b.doc.pdfTotal)}` : ''}` : ''}</span>
      </div>
      ${b.duplicated ? '<div class="pdf-note">系统里已有这个采购单号，将跳过</div>' : ''}
      ${(b.warnings || []).map((w) => `<div class="pdf-note">${escapeHtml(w)}</div>`).join('')}
      ${b.problems.map((p) => `<div class="pdf-note bad">${escapeHtml(p)}</div>`).join('')}
    </div>`).join('');
  els.pdfPreview.innerHTML = `
    <div class="submit-summary-row"><span>识别到</span><strong>${docs.length} 个 PDF</strong></div>
    <div class="submit-summary-row"><span>本次将新增</span><strong>${new Set(rows.map((r) => r.po)).size} 张单 · ${rows.length} 行 · 数量 ${fmt(totalQty)}</strong></div>
    ${bad.length ? `<div class="submit-summary-row"><span>有问题（不会导入）</span><strong class="bad">${bad.length} 个</strong></div>` : ''}
    ${html}`;
  els.confirmPdf.disabled = !rows.length || bad.length > 0;
  els.pdfModal.hidden = false;
  if (bad.length) showToast(`总金额核对未通过：${bad.length} 个 PDF 有问题，已禁止导入`, 7000);
}

async function confirmPdfImport() {
  if (!pendingPdfRows.length) return;
  if (boardRole !== 'admin') {
    showToast('含单价金额的信息请使用管理员模式网址导入');
    return;
  }
  if (!RPC_BASE) {
    showToast('这个页面不是云端版，导入不了新订单。请用云端地址打开看板再导入。');
    return;
  }
  els.confirmPdf.disabled = true;
  try {
    const result = await callRpc('board_add_orders', { p_code: getAccessCode(), p_orders: pendingPdfRows });
    if (!result.response.ok) throw new Error(result.data?.message || '导入失败');
    const count = Number(result.data?.count || pendingPdfRows.length);
    // 把 PDF 里的含税单价写进云端（管理码专属），并刷新订单总额
    if (boardRole === 'admin') {
      let priced = 0;
      for (const row of pendingPdfRows) {
        if (row.unitPrice == null) continue;
        try {
          const r = await callRpc('board_set_order_price', { p_code: getAccessCode(), p_payload: { orderId: row.id, unitPrice: row.unitPrice, source: 'pdf' } });
          if (r.response.ok) priced += 1;
        } catch { }
      }
      try { await callRpc('board_refresh_order_amount', { p_code: getAccessCode() }); } catch { }
      if (priced) showToast(`已写入 ${priced} 条含税单价（来源：采购订单 PDF）`);
    }
    closePdfModal();
    showToast(`已导入 ${count} 行新订单（未交已更新）`);
    await loadState({ quiet: true });
    renderAll();
  } catch (error) {
    showToast(error.message || '导入失败');
    els.confirmPdf.disabled = false;
  }
}

async function loadAmounts() {
  if (!RPC_BASE) return [];
  const code = getAccessCode();
  if (!code) return [];
  try {
    const r = await callRpc('board_get_amounts', { p_code: code });
    if (!r.response.ok) return [];
    return Array.isArray(r.data) ? r.data : [];
  } catch { return []; }
}

let amountMap = new Map();

function currentAssetVersion() {
  try {
    const tag = document.querySelector('script[src*="app.js"]');
    const m = String(tag && tag.src || '').match(/[?&]v=([^&"']+)/);
    return m ? m[1] : '?';
  } catch { return '?'; }
}

function applyRoleUI() {
  const isAdmin = boardRole === 'admin';
  const suffix = isAdmin ? '（管理员）' : '';
  const el = document.getElementById('brandTitle');
  if (el) el.textContent = '帆顺科技' + suffix;
  const el2 = document.getElementById('mobileBrandTitle');
  if (el2) el2.textContent = '手机装车登记' + suffix;
  const stamp = document.getElementById('sourceStamp');
  if (stamp) stamp.dataset.role = boardRole;
  document.title = '帆顺科技' + suffix;
  const badge = document.getElementById('modeBadge');
  if (badge) badge.textContent = isAdmin ? '管理员模式' : '普通模式';
}

function rebuildAmountMap() {
  const rows = (snapshot && Array.isArray(snapshot.amounts)) ? snapshot.amounts : [];
  amountMap = new Map(rows.map((row) => [String(row.orderId), row]));
}

function amountFor(orderId) {
  return amountMap.get(String(orderId)) || null;
}

function isBilledShipment(id) {
  return billedShipmentIds.has(String(id));
}

function isBilledExtra(id) {
  return billedExtraIds.has(String(id));
}

async function loadBilledStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${PRINT_HELPER_BASE}/billed-status`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return;
    const data = await response.json();
    billedShipmentIds = new Set((data.shipments || []).map((value) => String(value)));
    billedExtraIds = new Set((data.extras || []).map((value) => String(value)));
  } catch {
    // 打印助手未运行时不影响看板加载，撤回按钮仍按原逻辑显示。
  } finally {
    clearTimeout(timer);
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

async function loadReplacements() {
  if (!RPC_BASE) return [];
  const accessCode = getAccessCode();
  if (!accessCode) return [];
  try {
    const result = await callRpc('board_get_replacements', { p_code: accessCode, p_limit: 100 });
    if (!result.response.ok) return [];
    return Array.isArray(result.data) ? result.data : [];
  } catch { return []; }
}

function replacements() {
  return (snapshot && Array.isArray(snapshot.replacements)) ? snapshot.replacements : [];
}

function renderReplacementList() {
  const rows = replacements();
  if (!rows.length) return '';
  return `
    <section class="over-box">
      <div class="over-head"><strong>补发记录</strong><span>${rows.length} 笔</span></div>
      ${rows.map((row) => `
        <div class="over-row">
          <span class="mono">${escapeHtml(row.material)}</span>
          <span>${escapeHtml(row.name || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}${row.remark ? ' · 备注：' + escapeHtml(row.remark) : ''}<br><em>${escapeHtml(row.deliveryDate || '')}</em></span>
          <strong>${fmt(row.quantity)} 件</strong>
          ${isLockedRecord(row.createdAt) || isBilledExtra(row.id)
            ? `<span class="row-locked" title="${isBilledExtra(row.id) ? '已开送货单并上传云端，不能撤回' : '登记满 7 天后不能再撤回'}">${isBilledExtra(row.id) ? '已开单' : '已归档'}</span>`
            : `<button type="button" class="row-revoke" data-revoke-replacement="${escapeHtml(row.id)}">撤回</button>`}
        </div>`).join('')}
      <p class="over-tip">补发是给前期交货的不良品补货，不扣未交，会进当天送货单（订单号/项次=无，备注按填写内容）。</p>
    </section>`;
}

async function revokeReplacement(id) {
  const replacementRow = replacements().find((row) => String(row.id) === String(id));
  if (replacementRow && isBilledExtra(id)) { showToast('这笔补发已经开送货单并上传云端，不能撤回'); return; }
  if (replacementRow && isLockedRecord(replacementRow.createdAt)) { showToast('这笔补发已满 7 天，不能再撤回'); return; }
  if (!window.confirm('要把这笔补发撤回吗？撤回后不再出现在送货单里。')) return;
  const result = await callRpc('board_revoke_replacement', { p_code: getAccessCode(), p_id: id });
  if (!result.response.ok) { showToast(result.data?.message || '撤回失败'); return; }
  showToast('已撤回这笔补发');
  await loadState({ quiet: true });
  renderAll();
}

function deliveryFiles() {
  return (snapshot && Array.isArray(snapshot.deliveryFiles)) ? snapshot.deliveryFiles : [];
}

// 云端送货单：独立页面（电脑端一个页面、手机端一个标签），Excel 和 PDF 各一份
function renderCloudFiles() {
  const desktopHtml = renderDeliveryFiles(filesDate, filesQuery);
  if (els.cloudFileList) els.cloudFileList.innerHTML = desktopHtml || '<div class="empty-state"><strong>还没有上传过送货单</strong><span>在打印助手预览页点“确认上传到云端”就会出现在这里。</span></div>';
  if (els.filesSummary) {
    const rows = filterDeliveryFiles(filesDate, filesQuery);
    els.filesSummary.textContent = rows.length ? `共 ${rows.length} 个文件 · 最新上传排在最上面` : '还没有上传过送货单';
  }
  const mobileHtml = renderDeliveryFiles(mobileFilesDate, mobileFilesQuery);
  if (els.mobileCloudFileList) els.mobileCloudFileList.innerHTML = mobileHtml || '<div class="empty-state"><strong>还没有上传过送货单</strong><span>在打印助手预览页点“确认上传到云端”就会出现在这里。</span></div>';
}

function filterDeliveryFiles(dateFilter, queryText) {
  const query = String(queryText || '').trim().toLowerCase();
  return deliveryFiles().filter((row) => {
    if (dateFilter && String(row.deliveryDate || '') !== String(dateFilter)) return false;
    if (!query) return true;
    return [row.deliveryDate, row.batch, row.fileName, row.kind].join(' ').toLowerCase().includes(query);
  });
}

function renderDeliveryFiles(dateFilter, queryText) {
  const wantPdf = cloudFileFormat === 'pdf';
  const rows = filterDeliveryFiles(dateFilter, queryText).filter((row) => {
    const isPdf = /\.pdf$/i.test(String(row.fileName || ''));
    if (wantPdf !== isPdf) return false;
    const kind = String(row.kind || '');
    return cloudFileCompany === '邦凡' ? kind === '邦凡' : kind !== '邦凡';
  });
  if (!rows.length && !dateFilter && !String(queryText || '').trim()) return '';
  return `
    <section class="file-box">
      <div class="over-head"><strong>已上传的送货单</strong><span>${rows.length} 个文件</span></div>
      <div class="file-format-tabs">
        <button class="chip${wantPdf ? '' : ' active'}" data-cloud-format="excel" type="button">EXCEL（下载打印送货单）</button>
        <button class="chip${wantPdf ? ' active' : ''}" data-cloud-format="pdf" type="button">PDF（云端归档）</button>
      </div>
      <div class="file-format-tabs file-company-tabs">
        <button class="chip${cloudFileCompany === '艾沃意特' ? ' active' : ''}" data-cloud-company="艾沃意特" type="button">艾沃意特</button>
        <button class="chip${cloudFileCompany === '邦凡' ? ' active' : ''}" data-cloud-company="邦凡" type="button">邦凡</button>
      </div>
      ${rows.length ? rows.map((row) => `
        <div class="over-row file-row">
          <span>${escapeHtml(row.fileName)}${row.kind ? ` · ${escapeHtml(row.kind)}` : ''}${row.noteCount ? ` · ${fmt(row.noteCount)} 张` : ''}</span>
          <button type="button" class="file-download" data-file-id="${escapeHtml(row.id)}">下载 ${String(row.fileName || '').toLowerCase().endsWith('.pdf') ? 'PDF' : 'Excel'}</button>
          ${/\.pdf$/i.test(String(row.fileName || ''))
            ? ''   // PDF 不提供单独撤回，删同批次的 Excel 时会一起删掉
            : (isLockedRecord(row.createdAt)
              ? '<span class="row-locked" title="上传满 7 天后不能再撤回">已归档</span>'
              : `<button type="button" class="row-revoke" data-file-delete="${escapeHtml(row.id)}" title="撤回这份 Excel（同批次的 PDF 会一起撤回）">撤回</button>`)}
        </div>`).join('')
        : '<p class="over-tip">这几天还没有上传送货单，或换个日期/搜索词再找。</p>'}
    </section>`;
}

async function deleteDeliveryFile(id, button) {
  const row = deliveryFiles().find((item) => String(item.id) === String(id));
  const name = row ? row.fileName : '这份文件';
  const isPdf = /\.pdf$/i.test(name);
  const mates = isPdf ? [] : deliveryFiles().filter((item) => String(item.deliveryDate) === String(row?.deliveryDate)
    && String(item.batch) === String(row?.batch) && /\.pdf$/i.test(String(item.fileName || '')));
  const mateText = mates.length ? `\n同批次的 PDF（${mates.map((m) => m.fileName).join('、')}）也会一起撤回。` : '';
  if (!window.confirm(`要把云端送货单「${name}」撤回吗？${mateText}\n撤回后可以重新生成再上传。`)) return;
  if (row && isLockedRecord(row.createdAt)) {
    showToast('这份送货单上传已满 7 天，不能再撤回');
    return;
  }
  if (button) { button.disabled = true; button.textContent = '撤回中...'; }
  try {
    const result = await callRpc('board_delete_delivery_file', { p_code: getAccessCode(), p_id: id });
    if (!result.response.ok) throw new Error(result.data?.message || '撤回失败');
    for (const mate of mates) {
      try { await callRpc('board_delete_delivery_file', { p_code: getAccessCode(), p_id: mate.id }); } catch {}
    }
    showToast(`已撤回 ${name}${mates.length ? `（连同 ${mates.length} 个 PDF）` : ''}，可以重新上传`);
    await loadState({ quiet: true });
    renderAll();
  } catch (error) {
    showToast(error.message || '撤回失败');
    if (button) { button.disabled = false; button.textContent = '撤回'; }
  }
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
    const isPdf = String(data.fileName || row?.fileName || '').toLowerCase().endsWith('.pdf');
    const blob = new Blob([bytes], {
      type: isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
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
// 发货记录：满 7 天后自动归档（同一天合并、不能再撤回）
const REVOKE_WINDOW_DAYS = 7;

function daysSince(value) {
  const day = shipShanghaiDate(value);
  if (!day) return 0;
  const then = new Date(`${day}T00:00:00+08:00`).getTime();
  return Math.floor((Date.now() - then) / 86400000);
}

function isLockedRecord(value) {
  return daysSince(value) >= REVOKE_WINDOW_DAYS;
}

function lockDaysText(value) {
  const left = REVOKE_WINDOW_DAYS - daysSince(value);
  if (left <= 0) return '已归档';
  return `${left} 天后归档`;
}

// 记录日期（按上海时区取 YYYY-MM-DD）
function recordDay(value) {
  if (!value) return '';
  return shipShanghaiDate(value);
}

function overFilteredRows() {
  const q = overQuery.trim().toLowerCase();
  return overDeliveries().filter((row) => {
    if (overDate && recordDay(row.createdAt) !== overDate) return false;
    if (!q) return true;
    return [row.material, row.name, row.spec, row.customer].join(' ').toLowerCase().includes(q);
  });
}

function offsetFilteredRows() {
  const q = offsetQuery.trim().toLowerCase();
  return overOffsets().filter((row) => {
    if (offsetDate && recordDay(row.appliedAt) !== offsetDate) return false;
    if (!q) return true;
    return [row.material, row.name, row.spec, row.orderId, row.customer].join(' ').toLowerCase().includes(q);
  });
}

function renderOverDeliveryList() {
  const rows = overFilteredRows();
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
          ${isLockedRecord(row.createdAt) || isBilledExtra(row.id)
            ? `<span class="row-locked" title="${isBilledExtra(row.id) ? '已开送货单并上传云端，不能撤回' : '登记满 7 天后不能再撤回'}">${isBilledExtra(row.id) ? '已开单' : '已归档'}</span>`
            : `<button type="button" class="row-revoke" data-revoke-over="${escapeHtml(row.id)}">撤回</button>`}
        </div>`).join('')}
      <p class="over-tip">这些货已经发出但没有对应采购单；点“撤回”可以撤销这笔登记，等出现同料号的新订单时导入新订单会提示你冲抵。</p>
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
  const list = offsetCandidates().filter((item) => isBangfanName(item.over.name) && !offsetSkipped(item.over));
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
  const rows = offsetFilteredRows().slice(0, 60);
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
          ${isLockedRecord(row.appliedAt) || isBilledExtra(row.id)
            ? `<span class="row-locked" title="${isBilledExtra(row.id) ? '已开送货单并上传云端，不能撤回' : '冲抵满 7 天后不能再撤回'}">${isBilledExtra(row.id) ? '已开单' : '已归档'}</span>`
            : `<button type="button" class="row-revoke" data-revoke-offset="${escapeHtml(row.id)}">撤回</button>`}
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
  const pages = {
    overview: document.getElementById('desktopView'),
    remaining: document.getElementById('desktopRemainingView'),
    shipments: document.getElementById('desktopShipmentsView'),
    files: document.getElementById('desktopFilesView'),
  };
  if (!pages.overview || !pages.shipments) return;
  const target = pages[name] ? name : 'overview';
  for (const [key, section] of Object.entries(pages)) {
    if (section) section.hidden = key !== target;
  }
  document.querySelectorAll('[data-desktop-view]').forEach((link) => {
    link.classList.toggle('active', link.dataset.desktopView === target);
  });
  if (target === 'remaining') renderDesktopRemaining();
  if (target === 'shipments') renderDesktopHistory();
  if (target === 'files') renderCloudFiles();
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
  refreshRemainingViews();
  renderMobileRecords();
  renderCloudFiles();
  renderCart();
  els.sourceTitle.textContent = snapshot.storage?.label || '现有计划表导入';
  const roleTag = boardRole === 'admin' ? '管理码（可看金额）' : '普通码';
  applyRoleUI();
  if (els.sourceStamp) els.sourceStamp.dataset.role = boardRole;
  if (els.liveText && els.liveText.dataset) els.liveText.title = roleTag;
  els.sourceStamp.textContent = snapshot.storage?.cloud
    ? `${snapshot.source.sheet} · 实时同步`
    : `生成于 ${snapshot.source.generatedAt}`;
  els.resetButton.hidden = Boolean(snapshot.storage?.cloud);
  if (els.importButton) els.importButton.hidden = !RPC_BASE;
  if (els.pdfImportButton) els.pdfImportButton.hidden = !RPC_BASE || boardRole !== 'admin';
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
  if (table) {
    // 固定表格宽度 = 各列宽度之和，这样拖动列宽才会真的动（而不是被 100% 宽度摊回去）
    const width = Math.max(760, total);
    table.style.width = `${width}px`;
    table.style.minWidth = `${width}px`;
  }
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
        <td><span class="order-id">${escapeHtml(order.po)}</span><span class="company-tag" title="${escapeHtml(companyName(orderCompany(order)))}">${escapeHtml(orderCompany(order) || '—')}</span>${(() => { const am = amountFor(order.id); return boardRole === 'admin' && am && am.orderAmount != null ? `<span class="amount-line">单总 ${fmt(am.orderAmount)}</span>` : ''; })()}</td>
        <td><span class="material-code mono">${escapeHtml(order.material)}</span>${(() => { const info = materialSummary(order); return info.count > 1 ? `<span class="material-total-tag" title="同一物料编号所有采购单合计未交">共${fmt(info.total)}/${info.count}单</span>` : ''; })()}</td>
        <td><span class="item-name">${escapeHtml(order.name)}</span></td>
        <td><span class="spec-code mono">${escapeHtml(order.spec || '—')}</span></td>
        <td class="number">${escapeHtml(order.seq)}</td>
        <td><span class="due-date">${escapeHtml(formatDate(order.dueDate))}</span><span class="due-badge ${badge.className}">${escapeHtml(dueStatus(order).text)}</span></td>
        <td class="number"><span class="remaining-number">${fmt(order.remaining)}</span>${(() => { const am = amountFor(order.id); return boardRole === 'admin' && am && am.unitPrice != null ? `<span class="amount-line">单价 ${am.unitPrice} · 金额 ${fmt(am.amount)}</span>` : ''; })()}</td>
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
    // 没填车牌/录入人时，显示 FS-发货日期（例如 FS-260924）
    const dayKey = shipShanghaiDate(shipment.createdAt).slice(2).replace(/-/g, '');
    const fallbackLabel = dayKey ? `FS-${dayKey}` : 'FS';
    const label = (value) => {
      const text = String(value || '').trim();
      return (!text || text === '未填写' || text === '-') ? fallbackLabel : text;
    };
    const vehicleLabel = label(shipment.vehicle);
    return `
    <article class="history-card">
      <div class="history-head">
        <strong>${escapeHtml(vehicleLabel)}</strong>
        <span>${escapeHtml(stamp)}</span>
      </div>
      <div class="history-lines">
        ${shown.map((line) => `<div class="history-line"><span>${escapeHtml(line.material)} ${escapeHtml(line.name)}</span><strong>${fmt(line.quantity)} 件</strong></div>`).join('')}
      </div>
      ${items.length > 5 ? `<button class="history-expand" type="button" data-expand="${escapeHtml(shipment.id)}">${expanded ? '收起明细' : `展开全部 ${items.length} 项（还有 ${hidden} 项）`}</button>` : ''}
      <div class="history-foot">
        <span class="history-total">合计 ${fmt(shipment.totalQuantity)} 件 · ${items.length} 项</span>
        ${isBilledShipment(shipment.id)
          ? '<span class="row-locked" title="已开送货单并上传云端，不能撤回">已开单</span>'
          : `<button class="row-revoke" type="button" data-undo="${escapeHtml(shipment.id)}" title="撤销这笔发货">撤回</button>`}
      </div>
    </article>`;
  }).join('');
}

// 查询页三个子项：发货记录 / 冲抵记录 / 无订单发货记录
const QUERY_TABS = ['shipments', 'offsets', 'overs', 'replacements'];
const QUERY_TITLES = { shipments: '发货记录', offsets: '冲抵记录', overs: '无订单发货记录', replacements: '补发记录' };

function applyQueryTab() {
  for (const tab of QUERY_TABS) {
    const on = tab === queryTab;
    document.querySelectorAll(`[data-query-tab="${tab}"]`).forEach((button) => button.classList.toggle('active', on));
    document.querySelectorAll(`[data-query-pane="${tab}"]`).forEach((pane) => { pane.hidden = !on; });
  }
  if (els.queryTitle) els.queryTitle.textContent = QUERY_TITLES[queryTab] || '发货记录';
}

document.querySelectorAll('[data-query-tab]').forEach((button) => {
  button.addEventListener('click', () => { queryTab = button.dataset.queryTab; applyQueryTab(); });
});

function syncQueryInputs() {
  const set = (el, value) => { if (el && el.value !== value) el.value = value; };
  set(els.offsetSearch, offsetQuery); set(els.offsetDate, offsetDate);
  set(els.recordsOffsetSearch, offsetQuery); set(els.recordsOffsetDate, offsetDate);
  set(els.overSearch, overQuery); set(els.overDate, overDate);
  set(els.recordsOverSearch, overQuery); set(els.recordsOverDate, overDate);
}

function renderQueryPanes(containerShipments, containerOffsets, containerOvers, shipmentsHtml, containerReplacements) {
  if (containerShipments) containerShipments.innerHTML = shipmentsHtml;
  const offsetFiltering = Boolean(offsetDate) || Boolean(offsetQuery.trim());
  const overFiltering = Boolean(overDate) || Boolean(overQuery.trim());
  if (containerOffsets) {
    containerOffsets.innerHTML = renderOverOffsetList()
      || (offsetFiltering
        ? '<div class="empty-state"><strong>没有符合条件的冲抵记录</strong><span>换个搜索词或清空日期再试。</span></div>'
        : '<div class="empty-state"><strong>还没有冲抵记录</strong><span>前期多送的货被新订单冲抵后，会显示在这里，可以逐笔撤回。</span></div>');
  }
  if (containerOvers) {
    containerOvers.innerHTML = renderOverDeliveryList()
      || (overFiltering
        ? '<div class="empty-state"><strong>没有符合条件的无订单发货</strong><span>换个搜索词或清空日期再试。</span></div>'
        : '<div class="empty-state"><strong>目前没有无订单发货</strong><span>装车时超出所有未交订单的部分，会自动记在这里。</span></div>');
  }
  if (containerReplacements) {
    containerReplacements.innerHTML = renderReplacementList()
      || '<div class="empty-state"><strong>还没有补发记录</strong><span>装车时用“补发（不良补货）”登记，就会出现在这里。</span></div>';
  }
  syncQueryInputs();
  applyQueryTab();
}

// 满 7 天的发货记录：同一天合并成一张卡（不能再撤回）
function renderMergedDayCards(rows) {
  if (!rows.length) return '';
  return rows.map((row) => `
    <article class="history-card archived-card">
      <div class="history-head">
        <strong>${escapeHtml(row.day)}</strong>
        <span>${row.count} 笔 · 合计 ${fmt(row.total)} 件</span>
      </div>
      <div class="history-lines">
        ${[...row.items.entries()].map(([key, quantity]) => {
          const [material, name, spec] = key.split('|');
          return `<div class="history-line"><span>${escapeHtml(material)} ${escapeHtml(name)}${spec ? ' · ' + escapeHtml(spec) : ''}</span><strong>${fmt(quantity)} 件</strong></div>`;
        }).join('')}
      </div>
      <div class="history-foot">
        <span class="history-total">已合并归档（超过 7 天，不能再撤回）</span>
      </div>
    </article>`).join('');
}

function renderShipmentSection(shipments) {
  const locked = shipments.filter((item) => isLockedRecord(item.createdAt));
  const recent = shipments.filter((item) => !isLockedRecord(item.createdAt));
  const archivedHtml = renderMergedDayCards(mergedShipmentsByDate(locked));
  const recentHtml = recent.length ? renderHistoryCards(recent) : '';
  if (!archivedHtml && !recentHtml) return renderHistoryCards([]);
  return recentHtml + archivedHtml;
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
  renderQueryPanes(els.shipmentHistory, els.offsetHistory, els.overHistory, renderShipmentSection(rows), els.replacementHistory);
  void renderCloudFiles();
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
  const pendingOverRows = [...sessionOver.values()].filter((item) => Number(item.quantity) > 0);
  const pendingOverQty = pendingOverRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const replacementQty = replacementTotalQty();
  els.mobileSelectedQty.textContent = fmt(selectedQty + pendingOverQty + replacementQty);
  els.mobileSelectedItems.textContent = `${selectedItems + pendingOverRows.length + sessionReplacements.length} 项物料`;
  els.mobileRemainingQty.textContent = fmt(snapshot.summary.remainingQuantity);
}

function qtyText(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function selectedRemainingDates() {
  return [...remainingDates].filter(Boolean).sort();
}

function remainingDateOptions() {
  const counts = new Map();
  for (const order of filteredOrders('active')) {
    const dueDate = String(order.dueDate || '').trim();
    if (!dueDate) continue;
    counts.set(dueDate, (counts.get(dueDate) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

function renderRemainingDateChips() {
  const containers = [els.remainingDateChips, els.desktopRemainingDateChips].filter(Boolean);
  if (!containers.length) return;
  const options = remainingDateOptions();
  const activeDates = new Set(options.map(([dueDate]) => dueDate));
  for (const dueDate of [...remainingDates]) {
    if (!activeDates.has(dueDate)) remainingDates.delete(dueDate);
  }
  const allActive = remainingDates.size === 0;
  const html = [
    `<button type="button" class="remaining-date-chip${allActive ? ' active' : ''}" data-remaining-date="" aria-pressed="${allActive}">全部日期</button>`,
    ...options.map(([dueDate, count]) => {
      const active = remainingDates.has(dueDate);
      return `<button type="button" class="remaining-date-chip${active ? ' active' : ''}" data-remaining-date="${escapeHtml(dueDate)}" aria-pressed="${active}">${escapeHtml(formatDate(dueDate))} <b>${fmt(count)}</b></button>`;
    }),
  ].join('');
  for (const container of containers) container.innerHTML = html;
}

function remainingRows(queryText = remainingSearch) {
  let rows = filteredOrders('active');
  const query = String(queryText || '').trim().toLowerCase();
  if (query) rows = rows.filter((order) => searchable(order).includes(query));
  if (remainingDates.size) rows = rows.filter((order) => remainingDates.has(String(order.dueDate || '').trim()));
  return rows;
}

function groupRemainingRows(rows) {
  const groups = new Map();
  for (const order of rows) {
    const material = String(order.material || '').trim();
    const name = String(order.name || '').trim();
    const key = `${material}\u0000${name}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        material,
        name,
        specs: new Set(),
        dates: new Set(),
        companies: new Set(),
        total: 0,
        detailCount: 0,
        mark: markMaterials.has(material),
      };
      groups.set(key, group);
    }
    const spec = String(order.spec || '').trim();
    const dueDate = String(order.dueDate || '').trim();
    const company = String(order.customer || '').trim();
    if (spec) group.specs.add(spec);
    if (dueDate) group.dates.add(dueDate);
    if (company) group.companies.add(company);
    group.total += Number(order.remaining || 0);
    group.detailCount += 1;
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      specs: [...group.specs].sort(),
      dates: [...group.dates].sort(),
      companies: [...group.companies].sort(),
    }))
    .sort((left, right) => {
      const leftDate = left.dates[0] || '9999-12-31';
      const rightDate = right.dates[0] || '9999-12-31';
      return leftDate.localeCompare(rightDate)
        || left.material.localeCompare(right.material)
        || left.name.localeCompare(right.name);
    });
}

function remainingGroups(queryText = remainingSearch) {
  return groupRemainingRows(remainingRows(queryText));
}

function remainingDateText(dates) {
  if (!dates.length) return '未填';
  return formatDate([...dates].sort()[0]);
}

function remainingDatePrintText(dates) {
  if (!dates.length) return '未填';
  const dueDate = [...dates].sort()[0];
  const match = String(dueDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1].slice(2)}/${match[2]}/${match[3]}` : String(dueDate || '');
}

function renderMobileRemaining() {
  if (!els.remainingList) return;
  renderRemainingDateChips();
  const all = remainingRows();
  const groups = groupRemainingRows(all);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const selectedText = selectedRemainingDates().length
    ? selectedRemainingDates().map((dueDate) => formatDate(dueDate)).join('、')
    : '全部交期';
  const rows = groups.slice(0, 150);
  els.remainingList.innerHTML = `
    <div class="remaining-list-summary">
      <div><strong>${fmt(groups.length)} 项物料</strong><span>${fmt(all.length)} 条订单明细 · 合计 ${qtyText(total)} 件</span></div>
      <em>${escapeHtml(selectedText)}</em>
    </div>
    ${rows.map((group) => {
      const companyText = group.companies.length > 1
        ? '两家公司'
        : companyName(group.companies[0] || '');
      return `<article class="mobile-remaining-card">
        <div class="mobile-remaining-row">
          <div class="remaining-cell order-cell">
            <span>编号</span>
            <strong class="mono">${escapeHtml(group.material)}</strong>
            ${group.mark ? '<em class="mark-badge">需打标</em>' : ''}
          </div>
          <div class="remaining-cell detail-cell">
            <div class="detail-line"><span>品名</span><strong>${escapeHtml(group.name)}</strong></div>
            <div class="detail-line"><span>规格</span><strong class="mono">${escapeHtml(group.specs.join('、') || '—')}</strong></div>
          </div>
          <div class="remaining-cell meta-cell">
            <div class="meta-line"><span>未交</span><strong class="quantity-value">${escapeHtml(qtyText(group.total))}</strong></div>
          </div>
          <div class="remaining-cell due-cell">
            <span>交期</span>
            <strong>${escapeHtml(remainingDateText(group.dates))}</strong>
          </div>
        </div>
      </article>`;
    }).join('')}
    ${groups.length > 150 ? `<div class="empty-state mobile-empty"><strong>还有 ${fmt(groups.length - 150)} 项未显示</strong><span>请用搜索或交期筛选缩小范围。</span></div>` : ''}`;
}

function printRemainingList(groups = remainingGroups()) {
  if (!groups.length) {
    showToast('没有可打印的未交数据');
    return;
  }
  const rows = groups.map((group) => `
    <tr>
      <td>${escapeHtml(group.material)}</td>
      <td>${escapeHtml(group.name)}</td>
      <td>${escapeHtml(qtyText(group.total))}</td>
      <td>${escapeHtml(remainingDatePrintText(group.dates))}</td>
      <td>${group.mark ? '✅' : ''}</td>
    </tr>`).join('');
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('浏览器阻止了打印窗口，请允许弹出窗口后重试');
    return;
  }
  printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>未交清单</title>
    <style>
      @page { size: A4 portrait; margin: 0 0 0 20mm; }
      html, body { margin: 0; padding: 0; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      col:nth-child(1) { width: 18.11%; }
      col:nth-child(2) { width: 41.18%; }
      col:nth-child(3) { width: 12.29%; }
      col:nth-child(4) { width: 20.03%; }
      col:nth-child(5) { width: 8.39%; }
      tr { height: 25.05pt; }
      th, td { height: 25.05pt; padding: 0 2px; border: 0.5pt solid #000; color: #000; font: 14pt "微软雅黑", "Microsoft YaHei", sans-serif; text-align: center; vertical-align: middle; white-space: nowrap; overflow: hidden; }
    </style></head><body>
    <table>
      <colgroup><col><col><col><col><col></colgroup>
      <thead><tr><th>物料编号</th><th>名称</th><th>送货数量</th><th>交货日期</th><th>打标</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </body></html>`);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 300);
}

function exportRemainingList(groups = remainingGroups()) {
  if (!groups.length) {
    showToast('没有可导出的未交数据');
    return;
  }
  if (!window.XLSX) {
    showToast('Excel 导出组件尚未加载');
    return;
  }
  const data = [
    ['物料编号', '名称', '送货数量', '交货日期', '打标'],
    ...groups.map((group) => [
      group.material,
      group.name,
      qtyText(group.total),
      remainingDatePrintText(group.dates),
      group.mark ? '✅' : '',
    ]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet['!cols'] = [
    { wch: 18.265625 },
    { wch: 41.53125 },
    { wch: 12.3984375 },
    { wch: 20.19921875 },
    { wch: 8.46484375 },
  ];
  sheet['!rows'] = data.map(() => ({ hpt: 25.05 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '未交清单');
  const suffix = selectedRemainingDates().length ? selectedRemainingDates().join('_') : '全部交期';
  XLSX.writeFile(workbook, `未交清单_${suffix}.xlsx`, { compression: true });
  showToast(`已导出 ${groups.length} 项未交物料`);
}

function renderDesktopRemaining() {
  if (!els.desktopRemainingBody) return;
  renderRemainingDateChips();
  const rows = remainingRows(desktopRemainingSearch);
  const groups = groupRemainingRows(rows);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const selectedText = selectedRemainingDates().length
    ? selectedRemainingDates().map((dueDate) => formatDate(dueDate)).join('、')
    : '全部交期';
  els.desktopRemainingSummary.textContent = `共 ${fmt(groups.length)} 项物料 · ${fmt(rows.length)} 条订单明细 · 合计 ${qtyText(total)} 件 · ${selectedText}`;
  els.desktopRemainingBody.innerHTML = groups.map((group) => `
    <tr>
      <td class="mono">${escapeHtml(group.material)}</td>
      <td>${escapeHtml(group.name)}</td>
      <td class="mono">${escapeHtml(group.specs.join('、'))}</td>
      <td class="number qty">${escapeHtml(qtyText(group.total))}</td>
      <td class="mark">${group.mark ? '✅' : ''}</td>
      <td>${escapeHtml(remainingDateText(group.dates))}</td>
    </tr>`).join('');
  els.desktopRemainingEmpty.hidden = groups.length > 0;
}

function refreshRemainingViews() {
  renderMobileRemaining();
  renderDesktopRemaining();
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
  renderQueryPanes(els.recordsList, els.recordsOffsetList, els.recordsOverList, mergedHtml + renderShipmentSection(rows), els.recordsReplacementList);
  void renderCloudFiles();
  els.recordsList.querySelectorAll('[data-expand]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.expand;
    if (expandedShipments.has(id)) expandedShipments.delete(id);
    else expandedShipments.add(id);
    renderMobileRecords();
    renderDesktopHistory();
  }));
}

async function revokeOffset(offsetId) {
  const offsetRow = overOffsets().find((row) => String(row.id) === String(offsetId));
  if (offsetRow && isBilledExtra(offsetId)) { showToast('这笔冲抵已经开送货单并上传云端，不能撤回'); return; }
  if (offsetRow && isLockedRecord(offsetRow.appliedAt)) {
    showToast('这笔冲抵已满 7 天，不能再撤回');
    return;
  }
  if (!window.confirm('要把这笔冲抵撤回吗？\n撤回后：订单未交会加回去，前期多送记录会恢复。')) return;
  const result = await callRpc('board_revoke_offset', { p_code: getAccessCode(), p_offset_id: offsetId });
  if (!result.response.ok) { showToast(result.data?.message || '撤回失败'); return; }
  // 撤回后不能再被自动冲抵回来：本地 + 云端都标记成“不自动冲抵”
  if (offsetRow && offsetRow.overId) await markAutoOffset(offsetRow.overId, false);
  showToast('已撤回这笔冲抵（该笔不会自动冲抵回来了）');
  await loadState({ quiet: true });
  renderAll();
}

async function revokeOverDelivery(overId) {
  const overRow = overDeliveries().find((row) => String(row.id) === String(overId));
  if (overRow && isBilledExtra(overId)) { showToast('这笔无订单发货已经开送货单并上传云端，不能撤回'); return; }
  if (overRow && isLockedRecord(overRow.createdAt)) {
    showToast('这笔无订单发货已满 7 天，不能再撤回');
    return;
  }
  if (!window.confirm('要把这笔“无订单发货”撤回吗？\n会同时撤销它引起的冲抵，订单未交恢复原样。')) return;
  const result = await callRpc('board_revoke_over_delivery', { p_code: getAccessCode(), p_over_id: overId });
  if (!result.response.ok) { showToast(result.data?.message || '撤回失败'); return; }
  for (const [material, item] of [...sessionOver.entries()]) {
    if (String(item.id) === String(overId)) sessionOver.delete(material);
  }
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
  const replacementLines = sessionReplacements.map((item, index) => `<div class="cart-line replacement">
      <div class="cart-line-info">
        <strong>${escapeHtml(item.material)} ${escapeHtml(item.name || '')}</strong>
        <span>补发 ${escapeHtml(item.spec || '')}${item.remark ? ' · 备注：' + escapeHtml(item.remark) : '（无备注）'}</span>
      </div>
      <strong class="cart-over-qty">${fmt(item.quantity)} 件</strong>
      <button type="button" class="cart-remove" data-cart-replacement="${index}">取消</button>
    </div>`).join('');
  els.cartDetail.innerHTML = `<div class="cart-detail-head"><strong>本次装车明细</strong>`
    + `<span>${entries.length} 项订单${overRows.length ? ` + ${overRows.length} 项无订单发货` : ''}，可直接改数量或取消</span></div>`
    + lines + replacementLines + overLines;
}

function renderCart() {
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  const overRows = [...sessionOver.values()].filter((item) => Number(item.quantity) > 0);
  // 本次装车数量 = 有订单的部分 + 无订单发货的部分
  const quantity = entries.reduce((sum, [, value]) => sum + Number(value), 0)
    + overRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
    + replacementTotalQty();
  els.cartQty.textContent = fmt(quantity);
  els.cartItems.textContent = fmt(entries.length + overRows.length + sessionReplacements.length);
  const overCount = overRows.length + sessionReplacements.length;
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

function showToast(message, duration = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, duration);
}

function showSubmitError(message) {
  if (!els.submitError) return;
  if (!message) { els.submitError.hidden = true; els.submitError.textContent = ''; return; }
  els.submitError.hidden = false;
  els.submitError.textContent = '提交失败：' + message;
}

function openSubmitModal() {
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  if (!entries.length && !sessionReplacements.length) {
    showToast('请先录入至少一项装车数量或补发');
    return;
  }
  showSubmitError('');
  // 打开确认框时顺手同步一次最新未交，减少"别的设备刚发过货"造成的误差
  loadState({ quiet: true }).then(() => renderAll()).catch(() => {});
  const orderTotal = entries.reduce((sum, [, quantity]) => sum + Number(quantity), 0);
  const overRows = [...sessionOver.values()].filter((item) => item.pending && Number(item.quantity) > 0);
  const overTotal = overRows.reduce((sum, item) => sum + Number(item.quantity), 0);
  const replacementQty = replacementTotalQty();
  const total = orderTotal + overTotal + replacementQty;
  els.submitSummary.innerHTML = `
    <div class="submit-summary-row"><span>本次物料</span><strong>${entries.length + overRows.length + sessionReplacements.length} 项</strong></div>
    <div class="submit-summary-row"><span>本次总数量</span><strong>${fmt(total)} 件</strong></div>
    ${replacementQty ? `<div class="submit-summary-row"><span>其中补发</span><strong>${fmt(replacementQty)} 件（${sessionReplacements.length} 项，进送货单）</strong></div>` : ''}
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
  const button = $('#submitShipment');
  button.disabled = true;
  button.textContent = '正在核对未交...';
  let reallocated = false;
  try {
    // ① 先记住本次每个料号打算发多少
    const wantedByMaterial = new Map();
    for (const [orderId, quantity] of selected.entries()) {
      const order = snapshot.orders.find((item) => item.id === orderId);
      if (!order) continue;
      const key = String(order.material || '').trim();
      wantedByMaterial.set(key, (wantedByMaterial.get(key) || 0) + Number(quantity || 0));
    }
    // ② 拉一次最新未交（别的手机/电脑可能刚发过货，避免超发报错）
    await loadState({ quiet: true });
    // ③ 按最新未交重新按交期分配（超出所有未交的部分仍会自动记成无订单发货）
    for (const [material, total] of wantedByMaterial) {
      if (!material || total <= 0) continue;
      const rows = materialOrders(material);
      if (!rows.length) continue;
      const current = rows.reduce((sum, item) => sum + Number(selected.get(item.id) || 0), 0);
      if (current !== total) {
        allocateByDueDate(rows[0], total);
        reallocated = true;
      }
    }
    const items = [...selected.entries()]
      .filter(([, quantity]) => Number(quantity) > 0)
      .map(([orderId, quantity]) => ({ orderId, quantity }));
    const onlyReplacement = !items.length && sessionReplacements.length > 0;
    if (!items.length && !onlyReplacement) throw new Error('本次可发的数量已经变化，请重新确认装车数量');
    const form = new FormData(els.shipmentForm);
    const payload = {
      customer: snapshot.customer,
      operator: String(form.get('operator') || '').trim() || '未填写',
      vehicle: String(form.get('vehicle') || '').trim() || '未填写',
      note: form.get('note'),
      items,
    };
    button.textContent = '正在同步...';
    let shipmentId = '';
    if (!onlyReplacement) {
      const response = await requestWithAccessCode(apiUrl('/api/shipments'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '提交失败');
      shipmentId = result.shipmentId || result.shipment?.id || '本次发货';
    } else {
      shipmentId = '本次补发';
    }
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
    // 补发：逐条登记到云端（进送货单：订单号无、项次无，备注用填写的文字）
    const replacementSaved = [];
    const replacementFailed = [];
    for (const item of [...sessionReplacements]) {
      try {
        const r = await callRpc('board_add_replacement', {
          p_code: getAccessCode(),
          p_payload: {
            date: snapshot.today,
            customer: item.customer,
            material: item.material,
            name: item.name,
            spec: item.spec,
            quantity: Number(item.quantity),
            remark: item.remark,
          },
        });
        if (!r.response.ok) throw new Error(r.data?.message || '补发登记失败');
        replacementSaved.push(`${item.material} ${fmt(item.quantity)} 件`);
        sessionReplacements.splice(sessionReplacements.indexOf(item), 1);
      } catch (error) {
        replacementFailed.push(item.material);
      }
    }
    selected.clear();
    els.shipmentForm.reset();
    closeSubmitModal();
    showSubmitError('');
    showToast(`${shipmentId} 已保存${reallocated ? '（已按最新未交重新分配）' : ''}${overSaved.length ? `，含无订单发货 ${overSaved.join('、')}` : ''}`);
    await loadBoardRole();
applyRoleUI();
await loadState();
applyRoleUI();
    if (replacementSaved.length) showToast(`补发已登记：${replacementSaved.join('、')}`);
    if (replacementFailed.length) showToast(`补发登记失败：${replacementFailed.join('、')}，请重新提交`);
    if (overFailed.length) showToast(`无订单发货登记失败：${overFailed.join('、')}，请在本次装车明细里重新提交`);
  } catch (error) {
    const raw = String(error.message || '提交失败');
    const friendly = /duplicate key/i.test(raw)
      ? '发货单号重复（撤销发货后编号会撞车，需要在云端执行一次修复脚本）'
      : raw;
    showSubmitError(friendly);
    showToast(`${friendly}｜已刷新最新未交，请重新确认数量`, 9000);
    await loadState({ quiet: true });
    renderAll();
  } finally {
    button.disabled = false;
    button.textContent = '保存并同步电脑';
  }
}

async function undoShipment(id) {
  const shipmentRow = snapshot && snapshot.shipments.find((row) => String(row.id) === String(id));
  if (isBilledShipment(id)) { showToast('这笔发货已经开送货单并上传云端，不能撤回'); return; }
  if (shipmentRow && isLockedRecord(shipmentRow.createdAt)) { showToast('这笔发货已满 7 天，不能再撤回'); return; }
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
  if (els.mobileFilesPanel) els.mobileFilesPanel.hidden = tab !== 'files';
  if (tab === 'files') renderCloudFiles();
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

els.desktopSearch.addEventListener('input', (event) => { desktopSearch = event.target.value; desktopPicked.clear(); renderDesktopTable(); renderSuggestFor(els.desktopSearch, els.desktopSuggest, desktopDueRows()); });
els.desktopSearch.addEventListener('focus', () => renderSuggestFor(els.desktopSearch, els.desktopSuggest, desktopDueRows()));
if (els.desktopSuggest) {
  els.desktopSuggest.addEventListener('click', (event) => {
    const button = event.target.closest('[data-suggest]');
    if (!button) return;
    const value = String(button.dataset.suggest || '');
    if (desktopPicked.has(value)) desktopPicked.delete(value); else desktopPicked.add(value);
    button.classList.toggle('active', desktopPicked.has(value));
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
    const replacementRemove = event.target.closest('[data-cart-replacement]');
    if (replacementRemove) {
      const index = Number(replacementRemove.dataset.cartReplacement);
      if (Number.isInteger(index) && index >= 0) sessionReplacements.splice(index, 1);
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
  const overButton = event.target.closest('[data-revoke-over]');
  if (overButton) { revokeOverDelivery(overButton.dataset.revokeOver); return; }
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
    await markAutoOffset(overId, true);
    showToast(`已冲抵 ${fmt(applied)} 件到 ${target.po} 项次${target.seq}`);
    await loadState({ quiet: true });
    renderAll();
  } catch (error) {
    showToast(error.message || '冲抵失败');
    button.disabled = false;
  }
});

if (els.replacementOpen) els.replacementOpen.addEventListener('click', () => {
  if (!els.replacementBox) return;
  els.replacementBox.hidden = !els.replacementBox.hidden;
  if (!els.replacementBox.hidden) {
    renderReplacementSuggest();
    els.replacementSearch?.focus();
  }
});
if (els.replacementClose) els.replacementClose.addEventListener('click', () => {
  if (els.replacementBox) els.replacementBox.hidden = true;
  if (els.replacementSuggest) els.replacementSuggest.hidden = true;
});
if (els.replacementSearch) els.replacementSearch.addEventListener('input', renderReplacementSuggest);
if (els.replacementSearch) els.replacementSearch.addEventListener('focus', renderReplacementSuggest);
if (els.replacementSuggest) els.replacementSuggest.addEventListener('click', (event) => {
  const button = event.target.closest('[data-replacement-pick]');
  if (!button) return;
  const [material, name, spec, customer] = button.dataset.replacementPick.split('|');
  replacementPick = { material, name, spec, customer };
  els.replacementSuggest.hidden = true;
  els.replacementSearch.value = '';
  renderReplacementPicked();
  els.replacementQty?.focus();
});
if (els.replacementAdd) els.replacementAdd.addEventListener('click', addReplacement);

if (els.mobileAllocNotice) els.mobileAllocNotice.addEventListener('click', (event) => {
  const button = event.target.closest('[data-over-cancel]');
  if (!button) return;
  const material = button.dataset.overCancel;
  sessionOver.delete(String(material || '').trim());
  renderCart();
  showAllocationNotice(`已取消 ${material} 的无订单发货，只保留有采购单的数量。`, 'ok');
});

function handleRemainingFilterClick(event) {
  const dateButton = event.target.closest('[data-remaining-date]');
  if (dateButton) {
    const dueDate = String(dateButton.dataset.remainingDate || '').trim();
    if (!dueDate) remainingDates.clear();
    else if (remainingDates.has(dueDate)) remainingDates.delete(dueDate);
    else remainingDates.add(dueDate);
    refreshRemainingViews();
    return;
  }
  if (event.target.id === 'remainingDateClear' || event.target.id === 'desktopRemainingDateClear') {
    remainingDates.clear();
    refreshRemainingViews();
    return;
  }
  if (event.target.id === 'remainingPrint') {
    printRemainingList();
    return;
  }
  if (event.target.id === 'desktopRemainingPrint') {
    printRemainingList(remainingGroups(desktopRemainingSearch));
    return;
  }
  if (event.target.id === 'remainingExport') {
    exportRemainingList();
    return;
  }
  if (event.target.id === 'desktopRemainingExport') {
    exportRemainingList(remainingGroups(desktopRemainingSearch));
  }
}

if (els.mobileRemainingPanel) {
  els.mobileRemainingPanel.addEventListener('input', (event) => {
    if (event.target.id !== 'remainingSearch') return;
    remainingSearch = event.target.value;
    refreshRemainingViews();
  });
  els.mobileRemainingPanel.addEventListener('click', handleRemainingFilterClick);
}

if (els.desktopRemainingSearch) {
  els.desktopRemainingSearch.addEventListener('input', (event) => {
    desktopRemainingSearch = event.target.value;
    renderDesktopRemaining();
  });
}
if (els.desktopRemainingDateChips) els.desktopRemainingDateChips.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingDateClear) els.desktopRemainingDateClear.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingPrint) els.desktopRemainingPrint.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingExport) els.desktopRemainingExport.addEventListener('click', handleRemainingFilterClick);

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

if (els.filesSearch) els.filesSearch.addEventListener('input', (event) => { filesQuery = event.target.value; renderCloudFiles(); });
if (els.filesDate) els.filesDate.addEventListener('change', (event) => { filesDate = event.target.value; renderCloudFiles(); });
if (els.filesClear) els.filesClear.addEventListener('click', () => { filesDate = ''; if (els.filesDate) els.filesDate.value = ''; renderCloudFiles(); });
if (els.mobileFilesSearch) els.mobileFilesSearch.addEventListener('input', (event) => { mobileFilesQuery = event.target.value; renderCloudFiles(); });
if (els.mobileFilesDate) els.mobileFilesDate.addEventListener('change', (event) => { mobileFilesDate = event.target.value; renderCloudFiles(); });
if (els.mobileFilesClear) els.mobileFilesClear.addEventListener('click', () => {
  mobileFilesDate = '';
  if (els.mobileFilesDate) els.mobileFilesDate.value = '';
  renderCloudFiles();
});
function refreshQueryViews() {
  renderDesktopHistory();
  renderMobileRecords();
}

[['offsetSearch', 'offsetQuery'], ['recordsOffsetSearch', 'offsetQuery']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('input', (event) => { offsetQuery = event.target.value; refreshQueryViews(); });
});
[['overSearch', 'overQuery'], ['recordsOverSearch', 'overQuery']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('input', (event) => { overQuery = event.target.value; refreshQueryViews(); });
});
[['offsetDate', 'offsetDate'], ['recordsOffsetDate', 'offsetDate']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('change', (event) => { offsetDate = event.target.value; refreshQueryViews(); });
});
[['overDate', 'overDate'], ['recordsOverDate', 'overDate']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('change', (event) => { overDate = event.target.value; refreshQueryViews(); });
});
[['offsetClear'], ['recordsOffsetClear']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('click', () => { offsetDate = ''; refreshQueryViews(); });
});
[['overClear'], ['recordsOverClear']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('click', () => { overDate = ''; refreshQueryViews(); });
});

if (els.historySearch) els.historySearch.addEventListener('input', (event) => { historyQuery = event.target.value; renderDesktopHistory(); });
if (els.historyDate) els.historyDate.addEventListener('change', (event) => { historyDate = event.target.value; renderDesktopHistory(); });
if (els.historyClear) els.historyClear.addEventListener('click', () => { historyDate = ''; if (els.historyDate) els.historyDate.value = ''; renderDesktopHistory(); });
function handleHistoryClick(event) {
  const fileButton = event.target.closest('[data-file-id]');
  if (fileButton) { downloadDeliveryFile(fileButton.dataset.fileId, fileButton); return; }
  const overButton = event.target.closest('[data-revoke-over]');
  if (overButton) { revokeOverDelivery(overButton.dataset.revokeOver); return; }
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
// 电脑端「冲抵记录 / 无订单发货记录」两个子项的撤回按钮
function handleQueryActionClick(event) {
  const overButton = event.target.closest('[data-revoke-over]');
  if (overButton) { revokeOverDelivery(overButton.dataset.revokeOver); return; }
  const offsetButton = event.target.closest('[data-revoke-offset]');
  if (offsetButton) { revokeOffset(offsetButton.dataset.revokeOffset); return; }
  const replacementButton = event.target.closest('[data-revoke-replacement]');
  if (replacementButton) revokeReplacement(replacementButton.dataset.revokeReplacement);
}
if (els.offsetHistory) els.offsetHistory.addEventListener('click', handleQueryActionClick);
if (els.overHistory) els.overHistory.addEventListener('click', handleQueryActionClick);
if (els.recordsOffsetList) els.recordsOffsetList.addEventListener('click', handleQueryActionClick);
if (els.recordsOverList) els.recordsOverList.addEventListener('click', handleQueryActionClick);
if (els.replacementHistory) els.replacementHistory.addEventListener('click', handleQueryActionClick);
if (els.recordsReplacementList) els.recordsReplacementList.addEventListener('click', handleQueryActionClick);

function handleCloudFileClick(event) {
  const companyButton = event.target.closest('[data-cloud-company]');
  if (companyButton) {
    cloudFileCompany = companyButton.dataset.cloudCompany === '邦凡' ? '邦凡' : '艾沃意特';
    renderCloudFiles();
    return;
  }
  const formatButton = event.target.closest('[data-cloud-format]');
  if (formatButton) {
    cloudFileFormat = formatButton.dataset.cloudFormat === 'excel' ? 'excel' : 'pdf';
    renderCloudFiles();
    return;
  }
  const fileButton = event.target.closest('[data-file-id]');
  if (fileButton) { downloadDeliveryFile(fileButton.dataset.fileId, fileButton); return; }
  const delButton = event.target.closest('[data-file-delete]');
  if (delButton) deleteDeliveryFile(delButton.dataset.fileDelete, delButton);
}
if (els.cloudFileList) els.cloudFileList.addEventListener('click', handleCloudFileClick);
if (els.mobileCloudFileList) els.mobileCloudFileList.addEventListener('click', handleCloudFileClick);
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
async function switchAccessCode() {
  const label = BOARD_MODE === 'admin' ? '管理员访问码' : BOARD_MODE === 'user' ? '普通访问码' : '访问码';
  const entered = prompt('请输入' + label + '：\n管理码 = 管理员模式\n普通码 = 普通模式');
  if (!entered || !entered.trim()) return;
  const code = entered.trim();

  let role = '';
  try {
    const r = await callRpc('board_whoami', { p_code: code });
    if (!r.response.ok) throw new Error(r.data?.message || '访问码验证失败');
    role = String((r.data && r.data.role) || '');
  } catch (error) {
    showToast(error.message || '访问码验证失败，请检查网络后重试', 4000);
    return;
  }

  if (role !== 'admin' && role !== 'user') {
    showToast('这个访问码无效，请重新输入', 4000);
    return;
  }
  if (!canUseRole(role)) {
    showToast(BOARD_MODE === 'admin' ? '这个网址是管理员模式，请输入管理员码' : '这个网址是普通模式，请输入普通码', 4500);
    return;
  }

  try {
    localStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
    localStorage.setItem(ROLE_STORAGE_KEY, role + '|' + code);
  } catch { }
  boardRole = role;
  boardCanSeeAmount = role === 'admin';
  applyRoleUI();
  showToast(role === 'admin' ? '已切换到管理员模式，正在刷新…' : '已切换到普通模式，正在刷新…', 3500);

  setTimeout(() => {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('code');
      url.searchParams.delete('from');
      location.replace(url.toString());
    } catch {
      location.reload();
    }
  }, 900);
}

if (els.switchCodeButton) els.switchCodeButton.addEventListener('click', switchAccessCode);
if (els.mobileSwitchCode) els.mobileSwitchCode.addEventListener('click', switchAccessCode);

$('#mobileRefresh').addEventListener('click', async () => {
  showToast('正在刷新最新数据…');
  try {
    refreshing = false;
    await loadState({ quiet: false });
    renderAll();
    showToast('已刷新（未交/发货记录都是最新的）');
  } catch (error) {
    showToast('刷新失败，请检查网络后重试');
  }
});
$('#resetButton').addEventListener('click', resetRecords);
if (els.importButton && els.importFileInput) {
  els.importButton.addEventListener('click', () => els.importFileInput.click());
}

// 采购订单 PDF 导入
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}
if (els.pdfImportButton && els.pdfFileInput) {
  els.pdfImportButton.addEventListener('click', () => {
    if (boardRole !== 'admin') {
      showToast('含单价金额的信息请使用管理员模式网址导入');
      return;
    }
    els.pdfFileInput.click();
  });
  els.pdfFileInput.addEventListener('change', (event) => handlePdfFiles(event.target.files));
}
if (els.confirmPdf) els.confirmPdf.addEventListener('click', confirmPdfImport);
if (els.cancelPdf) els.cancelPdf.addEventListener('click', closePdfModal);
if (els.closePdfModal) els.closePdfModal.addEventListener('click', closePdfModal);
if (els.importFileInput) els.importFileInput.addEventListener('change', handleImportFile);
if (els.confirmImport) els.confirmImport.addEventListener('click', confirmImportOrders);
if (els.closeImportModal) els.closeImportModal.addEventListener('click', closeImportDialog);
if (els.cancelImport) els.cancelImport.addEventListener('click', closeImportDialog);
els.submitModal.addEventListener('click', (event) => { if (event.target === els.submitModal) closeSubmitModal(); });
els.deliveryModal.addEventListener('click', (event) => { if (event.target === els.deliveryModal) closeDeliveryModal(); });
els.shipmentHistory.addEventListener('click', (event) => {
  const button = event.target.closest('[data-undo]');
  if (button) undoShipment(button.dataset.undo);
  else handleQueryActionClick(event);
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
if (!getAccessCode()) askAccessCode();
await loadBoardRole();
await loadMarkMaterials();
await loadState();
connectEvents();

























