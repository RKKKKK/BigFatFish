import assert from 'node:assert/strict';
import test from 'node:test';
import { balancePace, dailyAverage, limitPace, windowPace } from '../runtime/quota/pace.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const now = Date.parse('2026-10-05T12:00:00Z');

test('a subscription window projects its share at reset from its average rate so far', () => {
  assert.deepEqual(windowPace({ usedPercent: 40, windowMinutes: 300, resetsAt: now + 2.5 * HOUR, observedAt: now }),
    { projectedPercent: 80, exhaustAt: null }, 'half the window gone and 40% used: it lasts');
  assert.deepEqual(windowPace({ usedPercent: 60, windowMinutes: 300, resetsAt: new Date(now + 2.5 * HOUR).toISOString(), observedAt: now }),
    { projectedPercent: 120, exhaustAt: now + 100 * MINUTE }, 'at 60% in 2.5 hours the rest goes in 100 minutes');
  assert.equal(windowPace({ usedPercent: 5, windowMinutes: 300, resetsAt: now + 290 * MINUTE, observedAt: now }), null,
    'ten minutes into a window the rate says little');
  assert.equal(windowPace({ usedPercent: 5, windowMinutes: 300, resetsAt: now - MINUTE, observedAt: now }), null, 'a window that reset has no pace');
  assert.deepEqual(windowPace({ usedPercent: 0, windowMinutes: 10080, resetsAt: now + 3 * DAY, observedAt: now }), { projectedPercent: 0, exhaustAt: null });
});

test('money lasts by the average spend of the recent full days that are known', () => {
  assert.deepEqual(dailyAverage([{ total: 10 }, { total: null }, { total: 20 }]), { amount: 15, days: 2 });
  assert.equal(dailyAverage([{ total: null }, {}]), null);
  const resetsAt = now + 3.5 * DAY;
  assert.deepEqual(limitPace({ remaining: 170.49, resetsAt, average: { amount: 25 }, now }), { enough: true, exhaustAt: null });
  assert.deepEqual(limitPace({ remaining: 50, resetsAt: new Date(resetsAt).toISOString(), average: { amount: 25 }, now }),
    { enough: false, exhaustAt: now + 2 * DAY }, 'a quota that runs out before its reset says when');
  assert.deepEqual(limitPace({ remaining: 50, resetsAt, average: { amount: 0 }, now }), { enough: true, exhaustAt: null });
  assert.equal(limitPace({ remaining: 50, resetsAt, average: null, now }), null, 'no known spend, no pace');
  assert.deepEqual(balancePace({ amount: 45.2, average: { amount: 0.8 } }), { daysLeft: 56.5 });
  assert.equal(balancePace({ amount: 45.2, average: { amount: 0 } }), null, 'nothing spent lately: no estimate rather than forever');
  assert.equal(balancePace({ amount: null, average: { amount: 1 } }), null);
});
