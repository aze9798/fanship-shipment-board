/* 采购单打印（外协 / 原材料通用，支持一张单多行） */
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

  function buildHtml(kind, rows, poNo, drawMap) {
    const isOs = kind === '02';
    const r0 = rows[0] || {};
    const vendor = isOs ? r0.vendor : r0.supplier;
    const title = isOs ? '外协加工采购单' : '原材料采购单';
    const today = new Date(); const p = (n) => String(n).padStart(2, '0');
    const dateStr = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
    let totalQty = 0, totalAmt = 0;
    const body = rows.map((r, i) => {
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
      'body{font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;color:#111;font-size:12px;margin:0}' +
      'h1{font-size:19px;text-align:center;margin:0 0 3px;letter-spacing:2px}' +
      '.doctitle{text-align:center;font-size:15px;letter-spacing:6px;margin-bottom:10px;color:#333}' +
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 24px;margin:0 0 10px;font-size:12px}' +
      '.meta b{display:inline-block;width:62px;font-weight:400;color:#555}.meta .wide{grid-column:1/-1}' +
      'table{width:100%;border-collapse:collapse;table-layout:fixed}' +
      'th,td{border:1px solid #333;padding:5px 6px;word-break:break-all;vertical-align:middle}' +
      'th{background:#f3f3f3;font-weight:600;font-size:11.5px}.num{text-align:right}.c{text-align:center}' +
      '.sum{margin-top:6px;display:flex;justify-content:space-between;font-size:12px}' +
      '.note{margin-top:10px;font-size:12px;line-height:1.7;min-height:26px}' +
      '.sign{display:flex;justify-content:space-between;gap:40px;margin-top:34px;font-size:12px}' +
      '.sign>div{flex:1}.sign .line{border-bottom:1px solid #999;height:26px;margin-bottom:4px}' +
      '.tips{margin-top:14px;font-size:10.5px;color:#777;line-height:1.6}' +
      '</style></head><body>' +
      '<h1>无锡市帆顺金属科技有限公司</h1><div class="doctitle">' + title + '</div>' +
      '<div class="meta"><div><b>单号：</b>' + esc(poNo || '—') + '</div><div><b>日期：</b>' + dateStr + '</div>' +
      '<div class="wide"><b>' + (isOs ? '外协厂' : '供应商') + '：</b>' + esc(vendor || '—') + '</div>' +
      '<div><b>项数：</b>' + rows.length + ' 项</div><div><b>合计数量：</b>' + qty(totalQty) + '</div></div>' +
      '<table><thead><tr><th style="width:38px">项次</th><th>品名</th><th style="width:104px">料号</th>' +
      '<th style="width:104px">规格 / 图号</th><th class="num" style="width:60px">数量</th>' +
      '<th class="c" style="width:40px">单位</th><th class="num" style="width:64px">单价</th>' +
      '<th class="num" style="width:78px">金额</th><th class="c" style="width:74px">交期</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>' +
      '<div class="sum"><span>总数量：' + qty(totalQty) + '</span><span>金额合计：<b>' + (totalAmt ? '¥ ' + num(totalAmt) : '—') + '</b></span></div>' +
      '<div class="note"><b>备注：</b>' + (r0.note ? esc(r0.note) : '—') + '</div>' +
      '<div class="sign"><div><div class="line"></div>供方（盖章）：' + esc(vendor || '') + '</div>' +
      '<div><div class="line"></div>需方（盖章）：无锡市帆顺金属科技有限公司</div></div>' +
      '<div class="tips">说明：请按各项次交期送货；数量、单价如有异议请在 1 个工作日内回复。</div>' +
      (function () {
        if (!drawMap || !drawMap.size) return '';
        const lines = rows.map((r, i) => {
          const d = drawMap.get(String(r.material || '').trim());
          if (!d) return '';
          return '<tr><td class="c">' + (i + 1) + '</td><td>' + esc(r.material) + '</td><td>' +
            esc(r.spec || '—') + '</td><td><a href="' + esc(d.url) + '">' + esc(d.name || '打开图纸') + '</a></td></tr>';
        }).filter(Boolean).join('');
        if (!lines) return '';
        return '<h2 style="font-size:13px;margin:18px 0 6px">图纸附件</h2>' +
          '<table><thead><tr><th style="width:38px">项次</th><th style="width:120px">料号</th>' +
          '<th style="width:140px">图号</th><th>图纸文件</th></tr></thead><tbody>' + lines + '</tbody></table>';
      })() +
      '</body></html>';
  }

  /* 取图纸：料号 → 图纸公开地址（给采购单附图纸清单用） */
  let drawMap = null;
  async function loadDrawings() {
    if (drawMap) return drawMap;
    drawMap = new Map();
    const res = await rpc('board_get_drawings', {});
    const arr = (res && res.ok && Array.isArray(res.data)) ? res.data : [];
    const origin = String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
    arr.forEach((d) => {
      const key = String(d.material || '').trim();
      if (key && !drawMap.has(key)) {
        drawMap.set(key, { url: origin + '/storage/v1/object/public/product-drawings/' + String(d.storagePath || '').split('/').map(encodeURIComponent).join('/'), name: d.fileName || '' });
      }
    });
    return drawMap;
  }

  window.tkPrintPo = async function (kind, input, poNoIn, opts) {
    const rows = Array.isArray(input) ? input.filter(Boolean) : (input ? [input] : []);
    if (!rows.length) return;
    const k = kind === '01' ? '01' : '02';
    let poNo = poNoIn || rows[0].poNo || '';
    if (!poNo) {
      const res = await rpc('board_po_no_of', { p_kind: k, p_id: rows[0].id });
      poNo = (res && res.ok && typeof res.data === 'string') ? res.data : '';
    }
    if (!poNo) { alert('取单号失败：请先在 Supabase 执行 po-number-schema.sql'); return; }
    const dm = await loadDrawings();
    const html = buildHtml(k, rows, poNo, dm);
    if (opts && opts.download) {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (poNo || '采购单') + '.html';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return;
    }
    const w = window.open('', '_blank');
    if (!w) { alert('浏览器拦了弹窗，请允许本页弹出窗口'); return; }
    try {
      w.document.open(); w.document.write(html); w.document.close(); w.focus();
      setTimeout(() => { try { w.print(); } catch { } }, 400);
    } catch (e) { alert('打开失败：' + e.message); }
  };
})();