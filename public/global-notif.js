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

  // ===== 着信音: MP3 ファイル再生 (iOS Safari で WebAudio oscillator が
  // 無音化される事例があったため 2026-05-20 に MP3 へ移行) =====
  var _chimeOn = true;
  try { if (localStorage.getItem('cohub_chat_notif_on') === '0') _chimeOn = false; } catch (e) {}
  var _audio = null;
  var _audioUnlocked = false;
  var CHIME_MP3 = '/assets/notif-mention.mp3?v=1';

  function ensureAudio() {
    if (_audio) return _audio;
    try {
      _audio = new Audio(CHIME_MP3);
      _audio.preload = 'auto';
      _audio.volume = 0.85;
    } catch (e) { console.warn('[chime] init fail', e); return null; }
    return _audio;
  }

  // iOS Safari の autoplay 制約解除。
  // 旧実装は muted=true で MP3 を一瞬再生していたが、iOS で先頭音が漏れる事故あり
  // (2026-05-20)。AudioContext の 1サンプル空バッファ → 完全無音で解除する方式に変更。
  var _unlockCtx = null;
  function unlockAudio() {
    if (_audioUnlocked) return;
    try {
      if (!_unlockCtx) _unlockCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_unlockCtx.state === 'suspended') _unlockCtx.resume();
      var buf = _unlockCtx.createBuffer(1, 1, 22050);
      var src = _unlockCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_unlockCtx.destination);
      src.start(0);
      // MP3 Audio もプリロード (decode は最初の play 時)
      ensureAudio();
      _audioUnlocked = true;
    } catch (e) { console.warn('[chime] unlock fail', e); }
  }

  document.addEventListener('click', unlockAudio, { passive: true });
  document.addEventListener('touchstart', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);

  function playChime() {
    if (!_chimeOn) return;
    var a = ensureAudio();
    if (!a) return;
    try {
      a.currentTime = 0;
      a.muted = false;
      a.volume = 0.85;
      var p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function (e) { console.warn('[chime] play blocked', e.name || e); });
      }
    } catch (e) { console.warn('[chime] play exception', e); }
  }

  // 🔔 呼出専用: 通知OFFでも必ず鳴らす + 3回連続で確実に気づかせる
  // (chat-simple の playSummonChime と同趣旨。明示的な人対人の呼び出しのため _chimeOn を無視)
  function playSummon() {
    var a = ensureAudio();
    if (!a) return;
    var n = 0;
    function ring() {
      try {
        a.currentTime = 0; a.muted = false; a.volume = 1.0;
        var p = a.play();
        if (p && typeof p.catch === 'function') p.catch(function (e) { console.warn('[summon] play blocked', e.name || e); });
      } catch (e) {}
      n++;
      if (n < 3) setTimeout(ring, 700);
    }
    ring();
  }

  // 呼出の中央オーバーレイ (どのページに居ても気づける)
  function showSummonOverlay(name) {
    var ov = document.getElementById('gn-summon-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'gn-summon-overlay';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(8,20,40,0.55);backdrop-filter:blur(4px);padding:20px;';
      ov.innerHTML = '<div style="background:#fff;border-radius:18px;padding:30px 26px;max-width:340px;width:100%;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,0.4);animation:gnSummonPulse 0.8s ease-in-out infinite alternate;">'
        + '<div style="font-size:54px;line-height:1;margin-bottom:14px;">🛎️</div>'
        + '<div id="gn-summon-name" style="font-size:19px;font-weight:800;color:#0f172a;margin-bottom:4px;"></div>'
        + '<div style="font-size:14px;color:#475569;margin-bottom:22px;">があなたを呼んでいます</div>'
        + '<button id="gn-summon-open" style="width:100%;padding:13px;border:none;border-radius:10px;background:#2f80ed;color:#fff;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:8px;">チャットを開く</button>'
        + '<button id="gn-summon-close" style="width:100%;padding:11px;border:none;border-radius:10px;background:#eef2f7;color:#475569;font-size:14px;cursor:pointer;">閉じる</button>'
        + '</div>';
      document.body.appendChild(ov);
      if (!document.getElementById('gn-summon-style')) {
        var st = document.createElement('style'); st.id = 'gn-summon-style';
        st.textContent = '@keyframes gnSummonPulse{from{transform:scale(1)}to{transform:scale(1.045)}}';
        document.head.appendChild(st);
      }
    }
    document.getElementById('gn-summon-name').textContent = (name || '誰か') + 'さん';
    ov.style.display = 'flex';
    ov.querySelector('#gn-summon-open').onclick = function () { location.href = '/chat-simple.html'; };
    ov.querySelector('#gn-summon-close').onclick = function () { ov.style.display = 'none'; };
    clearTimeout(window._gnSummonTimer);
    window._gnSummonTimer = setTimeout(function () { if (ov) ov.style.display = 'none'; }, 12000);
  }

  // 外部からON/OFF切替できるよう公開 (home.html のヘッダー🔔ボタン用)
  window.cohubGetChimeOn = function () { return _chimeOn; };
  window.cohubSetChimeOn = function (on) {
    _chimeOn = !!on;
    try { localStorage.setItem('cohub_chat_notif_on', _chimeOn ? '1' : '0'); } catch (e) {}
    if (_chimeOn) {
      unlockAudio();
      // ユーザー操作のタイミング内で同期的に再生
      var a = ensureAudio();
      if (a) {
        try {
          a.currentTime = 0; a.muted = false; a.volume = 0.85;
          var p = a.play();
          if (p && typeof p.catch === 'function') p.catch(function (e) { console.warn('[chime] test play fail', e.name || e); });
        } catch (e) { console.warn('[chime] test exception', e); }
      }
    }
    return _chimeOn;
  };

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
  function _fallbackSpeak(text, opts) {
    if (!('speechSynthesis' in window)) return;
    opts = opts || {};
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      u.rate = opts.fbRate != null ? opts.fbRate : 1.05;
      u.pitch = opts.fbPitch != null ? opts.fbPitch : 1.0;  // 低め=シリアス
      u.volume = 1.0;
      // 男性声があれば優先 (アラート用)
      if (opts.male) {
        try {
          var vs = window.speechSynthesis.getVoices() || [];
          var jp = vs.filter(function (v) { return /ja|JP/i.test(v.lang); });
          var m = jp.find(function (v) { return /male|男|otoya|Ichiro|Hattori|Daichi/i.test(v.name); });
          if (m) u.voice = m;
        } catch (e) {}
      }
      try { window.speechSynthesis.cancel(); } catch (e) {}
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  async function speak(text, opts) {
    opts = opts || {};
    if ((!_ttsOn && !opts.force) || !text) return;  // アラートは force:true で TTS-OFF でも鳴らす
    // 進行中の読み上げを止める (連投時の重なり防止)
    try {
      if (_ttsCurrentAudio) { _ttsCurrentAudio.pause(); _ttsCurrentAudio = null; }
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch (e) {}
    // 既定は葵(ひろば)。アラートは opts で男性シリアス声を指定
    var voice = opts.voice || 'ja-JP-Neural2-B';
    var speed = opts.speed != null ? opts.speed : 1.10;
    var pitch = opts.pitch != null ? opts.pitch : 4;
    var key = text + '|' + voice + '|' + speed + '|' + pitch;
    try {
      var url = _ttsBlobCache.get(key);
      if (!url) {
        var res = await fetch('/api/voice/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ text: text, voice: voice, speed: speed, pitch: pitch }),
        });
        if (!res.ok) { console.warn('[gn] tts http', res.status); _fallbackSpeak(text, opts); return; }
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
      try { await audio.play(); } catch (e) { console.warn('[gn] tts play', e && e.message); _fallbackSpeak(text, opts); }
    } catch (e) { console.warn('[gn] tts fail', e && e.message); _fallbackSpeak(text, opts); }
  }
  // 公開: 設定UIから ON/OFF
  window.cohubPlazaTtsToggle = function (on) {
    _ttsOn = !!on;
    try { localStorage.setItem('cohub_plaza_tts_on', on ? '1' : '0'); } catch (e) {}
  };

  // ===== 運転アラート: 通知音 (やわらかいベルチャイム / 2026-05-25 音色刷新) =====
  // 安全系の重要通知だが 20秒ごとにループするため、精神衛生に配慮し
  // 正弦波のベル風2音 (高→低の施設アナウンス風) に変更。気づくが急かさない・耳に痛くない。
  // チャット用チャイムON/OFFとは独立。常に鳴らす。
  function playAlarm() {
    try {
      if (!_unlockCtx) _unlockCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = _unlockCtx;
      if (ctx.state === 'suspended') ctx.resume();
      var t = ctx.currentTime;
      // 1音 = 正弦波 + ベル風の自然な減衰 (やわらかい立ち上がり→ゆっくり消える)。倍音を僅かに重ね温かみを出す。
      function note(freq, at, dur, peak) {
        [[freq, peak], [freq * 2, peak * 0.18]].forEach(function (p) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(p[0], at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(p[1], at + 0.05);    // ふわっと立ち上げ
          g.gain.exponentialRampToValueAtTime(0.0001, at + dur);   // ゆっくり減衰
          o.connect(g); g.connect(ctx.destination);
          o.start(at); o.stop(at + dur + 0.05);
        });
      }
      // 高→低の落ち着いた2音 (C6→G5)。駅・空港のアナウンス前チャイム風で「気づくが穏やか」。
      note(1047, t,        0.85, 0.20);   // ピーン
      note(784,  t + 0.45, 1.35, 0.22);   // ポーン
      return 1.7; // 鳴動秒数 (音声読み上げ開始の目安)
    } catch (e) { console.warn('[alert] chime fail', e); try { playChime(); } catch (_) {} return 1.0; }
  }

  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ========== 運転アラート: 対応済みになるまで警報をループ (2026-05-25 ユーザー要望) ==========
  // 未対応の間は派手な音+音声を ALERT_LOOP_MS ごとに繰り返す。管理者が一覧で「対応済み」に
  // すると停止。リロード/再ログイン時も未対応が残っていれば自動で鳴り続ける(見逃し防止)。
  var _alertPending = new Map();          // id -> alert
  var _alertLoopTimer = null;
  var _onAlertsPage = /^\/alerts(\.html|\/|$|\?)/.test(path);
  var ALERT_LOOP_MS = 20000;
  // 男性のシリアスな声 (ユーザー要望 2026-05-25): Neural2-D=低め男性、pitch下げ・やや遅め。
  // force:true で「ひろばTTS OFF」でも安全アラートは鳴らす。fallbackも男性/低ピッチ指定。
  var ALERT_VOICE = { voice: 'ja-JP-Neural2-D', speed: 0.98, pitch: -3.5, force: true, male: true, fbPitch: 0.7, fbRate: 0.98 };

  function _alertWhere(a) { return a.branch || a.vehicle_name || a.vehicle_number || ''; }

  // 数字を1桁ずつ読点区切りに ("9999"→"9、9、9、9")。ハイフンは除去
  function _digits(s) { return String(s).replace(/[-－\s]/g, '').split('').join('、'); }

  // 読み上げ用にナンバーを分解してポーズを入れる: "相模800て9999" → "相模、8、0、0、て、9、9、9、9"
  // (表示には使わない。地域名/分類番号/かな/一連番号 を読点で区切り、数字は1桁ずつ読ませる)
  function speakableVehicle(a) {
    if (a.branch) return a.branch;
    var name = (a.vehicle_name || '').trim();
    if (name) {
      var m = name.match(/^([^\d０-９ぁ-んァ-ヶ\s]+)?\s*([\d０-９]+)?\s*([ぁ-んァ-ヶ]+)?\s*([\d０-９\-－]+)?\s*$/);
      if (m && (m[1] || m[2] || m[3] || m[4])) {
        var out = [];
        if (m[1]) out.push(m[1].trim());                                     // 地域名
        if (m[2]) out.push(_digits(m[2]));                                   // 分類番号: 1桁ずつ
        if (m[3]) out.push(m[3].trim());                                     // かな
        if (m[4]) out.push(_digits(m[4]));                                   // 一連番号: 1桁ずつ
        return out.join('、');
      }
      return name;
    }
    var num = (a.vehicle_number || '').trim();   // 内部車番しか無い時も1桁ずつ
    return num ? _digits(num) : '';
  }

  var ALERT_CLOSING = '。だいしきゅう、所属の管理者は対応すること。';  // TTS誤読(おおしきゅう)対策でかな表記
  function buildAnnounce() {
    if (_alertPending.size === 0) return '';
    if (_alertPending.size === 1) {
      var a = _alertPending.values().next().value;
      var parts = [];
      var v = speakableVehicle(a);
      if (v) parts.push(v);
      if (a.driver_name) parts.push('運転者、' + a.driver_name + 'さん');
      if (a.notice) parts.push(a.notice);
      return parts.join('、') + ALERT_CLOSING;
    }
    return '未対応の運転アラートが' + _alertPending.size + '件あります' + ALERT_CLOSING;
  }

  // 赤フラッシュ常駐トースト (タップで一覧へ)。未対応が無くなれば消える
  function renderAlertToast() {
    if (_onAlertsPage) return;            // 一覧表示中は被るので出さない(音はループ)
    var t = document.getElementById('gn-alert-toast');
    if (_alertPending.size === 0) { if (t) t.style.opacity = '0'; return; }
    if (!document.getElementById('gn-alert-style')) {
      var st = document.createElement('style'); st.id = 'gn-alert-style';
      st.textContent = '@keyframes gnAlertFlash{0%,100%{box-shadow:0 14px 40px rgba(220,38,38,.55);}50%{box-shadow:0 16px 56px rgba(255,90,90,.98);}}';
      document.head.appendChild(st);
    }
    if (!t) {
      t = document.createElement('div'); t.id = 'gn-alert-toast';
      t.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);background:linear-gradient(135deg,#dc2626,#991b1b);color:#fff;padding:18px 30px;border-radius:18px;font-size:18px;font-weight:800;z-index:100000;max-width:94vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:auto;cursor:pointer;border:3px solid rgba(255,255,255,.55);animation:gnAlertFlash .6s ease-in-out infinite;';
      t.onclick = function () { location.href = '/alerts.html'; };
      document.body.appendChild(t);
    }
    var last = Array.from(_alertPending.values()).pop();
    var detail = [_alertWhere(last), last.driver_name ? ('運転者 ' + last.driver_name) : '', last.notice].filter(Boolean).map(_esc).join('　/　');
    var head = _alertPending.size > 1 ? ('⚠️ 未対応の運転アラート ' + _alertPending.size + '件') : '⚠️ 運転アラート（未対応）';
    t.innerHTML = '<div style="font-size:13px;opacity:.92;margin-bottom:5px;letter-spacing:1px;">' + head + '</div><div style="line-height:1.45;">' + detail + '</div><div style="font-size:11.5px;opacity:.85;margin-top:7px;">タップで一覧へ → 「対応済み」で停止</div>';
    t.style.opacity = '1';
  }

  // 1回鳴らす (派手な音 → 鳴り終わってから音声読み上げ)
  function fireAlert() {
    var dur = playAlarm() || 2.0;
    var ann = buildAnnounce();
    if (ann) setTimeout(function () { speak(ann, ALERT_VOICE); }, Math.round(dur * 1000) + 250);
  }

  function startAlertLoop() {
    renderAlertToast();
    if (_alertLoopTimer) return;
    _alertLoopTimer = setInterval(function () {
      if (_alertPending.size === 0) { stopAlertLoop(); return; }
      fireAlert();
      renderAlertToast();
    }, ALERT_LOOP_MS);
  }
  function stopAlertLoop() {
    if (_alertLoopTimer) { clearInterval(_alertLoopTimer); _alertLoopTimer = null; }
    var t = document.getElementById('gn-alert-toast'); if (t) t.style.opacity = '0';
  }

  function addPendingAlert(a, fireNow) {
    if (!a) return;
    var id = (a.id != null) ? a.id : ('k' + (a.vehicle_number || '') + (a.occurred_at || '') + (a.notice || ''));
    var isNew = !_alertPending.has(id);
    _alertPending.set(id, a);
    if (fireNow && isNew) fireAlert();
    startAlertLoop();
    try { window.dispatchEvent(new CustomEvent('cohub:alert-new', { detail: a })); } catch (e) {}
  }
  function removePendingAlert(id) {
    _alertPending['delete'](id);
    if (_alertPending.size === 0) stopAlertLoop(); else renderAlertToast();
  }

  // 起動時ブートストラップ: 未対応が残っていれば鳴らし続ける (管理職のみ; 非管理職は403で無反応)
  function bootstrapAlerts() {
    fetch('/api/alert/unhandled', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.success || !j.alerts || !j.alerts.length) return;
        j.alerts.forEach(function (a) { addPendingAlert(a, false); });
        fireAlert();   // まとめて1回鳴らしてループ開始
      }).catch(function () {});
  }
  // 一覧ページ側から「対応済み化」されたら即停止できるよう公開
  window.cohubAlertHandled = function (id) { removePendingAlert(id); };

  // ========== 事故報告「一報」アラート (2026-06-02) ==========
  // 違反警告と同じ「感じ」(派手な音+男性シリアス声+赤トースト) だが、20秒ループはしない
  // = 1回だけ鳴らす安全設計。未承認(submitted)の間は起動時ブートストラップで再掲、承認で消える。
  var _accidentPending = new Map();     // 'kind:id' -> payload
  var _onAccidentPage = /^\/accident(\.html|\/|$|\?)/.test(path);
  function _accKey(p) { return (p && p.kind || '') + ':' + (p && p.id != null ? p.id : ''); }
  function buildAccidentAnnounce(p) {
    var parts = ['事故報告の一報です'];
    if (p.location) parts.push(p.location);
    if (p.accident_type) parts.push(p.accident_type);
    if (p.reporter_name) parts.push('報告者、' + p.reporter_name + 'さん');
    return parts.join('、') + '。所属の管理者は確認してください。';
  }
  function renderAccidentToast() {
    if (_onAccidentPage) return;          // 事故対応画面では被るので出さない
    var t = document.getElementById('gn-accident-toast');
    if (_accidentPending.size === 0) { if (t) t.style.opacity = '0'; return; }
    if (!document.getElementById('gn-accident-style')) {
      var st = document.createElement('style'); st.id = 'gn-accident-style';
      st.textContent = '@keyframes gnAccFlash{0%,100%{box-shadow:0 14px 40px rgba(217,70,30,.55);}50%{box-shadow:0 16px 56px rgba(255,120,60,.98);}}';
      document.head.appendChild(st);
    }
    if (!t) {
      t = document.createElement('div'); t.id = 'gn-accident-toast';
      t.style.cssText = 'position:fixed;left:50%;top:96px;transform:translateX(-50%);background:linear-gradient(135deg,#ea580c,#b91c1c);color:#fff;padding:18px 30px;border-radius:18px;font-size:18px;font-weight:800;z-index:100000;max-width:94vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:auto;cursor:pointer;border:3px solid rgba(255,255,255,.55);animation:gnAccFlash .7s ease-in-out infinite;';
      t.onclick = function () { location.href = '/accident.html'; };
      document.body.appendChild(t);
    }
    var last = Array.from(_accidentPending.values()).pop();
    var detail = [_esc(last.location), _esc(last.accident_type), last.reporter_name ? ('報告者 ' + _esc(last.reporter_name)) : '', _esc(last.summary)].filter(Boolean).join('　/　');
    var head = _accidentPending.size > 1 ? ('🚨 未確認の事故報告 ' + _accidentPending.size + '件') : '🚨 事故報告（一報）';
    t.innerHTML = '<div style="font-size:13px;opacity:.92;margin-bottom:5px;letter-spacing:1px;">' + head + '</div><div style="line-height:1.45;">' + detail + '</div><div style="font-size:11.5px;opacity:.85;margin-top:7px;">タップで事故報告へ → 承認で停止</div>';
    t.style.opacity = '1';
  }
  function fireAccidentAlert(p) {
    var dur = playAlarm() || 2.0;
    var src = p || (_accidentPending.size ? Array.from(_accidentPending.values()).pop() : null);
    if (!src) return;
    var ann = (_accidentPending.size > 1 && !p)
      ? ('未確認の事故報告が' + _accidentPending.size + '件あります。所属の管理者は確認してください。')
      : buildAccidentAnnounce(src);
    setTimeout(function () { speak(ann, ALERT_VOICE); }, Math.round(dur * 1000) + 250);
  }
  function addAccident(p, fireNow) {
    if (!p) return;
    var k = _accKey(p); var isNew = !_accidentPending.has(k);
    _accidentPending.set(k, p);
    renderAccidentToast();
    if (fireNow && isNew) fireAccidentAlert(p);   // ループせず1回だけ
  }
  function removeAccident(id, kind) {
    _accidentPending['delete']((kind || '') + ':' + (id != null ? id : ''));
    renderAccidentToast();
  }
  // 起動時ブートストラップ: 未承認(submitted)が残っていれば再掲 (管理職のみ; 非管理職は空配列)
  function bootstrapAccidents() {
    fetch('/api/accident/pending-alerts', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.success || !j.alerts || !j.alerts.length) return;
        j.alerts.forEach(function (a) { addAccident(a, false); });
        fireAccidentAlert();   // まとめて1回鳴らす(ループなし)
      }).catch(function () {});
  }
  // 事故対応画面側から承認したら即消せるよう公開
  window.cohubAccidentCleared = function (id, kind) { removeAccident(id, kind); };

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

      // 🔔 呼出 (dm:call) — 明示的な人対人の呼び出し。chat-simple / m.html は自前ハンドラを
      // 持つのでそこだけ抑制し、それ以外(home/メール/メンバー等)の全ページで確実に鳴らす。
      // ⚠️ hasOwnChatHandler は /home も含むが home には dm:call ハンドラが無いので専用ゲートを使う。
      var hasOwnSummonHandler = /^\/chat-simple|^\/m(\/|$|\?)/.test(path);
      if (!hasOwnSummonHandler) {
        socket.on('dm:call', function (p) {
          if (!p || p.from === myUid) return;
          var who = (p.fromName || '誰か');
          try { playSummon(); } catch (e) {}
          try { showSummonOverlay(who); } catch (e) {}
          try { if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {}
          try { speak(who + 'さんが呼んでいます', { force: true }); } catch (e) {}
        });
      }

      // ⚠️ 運転アラート — 管理職のみサーバーから配信。未対応の間ループ、対応済みで停止
      socket.on('alert:new', function (a) { addPendingAlert(a, true); });
      socket.on('alert:handled', function (p) { if (p && p.handled) removePendingAlert(p.id); });
      // 未対応の積み残しがあれば鳴らし始める
      bootstrapAlerts();

      // 🚨 事故報告「一報」 — 管理職のみ配信。1回鳴らす(ループなし)、承認で消える
      socket.on('accident:new', function (p) { addAccident(p, true); });
      socket.on('accident:cleared', function (p) { if (p) removeAccident(p.id, p.kind); });
      bootstrapAccidents();

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
