// Browser side: canvas drawing, keyboard/touch input, game loop. Logic lives in logic.js.
(function () {
  'use strict';
  const { createGame, turn, step, tickMs } = window.SnakeLogic;

  const CELL = 24;
  const COLS = 20;
  const ROWS = 20;
  const W = COLS * CELL;
  const H = ROWS * CELL;
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  // Render at device resolution so it stays crisp on HiDPI screens; draw in CSS pixels.
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The checkerboard never changes: paint it once offscreen, then blit it each frame.
  const bg = document.createElement('canvas');
  bg.width = W * dpr;
  bg.height = H * dpr;
  const bctx = bg.getContext('2d');
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.fillStyle = '#111';
  bctx.fillRect(0, 0, W, H);
  bctx.fillStyle = '#161616';
  for (let y = 0; y < ROWS; y++)
    for (let x = (y % 2); x < COLS; x += 2) bctx.fillRect(x * CELL, y * CELL, CELL, CELL);

  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const msgEl = document.getElementById('message');
  const wrapEl = document.getElementById('wrap');
  const levelEl = document.getElementById('level');
  const soundEl = document.getElementById('sound');

  // localStorage can throw (privacy mode, some file:// setups), so guard it.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  wrapEl.checked = store.get('snake.wrap') === '1';
  soundEl.checked = store.get('snake.sound') !== '0';
  const savedLevel = store.get('snake.level');
  if (savedLevel && Object.hasOwn(SnakeLogic.LEVELS, savedLevel)) levelEl.value = savedLevel;
  const bestKey = () => SnakeLogic.bestKey(levelEl.value, wrapEl.checked); // per difficulty + wrap
  let best = 0;
  let bestAtStart = 0;

  // Tiny Web Audio beeps: no sound files needed. The context is created on the first
  // key press, because browsers block audio until the user interacts with the page.
  let audio = null;
  function beep(freq, ms, type = 'square', vol = 0.06) {
    if (!soundEl.checked) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + ms / 1000);
    } catch { /* no audio support: play silently */ }
  }

  let game;
  let paused = false;
  let started = false;
  let acc = 0; // ms of game time owed
  let last = 0;

  function reset() {
    game = createGame({ cols: COLS, rows: ROWS, wrap: wrapEl.checked });
    paused = false;
    started = false;
    acc = 0;
    best = SnakeLogic.loadBest((k) => store.get(k), levelEl.value, wrapEl.checked);
    bestAtStart = best;
    show('Press an arrow key / WASD (or swipe) to start');
    draw();
  }

  function show(text) {
    msgEl.textContent = text;
    msgEl.hidden = !text;
  }

  const running = () => started && !paused && !game.over;

  function tick() {
    const before = game.score;
    step(game);
    if (game.score > before) beep(660 + game.score * 8, 70);
    if (game.score > best) {
      best = game.score;
      store.set(bestKey(), String(best));
    }
    if (game.over) {
      const record = game.score > bestAtStart ? ' · New best!' : '';
      if (game.won) {
        beep(880, 300, 'triangle');
        show(`You win! Score ${game.score}${record} · Enter to play again`);
      } else {
        beep(110, 350, 'sawtooth', 0.08);
        show(`Game over · Score ${game.score}${record} · Enter to restart`);
      }
    }
  }

  // Fixed-timestep loop on requestAnimationFrame: steps exactly every tickMs regardless of
  // frame rate, never drifts like chained setTimeouts, and idles in background tabs.
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(t - last, 250); // clamp so a long hiccup can't teleport the snake
    last = t;
    if (!running()) return;
    acc += dt;
    let stepped = false;
    while (running() && acc >= tickMs(game.score, levelEl.value)) {
      acc -= tickMs(game.score, levelEl.value);
      tick();
      stepped = true;
    }
    if (stepped) draw();
  }

  function start() {
    if (started || game.over) return;
    started = true;
    acc = 0;
    show('');
  }

  function togglePause() {
    if (!started || game.over) return;
    paused = !paused;
    show(paused ? 'Paused · Space to resume' : '');
  }

  // Switching tabs or minimising pauses the game instead of killing you off-screen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running()) togglePause();
  });

  function steer(dir) {
    if (game.over || paused) return;
    turn(game, dir);
    start();
  }

  // ctx.roundRect is fairly new; fall back to square cells on older browsers.
  const cell = (x, y, inset, r) => {
    const s = CELL - inset * 2;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x * CELL + inset, y * CELL + inset, s, s, r);
      ctx.fill();
    } else {
      ctx.fillRect(x * CELL + inset, y * CELL + inset, s, s);
    }
  };

  function draw() {
    ctx.drawImage(bg, 0, 0, W, H);

    if (game.food) {
      const fx = game.food.x * CELL + CELL / 2;
      const fy = game.food.y * CELL + CELL / 2;
      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      ctx.arc(fx, fy, CELL * 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.35)'; // highlight
      ctx.beginPath();
      ctx.arc(fx - CELL * 0.12, fy - CELL * 0.12, CELL * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body fades from bright at the head to darker at the tail.
    const n = game.snake.length;
    for (let i = n - 1; i >= 0; i--) {
      const p = game.snake[i];
      const light = 62 - Math.round((i / Math.max(1, n - 1)) * 22);
      ctx.fillStyle = i === 0 ? '#7bed9f' : `hsl(145, 63%, ${light - 20}%)`;
      cell(p.x, p.y, i === 0 ? 1 : 2, i === 0 ? 7 : 5);
    }

    // Eyes on the head, looking where it's going.
    const h = game.snake[0];
    const d = SnakeLogic.DIRS[game.dir];
    const hx = h.x * CELL + CELL / 2;
    const hy = h.y * CELL + CELL / 2;
    for (const side of [-1, 1]) {
      const ex = hx + d.x * CELL * 0.18 + -d.y * side * CELL * 0.2;
      const ey = hy + d.y * CELL * 0.18 + d.x * side * CELL * 0.2;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, CELL * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = game.over && !game.won ? '#e74c3c' : '#111';
      ctx.beginPath();
      ctx.arc(ex + d.x * CELL * 0.04, ey + d.y * CELL * 0.04, CELL * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }

    scoreEl.textContent = game.score;
    bestEl.textContent = best;
  }

  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
  };

  // Browsers only allow audio after a user gesture, so create/resume it from input handlers.
  function unlockAudio() {
    if (!soundEl.checked) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* no audio support */ }
  }

  document.addEventListener('keydown', (e) => {
    if (e.target === levelEl) return; // let the dropdown use arrow keys normally
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts (Ctrl+S, Ctrl+R, …) alone
    unlockAudio();
    if (e.key === 'm' || e.key === 'M') {
      soundEl.checked = !soundEl.checked;
      store.set('snake.sound', soundEl.checked ? '1' : '0');
    } else if (KEYS[e.key]) {
      e.preventDefault();
      steer(KEYS[e.key]);
    } else if (e.key === ' ' || e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      togglePause();
    } else if (e.key === 'Enter' || e.key === 'r' || e.key === 'R') {
      reset();
    }
  });

  // Touch: swipe to steer, tap to pause.
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    unlockAudio();
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return togglePause();
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });

  wrapEl.addEventListener('change', () => {
    store.set('snake.wrap', wrapEl.checked ? '1' : '0');
    reset();
    wrapEl.blur(); // keep Space/arrows going to the game, not the checkbox
  });
  levelEl.addEventListener('change', () => {
    store.set('snake.level', levelEl.value);
    reset();
    levelEl.blur();
  });
  soundEl.addEventListener('change', () => {
    store.set('snake.sound', soundEl.checked ? '1' : '0');
    soundEl.blur();
  });
  document.getElementById('restart').addEventListener('click', (e) => { reset(); e.currentTarget.blur(); });
  // Reset only the current mode's best. Store '0' rather than removing the key, so the
  // legacy 'snake.best' fallback can't bring an old record back.
  document.getElementById('reset-best').addEventListener('click', (e) => {
    e.currentTarget.blur();
    if (!window.confirm('Reset the best score for this difficulty and wall mode?')) return;
    store.set(bestKey(), '0');
    best = 0;
    bestAtStart = 0;
    draw();
  });

  reset();
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
})();
