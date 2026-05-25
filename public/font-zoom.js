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
    var slot = document.getElementById('fz-slot');
    // 明示的なスロットがなくても、ページ最初の <header> があればそこに自動マウント
    // (右下FABが入力欄やボトムナビと被るのを避けるため、タイトルバー優先)
    var inlineMode = !!slot;
    if (!slot) {
      var headers = document.getElementsByTagName('header');
      if (headers && headers.length > 0) {
        slot = headers[0];
        inlineMode = true;
      }
    }
    var btn = document.createElement('button');
    btn.id = 'fz-fab';
    btn.type = 'button';
    btn.setAttribute('aria-label', '文字サイズ切替');
    btn.title = '文字サイズ切替';
    btn.onclick = cycle;
    if (inlineMode) {
      // インラインモード: ページ側ヘッダー (または明示スロット) に埋め込む
      // 入力欄やボトムナビと被らないよう、タイトルバーへ優先配置
      btn.innerHTML = '<span style="font-size:11px;line-height:1;">A</span>·<span style="font-size:15px;line-height:1;">A</span><span id="fz-fab-lvl" style="font-size:10px;color:#1e3a8a;background:#fff;padding:1px 5px;border-radius:5px;margin-left:4px;font-weight:900;">M</span>';
      btn.style.cssText = [
        'background:rgba(255,255,255,0.22)',
        'color:#fff',
        'border:none',
        'border-radius:6px',
        'padding:5px 8px',
        'font-weight:800',
        'cursor:pointer',
        'display:inline-flex',
        'align-items:center',
        'gap:0',
        'flex-shrink:0',
        'margin:0 6px'
      ].join(';');
      // 右端の「閉じる/✕」系ボタンが末尾にあれば、その手前に挿入。
      // 「戻る/ホーム」は左ナビなのでスキップ (それを anchor にすると A·A が左端に行ってしまう)。
      var anchor = null;
      if (!document.getElementById('fz-slot')) {
        var kids = slot.children;
        // 末尾から最大3要素までだけ検査 — 中間の要素を anchor にしない
        var scanMax = Math.min(3, kids.length);
        for (var i = kids.length - 1; i >= kids.length - scanMax; i--) {
          var c = kids[i];
          if (c.tagName !== 'BUTTON' && c.tagName !== 'A') continue;
          var txt = (c.textContent || '').trim();
          if (/閉じる|✕|×|✖/.test(txt)) { anchor = c; break; }
        }
      }
      if (anchor) slot.insertBefore(btn, anchor);
      else slot.appendChild(btn);
    } else {
      // 既存 FAB モード: 右下フローティング
      btn.innerHTML = '<span style="font-size:11px;line-height:1;">A</span>·<span style="font-size:16px;line-height:1;">A</span><span id="fz-fab-lvl" style="font-size:10px;color:#fff;background:#1e3a8a;padding:2px 6px;border-radius:6px;margin-left:4px;font-weight:900;">M</span>';
      btn.style.cssText = [
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
      document.body.appendChild(btn);
    }
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
