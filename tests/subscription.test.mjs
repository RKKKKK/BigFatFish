import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SessionParser } from '../runtime/session-monitor.mjs';
import { fixture } from './helpers/fixture.mjs';

function rateLimits(now) {
  return { limit_id: 'codex', plan_type: 'plus',
    primary: { used_percent: 25, window_minutes: 300, resets_at: Math.floor((now + 3600000) / 1000) },
    secondary: { used_percent: 60, window_minutes: 10080, resets_at: Math.floor((now + 86400000) / 1000) },
    account: 'private-account', access_token: 'private-token' };
}

function parserFor(service, onEnd = () => {}) {
  return new SessionParser({ id: 'session', defaultModel: 'test-model',
    onRateLimits: snapshot => service.updateSubscriptionRateLimits(snapshot),
    onRateLimitContext: context => service.updateSubscriptionRateLimitContext(context), onEnd });
}

function tokenEvent(parser, now, limits) {
  parser.accept({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count', rate_limits: limits } });
}

test('subscription windows expose remaining percentages and survive a restart without credentials', async t => {
  const { service, createService, dataDir } = fixture(t), now = Date.now();
  tokenEvent(parserFor(service), now, rateLimits(now));
  const result = service.subscriptionRateLimits();
  assert.equal(result.available, true);
  assert.equal(result.fiveHour.remainingPercent, 75);
  assert.equal(result.sevenDay.remainingPercent, 40);
  assert.equal(result.fiveHour.resetsAt, new Date(Math.floor((now + 3600000) / 1000) * 1000).toISOString());
  await service.close();
  assert.deepEqual(createService().subscriptionRateLimits(), result);
  const saved = fs.readFileSync(path.join(dataDir, 'subscription-rate-limits.json'), 'utf8');
  assert.doesNotMatch(saved, /private-account|private-token|access_token|account/);
});

test('a newer API event hides subscription data and older events cannot restore it', t => {
  const { service, createService } = fixture(t), now = Date.now(), parser = parserFor(service);
  tokenEvent(parser, now, rateLimits(now));
  tokenEvent(parser, now + 1000, undefined);
  assert.equal(service.subscriptionRateLimits().available, false);
  tokenEvent(parserFor(service), now - 1000, rateLimits(now));
  assert.equal(service.subscriptionRateLimits().available, false);
  assert.equal(createService().subscriptionRateLimits().available, false);
  tokenEvent(parser, now + 2000, rateLimits(now));
  assert.equal(service.subscriptionRateLimits().available, true);
});

test('missing, unrelated or incomplete windows fall back to API data', t => {
  const { service } = fixture(t), now = Date.now(), parser = parserFor(service);
  for (const malformed of [null, { ...rateLimits(now), limit_id: 'other' }, { ...rateLimits(now), secondary: null },
    { ...rateLimits(now), primary: { ...rateLimits(now).primary, window_minutes: 60 } }]) {
    tokenEvent(parser, now, rateLimits(now));
    tokenEvent(parser, now + 1000, malformed);
    assert.equal(service.subscriptionRateLimits().available, false);
  }
});

test('a window that has reset is hidden on its own while the other still shows', t => {
  const { service } = fixture(t), now = Date.now();
  for (const [key, hidden, shown] of [['primary', 'fiveHour', 'sevenDay'], ['secondary', 'sevenDay', 'fiveHour']]) {
    const limits = rateLimits(now);
    limits[key].resets_at = Math.floor((now - 1000) / 1000);
    tokenEvent(parserFor(service), now, limits);
    const result = service.subscriptionRateLimits();
    assert.equal(result.available, true);
    assert.equal(result[hidden], null);
    assert.ok(result[shown].remainingPercent > 0);
  }
  const limits = rateLimits(now);
  limits.primary.resets_at = limits.secondary.resets_at = Math.floor((now - 1000) / 1000);
  tokenEvent(parserFor(service), now + 1, limits);
  assert.equal(service.subscriptionRateLimits().available, false, 'with both windows reset there is nothing to show');
});

test('missing percentages are unavailable rather than a full unused quota', t => {
  const { service } = fixture(t), now = Date.now(), parser = parserFor(service);
  for (const used of [null, '', true]) {
    const limits = rateLimits(now);
    limits.primary.used_percent = used;
    tokenEvent(parser, now, limits);
    assert.equal(service.subscriptionRateLimits().available, false);
    assert.equal(service.updateSubscriptionRateLimits({ observedAt: now, planType: 'plus',
      fiveHour: { usedPercent: used, windowMinutes: 300, resetsAt: now + 1000 },
      sevenDay: { usedPercent: 60, windowMinutes: 10080, resetsAt: now + 1000 } }), false);
  }
});

test('a completed subscription turn carries its quota snapshot and not private session fields', t => {
  const { service } = fixture(t), now = Date.now(), ends = [];
  const parser = parserFor(service, event => ends.push(event));
  parser.accept({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'task_started', turn_id: 'turn' } });
  tokenEvent(parser, now, rateLimits(now));
  parser.accept({ type: 'event_msg', timestamp: new Date(now + 1000).toISOString(), payload: { type: 'task_complete', turn_id: 'turn' } });
  assert.equal(ends.length, 1);
  assert.equal(ends[0].notify, true);
  assert.equal(ends[0].subscriptionRateLimits.fiveHour.usedPercent, 25);
  assert.doesNotMatch(JSON.stringify(ends), /private-account|private-token/);
});
