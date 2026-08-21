/* ══════════════════════════════════════════════════════════════════════
   INVASION CORE — lógica compartida del modo Invasión
   ══════════════════════════════════════════════════════════════════════
   Ver docs/DISEÑO.md para el porqué de cada decisión. Resumen rápido:

   - Este proyecto (CryptoClick) es 100% estático: Vercel + Firebase
     client SDK, SIN Cloud Functions ni backend propio.
   - Por eso TODA la lógica de aquí (elegir rival, resolver el minijuego,
     calcular el robo) corre en el navegador del jugador. La única
     barrera anti-trampa real son las Firestore Rules (firestore/
     invasion.rules), que validan los documentos que este archivo escribe.
   - Esto es "difícil de explotar con DevTools", NO "imposible". Se
     documenta así a propósito, no es un descuido.

   Este módulo se carga con <script type="module"> y expone funciones en
   window.InvasionCore para que las pantallas (HTML sueltos, sin bundler,
   igual que index.html/invasion.html del juego padre) puedan usarlo sin
   imports relativos frágiles.
   ══════════════════════════════════════════════════════════════════════ */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteField,
  collection, query, where, orderBy, limit, getDocs,
  serverTimestamp, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ─────────────────────────────────────────────────────────────────────
// FIREBASE: mismo proyecto real que index.html/invasion.html del padre.
// Reutilizamos la app si ya fue inicializada por otro script en la misma
// página (evita "Firebase App named '[DEFAULT]' already exists").
// ─────────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAEVcDHhKSyPd4n_U-DXzJI7lskY7BTiyI",
  authDomain: "crypto-alien.firebaseapp.com",
  projectId: "crypto-alien",
  storageBucket: "crypto-alien.firebasestorage.app",
  messagingSenderId: "61542154571",
  appId: "1:61542154571:web:bddd5100632abc9f09a8ce"
};
const fbApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// ─────────────────────────────────────────────────────────────────────
// CONFIG DE NEGOCIO — todos los números del sistema en un solo lugar.
// Cambiar el balance del modo es cambiar esto, no buscar constantes
// desperdigadas por el código.
// ─────────────────────────────────────────────────────────────────────
const CFG = {
  // Escudos: duración en horas. Todos definidos aunque de momento solo
  // '3d' y '7d' se puedan COMPRAR (ver SHIELDS_ENABLED) — el resto del
  // sistema (expiración, cuenta atrás, filtrado de objetivos) funciona
  // igual para los 4 tipos sin cambios de esquema.
  // NOTA: las claves '3d'/'7d' son solo el identificador técnico del
  // escudo plata/dorado (heredado de cuando duraban 3 y 7 días) — se
  // mantienen así aposta para no tocar el resto del sistema (Firestore,
  // comparaciones de tipo activo, selección de imagen en index.html),
  // pero el NÚMERO de horas ya no corresponde a esos nombres: por
  // modelo de negocio, el escudo plata ('3d') dura 12h y el dorado
  // ('7d') dura 24h.
  SHIELD_HOURS: { '6h': 6, '24h': 24, '3d': 12, '7d': 24 },
  SHIELDS_ENABLED: ['3d', '7d'],

  // Coste en $CLK de cada escudo, escalado por nivel del jugador con el
  // MISMO patrón de progresión que usa el resto del juego padre (ver
  // index.html: xpNeed = 500*1.18^(lvl-1), upCost = base*1.5^ups,
  // misGoal = g*1.6^(lvl-1)) — aquí: costeBase * exponente^(lvl-1).
  // '7d' usa una base y exponente mayores que '3d' para que salga siempre
  // más caro que '3d' en cualquier nivel, no solo en el nivel 1.
  // base x10 a petición expresa (antes 5.000/10.000 en nivel 1) para que
  // en nivel 1 cueste exactamente 50.000 (3d) y 100.000 (7d); exp intacto
  // (mismo ritmo de escalado agresivo que ya tenía el sistema), así que
  // el x10 se mantiene proporcional en cualquier nivel, no solo en el 1.
  // A nivel 50 esto da ~12,90M (3d) / ~61,42M (7d).
  SHIELD_COST: {
    '3d': { base: 50000,  exp: 1.12 },
    '7d': { base: 100000, exp: 1.14 },
  },

  // NOTA: existía aquí una probabilidad de victoria fija (WIN_PROBABILITY)
  // que decidía ganar/perder con una moneda ajena al minijuego, ignorando
  // si el jugador encontró los 3 depósitos a tiempo. Se elimina a
  // petición expresa: el resultado ahora depende de verdad de lo que pasa
  // en el tablero (minigame.html ya no llama a una tirada aparte, usa
  // directamente si encontró los 3 depósitos). Ver difficultyFor() más
  // abajo para el equilibrio de intentos/tiempo por tier, que es ahora el
  // único lugar donde vive la dificultad real del modo.

  // Anti-abuso
  // Bajado de 60s a 5s a petición expresa: el cooldown largo se sentía
  // como fricción sin aportar nada al anti-abuso real (esa barrera es el
  // límite diario de abajo + las Firestore Rules, no este número). 5s
  // basta para absorber un doble-clic accidental sin frenar el ritmo de
  // juego entre invasiones consecutivas.
  INVASION_COOLDOWN_MS: 5 * 1000,
  // Bajado de 30 a 10 a petición expresa (ajuste posterior al cambio de
  // cooldown 60s→5s documentado arriba): 30/día con un cooldown de solo
  // 5s hacía que el límite diario fuera casi la única fricción real del
  // modo, pero en la práctica 30 ataques por cuenta y día se consideró
  // demasiado alto para el ritmo de partidas deseado. Se acota a 10/día,
  // manteniendo el cooldown corto de 5s (que sigue absorbiendo el
  // doble-clic accidental sin ser la fricción principal). Debe ir
  // sincronizado con el tope invasionsToday <= 30 en firestore.rules —
  // ver ese archivo, función isValidPlayerDoc(): ese límite es
  // deliberadamente más ancho que este (actúa como techo absoluto de
  // seguridad ante manipulación directa del cliente, no como el límite
  // de producto real) y no hace falta bajarlo a la par de este número
  // salvo que se quiera estrechar también esa cota de seguridad.
  MAX_INVASIONS_PER_DAY: 10,
  SAME_TARGET_COOLDOWN_MS: 4 * 60 * 60 * 1000, // 4h sin repetir objetivo
  NEW_ACCOUNT_PROTECTION_MS: 0, // protección a cuentas nuevas desactivada a petición: cualquier cuenta puede invadir desde el minuto 1
  REVENGE_WINDOW_MS: 24 * 60 * 60 * 1000,    // 24h para vengarse

  // Ventana máxima para que el DEFENSOR responda a un ataque pendiente
  // (jugar su minijuego de interceptación) antes de que el duelo se
  // resuelva automáticamente a favor del atacante — ver
  // expirePendingAttack() más abajo. A petición expresa: pasadas las
  // 24h sin respuesta, se cuenta como una victoria más del atacante,
  // con el mismo cálculo de botín que una victoria jugada de verdad
  // (mismo tier de dificultad, mismo robMax, mismo colchón mínimo), y
  // el defensor SÍ pierde ese $CLK exactamente igual que si hubiera
  // jugado y perdido. No es una expiración neutra: es una victoria por
  // incomparecencia, a propósito.
  PENDING_ATTACK_WINDOW_MS: 24 * 60 * 60 * 1000,

  // Objetivo debe tener al menos esto para poder ser robado (evita que
  // se pueda "invadir" a alguien con 0 saldo solo para gastar su cooldown)
  MIN_CLK_TO_BE_TARGET: 50,

  // Nunca dejar al defensor con menos de este colchón absoluto, además
  // del tope en % de la tabla de dificultad (protege saldos bajos donde
  // un % alto igualmente dejaría una cifra insignificante o en 0).
  MIN_CLK_LEFT_AFTER_ROB: 10,

  // Tabla de dificultad por diferencia de nivel (invasor - defensor).
  // tiempoMs / intentos alimentan el minijuego; robMax es el % techo.
  //
  // Reajustada a petición expresa ("que se gane más, más fácil, al 50%,
  // y que dependa de la suerte real del jugador"): ahora que el resultado
  // del minijuego SÍ decide ganar/perder (ver minigame.html/endGame(),
  // ya no hay tirada aparte), los `intentos` de esta tabla son la
  // dificultad real, no decorativa. Se suben en todos los tiers para que
  // ganar sea alcanzable con juego normal — con 9 casillas (3 depósitos·
  // 3 trampas·3 vacíos) y coste trampa=2/vacío=1/depósito=0, el tier
  // 'normal' antes solo perdonaba UNA trampa con 3 intentos; con 5
  // intentos perdona dos trampas y dos vacíos antes de fallar, lo que
  // deja la victoria mayormente en manos de encontrar rápido los
  // depósitos (la "suerte" de qué casillas tocas primero) en vez de
  // depender de acertar sin ningún margen de error. robMax también sube
  // en todos los tiers manteniendo el mismo orden relativo de dificultad.
  //
  // Corrección posterior (bug real medido en simulación con el barajado
  // Fisher-Yates de buildGrid() en minigame.html, 300k partidas por
  // tier): con intentos=5 el tier 'normal' ganaba solo ~18% de las
  // veces, no "alcanzable con juego normal" como decía el comentario de
  // arriba — 5 intentos perdona como mucho dos trampas/vacíos antes de
  // fallar, y en 9 casillas eso sigue siendo insuficiente la mayoría de
  // las veces. Pedido expreso: que se gane aprox 2 de cada 3 (≈66%).
  // Con este barajado, el máximo de intentos que se pueden "gastar" en
  // trampas/vacíos antes de destapar el 3er depósito en el peor caso es
  // 3*2 (trampas) + 3*1 (vacíos) = 9 — por eso intentos=10+ garantiza
  // 100% (deja de depender del tablero) e intentos=9 es el techo real
  // que SÍ sigue dependiendo del barajado, y da ≈66.6% medido en
  // simulación, exactamente el ratio pedido. Se sube a 9 en
  // muy_facil/facil/normal (donde aplica el "2 de cada 3"; los tres
  // dan el mismo ≈66% porque 9 es un techo matemático, no hay un valor
  // intermedio entre 9 y 10 para diferenciarlos más entre sí sin salirse
  // de esos dos números) y se sube proporcionalmente dificil→7 (≈38%)
  // y muy_dificil→5 (≈18%) para conservar el mismo orden relativo de
  // dificultad que ya tenía la tabla, sin que ningún tier llegue a
  // 100% garantizado (eso eliminaría la suerte real del tablero, que es
  // justo lo que el comentario de arriba pide conservar). tiempoMs sube
  // a la par en los tiers con más intentos: con más clics necesarios
  // para llegar al mismo resultado, el jugador humano necesita más
  // margen real de reloj, o el límite de tiempo pasaría a ser el nuevo
  // cuello de botella oculto pese al cálculo de intentos.
  DIFFICULTY_TIERS: [
    { min: 10,  max: Infinity, key: 'muy_facil',   label: 'Muy fácil',    tiempoMs: 26000, intentos: 9, robMax: 0.30 },
    { min: 4,   max: 9,        key: 'facil',       label: 'Fácil',        tiempoMs: 24000, intentos: 9, robMax: 0.25 },
    { min: -3,  max: 3,        key: 'normal',      label: 'Normal',       tiempoMs: 22000, intentos: 9, robMax: 0.20 },
    { min: -9,  max: -4,       key: 'dificil',     label: 'Difícil',      tiempoMs: 17000, intentos: 7, robMax: 0.14 },
    { min: -Infinity, max: -10, key: 'muy_dificil', label: 'Casi imposible', tiempoMs: 14000, intentos: 5, robMax: 0.10 },
  ],

  // ───────────────────────────────────────────────────────────────────
  // MINIJUEGO DE PRECISIÓN (misil) — sustituye al tablero de 9 casillas
  // como mecánica de Ataque y de Defensa (mismo cálculo de puntuación
  // para ambos, ver computeAimScore() más abajo). Un único tap: se
  // puntúa 0-100 combinando qué tan cerca en el TIEMPO cayó el tap de
  // "0,00" y qué tan cerca en el ESPACIO cayó del centro exacto de la
  // pantalla. Todo configurable aquí para poder ajustar dificultad sin
  // tocar minigame.html/defense.html.
  // ───────────────────────────────────────────────────────────────────
  AIM: {
    // Cuenta atrás antes de que llegue el instante "0,00".
    COUNTDOWN_MS: 3000,

    // Ventana de tap: si el jugador no pulsa dentro de este margen
    // alrededor de "0,00" (antes o después), no se registra tap y el
    // intento vale 0 en timing (falló por completo, ver
    // computeAimScore()). Suficientemente generoso para que "no pulsar
    // a tiempo" sea un fallo claro, no un margen imperceptible.
    MAX_TIMING_MS: 600,

    // Timing: puntuación 100 en t=0ms, decae a 0 en MAX_TIMING_MS.
    // Curva configurable por separado del espacio para poder afinar
    // cada eje de dificultad de forma independiente.
    TIMING_PERFECT_MS: 0,

    // Espacio: puntuación 100 en el centro exacto (distancia 0), decae a
    // 0 al llegar a AIM_MAX_DISTANCE_RATIO * min(ancho,alto) del área de
    // juego. Se expresa como ratio (no px fijos) para que el mismo
    // ajuste sirva igual en cualquier tamaño de pantalla.
    MAX_DISTANCE_RATIO: 0.42,

    // Peso de cada factor en la puntuación final (deben sumar 1).
    WEIGHT_TIMING: 0.5,
    WEIGHT_SPACE: 0.5,

    // Exponente de la curva de caída (1 = lineal, >1 = perdona más cerca
    // del centro/instante y castiga más lejos, típico "ease-out").
    FALLOFF_POWER: 1.4,
  },

  // Nivel mínimo para poder entrar en el modo Invasión. Bloqueado en
  // nivel 1 y 2, se desbloquea exactamente al llegar a nivel 3 (ver
  // isInvasionUnlocked() y su uso en index.html/search.html).
  MIN_LEVEL_TO_UNLOCK: 3,
};

// Coste en $CLK de un escudo para un jugador de nivel `lvl`, redondeado
// hacia arriba (como misGoal/misReward del padre) para que nunca cueste
// menos de lo calculado.
function shieldCost(shieldType, lvl) {
  const c = CFG.SHIELD_COST[shieldType];
  if (!c) return 0;
  return Math.ceil(c.base * Math.pow(c.exp, Math.max(1, lvl) - 1));
}

function difficultyFor(attackerLvl, defenderLvl) {
  const diff = attackerLvl - defenderLvl;
  for (const tier of CFG.DIFFICULTY_TIERS) {
    if (diff >= tier.min && diff <= tier.max) return tier;
  }
  return CFG.DIFFICULTY_TIERS[2]; // 'normal' como fallback defensivo
}

// ─────────────────────────────────────────────────────────────────────
// ¿Puede este nivel entrar en Invasión? Nivel 1 y 2 bloqueados, se
// desbloquea en CFG.MIN_LEVEL_TO_UNLOCK (3). Centralizado aquí para que
// index.html (bloquea el botón de entrada) y search.html (por si se
// llega ahí saltándose el hub) usen exactamente el mismo criterio.
// ─────────────────────────────────────────────────────────────────────
function isInvasionUnlocked(lvl) {
  return (lvl || 1) >= CFG.MIN_LEVEL_TO_UNLOCK;
}

// ─────────────────────────────────────────────────────────────────────
// PUNTUACIÓN DEL MINIJUEGO DE PRECISIÓN (misil) — 0 a 100, combina
// timing (distancia en ms al instante "0,00") y espacio (distancia en
// px al centro exacto del área de juego). Misma función para Ataque y
// Defensa: ambos minijuegos son mecánicamente equivalentes (timing +
// precisión), solo cambia el vídeo/tema visual que los envuelve — ver
// sección 4 de la spec ("la mecánica vuelve a ser equivalente").
//
// Determinista y pura (sin Firestore, sin random) para poder testear y
// para que createPendingAttack()/resolveDuel() puedan recalcular con los
// mismos números si hiciera falta depurar un resultado.
//
// - timingMs: diferencia real en ms entre el tap y el instante "0,00"
//   (puede ser negativo si tapeó antes; se usa el valor absoluto).
//   Pasar null/undefined si el jugador NO llegó a tapear a tiempo
//   (ventana agotada) → puntuación de timing 0.
// - distancePx: distancia en px entre el tap y el centro exacto del
//   área de juego. Pasar null/undefined junto con timingMs null.
// - maxDistancePx: distancia que vale 0 puntos en el eje espacial —
//   normalmente min(anchoAreaJuego,altoAreaJuego) * MAX_DISTANCE_RATIO,
//   lo calcula la pantalla (conoce su propio layout) y se lo pasa aquí
//   ya resuelto en px para no acoplar esta función a medidas de DOM.
// ─────────────────────────────────────────────────────────────────────
function computeAimScore(timingMs, distancePx, maxDistancePx) {
  const A = CFG.AIM;
  const pow = A.FALLOFF_POWER;

  let timingScore = 0;
  if (timingMs !== null && timingMs !== undefined && isFinite(timingMs)) {
    const t = Math.min(Math.abs(timingMs), A.MAX_TIMING_MS);
    const ratio = A.MAX_TIMING_MS > 0 ? 1 - (t / A.MAX_TIMING_MS) : 0;
    timingScore = Math.max(0, Math.pow(Math.max(0, ratio), pow)) * 100;
  }

  let spaceScore = 0;
  if (distancePx !== null && distancePx !== undefined && isFinite(distancePx) && maxDistancePx > 0) {
    const d = Math.min(Math.max(0, distancePx), maxDistancePx);
    const ratio = 1 - (d / maxDistancePx);
    spaceScore = Math.max(0, Math.pow(Math.max(0, ratio), pow)) * 100;
  }

  const final = timingScore * A.WEIGHT_TIMING + spaceScore * A.WEIGHT_SPACE;
  return {
    score: Math.round(Math.max(0, Math.min(100, final))),
    timingScore: Math.round(timingScore),
    spaceScore: Math.round(spaceScore),
  };
}

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ─────────────────────────────────────────────────────────────────────
// ESTADO DE AUTH — expuesto igual que en invasion.html del padre, para
// que cada pantalla pueda esperar a `window.__fbUser` antes de operar.
//
// authReady se resuelve DESPUÉS de auth.authStateReady(), no solo tras
// el primer onAuthStateChanged. Son cosas distintas: onAuthStateChanged
// puede disparar con un `user` ya no-nulo (sesión recuperada desde
// almacenamiento persistente) antes de que el SDK tenga el ID token listo
// para adjuntarlo a peticiones de Firestore — hay una ventana de carrera
// real y documentada (ver firebase-js-sdk issue #8302: "Missing
// Authorization header when requesting firestore inside
// beforeAuthStateChanged/onAuthStateChanged" sin este await). Sin este
// await, la primera llamada a Firestore tras entrar con sesión ya
// iniciada puede llegar SIN el token adjunto y ser rechazada con
// 'Missing or insufficient permissions' aunque las Rules sean correctas
// y el usuario sí esté autenticado — exactamente el síntoma que causaba
// que el modo se quedara colgado en el loader con sesión activa.
// ─────────────────────────────────────────────────────────────────────
let _authReadyResolve;
const authReady = new Promise((res) => { _authReadyResolve = res; });
onAuthStateChanged(auth, async (user) => {
  window.__fbUser = user || null;
  if (user) {
    // Espera a que el SDK confirme que el estado de auth (incluido el
    // token) está completamente asentado antes de dar luz verde.
    await auth.authStateReady();
  }
  _authReadyResolve(user || null);
});

// ─────────────────────────────────────────────────────────────────────
// Misma clave/formato de localStorage que index.html y ruleta.html (ver
// SAVE_KEY_PREFIX y sanitize() ahí): permite leer aquí el saldo que el
// jugador acaba de guardar en el padre antes de que llegue a Firestore.
// ─────────────────────────────────────────────────────────────────────
const SAVE_KEY = 'cck4';
const SAVE_KEY_PREFIX = 'cck4_user_';
function saveKeyForUid(uid) { return uid ? SAVE_KEY_PREFIX + uid : SAVE_KEY; }

// ─────────────────────────────────────────────────────────────────────
// SINCRONIZAR PERFIL DE INVASIÓN desde saves/{uid} (el saldo/nivel real
// del juego padre). Se llama al entrar al modo y tras resolver un
// combate. Escribe invasion_players/{uid} E invasion_targets/{uid} en un
// mismo batch (deben ir siempre a la par, o alguien podría quedar
// "invisible como objetivo" con clk desactualizado).
//
// clk NO se toma ciegamente de saves/ cada vez: eso pisaría cualquier
// robo ganado o sufrido que invasion_players ya registró pero que
// saves/ (el guardado real del juego padre, ver limitación en
// resolveInvasion() más abajo) todavía no sabe. Se compara el
// updatedAt de ambos documentos — si invasion_players es MÁS RECIENTE
// que saves/, gana el clk de invasion_players (hubo un robo después
// del último guardado del padre); si no, gana saves/ (sincronización
// normal tras jugar el juego principal). Sin esta comparación, un
// jugador que gana un robo y vuelve al hub vería su saldo antiguo,
// como si el robo no hubiera pasado.
//
// TAMPOCO se toma ciegamente de saves/ frente a localStorage: saves/
// se sube desde el padre como mucho cada 20s (CLOUD_MIN_INTERVAL en
// index.html), así que si el jugador tapeó ahí y entra a Invasión antes
// de esos 20s, saves/ todavía tiene un clk viejo aunque localStorage ya
// tenga el correcto. Por eso mainClk también se compara contra el
// lastSave del localStorage local: si éste es más reciente que
// saves/.updatedAt, manda localStorage.
// ─────────────────────────────────────────────────────────────────────
async function syncProfileFromMainSave(uid) {
  let mainSnap;
  try {
    mainSnap = await getDoc(doc(db, 'saves', uid));
  } catch (e) {
    console.error('[DIAG] Falló leyendo saves/' + uid + ':', e.code || e.message);
    throw e;
  }
  let alias = '', lvl = 1, mainClk = 0, mainUpdatedMs = 0;
  if (mainSnap.exists()) {
    try {
      const parsed = JSON.parse(mainSnap.data().data);
      alias = typeof parsed.alias === 'string' ? parsed.alias.slice(0, 16) : '';
      lvl = typeof parsed.lvl === 'number' && parsed.lvl >= 1 ? Math.floor(parsed.lvl) : 1;
      mainClk = typeof parsed.clk === 'number' && parsed.clk >= 0 ? Math.floor(parsed.clk) : 0;
    } catch (e) { /* save corrupto o inexistente: nos quedamos con defaults */ }
    const mainUpdatedAt = mainSnap.data().updatedAt;
    mainUpdatedMs = mainUpdatedAt && mainUpdatedAt.toMillis ? mainUpdatedAt.toMillis() : 0;
  }
  // Si localStorage tiene un guardado MÁS RECIENTE que saves/ (el padre
  // tapeó y aún no pasaron los 20s de CLOUD_MIN_INTERVAL), ese clk local
  // manda sobre el de Firestore que acabamos de leer arriba.
  try {
    const localRaw = localStorage.getItem(saveKeyForUid(uid));
    const localData = localRaw ? JSON.parse(localRaw) : null;
    const localSavedMs = (localData && localData.lastSave) || 0;
    if (localData && localSavedMs > mainUpdatedMs) {
      if (typeof localData.clk === 'number' && localData.clk >= 0) mainClk = Math.floor(localData.clk);
      if (typeof localData.lvl === 'number' && localData.lvl >= 1) lvl = Math.floor(localData.lvl);
      mainUpdatedMs = localSavedMs;
    }
  } catch (e) { /* localStorage no disponible (modo privado, etc.): seguimos solo con saves/ */ }

  const playerRef = doc(db, 'invasion_players', uid);
  let existing;
  try {
    existing = await getDoc(playerRef);
  } catch (e) {
    console.error('[DIAG] Falló leyendo invasion_players/' + uid + ':', e.code || e.message);
    throw e;
  }
  const now = Date.now();
  const prev = existing.exists() ? existing.data() : null;
  const prevUpdatedMs = prev && prev.updatedAt && prev.updatedAt.toMillis ? prev.updatedAt.toMillis() : 0;

  // Si invasion_players tiene un movimiento MÁS RECIENTE que el último
  // guardado del padre, ese movimiento (robo ganado o sufrido) es la
  // fuente de verdad actual del saldo — el padre simplemente no se ha
  // enterado todavía.
  const clk = (prev && prevUpdatedMs > mainUpdatedMs) ? (prev.clk || 0) : mainClk;

  const playerData = {
    alias: alias || (prev && prev.alias) || 'Jugador',
    lvl, clk,
    shieldUntil: prev ? (prev.shieldUntil || 0) : 0,
    shieldType: prev ? (prev.shieldType || '') : '',
    accountCreatedAt: prev ? prev.accountCreatedAt : now, // se fija UNA vez
    lastAttackedAt: prev ? (prev.lastAttackedAt || 0) : 0,
    lastInvasionAt: prev ? (prev.lastInvasionAt || 0) : 0,
    invasionsToday: prev ? (prev.invasionsToday || 0) : 0,
    invasionsDayKey: prev ? (prev.invasionsDayKey || todayKeyUTC()) : todayKeyUTC(),
    recentTargets: prev ? (prev.recentTargets || {}) : {},
    updatedAt: serverTimestamp(),
  };

  const targetData = {
    alias: playerData.alias, lvl: playerData.lvl, clk: playerData.clk,
    shieldUntil: playerData.shieldUntil,
    accountCreatedAt: playerData.accountCreatedAt,
    rand: Math.random(),
  };

  console.log('[DIAG] Intentando escribir invasion_players con:', JSON.stringify(playerData));
  console.log('[DIAG] Intentando escribir invasion_targets con:', JSON.stringify(targetData));

  const batch = writeBatch(db);
  batch.set(playerRef, playerData, { merge: true });
  batch.set(doc(db, 'invasion_targets', uid), targetData, { merge: true });
  try {
    await batch.commit();
  } catch (e) {
    console.error('[DIAG] Falló el batch.commit() de invasion_players+invasion_targets:', e.code || e.message);
    console.error('[DIAG] prev (documento previo de invasion_players, null si no existía):', JSON.stringify(prev));
    console.error('[DIAG] existing.exists():', existing.exists());
    throw e;
  }

  return { ...playerData, updatedAt: now };
}

// ─────────────────────────────────────────────────────────────────────
// BUSCAR RIVAL DENTRO DE UN NIVEL EXACTO — misma técnica de `rand` que
// antes (ver docs/DISEÑO.md sección invasion_targets: Firestore no tiene
// ORDER BY random() nativo), pero ahora acotada a where('lvl','==',lvl)
// además de where('rand',...). Es el bloque reutilizable que
// findTargetByLevel() llama una vez por cada nivel de la escalera de
// prioridad (mismo nivel → nivel-1 → nivel-2 → …).
//
// Nota de índices: where('lvl','==',lvl) + where('rand','>=',r) +
// orderBy('rand') es un índice compuesto de 2 campos (lvl+rand), más
// simple que uno de 3, y Firestore lo pide solo automáticamente la
// primera vez que la query se ejecuta en producción si no existe ya
// (ver invasion.indexes.json, se documenta ahí también).
// ─────────────────────────────────────────────────────────────────────
async function findCandidatesAtLevel(lvl, r) {
  const targetsCol = collection(db, 'invasion_targets');
  async function tryDirection(op, order) {
    const q = query(
      targetsCol,
      where('lvl', '==', lvl),
      where('rand', op, r),
      orderBy('rand', order),
      limit(30)
    );
    const snap = await getDocs(q);
    return snap.docs;
  }
  // '>=' ascendente primero (más cercanos a r por arriba), '<=' descendente
  // como fallback (más cercanos a r por abajo) — mismo razonamiento que
  // tenía la búsqueda puramente aleatoria original.
  let docs = await tryDirection('>=', 'asc');
  if (docs.length === 0) docs = await tryDirection('<=', 'desc');
  return docs;
}

// Filtra en cliente los candidatos leídos de un nivel: cuenta propia,
// saldo mínimo robable, escudo activo, cuenta nueva, cooldown de mismo
// objetivo, ataque pendiente sin resolver. Devuelve el primer candidato
// válido o null. Se separa de findCandidatesAtLevel() para que
// findTargetByLevel() pueda reusar este mismo criterio de filtrado en
// cada peldaño de la escalera de niveles sin repetir el cuerpo del bucle.
//
// BUGFIX: mientras un jugador tiene un ataque en status:'pending' contra
// él, no debe poder aparecer como objetivo en la búsqueda — esa regla ya
// se aplicaba como comprobación final en createPendingAttack() y en el
// botón "Atacar" de search.html, pero faltaba aquí, en el propio filtro
// de candidatos: un jugador con defensa pendiente SÍ podía llegar a
// mostrarse en la pantalla de "rival encontrado" y solo se rechazaba al
// pulsar "Atacar" al final.
//
// Se usa hasActivePendingDefense() en vez de hasPendingDefense() a
// propósito: esta última solo mira status:'pending', sin fecha, así que
// un candidato cuyo único pendiente ya superó las 24h de
// CFG.PENDING_ATTACK_WINDOW_MS (y por tanto, en la práctica, ya perdió
// por incomparecencia) seguiría invisible en la búsqueda hasta que ÉL
// MISMO volviera a abrir el juego. hasActivePendingDefense() no solo
// ignora esos vencidos: los resuelve de verdad (mismo reparto de saldo
// que si el propio defensor hubiera dejado pasar las 24h desde su
// pantalla), así que "ya no bloquea" aquí es una verdad definitiva, no
// una decisión de visualización que createPendingAttack() fuera a
// contradecir más abajo en el mismo flujo de ataque.
//
// Se comprueba async (await) por candidato, igual que el resto de la
// función es awaited desde findTargetByLevel() — el bucle ya corta en el
// primer candidato válido, así que en el caso normal esto añade como
// mucho una lectura extra por candidato descartado, no una por cada uno
// de los hasta 30 candidatos leídos.
async function firstValidCandidate(docs, myUid, myRecentTargets, now, skipped) {
  for (const docSnap of docs) {
    const uid = docSnap.id;
    const d = docSnap.data();
    if (uid === myUid) { skipped.self++; continue; }
    if ((d.clk || 0) < CFG.MIN_CLK_TO_BE_TARGET) { skipped.lowClk++; continue; }
    if ((d.shieldUntil || 0) > now) { skipped.shielded++; continue; }
    if (now - (d.accountCreatedAt || 0) < CFG.NEW_ACCOUNT_PROTECTION_MS) { skipped.newAccount++; continue; }
    const lastHit = (myRecentTargets || {})[uid] || 0;
    if (now - lastHit < CFG.SAME_TARGET_COOLDOWN_MS) { skipped.cooldown++; continue; }
    if (await hasActivePendingDefense(uid)) { skipped.pendingDefense++; continue; }
    return { uid, ...d };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// BUSCAR RIVAL POR NIVEL (sustituye a la búsqueda puramente aleatoria) —
// spec punto 10: la prioridad de objetivos se basa en el nivel del
// atacante. Un atacante de nivel N prueba primero objetivos de nivel N
// exactamente; si no encuentra ninguno válido, prueba N-1, luego N-2, y
// así sucesivamente hasta nivel 1. Dentro de cada nivel, el candidato en
// concreto se sigue eligiendo al azar (técnica `rand`, ver
// findCandidatesAtLevel()) para no repetir siempre el mismo rival a
// igualdad de nivel.
//
// Un atacante de nivel 3 prueba 3→2→1 (spec sección 11: nivel 3 es el
// mínimo desbloqueado, así que nunca hace falta bajar de nivel 1). Un
// atacante de nivel 17 prueba 17→16→…→1 en el peor caso — cada peldaño
// vacío es una lectura de hasta 30 docs, así que en la práctica esto se
// detiene en cuanto encuentra el primer nivel con población real, no
// recorre los 17 siempre.
// ─────────────────────────────────────────────────────────────────────
// Diagnóstico de la última búsqueda sin resultado — se rellena SOLO
// cuando findTargetByLevel() devuelve null, y se limpia (a null) al
// empezar cada búsqueda nueva, para que un valor viejo no sobreviva
// entre dos llamadas y confunda a quien lo consulte después de una
// búsqueda que SÍ encontró rival. search.html lo lee justo después de
// llamar a findTargetByLevel() para construir un mensaje legible de
// "por qué no hay rival" en vez de mandar al jugador a la consola (F12)
// — antes este detalle solo se veía en console.log, nunca en pantalla.
let _lastSearchDiagnostic = null;

async function findTargetByLevel(myUid, myLvl, myRecentTargets) {
  _lastSearchDiagnostic = null;
  const now = Date.now();
  const r = Math.random();
  const startLvl = Math.max(1, Math.floor(myLvl || 1));
  const skipped = { self: 0, lowClk: 0, shielded: 0, newAccount: 0, cooldown: 0, pendingDefense: 0 };
  let levelsChecked = 0;
  let totalCandidatesSeen = 0;

  for (let lvl = startLvl; lvl >= 1; lvl--) {
    levelsChecked++;
    const docs = await findCandidatesAtLevel(lvl, r);
    totalCandidatesSeen += docs.length;
    const found = await firstValidCandidate(docs, myUid, myRecentTargets, now, skipped);
    if (found) return found;
  }

  // totalCandidatesSeen === 0 es el caso que reporta el jugador con más
  // frecuencia como confuso ("no dice por qué no hay nadie"): no es que
  // todos los candidatos se descartaran por escudo/cooldown/saldo, es
  // que directamente no hay NINGÚN documento en invasion_targets con
  // lvl <= myLvl — es decir, ningún otro jugador de nivel igual o menor
  // ha entrado nunca al modo Invasión (o los que hay están todos en
  // niveles superiores al del atacante, fuera del rango que se prueba
  // aquí a propósito, ver comentario de findTargetByLevel más arriba).
  _lastSearchDiagnostic = {
    levelsChecked, startLvl, totalCandidatesSeen, skipped,
    noPopulationAtAll: totalCandidatesSeen === 0,
  };
  console.log('[DIAG] findTargetByLevel: sin candidato válido. Niveles probados:', levelsChecked, '(desde', startLvl, 'hasta 1). Candidatos vistos en total:', totalCandidatesSeen, '. Descartados por:', JSON.stringify(skipped));
  return null; // no se encontró rival válido en ningún nivel de 1 a myLvl
}

// Traduce el diagnóstico de la última búsqueda sin resultado a un texto
// legible para mostrar directamente en la pantalla de search.html, sin
// que el jugador necesite abrir la consola (F12) para saber el motivo.
// Devuelve un mensaje genérico si se llama sin que haya diagnóstico
// disponible (p.ej. tras una búsqueda que sí encontró rival).
function explainNoTargetFound() {
  const d = _lastSearchDiagnostic;
  if (!d) return 'No hay rivales disponibles en este momento.';

  if (d.noPopulationAtAll) {
    return d.startLvl <= 1
      ? 'Todavía no hay ningún otro jugador registrado en el modo Invasión. Vuelve a intentarlo cuando más gente haya entrado.'
      : `No hay ningún jugador de nivel ${d.startLvl} o inferior registrado en el modo Invasión todavía. Vuelve a intentarlo más tarde, cuando haya más gente de tu nivel o menor.`;
  }

  // Caso frecuente al probar en desarrollo con una sola cuenta: el único
  // documento visto en invasion_targets es el propio jugador (nadie más
  // ha entrado nunca al modo con nivel <= el suyo). Merece un mensaje
  // propio en vez de mezclarse con la lista de motivos de abajo, porque
  // la solución (entrar con otra cuenta) es distinta a esperar/reintentar.
  if (d.totalCandidatesSeen === d.skipped.self && d.skipped.self > 0) {
    return 'El único jugador encontrado en tu rango de nivel eres tú mismo — necesitas que otra cuenta entre al modo Invasión (nivel 3 o más) para poder atacarla. Prueba con otra cuenta o espera a que otro jugador entre.';
  }

  const s = d.skipped;
  const motivos = [];
  if (s.shielded > 0) motivos.push(`${s.shielded} con escudo activo`);
  if (s.lowClk > 0) motivos.push(`${s.lowClk} sin $CLK suficiente para robar`);
  if (s.cooldown > 0) motivos.push(`${s.cooldown} ya invadidos por ti hace menos de 4h`);
  if (s.newAccount > 0) motivos.push(`${s.newAccount} con cuenta demasiado nueva`);
  if (s.pendingDefense > 0) motivos.push(`${s.pendingDefense} ya tienen otro ataque pendiente de resolver`);
  if (s.self > 0) motivos.push(`${s.self} eras tú mismo`);

  if (motivos.length === 0) {
    // Se vieron candidatos (totalCandidatesSeen > 0) pero ninguno cayó
    // en ninguna de las categorías de descarte contadas arriba — caso
    // residual poco probable, mensaje genérico en vez de una lista vacía.
    return `Se encontraron ${d.totalCandidatesSeen} jugador(es) de nivel ${d.startLvl} o inferior, pero ninguno es un objetivo válido ahora mismo. Vuelve a intentarlo en unos minutos.`;
  }

  return `Se encontraron ${d.totalCandidatesSeen} jugador(es) de nivel ${d.startLvl} o inferior, pero ninguno es un objetivo válido ahora mismo: ${motivos.join(', ')}.`;
}

// Alias retrocompatible: código o pantallas que todavía llamen a la
// búsqueda "aleatoria" original obtienen la búsqueda por nivel, que es
// su sustituta directa (misma firma salvo el nuevo parámetro myLvl).
async function findRandomTarget(myUid, myLvl, myRecentTargets) {
  return findTargetByLevel(myUid, myLvl, myRecentTargets);
}

// ─────────────────────────────────────────────────────────────────────
// VALIDAR SI PUEDO LANZAR UNA INVASIÓN AHORA (cooldown, límite diario).
// Se llama ANTES de buscar rival y ANTES de resolver, para no dejar que
// el jugador entre al minijuego y luego se le rechace la escritura.
// ─────────────────────────────────────────────────────────────────────
function checkCanInvade(playerDoc) {
  const now = Date.now();
  if (now - (playerDoc.accountCreatedAt || 0) < CFG.NEW_ACCOUNT_PROTECTION_MS) {
    const leftMs = CFG.NEW_ACCOUNT_PROTECTION_MS - (now - playerDoc.accountCreatedAt);
    return { ok: false, reason: 'cuenta_nueva', msLeft: leftMs };
  }
  if (now - (playerDoc.lastInvasionAt || 0) < CFG.INVASION_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', msLeft: CFG.INVASION_COOLDOWN_MS - (now - playerDoc.lastInvasionAt) };
  }
  const dayKey = todayKeyUTC();
  const usedToday = playerDoc.invasionsDayKey === dayKey ? (playerDoc.invasionsToday || 0) : 0;
  if (usedToday >= CFG.MAX_INVASIONS_PER_DAY) {
    return { ok: false, reason: 'limite_diario', msLeft: 0 };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// FASE 1 — LANZAMIENTO DEL MISIL (ataque): sustituye a la antigua
// resolveInvasion() de una sola fase. Ahora el resultado NO se decide
// aquí — solo se registra la puntuación del atacante (attackScore,
// calculada por minigame.html con computeAimScore()) y el ataque queda
// en estado 'pending' hasta que el defensor juegue su propio minijuego
// (ver resolveDuel() más abajo). Aun así, esta función SÍ aplica de
// inmediato el cooldown/contador diario del atacante — igual que antes,
// lanzar el misil consume el cupo de invasión aunque el duelo tarde en
// resolverse; no tendría sentido dejar lanzar misiles gratis mientras el
// defensor no conecta.
//
// Recalcula la dificultad del lado "servidor" (este módulo, ver
// docs/DISEÑO.md sección 0) a partir de los niveles reales leídos ahora
// mismo, no de los que traiga la pantalla — mismo criterio que ya tenía
// resolveInvasion().
// ─────────────────────────────────────────────────────────────────────
// ℹ️ SINCRONIZACIÓN CON EL SALDO DEL JUEGO PADRE (antes documentada aquí
// como "limitación conocida sin resolver" — ya no lo es, se deja este
// comentario para que quien lea el código encuentre la respuesta en vez
// de la pregunta abierta):
// invasion_players/{uid}.clk parte de saves/{uid}.clk como fuente inicial,
// pero syncProfileFromMainSave() compara updatedAt entre ambos documentos
// y NO deja que un saves/ desactualizado pise un robo más reciente (ver
// esa función) — así que dentro del modo Invasión el saldo mostrado SÍ
// refleja robos ganados/sufridos de inmediato, sin importar cuántas veces
// se resincronice.
//
// El camino INVERSO (que ese cambio de saldo SÍ se refleje de vuelta en
// saves/{uid}, para que el juego principal no "olvide" un robo ganado o
// sufrido en Invasión) vive en el juego padre, no aquí: ver
// syncShieldState() en index.html (raíz del proyecto). Esa función,
// llamada una vez al arrancar cada sesión del padre, relee
// invasion_players/{uid}.clk vía syncProfileFromMainSave() y, si difiere
// de S.clk (el estado en memoria del padre), ajusta S.clk en el sentido
// que corresponda (addClk() si ganó, resta directa si perdió) y fuerza un
// guardado inmediato — así el $CLK movido en Invasión (por un duelo
// jugado, por expirePendingAttack(), o por cualquier otro movimiento de
// invasion_players.clk) pasa a ser el mismo saldo que ve y guarda el
// juego principal, sin una segunda fuente de verdad divergente. Nota: la
// reconciliación ocurre al ABRIR/RECARGAR el padre, no en tiempo real
// mientras ya está abierto — si el jugador tiene el juego principal
// abierto en el momento exacto en que gana o pierde un robo desde otra
// pestaña/dispositivo, verá el ajuste reflejado en su próxima recarga,
// no al instante.
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// ¿TIENE ESTE JUGADOR UN ATAQUE PENDIENTE SIN RESOLVER? — a petición
// expresa: mientras un defensor tenga un ataque en status:'pending'
// contra él, no puede recibir otro (createPendingAttack() lo usa como
// barrera) ni aparecer como objetivo en la búsqueda (search.html lo usa
// para filtrar). El ATACANTE sí puede seguir lanzando misiles contra
// otros aunque él mismo tenga un ataque pendiente sin resolver contra sí
// mismo — esta función solo se consulta sobre el lado DEFENSOR, nunca
// sobre el atacante, a propósito.
//
// Nota: esto sustituye la decisión de diseño anterior documentada en
// DISENO.md sección 4 ("Ataques pendientes simultáneos" — permitía
// varios atacantes a la vez contra el mismo defensor). Cambio de regla
// de negocio confirmado expresamente, no un descuido.
// ─────────────────────────────────────────────────────────────────────
async function hasPendingDefense(uid) {
  const q = query(
    collection(db, 'invasion_attacks'),
    where('defenderUid', '==', uid),
    where('status', '==', 'pending'),
    limit(1)
  );
  const snap = await getDocs(q);
  return !snap.empty;
}

// ─────────────────────────────────────────────────────────────────────
// ¿TIENE ESTE JUGADOR UNA DEFENSA PENDIENTE QUE TODAVÍA BLOQUEA? — misma
// pregunta que hasPendingDefense(), pero además resuelve por expiración
// (no solo ignora) cualquier pendiente que ya superó
// CFG.PENDING_ATTACK_WINDOW_MS (24h), en vez de dejarlo tal cual hasta
// que su propio dueño vuelva a conectarse.
//
// BUGFIX: firstValidCandidate() (más abajo) usaba hasPendingDefense()
// para no mostrar en la búsqueda a nadie con una defensa sin resolver —
// pero esa función solo mira status:'pending', sin fecha, así que un
// jugador cuyo único pendiente ya superó las 24h (y por tanto, en la
// práctica, ya perdió por incomparecencia) se quedaba invisible en
// búsquedas indefinidamente hasta que ÉL MISMO volviera a abrir el
// juego — nadie más disparaba nunca su expiración, porque
// getPendingAttacksFor() (la única función que la dispara) siempre se
// llamaba con el uid del propio jugador conectado.
//
// firestore.rules ya permite ahora que CUALQUIER usuario autenticado
// ejecute la transición de expiración de un ataque ajeno (ver
// isValidExpiryResolution() ahí — esa transición no depende de ningún
// dato que aporte quien la ejecuta, así que un tercero produce
// exactamente el mismo resultado que el propio defensor), así que aquí
// se reutiliza getPendingAttacksFor(uid) tal cual — la misma función que
// ya usa el hub para el propio jugador — para, de paso, dejar
// REALMENTE resueltos (con su reparto de saldo correspondiente) los
// pendientes vencidos de un candidato ajeno, no solo tratarlos como
// libres de cara a esta comprobación puntual. Así, cuando createPendingAttack()
// vuelva a comprobar hasPendingDefense() más abajo en el mismo flujo de
// ataque, ya no encontrará el vencido — se resolvió de verdad, no solo
// se ignoró aquí.
// ─────────────────────────────────────────────────────────────────────
async function hasActivePendingDefense(uid) {
  const stillPending = await getPendingAttacksFor(uid);
  return stillPending.length > 0;
}

async function createPendingAttack({ attackerUid, defenderUid, attackScore, isRevenge }) {
  const [attackerSnap, defenderSnap] = await Promise.all([
    getDoc(doc(db, 'invasion_players', attackerUid)),
    getDoc(doc(db, 'invasion_players', defenderUid)),
  ]);
  if (!attackerSnap.exists() || !defenderSnap.exists()) {
    throw new Error('Perfil de invasión no encontrado');
  }
  const attacker = attackerSnap.data();
  const defender = defenderSnap.data();
  const now = Date.now();

  if (!isInvasionUnlocked(attacker.lvl)) throw new Error('Invasión bloqueada hasta nivel ' + CFG.MIN_LEVEL_TO_UNLOCK);
  const invadeCheck = checkCanInvade(attacker);
  if (!invadeCheck.ok) throw new Error('No se puede invadir ahora mismo: ' + invadeCheck.reason);
  if ((defender.shieldUntil || 0) > now) throw new Error('El objetivo activó un escudo justo ahora');
  if (await hasPendingDefense(defenderUid)) throw new Error('El objetivo ya tiene un ataque pendiente sin resolver');

  // isRevenge llega del cliente sin que nada lo haya verificado de forma
  // obligatoria hasta aquí (mismo razonamiento que tenía la resolución
  // de una sola fase: search.html ya revalida como comodidad de UI, pero
  // esta es la única parada por la que pasa TODO ataque sea cual sea su
  // origen). Si no es legítimo se degrada a false en vez de rechazar el
  // ataque completo.
  const revengeIsLegit = !!isRevenge && await isLegitimateRevenge(attackerUid, defenderUid);

  const tier = difficultyFor(attacker.lvl, defender.lvl);
  const score = Math.max(0, Math.min(100, Math.round(attackScore)));

  const dayKey = todayKeyUTC();
  const newInvasionsToday = attacker.invasionsDayKey === dayKey ? (attacker.invasionsToday || 0) + 1 : 1;
  const newRecentTargets = { ...(attacker.recentTargets || {}), [defenderUid]: now };

  const batch = writeBatch(db);
  batch.update(doc(db, 'invasion_players', attackerUid), {
    lastInvasionAt: now,
    invasionsToday: newInvasionsToday,
    invasionsDayKey: dayKey,
    recentTargets: newRecentTargets,
    updatedAt: serverTimestamp(),
  });

  const attackId = `${attackerUid}_${now}`;
  batch.set(doc(db, 'invasion_attacks', attackId), {
    attackerUid, attackerAlias: attacker.alias || 'Jugador',
    defenderUid, defenderAlias: defender.alias || 'Jugador',
    attackerLvl: attacker.lvl || 1, defenderLvl: defender.lvl || 1,
    difficulty: tier.key,
    attackScore: score,
    defenseScore: null,
    status: 'pending',
    won: false, stolenAmount: 0, // se rellenan de verdad al resolver (resolveDuel); placeholders válidos para las Rules mientras está pendiente
    isRevenge: revengeIsLegit,
    createdAt: serverTimestamp(),
  });

  await batch.commit();
  return { attackId, attackScore: score, difficulty: tier };
}

// ─────────────────────────────────────────────────────────────────────
// FASE 2 — INTERCEPCIÓN (defensa) Y RESOLUCIÓN DEL DUELO: se llama tras
// el minijuego de defensa, con defenseScore (0-100, calculado por
// defense.html con la misma computeAimScore() que el ataque). Compara
// attackScore contra defenseScore (spec sección 5: el defensor gana
// cuando su puntuación es MAYOR; empate favorece al defensor) y, a
// partir de ahí, reutiliza EXACTAMENTE la misma lógica de robo que ya
// existía en la resolución de una sola fase — no se crea una segunda
// fórmula de recompensas, solo se mueve el punto en el tiempo en el que
// se conoce el resultado.
//
// Vuelve a leer invasion_attacks/{attackId} (no se fía del attackScore
// que pudiera traer la pantalla de defensa) y vuelve a leer ambos
// perfiles/el escudo del defensor en tiempo real, mismo criterio
// anti-trampa "difícil de explotar, no imposible" documentado en
// docs/DISEÑO.md sección 0.
// ─────────────────────────────────────────────────────────────────────
async function resolveDuel({ attackId, defenderUid, defenseScore }) {
  const attackRef = doc(db, 'invasion_attacks', attackId);
  const attackSnap = await getDoc(attackRef);
  if (!attackSnap.exists()) throw new Error('Ataque no encontrado');
  const attack = attackSnap.data();

  if (attack.status !== 'pending') throw new Error('Este ataque ya fue resuelto');
  if (attack.defenderUid !== defenderUid) throw new Error('Este ataque no es tuyo para defender');

  const [attackerSnap, defenderSnap] = await Promise.all([
    getDoc(doc(db, 'invasion_players', attack.attackerUid)),
    getDoc(doc(db, 'invasion_players', defenderUid)),
  ]);
  if (!attackerSnap.exists() || !defenderSnap.exists()) {
    throw new Error('Perfil de invasión no encontrado');
  }
  const attacker = attackerSnap.data();
  const defender = defenderSnap.data();
  const now = Date.now();

  const dScore = Math.max(0, Math.min(100, Math.round(defenseScore)));
  const aScore = attack.attackScore || 0;

  // Spec sección 5: el defensor gana cuando SU puntuación es superior a
  // la del atacante; en caso de empate se favorece al defensor (won se
  // refiere aquí, igual que en el esquema original, a "ganó el
  // ATACANTE" — así que empate → won=false, MISIL INTERCEPTADO).
  const won = aScore > dScore;

  const tier = difficultyFor(attacker.lvl || attack.attackerLvl || 1, defender.lvl || attack.defenderLvl || 1);
  let stolenAmount = 0;
  if (won) {
    const rawMax = Math.floor((defender.clk || 0) * tier.robMax);
    const capByFloor = Math.max(0, (defender.clk || 0) - CFG.MIN_CLK_LEFT_AFTER_ROB);
    stolenAmount = Math.max(0, Math.min(rawMax, capByFloor));
  }

  const batch = writeBatch(db);

  if (stolenAmount > 0) {
    const newAttackerClk = (attacker.clk || 0) + stolenAmount;
    const newDefenderClk = Math.max(0, (defender.clk || 0) - stolenAmount);
    batch.update(doc(db, 'invasion_players', attack.attackerUid), {
      clk: newAttackerClk, updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'invasion_players', defenderUid), {
      clk: newDefenderClk, lastAttackedAt: now, updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'invasion_targets', attack.attackerUid), { clk: newAttackerClk }, { merge: true });
    batch.set(doc(db, 'invasion_targets', defenderUid), { clk: newDefenderClk }, { merge: true });
  }

  batch.update(attackRef, {
    defenseScore: dScore,
    status: 'resolved',
    won: !!won,
    stolenAmount,
    resolvedAt: serverTimestamp(),
  });

  await batch.commit();
  return { won: !!won, stolenAmount, difficulty: tier, attackScore: aScore, defenseScore: dScore, attackId };
}

// ─────────────────────────────────────────────────────────────────────
// EXPIRACIÓN POR INCOMPARECENCIA — a petición expresa: si el defensor no
// responde dentro de CFG.PENDING_ATTACK_WINDOW_MS (24h), el duelo se
// resuelve SOLO, como una victoria más del atacante, con el MISMO
// cálculo de botín que resolveDuel() (mismo tier de dificultad según
// niveles, mismo robMax, mismo colchón MIN_CLK_LEFT_AFTER_ROB) — no es
// una fórmula distinta ni un botín simbólico, es exactamente lo que se
// habría robado si el defensor hubiera jugado y perdido. defenseScore
// se guarda como 0 (el defensor nunca llegó a tapear, a diferencia de un
// 0 real por fallar el timing/espacio) para que el historial pueda, si
// hace falta más adelante, distinguir "perdió jugando" de "no respondió"
// sin añadir un campo nuevo al esquema — status pasa a 'resolved' igual
// que una resolución jugada, así que ninguna pantalla que ya filtre por
// status necesita cambios para entender este caso.
//
// Sin backend (ver cabecera del archivo: proyecto 100% estático, sin
// Cloud Functions), esto NO corre solo con el reloj parado — se dispara
// desde el cliente, la primera vez que alguien (atacante, defensor, o
// cualquier otro jugador cuya pantalla llame a getPendingAttacksFor())
// entra a una pantalla que compruebe pendientes tras cumplirse la
// ventana. Ver getPendingAttacksFor() más abajo, que llama a esto por
// cada pendiente vencido ANTES de devolver la lista, así que el defensor
// nunca ve como "pendiente todavía" un ataque que ya expiró.
// ─────────────────────────────────────────────────────────────────────
async function expirePendingAttack(attackId) {
  const attackRef = doc(db, 'invasion_attacks', attackId);
  const attackSnap = await getDoc(attackRef);
  if (!attackSnap.exists()) return null; // ya no existe: nada que expirar
  const attack = attackSnap.data();
  if (attack.status !== 'pending') return null; // alguien ya lo resolvió (jugado o expirado) mientras tanto

  const createdMs = attack.createdAt && attack.createdAt.toMillis ? attack.createdAt.toMillis() : 0;
  if (Date.now() - createdMs < CFG.PENDING_ATTACK_WINDOW_MS) return null; // todavía dentro de la ventana

  const [attackerSnap, defenderSnap] = await Promise.all([
    getDoc(doc(db, 'invasion_players', attack.attackerUid)),
    getDoc(doc(db, 'invasion_players', attack.defenderUid)),
  ]);
  if (!attackerSnap.exists() || !defenderSnap.exists()) return null; // perfil borrado/corrupto: no se puede resolver con seguridad

  const attacker = attackerSnap.data();
  const defender = defenderSnap.data();
  const now = Date.now();

  // won siempre true aquí (incomparecencia = victoria del atacante),
  // mismo cálculo de tier/botín que resolveDuel() cuando won es true.
  const tier = difficultyFor(attacker.lvl || attack.attackerLvl || 1, defender.lvl || attack.defenderLvl || 1);
  const rawMax = Math.floor((defender.clk || 0) * tier.robMax);
  const capByFloor = Math.max(0, (defender.clk || 0) - CFG.MIN_CLK_LEFT_AFTER_ROB);
  const stolenAmount = Math.max(0, Math.min(rawMax, capByFloor));

  const batch = writeBatch(db);

  if (stolenAmount > 0) {
    const newAttackerClk = (attacker.clk || 0) + stolenAmount;
    const newDefenderClk = Math.max(0, (defender.clk || 0) - stolenAmount);
    batch.update(doc(db, 'invasion_players', attack.attackerUid), {
      clk: newAttackerClk, updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'invasion_players', attack.defenderUid), {
      clk: newDefenderClk, lastAttackedAt: now, updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'invasion_targets', attack.attackerUid), { clk: newAttackerClk }, { merge: true });
    batch.set(doc(db, 'invasion_targets', attack.defenderUid), { clk: newDefenderClk }, { merge: true });
  }

  batch.update(attackRef, {
    defenseScore: 0,
    status: 'resolved',
    won: true,
    stolenAmount,
    resolvedAt: serverTimestamp(),
    expiredByTimeout: true, // distingue esta resolución de una jugada de verdad, ver comentario de la función
  });

  await batch.commit();
  return { won: true, stolenAmount, difficulty: tier, attackScore: attack.attackScore || 0, defenseScore: 0, attackId, expiredByTimeout: true };
}

// ─────────────────────────────────────────────────────────────────────
// ATAQUES PENDIENTES DE UN DEFENSOR — spec sección 6: el ataque queda
// registrado mientras el defensor no lo haya resuelto, incluso si
// estaba offline cuando se lanzó. Se listan aquí para que index.html
// pinte la notificación ("Fulano te ha atacado") y enlace al minijuego
// de defensa. Puede haber más de uno a la vez (varios atacantes
// distintos pueden tener un misil pendiente contra el mismo defensor
// simultáneamente; cada uno se resuelve por separado con resolveDuel()).
//
// Antes de devolver la lista, resuelve (expirePendingAttack) cualquier
// pendiente que ya superó CFG.PENDING_ATTACK_WINDOW_MS — así el defensor
// nunca ve como "pendiente, puedes defenderte" un ataque que ya se
// resolvió solo en su contra. Se procesan en paralelo (Promise.all): no
// hay dependencia entre expirar un ataque y otro, cada uno toca su
// propio documento.
// ─────────────────────────────────────────────────────────────────────
async function getPendingAttacksFor(uid, max = 20) {
  const q = query(
    collection(db, 'invasion_attacks'),
    where('defenderUid', '==', uid),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc'),
    limit(max)
  );
  const snap = await getDocs(q);
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const now = Date.now();
  const stillPending = [];
  const toExpire = [];
  for (const a of all) {
    const createdMs = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    if (now - createdMs >= CFG.PENDING_ATTACK_WINDOW_MS) toExpire.push(a.id);
    else stillPending.push(a);
  }
  if (toExpire.length > 0) {
    await Promise.all(toExpire.map(id => expirePendingAttack(id).catch(e => {
      // Un fallo al expirar UN ataque concreto (p.ej. perfil borrado) no
      // debe tumbar la carga del resto de pendientes reales — se loguea
      // y se sigue; ese ataque en concreto quedará 'pending' y se
      // reintentará expirar en la próxima llamada a esta función.
      console.error('[DIAG] expirePendingAttack falló para', id, e);
    })));
  }
  return stillPending;
}

// ─────────────────────────────────────────────────────────────────────
// ACTIVAR ESCUDO — de momento solo tipos en CFG.SHIELDS_ENABLED. Cuesta
// $CLK según shieldCost(shieldType, nivel) (ver CFG.SHIELD_COST). Se
// relee invasion_players/{uid} justo antes de cobrar (no se confía en el
// clk que trae myProfile en el cliente, que puede llevar unos segundos
// desfasado) para no dejar cobrar un escudo que el jugador ya no puede
// pagar.
// ─────────────────────────────────────────────────────────────────────
async function activateShield(uid, shieldType) {
  if (!CFG.SHIELDS_ENABLED.includes(shieldType)) {
    throw new Error('Tipo de escudo no habilitado: ' + shieldType);
  }
  const playerRef = doc(db, 'invasion_players', uid);
  const snap = await getDoc(playerRef);
  if (!snap.exists()) throw new Error('Perfil de invasión no encontrado');
  const player = snap.data();

  // Mientras haya un escudo activo, no se puede volver a comprar el
  // MISMO tipo (evita repetir 3d sobre 3d, o 7d sobre 7d, sin ganar nada
  // porque solo reinicia el contador en vez de sumarlo). Tampoco se
  // puede comprar 3d con un 7d activo, porque sería pagar por una
  // duración menor que recortaría la protección de 7d ya pagada. En
  // cambio, comprar 7d con un 3d activo sí se permite: mejora la
  // protección en vez de desperdiciarla.
  const hasActiveShield = (player.shieldUntil || 0) > Date.now();
  if (hasActiveShield && (shieldType === player.shieldType || (shieldType === '3d' && player.shieldType === '7d'))) {
    throw new Error('Ya tienes un escudo de ' + player.shieldType + ' activo. Espera a que termine para comprar otro de ' + shieldType + '.');
  }

  const cost = shieldCost(shieldType, player.lvl || 1);
  const currentClk = player.clk || 0;
  if (currentClk < cost) {
    throw new Error('CLK insuficiente para este escudo');
  }

  const hours = CFG.SHIELD_HOURS[shieldType];
  const shieldUntil = Date.now() + hours * 60 * 60 * 1000;
  const newClk = currentClk - cost;

  const batch = writeBatch(db);
  batch.update(playerRef, { shieldUntil, shieldType, clk: newClk, updatedAt: serverTimestamp() });
  batch.set(doc(db, 'invasion_targets', uid), { shieldUntil, clk: newClk }, { merge: true });
  await batch.commit();
  return { shieldUntil, cost, newClk };
}

// ─────────────────────────────────────────────────────────────────────
// VENGANZA — último ataque sufrido dentro de la ventana de 24h, siempre
// que TODAVÍA no me haya vengado de ese ataque concreto.
//
// BUG corregido aquí: esta función buscaba solo "el último ataque que
// sufrí y que ganó mi atacante", sin comprobar si yo ya había lanzado
// esa venganza. Como vengarse crea un invasion_attacks NUEVO (con roles
// invertidos: yo como attackerUid, mi agresor original como
// defenderUid) que no modifica ni marca el documento del ataque
// original, esta query seguía devolviendo el mismo ataque como
// "pendiente de vengar" indefinidamente mientras siguiera dentro de las
// 24h — el aviso nunca desaparecía, el historial nunca reflejaba que ya
// me había vengado, y en cuanto pasaba el cooldown normal
// (CFG.INVASION_COOLDOWN_MS) se podía volver a "vengar" el mismo ataque
// una y otra vez.
//
// El arreglo: tras localizar el último ataque sufrido y ganado (igual
// que antes), se comprueba si ya existe un ataque MÍO posterior contra
// ese mismo agresor (mi venganza). Se reutiliza la query de
// "attackerUid == uid" que ya usa getAttackHistory() -mismo índice
// compuesto attackerUid+createdAt, sin necesitar uno nuevo- y se filtra
// en cliente por defenderUid/fecha, mismo patrón que ya usa
// findRandomTarget() para recentTargets.
// ─────────────────────────────────────────────────────────────────────
async function getActiveRevengeTarget(uid) {
  // where('won','==',true) ya excluye por sí solo los ataques todavía
  // 'pending' del nuevo flujo de dos fases: mientras un ataque está
  // pendiente, won se guarda como placeholder false (ver
  // createPendingAttack()) y solo pasa a reflejar el resultado real de
  // won al llegar a resolveDuel() — así que un misil que el defensor
  // aún no ha interceptado/dejado pasar nunca puede colarse aquí como
  // "ataque ganado pendiente de vengar" antes de tiempo.
  const q = query(
    collection(db, 'invasion_attacks'),
    where('defenderUid', '==', uid),
    where('won', '==', true),
    orderBy('createdAt', 'desc'),
    limit(1)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const last = snap.docs[0].data();
  const createdMs = last.createdAt && last.createdAt.toMillis ? last.createdAt.toMillis() : 0;
  if (Date.now() - createdMs > CFG.REVENGE_WINDOW_MS) return null;

  const alreadyRevenged = await hasRevengedAttack(uid, last.attackerUid, createdMs);
  if (alreadyRevenged) return null;

  return {
    attackerUid: last.attackerUid,
    attackerAlias: last.attackerAlias,
    stolenAmount: last.stolenAmount,
    msLeft: CFG.REVENGE_WINDOW_MS - (Date.now() - createdMs),
  };
}

// Comprueba si `uid` ya lanzó, después de `sinceMs`, algún ataque contra
// `revengeTargetUid` — es decir, si ya se vengó de ese ataque concreto.
// Se usa desde getActiveRevengeTarget() (arriba) y desde las pantallas
// que pintan el botón "Vengarse" por fila de historial (mismo criterio
// para ambos sitios, ver index.html/loadHistory()).
//
// Nota flujo de dos fases: esto NO filtra por status, así que un misil
// de venganza todavía 'pending' (el agresor original aún no lo ha
// defendido) YA cuenta aquí como "venganza lanzada" — a propósito, igual
// que en un ataque normal LANZAR el misil es lo que consume el cooldown
// y el cupo diario (ver createPendingAttack()), independientemente de
// cómo acabe el duelo. "Vengarse" es la acción de lanzar el misil de
// revancha, no depende de acertar el tap.
async function hasRevengedAttack(uid, revengeTargetUid, sinceMs) {
  const q = query(
    collection(db, 'invasion_attacks'),
    where('attackerUid', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    const createdMs = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
    if (createdMs <= sinceMs) break; // ya llegamos a ataques anteriores al que se quiere vengar
    if (d.defenderUid === revengeTargetUid) return true;
  }
  return false;
}

// Comprueba si `avengerUid` tiene, AHORA MISMO, una venganza legítima
// pendiente contra `originalAttackerUid` — es decir: `originalAttackerUid`
// le robó dentro de las últimas 24h Y `avengerUid` todavía no se ha
// vengado de ESE ataque concreto.
//
// Se usa dentro de resolveInvasion() (más abajo) para no confiar
// ciegamente en el isRevenge:true/false que declara el cliente — ver el
// comentario en resolveInvasion() sobre por qué esto hace falta pese a
// que search.html también valida.
//
// Nota de diseño: NO se reutiliza getActiveRevengeTarget() tal cual
// porque esa función solo mira "el ataque MÁS RECIENTE que sufrí", y
// aquí el atacante a comprobar ya viene fijado por parámetro — si
// avengerUid sufrió un ataque de otro jugador MÁS RECIENTE después de
// este, getActiveRevengeTarget() apuntaría a ese otro ataque y daría un
// falso negativo aquí aunque la venganza contra originalAttackerUid
// siga siendo legítima.
//
// Se reutiliza el índice compuesto defenderUid+won+createdAt que ya usa
// getActiveRevengeTarget() (sin el limit(1) fijado al más reciente) y se
// filtra attackerUid en cliente, en vez de añadir un where('attackerUid',...)
// a la query -eso exigiría un índice compuesto de 4 campos que hoy no
// existe-. limit(20) es suficiente margen para encontrar el ataque de
// ese agresor concreto entre los sufridos recientes sin tener que leer
// el historial completo.
async function isLegitimateRevenge(avengerUid, originalAttackerUid) {
  const q = query(
    collection(db, 'invasion_attacks'),
    where('defenderUid', '==', avengerUid),
    where('won', '==', true),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  const snap = await getDocs(q);
  const now = Date.now();
  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    if (d.attackerUid !== originalAttackerUid) continue;
    const createdMs = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
    if (now - createdMs > CFG.REVENGE_WINDOW_MS) return false; // el más reciente de ESE agresor ya caducó
    const alreadyRevenged = await hasRevengedAttack(avengerUid, originalAttackerUid, createdMs);
    return !alreadyRevenged;
  }
  return false; // ese agresor nunca robó a avengerUid (o fue hace más de 20 ataques sufridos)
}

// ─────────────────────────────────────────────────────────────────────
// HISTORIAL — últimos robos donde participé (como atacante o defensor).
// Dos queries porque Firestore no permite OR entre campos distintos en
// una sola query sin índice compuesto especial; se fusionan en cliente.
// ─────────────────────────────────────────────────────────────────────
async function getAttackHistory(uid, max = 20) {
  const [asAttacker, asDefender] = await Promise.all([
    getDocs(query(collection(db, 'invasion_attacks'), where('attackerUid', '==', uid), orderBy('createdAt', 'desc'), limit(max))),
    getDocs(query(collection(db, 'invasion_attacks'), where('defenderUid', '==', uid), orderBy('createdAt', 'desc'), limit(max))),
  ]);
  const rows = [];
  asAttacker.forEach(d => rows.push({ id: d.id, role: 'attacker', ...d.data() }));
  asDefender.forEach(d => rows.push({ id: d.id, role: 'defender', ...d.data() }));
  rows.sort((a, b) => {
    const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return tb - ta;
  });
  return rows.slice(0, max);
}

// ─────────────────────────────────────────────────────────────────────
// HISTORIAL PAGINADO — misma fuente que getAttackHistory() (dos queries
// fusionadas), pero pensado para un selector de páginas con números en
// vez de una lista fija. Se trae un lote combinado más grande UNA sola
// vez (fetchCap filas por rol, tope FETCH_CAP_MAX) y la paginación en
// sí ocurre en cliente sobre ese array ya ordenado — evita el problema
// de sincronizar cursors de Firestore entre DOS queries distintas
// (atacante/defensor) que tendrían que avanzar juntas página a página.
// Para el volumen de este modo (un historial personal, no un ranking
// global) esto es más simple y fiable que paginar en el propio
// Firestore, a costa de un techo fijo de filas totales visibles
// (FETCH_CAP_MAX) en vez de paginación infinita.
// ─────────────────────────────────────────────────────────────────────
const HIST_FETCH_CAP_MAX = 200; // tope total (atacante+defensor) por consulta
async function getAttackHistoryPage(uid, page = 1, pageSize = 15) {
  const fetchCap = Math.min(HIST_FETCH_CAP_MAX, Math.max(pageSize * 10, pageSize));
  const [asAttacker, asDefender] = await Promise.all([
    getDocs(query(collection(db, 'invasion_attacks'), where('attackerUid', '==', uid), orderBy('createdAt', 'desc'), limit(fetchCap))),
    getDocs(query(collection(db, 'invasion_attacks'), where('defenderUid', '==', uid), orderBy('createdAt', 'desc'), limit(fetchCap))),
  ]);
  const rows = [];
  asAttacker.forEach(d => rows.push({ id: d.id, role: 'attacker', ...d.data() }));
  asDefender.forEach(d => rows.push({ id: d.id, role: 'defender', ...d.data() }));
  rows.sort((a, b) => {
    const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return tb - ta;
  });
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    totalRows: rows.length,
    truncated: rows.length >= fetchCap, // puede haber más filas de las que este lote trajo
  };
}

// ─────────────────────────────────────────────────────────────────────
// MÚSICA DE FONDO DEL MODO INVASIÓN — sounds/invasion.mp3, en loop,
// SOLO en invasion/index.html (la pantalla principal del modo). No
// suena en search.html ni en minigame.html -decisión de producto, no
// limitación técnica-. Se centraliza aquí en vez de vivir directamente
// en index.html porque el resto de utilidades de Invasión ya siguen
// este mismo patrón (window.InvasionCore) -mismo criterio que
// RULETA_SOUND_SRC/MUSICA_FONDO_SOUND_SRC en ruleta.html, incluida la
// clave de localStorage 'cck4_muted' para que el mute sea consistente
// con el resto de la app (índice padre, ruleta, invasión).
// ─────────────────────────────────────────────────────────────────────
const INVASION_BGM_SRC = 'sounds/invasion.mp3';
const INVASION_BGM_VOL = 0.15; // mismo nivel que MUSICA_FONDO_VOL en ruleta.html
let _invasionMuted = false;
try { _invasionMuted = localStorage.getItem('cck4_muted') === '1'; } catch (e) {}
let _invasionBgmEl = null;

function getInvasionBgmEl() {
  if (!_invasionBgmEl) {
    _invasionBgmEl = new Audio(INVASION_BGM_SRC);
    _invasionBgmEl.preload = 'auto';
    _invasionBgmEl.loop = true;
    _invasionBgmEl.volume = _invasionMuted ? 0 : INVASION_BGM_VOL;
    _invasionBgmEl.addEventListener('error', () => {
      const err = _invasionBgmEl.error;
      console.error('[música de fondo invasión] No se pudo cargar "' + INVASION_BGM_SRC + '". Código de error:', err ? err.code : '(desconocido)');
    });
  }
  return _invasionBgmEl;
}

// Arranca la música de fondo en loop. Igual que en ruleta.html/index.html:
// se intenta reproducir apenas se llama; si el navegador bloquea el
// autoplay con sonido, se reintenta una sola vez en el primer
// click/touch/tecla del usuario en esa página.
function initInvasionBgm() {
  if (_invasionMuted) return;
  const el = getInvasionBgmEl();
  el.play().catch(() => {
    const reintentar = () => {
      if (_invasionMuted) return;
      el.play().catch(err => console.error('[música de fondo invasión] play() rechazado:', err.name, '-', err.message));
      ['click', 'touchstart', 'keydown'].forEach(ev => document.removeEventListener(ev, reintentar));
    };
    ['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, reintentar, { once: true }));
  });
}

// Pausa/reanuda la música de fondo de Invasión — mismo patrón que
// BGM.pause()/BGM.resume() en el índice padre, usado ahí para que la
// música de fondo del juego no se solape con el audio propio del video
// de intro. Aquí se usa por el mismo motivo: el video de intro de
// Invasión (invasioncortapresentacion.mp4) también reproduce con sonido
// (ver playIntroVideo() en index.html, vid.muted=false), así que sin
// esto invasion.mp3 sonaría a la vez que el audio del video.
function pauseInvasionBgm() {
  if (_invasionBgmEl && !_invasionBgmEl.paused) _invasionBgmEl.pause();
}
function resumeInvasionBgm() {
  if (_invasionMuted || !_invasionBgmEl) return;
  _invasionBgmEl.play().catch(() => {}); // si el navegador lo bloquea aquí, initInvasionBgm ya dejó un reintento armado en el primer gesto
}

// Invierte el mute (mismo patrón que SFX.toggleMute() + BGM.onMuteChanged()
// en el índice padre): guarda en la misma clave 'cck4_muted' y ajusta en
// vivo el volumen de la música de fondo de Invasión. Devuelve el nuevo
// estado (true = silenciado) para que el botón que llama sepa qué icono
// mostrar.
function toggleInvasionMute() {
  _invasionMuted = !_invasionMuted;
  try { localStorage.setItem('cck4_muted', _invasionMuted ? '1' : '0'); } catch (e) {}
  if (_invasionBgmEl) {
    if (_invasionMuted) {
      _invasionBgmEl.pause();
    } else {
      _invasionBgmEl.volume = INVASION_BGM_VOL;
      _invasionBgmEl.play().catch(() => {});
    }
  }
  return _invasionMuted;
}

// ─────────────────────────────────────────────────────────────────────
// EXPORT — window.InvasionCore, mismo patrón que window.__fb en el padre.
// ─────────────────────────────────────────────────────────────────────
window.InvasionCore = {
  CFG, db, auth, authReady,
  difficultyFor, todayKeyUTC, shieldCost, isInvasionUnlocked, computeAimScore,
  syncProfileFromMainSave, findRandomTarget, findTargetByLevel, explainNoTargetFound, checkCanInvade,
  createPendingAttack, resolveDuel, getPendingAttacksFor, expirePendingAttack, hasPendingDefense, hasActivePendingDefense,
  activateShield, getActiveRevengeTarget, hasRevengedAttack, isLegitimateRevenge, getAttackHistory, getAttackHistoryPage,
  doc, getDoc, // se re-exportan por si una pantalla necesita leer algo puntual
  initInvasionBgm, // arranca la música de fondo del modo Invasión (loop, respeta cck4_muted)
  pauseInvasionBgm, resumeInvasionBgm, // para no solapar con el audio propio del video de intro
  toggleInvasionMute, // botón de silenciar del topbar de invasion/index.html
  get invasionMuted() { return _invasionMuted; }, // estado actual, para pintar el icono del botón al cargar
};
