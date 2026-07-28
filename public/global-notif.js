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
    // 2026-06-19: 着信音を全画面で統一。旧 notif-mention.mp3(ピンポンパーン)は廃止し、
    // 呼出と同じビープ音(playSummon)に統一。通知OFF時は鳴らさない(上の_chimeOnガード)。
    try { playSummon(); } catch (e) {}
  }

  // 🔔 呼出専用: 「ぴぴぴ ぴぴぴ」= 短いビープ3回×2セット (旧ピンポンパーンMP3は廃止し全画面で統一)。
  // 通知OFFでも鳴らす(明示的な人対人の呼び出しのため)。WebAudioが規制で鳴らせない時は無音(オーバーレイ/バイブ/TTSで気づく)。
  function playSummon() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!_unlockCtx) _unlockCtx = new Ctx();
      var ctx = _unlockCtx;
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      if (ctx.state !== 'running') return;
      var now = ctx.currentTime;
      var master = ctx.createGain(); master.gain.value = 1.6; master.connect(ctx.destination);
      var beep = function (freq, off, dur, vol) {
        var t0 = now + off;
        var env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        env.connect(master);
        var o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq; o.connect(env); o.start(t0); o.stop(t0 + dur + 0.02);
        var o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = freq * 2; var g2 = ctx.createGain(); g2.gain.value = 0.2; o2.connect(g2); g2.connect(env); o2.start(t0); o2.stop(t0 + dur + 0.02);
      };
      [0.00, 0.13, 0.26, 0.62, 0.75, 0.88].forEach(function (off) { beep(1047, off, 0.09, 0.85); });
    } catch (e) {}
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
  // 外部ページ(home等の自前socket)からも同じMP3チャイムを鳴らせるよう公開 (WebAudioより自動再生規制に強い)
  window.cohubPlayChime = function () { try { playChime(); } catch (e) {} };

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
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      // 音アンロック前(無操作ページ)は鳴らせない → 穏やかチャイムにフォールバック
      if (ctx.state !== 'running') { try { playChime(); } catch (_) {} return 1.3; }
      var t = ctx.currentTime;
      // 2026-06-30: 離席中でも気づけるよう「館内放送型」の大音量ピーポーサイレンへ変更。
      // 矩形波(遠達性が高い)のハイ/ロー2音を交互に=欧州式緊急サイレン。やわらかチャイムは廃止。
      var master = ctx.createGain();
      master.gain.value = 1.8;            // 部屋に響く音量 (旧チャイムの約8倍)
      master.connect(ctx.destination);
      var seg = 0.42;                      // 1音の長さ
      var pattern = [880, 660, 880, 660, 880, 660];  // ハイ→ロー 3往復 ≈ 2.5秒
      pattern.forEach(function (freq, i) {
        var at = t + i * seg;
        var env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, at);
        env.gain.exponentialRampToValueAtTime(0.5, at + 0.02);     // 立ち上がり鋭く
        env.gain.setValueAtTime(0.5, at + seg - 0.05);             // 区間中はフルで保持
        env.gain.exponentialRampToValueAtTime(0.0001, at + seg);   // 末尾だけ素早く落とす
        env.connect(master);
        var o = ctx.createOscillator(); o.type = 'square';
        o.frequency.setValueAtTime(freq, at);
        o.connect(env); o.start(at); o.stop(at + seg + 0.02);
        // 倍音(のこぎり波)を重ねて遠達性=耳に付く度合いを上げる
        var o2 = ctx.createOscillator(); o2.type = 'sawtooth';
        o2.frequency.setValueAtTime(freq, at);
        var g2 = ctx.createGain(); g2.gain.value = 0.25;
        o2.connect(g2); g2.connect(env); o2.start(at); o2.stop(at + seg + 0.02);
      });
      return pattern.length * seg + 0.2;   // 鳴動秒数 ≈ 2.7秒 (音声読み上げ開始の目安)
    } catch (e) { console.warn('[alert] alarm fail', e); try { playChime(); } catch (_) {} return 1.0; }
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
    var _av = last.driver_avatar ? '<div style="margin:2px auto 8px;text-align:center;"><img src="' + _esc(last.driver_avatar) + '" alt="" style="width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.85);box-shadow:0 2px 8px rgba(0,0,0,.35);display:inline-block;"></div>' : '';
    t.innerHTML = '<div style="font-size:13px;opacity:.92;margin-bottom:5px;letter-spacing:1px;">' + head + '</div>' + _av + '<div style="line-height:1.45;">' + detail + '</div><div style="font-size:11.5px;opacity:.85;margin-top:7px;">タップで一覧へ → 「対応済み」で停止</div>';
    t.style.opacity = '1';
  }

  // 1回鳴らす (派手な音 → 鳴り終わってから音声読み上げ)
  function fireAlert() {
    var dur = playAlarm() || 2.0;
    var ann = buildAnnounce();
    if (ann) setTimeout(function () { speak(ann, ALERT_VOICE); }, Math.round(dur * 1000) + 250);
  }

  // ===== 未対応アラート: タブ見出し点滅 + ファビコン赤バッジ (2026-06-11) =====
  // 音声オートプレイ規制で無操作ページは警報音が鳴らない → 別画面の管理職が気づけない症状の対策。
  // 音に頼らず「タブの見出し点滅」と「ファビコン赤バッジ」で視界の端でも気づけるようにする。
  var _alertTitleTimer = null;
  var _alertOrigTitle = null;
  var _alertOrigFavicons = null;
  var _faviconCreated = [];   // 元々faviconが無いページ用にこちらで作ったlink。解除時に削除する
  function _setFaviconBadge(count) {
    try {
      var size = 64;
      var c = document.createElement('canvas'); c.width = size; c.height = size;
      var x = c.getContext('2d');
      x.fillStyle = '#dc2626';
      x.beginPath(); x.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#fff';
      x.font = 'bold ' + (count > 1 ? 40 : 46) + 'px sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(count > 1 ? String(Math.min(count, 9)) : '!', size / 2, size / 2 + 3);
      var url = c.toDataURL('image/png');
      var links = document.querySelectorAll('link[rel~="icon"]');
      if (_alertOrigFavicons === null) {
        _alertOrigFavicons = [];
        Array.prototype.forEach.call(links, function (l) { _alertOrigFavicons.push({ el: l, href: l.getAttribute('href') }); });
      }
      if (links.length === 0) {
        var nl = document.createElement('link'); nl.rel = 'icon'; nl.setAttribute('data-gn-alert', '1');
        document.head.appendChild(nl);
        _faviconCreated.push(nl);
        links = document.querySelectorAll('link[rel~="icon"]');
      }
      Array.prototype.forEach.call(links, function (l) { l.href = url; });
    } catch (e) {}
  }
  // 透明1px (GIF)。faviconはlink削除では端末キャッシュで消えないため、透明画像へ張り替えて確実に「！」を消す
  var _BLANK_ICON = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  function _restoreFavicon() {
    try {
      // 元々あったfaviconは元のhrefへ戻す (無href/元々無しは透明へ)
      if (_alertOrigFavicons) {
        _alertOrigFavicons.forEach(function (o) { try { o.el.setAttribute('href', o.href == null ? _BLANK_ICON : o.href); } catch (e) {} });
      }
      // 元々faviconが無くこちらで作ったlinkは、削除では消えない端末があるため透明画像へ張替え
      _faviconCreated.forEach(function (l) { try { l.setAttribute('href', _BLANK_ICON); } catch (e) {} });
    } catch (e) {}
  }
  function startAlertTitleFlash() {
    _setFaviconBadge(_alertPending.size);
    if (_alertTitleTimer) return;
    if (_alertOrigTitle === null) _alertOrigTitle = document.title;
    var on = false;
    _alertTitleTimer = setInterval(function () {
      on = !on;
      var n = _alertPending.size;
      document.title = on ? ('🚨未対応アラート' + (n > 1 ? ' ' + n + '件' : '') + ' ⚠') : (_alertOrigTitle || 'CoHub');
    }, 1000);
  }
  function stopAlertTitleFlash() {
    if (_alertTitleTimer) { clearInterval(_alertTitleTimer); _alertTitleTimer = null; }
    if (_alertOrigTitle !== null) document.title = _alertOrigTitle;
    _restoreFavicon();
  }

  function startAlertLoop() {
    renderAlertToast();
    startAlertTitleFlash();
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
    stopAlertTitleFlash();
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

  // テスト用: 運転アラートを「自分の画面だけ」に表示 (2026-07-03). サーバーemit/Push無し・他者に波及しない。
  // 使い方(ブラウザのコンソール): cohubTestDriveAlert()  /  音も鳴らす: cohubTestDriveAlert({sound:true})  /  顔なし: cohubTestDriveAlert({driver_avatar:null})
  window.cohubTestDriveAlert = function (opts) {
    opts = opts || {};
    var avatar = (opts.driver_avatar !== undefined) ? opts.driver_avatar : '/uploads/avatars/b097b512-468b-4161-a273-2e96ee589960_cand_soft_1777540349188.png';
    var name = opts.driver_name || '吉沢 佑也';
    var notice = opts.notice || 'テスト表示（急ブレーキ検知）';
    var vehicle = opts.vehicle_name || 'テスト車両';
    var old = document.getElementById('gn-alert-toast-test'); if (old) old.remove();
    if (!document.getElementById('gn-alert-style')) { var st = document.createElement('style'); st.id = 'gn-alert-style'; st.textContent = '@keyframes gnAlertFlash{0%,100%{box-shadow:0 14px 40px rgba(220,38,38,.55);}50%{box-shadow:0 16px 56px rgba(255,90,90,.98);}}'; document.head.appendChild(st); }
    var t = document.createElement('div'); t.id = 'gn-alert-toast-test';
    t.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);background:linear-gradient(135deg,#dc2626,#991b1b);color:#fff;padding:18px 30px;border-radius:18px;font-size:18px;font-weight:800;z-index:100001;max-width:94vw;text-align:center;pointer-events:auto;cursor:pointer;border:3px solid rgba(255,255,255,.55);animation:gnAlertFlash .6s ease-in-out infinite;';
    var av = avatar ? '<div style="margin:2px auto 8px;text-align:center;"><img src="' + avatar + '" alt="" style="width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.85);box-shadow:0 2px 8px rgba(0,0,0,.35);display:inline-block;"></div>' : '';
    var detail = [vehicle, '運転者 ' + name, notice].filter(Boolean).join('　/　');
    t.innerHTML = '<div style="font-size:13px;opacity:.92;margin-bottom:5px;letter-spacing:1px;">⚠️ 運転アラート（未対応）【テスト】</div>' + av + '<div style="line-height:1.45;">' + detail + '</div><div style="font-size:11.5px;opacity:.85;margin-top:7px;">タップで閉じる（これはテスト表示です）</div>';
    t.onclick = function () { t.remove(); };
    document.body.appendChild(t);
    if (opts.sound === true) { try { if (typeof fireAlert === 'function') fireAlert(); } catch (e) {} }
    return 'テスト表示中です。消えません。タップで閉じられます。';
  };

  // コンソール無しでもテスト可: URLに ?gntest=1 を付けて開くと自動表示 (?gntest=sound=音あり / ?gntest=noface=顔なし)
  try {
    var _gt = new URLSearchParams(location.search).get('gntest');
    if (_gt) {
      var _fireGt = function () { try { window.cohubTestDriveAlert({ sound: _gt === 'sound', driver_avatar: (_gt === 'noface' ? null : undefined) }); } catch (e) {} };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(_fireGt, 700); });
      else setTimeout(_fireGt, 700);
    }
  } catch (e) {}
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
  // 取りこぼし対策 (2026-06-11): 背面/無操作タブは socket が切れている間に
  // alert:handled を取りこぼし、タブの「！」が消えなくなる。再接続時とタブ復帰時に
  // サーバーの未対応一覧と突き合わせ、対応済みになったものをローカルからも除去して
  // タブ点滅とファビコン「！」を確実に解除する。
  function reconcileAlerts() {
    fetch('/api/alert/unhandled', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.success || !j.alerts) return;
        var live = {};
        j.alerts.forEach(function (a) { live[a.id] = 1; addPendingAlert(a, false); });
        Array.from(_alertPending.keys()).forEach(function (id) {
          if (!live.hasOwnProperty(id)) removePendingAlert(id);   // サーバー上は対応済み → ローカルからも消す
        });
      }).catch(function () {});
  }
  // 一覧ページ側から「対応済み化」されたら即停止できるよう公開
  window.cohubAlertHandled = function (id) { removePendingAlert(id); };
  // タブ復帰で即再同期 (socket 切断中に取りこぼした「対応済み」を反映)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && _alertsWired) reconcileAlerts();
  });

  // ========== 事故報告「一報」アラート (2026-06-02) ==========
  // 違反警告と同じ「感じ」(派手な音+男性シリアス声+赤トースト) だが、20秒ループはしない
  // = 1回だけ鳴らす安全設計。未承認(submitted)の間は起動時ブートストラップで再掲、承認で消える。
  var _accidentPending = new Map();     // 'kind:id' -> payload
  var _onAccidentPage = /^\/accident(\.html|\/|$|\?)/.test(path);
  function _accKey(p) { return (p && p.kind || '') + ':' + (p && p.id != null ? p.id : ''); }
  // TTS氏名読み辞書 (chat-simple.html / m.html と同内容。Google TTSの誤読対策)。
  // 一報読み上げで報告者名を素のまま渡すとオカダキョウジ等と誤読されるため変換する。
  var NAME_READINGS = {
    '小林 猛': 'コバヤシ タケシ', '小林　猛': 'コバヤシ タケシ', '小林猛': 'コバヤシ タケシ',
    '金子 力': 'カネコ チカラ', '金子　力': 'カネコ チカラ', '金子力': 'カネコ チカラ',
    '岡田 恭司': 'オカダ ヤスジ', '岡田　恭司': 'オカダ ヤスジ', '岡田恭司': 'オカダ ヤスジ',
    '土古 辰雄': 'ツチコ タツオ', '土古　辰雄': 'ツチコ タツオ', '土古辰雄': 'ツチコ タツオ'
  };
  function readingOf(name) {
    if (!name) return name;
    if (NAME_READINGS[name]) return NAME_READINGS[name];
    var norm = name.replace(/\s+/g, '').replace(/　/g, '');
    for (var k in NAME_READINGS) {
      if (NAME_READINGS.hasOwnProperty(k) && k.replace(/\s+/g, '').replace(/　/g, '') === norm) return NAME_READINGS[k];
    }
    return name;
  }
  function buildAccidentAnnounce(p) {
    var parts = ['事故報告の一報です'];
    if (p.location) parts.push(p.location);
    if (p.accident_type) parts.push(p.accident_type);
    if (p.reporter_name) parts.push('報告者、' + readingOf(p.reporter_name) + 'さん');
    return parts.join('、') + '。所属の管理者は確認してください。';
  }
  function renderAccidentToast() {
    if (_onAccidentPage) return;          // 事故対応画面では被るので出さない
    var t = document.getElementById('gn-accident-toast');
    if (_accidentPending.size === 0) { if (t) t.style.opacity = '0'; return; }
    if (!t) {
      t = document.createElement('div'); t.id = 'gn-accident-toast';
      t.style.cssText = 'position:fixed;left:50%;top:96px;transform:translateX(-50%);background:linear-gradient(135deg,#0284c7,#0369a1);color:#fff;padding:16px 28px;border-radius:18px;font-size:18px;font-weight:800;z-index:100000;max-width:94vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:auto;cursor:pointer;border:2px solid rgba(255,255,255,.5);box-shadow:0 12px 34px rgba(2,132,199,.4);';
      t.onclick = function () { location.href = '/accident.html'; };
      document.body.appendChild(t);
    }
    var last = Array.from(_accidentPending.values()).pop();
    var detail = [_esc(last.location), _esc(last.accident_type), last.reporter_name ? ('報告者 ' + _esc(last.reporter_name)) : '', _esc(last.summary)].filter(Boolean).join('　/　');
    var head = _accidentPending.size > 1 ? ('📋 確認待ちの事故報告 ' + _accidentPending.size + '件') : '📋 事故報告（確認待ち）';
    t.innerHTML = '<div style="font-size:13px;opacity:.92;margin-bottom:5px;letter-spacing:1px;">' + head + '</div><div style="line-height:1.45;">' + detail + '</div><div style="font-size:11.5px;opacity:.85;margin-top:7px;">タップで内容を確認 → 対応済みで消えます</div>';
    t.style.opacity = '1';
  }
  function fireAccidentAlert(p) {
    // 事故報告の一報は「違反(運転アラート)」ではない。けたたましいサイレンは鳴らさず、
    // 気づける程度のやわらかいチャイムを1回だけ。承認(確認)までトーストは残る。
    try { playChime(); } catch (e) {}
    var src = p || (_accidentPending.size ? Array.from(_accidentPending.values()).pop() : null);
    if (!src) return;
    var ann = (_accidentPending.size > 1 && !p)
      ? ('未確認の事故報告が' + _accidentPending.size + '件あります。所属の管理者は確認してください。')
      : buildAccidentAnnounce(src);
    // 声も違反アラート専用のシリアス声でなく通常の案内声で(運転アラートと差別化)。
    setTimeout(function () { try { speak(ann); } catch (e) {} }, 900);
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

  // ===== 運転アラート/事故 一報の配線 (自前socketページにも相乗りできるよう関数化) =====
  // chat-simple.html 等は独自socketを張り global-notif.js を読まないため運転アラートを取りこぼす。
  // それらのページは window.__cohubNoGnSocket=true を立て、自前socketに対し
  // window.cohubWireAlerts(socket) を呼ぶことで、2本目socket(=attendance二重挿入)を作らず相乗りする。
  var _alertsWired = false;
  function wireAlerts(sock) {
    if (!sock || _alertsWired) return;
    _alertsWired = true;
    // ⚠️ 運転アラート — 未対応の間ループ、対応済みで停止
    sock.on('alert:new', function (a) { addPendingAlert(a, true); });
    sock.on('alert:handled', function (p) { if (p && p.handled) removePendingAlert(p.id); });
    bootstrapAlerts();
    // 🚨 事故報告「一報」 — 1回鳴らす(ループなし)、承認で消える
    sock.on('accident:new', function (p) { addAccident(p, true); });
    sock.on('accident:cleared', function (p) { if (p) removeAccident(p.id, p.kind); });
    bootstrapAccidents();
    // 📢 通達 — 重要/緊急は全ページでチャイム+バナー。normalは鳴らさず未読バッジのみ(従来通り)。
    sock.on('announcement:new', function (p) {
      try {
        if (!p || (p.level !== 'important' && p.level !== 'urgent')) return;
        var icon = p.level === 'urgent' ? '🚨' : '📢';
        playChime();
        showToast(icon + ' 通達: ' + ((p.title || '').slice(0, 40) || '新しい通達があります'));
      } catch (e) {}
    });
  }
  window.cohubWireAlerts = wireAlerts;

  // ===== Socket.IO 接続 =====
  function connect() {
    try {
      var socket = io({ auth: { token: token } });
      socket.on('connect', function () {
        console.log('[gn] socket connected');
        if (_alertsWired) reconcileAlerts();   // 再接続時に取りこぼした「対応済み」を反映して「！」を消す
      });
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
          // 送信者名はサーバーが payload に載せる (2026-07-28。無い場合だけ従来表記)
          var whoDm = (p.from_name || '').trim();
          showToast('💬 ' + (whoDm ? whoDm + 'さん: ' : 'メッセージ: ') + ((p.content || '').slice(0, 40) || '📎 添付'));
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

      // ⚠️ 運転アラート + 🚨 事故報告 一報 (管理職のみ)。chat-simple 等の自前socketページにも
      // window.cohubWireAlerts で相乗りできるよう関数化 (2026-06-11)。
      wireAlerts(socket);

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

  // ===== 共用タブレット(キオスク)ガード =====
  // tablet.html 経由ログインで localStorage.cohub_kiosk='1' が立つ。
  // 共用端末で「前の人のまま操作される」「前の人の下書きが見える」のを物理的に防ぐ:
  //   ・無操作3分で自動ログアウト ・手動ログアウトボタン ・ログアウト時に個人データ全消去→/tablet
  (function kioskGuard() {
    var isKiosk = false;
    // キオスク印は tablet.html ログイン時のトークンに紐づく(2026-06-23)。
    // 現在のトークンと一致する時だけキオスク扱い。通常ログイン(別トークン)や
    // 旧仕様(紐づけ無し)で印だけ残っている端末は、印を消して自己修復する。
    // → これが無いと、過去に一度 /tablet ログインしたPCが永続的にキオスク化し、
    //   通常ログインでも5分無操作で /tablet に飛んでしまう不具合になっていた。
    try {
      if (localStorage.getItem('cohub_kiosk') === '1') {
        var _kt = localStorage.getItem('cohub_kiosk_token') || '';
        var _cur = localStorage.getItem('cohub_token') || '';
        if (_kt && _kt === _cur) isKiosk = true;
        else { try { localStorage.removeItem('cohub_kiosk'); localStorage.removeItem('cohub_kiosk_token'); } catch (e) {} }
      }
    } catch (e) {}
    if (!isKiosk) return;
    var IDLE_MS = 3 * 60 * 1000; // 無操作3分
    var idleTimer = null, loggingOut = false;

    function clearPersonalStorage() {
      // 端末設定(キオスク印/拠点/文字サイズ/通知ON)は残し、個人ひもづきは消す
      try {
        var keep = { cohub_kiosk: 1, cohub_tablet_co: 1, cohub_tablet_co_lock: 1, m_fz: 1, cohub_chat_notif_on: 1 };
        var del = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && !keep[k] && k.indexOf('cohub_') === 0) del.push(k); // cohub_token/cohub_user/cohub_draft_* 等
        }
        del.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      } catch (e) {}
    }
    window.cohubKioskLogout = function () {
      if (loggingOut) return; loggingOut = true;
      var t = ''; try { t = localStorage.getItem('cohub_token') || ''; } catch (e) {}
      function done() { clearPersonalStorage(); location.replace('/tablet'); }
      try { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).then(done, done); }
      catch (e) { done(); }
    };
    function resetIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(window.cohubKioskLogout, IDLE_MS); }
    ['touchstart', 'mousedown', 'keydown', 'scroll', 'pointerdown'].forEach(function (ev) {
      window.addEventListener(ev, resetIdle, { passive: true });
    });
    resetIdle();

    function addLogoutBtn() {
      if (document.getElementById('kiosk-logout-btn')) return;
      var b = document.createElement('button');
      b.id = 'kiosk-logout-btn'; b.type = 'button'; b.textContent = '🔒 ログアウト';
      b.style.cssText = 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:99999;padding:10px 12px;border:none;border-radius:22px 0 0 22px;background:#0f766e;color:#fff;font-size:12px;font-weight:700;box-shadow:0 3px 12px rgba(0,0,0,.25);cursor:pointer;writing-mode:horizontal-tb;';
      b.onclick = function () {
        if (confirm('ログアウトして名簿に戻りますか?\n(この端末の下書きなど個人データは消去されます)')) window.cohubKioskLogout();
      };
      document.body.appendChild(b);
    }
    if (document.body) addLogoutBtn();
    else document.addEventListener('DOMContentLoaded', addLogoutBtn);
  })();

  // 自前socketを持つページ(chat-simple)は __cohubNoGnSocket=true で2本目を作らない。
  // その場合でも window.cohubWireAlerts / 音声アンロック / 各ヘルパは定義済みなので、
  // ページ側が既存socketに cohubWireAlerts(socket) を呼べば運転アラートを受けられる。
  if (!window.__cohubNoGnSocket) {
    if (typeof io === 'function') {
      connect();
    } else {
      var s = document.createElement('script');
      s.src = '/socket.io/socket.io.js';
      s.onload = connect;
      s.onerror = function () { console.warn('[gn] socket.io client load failed'); };
      document.head.appendChild(s);
    }
  }
})();
