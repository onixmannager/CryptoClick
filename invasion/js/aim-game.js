/* ══════════════════════════════════════════════════════════════════════
   AIM GAME — motor compartido del minijuego de precisión (misil)
   ══════════════════════════════════════════════════════════════════════
   Usado por minigame.html (Ataque: lanzamiento del misil) y defense.html
   (Defensa: interceptación del misil). Es la MISMA mecánica en ambos
   casos -timing + precisión espacial, un único tap- tal y como pide la
   spec ("visualmente debe sentirse como una defensa, aunque la mecánica
   sea equivalente"): lo único que cambia entre pantallas es el vídeo, el
   texto y la paleta, nunca el cálculo de puntuación (ese vive en
   InvasionCore.computeAimScore(), invasion-core.js, para que ataque y
   defensa puntúen con exactamente la misma fórmula y sea imposible que
   se desincronicen con el tiempo).

   No depende de Firebase ni de nada de InvasionCore salvo
   computeAimScore()/CFG.AIM — se puede usar en cualquier pantalla que ya
   haya cargado invasion-core.js (mismo patrón que el resto del proyecto:
   <script type="module"> con import relativo).

   CONTRATO:
     const game = createAimGame({
       videoEl,              // <video> ya en el DOM, con su src puesto
       stageEl,               // contenedor sobre el que se centra el punto de mira
       countdownEl,           // elemento de texto para pintar 3/2/1/0,00
       onTap(result) {...},   // se llama tras el tap (o tras agotar la ventana) con {score, timingScore, spaceScore, timingMs, distancePx}
       zeroAtMs,               // instante del vídeo (ms desde que empieza a reproducirse) que corresponde a "0,00" — normalmente cerca del final, el fotograma de impacto/intercepción
       jitterMs,               // variación aleatoria +/- aplicada a zeroAtMs en cada partida (spec 9: "el momento exacto puede variar ligeramente"), 0 para desactivar
     });
     game.start(); // arranca el vídeo + cuenta atrás
   ══════════════════════════════════════════════════════════════════════ */

function createAimGame({ videoEl, stageEl, countdownEl, onTap, zeroAtMs, jitterMs = 0 }) {
  const core = window.InvasionCore;
  const AIM = core.CFG.AIM;

  let resolved = false;
  let zeroTimestamp = 0; // performance.now() del instante "0,00" real de esta partida
  let countdownTimers = [];
  let windowTimer = null;
  let tapListenerTarget = null;

  function clearTimers() {
    countdownTimers.forEach(t => clearTimeout(t));
    countdownTimers = [];
    if (windowTimer) { clearTimeout(windowTimer); windowTimer = null; }
  }

  function setCountdownText(txt) {
    if (countdownEl) countdownEl.textContent = txt;
  }

  // Distancia en px del punto de mira al centro EXACTO del área de
  // juego (stageEl), y el radio que vale "0 puntos" en el eje espacial
  // — se recalculan en cada partida por si el viewport cambió (rotación,
  // resize) en vez de cachear una sola vez al crear el motor.
  function measureStage() {
    const rect = stageEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxDistancePx = Math.min(rect.width, rect.height) * AIM.MAX_DISTANCE_RATIO;
    return { cx, cy, maxDistancePx };
  }

  function registerTap(clientX, clientY) {
    if (resolved) return;
    resolved = true;
    clearTimers();
    if (tapListenerTarget) tapListenerTarget.removeEventListener('pointerdown', onPointerDown);
    try { videoEl.pause(); } catch (e) {} // deja de correr de fondo tras el tap, no aporta nada una vez resuelto

    const timingMs = performance.now() - zeroTimestamp;
    const { cx, cy, maxDistancePx } = measureStage();
    const distancePx = Math.hypot(clientX - cx, clientY - cy);

    const withinWindow = Math.abs(timingMs) <= AIM.MAX_TIMING_MS;
    const result = core.computeAimScore(
      withinWindow ? timingMs : null,
      withinWindow ? distancePx : null,
      maxDistancePx
    );
    onTap({ ...result, timingMs, distancePx, tapped: true });
  }

  function onPointerDown(ev) {
    const p = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    registerTap(p.clientX, p.clientY);
  }

  function onWindowExpired() {
    if (resolved) return;
    resolved = true;
    clearTimers();
    if (tapListenerTarget) tapListenerTarget.removeEventListener('pointerdown', onPointerDown);
    try { videoEl.pause(); } catch (e) {}
    // No hubo tap dentro de la ventana válida: puntuación 0 en ambos
    // ejes (ver computeAimScore() con timingMs/distancePx null).
    const result = core.computeAimScore(null, null, 1);
    onTap({ ...result, timingMs: null, distancePx: null, tapped: false });
  }

  function start() {
    resolved = false;
    tapListenerTarget = stageEl;
    stageEl.addEventListener('pointerdown', onPointerDown);

    const jitter = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
    const targetVideoMs = Math.max(0, zeroAtMs + jitter);

    try { videoEl.currentTime = 0; } catch (e) {}
    const playPromise = videoEl.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});

    // Cuenta atrás 3→2→1→0,00 sincronizada con targetVideoMs: se calcula
    // hacia atrás desde el instante en que el vídeo llegará a
    // targetVideoMs, usando el reloj real (performance.now()) en vez de
    // fiarse de que el vídeo reproduzca a velocidad perfectamente
    // constante frame a frame — el conteo en pantalla es un timer de
    // reloj normal, el vídeo simplemente decora encima.
    const startTs = performance.now();
    const msToZero = targetVideoMs; // el vídeo arranca en t=0 junto con la cuenta atrás
    const stepMs = AIM.COUNTDOWN_MS / 3;
    const steps = ['3', '2', '1'];

    setCountdownText(steps[0]);
    steps.slice(1).forEach((label, i) => {
      countdownTimers.push(setTimeout(() => setCountdownText(label), stepMs * (i + 1)));
    });
    countdownTimers.push(setTimeout(() => setCountdownText('0,00'), Math.max(stepMs * 3, msToZero - 50)));

    zeroTimestamp = startTs + msToZero;
    const windowEndMs = msToZero + AIM.MAX_TIMING_MS;
    windowTimer = setTimeout(onWindowExpired, windowEndMs);
  }

  function destroy() {
    clearTimers();
    if (tapListenerTarget) tapListenerTarget.removeEventListener('pointerdown', onPointerDown);
    resolved = true;
  }

  return { start, destroy };
}

window.createAimGame = createAimGame;
