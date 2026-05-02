/**
 * モバイル文字サイズ統一切替 (m.html の m_fz を全ページで尊重)
 * - localStorage 'm_fz' = 's' | 'm' | 'l' | 'xl'
 * - スマホUAのみで CSS zoom + 右上 [A·A] ボタン (固定) を表示
 * - PC では何もしない (PC側は普通の表示)
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      var uaHit = /Android|iPhone|iPod|Mobile/i.test(ua) || (/iPad/.test(ua) && navigator.maxTouchPoints > 1);
      var minSide = Math.min(screen.width || 9999, screen.height || 9999);
      return uaHit && minSide < 820;
    } catch (e) { return false; }
  }
  if (!isMobile()) return;
  var LEVELS = ['s', 'm', 'l', 'xl', 'xxl', 'xxxl'];
  var ZOOM = { s: 0.92, m: 1, l: 1.15, xl: 1.32, xxl: 1.55, xxxl: 1.85 };
  var LBL = { s: 'S', m: 'M', l: 'L', xl: 'XL', xxl: '2XL', xxxl: '3XL' };
  function getLevel() {
    try { var v = localStorage.getItem('m_fz'); return LEVELS.indexOf(v) >= 0 ? v : 'm'; } catch (e) { return 'm'; }
  }
  function applyZoom(level) {
    var z = ZOOM[level] || 1;
    try {
      // CSS zoom が使える環境 (Chromium/WebKit/Firefox 126+) はそれを優先
      document.documentElement.style.zoom = z;
    } catch (e) {}
    var btn = document.getElementById('fz-fab-lvl');
    if (btn) btn.textContent = LBL[level] || 'M';
  }
  function cycle() {
    var cur = getLevel();
    var idx = LEVELS.indexOf(cur);
    var next = LEVELS[(idx + 1) % LEVELS.length];
    try { localStorage.setItem('m_fz', next); } catch (e) {}
    applyZoom(next);
  }
  function mountFab() {
    if (document.getElementById('fz-fab')) return;
    var fab = document.createElement('button');
    fab.id = 'fz-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', '文字サイズ切替');
    fab.title = '文字サイズ切替';
    fab.innerHTML = '<span style="font-size:10px;line-height:1;">A</span>·<span style="font-size:14px;line-height:1;">A</span> <span id="fz-fab-lvl" style="font-size:9px;color:#3b82f6;margin-left:2px;">M</span>';
    fab.style.cssText = [
      'position:fixed',
      'top:calc(env(safe-area-inset-top) + 6px)',
      'right:6px',
      'z-index:99500',
      'background:linear-gradient(135deg,#eff6ff,#dbeafe)',
      'color:#1e3a8a',
      'border:1px solid #93c5fd',
      'border-radius:8px',
      'height:28px',
      'padding:0 8px',
      'font-weight:800',
      'cursor:pointer',
      'display:inline-flex',
      'align-items:center',
      'gap:2px',
      'box-shadow:0 2px 6px rgba(15,23,42,0.18)'
    ].join(';');
    fab.onclick = cycle;
    document.body.appendChild(fab);
    var lv = getLevel();
    var lblEl = document.getElementById('fz-fab-lvl');
    if (lblEl) lblEl.textContent = LBL[lv] || 'M';
  }
  function init() {
    applyZoom(getLevel());
    mountFab();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // 他ウィンドウで変更された場合も同期
  window.addEventListener('storage', function (e) {
    if (e.key === 'm_fz') applyZoom(getLevel());
  });
})();
