(() => {
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'fanshipWorkEmployeeCode';
  const COOKIE_KEY = 'fanshipWorkEmployeeCode';
  const SESSION_BETA = new URLSearchParams(location.search).get('session') === '1';
  let code = '';
  let state = null;
  let selectedProduct = null;
  let selectedProcessId = '';
  let searchTimer = null;
  let selectedVariant = null;
  let pendingRevokeId = '';
  let requestMode = 'custom';
  let requestProduct = null;
  let requestAutoPrice = null;
  let requestMaterialTimer = null;
  let requestMaterialToken = 0;
  let editEntry = null;
  let salaryDate = '';
  let salaryRange = 'day';
  let salaryMonthValue = '';
  let salaryMonthData = null;
  let salaryData = null;
  let profile = null;
  let attendanceData = null;
  let payrollData = null;
  let payrollRange = 'month';
  let betaSession = null;
  let betaHistory = [];
  let betaStateLoaded = false;
  let selectedPriceToken = 0;
  let productProcessToken = 0;
  let productSearchToken = 0;
  const productProcessMap = new Map();
  const matchedVariantMap = new Map();
  const PROCESS_VARIANTS = {
    '打孔': { key: 'holes', label: '孔数', type: 'select', options: [1,2,3,4,5,6,8,10] },
    '攻丝': { key: 'holes', label: '攻丝孔数', type: 'select', options: [1,2,3,4], allowCustom:true },
    '折弯': { key: 'bends', label: '折弯刀数', type: 'select', options: [1,2,3,4], allowCustom:true },
    '梁配件折弯': { key: 'bends', label: '折弯刀数', type: 'select', options: [1,2,3,4], allowCustom:true },
    '短梁折边': { key: 'bends', label: '折弯刀数', type: 'select', options: [4], allowCustom:false },
    '长梁折边': { key: 'bends', label: '折弯刀数', type: 'select', options: [4], allowCustom:false },
    '剪板': { key: 'thickness', label: '板厚', type: 'select', options: [3,4,6] },
    '弯管': { key: 'bends', label: '弯管道数', type: 'select', options: [1,2,3,4], allowCustom:true },
  };

  const show = (el, on) => el && el.classList.toggle('hidden', !on);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const fmtMinutes = (m) => `${(Number(m || 0) / 60).toFixed(1)}h`;
  const fmtClock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Shanghai' }); };
  function toast(text) { const el = $('toast'); el.textContent = text; show(el, true); clearTimeout(toast.t); toast.t = setTimeout(() => show(el, false), 2600); }
  function readCookie(name) {
    const prefix = encodeURIComponent(name) + '=';
    const item = document.cookie.split('; ').find((row) => row.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : '';
  }
  function persistCode(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch {}
    try { document.cookie = `${COOKIE_KEY}=${encodeURIComponent(value)}; Max-Age=315360000; Path=/; SameSite=Lax`; } catch {}
  }
  function clearStoredCode() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    try { document.cookie = `${COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax`; } catch {}
  }
  function storedEmployeeCode() {
    try { const value = localStorage.getItem(STORAGE_KEY) || ''; if (value) return value; } catch {}
    return readCookie(COOKIE_KEY) || '';
  }
  function rpcFormBody(body) {
    const form = new URLSearchParams();
    Object.entries(body || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    });
    return form.toString();
  }
  // 带 null / undefined 参数的调用没法用表单体表达 SQL NULL，这类调用继续走原来的 JSON 方式。
  function rpcNeedsJsonBody(body) {
    return Object.values(body || {}).some((value) => value === null || value === undefined);
  }
  // 关键改动：能用表单体（application/x-www-form-urlencoded）+ URL 传 apikey 的调用属于浏览器"简单请求"，
  // 不再触发跨域预检（OPTIONS）。移动卡等弱网环境下跨域预检最容易被运营商掐断，表现为 Failed to fetch。
  // 会新建计件记录的接口 → 走幂等版本：网络重试/连点不会写成两条
  const IDEMPOTENT_RPCS = {
    work_add_piece_entry: 'work_add_piece_entry_idem',
    work_submit_custom_piece: 'work_submit_custom_piece_idem',
    work_submit_piece_request: 'work_submit_piece_request_idem',
    work_submit_price_change: 'work_submit_price_change_idem'
  };
  function newClientRef() {
    try { return crypto.randomUUID(); } catch { return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
  }
  // 两条线路：① 国内转发（默认，最稳） ② 直连备用（部分网络能通）
  function rpcBases() {
    const list = [];
    if (window.WORK_RPC_BASE) list.push(window.WORK_RPC_BASE);
    if (window.WORK_DIRECT_RPC_BASE && window.WORK_DIRECT_RPC_BASE !== window.WORK_RPC_BASE) list.push(window.WORK_DIRECT_RPC_BASE);
    return list;
  }
  async function rpc(name, body) {
    let payload = body;
    const idemName = IDEMPOTENT_RPCS[name];
    if (idemName) {
      // 幂等键只生成一次：换线路重试也不会写成两条
      name = idemName;
      payload = { ...(body || {}), p_client_ref: newClientRef() };
    }
    const useJson = rpcNeedsJsonBody(payload);
    const bases = rpcBases();
    let lastError = null;
    for (let b = 0; b < bases.length; b += 1) {
      const base = bases[b];
      const url = useJson
        ? `${base}/${name}`
        : `${base}/${name}?apikey=${encodeURIComponent(window.WORK_ANON_KEY)}`;
      const init = useJson
        ? { headers:{ apikey:window.WORK_ANON_KEY, Authorization:`Bearer ${window.WORK_ANON_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) }
        : { headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:rpcFormBody(payload) };
      const attempts = b === 0 ? 3 : 2;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        try {
          const r = await fetch(url, { method:'POST', ...init, signal:controller.signal, cache:'no-store' });
          const data = await r.json().catch(() => null);
          if (!r.ok) {
            const httpError = new Error(data?.message || '请求失败');
            httpError.status = r.status;
            // 4xx 是业务/权限问题，换线路也没用；5xx 值得换线路再试
            if (r.status < 500) httpError.noRetry = true;
            throw httpError;
          }
          return data;
        } catch (error) {
          if (error.noRetry) throw error;
          lastError = error;
          if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 700));
        } finally {
          clearTimeout(timer);
        }
      }
    }
    if (!navigator.onLine) throw new Error('手机当前没有网络，请检查 4G/5G 或 Wi-Fi');
    const reason = lastError?.name === 'AbortError' ? '连接超时' : (lastError?.message || '网络连接失败');
    throw new Error(`${reason}（两条线路都试过了：请切换 WiFi / 流量，或关闭 VPN、私人中继后重试）`);
  }
  function betaStorageKey(kind) { return `fanshipWorkBeta:${kind}:${code || 'none'}`; }
  function loadBetaSession() {
    try { betaSession = JSON.parse(localStorage.getItem(betaStorageKey('session')) || 'null'); } catch { betaSession = null; }
    try { betaHistory = JSON.parse(localStorage.getItem(betaStorageKey('history')) || '[]'); } catch { betaHistory = []; }
    betaStateLoaded = true;
  }
  function saveBetaState() {
    try { localStorage.setItem(betaStorageKey('session'), JSON.stringify(betaSession)); } catch {}
    try { localStorage.setItem(betaStorageKey('history'), JSON.stringify(betaHistory.slice(-30))); } catch {}
  }
  function betaElapsedText() {
    if (!betaSession?.startedAt) return '00:00:00';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(betaSession.startedAt).getTime()) / 1000));
    return `${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor((seconds%3600)/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  }
  function addBetaHistory() {
    if (!betaSession?.startedAt) return;
    betaHistory.push({ mode:betaSession.mode, startedAt:betaSession.startedAt, endedAt:new Date().toISOString() });
    betaHistory = betaHistory.slice(-30);
  }
  function renderBetaSession() {
    if (!SESSION_BETA) return;
    show($('sessionBetaCard'), true);
    show($('normalClockCard'), false);
    if (!betaStateLoaded) loadBetaSession();
    const actions = $('sessionBetaActions'); const title = $('sessionBetaTitle'); const hint = $('sessionBetaHint'); const elapsed = $('sessionBetaElapsed');
    if (!betaSession) {
      title.textContent = '选择工作类型'; hint.textContent = '计时和计件同一时间只开启一种工作时段'; elapsed.textContent = '00:00:00';
      actions.innerHTML = `<button class="ghost" type="button" data-beta-action="start-piece">开始计件工作</button><button class="primary" type="button" data-beta-action="start-time">开始计时工作</button>`;
    } else if (betaSession.mode === 'piece') {
      title.textContent = '正在计件工作'; hint.textContent = '本时段只记录计件，不影响计时工资'; elapsed.textContent = betaElapsedText();
      actions.innerHTML = `<button class="ghost" type="button" data-beta-action="switch-time">结束计件并开始计时</button><button class="primary" type="button" data-beta-action="end">结束全部工作</button>`;
    } else {
      title.textContent = '正在计时工作'; hint.textContent = '本时段按有效工时计算，不计件'; elapsed.textContent = betaElapsedText();
      actions.innerHTML = `<button class="ghost" type="button" data-beta-action="switch-piece">结束计时并开始计件</button><button class="primary" type="button" data-beta-action="end">结束全部工作</button>`;
    }
    $('sessionBetaHistory').innerHTML = betaHistory.length ? betaHistory.slice(-6).reverse().map((row) => `<div class="session-history-row"><strong>${row.mode === 'piece' ? '计件' : '计时'}</strong><span>${fmtClock(row.startedAt)} → ${fmtClock(row.endedAt)}</span></div>`).join('') : '';
    const canPiece = betaSession?.mode === 'piece'; show($('pieceSessionNotice'), !canPiece); updatePieceSubmitState();
  }
  async function startBetaSession(mode) {
    const startedAt = new Date().toISOString();
    if (mode === 'time') { const result = await rpc('work_start_timer', { p_code:code }); betaSession = { mode:'time', startedAt:result?.startedAt || startedAt }; saveBetaState(); await loadState(); }
    else { betaSession = { mode:'piece', startedAt }; saveBetaState(); renderBetaSession(); toast('已开始计件工作'); }
  }
  async function switchBetaSession(mode) {
    if (betaSession?.mode === mode) return;
    if (betaSession?.mode === 'time') await rpc('work_stop_timer', { p_code:code });
    addBetaHistory(); betaSession = null; saveBetaState(); await startBetaSession(mode);
  }
  async function endBetaSession() {
    if (!betaSession) return;
    if (betaSession.mode === 'time') await rpc('work_stop_timer', { p_code:code });
    addBetaHistory(); betaSession = null; saveBetaState(); await loadState(); renderBetaSession(); toast('本次工作时段已结束');
  }
  function currentElapsedText() {
    if (!state?.activeEntry?.startedAt) return '00:00';
    const s = Math.max(0, Math.floor((Date.now() - new Date(state.activeEntry.startedAt).getTime()) / 1000));
    return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}`;
  }
  function renderTime() {
    const active = Boolean(state?.activeEntry);
    const elapsed = currentElapsedText();
    $('clockLabel').textContent = active ? '计时中 · 已开始' : '当前未计时';
    $('clockTime').textContent = elapsed;
    const banner = $('activeTimerBanner');
    banner.classList.toggle('hidden', !active);
    if (active) {
      $('activeTimerElapsed').textContent = elapsed;
      $('activeTimerSince').textContent = `开始 ${fmtClock(state.activeEntry.startedAt)}`;
    }
    $('normalClockCard').classList.toggle('is-running', active);
    const note = $('clockNote');
    note.textContent = active ? `已从 ${fmtClock(state.activeEntry.startedAt)} 开始计时，请勿重复点击开始` : '';
    note.hidden = !active;
    const btn = $('clockAction');
    if (!btn.classList.contains('is-loading') && !btn.classList.contains('is-success') && !btn.classList.contains('is-result')) {
      const label = btn.querySelector('.ca-text') || btn;
      label.textContent = active ? '结束本次计时' : '开始计时';
      btn.classList.toggle('clock-stop', active);
    }
    $('todayMinutes').textContent = fmtMinutes(state?.todayMinutes);
    $('monthMinutes').textContent = fmtMinutes(state?.monthMinutes);
    const rows = state?.todayEntries || []; $('todayCount').textContent = `${rows.length} 段`;
    $('todayEntries').innerHTML = rows.length ? rows.map((x) => `<div class="record"><div><strong>${esc(fmtClock(x.startedAt))} → ${x.endedAt ? esc(fmtClock(x.endedAt)) : '进行中'}</strong><small>${x.status === 'closed' ? '已完成' : '未结束'}${x.overtimeConfirmed ? '<em class="record-special">已确认加班</em>' : (x.specialConfirmed ? '<em class="record-special">已备注</em>' : '')}${x.specialNote ? ` · ${esc(x.specialNote)}` : ''}</small></div><strong>${x.endedAt ? `${Number(x.rawMinutes || 0)} 分钟` : '计时中'}</strong></div>`).join('') : '<div class="empty">今天还没有计时记录</div>';
  }
  function currentProcess() {
  return (state?.processes || []).find((p) => p.id === selectedProcessId) || null;
}
function revealVariantBox() {
  const box = $('variantBox');
  if (!box || box.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    box.classList.add('variant-attention');
    box.scrollIntoView({ behavior:'smooth', block:'center' });
    setTimeout(() => box.classList.remove('variant-attention'), 800);
  });
}
function fixedVariantValues(processId) {
  return [...new Set((matchedVariantMap.get(processId) || [])
    .filter((item) => item.variantKey && Number(item.variantValue) > 0)
    .map((item) => Number(item.variantValue)))]
    .sort((a, b) => a - b);
}
function allowCustomForProcess(process, product = selectedProduct) {
  if (!process) return false;
  if (process.name === '弯管') return ['002','HJ-002'].includes(String(product?.material || ''));
  return Boolean(PROCESS_VARIANTS[process.name]?.allowCustom);
}
function currentVariantOptions() {
  const process = currentProcess();
  const config = process ? PROCESS_VARIANTS[process.name] : null;
  if (!process || !config) return { process:null, config:null, options:[] };
  const fixed = fixedVariantValues(selectedProcessId);
  if (fixed.length) {
    return { process, config, options:fixed };
  }
  if (allowCustomForProcess(process)) return { process, config, options:config.options };
  return { process, config, options:fixed.length ? fixed : config.options };
}
function isGenericProduct(product = selectedProduct) {
  return Boolean(product && (/^NC-/i.test(String(product.material || '')) || !String(product.material || '').trim()));
}
function preferredVariantForProcess(processId) {
  const direct = productProcessMap.get(processId)?.lastUsedVariant;
  if (direct && Number(direct.variantValue) > 0) return direct;
  const rows = (matchedVariantMap.get(processId) || [])
    .filter((item) => item.variantKey && Number(item.variantValue) > 0)
    .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));
  const priced = rows.find((item) => item.lastUsedAt) || (rows.length === 1 ? rows[0] : null);
  if (priced) return priced;
  const recent = (state?.pieceEntries || [])
    .filter((item) => String(item.productId) === String(selectedProduct?.id)
      && String(item.processId) === String(processId)
      && item.variantKey && Number(item.variantValue) > 0
      && (item.status === 'submitted' || item.status === 'approved'))
    .sort((a, b) => new Date(b.createdAt || b.submittedAt || 0) - new Date(a.createdAt || a.submittedAt || 0));
  return recent.length ? { variantValue:Number(recent[0].variantValue), variantLabel:recent[0].variantLabel || String(recent[0].variantValue) } : null;
}
function setGenericVariantPrice() {
  const process = currentProcess();
  const value = Number($('variantModalCustomValue')?.value || 0);
  if (!process || !Number.isInteger(value) || value <= 0) { $('variantGenericPrice').textContent = '请输入正整数后自动计算单价'; return 0; }
  const unitPrice = Number((0.2 * value).toFixed(2));
  const qty = Number($('variantGenericQty')?.value || 0);
  const amount = Number.isInteger(qty) && qty > 0 ? Number((unitPrice * qty).toFixed(2)) : null;
  $('variantGenericPrice').textContent = `单价 ${unitPrice.toFixed(2)} 元${amount != null ? ` · 金额 ${amount.toFixed(2)} 元` : ''}`;
  return unitPrice;
}
async function submitGenericVariant() {
  const process = currentProcess();
  if (!process) return toast('工序信息已失效，请重新选择');
  const value = Number($('variantModalCustomValue').value || 0);
  if (!Number.isInteger(value) || value <= 0) return toast('请填写大于 0 的整数');
  const name = $('variantGenericName').value.trim();
  const material = $('variantGenericMaterial').value.trim();
  const qty = Number($('variantGenericQty').value);
  if (!name) return toast('请填写实际品名');
  if (!material || material.length < 4) return toast('请填写完整料件编号或后四位');
  if (!Number.isInteger(qty) || qty <= 0) return toast('数量必须是大于 0 的整数');
  const config = PROCESS_VARIANTS[process.name];
  const unitPrice = Number((0.2 * value).toFixed(2));
  const button = $('variantGenericSubmit'); button.disabled = true;
  try {
    await rpc('work_submit_custom_piece', {
      p_code:code,
      p_name:name,
      p_material:material,
      p_spec:'',
      p_process_id:process.id,
      p_process_name:process.name,
      p_quantity:qty,
      p_variant_key:config?.key || '',
      p_variant_value:value,
      p_variant_label:variantDisplay(process.name, value),
      p_unit_price:unitPrice,
      p_note:'自填规格并补充料件信息',
    });
    closeVariantModal();
    selectedProduct = null; selectedProcessId = ''; selectedVariant = null;
    $('pieceQty').value = ''; $('pieceNote').value = '';
    await loadState();
    toast('已提交，等待管理员审核');
  } catch (e) { toast(e.message || '提交失败'); } finally { button.disabled = false; }
}
function applyCustomVariant(rawValue, source = '') {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) return toast('请填写大于 0 的整数');
  const process = currentProcess();
  const label = process?.name === '弯管' ? `${value}道` : process?.name === '折弯' ? `${value}刀` : `${value}孔`;
  selectedVariant = { value, label, custom:true };
  if (source === 'modal') closeVariantModal();
  renderVariant();
  refreshSelectedPrice();
}
function openVariantModal() {
  const { process, config, options } = currentVariantOptions();
  if (!process || !config) return;
  if (!selectedVariant) {
    const preferred = preferredVariantForProcess(selectedProcessId);
    if (preferred) selectedVariant = { value:Number(preferred.variantValue), label:preferred.variantLabel || String(preferred.variantValue), custom:Number(preferred.variantValue) > 4 };
  }
  $('variantModalTitle').textContent = `请选择${config.label}`;
  $('variantModalHint').textContent = `点一下下面的${config.label}，然后填写数量。`;
  $('variantModalOptions').innerHTML = options.map((v) => `<button type="button" data-modal-variant-value="${v}" data-modal-variant-label="${variantDisplay(process.name, v)}" class="${Number(selectedVariant?.value) === v && !selectedVariant?.custom ? 'active' : ''}">${variantDisplay(process.name, v)}</button>`).join('') + (allowCustomForProcess(process) ? '<button type="button" data-modal-variant-custom="1">自填</button>' : '');
  const customSelected = Boolean(selectedVariant?.custom && Number(selectedVariant?.value) > 0);
  $('variantModalCustomValue').value = customSelected ? String(selectedVariant.value) : '';
  show($('variantModalCustomWrap'), customSelected);
  show($('variantGenericInfoWrap'), false);
  show($('variantModal'), true);
}
function closeVariantModal() { show($('variantModal'), false); }
function renderVariant() {
  const box = $('variantBox');
  const process = currentProcess();
  const config = process ? PROCESS_VARIANTS[process.name] : null;
  if (!config) { selectedVariant = null; show(box, false); box.innerHTML = ''; updatePieceSubmitState(); return; }
  if (config.type === 'select') {
    const options = currentVariantOptions().options;
    box.innerHTML = `<div class="variant-label">${config.label}</div><div class="variant-options">${options.map((v) => `<button type="button" data-variant-value="${v}" data-variant-label="${variantDisplay(process.name, v)}" class="${Number(selectedVariant?.value) === v && !selectedVariant?.custom ? 'active' : ''}">${variantDisplay(process.name, v)}</button>`).join('')}${allowCustomForProcess(process) ? '<button type="button" data-variant-custom="1" class="' + (selectedVariant?.custom ? 'active' : '') + '">自填</button>' : ''}</div>${allowCustomForProcess(process) ? '<div id="variantCustomWrap" class="variant-custom hidden"><input id="variantCustomValue" type="number" min="1" step="1" inputmode="numeric" placeholder="请输入正整数"><button id="variantCustomConfirm" class="primary" type="button">确定</button></div>' : ''}`;
  } else {
    box.innerHTML = `<div class="variant-label">${config.label}</div><input id="variantValue" type="number" min="1" step="1" inputmode="numeric" placeholder="${config.placeholder}" value="${selectedVariant?.value || ''}">`;
  }
  show(box, true);
  updatePieceSubmitState();
}
async function refreshSelectedPrice() {
  const card = $('selectedPriceCard');
  const process = currentProcess();
  if (!card || !selectedProduct || !process) { show(card, false); return; }
  const config = PROCESS_VARIANTS[process.name];
  const value = Number(selectedVariant?.value || 0);
  if (config && !value) {
    card.className = 'selected-price-card warn';
    card.innerHTML = `<strong>请选择${config.label}</strong><span>选好规格后显示当前单价</span>`;
    show(card, true);
    return;
  }
  const token = ++selectedPriceToken;
  card.className = 'selected-price-card';
  card.innerHTML = '<strong>正在查询当前单价…</strong>';
  show(card, true);
  try {
    const variant = config ? { key:config.key, value, label:selectedVariant?.label || variantDisplay(process.name, value) } : { key:'', value:0, label:'' };
    const result = await rpc('work_get_catalog_price', {
      p_code:code,
      p_product_id:selectedProduct.id,
      p_process_id:process.id,
      p_variant_key:variant.key,
      p_variant_value:variant.value,
    });
    if (token !== selectedPriceToken) return;
    if (result?.unitPrice != null) {
      card.classList.remove('warn');
      card.innerHTML = `<strong>当前单价：${Number(result.unitPrice).toLocaleString('zh-CN',{maximumFractionDigits:4})} 元</strong>`;
    } else {
      card.classList.add('warn');
      card.innerHTML = '<strong>当前没有配置单价</strong><span>请点击下面“单价不对？申请修改”提交审核</span>';
    }
  } catch (e) {
    if (token !== selectedPriceToken) return;
    card.classList.add('warn');
    card.innerHTML = '<strong>暂时无法查询单价</strong><span>可稍后刷新重试</span>';
  }
}
async function loadProductProcesses(productId) {
  const token = ++productProcessToken;
  productProcessMap.clear();
  matchedVariantMap.clear();
  try {
    const rows = await rpc('work_get_product_processes', { p_code:code, p_product_id:productId });
    if (token !== productProcessToken) return;
    for (const row of rows || []) {
      productProcessMap.set(row.id, row);
      matchedVariantMap.set(row.id, row.variants || []);
    }
  } catch (e) {
    if (token !== productProcessToken) return;
    toast(e.message || '工序匹配失败');
  }
  // 折弯工：护栏类自动走弯管，其余产品自动走折弯；规格选项仍由前端规格弹窗提供
  const isGuardrail = /护栏/.test(String(selectedProduct?.name || ''));
  const foldProcess = (state?.processes || []).find((process) => process.name === '折弯' && process.id);
  if (isGuardrail && foldProcess) {
    productProcessMap.delete(foldProcess.id);
    matchedVariantMap.delete(foldProcess.id);
  }
  const hasPackagingProcess = [...productProcessMap.values()].some((row) => String(row.name || '').includes('包装'));
  const extraProcessName = isGuardrail ? '弯管' : '折弯';
  const extraProcess = (state?.processes || []).find((process) => process.name === extraProcessName && process.id);
  if (!hasPackagingProcess && extraProcess && !productProcessMap.has(extraProcess.id)) {
    productProcessMap.set(extraProcess.id, { id:extraProcess.id, name:extraProcessName, variants:[] });
    matchedVariantMap.set(extraProcess.id, []);
  }
  const allowed = (state?.processes || []).filter((process) => productProcessMap.has(process.id));
  selectedProcessId = '';
  selectedVariant = null;
  if (allowed.length === 1) {
    selectedProcessId = allowed[0].id;
    const preferred = preferredVariantForProcess(selectedProcessId);
    if (preferred) selectedVariant = { value:Number(preferred.variantValue), label:preferred.variantLabel || String(preferred.variantValue), custom:Number(preferred.variantValue) > 4 };
  }
  renderPiece();
  if (selectedProcessId && PROCESS_VARIANTS[allowed[0]?.name] && !selectedVariant) openVariantModal();
}
function pieceFormState() {
  const process = currentProcess();
  const config = process ? PROCESS_VARIANTS[process.name] : null;
  const variantValue = config?.type === 'select'
    ? Number(selectedVariant?.value || 0)
    : Number($('variantValue')?.value || 0);
  const variantReady = !config || variantValue > 0;
  const quantity = Number($('pieceQty')?.value || 0);
  const quantityReady = Number.isInteger(quantity) && quantity > 0;
  const sessionReady = !SESSION_BETA || betaSession?.mode === 'piece';
  return {
    product: Boolean(selectedProduct),
    process: Boolean(selectedProcessId) && variantReady,
    qty: quantityReady,
    ready: Boolean(selectedProduct && selectedProcessId && variantReady && quantityReady && !state?.activeEntry && sessionReady),
  };
}
function showPieceFormError(message = '') {
  const box = $('pieceFormError');
  if (!box) return;
  box.textContent = message;
  show(box, Boolean(message));
}
function updatePieceSubmitState() {
  const formState = pieceFormState();
  const btn = $('pieceSubmit');
  if (btn) btn.disabled = !formState.ready;
  const values = [formState.product, formState.process, formState.qty];
  const firstPending = values.findIndex((value) => !value);
  document.querySelectorAll('[data-piece-step]').forEach((step, index) => {
    step.classList.toggle('done', Boolean(values[index]));
    step.classList.toggle('active', firstPending >= 0 ? index === firstPending : false);
  });
}
function renderPiece() {
  const rows = state?.pieceEntries || [];
  const activeCount = rows.filter((x) => x.status === 'submitted' || x.status === 'approved').length;
  $('pieceCount').textContent = `${activeCount} 笔`;
  $('pieceEntries').innerHTML = rows.length ? rows.map((x) => {
    const material = x.material || x.submittedMaterial || '';
    const name = x.name || x.submittedName || '';
    const process = x.process || x.submittedProcessName || '待审核';
    const statusText = x.status === 'revoked' ? '已撤回' : x.status === 'approved' ? '已通过' : x.status === 'rejected' ? '已退回' : (x.sourceType === 'catalog' ? '已提交' : '待审核');
    const canEdit = x.status === 'submitted' || x.status === 'rejected' || x.status === 'revoked' || x.status === 'approved';
    const canRevoke = x.status === 'submitted' || x.status === 'rejected' || x.status === 'approved';
    const priceText = x.status === 'approved' && x.unitPrice != null
      ? `单价 ${Number(x.unitPrice).toLocaleString('zh-CN',{maximumFractionDigits:4})} 元 · 金额 ${Number(x.amount || 0).toFixed(2)} 元`
      : x.submittedUnitPrice != null
        ? `申报单价 ${Number(x.submittedUnitPrice).toLocaleString('zh-CN',{maximumFractionDigits:2})} 元 · 待审核`
        : '单价待审核';
    const reviewText = x.reviewNote ? `<span>${x.status === 'rejected' ? '退回原因：' : '审核备注：'}${esc(x.reviewNote)}</span>` : '';
    const editText = x.status === 'rejected' ? '修改后重提' : x.status === 'approved' ? '修改数量' : '编辑';
    return `<div class="piece-record"><strong>${esc(material)} · ${esc(name)}</strong><span>${esc(process)}${x.variantLabel ? ' · ' + esc(x.variantLabel) : ''} · ${Number(x.quantity)} 件 · ${esc(x.workDate)}</span><span class="piece-money">${esc(priceText)}</span>${reviewText}<div class="record-foot"><span class="record-status ${x.status}">${statusText}</span><div class="salary-actions">${x.status === 'approved' ? `<button type="button" data-edit-qty="${esc(x.id)}">修改数量</button>` : x.status === 'revoked' ? `<button type="button" data-resubmit-piece="${esc(x.id)}">重新申报</button>` : canEdit ? `<button type="button" data-edit-piece="${esc(x.id)}">${editText}</button>` : ''}${canRevoke ? `<button type="button" class="danger" data-revoke-piece="${esc(x.id)}">撤回</button>` : ''}</div></div></div>`;
  }).join('') : '<div class="card empty">还没有计件申报记录</div>';
  const matchedProcesses = selectedProduct
    ? (state?.processes || []).filter((p) => productProcessMap.has(p.id))
    : [];
  if (selectedProcessId && !matchedProcesses.some((p) => p.id === selectedProcessId)) selectedProcessId = '';
  $('processGrid').innerHTML = matchedProcesses.map((p) => `<button type="button" class="process ${selectedProcessId === p.id ? 'active' : ''}" data-process="${esc(p.id)}">${esc(p.name)}</button>`).join('');
  show($('processGrid'), matchedProcesses.length > 0);
  show($('noPricedProcess'), Boolean(selectedProduct) && matchedProcesses.length === 0);
  show($('priceChangeButton'), Boolean(selectedProduct && selectedProcessId));
  renderVariant();
  refreshSelectedPrice();
  const timerActive = Boolean(state?.activeEntry);
  if (!SESSION_BETA) {
    show($('pieceSessionNotice'), timerActive);
    if (timerActive) $('pieceSessionNotice').textContent = '正在计时，结束后才能申报计件。';
  }
  updatePieceSubmitState();
}
  function fmtMoney(value, digits = 2) {
    return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function salaryStatusText(status) {
    return ({ submitted:'待审核', approved:'已通过', rejected:'已退回', revoked:'已撤回' })[status] || status || '--';
  }
  function salaryStatusNotice(data) {
    const bits = [];
    if (Number(data.pendingCount || 0) > 0) bits.push(`${data.pendingCount} 笔待审核`);
    if (Number(data.rejectedCount || 0) > 0) bits.push(`${data.rejectedCount} 笔已退回`);
    if (Number(data.revokedCount || 0) > 0) bits.push(`${data.revokedCount} 笔已撤回`);
    return bits.length ? bits.join(' · ') : '没有待处理记录';
  }
  function salaryEntryCard(x) {
    const status = salaryStatusText(x.status);
    const price = x.status === 'approved' && x.unitPrice != null
      ? `单价 ${Number(x.unitPrice).toLocaleString('zh-CN',{maximumFractionDigits:4})} 元 · 金额 ${fmtMoney(x.amount)} 元`
      : x.submittedUnitPrice != null
        ? `申报单价 ${Number(x.submittedUnitPrice).toLocaleString('zh-CN',{maximumFractionDigits:2})} 元 · 不计工资`
        : '单价待审核';
    const canEdit = x.status === 'submitted' || x.status === 'rejected' || x.status === 'revoked' || x.status === 'approved';
    const canRevoke = x.status === 'submitted' || x.status === 'rejected' || x.status === 'approved';
    const editText = x.status === 'rejected' ? '修改后重提' : x.status === 'approved' ? '修改数量' : '编辑';
    return `<div class="piece-record"><strong>${esc(x.material || '')} · ${esc(x.name || '')}</strong><span>${esc(x.process || '')}${x.variantLabel ? ' · ' + esc(x.variantLabel) : ''} · ${Number(x.quantity)} 件</span><span class="piece-money">${esc(price)}</span><div class="record-foot"><span class="record-status ${esc(x.status)}">${esc(status)}</span><div class="salary-actions">${x.status === 'approved' ? `<button type="button" data-edit-qty="${esc(x.id)}">修改数量</button>` : x.status === 'revoked' ? `<button type="button" data-resubmit-piece="${esc(x.id)}">重新申报</button>` : canEdit ? `<button type="button" data-edit-piece="${esc(x.id)}">${editText}</button>` : ''}${canRevoke ? `<button type="button" class="danger" data-revoke-piece="${esc(x.id)}">撤回</button>` : ''}</div></div></div>`;
  }
  async function loadSalary() {
    if (!code) return;
    const button = $('salaryRefresh');
    if (button) button.disabled = true;
    try {
      if (salaryRange === 'month') {
        if (!$('salaryMonth').value) $('salaryMonth').value = currentMonth();
        salaryMonthValue = $('salaryMonth').value;
        salaryMonthData = await rpc('work_get_my_salary_month', { p_code:code, p_month: salaryMonthValue + '-01' });
        renderSalaryMonth();
      } else {
        if (!$('salaryDate').value) $('salaryDate').value = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' });
        salaryDate = $('salaryDate').value;
        salaryData = await rpc('work_get_my_salary_day', { p_code:code, p_date:salaryDate });
        renderSalary();
      }
    } catch (e) {
      toast(e.message || '工资加载失败');
    } finally {
      if (button) button.disabled = false;
    }
  }
  function renderSalary() {
    if (!salaryData) return;
    const data = salaryData;
    $('salarySummary').innerHTML = `<span>${esc(data.date || '')} 工资合计</span><strong>${fmtMoney(data.totalPay)} 元</strong><small>计时工资 ${fmtMoney(data.timerPay)} 元 + 已审核计件工资 ${fmtMoney(data.piecePay)} 元</small>`;
    $('salaryStatusHint').textContent = salaryStatusNotice(data);
    const rate = Number(data.employee?.hourlyRate || 0);
    const rateText = Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
    const overtimeRate = Number(data.overtimeHourlyRate || 0) || rate;
    const overtimeRateText = Number.isInteger(overtimeRate) ? String(overtimeRate) : overtimeRate.toFixed(2);
    const overtimeHours = Number(data.overtimeMinutes || 0) / 60;
    $('salaryBreakdown').innerHTML = `
      <div class="salary-line expandable" data-salary-detail="time" role="button" tabindex="0" aria-expanded="false">
        <div class="salary-line-main"><span>计时工时</span><strong>${Number(data.timerHours || 0).toFixed(2)} 小时</strong></div>
        <div class="salary-detail" data-detail-body="time"></div>
      </div>
      <div class="salary-line"><div class="salary-line-main"><span>${overtimeHours > 0 ? '正常时薪' : '计时时薪'}</span><strong>${rateText}元/小时</strong></div></div>
      ${overtimeHours > 0 ? `<div class="salary-line"><div class="salary-line-main"><span>加班时薪</span><strong>${overtimeRateText}元/小时</strong></div></div><div class="salary-line"><div class="salary-line-main"><span>其中加班工时</span><strong>${overtimeHours.toFixed(2)} 小时</strong></div></div>` : ''}
      <div class="salary-line"><div class="salary-line-main"><span>计时工资</span><strong>${fmtMoney(data.timerPay)} 元</strong></div></div>
      <div class="salary-line expandable" data-salary-detail="piece" role="button" tabindex="0" aria-expanded="false">
        <div class="salary-line-main"><span>已审核计件</span><strong>${Number(data.approvedCount || 0)} 笔 · ${Number(data.approvedQuantity || 0)} 件</strong></div>
        <div class="salary-detail" data-detail-body="piece"></div>
      </div>
      <div class="salary-line"><div class="salary-line-main"><span>计件工资</span><strong>${fmtMoney(data.piecePay)} 元</strong></div></div>
      <div class="salary-line"><div class="salary-line-main"><span>工资合计</span><strong>${fmtMoney(data.totalPay)} 元</strong></div></div>
    `;
    const entries = data.entries || [];
    $('salaryEntriesCount').textContent = `${entries.length} 笔`;
    $('salaryEntries').innerHTML = entries.length ? entries.map(salaryEntryCard).join('') : '<div class="card empty">当天没有计件记录</div>';
  }
  function renderSalaryMonth() {
    const data = salaryMonthData;
    if (!data) return;
    const rate = Number(data.employee?.hourlyRate || 0);
    const rateText = Number.isInteger(rate) ? String(rate) : rate.toFixed(2);
    const monthText = String(data.month || '').slice(0, 7);
    const monthApprovedCount = (data.days || []).reduce((sum, d) => sum + Number(d.approvedCount || 0), 0);
    const monthApprovedQty = (data.days || []).reduce((sum, d) => sum + Number(d.approvedQuantity || 0), 0);
    $('salarySummary').innerHTML = `<span>${esc(monthText)} 本月工资合计</span><strong>${fmtMoney(data.totalPay)} 元</strong><small>计时工资 ${fmtMoney(data.timerPay)} 元 + 已审核计件工资 ${fmtMoney(data.piecePay)} 元</small>`;
    $('salaryStatusHint').textContent = `共 ${(data.days || []).length} 天有记录`;
    $('salaryBreakdown').innerHTML = `
      <div class="salary-line"><div class="salary-line-main"><span>本月计时工时</span><strong>${Number(data.timerHours || 0).toFixed(2)} 小时</strong></div></div>
      <div class="salary-line"><div class="salary-line-main"><span>计时时薪</span><strong>${rateText}元/小时</strong></div></div>
      <div class="salary-line"><div class="salary-line-main"><span>本月计时工资</span><strong>${fmtMoney(data.timerPay)} 元</strong></div></div>
      <div class="salary-line"><div class="salary-line-main"><span>本月已审核计件</span><strong>${monthApprovedCount} 笔 · ${monthApprovedQty} 件</strong></div></div>
      <div class="salary-line"><div class="salary-line-main"><span>本月计件工资</span><strong>${fmtMoney(data.piecePay)} 元</strong></div></div>
      <div class="salary-line"><div class="salary-line-main"><span>本月工资合计</span><strong>${fmtMoney(data.totalPay)} 元</strong></div></div>
    `;
    const days = (data.days || []).filter((d) => Number(d.totalPay || 0) > 0 || Number(d.approvedCount || 0) > 0 || Number(d.timerMinutes || 0) > 0);
    $('salaryMonthDaysCount').textContent = days.length ? `${days.length} 天` : '';
    $('salaryMonthDays').innerHTML = days.length ? days.map((d) => {
      const dt = new Date(d.date + 'T00:00:00');
      const label = Number.isNaN(dt.getTime()) ? d.date : `${dt.getMonth() + 1}/${dt.getDate()} 周${'日一二三四五六'[dt.getDay()]}`;
      const brief = [];
      if (Number(d.timerMinutes || 0) > 0) brief.push(`计时 ${(Number(d.timerMinutes) / 60).toFixed(2)}h`);
      if (Number(d.approvedCount || 0) > 0) brief.push(`计件 ${Number(d.approvedCount)} 笔`);
      return `<div class="salary-line expandable" data-month-day="${esc(d.date)}" role="button" tabindex="0" aria-expanded="false">
        <div class="salary-line-main"><span>${esc(label)} · ${esc(brief.join(' · ') || '无记录')}</span><strong>${fmtMoney(d.totalPay)} 元</strong></div>
        <div class="salary-detail" data-detail-body="month-day"></div>
      </div>`;
    }).join('') : '<div class="empty" style="padding:18px 0">本月还没有工资记录</div>';
  }
  function buildMonthDayDetail(dateKey) {
    const day = ((salaryMonthData && salaryMonthData.days) || []).find((d) => String(d.date) === String(dateKey));
    if (!day) return salaryDetailShell('当天明细', '<div class="d-empty">找不到这天的记录</div>', '');
    const rows = (day.entries || []).filter((x) => x.status === 'approved');
    const body = rows.length ? rows.map((x, i) => `<div class="d-row"><span>${i + 1}. ${esc(x.material || '')} · ${esc(x.name || '')} · ${esc(x.process || '')}${x.variantLabel ? ' · ' + esc(x.variantLabel) : ''}</span><span class="d-tag">${Number(x.quantity)} 件</span></div>`).join('') : '<div class="d-empty">这一天没有已审核的计件</div>';
    const pieceTotal = rows.reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const pieceText = rows.length === 1
      ? `${fmtMoney(rows[0].unitPrice)} × ${Number(rows[0].quantity)} = ${fmtMoney(pieceTotal)} 元`
      : `合计 ${fmtMoney(pieceTotal)} 元`;
    const foot = `<div class="d-row"><span>计时 ${(Number(day.timerMinutes || 0) / 60).toFixed(2)} 小时</span><strong>${pieceText}</strong></div>
      <div class="d-row"><span>合计</span><strong>${fmtMoney(day.totalPay)} 元</strong></div>`;
    return salaryDetailShell('当天明细 · ' + esc(dateKey), body, foot);
  }
  function salaryDetailShell(title, rowsHtml, footHtml) {
    return `<div class="layer layer-1"><h4>${esc(title)}</h4></div>
      <div class="layer layer-2">${rowsHtml}</div>
      <div class="layer layer-3">${footHtml}</div>`;
  }
  async function buildTimeDetail() {
    const day = salaryDate || $('salaryDate').value;
    let data;
    try {
      data = await rpc('work_get_my_time_entries', { p_code:code, p_date:day });
    } catch (e) {
      return salaryDetailShell('当天计时明细', '<div class="d-empty">计时明细需要先执行一次 fix-work-time-entries-rpc.sql</div>', '');
    }
    const rows = (data && data.entries) || [];
    const mins = Number(data?.totalMinutes || 0);
    const normalMins = Number(data?.normalMinutes || 0);
    const overtimeMins = Number(data?.overtimeMinutes || 0);
    const body = rows.length ? rows.map((r) => {
      const note = `${r.overtimeConfirmed ? '<span class="d-tag">已确认加班</span>' : ''}${r.specialNote ? `<span class="d-tag">备注 ${esc(r.specialNote)}</span>` : ''}`;
      return `<div class="d-row"><span>${esc(fmtClock(r.startedAt))} → ${r.open ? '计时中' : esc(fmtClock(r.endedAt))}${note}</span><strong>${Number(r.minutes || 0)} 分钟</strong></div>`;
    }).join('') : '<div class="d-empty">这一天没有计时记录</div>';
    const foot = `<div class="d-row"><span>当天有效计时合计</span><strong>${(mins / 60).toFixed(2)} 小时</strong></div>
      <div class="d-row"><span>正常工时</span><strong>${(normalMins / 60).toFixed(2)} 小时</strong></div>
      ${overtimeMins > 0 ? `<div class="d-row"><span>加班工时</span><strong>${(overtimeMins / 60).toFixed(2)} 小时</strong></div>` : ''}`;
    return salaryDetailShell('当天计时明细 · ' + esc(day), body, foot);
  }
  function buildPieceDetail() {
    const all = (salaryData && salaryData.entries) || [];
    const rows = all.filter((x) => x.status === 'approved');
    const body = rows.length ? rows.map((x, i) => `<div class="d-row"><span>${i + 1}. ${esc(x.material || '')} · ${esc(x.name || '')} · ${esc(x.process || '')}${x.variantLabel ? ' · ' + esc(x.variantLabel) : ''}</span><span class="d-tag">${Number(x.quantity)} 件</span></div>`).join('') : '<div class="d-empty">这一天没有已审核的计件</div>';
    const total = rows.reduce((s, x) => s + Number(x.amount || 0), 0);
    const totalText = rows.length === 1
      ? `${fmtMoney(rows[0].unitPrice)} × ${Number(rows[0].quantity)} = ${fmtMoney(total)} 元`
      : `合计 ${fmtMoney(total)} 元`;
    const foot = `<div class="d-row"><span>已审核</span><strong>${totalText}</strong></div>`;
    return salaryDetailShell('当天计件明细 · ' + esc(salaryData?.date || ''), body, foot);
  }
  async function toggleSalaryDetail(line) {
    const key = line.dataset.salaryDetail || (line.dataset.monthDay ? 'month' : '');
    const monthDay = line.dataset.monthDay || '';
    const body = line.querySelector('[data-detail-body]');
    const isOpen = line.classList.contains('expanded');
    if (isOpen) {
      line.classList.remove('expanded');
      line.setAttribute('aria-expanded', 'false');
      return;
    }
    if (body && !body.dataset.filled) {
      body.innerHTML = monthDay
        ? buildMonthDayDetail(monthDay)
        : (key === 'time' ? await buildTimeDetail() : buildPieceDetail());
      body.dataset.filled = '1';
      // 先让内容以"未淡入"的状态渲染一帧，否则三层淡入会被跳过
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    line.classList.add('expanded');
    line.setAttribute('aria-expanded', 'true');
  }
  function bindSalaryBreakdown() {
    const box = $('salaryPanel');
    if (!box) return;
    box.addEventListener('click', (event) => {
      const line = event.target.closest('[data-salary-detail], [data-month-day]');
      if (line) toggleSalaryDetail(line).catch(() => {});
    });
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const line = event.target.closest('[data-salary-detail], [data-month-day]');
      if (!line) return;
      event.preventDefault();
      toggleSalaryDetail(line).catch(() => {});
    });
  }
    function tradeLabel(employee) {
    if (!employee) return '';
    const names = (state?.processes || []).map((p) => String(p.name || ''));
    const has = (kw) => names.some((n) => n.includes(kw));
    if (has('折弯') || has('弯管')) return '折弯';
    if (has('焊') || has('烧') || has('点圈') || has('拼头') || has('烧头')) return '焊接';
    if (employee.track === 'welding') return '焊接';
    if (employee.track === 'fixed') return profile?.salaryType === 'monthly' ? '固定月薪' : profile?.salaryType === 'management' ? '管理' : '固定日薪';
    return '后道';
  }
  function render() {
    show($('loginView'), !state); show($('mainView'), Boolean(state)); if (!state) return;
    $('employeeName').textContent = state.employee.name;
    $('employeeMeta').textContent = tradeLabel(state.employee);
    renderTime(); renderBetaSession(); renderPiece();
    // 工资面板按当前查看范围重绘，避免自动刷新时把"本月"覆盖成"当天"
    if (salaryRange === 'month') { if (salaryMonthData) renderSalaryMonth(); }
    else if (salaryData) renderSalary();
  }
  async function loadState() {
    const [nextState, submissions] = await Promise.all([
      rpc('work_get_state', { p_code: code }),
      rpc('work_get_my_submissions', { p_code: code, p_limit: 80 }).catch(() => []),
    ]);
    state = nextState;
    state.pieceEntries = (submissions || []).map((x) => ({
      id: x.id,
      workDate: x.workDate,
      status: x.status,
      sourceType: x.sourceType,
      productId: x.productId,
      processId: x.processId,
      material: x.submittedMaterial,
      name: x.submittedName,
      spec: x.submittedSpec,
      process: x.submittedProcessName,
      quantity: x.quantity,
      unitPrice: x.unitPrice,
      submittedUnitPrice: x.submittedUnitPrice,
      originalUnitPrice: x.originalUnitPrice,
      amount: x.amount,
      variantKey: x.variantKey,
      variantValue: x.variantValue,
      variantLabel: x.variantLabel,
      reviewNote: x.reviewNote,
      reviewedAt: x.reviewedAt,
      createdAt: x.createdAt,
      submittedAt: x.submittedAt,
      note: x.note,
      piecePeriodId: x.piecePeriodId,
    }));
    render();
  }
  // 网络类失败自动重试：弱网/家里 WiFi 不稳时，工人不用手动点，等一会儿自己就进来了
  let autoRetryTimer = null;
  let autoRetryCount = 0;
  function clearAutoRetry(message) {
    if (autoRetryTimer) { clearInterval(autoRetryTimer); autoRetryTimer = null; }
    autoRetryCount = 0;
  }
  function scheduleAutoRetry(value) {
    if (autoRetryTimer) return;
    autoRetryCount = 0;
    autoRetryTimer = setInterval(() => {
      autoRetryCount += 1;
      if (autoRetryCount > 10) { clearAutoRetry(); return; }
      if (autoRetryCount === 1) {
        show($('loginError'), true);
        $('loginError').textContent = '网络不太稳，正在自动重试，请稍等…（也可以点下面的按钮做网络自检）';
      }
      login(value, true).catch(() => {});
    }, 12000);
  }
  async function login(nextCode, isRetry) {
    const value = String(nextCode || '').trim(); if (!value) return;
    try {
      await rpc('work_login', { p_code:value });
      code = value; persistCode(code); betaStateLoaded = false; loadBetaSession();
      profile = await rpc('work_get_my_profile', { p_code:code }).catch(() => null);
      await loadState();
      applyProfileTabs();
      clearAutoRetry();
      show($('loginError'), false);
    } catch (e) {
      show($('loginError'), true);
      show($('networkCheckButton'), !e.noRetry);
      if ($('networkCheckResult')) $('networkCheckResult').classList.add('hidden');
      if (e.noRetry) {
        // 访问码不对之类的业务错误：直接说清楚，不重试
        clearAutoRetry();
        $('loginError').textContent = e.message || '登录失败';
      } else {
        // 网络问题：换成友好提示并自动重试，不显示技术错误
        $('loginError').textContent = '网络不太稳，正在自动重试，请稍等…（也可点下面的按钮做网络自检）';
        scheduleAutoRetry(value);
      }
    }
  }
  async function probeFetch(label, url, init = {}, timeoutMs = 8000) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
      return { label, ok: true, status: response.status, ms: Date.now() - started };
    } catch (error) {
      return { label, ok: false, ms: Date.now() - started, error: error?.name === 'AbortError' ? '超时' : (error?.message || '失败') };
    } finally { clearTimeout(timer); }
  }
  // 分段网络检测：① 页面服务 ② 接口域名(简单请求) ③ 登录接口(表单式 POST，无预检)
  async function checkNetworkConnectivity() {
    const button = $('networkCheckButton');
    const result = $('networkCheckResult');
    if (!button || !result) return;
    button.disabled = true;
    result.classList.remove('hidden');
    result.textContent = '正在分段检测网络…';
    const apiOrigin = new URL(window.WORK_RPC_BASE).origin;
    const steps = [];
    steps.push(await probeFetch('① 本页页面服务', location.href));
    steps.push(await probeFetch('② 接口域名（简单请求）', apiOrigin + '/rest/v1/?apikey=' + encodeURIComponent(window.WORK_ANON_KEY)));
    steps.push(await probeFetch('③ 登录接口（简单 POST，无预检）', `${window.WORK_RPC_BASE}/work_login?apikey=${encodeURIComponent(window.WORK_ANON_KEY)}`, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:'p_code=' + encodeURIComponent('__network_probe__') }));
    if (window.WORK_DIRECT_RPC_BASE && window.WORK_DIRECT_RPC_BASE !== window.WORK_RPC_BASE) {
      steps.push(await probeFetch('④ 备用直连线路', `${window.WORK_DIRECT_RPC_BASE}/work_login?apikey=${encodeURIComponent(window.WORK_ANON_KEY)}`, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:'p_code=' + encodeURIComponent('__network_probe__') }));
    }
    const lines = steps.map((s) => `${s.label}：${s.ok ? '✅ 通' : '❌ 不通'}（${s.ms}ms${s.ok ? `，HTTP ${s.status}` : `，${s.error}`}）`);
    const mainSteps = steps.filter((s) => !s.label.startsWith('④'));
    const directStep = steps.find((s) => s.label.startsWith('④'));
    let advice;
    if (steps.every((s) => s.ok)) advice = '线路都通：网络正常，请返回重新登录。';
    else if (!steps[0].ok) advice = '页面服务都不通：当前网络访问不了页面服务器，请切换 WiFi 或换网络后刷新。';
    else if (!steps[1].ok) advice = '页面能开、接口域名连不上：运营商线路问题，请切换 WiFi 或换用其他手机卡。';
    else if (mainSteps.every((s) => s.ok)) advice = '主线路正常，请返回重新登录。';
    else if (directStep && directStep.ok) advice = '主线路不通、备用直连线路是通的：系统会自动走备用线路，请返回重新登录。';
    else advice = '两条线路都不通：请把本页截图发给管理员。';
    result.innerHTML = lines.map((line) => `<div>${line}</div>`).join('') + `<div style="margin-top:6px;font-weight:800">${advice}</div>`;
    button.disabled = false;
  }
  function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function previousMonth() {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function applyProfileTabs() {
    const isPiece = !profile || profile.salaryType === 'hourly_piece';
    document.querySelectorAll('[data-piece-tab]').forEach((el) => el.classList.toggle('hidden', !isPiece));
    const monthInput = $('attendanceMonth');
    if (monthInput && !monthInput.value) monthInput.value = currentMonth();
    const payrollInput = $('payrollMonth');
    if (payrollInput && !payrollInput.value) payrollInput.value = currentMonth();
    if (!isPiece) {
      const att = document.querySelector('.tabs button[data-tab="attendance"]');
      if (att && !att.classList.contains('active')) att.click();
    }
  }
  const ATT_STATUS = { normal:'正常', late:'迟到', early_leave:'早退', missing_once:'漏刷1次', missing_overdue:'漏刷未补', absent:'没上班', manual:'人工判定', leave:'请假', reissued:'已补卡', working:'进行中' };
  function monthBounds(month) {
    const [y, m] = String(month).split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
  }
  async function loadMyAttendance() {
    if (!code) return;
    const month = $('attendanceMonth')?.value || currentMonth();
    const { from, to } = monthBounds(month);
    await rpc('attendance_refresh_overdue', {}).catch(() => {});
    attendanceData = await rpc('work_get_my_attendance', { p_code:code, p_from:from, p_to:to });
    renderMyAttendance(month);
    loadMyLeaves().catch(() => {});
  }
  function renderMyAttendance(month) {
    const days = attendanceData?.days || [];
    const n = (v) => Number(v || 0);
    const attendanceDays = days.filter((d) => d.status !== 'absent' && d.status !== 'manual').length;
    const absentDays = days.filter((d) => d.status === 'absent').length;
    const lateDays = days.filter((d) => d.isLate).length;
    const earlyDays = days.filter((d) => d.isEarlyLeave).length;
    const missingDays = days.filter((d) => d.status === 'missing_once').length;
    const overdueDays = days.filter((d) => d.status === 'missing_overdue').length;
    // 应出勤 = 有考勤记录的天数（休息日全厂无记录，自动排除）
    const shouldDays = attendanceDays + absentDays;
    const rate = shouldDays ? Math.round(attendanceDays / shouldDays * 1000) / 10 : 0;
    const otDays = days.filter((d) => n(d.overtimeMinutes) > 0).length;
    const otHours = Math.round(days.reduce((s, d) => s + n(d.overtimeMinutes), 0) / 60 * 10) / 10;
    const otAmount = days.reduce((s, d) => s + n(d.overtimeAmount), 0);
    $('attendanceSub').textContent = month;
    $('attendanceSummary').innerHTML = `<div class="att-grid">
      <div class="att-stat good"><span>出勤</span><strong>${attendanceDays} 天</strong></div>
      <div class="att-stat info"><span>出勤率</span><strong>${rate}%</strong><small>应出勤 ${shouldDays} 天</small></div>
      <div class="att-stat bad"><span>没上班</span><strong>${absentDays} 天</strong></div>
      <div class="att-stat warn"><span>迟到/早退</span><strong>${lateDays + earlyDays} 天</strong></div>
      <div class="att-stat warn"><span>漏刷1次</span><strong>${missingDays} 天</strong></div>
      ${overdueDays ? `<div class="att-stat bad"><span>漏刷未补</span><strong>${overdueDays} 天</strong></div>` : ''}
      <div class="att-stat info"><span>加班</span><strong>${otDays} 天</strong><small>${otHours} 小时${otAmount ? ' · ' + otAmount.toFixed(0) + ' 元' : ''}</small></div>
    </div>`;
    $('attendanceCount').textContent = `${days.length} 天`;
    const WEEK = ['周日','周一','周二','周三','周四','周五','周六'];
    $('attendanceList').innerHTML = days.length ? days.map((d) => {
      const tag = ATT_STATUS[d.status] || d.status || '--';
      const outRaw = d.checkOutRaw || d.checkOut || '';
      const outText = outRaw && d.shift === 'night' ? '次日 ' + outRaw : outRaw;
      const times = [d.checkInRaw || d.checkIn || '', outText].filter(Boolean).join(' / ') || '无打卡';
      const extra = n(d.overtimeMinutes) > 0 ? ` · 加班 ${Math.round(n(d.overtimeMinutes) / 60 * 10) / 10}h` : '';
      const wk = WEEK[new Date(d.workDate + 'T00:00:00').getDay()] || '';
      const cls = (d.status === 'absent' || d.status === 'missing_overdue') ? 'bad'
        : (d.status === 'late' || d.status === 'early_leave' || d.status === 'missing_once') ? 'abnormal' : 'good';
      let action = '';
      if (d.status === 'missing_once') {
        if (d.reissueStatus === 'submitted') action = '<span class="att-tag manual">补卡待审核</span>';
        else if (d.reissueStatus === 'approved') action = '<span class="att-tag normal">已补卡</span>';
        else if (d.reissueStatus === 'rejected') action = `<button class="att-reissue" type="button" data-reissue="${esc(d.workDate)}">重新补卡</button>`;
        else action = `<button class="att-reissue" type="button" data-reissue="${esc(d.workDate)}">补卡申请</button>`;
      }
      return `<div class="att-item ${cls}"><div><div class="d1">${esc(String(d.workDate || '').slice(5))}<span class="wk">${wk}</span></div><div class="d2">${esc(times)}${esc(extra)}</div>${d.note ? `<div class="d3">${esc(d.note)}</div>` : ''}</div><div class="att-right"><span class="att-tag ${esc(d.status || '')}">${esc(tag)}</span>${action}</div></div>`;
    }).join('') : '<div class="d-empty">这个月还没有考勤记录</div>';
    renderAttendanceToday();
    renderAttendanceTodo();
    renderAttendanceCalendar(month);
  }
  function todayValue() { return new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' }); }
  function renderAttendanceToday() {
    const box = $('attendanceToday'); if (!box) return;
    const today = todayValue();
    const WEEK = ['周日','周一','周二','周三','周四','周五','周六'];
    const label = `${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日 ${WEEK[new Date(today + 'T00:00:00').getDay()]}`;
    const day = (attendanceData?.days || []).find((d) => d.workDate === today);
    if (!day) {
      box.innerHTML = `<div class="att-hero-top"><span>今日考勤</span><span>${esc(label)}</span></div>
        <div class="att-hero-status"><span class="dot"></span>暂无打卡记录</div>
        <div class="att-hero-times"><div><span>签到</span><strong>--:--</strong></div><div class="arrow">→</div><div><span>签退</span><strong>--:--</strong></div></div>
        <div class="att-hero-foot">今天还没有打卡记录 · 没打卡记得提交补卡</div>`;
      return;
    }
    const st = day.status || '';
    const cls = (st === 'absent' || st === 'missing_overdue') ? 'bad' : (st === 'normal' || st === 'reissued' ? 'ok' : '');
    const hours = Math.round(n(day.overtimeMinutes) / 60 * 10) / 10;
    const shiftText = day.shift === 'night' ? '夜班' : (day.shift === 'manual' ? '人工判定' : '白班');
    const foot = [shiftText, hours > 0 ? `加班 ${hours} 小时` : ''].filter(Boolean).join(' · ');
    box.innerHTML = `<div class="att-hero-top"><span>今日考勤</span><span>${esc(label)}</span></div>
      <div class="att-hero-status ${cls}"><span class="dot"></span>${esc(ATT_STATUS[st] || st || '无记录')}</div>
      <div class="att-hero-times">
        <div><span>签到</span><strong>${esc(day.checkInRaw || day.checkIn || '--:--')}</strong></div>
        <div class="arrow">→</div>
        <div><span>签退</span><strong>${esc((day.shift === 'night' && (day.checkOutRaw || day.checkOut) ? '次日 ' : '') + (day.checkOutRaw || day.checkOut || '--:--'))}</strong></div>
      </div>
      <div class="att-hero-foot">${esc(foot)}</div>`;
  }
  function renderAttendanceTodo() {
    const box = $('attendanceTodo'); if (!box) return;
    const days = attendanceData?.days || [];
    const todo = days.filter((d) => d.status === 'missing_once' && !d.reissueStatus);
    const overdue = days.filter((d) => d.status === 'missing_overdue');
    if (!todo.length && !overdue.length) { show(box, false); return; }
    show(box, true);
    box.innerHTML = `<div class="att-sec-title" style="margin:0 0 4px"><strong>待办</strong><span>需要你处理</span></div>` +
      (todo.length ? `<div class="t-row"><span class="t-ico">补</span><div><div class="t-txt">待补卡 ${todo.length} 天</div><div class="t-sub">本月漏刷，请在下面明细里点“补卡申请”</div></div></div>` : '') +
      (overdue.length ? `<div class="t-row"><span class="t-ico">异</span><div><div class="t-txt">漏刷未补 ${overdue.length} 天</div><div class="t-sub">已跨月，请联系管理员处理</div></div></div>` : '');
  }
  function renderAttendanceCalendar(month) {
    const box = $('attendanceCalendar'); if (!box) return;
    const [y, m] = month.split('-').map(Number);
    const startWeek = new Date(y, m - 1, 1).getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const byDate = new Map((attendanceData?.days || []).map((d) => [d.workDate, d]));
    const heads = ['日','一','二','三','四','五','六'];
    const today = todayValue();
    let html = '<div class="att-cal">' + heads.map((h) => `<div class="cal-head">${h}</div>`).join('');
    for (let i = 0; i < startWeek; i += 1) html += '<div class="cal-day empty"></div>';
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${month}-${String(d).padStart(2, '0')}`;
      const row = byDate.get(key);
      const cls = [row ? (row.status || '') : '', key === today ? 'today' : ''].filter(Boolean).join(' ');
      html += `<div class="cal-day ${cls}"><span class="d">${d}</span>${row ? '<span class="p"></span>' : ''}</div>`;
    }
    html += '</div>';
    html += `<div class="att-legend">
      <span><i style="background:#0f766e"></i>正常</span>
      <span><i style="background:#e8871e"></i>迟到/早退</span>
      <span><i style="background:#d9a520"></i>漏刷1次</span>
      <span><i style="background:#c0392b"></i>异常/没上班</span>
      <span><i style="background:#3b5bdb"></i>请假</span>
      <span><i style="background:#8a999d"></i>人工判定</span>
    </div>`;
    box.innerHTML = html;
  }
  async function loadMyLeaves() {
    if (!code) return;
    rpc('work_get_my_leave_balances', { p_code:code }).then((b) => {
      if (!b || !b.balances) return;
      $('balanceYear').textContent = `${b.year} 年`;
      const withBal = b.balances.filter((x) => x.requiresBalance && Number(x.totalDays) > 0);
      $('attendanceBalances').innerHTML = withBal.length ? withBal.map((x) => {
        const total = Number(x.totalDays) || 0;
        const used = Number(x.usedDays) || 0;
        const pct = total ? Math.min(100, Math.round(used / total * 100)) : 0;
        return `<div class="att-bal"><div class="att-bal-top"><b>${esc(x.name)}</b><em>剩余 ${x.remainDays} 天 / 共 ${x.totalDays} 天</em></div><div class="att-bal-bar"><i style="width:${pct}%"></i></div></div>`;
      }).join('') : '<div class="d-empty">没有需要额度的假别（事假、病假不限额）</div>';
    }).catch(() => {});
    const month = $('attendanceMonth')?.value || currentMonth();
    const { from, to } = monthBounds(month);
    const data = await rpc('work_get_my_leaves', { p_code:code, p_from:from, p_to:to }).catch(() => ({ requests: [] }));
    const rows = data.requests || [];
    $('leaveCount').textContent = `${rows.length} 条`;
    $('attendanceLeaves').innerHTML = rows.length ? rows.map((r) => {
      const st = ({ submitted:'待审核', approved:'已通过', rejected:'已退回' })[r.status] || r.status;
      const cls = r.status === 'approved' ? 'good' : (r.status === 'rejected' ? 'bad' : 'abnormal');
      return `<div class="att-item ${cls}"><div><div class="d1">${esc(r.startDate)} ~ ${esc(r.endDate)}</div><div class="d2">${esc(r.leaveType)}${r.reason ? ' · ' + esc(r.reason) : ''}</div></div><span class="att-tag ${esc(r.status)}">${esc(st)}</span></div>`;
    }).join('') : '<div class="d-empty">本月没有请假记录</div>';
  }
  function openLeaveModal() {
    $('leaveFrom').value = $('leaveFrom').value || todayValue();
    $('leaveTo').value = $('leaveTo').value || todayValue();
    $('leaveReason').value = '';
    show($('leaveError'), false);
    show($('leaveModal'), true);
  }
  async function submitLeave() {
    const type = $('leaveType').value;
    const from = $('leaveFrom').value;
    const to = $('leaveTo').value;
    const reason = $('leaveReason').value.trim();
    if (!from || !to) { show($('leaveError'), true); $('leaveError').textContent = '请选择请假日期'; return; }
    if (!reason) { show($('leaveError'), true); $('leaveError').textContent = '请填写请假原因'; return; }
    const btn = $('leaveSubmit'); btn.disabled = true;
    try {
      await rpc('work_submit_leave', { p_code:code, p_type:type, p_from:from, p_to:to, p_reason:reason });
      show($('leaveModal'), false);
      toast('请假申请已提交，等待管理员审核');
      await loadMyLeaves();
    } catch (e) { show($('leaveError'), true); $('leaveError').textContent = e.message || '提交失败'; }
    finally { btn.disabled = false; }
  }
  function shiftMonthValue(value, delta) {
    const [y, m] = String(value || currentMonth()).split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function shiftMonthInput(inputId, delta) {
    const el = $(inputId);
    if (!el) return;
    const v = el.value || previousMonth();
    const [y, m] = v.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    el.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  async function loadMyPayroll() {
    if (!code) return;
    const params = { p_code: code, p_mode: payrollRange, p_value: null };
    if (payrollRange === 'month') {
      if (!$('payrollMonth').value) $('payrollMonth').value = previousMonth();
      params.p_value = $('payrollMonth').value + '-01';
    } else {
      if (!$('payrollDate').value) $('payrollDate').value = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' });
      params.p_value = $('payrollDate').value;
    }
    payrollData = await rpc('work_get_my_payroll', params);
    renderMyPayroll();
  }
  function renderMyPayroll() {
    const d = payrollData || {};
    const n = (v) => Number(v || 0);
    const money = (v) => (v === null || v === undefined) ? '--' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' 元';
    const hours = (m) => Math.round(n(m) / 60 * 10) / 10;
    $('payrollHero').innerHTML = `<span>${esc(d.label || '')} 工资合计</span><strong>${money(d.totalPay)}</strong><small>${esc(d.note || '')}</small>`;
    const rows = [];
    if (d.salaryType === 'daily') {
      rows.push(['出勤', `${n(d.attendanceDays)} 天`]);
      rows.push(['日工资', money(d.dailySalary)]);
      rows.push(['基本工资', money(d.basePay)]);
      if (d.mode === 'month') {
        rows.push(['没上班', `${n(d.absentDays)} 天`]);
        rows.push(['加班', `${n(d.overtimeDays)} 天 · ${hours(d.overtimeMinutes)} 小时`]);
      } else {
        rows.push(['当天加班', `${hours(d.overtimeMinutes)} 小时`]);
      }
      rows.push(['加班费', money(d.overtimeAmount)]);
    } else if (d.salaryType === 'monthly') {
      rows.push(['月薪', money(d.monthlySalary)]);
      if (d.mode === 'month') rows.push(['出勤', `${n(d.attendanceDays)} 天`]);
    } else {
      rows.push(['说明', d.note || '']);
    }
    $('payrollBreakdown').innerHTML = rows.map(([k, v]) => `<div class="salary-line"><div class="salary-line-main"><span>${esc(k)}</span><strong>${esc(String(v))}</strong></div></div>`).join('');
    const showMonth = d.mode === 'month';
    show($('payrollMonthTitle'), showMonth);
    show($('payrollMonthDays'), showMonth);
    if (showMonth) {
      const days = d.days || [];
      $('payrollMonthCount').textContent = `${days.length} 天`;
      $('payrollMonthDays').innerHTML = days.length ? days.map((x) => `<div class="att-item"><div><div class="d1">${esc(String(x.workDate || '').slice(5))}</div><div class="d2">${esc([x.checkInRaw || x.checkIn || '', x.checkOutRaw || x.checkOut || ''].filter(Boolean).join(' / ') || '无打卡')}${n(x.overtimeMinutes) > 0 ? ' · 加班 ' + hours(x.overtimeMinutes) + 'h' : ''}</div></div><span class="att-tag ${esc(x.status || '')}">${esc(ATT_STATUS[x.status] || x.status || '')}</span></div>`).join('') : '<div class="d-empty">这个月还没有记录</div>';
    }
  }
  let reissueDay = null;
  function openReissueModal(workDate) {
    const day = (attendanceData?.days || []).find((d) => d.workDate === workDate);
    if (!day) return;
    reissueDay = day;
    const slot = !day.checkIn ? 'check_in' : 'check_out';
    const slotText = slot === 'check_in' ? '签到' : '签退';
    $('reissueInfo').textContent = `${workDate} · 漏刷${slotText}，请填写补卡时间和原因`;
    $('reissueTime').value = slot === 'check_in' ? '07:30' : '17:00';
    $('reissueReason').value = '';
    show($('reissueError'), false);
    show($('reissueModal'), true);
  }
  function closeReissueModal() { show($('reissueModal'), false); reissueDay = null; }
  async function submitReissue() {
    if (!reissueDay) return;
    const slot = !reissueDay.checkIn ? 'check_in' : 'check_out';
    const time = $('reissueTime').value;
    const reason = $('reissueReason').value.trim();
    if (!time) { show($('reissueError'), true); $('reissueError').textContent = '请填写补卡时间'; return; }
    if (!reason) { show($('reissueError'), true); $('reissueError').textContent = '请填写补卡原因'; return; }
    const btn = $('reissueSubmit'); btn.disabled = true;
    try {
      await rpc('work_submit_reissue', { p_code:code, p_date:reissueDay.workDate, p_slot:slot, p_time:time, p_reason:reason });
      closeReissueModal();
      toast('补卡申请已提交，等待管理员审核');
      await loadMyAttendance();
    } catch (e) { show($('reissueError'), true); $('reissueError').textContent = e.message || '提交失败'; }
    finally { btn.disabled = false; }
  }
  let pendingSpecialEntry = '';
  let specialPreviewReady = false;
  function updateSpecialConfirmAction() {
    const btn = $('specialTimeConfirm');
    if (!btn) return;
    const overtime = Boolean($('specialTimeOvertime')?.checked);
    btn.textContent = specialPreviewReady ? '确认工时' : (overtime ? '下一步' : '确认不加班');
  }
  function resetSpecialConfirm() {
    specialPreviewReady = false;
    if ($('specialTimeOvertime')) $('specialTimeOvertime').checked = false;
    if ($('specialTimeNote')) $('specialTimeNote').value = '';
    show($('specialTimePreview'), false);
    updateSpecialConfirmAction();
  }
  function renderSpecialPanel() {
    const panel = $('specialTimePanel');
    if (!panel) return;
    if (!pendingSpecialEntry) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
  }
  function playClockMorph(btn) {
    btn.classList.remove('clock-stop');
    btn.classList.add('is-loading');
    // 先收成圆形，再走环形进度
    setTimeout(() => btn.classList.add('is-ring-run'), 480);
  }
  // 开始计时成功后：先变 ✓ 再过渡到"计时中"，避免界面硬跳
  function finishStartMorph(btn) {
    const startedAt = state?.activeEntry?.startedAt || new Date().toISOString();
    btn.classList.add('is-success');
    setTimeout(() => {
      const result = btn.querySelector('.ca-result');
      if (result) result.textContent = `已开始 · ${fmtClock(startedAt)}`;
      btn.classList.add('is-result');
    }, 620);
    setTimeout(() => {
      btn.classList.remove('is-loading', 'is-ring-run', 'is-success', 'is-result');
      btn.classList.add('clock-stop');
      const label = btn.querySelector('.ca-text');
      if (label) label.textContent = '结束本次计时';
      btn.disabled = false;
    }, 2100);
  }
  // 卡片与顶部横幅的入场动画（只在刚从"未计时"切到"计时中"时播一次）
  function markJustStarted() {
    const card = $('normalClockCard');
    const banner = $('activeTimerBanner');
    if (card) {
      card.classList.remove('just-started');
      void card.offsetWidth;
      card.classList.add('just-started');
      setTimeout(() => card.classList.remove('just-started'), 1400);
    }
    if (banner) {
      banner.classList.remove('is-enter');
      void banner.offsetWidth;
      banner.classList.add('is-enter');
      setTimeout(() => banner.classList.remove('is-enter'), 800);
    }
  }
  function finishClockMorph(btn, text) {
    btn.classList.add('is-success');
    setTimeout(() => {
      const result = btn.querySelector('.ca-result');
      if (result) result.textContent = text;
      btn.classList.add('is-result');
    }, 640);
    setTimeout(() => {
      btn.classList.remove('is-loading','is-ring-run','is-success','is-result');
      btn.classList.add('clock-stop');
      const label = btn.querySelector('.ca-text');
      if (label) label.textContent = '开始计时';
      btn.disabled = false;
    }, 2800);
  }
  function resetClockMorph(btn) {
    btn.classList.remove('is-loading','is-ring-run','is-success','is-result');
    const label = btn.querySelector('.ca-text');
    if (label) label.textContent = state?.activeEntry ? '结束本次计时' : '开始计时';
    btn.classList.toggle('clock-stop', Boolean(state?.activeEntry));
    btn.disabled = false;
  }
  let clockLockUntil = 0;
  async function clockAction() {
    const btn = $('clockAction');
    if (Date.now() < clockLockUntil) { toast('刚刚已开始计时，请稍候再操作'); return; }
    if (state?.activeEntry) { openClockStopConfirm(); return; }
    await runClockAction(false);
  }
  function openClockStopConfirm() {
    const detail = $('clockStopDetail');
    if (detail) {
      const started = state?.activeEntry?.startedAt;
      const elapsed = currentElapsedText();
      detail.textContent = started
        ? `开始时间 ${fmtClock(started)}，已计时 ${elapsed}。结束后如需继续工作，要重新点“开始计时”。`
        : '结束后如需继续工作，要重新点“开始计时”。';
    }
    show($('clockStopModal'), true);
  }
  function closeClockStopConfirm() { show($('clockStopModal'), false); }
  async function runClockAction(active) {
    const btn = $('clockAction');
    btn.disabled = true;
    playClockMorph(btn);
    try {
      let result;
      try {
        result = await rpc(active ? 'work_stop_timer' : 'work_start_timer', { p_code:code });
      } catch (stopError) {
        if (!active) throw stopError;
        result = await rpc('work_stop_timer', { p_code:code });
      }
      await loadState();
      if (active && result && result.needConfirm) {
        pendingSpecialEntry = result.id || '';
        const clock = (v) => fmtClock(v);
        $('specialTimeHint').textContent = result.capped
          ? `实际结束 ${clock(result.rawEndedAt)}，超过 20:30 的部分按 20:30 计入。不勾选只计正常 9 小时。`
          : `实际结束 ${clock(result.rawEndedAt)}。勾选“确认加班”后，17:00 后工时计入并扣晚餐 30 分钟；不勾选只计正常 9 小时。`;
        resetSpecialConfirm();
        renderSpecialPanel();
        toast('请确认是否加班');
      } else if (active && result && result.overtimeConfirmed) {
        pendingSpecialEntry = '';
        renderSpecialPanel();
        toast('本次计时已结束（已确认加班）');
      } else if (active && result && result.deleted) {
        pendingSpecialEntry = '';
        renderSpecialPanel();
        toast('不足1分钟，本次计时已自动取消');
      } else {
        pendingSpecialEntry = '';
        renderSpecialPanel();
        toast(active ? '本次计时已结束' : '计时已开始，页面已切换为橙色计时状态');
      }
      if (active) {
        const clock = (v) => fmtClock(v);
        const text = result && result.deleted
          ? '已取消 · 不足1分钟'
          : result && result.capped
          ? `已结束 · 按 ${clock(result.endedAt)} 计`
          : result && result.endedAt ? `已结束 · ${clock(result.endedAt)}` : '本次计时已结束';
        finishClockMorph(btn, text);
      } else {
        clockLockUntil = Date.now() + 4000;
        finishStartMorph(btn);
        markJustStarted();
        navigator.vibrate?.(120);
      }
    } catch (e) {
      resetClockMorph(btn);
      toast(e.message || '操作失败');
    }
  }
  let qtyEditId = '';
  function findPieceEntry(id) {
    const pools = [state?.pieceEntries || [], (salaryData && salaryData.entries) || []];
    for (const pool of pools) {
      const hit = pool.find((x) => String(x.id) === String(id));
      if (hit) return hit;
    }
    return null;
  }
  function openQtyModal(id) {
    const entry = findPieceEntry(id);
    if (!entry) { toast('找不到这条报工记录'); return; }
    qtyEditId = String(entry.id);
    const label = [entry.material || entry.submittedMaterial || '', entry.name || entry.submittedName || '', entry.process || entry.submittedProcessName || ''].filter(Boolean).join(' · ');
    const $info = $('qtyModalInfo');
    if ($info) $info.textContent = label;
    $('qtyModalInput').value = String(Number(entry.quantity));
    show($('qtyModalError'), false);
    show($('qtyModal'), true);
    $('qtyModalInput').focus();
    $('qtyModalInput').select();
  }
  function closeQtyModal() {
    qtyEditId = '';
    show($('qtyModal'), false);
  }
  async function saveQtyModal() {
    if (!qtyEditId) return;
    const value = Number($('qtyModalInput').value);
    if (!Number.isInteger(value) || value <= 0) { show($('qtyModalError'), true); $('qtyModalError').textContent = '数量必须是大于 0 的整数'; return; }
    const btn = $('qtyModalSave');
    btn.disabled = true;
    try {
      const result = await rpc('work_update_my_piece', { p_code:code, p_id:qtyEditId, p_payload:{ quantity:value, reason:'员工修改数量' } });
      if (!result || result.ok === false) throw new Error(result?.message || '修改失败');
      closeQtyModal();
      await loadState();
      if (salaryData) { salaryData = await rpc('work_get_my_salary_day', { p_code:code, p_date:salaryDate }).catch(() => salaryData); }
      toast('数量已修改，等待管理员重新审核');
    } catch (e) {
      show($('qtyModalError'), true);
      $('qtyModalError').textContent = e.message || '修改失败';
    } finally {
      btn.disabled = false;
    }
  }
  async function resubmitPiece(id) {
    const entry = findPieceEntry(id);
    if (!entry) { toast('找不到这条报工记录'); return; }
    if (!window.confirm('按原记录内容重新申报这条计件？\n品名、料号、工序、数量、单价都保持不变。')) return;
    try {
      const result = await rpc('work_resubmit_piece', { p_code:code, p_id:id });
      if (!result || result.ok === false) throw new Error(result?.message || '重新申报失败');
      await loadState();
      if (salaryData) salaryData = await rpc('work_get_my_salary_day', { p_code:code, p_date:salaryDate }).catch(() => salaryData);
      toast(result.noReview ? '已重新申报并生效（无需再审核）' : '已重新申报，等待管理员审核');
      render();
    } catch (e) {
      // 数据库还没执行 fix-work-resubmit.sql 时，退回原来的表单
      if (/function|does not exist|schema cache/i.test(e.message || '')) { openEditPiece(id); return; }
      toast(e.message || '重新申报失败');
    }
  }
  async function confirmSpecialTime() {
    if (!pendingSpecialEntry) return;
    const note = $('specialTimeNote').value.trim();
    const overtime = Boolean($('specialTimeOvertime')?.checked);
    const btn = $('specialTimeConfirm'); btn.disabled = true;
    try {
      if (overtime && !specialPreviewReady) {
        const preview = await rpc('work_preview_overtime', { p_code:code, p_entry_id:pendingSpecialEntry });
        const normalHours = Number(preview.normalMinutes || 0) / 60;
        const overtimeHours = Number(preview.overtimeMinutes || 0) / 60;
        const totalHours = normalHours + overtimeHours;
        const normalPay = Number(preview.normalPay || 0);
        const overtimePay = Number(preview.overtimePay || 0);
        $('specialTimePreview').innerHTML = `本次将计入：正常 ${normalHours.toFixed(2)} 小时 + 加班 ${overtimeHours.toFixed(2)} 小时 = 合计 ${totalHours.toFixed(2)} 小时。<br>预计计时工资：正常 ${fmtMoney(normalPay)} 元 + 加班 ${fmtMoney(overtimePay)} 元（${Number(preview.overtimeHourlyRate || 0).toFixed(2)} 元/小时）= ${fmtMoney(normalPay + overtimePay)} 元。`;
        show($('specialTimePreview'), true);
        specialPreviewReady = true;
        updateSpecialConfirmAction();
        return;
      }
      await rpc('work_confirm_special_time', { p_code:code, p_entry_id:pendingSpecialEntry, p_note:note, p_overtime:overtime });
      pendingSpecialEntry = '';
      resetSpecialConfirm();
      renderSpecialPanel();
      await loadState();
      toast(overtime ? '已确认加班，工时和加班工资已计入' : '已确认不加班，只计正常 9 小时');
    } catch (e) { toast(e.message || '确认失败'); } finally { btn.disabled = false; }
  }
  const EMPLOYEE_SEARCH_ALIASES = { '11': { '001':'001','002':'002','003':'003','004':'004' }, '16': { '001':'N16-001','002':'N16-002' } };
  async function searchProducts() {
    const token = ++productSearchToken;
    const q = $('productSearch').value.trim(); const box = $('productSuggest');
    if (!q) { show(box,false); show($('newPieceButton'), true); return; }
    try {
      const employeeNo = String(state?.employee?.employeeNo || '');
      const employeeAliases = EMPLOYEE_SEARCH_ALIASES[employeeNo] || {};
      const aliasMaterial = employeeAliases[q] || '';
      const aliasLabel = aliasMaterial ? q : '';
      const shortNumericSearch = !aliasMaterial && /^\d{1,3}$/.test(q);
      if (shortNumericSearch) {
        box.innerHTML = '<button type="button" disabled><strong>请输入至少4位编号</strong><span>或输入完整料号、产品名称</span></button>';
        show(box, true);
        show($('newPieceButton'), false);
        return;
      }
      const rows = await rpc('work_search_products', { p_code:code, p_query:aliasMaterial || q });
      if (token !== productSearchToken) return;
      let orderedRows = Array.isArray(rows) ? rows.slice() : [];
      if (aliasMaterial) orderedRows = orderedRows.filter((p) => p.material === aliasMaterial);
      const displayLabel = aliasLabel;
      const priorityMaterial = aliasMaterial || (!['11','06','20'].includes(employeeNo) && q.includes('攻丝') ? 'NC-0019' : '');
      orderedRows.sort((a,b) => priorityMaterial && a.material !== b.material ? (a.material === priorityMaterial ? -1 : b.material === priorityMaterial ? 1 : 0) : 0);
      box.innerHTML = orderedRows.length ? orderedRows.map((p) => `<button type="button" data-product="${esc(p.id)}" data-material="${esc(displayLabel || p.material)}" data-name="${esc(p.name)}" data-spec="${esc(p.spec)}"><strong>${esc(displayLabel || p.material)} · ${esc(p.name)}</strong></button>`).join('') : '<button type="button" data-open-custom="1"><strong>没有找到产品</strong><span>点这里自主申报新产品</span></button>';
      show(box,true);
      show($('newPieceButton'), orderedRows.length === 0);
    } catch (e) { if (token !== productSearchToken) return; toast(e.message || '搜索失败'); }
  }
function variantDisplay(processName, value) {
    const v = Number(value || 0);
    if (['折弯','梁配件折弯','短梁折边','长梁折边'].includes(processName)) return `${v}刀`;
    if (processName === '弯管') return `${v}道`;
    if (processName === '剪板') return `${v}mm`;
    return `${v}孔`;
  }
  async function submitPiece() {
    if (SESSION_BETA && betaSession?.mode !== 'piece') return toast('请先开始计件工作');
    if (state?.activeEntry) return toast('正在计时，结束后才能申报计件');
    if (!selectedProduct) { showPieceFormError('请先搜索并选择产品'); $('productSearch').focus(); return; }
    if (!selectedProcessId) { showPieceFormError('请选择工序'); return; }
    const process = currentProcess();
    const config = process ? PROCESS_VARIANTS[process.name] : null;
    let variant = { key:'', value:0, label:'' };
    if (config) {
      if (config.type === 'select') {
        const value = Number(selectedVariant?.value || 0);
        if (!value) { showPieceFormError('请选择' + config.label); return; }
        variant = { key:config.key, value, label:variantDisplay(process.name, value) };
      } else {
        const value = Number($('variantValue')?.value || 0);
        if (!Number.isInteger(value) || value <= 0) { showPieceFormError('请填写' + config.label); return; }
        variant = { key:config.key, value, label:variantDisplay(process.name, value) };
      }
    }
    const qty = Number($('pieceQty').value);
    if (!Number.isInteger(qty) || qty <= 0) { showPieceFormError('数量必须是大于 0 的整数'); $('pieceQty').focus(); return; }
    showPieceFormError('');
    const btn = $('pieceSubmit'); btn.disabled = true;
    try {
      await rpc('work_add_piece_entry', {
        p_code:code,
        p_product_id:selectedProduct.id,
        p_process_id:selectedProcessId,
        p_quantity:qty,
        p_note:$('pieceNote').value.trim(),
        p_variant_key:variant.key,
        p_variant_value:variant.value,
        p_variant_label:variant.label,
      });
      $('pieceQty').value = ''; $('pieceNote').value = '';
      selectedProcessId = ''; selectedProduct = null; selectedVariant = null;
      await loadState();
      toast('计件已提交');
    } catch (e) { const message = e.message || '提交失败'; toast(message); showPieceFormError(message); } finally { updatePieceSubmitState(); }
  }

  function setRequestError(message) {
    const box = $('requestError');
    box.textContent = message || '';
    show(box, Boolean(message));
  }
  function currentRequestProcess() {
    const raw = String($('requestProcess').value || '').trim();
    if (!raw) return null;
    if (raw.startsWith('custom:')) return { id:null, name:raw.slice(7), custom:true };
    const rows = state?.processes || [];
    return rows.find((p) => p.id === raw)
      || rows.find((p) => p.name === raw)
      || { id:null, name:raw, custom:true };
  }
  function requestVariantConfig(process) {
    return process ? PROCESS_VARIANTS[process.name] : null;
  }
  function populateRequestProcesses(selectedId = '', fallbackName = '') {
    const rows = state?.processes || [];
    const selected = rows.find((p) => p.id === selectedId) || rows.find((p) => p.name === fallbackName);
    const input = $('requestProcess');
    input.value = selected ? selected.name : (fallbackName || '');
    const list = $('requestProcessList');
    if (list) list.innerHTML = rows.map((p) => `<option value="${esc(p.name)}" data-id="${esc(p.id)}"></option>`).join('');
  }
  function requestVariant() {
    const process = currentRequestProcess();
    const config = requestVariantConfig(process);
    if (!config) return { key:'', value:0, label:'' };
    const raw = $('requestVariantValue').value;
    const value = raw === 'custom'
      ? Math.floor(Number($('requestVariantCustom')?.value || 0))
      : Number(raw || 0);
    return { key:config.key, value, label:value > 0 ? variantDisplay(process.name, value) : '' };
  }
  function renderRequestVariant(keepValue = false) {
    const process = currentRequestProcess();
    const config = requestVariantConfig(process);
    const wrap = $('requestVariantWrap');
    const input = $('requestVariantValue');
    if (!config) {
      input.value = '';
      show(wrap, false);
      return;
    }
    $('requestVariantLabel').textContent = config.label;
    const currentValue = Number(keepValue ? (selectedVariant?.value || editEntry?.variantValue || 0) : 0);
    const fixed = fixedVariantValues(process.id);
    const values = fixed.length ? [...fixed] : [...config.options];
    if (currentValue > 0 && !values.includes(currentValue)) values.push(currentValue);
    input.innerHTML = '<option value="">请选择</option>'
      + values.map((value) => `<option value="${value}">${variantDisplay(process.name, value)}</option>`).join('')
      + (allowCustomForProcess(process, requestProduct || selectedProduct) ? '<option value="custom">自己填写</option>' : '');
    show(wrap, true);
    const customWrap = $('requestVariantCustomWrap');
    const customInput = $('requestVariantCustom');
    const isCustomValue = currentValue > 0 && !values.includes(currentValue);
    if (isCustomValue) {
      input.value = 'custom';
      if (customInput) customInput.value = String(currentValue);
      if ($('requestVariantCustomLabel')) $('requestVariantCustomLabel').textContent = `自己填写${config.label.replace(/^(攻丝|折弯|弯管)/, '')}`;
      show(customWrap, true);
    } else {
      input.value = currentValue > 0 ? String(currentValue) : '';
      if (customInput) customInput.value = '';
      show(customWrap, false);
    }
  }
  function updateRequestSuggestedPrice(force = false) {
    const process = currentRequestProcess();
    const config = requestVariantConfig(process);
    const input = $('requestPrice');
    let suggestion = null;
    if (process && config && (['折弯','梁配件折弯','短梁折边','长梁折边'].includes(process.name) || process.name === '攻丝')) {
      const raw = $('requestVariantValue').value;
      const value = raw === 'custom' ? Math.floor(Number($('requestVariantCustom')?.value || 0)) : Number(raw || 0);
      if (value > 0) suggestion = Number((value * 0.2).toFixed(2));
    }
    const canReplace = !input.value || (requestAutoPrice != null && Number(input.value) === Number(requestAutoPrice));
    if (force) input.value = suggestion == null ? '' : suggestion.toFixed(2);
    else if (suggestion != null && canReplace) input.value = suggestion.toFixed(2);
    requestAutoPrice = suggestion;
  }
  async function loadCatalogPriceForRequest() {
    if (requestMode !== 'price_change' || !requestProduct) return;
    const process = currentRequestProcess();
    if (!process) return;
    const variant = requestVariant();
    if (variant.value < 0) return;
    try {
      const result = await rpc('work_get_catalog_price', {
        p_code:code,
        p_product_id:requestProduct.id,
        p_process_id:process.id,
        p_variant_key:variant.key,
        p_variant_value:variant.value,
      });
      if (result?.unitPrice != null) {
        const value = Number(result.unitPrice);
        $('requestPrice').value = value.toFixed(2);
        requestAutoPrice = value;
      }
    } catch {}
  }
  function setRequestMaterialHint(text) {
    const hint = $('requestMaterialHint');
    if (hint) {
      hint.textContent = text || '';
      hint.hidden = !text;
    }
  }
  function fillRequestProduct(product, source = 'system') {
    if (!product) return;
    $('requestMaterial').value = product.material || '';
    if (!$('requestName').value.trim()) $('requestName').value = product.name || '';
    const specEl = $('requestSpec');
    if (specEl && !specEl.value.trim()) specEl.value = product.spec || '';
    setRequestMaterialHint(`已匹配系统产品：${product.material || ''} · ${product.name || ''}${source === 'user' ? '' : '（已自动带出完整料号和品名）'}`);
    show($('requestMaterialMatches'), false);
  }
  function renderRequestMaterialMatches(rows) {
    const box = $('requestMaterialMatches');
    box.innerHTML = rows.map((p) => `<button type="button" data-request-product="${esc(p.id)}" data-material="${esc(displayLabel || p.material)}" data-name="${esc(p.name)}" data-spec="${esc(p.spec)}"><strong>${esc(p.material)} · ${esc(p.name || '（无品名）')}</strong><span>${esc(p.spec || '无图号')}</span></button>`).join('');
    show(box, rows.length > 0);
  }
  async function lookupRequestMaterial() {
    const input = $('requestMaterial');
    const query = input.value.trim();
    const box = $('requestMaterialMatches');
    const token = ++requestMaterialToken;
    if (query.length < 4) {
      show(box, false);
      setRequestMaterialHint('');
      return;
    }
    try {
      const rows = await rpc('work_search_products', { p_code:code, p_query:query });
      if (token !== requestMaterialToken) return;
      const digits = query.replace(/\D/g, '');
      const exact = rows.filter((p) => String(p.material || '') === query);
      const suffix = digits.length >= 4 ? rows.filter((p) => String(p.material || '').replace(/\D/g, '').endsWith(digits)) : [];
      const matches = exact.length ? exact : suffix;
      if (matches.length === 1) {
        fillRequestProduct(matches[0]);
        return;
      }
      if (matches.length > 1) {
        setRequestMaterialHint('系统找到多个可能产品，请点选正确项或填写更完整的料件编号。');
        renderRequestMaterialMatches(matches);
        return;
      }
      show(box, false);
      setRequestMaterialHint('系统未找到对应产品，将按新料件提交，管理员后续补全。');
    } catch (e) {
      if (token !== requestMaterialToken) return;
      show(box, false);
      setRequestMaterialHint('暂时无法查询产品库，可继续填写并按新料件提交。');
    }
  }
  function scheduleRequestMaterialLookup() {
    clearTimeout(requestMaterialTimer);
    requestMaterialToken += 1;
    requestMaterialTimer = setTimeout(lookupRequestMaterial, 280);
  }

  function openCustomRequest(prefillProduct = false) {
    requestMode = 'custom';
    requestProduct = null;
    editEntry = null;
    requestAutoPrice = null;
    $('requestTitle').textContent = '自主申报新产品';
    $('requestSubtitle').textContent = '产品或单价不在目录中，请填写后提交管理员审核。';
    show($('requestNameWrap'), true);
    show($('requestMaterialWrap'), true);
    /* 规格字段已移除 */
    show($('requestProcessWrap'), true);
    show($('requestProductSummary'), false);
    $('requestProcess').disabled = false;
    $('requestName').value = prefillProduct && selectedProduct ? (selectedProduct.name || '') : '';
    $('requestMaterial').value = prefillProduct && selectedProduct ? (selectedProduct.material || '') : '';
    if ($('requestSpec')) $('requestSpec').value = prefillProduct && selectedProduct ? (selectedProduct.spec || '') : '';
    $('requestOtherProcess').value = '';
    requestMaterialToken += 1;
    clearTimeout(requestMaterialTimer);
    show($('requestMaterialMatches'), false);
    setRequestMaterialHint('');
    $('requestQty').value = '';
    $('requestPrice').value = '';
    $('requestNote').value = '';
    populateRequestProcesses(selectedProcessId || '');
    $('requestProcess').dispatchEvent(new Event('change'));
    setRequestError('');
    show($('requestModal'), true);
  }
  async function openPriceChangeRequest() {
    if (!selectedProduct) return toast('请先搜索并选择产品');
    if (!selectedProcessId) return toast('请先选择工序');
    requestMode = 'price_change';
    requestProduct = selectedProduct;
    editEntry = null;
    requestAutoPrice = null;
    $('requestTitle').textContent = '申请修改单价';
    $('requestSubtitle').textContent = '原单价继续有效，审核通过后才会使用新单价。';
    show($('requestNameWrap'), false);
    show($('requestMaterialWrap'), false);
    /* 规格字段已移除 */
    show($('requestProcessWrap'), true);
    show($('requestProductSummary'), true);
    $('requestProductSummary').innerHTML = `<strong>${esc(selectedProduct.material)} · ${esc(selectedProduct.name)}</strong><br>${esc(selectedProduct.spec || '无图号')}`;
    populateRequestProcesses(selectedProcessId);
    $('requestProcess').disabled = false;
    $('requestOtherProcess').value = '';
    $('requestQty').value = '';
    $('requestPrice').value = '';
    $('requestNote').value = '';
    renderRequestVariant(true);
    setRequestError('');
    show($('requestModal'), true);
    await loadCatalogPriceForRequest();
  }
  function openEditPiece(id) {
    const entry = (state?.pieceEntries || []).find((x) => x.id === id);
    if (!entry) return toast('找不到这条计件记录');
    editEntry = entry;
    requestMode = 'edit';
    requestProduct = entry.productId ? { id:entry.productId, material:entry.material || '', name:entry.name || '', spec:entry.spec || '' } : null;
    requestAutoPrice = entry.submittedUnitPrice ?? entry.unitPrice ?? null;
    $('requestTitle').textContent = entry.status === 'revoked' ? '重新申报计件' : '修改计件申报';
    $('requestSubtitle').textContent = entry.status === 'approved' ? '修改后会撤回原记录，并生成一条新的待审核记录。' : '修改后重新提交管理员审核。';
    show($('requestNameWrap'), true);
    show($('requestMaterialWrap'), true);
    /* 规格字段已移除 */
    show($('requestProcessWrap'), true);
    show($('requestProductSummary'), false);
    $('requestProcess').disabled = false;
    $('requestName').value = entry.name || '';
    $('requestMaterial').value = entry.material || '';
    if ($('requestSpec')) $('requestSpec').value = entry.spec || '';
    $('requestOtherProcess').value = '';
    $('requestQty').value = entry.quantity ?? '';
    $('requestPrice').value = Number(entry.submittedUnitPrice ?? entry.unitPrice ?? '').toFixed(2);
    $('requestNote').value = entry.note || '';
    selectedVariant = entry.variantValue > 0 ? { value:Number(entry.variantValue), label:entry.variantLabel || String(entry.variantValue) } : null;
    populateRequestProcesses(entry.processId || '', entry.process || '');
    $('requestProcess').dispatchEvent(new Event('change'));
    if (entry.variantKey) $('requestVariantValue').value = String(entry.variantValue || '');
    setRequestError('');
    show($('requestModal'), true);
  }
  function closeRequestModal() {
    show($('requestModal'), false);
    setRequestError('');
    $('requestProcess').disabled = false;
  }
  function parsePriceInput() {
    const raw = String($('requestPrice').value || '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
    const value = Number(raw);
    return value > 0 ? value : null;
  }
  async function submitRequest() {
    if (SESSION_BETA && betaSession?.mode !== 'piece') return setRequestError('请先开始计件工作，再提交自主申报');
    if (state?.activeEntry) return setRequestError('正在计时，结束后才能申报计件');
    setRequestError('');
    const process = currentRequestProcess();
    if (!process) return setRequestError('请选择工序');
    const manualProcess = process.name === '其他' ? $('requestOtherProcess').value.trim() : '';
    if (process.name === '其他' && !manualProcess) return setRequestError('选择“其他”后请手工填写工序名称');
    const variant = requestVariant();
    const config = requestVariantConfig(process);
    if (config && variant.value <= 0) return setRequestError(`请填写${config.label}`);
    if (config && !Number.isInteger(variant.value)) return setRequestError(`${config.label}必须是整数`);
    const qty = Number($('requestQty').value);
    if (!Number.isInteger(qty) || qty <= 0) return setRequestError('数量必须是大于 0 的整数');
    const price = parsePriceInput();
    if (price == null) return setRequestError('单价必须大于 0，最多两位小数');
    const button = $('requestSubmit');
    button.disabled = true;
    try {
      if (requestMode === 'edit') {
        if (!editEntry) throw new Error('找不到要修改的记录');
        await rpc('work_update_my_piece', {
          p_code:code,
          p_id:editEntry.id,
          p_payload:{
            name:$('requestName').value.trim(),
            material:$('requestMaterial').value.trim(),
            spec:$('requestSpec') ? $('requestSpec').value.trim() : (editEntry?.spec || ''),
            processName:manualProcess || process.name,
            quantity:qty,
            unitPrice:price,
            variantKey:variant.key,
            variantValue:variant.value,
            variantLabel:variant.label,
            note:$('requestNote').value.trim(),
            reason:'员工修改后提交',
          },
        });
      } else if (requestMode === 'custom') {
        const name = $('requestName').value.trim();
        const material = $('requestMaterial').value.trim();
        if (!name) throw new Error('请填写品名');
        if (!material) throw new Error('请填写完整料件编号或后四位 不清楚请询问现场管理人员。');
        if (material.length < 4) throw new Error('料件编号至少填写后四位');
        await rpc('work_submit_custom_piece', {
          p_code:code,
          p_name:name,
          p_material:material,
          p_spec:$('requestSpec') ? $('requestSpec').value.trim() : '',
          p_process_id:(process.name === '其他' || process.custom) ? null : process.id,
          p_process_name:manualProcess || process.name,
          p_quantity:qty,
          p_variant_key:variant.key,
          p_variant_value:variant.value,
          p_variant_label:variant.label,
          p_unit_price:price,
          p_note:$('requestNote').value.trim(),
        });
      } else {
        if (!requestProduct) throw new Error('产品信息已失效，请重新选择产品');
        const priceChangePayload = {
          p_code:code,
          p_product_id:requestProduct.id,
          p_process_id:process.id || null,
          p_process_name:manualProcess || process.name,
          p_quantity:qty,
          p_variant_key:variant.key,
          p_variant_value:variant.value,
          p_variant_label:variant.label,
          p_unit_price:price,
          p_note:$('requestNote').value.trim(),
        };
        try {
          await rpc('work_submit_price_change', priceChangePayload);
        } catch (changeError) {
          if (!/p_process_name|function.*not found|does not exist|schema cache/i.test(changeError.message || '')) throw changeError;
          const legacyPayload = { ...priceChangePayload };
          delete legacyPayload.p_process_name;
          await rpc('work_submit_price_change', legacyPayload);
        }
      }
      closeRequestModal();
      await loadState();
      if (!$('salaryPanel').classList.contains('hidden')) await loadSalary();
      toast('已提交，等待管理员审核');
    } catch (e) {
      setRequestError(e.message || '提交失败');
    } finally {
      button.disabled = false;
    }
  }

  function showRevoke(id) { pendingRevokeId = id; show($('revokeModal'), true); }
  function closeRevoke() { pendingRevokeId = ''; show($('revokeModal'), false); }
  async function revokePiece() {
    if (!pendingRevokeId) return;
    const id = pendingRevokeId; const btn = $('revokeConfirm'); btn.disabled = true;
    try {
      await rpc('work_withdraw_submission', { p_code:code, p_id:id, p_reason:'' });
      closeRevoke(); await loadState(); if (!$('salaryPanel').classList.contains('hidden')) await loadSalary(); toast('计件记录已撤回');
    } catch (e) { toast(e.message || '撤回失败'); } finally { btn.disabled = false; }
  }
  $('loginButton').addEventListener('click', () => login($('codeInput').value));
  if ($('networkCheckButton')) $('networkCheckButton').addEventListener('click', () => checkNetworkConnectivity().catch(() => {}));
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login($('codeInput').value); });
  const logoutButton = $('logoutButton');
  if (logoutButton) logoutButton.addEventListener('click', () => { state = null; salaryData = null; editEntry = null; code = ''; clearStoredCode(); render(); });
  $('clockAction').addEventListener('click', clockAction);
$('clockStopConfirm').addEventListener('click', () => { closeClockStopConfirm(); runClockAction(true).catch((error) => toast(error.message || '结束失败')); });
$('clockStopCancel').addEventListener('click', closeClockStopConfirm);
$('clockStopModal').addEventListener('click', (e) => { if (e.target === $('clockStopModal')) closeClockStopConfirm(); });
  if ($('attendanceRefresh')) $('attendanceRefresh').addEventListener('click', () => loadMyAttendance().catch(() => {}));
  if ($('attendanceLeaveBtn')) $('attendanceLeaveBtn').addEventListener('click', openLeaveModal);
  if ($('leaveClose')) $('leaveClose').addEventListener('click', () => show($('leaveModal'), false));
  if ($('leaveCancel')) $('leaveCancel').addEventListener('click', () => show($('leaveModal'), false));
  if ($('leaveSubmit')) $('leaveSubmit').addEventListener('click', submitLeave);
  if ($('attendancePrevMonth')) $('attendancePrevMonth').addEventListener('click', () => { const m = $('attendanceMonth'); m.value = shiftMonthValue(m.value || currentMonth(), -1); loadMyAttendance().catch(() => {}); });
  if ($('attendanceNextMonth')) $('attendanceNextMonth').addEventListener('click', () => { const m = $('attendanceMonth'); m.value = shiftMonthValue(m.value || currentMonth(), 1); loadMyAttendance().catch(() => {}); });
  if ($('payrollRefresh')) $('payrollRefresh').addEventListener('click', () => loadMyPayroll().catch(() => {}));
  if ($('payrollPrint')) $('payrollPrint').addEventListener('click', () => window.print());
  if ($('payrollMonth')) $('payrollMonth').addEventListener('change', () => loadMyPayroll().catch(() => {}));
  if ($('payrollRangeSwitch')) $('payrollRangeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-payroll-range]');
    if (!btn) return;
    payrollRange = btn.dataset.payrollRange === 'month' ? 'month' : 'day';
    [...$('payrollRangeSwitch').querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    show($('payrollDateWrap'), payrollRange === 'day');
    show($('payrollMonthWrap'), payrollRange === 'month');
    show($('payrollMonthNav'), payrollRange === 'month');
    loadMyPayroll().catch(() => {});
  });
  if ($('payrollPrevMonth')) $('payrollPrevMonth').addEventListener('click', () => { shiftMonthInput('payrollMonth', -1); loadMyPayroll().catch(() => {}); });
  if ($('payrollNextMonth')) $('payrollNextMonth').addEventListener('click', () => { shiftMonthInput('payrollMonth', 1); loadMyPayroll().catch(() => {}); });
  if ($('payrollDate')) $('payrollDate').addEventListener('change', () => loadMyPayroll().catch(() => {}));
  if ($('salaryPrevMonth')) $('salaryPrevMonth').addEventListener('click', () => { shiftMonthInput('salaryMonth', -1); loadSalary().catch(() => {}); });
  if ($('salaryNextMonth')) $('salaryNextMonth').addEventListener('click', () => { shiftMonthInput('salaryMonth', 1); loadSalary().catch(() => {}); });
  if ($('attendanceMonth')) $('attendanceMonth').addEventListener('change', () => loadMyAttendance().catch(() => {}));
  if ($('reissueClose')) $('reissueClose').addEventListener('click', closeReissueModal);
  if ($('reissueCancel')) $('reissueCancel').addEventListener('click', closeReissueModal);
  if ($('reissueSubmit')) $('reissueSubmit').addEventListener('click', submitReissue);
  if ($('attendanceList')) $('attendanceList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reissue]');
    if (btn) openReissueModal(btn.dataset.reissue);
  });
  if ($('specialTimeConfirm')) $('specialTimeConfirm').addEventListener('click', confirmSpecialTime);
  if ($('specialTimeOvertime')) $('specialTimeOvertime').addEventListener('change', () => { specialPreviewReady = false; show($('specialTimePreview'), false); updateSpecialConfirmAction(); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    const tab = b.dataset.tab;
    show($('timePanel'), tab === 'time'); show($('piecePanel'), tab === 'piece'); show($('attendancePanel'), tab === 'attendance');
    const pieceSalary = !profile || profile.salaryType === 'hourly_piece';
    show($('salaryPanel'), tab === 'salary' && pieceSalary);
    show($('payrollPanel'), tab === 'salary' && !pieceSalary);
    if (tab === 'salary' && pieceSalary) loadSalary().catch(() => {});
    if (tab === 'salary' && !pieceSalary) loadMyPayroll().catch(() => {});
    if (tab === 'attendance') loadMyAttendance().catch(() => {});
  }));
  $('productSearch').addEventListener('input', () => {
    show($('productSearchClear'), Boolean($('productSearch').value.trim()));
    if (selectedProduct) {
      selectedProduct = null; selectedProcessId = ''; selectedVariant = null;
      $('productSearch').classList.remove('has-selection');
      $('productSearch').title = '';
      show($('newPieceButton'), true);
      renderPiece();
    }
    clearTimeout(searchTimer); searchTimer = setTimeout(searchProducts, 220);
  });
  $('productSearchClear').addEventListener('click', () => {
    closeVariantModal();
    $('productSearch').value = '';
    $('productSearch').classList.remove('has-selection');
    $('productSearch').title = '';
    selectedProduct = null; selectedProcessId = ''; selectedVariant = null;
    show($('productSuggest'), false); show($('productSearchClear'), false); show($('newPieceButton'), true);
    renderPiece(); $('productSearch').focus();
  });
  $('productSuggest').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-custom]')) { show($('productSuggest'), false); show($('newPieceButton'), true); openCustomRequest(); return; }
    const b = e.target.closest('[data-product]'); if (!b) return;
    selectedProduct = { id:b.dataset.product, material:b.dataset.material, name:b.dataset.name, spec:b.dataset.spec };
    selectedProcessId = ''; selectedVariant = null;
    $('productSearch').value = `${selectedProduct.material} · ${selectedProduct.name}`;
    $('productSearch').title = [selectedProduct.material, selectedProduct.name, selectedProduct.spec].filter(Boolean).join(' · ');
    $('productSearch').classList.add('has-selection');
    show($('productSearchClear'), true);
    show($('pickedProduct'), false); show($('productSuggest'), false); show($('newPieceButton'), false); loadProductProcesses(selectedProduct.id);
  });
  $('processGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-process]'); if (!b) return;
    const process = (state?.processes || []).find((p) => p.id === b.dataset.process);
    if (process?.name === '其他') {
      if (!selectedProduct) return toast('请先搜索并选择产品');
      openCustomRequest(true);
      $('requestProcess').value = process.name;
      $('requestProcess').dispatchEvent(new Event('change'));
      return;
    }
    selectedProcessId = b.dataset.process;
    selectedVariant = null;
    const config = PROCESS_VARIANTS[process?.name];
    const preferred = config ? preferredVariantForProcess(selectedProcessId) : null;
    if (preferred) selectedVariant = { value:Number(preferred.variantValue), label:preferred.variantLabel || variantDisplay(process.name, Number(preferred.variantValue)), custom:Number(preferred.variantValue) > 4 };
    renderPiece();
    if (config && !selectedVariant) openVariantModal();
  });
  $('variantBox').addEventListener('click', (e) => {
    if (e.target.closest('[data-variant-custom]')) { show($('variantCustomWrap'), true); $('variantCustomValue')?.focus(); return; }
    if (e.target.closest('#variantCustomConfirm')) { applyCustomVariant($('variantCustomValue')?.value || ''); return; }
    const b = e.target.closest('[data-variant-value]'); if (!b) return;
    selectedVariant = { value:Number(b.dataset.variantValue), label:b.dataset.variantLabel || String(b.dataset.variantValue) };
    renderVariant(); refreshSelectedPrice();
  });
  const handlePieceCardClick = (e) => {
    const resubmit = e.target.closest('[data-resubmit-piece]');
    if (resubmit) { resubmitPiece(resubmit.dataset.resubmitPiece).catch(() => {}); return; }
    const qty = e.target.closest('[data-edit-qty]');
    if (qty) { openQtyModal(qty.dataset.editQty); return; }
    const edit = e.target.closest('[data-edit-piece]');
    if (edit) { openEditPiece(edit.dataset.editPiece); return; }
    const revoke = e.target.closest('[data-revoke-piece]');
    if (revoke) showRevoke(revoke.dataset.revokePiece);
  };
  $('pieceEntries').addEventListener('click', handlePieceCardClick);
  $('salaryEntries').addEventListener('click', handlePieceCardClick);
  $('qtyModalCancel').addEventListener('click', closeQtyModal);
  $('qtyModalClose').addEventListener('click', closeQtyModal);
  $('qtyModalSave').addEventListener('click', () => saveQtyModal().catch(() => {}));
  $('qtyModalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveQtyModal().catch(() => {}); });
  $('qtyModal').addEventListener('click', (e) => { if (e.target === $('qtyModal')) closeQtyModal(); });
  $('salaryRefresh').addEventListener('click', () => loadSalary().catch(() => {}));
  $('salaryRangeSwitch').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-salary-range]');
    if (!btn) return;
    salaryRange = btn.dataset.salaryRange === 'month' ? 'month' : 'day';
    [...$('salaryRangeSwitch').querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    show($('salaryDateWrap'), salaryRange === 'day');
    show($('salaryMonthWrap'), salaryRange === 'month');
    show($('salaryMonthNav'), salaryRange === 'month');
    show($('salaryEntriesTitle'), salaryRange === 'day');
    show($('salaryEntries'), salaryRange === 'day');
    show($('salaryMonthTitle'), salaryRange === 'month');
    show($('salaryMonthDays'), salaryRange === 'month');
    loadSalary().catch(() => {});
  });
  $('salaryMonth').addEventListener('change', () => loadSalary().catch(() => {}));
  bindSalaryBreakdown();
  $('salaryDate').addEventListener('change', () => loadSalary().catch(() => {}));
  $('revokeCancel').addEventListener('click', closeRevoke);
  $('revokeConfirm').addEventListener('click', revokePiece);
  $('revokeModal').addEventListener('click', (e) => { if (e.target === $('revokeModal')) closeRevoke(); });

  $('noPricedProcessApply').addEventListener('click', () => {
    openCustomRequest(true);
    const other = (state?.processes || []).find((p) => p.name === '其他');
    if (other) {
      $('requestProcess').value = other.name;
      $('requestProcess').dispatchEvent(new Event('change'));
    }
  });
  $('sessionBetaActions').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-beta-action]'); if (!button) return; const action = button.dataset.betaAction;
    try { if (action === 'start-piece') await startBetaSession('piece'); else if (action === 'start-time') await startBetaSession('time'); else if (action === 'switch-piece') await switchBetaSession('piece'); else if (action === 'switch-time') await switchBetaSession('time'); else if (action === 'end') await endBetaSession(); } catch (e) { toast(e.message || '工作时段操作失败'); }
  });
  $('newPieceButton').addEventListener('click', openCustomRequest);
  $('priceChangeButton').addEventListener('click', openPriceChangeRequest);
  $('requestProcess').addEventListener('input', () => {
    const process = currentRequestProcess();
    show($('requestOtherProcessWrap'), process?.name === '其他');
    renderRequestVariant(false);
  });
  $('requestProcess').addEventListener('change', () => {
    const process = currentRequestProcess();
    show($('requestOtherProcessWrap'), process?.name === '其他');
    renderRequestVariant(false);
    if (requestMode === 'price_change') loadCatalogPriceForRequest();
    else if (requestMode === 'custom') updateRequestSuggestedPrice(false);
  });
  $('requestMaterial').addEventListener('input', scheduleRequestMaterialLookup);
  $('requestMaterialMatches').addEventListener('click', (event) => {
    const button = event.target.closest('[data-request-product]');
    if (!button) return;
    fillRequestProduct({ id:button.dataset.requestProduct, material:button.dataset.material, name:button.dataset.name, spec:button.dataset.spec }, 'user');
  });
  $('variantModalOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-modal-variant-value]');
    if (!button) return;
    selectedVariant = { value:Number(button.dataset.modalVariantValue), label:button.dataset.modalVariantLabel || String(button.dataset.modalVariantValue) };
    closeVariantModal();
    renderVariant();
    refreshSelectedPrice();
  });
  $('variantModalCustomValue').addEventListener('input', setGenericVariantPrice);
  $('variantGenericQty').addEventListener('input', setGenericVariantPrice);
  $('variantGenericSubmit').addEventListener('click', submitGenericVariant);
  $('variantModalClose').addEventListener('click', closeVariantModal);
  $('variantModal').addEventListener('click', (event) => {
    if (event.target === $('variantModal')) { closeVariantModal(); return; }
    if (event.target.closest('[data-modal-variant-custom]')) {
      const generic = isGenericProduct();
      show($('variantModalCustomWrap'), true);
      show($('variantGenericInfoWrap'), generic);
      $('variantModalCustomConfirm').hidden = generic;
      if (generic) {
        $('variantGenericQty').value = $('pieceQty').value || '';
        setGenericVariantPrice();
      }
      $('variantModalCustomValue')?.focus();
      return;
    }
    if (event.target.closest('#variantModalCustomConfirm')) { applyCustomVariant($('variantModalCustomValue')?.value || '', 'modal'); }
  });
  $('requestVariantValue').addEventListener('change', () => {
    const isCustom = $('requestVariantValue').value === 'custom';
    const config = requestVariantConfig(currentRequestProcess());
    if ($('requestVariantCustomLabel') && config) $('requestVariantCustomLabel').textContent = `自己填写${config.label.replace(/^(攻丝|折弯|弯管)/, '')}`;
    show($('requestVariantCustomWrap'), isCustom);
    if (isCustom) $('requestVariantCustom')?.focus();
    updateRequestSuggestedPrice(false);
    loadCatalogPriceForRequest();
  });
  $('requestVariantCustom')?.addEventListener('input', () => {
    updateRequestSuggestedPrice(false);
    loadCatalogPriceForRequest();
  });
  $('requestPrice').addEventListener('input', () => {
    if (requestAutoPrice != null && Number($('requestPrice').value) !== Number(requestAutoPrice)) requestAutoPrice = null;
  });
  $('requestCancel').addEventListener('click', closeRequestModal);
  $('requestSubmit').addEventListener('click', submitRequest);
  $('requestModal').addEventListener('click', (e) => { if (e.target === $('requestModal')) closeRequestModal(); });
  $('pieceSubmit').addEventListener('click', submitPiece);
  $('pieceQty').addEventListener('input', () => { showPieceFormError(''); updatePieceSubmitState(); });
  setInterval(() => {
    if (SESSION_BETA) renderBetaSession();
    else if (state?.activeEntry) {
      const elapsed = currentElapsedText();
      $('clockTime').textContent = elapsed;
      if ($('activeTimerElapsed')) $('activeTimerElapsed').textContent = elapsed;
    }
  }, 1000);
  setInterval(() => { if (code && state) loadState().catch(() => {}); }, 30000);
  const urlCode = new URLSearchParams(location.search).get('code');
  const stored = storedEmployeeCode();
  if (urlCode || stored) login(urlCode || stored); else render();
})();
