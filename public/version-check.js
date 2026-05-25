// CoWell 自動バージョンチェック
// - 60秒ごとに /api/version を取得し、localStorage に保存されたバージョンと照合
// - ズレていれば自動で location.reload() を1回実行
// - 入力中 (textarea/input にフォーカス) は次回チェックまで遅延
// - 初回は版を保存するだけ (リロードしない)
(function () {
  if (typeof window === 'undefined') return;
  if (window.__cohub_version_check_loaded) return;
  window.__cohub_version_check_loaded = true;

  var KEY = 'cohub_app_version';
  var RELOAD_FLAG = 'cohub_version_just_reloaded';
  var CHECK_INTERVAL_MS = 60 * 1000;
  var BANNER_ID = 'cohub-version-update-banner';

  function isUserBusy() {
    var ae = document.activeElement;
    if (!ae) return false;
    var tag = (ae.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || ae.isContentEditable) return true;
    return false;
  }

  function showUpdateBanner(newVer) {
    if (document.getElementById(BANNER_ID)) return;
    var bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:linear-gradient(135deg,#f59e0b,#dc2626);color:#fff;padding:10px 14px;z-index:99998;font-size:13px;font-weight:700;text-align:center;box-shadow:0 4px 16px rgba(220,38,38,0.30);display:flex;align-items:center;justify-content:center;gap:12px;';
    bar.innerHTML = '⚠️ 新版が公開されました。入力中はそのまま続けてください — 30秒後に自動更新します。 <button id="cv-upd-now" style="background:#fff;color:#dc2626;border:none;padding:6px 14px;border-radius:8px;font-weight:800;cursor:pointer;font-size:12px;">今すぐ更新</button>';
    document.body.appendChild(bar);
    document.getElementById('cv-upd-now').onclick = function () { forceReload(newVer); };
    // 30秒後に自動リロード (入力していなければ)
    setTimeout(function () {
      if (!isUserBusy()) forceReload(newVer);
    }, 30000);
  }

  function forceReload(newVer) {
    try { localStorage.setItem(KEY, newVer); } catch (e) {}
    try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) {}
    // クエリにバージョンを付けてキャッシュバスト
    var url = new URL(location.href);
    url.searchParams.set('_v', newVer);
    location.replace(url.toString());
  }

  function check() {
    fetch('/api/version', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) return;
      return r.json();
    }).then(function (d) {
      if (!d || !d.success || !d.version) return;
      var stored = null;
      try { stored = localStorage.getItem(KEY); } catch (e) {}
      if (!stored) {
        // 初回: 保存のみ
        try { localStorage.setItem(KEY, d.version); } catch (e) {}
        return;
      }
      if (stored !== d.version) {
        console.log('[version-check] mismatch: stored=' + stored + ' new=' + d.version);
        if (isUserBusy()) {
          // 入力中はバナーで猶予
          showUpdateBanner(d.version);
        } else {
          forceReload(d.version);
        }
      }
    }).catch(function () {});
  }

  // 初回チェック (ページロード後ちょっと待ってから)
  setTimeout(check, 5000);
  // 定期チェック
  setInterval(check, CHECK_INTERVAL_MS);
  // ページ可視復帰時にもチェック
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') setTimeout(check, 500);
  });
})();
