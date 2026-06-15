// 共通 音声入力(文字起こし) — コメント等のテキスト欄にフォーカスすると🎤が出て、声→そのまま入力。
// まとめる君は通さない(コメントは認識精度で十分)。自動再開なし(点滅防止)。
// 使い方: 各ページの末尾に <script src="/voice-input.js" defer></script> を1行追加するだけ。
(function () {
  if (typeof window === 'undefined') return;
  if (window.__voiceInputLoaded) return;
  window.__voiceInputLoaded = true;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // 非対応端末は何もしない

  var target = null, recog = null, listening = false, btn = null, hideTimer = null, base = '';

  // コメント等の「文字を入力する欄」か判定 (検索/ログイン/数値などは除外)
  function isTextField(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var t = (el.type || 'text').toLowerCase();
    if (t !== 'text' && t !== 'search') return false;
    if (el.readOnly || el.disabled) return false;
    var ph = (el.getAttribute('placeholder') || '');
    if (/コメント|応援|返信|メッセージ|ひとこと|感想|つぶやき|comment|reply/i.test(ph)) return true;
    // 親要素にコメント系のクラス/ID があれば対象
    if (el.closest('.comments,.comment,.cinput,.cmt,.reply,[class*="comment"],[class*="Comment"],[class*="reply"]')) return true;
    // 検索ボックスは除外
    if (/検索|search|絞込|絞り込み|filter/i.test(ph)) return false;
    return false;
  }

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'vi-mic-btn';
    btn.textContent = '🎤';
    btn.setAttribute('aria-label', '声で入力');
    btn.title = '声で入力';
    btn.style.cssText = 'position:fixed;right:14px;bottom:96px;z-index:99990;width:58px;height:58px;border-radius:50%;border:none;background:linear-gradient(135deg,#fb7185,#e11d48);color:#fff;font-size:25px;line-height:1;box-shadow:0 6px 16px rgba(225,29,72,.40);cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;';
    // タップしてもフォーカスが外れないように(入力欄を保持)
    var keep = function (e) { e.preventDefault(); };
    btn.addEventListener('mousedown', keep);
    btn.addEventListener('touchstart', keep, { passive: false });
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    return btn;
  }
  function showBtn() { ensureBtn().style.display = 'flex'; }
  function hideBtn() { if (btn && !listening) btn.style.display = 'none'; }
  function setOn(on) {
    if (!btn) return;
    btn.textContent = on ? '⏹' : '🎤';
    btn.style.background = on ? 'linear-gradient(135deg,#1d4ed8,#1e3a8a)' : 'linear-gradient(135deg,#fb7185,#e11d48)';
    btn.style.animation = on ? 'viPulse 1.2s infinite' : 'none';
  }
  function stop() { if (recog) { try { recog.stop(); } catch (e) {} } }

  function toggle() {
    if (!target) return;
    if (listening) { stop(); return; }
    recog = new SR();
    recog.lang = 'ja-JP'; recog.interimResults = true; recog.continuous = true;
    base = target.value ? target.value + ' ' : '';
    recog.onresult = function (e) {
      var fin = '', itm = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) fin += r[0].transcript; else itm += r[0].transcript;
      }
      if (fin) base += fin;
      target.value = base + itm;
      try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {}
    };
    recog.onend = function () { listening = false; setOn(false); };
    recog.onerror = function () { listening = false; setOn(false); };
    try { recog.start(); listening = true; setOn(true); } catch (e) {}
  }

  document.addEventListener('focusin', function (e) {
    if (isTextField(e.target)) { target = e.target; clearTimeout(hideTimer); showBtn(); }
  });
  document.addEventListener('focusout', function () {
    if (listening) stop();
    hideTimer = setTimeout(hideBtn, 350);
  });

  // pulse keyframe
  try {
    var st = document.createElement('style');
    st.textContent = '@keyframes viPulse{0%,100%{box-shadow:0 0 0 0 rgba(29,78,216,.4);}50%{box-shadow:0 0 0 10px rgba(29,78,216,0);}}';
    document.head.appendChild(st);
  } catch (e) {}
})();
