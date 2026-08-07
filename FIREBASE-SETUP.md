# Configurar Firebase (gratis) para Crypto Alien Click

El juego ya tiene todo el código listo. Solo faltan 3 pasos: crear el proyecto, activar Google Login, pegar tu config y poner las reglas de seguridad.

## 1. Crear proyecto Firebase
1. Ve a https://console.firebase.google.com
2. "Agregar proyecto" → nómbralo (ej: `crypto-alien-click`) → puedes desactivar Google Analytics, no hace falta.
3. Cuando termine, entra al proyecto.

## 2. Activar login con Google
1. Menú lateral → **Build → Authentication** → "Comenzar".
2. Pestaña **Sign-in method** → activa **Google** → guarda.
3. En **Authentication → Settings → Authorized domains**, agrega el dominio donde publiques el juego (ej: `tu-proyecto.vercel.app`). `localhost` ya viene incluido para pruebas.

## 3. Crear la base de datos (Firestore)
1. Menú lateral → **Build → Firestore Database** → "Crear base de datos".
2. Elige **modo producción** (más seguro) y la región más cercana a tus usuarios.
3. Ve a la pestaña **Reglas** y reemplaza todo por esto:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /saves/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Esto asegura que **cada jugador solo pueda leer/escribir su propia partida** — nadie puede ver ni modificar la de otro, y nadie sin login puede tocar la base de datos. Publica las reglas.

## 4. Obtener tu configuración y pegarla en el juego
1. Menú lateral → ⚙️ **Configuración del proyecto** (ícono de engranaje, arriba a la izquierda).
2. Baja a "Tus apps" → click en **</> (Web)** → dale un nombre → "Registrar app".
3. Copia el objeto `firebaseConfig` que te muestra, algo así:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "crypto-alien-click.firebaseapp.com",
  projectId: "crypto-alien-click",
  storageBucket: "crypto-alien-click.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

4. Abre `index.html`, busca este bloque (cerca de la línea 601) y **reemplázalo** con tus valores reales:

```js
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};
```

5. Guarda el archivo y sube tu proyecto (Vercel, Netlify, etc. — ya tienes `vercel.json` listo).

## Listo — así funciona
- Al entrar, el usuario ve una pantalla de **login con Google** obligatoria.
- Tras entrar, se hace **1 sola lectura** a Firestore para traer su partida guardada.
- El progreso se guarda **al instante en el propio dispositivo** (localStorage, sin costo) y se sube a la nube cada ~110 segundos como máximo (solo si hubo cambios), más al cerrar la pestaña o cambiar de app.
- Esto significa que aunque tengas miles de jugadores activos a la vez, cada uno genera muy pocas escrituras por hora, así que te mantienes cómodamente dentro del plan gratuito de Firebase (Spark): 50,000 lecturas y 20,000 escrituras gratis al día.
- Si el usuario juega en dos dispositivos, se usa automáticamente el guardado más reciente entre nube y local (por fecha), para no perder progreso.

## Nota sobre costos si el juego crece mucho
Si en el futuro tienes decenas de miles de jugadores diarios y te acercas al límite gratis, lo más barato es simplemente aumentar el intervalo de guardado en la nube (buscar `CLOUD_MIN_INTERVAL` en `index.html` y subirlo, por ejemplo a 300000 = 5 min) antes de pasar a un plan de pago.
