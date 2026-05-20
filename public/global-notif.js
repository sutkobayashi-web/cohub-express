// CoWell 共通DM/グループメッセージ + みんなの声(plaza投稿) 通知 (全サブページ共通)
// - チャイム + トースト + バッジ + TTSアナウンス
// - ページが何であろうとサブページ表示中も着信に気づける
// - chat-simple.html や m.html は専用ハンドラがあるので二重発火回避 (DM/グループのみフラグで判定)
// - plaza:new は「みんなの声を無碍にしない」設計思想([[health_philosophy_core]])に基づき全ページで発火
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__cohub_global_notif_loaded) return;
  window.__cohub_global_notif_loaded = true;
  var path = location.pathname || '';
  // DM/グループの専用ハンドラを持つページ (チャット/ホーム/モバイル/ルート)
  var hasOwnChatHandler = /^\/chat-simple|^\/m(\/|$|\?)|^\/home(\.html|\/|$|\?)|^\/$/.test(path);
  // plaza自体を開いている時はリアルタイム描画があるので、アナウンスは抑制
  var onPlaza = /^\/plaza(\.html|\/|$|\?)/.test(path);

  var token = '';
  try { token = localStorage.getItem('cohub_token') || ''; } catch (e) {}
  if (!token) return;

  // ===== AudioContext (iOS Safari 対策で都度タッチ保温) =====
  var _ctx = null;
  var _chimeOn = true;
  try { if (localStorage.getItem('cohub_chat_notif_on') === '0') _chimeOn = false; } catch (e) {}

  // 外部からON/OFF切替できるよう公開 (home.html のヘッダー🔔ボタン用)
  window.cohubGetChimeOn = function () { return _chimeOn; };
  window.cohubSetChimeOn = function (on) {
    _chimeOn = !!on;
    try { localStorage.setItem('cohub_chat_notif_on', _chimeOn ? '1' : '0'); } catch (e) {}
    if (_chimeOn) { try { warmCtx(); playChime(); } catch (e) {} }
    return _chimeOn;
  };

  function ensureCtx() {
    if (!_ctx) {
      try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    return _ctx;
  }

  document.addEventListener('click', warmCtx, { passive: true });
  document.addEventListener('touchstart', warmCtx, { passive: true });
  function warmCtx() {
    var ctx = ensureCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      var b = ctx.createBuffer(1, 1, 22050);
      var s = ctx.createBufferSource(); s.buffer = b;
      s.connect(ctx.destination); s.start(0);
    } catch (e) {}
  }

  async function playChime() {
    if (!_chimeOn) return;
    var ctx = ensureCtx();
    if (!ctx) return;
    try {
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch (e) {}
      }
      if (ctx.state !== 'running') return;
      var now = ctx.currentTime;
      var master = ctx.createGain(); master.gain.value = 1.0; master.connect(ctx.destination);
      function note(freq, off, dur, vol) {
        var t0 = now + off;
        var env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        env.connect(master);
        var o1 = ctx.createOscillator();
        o1.type = 'sine'; o1.frequency.value = freq;
        o1.connect(env); o1.start(t0); o1.stop(t0 + dur + 0.02);
        var o2 = ctx.createOscillator();
        o2.type = 'triangle'; o2.frequency.value = freq * 2;
        var o2g = ctx.createGain(); o2g.gain.value = 0.18;
        o2.connect(o2g); o2g.connect(env);
        o2.start(t0); o2.stop(t0 + dur + 0.02);
      }
      // ピン↑ポーン↑×2
      note(1047, 0.00, 0.12, 0.40);
      note(1319, 0.13, 0.42, 0.50);
      note(1047, 0.65, 0.12, 0.40);
      note(1319, 0.78, 0.42, 0.50);
    } catch (e) {}
  }

  // ===== トースト (タップで /chat-simple へ) =====
  function showToast(msg) {
    var t = document.getElementById('gn-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gn-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;padding:14px 24px;border-radius:14px;font-size:14px;font-weight:700;z-index:99999;max-width:90vw;text-align:center;opacity:0;transition:opacity 0.25s;pointer-events:auto;box-shadow:0 8px 24px rgba(2,132,199,0.4);cursor:pointer;display:flex;align-items:center;gap:8px;border:2px solid rgba(255,255,255,0.3);';
      t.onclick = function () { location.href = '/chat-simple.html'; };
      document.body.appendChild(t);
    }
    t.innerHTML = '<span>' + msg + '</span><span style="font-size:11px;opacity:0.85;background:rgba(255,255,255,0.2);padding:3px 8px;border-radius:8px;">タップ</span>';
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; }, 7000);
  }

  // ===== plaza用トースト (タップで /plaza.html へ、緑グラデで区別) — 大きめサイズで存在感UP =====
  function showPlazaToast(msg) {
    var t = document.getElementById('gn-plaza-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gn-plaza-toast';
      t.style.cssText = 'position:fixed;left:50%;top:32px;transform:translateX(-50%);background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:22px 36px;border-radius:20px;font-size:20px;font-weight:800;letter-spacing:0.5px;z-index:99999;max-width:94vw;text-align:center;opacity:0;transition:opacity 0.25s, transform 0.25s;pointer-events:auto;box-shadow:0 14px 36px rgba(5,150,105,0.45), 0 4px 12px rgba(0,0,0,0.20);cursor:pointer;display:flex;align-items:center;gap:14px;border:3px solid rgba(255,255,255,0.45);';
      t.onclick = function () { location.href = '/plaza.html'; };
      document.body.appendChild(t);
    }
    t.innerHTML = '<span style="line-height:1.4;">' + msg + '</span><span style="font-size:14px;opacity:0.95;background:rgba(255,255,255,0.25);padding:6px 14px;border-radius:12px;font-weight:800;letter-spacing:1px;white-space:nowrap;">ひろばへ →</span>';
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; }, 7000);
  }

  // ===== TTSアナウンス (Google Cloud TTS /api/voice/tts、いつもの総合案内と同じ声) =====
  // フォールバック: 401/ネットワーク失敗時のみSpeechSynthesis
  var _ttsOn = true;
  try { if (localStorage.getItem('cohub_plaza_tts_on') === '0') _ttsOn = false; } catch (e) {}
  var _ttsBlobCache = new Map(); // text -> blobURL
  var _ttsCurrentAudio = null;
  function _fallbackSpeak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP'; u.rate = 1.05; u.pitch = 1.0; u.volume = 0.9;
      try { window.speechSynthesis.cancel(); } catch (e) {}
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  async function speak(text) {
    if (!_ttsOn || !text) return;
    // 進行中の読み上げを止める (連投時の重なり防止)
    try {
      if (_ttsCurrentAudio) { _ttsCurrentAudio.pause(); _ttsCurrentAudio = null; }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch (e) {}
    var voice = 'ja-JP-Neural2-B', speed = 1.00, pitch = 5; // 少しゆっくり+ピッチUPで元気よく
    var key = text + '|' + voice + '|' + speed + '|' + pitch;
    try {
      var url = _ttsBlobCache.get(key);
      if (!url) {
        var res = await fetch('/api/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ text: text, voice: voice, speed: speed, pitch: pitch }),
        });
        if (!res.ok) { console.warn('[gn] tts http', res.status); _fallbackSpeak(text); return; }
        var blob = await res.blob();
        url = URL.createObjectURL(blob);
        _ttsBlobCache.set(key, url);
        if (_ttsBlobCache.size > 50) {
          var first = _ttsBlobCache.keys().next().value;
          try { URL.revokeObjectURL(_ttsBlobCache.get(first)); } catch (e) {}
          _ttsBlobCache.delete(first);
        }
      }
      var audio = new Audio(url);
      audio.volume = 1.0;
      _ttsCurrentAudio = audio;
      audio.addEventListener('ended', function () { if (_ttsCurrentAudio === audio) _ttsCurrentAudio = null; });
      try { await audio.play(); } catch (e) { console.warn('[gn] tts play', e && e.message); _fallbackSpeak(text); }
    } catch (e) { console.warn('[gn] tts fail', e && e.message); _fallbackSpeak(text); }
  }
  // 公開: 設定UIから ON/OFF
  window.cohubPlazaTtsToggle = function (on) {
    _ttsOn = !!on;
    try { localStorage.setItem('cohub_plaza_tts_on', on ? '1' : '0'); } catch (e) {}
  };

  // ===== Socket.IO 接続 =====
  function connect() {
    try {
      var socket = io({ auth: { token: token } });
      socket.on('connect', function () { console.log('[gn] socket connected'); });
      socket.on('session:kicked', function () {
        try { localStorage.removeItem('cohub_token'); } catch (e) {}
        alert('別の端末で同じアカウントがログインされたため、このセッションは終了します。');
        location.replace('/');
      });
      socket.on('connect_error', function (err) {
        if (err && (err.message === 'session_kicked' || err.message === 'unauth')) {
          try { localStorage.removeItem('cohub_token'); } catch (e) {}
          if (err.message === 'session_kicked') alert('別の端末で同じアカウントがログインされたため、このセッションは終了します。');
          location.replace('/');
        }
      });
      var myUid = null;
      try { myUid = JSON.parse(localStorage.getItem('cohub_user') || '{}').uid || null; } catch (e) {}

      // DM/グループ通知: 自前ハンドラを持たないページのみ発火
      if (!hasOwnChatHandler) {
        socket.on('dm:msg', function (p) {
          if (!p || p.from === myUid) return; // 自分の echo は無視
          playChime();
          showToast('💬 メッセージ: ' + ((p.content || '').slice(0, 40) || '📎 添付'));
        });
        socket.on('group:msg', function (p) {
          if (!p || p.from === myUid) return;
          playChime();
          showToast('💬 グループ: ' + ((p.content || '').slice(0, 40) || '📎 添付'));
        });
      }

      // 🟢 みんなの声 plaza:new — 全ページで発火 (plaza自身は除く=リアルタイム描画と二重になる)
      // 設計思想: 「どんな投稿も反応してあげて無碍にしたくない」
      var _plazaLastAt = 0;
      socket.on('plaza:new', function (ev) {
        if (!ev || !ev.post) return;
        var p = ev.post;
        if (p.author_id === myUid) return; // 自分の echo は無視
        // 連投スロットル (3秒)
        var now = Date.now();
        if (now - _plazaLastAt < 3000) return;
        _plazaLastAt = now;
        if (onPlaza) return; // plaza自体は専用UIに任せる

        var who = (p.author_nickname || p.author_name || 'どなたか').replace(/^🎭\s*/, '');
        var cat = p.category || '投稿';
        // 関西弁化 — 「で」は TTS で上がり調子になりがちなので「わ。」で統一(下がり調子の宣言)
        var verbKansai = (cat === '食事')     ? 'メシ載せてくれはったわ。'
                       : (cat === '相談')     ? '相談あげてくれはったわ。'
                       : (cat === '雑談')     ? 'なんかつぶやいてはるわ。'
                       : (cat === '健康Tips') ? 'ええ話してくれてはるわ。'
                                              : '投稿してくれはったわ。';
        var verbToast  = (cat === '食事')     ? '食事を投稿しました'
                       : (cat === '相談')     ? '相談を投稿しました'
                       : (cat === '雑談')     ? 'つぶやきました'
                       : (cat === '健康Tips') ? '健康Tipsをシェアしました'
                                              : '投稿しました';
        playChime();
        var emoji = (cat === '食事') ? '🍱' : (cat === '相談') ? '💬' : (cat === '雑談') ? '☕' : (cat === '健康Tips') ? '💡' : '📢';
        showPlazaToast(emoji + ' ' + who + 'さん ' + verbToast);
        speak(who + 'さんが' + verbKansai);
        // バッジバンプ (home/m に居なくても他ページの b-plaza があれば更新)
        try {
          var b = document.getElementById('b-plaza');
          if (b) {
            var cur = parseInt(b.textContent || '0', 10) || 0;
            b.textContent = String(Math.min(cur + 1, 99));
            b.style.display = '';
          }
        } catch (e) {}
      });
    } catch (e) { console.warn('[gn] socket setup failed', e); }
  }

  if (typeof io === 'function') {
    connect();
  } else {
    var s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = connect;
    s.onerror = function () { console.warn('[gn] socket.io client load failed'); };
    document.head.appendChild(s);
  }
})();
