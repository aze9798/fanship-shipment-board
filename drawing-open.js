/* ============================================================
   图纸：点「查看图纸」直接在**新窗口**打开 PDF（浏览器自带阅读器）
   文件：public/drawing-open.js        建立日期：2026-10-17
   为什么这么做：内嵌预览是图片，宽图要左右拖，阿泽说不好用；
   浏览器自带的 PDF 阅读器清晰、能缩放、能旋转。
   做法：提前把「图纸 id → storagePath」拉下来存内存；点的时候同步
   拼出 public URL 并 window.open（必须同步，否则会被浏览器当弹窗拦掉）。
   兜底：映射还没准备好，就不拦，交回 app.js 原来的内嵌预览。
   回滚：删掉 index.html 里这一行 <script> 即可。
   ============================================================ */
(() => {
  'use strict';

  let map = null;
  let loading = null;

  function readCode() {
    const mode = new URLSearchParams(location.search).get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }

  function loadMap() {
    if (map || loading) return loading || Promise.resolve(map);
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) { map = new Map(); return Promise.resolve(map); }
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) { h.apikey = window.SHIPMENT_ANON_KEY; h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY; }
    loading = fetch(base + '/board_get_drawings', {
      method: 'POST', headers: h, body: JSON.stringify({ p_code: readCode() })
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => {
        map = new Map((Array.isArray(arr) ? arr : []).map((d) => [String(d.id), String(d.storagePath || '')]));
        return map;
      })
      .catch(() => { map = new Map(); return map; });
    return loading;
  }

  function pdfUrl(id) {
    const p = map && map.get(String(id));
    if (!p) return '';
    const origin = String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
    if (!origin) return '';
    return origin + '/storage/v1/object/public/product-drawings/' +
      p.split('/').map(encodeURIComponent).join('/');
  }

  // 进图纸库就先备好映射（列表 72KB，一次就够）
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tk-view="drawings"], .side-link[data-desktop-view="drawings"]')) loadMap();
  }, true);
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest('#desktopDrawingsView .drawing-row')) loadMap();
  }, true);

  /* 接管「查看图纸」：直接新窗口开 PDF。
     app.js 的点击监听比我们早注册，光靠 stopPropagation 拦不住（实测内嵌预览还是会弹），
     所以映射准备好以后，把这些按钮换成副本——副本不带 app.js 的监听，
     只走我们自己的新窗口逻辑。列表重绘时会自动再接管一次。 */
  function armButtons() {
    if (!map) return;
    const v = document.getElementById('desktopDrawingsView');
    if (!v) return;
    v.querySelectorAll('.drawing-open[data-drawing-id]').forEach((btn) => {
      if (btn.dataset.tkOpen === '1') return;
      const clone = btn.cloneNode(true);
      clone.dataset.tkOpen = '1';
      btn.parentNode.replaceChild(clone, btn);
    });
  }
  function watchList() {
    const v = document.getElementById('desktopDrawingsView');
    if (!v || v.dataset.tkOpenWatched === '1') return;
    v.dataset.tkOpenWatched = '1';
    try { new MutationObserver(() => armButtons()).observe(v, { childList: true, subtree: true }); } catch { }
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.drawing-open[data-tk-open="1"]');
    if (!btn) return;
    const url = pdfUrl(btn.dataset.drawingId);
    e.preventDefault();
    e.stopPropagation();
    if (url) window.open(url, '_blank', 'noopener');
    else loadMap();
  }, true);
  const armTimer = setInterval(() => {
    watchList();
    if (map) armButtons();
  }, 800);
  setTimeout(() => clearInterval(armTimer), 300000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(loadMap, 0));
  else setTimeout(loadMap, 0);
})();