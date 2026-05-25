// CoWell Service Worker (PWA Push通知)
// v4 (2026-05-18): 旧 lobby/葵版が残存する PWA を強制的に /home に飛ばすため cache全削除＋controlled clientsをnavigate。
const CACHE = "cohub-v6";

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 旧バージョン (v1/v2/v3) が CacheStorage に残した全エントリを掃除。
    // 現行 SW は HTMLキャッシュしない設計だが、過去にキャッシュされた index.html が
    // 旧 lobby/葵 を返し続ける事案が出ているため、ここで一掃する。
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    } catch (e) {}
    await self.clients.claim();
    // controlled 化したクライアントを最新HTMLに再ナビゲート。
    // ルート(`/`)とパス無しは /home に振り、それ以外は同じURLを再取得させて
    // サーバー側302/最新static配信に乗せ替える。
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        try {
          const u = new URL(c.url);
          const target = (u.pathname === '/' || u.pathname === '') ? '/home' : c.url;
          await c.navigate(target);
        } catch (e) {}
      }
    } catch (e) {}
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
