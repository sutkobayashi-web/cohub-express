/**
 * モバイル文字サイズ統一適用 (localStorage 'm_fz' を全ページで尊重)
 * - localStorage 'm_fz' = 's' | 'm' | 'l' | 'xl' | 'xxl' | 'xxxl'
 * - スマホ/タブレットUAのみで CSS zoom を適用 (PC では何もしない)
 * - 2026-07-28: 画面上の [A− A＋] ボタンは廃止。切替は「マイページ → 文字サイズ」に集約。
 *   → 各ページからは window.cohubFontZoom (get/set/LEVELS/LBL/ZOOM/supported) を使う。
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      var touch = (navigator.maxTouchPoints || 0) > 1;
      // スマホ + タブレット(iPad/Androidタブ)を対象。iPadOSはMac偽装UAなのでtouchで補足。
      var uaHit = /Android|iPhone|iPod|iPad|Mobile/i.test(ua) || (/Macintosh/.test(ua) && touch);
      var minSide = Math.min(screen.width || 9999, screen.height || 9999);
      // iPad 12.9"縦(1024)まで含め、PC(タッチ無し/大画面)は除外
      return uaHit && minSide < 1200;
    } catch (e) { return false; }
  }
  var LEVELS = ['s', 'm', 'l', 'xl', 'xxl', 'xxxl'];
  var ZOOM = { s: 0.92, m: 1, l: 1.15, xl: 1.32, xxl: 1.55, xxxl: 1.85 };
  var LBL = { s: 'S', m: 'M', l: 'L', xl: 'XL', xxl: '2XL', xxxl: '3XL' };
  var mobile = isMobile();
  function getLevel() {
    try { var v = localStorage.getItem('m_fz'); return LEVELS.indexOf(v) >= 0 ? v : 'm'; } catch (e) { return 'm'; }
  }
  function applyZoom(level) {
    var z = ZOOM[level] || 1;
    try {
      // CSS zoom が使える環境 (Chromium/WebKit/Firefox 126+) はそれを優先
      document.documentElement.style.zoom = z;
    } catch (e) {}
  }
  function setLevel(level) {
    if (LEVELS.indexOf(level) < 0) return getLevel();
    try { localStorage.setItem('m_fz', level); } catch (e) {}
    if (mobile) applyZoom(level);
    return level;
  }
  // マイページ等の設定UIから使う共通API (PCでも参照できるよう early return より前で公開)
  window.cohubFontZoom = {
    LEVELS: LEVELS.slice(), ZOOM: ZOOM, LBL: LBL,
    supported: mobile,      // false = この端末では文字サイズ変更が効かない (PC)
    get: getLevel,
    set: setLevel,
  };

  if (!mobile) return;

  applyZoom(getLevel());
  // 他ウィンドウ/他タブで変更された場合も同期
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
