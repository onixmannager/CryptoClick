// sw.js — Service Worker de Crypto Alien Click
// Estrategia:
//  - App shell (HTML/manifest/iconos propios): cache-first -> abre instantáneo y offline.
//  - Firebase (auth/firestore) y cualquier llamada a Google APIs: siempre red, nunca cache.
//    (el login y el guardado de partidas necesitan datos frescos, no cacheados)
//  - Fuentes e imágenes externas (fonts.googleapis, raw.githubusercontent, etc.):
//    stale-while-revalidate -> respuesta instantánea desde cache + actualización en segundo plano.

const VERSION = 'v1';
const SHELL_CACHE = `cryptoclick-shell-${VERSION}`;
const ASSET_CACHE = `cryptoclick-assets-${VERSION}`;

// Rutas del propio origen que forman el "app shell".
// index.html es el juego real (lo que se instala como PWA); landing.html
// se deja fuera del precache porque es solo la página de marketing.
const SHELL_URLS = [
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png'
];

// Dominios que NUNCA deben cachearse: todo lo relacionado con Firebase Auth/Firestore
// debe ir siempre a la red, o el login y el guardado de partidas se romperían.
const NEVER_CACHE_HOSTS = [
  'firestore.googleapis.com',
  'firebaseauth.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'accounts.google.com'
];

// Dominios de assets estáticos externos (fuentes, imágenes) aptos para
// stale-while-revalidate: se sirven rápido desde cache y se refrescan en segundo plano.
const SWR_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'raw.githubusercontent.com',
  'www.gstatic.com' // SDK de Firebase (los .js del SDK sí son cacheables, no las llamadas de red del SDK)
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function isNeverCache(url) {
  return NEVER_CACHE_HOSTS.some((host) => url.hostname === host);
}

function isSWR(url) {
  return SWR_HOSTS.some((host) => url.hostname === host);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached); // sin red -> lo que haya en cache, si hay
  return cached || network;
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    // Navegación offline sin nada en cache: devolvemos el shell (index.html)
    // como último recurso para que la app al menos abra.
    if (request.mode === 'navigate') {
      const shellFallback = await cache.match('/index.html');
      if (shellFallback) return shellFallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // no interceptar POST/PUT (escrituras a Firestore, etc.)

  const url = new URL(request.url);

  // 1) Firebase Auth/Firestore: siempre red, nunca tocar cache.
  if (isNeverCache(url)) {
    return; // dejar pasar tal cual, sin respondWith -> comportamiento normal del navegador
  }

  // 2) Navegación (abrir la app / recargar): app shell cache-first con fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(cacheFirst(new Request('/index.html')));
    return;
  }

  // 3) Assets propios del shell (mismo origen): cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 4) Fuentes/imágenes externas conocidas: stale-while-revalidate.
  if (isSWR(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 5) Cualquier otro origen externo no listado: dejar pasar normal (network-only implícito).
});
