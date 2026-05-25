/*
 * overlay-history.js v4
 * 副作用: 1) pageshow.persisted (bfcache復帰) 時に reload — ただし以下なら抑止:
 *           - window._farewellMode=true
 *           - .modal.open / dialog[open] が DOM 上にある (モーダル中)
 *           - input/textarea/contentEditable にフォーカス (入力中)
 *         2) Overlay.open/close (opt-in)
 */
(function () {
  if (window.Overlay) return;
  var stack = [];
  function open(id, onClose) {
    if (!id) return;
    if (stack.some(function (s) { return s.id === id; })) return;
    try { history.pushState({ overlayId: id, ts: Date.now() }, ''); } catch (e) {}
    stack.push({ id: id, onClose: onClose });
  }
  function close(id) {
    var idx = stack.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    stack.splice(idx, 1);
    if (history.state && history.state.overlayId === id) {
      try { history.back(); } catch (e) {}
    }
  }
  window.addEventListener('popstate', function () {
    if (stack.length === 0) return;
    var top = stack.pop();
    try { top.onClose && top.onClose(); } catch (e) {}
  });
  function isModalOrInputBusy() {
    try {
      if (document.querySelector('.modal.open, dialog[open]')) return true;
      var ae = document.activeElement;
      if (ae) {
        var tag = (ae.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || ae.isContentEditable) return true;
      }
    } catch (e) {}
    return false;
  }
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && !window._farewellMode && !isModalOrInputBusy()) {
      try { location.reload(); } catch (err) {}
    }
  });
  window.Overlay = { open: open, close: close, _stack: stack };
})();
