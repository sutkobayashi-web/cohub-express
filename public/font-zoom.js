/**
 * 文字サイズ統一適用 (localStorage 'm_fz' を全ページで尊重)
 * - localStorage 'm_fz' = 's'(小さめ) | 'm'(標準) | 'l'(大) | 'xl'(特大) の4段階
 *   旧値 xxl / xxxl は xl に読み替え (2026-07-28に6段階→4段階へ集約)
 * - 2026-07-28: 画面上の [A− A＋] ボタンは廃止。切替は「マイページ → 文字サイズ」に集約。
 *   → 各ページからは window.cohubFontZoom (get/set/LEVELS/LBL/ZOOM) を使う。
 * - スマホ/タブレットだけでなく PC でも適用 (端末=ブラウザごとの設定。既定は標準=等倍)
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      var touch = (navigator.maxTouchPoints || 0) > 1;
      // スマホ + タブレット(iPad/Androidタブ)。iPadOSはMac偽装UAなのでtouchで補足。
      var uaHit = /Android|iPhone|iPod|iPad|Mobile/i.test(ua) || (/Macintosh/.test(ua) && touch);
      var minSide = Math.min(screen.width || 9999, screen.height || 9999);
      return uaHit && minSide < 1200;
    } catch (e) { return false; }
  }
  var LEVELS = ['s', 'm', 'l', 'xl'];
  var ZOOM = { s: 0.9, m: 1, l: 1.15, xl: 1.32 };
  var LBL = { s: '小さめ', m: '標準', l: '大', xl: '特大' };
  var LEGACY = { xxl: 'xl', xxxl: 'xl' };   // 6段階時代の保存値を読み替え
  function getLevel() {
    try {
      var v = localStorage.getItem('m_fz');
      if (LEGACY[v]) return LEGACY[v];
      return LEVELS.indexOf(v) >= 0 ? v : 'm';
    } catch (e) { return 'm'; }
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
    applyZoom(level);
    return level;
  }
  // マイページ等の設定UIから使う共通API
  window.cohubFontZoom = {
    LEVELS: LEVELS.slice(), ZOOM: ZOOM, LBL: LBL,
    supported: true,        // PC/スマホ/タブレットいずれでも変更できる
    get: getLevel,
    set: setLevel,
  };

  applyZoom(getLevel());
  // 他ウィンドウ/他タブで変更された場合も同期
  window.addEventListener('storage', function (e) {
    if (e.key === 'm_fz') applyZoom(getLevel());
  });

  if (!isMobile()) return;

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
