/**
 * Service Worker — Ônibus MC (Cache Offline de App Shell + Web Push / Notificações)
 */
const CACHE_NAME = 'onibus-mc-v4';
const ASSETS_TO_CACHE = [
    './',
    './assets/css/app.css?v=2.3.0',
    './assets/js/app.js?v=2.3.0',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE).catch(() => {}))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    // Para chamadas de API em tempo real (/api/vehicles), usar sempre rede primeiro
    if (req.url.includes('/api/vehicles')) {
        return;
    }

    event.respondWith(
        fetch(req)
            .then((networkRes) => {
                if (networkRes && networkRes.status === 200 && req.url.startsWith(self.location.origin)) {
                    const clone = networkRes.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
                }
                return networkRes;
            })
            .catch(() => caches.match(req))
    );
});

self.addEventListener('push', (event) => {
    let payload = {
        title: '🚍 Ônibus MC — Alerta de Aproximação',
        body: 'Seu ônibus está próximo ao ponto de embarque!'
    };
    if (event.data) {
        try {
            payload = event.data.json();
        } catch (e) {
            payload.body = event.data.text();
        }
    }
    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: 'https://cdn-icons-png.flaticon.com/512/3448/3448339.png',
            vibrate: [200, 100, 200],
            tag: 'onibus-mc-push'
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            if (windowClients.length > 0) {
                return windowClients[0].focus();
            }
            return clients.openWindow('./');
        })
    );
});
