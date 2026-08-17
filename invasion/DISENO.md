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
ese hueco del todo, la vía es mover `createPendingAttack()`/`resolveDuel()`
a Cloud Functions callable y que el cliente deje de escribir
`invasion_attacks` directamente. Documentado aquí para que quien retome
esto no lo redescubra desde cero.

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
                               // grande sobre createPendingAttack() en
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
Log de cada invasión, ahora en **dos fases** (ver sección 3): se crea en
estado `pending` cuando el atacante lanza el misil, y pasa a `resolved`
cuando el defensor completa su minijuego de interceptación. Sigue siendo
a la vez "historial de robos" y la fuente para "quién me atacó"
(venganza) Y la fuente para "quién tengo pendiente de defender" (nuevo).

```
{
  attackerUid: string,
  attackerAlias: string,
  defenderUid: string,
  defenderAlias: string,
  attackerLvl: number,
  defenderLvl: number,
  difficulty: string,       // 'muy_facil'|'facil'|'normal'|'dificil'|'muy_dificil'
  attackScore: number,      // 0-100, puntuación del ATACANTE — se conoce desde el create
  defenseScore: number|null,// 0-100, puntuación del DEFENSOR — null mientras status='pending'
  status: string,           // 'pending' | 'resolved'
  won: boolean,             // placeholder false mientras pending; real solo tras resolved
  stolenAmount: number,     // placeholder 0 mientras pending; real solo tras resolved
  isRevenge: boolean,
  createdAt: serverTimestamp(),   // instante del lanzamiento (fase 1)
  resolvedAt: serverTimestamp(),  // instante de la interceptación (fase 2) — solo existe si status='resolved'
}
```

Consultas clave:
- Ataques pendientes de defender: `where('defenderUid','==',uid).where('status','==','pending').orderBy('createdAt','desc')` → `getPendingAttacksFor()`
- Venganza (último robo GANADO, ya resuelto): `where('defenderUid','==',uid).where('won','==',true).orderBy('createdAt','desc').limit(1)` → `getActiveRevengeTarget()` (won solo es `true` en documentos `resolved`, ver placeholder arriba)

## 2. Dificultad según diferencia de nivel

`diff = lvlInvasor - lvlDefensor`. Define el % máximo robable (el
minijuego de precisión, ver sección 3, ya no depende de la dificultad
para su duración/mecánica — esa es fija; lo que cambia con el tier es
solo el techo de robo).

| diff          | etiqueta       | robo máx. |
|---------------|----------------|-----------|
| diff >= 10    | muy_facil      | 30%       |
| 4..9          | facil          | 25%       |
| -3..3         | normal         | 20%       |
| -9..-4        | dificil        | 14%       |
| diff <= -10   | muy_dificil    | 10%       |

Nota: un invasor de nivel MUY inferior al defensor puede seguir atacando
(la spec no lo prohíbe, solo dice que es "casi imposible") — lo que baja
es el techo de robo. Los campos `tiempoMs`/`intentos` de cada tier en
`CFG.DIFFICULTY_TIERS` son un remanente del minijuego anterior (sección
3 vieja); ya no los usa el minijuego de precisión, pero se han dejado en
la config por si un futuro ajuste de dificultad quisiera diferenciar el
timing/ventana de tap también por tier (hoy `CFG.AIM` es fijo para
todos los tiers).

## 3. Minijuego: lanzamiento + interceptación de misil (timing + precisión)

Sustituye por completo al antiguo minijuego "Infiltración de la Base" (9
compartimentos) — ver `js/aim-game.js` para el motor compartido y
`CFG.AIM` en `invasion-core.js` para toda la config de dificultad de tap.

**Dos minijuegos independientes, mecánicamente idénticos, con vídeo y
tema visual distintos:**
- **Ataque** (`minigame.html`, vídeo `videos/ataque.mp4`): el jugador
  lanza el misil.
- **Defensa** (`defense.html`, vídeo `videos/defensa.mp4`): el jugador
  intercepta un misil ya lanzado contra él.

**Mecánica (igual en ambos):** el vídeo se reproduce, sobre él aparece
una cuenta atrás `3 → 2 → 1 → 0,00`. El jugador hace un único tap. La
puntuación (0-100) combina:
- **Timing:** distancia en ms entre el tap y el instante `0,00`
  (`CFG.AIM.MAX_TIMING_MS` es la ventana máxima; fuera de ella, 0 puntos
  de timing y se considera "no tapeó a tiempo").
- **Espacio:** distancia en px entre el tap y el centro exacto de la
  pantalla (`CFG.AIM.MAX_DISTANCE_RATIO` del lado menor del área de
  juego es el radio que vale 0 puntos).

Ambos ejes usan la misma curva de caída (`CFG.AIM.FALLOFF_POWER`,
ease-out) y se combinan con pesos configurables
(`CFG.AIM.WEIGHT_TIMING`/`WEIGHT_SPACE`, deben sumar 1). Ver
`computeAimScore()` en `invasion-core.js` — es la ÚNICA función que
calcula esta puntuación, usada por ambos minijuegos, para que no puedan
desincronizarse con el tiempo.

**Flujo de dos fases (spec 4-6):**
1. Atacante juega su minijuego → `attackScore` conocido de inmediato →
   `createPendingAttack()` crea el doc en `invasion_attacks` con
   `status:'pending'`. El cooldown/límite diario del atacante se aplica
   YA, en este paso — lanzar el misil consume el cupo aunque el
   defensor tarde en responder.
2. El ataque queda pendiente indefinidamente hasta que el defensor
   entra al modo Invasión (aunque haya estado offline) y ve la
   notificación "Fulano te ha atacado" (panel en `index.html`, ver
   `checkPendingAttacks()`).
3. Defensor juega su minijuego → `defenseScore` conocido → `resolveDuel()`
   compara `attackScore` vs `defenseScore` (defensor gana si su
   puntuación es MAYOR; empate favorece al defensor), calcula el robo
   con la MISMA fórmula de tier/robMax que ya existía, y marca el
   documento como `resolved`.

Como en el diseño anterior, el resultado final SÍ se decide en el
cliente (cada minijuego calcula su propia puntuación) y las Rules solo
acotan forma/rango — ver sección 0. La diferencia real de superficie de
abuso frente al diseño de una sola fase: antes un jugador podía intentar
llamar a `resolveInvasion()` fabricando `won:true` a mano; ahora tendría
que fabricar un `attackScore`/`defenseScore` a mano Y esperar a que la
otra parte del duelo sea legítima (o fabricar ambos lados, lo cual ya
requiere controlar las dos cuentas). No es una mejora de seguridad
fundamental, pero sí reduce el caso más simple de auto-abuso con una
sola cuenta.


## 4. Protección contra abusos (todo vía Firestore Rules + checks cliente)

- **Bloqueo por nivel** (nuevo): Invasión bloqueada para nivel 1 y 2, se
  desbloquea en nivel 3 (`CFG.MIN_LEVEL_TO_UNLOCK`). Revalidado en tres
  sitios: el enlace de entrada del padre (UX, evita el clic), el hub
  (`index.html`, botón deshabilitado) y `search.html`/`createPendingAttack()`
  (la validación real y autoritativa, por si se llega saltándose las dos
  anteriores).
- **Cooldown entre invasiones**: 60s desde `lastInvasionAt`. Se aplica al
  LANZAR el misil (`createPendingAttack()`), no al resolver el duelo — un
  ataque pendiente sin resolver sigue contando contra el cooldown/límite
  diario del atacante mientras espera al defensor.
- **Límite diario**: 20 invasiones/día (`invasionsToday` + `invasionsDayKey`).
- **No repetir objetivo**: no se puede atacar al mismo `uid` dos veces en
  4 horas (`recentTargets[uid]`).
- **Cuentas nuevas**: un jugador con `accountCreatedAt` de menos de 24h no
  puede ser elegido como objetivo NI puede lanzar invasiones.
- **Nunca dejar a 0**: el robo nunca puede superar el `%` máximo de la
  tabla de dificultad Y además nunca puede dejar al defensor con menos de
  un mínimo absoluto de colchón (se implementa como tope adicional, no
  solo %, para saldos muy bajos). Se calcula en `resolveDuel()`, con los
  saldos leídos en tiempo real en el momento en que el DEFENSOR resuelve
  el duelo (no en el momento en que el atacante lanzó el misil).
- **Objetivo debe tener saldo robable**: `clk > MIN_CLK_PARA_SER_OBJETIVO`
  (si no, no aparece en `invasion_targets`).
- **Ataques pendientes simultáneos**: un jugador puede tener varios
  ataques `pending` a la vez, de atacantes distintos — no se bloquea
  lanzar un misil solo porque el objetivo ya tenga otro ataque sin
  resolver. Cada duelo se resuelve de forma independiente. Decisión de
  diseño deliberada: las protecciones existentes (cooldown, límite
  diario, `recentTargets` de 4h) ya evitan que esto sea un vector de
  spam contra un mismo defensor, y bloquear objetivos "ocupados"
  penalizaría a atacantes legítimos por la mala suerte de que otro
  llegara antes.

## 5. Escudos

Tipos preparados: `6h`, `24h`, `3d`, `7d` (duración en horas: 6, 24, 72,
168). Solo `3d` y `7d` habilitados para compra en esta primera versión
(según el resumen final de la spec), pero el sistema soporta los 4 sin
cambios de esquema — activar `6h`/`24h` es solo añadirlos a la lista de
"comprables" en la UI.

Mientras `shieldUntil > now`, el jugador:
- No puede aparecer como objetivo (se filtra en la query de
  `invasion_targets` Y se revalida en `createPendingAttack()` contra
  `invasion_players/{defenderUid}` real, por si el escudo se activó
  justo entre la búsqueda y el lanzamiento del misil).
- Ve el contador de cuenta atrás en la interfaz.

## 6. Venganza

Al perder frente a un ataque (`invasion_attacks` con `status:'resolved'`
y `won:true` contra ti — es decir, tras resolver tu minijuego de defensa
y perderlo), tienes 24h desde `createdAt` para pulsar "Vengarse", que
lanza una invasión DIRECTA contra `attackerUid` (salta la búsqueda por
nivel, pero pasa por las mismas validaciones de escudo/cooldown/límites
— vengarse no es una vía para saltarse las protecciones anti-abuso, solo
para saltarse la búsqueda). El propio misil de venganza sigue el mismo
flujo de dos fases que cualquier otro ataque: queda `pending` hasta que
el agresor original lo defienda.

## 7. Notas para la fase de integración (no aplicadas todavía)

- **sw.js del padre**: usa network-first para navegaciones HTML y excluye
  Firebase de caché (`NEVER_CACHE_HOSTS`). El modo vive ahora en
  `/invasion/` (index.html, search.html, minigame.html, defense.html) —
  añadir estas rutas nuevas no debería requerir tocar el service worker,
  pero si se quiere que funcionen offline como app shell, sí habría que
  añadir `/invasion/`, `/invasion/search.html`, `/invasion/minigame.html`
  y `/invasion/defense.html` (rutas completas, no solo el nombre del
  archivo) a `APP_SHELL_URLS`.
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
  grande encima de `createPendingAttack()` en invasion-core.js para el
  detalle completo — pendiente decidir en integración cómo unificar
  esto en una única fuente de verdad.
- **Botón de entrada al modo — y qué hacer con `/invasion.html`**: el
  índice del padre ya enlaza a `/invasion/` (`guardInvasionLink()`, con
  bloqueo por nivel). Pero el archivo suelto `/invasion.html` en la raíz
  del padre SIGUE EXISTIENDO — es el placeholder original (fondo,
  música, boot, sin lógica propia, ver su comentario "esta pantalla aún
  no tiene lógica propia") y hoy convive sin conflicto técnico con
  `/invasion/` (son rutas distintas), pero deja dos "modos Invasión"
  accesibles en el sitio. Antes de cerrar integración, decidir: (a)
  `/invasion.html` se borra o se convierte en un redirect hacia
  `/invasion/`, o (b) se reutiliza el fondo/música/boot de
  `/invasion.html` como base visual y se migra la lógica de `/invasion/`
  hacia ahí, eliminando la carpeta. No se ha tomado esa decisión aquí a
  propósito — afecta a un archivo del padre.
- **Coste de escudos en CLK**: activateShield() no cobra nada todavía
  (ver comentario en buyShield() de este index.html). Cuando se defina
  el coste, hay que restar del saldo ANTES de llamar a activateShield(),
  y decidir si esa resta también debe reflejarse en saves/{uid}.clk.
- **Notificación de ataque pendiente — hoy es "al abrir la app", no
  push**: la spec pide que el defensor "reciba una notificación" al
  volver a entrar, incluso si estaba offline cuando le atacaron — esto
  SÍ está implementado: `checkPendingAttacks()` se llama en el boot() del
  hub y muestra un panel con cada ataque sin resolver ("Fulano te ha
  atacado" + botón Defender), consultando `invasion_attacks` con
  `status:'pending'` directamente, así que sobrevive a que el defensor
  haya estado offline cualquier cantidad de tiempo. Lo que NO está
  implementado es una notificación push de verdad (mientras la app está
  CERRADA, no solo "la próxima vez que se abre") — eso necesitaría
  Service Worker + Push API + un disparador del lado servidor (Cloud
  Messaging u otro), infraestructura nueva más allá de esta fase. Si se
  quiere en el futuro, el service worker del padre (sw.js) ya existe
  como punto de partida técnico para añadir un listener de push.
- **Vídeos de ataque/defensa**: `videos/ataque.mp4` y `videos/defensa.mp4`
  deben copiarse a `invasion/videos/` con esos nombres exactos —
  referenciados directamente por `minigame.html`/`defense.html`. El
  instante "0,00" se calcula por defecto cerca del final de cada vídeo
  (`duration*1000 - 400`ms, con jitter ±220ms entre partidas, ver
  `runGame()` en ambos archivos); si el momento de impacto/intercepción
  real del vídeo cae en otro punto, ajustar esa resta fija (o pasar un
  `zeroAtMs` explícito) por vídeo.
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
