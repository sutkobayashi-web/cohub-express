// CoWell Service Worker (PWA Push通知)
const CACHE = 'cohub-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'CoWell', body: (event.data && event.data.text()) || '' }; }
    // タブが開いている (foreground/background問わず) ならページ側の fireOSNotif / showNotifCard に任せて
    // SW push 通知は出さない。タブが完全に閉じている時のみここで OS 通知を出す。
    // (両方発火による DM/メンション通知の二重表示を防止)
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (list && list.length > 0) return;
    } catch (e) {}
    const title = data.title || 'CoWell';
    const options = {
      body: data.body || '',
      icon: data.icon || '/img/icon-192.png',
      badge: '/img/favicon-32.png',
      tag: data.tag || 'cohub-push',
      renotify: true,
      requireInteraction: !!data.mention,
      data: { url: data.url || '/' },
      vibrate: data.mention ? [200, 80, 200] : [100],
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
