// CoWell Service Worker (PWA Push通知)
// v4 (2026-05-18): 旧 lobby/葵版が残存する PWA を強制的に /home に飛ばすため cache全削除＋controlled clientsをnavigate。
// v7 (2026-06-15): 「旧版が通常ブラウザで起動する」事案対策。activate時に CacheStorage を全削除(例外なし)し、
//                  旧SWが残したキャッシュシェルを根絶。push通知ハンドラは維持(通知は引き続き機能)。
// v8 (2026-06-15): activate時の「全クライアント強制navigate(リロード)」を撤去。リセット直後にトップ描画途中で
//                  リロードが走り「遅い/出ない」と感じる原因だったため。キャッシュ掃除+claimのみに簡素化。
const CACHE = "cohub-v8";

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 旧バージョンが CacheStorage に残した全エントリを掃除。
    // 現行 SW は HTMLキャッシュしない設計なので、例外なく全キャッシュを削除して
    // 旧 lobby/葵 シェルや古いHTMLを根絶する。
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (e) {}
    await self.clients.claim();
    // 注: 旧版では controlled clients を c.navigate() で強制リロードしていたが、
    //     トップ描画途中のリロードで「遅い/画面が出ない」誤認を招くため撤去。
    //     現行SWはfetchをインターセプトしないので、次回ナビゲーションで自然に最新が読まれる。
  })());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'CoWell', body: (event.data && event.data.text()) || '' }; }
    // タブが開いている (foreground/background問わず) ならページ側の fireOSNotif / showNotifCard に任せて
    // SW push 通知は出さない。タブが完全に閉じている時のみここで OS 通知を出す。
    // (両方発火による DM/メンション通知の二重表示を防止)
    try {
      // data.alwaysShow=true なら開いてても出す (plaza:new等の全員向け重要通知)
      if (!data.alwaysShow) {
        const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (list && list.length > 0) return;
      }
    } catch (e) {}
    const title = data.title || 'CoWell';
    const options = {
      body: data.body || '',
      icon: data.icon || '/img/icon-192.png',
      badge: '/img/favicon-32.png',
      tag: data.tag || 'cohub-push',
      renotify: true,
      requireInteraction: data.requireInteraction !== undefined ? !!data.requireInteraction : !!data.mention,
      data: { url: data.url || '/' },
      vibrate: data.vibrate || (data.mention ? [200, 80, 200] : [100]),
    };
    return self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        try {
          if (c.url.includes(self.location.origin)) {
            c.focus();
            c.postMessage({ type: 'push-click', url });
            return;
          }
        } catch (e) {}
      }
      return self.clients.openWindow(url);
    })
  );
});
