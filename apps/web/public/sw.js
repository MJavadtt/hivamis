/**
 * Hiva OS service worker (roadmap #19).
 *
 * Written by hand rather than generated: the caching rules here are short enough to read, and
 * a form the production unit fills on set is not the place to find out what a plugin decided.
 *
 * Three rules, and nothing else:
 *   1. Navigation falls back to the cached shell when the network is unreachable, so opening
 *      the app with no signal opens the app rather than the browser's dinosaur.
 *   2. Built assets (hashed filenames) and fonts are cache-first — they never change under a
 *      given name.
 *   3. GETs of form definitions are network-first with a cached fallback, so the forms someone
 *      opened before leaving the office can still be *opened* in the field. Nothing else from
 *      the API is cached: stale project data is worse than no project data.
 *
 * Submissions are never intercepted here. They are queued in IndexedDB by the app itself
 * (lib/outbox.ts), which can show the person what is waiting and what was refused — something
 * a background sync in a worker cannot do honestly.
 */
const VERSION = 'hiva-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const FORMS = `${VERSION}-forms`;
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.add(new Request(SHELL_URL, { cache: 'reload' })).catch(() => undefined);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS, FORMS]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

const isAsset = (url) =>
  url.origin === self.location.origin
  && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/') || url.pathname.endsWith('.woff2'));

const isFormDefinition = (url) =>
  url.origin === self.location.origin && /^\/api\/v1\/forms\/definitions/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = await caches.match(SHELL_URL);
        return cached ?? Response.error();
      }
    })());
    return;
  }

  if (isAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const res = await fetch(request);
      if (res.ok) (await caches.open(ASSETS)).put(request, res.clone());
      return res;
    })());
    return;
  }

  if (isFormDefinition(url)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        // Only a real answer is worth keeping: a 401 cached here would outlive the session.
        if (res.ok) (await caches.open(FORMS)).put(request, res.clone());
        return res;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error('offline and no cached copy of this form');
      }
    })());
  }
});

/* ── Web Push (roadmap #49) ──────────────────────────────────────────────────────────────────
 * The server encrypts each notice to this browser's key; the browser decrypts it before this
 * handler sees it. Only the three short-deadline loops arrive here — see apps/api/src/push. */

/** Where a notice may open: a page of this app, never an address carried in a message. */
const ownPage = (raw) => {
  try {
    const url = new URL(raw || '/m', self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : '/m';
  } catch {
    return '/m';
  }
};

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'هیوا', {
      body: data.body || '',
      tag: data.tag || undefined,
      // The same record again (a warning after the first notice) replaces it — and says so.
      renotify: Boolean(data.tag),
      requireInteraction: Boolean(data.urgent),
      dir: 'rtl',
      lang: 'fa',
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: ownPage(data.url) },
    });
    // An open app re-reads its queue at once, rather than at its next poll.
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      client.postMessage({ type: 'hiva:push', kind: data.kind || null });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = ownPage(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((c) => new URL(c.url).pathname.startsWith('/m')) || windows[0];
    if (open) {
      await open.focus();
      // The page moves itself: navigating a client from here works only for pages this worker controls.
      open.postMessage({ type: 'hiva:open', url: path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});
