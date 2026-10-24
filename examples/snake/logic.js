// Pure Snake game logic: no DOM, no timers. Loaded as a classic <script> in the
// browser (so index.html works straight from file://) and via node:vm in the tests.
(function (root) {
  'use strict';

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  function createGame({ cols = 20, rows = 20, wrap = false, rng = Math.random } = {}) {
    const cx = Math.floor(cols / 2);
    const cy = Math.floor(rows / 2);
    const state = {
      cols,
      rows,
      wrap,
      rng,
      snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }], // head first
      dir: 'right',
      queue: [], // buffered turns, so quick double-taps aren't lost
      food: null,
      score: 0,
      over: false,
      won: false,
    };
    state.food = placeFood(state);
    return state;
  }

  function placeFood(state) {
    const taken = new Set(state.snake.map((p) => p.x + ',' + p.y));
    const free = [];
    for (let y = 0; y < state.rows; y++)
      for (let x = 0; x < state.cols; x++) if (!taken.has(x + ',' + y)) free.push({ x, y });
    if (free.length === 0) return null;
    return free[Math.floor(state.rng() * free.length)];
  }

  // Queue a turn. Ignores unknown names, repeats and 180° reversals, checked against
  // the last *queued* direction so "up, left" quickly while moving right can't reverse.
  function turn(state, name) {
    if (!Object.hasOwn(DIRS, name) || state.over) return; // own keys only: 'toString' etc. aren't directions
    const last = state.queue.length ? state.queue[state.queue.length - 1] : state.dir;
    if (name === last || name === OPPOSITE[last]) return;
    if (state.queue.length < 3) state.queue.push(name);
  }

  // Advance one tick. Mutates and returns state.
  function step(state) {
    if (state.over) return state;
    if (state.queue.length) state.dir = state.queue.shift();
    const d = DIRS[state.dir];
    const head = state.snake[0];
    let next = { x: head.x + d.x, y: head.y + d.y };

    if (state.wrap) {
      next = { x: (next.x + state.cols) % state.cols, y: (next.y + state.rows) % state.rows };
    } else if (next.x < 0 || next.y < 0 || next.x >= state.cols || next.y >= state.rows) {
      state.over = true;
      return state;
    }

    const eating = !!state.food && next.x === state.food.x && next.y === state.food.y;
    // The tail moves out of the way this tick unless the snake is growing.
    const len = state.snake.length - (eating ? 0 : 1);
    for (let i = 0; i < len; i++) {
      if (state.snake[i].x === next.x && state.snake[i].y === next.y) {
        state.over = true;
        return state;
      }
    }

    // Mutate in place: no per-tick array copies.
    state.snake.unshift(next);
    if (!eating) state.snake.pop();
    if (eating) {
      state.score += 1;
      state.food = placeFood(state);
      if (!state.food) {
        state.won = true;
        state.over = true;
      }
    }
    return state;
  }

  // Tick length per difficulty: starting speed and the fastest it ever gets.
  const LEVELS = {
    easy: { start: 180, min: 90 },
    normal: { start: 140, min: 60 },
    hard: { start: 100, min: 45 },
  };

  // Milliseconds per tick: 5 ms faster per point, never below the level's floor.
  const tickMs = (score, level = 'normal') => {
    const l = Object.hasOwn(LEVELS, level) ? LEVELS[level] : LEVELS.normal;
    return Math.max(l.min, l.start - score * 5);
  };

  // Storage key for the best score: one per difficulty, and wrap mode (easier) kept separate.
  const bestKey = (level, wrap = false) =>
    'snake.best.' + (Object.hasOwn(LEVELS, level) ? level : 'normal') + (wrap ? '.wrap' : '');

  // Read a best score through get(key) -> string|null. Normal/walls falls back to the
  // pre-difficulty 'snake.best' key so old records survive. Junk or negative values read as 0.
  function loadBest(get, level, wrap = false) {
    let raw = get(bestKey(level, wrap));
    if (raw == null && !wrap && bestKey(level) === 'snake.best.normal') raw = get('snake.best');
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  root.SnakeLogic = { createGame, turn, step, placeFood, tickMs, bestKey, loadBest, DIRS, LEVELS };
})(globalThis);
