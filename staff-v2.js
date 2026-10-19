/* ============================================================
   员工信息 / 工资 v2
   说明：直接挂在主管理端视图里，不再 iframe，不再二次输访问码。
   数据：优先用 staff-v2-schema.sql 提供的新 RPC；
         未执行迁移时自动降级到现有接口预览。
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const RPC_BASE = String(window.SHIPMENT_RPC_BASE || '').replace(/\/+$/, '');
  const ANON_KEY = String(window.SHIPMENT_ANON_KEY || '');
  const TYPE_TEXT = { daily: '固定日薪', hourly_piece: '计时计件', monthly: '固定月薪', management: '管理（免考勤）' };
  const TYPE_CLASS = { daily: 'daily', hourly_piece: 'hourly_piece', monthly: 'monthly', management: 'management' };
  const TRACK_TEXT = { welding: '焊工', back: '后道', fixed: '非报工组' };
  const STATUS_TEXT = { draft: '草稿', review: '待核对', locked: '已锁定', paid: '已发放', imported: '历史导入' };
  const state = {
    employeeMounted: false, employeeLoading: false, employeePromise: null, employees: [], employeeQuery: '', employeeDept: '', employeeType: '', employeeStatus: 'active',
    detail: null, detailTab: 'basic', sensitiveRevealed: false, auditLoaded: false,
    payrollMounted: false, payrollLoading: false, payrollSeq: 0, payrollMonth: initialPayrollMonth(), payrollRows: [], payrollQuery: '', payrollType: '', payrollSource: 'all', payrollStatus: 'all',
    period: null, schemaMissing: false, fallbackReason: '', toastTimer: 0
  };

function currentMonth() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7); }
  function initialPayrollMonth() {
    const raw = String(new URLSearchParams(location.search).get('pay_month') || '').trim();
    return /^\d{4}-\d{2}$/.test(raw) ? raw : currentMonth();
  }
  function monthStart(month) { return String(month || currentMonth()) + '-01'; }
  function monthEnd(month) { const [y, m] = String(month || currentMonth()).split('-').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; }
  function addMonth(month, delta) { const [y, m] = String(month || currentMonth()).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + delta, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v) { return Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
  function money(v) { return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function typeText(v) { return TYPE_TEXT[v] || v || '未设置'; }
  function typeClass(v) { return TYPE_CLASS[v] || ''; }
  function isAdmin() { return document.body.dataset.boardRole === 'admin'; }
  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || localStorage.getItem('shipmentBoardAccessCode') || ''; } catch { return ''; }
  }
  async function rpc(name, body = {}) {
    if (!RPC_BASE) return { ok: false, error: '未配置云端接口' };
    const code = readCode(); if (!code) return { ok: false, error: '没有管理员访问码，请先在主页面登录' };
    try {
      const h = { 'Content-Type': 'application/json' };
      if (ANON_KEY) { h.apikey = ANON_KEY; h.Authorization = 'Bearer ' + ANON_KEY; }
      const res = await fetch(RPC_BASE + '/' + name, { method: 'POST', headers: h, body: JSON.stringify({ p_code: code, ...body }) });
      const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
      if (!res.ok) { const msg = (data && (data.message || data.error || data.details)) || ('HTTP ' + res.status); return { ok: false, error: msg, missing: /does not exist|could not find|Could not find the function|PGRST202|42883/i.test(msg) }; }
      return { ok: true, data };
    } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }
  function ensureToast() { let el = document.getElementById('sv2Toast'); if (!el) { el = document.createElement('div'); el.id = 'sv2Toast'; el.className = 'sv2-toast'; el.hidden = true; document.body.appendChild(el); } return el; }
  function toast(message, kind = '') { const el = ensureToast(); el.textContent = String(message || ''); el.className = 'sv2-toast ' + kind; el.hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { el.hidden = true; }, 5200); }
  function normalizeEmployee(raw) {
    const employeeNo = String(raw && (raw.employeeNo ?? raw.employee_no ?? raw.no) || '').trim();
    const salaryType = String(raw && (raw.salaryType ?? raw.salary_type) || '').trim();
    const employmentStatus = String(raw && (raw.employmentStatus ?? raw.employment_status) || (raw && raw.active === false ? 'resigned' : 'active'));
    const active = raw && raw.active !== false && employmentStatus !== 'resigned';
    const issues = [];
    if (!String(raw && raw.phone || '').trim()) issues.push('缺手机号');
    if (!String(raw && raw.deliAccount || '').trim()) issues.push('缺得力账号');
    if (!salaryType) issues.push('缺工资类型');
    if (salaryType === 'daily' && raw && raw.dailySalary == null) issues.push('缺日薪');
    if ((salaryType === 'monthly' || salaryType === 'management') && raw && raw.monthlySalary == null) issues.push('缺月薪');
    if (salaryType === 'hourly_piece' && raw && raw.hourlyRate == null) issues.push('缺时薪');
    const reportedComplete = raw && typeof raw.dataComplete === 'boolean' ? raw.dataComplete : null;
    return { ...raw, employeeNo, name: String(raw && raw.name || '').trim(), salaryType, employmentStatus, active, department: String(raw && raw.department || '').trim(), track: String(raw && raw.track || 'fixed'), baseStart: String(raw && raw.baseStart || '').slice(0, 5), issueList: reportedComplete === true ? [] : issues, dataComplete: reportedComplete === null ? issues.length === 0 : reportedComplete };
  }
  function findEmployee(no) { return state.employees.find((e) => String(e.employeeNo) === String(no)) || null; }

  function closeDrawer() { $$('.sv2-drawer-mask').forEach((x) => x.remove()); $$('.sv2-drawer').forEach((x) => x.remove()); state.drawerKind = ''; }
  function openDrawer({ title, subtitle = '', body = '', footer = '', className = '' }, onMount) {
    closeDrawer();
    const mask = document.createElement('div'); mask.className = 'sv2-drawer-mask';
    const drawer = document.createElement('section'); drawer.className = 'sv2-drawer ' + className; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = `<header class="sv2-drawer-head"><div class="sv2-drawer-head-main"><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button type="button" class="sv2-btn ghost small" data-sv2-close>关闭</button></header><div class="sv2-drawer-body">${body}</div>${footer ? `<footer class="sv2-drawer-foot">${footer}</footer>` : ''}`;
    mask.addEventListener('click', closeDrawer);
    drawer.addEventListener('click', (event) => { if (event.target.closest('[data-sv2-close]')) { event.preventDefault(); closeDrawer(); } });
    document.body.append(mask, drawer); if (typeof onMount === 'function') onMount(drawer); return drawer;
  }

  function renderEmployeeShell() {
    const mount = document.getElementById('staffInfoMount'); if (!mount || state.employeeMounted) return; state.employeeMounted = true;
    mount.innerHTML = `<div class="sv2-page"><header class="sv2-head"><div class="sv2-head-main"><p class="sv2-eyebrow">人事主数据</p><h1>员工信息</h1><p>员工档案、任职状态、工资标准和敏感资料统一管理。身份证、银行卡默认打码，只对管理员开放。</p></div><div class="sv2-actions"><button class="sv2-btn" type="button" id="sv2EmpRefresh">刷新</button><button class="sv2-btn primary" type="button" id="sv2EmpNew">新增员工</button></div></header><section class="sv2-kpis" id="sv2EmpKpis"></section><div id="sv2EmpDataHint" class="sv2-note" style="margin-bottom:12px" hidden></div><section class="sv2-panel"><div class="sv2-toolbar"><label class="sv2-field grow"><span>搜索</span><input id="sv2EmpSearch" type="search" placeholder="工号 / 姓名 / 手机 / 部门 / 得力账号"></label><label class="sv2-field" style="width:190px"><span>部门</span><select id="sv2EmpDept"><option value="">全部部门</option></select></label><label class="sv2-field" style="width:160px"><span>工资类型</span><select id="sv2EmpType"><option value="">全部类型</option><option value="daily">固定日薪</option><option value="hourly_piece">计时计件</option><option value="monthly">固定月薪</option><option value="management">管理（免考勤）</option></select></label><label class="sv2-field" style="width:140px"><span>状态</span><select id="sv2EmpStatus"><option value="active">在职</option><option value="all">全部</option><option value="resigned">离职</option><option value="incomplete">资料不完整</option></select></label></div><div class="sv2-table-wrap"><table class="sv2-table employee-table"><thead><tr><th>工号</th><th>姓名</th><th>部门 / 报工组</th><th>工资类型</th><th>手机</th><th>入职日期</th><th>账号</th><th>资料</th><th>操作</th></tr></thead><tbody id="sv2EmpBody"><tr><td colspan="9"><div class="sv2-skeleton"><b>正在读取员工档案</b><span>请稍候…</span></div></td></tr></tbody></table><div id="sv2EmpEmpty" class="sv2-empty" hidden></div></div></section></div>`;
    $('#sv2EmpRefresh').addEventListener('click', () => loadDirectory(true).catch(() => {}));
    $('#sv2EmpNew').addEventListener('click', () => openEmployeeForm(''));
    $('#sv2EmpSearch').addEventListener('input', (e) => { state.employeeQuery = e.target.value; renderDirectory(); });
    $('#sv2EmpDept').addEventListener('change', (e) => { state.employeeDept = e.target.value; renderDirectory(); });
    $('#sv2EmpType').addEventListener('change', (e) => { state.employeeType = e.target.value; renderDirectory(); });
    $('#sv2EmpStatus').addEventListener('change', (e) => { state.employeeStatus = e.target.value; renderDirectory(); });
    $('#sv2EmpBody').addEventListener('click', (event) => {
      const action = event.target.closest('[data-sv2-action]'); const row = event.target.closest('tr[data-employee-no]');
      if (action) { event.preventDefault(); event.stopPropagation(); const no = action.dataset.employeeNo || (row && row.dataset.employeeNo); if (action.dataset.sv2Action === 'edit') openEmployeeForm(no); else if (action.dataset.sv2Action === 'payroll') switchToPayroll(no); else openEmployeeDetail(no).catch(() => {}); return; }
      if (row) openEmployeeDetail(row.dataset.employeeNo).catch(() => {});
    });
  }

  async function ensureEmployees(force = false) {
    if (state.employeePromise) return state.employeePromise;
    if (state.employees.length && !force) return;
    state.employeeLoading = true;
    state.employeePromise = (async () => {
      try {
        let result = await rpc('board_employee_directory');
        if (result.ok) state.employees = (result.data && result.data.employees || []).map(normalizeEmployee);
        else if (result.missing) {
          result = await rpc('board_employee_list'); if (!result.ok) throw new Error(result.error || '员工档案读取失败');
          state.employees = (result.data && result.data.employees || []).map(normalizeEmployee); state.schemaMissing = true;
        } else throw new Error(result.error || '员工档案读取失败');
        state.employees.sort((a, b) => { const na = Number(String(a.employeeNo).replace(/[^0-9]/g, '')) || 999999; const nb = Number(String(b.employeeNo).replace(/[^0-9]/g, '')) || 999999; return na - nb || a.name.localeCompare(b.name, 'zh-CN'); });
      } finally { state.employeeLoading = false; state.employeePromise = null; }
    })();
    return state.employeePromise;
  }
  async function loadDirectory(force = false) {
    renderEmployeeShell();
    try { await ensureEmployees(force); renderDirectory(); }
    catch (error) { const body = $('#sv2EmpBody'); if (body) body.innerHTML = `<tr><td colspan="9"><div class="sv2-empty"><b>员工档案读取失败</b>${esc(error.message || error)}</div></td></tr>`; toast(error.message || '员工档案读取失败', 'err'); }
  }
  function filteredEmployees() {
    const q = state.employeeQuery.trim().toLowerCase();
    return state.employees.filter((e) => {
      const active = e.active !== false && e.employmentStatus !== 'resigned';
      if (state.employeeStatus === 'active' && !active) return false;
      if (state.employeeStatus === 'resigned' && active) return false;
      if (state.employeeStatus === 'incomplete' && e.dataComplete) return false;
      if (state.employeeDept && e.department !== state.employeeDept) return false;
      if (state.employeeType && e.salaryType !== state.employeeType) return false;
      if (!q) return true;
      return [e.employeeNo, e.name, e.phone, e.department, e.deliAccount, e.track].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }
  function renderDirectory() {
    renderEmployeeShell();
    const active = state.employees.filter((e) => e.active !== false && e.employmentStatus !== 'resigned');
    const month = currentMonth(); const newHire = state.employees.filter((e) => String(e.hireDate || '').slice(0, 7) === month).length; const incomplete = active.filter((e) => !e.dataComplete).length;
    const missingHire = active.filter((e) => !String(e.hireDate || '').trim()).length;
    const hint = $('#sv2EmpDataHint');
    if (hint) { hint.hidden = missingHire === 0; hint.innerHTML = missingHire ? `有 ${missingHire} 名在职员工未填入职日期。入职日期用于员工生命周期和离职结算，不影响本月工资试算；建议人事补录。` : ''; }
    const kpis = $('#sv2EmpKpis');
    if (kpis) kpis.innerHTML = `<article class="sv2-kpi"><span>员工总数</span><strong>${num(state.employees.length)}</strong><small>全部档案</small></article><article class="sv2-kpi"><span>在职</span><strong>${num(active.length)}</strong><small>可参与工资计算</small></article><article class="sv2-kpi"><span>本月新入职</span><strong>${num(newHire)}</strong><small>${esc(month)}</small></article><article class="sv2-kpi${incomplete ? ' hot' : ''}"><span>资料不完整</span><strong>${num(incomplete)}</strong><small>建议补全后再发工资</small></article>`;
    const dept = $('#sv2EmpDept');
    if (dept && !dept.dataset.filled) { const list = [...new Set(state.employees.map((e) => e.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')); dept.innerHTML = '<option value="">全部部门</option>' + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join(''); dept.dataset.filled = '1'; }
    const rows = filteredEmployees(); const body = $('#sv2EmpBody'); const empty = $('#sv2EmpEmpty');
    if (body) body.innerHTML = rows.map((e) => `<tr data-employee-no="${esc(e.employeeNo)}"><td class="mono">${esc(e.employeeNo)}</td><td><div class="sv2-cell-strong"><span class="sv2-avatar">${esc(String(e.name || '?').slice(0, 1))}</span><span><b>${esc(e.name || '—')}</b><small>${esc(e.phone || '未填手机')}</small></span></div></td><td>${esc(e.department || '—')}<small class="muted" style="display:block">${esc(TRACK_TEXT[e.track] || e.track || '')}</small></td><td><span class="sv2-pill ${typeClass(e.salaryType)}">${esc(typeText(e.salaryType))}</span></td><td>${esc(e.phone || '—')}</td><td>${esc(e.hireDate || '—')}</td><td><span class="sv2-pill ${e.active ? 'active' : 'resigned'}">${e.active ? '在职' : '离职'}</span></td><td>${e.dataComplete ? '<span class="sv2-pill ok">完整</span>' : `<span class="sv2-pill warn" title="${esc(e.issueList.join('、'))}">${e.issueList.length} 项待补</span>`}</td><td><div class="sv2-row-actions"><button class="sv2-btn small" type="button" data-sv2-action="edit" data-employee-no="${esc(e.employeeNo)}">编辑</button><button class="sv2-btn small ghost" type="button" data-sv2-action="payroll" data-employee-no="${esc(e.employeeNo)}">工资</button></div></td></tr>`).join('');
    if (empty) { empty.hidden = rows.length > 0; empty.innerHTML = '<b>没有符合条件的员工</b>换个筛选条件试试。'; }
  }

  async function openEmployeeDetail(no) {
    const summary = findEmployee(no) || { employeeNo: no }; state.detailTab = 'basic'; state.sensitiveRevealed = false; state.auditLoaded = false;
    openDrawer({ title: `${summary.name || '员工'} · ${summary.employeeNo || ''}`, subtitle: '正在读取员工详情…', body: '<div class="sv2-skeleton"><b>正在读取员工详情</b><span>包含工资标准和敏感资料状态…</span></div>' }); state.drawerKind = 'employee-detail';
    let detail = summary; let rates = [];
    const detailResult = await rpc('board_employee_detail', { p_employee_no: no });
    if (detailResult.ok) { const payload = detailResult.data || {}; detail = normalizeEmployee(payload.employee || payload); rates = payload.rates || []; }
    else if (detailResult.missing) { const fallback = await rpc('board_employee_list'); if (fallback.ok) { const found = (fallback.data && fallback.data.employees || []).find((e) => String(e.employeeNo) === String(no)); if (found) detail = normalizeEmployee(found); } rates = synthesizeRates(detail); state.schemaMissing = true; }
    else { toast(detailResult.error || '员工详情读取失败', 'err'); rates = synthesizeRates(summary); }
    if (!rates.length) rates = synthesizeRates(detail); state.detail = { employee: detail, rates, audit: [] }; renderEmployeeDetail();
  }
  function synthesizeRates(e) { return [{ id: 'current', effectiveFrom: monthStart(currentMonth()), salaryType: e.salaryType, monthlySalary: e.monthlySalary, dailySalary: e.dailySalary, hourlyRate: e.hourlyRate, overtimeRate: e.overtimeRate, note: '当前有效标准（兼容模式）', current: true }]; }
  function rateSummary(r) { const bits = []; if (r.salaryType === 'daily') bits.push(`日薪 ${money(r.dailySalary)} 元/天`, `加班 ${money(r.overtimeRate)} 元/天`); else if (r.salaryType === 'monthly' || r.salaryType === 'management') bits.push(`月薪 ${money(r.monthlySalary)} 元`); else bits.push(`时薪 ${money(r.hourlyRate)} 元/小时`); return bits.join(' · '); }
  function detailGrid(items) { return `<div class="sv2-detail-grid">${items.map(([label, value, full]) => `<div class="sv2-detail-item${full ? ' full' : ''}"><span>${esc(label)}</span><strong>${value}</strong></div>`).join('')}</div>`; }

  function renderEmployeeDetail() {
    if (!state.detail) return;
    const e = state.detail.employee; const rates = state.detail.rates || [];
    const tabs = [['basic', '基本信息'], ['job', '任职与状态'], ['salary', '工资标准'], ['sensitive', '敏感资料'], ['audit', '变更记录']];
    let content = '';
    if (state.detailTab === 'basic') content = detailGrid([['工号', esc(e.employeeNo || '—')], ['姓名', esc(e.name || '—')], ['部门', esc(e.department || '—')], ['报工组', esc(TRACK_TEXT[e.track] || e.track || '—')], ['手机号', esc(e.phone || '—')], ['得力账号', esc(e.deliAccount || '—')], ['入职日期', esc(e.hireDate || '—')], ['账号状态', e.active ? '<span class="sv2-pill active">启用</span>' : '<span class="sv2-pill resigned">停用</span>'], ['备注', esc(e.note || '—'), true]]);
    else if (state.detailTab === 'job') content = detailGrid([['工资类型', `<span class="sv2-pill ${typeClass(e.salaryType)}">${esc(typeText(e.salaryType))}</span>`], ['在职状态', e.employmentStatus === 'resigned' ? '离职' : '在职'], ['上班基准', esc(e.baseStart || '—')], ['离职日期', esc(e.leaveDate || '—')], ['报工组', esc(TRACK_TEXT[e.track] || e.track || '—')], ['资料状态', e.dataComplete ? '完整' : esc(e.issueList.join('、'))]]);
    else if (state.detailTab === 'salary') content = `<div class="sv2-note">工资标准按生效日期保存。调薪只新增记录，不覆盖历史。</div><div class="sv2-rate-list" style="margin-top:12px">${rates.map((r) => `<article class="sv2-rate"><div><div class="date">${esc(r.effectiveFrom || '—')}</div>${r.current ? '<span class="cur">当前有效</span>' : ''}</div><div class="body"><span class="sv2-pill ${typeClass(r.salaryType)}">${esc(typeText(r.salaryType))}</span><span>${esc(rateSummary(r))}</span>${r.note ? `<span>${esc(r.note)}</span>` : ''}</div><div>${r.current ? '' : '<span class="muted" style="font-size:11px">历史</span>'}</div></article>`).join('')}</div><div style="margin-top:14px"><button class="sv2-btn primary" type="button" id="sv2EmpRateAdd">调整工资标准</button></div>`;
    else if (state.detailTab === 'sensitive') {
      const idCard = e.idCard || ''; const bank = e.bankCard || ''; const mask = (v) => v ? String(v).slice(0, 4) + '********' + String(v).slice(-3) : '未填写';
      content = `<div class="sv2-note">敏感字段只允许管理员查看；普通目录接口不返回这些值。</div><div class="sv2-detail-grid" style="margin-top:12px"><div class="sv2-detail-item"><span>身份证号</span><strong class="sv2-secure"><span class="${state.sensitiveRevealed ? '' : 'masked'}">${esc(state.sensitiveRevealed ? idCard || '未填写' : mask(idCard))}</span></strong></div><div class="sv2-detail-item"><span>银行卡号</span><strong class="sv2-secure"><span class="${state.sensitiveRevealed ? '' : 'masked'}">${esc(state.sensitiveRevealed ? bank || '未填写' : mask(bank))}</span></strong></div><div class="sv2-detail-item full"><span>开户行</span><strong>${esc(e.bankName || '未填写')}</strong></div></div><div style="margin-top:14px"><button class="sv2-btn" type="button" id="sv2RevealSensitive">${state.sensitiveRevealed ? '隐藏完整信息' : '查看完整信息'}</button></div>`;
    } else {
      const logs = state.detail.audit || [];
      content = state.schemaMissing ? '<div class="sv2-note">当前为兼容模式；执行 staff-v2-schema.sql 后显示员工变更审计。</div>' : (logs.length ? `<div class="sv2-rate-list">${logs.map((log) => `<div class="sv2-rate"><div class="date">${esc(String(log.createdAt || '').slice(0, 16).replace('T', ' '))}</div><div class="body"><b>${esc(log.action || '变更')}</b><span>${esc(log.note || '')}</span></div><div class="muted">${esc(log.operator || '')}</div></div>`).join('')}</div>` : '<div class="sv2-empty"><b>还没有变更记录</b>执行迁移后会自动留痕。</div>');
    }
    const drawer = openDrawer({ title: `${e.name || '员工'} · ${e.employeeNo || ''}`, subtitle: `${e.department || '未填部门'} · ${typeText(e.salaryType)}`, body: `<div class="sv2-drawer-tabs">${tabs.map(([k, label]) => `<button type="button" class="sv2-drawer-tab ${state.detailTab === k ? 'on' : ''}" data-sv2-detail-tab="${k}">${label}</button>`).join('')}</div><div id="sv2DetailContent">${content}</div>`, footer: '<button class="sv2-btn ghost" type="button" id="sv2EmpResetCode">重置访问码</button><button class="sv2-btn" type="button" id="sv2EmpEdit">编辑档案</button><button class="sv2-btn primary" type="button" id="sv2EmpPayroll">查看工资</button>' });
    state.drawerKind = 'employee-detail';
    $$('.sv2-drawer-tab', drawer).forEach((tab) => tab.addEventListener('click', () => { state.detailTab = tab.dataset.sv2DetailTab; if (state.detailTab === 'audit' && !state.auditLoaded) loadEmployeeAudit().catch(() => {}); else renderEmployeeDetail(); }));
    const reveal = $('#sv2RevealSensitive', drawer); if (reveal) reveal.addEventListener('click', () => { state.sensitiveRevealed = !state.sensitiveRevealed; renderEmployeeDetail(); });
    const rateAdd = $('#sv2EmpRateAdd', drawer); if (rateAdd) rateAdd.addEventListener('click', () => openRateForm(e));
    $('#sv2EmpEdit', drawer)?.addEventListener('click', () => openEmployeeForm(e.employeeNo));
    $('#sv2EmpPayroll', drawer)?.addEventListener('click', () => { closeDrawer(); switchToPayroll(e.employeeNo); });
    $('#sv2EmpResetCode', drawer)?.addEventListener('click', () => resetEmployeeCode(e));
  }
  async function loadEmployeeAudit() {
    if (!state.detail) return;
    const result = await rpc('board_employee_audit_list', { p_employee_no: state.detail.employee.employeeNo, p_limit: 100 });
    if (result.ok) state.detail.audit = result.data && result.data.logs || []; else if (!result.missing) toast(result.error || '变更记录读取失败', 'err');
    state.auditLoaded = true; renderEmployeeDetail();
  }

  function employeePayloadFromForm() {
    return { employeeNo: String($('#sv2FormNo')?.value || '').trim(), name: String($('#sv2FormName')?.value || '').trim(), department: String($('#sv2FormDept')?.value || '').trim(), phone: String($('#sv2FormPhone')?.value || '').trim(), deliAccount: String($('#sv2FormDeli')?.value || '').trim(), salaryType: String($('#sv2FormType')?.value || 'daily'), monthlySalary: $('#sv2FormMonthly')?.value || null, dailySalary: $('#sv2FormDaily')?.value || null, overtimeRate: $('#sv2FormOvertime')?.value || null, hourlyRate: $('#sv2FormHourly')?.value || null, baseStart: $('#sv2FormBaseStart')?.value || null, track: String($('#sv2FormTrack')?.value || 'fixed'), employmentStatus: String($('#sv2FormEmployment')?.value || 'active'), hireDate: $('#sv2FormHire')?.value || null, leaveDate: $('#sv2FormLeave')?.value || null, idCard: String($('#sv2FormIdCard')?.value || '').trim(), bankCard: String($('#sv2FormBankCard')?.value || '').trim(), bankName: String($('#sv2FormBankName')?.value || '').trim(), note: String($('#sv2FormNote')?.value || '').trim(), active: String($('#sv2FormEmployment')?.value || 'active') !== 'resigned', effectiveFrom: $('#sv2FormEffective')?.value || monthStart(currentMonth()) };
  }
  function syncEmployeeFormSalaryFields(root) {
    const type = $('#sv2FormType', root)?.value || 'daily';
    $$('[data-sv2-salary-kind]', root).forEach((el) => { const kind = el.dataset.sv2SalaryKind; el.hidden = kind === 'monthly' ? !(type === 'monthly' || type === 'management') : kind === 'daily' ? type !== 'daily' : type !== 'hourly_piece'; });
    const track = $('#sv2FormTrack', root); if (track) { track.disabled = type !== 'hourly_piece'; if (type !== 'hourly_piece') track.value = 'fixed'; else if (track.value === 'fixed') track.value = 'back'; }
  }
  async function openEmployeeForm(no) {
    const e = no ? (state.detail && state.detail.employee && String(state.detail.employee.employeeNo) === String(no) ? state.detail.employee : findEmployee(no)) : null;
    const isEdit = !!e; const type = e?.salaryType || 'daily';
    const body = `<div class="sv2-form-grid"><label class="sv2-field"><span>工号 *</span><input id="sv2FormNo" value="${esc(e?.employeeNo || '')}" ${isEdit ? 'disabled' : ''} placeholder="如 20"></label><label class="sv2-field"><span>姓名 *</span><input id="sv2FormName" value="${esc(e?.name || '')}" placeholder="请输入姓名"></label><label class="sv2-field"><span>部门</span><input id="sv2FormDept" value="${esc(e?.department || '')}" placeholder="如 生产部 / 办公室"></label><label class="sv2-field"><span>手机号</span><input id="sv2FormPhone" value="${esc(e?.phone || '')}" inputmode="tel"></label><label class="sv2-field"><span>得力账号</span><input id="sv2FormDeli" value="${esc(e?.deliAccount || '')}"></label><label class="sv2-field"><span>工资类型</span><select id="sv2FormType"><option value="daily" ${type === 'daily' ? 'selected' : ''}>固定日薪</option><option value="hourly_piece" ${type === 'hourly_piece' ? 'selected' : ''}>计时计件</option><option value="monthly" ${type === 'monthly' ? 'selected' : ''}>固定月薪</option><option value="management" ${type === 'management' ? 'selected' : ''}>管理（免考勤）</option></select></label><label class="sv2-field" data-sv2-salary-kind="daily"><span>日薪（元/天）</span><input id="sv2FormDaily" type="number" min="0" step="0.01" value="${esc(e?.dailySalary ?? '')}"></label><label class="sv2-field" data-sv2-salary-kind="daily"><span>加班工资（元/天）</span><input id="sv2FormOvertime" type="number" min="0" step="0.01" value="${esc(e?.overtimeRate ?? '')}"></label><label class="sv2-field" data-sv2-salary-kind="monthly"><span>月薪（元）</span><input id="sv2FormMonthly" type="number" min="0" step="0.01" value="${esc(e?.monthlySalary ?? '')}"></label><label class="sv2-field" data-sv2-salary-kind="hourly"><span>计时时薪（元/小时）</span><input id="sv2FormHourly" type="number" min="0" step="0.01" value="${esc(e?.hourlyRate ?? '')}"></label><label class="sv2-field"><span>上班基准</span><input id="sv2FormBaseStart" type="time" value="${esc(e?.baseStart || '07:30')}"></label><label class="sv2-field"><span>报工组</span><select id="sv2FormTrack"><option value="fixed" ${e?.track === 'fixed' ? 'selected' : ''}>非报工组</option><option value="welding" ${e?.track === 'welding' ? 'selected' : ''}>焊工</option><option value="back" ${e?.track === 'back' ? 'selected' : ''}>后道</option></select></label><label class="sv2-field"><span>在职状态</span><select id="sv2FormEmployment"><option value="active" ${e?.employmentStatus !== 'resigned' ? 'selected' : ''}>在职</option><option value="resigned" ${e?.employmentStatus === 'resigned' ? 'selected' : ''}>离职</option></select></label><label class="sv2-field"><span>入职日期</span><input id="sv2FormHire" type="date" value="${esc(e?.hireDate || '')}"></label><label class="sv2-field"><span>离职日期</span><input id="sv2FormLeave" type="date" value="${esc(e?.leaveDate || '')}"></label><label class="sv2-field"><span>工资标准生效日</span><input id="sv2FormEffective" type="date" value="${esc(monthStart(currentMonth()))}"></label><label class="sv2-field"><span>身份证号</span><input id="sv2FormIdCard" value="${esc(e?.idCard || '')}" autocomplete="off"></label><label class="sv2-field"><span>银行卡号</span><input id="sv2FormBankCard" value="${esc(e?.bankCard || '')}" autocomplete="off"></label><label class="sv2-field"><span>开户行</span><input id="sv2FormBankName" value="${esc(e?.bankName || '')}"></label><label class="sv2-field full"><span>备注</span><textarea id="sv2FormNote">${esc(e?.note || '')}</textarea></label></div><div class="sv2-note" style="margin-top:14px">${isEdit ? '修改工资标准会新增一条生效记录，不覆盖历史标准。' : '新增员工后系统会生成个人访问码。'}</div>`;
    const drawer = openDrawer({ title: isEdit ? `编辑员工 · ${e.name}` : '新增员工', subtitle: '员工档案与工资标准', body, footer: '<button class="sv2-btn ghost" type="button" data-sv2-close>取消</button><button class="sv2-btn primary" type="button" id="sv2FormSave">保存</button>' }); state.drawerKind = 'employee-form';
    syncEmployeeFormSalaryFields(drawer); $('#sv2FormType', drawer).addEventListener('change', () => syncEmployeeFormSalaryFields(drawer));
    $('#sv2FormSave', drawer).addEventListener('click', async () => {
      const payload = employeePayloadFromForm(); if (!payload.employeeNo || !payload.name) { toast('工号和姓名必填', 'err'); return; } if (payload.salaryType !== 'hourly_piece') payload.track = 'fixed';
      const btn = $('#sv2FormSave', drawer); btn.disabled = true; btn.textContent = '保存中…';
      let result = await rpc('board_employee_save_v2', { p_payload: payload }); if (!result.ok && result.missing) result = await rpc('board_employee_save', { p_payload: payload });
      if (!result.ok) { toast(result.error || '保存失败', 'err'); btn.disabled = false; btn.textContent = '保存'; return; }
      const accessCode = result.data && (result.data.accessCode || result.data.access_code); closeDrawer(); await loadDirectory(true);
      if (accessCode) alert('员工已保存。\n访问码：' + accessCode + '\n请把这个访问码发给员工。'); else toast('员工档案已保存', 'ok');
      if (isEdit) openEmployeeDetail(payload.employeeNo).catch(() => {});
    });
  }
  async function resetEmployeeCode(e) {
    if (!e) return; if (!confirm(`要重置 ${e.name}（工号 ${e.employeeNo}）的访问码吗？旧访问码会立即失效。`)) return;
    const result = await rpc('board_employee_reset_code', { p_employee_no: e.employeeNo }); if (!result.ok) { toast(result.error || '重置失败', 'err'); return; }
    const code = result.data && (result.data.accessCode || result.data.access_code) || ''; if (code) alert('新访问码：' + code + '\n请把这个访问码发给员工。'); toast('访问码已重置', 'ok');
  }

  function openRateForm(e) {
    const body = `<div class="sv2-form-grid"><label class="sv2-field"><span>生效日期 *</span><input id="sv2RateFrom" type="date" value="${esc(monthStart(currentMonth()))}"></label><label class="sv2-field"><span>工资类型</span><select id="sv2RateType"><option value="daily" ${e.salaryType === 'daily' ? 'selected' : ''}>固定日薪</option><option value="hourly_piece" ${e.salaryType === 'hourly_piece' ? 'selected' : ''}>计时计件</option><option value="monthly" ${e.salaryType === 'monthly' ? 'selected' : ''}>固定月薪</option><option value="management" ${e.salaryType === 'management' ? 'selected' : ''}>管理（免考勤）</option></select></label><label class="sv2-field" data-sv2-rate-kind="daily"><span>日薪（元/天）</span><input id="sv2RateDaily" type="number" value="${esc(e.dailySalary ?? '')}"></label><label class="sv2-field" data-sv2-rate-kind="daily"><span>加班工资（元/天）</span><input id="sv2RateOvertime" type="number" value="${esc(e.overtimeRate ?? '')}"></label><label class="sv2-field" data-sv2-rate-kind="monthly"><span>月薪（元）</span><input id="sv2RateMonthly" type="number" value="${esc(e.monthlySalary ?? '')}"></label><label class="sv2-field" data-sv2-rate-kind="hourly"><span>计时时薪（元/小时）</span><input id="sv2RateHourly" type="number" value="${esc(e.hourlyRate ?? '')}"></label><label class="sv2-field full"><span>备注</span><input id="sv2RateNote" placeholder="如：2027 年调薪"></label></div>`;
    const drawer = openDrawer({ title: `调整工资标准 · ${e.name}`, subtitle: '新增生效记录，不覆盖历史', body, footer: '<button class="sv2-btn ghost" type="button" data-sv2-close>取消</button><button class="sv2-btn primary" type="button" id="sv2RateSave">保存标准</button>' }); state.drawerKind = 'rate-form';
    const sync = () => { const type = $('#sv2RateType', drawer).value; $$('[data-sv2-rate-kind]', drawer).forEach((el) => { const kind = el.dataset.sv2RateKind; el.hidden = kind === 'monthly' ? !(type === 'monthly' || type === 'management') : kind === 'daily' ? type !== 'daily' : type !== 'hourly_piece'; }); };
    sync(); $('#sv2RateType', drawer).addEventListener('change', sync);
    $('#sv2RateSave', drawer).addEventListener('click', async () => {
      const payload = { employeeNo: e.employeeNo, effectiveFrom: $('#sv2RateFrom', drawer).value || monthStart(currentMonth()), salaryType: $('#sv2RateType', drawer).value, dailySalary: $('#sv2RateDaily', drawer).value || null, overtimeRate: $('#sv2RateOvertime', drawer).value || null, monthlySalary: $('#sv2RateMonthly', drawer).value || null, hourlyRate: $('#sv2RateHourly', drawer).value || null, note: $('#sv2RateNote', drawer).value.trim() };
      const result = await rpc('board_employee_rate_add', { p_payload: payload });
      if (!result.ok) { toast(result.missing ? '工资标准历史表还没建，请先执行 staff-v2-schema.sql' : (result.error || '保存失败'), 'err'); return; }
      closeDrawer(); await loadDirectory(true); openEmployeeDetail(e.employeeNo).catch(() => {}); toast('工资标准已新增', 'ok');
    });
  }

  function renderPayrollShell() {
    const mount = document.getElementById('payrollMount'); if (!mount || state.payrollMounted) return; state.payrollMounted = true;
    mount.innerHTML = `<div class="sv2-page"><header class="sv2-head"><div class="sv2-head-main"><p class="sv2-eyebrow">月度结算</p><h1>工资</h1><p>按考勤、报工和有效工资标准生成月度快照；历史导入、自动计算和手工调整分开显示，不再互相覆盖。</p></div><div class="sv2-actions"><button class="sv2-btn" type="button" id="sv2PayRefresh">刷新</button><button class="sv2-btn primary" type="button" id="sv2PayRecalc">重算本月</button></div></header><section class="sv2-kpis" id="sv2PayKpis"></section><section class="sv2-panel"><div class="sv2-toolbar"><div class="sv2-monthbar"><button class="sv2-btn small" type="button" id="sv2PayPrev" aria-label="上个月">‹</button><label class="sv2-field"><span>工资月份</span><input id="sv2PayMonth" type="month"></label><button class="sv2-btn small" type="button" id="sv2PayNext" aria-label="下个月">›</button><button class="sv2-btn small ghost" type="button" id="sv2PayThisMonth">本月</button></div><label class="sv2-field grow"><span>搜索</span><input id="sv2PaySearch" type="search" placeholder="工号 / 姓名"></label><label class="sv2-field" style="width:150px"><span>工资类型</span><select id="sv2PayType"><option value="">全部类型</option><option value="daily">固定日薪</option><option value="hourly_piece">计时计件</option><option value="monthly">固定月薪</option><option value="management">管理</option></select></label><label class="sv2-field" style="width:150px"><span>数据来源</span><select id="sv2PaySource"><option value="all">全部来源</option><option value="auto">自动计算</option><option value="imported">历史导入</option><option value="manual">手工调整</option></select></label><label class="sv2-field" style="width:140px"><span>状态</span><select id="sv2PayStatus"><option value="all">全部</option><option value="review">待核对</option><option value="locked">已锁定</option><option value="paid">已发放</option><option value="anomaly">有异常</option></select></label><button class="sv2-btn" type="button" id="sv2PayExport">导出 Excel</button><button class="sv2-btn" type="button" id="sv2PayPrint">打印</button></div><div class="sv2-statusline" id="sv2PayStatusLine"></div><div class="sv2-table-wrap"><table class="sv2-table payroll-table"><thead><tr><th>工号</th><th>姓名</th><th>类型</th><th class="num">出勤</th><th class="num">基本</th><th class="num">加班</th><th class="num">计时</th><th class="num">计件</th><th class="num">调整</th><th class="num">应付合计</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody id="sv2PayBody"><tr><td colspan="13"><div class="sv2-skeleton"><b>正在读取工资</b><span>核对考勤、报工和历史导入…</span></div></td></tr></tbody></table><div id="sv2PayEmpty" class="sv2-empty" hidden></div></div></section></div>`;
    $('#sv2PayMonth').value = state.payrollMonth;
    $('#sv2PayRefresh').addEventListener('click', () => loadPayroll(state.payrollMonth).catch(() => {})); $('#sv2PayRecalc').addEventListener('click', recalcPayroll);
    $('#sv2PayPrev').addEventListener('click', () => changePayrollMonth(addMonth(state.payrollMonth, -1))); $('#sv2PayNext').addEventListener('click', () => changePayrollMonth(addMonth(state.payrollMonth, 1))); $('#sv2PayThisMonth').addEventListener('click', () => changePayrollMonth(currentMonth())); $('#sv2PayMonth').addEventListener('change', (e) => changePayrollMonth(e.target.value || currentMonth()));
    $('#sv2PaySearch').addEventListener('input', (e) => { state.payrollQuery = e.target.value; renderPayroll(); }); $('#sv2PayType').addEventListener('change', (e) => { state.payrollType = e.target.value; renderPayroll(); }); $('#sv2PaySource').addEventListener('change', (e) => { state.payrollSource = e.target.value; renderPayroll(); }); $('#sv2PayStatus').addEventListener('change', (e) => { state.payrollStatus = e.target.value; renderPayroll(); });
    $('#sv2PayExport').addEventListener('click', exportPayroll); $('#sv2PayPrint').addEventListener('click', () => window.print());
    $('#sv2PayBody').addEventListener('click', (event) => { const action = event.target.closest('[data-sv2-pay-action]'); const row = event.target.closest('tr[data-pay-key]'); if (action) { event.preventDefault(); event.stopPropagation(); if (action.dataset.sv2PayAction === 'detail') openPayrollDetail(action.dataset.payKey); else if (action.dataset.sv2PayAction === 'adjust') openAdjustmentForm(findPayrollRow(action.dataset.payKey)); return; } if (row) openPayrollDetail(row.dataset.payKey); });
  }
  function changePayrollMonth(month) { state.payrollMonth = month || currentMonth(); const input = $('#sv2PayMonth'); if (input) input.value = state.payrollMonth; loadPayroll(state.payrollMonth).catch(() => {}); }
  function calcAuto(e, att, work) {
    const days = Number(att && att.attendanceDays || 0); const overtimeDays = Number(att && att.overtimeDays || 0); const overtimePay = Number(att && att.overtimeDays || 0) * Number(e.overtimeRate || 0);
    if (e.salaryType === 'daily') { const basePay = Number(e.dailySalary || 0) * days; return { attendanceDays: days, overtimeDays, basePay, overtimePay, timerMinutes: 0, timerPay: 0, pieceCount: 0, pieceQty: 0, piecePay: 0, adjustmentTotal: 0, grossPay: basePay + overtimePay, anomalies: [] }; }
    if (e.salaryType === 'monthly' || e.salaryType === 'management') return { attendanceDays: days, overtimeDays: 0, basePay: Number(e.monthlySalary || 0), overtimePay: 0, timerMinutes: 0, timerPay: 0, pieceCount: 0, pieceQty: 0, piecePay: 0, adjustmentTotal: 0, grossPay: Number(e.monthlySalary || 0), anomalies: [] };
    const timerPay = Number(work && work.timerPay || 0); const piecePay = Number(work && work.piecePay || 0); const anomalies = Number(work && work.pendingCount || 0) ? [`有 ${work.pendingCount} 笔计件待审核`] : [];
    return { attendanceDays: days, overtimeDays: 0, basePay: 0, overtimePay: 0, timerMinutes: Number(work && work.timerMinutes || 0), timerPay, pieceCount: Number(work && work.pieceCount || 0), pieceQty: Number(work && work.pieceQty || 0), piecePay, adjustmentTotal: 0, grossPay: timerPay + piecePay, anomalies };
  }

  async function loadPayroll(month = state.payrollMonth) {
    renderPayrollShell(); state.payrollMonth = month || currentMonth(); const input = $('#sv2PayMonth'); if (input) input.value = state.payrollMonth; const seq = ++state.payrollSeq; state.payrollLoading = true; renderPayrollLoading();
    const result = await rpc('board_payroll_preview', { p_month: monthStart(state.payrollMonth) });
    if (seq !== state.payrollSeq) return;
    if (result.ok) { const payload = result.data || {}; state.period = payload.period || { monthStart: monthStart(state.payrollMonth), status: 'draft' }; state.payrollRows = (payload.rows || []).map(normalizePayrollRow); state.schemaMissing = false; state.fallbackReason = ''; }
    else if (result.missing) { await loadPayrollFallback(result.error || '', seq); if (seq !== state.payrollSeq) return; }
    else { state.payrollRows = []; state.period = { monthStart: monthStart(state.payrollMonth), status: 'draft' }; state.fallbackReason = result.error || '工资读取失败'; toast(state.fallbackReason, 'err'); }
    state.payrollLoading = false; renderPayroll();
  }
  async function loadPayrollFallback(reason, seq = state.payrollSeq) {
    await ensureEmployees(); const from = monthStart(state.payrollMonth); const to = monthEnd(state.payrollMonth);
    const [attResult, workResult, importedResult] = await Promise.all([rpc('board_attendance_summary', { p_from: from, p_to: to }), rpc('work_admin_month_overview', { p_month: from }), rpc('board_payroll_list', { p_month: from })]);
    const attMap = new Map(((attResult.ok && attResult.data && attResult.data.summary) || []).map((r) => [String(r.employeeNo), r]));
    const workMap = new Map(((workResult.ok && Array.isArray(workResult.data)) ? workResult.data : []).map((r) => [String(r.employeeNo), r]));
    const imported = importedResult.ok && importedResult.data && Array.isArray(importedResult.data.rows) ? importedResult.data.rows : [];
    const importedByNo = new Map(); const importedByName = new Map();
    for (const row of imported) { if (row.employeeNo) importedByNo.set(String(row.employeeNo), row); if (row.employeeName) importedByName.set(String(row.employeeName), row); }
    const rows = [];
    for (const e of state.employees.filter((x) => x.active !== false && x.employmentStatus !== 'resigned')) {
      const auto = calcAuto(e, attMap.get(String(e.employeeNo)), workMap.get(String(e.employeeNo))); const importRow = importedByNo.get(String(e.employeeNo)) || importedByName.get(e.name) || null; const anomalies = [...auto.anomalies];
      if (!e.salaryType) anomalies.push('缺工资类型'); if (e.salaryType === 'daily' && (e.dailySalary == null || e.dailySalary === '')) anomalies.push('缺日薪'); if ((e.salaryType === 'monthly' || e.salaryType === 'management') && (e.monthlySalary == null || e.monthlySalary === '')) anomalies.push('缺月薪'); if (e.salaryType === 'hourly_piece' && (e.hourlyRate == null || e.hourlyRate === '')) anomalies.push('缺时薪'); if (importRow && !auto.grossPay) anomalies.push('有历史导入，也有自动预览');
      const source = importRow ? 'imported' : 'auto'; const gross = importRow ? Number(importRow.totalSalary || 0) : auto.grossPay;
      rows.push(normalizePayrollRow({ key: `${e.employeeNo}|${source}`, employeeNo: e.employeeNo, employeeName: e.name, salaryType: importRow && importRow.salaryType || e.salaryType, ...auto, grossPay: gross, source, status: importRow ? 'imported' : 'review', imported: importRow, autoPreview: auto, note: importRow && importRow.note || '', anomalies }));
    }
    for (const row of imported) { const rowNo = String(row.employeeNo || '').trim(); const rowName = String(row.employeeName || '').trim(); if (rows.some((r) => (rowNo && String(r.employeeNo || '').trim() === rowNo) || (rowName && String(r.employeeName || '').trim() === rowName))) continue; rows.push(normalizePayrollRow({ key: `imported|${row.id || rowNo || rowName}`, employeeNo: rowNo, employeeName: rowName, salaryType: row.salaryType, attendanceDays: row.attendanceDays, overtimeDays: row.overtimeDays, basePay: Number(row.monthlySalary || 0), overtimePay: Number(row.overtimeDays || 0) * Number(row.overtimeRate || 0), timerPay: 0, piecePay: row.pieceSalary || 0, adjustmentTotal: 0, grossPay: row.totalSalary || 0, source: 'imported', status: 'imported', imported: row, autoPreview: null, anomalies: ['历史导入员工不在当前在职名单'] })); }
    if (seq !== state.payrollSeq) return;
    state.payrollRows = rows; state.period = { monthStart: from, status: imported.length ? 'review' : 'draft', importedCount: imported.length }; state.schemaMissing = true; state.fallbackReason = reason || '当前使用兼容预览';
  }
  function normalizePayrollRow(raw) {
    const employeeNo = String(raw.employeeNo ?? raw.employee_no ?? '').trim(); const employeeName = String(raw.employeeName ?? raw.employee_name ?? raw.name ?? '').trim(); const source = String(raw.source || (raw.status === 'imported' ? 'imported' : 'auto'));
    return { ...raw, key: String(raw.key || `${employeeNo}|${source}`), employeeNo, employeeName, source, salaryType: String(raw.salaryType || raw.salary_type || ''), attendanceDays: Number(raw.attendanceDays || 0), overtimeDays: Number(raw.overtimeDays || 0), basePay: Number(raw.basePay || 0), overtimePay: Number(raw.overtimePay || 0), timerMinutes: Number(raw.timerMinutes || 0), timerPay: Number(raw.timerPay || 0), pieceCount: Number(raw.pieceCount || 0), pieceQty: Number(raw.pieceQty || 0), piecePay: Number(raw.piecePay || 0), adjustmentTotal: Number(raw.adjustmentTotal || 0), grossPay: Number(raw.grossPay ?? raw.totalSalary ?? 0), status: String(raw.status || 'review'), anomalies: Array.isArray(raw.anomalies) ? raw.anomalies : [] };
  }
  function filteredPayroll() {
    const q = state.payrollQuery.trim().toLowerCase();
    return state.payrollRows.filter((r) => { if (state.payrollType && r.salaryType !== state.payrollType) return false; if (state.payrollSource !== 'all' && r.source !== state.payrollSource) return false; if (state.payrollStatus === 'anomaly' && !r.anomalies.length) return false; if (state.payrollStatus !== 'all' && state.payrollStatus !== 'anomaly' && r.status !== state.payrollStatus) return false; if (q && ![r.employeeNo, r.employeeName].some((v) => String(v || '').toLowerCase().includes(q))) return false; return true; });
  }
  function renderPayrollLoading() { const body = $('#sv2PayBody'); if (body) body.innerHTML = '<tr><td colspan="13"><div class="sv2-skeleton"><b>正在读取工资</b><span>核对考勤、报工和历史导入…</span></div></td></tr>'; const empty = $('#sv2PayEmpty'); if (empty) empty.hidden = true; }

  function renderPayroll() {
    renderPayrollShell();
    const rows = filteredPayroll(); const total = rows.reduce((s, r) => s + Number(r.grossPay || 0), 0); const locked = rows.filter((r) => r.status === 'locked' || r.status === 'paid').reduce((s, r) => s + Number(r.grossPay || 0), 0); const review = rows.filter((r) => r.status === 'review' || r.status === 'imported').length; const anomalies = rows.filter((r) => r.anomalies.length).length;
    const kpis = $('#sv2PayKpis');
    if (kpis) kpis.innerHTML = `<article class="sv2-kpi"><span>工资合计</span><strong>${money(total)}</strong><small>${esc(state.payrollMonth)} · 当前筛选</small></article><article class="sv2-kpi"><span>已锁定 / 已发放</span><strong>${money(locked)}</strong><small>不可直接修改</small></article><article class="sv2-kpi"><span>待核对</span><strong>${num(review)}</strong><small>人 · 自动计算或历史导入</small></article><article class="sv2-kpi${anomalies ? ' hot' : ''}"><span>有异常</span><strong>${num(anomalies)}</strong><small>人 · 建议先处理</small></article>`;
    const statusLine = $('#sv2PayStatusLine');
    if (statusLine) {
      const status = state.period && state.period.status || 'draft';
      const hasSnapshot = Boolean(state.period && state.period.id);
      const sourceText = state.schemaMissing ? '兼容预览' : hasSnapshot ? '工资快照' : '实时预览（未生成快照）';
      const hintText = state.schemaMissing
        ? '执行 staff-v2-schema.sql 后可锁定、调整和留痕。'
        : hasSnapshot
          ? '锁定后禁止直接修改，解锁需填写原因。'
          : '当前为实时预览；点“重算本月”生成快照后才能锁定、调整和发放。';
      const disabled = hasSnapshot ? '' : ' disabled';
      statusLine.innerHTML = `<span>月份状态 <strong>${esc(STATUS_TEXT[status] || status)}</strong></span><span>数据来源 <strong>${sourceText}</strong></span><span>${hintText}</span><span style="margin-left:auto"></span><button class="sv2-btn small" type="button" data-sv2-period="review"${disabled}>标记待核对</button><button class="sv2-btn small primary" type="button" data-sv2-period="locked"${disabled}>锁定工资</button><button class="sv2-btn small" type="button" data-sv2-period="paid"${disabled}>标记发放</button><button class="sv2-btn small warn" type="button" data-sv2-period="unlock"${disabled}>解锁</button>`;
      $$('[data-sv2-period]', statusLine).forEach((btn) => btn.addEventListener('click', () => payrollPeriodAction(btn.dataset.sv2Period)));
    }
    const body = $('#sv2PayBody');
    if (body) body.innerHTML = rows.map((r) => `<tr data-pay-key="${esc(r.key)}"><td class="mono">${esc(r.employeeNo || '—')}</td><td><div class="sv2-cell-strong"><span class="sv2-avatar">${esc(String(r.employeeName || '?').slice(0, 1))}</span><span><b>${esc(r.employeeName || '—')}</b>${r.anomalies.length ? `<small><span class="sv2-anomaly">${esc(r.anomalies[0])}</span></small>` : ''}</span></div></td><td><span class="sv2-pill ${typeClass(r.salaryType)}">${esc(typeText(r.salaryType))}</span></td><td class="num">${r.salaryType === 'hourly_piece' ? '—' : num(r.attendanceDays)}</td><td class="money">${money(r.basePay)}</td><td class="money">${money(r.overtimePay)}</td><td class="money">${money(r.timerPay)}</td><td class="money">${money(r.piecePay)}</td><td class="money">${money(r.adjustmentTotal)}</td><td class="money">${money(r.grossPay)}</td><td><span class="sv2-pill ${esc(r.source)}">${esc(r.source === 'imported' ? '历史导入' : r.source === 'manual' ? '手工调整' : '自动计算')}</span></td><td><span class="sv2-pill ${esc(r.status)}">${esc(STATUS_TEXT[r.status] || r.status)}</span></td><td><div class="sv2-row-actions"><button class="sv2-btn small" type="button" data-sv2-pay-action="detail" data-pay-key="${esc(r.key)}">明细</button><button class="sv2-btn small ghost" type="button" data-sv2-pay-action="adjust" data-pay-key="${esc(r.key)}">调整</button></div></td></tr>`).join('');
    const empty = $('#sv2PayEmpty'); if (empty) { empty.hidden = rows.length > 0; empty.innerHTML = '<b>这个筛选下没有工资数据</b>换个条件试试。'; }
  }
  function findPayrollRow(key) { return state.payrollRows.find((r) => String(r.key) === String(key)); }

  function openPayrollDetail(key) {
    const r = findPayrollRow(key); if (!r) return; const auto = r.autoPreview || (r.source === 'auto' ? r : null); const imported = r.imported || null; const adjustments = Array.isArray(r.adjustments) ? r.adjustments : [];
    const body = `<div class="sv2-money-summary"><article><span>基本工资</span><strong>${money(r.basePay)}</strong></article><article><span>加班 / 计时 / 计件</span><strong>${money(r.overtimePay + r.timerPay + r.piecePay)}</strong></article><article class="total"><span>应付合计</span><strong>${money(r.grossPay)}</strong></article></div>${r.anomalies.length ? `<div class="sv2-note danger"><b>需要核对：</b>${r.anomalies.map(esc).join('；')}</div>` : ''}<div class="sv2-section-title">计算依据</div>${(r.salaryType === 'monthly' || r.salaryType === 'management') ? '<div class="sv2-note ok">固定月薪：请假或缺勤暂不影响本月工资。</div>' : r.salaryType === 'daily' ? '<div class="sv2-note">加班按 3 小时计，金额取员工档案中的加班单价，不按分钟折算。</div>' : ''}${detailGrid([['工资类型', esc(typeText(r.salaryType))], ['出勤天数', num(r.attendanceDays)], ['加班天数', num(r.overtimeDays)], ['加班费', money(r.overtimePay)], ['计时工时', (Number(r.timerMinutes || 0) / 60).toFixed(2) + ' 小时'], ['计时工资', money(r.timerPay)], ['已审核计件', `${num(r.pieceCount)} 笔 · ${num(r.pieceQty)} 件`], ['计件工资', money(r.piecePay)], ['调整金额', money(r.adjustmentTotal)], ['数据来源', r.source === 'imported' ? '历史导入' : r.source === 'manual' ? '手工调整' : '自动计算']])}${auto && r.source === 'imported' ? `<div class="sv2-section-title">自动预览（仅供核对）</div>${detailGrid([['自动计算应付', money(auto.grossPay)], ['计时工资', money(auto.timerPay)], ['计件工资', money(auto.piecePay)], ['考勤出勤', num(auto.attendanceDays)]])}` : ''}${imported ? `<div class="sv2-section-title">历史导入</div>${detailGrid([['导入合计', money(imported.totalSalary)], ['备注', esc(imported.note || '—'), true]])}` : ''}<div class="sv2-section-title">调整项</div>${adjustments.length ? `<div class="sv2-adjust-list">${adjustments.map((a) => `<div class="sv2-adjust"><span class="reason">${esc(a.reason || '')}</span><span class="muted">${esc(a.kind || '')}</span><span class="amount ${Number(a.amount) < 0 ? 'neg' : ''}">${money(a.amount)}</span></div>`).join('')}</div>` : '<div class="sv2-empty"><b>没有调整项</b>如需补发或扣款，使用下方“新增调整”。</div>'}<div style="margin-top:14px"><button class="sv2-btn" type="button" id="sv2PayAddAdjust">新增调整</button></div>`;
    const drawer = openDrawer({ title: `${r.employeeName} · ${state.payrollMonth} 工资明细`, subtitle: `${r.employeeNo || '无工号'} · ${typeText(r.salaryType)} · ${STATUS_TEXT[r.status] || r.status}`, body, footer: '<button class="sv2-btn ghost" type="button" data-sv2-close>关闭</button><button class="sv2-btn primary" type="button" id="sv2PayDetailPrint">打印工资条</button>' }); state.drawerKind = 'payroll-detail';
    $('#sv2PayAddAdjust', drawer)?.addEventListener('click', () => openAdjustmentForm(r)); $('#sv2PayDetailPrint', drawer)?.addEventListener('click', () => window.print());
  }
  function openAdjustmentForm(row) {
    if (!row) return; if (row.status === 'locked' || row.status === 'paid') { toast('工资已锁定，请先解锁再调整', 'err'); return; }
    const body = `<div class="sv2-form-grid"><label class="sv2-field"><span>调整类型</span><select id="sv2AdjKind"><option value="bonus">补发 / 奖励</option><option value="deduction">扣款</option><option value="correction">修正</option></select></label><label class="sv2-field"><span>金额（元）*</span><input id="sv2AdjAmount" type="number" step="0.01" placeholder="扣款填负数"></label><label class="sv2-field full"><span>原因 *</span><input id="sv2AdjReason" placeholder="必须填写，如：8月漏计一件"></label></div><div class="sv2-note" style="margin-top:12px">调整会写入工资明细并留痕，不能直接改总工资。</div>`;
    const drawer = openDrawer({ title: `新增调整 · ${row.employeeName}`, subtitle: `${state.payrollMonth} · 当前应付 ${money(row.grossPay)}`, body, footer: '<button class="sv2-btn ghost" type="button" data-sv2-close>取消</button><button class="sv2-btn primary" type="button" id="sv2AdjSave">保存调整</button>' }); state.drawerKind = 'adjustment';
    $('#sv2AdjSave', drawer).addEventListener('click', async () => {
      const amount = Number($('#sv2AdjAmount', drawer).value || 0); const reason = $('#sv2AdjReason', drawer).value.trim(); if (!amount) { toast('金额不能为 0', 'err'); return; } if (!reason) { toast('请填写调整原因', 'err'); return; }
      const result = await rpc('board_payroll_adjustment_add', { p_payload: { lineId: row.lineId || null, employeeNo: row.employeeNo, monthStart: monthStart(state.payrollMonth), kind: $('#sv2AdjKind', drawer).value, amount, reason } });
      if (!result.ok) { toast(result.missing ? '工资调整表还没建，请先执行 staff-v2-schema.sql' : (result.error || '保存失败'), 'err'); return; }
      closeDrawer(); await loadPayroll(state.payrollMonth); toast('调整已保存', 'ok');
    });
  }

  async function recalcPayroll() {
    if (state.schemaMissing) { toast('当前是兼容预览。执行 staff-v2-schema.sql 后才能生成工资快照', 'err'); return; }
    const result = await rpc('board_payroll_generate', { p_month: monthStart(state.payrollMonth) }); if (!result.ok) { toast(result.error || '重算失败', 'err'); return; }
    await loadPayroll(state.payrollMonth); toast('工资快照已重算', 'ok');
  }
  async function payrollPeriodAction(action) {
    if (state.schemaMissing) { toast('请先执行 staff-v2-schema.sql，再使用工资锁定和状态流转', 'err'); return; }
    if (action === 'unlock') { const reason = prompt('解锁工资必须填写原因（至少 2 个字）：', ''); if (!reason || reason.trim().length < 2) return; const result = await rpc('board_payroll_unlock', { p_month: monthStart(state.payrollMonth), p_reason: reason.trim() }); if (!result.ok) { toast(result.error || '解锁失败', 'err'); return; } await loadPayroll(state.payrollMonth); toast('工资已解锁', 'ok'); return; }
    const result = await rpc('board_payroll_set_status', { p_month: monthStart(state.payrollMonth), p_status: action, p_note: '' }); if (!result.ok) { toast(result.error || '状态更新失败', 'err'); return; }
    await loadPayroll(state.payrollMonth); toast('工资状态已更新', 'ok');
  }
  function switchToPayroll(no) { const link = document.getElementById('desktopPayrollLink'); if (link) link.click(); setTimeout(() => { state.payrollQuery = String(no || ''); const input = $('#sv2PaySearch'); if (input) input.value = state.payrollQuery; renderPayroll(); }, 320); }
  async function exportPayroll() {
    const rows = filteredPayroll(); const lines = [['工号', '姓名', '工资类型', '出勤天数', '基本工资', '加班费', '计时工资', '计件工资', '调整金额', '应付合计', '数据来源', '状态'], ...rows.map((r) => [r.employeeNo, r.employeeName, typeText(r.salaryType), r.attendanceDays, r.basePay, r.overtimePay, r.timerPay, r.piecePay, r.adjustmentTotal, r.grossPay, r.source === 'imported' ? '历史导入' : r.source === 'manual' ? '手工调整' : '自动计算', STATUS_TEXT[r.status] || r.status])];
    try {
      if (!window.XLSX) await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; script.onload = () => window.XLSX ? resolve() : reject(new Error('Excel 组件未就绪')); script.onerror = () => reject(new Error('Excel 组件加载失败')); document.head.appendChild(script); });
      const ws = window.XLSX.utils.aoa_to_sheet(lines); const wb = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(wb, ws, '工资表'); window.XLSX.writeFile(wb, `工资表_${state.payrollMonth}.xlsx`); toast('Excel 已导出', 'ok');
    } catch {
      const csv = '\ufeff' + lines.map((line) => line.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n'); const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `工资表_${state.payrollMonth}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Excel 组件未加载，已改用 CSV 导出', '');
    }
  }

  function mountAll() { if (!isAdmin()) return; renderEmployeeShell(); renderPayrollShell(); loadDirectory().catch(() => {}); loadPayroll(state.payrollMonth).catch(() => {}); }
  function watchViews() {
    const staffView = document.getElementById('desktopStaffInfoView'); const payrollView = document.getElementById('desktopPayrollView'); if (!staffView || !payrollView) return;
    let lastStaff = staffView.hidden; let lastPayroll = payrollView.hidden;
    const observer = new MutationObserver(() => { if (lastStaff && !staffView.hidden && isAdmin()) loadDirectory().catch(() => {}); if (lastPayroll && !payrollView.hidden && isAdmin()) loadPayroll(state.payrollMonth).catch(() => {}); lastStaff = staffView.hidden; lastPayroll = payrollView.hidden; });
    observer.observe(staffView, { attributes: true, attributeFilter: ['hidden'] }); observer.observe(payrollView, { attributes: true, attributeFilter: ['hidden'] });
  }
function openHashView() {
    const hash = String(location.hash || '').replace('#', '');
    const staffNo = String(new URLSearchParams(location.search).get('staff_no') || '').trim();
    if (hash === 'staff-info') {
      document.getElementById('desktopStaffInfoLink')?.click();
      if (staffNo) ensureEmployees().then(() => openEmployeeDetail(staffNo)).catch(() => {});
    } else if (hash === 'payroll') document.getElementById('desktopPayrollLink')?.click();
  }
  function boot() {
    if (isAdmin()) mountAll();
    watchViews();
    const observer = new MutationObserver(() => { if (isAdmin()) { mountAll(); observer.disconnect(); } });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-board-role'] });
    setTimeout(() => { if (isAdmin()) openHashView(); }, 1400);
    window.addEventListener('hashchange', openHashView);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
