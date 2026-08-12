# Modo Invasión — Diseño técnico

> Este documento vive junto al código porque el propio código lo referencia
> en comentarios. Léelo antes de tocar `js/invasion-core.js` o las Rules.

## 0. Decisión de arquitectura (importante, léelo primero)

El proyecto padre (`CryptoClick-main`) es **100% estático**: Vercel sirviendo
HTML/JS + Firebase client SDK (Auth + Firestore). No hay Cloud Functions ni
backend propio — la única lógica "de servidor" que existe hoy son las
`firestore.rules`, que **validan documentos** (forma, tipos, rangos) pero no
pueden **decidir** nada (no eligen un rival al azar, no resuelven un
minijuego, no generan aleatoriedad segura).

La spec original pide que "toda la lógica... se ejecute exclusivamente en
el servidor". Con la arquitectura actual eso no es posible sin añadir
Cloud Functions. Se decidió explícitamente:

**Todo el cálculo (elegir rival, resolver minijuego, aplicar robo) corre en
el cliente. Firestore Rules es la única barrera anti-trampa real.**

Esto significa: un jugador con DevTools abiertos *puede* leer el algoritmo,
entender el minijuego, o intentar llamar a las funciones de escritura con
valores fabricados a mano. Las Rules están escritas para que esos intentos
se rechacen en el momento de escribir (rango de robo, cooldowns por
`serverTimestamp`, límites diarios, doble-escritura atómica) — pero esto es
"difícil de explotar", no "imposible". Si en el futuro se quiere cerrar
ese hueco del todo, la vía es mover `resolveInvasion()` a una Cloud
Function callable y que el cliente deje de escribir `invasion_attacks`
directamente. Documentado aquí para que quien retome esto no lo redescubra
desde cero.

## 1. Colecciones Firestore (nuevas, aisladas de saves/ y leaderboard/)

Prefijo `invasion_` para que convivan sin colisión con las colecciones del
juego padre, y para que integrar más adelante sea añadir, no migrar.

### `invasion_players/{uid}`
Documento propio de cada jugador. Es el "estado" del modo Invasión —
análogo a lo que `saves/{uid}` es para el juego principal, pero con campos
planos (no un blob JSON), porque aquí SÍ necesitamos que Firestore Rules
valide campo a campo (igual que ya hacen con `leaderboard/{uid}`).

```
{
  alias: string,              // copiado de saves/{uid} al entrar (max 16)
  lvl: number,                // copiado de saves/{uid} al entrar
  clk: number,                // saldo robable — normalmente espejo de
                               // saves/{uid}.clk, pero si invasion_players
                               // tiene un movimiento MÁS RECIENTE (robo
                               // ganado o sufrido) que el último guardado
                               // del padre, ese valor prevalece — ver
                               // syncProfileFromMainSave() y el comentario
                               // grande sobre resolveInvasion() en
                               // invasion-core.js
  shieldUntil: number,        // epoch ms; 0 o pasado = sin escudo
  shieldType: string,         // '6h' | '24h' | '3d' | '7d' | ''
  accountCreatedAt: number,   // epoch ms, se fija una vez, protege cuentas nuevas
  lastAttackedAt: number,     // epoch ms del último robo sufrido
  lastInvasionAt: number,     // epoch ms de la última invasión LANZADA (cooldown)
  invasionsToday: number,     // contador diario de invasiones lanzadas
  invasionsDayKey: string,    // 'YYYY-MM-DD' UTC, para saber cuándo resetear
  recentTargets: { [uid]: number }, // últimos objetivos atacados -> epoch ms
  updatedAt: serverTimestamp()
}
```

### `invasion_targets/{uid}`
Espejo mínimo de `invasion_players/{uid}`, con un campo extra `rand`
(0..1, se regenera en cada escritura). Existe solo porque Firestore no
tiene "SELECT ... ORDER BY random() LIMIT 1" nativo: la técnica estándar
es guardar un número aleatorio por doc y hacer
`where('rand','>=',x).limit(1)` (con fallback `<=x` si no hay resultados
por arriba). Se escribe a la vez que `invasion_players` (mismo batch).

```
{
  alias: string,
  lvl: number,
  clk: number,
  shieldUntil: number,
  accountCreatedAt: number,
  rand: number
}
```

### `invasion_attacks/{attackId}`
Log de cada invasión resuelta (ganada o perdida). Es a la vez "historial
de robos" y la fuente para "quién me atacó" (venganza): no hace falta
colección aparte, se consulta con
`where('defenderUid','==',uid).orderBy('createdAt','desc').limit(1)`.

```
{
  attackerUid: string,
  attackerAlias: string,
  defenderUid: string,
  defenderAlias: string,
  attackerLvl: number,
  defenderLvl: number,
  difficulty: string,       // 'muy_facil'|'facil'|'normal'|'dificil'|'muy_dificil'
  won: boolean,
  stolenAmount: number,     // 0 si won=false
  isRevenge: boolean,
  createdAt: serverTimestamp()
}
```

## 2. Dificultad según diferencia de nivel

`diff = lvlInvasor - lvlDefensor`. Define el layout del minijuego
(cuántos intentos/tiempo) y el % máximo robable.

| diff          | etiqueta       | tiempo minijuego | intentos | robo máx. |
|---------------|----------------|------------------|----------|-----------|
| diff >= 10    | muy_facil      | 20s              | 4        | 18%       |
| 4..9          | facil          | 17s              | 3        | 15%       |
| -3..3         | normal         | 14s              | 3        | 12%       |
| -9..-4        | dificil        | 11s              | 2        | 8%        |
| diff <= -10   | muy_dificil    | 10s              | 2        | 5%        |

Nota: un invasor de nivel MUY inferior al defensor puede seguir atacando
(la spec no lo prohíbe, solo dice que es "casi imposible") — lo que baja
es el tiempo/intentos del minijuego y el techo de robo.

## 3. Minijuego: Infiltración de la Base (9 compartimentos)

3 depósitos CLK · 3 trampas · 3 vacíos, posiciones barajadas en el
cliente al empezar. El jugador tiene `intentos` (de la tabla de
dificultad) dentro de `tiempo minijuego` segundos. Coste en intentos
por tipo de compartimento (cada clic resta UNA vez, no acumulable):
- Depósito → cuesta 0 intentos, suma a "encontrados", se marca.
- Trampa → cuesta 2 intentos (penalización: el doble que un vacío).
- Vacío → cuesta 1 intento, se marca, no aporta nada.
- Gana si encuentra los 3 depósitos antes de agotar tiempo/intentos.
- Pierde si se acaba el tiempo o los intentos sin encontrar los 3.

Con la tabla de intentos (4/3/3/2/2 según tier), esto hace que en los
tiers `dificil`/`muy_dificil` (2 intentos) una sola trampa acabe la
partida — coherente con la etiqueta "casi imposible" de ese tier.

El resultado (ganó/perdió) se calcula en el cliente y se manda a
`resolveInvasion()`, que es quien de verdad decide cuánto se roba (dentro
del techo de la tabla anterior) y escribe en Firestore. Como el cliente
"dice" si ganó, esto es exactamente el punto débil descrito en la sección
0 — un jugador podría intentar llamar a resolveInvasion() diciendo que
ganó sin haber jugado. Las Rules no pueden verificar "de verdad jugó el
minijuego", solo pueden acotar el daño: rango de robo válido, cooldown,
límite diario, nunca dejar al defensor en 0.

## 4. Protección contra abusos (todo vía Firestore Rules + checks cliente)

- **Cooldown entre invasiones**: 60s desde `lastInvasionAt`.
- **Límite diario**: 20 invasiones/día (`invasionsToday` + `invasionsDayKey`).
- **No repetir objetivo**: no se puede atacar al mismo `uid` dos veces en
  4 horas (`recentTargets[uid]`).
- **Cuentas nuevas**: un jugador con `accountCreatedAt` de menos de 24h no
  puede ser elegido como objetivo NI puede lanzar invasiones.
- **Nunca dejar a 0**: el robo nunca puede superar el `%` máximo de la
  tabla de dificultad Y además nunca puede dejar al defensor con menos de
  un mínimo absoluto de colchón (se implementa como tope adicional, no
  solo %, para saldos muy bajos).
- **Objetivo debe tener saldo robable**: `clk > MIN_CLK_PARA_SER_OBJETIVO`
  (si no, no aparece en `invasion_targets`).

## 5. Escudos

Tipos preparados: `6h`, `24h`, `3d`, `7d` (duración en horas: 6, 24, 72,
168). Solo `3d` y `7d` habilitados para compra en esta primera versión
(según el resumen final de la spec), pero el sistema soporta los 4 sin
cambios de esquema — activar `6h`/`24h` es solo añadirlos a la lista de
"comprables" en la UI.

Mientras `shieldUntil > now`, el jugador:
- No puede aparecer como objetivo (se filtra en la query de
  `invasion_targets` Y se revalida en el momento de resolver la invasión
  contra `invasion_players/{defenderUid}` real, por si el escudo se activó
  justo entre la búsqueda y el minijuego).
- Ve el contador de cuenta atrás en la interfaz.

## 6. Venganza

Al perder frente a un ataque (`invasion_attacks` con `won:true` contra ti),
tienes 24h desde `createdAt` para pulsar "Vengarse", que lanza una
invasión DIRECTA contra `attackerUid` (salta la búsqueda aleatoria, pero
pasa por las mismas validaciones de escudo/cooldown/límites — vengarse no
es una vía para saltarse las protecciones anti-abuso, solo para saltarse
la búsqueda aleatoria).

## 7. Notas para la fase de integración (no aplicadas todavía)

- **sw.js del padre**: usa network-first para navegaciones HTML y excluye
  Firebase de caché (`NEVER_CACHE_HOSTS`). El modo vive ahora en
  `/invasion/` (index.html, search.html, minigame.html) — añadir estas
  rutas nuevas no debería requerir tocar el service worker, pero si se
  quiere que funcionen offline como app shell, sí habría que añadir
  `/invasion/`, `/invasion/search.html` y `/invasion/minigame.html`
  (rutas completas, no solo el nombre del archivo) a `APP_SHELL_URLS`.
- **Sincronización de `clk` hacia saves/{uid}**: dentro del modo Invasión
  el saldo SÍ se ve correcto de inmediato tras un robo (syncProfileFromMainSave
  compara updatedAt entre invasion_players y saves/, y no deja que un
  saves/ desactualizado pise un robo más reciente). Lo que falta: ese
  cambio nunca se escribe DE VUELTA en saves/{uid}, así que el juego
  principal sigue sin saberlo — y si el jugador vuelve a jugar el juego
  principal, su autoguardado (cada ~20s, ver CLOUD_MIN_INTERVAL) puede
  sobreescribir saves/ con el saldo de antes del robo, momento en el
  cual el saldo mostrado en Invasión también "olvida" el robo (aunque
  el historial en invasion_attacks queda intacto). Ver el comentario
  grande encima de `resolveInvasion()` en invasion-core.js para el
  detalle completo — pendiente decidir en integración cómo unificar
  esto en una única fuente de verdad.
- **Botón de entrada al modo — y qué hacer con `/invasion.html`**: falta
  añadir en index.html del padre un botón/enlace hacia el modo nuevo, que
  ahora vive en `/invasion/` (esta carpeta). Pero el archivo suelto
  `/invasion.html` en la raíz del padre SIGUE EXISTIENDO — es el
  placeholder original (fondo, música, boot, sin lógica propia, ver su
  comentario "esta pantalla aún no tiene lógica propia") y hoy convive
  sin conflicto técnico con `/invasion/` (son rutas distintas), pero deja
  dos "modos Invasión" accesibles en el sitio. Antes de enlazar el botón
  de entrada, decidir: (a) el botón apunta a `/invasion/` y
  `/invasion.html` se borra o se convierte en un redirect hacia
  `/invasion/`, o (b) se reutiliza el fondo/música/boot de
  `/invasion.html` como base visual y se migra la lógica de `/invasion/`
  hacia ahí, eliminando la carpeta. No se ha tomado esa decisión aquí a
  propósito — afecta a un archivo del padre.
- **Coste de escudos en CLK**: activateShield() no cobra nada todavía
  (ver comentario en buyShield() de este index.html). Cuando se defina
  el coste, hay que restar del saldo ANTES de llamar a activateShield(),
  y decidir si esa resta también debe reflejarse en saves/{uid}.clk.
- **Notificación de robo — hoy es pasiva, no activa**: la spec pide "debe
  recibir una notificación" cuando te roban. Lo implementado es que
  index.html, al abrirse, consulta getActiveRevengeTarget() y muestra el
  panel de venganza si aplica — el jugador se entera la próxima vez que
  abre el modo, no en el momento del robo. Una notificación de verdad
  (push, mientras la app está cerrada) necesitaría Service Worker + Push
  API + un disparador del lado servidor (Cloud Messaging u otro), que es
  infraestructura nueva más allá de esta fase — no se ha construido a
  propósito, para no meter complejidad no pedida. Si se quiere en el
  futuro, el service worker del padre (sw.js) ya existe como punto de
  partida técnico para añadir un listener de push.
- **Despliegue de Rules e índices**: firestore/invasion.rules debe
  copiarse DENTRO del match /databases/.../documents del firestore.rules
  real del padre (Firestore solo permite un ruleset activo). Los índices
  de firestore/invasion.indexes.json se pueden crear de antemano o dejar
  que Firestore los pida la primera vez que la query falle en producción.
- **Audio**: index.html del padre usa `sounds/audiojuegoalien.mp3` (existe,
  funciona). invasion.html del padre referencia un nombre distinto,
  `sounds/audioinvasion.mp3`, que no aparece en la carpeta sounds/ del
  proyecto — puede ser intencional (pendiente de añadir) o un nombre a
  corregir. No urgente, no bloquea nada de este modo: las tres pantallas
  de aquí no referencian audio todavía.
