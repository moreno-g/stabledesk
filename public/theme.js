// Shared 3-state theme control (Auto / Light / Dark), used by the terminal and the docs page.
// Auto = follow the OS setting; explicit choices are stored and shared across pages.
(function () {
  var root = document.documentElement, KEY = 'arc-theme', order = ['auto', 'light', 'dark'];
  var ICON = {
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3 A9 9 0 0 1 12 21 Z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  var LABEL = { auto: 'Auto (system)', light: 'Light', dark: 'Dark' };

  function get() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply(m) { if (m === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', m); }

  apply(get()); // run immediately (script is render-blocking in <head>) → no flash, respects system in Auto

  function wire() {
    var b = document.getElementById('themeBtn');
    if (!b) return;
    function paint() { var m = get(); b.innerHTML = ICON[m]; var t = 'Theme: ' + LABEL[m] + ' — click to change'; b.title = t; b.setAttribute('aria-label', t); }
    paint();
    b.addEventListener('click', function () {
      var next = order[(order.indexOf(get()) + 1) % order.length];
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next); paint();
    });
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (get() === 'auto') paint(); }); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
