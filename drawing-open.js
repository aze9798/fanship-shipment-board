/* ============================================================
   图纸打开方式（2026-10-17 阿泽定稿）
   - 电脑端：点“查看图纸 / 图纸”直接新窗口显示图纸预览，不再是内嵌小窗口
   - 手机端：交给 app.js 的快速预览，不在这里抢事件；手机端也不加载旋转
   - 新窗口优先显示 JPG 预览图，第 1 页先出，其余页懒加载；
     预览图不可用时才退回 PDF。
   ============================================================ */
(() => {
  'use strict';

  const isMobileBoard = new URLSearchParams(location.search).get('view') === 'mobile'
    || /\/mobile\/?$/.test(location.pathname)
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (isMobileBoard) return;

  let map = null;
  let loading = null;
  let manifest = null;
  let manifestLoading = null;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readCode() {
    const q = new URLSearchParams(location.search);
    const fromUrl = String(q.get('code') || '').trim();
    if (fromUrl) return fromUrl;
    const mode = q.get('mode');
    const suffix = (mode === 'admin' || mode === 'user') ? ':' + mode : '';
    try { return localStorage.getItem('shipmentBoardAccessCode' + suffix) || ''; } catch { return ''; }
  }

  function origin() {
    return String(window.SHIPMENT_RPC_BASE || '').replace(/\/rest\/v1\/rpc.*$/, '');
  }

  function loadMap() {
    if (map && map.size) return Promise.resolve(map);
    if (loading) return loading;
    const base = window.SHIPMENT_RPC_BASE || '';
    if (!base) { map = new Map(); return Promise.resolve(map); }
    const h = { 'Content-Type': 'application/json' };
    if (window.SHIPMENT_ANON_KEY) {
      h.apikey = window.SHIPMENT_ANON_KEY;
      h.Authorization = 'Bearer ' + window.SHIPMENT_ANON_KEY;
    }
    // 刚打开页面时访问码可能还没写进 localStorage，第一次 RPC 会 403；
    // 这里最多重试 3 次，不能把一次 403 当成“没有图纸”。
    loading = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const r = await fetch(base + '/board_get_drawings', {
            method: 'POST', headers: h, body: JSON.stringify({ p_code: readCode() })
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const arr = await r.json();
          map = new Map((Array.isArray(arr) ? arr : []).map((d) => [String(d.id), String(d.storagePath || '')]));
          return map;
        } catch {
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
      map = new Map();
      return map;
    })().finally(() => { loading = null; });
    return loading;
  }

  function loadManifest() {
    if (manifest || manifestLoading) return manifestLoading || Promise.resolve(manifest || {});
    const base = origin();
    if (!base) { manifest = {}; return Promise.resolve(manifest); }
    manifestLoading = fetch(base + '/storage/v1/object/public/product-drawings/_previews.json', { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => { manifest = data && typeof data === 'object' ? data : {}; return manifest; })
      .catch(() => { manifest = {}; return manifest; });
    return manifestLoading;
  }

  function previewUrl(storagePath, page) {
    const base = origin();
    if (!base || !storagePath) return '';
    const path = String(storagePath).replace(/\.pdf$/i, '') + `-p${page}.jpg`;
    return base + '/storage/v1/object/public/product-drawings/' + path.split('/').map(encodeURIComponent).join('/');
  }

  function pdfUrl(storagePath) {
    const base = origin();
    if (!base || !storagePath) return '';
    return base + '/storage/v1/object/public/product-drawings/' + String(storagePath).split('/').map(encodeURIComponent).join('/');
  }

  function titleOf(btn) {
    const tr = btn.closest('tr');
    if (tr) {
      const cells = [...tr.cells].map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      const material = String(cells[1] || '').replace(/共.*$/, '').trim();
      const label = [material, cells[2], cells[3]].filter(Boolean).join(' · ');
      if (label) return label.slice(0, 100);
    }
    const row = btn.closest('.drawing-row, .order-card, .remaining-card, article');
    const node = row && row.querySelector('.drawing-name, .order-name, .remaining-name, strong');
    return String((node && node.textContent) || btn.textContent || '图纸').replace(/\s+/g, ' ').trim() || '图纸';
  }

  function loadingWindow(title) {
    const win = window.open('', '_blank');
    if (!win) return null;
    try {
      win.document.open();
      win.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
        <style>html,body{margin:0;height:100%;background:#182326;color:#eaf4f2;font:14px "Microsoft YaHei","微软雅黑",sans-serif}body{display:grid;place-items:center}.box{text-align:center;opacity:.9}i{display:block;width:28px;height:28px;margin:0 auto 12px;border:3px solid #3fd0c9;border-right-color:transparent;border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="box"><i></i><div>正在加载图纸...</div></div></body></html>`);
      win.document.close();
    } catch { }
    return win;
  }

  function renderWindow(win, btn, storagePath, data) {
    if (!win || win.closed) return;
    const pages = Math.max(1, Math.min(200, Number(data && data[storagePath] || 1)));
    const first = previewUrl(storagePath, 1);
    const pdf = pdfUrl(storagePath);
    const title = titleOf(btn);
    const images = [];
    if (first) {
      images.push(`<img class="drawing-page first" src="${esc(first)}" alt="${esc(title)} 第 1 页">`);
      for (let page = 2; page <= pages; page += 1) {
        images.push(`<img class="drawing-page" loading="lazy" src="${esc(previewUrl(storagePath, page))}" alt="${esc(title)} 第 ${page} 页">`);
      }
    }
    const body = images.length
      ? `<div class="pages">${images.join('')}</div>`
      : `<div class="error">没有找到可显示的图纸预览</div>`;
    const fallback = JSON.stringify(pdf);
    try {
      win.document.open();
      win.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
        <style>
          html,body{margin:0;background:#162124;color:#eaf4f2;font:14px "Microsoft YaHei","微软雅黑",sans-serif}
          header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(16,30,33,.94);border-bottom:1px solid #2c4347;backdrop-filter:blur(8px)}
          header b{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          header span{margin-left:auto;color:#9fb9b8;font-size:12px;white-space:nowrap}
          .pages{padding:14px;display:flex;flex-direction:column;align-items:center;gap:14px}
          .drawing-page{display:block;max-width:100%;height:auto;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.35)}
          .error{padding:40px;text-align:center;color:#ffb3a7}
          @media(max-width:640px){header span{display:none}.pages{padding:8px;gap:8px}}
        </style></head><body><header><b>${esc(title)}</b><span>共 ${pages} 页 · 可用浏览器缩放查看</span></header>${body}
        <script>(function(){var first=document.querySelector('.drawing-page.first');if(!first)return;first.addEventListener('error',function(){var pdf=${fallback};if(pdf){location.replace(pdf);}else{document.body.innerHTML='<div class="error">预览图加载失败</div>';}},{once:true});})();<\/script>
        </body></html>`);
      win.document.close();
      try { win.focus(); } catch { }
    } catch { }
  }

  // 点击任意图纸按钮：先同步开新窗口，避免被弹窗拦截；再异步补内容
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-drawing-id]');
    if (!btn) return;
    const win = loadingWindow(titleOf(btn));
    if (!win) return; // 被拦截就交给 app.js 原来的内嵌预览兜底
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    Promise.all([loadMap(), loadManifest()]).then(([paths, data]) => {
      const id = String(btn.dataset.drawingId || '');
      const storagePath = paths && paths.get(id);
      if (!storagePath) {
        try {
          win.document.body.innerHTML = '<div class="error" style="padding:40px;text-align:center;color:#ffb3a7">图纸地址未找到，请刷新页面后重试</div>';
        } catch { }
        return;
      }
      renderWindow(win, btn, storagePath, data);
    }).catch(() => {
      try { win.document.body.innerHTML = '<div class="error" style="padding:40px;text-align:center;color:#ffb3a7">图纸加载失败，请刷新页面后重试</div>'; } catch { }
    });
  }, true);

  // 进图纸库 / 鼠标移到图纸行就先备好地址，点的时候直接出图
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tk-view="drawings"], .side-link[data-desktop-view="drawings"]')) loadMap();
  }, true);
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest('#desktopDrawingsView .drawing-row, [data-drawing-id]')) loadMap();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(() => { void loadMap(); void loadManifest(); }, 0));
  else setTimeout(() => { void loadMap(); void loadManifest(); }, 0);
  /* 2026-10-19：图纸库搜索兜底（输入后列表不筛时，这里自己按文字过滤） */
  function filterDrawingRows(q) {
    const v = document.getElementById('desktopDrawingsView');
    if (!v) return;
    const rows = [...v.querySelectorAll('.drawing-row')];
    if (!rows.length) return;
    const key = String(q || '').trim().toLowerCase();
    let shown = 0;
    rows.forEach((row) => {
      const hit = !key || String(row.textContent || '').toLowerCase().includes(key) ||
        String(row.getAttribute('title') || '').toLowerCase().includes(key);
      row.style.display = hit ? '' : 'none';
      if (hit) shown += 1;
    });
    let tip = document.getElementById('tkDrawEmpty');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'tkDrawEmpty';
      tip.style.padding = '18px 4px';
      tip.style.color = 'var(--muted)';
      (v.querySelector('.panel') || v).appendChild(tip);
    }
    tip.textContent = shown ? '' : ('没有找到「' + q + '」对应的图纸');
    tip.hidden = shown > 0;
  }
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'drawingSearch') setTimeout(() => filterDrawingRows(e.target.value), 60);
  }, true);
  document.addEventListener('click', (e) => {
    if (e.target.closest('#drawingCategoryTabs button') || e.target.closest('[data-format]')) {
      const inp = document.getElementById('drawingSearch');
      if (inp && inp.value.trim()) setTimeout(() => filterDrawingRows(inp.value), 120);
    }
  }, true);
})();