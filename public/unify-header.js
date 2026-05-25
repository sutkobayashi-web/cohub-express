// CoWell 統一ヘッダー (home.html の teal gradient に揃える)
// 使い方: <script src="/unify-header.js" defer></script> を <head> に入れるだけ
(function() {
  if (window.__cohubUnifyHeader) return;
  window.__cohubUnifyHeader = true;

  const CSS = `
    /* ===== CoWell 統一ヘッダー ===== */
    body header,
    header.cohub-std-header {
      position: sticky !important; top: 0 !important; z-index: 100 !important;
      background: linear-gradient(135deg, #0d9488 0%, #0f766e 60%, #064e3b 100%) !important;
      color: #fff !important;
      padding: 14px 20px !important;
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      box-shadow: 0 6px 18px rgba(15,118,110,0.25) !important;
      border-bottom: none !important;
      backdrop-filter: none !important;
    }
    body header h1, body header h2, body header .title, body header .ttl,
    body header .h1, body header > div > .title {
      color: #fff !important;
      font-size: 17px !important;
      font-weight: 800 !important;
      letter-spacing: 0.8px !important;
      margin: 0 !important;
      flex: 1 !important;
      min-width: 0 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    body header .back, body header a.back, body header button.back,
    body header > a:first-child[href],
    body header > a[href="/"], body header > a[href="/home"],
    body header > a[href="/full"], body header > a[href="/m"] {
      background: rgba(255,255,255,0.18) !important;
      color: #fff !important;
      border: 1px solid rgba(255,255,255,0.30) !important;
      border-radius: 8px !important;
      padding: 5px 10px !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      line-height: 1.2 !important;
      text-decoration: none !important;
      cursor: pointer !important;
    }
    body header .back:hover,
    body header > a:first-child[href]:hover { background: rgba(255,255,255,0.32) !important; }
    body header img.auto-logo {
      width: 38px !important; height: 38px !important;
      border-radius: 9px !important;
      object-fit: cover !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.18) !important;
      flex-shrink: 0 !important;
      display: block !important;
    }
    /* 既存ロゴ要素のスタイルリセット */
    body header .logo { background: transparent !important; }
    body header .logo img { display: block; object-fit: cover; }
    /* 右側のchip類 */
    body header .right .name,
    body header .name {
      background: rgba(255,255,255,0.18) !important;
      color: #fff !important;
      border-radius: 18px !important;
      padding: 5px 11px !important;
      font-size: 12px !important;
      font-weight: 700 !important;
    }
    /* 右側ボタン */
    body header .right button,
    body header > button:not(.back) {
      background: transparent !important;
      color: #fff !important;
      border: 1px solid rgba(255,255,255,0.55) !important;
      border-radius: 4px !important;
      padding: 5px 11px !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      cursor: pointer !important;
    }
    body header .right button:hover,
    body header > button:not(.back):hover {
      background: rgba(255,255,255,0.12) !important;
      border-color: #fff !important;
    }
    /* inline style で background を指定されている場合の打消し (一部ページ) */
    body header[style*="background"] {
      background: linear-gradient(135deg, #0d9488 0%, #0f766e 60%, #064e3b 100%) !important;
    }
    @media (max-width: 600px) {
      body header, header.cohub-std-header { padding: 12px 14px !important; gap: 10px !important; }
      body header h1, body header h2, body header .ttl { font-size: 15px !important; }
      body header img.auto-logo { width: 32px !important; height: 32px !important; border-radius: 7px !important; }
    }
  `;

  function inject() {
    if (document.getElementById('cohub-unify-header-css')) return;
    const style = document.createElement('style');
    style.id = 'cohub-unify-header-css';
    style.textContent = CSS;
    document.head.appendChild(style);

    // ロゴが無いヘッダーには自動で挿入
    const hdr = document.querySelector('body header');
    if (hdr && !hdr.querySelector('img.auto-logo, .logo')) {
      const img = document.createElement('img');
      img.src = '/img/icon-192.png';
      img.alt = 'CoWell';
      img.className = 'auto-logo';
      // 戻るボタンの後 (または先頭) に差し込む
      const back = hdr.querySelector('.back, a[href="/"], a[href="/home"], a[href="/full"]');
      if (back && back.nextSibling) hdr.insertBefore(img, back.nextSibling);
      else hdr.insertBefore(img, hdr.firstChild);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
