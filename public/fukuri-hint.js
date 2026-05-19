// 🎁 福利厚生 (fukuri.co) アクセス前モーダル — ID/PW端末ローカル保存+コピー支援
// 完全自動ログインはクロスオリジン制約で不可。代替として登録済みID/PWを表示+ワンタップコピー。
// 保存先は localStorage (端末内のみ、サーバー送信なし)。
(function () {
  const FUKURI_URL = 'https://www.fukuri.co/';
  const LS_ID = 'cohub_yba_id';
  const LS_PW = 'cohub_yba_pw';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

  function openFukuri() {
    window.open(FUKURI_URL, '_blank', 'noopener');
  }

  function close() {
    const bg = document.getElementById('fukuri-hint-bg');
    if (bg) bg.remove();
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // フォールバック: 一時textareaでexecCommand
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ コピー済';
      btn.style.background = '#10b981';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1200);
    }
  }

  function renderDisplayMode(savedId, savedPw) {
    const masked = '•'.repeat(Math.max(6, savedPw.length));
    return `
      <div style="font-size:18px;font-weight:800;color:#92400e;margin-bottom:6px;">🎁 福利厚生 (fukuri) を開きます</div>
      <div style="font-size:12.5px;color:#475569;line-height:1.65;margin-bottom:12px;">登録済みのYBA ID/パスワードです。コピーして fukuri 側のログイン画面に貼り付けてください。</div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:8px;">
        <div style="font-size:11px;color:#64748b;font-weight:700;margin-bottom:4px;">ID</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <div id="fk-id-val" style="flex:1;font-family:'Menlo','Consolas',monospace;font-size:14px;font-weight:700;color:#0f172a;word-break:break-all;background:#fff;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;">${esc(savedId)}</div>
          <button id="fk-copy-id" style="flex:0 0 auto;padding:8px 12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">📋 コピー</button>
        </div>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:14px;">
        <div style="font-size:11px;color:#64748b;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:8px;">
          パスワード
          <button id="fk-toggle-pw" style="margin-left:auto;padding:2px 8px;background:#e2e8f0;color:#475569;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">👁 表示</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <div id="fk-pw-val" data-masked="1" style="flex:1;font-family:'Menlo','Consolas',monospace;font-size:14px;font-weight:700;color:#0f172a;word-break:break-all;background:#fff;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;">${esc(masked)}</div>
          <button id="fk-copy-pw" style="flex:0 0 auto;padding:8px 12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">📋 コピー</button>
        </div>
      </div>

      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:8px 10px;border-radius:6px;font-size:11px;color:#78350f;margin-bottom:14px;line-height:1.55;">
        🔒 ID/PWは<b>この端末内のみ</b>に保存されています (サーバー送信なし)。端末ロックの設定をお願いします。
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="fk-edit" style="flex:0 0 auto;padding:9px 12px;background:transparent;color:#64748b;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">✏️ 変更</button>
        <button id="fk-clear" style="flex:0 0 auto;padding:9px 12px;background:transparent;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">🗑 削除</button>
        <button id="fk-go" style="flex:1;min-width:160px;padding:12px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(217,119,6,0.30);">fukuri を開く →</button>
      </div>
    `;
  }

  function renderRegisterMode(prevId, prevPw, isEdit) {
    return `
      <div style="font-size:18px;font-weight:800;color:#92400e;margin-bottom:6px;">🎁 ${isEdit ? 'YBA ID/PWの変更' : 'YBA ID/PWを登録'}</div>
      <div style="font-size:12.5px;color:#475569;line-height:1.65;margin-bottom:12px;">
        ${isEdit ? '' : '次回から<b>カードを取り出さずに済む</b>よう、配布されたYBAカード記載のID/パスワードをこの端末に保存します。<br>'}
        保存先は<b>この端末内のみ</b>です (サーバー送信なし)。
      </div>

      <div style="margin-bottom:10px;">
        <div style="font-size:11px;color:#64748b;font-weight:700;margin-bottom:4px;">YBA ログインID</div>
        <input id="fk-input-id" type="text" autocomplete="username" inputmode="text" value="${esc(prevId)}" placeholder="カード記載のID" style="width:100%;padding:11px 12px;border:1.5px solid #cbd5e1;border-radius:8px;font-size:14px;font-family:'Menlo','Consolas',monospace;outline:none;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:14px;">
        <div style="font-size:11px;color:#64748b;font-weight:700;margin-bottom:4px;display:flex;align-items:center;">
          パスワード
          <button id="fk-input-toggle" type="button" style="margin-left:auto;padding:2px 8px;background:#e2e8f0;color:#475569;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;">👁 表示</button>
        </div>
        <input id="fk-input-pw" type="password" autocomplete="current-password" value="${esc(prevPw)}" placeholder="カード記載のパスワード" style="width:100%;padding:11px 12px;border:1.5px solid #cbd5e1;border-radius:8px;font-size:14px;font-family:'Menlo','Consolas',monospace;outline:none;box-sizing:border-box;">
      </div>

      <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:8px 10px;border-radius:6px;font-size:11px;color:#78350f;margin-bottom:14px;line-height:1.55;">
        💡 ID/PWを忘れたら所属営業所の事務担当へ。<br>
        🔒 紙のカードと同じく、端末を取られると見られます。端末ロック必須。
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="fk-skip" style="flex:0 0 auto;padding:11px 12px;background:transparent;color:#64748b;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">${isEdit ? 'キャンセル' : '保存せず開く'}</button>
        <button id="fk-save" style="flex:1;min-width:160px;padding:12px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(16,185,129,0.30);">${isEdit ? '保存する' : '保存して開く →'}</button>
      </div>
    `;
  }

  function showModal(modeHtml) {
    close();
    const bg = document.createElement('div');
    bg.id = 'fukuri-hint-bg';
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    const inner = document.createElement('div');
    inner.style.cssText = 'background:#fff;border-radius:14px;padding:20px 22px;max-width:440px;width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.2);';
    inner.innerHTML = modeHtml;
    bg.appendChild(inner);
    document.body.appendChild(bg);
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
  }

  function showDisplay() {
    const savedId = localStorage.getItem(LS_ID) || '';
    const savedPw = localStorage.getItem(LS_PW) || '';
    showModal(renderDisplayMode(savedId, savedPw));
    document.getElementById('fk-copy-id').addEventListener('click', e => copyText(savedId, e.currentTarget));
    document.getElementById('fk-copy-pw').addEventListener('click', e => copyText(savedPw, e.currentTarget));
    document.getElementById('fk-toggle-pw').addEventListener('click', e => {
      const el = document.getElementById('fk-pw-val');
      const btn = e.currentTarget;
      if (el.getAttribute('data-masked') === '1') {
        el.textContent = savedPw; el.setAttribute('data-masked', '0'); btn.textContent = '🙈 隠す';
      } else {
        el.textContent = '•'.repeat(Math.max(6, savedPw.length)); el.setAttribute('data-masked', '1'); btn.textContent = '👁 表示';
      }
    });
    document.getElementById('fk-edit').addEventListener('click', () => showRegister(true));
    document.getElementById('fk-clear').addEventListener('click', () => {
      if (!confirm('保存されたID/PWを削除しますか?\n(紙のカードからの再入力が必要になります)')) return;
      localStorage.removeItem(LS_ID); localStorage.removeItem(LS_PW);
      close();
      alert('削除しました');
    });
    document.getElementById('fk-go').addEventListener('click', () => { close(); openFukuri(); });
  }

  function showRegister(isEdit) {
    const prevId = isEdit ? (localStorage.getItem(LS_ID) || '') : '';
    const prevPw = isEdit ? (localStorage.getItem(LS_PW) || '') : '';
    showModal(renderRegisterMode(prevId, prevPw, isEdit));
    const pwInput = document.getElementById('fk-input-pw');
    document.getElementById('fk-input-toggle').addEventListener('click', e => {
      const btn = e.currentTarget;
      if (pwInput.type === 'password') { pwInput.type = 'text'; btn.textContent = '🙈 隠す'; }
      else { pwInput.type = 'password'; btn.textContent = '👁 表示'; }
    });
    document.getElementById('fk-skip').addEventListener('click', () => {
      close();
      if (!isEdit) openFukuri();  // 新規時は「保存せず開く」、変更時はただ閉じる
    });
    document.getElementById('fk-save').addEventListener('click', () => {
      const id = document.getElementById('fk-input-id').value.trim();
      const pw = pwInput.value;
      if (!id || !pw) { alert('ID と パスワードを両方入力してください'); return; }
      localStorage.setItem(LS_ID, id);
      localStorage.setItem(LS_PW, pw);
      close();
      if (isEdit) showDisplay();  // 変更後は表示モードに戻る
      else openFukuri();           // 新規保存後はそのまま fukuri へ
    });
    // 初回フォーカス (新規時のみ)
    if (!isEdit && !prevId) setTimeout(() => document.getElementById('fk-input-id').focus(), 50);
  }

  // エントリポイント (PC/モバイル共通)
  window.openFukuriHint = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const savedId = localStorage.getItem(LS_ID);
    const savedPw = localStorage.getItem(LS_PW);
    if (savedId && savedPw) showDisplay();
    else showRegister(false);
    return false;
  };
})();
