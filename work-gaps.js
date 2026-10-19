/* 报工详情：统计「不在计时的时段」（2026-10-19） */
(() => {
  'use strict';
  const MIN = 5;                 // 小于 5 分钟的空档不算
  const DAY_START = 7 * 60;      // 统计窗口 07:00
  const DAY_END = 19 * 60;       // 统计窗口 19:00
  const toMin = (s) => { const m = String(s).match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const fmt = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

  function build() {
    document.querySelectorAll('.work-live-panel, .work-timeline-panel, .work-detail, dialog, .modal-card').forEach(() => {});
    const hosts = [...document.querySelectorAll('section, .panel, dialog, .modal-card')]
      .filter((el) => /计时时段与产量/.test(el.textContent || '') && !el.querySelector('.tk-gap-sum'));
    hosts.forEach((host) => {
      const ranges = [];
      const re = /(\d{1,2}:\d{2})\s*[→\-~至]\s*(\d{1,2}:\d{2})/g;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.nodeValue || '';
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(t))) {
          const a = toMin(m[1]), b = toMin(m[2]);
          if (a != null && b != null && b > a) ranges.push([a, b]);
        }
      }
      if (!ranges.length) return;
      ranges.sort((x, y) => x[0] - y[0]);
      const merged = [];
      ranges.forEach((r) => {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      });
      const gaps = [];
      let cursor = Math.min(DAY_START, merged[0][0]);
      merged.forEach((r) => {
        if (r[0] - cursor >= MIN) gaps.push([cursor, r[0]]);
        cursor = Math.max(cursor, r[1]);
      });
      if (DAY_END - cursor >= MIN) gaps.push([cursor, DAY_END]);
      if (!gaps.length) return;
      const total = gaps.reduce((s, g) => s + (g[1] - g[0]), 0);
      const box = document.createElement('div');
      box.className = 'tk-gap-sum';
      box.innerHTML = '<b>不在计时的时段</b>　合计 ' + Math.round(total / 60 * 10) / 10 + ' 小时' +
        '<div class="list">' + gaps.map((g) => '<span>' + fmt(g[0]) + ' – ' + fmt(g[1]) + '<i>' + (g[1] - g[0]) + ' 分钟</i></span>').join('') + '</div>';
      const h = [...host.querySelectorAll('*')].find((el) => /计时时段与产量/.test(el.textContent || '') && el.children.length <= 2);
      if (h && h.parentElement === host) h.insertAdjacentElement('afterend', box);
      else host.insertBefore(box, host.firstChild);
    });
  }
  setInterval(build, 1200);
})();