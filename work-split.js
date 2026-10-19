/* 报工页：左侧列表 + 右侧详情（不改 app.js，只在渲染后接管布局） 2026-10-19 */
(() => {
  'use strict';
  const VIEW = 'desktopWorkReportView';
  let lastTr = null;

  function build() {
    const v = document.getElementById(VIEW);
    if (!v) return;
    const panel = v.querySelector('.work-live-panel');
    if (!panel) return;
    const table = panel.querySelector('table');
    if (!table || !table.querySelector('tbody')) return;
    if (panel.querySelector('.tk-work-split')) return;

    const split = document.createElement('div');
    split.className = 'tk-work-split';
    const left = document.createElement('div');
    left.className = 'tk-work-left';
    const right = document.createElement('div');
    right.className = 'tk-work-right';
    table.parentNode.insertBefore(split, table);
    split.appendChild(left);
    split.appendChild(right);
    left.appendChild(table);
    right.innerHTML = '<div class="tk-work-empty">点左侧任意一行<br>这里显示该员工当天的逐笔明细</div>';

    table.addEventListener('click', (e) => {
      const tr = e.target.closest('tbody tr');
      if (!tr || tr === lastTr) return;
      lastTr = tr;
      [...table.querySelectorAll('tbody tr')].forEach((x) => x.classList.toggle('on', x === tr));
      const heads = [...table.querySelectorAll('thead th')].map((t) => t.textContent.trim());
      const cells = [...tr.children].map((td) => td.innerText.trim().replace(/\s+/g, ' '));
      right.innerHTML = '<h4>' + (cells[0] || '明细') + '</h4>' +
        '<dl>' + heads.map((h, i) => '<dt>' + (h || '—') + '</dt><dd>' + (cells[i] || '—') + '</dd>').join('') + '</dl>';
    });
  }

  setInterval(build, 1200);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-tk-view="work"]')) setTimeout(build, 400);
  }, true);
})();