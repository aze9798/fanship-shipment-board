/* 员工信息与工资：独立管理员页面，复用现有员工/考勤/报工 RPC。 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const RPC_BASE = String(window.SHIPMENT_RPC_BASE || '').replace(/\/+$/, '');
  const state = {
    code: '', employees: [], att: new Map(), work: new Map(),
    tab: 'info', month: currentMonth(), employeeSearch: '', employeeType: '', employeeStatus: 'active',
    payrollSearch: '', payrollType: '', editEmployee: null, payrollSource: 'auto', imported: []
  };
  let toastTimer = 0;
  const EMBED = new URLSearchParams(location.search).get('embed') || '';

  function currentMonth() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  }
  function monthBounds(month) {
    const [y, m] = String(month || currentMonth()).split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v || 0).toLocaleString('zh-CN');
  const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const typeText = (t) => ({ daily: '固定日薪', hourly_piece: '计时计件', monthly: '固定月薪', management: '管理（免考勤）' }[t] || t || '未设置');
  const typeClass = (t) => ({ daily: 'daily', hourly_piece: 'hourly', monthly: 'monthly', management: 'management' }[t] || '');

  function toast(text, isError = false) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }

  async function rpc(name, body) {
    if (!RPC_BASE) throw new Error('系统接口未配置');
    const headers = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) {
      headers.apikey = window.SHIPMENT_ANON_KEY;
      headers.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY;
    }
    const res = await fetch(RPC_BASE + '/' + name, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.message || data?.error || data?.details || `请求失败（${res.status}）`);
    return data;
  }

  function storedCode() {
    const q = new URLSearchParams(location.search).get('code') || '';
    try { return q || localStorage.getItem('shipmentBoardAccessCode:admin') || localStorage.getItem('shipmentBoardAccessCode') || ''; }
    catch { return q; }
  }
  function storeCode(code) {
    try {
      localStorage.setItem('shipmentBoardAccessCode:admin', code);
      localStorage.setItem('shipmentBoardRole:admin', 'admin');
    } catch { }
  }
  function showLogin(message = '') {
    $('#loginGate').hidden = false;
    $('#staffApp').hidden = true;
    $('#refreshButton').hidden = true;
    $('#switchCodeButton').hidden = true;
    const err = $('#loginError');
    err.textContent = message;
    err.style.display = message ? 'block' : 'none';
    $('#accessCodeInput').focus();
  }
  async function login(code) {
    code = String(code || '').trim();
    if (!code) throw new Error('请输入管理访问码');
    const data = await rpc('board_employee_list', { p_code: code });
    if (!data || !Array.isArray(data.employees)) throw new Error('访问码无效');
    state.code = code;
    storeCode(code);
    const url = new URL(location.href);
    if (url.searchParams.has('code')) { url.searchParams.delete('code'); history.replaceState(null, '', url); }
    $('#loginGate').hidden = true;
    $('#staffApp').hidden = false;
    $('#refreshButton').hidden = false;
    $('#switchCodeButton').hidden = false;
    await refreshAll();
    applyEmbedTab();
  }
  function applyEmbedTab() {
    if (!EMBED) return;
    const tab = EMBED === 'payroll' ? 'payroll' : 'info';
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    $('#infoTab').hidden = tab !== 'info';
    $('#payrollTab').hidden = tab !== 'payroll';
    if (tab === 'payroll') renderPayroll();
  }

  async function loadEmployees() {
    const data = await rpc('board_employee_list', { p_code: state.code });
    state.employees = (data.employees || []).slice().sort((a, b) => {
      const na = Number(String(a.employeeNo || '').replace(/\D/g, '')) || 999999;
      const nb = Number(String(b.employeeNo || '').replace(/\D/g, '')) || 999999;
      return na - nb || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
  }
  async function loadPayroll(month = state.month) {
    const { from, to } = monthBounds(month);
    const [attRes, workRes] = await Promise.all([
      rpc('board_attendance_summary', { p_code: state.code, p_from: from, p_to: to }),
      rpc('work_admin_month_overview', { p_code: state.code, p_month: from })
    ]);
    state.att = new Map((attRes.summary || []).map((r) => [String(r.employeeNo), r]));
    state.work = new Map((workRes || []).map((r) => [String(r.employeeNo), r]));
    state.month = month;
    let imported = [];
    try {
      const importedRes = await rpc('board_payroll_list', { p_code: state.code, p_month: from });
      imported = Array.isArray(importedRes?.rows) ? importedRes.rows : [];
    } catch { imported = []; }
    state.imported = imported;
    state.payrollSource = imported.length ? 'imported' : 'auto';
  }
  async function refreshAll() {
    try {
      await loadEmployees();
      await loadPayroll(state.month);
      renderAll();
    } catch (error) {
      toast(error.message || '数据加载失败', true);
    }
  }
  function renderAll() {
    renderEmployeeSummary();
    renderEmployees();
    renderPayroll();
    $('#payrollMonth').value = state.month;
    $('#payrollSource').value = state.payrollSource;
  }

  function filteredEmployees() {
    const q = state.employeeSearch.trim().toLowerCase();
    return state.employees.filter((e) => {
      const active = e.active !== false && e.employmentStatus !== 'resigned';
      if (state.employeeStatus === 'active' && !active) return false;
      if (state.employeeStatus === 'resigned' && active) return false;
      if (state.employeeType && e.salaryType !== state.employeeType) return false;
      if (!q) return true;
      return [e.employeeNo, e.name, e.phone, e.department, e.deliAccount].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }
  function renderEmployeeSummary() {
    const active = state.employees.filter((e) => e.active !== false && e.employmentStatus !== 'resigned');
    const c = { daily: 0, hourly_piece: 0, monthly: 0, management: 0 };
    for (const e of active) if (c[e.salaryType] != null) c[e.salaryType] += 1;
    $('#employeeSummary').innerHTML =
      `<article class="stat"><span>员工总数</span><strong>${num(state.employees.length)}</strong><small>全部档案</small></article>
       <article class="stat"><span>在职</span><strong>${num(active.length)}</strong><small>可参与工资计算</small></article>
       <article class="stat"><span>固定日薪</span><strong>${num(c.daily)}</strong><small>日薪 + 加班天</small></article>
       <article class="stat"><span>计时计件</span><strong>${num(c.hourly_piece)}</strong><small>报工自动汇总</small></article>`;
  }
  function renderEmployees() {
    const rows = filteredEmployees();
    const tbody = $('#employeeRows');
    tbody.innerHTML = rows.map((e) => {
      const active = e.active !== false && e.employmentStatus !== 'resigned';
      return `<tr>
        <td class="mono">${esc(e.employeeNo)}</td><td><strong>${esc(e.name)}</strong></td>
        <td><span class="tag ${typeClass(e.salaryType)}">${esc(typeText(e.salaryType))}</span></td>
        <td class="num">${e.salaryType === 'daily' ? money(e.dailySalary) : '—'}</td>
        <td class="num">${e.salaryType === 'daily' ? money(e.overtimeRate) : '—'}</td>
        <td class="num">${(e.salaryType === 'monthly' || e.salaryType === 'management') ? money(e.monthlySalary) : '—'}</td>
        <td class="num">${e.salaryType === 'hourly_piece' ? money(e.hourlyRate) : '—'}</td>
        <td>${esc(e.phone || '—')}</td><td>${esc(e.department || '—')}</td>
        <td><span class="tag ${active ? '' : 'off'}">${active ? '在职' : '离职'}</span></td>
        <td><button class="btn small" type="button" data-edit-employee="${esc(e.employeeNo)}">编辑</button></td>
      </tr>`;
    }).join('');
    $('#employeeEmpty').hidden = rows.length > 0;
    tbody.querySelectorAll('[data-edit-employee]').forEach((b) => b.addEventListener('click', () => openEmployeeModal(b.dataset.editEmployee)));
  }

  function payrollRows() {
    const q = state.payrollSearch.trim().toLowerCase();
    return state.employees
      .filter((e) => e.active !== false && e.employmentStatus !== 'resigned')
      .filter((e) => !state.payrollType || e.salaryType === state.payrollType)
      .filter((e) => !q || [e.employeeNo, e.name].some((v) => String(v || '').toLowerCase().includes(q)))
      .map((e) => ({ e, att: state.att.get(String(e.employeeNo)) || null, work: state.work.get(String(e.employeeNo)) || null }))
      .map((row) => ({ ...row, calc: calcPayroll(row.e, row.att, row.work) }));
  }
  function calcPayroll(e, att, work) {
    if (e.salaryType === 'daily') {
      const days = Number(att?.attendanceDays || 0);
      const otDays = Number(att?.overtimeDays || 0);
      const base = Number(e.dailySalary || 0) * days;
      const overtime = Number(att?.overtimeAmount || 0);
      return { days, otDays, base, overtime, timerPay: 0, piecePay: 0, total: base + overtime, pending: 0 };
    }
    if (e.salaryType === 'monthly' || e.salaryType === 'management') {
      return { days: Number(att?.attendanceDays || 0), otDays: 0, base: Number(e.monthlySalary || 0), overtime: 0, timerPay: 0, piecePay: 0, total: Number(e.monthlySalary || 0), pending: 0 };
    }
    const timerPay = Number(work?.timerPay || 0);
    const piecePay = Number(work?.piecePay || 0);
    return {
      days: Number(att?.attendanceDays || 0), otDays: 0, base: 0, overtime: 0,
      timerPay, piecePay, total: timerPay + piecePay,
      timerMinutes: Number(work?.timerMinutes || 0), pieceQty: Number(work?.pieceQty || 0),
      pieceCount: Number(work?.pieceCount || 0), pending: Number(work?.pendingCount || 0)
    };
  }
  function importedPayrollRows() {
    const q = state.payrollSearch.trim().toLowerCase();
    return state.imported
      .filter((r) => !state.payrollType || r.salaryType === state.payrollType)
      .filter((r) => !q || [r.employeeNo, r.employeeName].some((v) => String(v || '').toLowerCase().includes(q)));
  }
  function renderImportedPayroll() {
    const rows = importedPayrollRows();
    const total = rows.reduce((s, r) => s + Number(r.totalSalary || 0), 0);
    const dailyTotal = rows.filter((r) => r.salaryType === 'daily').reduce((s, r) => s + Number(r.totalSalary || 0), 0);
    const monthlyTotal = rows.filter((r) => r.salaryType === 'monthly' || r.salaryType === 'management').reduce((s, r) => s + Number(r.totalSalary || 0), 0);
    const pieceTotal = rows.filter((r) => r.salaryType === 'hourly_piece').reduce((s, r) => s + Number(r.totalSalary || 0), 0);
    $('#payrollSummary').innerHTML =
      `<article class="stat"><span>本月工资合计</span><strong>${money(total)}</strong><small>${esc(state.month)} · 历史导入</small></article>
       <article class="stat"><span>固定日薪合计</span><strong>${money(dailyTotal)}</strong><small>导入快照</small></article>
       <article class="stat"><span>固定月薪合计</span><strong>${money(monthlyTotal)}</strong><small>含管理岗</small></article>
       <article class="stat"><span>计时计件合计</span><strong>${money(pieceTotal)}</strong><small>导入快照</small></article>`;
    const tbody = $('#payrollRows');
    tbody.innerHTML = rows.map((r) => `<tr>
      <td class="mono">${esc(r.employeeNo || '—')}</td><td><strong>${esc(r.employeeName)}</strong></td>
      <td><span class="tag ${typeClass(r.salaryType)}">${esc(typeText(r.salaryType))}</span></td>
      <td class="num">${r.salaryType === 'hourly_piece' ? '—' : num(r.attendanceDays)}</td>
      <td class="num">${r.salaryType === 'daily' ? money(r.dailySalary) : '—'}</td>
      <td class="num">${r.salaryType === 'daily' ? num(r.overtimeDays) : '—'}</td>
      <td class="num">${r.salaryType === 'daily' ? money(Number(r.overtimeDays || 0) * Number(r.overtimeRate || 0)) : '—'}</td>
      <td class="num">${(r.salaryType === 'monthly' || r.salaryType === 'management') ? money(r.monthlySalary) : '—'}</td>
      <td class="num">${r.salaryType === 'hourly_piece' ? money(r.pieceSalary) : '—'}</td>
      <td class="num"><strong>${money(r.totalSalary)}</strong></td>
      <td><button class="btn small" type="button" data-import-edit="${esc(r.id)}">编辑导入</button></td>
    </tr>`).join('');
    $('#payrollEmpty').hidden = rows.length > 0;
    tbody.querySelectorAll('[data-import-edit]').forEach((b) => b.addEventListener('click', () => openImportPayrollModal(b.dataset.importEdit)));
  }
  function renderPayroll() {
    $('#payrollSource').value = state.payrollSource;
    if (state.payrollSource === 'imported' && state.imported.length) return renderImportedPayroll();
    const rows = payrollRows();
    const total = rows.reduce((s, r) => s + Number(r.calc.total || 0), 0);
    const dailyTotal = rows.filter((r) => r.e.salaryType === 'daily').reduce((s, r) => s + Number(r.calc.total || 0), 0);
    const monthlyTotal = rows.filter((r) => r.e.salaryType === 'monthly' || r.e.salaryType === 'management').reduce((s, r) => s + Number(r.calc.total || 0), 0);
    const pieceTotal = rows.filter((r) => r.e.salaryType === 'hourly_piece').reduce((s, r) => s + Number(r.calc.total || 0), 0);
    $('#payrollSummary').innerHTML =
      `<article class="stat"><span>本月工资合计</span><strong>${money(total)}</strong><small>${esc(state.month)}</small></article>
       <article class="stat"><span>固定日薪合计</span><strong>${money(dailyTotal)}</strong><small>日薪 + 加班费</small></article>
       <article class="stat"><span>固定月薪合计</span><strong>${money(monthlyTotal)}</strong><small>含管理岗</small></article>
       <article class="stat"><span>计时计件合计</span><strong>${money(pieceTotal)}</strong><small>计时 + 已审核计件</small></article>`;
    const tbody = $('#payrollRows');
    tbody.innerHTML = rows.map(({ e, calc }) => `<tr>
      <td class="mono">${esc(e.employeeNo)}</td><td><strong>${esc(e.name)}</strong></td>
      <td><span class="tag ${typeClass(e.salaryType)}">${esc(typeText(e.salaryType))}</span></td>
      <td class="num">${e.salaryType === 'hourly_piece' ? '—' : num(calc.days)}</td>
      <td class="num">${e.salaryType === 'daily' ? money(e.dailySalary) : '—'}</td>
      <td class="num">${e.salaryType === 'daily' ? num(calc.otDays) : '—'}</td>
      <td class="num">${e.salaryType === 'daily' ? money(calc.overtime) : '—'}</td>
      <td class="num">${(e.salaryType === 'monthly' || e.salaryType === 'management') ? money(e.monthlySalary) : '—'}</td>
      <td class="num">${e.salaryType === 'hourly_piece' ? money(calc.timerPay) : '—'}</td>
      <td class="num">${e.salaryType === 'hourly_piece' ? money(calc.piecePay) : '—'}</td>
      <td class="num"><strong>${money(calc.total)}</strong></td>
      <td><button class="btn small" type="button" data-payroll-detail="${esc(e.employeeNo)}">明细</button> <button class="btn small" type="button" data-edit-employee="${esc(e.employeeNo)}">改工资</button></td>
    </tr>`).join('');
    $('#payrollEmpty').hidden = rows.length > 0;
    tbody.querySelectorAll('[data-edit-employee]').forEach((b) => b.addEventListener('click', () => openEmployeeModal(b.dataset.editEmployee, true)));
    tbody.querySelectorAll('[data-payroll-detail]').forEach((b) => b.addEventListener('click', () => openPayrollDetail(b.dataset.payrollDetail)));
  }

  function syncSalaryFields() {
    const type = $('#fSalaryType').value;
    document.querySelectorAll('[data-salary="monthly"]').forEach((el) => { el.hidden = !(type === 'monthly' || type === 'management'); });
    document.querySelectorAll('[data-salary="daily"]').forEach((el) => { el.hidden = type !== 'daily'; });
    document.querySelectorAll('[data-salary="hourly"]').forEach((el) => { el.hidden = type !== 'hourly_piece'; });
    $('#fTrack').disabled = type !== 'hourly_piece';
    if (type !== 'hourly_piece') $('#fTrack').value = 'fixed';
    else if ($('#fTrack').value === 'fixed') $('#fTrack').value = 'back';
  }
  function openEmployeeModal(employeeNo = '', payrollFocus = false) {
    const e = employeeNo ? state.employees.find((x) => String(x.employeeNo) === String(employeeNo)) : null;
    state.editEmployee = e || null;
    $('#employeeModalTitle').textContent = e ? '编辑员工 · ' + e.name : '新增员工';
    $('#fEmployeeNo').value = e ? e.employeeNo : '';
    $('#fEmployeeNo').disabled = !!e;
    $('#fName').value = e ? e.name || '' : '';
    $('#fDepartment').value = e ? e.department || '' : '无锡市帆顺金属制品厂';
    $('#fPhone').value = e ? e.phone || '' : '';
    $('#fIdCard').value = e ? e.idCard || '' : '';
    $('#fBankCard').value = e ? e.bankCard || '' : '';
    $('#fBankName').value = e ? e.bankName || '' : '';
    $('#fDeliAccount').value = e ? e.deliAccount || '' : '';
    $('#fSalaryType').value = e ? e.salaryType || 'daily' : 'daily';
    $('#fEmploymentStatus').value = e ? e.employmentStatus || (e.active === false ? 'resigned' : 'active') : 'active';
    $('#fBaseStart').value = e ? String(e.baseStart || '').slice(0, 5) : '07:30';
    $('#fHireDate').value = e ? e.hireDate || '' : '';
    $('#fLeaveDate').value = e ? e.leaveDate || '' : '';
    $('#fTrack').value = e ? e.track || 'fixed' : 'fixed';
    $('#fActive').value = e && e.active === false ? 'false' : 'true';
    $('#fMonthlySalary').value = e && e.monthlySalary != null ? e.monthlySalary : '';
    $('#fDailySalary').value = e && e.dailySalary != null ? e.dailySalary : '';
    $('#fOvertimeRate').value = e && e.overtimeRate != null ? e.overtimeRate : '';
    $('#fHourlyRate').value = e && e.hourlyRate != null ? e.hourlyRate : '';
    $('#fNote').value = e ? e.note || '' : '';
    $('#resetCodeButton').hidden = !e;
    $('#employeeFormError').style.display = 'none';
    syncSalaryFields();
    $('#employeeOverlay').classList.add('show');
    setTimeout(() => { (payrollFocus ? $('#fDailySalary') : $('#fName')).focus(); }, 50);
  }
  function closeEmployeeModal() {
    $('#employeeOverlay').classList.remove('show');
    state.editEmployee = null;
  }
  function showFormError(message) {
    const box = $('#employeeFormError');
    box.textContent = message;
    box.style.display = message ? 'block' : 'none';
  }
  async function saveEmployee() {
    const e = state.editEmployee;
    const no = $('#fEmployeeNo').value.trim();
    const name = $('#fName').value.trim();
    if (!no || !name) { showFormError('工号和姓名必填'); return; }
    const type = $('#fSalaryType').value;
    const employmentStatus = $('#fEmploymentStatus').value;
    const active = $('#fActive').value === 'true' && employmentStatus !== 'resigned';
    const payload = {
      employeeNo: no, name,
      department: $('#fDepartment').value.trim(), phone: $('#fPhone').value.trim(),
      idCard: $('#fIdCard').value.trim(), bankCard: $('#fBankCard').value.trim(),
      bankName: $('#fBankName').value.trim(), deliAccount: $('#fDeliAccount').value.trim(),
      salaryType: type,
      monthlySalary: type === 'monthly' || type === 'management' ? ($('#fMonthlySalary').value || null) : null,
      dailySalary: type === 'daily' ? ($('#fDailySalary').value || null) : null,
      overtimeRate: type === 'daily' ? ($('#fOvertimeRate').value || null) : null,
      baseStart: $('#fBaseStart').value || null,
      track: type === 'hourly_piece' ? $('#fTrack').value : 'fixed',
      hourlyRate: type === 'hourly_piece' ? ($('#fHourlyRate').value || 0) : 0,
      employmentStatus, hireDate: $('#fHireDate').value || null, leaveDate: $('#fLeaveDate').value || null,
      active, note: $('#fNote').value.trim()
    };
    const btn = $('#employeeSave');
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const res = await rpc('board_employee_save', { p_code: state.code, p_payload: payload });
      if (!res || res.ok !== true) throw new Error(res?.message || '保存失败');
      closeEmployeeModal();
      if (!e && res.accessCode) alert('员工已新增。\n访问码：' + res.accessCode + '\n请把这个访问码发给员工。');
      else toast('员工信息和工资标准已保存');
      await loadEmployees();
      await loadPayroll(state.month);
      renderAll();
    } catch (error) {
      showFormError(error.message || '保存失败');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  }
  async function resetAccessCode() {
    const e = state.editEmployee;
    if (!e) return;
    if (!confirm(`要重置 ${e.name}（工号 ${e.employeeNo}）的访问码吗？旧访问码会立即失效。`)) return;
    try {
      const res = await rpc('board_employee_reset_code', { p_code: state.code, p_employee_no: e.employeeNo });
      if (!res || res.ok !== true) throw new Error(res?.message || '重置失败');
      alert('新访问码：' + res.accessCode + '\n请把这个访问码发给员工。');
      await loadEmployees();
      renderAll();
    } catch (error) { showFormError(error.message || '重置失败'); }
  }

  function openPayrollDetail(employeeNo) {
    const e = state.employees.find((x) => String(x.employeeNo) === String(employeeNo));
    if (!e) return;
    const calc = calcPayroll(e, state.att.get(String(e.employeeNo)) || null, state.work.get(String(e.employeeNo)) || null);
    let rows = '';
    if (e.salaryType === 'daily') {
      rows = `<div class="detail-row"><span>出勤天数</span><strong>${num(calc.days)} 天</strong></div>
        <div class="detail-row"><span>日薪</span><strong>${money(e.dailySalary)} 元/天</strong></div>
        <div class="detail-row"><span>基本工资</span><strong>${money(calc.base)} 元</strong></div>
        <div class="detail-row"><span>加班天数</span><strong>${num(calc.otDays)} 天</strong></div>
        <div class="detail-row"><span>加班费</span><strong>${money(calc.overtime)} 元</strong></div>`;
    } else if (e.salaryType === 'monthly' || e.salaryType === 'management') {
      rows = `<div class="detail-row"><span>月薪</span><strong>${money(e.monthlySalary)} 元</strong></div>
        <div class="detail-row"><span>出勤天数</span><strong>${num(calc.days)} 天</strong></div>`;
    } else {
      rows = `<div class="detail-row"><span>计时工时</span><strong>${(Number(calc.timerMinutes || 0) / 60).toFixed(2)} 小时</strong></div>
        <div class="detail-row"><span>计时时薪</span><strong>${money(e.hourlyRate)} 元/小时</strong></div>
        <div class="detail-row"><span>计时工资</span><strong>${money(calc.timerPay)} 元</strong></div>
        <div class="detail-row"><span>已审核计件</span><strong>${num(calc.pieceCount)} 笔 · ${num(calc.pieceQty)} 件</strong></div>
        <div class="detail-row"><span>计件工资</span><strong>${money(calc.piecePay)} 元</strong></div>
        <div class="detail-row"><span>待审核</span><strong>${num(calc.pending)} 笔</strong></div>`;
    }
    $('#detailTitle').textContent = `${e.employeeNo} ${e.name} · ${state.month} 工资明细`;
    $('#detailBody').innerHTML = `${rows}<div class="detail-row"><span>应付合计</span><strong>${money(calc.total)} 元</strong></div>`;
    $('#detailOverlay').classList.add('show');
  }
  function closeDetail() { $('#detailOverlay').classList.remove('show'); }

  function openImportPayrollModal(id) {
    const r = state.imported.find((x) => String(x.id) === String(id));
    if (!r) return;
    $('#importPayrollTitle').textContent = '编辑导入工资 · ' + r.employeeName;
    $('#ipName').value = r.employeeName || '';
    $('#ipType').value = r.salaryType || 'daily';
    $('#ipDays').value = r.attendanceDays ?? '';
    $('#ipOvertimeDays').value = r.overtimeDays ?? '';
    $('#ipDaily').value = r.dailySalary ?? '';
    $('#ipOvertimeRate').value = r.overtimeRate ?? '';
    $('#ipMonthly').value = r.monthlySalary ?? '';
    $('#ipPiece').value = r.pieceSalary ?? '';
    $('#ipTotal').value = r.totalSalary ?? '';
    $('#ipNote').value = r.note || '';
    $('#importPayrollError').style.display = 'none';
    state.editImported = r;
    $('#importPayrollOverlay').classList.add('show');
  }
  function closeImportPayroll() { $('#importPayrollOverlay').classList.remove('show'); state.editImported = null; }
  async function saveImportPayroll() {
    const r = state.editImported;
    if (!r) return;
    const payload = {
      monthStart: state.month + '-01', employeeNo: r.employeeNo || '', employeeName: r.employeeName,
      salaryType: $('#ipType').value,
      attendanceDays: $('#ipDays').value || null, overtimeDays: $('#ipOvertimeDays').value || null,
      dailySalary: $('#ipDaily').value || null, overtimeRate: $('#ipOvertimeRate').value || null,
      monthlySalary: $('#ipMonthly').value || null, pieceSalary: $('#ipPiece').value || null,
      totalSalary: $('#ipTotal').value || 0, note: $('#ipNote').value.trim(), source: r.source || '手工修改'
    };
    const btn = $('#importPayrollSave'); btn.disabled = true; btn.textContent = '保存中...';
    try {
      const res = await rpc('board_payroll_save', { p_code: state.code, p_payload: payload });
      if (!res || res.ok !== true) throw new Error(res?.message || '保存失败');
      closeImportPayroll(); toast('导入工资已修改');
      await loadPayroll(state.month); renderAll();
    } catch (e) {
      const box = $('#importPayrollError'); box.textContent = e.message || '保存失败'; box.style.display = 'block';
    } finally { btn.disabled = false; btn.textContent = '保存导入工资'; }
  }

  function exportPayroll() {
    if (state.payrollSource === 'imported' && state.imported.length) return exportImportedPayroll();
    const rows = payrollRows();
    const lines = [
      ['工号','姓名','工资类型','出勤天数','日薪','加班天数','加班费','月薪','计时工资','计件工资','应付合计'],
      ...rows.map(({ e, calc }) => [
        e.employeeNo, e.name, typeText(e.salaryType),
        e.salaryType === 'hourly_piece' ? '' : calc.days,
        e.salaryType === 'daily' ? e.dailySalary : '',
        e.salaryType === 'daily' ? calc.otDays : '',
        e.salaryType === 'daily' ? calc.overtime : '',
        (e.salaryType === 'monthly' || e.salaryType === 'management') ? e.monthlySalary : '',
        e.salaryType === 'hourly_piece' ? calc.timerPay : '',
        e.salaryType === 'hourly_piece' ? calc.piecePay : '',
        calc.total
      ])
    ];
    const csv = '\ufeff' + lines.map((line) => line.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `工资表_${state.month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportImportedPayroll() {
    const rows = importedPayrollRows();
    const lines = [
      ['工号','姓名','工资类型','出勤天数','日薪','加班天数','加班费','月薪','计件工资','应付合计','备注'],
      ...rows.map((r) => [r.employeeNo || '', r.employeeName, typeText(r.salaryType), r.attendanceDays ?? '', r.dailySalary ?? '', r.overtimeDays ?? '', Number(r.overtimeDays || 0) * Number(r.overtimeRate || 0), r.monthlySalary ?? '', r.pieceSalary ?? '', r.totalSalary ?? 0, r.note || ''])
    ];
    const csv = '\ufeff' + lines.map((line) => line.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `工资表_${state.month}_导入.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function bind() {
    $('#loginButton').addEventListener('click', () => login($('#accessCodeInput').value).catch((e) => showLogin(e.message || '登录失败')));
    $('#accessCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login($('#accessCodeInput').value).catch((err) => showLogin(err.message || '登录失败')); });
    $('#switchCodeButton').addEventListener('click', () => {
      try { localStorage.removeItem('shipmentBoardAccessCode:admin'); localStorage.removeItem('shipmentBoardRole:admin'); } catch { }
      state.code = '';
      showLogin('已退出，请输入管理访问码');
    });
    $('#refreshButton').addEventListener('click', () => refreshAll());
    document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      $('#infoTab').hidden = state.tab !== 'info';
      $('#payrollTab').hidden = state.tab !== 'payroll';
      if (state.tab === 'payroll') renderPayroll();
    }));
    $('#employeeSearch').addEventListener('input', (e) => { state.employeeSearch = e.target.value; renderEmployees(); });
    $('#employeeTypeFilter').addEventListener('change', (e) => { state.employeeType = e.target.value; renderEmployees(); });
    $('#employeeStatusFilter').addEventListener('change', (e) => { state.employeeStatus = e.target.value; renderEmployees(); });
    $('#addEmployeeButton').addEventListener('click', () => openEmployeeModal(''));
    $('#employeeClose').addEventListener('click', closeEmployeeModal);
    $('#employeeCancel').addEventListener('click', closeEmployeeModal);
    $('#employeeSave').addEventListener('click', saveEmployee);
    $('#resetCodeButton').addEventListener('click', resetAccessCode);
    $('#fSalaryType').addEventListener('change', syncSalaryFields);
    $('#employeeOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeEmployeeModal(); });
    $('#detailClose').addEventListener('click', closeDetail);
    $('#detailOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDetail(); });
    $('#payrollMonth').addEventListener('change', (e) => {
      state.month = e.target.value || currentMonth();
      loadPayroll(state.month).then(renderPayroll).catch((err) => toast(err.message || '工资加载失败', true));
    });
    $('#payrollSearch').addEventListener('input', (e) => { state.payrollSearch = e.target.value; renderPayroll(); });
    $('#payrollTypeFilter').addEventListener('change', (e) => { state.payrollType = e.target.value; renderPayroll(); });
    $('#payrollSource').addEventListener('change', (e) => {
      state.payrollSource = e.target.value === 'imported' ? 'imported' : 'auto';
      if (state.payrollSource === 'imported' && !state.imported.length) { toast('这个月没有导入工资数据'); state.payrollSource = 'auto'; e.target.value = 'auto'; }
      renderPayroll();
    });
    $('#importPayrollClose').addEventListener('click', closeImportPayroll);
    $('#importPayrollCancel').addEventListener('click', closeImportPayroll);
    $('#importPayrollSave').addEventListener('click', saveImportPayroll);
    $('#importPayrollOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeImportPayroll(); });
    $('#payrollRefresh').addEventListener('click', () => loadPayroll(state.month).then(renderPayroll).catch((err) => toast(err.message || '工资加载失败', true)));
    $('#payrollExport').addEventListener('click', exportPayroll);
    $('#payrollPrint').addEventListener('click', () => window.print());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeEmployeeModal(); closeDetail(); closeImportPayroll(); } });
  }

  async function init() {
    if (EMBED) document.body.classList.add('embed');
    bind();
    const code = storedCode();
    if (!code) { showLogin(); return; }
    try { await login(code); }
    catch { showLogin('访问码失效，请重新输入管理访问码'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
