/* 2026-10-19：管理端清掉提示词/引导语 */
(() => {
  'use strict';
  const PAT = /点右上角|点左上角|默认查看|可以按|请先|点击.{0,4}开始|会自动跟着变|会自动进来|建议|提示[:：]|输入\s*\d+\s*套|按.{0,6}筛选|选好后点/;
  const SEL = '.hint2, .tk-more-hint, .os-sub, .pu-sub, .ql-sub, .iv-sub, .page-hint, .form-hint, .help-text, .tk-gs-hint';

  function clean() {
    document.querySelectorAll(SEL).forEach((el) => { el.style.display = 'none'; });
    document.querySelectorAll('#desktopView .sub, .desktop-view > .topbar .sub, .desktop-view .eyebrow + h1 + p').forEach((el) => {
      if (PAT.test(el.textContent || '')) el.style.display = 'none';
    });
    document.querySelectorAll('.desktop-view p, .desktop-view small, .desktop-view em, .desktop-view div').forEach((el) => {
      if (el.closest('.sv2-page')) return;
      if (el.children.length > 2) return;
      const t = String(el.textContent || '').trim();
      if (!t || t.length > 60) return;
      if (!PAT.test(t)) return;
      if (el.querySelector('input, select, textarea, button')) return;
      el.style.display = 'none';
    });
  }
  setInterval(clean, 1500);
})();