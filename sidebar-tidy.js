/* 2026-10-19：去掉侧栏底部「实时同步中 / 打印助手」那块（阿泽说没用） */
(() => {
  'use strict';
  function tidy() {
    const foot = document.querySelector('.sidebar-foot');
    if (!foot) return;
    [...foot.children].forEach((el) => {
      const t = String(el.textContent || '');
      if (t.includes('实时同步中') || t.includes('打印助手')) el.style.display = 'none';
    });
  }
  setInterval(tidy, 800);
})();