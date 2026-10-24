// Offline tests for the Snake game logic (snake/logic.js is a classic browser script, so it's loaded via node:vm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Same realm on purpose: objects from vm.runInNewContext have a foreign Object.prototype,
// which makes assert.deepStrictEqual fail on structurally equal values.
const load = () => {
  vm.runInThisContext(fs.readFileSync(new URL('./logic.js', import.meta.url), 'utf8'));
  return globalThis.SnakeLogic;
};
const S = load();
const fixed = (v = 0) => () => v;

test('a new game starts centred, moving right, with food off the snake', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  assert.deepEqual(g.snake[0], { x: 5, y: 5 });
  assert.equal(g.snake.length, 3);
  assert.equal(g.dir, 'right');
  assert.ok(!g.snake.some((p) => p.x === g.food.x && p.y === g.food.y));
});

test('the snake moves one cell per step and keeps its length', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  S.step(g);
  assert.deepEqual(g.snake.map((p) => [p.x, p.y]), [[6, 5], [5, 5], [4, 5]]);
});

test('reversing straight into itself is ignored, even via a quick double-tap', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  S.turn(g, 'left');
  assert.deepEqual(g.queue, []);
  S.turn(g, 'up');
  S.turn(g, 'down'); // reverse of the queued 'up'
  assert.deepEqual(g.queue, ['up']);
  S.turn(g, 'left');
  S.step(g); S.step(g);
  assert.equal(g.over, false);
  assert.deepEqual(g.snake[0], { x: 4, y: 4 });
});

test('eating food grows the snake, scores, and respawns food elsewhere', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  g.food = { x: 6, y: 5 };
  S.step(g);
  assert.equal(g.score, 1);
  assert.equal(g.snake.length, 4);
  assert.ok(g.food && !g.snake.some((p) => p.x === g.food.x && p.y === g.food.y));
});

test('hitting a wall ends the game, unless wrap is on', () => {
  const g = S.createGame({ cols: 4, rows: 4, rng: fixed(0) }); // head at (2,2)
  S.step(g); assert.equal(g.over, false); // (3,2)
  S.step(g); assert.equal(g.over, true);
  const w = S.createGame({ cols: 4, rows: 4, wrap: true, rng: fixed(0) });
  S.step(w); S.step(w);
  assert.equal(w.over, false);
  assert.deepEqual(w.snake[0], { x: 0, y: 2 });
});

test('running into its own body ends the game', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  g.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 6, y: 4 }];
  S.turn(g, 'down');
  S.step(g);
  assert.equal(g.over, true);
});

test('moving into the cell the tail is leaving is allowed', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0.99) });
  g.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }]; // tail at (4,5)
  g.dir = 'up';
  S.turn(g, 'left');
  S.step(g);
  assert.equal(g.over, false);
  assert.deepEqual(g.snake[0], { x: 4, y: 5 });
});

test('filling the board wins; speed ramps up but has a floor', () => {
  const g = S.createGame({ cols: 2, rows: 2, rng: fixed(0) });
  g.snake = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  g.dir = 'right';
  g.food = { x: 1, y: 0 };
  S.step(g);
  assert.equal(g.won, true);
  assert.equal(g.over, true);
  assert.equal(S.tickMs(0), 140);
  assert.ok(S.tickMs(5) < S.tickMs(0));
  assert.equal(S.tickMs(1000), 60);
});

test('difficulty changes the starting speed and the speed floor; unknown levels act as normal', () => {
  assert.ok(S.tickMs(0, 'easy') > S.tickMs(0, 'normal'));
  assert.ok(S.tickMs(0, 'hard') < S.tickMs(0, 'normal'));
  assert.equal(S.tickMs(1000, 'easy'), S.LEVELS.easy.min);
  assert.equal(S.tickMs(1000, 'hard'), S.LEVELS.hard.min);
  assert.equal(S.tickMs(3, 'nope'), S.tickMs(3, 'normal'));
});

test('inherited property names are not accepted as directions or levels', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) S.turn(g, name);
  assert.deepEqual(g.queue, []);
  S.step(g);
  assert.deepEqual(g.snake[0], { x: 6, y: 5 });
  assert.equal(S.tickMs(3, 'toString'), S.tickMs(3, 'normal'));
  assert.equal(S.tickMs(3, '__proto__'), S.tickMs(3, 'normal'));
});

test('best scores are keyed per difficulty and wall mode; unknown levels use normal', () => {
  assert.equal(S.bestKey('easy'), 'snake.best.easy');
  assert.equal(S.bestKey('hard', true), 'snake.best.hard.wrap');
  assert.notEqual(S.bestKey('normal', true), S.bestKey('normal', false));
  assert.equal(S.bestKey('nope'), 'snake.best.normal');
  assert.equal(S.bestKey('__proto__'), 'snake.best.normal');
});

test('loading a best score falls back to the legacy key only for normal with walls', () => {
  const store = (obj) => (k) => (Object.hasOwn(obj, k) ? obj[k] : null);
  const legacy = store({ 'snake.best': '17' });
  assert.equal(S.loadBest(legacy, 'normal'), 17);
  assert.equal(S.loadBest(legacy, 'normal', true), 0);
  assert.equal(S.loadBest(legacy, 'hard'), 0);
  // A stored per-level value, even '0' after a reset, wins over the legacy key.
  assert.equal(S.loadBest(store({ 'snake.best': '17', 'snake.best.normal': '0' }), 'normal'), 0);
  assert.equal(S.loadBest(store({ 'snake.best.easy.wrap': '9' }), 'easy', true), 9);
});

test('junk, negative or fractional stored best scores read safely', () => {
  const one = (v) => () => v;
  assert.equal(S.loadBest(one('abc'), 'easy'), 0);
  assert.equal(S.loadBest(one('-5'), 'easy'), 0);
  assert.equal(S.loadBest(one('Infinity'), 'easy'), 0);
  assert.equal(S.loadBest(one('12.9'), 'easy'), 12);
  assert.equal(S.loadBest(one(null), 'easy'), 0);
});

test('stepping updates the snake array in place without changing its length', () => {
  const g = S.createGame({ cols: 10, rows: 10, rng: fixed(0) });
  const arr = g.snake;
  for (let i = 0; i < 3; i++) S.step(g);
  assert.equal(g.snake, arr);
  assert.equal(g.snake.length, 3);
  assert.deepEqual(g.snake[0], { x: 8, y: 5 });
});
