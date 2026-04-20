// CoHub Express Service Worker (PWA Push通知)
const CACHE = 'cohub-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'CoHub', body: (event.data && event.data.text()) || '' }; }
  const title = data.title || 'CoHub Express';
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
  event.waitUntil(self.registration.showNotification(title, options));
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
