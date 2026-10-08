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
const STATE_CACHE_KEY = 'shipmentBoardStateCache' + MODE_KEY_SUFFIX;
const PRINT_HELPER_BASE = 'http://127.0.0.1:8790';
let deliveryFilesPromise = null;
let auxiliaryPromise = null;
let auxiliaryLoadedAt = 0;
let xlsxPromise = null;

function syncMobileEntryLink() {
  const link = document.getElementById('mobileEntryLink');
  if (!link) return;
  try {
    const url = new URL(link.getAttribute('href'), location.href);
    url.searchParams.set('view', 'mobile');
    url.searchParams.set('mode', BOARD_MODE || 'user');
    link.href = url.toString();
  } catch { }
}

let deliveryPlan = null;
let boardRole = 'user';            // user=普通，admin=管理（可看金额）
let boardCanSeeAmount = false;
let billedShipmentIds = new Set();
let billedExtraIds = new Set();
let workReviewRows = [];
let workReviewStatus = 'submitted';
let workReviewEditing = null;
let mobileModule = 'entry';
let desktopModule = 'shipment';
let desktopView = 'overview';
let attendanceMonth = '';
let attendanceData = null;
let attendanceReissueData = null;
let mobileAttendanceTab = 'summary';
let mobileWorkTab = 'report';
let workReportRows = [];
let workReportDate = '';
let workReportEmployeeId = '';
let workReportStatus = 'all';
let workReportQuery = '';
let workEmployeesCache = null;
let workTimeline = null;
let workLiveRows = [];
let workLiveLoading = false;
let workLiveLoadedAt = 0;
let remainingVisibleLimit = 60;
let desktopRemainingVisibleLimit = 120;
let formBaseRevision = null;
let orderEditBaseRevision = null;

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
      // 同一访问码下角色已经验证过，直接使用缓存，避免每次打开都先等一次云端身份校验。
      applyRoleUI();
      return;
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

async function callRpc(name, body, timeoutMs = 0) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`${RPC_BASE}/${name}`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const message = data?.message || data?.error || `云端请求失败（HTTP ${response.status}）`;
      return { response: new Response(JSON.stringify({ error: message }), { status: response.status, headers: { 'Content-Type': 'application/json' } }) };
    }
    return { response: new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }), data };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
let desktopOrderType = '';
let remainingSearch = '';
let desktopRemainingSearch = '';
let desktopLoadingSearch = '';
let desktopLoadingDue = 'all';
let desktopLoadingCompany = 'all';
const remainingDates = new Set();
let desktopDueFilter = 'all';
let desktopDueDate = '';
let desktopSearch = '';
const desktopPicked = new Set();   // 下拉里勾选多个料号一起看
let mobileSearch = '';
let historyDate = '';
let recordsSearch = '';
let recordsDate = '';
let recordsCompany = '艾沃意特';
let recordsBatch = '';
let recordsMonth = '';
let recordsFilterPanel = '';
let historyQuery = '';
let queryTab = 'shipments';
let offsetQuery = '';
let offsetDate = '';
let overQuery = '';
let overDate = '';
let replacementQuery = '';
let replacementDate = '';
let cloudFileFormat = 'excel';
let cloudFileCompany = '艾沃意特';   // 云端送货单：再按公司分开   // 云端送货单：pdf / excel 分开看
let filesQuery = '';
let drawingQuery = '';
let drawingCategory = 'all';
let filesDate = '';
let mobileFilesQuery = '';
let mobileFilesDate = '';
const expandedShipments = new Set();
let autoOffsetNote = '';
let cartOpen = false;
const sessionOver = new Map();

// 本次装车里的补发（不良补货）：不扣未交，直接进送货单
const REPLACEMENT_PLAN_MARK = '【补发计划待装车】';
const PHOTO_FILE_KIND = 'SHIPMENT_PHOTO';
const UNIT_FILE_KIND = 'SHIPMENT_UNIT';
const sessionReplacements = [];
const sessionPhotos = [];
const photoDataUrlCache = new Map();
const photoDataLoadPromises = new Map();
let replacementPick = null;
let photoCaptureTarget = null;
let photoPendingDataUrl = '';
let photoCandidateRows = [];
let photoSelectedMaterials = new Map();
let photoUnitQuantities = new Map();
let sampleApprovalAllCandidates = [];
let sampleApprovalCandidates = [];
let sampleApprovalSelectedIndex = -1;
let sampleApprovalPreviewRows = [];
let sampleApprovalPreviewObjectUrl = '';
let sampleApprovalPreviewToken = '';
let photoViewerTarget = null;
let photoViewerRow = null;
let photoRetakeMode = false;
let photoRetakeAllowedKeys = new Set();
let photoUnitContext = null;
let editingOrderId = '';

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
  const orderById = new Map();
  const put = (row) => {
    const material = String(row.material || '').trim();
    if (!material) return;
    const spec = String(row.spec || '').trim();
    const key = material + '|' + spec;
    const current = map.get(key) || {};
    map.set(key, {
      material: current.material || material,
      name: current.name || String(row.name || '').trim(),
      spec: current.spec || spec,
      customer: current.customer || String(row.customer || '').trim(),
    });
  };

  // 补发搜索保持原样：按料号/名称/规格列历史产品，不在这里展开订单和项次。
  for (const order of (snapshot?.orders || [])) {
    orderById.set(String(order.id || ''), order);
    put(order);
  }
  for (const shipment of (snapshot?.shipments || [])) {
    for (const item of (shipment.items || [])) {
      const order = orderById.get(String(item.orderId || ''));
      put({
        material: item.material,
        name: item.name || order?.name,
        spec: item.spec || order?.spec,
        customer: shipment.customer || order?.customer,
      });
    }
  }
  for (const row of (snapshot?.overDeliveries || [])) put(row);
  for (const row of (snapshot?.overOffsets || [])) put(row);
  for (const row of (snapshot?.replacements || [])) put(row);

  const rows = [...map.values()].sort((a, b) =>
    String(a.material || '').localeCompare(String(b.material || ''), 'zh-CN')
    || String(a.spec || '').localeCompare(String(b.spec || ''), 'zh-CN'));
  if (!query) return rows.slice(0, 20);
  return rows.filter((row) => [row.material, row.name, row.spec].join(' ').toLowerCase().includes(query)).slice(0, 50);
}

function currentDeliveryDate() {
  return String((snapshot && snapshot.today) || TODAY || '').slice(0, 10);
}

function defaultReplacementDueDate() {
  const today = currentDeliveryDate();
  const dates = [...new Set((snapshot?.orders || [])
    .filter((order) => Number(order.remaining || 0) > 0)
    .map((order) => String(order.dueDate || '').trim())
    .filter(Boolean))]
    .sort();
  return dates.find((date) => date >= today) || dates[dates.length - 1] || today;
}

function syncReplacementDueDate() {
  if (!els.replacementDueDate) return;
  if (!els.replacementDueDate.value) els.replacementDueDate.value = defaultReplacementDueDate();
}

function isOverdueOrder(order) {
  const dueDate = String(order?.dueDate || '').trim();
  return Boolean(dueDate && dueDate < currentDeliveryDate());
}

// 装车录入排序：交期优先；同一交期内，逾期/补发/承样/试制/工装优先于普通订单。
function loadingOrderPriority(order) {
  if (isOverdueOrder(order)) return 0;
  const type = normalizeOrderType(order);
  if (type === 'sample') return 2;
  if (type === 'trial') return 3;
  if (type === 'tooling') return 4;
  return 5;
}

function loadingReplacementPriority(item) {
  const dueDate = String(item?.dueDate || '').trim();
  return dueDate && dueDate < currentDeliveryDate() ? 0 : 1;
}

function unitDueDates(unit) {
  return [...new Set((unit?.members || []).map((member) => String(member.dueDate || '').slice(0, 10)).filter(Boolean))];
}

function unitMatchesDueFilter(unit, filter) {
  if (!filter || filter === 'all' || filter === 'active') return true;
  const dates = unitDueDates(unit);
  if (!dates.length) return false;
  const today = String(snapshot?.today || TODAY || '').slice(0, 10);
  if (filter === 'today' || filter === 'dueToday') return dates.some((date) => date === today);
  if (filter === 'overdue') return dates.some((date) => date && date < today);
  if (String(filter).startsWith('date:')) { const target = String(filter).slice(5); return dates.some((date) => date === target); }
  return true;
}

function unitMatchesCompany(unit, company) {
  if (!company || company === 'all') return true;
  return (unit?.members || []).some((member) => String(member.customer || '') === String(company));
}

function loadingItems(orderRows, options = {}) {
  const includeReplacements = options.includeReplacements !== false;
  const planQuery = String(options.planQuery || '').trim().toLowerCase();
  const selectedPlans = new Map(sessionReplacements
    .filter((item) => item.planId)
    .map((item) => [String(item.planId), item]));
  const planItems = includeReplacements ? replacementPlans().filter((plan) => !planQuery
    || [plan.material, plan.name, plan.spec, replacementPlanNote(plan)].join(' ').toLowerCase().includes(planQuery)).map((plan) => {
    const selected = selectedPlans.get(String(plan.id)) || null;
    const dueDate = String(plan.deliveryDate || '').trim() || defaultReplacementDueDate();
    return {
      kind: 'replacement',
      dueDate,
      rank: loadingReplacementPriority({ dueDate }),
      material: String(plan.material || ''),
      name: String(plan.name || ''),
      seq: String(plan.createdAt || ''),
      item: selected ? { ...plan, quantity: selected.quantity, remark: selected.remark } : plan,
      selected: Boolean(selected),
      planId: String(plan.id || ''),
    };
  }) : [];
  const legacyItems = includeReplacements ? sessionReplacements
    .filter((item) => !item.planId)
    .map((item, legacyIndex) => ({
      kind: 'replacement',
      dueDate: String(item.dueDate || '').trim() || defaultReplacementDueDate(),
      rank: loadingReplacementPriority(item),
      material: String(item.material || ''),
      name: String(item.name || ''),
      seq: legacyIndex,
      item,
      selected: true,
      legacyIndex,
    })) : [];
  const activeUnits = [...new Map(shipmentUnits().filter((unit) => String(unit.status || 'ready') !== 'shipped' && (typeof options.unitFilter !== 'function' || options.unitFilter(unit))).sort((left, right) => String(left.updatedAt || left.createdAt || '').localeCompare(String(right.updatedAt || right.createdAt || ''))).map((unit) => [String(unit.unitId || unit.id), unit])).values()];
  const unitPlanIds = new Set(activeUnits.flatMap((unit) => (unit.members || []).map((member) => String(member.planId || (member.replacement ? member.orderId : '')).trim()).filter(Boolean)));
  const unitOrderIds = new Set(activeUnits.flatMap((unit) => (unit.members || []).map((member) => String(member.orderId || '')).filter(Boolean)));
  const visibleOrderRows = (orderRows || []).filter((order) => !unitOrderIds.has(String(order.id || '')));
  const unitItems = activeUnits.map((unit, index) => ({
    kind: 'unit',
    dueDate: unitDisplayDate(unit),
    rank: 1.5,
    material: String(unit.members?.[0]?.material || unit.unitId || ''),
    name: String(unit.label || '装车单元'),
    seq: index,
    unit,
    index,
  }));
  return [
    ...visibleOrderRows.map((order) => ({
      kind: 'order',
      dueDate: String(order.dueDate || '').trim(),
      rank: loadingOrderPriority(order),
      material: String(order.material || ''),
      name: String(order.name || ''),
      seq: Number(order.seq || 0),
      order,
    })),
    ...planItems.filter((item) => !unitPlanIds.has(String(item.planId || item.item?.id || ''))),
    ...unitItems,
    ...legacyItems.filter((item) => !unitPlanIds.has(String(item.item?.planId || ''))),
  ].sort((left, right) =>
    String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31'))
    || Number(left.rank || 0) - Number(right.rank || 0)
    || String(left.material || '').localeCompare(String(right.material || ''), 'zh-CN')
    || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
    || String(left.seq || '').localeCompare(String(right.seq || '')));
}function removeReplacementPlan(index) {
  const current = Number(index);
  if (!Number.isInteger(current) || current < 0 || current >= sessionReplacements.length) return;
  const removed = sessionReplacements.splice(current, 1)[0];
  renderMobileSummary();
  renderMobileList();
  renderDesktopLoading();
  renderCart();
  if (removed) showToast('已取消补发计划：' + removed.material);
}

function selectReplacementPlan(planId) {
  const plan = replacementPlans().find((row) => String(row.id) === String(planId));
  if (!plan) { showToast('这个补发计划已经不存在或已被装车'); return; }
  if (sessionReplacements.some((item) => String(item.planId) === String(planId))) return;
  sessionReplacements.push({
    planId: String(plan.id),
    orderId: String(plan.orderId || ''),
    po: String(plan.po || ''),
    seq: String(plan.seq ?? ''),
    material: plan.material || '',
    name: plan.name || '',
    spec: plan.spec || '',
    customer: '4137',
    quantity: Number(plan.quantity || 0),
    dueDate: String(plan.deliveryDate || '').trim() || defaultReplacementDueDate(),
    remark: replacementPlanNote(plan),
  });
  renderMobileSummary();
  renderMobileList();
  renderDesktopLoading();
  renderCart();
  showToast(`已装入补发计划：${plan.material} ${fmt(plan.quantity)} 件`);
}

function unselectReplacementPlan(planId) {
  const index = sessionReplacements.findIndex((item) => String(item.planId) === String(planId));
  if (index >= 0) sessionReplacements.splice(index, 1);
  renderMobileSummary();
  renderMobileList();
  renderDesktopLoading();
  renderCart();
  showToast('已取消装入这个补发计划，计划仍保留在待装车列表');
}

async function deleteReplacementPlan(planId) {
  const plan = replacementPlans().find((row) => String(row.id) === String(planId));
  if (!plan) { showToast('这个补发计划已经不存在'); return; }
  if (!window.confirm(`要删除补发计划吗？\n${plan.material} · ${fmt(plan.quantity)} 件`)) return;
  const result = await callRpc('board_revoke_replacement', { p_code: getAccessCode(), p_id: planId });
  if (!result.response.ok) { showToast(result.data?.message || '删除补发计划失败'); return; }
  unselectReplacementPlan(planId);
  await waitForStateIdle();
  await loadState({ quiet: true });
  renderAll();
  showToast('补发计划已删除');
}function normalizePhotoRow(row) {
  let meta = {};
  try { meta = JSON.parse(String(row?.batch || '{}')); } catch {}
  const materials = Array.isArray(meta.materials) ? meta.materials : [];
  return { ...row, meta, materials, note: String(meta.note || ''), capturedAt: String(meta.capturedAt || row?.createdAt || ''), shipmentId: String(meta.shipmentId || ''), pending: !String(meta.shipmentId || '') };
}

function shipmentPhotos() {
  return Array.isArray(snapshot?.shipmentPhotos) ? snapshot.shipmentPhotos : [];
}
function photoArchiveRows() {
  const map = new Map();
  for (const photo of sessionPhotos) map.set(String(photo.fileName || photo.localId), { ...photo, local: true, pending: !String(photo.meta?.shipmentId || '') });
  for (const row of shipmentPhotos()) { const key = String(row.fileName || row.id); if (!map.has(key)) map.set(key, row); }
  return [...map.values()].sort((left, right) => String(right.capturedAt || right.createdAt || '').localeCompare(String(left.capturedAt || left.createdAt || '')));
}

function photoMaterialsText(row) {
  return (row.materials || []).map((item) => String(item.material || '').trim() + (item.name ? ' ' + String(item.name).trim() : '')).filter(Boolean).join('、') || '未关联物料';
}

let photoArchiveCache = [];

function renderPhotoArchive() {
  const rows = photoArchiveRows();
  photoArchiveCache = rows;
  if (els.photoArchiveCount) els.photoArchiveCount.textContent = fmt(rows.length);
  if (!els.photoArchiveList) return;
  if (!rows.length) { els.photoArchiveList.innerHTML = '<div class="empty-state"><strong>还没有现场照片</strong><span>在装车录入里点物料卡片上的“拍照留档”即可。</span></div>'; return; }
  els.photoArchiveList.innerHTML = rows.map((row, index) => `<article class="photo-archive-item">${row.dataUrl ? `<img class="photo-archive-thumb" src="${row.dataUrl}" alt="现场照片">` : '<div class="photo-archive-thumb photo-archive-placeholder">已上传云端</div>'}<div class="photo-archive-info"><strong>${escapeHtml(photoMaterialsText(row))}</strong><span>${escapeHtml(row.note || '无备注')}</span><small>${row.pending ? '待装车确认' : (row.shipmentId ? '已关联装车 ' + escapeHtml(row.shipmentId) : '已留存')} · ${escapeHtml(String(row.capturedAt || row.createdAt || '').slice(0, 16).replace('T', ' '))}</small></div><button type="button" class="button ghost" data-photo-view-index="${index}">查看照片</button></article>`).join('');
}

function openPhotoArchive() { renderPhotoArchive(); if (els.photoArchiveModal) els.photoArchiveModal.hidden = false; }
function closePhotoArchive() { if (els.photoArchiveModal) els.photoArchiveModal.hidden = true; }


function photoMaterialKey(row) {
  const id = String(row?.id || row?.orderId || row?.planId || '').trim();
  const material = String(row?.material || '').trim();
  const spec = String(row?.spec || '').trim();
  const dueDate = String(row?.dueDate || row?.deliveryDate || row?.dueDates?.[0] || '').slice(0, 10);
  return [id, material, spec, dueDate].join('\u0000');
}
function renderPhotoUnitQtyList() {
  if (!els.photoUnitQtyList) return;
  const selected = [...photoSelectedMaterials.values()];
  els.photoUnitQtyList.innerHTML = selected.map((row) => {
    const key = photoMaterialKey(row);
    const value = photoUnitQuantities.get(key);
    return `<label class="photo-unit-qty-row"><span><strong>${escapeHtml(row.material || '')}</strong><small>${escapeHtml(photoCandidateStatsText(row))}</small></span><input type="number" min="0" step="1" inputmode="numeric" value="${value || ''}" placeholder="本框数量" data-photo-unit-qty="${encodeURIComponent(key)}"></label>`;
  }).join('') || '<div class="photo-unit-qty-empty">选择物料后填写本框/托盘总数量</div>';
}

function renderPhotoMaterialList() {
  if (!els.photoMaterialList) return;
  const query = String(els.photoMaterialSearch?.value || '').trim();
  const candidates = photoMaterialCandidates(query).filter((row) => {
    const key = photoMaterialKey(row);
    return photoRetakeAllowedKeys.has(key) || !materialHasPhoto(row);
  });
  photoCandidateRows = candidates;
  const selectedText = [...photoSelectedMaterials.values()].map((row) => row.material).filter(Boolean).join('、') || '未选择';
  const options = candidates.map((row, index) => {
    const key = photoMaterialKey(row);
    const selected = photoSelectedMaterials.has(key);
    const stats = photoCandidateStatsText(row);
    return `<button type="button" class="photo-material-option${selected ? ' selected' : ''}" data-photo-candidate="${index}"><span><strong>${escapeHtml(row.material)}</strong><small>${escapeHtml(row.name || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</small><small class="photo-candidate-stats">${escapeHtml(stats)}</small></span><b>${selected ? '已关联' : '关联'}</b></button>`;
  }).join('');
  els.photoMaterialList.innerHTML = `<div class="photo-selected-summary">已关联：${escapeHtml(selectedText)}</div>${options || '<div class="empty-state"><strong>没有待关联物料</strong><span>已留档的不会重复显示，可在照片档案里对已留档照片“再拍一张”。</span></div>'}`;
  renderPhotoUnitQtyList();
}


function photoDateKey(row) {
  return String(row?.meta?.deliveryDate || row?.deliveryDate || row?.capturedAt || row?.createdAt || '').slice(0, 10);
}

function photoTargetMatches(item, target) {
  const itemMaterial = String(item?.material || '').trim();
  const targetMaterial = String(target?.material || '').trim();
  if (!itemMaterial || !targetMaterial || itemMaterial !== targetMaterial) return false;
  const itemSpec = String(item?.spec || '').trim();
  const targetSpec = String(target?.spec || '').trim();
  if (itemSpec && targetSpec && itemSpec !== targetSpec) return false;
  const itemDate = String(item?.dueDate || item?.deliveryDate || item?.dueDates?.[0] || '').slice(0, 10);
  const targetDate = String(target?.dueDate || target?.deliveryDate || target?.dueDates?.[0] || '').slice(0, 10);
  if (itemDate && targetDate && itemDate !== targetDate) return false;
  const itemId = String(item?.id || item?.orderId || item?.planId || '').trim();
  const targetId = String(target?.id || target?.orderId || target?.planId || '').trim();
  if (itemId && targetId) return itemId === targetId;
  return true;
}

function photosForTarget(target) {
  const material = String(target?.material || '').trim();
  if (!material) return [];
  return photoArchiveRows().filter((row) => (row.materials || []).some((item) => photoTargetMatches(item, target)));
}

function latestPhotoForTarget(target) {
  return photosForTarget(target)[0] || null;
}

function materialHasPhoto(target) {
  return photosForTarget(target).length > 0;
}

function photoRowKey(row) {
  return String(row?.id || row?.fileName || row?.localId || '').trim();
}

function photosForShipmentLine(item) {
  const material = String(item?.material || '').trim();
  if (!material) return [];
  const shipmentId = String(item?.shipmentId || '').trim();
  const itemOrderId = String(item?.orderId || '').trim();
  const itemPlanId = String(item?.planId || '').trim();
  const itemSpec = String(item?.spec || '').trim();
  const matches = new Map();
  for (const row of photoArchiveRows()) {
    const key = photoRowKey(row);
    if (!key) continue;
    const rowShipmentId = String(row.shipmentId || '').trim();
    for (const photoMaterial of (row.materials || [])) {
      if (String(photoMaterial.material || '').trim() !== material) continue;
      const photoSpec = String(photoMaterial.spec || '').trim();
      if (photoSpec && itemSpec && photoSpec !== itemSpec) continue;
      let score = 30;
      if (rowShipmentId && shipmentId && rowShipmentId === shipmentId) score = 100;
      else if (itemOrderId && String(photoMaterial.orderId || '').trim() === itemOrderId) score = 80;
      else if (itemPlanId && String(photoMaterial.planId || '').trim() === itemPlanId) score = 80;
      else if (photoSpec && itemSpec) score = 60;
      const current = matches.get(key);
      if (!current || score > current.score) matches.set(key, { row, score });
    }
  }
  return [...matches.values()]
    .sort((left, right) => right.score - left.score
      || String(right.row.capturedAt || right.row.createdAt || '').localeCompare(String(left.row.capturedAt || left.row.createdAt || '')))
    .map((entry) => entry.row);
}

function shipmentPhotoButtonHtml(item) {
  const photos = photosForShipmentLine(item);
  if (!photos.length) return '';
  const key = photoRowKey(photos[0]);
  if (!key) return '';
  const label = photos.length > 1 ? `照片 ${photos.length}` : '照片';
  return `<button type="button" class="shipment-photo-btn" data-shipment-photo="${escapeHtml(key)}" title="查看这笔发货的留档照片">${label}</button>`;
}

function openShipmentPhoto(key) {
  const wanted = String(key || '').trim();
  const row = photoArchiveRows().find((item) => photoRowKey(item) === wanted);
  if (!row) { showToast('照片不存在或已经删除'); return; }
  const target = (row.materials || [])[0] || null;
  openPhotoViewerRow(row, target);
}

function photoPendingRows() {
  const rows = [];
  for (const order of (snapshot?.orders || [])) {
    const remaining = Number(order.remaining || 0);
    if (!(remaining > 0)) continue;
    rows.push({
      id: String(order.id || ''),
      orderId: String(order.id || ''),
      sourceType: 'order',
      material: String(order.material || '').trim(),
      name: String(order.name || '').trim(),
      spec: String(order.spec || '').trim(),
      customer: String(order.customer || '').trim(),
      remaining,
      planQty: 0,
      dueDate: String(order.dueDate || '').slice(0, 10),
    });
  }
  for (const plan of replacementPlans()) {
    const planQty = Number(plan.quantity || 0);
    if (!(planQty > 0)) continue;
    rows.push({
      id: String(plan.id || plan.planId || ''),
      planId: String(plan.id || plan.planId || ''),
      sourceType: 'replacement',
      material: String(plan.material || '').trim(),
      name: String(plan.name || '').trim(),
      spec: String(plan.spec || '').trim(),
      customer: '4137',
      remaining: 0,
      planQty,
      dueDate: String(plan.deliveryDate || plan.dueDate || '').slice(0, 10),
    });
  }
  return rows.sort((left, right) =>
    String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31'))
    || String(left.material || '').localeCompare(String(right.material || ''), 'zh-CN')
    || String(left.id || '').localeCompare(String(right.id || '')));
}

function photoCandidateStatsText(row) {
  const parts = [];
  if (Number(row.remaining || 0) > 0) parts.push('未交 ' + fmt(row.remaining));
  if (Number(row.planQty || 0) > 0) parts.push('补发 ' + fmt(row.planQty));
  if (row.dueDate) parts.push('交期 ' + formatDate(row.dueDate));
  return parts.join(' · ') || '暂无未交';
}

function photoMaterialCandidates(queryText) {
  const query = String(queryText || '').trim().toLowerCase();
  return photoPendingRows()
    .filter((row) => !query || [row.material, row.name, row.spec, row.dueDate]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    .slice(0, 80);
}

function currentPhotoMaterials(target) {
  const rows = photoPendingRows();
  const targetId = String(target?.id || target?.orderId || target?.planId || '').trim();
  const material = String(target?.material || '').trim();
  const spec = String(target?.spec || '').trim();
  const targetDate = String(target?.dueDate || target?.deliveryDate || target?.dueDates?.[0] || '').slice(0, 10);
  const selected = new Map();
  for (const row of rows) {
    const rowId = String(row.id || row.orderId || row.planId || '').trim();
    if (targetId && rowId && rowId !== targetId) continue;
    if (String(row.material || '').trim() !== material) continue;
    if (spec && String(row.spec || '').trim() && String(row.spec || '').trim() !== spec) continue;
    if (targetDate && row.dueDate && row.dueDate !== targetDate) continue;
    selected.set(photoMaterialKey(row), row);
  }
  if (!selected.size && target) selected.set(photoMaterialKey(target), target);
  return selected;
}
function openPhotoViewerRow(row, target) {
  if (!row) return;
  photoViewerTarget = target || null;
  photoViewerRow = row;
  if (row.dataUrl) openLocalPhoto(row);
  else if (row.id) openCloudPhoto(row.id, row);
}

function openPhotoCaptureFromButton(button) {
  if (!button) return;
  const orderId = String(button.dataset.photoOrder || '').trim();
  const planId = String(button.dataset.photoPlan || '').trim();
  if (orderId) {
    const order = snapshot?.orders?.find((row) => String(row.id) === orderId);
    if (order) {
      const existing = latestPhotoForTarget(order);
      if (existing) openPhotoViewerRow(existing, order);
      else openPhotoCapture(order);
    }
    return;
  }
  if (planId) {
    const plan = replacementPlans().find((row) => String(row.id) === planId);
    if (plan) {
      const existing = latestPhotoForTarget(plan);
      if (existing) openPhotoViewerRow(existing, plan);
      else openPhotoCapture(plan);
    }
  }
}

function openPhotoCapture(target, options = {}) {
  if (!target || !els.photoCaptureModal) return;
  photoCaptureTarget = target;
  photoPendingDataUrl = '';
  photoUnitQuantities = new Map();
  photoRetakeMode = Boolean(options.retake);
  photoUnitContext = options.unit || null;
  if (photoRetakeMode && options.existingPhoto?.materials?.length) {
    photoSelectedMaterials = new Map(options.existingPhoto.materials.map((row) => [photoMaterialKey(row), row]));
    photoRetakeAllowedKeys = new Set(photoSelectedMaterials.keys());
  } else {
    photoRetakeAllowedKeys = new Set();
    photoSelectedMaterials = currentPhotoMaterials(target);
  }
  if (els.photoFile) els.photoFile.value = '';
  if (els.photoPreview) els.photoPreview.src = '';
  if (els.photoPreviewWrap) els.photoPreviewWrap.hidden = true;
  if (els.photoNote) els.photoNote.value = '';
  if (els.photoMaterialSearch) els.photoMaterialSearch.value = '';
  renderPhotoMaterialList();
  els.photoCaptureModal.hidden = false;
}

function closePhotoCapture() { if (els.photoCaptureModal) els.photoCaptureModal.hidden = true; photoRetakeMode = false; photoRetakeAllowedKeys = new Set(); photoUnitContext = null; photoUnitQuantities = new Map(); }

function compressPhotoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type || '').startsWith('image/')) { reject(new Error('请选择图片文件')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('照片读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('照片解析失败'));
      image.onload = () => {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function savePhotoCapture() {
  if (!photoPendingDataUrl) { showToast('请先拍照或选择照片'); return; }
  const materials = [...photoSelectedMaterials.values()];
  const unitContext = photoUnitContext;
  if (!materials.length) { showToast('请至少关联一个物料'); return; }
  const photoId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/-/g, '');
  const fileName = `photo-${currentDeliveryDate().replace(/-/g, '')}-${photoId}.jpg`;
  const note = String(els.photoNote?.value || '').trim();
  const meta = { type: 'shipment_photo', photoId, deliveryDate: currentDeliveryDate(), materials, note, capturedAt: new Date().toISOString(), shipmentId: '' };
  const payload = { date: currentDeliveryDate(), batch: JSON.stringify(meta), fileName, kind: PHOTO_FILE_KIND, noteCount: materials.length, contentBase64: photoPendingDataUrl.split(',')[1] || '' };
  if (els.photoSave) els.photoSave.disabled = true;
  try {
    const result = await callRpc('board_save_delivery_file', { p_code: getAccessCode(), p_payload: payload });
    const uploaded = result.response.ok;
    sessionPhotos.push({ id: result.data?.id || '', fileName, dataUrl: photoPendingDataUrl, materials, note, meta, capturedAt: meta.capturedAt, uploaded });
    let unitUpdated = false;
    if (uploaded && unitContext) {
      const nextMembers = buildUnitMembers(materials, photoUnitQuantities);
      await persistUnit({ ...unitContext, members: nextMembers.length ? nextMembers : unitContext.members, photoFileNames: [fileName], status: 'ready' });
    } else if (uploaded && materials.length > 1) {
      await createUnitFromPhoto(photoId, materials, fileName, photoUnitQuantities);
      unitUpdated = true;
    }
    if (unitUpdated) {
      await waitForStateIdle();
      await loadState({ quiet: true });
      renderAll();
    } else {
      renderPhotoArchive();
      renderMobileList();
      renderDesktopLoading();
    }
    showToast(uploaded ? '照片已保存到云端' : '照片已暂存在本机，确认装车时会重试上传');
    if (window.confirm('照片已保存。要继续新增一张照片吗？')) {
      photoPendingDataUrl = '';
      if (els.photoFile) els.photoFile.value = '';
      if (els.photoPreview) els.photoPreview.src = '';
      if (els.photoPreviewWrap) els.photoPreviewWrap.hidden = true;
      if (els.photoNote) els.photoNote.value = '';
      renderPhotoMaterialList();
      showToast('可以继续拍下一张，关联物料已保留');
      return;
    }
    closePhotoCapture();
    showToast(uploaded ? '照片已保存到云端' : '照片已暂存在本机，确认装车时会重试上传');
  } finally {
    if (els.photoSave) els.photoSave.disabled = false;
  }
}
async function uploadSessionPhotos(shipmentId) {
  const failed = [];
  const succeeded = new Set();
  for (const photo of sessionPhotos) {
    const meta = { ...photo.meta, shipmentId: String(shipmentId || ''), finalized: true };
    const payload = { date: photo.meta?.deliveryDate || currentDeliveryDate(), batch: JSON.stringify(meta), fileName: photo.fileName, kind: PHOTO_FILE_KIND, noteCount: photo.materials.length, contentBase64: String(photo.dataUrl || '').split(',')[1] || '' };
    try {
      const result = await callRpc('board_save_delivery_file', { p_code: getAccessCode(), p_payload: payload });
      if (!result.response.ok) throw new Error(result.data?.message || '照片上传失败');
      succeeded.add(photo.fileName);
    } catch { failed.push(photo.fileName); }
  }
  const remaining = sessionPhotos.filter((photo) => !succeeded.has(photo.fileName));
  sessionPhotos.length = 0;
  sessionPhotos.push(...remaining);
  renderPhotoArchive();
  return failed;
}

async function deletePhotoViewerAndRetake() {
  const row = photoViewerRow;
  const target = photoViewerTarget;
  if (!row) return;
  if (!window.confirm('确定删除这张照片吗？删除后可以重新拍照留档。')) return;
  const button = els.photoViewerDelete;
  const originalText = button?.textContent || '删除并重拍';
  if (button) { button.disabled = true; button.textContent = '删除中...'; }
  try {
    if (row.id) {
      const result = await callRpc('board_delete_delivery_file', { p_code: getAccessCode(), p_id: row.id });
      if (!result.response.ok) throw new Error(result.data?.message || '删除照片失败');
    }
    const fileName = String(row.fileName || '');
    const localIndex = sessionPhotos.findIndex((photo) => (row.id && String(photo.id || '') === String(row.id)) || (fileName && String(photo.fileName || '') === fileName));
    if (localIndex >= 0) sessionPhotos.splice(localIndex, 1);
    if (snapshot && Array.isArray(snapshot.shipmentPhotos)) {
      snapshot.shipmentPhotos = snapshot.shipmentPhotos.filter((photo) => (row.id && String(photo.id || '') !== String(row.id)) && (!fileName || String(photo.fileName || '') !== fileName));
    }
    if (row.id) photoDataUrlCache.delete(String(row.id));
    photoViewerRow = null;
    if (els.photoViewerModal) els.photoViewerModal.hidden = true;
    renderPhotoArchive();
    renderMobileList();
    renderDesktopLoading();
    showToast('照片已删除，可以重新拍照留档');
    if (target) openPhotoCapture(target);
  } catch (error) {
    showToast(error.message || '删除照片失败');
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

async function openCloudPhoto(id, row = null) {
  if (!id) return;
  const key = String(id);
  const metaText = row ? photoMaterialsText(row) + (row.note ? ' · ' + row.note : '') : '现场照片';
  const cached = photoDataUrlCache.get(key);
  if (cached) {
    if (els.photoViewerImage) els.photoViewerImage.src = cached;
    if (els.photoViewerMeta) els.photoViewerMeta.textContent = metaText;
    if (els.photoViewerModal) els.photoViewerModal.hidden = false;
    return;
  }
  if (els.photoViewerImage) els.photoViewerImage.src = '';
  if (els.photoViewerMeta) els.photoViewerMeta.textContent = '照片加载中...';
  if (els.photoViewerModal) els.photoViewerModal.hidden = false;
  try {
    let promise = photoDataLoadPromises.get(key);
    if (!promise) {
      promise = (async () => {
        const result = await callRpc('board_get_delivery_file', { p_code: getAccessCode(), p_id: id });
        if (!result.response.ok) throw new Error(result.data?.message || '照片读取失败');
        const data = result.data || {};
        return `data:image/jpeg;base64,${String(data.contentBase64 || '')}`;
      })().finally(() => photoDataLoadPromises.delete(key));
      photoDataLoadPromises.set(key, promise);
    }
    const dataUrl = await promise;
    photoDataUrlCache.set(key, dataUrl);
    if (els.photoViewerImage) els.photoViewerImage.src = dataUrl;
    if (els.photoViewerMeta) els.photoViewerMeta.textContent = metaText;
  } catch (error) {
    showToast(error.message || '照片读取失败');
  }
}

function openLocalPhoto(row) {
  if (!row?.dataUrl || !els.photoViewerImage) return;
  els.photoViewerImage.src = row.dataUrl;
  els.photoViewerMeta.textContent = photoMaterialsText(row) + (row.note ? ' · ' + row.note : '');
  if (els.photoViewerModal) els.photoViewerModal.hidden = false;
}
function unitIdentityKeys(unit) {
  const keys = (unit?.members || []).map((member) => {
    if (member.planId) return 'plan:' + String(member.planId);
    if (member.orderId) return 'order:' + String(member.orderId);
    return 'material:' + String(member.material || '') + '|' + String(member.dueDate || '');
  }).filter(Boolean);
  if (!keys.length && unit?.unitId) keys.push('unit:' + String(unit.unitId));
  return keys;
}

function unitQualityScore(unit) {
  const statusScore = unit?.status === 'ready' ? 30 : unit?.status === 'loaded' ? 25 : unit?.status === 'shipped' ? 10 : 0;
  const stamp = Date.parse(String(unit?.updatedAt || unit?.createdAt || '')) || 0;
  return (unit?.members || []).length * 100
    + (unit?.photoFileNames || []).length * 40
    + statusScore
    + stamp / 1e13;
}

function dedupeShipmentUnits(units) {
  const sorted = [...(units || [])].sort((left, right) => unitQualityScore(right) - unitQualityScore(left));
  const used = new Set();
  const result = [];
  for (const unit of sorted) {
    const keys = unitIdentityKeys(unit);
    if (keys.some((key) => used.has(key))) continue;
    keys.forEach((key) => used.add(key));
    result.push(unit);
  }
  return result;
}

function shipmentUnits() {
  const units = dedupeShipmentUnits(Array.isArray(snapshot?.shipmentUnits) ? snapshot.shipmentUnits : []);
  // 装车单元至少要有 2 个不同物料；少于 2 个的旧单元自动解除/隐藏
  return units.filter((unit) => unitMaterialCount(unit) >= 2);
}

let invalidUnitsCleanupDone = false;
async function cleanupInvalidShipmentUnits() {
  if (invalidUnitsCleanupDone || !snapshot || !Array.isArray(snapshot.shipmentUnits)) return;
  const invalid = snapshot.shipmentUnits.filter((unit) => String(unit.status || '') !== 'shipped' && unitMaterialCount(unit) < 2);
  if (!invalid.length) { invalidUnitsCleanupDone = true; return; }
  invalidUnitsCleanupDone = true;
  let removed = false;
  for (const unit of invalid) {
    try { await dissolveShipmentUnit(unit); removed = true; } catch {}
  }
  if (removed) { renderMobileSummary(); renderMobileList(); renderDesktopLoading(); renderCart(); }
}

function normalizeUnitRow(row) {
  let meta = {};
  try { meta = JSON.parse(String(row?.batch || '{}')); } catch {}
  const members = Array.isArray(meta.members) ? meta.members : [];
  return {
    ...row,
    meta,
    unitId: String(meta.unitId || row?.id || ''),
    label: String(meta.label || '装车单元'),
    status: String(meta.status || 'ready'),
    deliveryDate: String(meta.deliveryDate || row?.deliveryDate || ''),
    members,
    photoFileNames: Array.isArray(meta.photoFileNames) ? meta.photoFileNames : [],
    note: String(meta.note || ''),
    createdAt: String(meta.createdAt || row?.createdAt || ''),
    updatedAt: String(meta.updatedAt || meta.createdAt || row?.createdAt || ''),
    shipmentId: String(meta.shipmentId || ''),
  };
}

async function fetchDeliveryFileRows() {
  if (!RPC_BASE) return [];
  const accessCode = getAccessCode();
  if (!accessCode) return [];
  if (!deliveryFilesPromise) {
    deliveryFilesPromise = callRpc('board_get_delivery_files', { p_code: accessCode, p_limit: 300 })
      .then((result) => result.response.ok && Array.isArray(result.data) ? result.data : [])
      .catch(() => []);
  }
  return deliveryFilesPromise;
}

async function loadShipmentUnits() {
  const rows = await fetchDeliveryFileRows();
  return rows.filter((row) => String(row.kind || '') === UNIT_FILE_KIND).map(normalizeUnitRow);
}

function unitStatusText(unit) {
  return ({ ready: '待装车', loaded: '已装入', needs_rephoto: '需重新拍照', shipped: '已发货' })[unit.status] || '待装车';
}

function unitPhoto(unit) {
  const fileName = String((unit.photoFileNames || []).slice(-1)[0] || '');
  if (!fileName) return null;
  return photoArchiveRows().find((row) => String(row.fileName || '') === fileName) || null;
}
function unitsForShipment(shipmentIds) {
  const ids = new Set((Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds]).map((value) => String(value || '')).filter(Boolean));
  if (!ids.size) return [];
  return shipmentUnits().filter((unit) => ids.has(String(unit.shipmentId || '')));
}

function unitHistoryHtml(shipmentIds) {
  const units = unitsForShipment(shipmentIds);
  if (!units.length) return '';
  return `<div class="history-units">${units.map((unit) => {
    const photo = unitPhoto(unit);
    return `<div class="history-unit"><div><strong>装车单元</strong><span>${escapeHtml(fmt(unitMaterialCount(unit)))} 项 · ${escapeHtml(fmt(unitTotalQuantity(unit)))} 件 · ${escapeHtml(unitMembersText(unit))}</span></div>${photo ? `<button type="button" class="unit-photo-button" data-unit-view-photo="${escapeHtml(unit.unitId)}">查看照片</button>` : '<span class="row-locked">无现场照片</span>'}</div>`;
  }).join('')}</div>`;
}


function unitMembersText(unit) {
  return (unit.members || []).map((member) => member.material).filter(Boolean).join('、') || '未填写物料';
}

function base64Text(value) {
  return btoa(unescape(encodeURIComponent(String(value || ''))));
}

function unitMetaForSave(unit) {
  return {
    type: 'shipment_unit',
    unitId: unit.unitId,
    label: unit.label || '装车单元',
    status: unit.status || 'ready',
    deliveryDate: unit.deliveryDate || currentDeliveryDate(),
    members: unit.members || [],
    photoFileNames: unit.photoFileNames || [],
    note: unit.note || '',
    createdAt: unit.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shipmentId: unit.shipmentId || '',
  };
}

async function persistUnit(unit) {
  const meta = unitMetaForSave(unit);
  const fileName = String(unit.fileName || ('unit-' + String(meta.deliveryDate).replace(/-/g, '') + '-' + meta.unitId + '.json'));
  const result = await callRpc('board_save_delivery_file', {
    p_code: getAccessCode(),
    p_payload: {
      date: meta.deliveryDate,
      batch: JSON.stringify(meta),
      fileName,
      kind: UNIT_FILE_KIND,
      noteCount: meta.members.length,
      contentBase64: base64Text(JSON.stringify(meta)),
    },
  });
  if (!result.response.ok) throw new Error(result.data?.message || '装车单元保存失败');
  return { ...unit, ...meta, fileName };
}

async function updateShipmentUnit(unit, patch = {}) {
  const updated = await persistUnit({ ...unit, ...patch });
  await waitForStateIdle();
  await loadState({ quiet: true });
  renderAll();
  return updated;
}

function detachUnitMembersFromCart(unit) {
  for (const member of (unit?.members || [])) {
    const planId = String(member.planId || '').trim();
    const orderId = String(member.orderId || '').trim();
    if (planId) {
      const index = sessionReplacements.findIndex((item) => String(item.planId) === planId);
      if (index >= 0) sessionReplacements.splice(index, 1);
    }
    if (orderId && !planId) selected.delete(orderId);
  }
}

async function dissolveShipmentUnit(unit) {
  if (!unit) return false;
  if (unit.id) {
    const result = await callRpc('board_delete_delivery_file', { p_code: getAccessCode(), p_id: unit.id });
    if (!result.response.ok) throw new Error(result.data?.message || '解除装车单元失败');
  }
  if (snapshot && Array.isArray(snapshot.shipmentUnits)) {
    snapshot.shipmentUnits = snapshot.shipmentUnits.filter((row) => {
      if (unit.id && row.id) return String(row.id) !== String(unit.id);
      return String(row.unitId || '') !== String(unit.unitId || '');
    });
  }
  return true;
}

function unitCandidateOrders(row) {
  const material = String(row?.material || '').trim();
  const spec = String(row?.spec || '').trim();
  return (snapshot?.orders || [])
    .filter((order) => Number(order.remaining || 0) > 0
      && String(order.material || '').trim() === material
      && (!spec || String(order.spec || '').trim() === spec))
    .sort((left, right) => String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31'))
      || Number(left.seq || 0) - Number(right.seq || 0));
}

function allocateUnitMember(row, totalQuantity) {
  let remainingToAllocate = Math.max(0, Number(totalQuantity || 0));
  const members = [];
  for (const order of unitCandidateOrders(row)) {
    if (remainingToAllocate <= 0) break;
    const available = Number(order.remaining || 0);
    const quantity = Math.min(available, remainingToAllocate);
    if (quantity <= 0) continue;
    members.push({
      orderId: String(order.id || ''),
      po: order.po || '',
      seq: order.seq || '',
      material: order.material || '',
      name: order.name || '',
      spec: order.spec || '',
      dueDate: String(order.dueDate || ''),
      quantity,
      unit: '件',
    });
    remainingToAllocate -= quantity;
  }
  return members;
}

function buildUnitMembers(materials, quantities = new Map()) {
  const explicit = quantities instanceof Map && quantities.size > 0;
  const members = [];
  for (const row of (materials || [])) {
    const key = photoMaterialKey(row);
    const explicitQuantity = Number((quantities instanceof Map ? quantities.get(key) : 0) || 0);
    const isReplacement = String(row?.sourceType || '') === 'replacement' || Boolean(row?.planId);
    if (isReplacement) {
      const quantity = explicit ? explicitQuantity : Number(row.planQty || row.quantity || 0);
      if (quantity > 0) {
        members.push({
          orderId: String(row.orderId || row.id || row.planId || ''),
          planId: String(row.planId || row.id || ''),
          po: String(row.po || '补发'),
          seq: String(row.seq || ''),
          material: String(row.material || ''),
          name: String(row.name || ''),
          spec: String(row.spec || ''),
          dueDate: String(row.dueDate || ''),
          quantity,
          unit: '件',
          replacement: true,
        });
      }
      continue;
    }
    if (explicit) {
      if (explicitQuantity > 0) members.push(...allocateUnitMember(row, explicitQuantity));
      continue;
    }
    for (const order of unitCandidateOrders(row)) {
      members.push({
        orderId: String(order.id || ''),
        po: order.po || '',
        seq: order.seq || '',
        material: order.material || '',
        name: order.name || '',
        spec: order.spec || '',
        dueDate: String(order.dueDate || ''),
        quantity: Number(order.remaining || 0),
        unit: '件',
      });
    }
  }
  return members;
}

function buildUnitMeta(unitId, materials, photoFileName, quantities = new Map()) {
  const members = buildUnitMembers(materials, quantities);
  return {
    unitId,
    label: '装车单元',
    status: 'ready',
    deliveryDate: currentDeliveryDate(),
    members,
    photoFileNames: [photoFileName].filter(Boolean),
    note: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shipmentId: '',
  };
}

async function createUnitFromPhoto(unitId, materials, photoFileName, quantities = new Map()) {
  const members = buildUnitMembers(materials, quantities);
  const distinctMaterials = new Set((materials || []).map((row) => String(row?.material || '').trim()).filter(Boolean)).size;
  if (!materials || !members.length || distinctMaterials < 2) return null;
  const unit = buildUnitMeta(unitId, materials, photoFileName, quantities);
  const fileName = 'unit-' + currentDeliveryDate().replace(/-/g, '') + '-' + unitId + '.json';
  return persistUnit({ ...unit, fileName });
}function unitMaterialCount(unit) {
  return new Set((unit.members || []).map((member) => String(member.material || '').trim()).filter(Boolean)).size;
}

function unitTotalQuantity(unit) {
  return (unit.members || []).reduce((sum, member) => sum + Number(member.quantity || 0), 0);
}

function unitDisplayDate(unit) {
  const dates = (unit.members || []).map((member) => String(member.dueDate || '').trim()).filter(Boolean).sort();
  return dates[0] || String(unit.deliveryDate || '').trim() || currentDeliveryDate();
}

function unitCardHtml(unit, index) {
  const photo = unitPhoto(unit);
  const status = unit.status || 'ready';
  const members = unit.members || [];
  const memberHtml = members.map((member, memberIndex) => `
    <div class="unit-member-row">
      <div class="unit-member-info">
        <strong>${escapeHtml(member.material || '')} ${escapeHtml(member.name || '')}</strong>
        <small>${escapeHtml(member.po || '')} 项次${escapeHtml(member.seq || '')} · ${escapeHtml(member.spec || '—')} · 交期 ${escapeHtml(formatDate(member.dueDate || unit.deliveryDate))}</small>
      </div>
      <input type="number" min="0" step="1" inputmode="numeric" value="${Number(member.quantity || 0) || ''}" placeholder="数量" data-unit-member-qty="${memberIndex}" data-unit-id="${escapeHtml(unit.unitId)}" aria-label="本次装车数量">
      <button type="button" class="cart-remove" data-unit-member-remove="${memberIndex}">移除</button>
    </div>`).join('');
  const retakeAction = status === 'needs_rephoto' ? `<button type="button" class="button primary" data-unit-retake="${escapeHtml(unit.unitId)}">重新拍照</button>` : '';
  const loadAction = status === 'needs_rephoto' ? '' : `<button type="button" class="button primary" data-unit-load="${escapeHtml(unit.unitId)}">${status === 'loaded' ? '更新装车数量' : '整组装车'}</button>`;
  const addAction = status === 'shipped' ? '' : `<button type="button" class="button ghost" data-unit-add="${escapeHtml(unit.unitId)}">增加物料</button>`;
  return `<article class="order-card shipment-unit-card" data-unit-card="${escapeHtml(unit.unitId)}">
    <div class="unit-card-head">
      <div>
        <div class="order-name-line"><strong>${escapeHtml(unit.label || '装车单元')}</strong><span class="unit-status ${escapeHtml(status)}">${escapeHtml(unitStatusText(unit))}</span></div>
        <span class="mono">交期 ${escapeHtml(formatDate(unitDisplayDate(unit)))} · ${escapeHtml(fmt(unitMaterialCount(unit)))} 项物料 · 共 ${escapeHtml(fmt(unitTotalQuantity(unit)))} 件</span>
      </div>
      ${photo ? `<button type="button" class="unit-photo-button" data-unit-view-photo="${escapeHtml(unit.unitId)}">现场照片</button>` : '<span class="unit-photo-button empty">无照片</span>'}
    </div>
    <div class="unit-member-list">${memberHtml || '<div class="unit-member-empty">没有匹配到待发货订单</div>'}</div>
    <div class="unit-card-actions">${addAction}${loadAction}${retakeAction}</div>
  </article>`;
}

async function loadUnitToCart(unitId) {
  const unit = shipmentUnits().find((row) => String(row.unitId) === String(unitId));
  if (!unit) { showToast('装车单元不存在或已更新'); return; }
  if (unit.status === 'needs_rephoto') { showToast('请先重新拍照，再整组装车'); return; }
  let loaded = 0;
  for (const member of unit.members || []) {
    const quantity = Number(member.quantity || 0);
    if (quantity <= 0) continue;
    const planId = String(member.planId || '').trim();
    if (member.replacement || planId) {
      if (!planId || sessionReplacements.some((item) => String(item.planId) === planId)) continue;
      const plan = replacementPlans().find((row) => String(row.id) === planId);
      sessionReplacements.push({
        planId,
        orderId: String(member.orderId || plan?.orderId || ''),
        po: String(member.po || plan?.po || ''),
        seq: String(member.seq ?? plan?.seq ?? ''),
        material: String(member.material || plan?.material || ''),
        name: String(member.name || plan?.name || ''),
        spec: String(member.spec || plan?.spec || ''),
        customer: '4137',
        quantity,
        dueDate: String(member.dueDate || plan?.deliveryDate || defaultReplacementDueDate()),
        remark: plan ? replacementPlanNote(plan) : '',
      });
      loaded += 1;
      continue;
    }
    if (!member.orderId) continue;
    selected.set(String(member.orderId), quantity);
    clearPendingOver(member.material);
    loaded += 1;
  }
  if (!loaded) { showToast('请先填写至少一项装车数量'); return; }
  await updateShipmentUnit(unit, { status: 'loaded' });
  renderMobileSummary();
  renderMobileList();
  renderDesktopLoading();
  renderCart();
  showToast(`已装入 ${loaded} 项物料，确认装车后一起发货`);
}

async function removeUnitMember(unitId, memberIndex) {
  const unit = shipmentUnits().find((row) => String(row.unitId) === String(unitId));
  if (!unit) { showToast('装车单元不存在或已更新'); return; }
  const index = Number(memberIndex);
  const member = (unit.members || [])[index];
  if (!member) return;
  if (!window.confirm(`要把 ${member.material} 从装车单元中移除吗？\n移除后需要重新拍照。`)) return;
  const members = (unit.members || []).filter((_, i) => i !== index);
  const remainingMaterials = new Set(members.map((row) => String(row.material || '').trim()).filter(Boolean)).size;
  if (remainingMaterials < 2) {
    detachUnitMembersFromCart(unit);
    try {
      await dissolveShipmentUnit(unit);
    } catch (error) {
      showToast(error.message || '解除装车单元失败');
      return;
    }
    renderMobileSummary();
    renderMobileList();
    renderDesktopLoading();
    renderCart();
    showToast('已移除物料，装车单元不足 2 个物料，已自动解除');
    return;
  }
  if (member.orderId && !member.planId) selected.delete(String(member.orderId));
  await updateShipmentUnit(unit, { members, status: 'needs_rephoto', photoFileNames: [] });
  showToast('已移除物料，请重新拍照后再确认整组装车');
}

async function updateUnitMemberQuantity(unitId, memberIndex, value) {
  const unit = shipmentUnits().find((row) => String(row.unitId) === String(unitId));
  if (!unit) return;
  const index = Number(memberIndex);
  const quantity = Number(value);
  const members = (unit.members || []).map((member, i) => i === index ? { ...member, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0 } : member);
  await updateShipmentUnit(unit, { members });
}

function viewUnitPhoto(unitId) {
  const unit = shipmentUnits().find((row) => String(row.unitId) === String(unitId));
  if (!unit) return;
  const photo = unitPhoto(unit);
  if (!photo) { showToast('这个装车单元还没有照片'); return; }
  photoViewerTarget = unit.members?.[0] || unit;
  photoViewerRow = photo;
  if (photo.dataUrl) openLocalPhoto(photo);
  else if (photo.id) openCloudPhoto(photo.id, photo);
}

function retakeUnit(unitId) {
  const unit = shipmentUnits().find((row) => String(row.unitId) === String(unitId));
  if (!unit) return;
  const target = unit.members?.[0] || { material: unitMembersText(unit) };
  photoUnitContext = unit;
  openPhotoCapture(target, { retake: true, existingPhoto: { ...unit, materials: unit.members || [] }, unit });
}

async function markLoadedUnitsShipped(shipmentId) {
  for (const unit of shipmentUnits().filter((row) => row.status === 'loaded')) {
    try { await persistUnit({ ...unit, status: 'shipped', shipmentId: String(shipmentId || '') }); } catch {}
  }
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
    + `${replacementPick.customer ? '（' + escapeHtml(replacementPick.customer) + '）' : ''}`;
}

async function addReplacement() {
  if (!replacementPick) { showToast('请先搜索并选择要补发的产品'); return; }
  const quantity = Number(els.replacementQty?.value || 0);
  if (!Number.isFinite(quantity) || quantity <= 0) { showToast('请填写补发数量'); return; }
  const dueDate = String(els.replacementDueDate?.value || '').trim() || defaultReplacementDueDate();
  if (!dueDate) { showToast('请选择补发交期'); return; }
  const remark = String(els.replacementRemark?.value || '').trim();
  if (els.replacementAdd) els.replacementAdd.disabled = true;
  try {
    const result = await callRpc('board_add_replacement', {
      p_code: getAccessCode(),
      p_payload: {
        date: dueDate,
        customer: '4137',
        orderId: replacementPick.orderId || '',
        po: replacementPick.po || '',
        seq: replacementPick.seq || '',
        material: replacementPick.material,
        name: replacementPick.name || '',
        spec: replacementPick.spec || '',
        quantity,
        remark: replacementPlanRemark(remark),
      },
    });
    if (!result.response.ok) throw new Error(result.data?.message || '补发计划发布失败');
    replacementPick = null;
    if (els.replacementQty) els.replacementQty.value = '';
    if (els.replacementRemark) els.replacementRemark.value = '';
    if (els.replacementSearch) els.replacementSearch.value = '';
    renderReplacementPicked();
    await waitForStateIdle();
    await loadState({ quiet: true });
    renderAll();
    showToast(`补发计划已发布：${quantity} 件，交期 ${formatDate(dueDate)}`);
  } catch (error) {
    showToast(error.message || '补发计划发布失败');
  } finally {
    if (els.replacementAdd) els.replacementAdd.disabled = false;
  }
}function offsetSkipped(over) {
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
let stateLoadFailures = 0;
let pendingImportOrders = null;

const els = {
  liveDot: $('#liveDot'),
  liveText: $('#liveText'),
  desktopLiveDot: $('#desktopLiveDot'),
  desktopLiveText: $('#desktopLiveText'),
  mobileLiveLabel: $('#mobileLiveLabel'),
  printHelperStatus: $('#printHelperStatus'),
  mobilePrintHelperStatus: $('#mobilePrintHelperStatus'),
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
  desktopOrderTypeFilter: $('#desktopOrderTypeFilter'),
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
  replacementHistorySearch: $('#replacementHistorySearch'),
  replacementHistoryDate: $('#replacementHistoryDate'),
  recordsReplacementSearch: $('#recordsReplacementSearch'),
  recordsReplacementDate: $('#recordsReplacementDate'),
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
  moduleSwitchButton: $('#moduleSwitchButton'),
  moduleSwitchSheet: $('#moduleSwitchSheet'),
  moduleSwitchLabel: $('#moduleSwitchLabel'),
  desktopWorkReportLink: $('#desktopWorkReportLink'),
  desktopWorkReportView: $('#desktopWorkReportView'),
  desktopWorkReportRefresh: $('#desktopWorkReportRefresh'),
  desktopWorkReportDate: $('#desktopWorkReportDate'),
  desktopWorkReportEmployee: $('#desktopWorkReportEmployee'),
  desktopWorkReportStatus: $('#desktopWorkReportStatus'),
  desktopWorkReportSearch: $('#desktopWorkReportSearch'),
  desktopWorkReportEntries: $('#desktopWorkReportEntries'),
  desktopWorkReportQuantity: $('#desktopWorkReportQuantity'),
  desktopWorkReportAmount: $('#desktopWorkReportAmount'),
  desktopWorkReportPending: $('#desktopWorkReportPending'),
  desktopWorkReportBody: $('#desktopWorkReportBody'),
  desktopWorkReportEmpty: $('#desktopWorkReportEmpty'),
  desktopWorkLiveHint: $('#desktopWorkLiveHint'),
  desktopWorkLiveSummary: $('#desktopWorkLiveSummary'),
  desktopWorkLiveBody: $('#desktopWorkLiveBody'),
  desktopWorkLiveEmpty: $('#desktopWorkLiveEmpty'),
  mobileWorkModule: $('#mobileWorkModule'),
  mobileWorkReportPanel: $('#mobileWorkReportPanel'),
  mobileWorkReportDate: $('#mobileWorkReportDate'),
  mobileWorkReportEmployee: $('#mobileWorkReportEmployee'),
  mobileWorkReportStatus: $('#mobileWorkReportStatus'),
  mobileWorkReportSearch: $('#mobileWorkReportSearch'),
  mobileWorkReportRefresh: $('#mobileWorkReportRefresh'),
  mobileWorkReportEntries: $('#mobileWorkReportEntries'),
  mobileWorkReportQuantity: $('#mobileWorkReportQuantity'),
  mobileWorkReportAmount: $('#mobileWorkReportAmount'),
  mobileWorkReportPending: $('#mobileWorkReportPending'),
  mobileWorkReportList: $('#mobileWorkReportList'),
  mobileWorkLiveSummary: $('#mobileWorkLiveSummary'),
  mobileWorkLiveList: $('#mobileWorkLiveList'),
  desktopWorkReviewLink: $('#desktopWorkReviewLink'),
  desktopWorkReviewView: $('#desktopWorkReviewView'),
  desktopWorkReviewStatus: $('#desktopWorkReviewStatus'),
  desktopWorkReviewRefresh: $('#desktopWorkReviewRefresh'),
  desktopWorkReviewPending: $('#desktopWorkReviewPending'),
  desktopWorkReviewCount: $('#desktopWorkReviewCount'),
  desktopWorkReviewList: $('#desktopWorkReviewList'),
  desktopWorkReviewEmpty: $('#desktopWorkReviewEmpty'),
  desktopAttendanceView: $('#desktopAttendanceView'),
  desktopAttendanceMonth: $('#desktopAttendanceMonth'),
  desktopAttendancePrev: $('#desktopAttendancePrev'),
  desktopAttendanceNext: $('#desktopAttendanceNext'),
  desktopAttendanceRefresh: $('#desktopAttendanceRefresh'),
  desktopAttendanceTab: $('#desktopAttendanceTab'),
  desktopAttendanceStats: $('#desktopAttendanceStats'),
  desktopAttendanceCount: $('#desktopAttendanceCount'),
  desktopAttendanceDays: $('#desktopAttendanceDays'),
  desktopAttendanceAbsent: $('#desktopAttendanceAbsent'),
  desktopAttendanceOvertime: $('#desktopAttendanceOvertime'),
  desktopAttendanceSummaryPanel: $('#desktopAttendanceSummaryPanel'),
  desktopAttendanceBody: $('#desktopAttendanceBody'),
  desktopAttendanceEmpty: $('#desktopAttendanceEmpty'),
  desktopAttendanceDetailPanel: $('#desktopAttendanceDetailPanel'),
  desktopAttendanceDetailTitle: $('#desktopAttendanceDetailTitle'),
  desktopAttendanceDetailHint: $('#desktopAttendanceDetailHint'),
  desktopAttendanceDetailClose: $('#desktopAttendanceDetailClose'),
  desktopAttendanceDetailBody: $('#desktopAttendanceDetailBody'),
  desktopAttendanceReissuePanel: $('#desktopAttendanceReissuePanel'),
  desktopAttendanceReissueList: $('#desktopAttendanceReissueList'),
  desktopAttendanceReissueEmpty: $('#desktopAttendanceReissueEmpty'),
  mobileAttendanceModule: $('#mobileAttendanceModule'),
  mobileAttendanceMonth: $('#mobileAttendanceMonth'),
  mobileAttendancePrev: $('#mobileAttendancePrev'),
  mobileAttendanceNext: $('#mobileAttendanceNext'),
  mobileAttendanceRefresh: $('#mobileAttendanceRefresh'),
  mobileAttendanceSummaryPanel: $('#mobileAttendanceSummaryPanel'),
  mobileAttendanceList: $('#mobileAttendanceList'),
  mobileAttendanceReissuePanel: $('#mobileAttendanceReissuePanel'),
  mobileAttendanceReissueList: $('#mobileAttendanceReissueList'),
  desktopLoadingView: $('#desktopLoadingView'),
  desktopLoadingSearch: $('#desktopLoadingSearch'),
  desktopLoadingDue: $('#desktopLoadingDue'),
  desktopLoadingCompany: $('#desktopLoadingCompany'),
  desktopLoadingRefresh: $('#desktopLoadingRefresh'),
  desktopLoadingSummary: $('#desktopLoadingSummary'),
  desktopLoadingSelectedQty: $('#desktopLoadingSelectedQty'),
  desktopLoadingSelectedItems: $('#desktopLoadingSelectedItems'),
  desktopLoadingRemainingQty: $('#desktopLoadingRemainingQty'),
  desktopLoadingCardList: $('#desktopLoadingCardList'),
  desktopLoadingEmpty: $('#desktopLoadingEmpty'),
  desktopLoadingCart: $('#desktopLoadingCart'),
  desktopLoadingCartHint: $('#desktopLoadingCartHint'),
  desktopLoadingOpenSubmit: $('#desktopLoadingOpenSubmit'),
  desktopLoadingRecords: $('#desktopLoadingRecords'),
  mobileModuleSwitch: $('#mobileModuleSwitch'),
  mobileModuleMenu: $('#mobileModuleMenu'),
  mobileWorkReviewPanel: $('#mobileWorkReviewPanel'),
  mobileWorkReviewStatus: $('#mobileWorkReviewStatus'),
  mobileWorkReviewRefresh: $('#mobileWorkReviewRefresh'),
  mobileWorkReviewList: $('#mobileWorkReviewList'),
  workReviewModal: $('#workReviewModal'),
  workReviewClose: $('#workReviewClose'),
  workReviewId: $('#workReviewId'),
  workReviewInfo: $('#workReviewInfo'),
  workReviewName: $('#workReviewName'),
  workReviewMaterial: $('#workReviewMaterial'),
  workReviewSpec: $('#workReviewSpec'),
  workReviewProcess: $('#workReviewProcess'),
  workReviewQty: $('#workReviewQty'),
  workReviewPrice: $('#workReviewPrice'),
  workReviewNote: $('#workReviewNote'),
  workReviewError: $('#workReviewError'),
  workReviewSave: $('#workReviewSave'),
  workReviewReject: $('#workReviewReject'),
  workReviewApprove: $('#workReviewApprove'),
  historySummary: $('#historySummary'),
  historySearch: $('#historySearch'),
  historyDate: $('#historyDate'),
  historyClear: $('#historyClear'),
  historyToday: $('#historyToday'),
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
  replacementDueDate: $('#replacementDueDate'),
  replacementRemark: $('#replacementRemark'),
  replacementAdd: $('#replacementAdd'),
  photoArchiveOpen: $('#photoArchiveOpen'),
  photoArchiveCount: $('#photoArchiveCount'),
  photoCaptureModal: $('#photoCaptureModal'),
  photoCaptureClose: $('#photoCaptureClose'),
  photoCaptureCancel: $('#photoCaptureCancel'),
  photoFile: $('#photoFile'),
  photoChoose: $('#photoChoose'),
  photoPreviewWrap: $('#photoPreviewWrap'),
  photoPreview: $('#photoPreview'),
  photoNote: $('#photoNote'),
  photoMaterialSearch: $('#photoMaterialSearch'),
  photoMaterialList: $('#photoMaterialList'),
  photoUnitQtyList: $('#photoUnitQtyList'),
  photoSave: $('#photoSave'),
  photoArchiveModal: $('#photoArchiveModal'),
  photoArchiveClose: $('#photoArchiveClose'),
  photoArchiveList: $('#photoArchiveList'),
  photoViewerModal: $('#photoViewerModal'),
  photoViewerClose: $('#photoViewerClose'),
  photoViewerRetake: $('#photoViewerRetake'),
  photoViewerMeta: $('#photoViewerMeta'),
  photoViewerImage: $('#photoViewerImage'),
  sampleApprovalSelectModal: $('#sampleApprovalSelectModal'),
  sampleApprovalSelectList: $('#sampleApprovalSelectList'),
  sampleApprovalSelectSearch: $('#sampleApprovalSelectSearch'),
  sampleApprovalSelectClose: $('#sampleApprovalSelectClose'),
  sampleApprovalSelectCancel: $('#sampleApprovalSelectCancel'),
  sampleApprovalSelectConfirm: $('#sampleApprovalSelectConfirm'),
  sampleApprovalPreviewModal: $('#sampleApprovalPreviewModal'),
  sampleApprovalPreviewMeta: $('#sampleApprovalPreviewMeta'),
  sampleApprovalPreviewFrame: $('#sampleApprovalPreviewFrame'),
  sampleApprovalPreviewClose: $('#sampleApprovalPreviewClose'),
  sampleApprovalPreviewCancel: $('#sampleApprovalPreviewCancel'),
  sampleApprovalPreviewPrint: $('#sampleApprovalPreviewPrint'),
  mobileOffsetBox: $('#mobileOffsetBox'),
  mobileEmpty: $('#mobileEmpty'),
  mobileEntryPanel: $('#mobileEntryPanel'),
  mobileRemainingPanel: $('#mobileRemainingPanel'),
  remainingSearch: $('#remainingSearch'),
  remainingDateChips: $('#remainingDateChips'),
  remainingDateClear: $('#remainingDateClear'),
  remainingPrint: $('#remainingPrint'),
  remainingSampleApproval: $('#remainingSampleApproval'),
  remainingExport: $('#remainingExport'),
  remainingList: $('#remainingList'),
  desktopRemainingSearch: $('#desktopRemainingSearch'),
  desktopRemainingDateChips: $('#desktopRemainingDateChips'),
  desktopRemainingDateClear: $('#desktopRemainingDateClear'),
  desktopRemainingPrint: $('#desktopRemainingPrint'),
  desktopLabelPrint: $('#desktopLabelPrint'),
  desktopRemainingSampleApproval: $('#desktopRemainingSampleApproval'),
  labelPrintModal: $('#labelPrintModal'),
  labelPrintRows: $('#labelPrintRows'),
  labelPrintSummary: $('#labelPrintSummary'),
  labelPrintSelectAll: $('#labelPrintSelectAll'),
  labelPrintSearch: $('#labelPrintSearch'),
  labelPrintModes: $('#labelPrintModes'),
  labelPrintTip: $('#labelPrintTip'),
  labelPrintShowPrinted: $('#labelPrintShowPrinted'),
  labelPrintPrintedInfo: $('#labelPrintPrintedInfo'),
  labelPrintError: $('#labelPrintError'),
  labelPrintClose: $('#labelPrintClose'),
  labelPrintCancel: $('#labelPrintCancel'),
  labelPrintConfirm: $('#labelPrintConfirm'),
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
  taskStatusBar: $('#taskStatusBar'),
  taskStatusText: $('#taskStatusText'),
  taskStatusAction: $('#taskStatusAction'),
  taskStatusClose: $('#taskStatusClose'),
  toast: $('#toast'),
  orderEditModal: $('#orderEditModal'),
  orderEditInfo: $('#orderEditInfo'),
  orderEditQty: $('#orderEditQty'),
  orderEditShipped: $('#orderEditShipped'),
  orderEditType: $('#orderEditType'),
  orderEditDue: $('#orderEditDue'),
  orderEditError: $('#orderEditError'),
  orderEditClose: $('#orderEditClose'),
  orderEditCancel: $('#orderEditCancel'),
  orderEditSave: $('#orderEditSave'),
  accessCodeModal: $('#accessCodeModal'),
  accessCodeInput: $('#accessCodeInput'),
  accessCodeError: $('#accessCodeError'),
  accessCodeClose: $('#accessCodeClose'),
  accessCodeCancel: $('#accessCodeCancel'),
  accessCodeSave: $('#accessCodeSave'),
  brandTitle: $('#brandTitle'),
  mobileBrandTitle: $('#mobileBrandTitle'),
  switchCodeButton: $('#switchCodeButton'),
  mobileSwitchCode: $('#mobileSwitchCode'),
  drawingSearch: $('#drawingSearch'),
  drawingCategoryTabs: $('#drawingCategoryTabs'),
  drawingList: $('#drawingList'),
  drawingCount: $('#drawingCount'),
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const fmt = (value) => numberFormat.format(Number(value || 0));
const searchable = (order) => [order.po, order.material, order.name, order.spec, order.batch, order.seq, order.customer, order.orderQty, order.shipped, order.remaining, order.remark, order.replacementPlanId, order.isReplacementPlan ? '补发 补货' : ''].join(' ').toLowerCase();

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

// 同一个交货日期内，特殊订单排在普通订单前面（承样 → 试制 → 工装），方便一眼看到
const ORDER_TYPE_LABELS = { trial: '试制', sample: '承样', tooling: '工装' };
const normalizeOrderType = (order) => {
  const type = String((order && order.orderType) || 'normal');
  return Object.prototype.hasOwnProperty.call(ORDER_TYPE_LABELS, type) ? type : 'normal';
};
const ORDER_TYPE_RANK = { sample: 0, trial: 1, tooling: 2 };
const orderTypeRank = (order) => {
  const type = normalizeOrderType(order);
  return Object.prototype.hasOwnProperty.call(ORDER_TYPE_RANK, type) ? ORDER_TYPE_RANK[type] : 9;
};
const orderTypeTagHtml = (type) => {
  const normalized = String(type || '');
  return Object.prototype.hasOwnProperty.call(ORDER_TYPE_LABELS, normalized)
    ? '<span class="order-type-tag order-type-' + normalized + '">' + ORDER_TYPE_LABELS[normalized] + '</span>'
    : '';
};
const remainingTypeTagsHtml = (types, hasReplacement = false) => {
  const specialTypes = [...new Set(types || [])]
    .filter((type) => Object.prototype.hasOwnProperty.call(ORDER_TYPE_LABELS, type))
    .sort((left, right) => ORDER_TYPE_RANK[left] - ORDER_TYPE_RANK[right]);
  return specialTypes.map(orderTypeTagHtml).join('')
    + (hasReplacement ? '<span class="order-type-tag order-type-replacement">补发</span>' : '');
};

function filteredOrders(filter) {
  const active = snapshot.orders.filter((order) => order.remaining > 0);
  if (filter === 'urgent') return active.filter((order) => order.dueDate <= TODAY);
  if (filter === 'dueToday') return active.filter((order) => order.dueDate === TODAY);
  // 试制 / 承样订单（工装订单请用「全部未交」查看）
  if (filter === 'special') return active.filter((order) => ['trial', 'sample'].includes(String(order.orderType || '')));
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
  if (desktopOrderType && desktopOrderType !== 'all') rows = rows.filter((order) => String(order.orderType || 'normal') === desktopOrderType);
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
  // 跟随交货日期排序；同一交期内承样/试制/工装排最上面
  return rows.sort((a, b) => String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'))
    || orderTypeRank(a) - orderTypeRank(b)
    || Number(a.seq || 0) - Number(b.seq || 0));
}

function syncMobileStickyOffsets() {
  if (document.body.dataset.view !== 'mobile') return;
  const head = document.querySelector('.mobile-head');
  const tabs = document.querySelector('.mobile-tabs');
  if (!head || !tabs) return;
  requestAnimationFrame(() => {
    const headHeight = Math.ceil(head.getBoundingClientRect().height || 0);
    const tabsHeight = Math.ceil(tabs.getBoundingClientRect().height || 0);
    document.documentElement.style.setProperty('--mobile-head-height', headHeight + 'px');
    document.documentElement.style.setProperty('--mobile-tabs-bottom', (headHeight + tabsHeight) + 'px');
  });
}

function setLiveStatus(status) {
  const text = status === 'online' ? '实时同步中' : status === 'offline' ? '连接中断' : '正在连接';
  if (els.liveText) els.liveText.textContent = text;
  if (els.desktopLiveText) els.desktopLiveText.textContent = status === 'online' ? '实时同步' : text;
  if (els.mobileLiveLabel) els.mobileLiveLabel.textContent = status === 'online' ? '数据实时同步' : text;
  for (const dot of [els.liveDot, els.desktopLiveDot]) {
    if (!dot) continue;
    dot.classList.toggle('online', status === 'online');
    dot.classList.toggle('offline', status === 'offline');
  }
}

function coreSnapshotForCache(state) {
  if (!state || !Array.isArray(state.orders) || !Array.isArray(state.shipments) || !state.summary) return null;
  return {
    orders: state.orders,
    shipments: state.shipments,
    summary: state.summary,
    source: state.source || {},
    storage: state.storage || {},
    revision: state.revision,
    today: state.today,
    overDeliveries: Array.isArray(state.overDeliveries) ? state.overDeliveries : [],
    overOffsets: Array.isArray(state.overOffsets) ? state.overOffsets : [],
    replacements: Array.isArray(state.replacements) ? state.replacements : [],
    amounts: Array.isArray(state.amounts) ? state.amounts : [],
  };
}

function saveCachedState() {
  const code = getAccessCode();
  if (!code || !snapshot) return;
  const core = coreSnapshotForCache(snapshot);
  if (!core) return;
  try { localStorage.setItem(STATE_CACHE_KEY, JSON.stringify({ code, savedAt: Date.now(), snapshot: core })); } catch {}
}

function restoreCachedState() {
  const code = getAccessCode();
  if (!code) return false;
  try {
    const cached = JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || 'null');
    if (!cached || cached.code !== code || !cached.snapshot) return false;
    if (Date.now() - Number(cached.savedAt || 0) > 24 * 60 * 60 * 1000) return false;
    const cachedSnapshot = cached.snapshot;
    if (!Array.isArray(cachedSnapshot.orders) || !Array.isArray(cachedSnapshot.shipments) || !cachedSnapshot.summary) return false;
    snapshot = cachedSnapshot;
    if (snapshot.today) TODAY = snapshot.today;
    rebuildAmountMap();
    rebuildDrawingMap();
    setLiveStatus('connecting');
    renderAll();
    return true;
  } catch { return false; }
}
async function waitForStateIdle(maxMs = 5000) {
  const started = Date.now();
  while ((refreshing || auxiliaryPromise) && Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function fetchAuxiliaryState() {
  if (auxiliaryPromise) return auxiliaryPromise;
  const promise = (async () => {
    deliveryFilesPromise = null;
    const [amounts, overDeliveries, overOffsets, deliveryFiles, shipmentPhotos, shipmentUnits, replacements, drawings] = await Promise.all([
      boardRole === 'admin' ? loadAmounts() : Promise.resolve([]),
      loadOverDeliveries(),
      loadOverOffsets(),
      loadDeliveryFiles(),
      loadShipmentPhotos(),
      loadShipmentUnits(),
      loadReplacements(),
      loadDrawings(),
      loadBilledStatus(),
    ]);
    auxiliaryLoadedAt = Date.now();
    return { amounts, overDeliveries, overOffsets, deliveryFiles, shipmentPhotos, shipmentUnits, replacements, drawings };
  })();
  auxiliaryPromise = promise.finally(() => { auxiliaryPromise = null; });
  return auxiliaryPromise;
}

async function loadState({ quiet = false, fast = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await requestWithAccessCode(apiUrl('/api/state'), { cache: 'no-store' });
    if (!response.ok) throw new Error('数据加载失败');
    const nextSnapshot = await response.json();
    // 核心表格先渲染；图片、图纸、金额等辅助数据放后台或低频刷新，避免首屏被慢请求拖住。
    const shouldRefreshAuxiliary = !quiet || !snapshot || Date.now() - auxiliaryLoadedAt > 60000;
    const previous = snapshot;
    if (!fast && shouldRefreshAuxiliary) {
      Object.assign(nextSnapshot, await fetchAuxiliaryState());
    } else {
      nextSnapshot.amounts = previous?.amounts || [];
      nextSnapshot.overDeliveries = previous?.overDeliveries || [];
      nextSnapshot.overOffsets = previous?.overOffsets || [];
      nextSnapshot.deliveryFiles = previous?.deliveryFiles || [];
      nextSnapshot.shipmentPhotos = previous?.shipmentPhotos || [];
      nextSnapshot.shipmentUnits = previous?.shipmentUnits || [];
      nextSnapshot.replacements = previous?.replacements || [];
      nextSnapshot.drawings = previous?.drawings || [];
    }
    const changed = !previous || nextSnapshot.revision !== previous.revision || (!fast && shouldRefreshAuxiliary);
    const stateChanged = !previous || nextSnapshot.revision !== previous.revision;
    snapshot = nextSnapshot;
    if (!fast && shouldRefreshAuxiliary) void cleanupInvalidShipmentUnits();
    if (stateChanged) {
      if ('requestIdleCallback' in window) requestIdleCallback(saveCachedState, { timeout: 2000 });
      else setTimeout(saveCachedState, 0);
    }
    stateLoadFailures = 0;
    setLiveStatus('online');
    rebuildAmountMap();
    rebuildDrawingMap();
    if (snapshot.today) TODAY = snapshot.today;
    reconcileSelection();
    if (!quiet || changed) renderAll();
    if (fast && shouldRefreshAuxiliary) {
      const revision = nextSnapshot.revision;
      void fetchAuxiliaryState().then((auxiliary) => {
        if (!snapshot || snapshot.revision !== revision) return;
        Object.assign(snapshot, auxiliary);
        rebuildAmountMap();
        rebuildDrawingMap();
        renderAll();
        void cleanupInvalidShipmentUnits();
      }).catch(() => {});
    }
  } catch (error) {
    stateLoadFailures += 1;
    setLiveStatus(stateLoadFailures >= 2 ? 'offline' : 'connecting');
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
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data }).promise;
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

function detectPdfOrderType(lines, fileName) {
  const firstItem = lines.findIndex((line) => PDF_ITEM_RE.test(line));
  const headerEnd = firstItem > 0 ? Math.min(lines.length, firstItem + 8) : Math.min(lines.length, 18);
  const header = [String(fileName || ''), ...lines.slice(0, headerEnd)].join(' ');
  if (/工装/.test(header)) return 'tooling';
  if (/试制/.test(header)) return 'trial';
  if (/承样|样品采购单|样品订单|带承样资料/.test(header)) return 'sample';

  const legalStart = lines.findIndex((line, index) => index > firstItem && /^\s*1[.．、]\s*订单/.test(line));
  const bodyEnd = legalStart > firstItem ? legalStart : lines.length;
  const body = lines.slice(Math.max(0, firstItem), bodyEnd).join(' ');
  if (/工装/.test(body)) return 'tooling';
  if (/试制/.test(body)) return 'trial';
  if (/承样|带承样资料/.test(body)) return 'sample';
  return 'normal';
}

async function parsePdfOrder(file) {
  const lines = await pdfToLines(file);
  const text = lines.join('\n');
  // pdf.js 常把“采购单号 : PN01-…”抽成冒号前带空格，先统一成紧贴冒号再识别
  const flat = text.replace(/[ \t]*([:：])[ \t]*/g, '$1').replace(/[ \t]+/g, ' ');
  const doc = { file: file.name, po: null, purchaseDate: null, vendor: null, pdfTotal: null, items: [], error: '', warnings: [], poFromFile: false, orderType: 'normal' };
  doc.orderType = detectPdfOrderType(lines, file.name);
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
let pendingPdfDocs = [];

// 选择 PDF 后：逐个识别 -> 弹出核对窗口
async function handlePdfFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  try {
    await loadPdfJs();
  } catch {
    showToast('PDF 识别组件加载失败，请检查网络后重试');
    if (els.pdfFileInput) els.pdfFileInput.value = '';
    return;
  }
  showToast(`正在识别 ${files.length} 个采购订单 PDF...`);
  beginTask('正在识别采购订单 PDF...');
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
    finishTask(okCount === docs.length ? 'PDF 识别完成' : 'PDF 已识别，但有文件需要检查', okCount === docs.length ? 'success' : 'error', 4500);
  } catch (error) {
    if (els.pdfModal) els.pdfModal.hidden = true;
    finishTask('PDF 识别失败', 'error', 5000);
    showToast(error.message || 'PDF 识别失败');
  } finally {
    if (els.pdfFileInput) els.pdfFileInput.value = '';
  }
}

function closePdfModal() {
  if (els.pdfModal) els.pdfModal.hidden = true;
  if (els.pdfFileInput) els.pdfFileInput.value = '';
  pendingPdfRows = [];
  pendingPdfDocs = [];
}

function renderPdfPreview(docs) {
  const showAmounts = boardRole === 'admin' && boardCanSeeAmount;
  const existing = new Set(snapshot.orders.map((o) => String(o.po || '').trim()));
  const rows = [];
  pendingPdfDocs = docs;
  const blocks = docs.map((doc, docIndex) => {
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
        rows.push({ id, customer: company, po: doc.po, purchaseDate: doc.purchaseDate, seq: item.seq, material: item.material, name: item.name, spec: item.spec, orderQty: item.quantity, openingRemaining: item.quantity, dueDate: item.dueDate, unitPrice: item.unitPrice, orderType: doc.orderType, pdfDocIndex: docIndex });
      }
    }
    if (priceNotes.length) warnings.push('单价有变动：' + priceNotes.slice(0, 5).join('；') + (priceNotes.length > 5 ? ` 等 ${priceNotes.length} 处` : ''));
    return { doc, problems, warnings, duplicated, company };
  });
  pendingPdfRows = rows;
  const totalQty = rows.reduce((sum, r) => sum + r.openingRemaining, 0);
  const bad = blocks.filter((b) => b.problems.length);
  const html = blocks.map((b, docIndex) => `
    <div class="pdf-doc${b.problems.length ? ' bad' : b.duplicated ? ' dup' : ''}">
      <div class="pdf-doc-head">
        <strong>${escapeHtml(b.doc.po || b.doc.file)}</strong>
        <span>${b.company ? (b.company === '4137' ? '帆顺金属科技' : '帆顺金属(老)') : '公司未知'} · ${b.doc.items.length} 行 · 数量 ${fmt(b.doc.qtyTotal)}${showAmounts ? ` · 含税金额 ${fmt(b.doc.amountTotal)} · 单价 ${fmt(b.doc.items[0]?.unitPrice)}${b.doc.pdfTotal != null ? ` / PDF ${fmt(b.doc.pdfTotal)}` : ''}` : ''}</span>
      </div>
      <label class="pdf-type-field">
        <span>订单类别</span>
        <select data-pdf-order-type="${docIndex}">
          <option value="normal"${b.doc.orderType === 'normal' ? ' selected' : ''}>普通订单</option>
          <option value="trial"${b.doc.orderType === 'trial' ? ' selected' : ''}>试制订单</option>
          <option value="sample"${b.doc.orderType === 'sample' ? ' selected' : ''}>承样订单</option>
          <option value="tooling"${b.doc.orderType === 'tooling' ? ' selected' : ''}>工装订单</option>
        </select>
      </label>
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

function sampleApprovalCandidateList(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row?.material) continue;
    if (row.orderType && row.orderType !== 'sample') continue;
    const key = [row.po, row.seq, row.material, row.spec].map((value) => String(value || '').trim()).join('|');
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()].sort((left, right) => String(right.dueDate || '').localeCompare(String(left.dueDate || '')) || String(left.material || '').localeCompare(String(right.material || ''), 'zh-CN'));
}

function renderSampleApprovalSelectList() {
  if (!els.sampleApprovalSelectList) return;
  const query = String(els.sampleApprovalSelectSearch?.value || '').trim().toLowerCase();
  sampleApprovalCandidates = sampleApprovalAllCandidates.filter((row) => !query
    || [row.po, row.seq, row.material, row.name, row.spec].join(' ').toLowerCase().includes(query));
  if (sampleApprovalSelectedIndex >= sampleApprovalCandidates.length) sampleApprovalSelectedIndex = 0;
  if (!sampleApprovalCandidates.length) {
    els.sampleApprovalSelectList.innerHTML = '<div class="empty-state"><strong>没有可选承样订单</strong><span>当前范围里没有承样订单。</span></div>';
    return;
  }
  els.sampleApprovalSelectList.innerHTML = sampleApprovalCandidates.map((row, index) => {
    const quantity = Number(row.quantity ?? row.orderQty ?? row.openingRemaining ?? row.remaining ?? 0);
    return `<label class="sample-approval-choice${index === sampleApprovalSelectedIndex ? ' selected' : ''}">
      <input type="radio" name="sampleApprovalChoice" value="${index}"${index === sampleApprovalSelectedIndex ? ' checked' : ''}>
      <span><strong>${escapeHtml(row.material || '')} · ${escapeHtml(row.name || '')}</strong><small>${escapeHtml(row.spec || '')} · 采购单 ${escapeHtml(row.po || '')} · 项次 ${escapeHtml(row.seq || '')} · 交期 ${escapeHtml(formatDate(row.dueDate))}</small></span>
      <em>${escapeHtml(fmt(quantity))} 件</em>
    </label>`;
  }).join('');
}

function openSampleApprovalSelector(rows) {
  sampleApprovalAllCandidates = sampleApprovalCandidateList(rows);
  if (!sampleApprovalAllCandidates.length) { showToast('没有可打印的承样订单'); return; }
  sampleApprovalSelectedIndex = 0;
  if (els.sampleApprovalSelectSearch) els.sampleApprovalSelectSearch.value = '';
  renderSampleApprovalSelectList();
  if (els.sampleApprovalSelectModal) els.sampleApprovalSelectModal.hidden = false;
}

function closeSampleApprovalSelector() { if (els.sampleApprovalSelectModal) els.sampleApprovalSelectModal.hidden = true; }

function closeSampleApprovalPreview() {
  if (els.sampleApprovalPreviewModal) els.sampleApprovalPreviewModal.hidden = true;
  if (els.sampleApprovalPreviewFrame) els.sampleApprovalPreviewFrame.src = 'about:blank';
  if (sampleApprovalPreviewObjectUrl) { URL.revokeObjectURL(sampleApprovalPreviewObjectUrl); sampleApprovalPreviewObjectUrl = ''; }
}

async function openSampleApprovalPreview(row) {
  const result = await printSampleApprovals([row], { previewOnly: true });
  const item = result?.results?.[0];
  if (!item?.previewPdfBase64) { showToast('承认书预览生成失败'); return; }
  const binary = atob(item.previewPdfBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (sampleApprovalPreviewObjectUrl) URL.revokeObjectURL(sampleApprovalPreviewObjectUrl);
  sampleApprovalPreviewObjectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  sampleApprovalPreviewRows = [row];
  sampleApprovalPreviewToken = String(item.previewToken || '');
  if (els.sampleApprovalPreviewFrame) els.sampleApprovalPreviewFrame.src = sampleApprovalPreviewObjectUrl;
  if (els.sampleApprovalPreviewMeta) {
    const quantity = Number(row.quantity ?? row.orderQty ?? row.openingRemaining ?? row.remaining ?? 0);
    els.sampleApprovalPreviewMeta.textContent = `${row.material || ''} · ${row.name || ''} · ${row.spec || ''} · ${fmt(quantity)} 件 · 交期 ${escapeHtml(formatDate(row.dueDate || snapshot?.today || TODAY))}`;
  }
  if (els.sampleApprovalPreviewModal) els.sampleApprovalPreviewModal.hidden = false;
}

function confirmSampleApprovalSelection() {
  const row = sampleApprovalCandidates[sampleApprovalSelectedIndex];
  if (!row) { showToast('请先选择一个承样订单'); return; }
  closeSampleApprovalSelector();
  void openSampleApprovalPreview(row);
}

async function printSampleApprovalPreview() {
  if (!sampleApprovalPreviewRows.length) return;
  const button = els.sampleApprovalPreviewPrint;
  const originalText = button?.textContent || '确认打印';
  if (button) { button.disabled = true; button.textContent = '正在打印...'; }
  try {
    const result = await printSampleApprovals(sampleApprovalPreviewRows, { previewToken: sampleApprovalPreviewToken });
    if (result) closeSampleApprovalPreview();
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}
async function printSampleApprovals(rows, options = {}) {
  const orders = (rows || []).map((row) => ({
    po: row.po || '',
    seq: row.seq || '',
    material: row.material || '',
    name: row.name || '',
    spec: row.spec || '',
    quantity: Number(row.quantity ?? row.orderQty ?? row.openingRemaining ?? 0),
    customer: row.customer || '',
    orderType: 'sample',
    date: row.dueDate || snapshot?.today || TODAY,
  })).filter((row) => row.material);
  if (!orders.length) return null;
  const generateOnly = Boolean(options.generateOnly);
  const previewOnly = Boolean(options.previewOnly);
  // 预览刚由打印助手生成过，确认打印时直接复用预览缓存，不再多走一次 /ping。
  if (!options.previewToken) {
    try {
      const health = await fetch(`${PRINT_HELPER_BASE}/ping`, { cache: 'no-store' });
      if (!health.ok) throw new Error('打印助手没有响应');
    } catch {
      showToast(generateOnly ? '无法生成样品承认书：请先启动发货单打印助手' : '样品承认书没有打印：请先启动发货单打印助手', 9000);
      return null;
    }
  }
  try {
    const response = await fetch(`${PRINT_HELPER_BASE}/sample-approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orders, dryRun: generateOnly || previewOnly, preview: previewOnly, previewToken: options.previewToken || '' }) });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || '样品承认书处理失败');
    if (previewOnly) return result;
    if (generateOnly) {
      const generated = (result.results || []).filter((item) => item.approvalGenerated).length;
      showToast(`已生成 ${generated} 份样品承认书`, 5000);
      return result;
    }
    const printed = (result.results || []).filter((item) => item.approvalPrinted).length;
    const drawings = (result.results || []).filter((item) => item.drawingPrinted).length;
    showToast(`样品承认书已发送打印 ${printed} 份，图纸 ${drawings} 份`, 7000);
    return result;
  } catch (error) {
    showToast((generateOnly ? '样品承认书生成失败：' : '样品承认书打印失败：') + (error.message || '请检查打印助手'), 9000);
    return null;
  }
}
async function printRemainingSampleApprovals(searchText) {
  const rows = (snapshot?.orders || []).filter((row) => String(row.orderType || '') === 'sample');
  if (!rows.length) { showToast('系统里还没有承样订单'); return; }
  openSampleApprovalSelector(rows);
}

async function generateAndPromptSampleApprovals(rows) {
  const result = await printSampleApprovals(rows, { generateOnly: true });
  if (!result) return false;
  const names = (result.results || []).map((item) => item.material).filter(Boolean).join('、');
  const message = `样品承认书已生成${names ? '：' + names : ''}。\n现在去打印吗？`;
  if (!window.confirm(message)) {
    showToast('样品承认书已生成，已保留在打印助手的 sample-approval 文件夹里', 8000);
    return false;
  }
  return printSampleApprovals(rows);
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
  beginTask('正在导入采购订单...');
  try {
    const result = await callRpc('board_add_orders', { p_code: getAccessCode(), p_orders: pendingPdfRows });
    if (!result.response.ok) throw new Error(result.data?.message || '导入失败');
    const count = Number(result.data?.count || pendingPdfRows.length);
    // 订单类别：试制 / 承样 / 工装
    // 注意：pendingPdfRows 里的 id 是本地拼的“采购单号#项次”，不是数据库订单 id，
    // 直接拿它调 board_set_order_type 会失败（之前就是这样静默丢掉了类型）。
    // 所以先刷新一次状态，用「单号 + 项次 + 物料」找到真实订单 id 再设置。
    const typedRows = pendingPdfRows.filter((row) => row.orderType && row.orderType !== 'normal');
    if (typedRows.length) {
      await loadState({ quiet: true });
      let typedOk = 0;
      for (const row of typedRows) {
        const target = (snapshot?.orders || []).find((order) => String(order.po || '').trim() === String(row.po || '').trim()
          && String(order.seq || '').trim() === String(row.seq || '').trim()
          && String(order.material || '').trim() === String(row.material || '').trim());
        if (!target) continue;
        try {
          const r = await callRpc('board_set_order_type', { p_code: getAccessCode(), p_order_id: target.id, p_order_type: row.orderType });
          if (r.response.ok) typedOk += 1;
        } catch { }
      }
      if (typedOk) showToast(`已把 ${typedOk} 条标记为${{ trial: '试制', sample: '承样', tooling: '工装' }[typedRows[0].orderType] || '特殊'}订单`);
      else showToast('订单类型没能写入，请在「订单变更」里手动设置', 6000);
    }
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
    finishTask('采购订单导入完成', 'success', 3000);
    openSampleApprovalSelector(typedRows.filter((row) => row.orderType === 'sample'));
  } catch (error) {
    finishTask('采购订单导入失败', 'error', 5000);
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

async function loadDrawings() {
  if (!RPC_BASE) return [];
  const code = getAccessCode();
  if (!code) return [];
  try {
    const r = await callRpc('board_get_drawings', { p_code: code });
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
  // 普通端实时总览不显示单价 / 金额（本身也没有数据）
  document.body.dataset.boardRole = isAdmin ? 'admin' : 'user';
  const el = document.getElementById('brandTitle');
  if (el) el.innerHTML = `帆顺科技${isAdmin ? '<small>（管理员）</small>' : ''}`;
  if (!isAdmin) desktopModule = 'shipment';
  setDesktopModule(desktopModule, desktopView);
  if (!isAdmin && mobileModule === 'workReview') mobileModule = 'entry';
  renderMobileModule();
  const el2 = document.getElementById('mobileBrandTitle');
  if (el2) el2.textContent = '帆顺科技' + suffix;
  const el3 = document.getElementById('mobileBrandModule');
  if (el3) el3.textContent = mobileModule === 'workReview' ? '报工审核' : '装车登记';
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

let drawingMap = new Map();

function rebuildDrawingMap() {
  const rows = (snapshot && Array.isArray(snapshot.drawings)) ? snapshot.drawings : [];
  drawingMap = new Map();
  const put = (key, row) => { if (!drawingMap.has(key)) drawingMap.set(key, row); };
  for (const row of rows) {
    const material = String(row.material || '').trim();
    const spec = String(row.spec || '').trim();
    const category = String(row.category || 'formal');
    put(`${material}\u0000${spec}\u0000${category}`, row);
    put(`${material}\u0000\u0000${category}`, row);
    put(`${material}\u0000${spec}\u0000formal`, row);
    put(`${material}\u0000\u0000formal`, row);
    put(`${material}\u0000${spec}`, row);
    put(`${material}\u0000`, row);
  }
}

function drawingFor(order) {
  const material = String(order.material || '').trim();
  const spec = String(order.spec || '').trim();
  const category = ({ trial: 'trial', sample: 'sample', tooling: 'tooling' })[order.orderType] || 'formal';
  return drawingMap.get(`${material}\u0000${spec}\u0000${category}`)
    || drawingMap.get(`${material}\u0000\u0000${category}`)
    || drawingMap.get(`${material}\u0000${spec}\u0000formal`)
    || drawingMap.get(`${material}\u0000\u0000formal`)
    || drawingMap.get(`${material}\u0000${spec}`)
    || drawingMap.get(`${material}\u0000`)
    || null;
}

function drawingPublicUrl(drawing) {
  const storagePath = String(drawing?.storagePath || '').trim();
  if (!storagePath) return '';
  const origin = String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
  if (!origin) return '';
  return `${origin}/storage/v1/object/public/product-drawings/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
}

let drawingViewerTask = null;
let drawingViewerPdf = null;
let drawingViewerBlobUrl = '';
let drawingViewerPageNumber = 0;
let drawingViewerTotalPages = 0;
let drawingViewerRenderToken = 0;
let pdfJsPromise = null;

function drawingLinkHtml(drawing, label = '图纸') {
  return `<button type="button" class="drawing-link" data-drawing-id="${escapeHtml(drawing.id)}">${label}</button>`;
}

function closeDrawingViewer() {
  const modal = document.getElementById('drawingViewer');
  const pages = document.getElementById('drawingViewerPages');
  try { if (drawingViewerTask?.destroy) drawingViewerTask.destroy(); } catch { }
  try { if (drawingViewerPdf?.destroy) drawingViewerPdf.destroy(); } catch { }
  drawingViewerTask = null;
  drawingViewerPdf = null;
  if (drawingViewerBlobUrl) {
    try { URL.revokeObjectURL(drawingViewerBlobUrl); } catch { }
    drawingViewerBlobUrl = '';
  }
  if (pages) pages.innerHTML = '';
  if (modal) modal.hidden = true;
  document.body.style.overflow = '';
}

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('./vendor/pdf.min.mjs').then((pdfjs) => {
      if (pdfjs.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
      }
      window.pdfjsLib = pdfjs;
      return pdfjs;
    }).catch(async (error) => {
      if (window.pdfjsLib) return window.pdfjsLib;
      throw error;
    });
  }
  return pdfJsPromise;
}

async function renderDrawingPdf(pdf) {
  const modal = document.getElementById('drawingViewer');
  const pages = document.getElementById('drawingViewerPages');
  const status = document.getElementById('drawingViewerStatus');
  const pager = document.getElementById('drawingViewerPager');
  if (!pdf || !pages || !status || !modal) return;
  const total = Number(pdf.numPages || 0);
  pages.innerHTML = '';
  if (pager) pager.hidden = true;
  status.hidden = false;
  if (total <= 0) { status.textContent = '这份图纸没有可显示的页面'; return; }
  const availableWidth = Math.max(280, Math.min((pages.clientWidth || window.innerWidth) - 8, 1100));
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    if (!modal || modal.hidden) return;
    status.textContent = `正在加载第 ${pageNumber} / ${total} 页...`;
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.8, Math.max(0.6, availableWidth / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    pages.appendChild(canvas);
    const renderContext = { canvasContext: canvas.getContext('2d'), viewport };
    if (pixelRatio !== 1) renderContext.transform = [pixelRatio, 0, 0, pixelRatio, 0, 0];
    await page.render(renderContext).promise;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  status.textContent = `共 ${total} 页`;
}

function drawingPreviewUrl(drawing) {
  const storagePath = String(drawing?.storagePath || '').trim();
  if (!storagePath) return '';
  const origin = String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
  if (!origin) return '';
  const previewPath = storagePath.replace(/\.pdf$/i, '') + '-p1.jpg';
  return `${origin}/storage/v1/object/public/product-drawings/${previewPath.split('/').map(encodeURIComponent).join('/')}`;
}

let drawingPreviewManifestPromise = null;

function drawingPreviewPageUrl(drawing, page) {
  const storagePath = String(drawing?.storagePath || '').trim();
  if (!storagePath) return '';
  const origin = String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
  if (!origin) return '';
  const previewPath = storagePath.replace(/\.pdf$/i, '') + `-p${page}.jpg`;
  return `${origin}/storage/v1/object/public/product-drawings/${previewPath.split('/').map(encodeURIComponent).join('/')}`;
}

async function loadDrawingPreviewManifest() {
  if (!drawingPreviewManifestPromise) {
    const origin = String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
    const url = `${origin}/storage/v1/object/public/product-drawings/_previews.json`;
    drawingPreviewManifestPromise = fetch(url, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : {})
      .catch(() => ({}));
  }
  return drawingPreviewManifestPromise;
}

async function renderDrawingImagePreview(drawing) {
  const modal = document.getElementById('drawingViewer');
  const pages = document.getElementById('drawingViewerPages');
  const status = document.getElementById('drawingViewerStatus');
  const storagePath = String(drawing?.storagePath || '').trim();
  if (!modal || !pages || !status || !storagePath) return false;
  const manifest = await loadDrawingPreviewManifest();
  const pageCount = Math.max(1, Math.min(200, Number(manifest?.[storagePath] || 1)));
  const firstUrl = drawingPreviewPageUrl(drawing, 1);
  if (!firstUrl) return false;
  const images = document.createDocumentFragment();
  for (let page = 1; page <= pageCount; page += 1) {
    const image = new Image();
    image.alt = `${[drawing?.material, drawing?.name, drawing?.spec].filter(Boolean).join(' · ') || '图纸'} 第 ${page} 页`;
    image.decoding = 'async';
    image.loading = page === 1 ? 'eager' : 'lazy';
    image.src = drawingPreviewPageUrl(drawing, page);
    images.appendChild(image);
  }
  pages.replaceChildren(images);
  status.hidden = false;
  status.textContent = `图纸预览 · 共 ${pageCount} 页`;
  return true;
}

async function openDrawingViewer(drawing, url, options = {}) {
  const modal = document.getElementById('drawingViewer');
  const title = document.getElementById('drawingViewerTitle');
  const status = document.getElementById('drawingViewerStatus');
  const external = document.getElementById('drawingViewerExternal');
  const pager = document.getElementById('drawingViewerPager');
  if (!modal || !url) { showToast('图纸地址无效'); return; }
  closeDrawingViewer();
  drawingViewerBlobUrl = options.revokeOnClose ? url : '';
  if (title) title.textContent = [drawing?.material, drawing?.name, drawing?.spec].filter(Boolean).join(' · ') || '图纸查看';
  if (external) external.href = url;
  if (pager) pager.hidden = true;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  try {
    if (await renderDrawingImagePreview(drawing)) return;
    if (status) {
      status.hidden = false;
      status.textContent = '正在加载 PDF 图纸...';
    }
    const pdfjs = await loadPdfJs();
    if (!modal.hidden) {
      drawingViewerTask = pdfjs.getDocument({ url, isEvalSupported: false });
      const pdf = await drawingViewerTask.promise;
      drawingViewerPdf = pdf;
      drawingViewerTotalPages = Number(pdf.numPages || 0);
      if (!modal.hidden) await renderDrawingPdf(pdf);
    }
  } catch (error) {
    if (status) {
      status.hidden = false;
      status.textContent = `图纸加载失败：${error?.message || '请点击“新窗口打开”'}`;
    }
  }
}

async function openDrawing(id) {
  const cached = (snapshot?.drawings || []).find((row) => String(row.id) === String(id));
  const directUrl = drawingPublicUrl(cached);
  if (directUrl) {
    await openDrawingViewer(cached, directUrl);
    return;
  }
  try {
    const result = await callRpc('board_get_drawing', { p_code: getAccessCode(), p_id: id });
    if (!result.response.ok) throw new Error(result.data?.message || '图纸读取失败');
    const row = result.data || {};
    const storageUrl = drawingPublicUrl({ storagePath: row.storagePath });
    if (storageUrl) {
      await openDrawingViewer(row, storageUrl);
      return;
    }
    if (!row.contentBase64) throw new Error(row.message || '图纸读取失败');
    const binary = atob(String(row.contentBase64));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    await openDrawingViewer(row, objectUrl, { revokeOnClose: true });
  } catch (error) {
    showToast(error.message || '图纸打开失败');
  }
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
  // 优先读云端。这样换电脑、手机打开同一网址也能看到“已开单”。
  if (RPC_BASE) {
    const accessCode = getAccessCode();
    if (accessCode) {
      try {
        const result = await callRpc('board_get_billed_status', { p_code: accessCode });
        if (result.response.ok && result.data) {
          billedShipmentIds = new Set((result.data.shipments || []).map((value) => String(value)));
          billedExtraIds = new Set((result.data.extras || []).map((value) => String(value)));
          return;
        }
      } catch { }
    }
  }
  // 云端接口尚未安装时，退回本机打印助手。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${PRINT_HELPER_BASE}/billed-status`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return;
    const data = await response.json();
    billedShipmentIds = new Set((data.shipments || []).map((value) => String(value)));
    billedExtraIds = new Set((data.extras || []).map((value) => String(value)));
  } catch {
    // 云端和本机都不可用时，不影响看板其他功能。
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
  const rows = await fetchDeliveryFileRows();
  return rows.filter((row) => String(row.kind || '') !== PHOTO_FILE_KIND && String(row.kind || '') !== UNIT_FILE_KIND);
}

async function loadShipmentPhotos() {
  const rows = await fetchDeliveryFileRows();
  return rows.filter((row) => String(row.kind || '') === PHOTO_FILE_KIND).map(normalizePhotoRow);
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

function replacementPlanRemark(remark) {
  return REPLACEMENT_PLAN_MARK + String(remark || '').trim();
}

function replacementPlanNote(row) {
  return String(row?.remark || '').replace(REPLACEMENT_PLAN_MARK, '').trim();
}

function isReplacementPlanRow(row) {
  return String(row?.remark || '').startsWith(REPLACEMENT_PLAN_MARK);
}

function planAlreadyFinalized(plan) {
  const key = [plan.material, plan.name, plan.spec, plan.deliveryDate, Number(plan.quantity || 0)].map((value) => String(value ?? '').trim()).join('|');
  return confirmedReplacements().some((row) => [row.material, row.name, row.spec, row.deliveryDate, Number(row.quantity || 0)].map((value) => String(value ?? '').trim()).join('|') === key);
}

function replacementPlans() {
  return replacements().filter((row) => isReplacementPlanRow(row) && !planAlreadyFinalized(row));
}

function replacementPlanRemainingRows() {
  return replacementPlans().map((plan) => ({
    id: 'replacement-plan:' + String(plan.id || ''),
    material: String(plan.material || '').trim(),
    name: String(plan.name || '').trim(),
    spec: String(plan.spec || '').trim(),
    po: '补发',
    seq: '',
    customer: String(plan.customer || '4137').trim() || '4137',
    dueDate: String(plan.deliveryDate || '').trim() || defaultReplacementDueDate(),
    remaining: Number(plan.quantity || 0),
    orderType: 'normal',
    isReplacementPlan: true,
    replacementPlanId: String(plan.id || ''),
    orderId: String(plan.orderId || ''),
    po: String(plan.po || ''),
    seq: String(plan.seq ?? ''),
    remark: replacementPlanNote(plan),
    createdAt: String(plan.createdAt || ''),
  })).filter((row) => row.remaining > 0 && row.material);
}

function confirmedReplacements() {
  return replacements().filter((row) => !isReplacementPlanRow(row));
}

function replacementHistoryRows() {
  const query = replacementQuery.trim().toLowerCase();
  return confirmedReplacements()
    .filter((row) => {
      if (replacementDate && String(row.deliveryDate || '') !== replacementDate) return false;
      if (!query) return true;
      return [row.material, row.name, row.spec, row.remark, row.deliveryDate]
        .some((value) => String(value ?? '').toLowerCase().includes(query));
    })
    // 最新的补发在最上面
    .sort((a, b) => String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || ''))
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
function renderReplacementList() {
  const rows = replacementHistoryRows();
  if (!rows.length) return '';
  return `
    <section class="over-box">
      <div class="over-head"><strong>补发记录</strong><span>${rows.length} 笔</span></div>
      ${rows.map((row) => `
        <div class="over-row">
          <span class="mono">${escapeHtml(row.material)}</span>
          <span>${escapeHtml(row.name || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}${row.remark ? ' · 备注：' + escapeHtml(row.remark) : ''}<br><em>日期：${escapeHtml(row.deliveryDate || '')}</em></span>
          <strong>${fmt(row.quantity)} 件</strong>
          ${isLockedRecord(row.createdAt) || isBilledExtra(row.id)
            ? `<span class="row-locked" title="${isBilledExtra(row.id) ? '已开送货单并上传云端，不能撤回' : '登记满 7 天后不能再撤回'}">${isBilledExtra(row.id) ? '已开单' : '已归档'}</span>`
            : `<button type="button" class="row-revoke" data-revoke-replacement="${escapeHtml(row.id)}">撤回</button>`}
        </div>`).join('')}
      
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

function drawingCategoryLabel(category) {
  return ({ trial: '试制图纸', sample: '承样图纸', tooling: '工装图纸', formal: '正式图纸' })[category] || '正式图纸';
}

function drawingCategoryIcon(category) {
  const icon = ({
    trial: '<path d="M9 3h6"></path><path d="M10 3v5.7L5.2 17a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 8.7V3"></path><path d="M8.2 14h7.6"></path>',
    sample: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"></path><path d="M4 7.5 12 12l8-4.5"></path><path d="M12 12v9"></path>',
    tooling: '<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.3 2.3-2.7-.7-.7-2.7z"></path>',
    formal: '<path d="M7 3h6l4 4v14H7z"></path><path d="M13 3v5h5"></path><path d="m9.5 15 1.6 1.6 3.4-3.6"></path>',
  })[category] || '<path d="M7 3h6l4 4v14H7z"></path><path d="M13 3v5h5"></path>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
}

function renderDesktopDrawings() {
  if (!els.drawingList) return;
  const query = drawingQuery.trim().toLowerCase();
  const rank = { formal: 0, trial: 1, sample: 2, tooling: 3 };
  const rows = (snapshot?.drawings || []).filter((row) => {
    if (drawingCategory !== 'all' && String(row.category || 'formal') !== drawingCategory) return false;
    if (!query) return true;
    return [row.material, row.name, row.spec, row.fileName].join(' ').toLowerCase().includes(query);
  }).sort((a, b) => {
    const ac = String(a.category || 'formal');
    const bc = String(b.category || 'formal');
    return (rank[ac] ?? 9) - (rank[bc] ?? 9)
      || String(a.material || '').localeCompare(String(b.material || ''), 'zh-CN')
      || String(a.spec || '').localeCompare(String(b.spec || ''), 'zh-CN');
  });
  if (els.drawingCount) els.drawingCount.textContent = `${rows.length} 份图纸`;
  els.drawingList.innerHTML = rows.length ? `
    <div class="drawing-list-head" aria-hidden="true"><span>料号</span><span>图纸名称 / 规格</span><span>操作</span></div>
    ${rows.map((row) => {
      const category = String(row.category || 'formal');
      const label = drawingCategoryLabel(category);
      const fileName = String(row.fileName || '');
      return `
        <div class="drawing-row" data-category="${escapeHtml(category)}">
          <span class="drawing-material mono">${escapeHtml(row.material)}</span>
          <div class="drawing-main" title="${escapeHtml(`${label} · ${fileName}`)}">
            <span class="drawing-type-icon" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${drawingCategoryIcon(category)}</span>
            <span class="drawing-name">${escapeHtml(row.name || '未命名图纸')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</span>
          </div>
          <button type="button" class="file-download drawing-open" data-drawing-id="${escapeHtml(row.id)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h8l4 4v16H6z"></path><path d="M14 2v5h5"></path><path d="M9 13h6"></path><path d="M9 17h4"></path></svg>
            <span>查看图纸</span>
          </button>
        </div>`;
    }).join('')}
  ` : '<div class="empty-state"><strong>没有匹配的图纸</strong><span>试试输入料号、品名、图号或文件名。</span></div>';
}

// 云端送货单：独立页面（电脑端一个页面、手机端一个标签），Excel 和 PDF 各一份
function syncFileDateOptions(select, current, reset) {
  if (!select || select.tagName !== 'SELECT') return;
  // 每个发货日期对应哪些送货单编号（不显示条数）
  const batchesByDay = new Map();
  for (const file of deliveryFiles()) {
    const day = String(file.deliveryDate || '').slice(0, 10);
    if (!day) continue;
    if (!batchesByDay.has(day)) batchesByDay.set(day, []);
    const batch = deliveryBatchText(file.deliveryBatch != null ? file.deliveryBatch : file.batch);
    const list = batchesByDay.get(day);
    if (batch && !list.includes(batch)) list.push(batch);
  }
  const days = [...batchesByDay.keys()].sort((a, b) => b.localeCompare(a));
  const label = (day) => {
    const list = batchesByDay.get(day) || [];
    if (!list.length) return day;
    list.sort((a, b) => String(b).localeCompare(String(a), 'zh-CN'));
    return `${day}｜送货单 ${list.join('、')}`;
  };
  const wanted = current || select.value || '';
  const options = ['<option value="">全部日期</option>']
    .concat(days.map((day) => `<option value="${escapeHtml(day)}">${escapeHtml(label(day))}</option>`));
  const html = options.join('');
  if (select.dataset.signature !== html) {
    select.innerHTML = html;
    select.dataset.signature = html;
  }
  const exists = days.includes(wanted);
  select.value = exists ? wanted : '';
  if (wanted && !exists) reset();
}
function syncFileDateOptionsAll() {
  syncFileDateOptions(els.filesDate, filesDate, () => { filesDate = ''; });
  syncFileDateOptions(els.mobileFilesDate, mobileFilesDate, () => { mobileFilesDate = ''; });
}
function renderCloudFiles() {
  syncFileDateOptionsAll();
  const desktopHtml = renderDeliveryFiles(filesDate, filesQuery);
  if (els.cloudFileList) els.cloudFileList.innerHTML = desktopHtml || '<div class="empty-state"><strong>还没有上传过送货单</strong><span>在打印助手预览页点“确认上传到云端”就会出现在这里。</span></div>';

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
      <div class="over-head"><strong>送货单明细</strong></div>
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
  return overDeliveries()
    .filter((row) => {
      if (overDate && recordDay(row.createdAt) !== overDate) return false;
      if (!q) return true;
      return [row.material, row.name, row.spec, row.customer, row.quantity, row.remaining].join(' ').toLowerCase().includes(q);
    })
    // 最新登记的在最上面
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function offsetFilteredRows() {
  const q = offsetQuery.trim().toLowerCase();
  return overOffsets()
    .filter((row) => {
      if (offsetDate && recordDay(row.appliedAt) !== offsetDate) return false;
      if (!q) return true;
      const meta = orderMetaSearchText(row.orderId, row);
      return [row.material, row.name, row.spec, row.orderId, row.customer, meta].join(' ').toLowerCase().includes(q);
    })
    // 最新冲抵的在最上面
    .sort((a, b) => String(b.appliedAt || '').localeCompare(String(a.appliedAt || '')));
}

function renderOverDeliveryList() {
  const rows = overFilteredRows();
  if (!rows.length) return '';
  // 同一料件编号合并成一笔展示，数量相加
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.material || '').trim();
    const billed = isBilledExtra(row.id);
    const locked = billed || isLockedRecord(row.createdAt);
    const current = groups.get(key);
    if (current) {
      current.quantity += Number(row.quantity || 0);
      current.remaining += Number(row.remaining || 0);
      current.ids.push(String(row.id));
      current.billed = current.billed || billed;
      current.locked = current.locked || locked;
      if (!current.name && row.name) current.name = row.name;
      if (!current.spec && row.spec) current.spec = row.spec;
    } else {
      groups.set(key, {
        material: row.material,
        name: row.name,
        spec: row.spec,
        quantity: Number(row.quantity || 0),
        remaining: Number(row.remaining || 0),
        ids: [String(row.id)],
        billed,
        locked,
      });
    }
  }
  const list = [...groups.values()];
  const total = list.reduce((sum, row) => sum + Number(row.remaining || 0), 0);
  return `
    <section class="over-box">
      <div class="over-head"><strong>无订单发货（待后续订单冲抵）</strong><span>${list.length} 项 · ${fmt(total)} 件</span></div>
      ${list.map((row) => `
        <div class="over-row">
          <span class="mono">${escapeHtml(row.material)}</span>
          <span>${escapeHtml(row.name || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}${row.ids.length > 1 ? `<br><em class="over-meta">合并 ${row.ids.length} 笔登记</em>` : ''}</span>
          <strong>${fmt(row.remaining)} 件</strong>
          ${row.locked
            ? `<span class="row-locked" title="${row.billed ? '已开送货单并上传云端，不能撤回' : '登记满 7 天后不能再撤回'}">${row.billed ? '已开单' : '已归档'}</span>`
            : `<button type="button" class="row-revoke" data-revoke-over="${escapeHtml(row.ids.join(','))}">撤回</button>`}
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
        const meta = orderMetaFor(row.orderId, row);
        const po = meta.po || '无';
        const seq = meta.seq || '无';
        return `<div class="over-row">
          <span class="mono">${escapeHtml(row.material)}</span>
          <span>${escapeHtml(row.name || '')}<br><em class="over-meta">采购单号：${escapeHtml(po)} · 项次：${escapeHtml(seq)} · 订单量：${fmt(meta.orderQty)} · 已发：${fmt(meta.shipped)} · 未交：${fmt(meta.remaining)} · 冲抵：${fmt(row.quantity)} 件 · 日期：${escapeHtml(stamp(row.appliedAt))}</em></span>
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

// 电脑端装车登记
function desktopLoadingDuePass(order) {
  if (desktopLoadingDue === 'all') return true;
  const today = String(snapshot?.today || TODAY || '').slice(0, 10);
  const due = String(order.dueDate || '').slice(0, 10);
  if (!due || !today) return true;
  const day = 86400000;
  const diff = Math.round((new Date(due + 'T00:00:00') - new Date(today + 'T00:00:00')) / day);
  if (desktopLoadingDue === 'overdue') return diff < 0;
  if (desktopLoadingDue === 'today') return diff === 0;
  if (desktopLoadingDue.startsWith('date:')) return due === desktopLoadingDue.slice(5);
  return true;
}
// 下拉里自动列出「要发货的日期」（未交订单里出现过的交期），前三个固定项不变
function desktopLoadingDueLabel(dateKey) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  return matched ? `${Number(matched[2])}月${Number(matched[3])}日` : String(dateKey || '');
}
function desktopLoadingDueDates() {
  const dates = new Set();
  for (const order of (snapshot?.orders || [])) {
    if (!(Number(order.remaining || 0) > 0)) continue;
    if (desktopLoadingCompany !== 'all' && String(orderCompany(order) || '') !== desktopLoadingCompany) continue;
    const due = String(order.dueDate || '').slice(0, 10);
    if (due) dates.add(due);
  }
  return [...dates].sort();
}
function syncDesktopLoadingDueOptions() {
  const select = els.desktopLoadingDue;
  if (!select) return;
  const dates = desktopLoadingDueDates();
  const signature = dates.join(',');
  if (select.dataset.dateSignature === signature) return;
  select.dataset.dateSignature = signature;
  for (const option of [...select.querySelectorAll('option[data-due-date]')]) option.remove();
  for (const date of dates) {
    const option = document.createElement('option');
    option.value = 'date:' + date;
    option.dataset.dueDate = date;
    option.textContent = desktopLoadingDueLabel(date);
    select.appendChild(option);
  }
  if (![...select.options].some((option) => option.value === desktopLoadingDue)) {
    desktopLoadingDue = 'all';
    select.value = 'all';
  }
}
function desktopLoadingOrders() {
  const query = desktopLoadingSearch.trim().toLowerCase();
  return (snapshot?.orders || [])
    .filter((order) => Number(order.remaining || 0) > 0)
    .filter((order) => desktopLoadingCompany === 'all' || String(orderCompany(order) || '') === desktopLoadingCompany)
    .filter(desktopLoadingDuePass)
    .filter((order) => !query || [order.po, order.seq, order.material, order.name, order.spec]
      .some((value) => String(value ?? '').toLowerCase().includes(query)))
    .sort((a, b) => String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'))
      || orderTypeRank(a) - orderTypeRank(b)
      || Number(a.seq || 0) - Number(b.seq || 0));
}
function renderDesktopLoadingRecords() {
  if (!els.desktopLoadingRecords) return;
  const rows = (snapshot?.shipments || []).slice(0, 8);
  els.desktopLoadingRecords.innerHTML = rows.length ? rows.map((shipment) => {
    const rawLabel = String(shipment.vehicle || shipment.operator || '').trim();
    const label = (!rawLabel || rawLabel === '未填写' || rawLabel === '-') ? '' : rawLabel;
    const meta = label ? `${label} · ${fmt((shipment.items || []).length)} 项` : `${fmt((shipment.items || []).length)} 项`;
    return `
      <div class="loading-record"><strong>${escapeHtml(String(shipment.createdAt || '').slice(0, 16).replace('T', ' '))}</strong>
      <span>${escapeHtml(meta)}</span>
      <b>${fmt(shipment.totalQuantity || 0)} 件</b></div>`;
  }).join('') : '<div class="empty-state"><strong>今天还没有装车记录</strong><span>提交后会显示在这里。</span></div>';
}
function renderDesktopLoadingCart() {
  if (!els.desktopLoadingCart) return;
  const rows = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0).map(([id, quantity]) => {
    const order = snapshot?.orders?.find((item) => item.id === id);
    return order ? { order, quantity:Number(quantity) } : null;
  }).filter(Boolean);
  const overRows = [...sessionOver.values()].filter((item) => Number(item.quantity) > 0);
  const total = rows.reduce((sum, row) => sum + row.quantity, 0) + overRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0) + replacementTotalQty();
  els.desktopLoadingCartHint.textContent = `${rows.length + overRows.length + sessionReplacements.length} 项 · ${fmt(total)} 件`;
  const cartQtyInput = (kind, key, value, max) => `<input class="loading-cart-qty" type="number" inputmode="numeric" min="0" step="1"${max ? ` max="${Number(max) || ''}"` : ''} value="${Number(value) || 0}" data-cart-qty="${kind}" data-key="${escapeHtml(String(key))}" aria-label="本次数量">`;
  const cartRemoveButton = (kind, key, label) => `<button type="button" class="cart-remove" data-cart-line-remove="${kind}" data-key="${escapeHtml(String(key))}">${label}</button>`;
  els.desktopLoadingCart.innerHTML = rows.length || overRows.length || sessionReplacements.length
    ? rows.map(({ order, quantity }) => `<div class="loading-cart-line"><div><strong>${escapeHtml(order.material)} · ${escapeHtml(order.name || '')}</strong><span>${escapeHtml(order.po || '')} · 项次 ${escapeHtml(order.seq || '')} · 未交 ${fmt(order.remaining)}</span></div><div class="loading-cart-actions">${cartQtyInput('order', order.id, quantity, order.remaining)}${cartRemoveButton('order', order.id, '取消')}</div></div>`).join('')
      + overRows.map((item) => `<div class="loading-cart-line"><div><strong>${escapeHtml(item.name || item.material || '无订单发货')}</strong><span>无订单发货${item.pending ? '' : '（已登记）'}</span></div><div class="loading-cart-actions">${item.pending ? cartQtyInput('over', item.material, item.quantity) : `<b>${fmt(item.quantity)} 件</b>`}${item.pending ? cartRemoveButton('over', item.material, '取消') : `<button type="button" class="cart-remove" data-cart-over="${escapeHtml(item.id)}">撤回</button>`}</div></div>`).join('')
      + sessionReplacements.map((item, index) => `<div class="loading-cart-line"><div><strong>${escapeHtml(item.material)} · ${escapeHtml(item.name || '')}</strong><span>补发计划 · 交期 ${escapeHtml(formatDate(item.dueDate || defaultReplacementDueDate()))}${item.remark ? ' · 原因：' + escapeHtml(item.remark) : '（未填原因）'}</span></div><div class="loading-cart-actions">${cartQtyInput('replacement', index, item.quantity)}${cartRemoveButton('replacement', index, '取消')}</div></div>`).join('')
    : '<div class="loading-cart-empty">还没有录入本次装车数量</div>';
  if (els.desktopLoadingOpenSubmit) els.desktopLoadingOpenSubmit.disabled = !(rows.length || overRows.length || sessionReplacements.length);
}
function renderDesktopLoadingSummary() {
  const selectedItems = [...selected.values()].filter((value) => Number(value) > 0).length;
  const selectedQty = [...selected.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  const overRows = [...sessionOver.values()].filter((item) => Number(item.quantity) > 0);
  const overQty = overRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const totalItems = selectedItems + overRows.length + sessionReplacements.length;
  const totalQty = selectedQty + overQty + replacementTotalQty();
  if (els.desktopLoadingSelectedQty) els.desktopLoadingSelectedQty.textContent = fmt(totalQty);
  if (els.desktopLoadingSelectedItems) els.desktopLoadingSelectedItems.textContent = `${totalItems} 项物料`;
  if (els.desktopLoadingRemainingQty) els.desktopLoadingRemainingQty.textContent = fmt(snapshot?.summary?.remainingQuantity || 0);
}
function renderDesktopLoading() {
  if (!els.desktopLoadingCardList) return;
  syncDesktopLoadingDueOptions();
  const items = loadingItems(desktopLoadingOrders(), {
    unitFilter: (unit) => unitMatchesDueFilter(unit, desktopLoadingDue) && unitMatchesCompany(unit, desktopLoadingCompany),
    includeReplacements: desktopLoadingDue === 'all' && desktopLoadingCompany === 'all',
    planQuery: desktopLoadingSearch,
  });
  const limit = 120;
  const shown = items.slice(0, limit);
  if (els.desktopLoadingSummary) els.desktopLoadingSummary.textContent = fmt(items.length);
  els.desktopLoadingEmpty.hidden = items.length > 0;
  els.desktopLoadingCardList.innerHTML = shown.map((item) => item.kind === 'replacement'
    ? replacementPlanCard(item.item, item.selected, item.legacyIndex)
    : item.kind === 'unit'
      ? unitCardHtml(item.unit, item.index)
      : orderCard(item.order)).join('')
    + (items.length > limit ? `<div class="empty-state desktop-loading-more"><strong>还有 ${fmt(items.length - limit)} 项未显示</strong><span>请用搜索快速定位物料。</span></div>` : '');
  renderDesktopLoadingSummary();
  renderDesktopLoadingCart();
  renderDesktopLoadingRecords();
}
// 报工情况查询：默认当天，电脑端和手机端共用
function todayShanghai() {
  return new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' });
}
function ensureReportDate(input) {
  if (!workReportDate) workReportDate = todayShanghai();
  if (input && !input.value) input.value = workReportDate;
}
function fillEmployeeOptions(rows) {
  const workbenchRows = (rows || []).filter((row) => row.track === 'welding' || row.track === 'back');
  const options = '<option value="">全部员工</option>' + workbenchRows.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.employeeNo || '')} · ${escapeHtml(row.name || '')}</option>`).join('');
  [els.desktopWorkReportEmployee, els.mobileWorkReportEmployee].forEach((select) => { if (select) select.innerHTML = options; });
}
async function loadWorkEmployees() {
  if (workEmployeesCache) { fillEmployeeOptions(workEmployeesCache); return workEmployeesCache; }
  const result = await callRpc('work_admin_list_employees', { p_code:getAccessCode() });
  if (!result.response.ok) throw new Error(result.data?.error || '员工列表加载失败');
  workEmployeesCache = Array.isArray(result.data) ? result.data : [];
  fillEmployeeOptions(workEmployeesCache);
  return workEmployeesCache;
}
function workLiveMinuteText(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0)));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${(minutes / 60).toFixed(2)} 小时`;
}
function workLiveEntries(data) {
  const list = [
    ...((data && data.periods) || []).flatMap((period) => period.entries || []),
    ...((data && data.unassignedEntries) || []),
  ];
  const map = new Map();
  for (const entry of list) {
    if (!entry || !entry.id || entry.status === 'revoked') continue;
    map.set(entry.id, entry);
  }
  return [...map.values()];
}
function workLiveLatestPiece(entries) {
  return entries.slice().sort((a, b) => new Date(b.submittedAt || b.createdAt || 0).getTime() - new Date(a.submittedAt || a.createdAt || 0).getTime())[0] || null;
}
function workLiveStatus(row) {
  if (row.error) return { text:'加载失败', className:'error' };
  if (row.activeTimer) return { text:'计时中', className:'active' };
  if ((row.timerEntries || []).length) return { text:'计时已结束', className:'' };
  if (Number(row.pieceCount || 0) > 0) return { text:'已有计件', className:'piece' };
  return { text:'未开始', className:'' };
}
function workLiveLatestText(row) {
  const stale = row.stale ? '<br><small class="work-live-stale">本次刷新失败，显示上次数据</small>' : '';
  if (row.error) return escapeHtml(row.error);
  if (!row.latestPiece) return `暂无计件动态${stale}`;
  return `${workTimelineTime(row.latestPiece.submittedAt)} · ${escapeHtml(row.latestPiece.name || '')} · ${escapeHtml(row.latestPiece.process || '')} · ${fmt(row.latestPiece.quantity)} 件 · ${escapeHtml(workReviewStatusText(row.latestPiece.status))}${stale}`;
}
function renderWorkLiveOverview() {
  const rows = Array.isArray(workLiveRows) ? workLiveRows : [];
  const timingNow = rows.filter((row) => row.activeTimer).length;
  const timedToday = rows.filter((row) => row.activeTimer || Number(row.timerMinutes || 0) > 0).length;
  const pieceTotal = rows.reduce((sum, row) => sum + Number(row.pieceCount || 0), 0);
  const pendingTotal = rows.reduce((sum, row) => sum + Number(row.pending || 0), 0);
  const staleTotal = rows.filter((row) => row.stale).length;
  const summary = `计时中 ${timingNow} 人 · 今日计时 ${timedToday} 人 · 今日计件 ${pieceTotal} 笔 · 待审 ${pendingTotal} 笔${staleTotal ? ` · 刷新失败 ${staleTotal} 人` : ''}`;
  if (els.desktopWorkLiveSummary) els.desktopWorkLiveSummary.textContent = summary;
  if (els.mobileWorkLiveSummary) els.mobileWorkLiveSummary.textContent = summary;
  const sorted = rows.slice().sort((a, b) => (Number(Boolean(b.activeTimer)) - Number(Boolean(a.activeTimer))) || (Number(b.pieceCount || 0) - Number(a.pieceCount || 0)) || String(a.employeeNo).localeCompare(String(b.employeeNo), 'zh-CN', { numeric:true }));
  if (els.desktopWorkLiveBody) {
    els.desktopWorkLiveBody.innerHTML = sorted.map((row) => {
      const status = workLiveStatus(row);
      const timerText = row.activeTimer ? `进行中 · ${workLiveMinuteText(row.activeTimer.minutes)}` : Number(row.timerMinutes || 0) > 0 ? `合计 ${workLiveMinuteText(row.timerMinutes)}` : '未计时';
      const timerSub = Number(row.timerPaidHours || 0) > 0 ? `有效 ${Number(row.timerPaidHours).toFixed(2)} 小时` : '---';
      const pieceText = Number(row.pieceCount || 0) > 0 ? `${fmt(row.pieceCount)} 笔 · ${fmt(row.pieceQuantity)} 件` : '暂无计件';
      const pieceSub = Number(row.pieceCount || 0) > 0 ? `金额 ${workReviewMoney(row.pieceAmount, 2)} 元 · 待审 ${fmt(row.pending)} 笔` : '---';
      return `<tr><td><div class="work-live-person"><strong>${escapeHtml(row.name || '')}</strong><small>${escapeHtml(row.employeeNo || '')}</small></div></td><td><span class="work-live-status ${status.className}">${escapeHtml(status.text)}</span></td><td><div class="work-live-metric">${escapeHtml(timerText)}<span>${escapeHtml(timerSub)}</span></div></td><td><div class="work-live-metric">${escapeHtml(pieceText)}<span>${escapeHtml(pieceSub)}</span></div></td><td><div class="work-live-metric">${workLiveLatestText(row)}</div></td><td><button class="work-live-action" type="button" data-work-live-employee="${escapeHtml(row.id)}">查看明细</button></td></tr>`;
    }).join('');
  }
  if (els.mobileWorkLiveList) {
    els.mobileWorkLiveList.innerHTML = sorted.length ? sorted.map((row) => {
      const status = workLiveStatus(row);
      const timerText = row.activeTimer ? `进行中 · ${workLiveMinuteText(row.activeTimer.minutes)}` : Number(row.timerMinutes || 0) > 0 ? `${workLiveMinuteText(row.timerMinutes)}` : '未计时';
      const pieceText = Number(row.pieceCount || 0) > 0 ? `${fmt(row.pieceCount)} 笔 · ${fmt(row.pieceQuantity)} 件` : '暂无计件';
      return `<article class="mobile-live-card"><div class="mobile-live-card-head"><h3>${escapeHtml(row.employeeNo || '')} · ${escapeHtml(row.name || '')}</h3><span class="work-live-status ${status.className}">${escapeHtml(status.text)}</span></div><div class="mobile-live-grid"><div><span>今日计时</span><strong>${escapeHtml(timerText)}</strong></div><div><span>今日计件</span><strong>${escapeHtml(pieceText)}</strong></div></div><div class="mobile-live-latest">最新动态：${workLiveLatestText(row)}</div><button type="button" data-work-live-employee="${escapeHtml(row.id)}">查看明细</button></article>`;
    }).join('') : '<div class="empty-state"><strong>没有可显示的计时计件员工</strong></div>';
  }
  if (els.desktopWorkLiveEmpty) els.desktopWorkLiveEmpty.hidden = sorted.length > 0;
}
function normalizeWorkLiveRow(employee, data = {}) {
  const timerEntries = Array.isArray(data.timerEntries) ? data.timerEntries : [];
  const pieceEntries = Array.isArray(data.pieceEntries)
    ? data.pieceEntries.filter((entry) => entry && entry.status !== 'revoked')
    : workLiveEntries(data);
  const activeTimer = data.activeTimer !== undefined ? data.activeTimer : timerEntries.find((entry) => !entry.endedAt) || null;
  const timerMinutes = data.timerMinutes != null
    ? Number(data.timerMinutes)
    : timerEntries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
  const pieceQuantity = data.pieceQuantity != null
    ? Number(data.pieceQuantity)
    : pieceEntries.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
  const pieceAmount = data.pieceAmount != null
    ? Number(data.pieceAmount)
    : pieceEntries.reduce((sum, entry) => sum + (entry.status === 'approved' ? Number(entry.amount || 0) : 0), 0);
  const pending = data.pending != null
    ? Number(data.pending)
    : pieceEntries.filter((entry) => entry.status === 'submitted').length;
  return {
    id:employee.id,
    employeeNo:employee.employeeNo,
    name:employee.name,
    track:employee.track || '',
    activeTimer,
    timerEntries,
    timerMinutes,
    timerPaidHours:Number(data.timerPaidHours ?? data.salary?.timerHours ?? 0),
    pieceEntries,
    pieceCount:data.pieceCount != null ? Number(data.pieceCount) : pieceEntries.length,
    pieceQuantity,
    pieceAmount,
    pending,
    latestPiece:data.latestPiece !== undefined ? data.latestPiece : workLiveLatestPiece(pieceEntries),
    stale:Boolean(data.stale),
    error:data.error || '',
  };
}
async function loadWorkLiveOverview(employees = null) {
  if (boardRole !== 'admin' || workLiveLoading) return;
  workLiveLoading = true;
  try {
    const list = (employees || await loadWorkEmployees()).filter((employee) => employee.track === 'welding' || employee.track === 'back');
    const day = workReportDate || todayShanghai();
    const previous = new Map((workLiveRows || []).map((row) => [row.id, row]));
    let rows = [];

    try {
      const result = await callRpc('work_admin_work_overview', { p_code:getAccessCode(), p_date:day }, 15000);
      if (!result.response.ok) throw new Error(result.data?.error || '实况汇总加载失败');
      const sourceRows = Array.isArray(result.data?.rows) ? result.data.rows : [];
      if (!sourceRows.length && list.length) throw new Error('实况汇总返回为空');
      rows = sourceRows.map((row) => normalizeWorkLiveRow({ id:row.id, employeeNo:row.employeeNo, name:row.name, track:row.track }, row));
    } catch {
      rows = [];
    }

    if (!rows.length) {
      for (const employee of list) {
        try {
          const result = await callRpc('work_admin_piece_timeline', { p_code:getAccessCode(), p_employee_id:employee.id, p_date:day }, 15000);
          if (!result.response.ok) throw new Error(result.data?.error || '实况加载失败');
          rows.push(normalizeWorkLiveRow(employee, result.data || {}));
        } catch (error) {
          const previousRow = previous.get(employee.id);
          rows.push(previousRow
            ? { ...previousRow, stale:true }
            : normalizeWorkLiveRow(employee, { error:error.message || '实况加载失败' }));
        }
      }
    }

    workLiveRows = rows;
    workLiveLoadedAt = Date.now();
    renderWorkLiveOverview();
  } finally {
    workLiveLoading = false;
  }
}
async function loadWorkReportWorkspace() {
  if (boardRole !== 'admin') return;
  const employees = await loadWorkEmployees();
  await Promise.all([loadWorkReport(employees), loadWorkLiveOverview(employees)]);
}
function workTimelineTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Shanghai' });
}
function workTimelineDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('zh-CN', { month:'numeric', day:'numeric', timeZone:'Asia/Shanghai' });
}
function workTimelinePeriodOptions(periods, currentId) {
  return '<option value="__auto__">重新自动匹配</option>' + (periods || []).map((period) => `<option value="${escapeHtml(period.id)}" ${period.id === currentId ? 'selected' : ''}>${escapeHtml(workTimelineTime(period.startedAt))} → ${escapeHtml(workTimelineTime(period.endedAt))}</option>`).join('');
}
function workTimelineEntryOptions(entry, periods) {
  return `<select data-work-timeline-entry="${escapeHtml(entry.id)}">${workTimelinePeriodOptions(periods, entry.piecePeriodId || '')}</select>`;
}
function renderWorkTimeline() {
  const desktopPanel = document.getElementById('desktopWorkTimelinePanel');
  const mobilePanel = document.getElementById('mobileWorkTimelinePanel');
  const data = workTimeline;
  if (!data || !data.employee) {
    if (desktopPanel) desktopPanel.hidden = true;
    if (mobilePanel) mobilePanel.hidden = true;
    return;
  }
  const salary = data.salary || {};
  const periods = data.periods || [];
  const unassigned = data.unassignedEntries || [];
  const anomalies = data.anomalies || [];
  const periodRows = periods.map((period) => {
    const entries = (period.entries || []).map((entry) => `<div class="work-timeline-entry"><span>${escapeHtml(entry.name || '')} · ${escapeHtml(entry.process || '')} · ${fmt(entry.quantity)} 件 · ${workReviewMoney(entry.amount, 2)} 元</span>${workTimelineEntryOptions({ ...entry, piecePeriodId:period.id }, periods)}</div>`).join('') || '<div class="work-timeline-entry">这个时段没有关联计件记录</div>';
    return `<div class="work-timeline-row"><div class="work-timeline-time">${escapeHtml(workTimelineTime(period.startedAt))} → ${escapeHtml(workTimelineTime(period.endedAt))}<small>${period.source === 'admin' ? '管理员调整' : '自动计算'} · ${fmt(period.minutes)} 分钟</small></div><div><div class="work-timeline-meta"><span>产量 <b>${fmt(period.quantity)}</b></span><span>金额 <b>${workReviewMoney(period.amount, 2)}</b></span><span>每小时 <b>${fmt(period.efficiency)}</b> 件</span></div><div class="work-timeline-entries">${entries}</div></div></div>`;
  }).join('');
  const unassignedRows = unassigned.map((entry) => `<div class="work-timeline-row"><div class="work-timeline-time">未关联时段<small>${escapeHtml(entry.status === 'approved' ? '已通过' : '待审核')}</small></div><div><div class="work-timeline-meta"><span>${escapeHtml(entry.name || '')} · ${escapeHtml(entry.process || '')} · ${fmt(entry.quantity)} 件</span></div></div><div>${workTimelineEntryOptions({ ...entry, piecePeriodId:'' }, periods)}</div></div>`).join('');
  const timerRows = (data.timerEntries || []).map((entry) => `<div class="work-timeline-row timer"><div class="work-timeline-time">${escapeHtml(workTimelineTime(entry.startedAt))} → ${escapeHtml(entry.endedAt ? workTimelineTime(entry.endedAt) : '进行中')}<small>已计时 ${fmt(entry.minutes)} 分钟</small></div><div class="work-timeline-meta"><span>状态 <b>${entry.status === 'closed' ? '已完成' : '进行中'}</b></span>${entry.note ? `<span>${escapeHtml(entry.note)}</span>` : ''}</div><div></div></div>`).join('');
  const anomalyHtml = anomalies.length ? `<div class="work-timeline-anomaly">${anomalies.map((item) => `⚠ ${escapeHtml(item)}`).join('<br>')}</div>` : '';
  const html = `${anomalyHtml}<div class="work-timeline-summary"><article><span>计时工时</span><strong>${fmt(salary.timerHours)}h</strong></article><article><span>计时工资</span><strong>${workReviewMoney(salary.timerPay, 2)} 元</strong></article><article><span>计件工时</span><strong>${fmt(salary.pieceHours)}h</strong></article><article><span>当天合计</span><strong>${workReviewMoney(salary.totalPay, 2)} 元</strong></article></div><div class="work-timeline-list">${timerRows}${periodRows}${unassignedRows}${!(timerRows || periodRows || unassignedRows) ? '<div class="work-timeline-empty">当天没有计时或计件记录</div>' : ''}</div>`;
  const actions = `<button type="button" data-work-payroll="${data.monthClosed ? 'open' : 'closed'}">${data.monthClosed ? '解封本月工资' : '封账本月工资'}</button>`;
  if (desktopPanel) {
    desktopPanel.hidden = false;
    document.getElementById('desktopWorkTimelineHint').textContent = `${data.employee.employeeNo} · ${data.employee.name} · ${data.date}`;
    document.getElementById('desktopWorkTimelineActions').innerHTML = actions;
    document.getElementById('desktopWorkTimeline').innerHTML = html;
  }
  if (mobilePanel) {
    mobilePanel.hidden = false;
    const mobileHtml = `<div class="work-timeline-anomaly">${data.employee.name} · ${data.date}${data.monthClosed ? ' · 本月已封账' : ''}</div><div class="work-timeline-list">${html}</div><div class="work-timeline-actions">${actions}</div>`;
    document.getElementById('mobileWorkTimeline').innerHTML = mobileHtml;
  }
}
async function loadWorkTimeline() {
  if (boardRole !== 'admin') return;
  const employeeId = workReportEmployeeId;
  const desktopPanel = document.getElementById('desktopWorkTimelinePanel');
  const mobilePanel = document.getElementById('mobileWorkTimelinePanel');
  if (!employeeId) {
    workTimeline = null;
    if (desktopPanel) desktopPanel.hidden = true;
    if (mobilePanel) mobilePanel.hidden = true;
    return;
  }
  try {
    const result = await callRpc('work_admin_piece_timeline', { p_code:getAccessCode(), p_employee_id:employeeId, p_date:workReportDate || todayShanghai() });
    if (!result.response.ok) throw new Error(result.data?.error || '工时时段加载失败');
    workTimeline = result.data || null;
    renderWorkTimeline();
  } catch (error) {
    workTimeline = null;
    if (desktopPanel) desktopPanel.hidden = true;
    if (mobilePanel) mobilePanel.hidden = true;
    showToast(error.message || '工时时段加载失败');
  }
}
async function updateWorkTimelineEntry(entryId, periodId, auto) {
  try {
    const result = await callRpc('work_admin_adjust_piece_period', {
      p_code:getAccessCode(),
      p_entry_id:entryId,
      p_period_id:auto ? null : periodId,
      p_note:'管理员在报工页面调整',
      p_auto:Boolean(auto),
    });
    if (!result.response.ok) throw new Error(result.data?.error || '调整失败');
    showToast(auto ? '已重新自动匹配' : '已调整计件时段');
    await loadWorkTimeline();
  } catch (error) {
    showToast(error.message || '调整失败');
  }
}
async function toggleWorkPayroll(status) {
  if (!workTimeline?.employee || !workTimeline?.date) return;
  const month = workTimeline.date.slice(0, 7) + '-01';
  try {
    const result = await callRpc('work_admin_set_payroll_status', {
      p_code:getAccessCode(), p_employee_id:workTimeline.employee.id, p_month:month,
      p_status:status, p_note:status === 'closed' ? '管理员封账' : '管理员解封',
    });
    if (!result.response.ok) throw new Error(result.data?.error || '封账操作失败');
    showToast(status === 'closed' ? '本月工资已封账' : '本月工资已解封');
    await loadWorkTimeline();
  } catch (error) {
    showToast(error.message || '封账操作失败');
  }
}
function renderWorkReport() {
  const summary = workReportRows.summary || {};
  const list = Array.isArray(workReportRows) ? workReportRows : (workReportRows.rows || []);
  if (els.desktopWorkReportEntries) els.desktopWorkReportEntries.textContent = fmt(summary.entries || 0);
  if (els.desktopWorkReportQuantity) els.desktopWorkReportQuantity.textContent = fmt(summary.quantity || 0);
  if (els.desktopWorkReportAmount) els.desktopWorkReportAmount.textContent = workReviewMoney(summary.amount || 0, 2);
  if (els.desktopWorkReportPending) els.desktopWorkReportPending.textContent = fmt(summary.pending || 0);
  if (els.mobileWorkReportEntries) els.mobileWorkReportEntries.textContent = fmt(summary.entries || 0);
  if (els.mobileWorkReportQuantity) els.mobileWorkReportQuantity.textContent = fmt(summary.quantity || 0);
  if (els.mobileWorkReportAmount) els.mobileWorkReportAmount.textContent = workReviewMoney(summary.amount || 0, 2);
  if (els.mobileWorkReportPending) els.mobileWorkReportPending.textContent = fmt(summary.pending || 0);
  const statusInfo = (row) => ({
    status: workReviewStatusText(row.status),
    price: row.unitPrice != null ? workReviewMoney(row.unitPrice) : row.submittedUnitPrice != null ? `申报 ${workReviewMoney(row.submittedUnitPrice, 2)}` : '--',
    amount: row.amount != null ? workReviewMoney(row.amount, 2) : '--'
  });
  if (els.desktopWorkReportBody) {
    els.desktopWorkReportBody.innerHTML = list.map((row) => {
      const info = statusInfo(row);
      return `<tr><td>${escapeHtml(String(row.createdAt || '').slice(11, 16))}<small>${escapeHtml(row.workDate || '')}</small></td><td><strong>${escapeHtml(row.employeeName || '')}</strong><small>${escapeHtml(row.employeeNo || '')}</small></td><td>${escapeHtml(row.name || '')}<small>${escapeHtml(row.material || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</small></td><td>${escapeHtml(row.process || '')}<small>${escapeHtml(row.variantLabel || '')}</small></td><td class="number">${fmt(row.quantity)}</td><td><span class="review-status ${escapeHtml(row.status || '')}">${escapeHtml(info.status)}</span></td><td class="number">${escapeHtml(info.price)}</td><td class="number">${escapeHtml(info.amount)}</td><td>${row.status === 'submitted' ? `<button class="work-report-action" type="button" data-report-review="${escapeHtml(row.id)}">去审核</button>` : '--'}</td></tr>`;
    }).join('');
  }
  if (els.mobileWorkReportList) {
    els.mobileWorkReportList.innerHTML = list.length ? list.map((row) => {
      const info = statusInfo(row);
      return `<article class="mobile-review-card"><div><span class="review-status ${escapeHtml(row.status || '')}">${escapeHtml(info.status)}</span><span>${escapeHtml(String(row.createdAt || '').slice(11, 16))}</span></div><h3>${escapeHtml(row.employeeName || '')} · ${escapeHtml(row.name || '')}</h3><p>${escapeHtml(row.material || '')}${row.spec ? ' · ' + escapeHtml(row.spec) : ''}</p><p>${escapeHtml(row.process || '')}${row.variantLabel ? ' · ' + escapeHtml(row.variantLabel) : ''} · ${fmt(row.quantity)} 件</p><p class="review-money">单价 ${escapeHtml(info.price)} 元 · 金额 ${escapeHtml(info.amount)} 元</p>${row.status === 'submitted' ? `<button type="button" data-report-review="${escapeHtml(row.id)}">去审核</button>` : ''}</article>`;
    }).join('') : '<div class="empty-state"><strong>当天没有符合条件的报工</strong><span>可以更换日期或筛选条件。</span></div>';
  }
  if (els.desktopWorkReportEmpty) els.desktopWorkReportEmpty.hidden = list.length > 0;
}
async function loadWorkReport(employees = null) {
  if (boardRole !== 'admin') return;
  ensureReportDate(els.desktopWorkReportDate);
  ensureReportDate(els.mobileWorkReportDate);
  if (els.desktopWorkReportDate) els.desktopWorkReportDate.value = workReportDate;
  if (els.mobileWorkReportDate) els.mobileWorkReportDate.value = workReportDate;
  if (els.desktopWorkReportStatus) els.desktopWorkReportStatus.value = workReportStatus;
  if (els.mobileWorkReportStatus) els.mobileWorkReportStatus.value = workReportStatus;
  if (els.desktopWorkReportSearch && els.desktopWorkReportSearch.value !== workReportQuery) els.desktopWorkReportSearch.value = workReportQuery;
  if (els.mobileWorkReportSearch && els.mobileWorkReportSearch.value !== workReportQuery) els.mobileWorkReportSearch.value = workReportQuery;
  try {
    const employeeRows = employees || await loadWorkEmployees();
    fillEmployeeOptions(employeeRows);
    const result = await callRpc('work_admin_report_list', { p_code:getAccessCode(), p_date:workReportDate, p_employee_id:workReportEmployeeId || null, p_status:workReportStatus, p_query:workReportQuery, p_limit:1000 });
    if (!result.response.ok) throw new Error(result.data?.error || '报工情况加载失败');
    workReportRows = result.data || { rows:[], summary:{} };
    renderWorkReport();
    if (workReportEmployeeId) await loadWorkTimeline();
    else {
      workTimeline = null;
      const desktopTimeline = document.getElementById('desktopWorkTimelinePanel');
      const mobileTimeline = document.getElementById('mobileWorkTimelinePanel');
      if (desktopTimeline) desktopTimeline.hidden = true;
      if (mobileTimeline) mobileTimeline.hidden = true;
    }
    if (els.desktopWorkReportEmployee) els.desktopWorkReportEmployee.value = workReportEmployeeId;
    if (els.mobileWorkReportEmployee) els.mobileWorkReportEmployee.value = workReportEmployeeId;
  } catch (error) { showToast(error.message || '报工情况加载失败'); }
}
function openReportReview(id) {
  const list = Array.isArray(workReportRows) ? workReportRows : (workReportRows.rows || []);
  const row = list.find((item) => item.id === id);
  if (!row) return;
  workReviewRows = [{ ...row, submittedName:row.submittedName || row.name || '', submittedMaterial:row.submittedMaterial || row.material || '', submittedSpec:row.submittedSpec || row.spec || '', submittedProcessName:row.submittedProcessName || row.process || '' }];
  openWorkReviewEditor(id);
}
function switchMobileWorkTab(tab) {
  mobileWorkTab = tab === 'review' ? 'review' : 'report';
  document.querySelectorAll('[data-mobile-work-tab]').forEach((button) => button.classList.toggle('active', button.dataset.mobileWorkTab === mobileWorkTab));
  if (els.mobileWorkReportPanel) els.mobileWorkReportPanel.hidden = mobileWorkTab !== 'report';
  if (els.mobileWorkReviewPanel) els.mobileWorkReviewPanel.hidden = mobileWorkTab !== 'review';
  if (mobileWorkTab === 'report') loadWorkReportWorkspace().catch(() => {});
  else loadWorkReviews().catch(() => {});
}
function setDesktopModule(module, view = '') {
  desktopModule = boardRole === 'admin' && (module === 'work' || module === 'attendance') ? module : 'shipment';
  document.querySelectorAll('[data-module]').forEach((link) => {
    const allowed = desktopModule === 'shipment'
      ? link.dataset.module === 'shipment'
      : desktopModule === 'attendance'
        ? link.dataset.module === 'attendance'
        : link.dataset.module === 'work';
    link.hidden = !allowed;
  });
  if (els.moduleSwitchButton) {
    els.moduleSwitchButton.hidden = false;
    els.moduleSwitchButton.setAttribute('aria-disabled', String(boardRole !== 'admin'));
    els.moduleSwitchButton.setAttribute('title', boardRole === 'admin' ? '切换模块' : '帆顺科技');
    els.moduleSwitchButton.setAttribute('aria-label', boardRole === 'admin' ? '切换模块' : '帆顺科技');
  }
  if (els.moduleSwitchLabel) {
    els.moduleSwitchLabel.textContent = desktopModule === 'attendance'
      ? '考勤管理'
      : desktopModule === 'work'
        ? (String(view || '').includes('Review') || (!view && String(desktopView).includes('Review')) ? '报工审核' : '报工情况')
        : '装车登记';
  }
  if (desktopModule === 'attendance') showDesktopView(view || 'attendance');
  else if (desktopModule === 'work') showDesktopView(view || 'workReport');
  else showDesktopView(view || (desktopView && !String(desktopView).startsWith('work') && desktopView !== 'attendance' ? desktopView : 'overview'));
  refreshElasticTabs();
}
// 报工审核：电脑端和手机端共用同一套数据和接口
function workReviewStatusText(status) {
  return ({ submitted:'待审核', approved:'已通过', rejected:'已退回', revoked:'已撤回' })[status] || status || '--';
}
function workReviewSourceText(source) {
  return ({ custom_product:'新产品', price_change:'申请改价', catalog:'目录报工' })[source] || source || '--';
}
function workReviewMoney(value, digits = 4) {
  if (value == null || value === '') return '--';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
function workReviewCard(row, mobile = false) {
  const status = workReviewStatusText(row.status);
  const source = workReviewSourceText(row.sourceType);
  const price = row.unitPrice != null
    ? `正式 ${workReviewMoney(row.unitPrice)} 元 · 金额 ${workReviewMoney(row.amount, 2)} 元`
    : row.submittedUnitPrice != null
      ? `申报 ${workReviewMoney(row.submittedUnitPrice, 2)} 元${row.originalUnitPrice != null ? ` · 原价 ${workReviewMoney(row.originalUnitPrice)} 元` : ''}`
      : '未定价';
  const variant = row.variantLabel ? ` · ${escapeHtml(row.variantLabel)}` : '';
  const fields = `<h3>${escapeHtml(row.employeeName || '--')} · ${escapeHtml(row.submittedName || '--')}</h3>
    <p>编号：<strong>${escapeHtml(row.submittedMaterial || '--')}</strong>${row.submittedSpec ? ` · 规格 ${escapeHtml(row.submittedSpec)}` : ''}</p>
    <p>${escapeHtml(source)} · ${escapeHtml(row.submittedProcessName || '--')}${variant} · ${fmt(row.quantity)} 件</p>
    <p class="review-money">${escapeHtml(price)}</p>`;
  if (mobile) {
    return `<article class="mobile-review-card" data-review-id="${escapeHtml(row.id)}">
      <div><span class="work-review-badge ${escapeHtml(row.sourceType || '')}">${escapeHtml(source)}</span><span class="review-status ${escapeHtml(row.status || '')}">${escapeHtml(status)}</span></div>
      ${fields}
      <button type="button" data-open-work-review="${escapeHtml(row.id)}">${row.status === 'submitted' ? '审核' : '查看'}</button>
    </article>`;
  }
  return `<article class="work-review-card" data-review-id="${escapeHtml(row.id)}">
    <div><span class="work-review-badge ${escapeHtml(row.sourceType || '')}">${escapeHtml(source)}</span><span class="review-status ${escapeHtml(row.status || '')}">${escapeHtml(status)}</span>${fields}</div>
    <div><p>员工：<strong>${escapeHtml(row.employeeNo || '--')} · ${escapeHtml(row.employeeName || '--')}</strong></p><p>日期：${escapeHtml(row.workDate || '--')} · 提交：${escapeHtml(String(row.createdAt || '').slice(0, 16).replace('T', ' '))}</p><p>${escapeHtml(price)}</p></div>
    <div><p>当前目录：<strong>${escapeHtml(row.currentMaterial || row.submittedMaterial || '--')}</strong></p><p>${escapeHtml(row.currentName || row.submittedName || '--')}${row.currentSpec ? ` · ${escapeHtml(row.currentSpec)}` : ''}</p><p>${escapeHtml(row.currentProcessName || row.submittedProcessName || '--')}</p></div>
    <button type="button" data-open-work-review="${escapeHtml(row.id)}">${row.status === 'submitted' ? '审核' : '查看'}</button>
  </article>`;
}
function renderWorkReviews() {
  if (els.desktopWorkReviewList) els.desktopWorkReviewList.innerHTML = workReviewRows.map((row) => workReviewCard(row, false)).join('');
  if (els.mobileWorkReviewList) els.mobileWorkReviewList.innerHTML = workReviewRows.map((row) => workReviewCard(row, true)).join('');
  if (els.desktopWorkReviewCount) els.desktopWorkReviewCount.textContent = String(workReviewRows.length);
  if (els.desktopWorkReviewEmpty) els.desktopWorkReviewEmpty.hidden = workReviewRows.length > 0;
}
async function loadWorkReviews(status = workReviewStatus) {
  if (boardRole !== 'admin') return;
  workReviewStatus = status || 'submitted';
  if (els.desktopWorkReviewStatus) els.desktopWorkReviewStatus.value = workReviewStatus;
  if (els.mobileWorkReviewStatus) els.mobileWorkReviewStatus.value = workReviewStatus;
  const result = await callRpc('work_admin_list_reviews', { p_code:getAccessCode(), p_status:workReviewStatus, p_limit:300 });
  if (!result.response.ok) { showToast(result.data?.error || '报工审核加载失败'); return; }
  workReviewRows = Array.isArray(result.data) ? result.data : [];
  renderWorkReviews();
  const pendingResult = await callRpc('work_admin_list_reviews', { p_code:getAccessCode(), p_status:'submitted', p_limit:300 });
  if (els.desktopWorkReviewPending) els.desktopWorkReviewPending.textContent = pendingResult.response.ok && Array.isArray(pendingResult.data) ? String(pendingResult.data.length) : '--';
}
function setWorkReviewError(message) {
  if (!els.workReviewError) return;
  els.workReviewError.textContent = message || '';
  els.workReviewError.hidden = !message;
}
function closeWorkReviewEditor() {
  if (!els.workReviewModal) return;
  els.workReviewModal.hidden = true;
  workReviewEditing = null;
  setWorkReviewError('');
}
function openWorkReviewEditor(id) {
  const row = workReviewRows.find((item) => item.id === id);
  if (!row) return;
  workReviewEditing = row;
  els.workReviewId.value = row.id;
  els.workReviewInfo.innerHTML = `<strong>${escapeHtml(row.employeeName || '')}</strong> · ${escapeHtml(workReviewSourceText(row.sourceType))} · ${escapeHtml(workReviewStatusText(row.status))}<br>员工填报：${escapeHtml(row.submittedName || '')} · ${escapeHtml(row.submittedMaterial || '')} · ${escapeHtml(row.submittedProcessName || '')}${row.variantLabel ? ' · ' + escapeHtml(row.variantLabel) : ''}<br>当前目录：${escapeHtml(row.currentMaterial || '未入库')}${row.currentName ? ' · ' + escapeHtml(row.currentName) : ''}`;
  els.workReviewName.value = row.submittedName || '';
  els.workReviewMaterial.value = row.submittedMaterial || '';
  els.workReviewSpec.value = row.submittedSpec || '';
  els.workReviewProcess.value = row.submittedProcessName || '';
  els.workReviewQty.value = row.quantity ?? '';
  els.workReviewPrice.value = row.submittedUnitPrice ?? row.unitPrice ?? '';
  els.workReviewNote.value = row.reviewNote || '';
  const editable = row.status === 'submitted';
  [els.workReviewName, els.workReviewMaterial, els.workReviewSpec, els.workReviewProcess, els.workReviewQty, els.workReviewPrice, els.workReviewNote].forEach((input) => { if (input) input.disabled = !editable; });
  if (els.workReviewSave) els.workReviewSave.hidden = !editable;
  if (els.workReviewReject) els.workReviewReject.hidden = !editable;
  if (els.workReviewApprove) els.workReviewApprove.hidden = !editable;
  els.workReviewModal.hidden = false;
}
function workReviewPayload() {
  return {
    name:els.workReviewName.value.trim(),
    material:els.workReviewMaterial.value.trim(),
    spec:els.workReviewSpec.value.trim(),
    processName:els.workReviewProcess.value.trim(),
    quantity:Number(els.workReviewQty.value),
    unitPrice:Number(els.workReviewPrice.value),
    reviewNote:els.workReviewNote.value.trim(),
  };
}
async function submitWorkReview(action) {
  const row = workReviewEditing;
  if (!row) return;
  const payload = workReviewPayload();
  if (!payload.name) return setWorkReviewError('品名不能为空');
  if (!payload.material || payload.material.length < 4) return setWorkReviewError('料件编号至少要填写后四位');
  if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) return setWorkReviewError('数量必须是大于 0 的整数');
  if (!(payload.unitPrice > 0) || !/^\d+(\.\d{1,2})?$/.test(String(els.workReviewPrice.value || '').trim())) return setWorkReviewError('单价必须大于 0，最多两位小数');
  const buttons = [els.workReviewSave, els.workReviewReject, els.workReviewApprove].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    let result;
    if (action === 'save') {
      result = await callRpc('work_admin_save_review', { p_code:getAccessCode(), p_id:row.id, p_payload:payload });
    } else {
      if (action === 'reject' && !payload.reviewNote) throw new Error('退回时必须填写原因');
      result = await callRpc('work_admin_review_request', { p_code:getAccessCode(), p_id:row.id, p_action:action, p_payload:payload, p_reason:payload.reviewNote });
    }
    if (!result.response.ok) throw new Error(result.data?.error || '审核提交失败');
    closeWorkReviewEditor();
    await loadWorkReviews(workReviewStatus);
    if (desktopModule === 'work' || mobileModule === 'workReview') await loadWorkReportWorkspace();
    showToast(action === 'approve' ? '审核通过，已更新产品和当前单价' : action === 'reject' ? '已退回员工报工' : '修改已保存');
  } catch (error) {
    setWorkReviewError(error.message || '审核提交失败');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}
// 考勤管理：电脑端和手机端共用
const ATTENDANCE_STATUS_TEXT = { normal:'正常', late:'迟到', early_leave:'早退', missing_once:'漏刷1次', absent:'没上班', manual:'人工判定', leave:'请假', reissued:'已补卡' };
const ATTENDANCE_TYPE_TEXT = { hourly_piece:'计时计件', daily:'固定日薪', monthly:'固定月薪', management:'管理' };
function attendancePrevMonth() { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function attendanceCurrentMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function attendanceBounds(m) { const [y, mm] = String(m).split('-').map(Number); const last = new Date(y, mm, 0).getDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2,'0')}` }; }
function attendanceMoney(v) { return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function attendanceHours(minutes) { return Math.round(Number(minutes || 0) / 60 * 10) / 10; }
async function attendanceRpc(name, payload) {
  const result = await callRpc(name, payload);
  if (!result.response.ok) throw new Error(result.data?.error || '请求失败');
  return result.data;
}
function applyAttendanceTab() {
  const reissue = els.desktopAttendanceTab && els.desktopAttendanceTab.value === 'reissue';
  if (els.desktopAttendanceStats) els.desktopAttendanceStats.hidden = reissue;
  if (els.desktopAttendanceSummaryPanel) els.desktopAttendanceSummaryPanel.hidden = reissue;
  if (els.desktopAttendanceDetailPanel) els.desktopAttendanceDetailPanel.hidden = true;
  if (els.desktopAttendanceReissuePanel) els.desktopAttendanceReissuePanel.hidden = !reissue;
}
async function loadAttendance() {
  if (boardRole !== 'admin' || !RPC_BASE) return;
  if (!attendanceMonth) {
    attendanceMonth = attendanceCurrentMonth();
    if (els.desktopAttendanceMonth) els.desktopAttendanceMonth.value = attendanceMonth;
    if (els.mobileAttendanceMonth) els.mobileAttendanceMonth.value = attendanceMonth;
  }
  await Promise.all([loadAttendanceSummary(), loadAttendanceReissues()]);
  applyAttendanceTab();
}
function attendanceShiftMonth(delta) {
  const [y, m] = (attendanceMonth || attendancePrevMonth()).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  attendanceMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  if (els.desktopAttendanceMonth) els.desktopAttendanceMonth.value = attendanceMonth;
  if (els.mobileAttendanceMonth) els.mobileAttendanceMonth.value = attendanceMonth;
  loadAttendance().catch(() => {});
}
async function loadAttendanceSummary() {
  const { from, to } = attendanceBounds(attendanceMonth);
  const data = await attendanceRpc('board_attendance_summary', { p_code:getAccessCode(), p_from:from, p_to:to });
  attendanceData = data.summary || [];
  renderAttendanceSummary();
}
function renderAttendanceSummary() {
  const rows = attendanceData || [];
  const sum = (key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);
  if (els.desktopAttendanceCount) els.desktopAttendanceCount.textContent = rows.length;
  if (els.desktopAttendanceDays) els.desktopAttendanceDays.textContent = sum('attendanceDays');
  if (els.desktopAttendanceAbsent) els.desktopAttendanceAbsent.textContent = sum('absentDays');
  if (els.desktopAttendanceOvertime) els.desktopAttendanceOvertime.textContent = attendanceMoney(sum('overtimeAmount'));
  if (els.desktopAttendanceBody) {
    els.desktopAttendanceBody.innerHTML = rows.map((r) => `<tr><td>${escapeHtml(r.employeeNo)}</td><td><strong>${escapeHtml(r.employeeName)}</strong></td><td>${escapeHtml(ATTENDANCE_TYPE_TEXT[r.salaryType] || r.salaryType)}</td><td class="number">${fmt(r.attendanceDays)}</td><td class="number">${fmt(r.absentDays)}</td><td class="number">${fmt(r.lateDays)}</td><td class="number">${fmt(r.earlyDays)}</td><td class="number">${fmt(r.missingOnceDays)}</td><td class="number">${fmt(r.overtimeDays)} 天</td><td class="number">${attendanceMoney(r.overtimeAmount)}</td><td><button type="button" class="button ghost" data-att-detail="${escapeHtml(r.employeeNo)}">明细</button></td></tr>`).join('');
    els.desktopAttendanceBody.querySelectorAll('[data-att-detail]').forEach((b) => b.addEventListener('click', () => loadAttendanceDetail(b.dataset.attDetail).catch(() => {})));
  }
  if (els.desktopAttendanceEmpty) els.desktopAttendanceEmpty.hidden = rows.length > 0;
  if (els.mobileAttendanceList) {
    els.mobileAttendanceList.innerHTML = rows.length ? rows.map((r) => `<article class="mobile-review-card"><div><span class="work-review-badge">${escapeHtml(ATTENDANCE_TYPE_TEXT[r.salaryType] || r.salaryType)}</span></div><h3>${escapeHtml(r.employeeNo)} ${escapeHtml(r.employeeName)}</h3><p>出勤 ${fmt(r.attendanceDays)} 天 · 没上班 ${fmt(r.absentDays)} 天</p><p>迟到 ${fmt(r.lateDays)} · 早退 ${fmt(r.earlyDays)} · 漏刷1次 ${fmt(r.missingOnceDays)}</p><p class="review-money">加班 ${fmt(r.overtimeDays)} 天 · 加班费 ${attendanceMoney(r.overtimeAmount)} 元</p></article>`).join('') : '<div class="empty-state"><strong>这个月没有考勤数据</strong></div>';
  }
}
async function loadAttendanceDetail(empNo) {
  const { from, to } = attendanceBounds(attendanceMonth);
  const data = await attendanceRpc('board_attendance_days', { p_code:getAccessCode(), p_from:from, p_to:to, p_employee_no:empNo });
  const days = data.days || [];
  if (els.desktopAttendanceDetailTitle) els.desktopAttendanceDetailTitle.textContent = `${empNo} ${days[0]?.employeeName || ''} · ${attendanceMonth} 每日明细`;
  if (els.desktopAttendanceDetailHint) els.desktopAttendanceDetailHint.textContent = `共 ${days.length} 天`;
  if (els.desktopAttendanceDetailBody) els.desktopAttendanceDetailBody.innerHTML = days.map((d) => `<tr><td>${escapeHtml(d.workDate)}</td><td>${escapeHtml(d.checkInRaw || d.checkIn || '')}</td><td>${escapeHtml(d.checkOutRaw || d.checkOut || '')}</td><td><span class="review-status ${escapeHtml(d.status)}">${escapeHtml(ATTENDANCE_STATUS_TEXT[d.status] || d.status)}</span></td><td class="number">${Number(d.overtimeMinutes || 0) > 0 ? attendanceHours(d.overtimeMinutes) + ' h' : ''}</td><td>${escapeHtml(d.note || '')}</td></tr>`).join('');
  if (els.desktopAttendanceDetailPanel) els.desktopAttendanceDetailPanel.hidden = false;
}
async function loadAttendanceReissues() {
  const data = await attendanceRpc('board_reissue_requests', { p_code:getAccessCode(), p_status:'submitted' });
  const rows = data.requests || [];
  attendanceReissueData = rows;
  if (els.desktopAttendanceReissueList) {
    els.desktopAttendanceReissueList.innerHTML = rows.map((r) => `<article class="work-review-card"><div><span class="work-review-badge">补卡</span><span class="review-status submitted">待审核</span><h3>${escapeHtml(r.employeeNo)} ${escapeHtml(r.employeeName)} · ${escapeHtml(r.workDate)}</h3><p>${r.slot === 'check_in' ? '签到' : '签退'} · ${escapeHtml(String(r.reissueTime || '').slice(0,5))}</p><p>原因：${escapeHtml(r.reason || '')}</p></div><div><button type="button" class="button primary" data-reissue-approve="${escapeHtml(r.id)}">通过</button> <button type="button" class="button ghost" data-reissue-reject="${escapeHtml(r.id)}">退回</button></div></article>`).join('');
    els.desktopAttendanceReissueList.querySelectorAll('[data-reissue-approve]').forEach((b) => b.addEventListener('click', () => reviewAttendanceReissue(b.dataset.reissueApprove, true)));
    els.desktopAttendanceReissueList.querySelectorAll('[data-reissue-reject]').forEach((b) => b.addEventListener('click', () => reviewAttendanceReissue(b.dataset.reissueReject, false)));
  }
  if (els.desktopAttendanceReissueEmpty) els.desktopAttendanceReissueEmpty.hidden = rows.length > 0;
  if (els.mobileAttendanceReissueList) {
    els.mobileAttendanceReissueList.innerHTML = rows.length ? rows.map((r) => `<article class="mobile-review-card"><div><span class="review-status submitted">待审核</span></div><h3>${escapeHtml(r.employeeNo)} ${escapeHtml(r.employeeName)} · ${escapeHtml(r.workDate)}</h3><p>${r.slot === 'check_in' ? '签到' : '签退'} · ${escapeHtml(String(r.reissueTime || '').slice(0,5))}</p><p>原因：${escapeHtml(r.reason || '')}</p><div class="mobile-reissue-actions"><button type="button" class="button primary" data-mobi-approve="${escapeHtml(r.id)}">通过</button><button type="button" class="button ghost" data-mobi-reject="${escapeHtml(r.id)}">退回</button></div></article>`).join('') : '<div class="empty-state"><strong>没有待审核的补卡申请</strong></div>';
    els.mobileAttendanceReissueList.querySelectorAll('[data-mobi-approve]').forEach((b) => b.addEventListener('click', () => reviewAttendanceReissue(b.dataset.mobiApprove, true)));
    els.mobileAttendanceReissueList.querySelectorAll('[data-mobi-reject]').forEach((b) => b.addEventListener('click', () => reviewAttendanceReissue(b.dataset.mobiReject, false)));
  }
}
async function reviewAttendanceReissue(id, approve) {
  let note = '';
  if (!approve) { note = prompt('退回原因：') || ''; if (!note) return; }
  try {
    await attendanceRpc('board_review_reissue', { p_code:getAccessCode(), p_id:id, p_approve:approve, p_note:note });
    showToast(approve ? '补卡已通过' : '补卡已退回');
    await loadAttendance();
  } catch (error) { showToast(error.message || '操作失败'); }
}
function switchMobileAttendanceTab(tab) {
  mobileAttendanceTab = tab === 'reissue' ? 'reissue' : 'summary';
  document.querySelectorAll('[data-mobile-attendance-tab]').forEach((b) => b.classList.toggle('active', b.dataset.mobileAttendanceTab === mobileAttendanceTab));
  if (els.mobileAttendanceSummaryPanel) els.mobileAttendanceSummaryPanel.hidden = mobileAttendanceTab !== 'summary';
  if (els.mobileAttendanceReissuePanel) els.mobileAttendanceReissuePanel.hidden = mobileAttendanceTab !== 'reissue';
}
function renderMobileModule() {
  const isAdmin = boardRole === 'admin';
  const workMode = isAdmin && mobileModule === 'workReview';
  const attendanceMode = isAdmin && mobileModule === 'attendance';
  if (els.mobileModuleSwitch) {
    els.mobileModuleSwitch.classList.toggle('disabled', !isAdmin);
    els.mobileModuleSwitch.setAttribute('aria-disabled', String(!isAdmin));
  }
  const title = document.getElementById('mobileBrandTitle');
  if (title) title.textContent = `帆顺科技${isAdmin ? '（管理员）' : ''}`;
  const moduleLabel = document.getElementById('mobileBrandModule');
  if (moduleLabel) moduleLabel.textContent = attendanceMode ? '考勤管理' : (workMode ? '报工审核' : '装车登记');
  const summary = document.querySelector('.mobile-summary');
  const tabs = document.querySelector('.mobile-tabs');
  if (summary) summary.hidden = workMode || attendanceMode;
  if (tabs) tabs.hidden = workMode || attendanceMode;
  if (els.mobileWorkModule) els.mobileWorkModule.hidden = !workMode;
  if (els.mobileAttendanceModule) els.mobileAttendanceModule.hidden = !attendanceMode;
  if (els.mobileCartBar) els.mobileCartBar.hidden = workMode || attendanceMode || ![...selected.values()].some((value) => Number(value) > 0);
  if (attendanceMode) {
    [els.mobileEntryPanel, els.mobileRemainingPanel, els.mobileRecordsPanel, els.mobileFilesPanel].forEach((panel) => { if (panel) panel.hidden = true; });
    switchMobileAttendanceTab(mobileAttendanceTab);
  } else if (workMode) {
    [els.mobileEntryPanel, els.mobileRemainingPanel, els.mobileRecordsPanel, els.mobileFilesPanel].forEach((panel) => { if (panel) panel.hidden = true; });
    switchMobileWorkTab(mobileWorkTab);
  } else {
    if (els.mobileWorkReportPanel) els.mobileWorkReportPanel.hidden = true;
    if (els.mobileWorkReviewPanel) els.mobileWorkReviewPanel.hidden = true;
  }
}
function switchMobileModule(module) {
  if ((module === 'workReview' || module === 'attendance') && boardRole !== 'admin') { showToast('只对管理员开放'); return; }
  mobileModule = (module === 'workReview' || module === 'attendance') ? module : 'entry';
  closeMobileModuleSheet();
  if (mobileModule === 'workReview') {
    renderMobileModule();
  } else if (mobileModule === 'attendance') {
    renderMobileModule();
  } else {
    if (els.mobileWorkReviewPanel) els.mobileWorkReviewPanel.hidden = true;
    if (els.mobileAttendanceModule) els.mobileAttendanceModule.hidden = true;
    switchMobileTab('entry');
  }
  renderMobileModule();
}
// 电脑端两个页面：实时总览 / 发货记录
function showDesktopView(name) {
  if ((name === 'workReview' || name === 'attendance') && boardRole !== 'admin') {
    showToast('只对管理员开放');
    name = 'overview';
  }
  const pages = {
    overview: document.getElementById('desktopView'),
    remaining: document.getElementById('desktopRemainingView'),
    shipments: document.getElementById('desktopShipmentsView'),
    files: document.getElementById('desktopFilesView'),
    drawings: document.getElementById('desktopDrawingsView'),
    loading: document.getElementById('desktopLoadingView'),
    workReport: document.getElementById('desktopWorkReportView'),
    workReview: document.getElementById('desktopWorkReviewView'),
    attendance: document.getElementById('desktopAttendanceView'),
  };
  if (!pages.overview || !pages.shipments) return;
  const target = pages[name] ? name : 'overview';
  desktopView = target;
  for (const [key, section] of Object.entries(pages)) {
    if (section) section.hidden = key !== target;
  }
  document.querySelectorAll('[data-desktop-view]').forEach((link) => {
    link.classList.toggle('active', link.dataset.desktopView === target);
  });
  if (target === 'remaining') renderDesktopRemaining();
  if (target === 'shipments') renderDesktopHistory();
  if (target === 'files') renderCloudFiles();
  if (target === 'drawings') renderDesktopDrawings();
  if (target === 'loading') renderDesktopLoading();
  if (target === 'workReport') loadWorkReportWorkspace().catch(() => {});
  if (target === 'workReview') loadWorkReviews().catch(() => {});
  if (target === 'attendance') loadAttendance().catch(() => {});
  window.scrollTo({ top: 0 });
  refreshElasticTabs();
}

function renderAll() {
  if (!snapshot) return;
  syncReplacementDueDate();
  renderDesktopMetrics();
  renderDesktopTable();
  renderDesktopHistory();
  renderOffsetBox();
  renderMobileSummary();
  renderMobileList();
  refreshRemainingViews();
  renderMobileRecords();
  renderCloudFiles();
  renderDesktopDrawings();
  renderCart();
  renderPhotoArchive();
  syncMobileStickyOffsets();
  if (els.desktopLoadingView && !els.desktopLoadingView.hidden) {
    if (!els.desktopLoadingCardList || !els.desktopLoadingCardList.contains(document.activeElement)) renderDesktopLoading();
    else { renderDesktopLoadingSummary(); renderDesktopLoadingCart(); renderDesktopLoadingRecords(); }
  }
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
  if (els.metricRemaining) els.metricRemaining.textContent = fmt(summary.remainingQuantity);
  if (els.metricRemainingHint) els.metricRemainingHint.textContent = `源数据未交 ${fmt(summary.sourceRemainingQuantity)} 件起算`;
  if (els.metricShipped) els.metricShipped.textContent = fmt(summary.shippedQuantity);
  if (els.metricShipmentCount) els.metricShipmentCount.textContent = summary.shipmentCount ? `${summary.shipmentCount} 笔发货记录` : '尚未提交发货';
  if (els.metricUrgent) els.metricUrgent.textContent = fmt(summary.overdue + summary.dueToday);
}

const DESKTOP_COLUMN_WIDTH_KEY = 'shipmentDesktopColumnWidths';
const DESKTOP_COLUMN_DEFAULT_WIDTHS = [125, 90, 200, 120, 60, 55, 65, 50, 70, 75, 85];

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
  const allColumns = [...document.querySelectorAll('#desktopOrdersColgroup col')];
  const spacer = allColumns.find((column) => column.classList.contains('col-spacer')) || null;
  const columns = allColumns.filter((column) => !column.classList.contains('col-spacer'));
  if (!columns.length) return;
  const normalized = columns.map((_, index) => {
    const width = Number(widths[index]);
    return Number.isFinite(width)
      ? Math.max(44, Math.min(420, Math.round(width)))
      : DESKTOP_COLUMN_DEFAULT_WIDTHS[index];
  });
  // 每一列都按用户设定/默认的像素宽固定下来：拖动某一列时其它列完全不动。
  columns.forEach((column, index) => { column.style.width = `${normalized[index]}px`; });
  if (spacer) spacer.style.width = 'auto';
  const table = columns[0].closest('table');
  if (table) {
    const total = normalized.reduce((sum, width) => sum + width, 0);
    // 表格铺满面板：多出来的空间全部由末尾的“填充列”吸收，不参与各列宽度分配。
    table.style.tableLayout = 'fixed';
    table.style.width = '100%';
    table.style.minWidth = `${Math.max(760, total)}px`;
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

const DESKTOP_REMAINING_COLUMN_WIDTH_KEY = 'shipmentDesktopRemainingColumnWidths';
const DESKTOP_REMAINING_COLUMN_DEFAULT_WIDTHS = [78, 180, 300, 262, 90, 90, 300];

function readDesktopRemainingColumnWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem(DESKTOP_REMAINING_COLUMN_WIDTH_KEY) || '[]');
    if (Array.isArray(saved) && saved.length === DESKTOP_REMAINING_COLUMN_DEFAULT_WIDTHS.length) {
      return saved.map((value, index) => {
        const width = Number(value);
        return Number.isFinite(width) ? Math.max(44, Math.min(520, Math.round(width))) : DESKTOP_REMAINING_COLUMN_DEFAULT_WIDTHS[index];
      });
    }
  } catch {}
  return [...DESKTOP_REMAINING_COLUMN_DEFAULT_WIDTHS];
}

function writeDesktopRemainingColumnWidths(widths) {
  try { localStorage.setItem(DESKTOP_REMAINING_COLUMN_WIDTH_KEY, JSON.stringify(widths)); } catch {}
}

function applyDesktopRemainingColumnWidths(widths = readDesktopRemainingColumnWidths()) {
  const columns = [...document.querySelectorAll('#desktopRemainingColgroup col')];
  if (!columns.length) return;
  const normalized = columns.map((_, index) => {
    const width = Number(widths[index]);
    return Number.isFinite(width) ? Math.max(44, Math.min(520, Math.round(width))) : DESKTOP_REMAINING_COLUMN_DEFAULT_WIDTHS[index];
  });
  columns.forEach((column, index) => { column.style.width = `${normalized[index]}px`; });
  const table = columns[0].closest('table');
  if (table) {
    const width = Math.max(760, normalized.reduce((sum, item) => sum + item, 0));
    table.style.tableLayout = 'fixed';
    table.style.width = `${width}px`;
    table.style.minWidth = `${width}px`;
  }
}

function setupDesktopRemainingColumnResize() {
  const table = document.querySelector('#desktopRemainingView .grouped-remaining-table');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')];
  headers.forEach((header, index) => {
    const handle = header.querySelector('.col-resizer');
    if (!handle) return;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const widths = readDesktopRemainingColumnWidths();
      const startWidth = widths[index];
      const onMove = (moveEvent) => {
        widths[index] = Math.max(44, Math.min(520, Math.round(startWidth + moveEvent.clientX - startX)));
        applyDesktopRemainingColumnWidths(widths);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        handle.classList.remove('dragging');
        writeDesktopRemainingColumnWidths(widths);
      };
      handle.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    handle.addEventListener('dblclick', () => {
      const widths = readDesktopRemainingColumnWidths();
      widths[index] = DESKTOP_REMAINING_COLUMN_DEFAULT_WIDTHS[index];
      applyDesktopRemainingColumnWidths(widths);
      writeDesktopRemainingColumnWidths(widths);
    });
  });
}
const DELIVERY_GROUPED_COLUMN_WIDTH_KEY = 'shipmentDeliveryGroupedColumnWidths';
const DELIVERY_MERGED_COLUMN_WIDTH_KEY = 'shipmentDeliveryMergedColumnWidths';
const DELIVERY_COLUMN_DEFAULT_WIDTHS = {
  grouped: [150, 130, 220, 82, 58, 76],
  merged: [135, 112, 180, 76, 52, 70, 106, 92],
};

function deliveryColumnWidthKey(kind) {
  return kind === 'merged' ? DELIVERY_MERGED_COLUMN_WIDTH_KEY : DELIVERY_GROUPED_COLUMN_WIDTH_KEY;
}

function readDeliveryColumnWidths(kind) {
  const defaults = DELIVERY_COLUMN_DEFAULT_WIDTHS[kind] || DELIVERY_COLUMN_DEFAULT_WIDTHS.grouped;
  try {
    const saved = JSON.parse(localStorage.getItem(deliveryColumnWidthKey(kind)) || '[]');
    if (Array.isArray(saved) && saved.length === defaults.length) {
      return saved.map((value, index) => {
        const width = Number(value);
        return Number.isFinite(width) ? Math.max(44, Math.min(520, Math.round(width))) : defaults[index];
      });
    }
  } catch { }
  return [...defaults];
}

function writeDeliveryColumnWidths(kind, widths) {
  try { localStorage.setItem(deliveryColumnWidthKey(kind), JSON.stringify(widths)); } catch { }
}

function applyDeliveryColumnWidths(kind, widths = readDeliveryColumnWidths(kind)) {
  const selector = kind === 'merged' ? '.delivery-lines.merged' : '.delivery-lines.grouped';
  const lines = [...document.querySelectorAll(selector)];
  if (!lines.length) return;
  // 手机端是纵向堆叠布局：不套用固定列宽，否则整行会被撑到 700px 以上并出现横向滚动
  if (window.matchMedia('(max-width: 900px)').matches) {
    lines.forEach((line) => {
      line.style.minWidth = '';
      [...line.children].forEach((child) => { child.style.gridTemplateColumns = ''; });
    });
    return;
  }
  const defaults = DELIVERY_COLUMN_DEFAULT_WIDTHS[kind] || DELIVERY_COLUMN_DEFAULT_WIDTHS.grouped;
  const normalized = defaults.map((fallback, index) => {
    const width = Number(widths[index]);
    return Number.isFinite(width) ? Math.max(44, Math.min(520, Math.round(width))) : fallback;
  });
  const template = normalized.map((width) => `${width}px`).join(' ');
  const total = normalized.reduce((sum, width) => sum + width, 0);
  lines.forEach((line) => {
    line.style.minWidth = `${total}px`;
    [...line.children]
      .filter((child) => child.classList.contains('delivery-lines-head') || child.classList.contains('delivery-line'))
      .forEach((child) => { child.style.gridTemplateColumns = template; });
  });
}

function setupDeliveryColumnResize() {
  document.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.history-col-resizer');
    if (!handle || event.button !== 0) return;
    const kind = handle.dataset.deliveryKind === 'merged' ? 'merged' : 'grouped';
    const index = Number(handle.dataset.deliveryCol);
    if (!Number.isFinite(index)) return;
    event.preventDefault();
    const startX = event.clientX;
    const widths = readDeliveryColumnWidths(kind);
    const startWidth = widths[index];
    const onMove = (moveEvent) => {
      widths[index] = Math.max(44, Math.min(520, Math.round(startWidth + moveEvent.clientX - startX)));
      applyDeliveryColumnWidths(kind, widths);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      handle.classList.remove('dragging');
      writeDeliveryColumnWidths(kind, widths);
    };
    handle.classList.add('dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  document.addEventListener('dblclick', (event) => {
    const handle = event.target.closest('.history-col-resizer');
    if (!handle) return;
    const kind = handle.dataset.deliveryKind === 'merged' ? 'merged' : 'grouped';
    const index = Number(handle.dataset.deliveryCol);
    const defaults = DELIVERY_COLUMN_DEFAULT_WIDTHS[kind] || DELIVERY_COLUMN_DEFAULT_WIDTHS.grouped;
    const widths = readDeliveryColumnWidths(kind);
    widths[index] = defaults[index];
    applyDeliveryColumnWidths(kind, widths);
    writeDeliveryColumnWidths(kind, widths);
  });
}

function renderDesktopTable() {
  const rows = desktopRows();
  els.desktopTableBody.innerHTML = rows.map((order) => {
    const badge = dueBadge(order);
    const orderQty = Number(order.orderQty ?? order.openingRemaining ?? 0);
    const amount = amountFor(order.id);
    const priceText = boardRole === 'admin' && amount && amount.unitPrice != null ? fmt(amount.unitPrice) : '--';
    const amountText = boardRole === 'admin' && amount && amount.amount != null ? fmt(amount.amount) : '--';
    return `
      <tr>
        <td><span class="order-id">${escapeHtml(order.po)}</span><span class="company-tag" title="${escapeHtml(companyName(orderCompany(order)))}">${escapeHtml(orderCompany(order) || '—')}</span>${orderTypeTagHtml(order.orderType)}${boardRole === 'admin' ? `<button type="button" class="order-edit-link" data-edit-order="${escapeHtml(order.id)}">变更</button>` : ''}</td>
        <td><span class="material-code mono">${escapeHtml(order.material)}</span>${(() => { const info = materialSummary(order); return info.count > 1 ? `<span class="material-total-tag" title="同一物料编号所有采购单合计未交">共${fmt(info.total)}/${info.count}单</span>` : ''; })()}${(() => { const d = drawingFor(order); return d ? drawingLinkHtml(d) : ''; })()}</td>
        <td><span class="item-name">${escapeHtml(order.name)}</span></td>
        <td><span class="spec-code mono">${escapeHtml(order.spec || '—')}</span></td>
        <td class="number"><span class="order-qty-number">${fmt(orderQty)}</span></td>
        <td class="number"><span class="shipped-number">${fmt(order.shipped)}</span></td>
        <td class="number"><span class="remaining-number">${fmt(order.remaining)}</span></td>
        <td class="number">${escapeHtml(order.seq)}</td>
        <td class="number">${escapeHtml(priceText)}</td>
        <td class="number">${escapeHtml(amountText)}</td>
        <td><span class="due-date">${escapeHtml(formatDate(order.dueDate))}</span><span class="due-badge ${badge.className}">${escapeHtml(dueStatus(order).text)}</span></td>
        <td class="col-spacer" aria-hidden="true"></td>
      </tr>`;
  }).join('');
  els.desktopEmpty.hidden = rows.length > 0;
}function currentEditingOrder() {
  return (snapshot?.orders || []).find((order) => String(order.id) === String(editingOrderId));
}

function closeOrderEdit() {
  editingOrderId = '';
  if (els.orderEditModal) els.orderEditModal.hidden = true;
  if (els.orderEditError) els.orderEditError.hidden = true;
}

function openOrderEdit(orderId) {
  if (boardRole !== 'admin') { showToast('只有管理员模式可以变更订单'); return; }
  const order = (snapshot?.orders || []).find((row) => String(row.id) === String(orderId));
  if (!order) { showToast('找不到这笔订单'); return; }
  editingOrderId = String(order.id);
  orderEditBaseRevision = snapshot?.revision ?? null;
  if (els.orderEditInfo) {
    els.orderEditInfo.innerHTML = `<strong>${escapeHtml(order.material)} · ${escapeHtml(order.name || '')}</strong>`
      + `<span>${escapeHtml(order.po)} · 项次 ${escapeHtml(order.seq)} · 已发货 ${fmt(order.shipped)} 件</span>`
      + `${order.spec ? `<span>图号：${escapeHtml(order.spec)}</span>` : ''}`;
  }
  if (els.orderEditQty) els.orderEditQty.value = String(Number(order.orderQty || order.openingRemaining || 0));
  if (els.orderEditShipped) els.orderEditShipped.value = String(Number(order.shipped || 0));
  if (els.orderEditDue) els.orderEditDue.value = order.dueDate || '';
  if (els.orderEditType) {
    const t = String(order.orderType || '');
    els.orderEditType.value = ['trial', 'sample', 'tooling'].includes(t) ? t : 'normal';
  }
  if (els.orderEditError) els.orderEditError.hidden = true;
  if (els.orderEditModal) els.orderEditModal.hidden = false;
  els.orderEditQty?.focus();
}

async function saveOrderEdit() {
  const order = currentEditingOrder();
  if (!order) { showToast('找不到这笔订单'); closeOrderEdit(); return; }
  const rawQty = String(els.orderEditQty?.value || '').trim();
  const rawShipped = String(els.orderEditShipped?.value || '').trim();
  const dueDate = String(els.orderEditDue?.value || '');
  const errorBox = els.orderEditError;
  const fail = (message) => {
    if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; }
    showToast(message);
  };
  if (!/^\d+$/.test(rawQty)) { fail('订单数量只能填整数'); return; }
  const orderQty = Number(rawQty);
  if (!Number.isSafeInteger(orderQty) || orderQty < 0) { fail('订单数量只能填 0 或正整数'); return; }
  if (!/^\d+$/.test(rawShipped)) { fail('已交数量只能填整数'); return; }
  const shippedQty = Number(rawShipped);
  if (!Number.isSafeInteger(shippedQty) || shippedQty < 0) { fail('已交数量只能填 0 或正整数'); return; }
  const cancelling = orderQty === 0;
  if (cancelling && shippedQty > 0) {
    fail('该订单已有发货记录，需先撤回发货后再取消订单');
    return;
  }
  if (cancelling && !window.confirm(`确定取消订单 ${order.po} 项次 ${order.seq} 吗？\n取消后该订单会从未交清单移除。`)) return;
  if (!cancelling && orderQty < shippedQty) {
    fail(`订单数量不能小于已交数量 ${fmt(shippedQty)}`);
    return;
  }
  if (!cancelling && !dueDate) { fail('请选择交货日期'); return; }
  if (!(await confirmFreshRevision(orderEditBaseRevision, '订单变更'))) return;
  orderEditBaseRevision = snapshot?.revision ?? null;
  const button = els.orderEditSave;
  if (button) button.disabled = true;
  try {
    const result = await callRpc('board_update_order', {
      p_code: getAccessCode(),
      p_order_id: order.id,
      p_order_qty: orderQty,
      p_shipped_qty: shippedQty,
      p_due_date: cancelling ? null : dueDate,
    });
    if (!result.response.ok) throw new Error(result.data?.message || '保存失败');
    // 订单类型（试制/承样/工装）单独保存：接口要的是数据库里的真实订单 id
    const nextType = String(els.orderEditType?.value || 'normal');
    const nowType = ['trial', 'sample', 'tooling'].includes(String(order.orderType || '')) ? String(order.orderType) : 'normal';
    if (nextType !== nowType) {
      const typeResult = await callRpc('board_set_order_type', { p_code: getAccessCode(), p_order_id: order.id, p_order_type: nextType });
      if (!typeResult.response.ok) throw new Error(typeResult.data?.message || '订单类型保存失败');
    }
    closeOrderEdit();
    if (cancelling) {
      showToast(`已取消 ${order.po} 项次 ${order.seq}`);
    } else {
      showToast(`已更新 ${order.po} 项次 ${order.seq}：数量 ${fmt(orderQty)}，交期 ${dueDate}`);
    }
    await loadState({ quiet: true });
    renderAll();
  } catch (error) {
    fail(error.message || '保存失败');
  } finally {
    if (button) button.disabled = false;
  }
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

function orderLookupMap() {
  return new Map((snapshot?.orders || []).map((order) => [String(order.id || ''), order]));
}

function orderMetaFor(orderId, fallback = {}, lookup = null) {
  const source = lookup || orderLookupMap();
  const id = String(orderId || '');
  const order = source.get(id) || null;
  const [poPart, seqPart] = id.split('#');
  const orderQty = Number(order?.orderQty ?? order?.openingRemaining ?? 0);
  return {
    order,
    po: String(order?.po || poPart || fallback.po || '').trim(),
    seq: String(order?.seq ?? seqPart ?? fallback.seq ?? '').trim(),
    orderQty: Number.isFinite(orderQty) ? orderQty : 0,
    shipped: Number(order?.shipped ?? fallback.shipped ?? 0),
    remaining: Number(order?.remaining ?? fallback.remaining ?? 0),
    material: String(order?.material || fallback.material || '').trim(),
    name: String(order?.name || fallback.name || '').trim(),
    spec: String(order?.spec || fallback.spec || '').trim(),
  };
}

function orderMetaSearchText(orderId, fallback = {}, lookup = null) {
  const meta = orderMetaFor(orderId, fallback, lookup);
  // 只匹配可见的编号/品名信息；字段用 | 分隔，避免跨字段拼出假匹配（如 0717+22 -> 1722）
  return [meta.po, meta.seq, meta.material, meta.name, meta.spec].join('|').toLowerCase();
}

function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '');
}
function searchTokenList(query) {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return [];
  const spaced = text.split(/\s+/).filter(Boolean);
  if (spaced.length > 1) return spaced;
  const mixed = text.match(/[a-z]*\d{3,}[a-z]*|[\u4e00-\u9fa5]+/gi);
  return mixed && mixed.length ? mixed : [text];
}
function matchesSearchQuery(text, query) {
  const target = normalizeSearchText(query);
  if (!target) return true;
  const haystack = normalizeSearchText(text);
  if (haystack.includes(target)) return true;
  return searchTokenList(query).every((token) => haystack.includes(normalizeSearchText(token)));
}
function shipmentCompany(shipment) {
  const explicit = String(shipment?.customer || '').trim();
  if (explicit === '邦凡') return '邦凡';
  const items = shipment?.items || [];
  if (items.some((line) => /^6140/.test(String(line.material || '')) || /护栏|护脚栏/.test(String(line.name || '')))) return '邦凡';
  if (explicit === '艾沃意特') return '艾沃意特';
  const batch = deliveryBatchText(shipment?.deliveryBatch);
  const file = (snapshot?.deliveryFiles || []).find((row) => /\.xlsx$/i.test(String(row.fileName || '')) && deliveryBatchText(row.batch) === batch);
  return String(file?.kind || '艾沃意特').trim() || '艾沃意特';
}
function shipmentDisplayBatch(shipment) {
  const explicit = deliveryBatchText(shipment?.deliveryBatch);
  // 历史导入的发货统一写成「历史已开单」这个占位值。这里按
  // 「发货日期 + 公司」去云端送货单文件里找真实编号：
  // 取“这笔发货之后最近上传的那一份”，对应不出来才保留「历史已开单」。
  if (explicit === '历史已开单') {
    const day = shipShanghaiDate(shipment?.createdAt);
    const company = shipmentCompany(shipment);
    const at = Date.parse(String(shipment?.createdAt || '')) || 0;
    const files = (snapshot?.deliveryFiles || [])
      .filter((row) => /\.xlsx$/i.test(String(row.fileName || ''))
        && String(row.deliveryDate || '') === day
        && (!company || String(row.kind || '').trim() === company)
        && deliveryBatchText(row.batch))
      .map((row) => ({ batch: deliveryBatchText(row.batch), at: Date.parse(String(row.createdAt || '')) || 0 }))
      .sort((a, b) => a.at - b.at);
    if (files.length) {
      const hit = files.find((file) => !at || file.at >= at) || files[files.length - 1];
      if (hit && hit.batch) return hit.batch;
    }
    return '历史已开单';
  }
  if (explicit) return explicit;
  const date = shipShanghaiDate(shipment?.createdAt);
  const company = shipmentCompany(shipment);
  const assignedBatches = new Set((snapshot?.shipments || [])
    .map((row) => deliveryBatchText(row.deliveryBatch))
    .filter((batch) => batch && batch !== '历史已开单'));
  const candidates = (snapshot?.deliveryFiles || []).filter((row) => {
    const batch = deliveryBatchText(row.batch);
    return /\.xlsx$/i.test(String(row.fileName || ''))
      && String(row.deliveryDate || '') === date
      && (!company || String(row.kind || '').trim() === company)
      && batch
      && !assignedBatches.has(batch);
  });
  if (candidates.length) {
    candidates.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return deliveryBatchText(candidates[0].batch) || '';
  }
  return ''; // 没开单：按单笔发货单独成卡，显示“未开单发货”
}

function recordAvailableDates(company = recordsCompany) {
  const dates = new Set();
  for (const shipment of (snapshot?.shipments || [])) {
    if (company && shipmentCompany(shipment) !== company) continue;
    const date = shipShanghaiDate(shipment.createdAt);
    if (date) dates.add(date);
  }
  return [...dates].sort();
}

function recordAvailableMonths() {
  return [...new Set(recordAvailableDates().map((date) => date.slice(0, 7)))].sort().reverse();
}

function recordBatchOptions(company = recordsCompany) {
  const batches = new Set();
  for (const row of (snapshot?.deliveryFiles || [])) {
    if (!/\.xlsx$/i.test(String(row.fileName || ''))) continue;
    if (company && String(row.kind || '').trim() !== company) continue;
    const batch = deliveryBatchText(row.batch);
    if (batch) batches.add(batch);
  }
  for (const shipment of (snapshot?.shipments || [])) {
    if (company && shipmentCompany(shipment) !== company) continue;
    const batch = shipmentDisplayBatch(shipment);
    if (batch && batch !== '历史已开单') batches.add(batch);
  }
  return [...batches].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
    return String(b).localeCompare(String(a), 'zh-CN');
  });
}

function renderMobileRecordFilterPanel() {
  const panel = document.getElementById('recordsFilterPanel');
  if (!panel) return;
  if (!recordsFilterPanel) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  if (recordsFilterPanel === 'company') {
    panel.innerHTML = `<div class="record-filter-options">
      ${['艾沃意特', '邦凡'].map((company) => `<button type="button" class="record-filter-option ${company === recordsCompany ? 'active' : ''}" data-record-company="${escapeHtml(company)}">${escapeHtml(company)}</button>`).join('')}
    </div>`;
    return;
  }
  if (recordsFilterPanel === 'batch') {
    const options = recordBatchOptions();
    panel.innerHTML = `<div class="record-filter-options">
      <button type="button" class="record-filter-option ${recordsBatch ? '' : 'active'}" data-record-batch="">全部发货编号</button>
      ${options.map((batch) => `<button type="button" class="record-filter-option ${batch === recordsBatch ? 'active' : ''}" data-record-batch="${escapeHtml(batch)}">${escapeHtml(batch)}</button>`).join('') || '<span class="record-filter-empty">当前公司还没有发货编号</span>'}
    </div>`;
    return;
  }
  const months = recordAvailableMonths();
  if (!recordsMonth || !months.includes(recordsMonth)) recordsMonth = months[0] || '';
  const dates = recordAvailableDates().filter((date) => date.startsWith(recordsMonth));
  if (!recordsMonth) {
    panel.innerHTML = '<div class="record-filter-empty">当前公司还没有可筛选的发货日期</div>';
    return;
  }
  const [year, month] = recordsMonth.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dayButtons = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = `${recordsMonth}-${String(day).padStart(2, '0')}`;
    const available = dates.includes(date);
    return `<button type="button" class="record-date-option ${available ? '' : 'blocked'} ${recordsDate === date ? 'active' : ''}" ${available ? `data-record-date="${date}"` : 'disabled'}>${day}</button>`;
  }).join('');
  panel.innerHTML = `
    <div class="record-month-row">
      <select id="recordsMonthSelect" class="record-month-select">
        ${months.map((monthValue) => `<option value="${monthValue}" ${monthValue === recordsMonth ? 'selected' : ''}>${monthValue.slice(0, 4)}年${monthValue.slice(5, 7)}月</option>`).join('')}
      </select>
      <button type="button" class="record-filter-option ${recordsDate ? '' : 'active'}" data-record-date="">全部发货日期</button>
    </div>
    <div class="record-date-grid">${dayButtons}</div>`;
}

function renderMobileRecordFilters() {
  const companyButton = document.getElementById('recordsCompanyFilter');
  const batchButton = document.getElementById('recordsBatchFilter');
  const dateButton = document.getElementById('recordsDateFilter');
  if (companyButton) companyButton.textContent = recordsCompany || '全部公司';
  if (batchButton) batchButton.textContent = recordsBatch ? `发货编号 ${recordsBatch}` : '全部发货编号';
  if (dateButton) dateButton.textContent = recordsDate ? `发货日期 ${recordsDate}` : '全部发货日期';
  document.querySelectorAll('[data-record-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.recordFilter === recordsFilterPanel);
  });
  renderMobileRecordFilterPanel();
}

function handleMobileRecordFilterClick(event) {
  const filterButton = event.target.closest('[data-record-filter]');
  if (filterButton) {
    recordsFilterPanel = recordsFilterPanel === filterButton.dataset.recordFilter ? '' : filterButton.dataset.recordFilter;
    renderMobileRecordFilters();
    return true;
  }
  const companyButton = event.target.closest('[data-record-company]');
  if (companyButton) {
    recordsCompany = companyButton.dataset.recordCompany || '艾沃意特';
    recordsBatch = '';
    recordsDate = '';
    recordsMonth = '';
    recordsFilterPanel = '';
    renderMobileRecords();
    return true;
  }
  const batchButton = event.target.closest('[data-record-batch]');
  if (batchButton) {
    recordsBatch = batchButton.dataset.recordBatch || '';
    recordsDate = '';
    recordsFilterPanel = '';
    renderMobileRecords();
    return true;
  }
  const dateButton = event.target.closest('[data-record-date]');
  if (dateButton) {
    recordsDate = dateButton.dataset.recordDate || '';
    recordsFilterPanel = '';
    renderMobileRecords();
    return true;
  }
  return false;
}

if (els.mobileRecordsPanel) {
  els.mobileRecordsPanel.addEventListener('click', handleMobileRecordFilterClick);
  els.mobileRecordsPanel.addEventListener('change', (event) => {
    if (event.target.id === 'recordsMonthSelect') {
      recordsMonth = event.target.value;
      renderMobileRecordFilterPanel();
    }
  });
}
function shipmentMatches(shipment, query, lookup = null) {
  if (!query) return true;
  const map = lookup || orderLookupMap();
  const text = [
    shipment.deliveryBatch, shipmentDisplayBatch(shipment), shipment.billedAt, shipment.vehicle, shipment.operator, shipment.note,
    ...shipment.items.flatMap((line) => [line.material, line.name, line.spec, orderMetaSearchText(line.orderId, line, map)]),
  ].join('|');
  return matchesSearchQuery(text, query);
}

function filterShipments(date, queryText) {
  if (!snapshot) return [];
  const query = String(queryText || '').trim().toLowerCase();
  const lookup = orderLookupMap();
  return snapshot.shipments.filter((shipment) => {
    if (date && shipShanghaiDate(shipment.createdAt) !== date) return false;
    return shipmentMatches(shipment, query, lookup);
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
  const orderLookup = orderLookupMap();
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
        ${shown.map((line) => {
          const meta = orderMetaFor(line.orderId, line, orderLookup);
          return `<div class="history-line history-line-rich">
            <div class="history-line-main"><span><b>${escapeHtml(line.material)}</b> ${escapeHtml(line.name || '')}${line.spec ? ' · ' + escapeHtml(line.spec) : ''}</span><strong>本次 ${fmt(line.quantity)} 件</strong></div>
            <div class="history-line-meta"><span>采购单号：${escapeHtml(meta.po || '无')}</span><span>项次：${escapeHtml(meta.seq || '无')}</span><span>订单量：${fmt(meta.orderQty)}</span><span>已发：${fmt(meta.shipped)}</span><span>未交：${fmt(meta.remaining)}</span></div>
          </div>`;
        }).join('')}
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
  syncHistoryTodayButton();
}

document.querySelectorAll('[data-query-tab]').forEach((button) => {
  button.addEventListener('click', () => { queryTab = button.dataset.queryTab; applyQueryTab(); if (button.closest('#mobileRecordsPanel')) renderMobileRecords(); });
});

function syncQueryInputs() {
  const set = (el, value) => { if (el && el.value !== value) el.value = value; };
  set(els.offsetSearch, offsetQuery); set(els.offsetDate, offsetDate);
  set(els.recordsOffsetSearch, offsetQuery); set(els.recordsOffsetDate, offsetDate);
  set(els.overSearch, overQuery); set(els.overDate, overDate);
  set(els.recordsOverSearch, overQuery); set(els.recordsOverDate, overDate);
  set(els.replacementHistorySearch, replacementQuery); set(els.replacementHistoryDate, replacementDate);
  set(els.recordsReplacementSearch, replacementQuery); set(els.recordsReplacementDate, replacementDate);
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
    const replacementFiltering = Boolean(replacementDate) || Boolean(replacementQuery.trim());
    containerReplacements.innerHTML = renderReplacementList()
      || (replacementFiltering
        ? '<div class="empty-state"><strong>没有符合条件的补发记录</strong><span>换个搜索词或清空日期再试。</span></div>'
        : '<div class="empty-state"><strong>还没有补发记录</strong><span>装车时用“补发（不良补货）”登记，就会出现在这里。</span></div>');
  }
  syncQueryInputs();
  applyQueryTab();
}

// 查询页：按送货单批次合并全部货物明细
function deliveryBatchText(value) {
  return String(value ?? '').trim();
}
function deliveryLineLabel(value, fallback = '无') {
  const text = String(value ?? '').trim();
  return text && text !== '-' && text !== '未填写' ? text : fallback;
}
function deliveryStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Shanghai' });
}
function deliveryItemMatches(line, meta, query) {
  // 只按用户能看到的字段匹配，避免内部 id 里的数字串造成误命中
  return matchesSearchQuery([
    meta.po, meta.seq, line.material, line.name, line.spec,
  ].join('|'), query);
}
function deliveryRemainingText(value, hasOrder) {
  if (!hasOrder) return '0';
  const number = Number(value || 0);
  return number > 0 ? `${fmt(number)} 件` : '0';
}
function buildDeliveryGroups(shipments, queryText = '') {
  const query = String(queryText || '').trim();
  const batchQuery = /^\d+$/.test(query) ? query : '';
  const orderLookup = orderLookupMap();
  const selectedBatch = new Set((shipments || []).map((shipment) => shipmentDisplayBatch(shipment)).filter(Boolean));
  const selectedShipmentIds = new Set((shipments || []).map((shipment) => String(shipment.id)));
  const allShipments = (snapshot?.shipments || []).filter((shipment) => {
    const batch = shipmentDisplayBatch(shipment);
    return selectedShipmentIds.has(String(shipment.id)) || (batch && selectedBatch.has(batch));
  });

  // 输入料件编号 / 品名时：只显示匹配的发货明细，按发货时间倒序，不合并整张送货单。
  // 纯数字查询既可能是料件编号、也可能是送货单号：只要有一行明细命中，就按明细显示。
  const hasItemMatch = query
    ? allShipments.some((shipment) => (shipment.items || []).some((line) => deliveryItemMatches(line, orderMetaFor(line.orderId, line, orderLookup), query)))
    : false;
  if (query && (!(batchQuery && selectedBatch.has(batchQuery)) || hasItemMatch)) {
    const searchGroups = [];
    for (const shipment of allShipments) {
      const items = [];
      for (const line of (shipment.items || [])) {
        const meta = orderMetaFor(line.orderId, line, orderLookup);
        if (!deliveryItemMatches(line, meta, query)) continue;
        items.push({
          key: ['search', meta.po, meta.seq, line.material, line.name, line.spec].map((v) => String(v || '')).join('|'),
          source: 'shipment',
          shipmentId: String(shipment.id),
          itemId: line.id,
          orderId: String(line.orderId || ''),
          typeLabel: '',
          po: deliveryLineLabel(meta.po, '无'),
          seq: deliveryLineLabel(meta.seq, '无'),
          material: deliveryLineLabel(line.material),
          name: deliveryLineLabel(line.name),
          spec: deliveryLineLabel(line.spec, ''),
          quantity: Number(line.quantity || 0),
          remaining: Number(meta.remaining || 0),
          hasOrder: Boolean(meta.po || meta.orderQty || meta.seq),
          remark: '',
        });
      }
      if (!items.length) continue;
      const displayBatch = shipmentDisplayBatch(shipment);
      searchGroups.push({
        key: `search:${shipment.id}`,
        batch: displayBatch,
        title: displayBatch ? `送货单 ${displayBatch} · ${deliveryStamp(shipment.createdAt)}` : `发货记录 · ${deliveryStamp(shipment.createdAt)}`,
        billed: Boolean(shipment.deliveryBatch),
        createdAt: shipment.createdAt,
        shipmentIds: [String(shipment.id)],
        items,
        searchMode: true,
      });
    }
    return searchGroups
      .map((group) => {
        const merged = new Map();
        for (const item of group.items) {
          const key = [item.po, item.seq, item.material, item.name, item.spec].join('|');
          const current = merged.get(key);
          if (current) current.quantity += item.quantity;
          else merged.set(key, { ...item });
        }
        group.items = [...merged.values()];
        group.total = group.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        return group;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  const map = new Map();
  const ensureGroup = (key, options = {}) => {
    if (!map.has(key)) {
      map.set(key, {
        key,
        batch: deliveryBatchText(options.batch),
        title: deliveryBatchText(options.batch) ? (/^\d+$/.test(deliveryBatchText(options.batch)) ? `送货单 ${deliveryBatchText(options.batch)}` : deliveryBatchText(options.batch)) : '未开单发货',
        billed: Boolean(options.batch),
        createdAt: options.createdAt || '',
        shipmentIds: [],
        items: [],
      });
    }
    return map.get(key);
  };
  for (const shipment of allShipments) {
    const batch = shipmentDisplayBatch(shipment);
    const key = batch ? `batch:${batch}` : `shipment:${shipment.id}`;
    const group = ensureGroup(key, { batch, createdAt: shipment.billedAt || shipment.createdAt });
    group.billed = group.billed || Boolean(batch);
    group.shipmentIds.push(String(shipment.id));
    for (const line of (shipment.items || [])) {
      const meta = orderMetaFor(line.orderId, line, orderLookup);
      group.items.push({
        key: ['shipment', meta.po, meta.seq, line.material, line.name, line.spec].map((v) => String(v || '')).join('|'),
        source: 'shipment',
        shipmentId: String(shipment.id),
        itemId: line.id,
        orderId: String(line.orderId || ''),
        typeLabel: '',
        po: deliveryLineLabel(meta.po, '无'),
        seq: deliveryLineLabel(meta.seq, '无'),
        material: deliveryLineLabel(line.material),
        name: deliveryLineLabel(line.name),
        spec: deliveryLineLabel(line.spec, ''),
        quantity: Number(line.quantity || 0),
        remaining: Number(meta.remaining || 0),
        hasOrder: Boolean(meta.po || meta.orderQty || meta.seq),
        remark: '',
        billed: Boolean(batch) || isBilledShipment(shipment.id),
      });
    }
  }
  const extras = [
    ...(snapshot?.replacements || []).map((row) => ({ ...row, source:'replacement' })),
    ...(snapshot?.overDeliveries || []).map((row) => ({ ...row, source:'over' })),
  ];
  for (const row of extras) {
    const batch = deliveryBatchText(row.deliveryBatch);
    if (!batch || !selectedBatch.has(batch)) continue;
    const group = ensureGroup(`batch:${batch}`, { batch, createdAt: row.billedAt || row.createdAt || row.deliveryDate });
    group.billed = true;
    const isReplacement = row.source === 'replacement';
    group.items.push({
      key: [row.source, isReplacement ? '补发' : '无订单', '无', row.material, row.name, row.spec].map((v) => String(v || '')).join('|'),
      source: row.source,
      typeLabel: isReplacement ? '补发' : '无订单',
      po: isReplacement ? '补发' : '无订单',
      seq: '无',
      material: deliveryLineLabel(row.material),
      name: deliveryLineLabel(row.name),
      spec: deliveryLineLabel(row.spec, ''),
      quantity: Number(row.quantity || 0),
      remaining: 0,
      hasOrder: false,
      remark: row.remark || row.note || '',
      billed: true,
    });
  }
  return [...map.values()].map((group) => {
    const merged = new Map();
    for (const item of group.items) {
      const key = [item.key, item.po, item.seq, item.material, item.name, item.spec].join('|');
      const current = merged.get(key);
      if (current) current.quantity += item.quantity;
      else merged.set(key, { ...item });
    }
    group.items = [...merged.values()];
    group.total = group.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    return group;
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
function qtyEditButtonHtml(item, billed) {
  if (boardRole !== 'admin' || !item || !item.itemId) return '';
  if (billed) return '<button type="button" class="qty-edit-btn" disabled title="已开单，不能修改发货数量">改</button>';
  return `<button type="button" class="qty-edit-btn" data-edit-qty="${escapeHtml(String(item.itemId))}" data-edit-value="${Number(item.quantity) || 0}" title="修改发货数量">改</button>`;
}
function renderDeliveryGroups(groups) {
  if (!groups.length) return '<div class="empty-state"><strong>没有符合条件的发货记录</strong><span>可以搜索送货单号、采购单号、料件编号或品名。</span></div>';
  return groups.map((group) => {
    const expanded = expandedShipments.has(group.key);
    const shown = expanded ? group.items : group.items.slice(0, 6);
    const hidden = group.items.length - shown.length;
    return `<article class="history-card delivery-batch-card ${group.billed ? 'billed-card' : ''}">
      <div class="history-head">
        <strong>${escapeHtml(group.title)}</strong>
      </div>
      <div class="delivery-lines grouped">
        <div class="delivery-lines-head"><span>采购单号<i class="history-col-resizer" data-delivery-kind="grouped" data-delivery-col="0" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span>料件编号<i class="history-col-resizer" data-delivery-kind="grouped" data-delivery-col="1" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span>品名<i class="history-col-resizer" data-delivery-kind="grouped" data-delivery-col="2" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="number">发货数量<i class="history-col-resizer" data-delivery-kind="grouped" data-delivery-col="3" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="number">项次<i class="history-col-resizer" data-delivery-kind="grouped" data-delivery-col="4" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="number">未交<i class="history-col-resizer" data-delivery-kind="grouped" data-delivery-col="5" role="separator" title="拖动调整列宽，双击恢复默认"></i></span></div>
        ${shown.map((item) => `<div class="delivery-line">
          <span data-label="采购单号">${escapeHtml(item.po)}${item.typeLabel ? ` <em>${escapeHtml(item.typeLabel)}</em>` : ''}</span>
          <span data-label="料件编号">${escapeHtml(item.material)}</span>
          <span data-label="品名"><span class="delivery-name-cell">${escapeHtml(item.name)}${item.spec ? ` · ${escapeHtml(item.spec)}` : ''}${item.remark ? `<small>备注：${escapeHtml(item.remark)}</small>` : ''}${shipmentPhotoButtonHtml(item)}</span></span>
          <strong data-label="发货数量" class="number"><span class="qty-value-with-edit">${fmt(item.quantity)} 件${qtyEditButtonHtml(item, item.billed)}</span></strong>
          <span data-label="项次" class="number">${escapeHtml(item.seq)}</span>
          <span data-label="未交" class="number">${escapeHtml(deliveryRemainingText(item.remaining, item.hasOrder))}</span>
        </div>`).join('')}
      </div>
      ${group.items.length > 6 ? `<button class="history-expand" type="button" data-expand="${escapeHtml(group.key)}">${expanded ? '收起明细' : `展开全部 ${group.items.length} 项（还有 ${hidden} 项）`}</button>` : ''}
      ${unitHistoryHtml(group.shipmentIds)}
      <div class="history-foot">
        <span class="history-total">合计 ${fmt(group.total)} 件 · ${group.items.length} 项</span>
        ${group.billed
          ? '<span class="row-locked">已开单</span>'
          : group.shipmentIds.length ? `<button class="row-revoke" type="button" data-undo="${escapeHtml(group.shipmentIds[0])}" title="撤销这笔发货">撤回</button>` : ''}
      </div>
    </article>`;
  }).join('');
}
function deliveryStampText(value) {
  const text = String(value || '').trim();
  if (!text) return '—';
  return text.replace('T', ' ').slice(0, 10);
}
function renderMergedDeliveryRows(groups) {
  const unitHtml = unitHistoryHtml(groups.flatMap((group) => group.shipmentIds || []));
  const rows = [];
  for (const group of groups) {
    for (const item of group.items) rows.push({ ...item, batch: group.batch || '', shippedAt: group.createdAt || '', billed: item.billed });
  }
  if (!rows.length) return '<div class="empty-state"><strong>没有符合条件的发货记录</strong><span>可以搜索送货单号、采购单号、料件编号或品名。</span></div>';
  rows.sort((a, b) => String(b.shippedAt || '').localeCompare(String(a.shippedAt || '')));
  return `<article class="history-card delivery-batch-card merged-card">
      <div class="delivery-lines merged">
        <div class="delivery-lines-head"><span>采购单号<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="0" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span>料件编号<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="1" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span>品名<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="2" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="number">发货数量<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="3" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="number">项次<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="4" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="number">未交<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="5" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="ship-batch-head">送货单编号<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="6" role="separator" title="拖动调整列宽，双击恢复默认"></i></span><span class="ship-date-head">发货日期<i class="history-col-resizer" data-delivery-kind="merged" data-delivery-col="7" role="separator" title="拖动调整列宽，双击恢复默认"></i></span></div>
        ${rows.map((item) => `<div class="delivery-line">
          <span data-label="采购单号">${escapeHtml(item.po)}${item.typeLabel ? ` <em>${escapeHtml(item.typeLabel)}</em>` : ''}</span>
          <span data-label="料件编号">${escapeHtml(item.material)}</span>
          <span data-label="品名"><span class="delivery-name-cell">${escapeHtml(item.name)}${item.spec ? ` · ${escapeHtml(item.spec)}` : ''}${item.remark ? `<small>备注：${escapeHtml(item.remark)}</small>` : ''}${shipmentPhotoButtonHtml(item)}</span></span>
          <strong data-label="发货数量" class="number"><span class="qty-value-with-edit">${fmt(item.quantity)} 件${qtyEditButtonHtml(item, item.billed)}</span></strong>
          <span data-label="项次" class="number">${escapeHtml(item.seq)}</span>
          <span data-label="未交" class="number">${escapeHtml(deliveryRemainingText(item.remaining, item.hasOrder))}</span>
          <span data-label="送货单编号" class="ship-batch">${escapeHtml(item.batch || '未开单')}</span>
          <span data-label="发货日期" class="ship-date">${escapeHtml(deliveryStampText(item.shippedAt))}</span>
        </div>`).join('')}
      </div>
      ${unitHtml}</article>`;
}
function renderShipmentSection(shipments, queryText = '') {
  const groups = buildDeliveryGroups(shipments, queryText);
  // 按料件编号/品名搜索时合并成一张连续的表，方便纵向核对；
  // 按送货单号搜索时仍按送货单分卡展示，保留送货单标题和撤回入口。
  if (String(queryText || '').trim() && groups.length && groups.every((group) => group.searchMode)) {
    return renderMergedDeliveryRows(groups);
  }
  return renderDeliveryGroups(groups);
}function renderDesktopHistory() {
  if (!snapshot) return;
  const rows = filteredShipments();
  const quantity = rows.reduce((sum, item) => sum + Number(item.totalQuantity || 0), 0);
  if (els.historySummary) {
    els.historySummary.textContent = rows.length === snapshot.shipments.length
      ? `共 ${rows.length} 笔 · 合计 ${fmt(quantity)} 件`
      : `筛选出 ${rows.length} 笔 · 合计 ${fmt(quantity)} 件`;
  }
  renderQueryPanes(els.shipmentHistory, els.offsetHistory, els.overHistory, renderShipmentSection(rows, historyQuery), els.replacementHistory);
  void renderCloudFiles();
  requestAnimationFrame(() => { applyDeliveryColumnWidths('grouped'); applyDeliveryColumnWidths('merged'); });
window.addEventListener('resize', () => { applyDeliveryColumnWidths('grouped'); applyDeliveryColumnWidths('merged'); });
}

function replacementPlanCard(plan, selected = false, legacyIndex = null) {
  const dueDate = String(plan.deliveryDate || plan.dueDate || '').trim() || defaultReplacementDueDate();
  const remark = replacementPlanNote(plan);
  const name = String(plan.name || '').trim();
  const planId = String(plan.id || plan.planId || '').trim();
  const drawing = drawingFor(plan);
  const hasPhoto = materialHasPhoto(plan);
  const drawingButton = drawing ? drawingLinkHtml(drawing) : '';
  const selectedAction = selected
    ? `<button type="button" class="cart-remove" data-unselect-replacement-plan="${escapeHtml(planId)}">取消装车</button>`
    : `<button type="button" class="button primary replacement-plan-load" data-select-replacement-plan="${escapeHtml(planId)}">装车</button>`;
  const legacyAction = `<button type="button" class="cart-remove" data-remove-replacement-plan="${legacyIndex}">取消计划</button>`;
  const photoAction = planId ? '<button type="button" class="photo-open' + (hasPhoto ? ' has-photo' : '') + '" data-photo-plan="' + escapeHtml(planId) + '">' + (hasPhoto ? '已留档' : '拍照留档') + '</button>' : '';
  const deleteAction = boardRole === 'admin' && planId
    ? `<button type="button" class="cart-remove" data-delete-replacement-plan="${escapeHtml(planId)}">删除计划</button>`
    : '';
  return `<article class="order-card replacement-plan-card" data-loading-kind="replacement" data-loading-due-date="${escapeHtml(dueDate)}">
    <div class="card-top">
      <div class="order-title">
        <div class="order-name-line"><strong>${escapeHtml(name || plan.material || '补发物料')}</strong><span class="replacement-plan-tag">补发</span>${drawingButton}<span class="replacement-plan-state">${selected ? '已加入本次装车' : '待装车'}</span></div>
        <span class="mono">${escapeHtml(plan.material || '')}${plan.spec ? ' · ' + escapeHtml(plan.spec) : ''}</span>
        ${plan.po ? `<span>${escapeHtml(plan.po)} · 项次 ${escapeHtml(plan.seq || '—')}</span>` : ''}
        <span>补发交期 ${escapeHtml(formatDate(dueDate))} · 4137</span>
      </div>
    </div>
    <div class="order-numbers">
      <div class="order-number"><span>补发数量</span><strong>${escapeHtml(fmt(plan.quantity))}</strong></div>
      <div class="order-number"><span>交期</span><strong>${escapeHtml(formatDate(dueDate))}</strong></div>
      <div class="order-number"><span>状态</span><strong>${selected ? '已装入' : '待装车'}</strong></div>
    </div>
    <div class="replacement-plan-note">补发原因：${escapeHtml(remark || '未填写')}</div>
    <div class="replacement-plan-actions">${photoAction}${selectedAction}${legacyIndex === null ? '' : legacyAction}${deleteAction}</div>
  </article>`;
}function orderCard(order) {
  const hasPhoto = materialHasPhoto(order);
  const badge = dueBadge(order);
  const selectedQuantity = Number(selected.get(order.id) || 0);
  const complete = order.remaining <= 0;
  return `
    <article class="order-card ${selectedQuantity ? 'selected' : ''} ${complete ? 'complete' : ''}" data-order-card="${escapeHtml(order.id)}">
      ${selectedQuantity ? `<span class="selected-tag">已选 ${fmt(selectedQuantity)}</span>` : ''}
      <div class="card-top">
        <div class="order-title">
          <div class="order-name-line"><strong>${escapeHtml(order.name)}</strong>${orderTypeTagHtml(order.orderType)}</div>
          <span class="mono">${escapeHtml(order.material)} · ${escapeHtml(order.spec)}${(() => { const d = drawingFor(order); return d ? ' ' + drawingLinkHtml(d) : ''; })()}</span>
          <span>${escapeHtml(order.po)} · 项次 ${escapeHtml(order.seq)}</span>
        </div>
        <span class="due-badge ${badge.className}">${escapeHtml(badge.text)}</span>
      </div>
      <div class="card-actions">
        ${order.orderType === 'sample' ? `<button type="button" class="sample-approval-open" data-sample-approval="${escapeHtml(order.id)}">样品承认书</button>` : ''}
        ${boardRole === 'admin' ? `<button type="button" class="order-edit-link mobile" data-edit-order="${escapeHtml(order.id)}">变更数量 / 交期</button>` : ''}
        ${(() => { const info = materialSummary(order); return info.count > 1
          ? `<div class="material-total">同料号共 ${info.count} 单 · 未交合计 <b>${fmt(info.total)}</b></div>` : ''; })()}
        <button type="button" class="photo-open${hasPhoto ? ' has-photo' : ''}" data-photo-order="${escapeHtml(order.id)}">${hasPhoto ? '已留档' : '拍照留档'}</button>
      </div>
      ${overDeliveryFor(order.material).length ? `<div class="material-total over">该料号已有无订单发货 <b>${fmt(overDeliveryFor(order.material).reduce((sum, row) => sum + Number(row.remaining || 0), 0))}</b> 件待冲抵</div>` : ''}
      <div class="order-numbers">
        <div class="order-number"><span>订单总数</span><strong>${fmt(order.openingRemaining)}</strong></div>
        <div class="order-number"><span>已发货</span><strong>${fmt(order.shipped)}</strong></div>
        <div class="order-number remaining"><span>剩余未交</span><strong>${fmt(order.remaining)}</strong></div>
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
  const items = loadingItems(mobileRows(), {
    unitFilter: (unit) => unitMatchesDueFilter(unit, mobileFilter),
    includeReplacements: mobileFilter === 'active',
    planQuery: mobileSearch,
  });
  const limit = 80;
  const shown = items.slice(0, limit);
  els.mobileOrderList.innerHTML = shown.map((item) => item.kind === 'replacement'
    ? replacementPlanCard(item.item, item.selected, item.legacyIndex)
    : item.kind === 'unit'
      ? unitCardHtml(item.unit, item.index)
      : orderCard(item.order)).join('');
  if (items.length > limit) {
    els.mobileOrderList.insertAdjacentHTML('beforeend', `<div class="empty-state mobile-empty"><strong>还有 ${items.length - limit} 项未显示</strong><span>请用搜索快速定位物料。</span></div>`);
  }
  els.mobileEmpty.hidden = items.length > 0;
  els.mobileEmpty.innerHTML = '<strong>没有符合条件的数据</strong><span>换个筛选条件或清空搜索词。</span>';
}

function renderMobileSummary() {
  const selectedItems = [...selected.values()].filter((value) => value > 0).length;
  const selectedQty = [...selected.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  const pendingOverRows = [...sessionOver.values()].filter((item) => Number(item.quantity) > 0);
  const pendingOverQty = pendingOverRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const replacementQty = replacementTotalQty();
  if (els.mobileSelectedQty) els.mobileSelectedQty.textContent = fmt(selectedQty + pendingOverQty + replacementQty);
  if (els.mobileSelectedItems) els.mobileSelectedItems.textContent = `${selectedItems + pendingOverRows.length + sessionReplacements.length} 项物料`;
  if (els.mobileRemainingQty) els.mobileRemainingQty.textContent = fmt(snapshot.summary.remainingQuantity);
  renderDesktopLoadingSummary();
}

function qtyText(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function selectedRemainingDates() {
  return [...remainingDates].filter(Boolean).sort();
}

function remainingBaseRows() {
  return [...filteredOrders('active'), ...replacementPlanRemainingRows()];
}

function remainingDateOptions() {
  const counts = new Map();
  for (const order of remainingBaseRows()) {
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
  if (!snapshot) return [];
  let rows = remainingBaseRows();
  const query = String(queryText || '').trim().toLowerCase();
  if (query) rows = rows.filter((order) => searchable(order).includes(query));
  if (remainingDates.size) rows = rows.filter((order) => remainingDates.has(String(order.dueDate || '').trim()));
  return rows;
}

function uniqueRemainingNames(values) {
  const fullwidth = /[\uFF08\uFF09\uFF3B\uFF3D\uFF5B\uFF5D\uFF0C\uFF1A\uFF1B]/g;
  const toHalfwidth = (ch) => ({
    '\uFF08': '(', '\uFF09': ')', '\uFF3B': '[', '\uFF3D': ']', '\uFF5B': '{', '\uFF5D': '}',
    '\uFF0C': ',', '\uFF1A': ':', '\uFF1B': ';',
  }[ch] || ch);
  const normalize = (value) => String(value || '')
    .replace(fullwidth, toHalfwidth)
    .replace(/[\u2010-\u2015\u2212\u2500\u2501\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\s+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const penalty = (value) => {
    const text = String(value || '');
    return (text.match(fullwidth) || []).length * 2
      + (text.match(/[\u2010-\u2015\u2212\u2500\u2501]/g) || []).length
      + (text.match(/-{2,}/g) || []).length
      + (text.match(/\s{2,}/g) || []).length;
  };
  const raw = [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
  raw.sort((a, b) => penalty(a) - penalty(b)
    || normalize(b).length - normalize(a).length
    || a.length - b.length
    || a.localeCompare(b, 'zh-CN'));
  const result = [];
  const keys = [];
  for (const name of raw) {
    const key = normalize(name);
    if (!key) continue;
    if (keys.some((existing) => existing === key || existing.includes(key) || key.includes(existing))) continue;
    keys.push(key);
    result.push(name);
  }
  return result;
}
function groupRemainingRows(rows) {
  const groups = new Map();
  for (const order of rows) {
    const material = String(order.material || '').trim();
    const name = String(order.name || '').trim();
    const spec = String(order.spec || '').trim();
    const dueDate = String(order.dueDate || '').trim();
    // 按「物料编号 + 交期」合并：同料号同交期才合并；不同交期另起一行，
    // 各自显示自己的未交数量，避免出现“交期写 10月10日、数量却是所有交期合计”的误解。
    const key = `${material || `${name}\u0000${spec}`}\u0000${dueDate}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        material,
        names: new Set(),
        specs: new Set(),
        dates: new Set(),
        companies: new Set(),
        total: 0,
        detailCount: 0,
        drawing: null,
        typeRank: 9,
        types: new Set(),
        mark: markMaterials.has(material),
        replacementTotal: 0,
        replacementCount: 0,
        hasReplacement: false,
      };
      groups.set(key, group);
    }
    if (!group.drawing) {
      const drawing = drawingFor(order);
      if (drawing) group.drawing = drawing;
    }
    const company = String(order.customer || '').trim();
    if (name) group.names.add(name);
    if (spec) group.specs.add(spec);
    if (dueDate) group.dates.add(dueDate);
    if (company) group.companies.add(company);
    group.total += Number(order.remaining || 0);
    if (order.isReplacementPlan) {
      group.replacementTotal += Number(order.remaining || 0);
      group.replacementCount += 1;
      group.hasReplacement = true;
    }
    group.detailCount += 1;
    group.typeRank = Math.min(group.typeRank, orderTypeRank(order));
    group.types.add(normalizeOrderType(order));
  }
  return [...groups.values()]
    .map((group) => {
      const names = uniqueRemainingNames([...group.names]);
      return {
      ...group,
      name: names.join('、'),
      names,
      specs: [...group.specs].sort(),
      dates: [...group.dates].sort(),
      companies: [...group.companies].sort(),
      types: [...group.types].filter((type) => Object.prototype.hasOwnProperty.call(ORDER_TYPE_LABELS, type))
        .sort((left, right) => ORDER_TYPE_RANK[left] - ORDER_TYPE_RANK[right]),
      };
    })
    .sort((left, right) => {
      const leftDate = left.dates[0] || '9999-12-31';
      const rightDate = right.dates[0] || '9999-12-31';
      return leftDate.localeCompare(rightDate)
        || (left.typeRank || 9) - (right.typeRank || 9)
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
  const visibleGroups = groups.slice(0, remainingVisibleLimit);
  // 每个料号“所有交期”的未交合计（不受当前交期筛选影响），显示在「未交」下面
  const materialTotals = labelRemainingAllDates();
  els.remainingList.innerHTML = `
    <div class="remaining-list-summary">
      <div><strong>${fmt(groups.length)} 项物料</strong></div>
      <em>${escapeHtml(selectedText)}</em>
    </div>
    ${visibleGroups.map((group) => {
      const companyText = group.companies.length > 1
        ? '两家公司'
        : companyName(group.companies[0] || '');
      const drawingButton = group.drawing ? drawingLinkHtml(group.drawing) : '';
      return `<article class="mobile-remaining-card">
        <div class="mobile-remaining-row">
          <div class="remaining-cell order-cell">
            <span>编号</span>
            <strong class="mono">${escapeHtml(group.material)}</strong>
            ${remainingTypeTagsHtml(group.types, group.hasReplacement)}
            ${group.mark ? '<em class="mark-badge">需打标</em>' : ''}
          </div>
          <div class="remaining-cell detail-cell">
            <div class="detail-copy">
              <div class="detail-line"><span>品名</span><strong>${escapeHtml(group.name)}</strong></div>
              <div class="detail-line"><span>规格</span><strong class="mono">${escapeHtml(group.specs.join('、') || '—')}</strong></div>
            </div>
            ${drawingButton ? `<div class="detail-drawing-slot">${drawingButton}</div>` : ''}
          </div>
          <div class="remaining-cell meta-cell">
            <div class="meta-line"><span>未交</span><strong class="quantity-value">${escapeHtml(qtyText(group.total))}</strong></div>
            <div class="meta-line total-line" title="该料号所有交期的未交合计"><span>总数</span><strong class="total-value">${escapeHtml(qtyText(materialTotals.get(String(group.material || '').trim()) ?? group.total))}</strong></div>
          </div>
          <div class="remaining-cell due-cell">
            <span>交期</span>
            <strong>${escapeHtml(remainingDateText(group.dates))}</strong>
          </div>
        </div>
      </article>`;
    }).join('')}
    ${groups.length > visibleGroups.length ? `<button type="button" class="load-more-button" data-remaining-load-more>加载更多（还有 ${fmt(groups.length - visibleGroups.length)} 项）</button>` : ''}`;
}

let labelRows = [];
let labelRowSeq = 0;
let labelPrintMode = 'big';           // big=大标签，small=小标签
let labelPrintSearch = '';            // 弹窗里的补打搜索词
let labelPrintedRecords = {};         // 本机永久打印记录：key -> { at, day, mode, count }
const LABEL_PRINTED_KEY = 'shipmentLabelPrinted';
const LABEL_STATS_KEY = 'shipmentLabelStats';
const LABEL_ASSIGN_KEY = 'shipmentLabelAssign';

// 固定一框数量的产品：编号里包含这些数字就按整框折算
const LABEL_BOX_RULES = [
  { key: '1443', perBox: 320 },
  { key: '8745', perBox: 216 },
  { key: '3502', perBox: 300, nameIncludes: '滑台加强槽板' },
];

function labelBoxRule(material, name) {
  const code = String(material || '');
  const text = String(name || '');
  return LABEL_BOX_RULES.find((rule) => code.includes(rule.key) && (!rule.nameIncludes || text.includes(rule.nameIncludes))) || null;
}

function labelBoxQuantityText(value, perBox) {
  const number = Number(value) || 0;
  if (!perBox || number <= 0) return '';
  const boxes = Math.ceil(number / perBox);
  return boxes * perBox + '（' + perBox + '×' + boxes + '框）';
}

function readLabelStats() {
  try {
    const saved = JSON.parse(localStorage.getItem(LABEL_STATS_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}

function writeLabelStats(stats) {
  try { localStorage.setItem(LABEL_STATS_KEY, JSON.stringify(stats)); } catch { }
}

function bumpLabelStats(materials, mode) {
  const stats = readLabelStats();
  [...new Set((materials || []).map((m) => String(m || '').trim()).filter(Boolean))].forEach((material) => {
    const row = stats[material] || { big: 0, small: 0 };
    row[mode] = Number(row[mode] || 0) + 1;
    stats[material] = row;
  });
  writeLabelStats(stats);
}

function labelMaterialCount(material, mode) {
  const row = readLabelStats()[String(material || '').trim()];
  return row ? Number(row[mode] || 0) : 0;
}

function readLabelAssign() {
  try {
    const saved = JSON.parse(localStorage.getItem(LABEL_ASSIGN_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}

function writeLabelAssign(assign) {
  try { localStorage.setItem(LABEL_ASSIGN_KEY, JSON.stringify(assign)); } catch { }
}

// 这个料号归哪种标签打：手动转过优先 → 再按打印习惯 → 都没有的默认归大标签
function labelAssignOf(material) {
  const key = String(material || '').trim();
  if (!key) return 'big';
  const explicit = readLabelAssign()[key];
  if (explicit === 'big' || explicit === 'small') return explicit;
  return labelHabit(key) || 'big';
}

function setLabelAssign(material, mode) {
  const key = String(material || '').trim();
  if (!key) return;
  const assign = readLabelAssign();
  assign[key] = mode === 'small' ? 'small' : 'big';
  writeLabelAssign(assign);
}

// 打印习惯：这个料号平时用哪种标签打（用来默认归类）
function labelHabit(material) {
  const big = labelMaterialCount(material, 'big');
  const small = labelMaterialCount(material, 'small');
  if (!big && !small) return '';
  return big >= small ? 'big' : 'small';
}

function nextLabelRowId() {
  labelRowSeq += 1;
  return 'lb' + labelRowSeq;
}

function labelToday() {
  return String((snapshot && snapshot.today) || TODAY || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
}

function labelShortDay(day) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return matched ? `${matched[2]}-${matched[3]}` : String(day || '');
}

function labelNowStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// 打印记录永久保存在本机（不再按天清零），所以第二天还能看出哪一项什么时候打过、能补打
function readPrintedRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem(LABEL_PRINTED_KEY) || '{}');
    if (saved && Array.isArray(saved.keys)) {
      const migrated = {};
      for (const key of saved.keys) {
        migrated[String(key)] = { at: `${saved.day || ''} 00:00`, day: String(saved.day || ''), mode: '', count: 1 };
      }
      writePrintedRecords(migrated);
      return migrated;
    }
    if (saved && saved.records && typeof saved.records === 'object') return saved.records;
    if (saved && typeof saved === 'object') return saved;
  } catch { }
  return {};
}

function writePrintedRecords(records) {
  try { localStorage.setItem(LABEL_PRINTED_KEY, JSON.stringify({ records })); } catch { }
}

function markLabelPrinted(keys, mode) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) return;
  const at = labelNowStamp();
  for (const key of list) {
    const previous = labelPrintedRecords[key] || {};
    labelPrintedRecords[key] = {
      at,
      day: at.slice(0, 10),
      mode: mode || previous.mode || '',
      count: Number(previous.count || 0) + 1,
    };
  }
  writePrintedRecords(labelPrintedRecords);
}

function labelSourceKey(group) {
  return [String(group.material || ''), (group.specs || []).join('、'), (group.dates || []).join(',')].join('|');
}

function labelModeText(mode = labelPrintMode) {
  return mode === 'small' ? '小标签' : '大标签';
}

function labelPool() {
  const onlyPrinted = Boolean(els.labelPrintShowPrinted && els.labelPrintShowPrinted.checked);
  const mode = labelPrintMode;
  const query = labelPrintSearch.trim().toLowerCase();
  // 只要在搜索，就把已打印的一起带出来，方便找出来补打
  const keepPrinted = Boolean(query) || Boolean(String(desktopRemainingSearch || '').trim());
  return remainingGroups(desktopRemainingSearch)
    .map((group) => {
      const key = labelSourceKey(group);
      return { group, key, record: labelPrintedRecords[key] || null };
    })
    // 归类：每个料号只出现在它归属的那一页
    .filter((item) => labelAssignOf(item.group.material) === mode)
    .filter((item) => (onlyPrinted ? Boolean(item.record) : (!item.record || keepPrinted)))
    .filter((item) => !query || [item.group.material, item.group.name, (item.group.specs || []).join(' ')]
      .some((value) => String(value || '').toLowerCase().includes(query)))
    // 打印习惯记忆：经常用这种标签的排前面
    .sort((a, b) => labelMaterialCount(b.group.material, mode) - labelMaterialCount(a.group.material, mode)
      || String(a.group.material || '').localeCompare(String(b.group.material || '')));
}

function labelRemainingAllDates() {
  // 待交合计：订单未交 + 有效补发计划，统计料号在所有交期上的数量，不受当前交期筛选影响
  const map = new Map();
  for (const row of remainingBaseRows()) {
    const remaining = Number(row.remaining || 0);
    if (remaining <= 0) continue;
    const material = String(row.material || '').trim();
    if (!material) continue;
    map.set(material, (map.get(material) || 0) + remaining);
  }
  return map;
}

function buildLabelRows() {
  const remainingAll = labelRemainingAllDates();
  return labelPool().map((item) => {
    const material = String(item.group.material || '');
    const record = item.record;
    const habit = labelHabit(material);
    const rule = labelBoxRule(material, item.group.name);
    return {
      id: nextLabelRowId(),
      sourceKey: item.key,
      printed: Boolean(record),
      printedAt: record ? String(record.at || '') : '',
      printedDay: record ? labelShortDay(record.day) : '',
      printedMode: record ? String(record.mode || '') : '',
      printedCount: record ? Number(record.count || 1) : 0,
      // 已打印的默认不勾（要补打自己勾上）；打印习惯是另一种标签的也不默认勾
      selected: !record && (!habit || habit === labelPrintMode),
      material,
      name: String(item.group.name || ''),
      spec: (item.group.specs || []).join('、'),
      quantity: rule
        ? labelBoxQuantityText(item.group.total, rule.perBox)
        : Number(item.group.total) || 0,
      remaining: remainingAll.has(material.trim())
        ? Number(remainingAll.get(material.trim()))
        : Number(item.group.total) || 0,
      perBox: rule ? rule.perBox : 0,
      habit,
      bigCount: labelMaterialCount(material, 'big'),
      smallCount: labelMaterialCount(material, 'small'),
      date: (item.group.dates || [])[0] || String((snapshot && snapshot.today) || '').slice(0, 10),
    };
  });
}

function openLabelPrintModal(mode = 'big') {
  if (!snapshot) return;
  labelPrintedRecords = readPrintedRecords();
  labelPrintSearch = '';
  if (els.labelPrintSearch) els.labelPrintSearch.value = '';
  labelPrintMode = mode === 'small' ? 'small' : 'big';
  labelRows = buildLabelRows();
  renderLabelRows();
  if (els.labelPrintError) els.labelPrintError.hidden = true;
  if (els.labelPrintModal) els.labelPrintModal.hidden = false;
}

function closeLabelPrintModal() {
  if (els.labelPrintModal) els.labelPrintModal.hidden = true;
}

function switchLabelPrintMode(mode) {
  labelPrintMode = mode === 'small' ? 'small' : 'big';
  labelRows = buildLabelRows();
  renderLabelRows();
  if (els.labelPrintError) els.labelPrintError.hidden = true;
}

function labelRowHtml(row, index) {
  // 已打印状态只用于「已打印」过滤，不在行里显示字样，免得挡内容
  const printedTag = '';
  const moveTarget = labelPrintMode === 'big' ? 'small' : 'big';
  const moveText = moveTarget === 'small' ? '转小标签' : '转大标签';
  return `<div class="label-print-row${row.printed ? ' printed' : ''}" data-label-row="${index}">
    <label class="label-print-check"><input type="checkbox" data-label-field="selected"${row.selected ? ' checked' : ''}></label>
    <input class="label-print-input mono" data-label-field="material" value="${escapeHtml(row.material)}" placeholder="物料编码">
    <input class="label-print-input" data-label-field="name" value="${escapeHtml(row.name)}" placeholder="物料名称">
    <input class="label-print-input" data-label-field="spec" value="${escapeHtml(row.spec)}" placeholder="规格">
    <div class="label-qty-cell">
      <input class="label-print-input number" type="text" inputmode="numeric" data-label-field="quantity" value="${escapeHtml(String(row.quantity ?? ''))}" placeholder="可填 6套">
    </div>
    <span class="label-remaining" data-label-remaining="${index}">${fmt(labelRowRemaining(row))}</span>
    <input class="label-print-input" type="date" data-label-field="date" value="${escapeHtml(row.date)}">
    <div class="label-print-row-actions">
      ${printedTag}
      <button type="button" class="label-row-btn" data-label-copy="${index}">复制</button>
      <button type="button" class="label-row-btn danger" data-label-remove="${index}">删除</button>
      <button type="button" class="label-row-btn move" data-label-move="${index}" title="把这一项固定到${moveText.slice(1)}打印（以后这个料号也按这个走）">${moveText}</button>
      <button type="button" class="label-row-btn done" data-label-mark="${index}" title="标记为已打印，从待打印列表里移走">已打印</button>
    </div>
    <div class="label-box-warn" data-label-box-warn="${index}" hidden></div>
  </div>`;
}

function renderLabelRows() {
  if (!els.labelPrintRows) return;
  els.labelPrintRows.innerHTML = labelRows.length
    ? labelRows.map((row, index) => labelRowHtml(row, index)).join('')
    : (labelPrintMode === 'small'
      ? '<div class="label-print-empty">小标签这边还没有料号。<br>在「大标签」页里，把要打小标签的那一行点「转小标签」，它就会挪到这里（会记住这个料号，下次自动归小标签）。</div>'
      : '<div class="label-print-empty">大标签这边没有待打印的产品了。<br>已经打印过的：勾上上面「已打印」，或直接搜索料号找出来补打。</div>');
  if (els.labelPrintModes) {
    els.labelPrintModes.querySelectorAll('[data-label-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.labelMode === labelPrintMode);
    });
  }
  if (els.labelPrintTip) {
    els.labelPrintTip.innerHTML = labelPrintMode === 'big'
      ? '<strong>大标签</strong>：勾选要打的（打 <strong>Brother DCP-L2628DW Printer</strong>）。<strong>没勾选的不会打印</strong>；要打小标签的行，点它后面的「转小标签」挪过去（会记住这个料号）。数量可以改；一架子放不下的点「复制」拆行。'
      : '<strong>小标签</strong>：这里只显示归属小标签的料号（在大标签页点「转小标签」挪过来的）。改好数量后勾选要打的（打 <strong>HPRT D35</strong>），没勾选的仍然不会打印。';
  }
  if (els.labelPrintConfirm) {
    els.labelPrintConfirm.textContent = labelPrintMode === 'big' ? '确认并打印大标签' : '确认并打印小标签';
  }
  if (els.labelPrintPrintedInfo) {
    const printedCount = Object.keys(labelPrintedRecords).length;
    els.labelPrintPrintedInfo.textContent = printedCount ? `本机已打印 ${printedCount} 项（可补打）` : '';
  }
  updateLabelSummary();
}

function labelMaterialFilled(material) {
  const key = String(material || '').trim();
  if (!key) return 0;
  return labelRows
    .filter((row) => String(row.material || '').trim() === key)
    .reduce((sum, row) => sum + labelRowQuantity(row), 0);
}

function refreshLabelRemaining() {
  if (!els.labelPrintRows) return;
  labelRows.forEach((row, index) => {
    const cell = els.labelPrintRows.querySelector(`[data-label-remaining="${index}"]`);
    const warn = els.labelPrintRows.querySelector(`[data-label-box-warn="${index}"]`);
    const remaining = labelRowRemaining(row);
    const filled = labelMaterialFilled(row.material);
    const box = labelBoxState(row);
    const over = !box && remaining > 0 && filled > remaining;
    if (cell) {
      cell.textContent = fmt(remaining) + (over ? `（已填 ${fmt(filled)}）` : '');
      cell.classList.toggle('over', over);
      cell.title = remaining > 0 ? `该料号未交合计 ${fmt(remaining)} 件，当前已填 ${fmt(filled)} 件` : '';
    }
    if (!warn) return;
    if (box && box.over) {
      const extra = box.rounded - box.remaining;
      if (row.overAccepted) {
        warn.hidden = false;
        warn.className = 'label-box-warn accepted';
        warn.innerHTML = `按 ${fmt(box.rounded)} 发，${fmt(extra)} 走无订单发货`;
      } else {
        warn.hidden = false;
        warn.className = 'label-box-warn over';
        warn.innerHTML = `<span>超出未交 ${fmt(extra)} 件</span>`
          + `<button type="button" data-label-box-fix="${index}">改成 ${escapeHtml(labelBoxFitText(box.remaining, box.perBox))}</button>`
          + `<button type="button" data-label-box-keep="${index}">按 ${fmt(box.rounded)} 发（${fmt(extra)} 无订单发货）</button>`;
      }
    } else {
      warn.hidden = true;
      warn.innerHTML = '';
    }
  });
}

function updateLabelSummary() {
  refreshLabelRemaining();
  if (!els.labelPrintSummary) return;
  const valid = labelRows.filter(labelRowIsValid);
  const picked = valid.filter((row) => row.selected);
  const reprinted = picked.filter((row) => row.printed).length;
  const total = picked.reduce((sum, row) => sum + labelRowQuantity(row), 0);
  const blank = picked.filter((row) => labelRowQuantity(row) === 0).length;
  const overMaterials = [...new Set(labelRows
    .filter((row) => {
      const remaining = labelRowRemaining(row);
      if (remaining <= 0) return false;
      const box = labelBoxState(row);
      if (box) return box.over && !row.overAccepted;
      return labelMaterialFilled(row.material) > remaining;
    })
    .map((row) => String(row.material || '').trim()))];
  els.labelPrintSummary.textContent = `${labelModeText()}：已勾选 ${picked.length} 行 / ${fmt(total)} 件`
    + (reprinted ? `（含补打 ${reprinted} 行）` : '')
    + (blank ? `（其中 ${blank} 行数量留空）` : '')
    + `，共 ${valid.length} 行`
    + (overMaterials.length ? `；⚠ ${overMaterials.join('、')} 已填数量超过订单未交` : '');
  if (els.labelPrintSelectAll) {
    els.labelPrintSelectAll.checked = valid.length > 0 && valid.every((row) => row.selected);
  }
  // 没勾选时不把按钮置灰：否则点了没反应，用户不知道问题在哪（点击时给提示）
}

function labelQuantityNumber(value) {
  // 数量允许带文字，例如「6套」「40根」，取里面的数字参与提示和合计
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const matched = text.match(/\d+(?:\.\d+)?/);
  if (!matched) return 0;
  const number = Number(matched[0]);
  return Number.isFinite(number) ? number : 0;
}

function labelRowQuantity(row) {
  return labelQuantityNumber(row.quantity);
}

function labelBoxState(row) {
  if (row.boxMixed) return null; // 用户已选“按未交数量拆框”，不再整框取整
  const rule = labelBoxRule(row.material, row.name);
  const perBox = row.perBox || (rule ? rule.perBox : 0);
  if (!perBox) return null;
  const entered = labelQuantityNumber(row.quantity);
  const rounded = entered > 0 ? Math.ceil(entered / perBox) * perBox : 0;
  const remaining = labelRowRemaining(row);
  return {
    perBox,
    entered,
    rounded,
    remaining,
    over: remaining > 0 && rounded > remaining,
  };
}

function labelBoxFitText(remaining, perBox) {
  const boxes = Math.floor(remaining / perBox);
  const rest = remaining - boxes * perBox;
  const parts = [];
  if (boxes > 0) parts.push(perBox + '×' + boxes);
  if (rest > 0) parts.push(String(rest));
  return remaining + '（' + parts.join('+') + '）';
}

function labelRowRemaining(row) {
  const value = Number(row.remaining);
  return Number.isFinite(value) ? value : 0;
}

function labelRowIsValid(row) {
  // 数量允许留空（空着代表自己手填），只要求有物料编码
  return Boolean(String(row.material || '').trim());
}

function labelRowIndex(target) {
  const row = target.closest('[data-label-row]');
  if (!row) return -1;
  const index = Number(row.dataset.labelRow);
  return Number.isInteger(index) && index >= 0 && index < labelRows.length ? index : -1;
}

function handleLabelPrintInput(event) {
  const field = event.target.dataset.labelField;
  if (!field) return;
  const index = labelRowIndex(event.target);
  if (index < 0) return;
  const row = labelRows[index];
  if (field === 'selected') row.selected = Boolean(event.target.checked);
  else if (field === 'quantity') row.quantity = event.target.value === '' ? '' : event.target.value;
  else row[field] = event.target.value;
  if (field === 'material' || field === 'name') {
    const rule = labelBoxRule(row.material, row.name);
    row.perBox = rule ? rule.perBox : 0;
  }
  updateLabelSummary();
}

function handleLabelPrintChange(event) {
  const field = event.target.dataset.labelField;
  if (field !== 'quantity') return;
  const index = labelRowIndex(event.target);
  if (index < 0) return;
  const row = labelRows[index];
  const liveRule = labelBoxRule(row.material, row.name);
  const perBox = row.perBox || (liveRule ? liveRule.perBox : 0);
  if (!row || !perBox) return;
  row.perBox = perBox;
  const entered = labelQuantityNumber(event.target.value);
  if (!entered) return;
  const text = labelBoxQuantityText(entered, perBox);
  row.quantity = text;
  row.overAccepted = false;
  row.boxMixed = false;
  event.target.value = text;
  updateLabelSummary();
}

function handleLabelPrintClick(event) {
  const copyButton = event.target.closest('[data-label-copy]');
  if (copyButton) {
    const index = Number(copyButton.dataset.labelCopy);
    const source = labelRows[index];
    if (!source) return;
    labelRows.splice(index + 1, 0, { ...source, id: nextLabelRowId(), printed: false });
    renderLabelRows();
    return;
  }
  const fixButton = event.target.closest('[data-label-box-fix]');
  if (fixButton) {
    const index = Number(fixButton.dataset.labelBoxFix);
    const row = labelRows[index];
    if (row) {
      const box = labelBoxState(row);
      if (box) {
        row.quantity = labelBoxFitText(box.remaining, box.perBox);
        row.overAccepted = false;
        row.boxMixed = true;
        renderLabelRows();
        showToast(`已改为 ${row.quantity}`);
      }
    }
    return;
  }
  const keepButton = event.target.closest('[data-label-box-keep]');
  if (keepButton) {
    const index = Number(keepButton.dataset.labelBoxKeep);
    const row = labelRows[index];
    if (row) {
      row.overAccepted = true;
      refreshLabelRemaining();
      updateLabelSummary();
      showToast(`按 ${labelBoxState(row).rounded} 发，超出部分走无订单发货`);
    }
    return;
  }
  const moveButton = event.target.closest('[data-label-move]');
  if (moveButton) {
    const index = Number(moveButton.dataset.labelMove);
    const row = labelRows[index];
    if (row) {
      const target = labelPrintMode === 'big' ? 'small' : 'big';
      setLabelAssign(row.material, target);
      showToast(`${row.material} 已归到${labelModeText(target)}打印`);
      labelRows = buildLabelRows();
      renderLabelRows();
    }
    return;
  }
  const markButton = event.target.closest('[data-label-mark]');
  if (markButton) {
    const index = Number(markButton.dataset.labelMark);
    const row = labelRows[index];
    if (row) {
      if (row.sourceKey) markLabelPrinted([row.sourceKey], labelPrintMode);
      labelRows.splice(index, 1);
      renderLabelRows();
      showToast(`${row.material} 已标记为已打印`);
    }
    return;
  }
  const removeButton = event.target.closest('[data-label-remove]');
  if (removeButton) {
    const index = Number(removeButton.dataset.labelRemove);
    if (index >= 0 && index < labelRows.length) labelRows.splice(index, 1);
    renderLabelRows();
  }
}

function showLabelPrintError(message) {
  if (!els.labelPrintError) return;
  els.labelPrintError.textContent = message;
  els.labelPrintError.hidden = false;
}

function labelPayload(rows) {
  return rows.map((row) => {
    const raw = String(row.quantity ?? '').trim();
    return {
      material: String(row.material || '').trim(),
      name: String(row.name || '').trim(),
      spec: String(row.spec || '').trim(),
      quantity: raw,
      date: String(row.date || '').trim(),
    };
  });
}

function finishLabelPrint(mode, sourceKeys, picked, result, manual) {
  markLabelPrinted(sourceKeys, mode);
  bumpLabelStats(picked.map((row) => row.material), mode);
  const rawWritten = mode === 'big' ? result?.bigRows : result?.smallRows;
  const written = Number.isFinite(Number(rawWritten)) ? Number(rawWritten) : sourceKeys.length;
  const errors = Array.isArray(result?.errors) && result.errors.length ? '；' + result.errors.join('；') : '';
  if (mode === 'big') {
    switchLabelPrintMode('small');
    showToast(manual
      ? `大标签已记为已打印（${sourceKeys.length} 项），已切到小标签：刚打过的不会重复出现，剩下的改好再确认${errors}`
      : `大标签已写入 ${written} 行并发送打印，已自动切到小标签：刚打过的 ${sourceKeys.length} 项已标为已打印，剩下的改好再确认${errors}`);
  } else {
    closeLabelPrintModal();
    showToast(manual
      ? `小标签已记为已打印（${sourceKeys.length} 项），打印习惯也记下了${errors}`
      : `小标签已写入 ${written} 行并发送打印，今天的标签任务完成${errors}`);
  }
}

async function closeLabelAppAfterManualPrint() {
  try { await deliveryHelper('/labels/complete', {}); } catch { }
}

async function confirmLabelPrint() {
  const mode = labelPrintMode;
  const valid = labelRows.filter(labelRowIsValid);
  const picked = valid.filter((row) => row.selected);
  if (!picked.length) {
    showLabelPrintError('还没有勾选要打印的行：在左边打勾后再点这个按钮（已打印的也可以勾上补打）。');
    showToast('还没有勾选要打印的行');
    return;
  }
  const payload = labelPayload(picked);
  const sourceKeys = [...new Set(picked.map((row) => row.sourceKey).filter(Boolean))];
  if (els.labelPrintError) els.labelPrintError.hidden = true;
  const confirmButton = els.labelPrintConfirm;
  const originalButtonText = confirmButton?.textContent || (mode === 'big' ? '确认并打印大标签' : '确认并打印小标签');
  let slowTimer = 0;
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = '正在写入…';
    slowTimer = setTimeout(() => { confirmButton.textContent = '正在打开汉码…'; }, 6000);
  }
  try {
    const body = mode === 'big' ? { big: payload, small: [] } : { big: [], small: payload };
    const result = await deliveryHelper('/labels', body, { timeoutMs: 15000, taskLabel: '正在准备标签数据...', keepTaskOpen: true });
    // 打印助手现在只负责：写数据 → 打开汉码 → 点开打印预览，最后一步「打印」是用户自己点的。
    // 所以这里问一下到底打完没有：确认了才记「已打印」并记打印习惯，没打完就不记（还能补打）。
    const manual = Boolean(result && result.manualPrint);
    if (manual) setTaskStatus('数据已写入，等待你在汉码里打印', 'info');
    if (manual) {
      const done = window.confirm('汉码已经打开并停在打印预览页面（数据已写好、模板正确）。\n\n打印完成了吗？\n\n【确定】= 已完成 → 记入「已打印」，并记住这些料号的打印习惯\n【取消】= 还没打完 → 先不记，之后还能找到它补打');
      if (!done) {
        clearTaskStatus();
        showToast('这次先不记「已打印」，需要补打时还能找到它');
        return;
      }
      void closeLabelAppAfterManualPrint();
    }
    finishLabelPrint(mode, sourceKeys, picked, result, manual);
    finishTask('标签打印已确认', 'success', 3000);
  } catch (error) {
    if (error?.name === 'AbortError') {
      finishTask('等待打印助手超时，请确认是否已打印', 'error', 0);
      const done = window.confirm('打印助手等待超时，但汉码可能已经打开。\n\n如果已经打印完成，点【确定】记入「已打印」；还没完成就点【取消】，之后还能补打。');
      if (done) {
        finishLabelPrint(mode, sourceKeys, picked, { errors: [] }, true);
        finishTask('标签打印已确认', 'success', 3000);
        void closeLabelAppAfterManualPrint();
      } else {
        clearTaskStatus();
        showLabelPrintError('打印助手还在处理中；如果汉码已经打开，完成打印后再点一次确认，或稍后补打。');
      }
      return;
    }
    clearTaskStatus();
    const detail = String(error.message || error || '');
    showLabelPrintError('打印没有完成：' + detail + '（如果是“Failed to fetch”，说明打印助手没在运行）');
    showToast('打印没有完成，看弹窗里的提示');
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.textContent = originalButtonText;
    }
    renderLabelRows();
  }
}

function printRemainingList(groups = remainingGroups()) {
  if (!groups.length) {
    showToast('没有可打印的未交数据');
    return;
  }
  const rows = groups.map((group) => `
    <tr>
      <td>${escapeHtml(group.material)}</td>
      <td>${escapeHtml(group.name)}${remainingTypeTagsHtml(group.types, group.hasReplacement)}</td>
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

async function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.async = true;
      script.dataset.xlsxLoader = '1';
      script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('Excel 导出组件初始化失败'));
      script.onerror = () => reject(new Error('Excel 导出组件加载失败，请检查网络后重试'));
      document.head.appendChild(script);
    });
  }
  return xlsxPromise.catch((error) => { xlsxPromise = null; throw error; });
}

function warmOptionalLibraries() {
  const warm = () => { loadXlsx().catch(() => {}); };
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1800);
}
async function exportRemainingList(groups = remainingGroups()) {
  if (!groups.length) {
    showToast('没有可导出的未交数据');
    return;
  }
  try {
    await loadXlsx();
  } catch (error) {
    showToast(error.message || 'Excel 导出组件加载失败');
    return;
  }
  const xlsx = window.XLSX;
  if (!xlsx) {
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
  const sheet = xlsx.utils.aoa_to_sheet(data);
  sheet['!cols'] = [
    { wch: 18.265625 },
    { wch: 41.53125 },
    { wch: 12.3984375 },
    { wch: 20.19921875 },
    { wch: 8.46484375 },
  ];
  sheet['!rows'] = data.map(() => ({ hpt: 25.05 }));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, '未交清单');
  const suffix = selectedRemainingDates().length ? selectedRemainingDates().join('_') : '全部交期';
  xlsx.writeFile(workbook, `未交清单_${suffix}.xlsx`, { compression: true });
  showToast(`已导出 ${groups.length} 项未交物料`);
}

function renderDesktopRemaining() {
  if (!els.desktopRemainingBody || !snapshot) return;
  renderRemainingDateChips();
  const rows = remainingRows(desktopRemainingSearch);
  const groups = groupRemainingRows(rows);
  const visibleGroups = groups.slice(0, desktopRemainingVisibleLimit);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const selectedText = selectedRemainingDates().length
    ? selectedRemainingDates().map((dueDate) => formatDate(dueDate)).join('、')
    : '全部交期';
  if (els.desktopRemainingSummary) els.desktopRemainingSummary.textContent = `共 ${fmt(groups.length)} 项物料 · ${fmt(rows.length)} 条待交明细 · 合计 ${qtyText(total)} 件 · ${selectedText}`;
  els.desktopRemainingBody.innerHTML = visibleGroups.map((group) => `
    <tr>
      <td class="remaining-type-cell">${remainingTypeTagsHtml(group.types, group.hasReplacement)}</td>
      <td class="mono">${escapeHtml(group.material)}</td>
      <td>${escapeHtml(group.name)}</td>
      <td class="mono">${escapeHtml(group.specs.join('、'))}</td>
      <td class="number qty">${escapeHtml(qtyText(group.total))}</td>
      <td class="mark">${group.mark ? '✅' : ''}</td>
      <td>${escapeHtml(remainingDateText(group.dates))}</td>
    </tr>`).join('');
  if (groups.length > visibleGroups.length) {
    els.desktopRemainingBody.innerHTML += `<tr><td colspan="7"><button type="button" class="load-more-button" data-remaining-load-more>加载更多（还有 ${fmt(groups.length - visibleGroups.length)} 项）</button></td></tr>`;
  }
  els.desktopRemainingEmpty.hidden = groups.length > 0;
}

function refreshRemainingViews() {
  renderMobileRemaining();
  renderDesktopRemaining();
}

function renderMobileRecords() {
  if (!els.recordsList || !snapshot) return;
  renderMobileRecordFilters();
  const query = String(recordsSearch || '').trim();
  const lookup = orderLookupMap();
  const rows = (snapshot.shipments || []).filter((shipment) => {
    if (recordsCompany && shipmentCompany(shipment) !== recordsCompany) return false;
    if (recordsBatch && shipmentDisplayBatch(shipment) !== recordsBatch) return false;
    if (recordsDate && shipShanghaiDate(shipment.createdAt) !== recordsDate) return false;
    return shipmentMatches(shipment, query, lookup);
  });
  renderQueryPanes(els.recordsList, els.recordsOffsetList, els.recordsOverList, renderShipmentSection(rows, recordsSearch), els.recordsReplacementList);
  void renderCloudFiles();
  requestAnimationFrame(() => { applyDeliveryColumnWidths('grouped'); applyDeliveryColumnWidths('merged'); });
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
  const ids = String(overId || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.length) return;
  const all = overDeliveries();
  const targets = ids.map((id) => all.find((row) => String(row.id) === String(id))).filter(Boolean);
  if (targets.some((row) => isBilledExtra(row.id))) { showToast('这笔无订单发货已经开送货单并上传云端，不能撤回'); return; }
  if (targets.some((row) => isLockedRecord(row.createdAt))) {
    showToast('这笔无订单发货已满 7 天，不能再撤回');
    return;
  }
  const question = ids.length > 1
    ? `要把这 ${ids.length} 笔“无订单发货”一起撤回吗？\n会同时撤销它们引起的冲抵，订单未交恢复原样。`
    : '要把这笔“无订单发货”撤回吗？\n会同时撤销它引起的冲抵，订单未交恢复原样。';
  if (!window.confirm(question)) return;
  for (const id of ids) {
    const result = await callRpc('board_revoke_over_delivery', { p_code: getAccessCode(), p_over_id: id });
    if (!result.response.ok) { showToast(result.data?.message || '撤回失败'); return; }
    for (const [material, item] of [...sessionOver.entries()]) {
      if (String(item.id) === String(id)) sessionOver.delete(material);
    }
  }
  showToast(ids.length > 1 ? `已撤回 ${ids.length} 笔无订单发货` : '已撤回这笔无订单发货');
  await loadState({ quiet: true });
  renderAll();
}

function renderCartDetail() {
  if (!els.cartDetail) return;
  const entries = [...selected.entries()].filter(([, quantity]) => Number(quantity) > 0);
  const overRows = [...sessionOver.entries()];
  if (!cartOpen || (!entries.length && !overRows.length && !sessionReplacements.length)) {
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
        <span>补发计划 · 交期 ${escapeHtml(formatDate(item.dueDate || defaultReplacementDueDate()))}${item.spec ? ' · ' + escapeHtml(item.spec) : ''}${item.remark ? ' · 原因：' + escapeHtml(item.remark) : '（未填原因）'}</span>
      </div>
      <strong class="cart-over-qty">${fmt(item.quantity)} 件</strong>
      <button type="button" class="cart-remove" data-cart-replacement="${index}">取消</button>
    </div>`).join('');
  els.cartDetail.innerHTML = `<div class="cart-detail-head"><strong>本次装车明细</strong>`
    + `<span>${entries.length} 项订单${overRows.length ? ` + ${overRows.length} 项无订单发货` : ''}${sessionReplacements.length ? ` + ${sessionReplacements.length} 项待确认补发` : ''}，可直接改数量或取消</span></div>`
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
  renderDesktopLoadingCart();
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
  const cards = [...document.querySelectorAll('[data-order-card]')].filter((item) => item.dataset.orderCard === orderId);
  if (!cards.length) return;
  const quantity = Number(selected.get(orderId) || 0);
  for (const card of cards) {
    const input = card.querySelector('[data-action="input"]');
    if (input && document.activeElement !== input) input.value = quantity > 0 ? quantity : '';
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

let taskStatusTimer = 0;
let taskStatusActionHandler = null;

function setTaskStatus(message, state = 'info', options = {}) {
  if (!els.taskStatusBar || !message) return;
  clearTimeout(taskStatusTimer);
  els.taskStatusBar.hidden = false;
  els.taskStatusBar.dataset.state = state;
  if (els.taskStatusText) els.taskStatusText.textContent = message;
  if (els.taskStatusAction) {
    if (options.actionText && typeof options.onAction === 'function') {
      els.taskStatusAction.hidden = false;
      els.taskStatusAction.textContent = options.actionText;
      taskStatusActionHandler = options.onAction;
    } else {
      els.taskStatusAction.hidden = true;
      els.taskStatusAction.textContent = '';
      taskStatusActionHandler = null;
    }
  }
}

function clearTaskStatus() {
  clearTimeout(taskStatusTimer);
  taskStatusTimer = 0;
  taskStatusActionHandler = null;
  if (els.taskStatusBar) els.taskStatusBar.hidden = true;
}

function beginTask(message) {
  setTaskStatus(message, 'info');
}

function finishTask(message, state = 'success', delay = 3000) {
  setTaskStatus(message, state);
  if (delay) taskStatusTimer = setTimeout(clearTaskStatus, delay);
}

function helperTaskLabel(path) {
  return ({
    '/prepare': '正在汇总送货单...',
    '/print': '正在发送送货单打印...',
    '/labels': '正在准备标签数据...',
    '/labels/complete': '正在关闭汉码...',
  })[path] || '';
}

async function checkPrintHelper(showResult = false) {
  const chips = [els.printHelperStatus, els.mobilePrintHelperStatus].filter(Boolean);
  chips.forEach((chip) => {
    chip.dataset.state = 'checking';
    chip.textContent = '打印助手：检测中';
    chip.disabled = true;
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${PRINT_HELPER_BASE}/ping`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('打印助手没有响应');
    chips.forEach((chip) => {
      chip.dataset.state = 'online';
      chip.textContent = '打印助手：已连接';
    });
    if (showResult) showToast('打印助手已连接，可以打印');
  } catch {
    chips.forEach((chip) => {
      chip.dataset.state = 'offline';
      chip.textContent = '打印助手：未启动';
    });
    if (showResult) showToast('打印助手未启动：请先双击桌面“启动打印助手”，再点这里重试', 7000);
  } finally {
    clearTimeout(timer);
    chips.forEach((chip) => { chip.disabled = false; });
  }
}

async function confirmFreshRevision(baseRevision, actionName) {
  if (baseRevision == null) return true;
  await loadState({ quiet: true, fast: true });
  if (snapshot?.revision === baseRevision) return true;
  return window.confirm(`「${actionName}」打开后，数据已被其他人更新。\n\n【确定】按最新数据继续；【取消】先返回核对最新未交。`);
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
  formBaseRevision = snapshot?.revision ?? null;
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

async function deliveryHelper(path, payload, helperOptions = {}) {
  const options = payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    : { cache: 'no-store' };
  const timeoutMs = Number(helperOptions.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  if (controller) options.signal = controller.signal;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const taskLabel = helperOptions.taskLabel || helperTaskLabel(path);
  const keepTaskOpen = Boolean(helperOptions.keepTaskOpen);
  if (taskLabel) beginTask(taskLabel);
  try {
    const response = await fetch(`${PRINT_HELPER_BASE}${path}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `打印助手请求失败（HTTP ${response.status}）`);
    if (taskLabel && !keepTaskOpen) finishTask('操作已完成', 'success', 2200);
    return data;
  } catch (error) {
    if (taskLabel) finishTask('操作失败：' + (error.message || '请检查打印助手'), 'error', 5000);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
              <span>${escapeHtml(line.material)} · ${escapeHtml(line.name)} · ${escapeHtml(line.spec || '—')}${line.remark ? ' · 备注：' + escapeHtml(line.remark) : ''}</span>
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

async function openDeliveryModal() {
  const date = snapshot?.today || TODAY;
  const url = `${PRINT_HELPER_BASE}/preview?date=${encodeURIComponent(date)}`;
  // 先确认打印助手在运行，否则浏览器会跳到“拒绝访问”的错误页，用户看不懂
  try {
    const health = await fetch(`${PRINT_HELPER_BASE}/health`, { cache: 'no-store' });
    if (!health.ok) throw new Error('打印助手没有响应');
  } catch {
    showToast('打印助手没在运行：请双击「发货实时看板\\printer\\启动打印助手.cmd」，保持那个窗口打开，再点生成发货单。', 'error');
    return;
  }
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
  beginTask('正在核对并提交装车...');
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
    if (formBaseRevision != null && snapshot?.revision !== formBaseRevision) {
      const keep = window.confirm('你打开本次装车后，数据已被其他人更新。\n\n【确定】按最新未交继续？【取消】返回重新核对。');
      if (!keep) {
        showToast('已取消提交，请重新核对最新未交数量');
        return;
      }
      formBaseRevision = snapshot?.revision ?? null;
    }
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
    setTaskStatus('正在同步装车数据...', 'info');
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
    // 补发：把已装入本次装车的计划转成正式补发记录；订单号无、项次无，备注用填写的文字
    const replacementSaved = [];
    const replacementFailed = [];
    const replacementWarnings = [];
    for (const item of [...sessionReplacements]) {
      try {
        const r = await callRpc('board_add_replacement', {
          p_code: getAccessCode(),
          p_payload: {
            date: item.dueDate || defaultReplacementDueDate(),
            customer: '4137',
            orderId: item.orderId || '',
            po: item.po || '',
            seq: item.seq || '',
            material: item.material,
            name: item.name,
            spec: item.spec,
            quantity: Number(item.quantity),
            remark: item.remark,
          },
        });
        if (!r.response.ok) throw new Error(r.data?.message || '补发登记失败');
        if (item.planId) {
          const removedPlan = await callRpc('board_revoke_replacement', { p_code: getAccessCode(), p_id: item.planId });
          if (!removedPlan.response.ok) replacementWarnings.push(`${item.material}的待装车计划未清理`);
        }
        replacementSaved.push(`${item.material} ${fmt(item.quantity)} 件（${formatDate(item.dueDate || defaultReplacementDueDate())}）`);
        sessionReplacements.splice(sessionReplacements.indexOf(item), 1);
      } catch (error) {
        replacementFailed.push(item.material);
      }
    }
    const photoUploadFailed = await uploadSessionPhotos(shipmentId);
    await markLoadedUnitsShipped(shipmentId);
    selected.clear();
    els.shipmentForm.reset();
    closeSubmitModal();
    formBaseRevision = null;
    showSubmitError('');
    showToast(`${shipmentId} 已保存${reallocated ? '（已按最新未交重新分配）' : ''}${overSaved.length ? `，含无订单发货 ${overSaved.join('、')}` : ''}`);
    finishTask('装车已提交，正在刷新最新未交', 'success', 3500);
    const isIOSDevice = /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOSDevice) setTimeout(() => { loadPdfJs().catch(() => {}); }, 2000);

await loadBoardRole();
applyRoleUI();
await loadState();
applyRoleUI();
    if (replacementSaved.length) showToast(`补发已登记：${replacementSaved.join('、')}`);
    if (replacementWarnings.length) showToast(`补发已登记，但以下计划需要稍后清理：${replacementWarnings.join('、')}`, 7000);
    if (replacementFailed.length) showToast(`补发登记失败：${replacementFailed.join('、')}，请重新提交`);
    if (photoUploadFailed.length) showToast(`${photoUploadFailed.length} 张现场照片没有上传成功，请稍后重试`, 8000);
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

async function editShipmentQuantity(itemId, current) {
  if (boardRole !== 'admin') { showToast('只有管理员模式可以改数量'); return; }
  const input = window.prompt('修改发货数量（件）：', String(current));
  if (input === null) return;
  const quantity = Number(String(input).trim());
  if (!Number.isFinite(quantity) || quantity <= 0) { showToast('数量必须是大于 0 的数字'); return; }
  if (quantity === Number(current)) return;
  try {
    const result = await callRpc('board_update_shipment_item', {
      p_code: getAccessCode(),
      p_item_id: Number(itemId),
      p_quantity: quantity,
    });
    if (!result.response.ok) throw new Error(result.data?.message || result.data?.error || '修改失败');
    showToast('发货数量已改为 ' + quantity + ' 件');
    await loadState();
  } catch (error) {
    const message = String(error.message || error || '');
    if (/board_update_shipment_item|Could not find the function|schema cache|不存在/.test(message)) {
      showToast('还差一步：请在 Supabase SQL Editor 里运行 cloud/fix-shipment-item-edit.sql');
      return;
    }
    showToast(message || '修改失败');
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
  try {
    await loadXlsx();
  } catch (error) {
    showToast(error.message || 'Excel 解析组件加载失败');
    event.target.value = '';
    return;
  }
  if (!window.XLSX) {
    showToast('Excel 解析组件加载失败，请刷新页面后重试');
    event.target.value = '';
    return;
  }
  try {
    beginTask('正在解析 Excel 未交订单...');
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
    finishTask('Excel 解析完成，请核对后导入', 'success', 3500);
  } catch (error) {
    pendingImportOrders = null;
    els.confirmImport.disabled = true;
    finishTask('Excel 解析失败', 'error', 5000);
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
  beginTask('正在覆盖导入未交订单...');
  try {
    const response = await requestWithAccessCode(apiUrl('/api/import-orders'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: pendingImportOrders }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '导入失败');
    showToast(`已导入 ${fmt(result.count)} 行，共 ${fmt(result.totalQuantity)} 件`);
    finishTask('未交订单导入完成', 'success', 3500);
    pendingImportOrders = null;
    closeImportDialog();
    await loadState();
  } catch (error) {
    finishTask('未交订单导入失败', 'error', 5000);
    showToast(error.message || '导入失败');
  } finally {
    button.disabled = false;
    button.textContent = '确认覆盖导入';
  }
}

function switchMobileTab(tab) {
  mobileTab = tab;
  mobileModule = 'entry';
  const summary = document.querySelector('.mobile-summary');
  const tabs = document.querySelector('.mobile-tabs');
  if (summary) summary.hidden = false;
  if (tabs) tabs.hidden = false;
  if (els.mobileWorkModule) els.mobileWorkModule.hidden = true;
  for (const button of document.querySelectorAll('.mobile-tab')) button.classList.toggle('active', button.dataset.tab === tab);
  els.mobileEntryPanel.hidden = tab !== 'entry';
  els.mobileRemainingPanel.hidden = tab !== 'remaining';
  els.mobileRecordsPanel.hidden = tab !== 'records';
  if (tab === 'records') renderMobileRecords();
  if (els.mobileFilesPanel) els.mobileFilesPanel.hidden = tab !== 'files';
  if (tab === 'files') renderCloudFiles();
  renderCart();
  renderMobileModule();
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
if (els.desktopOrderTypeFilter) els.desktopOrderTypeFilter.addEventListener('change', (event) => { desktopOrderType = event.target.value; renderDesktopTable(); });
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

if (els.desktopLoadingSearch) els.desktopLoadingSearch.addEventListener('input', (event) => { desktopLoadingSearch = event.target.value; renderDesktopLoading(); });
if (els.desktopLoadingDue) els.desktopLoadingDue.addEventListener('change', (event) => {
  desktopLoadingDue = event.target.value;
  renderDesktopLoading();
});
if (els.desktopLoadingCompany) els.desktopLoadingCompany.addEventListener('change', (event) => { desktopLoadingCompany = event.target.value; renderDesktopLoading(); });
if (els.desktopLoadingRefresh) els.desktopLoadingRefresh.addEventListener('click', async () => { await loadState({ quiet:false }); renderAll(); renderDesktopLoading(); showToast('未交订单已刷新'); });
if (els.desktopLoadingCardList) {
  els.desktopLoadingCardList.addEventListener('click', (event) => {
    const unitLoad = event.target.closest('[data-unit-load]');
    if (unitLoad) { loadUnitToCart(unitLoad.dataset.unitLoad); return; }
    const unitAdd = event.target.closest('[data-unit-add]');
    if (unitAdd) { retakeUnit(unitAdd.dataset.unitAdd); return; }
    const unitRetake = event.target.closest('[data-unit-retake]');
    if (unitRetake) { retakeUnit(unitRetake.dataset.unitRetake); return; }
    const unitView = event.target.closest('[data-unit-view-photo]');
    if (unitView) { viewUnitPhoto(unitView.dataset.unitViewPhoto); return; }
    const unitRemove = event.target.closest('[data-unit-member-remove]');
    if (unitRemove) { const card = unitRemove.closest('[data-unit-card]'); removeUnitMember(card?.dataset.unitCard, unitRemove.dataset.unitMemberRemove); return; }
    const photoButton = event.target.closest('[data-photo-order], [data-photo-plan]');
    if (photoButton) { openPhotoCaptureFromButton(photoButton); return; }
    const sampleButton = event.target.closest('[data-sample-approval]');
    if (sampleButton) { const order = snapshot?.orders?.find((row) => String(row.id) === String(sampleButton.dataset.sampleApproval)); if (order) openSampleApprovalSelector([order]); return; }
    const planSelect = event.target.closest('[data-select-replacement-plan]');
    if (planSelect) {
      selectReplacementPlan(planSelect.dataset.selectReplacementPlan);
      return;
    }
    const planUnselect = event.target.closest('[data-unselect-replacement-plan]');
    if (planUnselect) {
      unselectReplacementPlan(planUnselect.dataset.unselectReplacementPlan);
      return;
    }
    const planDelete = event.target.closest('[data-delete-replacement-plan]');
    if (planDelete) {
      deleteReplacementPlan(planDelete.dataset.deleteReplacementPlan);
      return;
    }
    const replacementRemove = event.target.closest('[data-remove-replacement-plan]');
    if (replacementRemove) {
      removeReplacementPlan(replacementRemove.dataset.removeReplacementPlan);
      return;
    }
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
  els.desktopLoadingCardList.addEventListener('input', (event) => {
    const input = event.target.closest('[data-action="input"]');
    if (!input) return;
    setQuantity(input.dataset.id, input.value);
  });
  els.desktopLoadingCardList.addEventListener('change', (event) => {
    const unitInput = event.target.closest('[data-unit-member-qty]');
    if (unitInput) { updateUnitMemberQuantity(unitInput.dataset.unitId, unitInput.dataset.unitMemberQty, unitInput.value); return; }
    const input = event.target.closest('[data-action="input"]');
    if (!input) return;
    updateOrderCardSelection(input.dataset.id);
  });
}
function syncDesktopCartAfterChange() {
  renderDesktopLoadingSummary();
  renderMobileSummary();
  renderDesktopLoadingCart();
}
if (els.desktopLoadingCart) {
  els.desktopLoadingCart.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cart-line-remove]');
    if (!button) return;
    const kind = button.dataset.cartLineRemove;
    const key = String(button.dataset.key || '');
    if (kind === 'order') {
      selected.delete(key);
      updateOrderCardSelection(key);
      showAllocationNotice('已从本次装车中取消该物料。', 'ok');
    } else if (kind === 'over') {
      sessionOver.delete(key.trim());
      showAllocationNotice(`已取消 ${key} 的无订单发货。`, 'ok');
    } else if (kind === 'replacement') {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0) sessionReplacements.splice(index, 1);
      showAllocationNotice('已取消该补发行。', 'ok');
    }
    syncDesktopCartAfterChange();
  });
  els.desktopLoadingCart.addEventListener('change', (event) => {
    const input = event.target.closest('[data-cart-qty]');
    if (!input) return;
    const kind = input.dataset.cartQty;
    const key = String(input.dataset.key || '');
    const value = Number(input.value);
    if (kind === 'order') {
      if (!Number.isFinite(value) || value <= 0) selected.delete(key);
      else selected.set(key, Math.max(0, Math.min(Number(snapshot?.orders?.find((item) => item.id === key)?.remaining || 0) || value, Math.round(value))));
      updateOrderCardSelection(key);
    } else if (kind === 'over') {
      const entry = sessionOver.get(key.trim());
      if (entry) {
        const quantity = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
        if (quantity <= 0) sessionOver.delete(key.trim());
        else entry.quantity = quantity;
      }
    } else if (kind === 'replacement') {
      const index = Number(key);
      const item = Number.isInteger(index) ? sessionReplacements[index] : null;
      if (item) {
        const quantity = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
        if (quantity <= 0) sessionReplacements.splice(index, 1);
        else item.quantity = quantity;
      }
    }
    syncDesktopCartAfterChange();
  });
}
if (els.desktopLoadingOpenSubmit) els.desktopLoadingOpenSubmit.addEventListener('click', openSubmitModal);
function openDesktopModuleSheet() {
  if (!els.moduleSwitchButton) return;
  els.moduleSwitchButton.classList.add('expanded');
  els.moduleSwitchButton.setAttribute('aria-expanded', 'true');
}
function closeDesktopModuleSheet() {
  if (!els.moduleSwitchButton) return;
  els.moduleSwitchButton.classList.remove('expanded');
  els.moduleSwitchButton.setAttribute('aria-expanded', 'false');
}
if (els.moduleSwitchButton) {
  const toggleDesktopModuleSheet = (event) => {
    // 面板内按钮自己处理，避免冒泡回来又开一次
    if (event.target.closest && event.target.closest('#moduleSwitchSheet')) return;
    event.preventDefault();
    event.stopPropagation();
    if (boardRole !== 'admin') return;
    if (els.moduleSwitchButton.classList.contains('expanded')) closeDesktopModuleSheet();
    else openDesktopModuleSheet();
  };
  els.moduleSwitchButton.addEventListener('click', toggleDesktopModuleSheet);
  els.moduleSwitchButton.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') toggleDesktopModuleSheet(event); });
}
if (els.moduleSwitchSheet) {
  els.moduleSwitchSheet.addEventListener('click', (event) => {
    const button = event.target.closest('[data-desktop-module]');
    if (!button) return;
    event.stopPropagation();
    const target = button.dataset.desktopModule;
    closeDesktopModuleSheet();
    if (target === 'shipment') setDesktopModule('shipment', 'overview');
    else if (target === 'attendance') setDesktopModule('attendance', 'attendance');
    else setDesktopModule('work', target === 'workReview' ? 'workReview' : 'workReport');
  });
}
document.addEventListener('click', (event) => {
  if (!els.moduleSwitchButton || !els.moduleSwitchButton.classList.contains('expanded')) return;
  if (els.moduleSwitchButton.contains(event.target)) return;
  closeDesktopModuleSheet();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeDesktopModuleSheet();
  closeMobileModuleSheet();
});
if (els.desktopWorkReportDate) els.desktopWorkReportDate.addEventListener('change', (event) => { workReportDate = event.target.value; loadWorkReportWorkspace(); });
if (els.desktopAttendanceRefresh) els.desktopAttendanceRefresh.addEventListener('click', () => loadAttendance().catch(() => {}));
if (els.mobileAttendanceRefresh) els.mobileAttendanceRefresh.addEventListener('click', () => loadAttendance().catch(() => {}));
if (els.desktopAttendanceMonth) els.desktopAttendanceMonth.addEventListener('change', () => { attendanceMonth = els.desktopAttendanceMonth.value || attendancePrevMonth(); loadAttendance().catch(() => {}); });
if (els.mobileAttendanceMonth) els.mobileAttendanceMonth.addEventListener('change', () => { attendanceMonth = els.mobileAttendanceMonth.value || attendancePrevMonth(); loadAttendance().catch(() => {}); });
if (els.desktopAttendancePrev) els.desktopAttendancePrev.addEventListener('click', () => attendanceShiftMonth(-1));
if (els.desktopAttendanceNext) els.desktopAttendanceNext.addEventListener('click', () => attendanceShiftMonth(1));
if (els.mobileAttendancePrev) els.mobileAttendancePrev.addEventListener('click', () => attendanceShiftMonth(-1));
if (els.mobileAttendanceNext) els.mobileAttendanceNext.addEventListener('click', () => attendanceShiftMonth(1));
if (els.desktopAttendanceDetailClose) els.desktopAttendanceDetailClose.addEventListener('click', () => { if (els.desktopAttendanceDetailPanel) els.desktopAttendanceDetailPanel.hidden = true; });
if (els.desktopAttendanceTab) els.desktopAttendanceTab.addEventListener('change', applyAttendanceTab);
document.querySelectorAll('[data-mobile-attendance-tab]').forEach((b) => b.addEventListener('click', () => { switchMobileAttendanceTab(b.dataset.mobileAttendanceTab); if (mobileAttendanceTab === 'reissue') loadAttendanceReissues().catch(() => {}); }));

if (els.mobileWorkReportDate) els.mobileWorkReportDate.addEventListener('change', (event) => { workReportDate = event.target.value; loadWorkReportWorkspace(); });
if (els.desktopWorkReportEmployee) els.desktopWorkReportEmployee.addEventListener('change', (event) => { workReportEmployeeId = event.target.value; loadWorkReport(); });
if (els.mobileWorkReportEmployee) els.mobileWorkReportEmployee.addEventListener('change', (event) => { workReportEmployeeId = event.target.value; loadWorkReport(); });
[document.getElementById('desktopWorkTimeline'), document.getElementById('desktopWorkTimelineActions'), document.getElementById('mobileWorkTimeline')].forEach((panel) => {
  if (!panel) return;
  panel.addEventListener('change', (event) => {
    const select = event.target.closest('[data-work-timeline-entry]');
    if (!select) return;
    const value = select.value;
    updateWorkTimelineEntry(select.dataset.workTimelineEntry, value === '__auto__' ? null : value, value === '__auto__');
  });
  panel.addEventListener('click', (event) => {
    const payroll = event.target.closest('[data-work-payroll]');
    if (payroll) toggleWorkPayroll(payroll.dataset.workPayroll);
  });
});
if (els.desktopWorkReportStatus) els.desktopWorkReportStatus.addEventListener('change', (event) => { workReportStatus = event.target.value; loadWorkReport(); });
if (els.mobileWorkReportStatus) els.mobileWorkReportStatus.addEventListener('change', (event) => { workReportStatus = event.target.value; loadWorkReport(); });
if (els.desktopWorkReportSearch) els.desktopWorkReportSearch.addEventListener('input', (event) => { workReportQuery = event.target.value; loadWorkReport(); });
if (els.mobileWorkReportSearch) els.mobileWorkReportSearch.addEventListener('input', (event) => { workReportQuery = event.target.value; loadWorkReport(); });
if (els.desktopWorkReportRefresh) els.desktopWorkReportRefresh.addEventListener('click', loadWorkReportWorkspace);
if (els.mobileWorkReportRefresh) els.mobileWorkReportRefresh.addEventListener('click', loadWorkReportWorkspace);
[els.desktopWorkLiveBody, els.mobileWorkLiveList].forEach((list) => {
  if (!list) return;
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-work-live-employee]');
    if (!button) return;
    workReportEmployeeId = button.dataset.workLiveEmployee;
    if (els.desktopWorkReportEmployee) els.desktopWorkReportEmployee.value = workReportEmployeeId;
    if (els.mobileWorkReportEmployee) els.mobileWorkReportEmployee.value = workReportEmployeeId;
    loadWorkReport().catch(() => {});
  });
});
[els.desktopWorkReportBody, els.mobileWorkReportList].forEach((list) => {
  if (!list) return;
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-report-review]');
    if (button) openReportReview(button.dataset.reportReview);
  });
});
document.querySelectorAll('[data-mobile-work-tab]').forEach((button) => button.addEventListener('click', () => switchMobileWorkTab(button.dataset.mobileWorkTab)));
if (els.desktopWorkReviewStatus) els.desktopWorkReviewStatus.addEventListener('change', (event) => loadWorkReviews(event.target.value));
if (els.mobileWorkReviewStatus) els.mobileWorkReviewStatus.addEventListener('change', (event) => loadWorkReviews(event.target.value));
if (els.desktopWorkReviewRefresh) els.desktopWorkReviewRefresh.addEventListener('click', () => loadWorkReviews(workReviewStatus));
if (els.mobileWorkReviewRefresh) els.mobileWorkReviewRefresh.addEventListener('click', () => loadWorkReviews(workReviewStatus));
[els.desktopWorkReviewList, els.mobileWorkReviewList].forEach((list) => {
  if (!list) return;
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-work-review]');
    if (!button) return;
    openWorkReviewEditor(button.dataset.openWorkReview);
  });
});
function openMobileModuleSheet() {
  if (!els.mobileModuleSwitch) return;
  els.mobileModuleSwitch.classList.add('expanded');
  els.mobileModuleSwitch.setAttribute('aria-expanded', 'true');
  document.body.classList.add('module-sheet-open');
}
function closeMobileModuleSheet() {
  if (!els.mobileModuleSwitch) return;
  els.mobileModuleSwitch.classList.remove('expanded');
  els.mobileModuleSwitch.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('module-sheet-open');
}
if (els.mobileModuleSwitch) {
  const toggleModuleMenu = (event) => {
    // 面板内的按钮点击由面板自己处理，避免冒泡回来又把面板重新打开
    if (event.target.closest && event.target.closest('#mobileModuleMenu')) return;
    event.preventDefault();
    event.stopPropagation();
    if (boardRole !== 'admin') { showToast('管理员模式才能切换报工审核'); return; }
    if (els.mobileModuleSwitch.classList.contains('expanded')) closeMobileModuleSheet();
    else openMobileModuleSheet();
  };
  els.mobileModuleSwitch.addEventListener('click', toggleModuleMenu);
  els.mobileModuleSwitch.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') toggleModuleMenu(event); });
}
if (els.mobileModuleMenu) {
  els.mobileModuleMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mobile-module]');
    if (!button) return;
    event.stopPropagation();
    switchMobileModule(button.dataset.mobileModule);
  });
}
document.addEventListener('click', (event) => {
  if (!els.mobileModuleSwitch || !els.mobileModuleSwitch.classList.contains('expanded')) return;
  if (els.mobileModuleSwitch.contains(event.target)) return;
  closeMobileModuleSheet();
});
if (els.workReviewClose) els.workReviewClose.addEventListener('click', closeWorkReviewEditor);
if (els.workReviewSave) els.workReviewSave.addEventListener('click', () => submitWorkReview('save'));
if (els.workReviewReject) els.workReviewReject.addEventListener('click', () => submitWorkReview('reject'));
if (els.workReviewApprove) els.workReviewApprove.addEventListener('click', () => submitWorkReview('approve'));
if (els.workReviewModal) els.workReviewModal.addEventListener('click', (event) => { if (event.target === els.workReviewModal) closeWorkReviewEditor(); });
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
  const shipmentPhoto = event.target.closest('[data-shipment-photo]');
  if (shipmentPhoto) { openShipmentPhoto(shipmentPhoto.dataset.shipmentPhoto); return; }
  const unitPhoto = event.target.closest('[data-unit-view-photo]');
  if (unitPhoto) { viewUnitPhoto(unitPhoto.dataset.unitViewPhoto); return; }
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
    syncReplacementDueDate();
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

if (els.photoArchiveOpen) els.photoArchiveOpen.addEventListener('click', openPhotoArchive);
if (els.photoArchiveClose) els.photoArchiveClose.addEventListener('click', closePhotoArchive);
if (els.photoCaptureClose) els.photoCaptureClose.addEventListener('click', closePhotoCapture);
if (els.photoCaptureCancel) els.photoCaptureCancel.addEventListener('click', closePhotoCapture);
if (els.photoChoose) els.photoChoose.addEventListener('click', () => els.photoFile?.click());
if (els.photoFile) els.photoFile.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    photoPendingDataUrl = await compressPhotoFile(file);
    if (els.photoPreview) els.photoPreview.src = photoPendingDataUrl;
    if (els.photoPreviewWrap) els.photoPreviewWrap.hidden = false;
  } catch (error) {
    showToast(error.message || '照片处理失败');
  }
});
if (els.photoMaterialSearch) els.photoMaterialSearch.addEventListener('input', renderPhotoMaterialList);
if (els.photoUnitQtyList) els.photoUnitQtyList.addEventListener('input', (event) => {
  const input = event.target.closest('[data-photo-unit-qty]');
  if (!input) return;
  const key = decodeURIComponent(input.dataset.photoUnitQty || '');
  const value = Number(input.value);
  if (Number.isFinite(value) && value > 0) photoUnitQuantities.set(key, value);
  else photoUnitQuantities.delete(key);
});
if (els.photoMaterialList) els.photoMaterialList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-photo-candidate]');
  if (!button) return;
  const row = photoCandidateRows[Number(button.dataset.photoCandidate)];
  if (!row) return;
  const key = photoMaterialKey(row);
  if (photoSelectedMaterials.has(key)) photoSelectedMaterials.delete(key);
  else photoSelectedMaterials.set(key, row);
  renderPhotoMaterialList();
});
if (els.photoSave) els.photoSave.addEventListener('click', savePhotoCapture);
if (els.photoArchiveList) els.photoArchiveList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-photo-view-index]');
  if (!button) return;
  const row = photoArchiveCache[Number(button.dataset.photoViewIndex)];
  if (!row) return;
  if (row.dataUrl) openLocalPhoto(row);
  else if (row.id) openCloudPhoto(row.id, row);
});
if (els.photoViewerClose) els.photoViewerClose.addEventListener('click', () => { if (els.photoViewerModal) els.photoViewerModal.hidden = true; });
if (els.sampleApprovalSelectClose) els.sampleApprovalSelectClose.addEventListener('click', closeSampleApprovalSelector);
if (els.sampleApprovalSelectCancel) els.sampleApprovalSelectCancel.addEventListener('click', closeSampleApprovalSelector);
if (els.sampleApprovalSelectSearch) els.sampleApprovalSelectSearch.addEventListener('input', renderSampleApprovalSelectList);
if (els.sampleApprovalSelectList) els.sampleApprovalSelectList.addEventListener('change', (event) => {
  const input = event.target.closest('input[name="sampleApprovalChoice"]');
  if (!input) return;
  sampleApprovalSelectedIndex = Number(input.value);
  renderSampleApprovalSelectList();
});
if (els.sampleApprovalSelectConfirm) els.sampleApprovalSelectConfirm.addEventListener('click', confirmSampleApprovalSelection);
if (els.sampleApprovalPreviewClose) els.sampleApprovalPreviewClose.addEventListener('click', closeSampleApprovalPreview);
if (els.sampleApprovalPreviewCancel) els.sampleApprovalPreviewCancel.addEventListener('click', closeSampleApprovalPreview);
if (els.sampleApprovalPreviewPrint) els.sampleApprovalPreviewPrint.addEventListener('click', () => { void printSampleApprovalPreview(); });
if (els.photoViewerDelete) els.photoViewerDelete.addEventListener('click', deletePhotoViewerAndRetake);
if (els.photoViewerRetake) els.photoViewerRetake.addEventListener('click', () => { if (els.photoViewerModal) els.photoViewerModal.hidden = true; if (photoViewerTarget) openPhotoCapture(photoViewerTarget, { retake: true, existingPhoto: photoViewerRow }); });

if (els.mobileAllocNotice) els.mobileAllocNotice.addEventListener('click', (event) => {
  const button = event.target.closest('[data-over-cancel]');
  if (!button) return;
  const material = button.dataset.overCancel;
  sessionOver.delete(String(material || '').trim());
  renderCart();
  showAllocationNotice(`已取消 ${material} 的无订单发货，只保留有采购单的数量。`, 'ok');
});

function handleRemainingLoadMore(event) {
  if (!event.target.closest('[data-remaining-load-more]')) return;
  remainingVisibleLimit += 60;
  desktopRemainingVisibleLimit += 120;
  renderMobileRemaining();
  renderDesktopRemaining();
}

function handleRemainingFilterClick(event) {
  const dateButton = event.target.closest('[data-remaining-date]');
  if (dateButton) {
    const dueDate = String(dateButton.dataset.remainingDate || '').trim();
    if (!dueDate) remainingDates.clear();
    else if (remainingDates.has(dueDate)) remainingDates.delete(dueDate);
    else remainingDates.add(dueDate);
    remainingVisibleLimit = 60;
    desktopRemainingVisibleLimit = 120;
    refreshRemainingViews();
    return;
  }
  if (event.target.id === 'remainingDateClear' || event.target.id === 'desktopRemainingDateClear') {
    remainingDates.clear();
    remainingVisibleLimit = 60;
    desktopRemainingVisibleLimit = 120;
    refreshRemainingViews();
    return;
  }
  if (event.target.id === 'remainingPrint') {
    printRemainingList();
    return;
  }
  if (event.target.id === 'remainingSampleApproval') {
    void printRemainingSampleApprovals(remainingSearch);
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

if (els.remainingList) els.remainingList.addEventListener('click', handleRemainingLoadMore);
if (els.desktopRemainingBody) els.desktopRemainingBody.addEventListener('click', handleRemainingLoadMore);

if (els.mobileRemainingPanel) {
  els.mobileRemainingPanel.addEventListener('input', (event) => {
    if (event.target.id !== 'remainingSearch') return;
    remainingSearch = event.target.value;
    remainingVisibleLimit = 60;
    desktopRemainingVisibleLimit = 120;
    refreshRemainingViews();
  });
  els.mobileRemainingPanel.addEventListener('click', handleRemainingFilterClick);
}

if (els.desktopRemainingSearch) {
  els.desktopRemainingSearch.addEventListener('input', (event) => {
    desktopRemainingSearch = event.target.value;
    remainingVisibleLimit = 60;
    desktopRemainingVisibleLimit = 120;
    renderDesktopRemaining();
  });
}
if (els.desktopRemainingDateChips) els.desktopRemainingDateChips.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingDateClear) els.desktopRemainingDateClear.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingPrint) els.desktopRemainingPrint.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingExport) els.desktopRemainingExport.addEventListener('click', handleRemainingFilterClick);
if (els.desktopRemainingSampleApproval) els.desktopRemainingSampleApproval.addEventListener('click', () => { void printRemainingSampleApprovals(desktopRemainingSearch); });
if (els.desktopLabelPrint) els.desktopLabelPrint.addEventListener('click', openLabelPrintModal);
if (els.labelPrintRows) {
  els.labelPrintRows.addEventListener('input', handleLabelPrintInput);
  els.labelPrintRows.addEventListener('change', (event) => {
    handleLabelPrintInput(event);
    handleLabelPrintChange(event);
  });
  els.labelPrintRows.addEventListener('click', handleLabelPrintClick);
}
if (els.labelPrintSelectAll) {
  els.labelPrintSelectAll.addEventListener('change', (event) => {
    const checked = Boolean(event.target.checked);
    labelRows.forEach((row) => { row.selected = checked; });
    renderLabelRows();
  });
}
if (els.labelPrintModes) {
  els.labelPrintModes.addEventListener('click', (event) => {
    const button = event.target.closest('[data-label-mode]');
    if (!button) return;
    switchLabelPrintMode(button.dataset.labelMode);
  });
}
if (els.labelPrintShowPrinted) {
  els.labelPrintShowPrinted.addEventListener('change', () => {
    labelRows = buildLabelRows();
    renderLabelRows();
  });
}
if (els.labelPrintSearch) {
  els.labelPrintSearch.addEventListener('input', (event) => {
    labelPrintSearch = event.target.value;
    labelRows = buildLabelRows();
    renderLabelRows();
  });
}
if (els.labelPrintClose) els.labelPrintClose.addEventListener('click', closeLabelPrintModal);
if (els.labelPrintCancel) els.labelPrintCancel.addEventListener('click', closeLabelPrintModal);
if (els.labelPrintConfirm) els.labelPrintConfirm.addEventListener('click', confirmLabelPrint);
if (els.labelPrintModal) {
  els.labelPrintModal.addEventListener('click', (event) => { if (event.target === els.labelPrintModal) closeLabelPrintModal(); });
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
    if (link.dataset.module) setDesktopModule(link.dataset.module, link.dataset.desktopView);
    else showDesktopView(link.dataset.desktopView);
  });
});

if (els.filesSearch) els.filesSearch.addEventListener('input', (event) => { filesQuery = event.target.value; renderCloudFiles(); });
if (els.drawingSearch) els.drawingSearch.addEventListener('input', (event) => { drawingQuery = event.target.value; renderDesktopDrawings(); });
if (els.drawingCategoryTabs) els.drawingCategoryTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-drawing-category]');
  if (!button) return;
  drawingCategory = button.dataset.drawingCategory;
  els.drawingCategoryTabs.querySelectorAll('[data-drawing-category]').forEach((x) => x.classList.toggle('active', x === button));
  renderDesktopDrawings();
});
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
[['replacementHistorySearch', 'replacementQuery'], ['recordsReplacementSearch', 'replacementQuery']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('input', (event) => { replacementQuery = event.target.value; refreshQueryViews(); });
});
[['replacementHistoryDate', 'replacementDate'], ['recordsReplacementDate', 'replacementDate']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('change', (event) => { replacementDate = event.target.value; refreshQueryViews(); });
});
[['replacementHistoryClear'], ['recordsReplacementClear']].forEach(([key]) => {
  const el = els[key];
  if (el) el.addEventListener('click', () => { replacementDate = ''; refreshQueryViews(); });
});

if (els.historySearch) els.historySearch.addEventListener('input', (event) => { historyQuery = event.target.value; renderDesktopHistory(); });
function syncHistoryTodayButton() {
  if (!els.historyToday) return;
  const today = String(snapshot?.today || TODAY || '').slice(0, 10);
  els.historyToday.classList.toggle('active', Boolean(today) && historyDate === today);
}
if (els.historyDate) els.historyDate.addEventListener('change', (event) => {
  historyDate = event.target.value;
  syncHistoryTodayButton();
  renderDesktopHistory();
});
if (els.historyClear) els.historyClear.addEventListener('click', () => {
  historyDate = '';
  if (els.historyDate) els.historyDate.value = '';
  syncHistoryTodayButton();
  renderDesktopHistory();
});
if (els.historyToday) els.historyToday.addEventListener('click', () => {
  const today = String(snapshot?.today || TODAY || '').slice(0, 10);
  if (!today) { showToast('还没取到服务器日期'); return; }
  historyDate = historyDate === today ? '' : today;
  if (els.historyDate) els.historyDate.value = historyDate;
  syncHistoryTodayButton();
  renderDesktopHistory();
  showToast(historyDate ? ('只显示 ' + formatDate(today) + ' 的发货记录') : '已显示全部发货日期');
});
function handleHistoryClick(event) {
  const shipmentPhoto = event.target.closest('[data-shipment-photo]');
  if (shipmentPhoto) { openShipmentPhoto(shipmentPhoto.dataset.shipmentPhoto); return; }
  const unitPhoto = event.target.closest('[data-unit-view-photo]');
  if (unitPhoto) { viewUnitPhoto(unitPhoto.dataset.unitViewPhoto); return; }
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
document.addEventListener('click', (event) => {
  const drawingButton = event.target.closest('[data-drawing-id]');
  if (drawingButton) {
    event.preventDefault();
    event.stopPropagation();
    openDrawing(drawingButton.dataset.drawingId);
  }
});

document.getElementById('drawingViewerClose')?.addEventListener('click', closeDrawingViewer);
document.getElementById('drawingViewer')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeDrawingViewer();
});
document.addEventListener('keydown', (event) => {
  const modal = document.getElementById('drawingViewer');
  if (event.key === 'Escape' && modal && !modal.hidden) closeDrawingViewer();
});

els.mobileOrderList.addEventListener('click', (event) => {
  const unitLoad = event.target.closest('[data-unit-load]');
  if (unitLoad) { loadUnitToCart(unitLoad.dataset.unitLoad); return; }
    const unitAdd = event.target.closest('[data-unit-add]');
    if (unitAdd) { retakeUnit(unitAdd.dataset.unitAdd); return; }
  const unitRetake = event.target.closest('[data-unit-retake]');
  if (unitRetake) { retakeUnit(unitRetake.dataset.unitRetake); return; }
  const unitView = event.target.closest('[data-unit-view-photo]');
  if (unitView) { viewUnitPhoto(unitView.dataset.unitViewPhoto); return; }
  const unitRemove = event.target.closest('[data-unit-member-remove]');
  if (unitRemove) { const card = unitRemove.closest('[data-unit-card]'); removeUnitMember(card?.dataset.unitCard, unitRemove.dataset.unitMemberRemove); return; }
  const photoButton = event.target.closest('[data-photo-order], [data-photo-plan]');
  if (photoButton) { openPhotoCaptureFromButton(photoButton); return; }
  const sampleButton = event.target.closest('[data-sample-approval]');
  if (sampleButton) { const order = snapshot?.orders?.find((row) => String(row.id) === String(sampleButton.dataset.sampleApproval)); if (order) openSampleApprovalSelector([order]); return; }
  const planSelect = event.target.closest('[data-select-replacement-plan]');
  if (planSelect) {
    selectReplacementPlan(planSelect.dataset.selectReplacementPlan);
    return;
  }
  const planUnselect = event.target.closest('[data-unselect-replacement-plan]');
  if (planUnselect) {
    unselectReplacementPlan(planUnselect.dataset.unselectReplacementPlan);
    return;
  }
  const planDelete = event.target.closest('[data-delete-replacement-plan]');
  if (planDelete) {
    deleteReplacementPlan(planDelete.dataset.deleteReplacementPlan);
    return;
  }
  const replacementRemove = event.target.closest('[data-remove-replacement-plan]');
  if (replacementRemove) {
    removeReplacementPlan(replacementRemove.dataset.removeReplacementPlan);
    return;
  }
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
  const unitInput = event.target.closest('[data-unit-member-qty]');
  if (unitInput) { updateUnitMemberQuantity(unitInput.dataset.unitId, unitInput.dataset.unitMemberQty, unitInput.value); return; }
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
function closeAccessCodeModal() {
  if (els.accessCodeModal) els.accessCodeModal.hidden = true;
  if (els.accessCodeError) els.accessCodeError.hidden = true;
}

function openAccessCodeModal() {
  if (els.accessCodeInput) els.accessCodeInput.value = '';
  if (els.accessCodeError) els.accessCodeError.hidden = true;
  if (els.accessCodeModal) els.accessCodeModal.hidden = false;
  els.accessCodeInput?.focus();
}

async function submitAccessCodeSwitch() {
  const code = String(els.accessCodeInput?.value || '').trim();
  const errorBox = els.accessCodeError;
  const fail = (message) => { if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; } showToast(message, 4000); };
  if (!code) { fail('请输入访问码'); return; }
  let role = '';
  try {
    const r = await callRpc('board_whoami', { p_code: code });
    if (!r.response.ok) throw new Error(r.data?.message || '访问码验证失败');
    role = String((r.data && r.data.role) || '');
  } catch (error) {
    fail(error.message || '访问码验证失败，请检查网络后重试');
    return;
  }
  if (role !== 'admin' && role !== 'user') { fail('这个访问码无效，请重新输入'); return; }
  if (!canUseRole(role)) {
    fail(BOARD_MODE === 'admin' ? '这个网址是管理员模式，请输入管理员码' : '这个网址是普通模式，请输入普通码');
    return;
  }
  try {
    localStorage.setItem(ACCESS_CODE_STORAGE_KEY, code);
    localStorage.setItem(ROLE_STORAGE_KEY, role + '|' + code);
  } catch { }
  boardRole = role;
  boardCanSeeAmount = role === 'admin';
  applyRoleUI();
  closeAccessCodeModal();
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

function switchAccessCode() { openAccessCodeModal(); }

if (els.accessCodeClose) els.accessCodeClose.addEventListener('click', closeAccessCodeModal);
if (els.accessCodeCancel) els.accessCodeCancel.addEventListener('click', closeAccessCodeModal);
if (els.accessCodeSave) els.accessCodeSave.addEventListener('click', submitAccessCodeSwitch);
if (els.accessCodeModal) els.accessCodeModal.addEventListener('click', (event) => { if (event.target === els.accessCodeModal) closeAccessCodeModal(); });
if (els.accessCodeInput) els.accessCodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') submitAccessCodeSwitch(); });
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
document.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit-order]');
  if (editButton) { openOrderEdit(editButton.dataset.editOrder); return; }
});
if (els.orderEditClose) els.orderEditClose.addEventListener('click', closeOrderEdit);
if (els.orderEditCancel) els.orderEditCancel.addEventListener('click', closeOrderEdit);
if (els.orderEditSave) els.orderEditSave.addEventListener('click', saveOrderEdit);
if (els.orderEditModal) els.orderEditModal.addEventListener('click', (event) => { if (event.target === els.orderEditModal) closeOrderEdit(); });
if (els.orderEditQty) els.orderEditQty.addEventListener('input', () => {
  if (els.orderEditDue) els.orderEditDue.disabled = String(els.orderEditQty.value || '').trim() === '0';
});
if (els.pdfPreview) els.pdfPreview.addEventListener('change', (event) => {
  const select = event.target.closest('[data-pdf-order-type]');
  if (!select) return;
  const index = Number(select.dataset.pdfOrderType);
  const doc = pendingPdfDocs[index];
  if (!doc) return;
  doc.orderType = select.value;
  for (const row of pendingPdfRows) {
    if (Number(row.pdfDocIndex) === index) row.orderType = select.value;
  }
});
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
  const editButton = event.target.closest('[data-edit-qty]');
  if (editButton) { editShipmentQuantity(editButton.dataset.editQty, Number(editButton.dataset.editValue) || 0); return; }
  const button = event.target.closest('[data-undo]');
  if (button) undoShipment(button.dataset.undo);
  else handleQueryActionClick(event);
});
els.mobileRecordsPanel.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit-qty]');
  if (editButton) { editShipmentQuantity(editButton.dataset.editQty, Number(editButton.dataset.editValue) || 0); return; }
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
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      void loadState({ quiet: true, fast: true });
      if (boardRole !== 'admin') return;
      const desktopReportVisible = desktopModule === 'work' && desktopView === 'workReport' && els.desktopWorkReportView && !els.desktopWorkReportView.hidden;
      const mobileReportVisible = mobileModule === 'workReview' && mobileWorkTab === 'report' && els.mobileWorkReportPanel && !els.mobileWorkReportPanel.hidden;
      if ((desktopReportVisible || mobileReportVisible) && Date.now() - workLiveLoadedAt > 30000) loadWorkReportWorkspace().catch(() => {});
    };
    // 后台标签页完全停止轮询；前台 10 秒同步一次，减少频繁网络请求造成的卡顿。
    connectEvents.pollTimer = setInterval(poll, 10000);
    if (connectEvents.visibilityHandler) document.removeEventListener('visibilitychange', connectEvents.visibilityHandler);
    connectEvents.visibilityHandler = () => { if (document.visibilityState === 'visible') void loadState({ quiet: true, fast: true }); };
    document.addEventListener('visibilitychange', connectEvents.visibilityHandler);
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


/* ===== 标签指示器（Elastic Tab indicator） ===== */
const elasticTabHandles = [];
function elasticBezierEase(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const delta = sampleX(t) - x;
      const slope = slopeX(t);
      if (Math.abs(delta) < 1e-5 || Math.abs(slope) < 1e-6) break;
      t -= delta / slope;
    }
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return sampleY(t);
  };
}
const elasticEase = elasticBezierEase(.2, .9, .22, 1);
const ELASTIC_DURATION = 480;
const ELASTIC_STAGGER = 6 * (1000 / 60); // 后沿延后 6 帧起步
function elasticOvershoot(p) {
  return p + Math.sin(Math.PI * Math.min(1, p)) * (1 - p) * 0.05;
}
function attachElasticTabs(container, itemSelector) {
  const items = [...container.querySelectorAll(itemSelector)];
  if (items.length < 2) return null;
  container.classList.add('elastic-tabs');
  const indicator = document.createElement('span');
  indicator.className = 'elastic-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  container.insertBefore(indicator, container.firstChild);

  let live = null;      // 当前实际渲染的位置（动画被打断时从这里接着走）
  let settled = null;   // 稳定位置
  let raf = 0;
  let pending = 0;
  let lastTargetKey = '';

  const applyBox = (left, width, top, height) => {
    indicator.style.left = left + 'px';
    indicator.style.width = width + 'px';
    if (top != null) indicator.style.top = top + 'px';
    if (height != null) indicator.style.height = height + 'px';
    live = {
      left,
      width,
      top: top != null ? top : (live ? live.top : 0),
      height: height != null ? height : (live ? live.height : 0),
    };
  };
  const measure = () => {
    const active = items.find((el) => el.classList.contains('active'));
    if (!active || !active.offsetWidth) return null;
    return { left: active.offsetLeft, width: active.offsetWidth, top: active.offsetTop, height: active.offsetHeight };
  };
  const snap = () => {
    const target = measure();
    cancelAnimationFrame(raf);
    cancelAnimationFrame(pending);
    if (!target) { indicator.style.opacity = '0'; live = null; settled = null; lastTargetKey = ''; return null; }
    indicator.style.opacity = '1';
    settled = target;
    lastTargetKey = target.left + ':' + target.width;
    applyBox(target.left, target.width, target.top, target.height);
    return target;
  };
  const run = () => {
    const target = measure();
    if (!target) { indicator.style.opacity = '0'; live = null; settled = null; return; }
    indicator.style.opacity = '1';
    const from = live || settled || target;
    const key = target.left + ':' + target.width;
    if ((Math.abs(from.left - target.left) < 0.5 && Math.abs(from.width - target.width) < 0.5) || key === lastTargetKey && raf === 0) {
      settled = target;
      lastTargetKey = key;
      applyBox(target.left, target.width, target.top, target.height);
      return;
    }
    lastTargetKey = key;
    const dir = (target.left + target.width / 2) >= (from.left + from.width / 2) ? 1 : -1;
    const leadFrom = dir > 0 ? from.left + from.width : from.left;
    const leadTo = dir > 0 ? target.left + target.width : target.left;
    const trailFrom = dir > 0 ? from.left : from.left + from.width;
    const trailTo = dir > 0 ? target.left : target.left + target.width;
    const peak = Math.max(from.width, target.width) * 0.62;
    const barWidth = container.clientWidth || (target.left + target.width);
    const startedAt = performance.now();
    cancelAnimationFrame(raf);
    const step = (now) => {
      const elapsed = now - startedAt;
      const pLead = Math.min(1, elapsed / ELASTIC_DURATION);
      const lead = leadFrom + (leadTo - leadFrom) * elasticOvershoot(elasticEase(pLead));
      const pTrail = Math.min(1, Math.max(0, (elapsed - ELASTIC_STAGGER) / ELASTIC_DURATION));
      const trailBase = trailFrom + (trailTo - trailFrom) * elasticEase(pTrail);
      const trail = trailBase - dir * Math.sin(Math.PI * pLead) * peak;
      let left = Math.min(lead, trail);
      let right = Math.max(lead, trail);
      // 中段最多拉到基础宽度的 2.4 倍，保证“两倍以上”又不会夸张
      const maxStretch = Math.max(from.width, target.width) * 2.4;
      if (right - left > maxStretch) {
        if (dir > 0) left = right - maxStretch;
        else right = left + maxStretch;
      }
      if (left < 0) left = 0;
      if (right > barWidth) {
        const over = right - barWidth;
        right = barWidth;
        left = Math.max(0, left - over);
      }
      if (right - left < 6) right = Math.min(barWidth, left + 6);
      applyBox(left, Math.max(6, right - left), target.top, target.height);
      if (pLead < 1 || pTrail < 1) {
        raf = requestAnimationFrame(step);
      } else {
        raf = 0;
        settled = target;
        applyBox(target.left, target.width, target.top, target.height);
      }
    };
    raf = requestAnimationFrame(step);
  };
  const schedule = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => { pending = 0; run(); });
  };

  snap();
  const observer = new MutationObserver(schedule);
  observer.observe(container, { attributes: true, attributeFilter: ['class'], subtree: true });
  // 只在“位置还没建立/容器刚显示”时直接落位，正常切换交给动画
  const reflow = () => {
    const target = measure();
    if (!target) return;
    if (!live || live.width === 0 || Math.abs(live.width - target.width) > 0.5 && raf === 0 && lastTargetKey === '') snap();
    else if (!live) snap();
  };
  const handle = { snap, move: schedule, reflow };
  elasticTabHandles.push(handle);
  return handle;
}
function initElasticTabs() {
  const groups = [
    ['.mobile-tabs', '.mobile-tab'],
    ['.mobile-work-tabs', 'button'],
    ['#drawingCategoryTabs', '.chip'],
  ];
  for (const [sel, item] of groups) {
    document.querySelectorAll(sel).forEach((container) => attachElasticTabs(container, item));
  }
  document.querySelectorAll('.query-tabs').forEach((container) => attachElasticTabs(container, '.chip'));
}
function refreshElasticTabs() {
  requestAnimationFrame(() => {
    for (const handle of elasticTabHandles) handle.reflow();
  });
}
initElasticTabs();
window.addEventListener('resize', () => { for (const handle of elasticTabHandles) handle.snap(); });

syncMobileEntryLink();
applyDesktopColumnWidths();
setupDesktopColumnResize();
applyDesktopRemainingColumnWidths();
setupDesktopRemainingColumnResize();
setupDeliveryColumnResize();
applyDeliveryColumnWidths('grouped');
applyDeliveryColumnWidths('merged');
let desktopColumnResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(desktopColumnResizeTimer);
  desktopColumnResizeTimer = setTimeout(() => {
    applyDesktopColumnWidths();
    applyDesktopRemainingColumnWidths();
  }, 160);
});
setupRpcExportLink();
if (!getAccessCode()) askAccessCode();
await loadBoardRole();
await loadMarkMaterials();
restoreCachedState();
await loadState({ fast: true });
connectEvents();
warmOptionalLibraries();
if (els.printHelperStatus) els.printHelperStatus.addEventListener('click', () => void checkPrintHelper(true));
if (els.mobilePrintHelperStatus) els.mobilePrintHelperStatus.addEventListener('click', () => void checkPrintHelper(true));
if (els.taskStatusClose) els.taskStatusClose.addEventListener('click', clearTaskStatus);
if (els.taskStatusAction) els.taskStatusAction.addEventListener('click', () => { if (taskStatusActionHandler) taskStatusActionHandler(); });
if (document.body.dataset.view !== 'mobile') {
  void checkPrintHelper();
setInterval(() => { if (document.visibilityState === 'visible') void checkPrintHelper(); }, 60000);
}
syncMobileStickyOffsets();
window.addEventListener('resize', syncMobileStickyOffsets);


























