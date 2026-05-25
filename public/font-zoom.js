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
    fab.innerHTML = '<span style="font-size:11px;line-height:1;">A</span>·<span style="font-size:16px;line-height:1;">A</span><span id="fz-fab-lvl" style="font-size:10px;color:#fff;background:#1e3a8a;padding:2px 6px;border-radius:6px;margin-left:4px;font-weight:900;">M</span>';
    // 右下 FAB (親指操作しやすい位置、ヘッダーの「閉じる」ボタン+ボトムナビと重ならない)
    fab.style.cssText = [
      'position:fixed',
      'bottom:calc(env(safe-area-inset-bottom) + 90px)',
      'right:12px',
      'z-index:99500',
      'background:linear-gradient(135deg,#eff6ff,#dbeafe)',
      'color:#1e3a8a',
      'border:1.5px solid #93c5fd',
      'border-radius:24px',
      'height:44px',
      'padding:0 12px',
      'font-weight:800',
      'cursor:pointer',
      'display:inline-flex',
      'align-items:center',
      'gap:0',
      'box-shadow:0 4px 12px rgba(15,23,42,0.25), 0 2px 4px rgba(15,23,42,0.10)'
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

  // 画面端からの横スワイプ抑止 (ブラウザ「戻る/進む」ジェスチャで画面が消える事故対策)
  // 端 EDGE_PX 以内から始まった touch かつ横方向優位な動きだけ preventDefault
  // → 通常の縦スクロール・中央付近の横スワイプUIは無傷
  (function blockEdgeSwipe() {
    var EDGE_PX = 24;
    var startX = 0, startY = 0, fromEdge = false;
    document.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) { fromEdge = false; return; }
      var t = e.touches[0];
      startX = t.pageX; startY = t.pageY;
      var w = window.innerWidth || document.documentElement.clientWidth || 0;
      fromEdge = (startX < EDGE_PX) || (startX > w - EDGE_PX);
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!fromEdge || !e.touches || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.pageX - startX;
      var dy = t.pageY - startY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });
    document.addEventListener('touchend', function () { fromEdge = false; }, { passive: true });
  })();
})();
