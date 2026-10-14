/*
 * Glubschi gewinnt - Service Worker
 *
 * - Precache der App-Hülle, damit das Spiel auch ohne Netz startet.
 * - Seitenaufrufe: erst Netz (max. 3,5 s), sonst die gespeicherte index.html.
 *   Der Query-String (?raum=...) wird dabei ignoriert.
 * - Eigene Dateien: stale-while-revalidate.
 * - Google Fonts: cache-first in einem eigenen Cache.
 * - Alles andere von fremden Servern (vor allem ntfy.sh mit SSE) läuft
 *   unangetastet am Service Worker vorbei.
 *
 * Neue Version ausrollen: vor jedem Deploy `node tools/stamp.mjs` ausführen.
 * Das versieht audio.js und relay.js in index.html und PRECACHE mit ?v=<Hash>
 * und setzt VERSION auf einen Hash der ganzen App-Hülle. So läuft eine neue
 * index.html nie mit alten Skripten aus dem Cache, und jede Änderung löst den
 * Hinweis "Neue Version da" aus. Die Seite kann den wartenden Worker mit
 * postMessage({ type: 'skip-waiting' }) sofort aktivieren.
 */
'use strict';

const VERSION = 'glubschi-8a307a6dfa';
const CACHE_PREFIX = 'glubschi-';       // alle Caches dieser App (Origin wird mit anderen GitHub-Pages-Projekten geteilt)
const FONT_CACHE = 'glubschi-fonts';    // Font-Dateien sind versioniert und überleben App-Updates
const NAV_TIMEOUT_MS = 3500;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

const PRECACHE = [
  './',
  './index.html',
  './relay.js?v=dc21e25914',
  './audio.js?v=79bb4f25c7',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

const SCOPE_URL = new URL('./', self.location.href).href;
const SCOPE_PATH = new URL(SCOPE_URL).pathname;
const INDEX_URL = new URL('./index.html', SCOPE_URL).href;

const noop = () => {};

// Antworten nach Weiterleitung lassen sich in Safari nicht für Navigationen verwenden.
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function isCacheable(res) {
  return res && res.status === 200 && res.type === 'basic';
}

/* ---------- Install: jede Datei einzeln, ein Fehlschlag bricht nichts ab ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const results = await Promise.allSettled(PRECACHE.map(async (path) => {
      const url = new URL(path, SCOPE_URL).href;
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (!isCacheable(res)) throw new Error(`${path}: HTTP ${res.status}`);
      await cache.put(url, await cleanResponse(res));
    }));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      console.warn(`[sw] ${failed.length} von ${PRECACHE.length} Dateien nicht vorgeladen:`,
        failed.map((r) => String(r.reason && r.reason.message || r.reason)));
    }
  })());
});

/* ---------- Activate: alte App-Caches weg, sofort übernehmen ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && !key.startsWith(VERSION) && key !== FONT_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

/* ---------- Fetch ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    // Nur Google Fonts übernehmen; ntfy.sh (Long-Polling, SSE) & Co. bleiben unberührt.
    if (FONT_HOSTS.has(url.hostname)) event.respondWith(fontCacheFirst(req));
    return;
  }

  if (!url.pathname.startsWith(SCOPE_PATH)) return;               // anderes GitHub-Pages-Projekt
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/event-stream') || req.headers.has('range')) return;

  staleWhileRevalidate(event);
});

async function fontCacheFirst(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Das Stylesheet kommt ohne CORS als opaque Antwort (Status 0), die Font-Dateien mit CORS.
    if (res.status === 200 || res.type === 'opaque') cache.put(req, res.clone()).catch(noop);
    return res;
  } catch (err) {
    return Response.error();
  }
}

async function networkFirstNavigation(event) {
  const req = event.request;
  const cache = await caches.open(VERSION);
  const url = new URL(req.url);
  const isShell = url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html';

  const network = fetch(req).then((res) => {
    if (isCacheable(res)) {
      const copyA = res.clone();
      const copyB = isShell ? res.clone() : null;
      event.waitUntil((async () => {
        if (isShell) {
          await cache.put(INDEX_URL, await cleanResponse(copyA));
          await cache.put(SCOPE_URL, await cleanResponse(copyB));
        } else {
          await cache.put(url.origin + url.pathname, await cleanResponse(copyA));
        }
      })().catch(noop));
    }
    return res;
  });
  network.catch(noop);
  event.waitUntil(network.then(noop, noop));

  const fromCache = async () =>
    (await cache.match(INDEX_URL)) ||
    (await cache.match(req, { ignoreSearch: true })) ||
    (await cache.match(SCOPE_URL));

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, NAV_TIMEOUT_MS, 'timeout'); });
  try {
    const winner = await Promise.race([network, timeout]);
    if (winner !== 'timeout') {
      if (winner.status >= 500) {
        const cached = await fromCache();
        if (cached) return cached;
      }
      return winner;
    }
  } catch (err) {
    // offline oder DNS-Fehler: weiter mit dem Cache
  } finally {
    clearTimeout(timer);
  }

  const cached = await fromCache();
  if (cached) return cached;
  try {
    return await network;            // noch nichts im Cache: doch aufs Netz warten
  } catch (err) {
    return offlinePage();
  }
}

function staleWhileRevalidate(event) {
  const req = event.request;
  let caching = Promise.resolve();
  const network = fetch(req).then((res) => {
    if (isCacheable(res)) {
      const copy = res.clone();
      caching = caches.open(VERSION).then((cache) => cache.put(req, copy));
    }
    return res;
  });
  event.waitUntil(network.then(() => caching).catch(noop));
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    return network;
  })());
}

function offlinePage() {
  const html = '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Glubschi gewinnt</title></head>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#FFD3E6;color:#24164A;' +
    'font:600 18px/1.4 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box">' +
    '<div><p style="font-size:28px;font-weight:800;margin:0 0 8px">Kein Netz</p>' +
    '<p style="margin:0">Die Glubschis finden gerade kein Internet. Versuch es gleich nochmal.</p></div></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
