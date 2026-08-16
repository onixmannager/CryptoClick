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
  // base fijada a petición expresa para que en nivel 1 (el más bajo)
  // cueste exactamente 5.000 (3d) y 10.000 (7d); exp intacto (mismo
  // ritmo de escalado agresivo que ya tenía el sistema, confirmado
  // explícitamente en vez de suavizarlo pese a que la base es mucho
  // mayor que antes). A nivel 50 esto da ~1,29M (3d) / ~6,14M (7d).
  // Base subida x3 a petición expresa (mismo coste x3 en TODOS los
  // niveles, no solo nivel 1): como el coste es base*exp^(lvl-1),
  // multiplicar la base x3 multiplica x3 el resultado para cualquier
  // lvl sin tocar exp ni el ritmo de escalado relativo entre niveles.
  SHIELD_COST: {
    '3d': { base: 15000, exp: 1.12 },
    '7d': { base: 30000, exp: 1.14 },
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
  // Subido de 20 a 30 junto con el cooldown más corto: con 5s de espera
  // entre invasiones, 20/día se agotaba en menos de 2 minutos de juego
  // seguido, lo que convertía el límite diario en la única fricción real
  // del modo. 30/día mueve esa fricción a "vuelve mañana" en vez de
  // "espera un minuto", que es el patrón de retención (sesión diaria) en
  // vez de sesión maratoniana. Debe ir sincronizado con el tope
  // invasionsToday <= 30 en firestore/invasion.rules.
  MAX_INVASIONS_PER_DAY: 30,
  SAME_TARGET_COOLDOWN_MS: 4 * 60 * 60 * 1000, // 4h sin repetir objetivo
  NEW_ACCOUNT_PROTECTION_MS: 0, // protección a cuentas nuevas desactivada a petición: cualquier cuenta puede invadir desde el minuto 1
  REVENGE_WINDOW_MS: 24 * 60 * 60 * 1000,    // 24h para vengarse

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
// BUSCAR RIVAL — query aleatoria vía campo `rand` (ver docs/DISEÑO.md
// sección invasion_targets). Filtra en la propia query lo que Firestore
// permite indexar (shieldUntil, clk) y filtra en cliente el resto
// (cuenta nueva, mismo uid, recentTargets) porque son condiciones que
// dependen del propio perfil del atacante, no solo del documento leído.
// ─────────────────────────────────────────────────────────────────────
async function findRandomTarget(myUid, myRecentTargets) {
  const now = Date.now();
  const targetsCol = collection(db, 'invasion_targets');
  const r = Math.random();

  // Firestore exige que si el primer filtro es una desigualdad (rand>=r),
  // el primer orderBy sea sobre ESE MISMO campo — no se puede combinar con
  // un orderBy('rand') a la vez que where('shieldUntil','<=',now) sin un
  // índice compuesto (ver firestore/invasion.indexes.json). Por eso el
  // filtro de escudo NO va en la query: se trae un lote algo más grande
  // por rand y se filtra shieldUntil/clk/cuenta-nueva/objetivo-reciente
  // en cliente. Es más lecturas de las estrictamente necesarias, pero
  // evita depender de un índice compuesto para algo que se puede resolver
  // con un limit más generoso.
  async function tryDirection(op, order) {
    const q = query(
      targetsCol,
      where('rand', op, r),
      orderBy('rand', order),
      limit(30)
    );
    const snap = await getDocs(q);
    return snap.docs;
  }

  // '>=' se recorre ascendente (los más cercanos a r por arriba primero);
  // '<=' se recorre DESCENDENTE (los más cercanos a r por abajo primero)
  // — antes iba ascendente también en este caso, así que con pocos
  // jugadores en la colección el candidato más cercano a `r` por abajo
  // podía quedar fuera del limit(30) si había muchos valores de `rand`
  // más pequeños todavía por delante suyo en el orden. Con pocos
  // jugadores el límite no debería recortar nada, pero se corrige igual
  // porque es la causa correcta de "candidatos que no se encuentran"
  // según la colección crece.
  let candidates = await tryDirection('>=', 'asc');
  if (candidates.length === 0) candidates = await tryDirection('<=', 'desc');

  // Diagnóstico: cuenta cuántos candidatos se leyeron y por qué motivo se
  // descartó cada uno, para poder ver en consola la causa real cuando
  // "no hay rivales" en vez de una caja negra. No cambia el resultado,
  // solo lo hace investigable.
  const skipped = { self: 0, lowClk: 0, shielded: 0, newAccount: 0, cooldown: 0 };

  for (const docSnap of candidates) {
    const uid = docSnap.id;
    const d = docSnap.data();
    if (uid === myUid) { skipped.self++; continue; }
    if ((d.clk || 0) < CFG.MIN_CLK_TO_BE_TARGET) { skipped.lowClk++; continue; }
    if ((d.shieldUntil || 0) > now) { skipped.shielded++; continue; }
    if (now - (d.accountCreatedAt || 0) < CFG.NEW_ACCOUNT_PROTECTION_MS) { skipped.newAccount++; continue; }
    const lastHit = (myRecentTargets || {})[uid] || 0;
    if (now - lastHit < CFG.SAME_TARGET_COOLDOWN_MS) { skipped.cooldown++; continue; }
    return { uid, ...d };
  }
  console.log('[DIAG] findRandomTarget: sin candidato válido. Leídos:', candidates.length, 'Descartados por:', JSON.stringify(skipped));
  return null; // no se encontró rival válido esta vez (lote sin candidatos válidos)
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
// RESOLVER INVASIÓN — se llama tras el minijuego, con el resultado
// (won: boolean) que decidió el cliente. Recalcula la dificultad/tope de
// robo del lado "servidor" (aquí: este mismo módulo, ver docs/DISEÑO.md
// sección 0 sobre por qué esto no es un servidor de verdad) en vez de
// confiar en un stolenAmount que mandara la pantalla del minijuego, y
// vuelve a leer el escudo del defensor en tiempo real por si se activó
// justo entre la búsqueda y ahora.
// ─────────────────────────────────────────────────────────────────────
// ⚠️ LIMITACIÓN CONOCIDA DE ESTA FASE (aislada, sin tocar el juego padre):
// invasion_players/{uid}.clk parte de saves/{uid}.clk como fuente inicial,
// pero syncProfileFromMainSave() compara updatedAt entre ambos documentos
// y NO deja que un saves/ desactualizado pise un robo más reciente (ver
// esa función) — así que dentro del modo Invasión el saldo mostrado SÍ
// refleja robos ganados/sufridos de inmediato, sin importar cuántas veces
// se resincronice.
//
// Lo que sigue sin resolverse aquí a propósito: ese cambio de saldo NUNCA
// se escribe de vuelta en saves/{uid} — el juego principal seguirá
// mostrando el saldo de antes del robo. Y hay un caso a vigilar: el padre
// autoguarda solo cada ~20s si hay actividad (ver CLOUD_MIN_INTERVAL en
// index.html del padre) — si el jugador simplemente vuelve a jugar el
// juego principal después de una invasión, ese autoguardado ESCRIBE
// saves/{uid} con el clk de antes del robo y un updatedAt nuevo, sin que
// el jugador haga nada explícito para ello. La próxima vez que abra el
// modo Invasión, saves/ "ganará" por ser más reciente y la ganancia o
// pérdida de Invasión desaparecerá del saldo mostrado — el registro en
// invasion_attacks (historial) sigue intacto, pero el saldo visible ya
// no la refleja. Esto es la consecuencia directa de no tener una única
// fuente de verdad para clk, y es exactamente el problema que resolver
// en integración: decidir si invasion_players pasa a ser la fuente de
// verdad de clk, o si cada robo escribe también en saves/{uid}.
async function resolveInvasion({ attackerUid, defenderUid, won, isRevenge }) {
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

  const invadeCheck = checkCanInvade(attacker);
  if (!invadeCheck.ok) throw new Error('No se puede invadir ahora mismo: ' + invadeCheck.reason);
  if ((defender.shieldUntil || 0) > now) throw new Error('El objetivo activó un escudo justo ahora');

  // isRevenge llega del cliente (search.html -> sessionStorage ->
  // minigame.html) sin que nada lo haya verificado hasta aquí de forma
  // obligatoria: search.html SÍ revalida antes de dejar avanzar al
  // minijuego (ver searchDirectTarget()), pero eso es una comodidad de
  // UI, no una barrera — nada impide llegar a minigame.html saltándose
  // search.html por completo, con invasion_battle_is_revenge='1'
  // escrito a mano en sessionStorage (DevTools) contra un objetivo que
  // nunca atacó a este jugador. isRevenge no afecta al robo en sí
  // (mismo tier/stolenAmount, mismo cooldown, mismo límite diario que un
  // ataque normal — es puramente informativo, ver el campo isRevenge más
  // abajo), pero si se guardara falso en invasion_attacks corrompería la
  // contabilidad que getActiveRevengeTarget()/hasRevengedAttack() usan
  // para decidir avisos y botones "Vengarse" futuros (ver esas
  // funciones). Por eso se revalida aquí, en el único paso por el que
  // OBLIGATORIAMENTE pasa cualquier resultado, sea cual sea la pantalla
  // de origen. Si no es legítimo, se degrada a false en vez de
  // rechazar la invasión entera: el ataque jugado sigue siendo válido,
  // lo único falso era la etiqueta de "venganza".
  const revengeIsLegit = !!isRevenge && await isLegitimateRevenge(attackerUid, defenderUid);

  const tier = difficultyFor(attacker.lvl, defender.lvl);
  let stolenAmount = 0;
  if (won) {
    const rawMax = Math.floor((defender.clk || 0) * tier.robMax);
    const capByFloor = Math.max(0, (defender.clk || 0) - CFG.MIN_CLK_LEFT_AFTER_ROB);
    stolenAmount = Math.max(0, Math.min(rawMax, capByFloor));
  }

  const dayKey = todayKeyUTC();
  const newInvasionsToday = attacker.invasionsDayKey === dayKey ? (attacker.invasionsToday || 0) + 1 : 1;
  const newRecentTargets = { ...(attacker.recentTargets || {}), [defenderUid]: now };

  const batch = writeBatch(db);

  // Un único update por documento en el batch (evitamos depender de que
  // varias llamadas .update() sobre el mismo doc se fusionen — aunque
  // writeBatch sí lo hace, es más claro dejarlo explícito en un solo objeto).
  const attackerUpdate = {
    lastInvasionAt: now,
    invasionsToday: newInvasionsToday,
    invasionsDayKey: dayKey,
    recentTargets: newRecentTargets,
    updatedAt: serverTimestamp(),
  };

  if (stolenAmount > 0) {
    const newAttackerClk = (attacker.clk || 0) + stolenAmount;
    const newDefenderClk = Math.max(0, (defender.clk || 0) - stolenAmount);
    attackerUpdate.clk = newAttackerClk;
    batch.update(doc(db, 'invasion_players', defenderUid), {
      clk: newDefenderClk, lastAttackedAt: now, updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'invasion_targets', attackerUid), { clk: newAttackerClk }, { merge: true });
    batch.set(doc(db, 'invasion_targets', defenderUid), { clk: newDefenderClk }, { merge: true });
  }

  batch.update(doc(db, 'invasion_players', attackerUid), attackerUpdate);

  const attackId = `${attackerUid}_${now}`;
  batch.set(doc(db, 'invasion_attacks', attackId), {
    attackerUid, attackerAlias: attacker.alias || 'Jugador',
    defenderUid, defenderAlias: defender.alias || 'Jugador',
    attackerLvl: attacker.lvl || 1, defenderLvl: defender.lvl || 1,
    difficulty: tier.key, won: !!won, stolenAmount,
    isRevenge: revengeIsLegit,
    createdAt: serverTimestamp(),
  });

  await batch.commit();

  return { won: !!won, stolenAmount, difficulty: tier, attackId };
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
  difficultyFor, todayKeyUTC, shieldCost,
  syncProfileFromMainSave, findRandomTarget, checkCanInvade,
  resolveInvasion, activateShield, getActiveRevengeTarget, hasRevengedAttack, isLegitimateRevenge, getAttackHistory, getAttackHistoryPage,
  doc, getDoc, // se re-exportan por si una pantalla necesita leer algo puntual
  initInvasionBgm, // arranca la música de fondo del modo Invasión (loop, respeta cck4_muted)
  pauseInvasionBgm, resumeInvasionBgm, // para no solapar con el audio propio del video de intro
  toggleInvasionMute, // botón de silenciar del topbar de invasion/index.html
  get invasionMuted() { return _invasionMuted; }, // estado actual, para pintar el icono del botón al cargar
};
