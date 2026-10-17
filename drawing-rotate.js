/* ============================================================
   图纸预览：加「左转 / 右转 / 复位」
   文件：public/drawing-rotate.js        建立日期：2026-10-17
   为什么单独一个文件：图纸预览器是 app.js 建的，不能改 app.js。
   做法：只包一层 wrapper + CSS transform，不改图片本身、不影响缩放。
   旋转 90°/270° 时 wrapper 的宽高要对调，否则会被裁掉一截。
   回滚：删掉 index.html 里这一行 <script> 即可。
   ============================================================ */
(() => {
  'use strict';

  const isMobileBoard = new URLSearchParams(location.search).get('view') === 'mobile'
    || /\/mobile\/?$/.test(location.pathname)
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  // 手机端不加载旋转功能：不包 wrapper、不挂监听、不创建按钮，减少打开图纸的负担。
  if (isMobileBoard) return;

  const LS = 'tkDrawingRotate';
  let rot = 0;
  try { rot = ((Number(localStorage.getItem(LS) || 0) % 360) + 360) % 360; } catch { rot = 0; }

  const $ = (s) => document.querySelector(s);

  function pagesBox() { return document.getElementById('drawingViewerPages'); }

  function wrap(img) {
    const p = img.parentElement;
    if (p && p.classList.contains('tk-rot-wrap')) return p;
    const w = document.createElement('div');
    w.className = 'tk-rot-wrap';
    img.parentNode.insertBefore(w, img);
    w.appendChild(img);
    return w;
  }

  function apply() {
    const box = pagesBox();
    if (!box) return;
    const avail = Math.max(160, box.clientWidth - 24);
    box.querySelectorAll('img').forEach((img) => {
      const w = wrap(img);
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      w.dataset.rot = String(rot);
      if (!nw || !nh) {
        // 图还没加载完：先不当成旋转容器，否则绝对定位会让盒子塌成 0 高、图看不见
        w.classList.add('is-pending');
        w.style.width = '';
        w.style.height = '';
        img.style.width = '';
        img.style.height = '';
        return;
      }
      w.classList.remove('is-pending');
      const h = Math.round(avail * nh / nw);  // 按宽度铺满时的图片高度
      if (rot % 180 === 90) {
        w.style.width = h + 'px';
        w.style.height = avail + 'px';
      } else {
        w.style.width = avail + 'px';
        w.style.height = h + 'px';
      }
      img.style.width = avail + 'px';
      img.style.height = h + 'px';
    });
    const deg = document.querySelector('.tk-rot-deg');
    if (deg) deg.textContent = rot + '°';
    const reset = document.querySelector('.tk-rot-reset');
    if (reset) reset.style.display = rot ? '' : 'none';
  }

  function setRot(next) {
    rot = ((next % 360) + 360) % 360;
    try { localStorage.setItem(LS, String(rot)); } catch { }
    apply();
  }

  function buildControls() {
    const actions = $('.drawing-viewer-actions');
    if (!actions || actions.querySelector('.tk-rot-btn')) return;
    const mk = (cls, title, html) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'button ghost tk-rot-btn ' + cls;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = html;
      return b;
    };
    const left = mk('tk-rot-left', '向左旋转 90°', '↺');
    const right = mk('tk-rot-right', '向右旋转 90°', '↻');
    const reset = mk('tk-rot-reset', '恢复原始方向', '复位');
    const deg = document.createElement('span');
    deg.className = 'tk-rot-deg';
    deg.textContent = rot + '°';
    // 顺序：↺  90°  ↻  复位  |  外链  关闭
    const anchor = actions.querySelector('#drawingViewerClose') || actions.firstChild;
    [left, deg, right, reset].forEach((el) => actions.insertBefore(el, anchor));
    left.addEventListener('click', () => setRot(rot - 90));
    right.addEventListener('click', () => setRot(rot + 90));
    reset.addEventListener('click', () => setRot(0));
    reset.style.display = rot ? '' : 'none';
  }

  window.__tkRotateApply = apply;
  let mo = null;
  function watch() {
    const viewer = $('.drawing-viewer');
    if (!viewer) return;
    buildControls();
    if (!mo) {
      mo = new MutationObserver(() => {
        buildControls();
        // 换页 / 换图 / 首次渲染都会走到这里
        clearTimeout(watch.t);
        watch.t = setTimeout(apply, 60);
      });
      mo.observe(viewer, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'hidden', 'style'] });
    }
    apply();
  }

  // 图片加载完再算尺寸（第一张常常是后到的）
  document.addEventListener('load', (e) => {
    if (e.target && e.target.tagName === 'IMG' && e.target.closest('#drawingViewerPages')) apply();
  }, true);
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(apply, 150); });

  const tick = setInterval(() => {
    if ($('.drawing-viewer')) { watch(); clearInterval(tick); }
  }, 500);
  setTimeout(() => clearInterval(tick), 60000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(watch, 0));
  else setTimeout(watch, 0);
})();