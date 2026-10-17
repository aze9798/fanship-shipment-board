/* ============================================================
   采购单打印（外协 / 原材料通用）
   文件：public/po-print.js        建立日期：2026-10-17
   抬头：无锡市帆顺金属科技有限公司
   单号：FS01-YYMMDDNN（原材料） / FS02-YYMMDDNN（外协），由数据库生成
   用法：window.tkPrintPo('02', row)
   回滚：删掉 index.html 里这一行 <script> 即可。
   ============================================================ */
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
      const text = await r.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
      if (!r.ok) return { ok: false, error: (data && (data.message || data.error)) || ('HTTP ' + r.status) };
      return { ok: true, data };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 2) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const qty = (n) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const day = (v) => String(v || '').slice(0, 10) || '—';

  function buildHtml(kind, r, poNo) {
    const isOs = kind === '02';
    const vendor = isOs ? r.vendor : r.supplier;
    const unit = isOs ? '件' : (r.unit || '件');
    const price = Number(r.unitPrice || 0);
    const amount = r.qty && price ? Number(r.qty) * price : 0;
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const dateStr = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
    const title = isOs ? '外协加工采购单' : '原材料采购单';

    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + esc(poNo || title) + '</title><style>' +
      '@page{size:A4;margin:14mm 12mm}' +
      'body{font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;color:#111;font-size:12px;margin:0}' +
      'h1{font-size:19px;text-align:center;margin:0 0 3px;letter-spacing:2px}' +
      '.doctitle{text-align:center;font-size:15px;letter-spacing:6px;margin-bottom:10px;color:#333}' +
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 24px;margin:0 0 10px;font-size:12px}' +
      '.meta b{display:inline-block;width:62px;font-weight:400;color:#555}' +
      '.meta .wide{grid-column:1/-1}' +
      'table{width:100%;border-collapse:collapse;table-layout:fixed}' +
      'th,td{border:1px solid #333;padding:5px 6px;word-break:break-all;vertical-align:middle}' +
      'th{background:#f3f3f3;font-weight:600;font-size:11.5px}' +
      '.num{text-align:right}' +
      '.c{text-align:center}' +
      '.sum{margin-top:6px;display:flex;justify-content:space-between;font-size:12px}' +
      '.note{margin-top:10px;font-size:12px;line-height:1.7;min-height:30px}' +
      '.sign{display:flex;justify-content:space-between;gap:40px;margin-top:34px;font-size:12px}' +
      '.sign>div{flex:1}' +
      '.sign .line{border-bottom:1px solid #999;height:26px;margin-bottom:4px}' +
      '.tips{margin-top:14px;font-size:10.5px;color:#777;line-height:1.6}' +
      '</style></head><body>' +
      '<h1>无锡市帆顺金属科技有限公司</h1>' +
      '<div class="doctitle">' + title + '</div>' +
      '<div class="meta">' +
        '<div><b>单号：</b>' + esc(poNo || '—') + '</div>' +
        '<div><b>日期：</b>' + dateStr + '</div>' +
        '<div class="wide"><b>' + (isOs ? '外协厂' : '供应商') + '：</b>' + esc(vendor || '—') + '</div>' +
        '<div><b>交期：</b>' + day(r.dueDate) + '</div>' +
        '<div><b>关联订单：</b>' + esc(r.orderNo || r.orderId || '—') + '</div>' +
      '</div>' +
      '<table><thead><tr>' +
        '<th style="width:38px">序号</th><th>品名</th><th style="width:112px">料号</th>' +
        '<th style="width:110px">规格 / 图号</th><th class="num" style="width:66px">数量</th>' +
        '<th class="c" style="width:44px">单位</th><th class="num" style="width:70px">单价</th>' +
        '<th class="num" style="width:84px">金额</th>' +
      '</tr></thead><tbody><tr>' +
        '<td class="c">1</td><td>' + esc(r.name || '—') + '</td><td>' + esc(r.material || '—') + '</td>' +
        '<td>' + esc(r.spec || '—') + '</td><td class="num">' + qty(r.qty) + '</td>' +
        '<td class="c">' + esc(unit) + '</td><td class="num">' + (price ? num(price, 4) : '—') + '</td>' +
        '<td class="num">' + (amount ? num(amount) : '—') + '</td>' +
      '</tr></tbody></table>' +
      '<div class="sum"><span>合计：' + qty(r.qty) + ' ' + esc(unit) + '</span>' +
        '<span>金额合计：<b>' + (amount ? '¥ ' + num(amount) : '—') + '</b></span></div>' +
      '<div class="note"><b>备注：</b>' + (r.note ? esc(r.note) : '—') + '</div>' +
      '<div class="sign">' +
        '<div><div class="line"></div>供方（盖章）：' + esc(vendor || '') + '</div>' +
        '<div><div class="line"></div>需方（盖章）：无锡市帆顺金属科技有限公司</div>' +
      '</div>' +
      '<div class="tips">说明：收到本采购单后请按交期送货；数量、单价如有异议请在 1 个工作日内回复。' +
        '外协件回厂时请随货附送货单，注明单号 ' + esc(poNo || '') + '。</div>' +
      '</body></html>';
  }

  window.tkPrintPo = async function (kind, row) {
    if (!row) return;
    const k = kind === '01' ? '01' : '02';
    const res = await rpc('board_po_no_of', { p_kind: k, p_id: row.id });
    const poNo = (res && res.ok && typeof res.data === 'string') ? res.data : '';
    if (!poNo) { alert('取单号失败：' + ((res && res.error) || '未知错误') + '\n请先在 Supabase 执行 po-number-schema.sql'); return; }
    const html = buildHtml(k, row, poNo);
    const w = window.open('', '_blank');
    if (!w) { alert('浏览器拦了弹窗，请允许本页弹出窗口'); return; }
    try {
      w.document.open(); w.document.write(html); w.document.close();
      w.focus();
      setTimeout(() => { try { w.print(); } catch { } }, 400);
    } catch (e) { alert('打印窗口打开失败：' + e.message); }
  };
})();