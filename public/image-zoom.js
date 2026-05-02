/**
 * 共有画像ライトボックス (ピンチズーム/ダブルタップ/ドラッグパン対応)
 * - 既存ページの openImgModal / closeImgModal を上書き
 * - PC: ホイール拡大縮小 + ドラッグパン
 * - スマホ: 2本指ピンチ + ドラッグパン + ダブルタップ拡大切替
 * - 上下に + / − / ↺ / × ボタン
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__imageZoomInit) return;
  window.__imageZoomInit = true;

  var modal, stage, img, btnIn, btnOut, btnReset;
  var scale = 1, tx = 0, ty = 0;
  var pinch = null;     // {dist:Number, scale:Number, cx:Number, cy:Number}
  var pan = null;       // {x,y,tx,ty}
  var lastTap = 0;
  var SCALE_MIN = 1, SCALE_MAX = 8;

  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'image-zoom-modal';
    modal.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.96)',
      'z-index:99999', 'display:none', 'flex-direction:column',
      'touch-action:none', 'user-select:none', '-webkit-user-select:none'
    ].join(';');
    modal.innerHTML =
      '<div style="position:absolute;top:env(safe-area-inset-top);left:0;right:0;display:flex;justify-content:space-between;padding:8px 10px;z-index:2;">' +
        '<div style="display:flex;gap:6px;">' +
          '<button data-act="out" aria-label="縮小" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:38px;height:38px;border-radius:50%;font-size:22px;cursor:pointer;">−</button>' +
          '<button data-act="reset" aria-label="原寸" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:38px;height:38px;border-radius:50%;font-size:14px;cursor:pointer;">↺</button>' +
          '<button data-act="in" aria-label="拡大" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:38px;height:38px;border-radius:50%;font-size:22px;cursor:pointer;">＋</button>' +
        '</div>' +
        '<button data-act="close" aria-label="閉じる" style="background:rgba(255,255,255,0.2);color:#fff;border:none;width:40px;height:40px;border-radius:50%;font-size:20px;cursor:pointer;">×</button>' +
      '</div>' +
      '<div data-zoom-stage style="flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;position:relative;">' +
        '<img alt="" style="max-width:100%;max-height:100%;transform-origin:center center;will-change:transform;-webkit-user-drag:none;pointer-events:none;display:block;">' +
      '</div>' +
      '<div style="position:absolute;bottom:env(safe-area-inset-bottom);left:0;right:0;text-align:center;color:rgba(255,255,255,0.55);font-size:10px;padding:6px;pointer-events:none;">ピンチで拡大 · ダブルタップで切替 · ドラッグで移動</div>';
    document.body.appendChild(modal);
    stage = modal.querySelector('[data-zoom-stage]');
    img = modal.querySelector('img');
    // ボタン
    modal.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      e.stopPropagation();
      if (act === 'in') zoomTo(scale * 1.5);
      else if (act === 'out') zoomTo(scale / 1.5);
      else if (act === 'reset') { scale = 1; tx = 0; ty = 0; apply(); }
      else if (act === 'close') closeModal();
    });
    // 背景クリック (画像外) で閉じる
    stage.addEventListener('click', function (e) {
      if (e.target === stage) closeModal();
    });
    // PC: ホイール
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var delta = -e.deltaY;
      var factor = delta > 0 ? 1.12 : 1 / 1.12;
      zoomTo(scale * factor, e.clientX, e.clientY);
    }, { passive: false });
    // PC: マウスドラッグ
    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      pan = { x: e.clientX, y: e.clientY, tx: tx, ty: ty };
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!pan) return;
      tx = pan.tx + (e.clientX - pan.x);
      ty = pan.ty + (e.clientY - pan.y);
      apply();
    });
    window.addEventListener('mouseup', function () { pan = null; });
    // タッチ
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        var t1 = e.touches[0], t2 = e.touches[1];
        var dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
        pinch = {
          dist: Math.hypot(dx, dy),
          scale: scale,
          cx: (t1.clientX + t2.clientX) / 2,
          cy: (t1.clientY + t2.clientY) / 2,
          tx: tx, ty: ty
        };
        pan = null;
      } else if (e.touches.length === 1) {
        var t = e.touches[0];
        pan = { x: t.clientX, y: t.clientY, tx: tx, ty: ty };
        // ダブルタップ判定
        var now = Date.now();
        if (now - lastTap < 320) {
          if (scale > 1.05) { scale = 1; tx = 0; ty = 0; }
          else { zoomTo(2.5, t.clientX, t.clientY); }
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    }, { passive: false });
    stage.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        var t1 = e.touches[0], t2 = e.touches[1];
        var dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
        var d = Math.hypot(dx, dy);
        var newScale = clamp(pinch.scale * (d / pinch.dist), SCALE_MIN, SCALE_MAX);
        // ピンチ中心点を保ったままズーム
        var rect = img.getBoundingClientRect();
        var iw = img.naturalWidth || rect.width, ih = img.naturalHeight || rect.height;
        // シンプル化: ズーム比率に応じて translate を補正
        var ratio = newScale / scale;
        tx = (tx - (pinch.cx - window.innerWidth / 2)) * ratio + (pinch.cx - window.innerWidth / 2);
        ty = (ty - (pinch.cy - window.innerHeight / 2)) * ratio + (pinch.cy - window.innerHeight / 2);
        scale = newScale;
        apply();
      } else if (e.touches.length === 1 && pan && scale > 1.01) {
        e.preventDefault();
        var t = e.touches[0];
        tx = pan.tx + (t.clientX - pan.x);
        ty = pan.ty + (t.clientY - pan.y);
        apply();
      }
    }, { passive: false });
    stage.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) pan = null;
    });
    // ESC で閉じる
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
    });
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function apply() {
    if (!img) return;
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }

  function zoomTo(newScale, cx, cy) {
    var s = clamp(newScale, SCALE_MIN, SCALE_MAX);
    if (cx == null) { cx = window.innerWidth / 2; cy = window.innerHeight / 2; }
    var ratio = s / scale;
    tx = (tx - (cx - window.innerWidth / 2)) * ratio + (cx - window.innerWidth / 2);
    ty = (ty - (cy - window.innerHeight / 2)) * ratio + (cy - window.innerHeight / 2);
    scale = s;
    apply();
  }

  function openModal(url) {
    ensureModal();
    img.src = url;
    scale = 1; tx = 0; ty = 0;
    apply();
    modal.style.display = 'flex';
    // 既存ページの旧モーダルが開いていれば閉じる
    var legacy = document.getElementById('img-modal');
    if (legacy && legacy.classList) legacy.classList.remove('open');
  }
  function closeModal() {
    if (!modal) return;
    modal.style.display = 'none';
    if (img) img.src = '';
  }

  // 既存 API を上書き
  window.openImgModal = openModal;
  window.closeImgModal = closeModal;
})();
