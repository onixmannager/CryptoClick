--- work/invasion_ORIGINAL_BACKUP/js/invasion-core.js	2026-08-16 06:28:58.455573363 +0000
+++ CryptoClick/CryptoClick-main/invasion/js/invasion-core.js	2026-08-16 06:36:38.388513340 +0000
@@ -167,6 +167,51 @@
     { min: -9,  max: -4,       key: 'dificil',     label: 'Difícil',      tiempoMs: 17000, intentos: 7, robMax: 0.14 },
     { min: -Infinity, max: -10, key: 'muy_dificil', label: 'Casi imposible', tiempoMs: 14000, intentos: 5, robMax: 0.10 },
   ],
+
+  // ───────────────────────────────────────────────────────────────────
+  // MINIJUEGO DE PRECISIÓN (misil) — sustituye al tablero de 9 casillas
+  // como mecánica de Ataque y de Defensa (mismo cálculo de puntuación
+  // para ambos, ver computeAimScore() más abajo). Un único tap: se
+  // puntúa 0-100 combinando qué tan cerca en el TIEMPO cayó el tap de
+  // "0,00" y qué tan cerca en el ESPACIO cayó del centro exacto de la
+  // pantalla. Todo configurable aquí para poder ajustar dificultad sin
+  // tocar minigame.html/defense.html.
+  // ───────────────────────────────────────────────────────────────────
+  AIM: {
+    // Cuenta atrás antes de que llegue el instante "0,00".
+    COUNTDOWN_MS: 3000,
+
+    // Ventana de tap: si el jugador no pulsa dentro de este margen
+    // alrededor de "0,00" (antes o después), no se registra tap y el
+    // intento vale 0 en timing (falló por completo, ver
+    // computeAimScore()). Suficientemente generoso para que "no pulsar
+    // a tiempo" sea un fallo claro, no un margen imperceptible.
+    MAX_TIMING_MS: 600,
+
+    // Timing: puntuación 100 en t=0ms, decae a 0 en MAX_TIMING_MS.
+    // Curva configurable por separado del espacio para poder afinar
+    // cada eje de dificultad de forma independiente.
+    TIMING_PERFECT_MS: 0,
+
+    // Espacio: puntuación 100 en el centro exacto (distancia 0), decae a
+    // 0 al llegar a AIM_MAX_DISTANCE_RATIO * min(ancho,alto) del área de
+    // juego. Se expresa como ratio (no px fijos) para que el mismo
+    // ajuste sirva igual en cualquier tamaño de pantalla.
+    MAX_DISTANCE_RATIO: 0.42,
+
+    // Peso de cada factor en la puntuación final (deben sumar 1).
+    WEIGHT_TIMING: 0.5,
+    WEIGHT_SPACE: 0.5,
+
+    // Exponente de la curva de caída (1 = lineal, >1 = perdona más cerca
+    // del centro/instante y castiga más lejos, típico "ease-out").
+    FALLOFF_POWER: 1.4,
+  },
+
+  // Nivel mínimo para poder entrar en el modo Invasión. Bloqueado en
+  // nivel 1 y 2, se desbloquea exactamente al llegar a nivel 3 (ver
+  // isInvasionUnlocked() y su uso en index.html/search.html).
+  MIN_LEVEL_TO_UNLOCK: 3,
 };
 
 // Coste en $CLK de un escudo para un jugador de nivel `lvl`, redondeado
@@ -186,6 +231,65 @@
   return CFG.DIFFICULTY_TIERS[2]; // 'normal' como fallback defensivo
 }
 
+// ─────────────────────────────────────────────────────────────────────
+// ¿Puede este nivel entrar en Invasión? Nivel 1 y 2 bloqueados, se
+// desbloquea en CFG.MIN_LEVEL_TO_UNLOCK (3). Centralizado aquí para que
+// index.html (bloquea el botón de entrada) y search.html (por si se
+// llega ahí saltándose el hub) usen exactamente el mismo criterio.
+// ─────────────────────────────────────────────────────────────────────
+function isInvasionUnlocked(lvl) {
+  return (lvl || 1) >= CFG.MIN_LEVEL_TO_UNLOCK;
+}
+
+// ─────────────────────────────────────────────────────────────────────
+// PUNTUACIÓN DEL MINIJUEGO DE PRECISIÓN (misil) — 0 a 100, combina
+// timing (distancia en ms al instante "0,00") y espacio (distancia en
+// px al centro exacto del área de juego). Misma función para Ataque y
+// Defensa: ambos minijuegos son mecánicamente equivalentes (timing +
+// precisión), solo cambia el vídeo/tema visual que los envuelve — ver
+// sección 4 de la spec ("la mecánica vuelve a ser equivalente").
+//
+// Determinista y pura (sin Firestore, sin random) para poder testear y
+// para que createPendingAttack()/resolveDuel() puedan recalcular con los
+// mismos números si hiciera falta depurar un resultado.
+//
+// - timingMs: diferencia real en ms entre el tap y el instante "0,00"
+//   (puede ser negativo si tapeó antes; se usa el valor absoluto).
+//   Pasar null/undefined si el jugador NO llegó a tapear a tiempo
+//   (ventana agotada) → puntuación de timing 0.
+// - distancePx: distancia en px entre el tap y el centro exacto del
+//   área de juego. Pasar null/undefined junto con timingMs null.
+// - maxDistancePx: distancia que vale 0 puntos en el eje espacial —
+//   normalmente min(anchoAreaJuego,altoAreaJuego) * MAX_DISTANCE_RATIO,
+//   lo calcula la pantalla (conoce su propio layout) y se lo pasa aquí
+//   ya resuelto en px para no acoplar esta función a medidas de DOM.
+// ─────────────────────────────────────────────────────────────────────
+function computeAimScore(timingMs, distancePx, maxDistancePx) {
+  const A = CFG.AIM;
+  const pow = A.FALLOFF_POWER;
+
+  let timingScore = 0;
+  if (timingMs !== null && timingMs !== undefined && isFinite(timingMs)) {
+    const t = Math.min(Math.abs(timingMs), A.MAX_TIMING_MS);
+    const ratio = A.MAX_TIMING_MS > 0 ? 1 - (t / A.MAX_TIMING_MS) : 0;
+    timingScore = Math.max(0, Math.pow(Math.max(0, ratio), pow)) * 100;
+  }
+
+  let spaceScore = 0;
+  if (distancePx !== null && distancePx !== undefined && isFinite(distancePx) && maxDistancePx > 0) {
+    const d = Math.min(Math.max(0, distancePx), maxDistancePx);
+    const ratio = 1 - (d / maxDistancePx);
+    spaceScore = Math.max(0, Math.pow(Math.max(0, ratio), pow)) * 100;
+  }
+
+  const final = timingScore * A.WEIGHT_TIMING + spaceScore * A.WEIGHT_SPACE;
+  return {
+    score: Math.round(Math.max(0, Math.min(100, final))),
+    timingScore: Math.round(timingScore),
+    spaceScore: Math.round(spaceScore),
+  };
+}
+
 function todayKeyUTC() {
   return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
 }
@@ -346,29 +450,25 @@
 }
 
 // ─────────────────────────────────────────────────────────────────────
-// BUSCAR RIVAL — query aleatoria vía campo `rand` (ver docs/DISEÑO.md
-// sección invasion_targets). Filtra en la propia query lo que Firestore
-// permite indexar (shieldUntil, clk) y filtra en cliente el resto
-// (cuenta nueva, mismo uid, recentTargets) porque son condiciones que
-// dependen del propio perfil del atacante, no solo del documento leído.
+// BUSCAR RIVAL DENTRO DE UN NIVEL EXACTO — misma técnica de `rand` que
+// antes (ver docs/DISEÑO.md sección invasion_targets: Firestore no tiene
+// ORDER BY random() nativo), pero ahora acotada a where('lvl','==',lvl)
+// además de where('rand',...). Es el bloque reutilizable que
+// findTargetByLevel() llama una vez por cada nivel de la escalera de
+// prioridad (mismo nivel → nivel-1 → nivel-2 → …).
+//
+// Nota de índices: where('lvl','==',lvl) + where('rand','>=',r) +
+// orderBy('rand') es un índice compuesto de 2 campos (lvl+rand), más
+// simple que uno de 3, y Firestore lo pide solo automáticamente la
+// primera vez que la query se ejecuta en producción si no existe ya
+// (ver invasion.indexes.json, se documenta ahí también).
 // ─────────────────────────────────────────────────────────────────────
-async function findRandomTarget(myUid, myRecentTargets) {
-  const now = Date.now();
+async function findCandidatesAtLevel(lvl, r) {
   const targetsCol = collection(db, 'invasion_targets');
-  const r = Math.random();
-
-  // Firestore exige que si el primer filtro es una desigualdad (rand>=r),
-  // el primer orderBy sea sobre ESE MISMO campo — no se puede combinar con
-  // un orderBy('rand') a la vez que where('shieldUntil','<=',now) sin un
-  // índice compuesto (ver firestore/invasion.indexes.json). Por eso el
-  // filtro de escudo NO va en la query: se trae un lote algo más grande
-  // por rand y se filtra shieldUntil/clk/cuenta-nueva/objetivo-reciente
-  // en cliente. Es más lecturas de las estrictamente necesarias, pero
-  // evita depender de un índice compuesto para algo que se puede resolver
-  // con un limit más generoso.
   async function tryDirection(op, order) {
     const q = query(
       targetsCol,
+      where('lvl', '==', lvl),
       where('rand', op, r),
       orderBy('rand', order),
       limit(30)
@@ -376,26 +476,22 @@
     const snap = await getDocs(q);
     return snap.docs;
   }
-
-  // '>=' se recorre ascendente (los más cercanos a r por arriba primero);
-  // '<=' se recorre DESCENDENTE (los más cercanos a r por abajo primero)
-  // — antes iba ascendente también en este caso, así que con pocos
-  // jugadores en la colección el candidato más cercano a `r` por abajo
-  // podía quedar fuera del limit(30) si había muchos valores de `rand`
-  // más pequeños todavía por delante suyo en el orden. Con pocos
-  // jugadores el límite no debería recortar nada, pero se corrige igual
-  // porque es la causa correcta de "candidatos que no se encuentran"
-  // según la colección crece.
-  let candidates = await tryDirection('>=', 'asc');
-  if (candidates.length === 0) candidates = await tryDirection('<=', 'desc');
-
-  // Diagnóstico: cuenta cuántos candidatos se leyeron y por qué motivo se
-  // descartó cada uno, para poder ver en consola la causa real cuando
-  // "no hay rivales" en vez de una caja negra. No cambia el resultado,
-  // solo lo hace investigable.
-  const skipped = { self: 0, lowClk: 0, shielded: 0, newAccount: 0, cooldown: 0 };
-
-  for (const docSnap of candidates) {
+  // '>=' ascendente primero (más cercanos a r por arriba), '<=' descendente
+  // como fallback (más cercanos a r por abajo) — mismo razonamiento que
+  // tenía la búsqueda puramente aleatoria original.
+  let docs = await tryDirection('>=', 'asc');
+  if (docs.length === 0) docs = await tryDirection('<=', 'desc');
+  return docs;
+}
+
+// Filtra en cliente los candidatos leídos de un nivel: cuenta propia,
+// saldo mínimo robable, escudo activo, cuenta nueva, cooldown de mismo
+// objetivo. Devuelve el primer candidato válido o null. Se separa de
+// findCandidatesAtLevel() para que findTargetByLevel() pueda reusar este
+// mismo criterio de filtrado en cada peldaño de la escalera de niveles
+// sin repetir el cuerpo del bucle.
+function firstValidCandidate(docs, myUid, myRecentTargets, now, skipped) {
+  for (const docSnap of docs) {
     const uid = docSnap.id;
     const d = docSnap.data();
     if (uid === myUid) { skipped.self++; continue; }
@@ -406,8 +502,49 @@
     if (now - lastHit < CFG.SAME_TARGET_COOLDOWN_MS) { skipped.cooldown++; continue; }
     return { uid, ...d };
   }
-  console.log('[DIAG] findRandomTarget: sin candidato válido. Leídos:', candidates.length, 'Descartados por:', JSON.stringify(skipped));
-  return null; // no se encontró rival válido esta vez (lote sin candidatos válidos)
+  return null;
+}
+
+// ─────────────────────────────────────────────────────────────────────
+// BUSCAR RIVAL POR NIVEL (sustituye a la búsqueda puramente aleatoria) —
+// spec punto 10: la prioridad de objetivos se basa en el nivel del
+// atacante. Un atacante de nivel N prueba primero objetivos de nivel N
+// exactamente; si no encuentra ninguno válido, prueba N-1, luego N-2, y
+// así sucesivamente hasta nivel 1. Dentro de cada nivel, el candidato en
+// concreto se sigue eligiendo al azar (técnica `rand`, ver
+// findCandidatesAtLevel()) para no repetir siempre el mismo rival a
+// igualdad de nivel.
+//
+// Un atacante de nivel 3 prueba 3→2→1 (spec sección 11: nivel 3 es el
+// mínimo desbloqueado, así que nunca hace falta bajar de nivel 1). Un
+// atacante de nivel 17 prueba 17→16→…→1 en el peor caso — cada peldaño
+// vacío es una lectura de hasta 30 docs, así que en la práctica esto se
+// detiene en cuanto encuentra el primer nivel con población real, no
+// recorre los 17 siempre.
+// ─────────────────────────────────────────────────────────────────────
+async function findTargetByLevel(myUid, myLvl, myRecentTargets) {
+  const now = Date.now();
+  const r = Math.random();
+  const startLvl = Math.max(1, Math.floor(myLvl || 1));
+  const skipped = { self: 0, lowClk: 0, shielded: 0, newAccount: 0, cooldown: 0 };
+  let levelsChecked = 0;
+
+  for (let lvl = startLvl; lvl >= 1; lvl--) {
+    levelsChecked++;
+    const docs = await findCandidatesAtLevel(lvl, r);
+    const found = firstValidCandidate(docs, myUid, myRecentTargets, now, skipped);
+    if (found) return found;
+  }
+
+  console.log('[DIAG] findTargetByLevel: sin candidato válido. Niveles probados:', levelsChecked, '(desde', startLvl, 'hasta 1). Descartados por:', JSON.stringify(skipped));
+  return null; // no se encontró rival válido en ningún nivel de 1 a myLvl
+}
+
+// Alias retrocompatible: código o pantallas que todavía llamen a la
+// búsqueda "aleatoria" original obtienen la búsqueda por nivel, que es
+// su sustituta directa (misma firma salvo el nuevo parámetro myLvl).
+async function findRandomTarget(myUid, myLvl, myRecentTargets) {
+  return findTargetByLevel(myUid, myLvl, myRecentTargets);
 }
 
 // ─────────────────────────────────────────────────────────────────────
@@ -433,15 +570,26 @@
 }
 
 // ─────────────────────────────────────────────────────────────────────
-// RESOLVER INVASIÓN — se llama tras el minijuego, con el resultado
-// (won: boolean) que decidió el cliente. Recalcula la dificultad/tope de
-// robo del lado "servidor" (aquí: este mismo módulo, ver docs/DISEÑO.md
-// sección 0 sobre por qué esto no es un servidor de verdad) en vez de
-// confiar en un stolenAmount que mandara la pantalla del minijuego, y
-// vuelve a leer el escudo del defensor en tiempo real por si se activó
-// justo entre la búsqueda y ahora.
-// ─────────────────────────────────────────────────────────────────────
-// ⚠️ LIMITACIÓN CONOCIDA DE ESTA FASE (aislada, sin tocar el juego padre):
+// FASE 1 — LANZAMIENTO DEL MISIL (ataque): sustituye a la antigua
+// resolveInvasion() de una sola fase. Ahora el resultado NO se decide
+// aquí — solo se registra la puntuación del atacante (attackScore,
+// calculada por minigame.html con computeAimScore()) y el ataque queda
+// en estado 'pending' hasta que el defensor juegue su propio minijuego
+// (ver resolveDuel() más abajo). Aun así, esta función SÍ aplica de
+// inmediato el cooldown/contador diario del atacante — igual que antes,
+// lanzar el misil consume el cupo de invasión aunque el duelo tarde en
+// resolverse; no tendría sentido dejar lanzar misiles gratis mientras el
+// defensor no conecta.
+//
+// Recalcula la dificultad del lado "servidor" (este módulo, ver
+// docs/DISEÑO.md sección 0) a partir de los niveles reales leídos ahora
+// mismo, no de los que traiga la pantalla — mismo criterio que ya tenía
+// resolveInvasion().
+// ─────────────────────────────────────────────────────────────────────
+// ⚠️ LIMITACIÓN CONOCIDA DE ESTA FASE (aislada, sin tocar el juego padre;
+// heredada tal cual del diseño de una sola fase, sigue aplicando igual
+// con el flujo de dos fases — el movimiento real de clk ahora ocurre en
+// resolveDuel(), no aquí, pero el resto del razonamiento es idéntico):
 // invasion_players/{uid}.clk parte de saves/{uid}.clk como fuente inicial,
 // pero syncProfileFromMainSave() compara updatedAt entre ambos documentos
 // y NO deja que un saves/ desactualizado pise un robo más reciente (ver
@@ -464,7 +612,8 @@
 // fuente de verdad para clk, y es exactamente el problema que resolver
 // en integración: decidir si invasion_players pasa a ser la fuente de
 // verdad de clk, o si cada robo escribe también en saves/{uid}.
-async function resolveInvasion({ attackerUid, defenderUid, won, isRevenge }) {
+// ─────────────────────────────────────────────────────────────────────
+async function createPendingAttack({ attackerUid, defenderUid, attackScore, isRevenge }) {
   const [attackerSnap, defenderSnap] = await Promise.all([
     getDoc(doc(db, 'invasion_players', attackerUid)),
     getDoc(doc(db, 'invasion_players', defenderUid)),
@@ -476,81 +625,153 @@
   const defender = defenderSnap.data();
   const now = Date.now();
 
+  if (!isInvasionUnlocked(attacker.lvl)) throw new Error('Invasión bloqueada hasta nivel ' + CFG.MIN_LEVEL_TO_UNLOCK);
   const invadeCheck = checkCanInvade(attacker);
   if (!invadeCheck.ok) throw new Error('No se puede invadir ahora mismo: ' + invadeCheck.reason);
   if ((defender.shieldUntil || 0) > now) throw new Error('El objetivo activó un escudo justo ahora');
 
-  // isRevenge llega del cliente (search.html -> sessionStorage ->
-  // minigame.html) sin que nada lo haya verificado hasta aquí de forma
-  // obligatoria: search.html SÍ revalida antes de dejar avanzar al
-  // minijuego (ver searchDirectTarget()), pero eso es una comodidad de
-  // UI, no una barrera — nada impide llegar a minigame.html saltándose
-  // search.html por completo, con invasion_battle_is_revenge='1'
-  // escrito a mano en sessionStorage (DevTools) contra un objetivo que
-  // nunca atacó a este jugador. isRevenge no afecta al robo en sí
-  // (mismo tier/stolenAmount, mismo cooldown, mismo límite diario que un
-  // ataque normal — es puramente informativo, ver el campo isRevenge más
-  // abajo), pero si se guardara falso en invasion_attacks corrompería la
-  // contabilidad que getActiveRevengeTarget()/hasRevengedAttack() usan
-  // para decidir avisos y botones "Vengarse" futuros (ver esas
-  // funciones). Por eso se revalida aquí, en el único paso por el que
-  // OBLIGATORIAMENTE pasa cualquier resultado, sea cual sea la pantalla
-  // de origen. Si no es legítimo, se degrada a false en vez de
-  // rechazar la invasión entera: el ataque jugado sigue siendo válido,
-  // lo único falso era la etiqueta de "venganza".
+  // isRevenge llega del cliente sin que nada lo haya verificado de forma
+  // obligatoria hasta aquí (mismo razonamiento que tenía la resolución
+  // de una sola fase: search.html ya revalida como comodidad de UI, pero
+  // esta es la única parada por la que pasa TODO ataque sea cual sea su
+  // origen). Si no es legítimo se degrada a false en vez de rechazar el
+  // ataque completo.
   const revengeIsLegit = !!isRevenge && await isLegitimateRevenge(attackerUid, defenderUid);
 
   const tier = difficultyFor(attacker.lvl, defender.lvl);
-  let stolenAmount = 0;
-  if (won) {
-    const rawMax = Math.floor((defender.clk || 0) * tier.robMax);
-    const capByFloor = Math.max(0, (defender.clk || 0) - CFG.MIN_CLK_LEFT_AFTER_ROB);
-    stolenAmount = Math.max(0, Math.min(rawMax, capByFloor));
-  }
+  const score = Math.max(0, Math.min(100, Math.round(attackScore)));
 
   const dayKey = todayKeyUTC();
   const newInvasionsToday = attacker.invasionsDayKey === dayKey ? (attacker.invasionsToday || 0) + 1 : 1;
   const newRecentTargets = { ...(attacker.recentTargets || {}), [defenderUid]: now };
 
   const batch = writeBatch(db);
-
-  // Un único update por documento en el batch (evitamos depender de que
-  // varias llamadas .update() sobre el mismo doc se fusionen — aunque
-  // writeBatch sí lo hace, es más claro dejarlo explícito en un solo objeto).
-  const attackerUpdate = {
+  batch.update(doc(db, 'invasion_players', attackerUid), {
     lastInvasionAt: now,
     invasionsToday: newInvasionsToday,
     invasionsDayKey: dayKey,
     recentTargets: newRecentTargets,
     updatedAt: serverTimestamp(),
-  };
+  });
+
+  const attackId = `${attackerUid}_${now}`;
+  batch.set(doc(db, 'invasion_attacks', attackId), {
+    attackerUid, attackerAlias: attacker.alias || 'Jugador',
+    defenderUid, defenderAlias: defender.alias || 'Jugador',
+    attackerLvl: attacker.lvl || 1, defenderLvl: defender.lvl || 1,
+    difficulty: tier.key,
+    attackScore: score,
+    defenseScore: null,
+    status: 'pending',
+    won: false, stolenAmount: 0, // se rellenan de verdad al resolver (resolveDuel); placeholders válidos para las Rules mientras está pendiente
+    isRevenge: revengeIsLegit,
+    createdAt: serverTimestamp(),
+  });
+
+  await batch.commit();
+  return { attackId, attackScore: score, difficulty: tier };
+}
+
+// ─────────────────────────────────────────────────────────────────────
+// FASE 2 — INTERCEPCIÓN (defensa) Y RESOLUCIÓN DEL DUELO: se llama tras
+// el minijuego de defensa, con defenseScore (0-100, calculado por
+// defense.html con la misma computeAimScore() que el ataque). Compara
+// attackScore contra defenseScore (spec sección 5: el defensor gana
+// cuando su puntuación es MAYOR; empate favorece al defensor) y, a
+// partir de ahí, reutiliza EXACTAMENTE la misma lógica de robo que ya
+// existía en la resolución de una sola fase — no se crea una segunda
+// fórmula de recompensas, solo se mueve el punto en el tiempo en el que
+// se conoce el resultado.
+//
+// Vuelve a leer invasion_attacks/{attackId} (no se fía del attackScore
+// que pudiera traer la pantalla de defensa) y vuelve a leer ambos
+// perfiles/el escudo del defensor en tiempo real, mismo criterio
+// anti-trampa "difícil de explotar, no imposible" documentado en
+// docs/DISEÑO.md sección 0.
+// ─────────────────────────────────────────────────────────────────────
+async function resolveDuel({ attackId, defenderUid, defenseScore }) {
+  const attackRef = doc(db, 'invasion_attacks', attackId);
+  const attackSnap = await getDoc(attackRef);
+  if (!attackSnap.exists()) throw new Error('Ataque no encontrado');
+  const attack = attackSnap.data();
+
+  if (attack.status !== 'pending') throw new Error('Este ataque ya fue resuelto');
+  if (attack.defenderUid !== defenderUid) throw new Error('Este ataque no es tuyo para defender');
+
+  const [attackerSnap, defenderSnap] = await Promise.all([
+    getDoc(doc(db, 'invasion_players', attack.attackerUid)),
+    getDoc(doc(db, 'invasion_players', defenderUid)),
+  ]);
+  if (!attackerSnap.exists() || !defenderSnap.exists()) {
+    throw new Error('Perfil de invasión no encontrado');
+  }
+  const attacker = attackerSnap.data();
+  const defender = defenderSnap.data();
+  const now = Date.now();
+
+  const dScore = Math.max(0, Math.min(100, Math.round(defenseScore)));
+  const aScore = attack.attackScore || 0;
+
+  // Spec sección 5: el defensor gana cuando SU puntuación es superior a
+  // la del atacante; en caso de empate se favorece al defensor (won se
+  // refiere aquí, igual que en el esquema original, a "ganó el
+  // ATACANTE" — así que empate → won=false, MISIL INTERCEPTADO).
+  const won = aScore > dScore;
+
+  const tier = difficultyFor(attacker.lvl || attack.attackerLvl || 1, defender.lvl || attack.defenderLvl || 1);
+  let stolenAmount = 0;
+  if (won) {
+    const rawMax = Math.floor((defender.clk || 0) * tier.robMax);
+    const capByFloor = Math.max(0, (defender.clk || 0) - CFG.MIN_CLK_LEFT_AFTER_ROB);
+    stolenAmount = Math.max(0, Math.min(rawMax, capByFloor));
+  }
+
+  const batch = writeBatch(db);
 
   if (stolenAmount > 0) {
     const newAttackerClk = (attacker.clk || 0) + stolenAmount;
     const newDefenderClk = Math.max(0, (defender.clk || 0) - stolenAmount);
-    attackerUpdate.clk = newAttackerClk;
+    batch.update(doc(db, 'invasion_players', attack.attackerUid), {
+      clk: newAttackerClk, updatedAt: serverTimestamp(),
+    });
     batch.update(doc(db, 'invasion_players', defenderUid), {
       clk: newDefenderClk, lastAttackedAt: now, updatedAt: serverTimestamp(),
     });
-    batch.set(doc(db, 'invasion_targets', attackerUid), { clk: newAttackerClk }, { merge: true });
+    batch.set(doc(db, 'invasion_targets', attack.attackerUid), { clk: newAttackerClk }, { merge: true });
     batch.set(doc(db, 'invasion_targets', defenderUid), { clk: newDefenderClk }, { merge: true });
   }
 
-  batch.update(doc(db, 'invasion_players', attackerUid), attackerUpdate);
-
-  const attackId = `${attackerUid}_${now}`;
-  batch.set(doc(db, 'invasion_attacks', attackId), {
-    attackerUid, attackerAlias: attacker.alias || 'Jugador',
-    defenderUid, defenderAlias: defender.alias || 'Jugador',
-    attackerLvl: attacker.lvl || 1, defenderLvl: defender.lvl || 1,
-    difficulty: tier.key, won: !!won, stolenAmount,
-    isRevenge: revengeIsLegit,
-    createdAt: serverTimestamp(),
+  batch.update(attackRef, {
+    defenseScore: dScore,
+    status: 'resolved',
+    won: !!won,
+    stolenAmount,
+    resolvedAt: serverTimestamp(),
   });
 
   await batch.commit();
+  return { won: !!won, stolenAmount, difficulty: tier, attackScore: aScore, defenseScore: dScore, attackId };
+}
 
-  return { won: !!won, stolenAmount, difficulty: tier, attackId };
+// ─────────────────────────────────────────────────────────────────────
+// ATAQUES PENDIENTES DE UN DEFENSOR — spec sección 6: el ataque queda
+// registrado mientras el defensor no lo haya resuelto, incluso si
+// estaba offline cuando se lanzó. Se listan aquí para que index.html
+// pinte la notificación ("Fulano te ha atacado") y enlace al minijuego
+// de defensa. Puede haber más de uno a la vez (varios atacantes
+// distintos pueden tener un misil pendiente contra el mismo defensor
+// simultáneamente; cada uno se resuelve por separado con resolveDuel()).
+// ─────────────────────────────────────────────────────────────────────
+async function getPendingAttacksFor(uid, max = 20) {
+  const q = query(
+    collection(db, 'invasion_attacks'),
+    where('defenderUid', '==', uid),
+    where('status', '==', 'pending'),
+    orderBy('createdAt', 'desc'),
+    limit(max)
+  );
+  const snap = await getDocs(q);
+  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
 }
 
 // ─────────────────────────────────────────────────────────────────────
@@ -624,6 +845,13 @@
 // findRandomTarget() para recentTargets.
 // ─────────────────────────────────────────────────────────────────────
 async function getActiveRevengeTarget(uid) {
+  // where('won','==',true) ya excluye por sí solo los ataques todavía
+  // 'pending' del nuevo flujo de dos fases: mientras un ataque está
+  // pendiente, won se guarda como placeholder false (ver
+  // createPendingAttack()) y solo pasa a reflejar el resultado real de
+  // won al llegar a resolveDuel() — así que un misil que el defensor
+  // aún no ha interceptado/dejado pasar nunca puede colarse aquí como
+  // "ataque ganado pendiente de vengar" antes de tiempo.
   const q = query(
     collection(db, 'invasion_attacks'),
     where('defenderUid', '==', uid),
@@ -653,6 +881,14 @@
 // Se usa desde getActiveRevengeTarget() (arriba) y desde las pantallas
 // que pintan el botón "Vengarse" por fila de historial (mismo criterio
 // para ambos sitios, ver index.html/loadHistory()).
+//
+// Nota flujo de dos fases: esto NO filtra por status, así que un misil
+// de venganza todavía 'pending' (el agresor original aún no lo ha
+// defendido) YA cuenta aquí como "venganza lanzada" — a propósito, igual
+// que en un ataque normal LANZAR el misil es lo que consume el cooldown
+// y el cupo diario (ver createPendingAttack()), independientemente de
+// cómo acabe el duelo. "Vengarse" es la acción de lanzar el misil de
+// revancha, no depende de acertar el tap.
 async function hasRevengedAttack(uid, revengeTargetUid, sinceMs) {
   const q = query(
     collection(db, 'invasion_attacks'),
@@ -864,9 +1100,10 @@
 // ─────────────────────────────────────────────────────────────────────
 window.InvasionCore = {
   CFG, db, auth, authReady,
-  difficultyFor, todayKeyUTC, shieldCost,
-  syncProfileFromMainSave, findRandomTarget, checkCanInvade,
-  resolveInvasion, activateShield, getActiveRevengeTarget, hasRevengedAttack, isLegitimateRevenge, getAttackHistory, getAttackHistoryPage,
+  difficultyFor, todayKeyUTC, shieldCost, isInvasionUnlocked, computeAimScore,
+  syncProfileFromMainSave, findRandomTarget, findTargetByLevel, checkCanInvade,
+  createPendingAttack, resolveDuel, getPendingAttacksFor,
+  activateShield, getActiveRevengeTarget, hasRevengedAttack, isLegitimateRevenge, getAttackHistory, getAttackHistoryPage,
   doc, getDoc, // se re-exportan por si una pantalla necesita leer algo puntual
   initInvasionBgm, // arranca la música de fondo del modo Invasión (loop, respeta cck4_muted)
   pauseInvasionBgm, resumeInvasionBgm, // para no solapar con el audio propio del video de intro
