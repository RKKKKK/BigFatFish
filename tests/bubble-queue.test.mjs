import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const { create } = browserModule('bubble-queue.js');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const timers = new Set(), draws = [], log = [];
  const queue = create({
    show: item => { log.push('show ' + item.id); return new Promise(resolve => draws.push({ item, resolve })); },
    hide: () => log.push('hide'),
    setTimeout: (run, ms) => { const timer = { run, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  // Runs the pending timer with the given delay, as if that much time passed.
  const elapse = async ms => {
    const timer = [...timers].find(item => item.ms === ms);
    assert.ok(timer, 'no timer for ' + ms + ' ms');
    timers.delete(timer); timer.run(); await settle();
  };
  const draw = async (committed = true) => { draws.shift().resolve(committed); await settle(); };
  return { queue, timers, draws, log, elapse, draw };
}

test('system bubbles show one at a time by rank, each timed from when it is on screen', async () => {
  const { queue, timers, log, elapse, draw } = harness();
  queue.push({ id: 'cost', kind: 'cost', rank: 3, ttlMs: 5000 });
  queue.push({ id: 'alert', kind: 'alert', rank: 2, ttlMs: 6500 });
  queue.push({ id: 'later-alert', kind: 'alert', ttlMs: 6500 });
  assert.deepEqual(log, [], 'arrivals are batched briefly so rank decides the order');
  await elapse(30);
  assert.deepEqual(log, ['show alert']);
  assert.equal(queue.current().id, 'alert');
  assert.deepEqual([...timers].map(timer => timer.ms), [], 'the display time starts once the bubble is drawn');
  await draw();
  await elapse(6500);
  await draw();
  await elapse(6500);
  await draw();
  await elapse(5000);
  assert.deepEqual(log, ['show alert', 'show later-alert', 'show cost', 'hide']);
  assert.equal(queue.current(), null);
});

test('an approval interrupts at once, keeps the interrupted bubble for later, and stays until dismissed', async () => {
  const { queue, timers, log, elapse, draw } = harness();
  queue.push({ id: 'cost', kind: 'cost', rank: 3, ttlMs: 5000 });
  await elapse(30); await draw();
  queue.approval({ id: 'approve-1' });
  assert.equal(queue.current().kind, 'approval');
  assert.deepEqual([...timers], [], 'the interrupted bubble stops counting down');
  await draw();
  assert.deepEqual([...timers], [], 'an approval has no display time');
  queue.approval({ id: 'approve-2' });
  await draw();
  queue.dismiss();
  assert.deepEqual(log, ['show cost', 'show approve-1', 'show approve-2', 'show cost'], 'a newer approval replaces the older one');
  await draw();
  await elapse(5000);
  assert.equal(log.at(-1), 'hide');
  assert.equal(queue.dismiss(), false, 'nothing left to dismiss');
});

test('a bubble that cannot be drawn is skipped instead of blocking later ones', async () => {
  const { queue, log, elapse, draw } = harness();
  queue.push({ id: 'broken', kind: 'alert', ttlMs: 6500 });
  await elapse(30);
  await draw(false);
  assert.equal(queue.current(), null);
  assert.deepEqual(log, ['show broken'], 'the renderer already kept what was on screen');
  queue.push({ id: 'next', kind: 'cost', rank: 3, ttlMs: 5000 });
  await elapse(30);
  assert.deepEqual(log, ['show broken', 'show next']);
});

test('clearing drops queued and showing bubbles, and ignores their late results', async () => {
  const { queue, timers, log, elapse, draw } = harness();
  queue.push({ id: 'a', kind: 'cost', rank: 3, ttlMs: 5000 });
  await elapse(30);
  queue.push({ id: 'b', kind: 'cost', rank: 3, ttlMs: 5000 });
  queue.clear();
  assert.deepEqual([...timers], []);
  await draw();
  assert.deepEqual([...timers], [], 'a draw finished after clearing starts no display time');
  assert.equal(queue.current(), null);
  assert.deepEqual(log, ['show a']);
});

test('clearing one kind drops it from the queue and the screen, and keeps the others', async () => {
  const { queue, log, elapse, draw } = harness();
  queue.push({ id: 'cost', kind: 'cost', rank: 3, ttlMs: 5000 });
  await elapse(30); await draw();
  queue.approval({ id: 'approve' });
  await draw();
  queue.push({ id: 'later-cost', kind: 'cost', rank: 3, ttlMs: 5000 });
  queue.push({ id: 'alert', kind: 'alert', ttlMs: 6500 });
  await elapse(30);
  queue.clear('cost');
  assert.equal(queue.current().kind, 'approval', 'a bubble of another kind stays on screen');
  queue.dismiss(); await draw();
  assert.deepEqual(log, ['show cost', 'show approve', 'show alert'], 'neither the interrupted nor the queued cost bubble returns');

  queue.push({ id: 'last-cost', kind: 'cost', rank: 3, ttlMs: 5000 });
  await elapse(6500); await draw();
  queue.clear('cost');
  assert.equal(queue.current(), null);
  assert.deepEqual(log.slice(-2), ['show last-cost', 'hide'], 'a cost bubble on screen closes');
});
