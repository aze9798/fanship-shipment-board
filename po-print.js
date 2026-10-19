/* 采购单打印（外协 / 原材料通用，一张单多行） 2026-10-17 */
(() => {
  'use strict';
  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }
  async function rpc(name, payload) {
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) return { ok: false, error: '没有云端接口' };
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
    try {
      const r = await fetch(base + '/' + name, { method: 'POST', headers: h, body: JSON.stringify({ p_code: readCode(), ...payload }) });
      const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { }
      if (!r.ok) return { ok: false, error: (d && (d.message || d.error)) || ('HTTP ' + r.status) };
      return { ok: true, data: d };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 2) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const qty = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const day = (v) => String(v || '').slice(0, 10) || '—';

  function buildHtml(kind, rows, poNo) {
    const isOs = kind === '02';
    // 交期按日期从早到晚排列，项次跟着重排
    const sortedRows = [...rows].sort((left, right) => String(left.dueDate || '9999-12-31').localeCompare(String(right.dueDate || '9999-12-31')));
    const r0 = sortedRows[0] || {};
    const vendor = isOs ? r0.vendor : r0.supplier;
    const title = isOs ? '外协加工采购单' : '原材料采购单';
    const t = new Date(); const p = (n) => String(n).padStart(2, '0');
    const dateStr = t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
    let totalQty = 0, totalAmt = 0;
    const body = sortedRows.map((r, i) => {
      const unit = isOs ? '件' : (r.unit || '件');
      const price = Number(r.unitPrice || 0);
      const amt = r.qty && price ? Number(r.qty) * price : 0;
      totalQty += Number(r.qty || 0); totalAmt += amt;
      return '<tr><td class="c">' + (i + 1) + '</td><td>' + esc(r.name || '—') + '</td>' +
        '<td>' + esc(r.material || '—') + '</td><td>' + esc(r.spec || '—') + '</td>' +
        '<td class="num">' + qty(r.qty) + '</td><td class="c">' + esc(unit) + '</td>' +
        '<td class="num">' + (price ? num(price, 4) : '—') + '</td>' +
        '<td class="num">' + (amt ? num(amt) : '—') + '</td>' +
        '<td class="c">' + day(r.dueDate) + '</td></tr>';
    }).join('');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + esc(poNo || title) + '</title><style>' +
      '@page{size:A4;margin:14mm 12mm}' +
      'body{font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;color:#111;font-size:14px;line-height:1.4;margin:0}' +
      'h1{font-size:22px;text-align:center;margin:0 0 5px;letter-spacing:2px;font-family:inherit}' +
      '.doctitle{text-align:center;font-size:18px;letter-spacing:6px;margin-bottom:12px;color:#222;font-family:inherit}' +
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:7px 24px;margin:0 0 12px;font-size:14px;font-family:inherit}' +
      '.meta b{display:inline-block;width:70px;font-weight:400;color:#444;font-family:inherit}.meta .wide{grid-column:1/-1}' +
      'table{width:100%;border-collapse:collapse;table-layout:fixed;font-family:inherit}' +
      'th,td{border:1px solid #333;padding:7px 6px;word-break:break-all;vertical-align:middle;text-align:center;font-family:inherit;font-size:14px;line-height:1.45}' +
      'th:last-child,td:last-child{white-space:nowrap}' +
      'th{background:#f3f3f3;font-weight:700;font-size:14px}.num{text-align:center}.c{text-align:center}' +
      '.sum{margin-top:8px;display:flex;justify-content:space-between;font-size:14px;font-family:inherit}' +
      '.note{margin-top:10px;font-size:14px;line-height:1.7;min-height:26px;font-family:inherit}' +
      '</style></head><body>' +
      '<h1>无锡市帆顺金属科技有限公司</h1><div class="doctitle">' + title + '</div>' +
      '<div class="meta"><div><b>单号：</b>' + esc(poNo || '—') + '</div><div><b>日期：</b>' + dateStr + '</div>' +
      '<div class="wide"><b>' + (isOs ? '外协公司' : '供应商') + '：</b>' + esc(vendor || '—') + '</div></div>' +
      '<table><thead><tr><th style="width:38px">项次</th><th>品名</th><th style="width:104px">料号</th>' +
      '<th style="width:104px">规格 / 图号</th><th class="num" style="width:60px">数量</th>' +
      '<th class="c" style="width:40px">单位</th><th class="num" style="width:64px">单价</th>' +
      '<th class="num" style="width:78px">金额</th><th class="c" style="width:96px">交期</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>' +
      '<div class="sum"><span>总数量：' + qty(totalQty) + '</span><span>金额合计：<b>' + (totalAmt ? '¥ ' + num(totalAmt) : '—') + '</b></span></div>' +
      '<div class="note"><b>备注：</b>' + (r0.note ? esc(r0.note) : '—') + '</div>' +
      '</body></html>';
  }

  window.tkPrintPo = async function (kind, input, poNoIn) {
    const rows = Array.isArray(input) ? input.filter(Boolean) : (input ? [input] : []);
    if (!rows.length) return;
    const k = kind === '01' ? '01' : '02';
    let poNo = poNoIn || rows[0].poNo || '';
    if (!poNo) {
      const res = await rpc('board_po_no_of', { p_kind: k, p_id: rows[0].id });
      poNo = (res && res.ok && typeof res.data === 'string') ? res.data : '';
    }
    if (!poNo) { alert('取单号失败：请先在 Supabase 执行 po-number-schema.sql'); return; }
    const w = window.open('', '_blank');
    if (!w) { alert('浏览器拦了弹窗，请允许本页弹出窗口'); return; }
    try {
      w.document.open(); w.document.write(buildHtml(k, rows, poNo)); w.document.close(); w.focus();
      setTimeout(() => { try { w.print(); } catch { } }, 400);
    } catch (e) { alert('打开失败：' + e.message); }
  };
})();