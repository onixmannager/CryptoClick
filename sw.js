// sw.js - Service Worker de Crypto Alien Click
// Correccion de estabilidad:
// - Las navegaciones HTML usan network-first para evitar pantallas rotas servidas desde cache.
// - Firebase/Auth/Firestore y SDK JS van siempre a red.
// - Iconos/manifest e imagenes externas pueden usar cache como respaldo offline.

const VERSION = 'v6';
const SHELL_CACHE = `cryptoclick-shell-${VERSION}`;
const ASSET_CACHE = `cryptoclick-assets-${VERSION}`;

const SCOPE_URL = new URL(self.registration.scope);
const APP_SHELL_URLS = [
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/favicon-16.png'
].map((path) => new URL(path, SCOPE_URL).toString());

const NEVER_CACHE_HOSTS = new Set([
  'firestore.googleapis.com',
  'firebaseauth.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'www.googleapis.com',
  'accounts.google.com',
  'www.gstatic.com'
]);

const SWR_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'raw.githubusercontent.com'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_URLS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('cryptoclick-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isNeverCache(url) {
  return NEVER_CACHE_HOSTS.has(url.hostname);
}

function isSWR(url) {
  return SWR_HOSTS.has(url.hostname);
}

function isHtmlRequest(request, url) {
  return request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
}

// Una respuesta 206 (Partial Content) nunca se puede guardar en Cache
// Storage (la spec lo prohibe explícitamente) y tampoco se debe servir
// como si fuera el recurso completo: si se cuela un status 206 aquí,
// el fetch de un script/módulo recibiría solo un trozo del archivo y
// el parser rompería con "Unexpected end of input" (como pasaba con
// invasion-core.js). isCacheable() es el filtro común que evita ambas cosas.
function isCacheable(response) {
  return !!response && response.status === 200 && response.type !== 'opaqueredirect';
}

// Guarda en caché sin dejar nunca una promesa de cache.put() sin capturar:
// si cache.put() falla (por lo que sea), no debe convertirse en un
// "Uncaught (in promise)" ni afectar a la respuesta ya devuelta a la página.
function safePut(cache, request, response) {
  if (!isCacheable(response)) return;
  cache.put(request, response.clone()).catch((err) => {
    console.warn('[sw] no se pudo cachear', request.url, err);
  });
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    safePut(cache, request, response);
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(new URL(fallbackUrl, SCOPE_URL).toString());
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  safePut(cache, request, response);
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      safePut(cache, request, response);
      // Si la red devuelve algo que no es un 200 normal (ej. un 206
      // parcial colado, o un error), y ya había algo en caché, servimos
      // la versión cacheada en vez de pasar un recurso incompleto/roto
      // a la página.
      if (!isCacheable(response) && cached) return cached;
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Las peticiones con cabecera "Range" (vídeos/audios haciendo seek, o el
  // propio Chrome reanudando una descarga interrumpida de CUALQUIER
  // recurso, incluido JS) se dejan pasar directas a la red sin que el SW
  // las intercepte. Es la causa raíz de los errores "Partial response
  // (status code 206) is unsupported" y de que invasion-core.js llegara
  // truncado: si el SW gestiona una Range request, puede acabar sirviendo
  // ese trozo parcial como si fuera el archivo completo. Dejándolas pasar,
  // el navegador las resuelve de forma nativa (incluye su propia gestión
  // de 206) y nunca llega un módulo/script a medias al parser.
  if (request.headers.has('range')) return;

  const url = new URL(request.url);

  if (isNeverCache(url)) {
    return;
  }

  if (isHtmlRequest(request, url)) {
    event.respondWith(networkFirst(request, 'index.html'));
    return;
  }

  if (url.origin === self.location.origin) {
    // cacheFirst servía JS/CSS del propio origen para siempre sin
    // comprobar si había una versión nueva en el servidor — cualquier
    // archivo de código (ej. invasion-core.js) quedaba pegado a la
    // primera versión que el navegador llegó a cachear, aunque se subiera
    // un archivo distinto al servidor después. staleWhileRevalidate sigue
    // sirviendo al instante desde caché (no se pierde velocidad offline)
    // pero SIEMPRE dispara una petición de red en paralelo que refresca
    // el caché para la siguiente vez — así una actualización de código
    // tarda como mucho una recarga extra en llegar, no queda cacheada
    // de forma indefinida.
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (isSWR(url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
