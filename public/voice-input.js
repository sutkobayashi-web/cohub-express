// 共通 音声入力 — ハイブリッド方式。
//  対応端末(Android/PC Chrome等): Web Speech API でリアルタイム文字起こし(ラグなし)。
//  非対応(iPhone Safari等): MediaRecorder録音→サーバー(Gemini)で文字起こし(話し終わり後に反映)。
// 送信/投稿ボタンの隣に🎤を常時表示(自動挿入)。window.VoiceInput.dictate(field,btn) を提供。
(function () {
  if (typeof window === 'undefined' || window.__voiceInputLoaded) return;
  window.__voiceInputLoaded = true;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ===== 共通: ボタン表示 =====
  function setBtn(btn, state) {
    if (!btn) return;
    btn.classList.toggle('vi-rec', state === 'rec');
    btn.classList.toggle('vi-busy', state === 'busy');
    btn.disabled = (state === 'busy');
    if (!btn.classList.contains('vi-keep-text')) {
      btn.textContent = state === 'rec' ? '⏹' : (state === 'busy' ? '…' : '🎤');
    }
  }
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99991;background:rgba(15,23,42,.9);color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;font-weight:700;box-shadow:0 4px 12px rgba(0,0,0,.3);display:none;';
      document.body.appendChild(toastEl);
    }
    if (msg) { toastEl.textContent = msg; toastEl.style.display = 'block'; }
    else { toastEl.style.display = 'none'; }
  }

  // ===== Web Speech API 経路 (リアルタイム) =====
  var sr = null, srOn = false, srField = null, srBtn = null;
  function srStart(field, btn) {
    sr = new SR(); sr.lang = 'ja-JP'; sr.interimResults = true; sr.continuous = true;
    var base = field.value ? field.value + ' ' : '';
    sr.onresult = function (e) {
      var fin = '', itm = '';
      for (var i = e.resultIndex; i < e.results.length; i++) { var r = e.results[i]; if (r.isFinal) fin += r[0].transcript; else itm += r[0].transcript; }
      if (fin) base += fin;
      field.value = base + itm;
      try { field.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {}
    };
    sr.onend = function () { srOn = false; setBtn(srBtn, 'idle'); };
    sr.onerror = function () { srOn = false; setBtn(srBtn, 'idle'); };
    srField = field; srBtn = btn;
    try { sr.start(); srOn = true; setBtn(btn, 'rec'); } catch (e) {}
  }

  // ===== MediaRecorder + サーバー文字起こし 経路 (iPhone等) =====
  var rec = null, stream = null, chunks = [], busy = false;
  function cleanup() { if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; } }
  async function mrStart(field, btn) {
    if (busy) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { alert('この端末は音声入力に対応していません。'); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { alert('マイクの使用を許可してください。'); return; }
    chunks = [];
    var mime = '';
    try { if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm'; else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4'; } catch (e) {}
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (e) { rec = new MediaRecorder(stream); }
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () { mrFinish(field, btn); };
    rec.start();
    setBtn(btn, 'rec'); toast('🎙 録音中… 話し終わったらもう一度タップ');
  }
  function mrStop() { try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {} }
  async function mrFinish(field, btn) {
    cleanup(); busy = true; setBtn(btn, 'busy'); toast('🖊 文字起こし中…');
    var type = (rec && rec.mimeType) || 'audio/webm';
    var blob = new Blob(chunks, { type: type });
    var ext = type.indexOf('mp4') >= 0 ? 'mp4' : (type.indexOf('webm') >= 0 ? 'webm' : 'dat');
    var text = '';
    try {
      var fd = new FormData(); fd.append('audio', blob, 'voice.' + ext);
      var tok = localStorage.getItem('cohub_token');
      var r = await fetch('/api/voice/transcribe', { method: 'POST', headers: tok ? { 'Authorization': 'Bearer ' + tok } : {}, body: fd });
      var d = await r.json();
      if (d && d.success) text = (d.text || '').trim(); else alert('文字起こしに失敗しました。');
    } catch (e) { alert('通信エラーが発生しました。'); }
    busy = false; setBtn(btn, 'idle'); toast('');
    if (text && field) {
      var cur = field.value || '';
      field.value = cur ? (cur.replace(/\s*$/, '') + ' ' + text) : text;
      try { field.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      try { field.focus(); } catch (e) {}
    }
  }

  // ===== 統一入口 =====
  function dictate(field, btn) {
    if (!field) return;
    if (field.disabled) { alert('先に入力欄を選んでください。'); return; }
    if (SR) { if (srOn) { try { sr.stop(); } catch (e) {} } else { srStart(field, btn); } }
    else { if (rec && rec.state === 'recording') mrStop(); else mrStart(field, btn); }
  }
  window.VoiceInput = { dictate: dictate, realtime: !!SR };

  // ===== 送信/投稿ボタンの隣に🎤を自動挿入 =====
  var SEND_RE = /送信|投稿|送る|コメント|返信|とうこう|つぶやく|書き込む|書込/;
  function fieldFor(btn) {
    var cont = btn.closest('form, .cinput, .composer, .comments, [class*="comment"], #input, .input-bar, .post-input, .reply') || btn.parentElement;
    if (!cont) return null;
    if (cont.querySelector('.vi-mic, .cmic, .mic')) return null;
    return cont.querySelector('textarea, input[type="text"], input:not([type])');
  }
  function injectMics() {
    var btns = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.dataset.viScanned) continue;
      b.dataset.viScanned = '1';
      var label = ((b.textContent || '') + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || ''));
      if (!SEND_RE.test(label)) continue;
      if (/検索|search|絞込|絞り込み/.test(label)) continue;
      var field = fieldFor(b);
      if (!field) continue;
      var mic = document.createElement('button');
      mic.type = 'button'; mic.className = 'vi-mic'; mic.textContent = '🎤';
      mic.title = '声で入力'; mic.setAttribute('aria-label', '声で入力');
      (function (f, m) {
        mic.addEventListener('mousedown', function (e) { e.preventDefault(); });
        mic.addEventListener('click', function (e) { e.preventDefault(); dictate(f, m); });
      })(field, mic);
      try { b.parentNode.insertBefore(mic, b); } catch (e) {}
    }
  }
  var scanTimer = null;
  function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(injectMics, 250); }

  function boot() {
    var st = document.createElement('style');
    st.textContent =
      '.vi-mic{width:40px;height:40px;min-width:40px;border-radius:50%;border:1px solid #fbcfe8;background:#fff;color:#e11d48;font-size:19px;line-height:1;cursor:pointer;flex-shrink:0;padding:0;margin:0 6px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;}' +
      '.vi-rec{background:#1d4ed8 !important;color:#fff !important;border-color:#1d4ed8 !important;animation:viPulse 1.2s infinite;}' +
      '.vi-busy{opacity:.6;}' +
      '@keyframes viPulse{0%,100%{box-shadow:0 0 0 0 rgba(29,78,216,.4);}50%{box-shadow:0 0 0 8px rgba(29,78,216,0);}}';
    document.head.appendChild(st);
    if (!window.VOICE_NO_AUTOINJECT) {
      injectMics();
      try { new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
