/* 未交清单列宽拖拽（修复：app.js 只给首屏那批手柄绑了事件，表格重绘后就失效） */
(() => {
  'use strict';
  let drag = null;

  document.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.col-resizer');
    if (!handle || e.button !== 0) return;
    const th = handle.closest('th');
    const table = handle.closest('table');
    if (!th || !table) return;
    e.preventDefault();
    e.stopPropagation();
    const headers = [...table.querySelectorAll('thead th')];
    const index = headers.indexOf(th);
    const cols = [...table.querySelectorAll('colgroup col')];
    drag = { handle, th, table, index, cols, startX: e.clientX, startW: th.getBoundingClientRect().width };
    handle.classList.add('dragging');
    try { document.body.style.cursor = 'col-resize'; } catch { }
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = Math.max(44, Math.min(560, Math.round(drag.startW + e.clientX - drag.startX)));
    if (drag.cols[drag.index]) drag.cols[drag.index].style.width = w + 'px';
    drag.th.style.width = w + 'px';
    e.preventDefault();
  }, true);

  const end = () => {
    if (!drag) return;
    drag.handle.classList.remove('dragging');
    try { document.body.style.cursor = ''; } catch { }
    drag = null;
  };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);

  // 双击手柄：恢复自动宽度
  document.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('.col-resizer');
    if (!handle) return;
    const th = handle.closest('th');
    const table = handle.closest('table');
    const headers = table ? [...table.querySelectorAll('thead th')] : [];
    const i = th ? headers.indexOf(th) : -1;
    const cols = table ? [...table.querySelectorAll('colgroup col')] : [];
    if (i >= 0 && cols[i]) cols[i].style.width = '';
    if (th) th.style.width = '';
  }, true);
  /* 2026-10-19：给考勤等表格自动装拖拽手柄（保留当前列宽当初始值） */
  function enhanceTables() {
    document.querySelectorAll('#desktopAttendanceView table').forEach((table) => {
      if (table.dataset.tkResizable === '1') return;
      const ths = [...table.querySelectorAll('thead th')];
      if (!ths.length) return;
      const widths = ths.map((th) => Math.max(56, Math.round(th.getBoundingClientRect().width)));
      let cg = table.querySelector('colgroup');
      if (!cg) {
        cg = document.createElement('colgroup');
        ths.forEach(() => cg.appendChild(document.createElement('col')));
        table.insertBefore(cg, table.firstChild);
      }
      [...cg.children].forEach((col, i2) => { if (widths[i2]) col.style.width = widths[i2] + 'px'; });
      table.style.tableLayout = 'fixed';
      ths.forEach((th) => {
        th.style.position = 'relative';
        if (th.querySelector('.col-resizer')) return;
        const s = document.createElement('span');
        s.className = 'col-resizer';
        s.setAttribute('title', '拖动调整列宽，双击恢复');
        th.appendChild(s);
      });
      table.dataset.tkResizable = '1';
    });
  }
  setInterval(enhanceTables, 1500);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tk-view="attendance"]')) setTimeout(enhanceTables, 400);
  }, true);
})();