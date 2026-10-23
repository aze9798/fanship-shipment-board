/* 报工单价管理员页面：按产品/工序/规格查看和修改计件单价 */
(() => {
  'use strict';
  const VIEW = 'workRates';
  const S = { mounted: false, loaded: false, rows: [], query: '', visibleLimit: 40 };
  const $ = (s) => document.querySelector(s);
  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }
  async function rpc(name, payload = {}) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return { ok: false, error: '没有云端接口' };
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
    try {
      const r = await fetch(base + '/' + name, { method: 'POST', headers: h, body: JSON.stringify({ p_code: readCode(), ...payload }) });
      const t = await r.text(); const data = t ? JSON.parse(t) : null;
      if (!r.ok) return { ok: false, error: data?.message || data?.error || ('HTTP ' + r.status) };
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const price = (v) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  function allViews() { return [...document.querySelectorAll('.desktop-view')]; }
  function showMine() {
    allViews().forEach((v) => { v.hidden = v.id !== 'desktopWorkRatesView'; });
    document.querySelectorAll('[data-desktop-view]').forEach((l) => l.classList.toggle('active', l.dataset.desktopView === VIEW));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    load();
  }
  function hideMine() { const v = document.getElementById('desktopWorkRatesView'); if (v) v.hidden = true; }
  function build() {
    if (S.mounted || document.getElementById('desktopWorkRatesView')) return;
    S.mounted = true;
    const nav = document.querySelector('.side-nav');
    if (nav && !nav.querySelector('[data-desktop-view="workRates"]')) {
      const a = document.createElement('a');
      a.className = 'side-link'; a.href = '#work-rates'; a.dataset.desktopView = VIEW; a.dataset.module = 'work'; a.hidden = true;
      a.innerHTML = '<span class="nav-dot"></span>报工单价';
      const anchor = nav.querySelector('[data-desktop-view="staffInfo"]');
      if (anchor) nav.insertBefore(a, anchor); else nav.appendChild(a);
    }
    const editActions = document.querySelector('#desktopWorkEditView .topbar-actions');
    if (editActions && !document.getElementById('workRatesOpenButton')) {
      const button = document.createElement('button');
      button.type = 'button'; button.id = 'workRatesOpenButton'; button.className = 'button ghost'; button.textContent = '报工单价';
      button.addEventListener('click', showMine);
      editActions.insertBefore(button, editActions.firstChild);
    }    const main = document.querySelector('main.main-area');
    if (main) {
      const sec = document.createElement('section');
      sec.id = 'desktopWorkRatesView'; sec.className = 'desktop-view desktop-only'; sec.hidden = true;
      sec.innerHTML = `
        <header class="topbar"><div><p class="eyebrow">管理员专用 · 计件单价</p><h1>报工单价</h1><p class="subhead">按产品、工序、规格维护计件单价。改价从所选生效日期开始生效，历史工资记录不受影响。</p></div><div class="topbar-actions"><button class="button" type="button" id="workRatesRefresh">刷新</button></div></header>
        <section class="panel" style="padding:16px 18px 18px">
          <div class="work-report-filters" style="margin:0 0 12px"><label style="flex:1"><span>搜索料号 / 品名 / 图号 / 工序</span><input id="workRatesSearch" type="search" placeholder="例如 611901823、折弯、4刀"></label><label style="width:160px"><span>当前单价</span><div id="workRatesCount" class="work-edit-lock">—</div></label></div>
          <div class="table-wrap"><table class="orders-table work-report-table"><thead><tr><th>料号</th><th>品名 / 规格</th><th>工序</th><th>规格 / 变体</th><th class="number">当前单价</th><th>生效日期</th><th>操作</th></tr></thead><tbody id="workRatesBody"></tbody></table><div id="workRatesEmpty" class="empty-state" hidden><strong>没有匹配的报工单价</strong><span>换个关键词试试。</span></div></div>
        </section>`;
      main.appendChild(sec);
    }
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.side-link[data-desktop-view]');
      if (!link) return;
      if (link.dataset.desktopView === VIEW) { e.preventDefault(); showMine(); } else hideMine();
    }, true);
    $('#workRatesRefresh')?.addEventListener('click', () => load());
    $('#workRatesSearch')?.addEventListener('input', (e) => { S.query = e.target.value; S.visibleLimit = 40; clearTimeout(S.timer); S.timer = setTimeout(() => load(), 220); });
    $('#workRatesBody')?.addEventListener('click', (e) => { if (e.target.closest('[data-rate-more]')) { S.visibleLimit += 40; render(); return; } const b = e.target.closest('[data-rate-edit]'); if (!b) return; const row = S.rows.find((x) => String(x.rateId) === String(b.dataset.rateEdit)); if (row) openEditor(row); });
  }
  async function load() {
    const res = await rpc('work_admin_price_list', { p_query: S.query || '' });
    if (!res.ok) { const body = $('#workRatesBody'); if (body) body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#c0392b">${esc(res.error || '读取失败')}</td></tr>`; return; }
    S.rows = Array.isArray(res.data) ? res.data : [];
    render();
  }
  function render() {
    const visibleRows = S.rows.slice(0, S.visibleLimit);
    $('#workRatesCount').textContent = S.rows.length + ' 条单价';
    $('#workRatesEmpty').hidden = S.rows.length > 0;
    $('#workRatesBody').innerHTML = visibleRows.map((r) => `<tr>
      <td class="mono">${esc(r.material || '—')}</td>
      <td>${esc(r.name || '')}${r.spec ? ' · ' + esc(r.spec) : ''}</td>
      <td>${esc(r.processName || '')}</td>
      <td>${esc(r.variantLabel || '—')}</td>
      <td class="number"><strong>${price(r.unitPrice)}</strong></td>
      <td>${esc(String(r.effectiveFrom || '').slice(0, 10))}</td>
      <td><button class="button ghost" type="button" data-rate-edit="${esc(r.rateId)}">改价</button></td>
    </tr>`).join('') + (S.rows.length > visibleRows.length ? `<tr><td colspan="7"><div class="load-more-row"><span>已显示 ${visibleRows.length} / ${S.rows.length} 条</span><button class="button ghost" type="button" data-rate-more>再显示 40 条</button></div></td></tr>` : '');
  }
  function openEditor(row) {
    const mask = document.createElement('div'); mask.id = 'workRateMask'; mask.style.cssText = 'position:fixed;inset:0;background:rgba(8,30,35,.38);z-index:9400;display:grid;place-items:center;padding:20px;';
    mask.innerHTML = `<div class="panel" style="width:min(100%,500px);padding:20px;background:#fff;border-radius:16px"><h2 style="margin:0 0 4px;font-size:18px">修改报工单价</h2><p style="margin:0 0 14px;color:#6b8085;font-size:12px">${esc(row.material)} · ${esc(row.name || '')} · ${esc(row.processName || '')} ${esc(row.variantLabel || '')}</p><label style="display:block;margin-bottom:10px"><span style="display:block;font-size:12px;color:#6b8085;margin-bottom:5px">修改后单价（元）</span><input id="workRatePrice" type="number" min="0.0001" step="0.0001" value="${row.unitPrice}" style="width:100%;height:38px;padding:0 10px;border:1px solid #d5e1e0;border-radius:9px;font:inherit"></label><label style="display:block;margin-bottom:12px"><span style="display:block;font-size:12px;color:#6b8085;margin-bottom:5px">生效日期</span><input id="workRateDate" type="date" value="${esc(String(row.effectiveFrom || '').slice(0,10) || new Date().toISOString().slice(0,10))}" style="width:100%;height:38px;padding:0 10px;border:1px solid #d5e1e0;border-radius:9px;font:inherit"></label><div id="workRateError" style="display:none;color:#c0392b;font-size:12px;margin-bottom:10px"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button class="button ghost" type="button" data-rate-cancel>取消</button><button class="button primary" type="button" data-rate-save>保存并生效</button></div></div>`;
    document.body.appendChild(mask);
    const close = () => mask.remove();
    mask.addEventListener('click', (e) => { if (e.target === mask || e.target.closest('[data-rate-cancel]')) close(); });
    mask.querySelector('[data-rate-save]').addEventListener('click', async (e) => {
      const amount = Number(mask.querySelector('#workRatePrice').value);
      const date = mask.querySelector('#workRateDate').value;
      const err = mask.querySelector('#workRateError');
      if (!(amount > 0)) { err.textContent = '单价必须大于 0'; err.style.display = 'block'; return; }
      e.target.disabled = true;
      const res = await rpc('work_admin_price_save', { p_payload: { productId: row.productId, processId: row.processId, unitPrice: amount, effectiveFrom: date, variantKey: row.variantKey || '', variantValue: row.variantValue || 0, variantLabel: row.variantLabel || '' } });
      e.target.disabled = false;
      if (!res.ok) { err.textContent = res.error || '保存失败'; err.style.display = 'block'; return; }
      close(); await load(); if (window.showToast) window.showToast('报工单价已更新'); else alert('报工单价已更新');
    });
  }
  function init() {
    if (/\/mobile\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'mobile') return;
    build();
    const link = document.querySelector('[data-desktop-view="workRates"]');
    if (link) link.hidden = false;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0)); else setTimeout(init, 0);
})();
