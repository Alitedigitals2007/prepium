/* Prepium service worker
 * Caching strategy:
 *  - cache-first for versioned static assets (/css, /js, /images) and public CDNs
 *  - network-first for public HTML pages, with an offline fallback
 *  - never intercept or cache: non-GET, /api/, /admin, authenticated app pages,
 *    payment or session traffic. Private user data is never stored in caches.
 */
const VERSION = 'prepium-v3';
const STATIC_CACHE = VERSION + '-static';
const PAGE_CACHE = VERSION + '-pages';
const OFFLINE_URL = '/offline';

// Public CDN assets the app shell depends on.
const CDN_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://cdn.jsdelivr.net/npm/sweetalert2@11'
];

// Public pages that are safe to cache (no personal data, no auth required).
const PUBLIC_PAGES = ['/', '/login', '/signup', '/guide', '/terms', '/privacy', '/library', '/offline'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(CDN_ASSETS).catch(() => {});
        try {
            const pageCache = await caches.open(PAGE_CACHE);
            await pageCache.add(OFFLINE_URL).catch(() => {});
        } catch (_) {}
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

function isStaticAsset(url) {
    return (
        url.pathname.startsWith('/css/') ||
        url.pathname.startsWith('/js/') ||
        url.pathname.startsWith('/images/') ||
        url.pathname === '/manifest.json' ||
        url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'fonts.gstatic.com' ||
        url.hostname === 'cdnjs.cloudflare.com' ||
        url.hostname === 'cdn.jsdelivr.net'
    );
}

function isPrivateRequest(url) {
    return (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/admin') ||
        url.pathname.startsWith('/verify-payment') ||
        url.pathname.startsWith('/paystack') ||
        url.pathname === '/dashboard' ||
        url.pathname.startsWith('/study') ||
        url.pathname.startsWith('/cgpa') ||
        url.pathname.startsWith('/profile') ||
        url.pathname.startsWith('/history') ||
        url.pathname.startsWith('/timetable') ||
        url.pathname.startsWith('/deadlines') ||
        url.pathname.startsWith('/notifications') ||
        url.pathname.startsWith('/suggestions') ||
        url.pathname.startsWith('/refer') ||
        url.pathname.startsWith('/squads') ||
        url.pathname.startsWith('/daily-task') ||
        url.pathname.startsWith('/setup-test') ||
        url.pathname.startsWith('/quiz') ||
        url.pathname.startsWith('/renaissance') ||
        url.pathname.startsWith('/competition') ||
        url.pathname.startsWith('/upgrade') ||
        url.pathname.startsWith('/migrate-premium') ||
        url.pathname.startsWith('/auth/')
    );
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Never touch private, authenticated or security-sensitive traffic.
    if (isPrivateRequest(url)) return;

    // Static assets: cache-first (immutable or versioned content).
    if (isStaticAsset(url)) {
        event.respondWith((async () => {
            const cached = await caches.match(req);
            if (cached) return cached;
            try {
                const res = await fetch(req);
                if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                    const cache = await caches.open(STATIC_CACHE);
                    cache.put(req, res.clone());
                }
                return res;
            } catch (_) {
                const fallback = await caches.match(req, { ignoreSearch: true });
                if (fallback) return fallback;
                return new Response('', { status: 504, statusText: 'Offline' });
            }
        })());
        return;
    }

    // Same-origin navigation: network-first, fall back to cache then offline page.
    if (req.mode === 'navigate' && url.origin === self.location.origin) {
        event.respondWith((async () => {
            try {
                const res = await fetch(req);
                const isPublic = PUBLIC_PAGES.includes(url.pathname) || url.pathname.startsWith('/library');
                if (res && res.ok && isPublic) {
                    const cache = await caches.open(PAGE_CACHE);
                    cache.put(req, res.clone());
                }
                return res;
            } catch (_) {
                const cached = await caches.match(req, { ignoreSearch: true });
                if (cached) return cached;
                const offline = await caches.match(OFFLINE_URL);
                if (offline) return offline;
                return new Response('You are offline. Reconnect to use Prepium.', {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain' }
                });
            }
        })());
    }
});
