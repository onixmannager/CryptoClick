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
  SHIELD_HOURS: { '6h': 6, '24h': 24, '3d': 72, '7d': 168 },
  SHIELDS_ENABLED: ['3d', '7d'],

  // Anti-abuso
  INVASION_COOLDOWN_MS: 60 * 1000,           // 60s entre invasiones lanzadas
  MAX_INVASIONS_PER_DAY: 20,
  SAME_TARGET_COOLDOWN_MS: 4 * 60 * 60 * 1000, // 4h sin repetir objetivo
  NEW_ACCOUNT_PROTECTION_MS: 24 * 60 * 60 * 1000, // 24h de protección a cuentas nuevas
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
  DIFFICULTY_TIERS: [
    { min: 10,  max: Infinity, key: 'muy_facil',   label: 'Muy fácil',    tiempoMs: 20000, intentos: 4, robMax: 0.18 },
    { min: 4,   max: 9,        key: 'facil',       label: 'Fácil',        tiempoMs: 17000, intentos: 3, robMax: 0.15 },
    { min: -3,  max: 3,        key: 'normal',      label: 'Normal',       tiempoMs: 14000, intentos: 3, robMax: 0.12 },
    { min: -9,  max: -4,       key: 'dificil',     label: 'Difícil',      tiempoMs: 11000, intentos: 2, robMax: 0.08 },
    { min: -Infinity, max: -10, key: 'muy_dificil', label: 'Casi imposible', tiempoMs: 10000, intentos: 2, robMax: 0.05 },
  ],
};

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
  async function tryDirection(op) {
    const q = query(
      targetsCol,
      where('rand', op, r),
      orderBy('rand'),
      limit(30)
    );
    const snap = await getDocs(q);
    return snap.docs;
  }

  let candidates = await tryDirection('>=');
  if (candidates.length === 0) candidates = await tryDirection('<=');

  for (const docSnap of candidates) {
    const uid = docSnap.id;
    const d = docSnap.data();
    if (uid === myUid) continue;
    if ((d.clk || 0) < CFG.MIN_CLK_TO_BE_TARGET) continue;
    if ((d.shieldUntil || 0) > now) continue;
    if (now - (d.accountCreatedAt || 0) < CFG.NEW_ACCOUNT_PROTECTION_MS) continue;
    const lastHit = (myRecentTargets || {})[uid] || 0;
    if (now - lastHit < CFG.SAME_TARGET_COOLDOWN_MS) continue;
    return { uid, ...d };
  }
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
    isRevenge: !!isRevenge,
    createdAt: serverTimestamp(),
  });

  await batch.commit();

  return { won: !!won, stolenAmount, difficulty: tier, attackId };
}

// ─────────────────────────────────────────────────────────────────────
// ACTIVAR ESCUDO — de momento solo tipos en CFG.SHIELDS_ENABLED. El
// coste en CLK de cada escudo NO se define aquí todavía: la spec dice
// explícitamente "el porcentaje... y las recompensas se configuran
// posteriormente", así que se deja como parámetro que la pantalla de
// tienda deberá pasar cuando exista.
// ─────────────────────────────────────────────────────────────────────
async function activateShield(uid, shieldType) {
  if (!CFG.SHIELDS_ENABLED.includes(shieldType)) {
    throw new Error('Tipo de escudo no habilitado: ' + shieldType);
  }
  const hours = CFG.SHIELD_HOURS[shieldType];
  const shieldUntil = Date.now() + hours * 60 * 60 * 1000;
  const batch = writeBatch(db);
  batch.update(doc(db, 'invasion_players', uid), { shieldUntil, shieldType, updatedAt: serverTimestamp() });
  batch.set(doc(db, 'invasion_targets', uid), { shieldUntil }, { merge: true });
  await batch.commit();
  return shieldUntil;
}

// ─────────────────────────────────────────────────────────────────────
// VENGANZA — último ataque sufrido dentro de la ventana de 24h.
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
  return {
    attackerUid: last.attackerUid,
    attackerAlias: last.attackerAlias,
    stolenAmount: last.stolenAmount,
    msLeft: CFG.REVENGE_WINDOW_MS - (Date.now() - createdMs),
  };
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
// EXPORT — window.InvasionCore, mismo patrón que window.__fb en el padre.
// ─────────────────────────────────────────────────────────────────────
window.InvasionCore = {
  CFG, db, auth, authReady,
  difficultyFor, todayKeyUTC,
  syncProfileFromMainSave, findRandomTarget, checkCanInvade,
  resolveInvasion, activateShield, getActiveRevengeTarget, getAttackHistory,
  doc, getDoc, // se re-exportan por si una pantalla necesita leer algo puntual
};
