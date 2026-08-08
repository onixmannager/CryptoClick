# Crypto Alien Click — estructura PWA

Esta carpeta es tu proyecto original (`index.html`, `landing.html`, `firestore.rules`,
`vercel.json`) con lo necesario añadido para convertirlo en una PWA instalable y
pasarlo por [PWABuilder.com](https://www.pwabuilder.com/).

## Qué se añadió

```
pwa/
├── index.html              ← el juego (app instalable) — con manifest + SW enlazados
├── landing.html             ← tu landing de marketing, intacta (no es la app instalable)
├── manifest.webmanifest     ← NUEVO: metadata de la PWA (nombre, iconos, colores...)
├── sw.js                    ← NUEVO: service worker (offline + caché)
├── icons/                   ← NUEVO: set de iconos generado desde tu logo del alien
│   ├── favicon-16.png
│   ├── favicon-32.png
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-maskable-512.png
│   └── apple-touch-icon.png
├── vercel.json               ← actualizado: headers para que sw.js/manifest no se cacheen de más
└── firestore.rules           ← tal cual, sin cambios
```

**index.html es la app instalable**, no `landing.html`. Por eso el `start_url` del
manifest apunta a `/index.html` y solo `index.html` registra el service worker.
`landing.html` sigue funcionando igual que antes, como puerta de entrada/marketing,
con sus botones "JUGAR AHORA" llevando a `index.html`.

## Por qué estas decisiones

- **Iconos**: los generé a partir de tu imagen del alien
  (`BackgroundEraser_20260330_044416658.png`), recortada a cuadrado y centrada.
  El `icon-maskable-512.png` tiene más margen de seguridad (80% central) porque
  Android/iOS recortan los iconos "maskable" en círculo o squircle — si no dejas
  ese margen, se corta la cabeza del alien o la moneda.
- **Colores**: `theme_color` y `background_color` = `#0b0a14`, el mismo `--bg`
  que ya usa tu juego, para que la pantalla de splash que genera el sistema
  combine con tu propio loader.
- **Service worker (`sw.js`)**: estrategia mixta a propósito, no "cachear todo":
  - Tu **shell** (HTML, iconos, manifest) → cache-first, abre instantáneo y offline.
  - **Firebase Auth/Firestore** (login con Google, guardado de partidas) →
    **nunca se cachea**, siempre va a red. Si esto se cacheara, el login o el
    guardado de tu progreso podrían fallar o mostrar datos viejos.
  - **Fuentes de Google e imágenes de tu repo de GitHub** → stale-while-revalidate
    (se sirven al instante desde caché y se actualizan en segundo plano).
- **`landing.html` no registra el service worker** ni enlaza el manifest: es
  intencional, así el navegador solo ofrece "Instalar app" cuando el usuario
  está dentro del juego, que es lo que realmente tiene sentido instalar.

## Pasos siguientes

### 1. Sube esta carpeta a tu hosting (Vercel, GitHub Pages, etc.)

Todo debe quedar servido en la **raíz** del dominio (o subcarpeta, ajustando las
rutas `/manifest.webmanifest`, `/sw.js`, `/icons/...` en `index.html` y en el
propio manifest si no despliegas en la raíz). Con Vercel, como ya tienes
`vercel.json`, simplemente conecta el repo o haz `vercel deploy` desde esta carpeta.

**Importante**: la PWA necesita **HTTPS** (Vercel te lo da automático). No
funciona el service worker en `http://` salvo en `localhost` para pruebas.

### 2. Verifica que todo esté accesible

Una vez desplegado, comprueba en el navegador que cargan:
- `https://tu-dominio.com/manifest.webmanifest`
- `https://tu-dominio.com/sw.js`
- `https://tu-dominio.com/icons/icon-512.png`

### 3. Pásalo por PWA Builder

1. Ve a **https://www.pwabuilder.com/**
2. Pega la URL de tu juego ya desplegado (la de `index.html`, ej.
   `https://tu-dominio.com/` si tienes cleanUrls activado, o
   `https://tu-dominio.com/index.html`)
3. PWA Builder analizará el manifest y el service worker automáticamente y
   te dará un "Report Card". Con esta estructura deberías pasar los checks de:
   - ✅ Manifest válido con iconos (incluyendo maskable)
   - ✅ Service worker registrado
   - ✅ HTTPS
4. Desde ahí puedes generar los paquetes para **Google Play (Android/TWA)**,
   **Microsoft Store** o **App Store (iOS)** directamente.

### 4. Prueba la instalación manualmente antes de publicar

- **Android/Chrome desktop**: entra al juego → el navegador debería ofrecer
  el icono de "Instalar app" en la barra de direcciones.
- **iOS/Safari**: Compartir → "Añadir a pantalla de inicio" (iOS no muestra
  el prompt automático, siempre es manual).

### Nota sobre el login con Google en modo instalado

Tu código ya maneja esto bien: usa `signInWithPopup` con fallback automático
a `signInWithRedirect` si el popup falla. Eso es justo lo recomendable para
una PWA instalada, porque en modo standalone los popups de OAuth a veces se
comportan distinto que en una pestaña normal del navegador. No hace falta
que cambies nada ahí.
