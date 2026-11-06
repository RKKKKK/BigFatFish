import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { QuotaBook } from '../runtime/quota/book.mjs';
import { publicWindows } from '../runtime/quota/windows.mjs';
import { saveClaudeTurn } from '../runtime/claude-usage.mjs';
import { ChatService } from '../runtime/chat/service.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';
import { dayKey } from '../runtime/paths.mjs';
import { createChatClient } from '../desktop/ui/chat-client.js';
import { fixture, turn } from './helpers/fixture.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const petKey = 'synthetic-deepseek-key', relayKey = 'synthetic-relay-key';
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100 };
const reply = text => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n' +
  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

// Codex runs on DeepSeek with the key the pet also uses, and on a relay through
// a second config whose query link reports daily cost and a weekly key limit.
function setup(t, { billing = () => null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-book-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "deepseek"\n[model_providers.deepseek]\nbase_url = "https://api.deepseek.com/v1"\nenv_key = "DEEPSEEK_KEY"\n');
  fs.writeFileSync(path.join(codexHome, 'relay.toml'), 'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example.test/v1"\nenv_key = "RELAY_KEY"\n');
  const config = new ConfigStore({ codexHome, dataDir, env: { DEEPSEEK_KEY: petKey, RELAY_KEY: relayKey } });
  config.save({ sources: [{ id: 'relay', name: 'labkey', configPath: path.join(codexHome, 'relay.toml'), keyMode: 'environment', keyEnv: 'RELAY_KEY',
    queryUrl: 'https://relay.example.test/v1/usage' }] });
  const now = Date.now(), calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === 'https://api.deepseek.com/user/balance') return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '45.20' }] });
    if (url === 'https://relay.example.test/v1/usage') return Response.json({
      daily_usage: [0, 1, 2, 3, 4, 5, 6, 7].map(index => ({ date: dayKey(now - index * DAY), actual_cost: index === 0 ? 15.72 : 20 + index })),
      rate_limits: [{ limit: 400, remaining: 170.49, reset_at: new Date(now + 3.5 * DAY).toISOString() }] });
    return new Response('missing', { status: 404 });
  };
  const whale = new WhaleService({ config, fetchImpl });
  t.after(() => whale.close());
  // The pet talks to DeepSeek with the key Codex also uses there.
  whale.accounts.setPet(whale.accounts.adopt({ baseUrl: 'https://api.deepseek.com', key: petKey }).id);
  return { dataDir, config, whale, calls, now, book: new QuotaBook({ whale, billing }) };
}

test('each subscription window expires on its own', () => {
  const now = Date.now(), snapshot = { fiveHour: { usedPercent: 30, resetsAt: now - 1 }, sevenDay: { usedPercent: 60, resetsAt: now + DAY } };
  const windows = publicWindows(snapshot, now);
  assert.equal(windows.available, true);
  assert.equal(windows.fiveHour, null);
  assert.equal(windows.sevenDay.remainingPercent, 40);
  assert.equal(publicWindows({ ...snapshot, sevenDay: { usedPercent: 101, resetsAt: now + DAY } }, now).available, false, 'a share outside 0–100 is not data');
});

test('one endpoint and key is one account, queried once whatever uses it', async t => {
  const { book, calls } = setup(t);
  await book.refresh();
  const { accounts } = book.snapshot();
  assert.deepEqual(accounts.map(account => account.id).slice(0, 2), ['codex', 'claude']);
  assert.equal(accounts.length, 4);
  const deepseek = accounts.find(account => account.uses.includes('pet'));
  assert.deepEqual(deepseek.uses, ['codex:deepseek', 'pet']);
  assert.deepEqual(deepseek.balance, { amount: 45.2, used: null, currency: 'CNY', full: 45.2, safe: null });
  assert.equal(calls.filter(url => url.endsWith('/user/balance')).length, 1);
  assert.ok(!JSON.stringify(accounts).includes(petKey) && !JSON.stringify(accounts).includes(relayKey), 'no key leaves the book');
});

test('an API quota that resets is a window, paced by the service\'s own daily record', async t => {
  const { book } = setup(t);
  await book.refresh();
  const relay = book.snapshot().accounts.find(account => account.name === 'labkey');
  assert.deepEqual(relay.uses, ['codex:relay']);
  assert.equal(relay.available, true);
  assert.equal(relay.balance, null);
  const [window] = relay.windows;
  assert.equal(window.label, '额度');
  assert.equal(window.limit, 400);
  assert.equal(window.remaining, 170.49);
  assert.equal(window.currency, 'USD');
  assert.equal(Math.round(window.remainingPercent), 43);
  assert.equal(relay.spend.today, 15.72);
  assert.equal(relay.spend.days7, 15.72 + 21 + 22 + 23 + 24 + 25 + 26);
  assert.deepEqual(relay.spend.average, { amount: 24, days: 7, currency: 'USD' });
  assert.deepEqual(relay.pace, { enough: true, exhaustAt: null, average: relay.spend.average }, '$170.49 at $24 a day outlasts the reset in 3.5 days');
});

test('an API account at or above its safe amount counts as full', async t => {
  const { book, whale } = setup(t);
  const store = whale.accounts, pet = store.pet().id, relay = store.sessionContext('relay').sourceId;
  store.update(pet, { safeAmount: 20 });
  store.update(relay, { safeAmount: '100' });
  await book.refresh();
  const view = id => book.snapshot().accounts.find(account => account.id === id);
  assert.deepEqual([view(pet).balance.full, view(pet).balance.safe], [20, 20], '¥45.20 is above the safe ¥20');
  assert.equal(view(relay).windows[0].remainingPercent, 100, '$170.49 left is above the safe $100');
  store.update(relay, { safeAmount: 400 });
  assert.equal(Math.round(view(relay).windows[0].remainingPercent), 43);
  store.update(pet, { safeAmount: null });
  assert.deepEqual([view(pet).balance.full, view(pet).balance.safe], [45.2, null], 'without one the full balance counts again');
});

test('a subscription shows each valid window with its pace, and marks one that reset', async t => {
  const { book, whale, now } = setup(t);
  whale.updateSubscriptionRateLimits({ observedAt: now - HOUR, planType: 'plus',
    fiveHour: { usedPercent: 30, windowMinutes: 300, resetsAt: now - 1000 },
    sevenDay: { usedPercent: 60, windowMinutes: 10080, resetsAt: now + 3.5 * DAY } });
  const codex = book.snapshot().accounts.find(account => account.id === 'codex');
  assert.equal(codex.available, true);
  assert.equal(codex.plan, 'plus');
  assert.deepEqual(codex.windows[0], { id: '5h', label: '5h', reset: true });
  assert.equal(codex.windows[1].remainingPercent, 40);
  assert.ok(codex.windows[1].pace.projectedPercent > 100 && codex.windows[1].pace.exhaustAt < now + 3.5 * DAY,
    '60% used in under half the week runs out before the reset');
});

test('the pet account falls back on chat billing estimates for days its ledger never saw', async t => {
  const now = Date.now();
  const billing = { dailySpend: () => ({ today: 0.5, days: [{ date: dayKey(now - DAY), total: 1 }, { date: dayKey(now - 2 * DAY), total: 0.6 }] }) };
  const { book } = setup(t, { billing: () => billing });
  await book.refresh();
  const pet = book.snapshot().accounts.find(account => account.uses.includes('pet'));
  assert.deepEqual(pet.spend.average, { amount: 0.8, days: 2, currency: 'CNY' });
  assert.equal(pet.spend.estimated, true);
  assert.equal(pet.pace.daysLeft, 45.2 / 0.8);
});

test('the account in use follows the latest activity, and a choice holds until a later one', async t => {
  const { book, whale, dataDir, now } = setup(t);
  await book.refresh();
  const ids = Object.fromEntries(book.snapshot().accounts.map(account => [account.uses.includes('pet') ? 'pet' : account.name, account.id]));
  const relay = whale.accounts.sessionContext('relay');
  book.codexTurn({ ts: now - 5000, subscription: true });
  assert.equal(book.snapshot().current, 'codex');
  saveClaudeTurn(dataDir, { hook_event_name: 'Stop', session_id: 'fixture' }, now - 4000);
  assert.equal(book.snapshot().current, 'claude');
  book.petMessage(now - 3000);
  assert.equal(book.snapshot().current, ids.pet);
  book.codexTurn({ ts: now - 2000, subscription: false, context: relay });
  assert.equal(book.snapshot().current, ids.labkey);
  assert.equal(book.snapshot().accounts.find(account => account.id === ids.labkey).lastActiveAt, new Date(now - 2000).toISOString());
  book.select('codex', now - 1000);
  assert.equal(book.snapshot().current, 'codex');
  book.codexTurn({ ts: now - 1500, subscription: false, context: relay });
  assert.equal(book.snapshot().current, 'codex', 'activity from before the choice does not move it');
  assert.equal(new QuotaBook({ whale }).snapshot().current, 'codex', 'the choice survives a restart');
  book.petMessage(now);
  assert.equal(book.snapshot().current, ids.pet, 'a later activity moves the pet on');
  assert.throws(() => book.select('missing'), /没有这个额度账户/);
});

test('a Codex turn is activity on the subscription it used, or on the API account it ran against', async t => {
  const { service } = fixture(t), ends = [], now = Date.now();
  service.onTurnEnd = event => ends.push({ subscription: event.subscription, source: event.context.sourceName });
  const limits = { observedAt: now, planType: 'plus', fiveHour: { usedPercent: 25, windowMinutes: 300, resetsAt: now + HOUR },
    sevenDay: { usedPercent: 60, windowMinutes: 10080, resetsAt: now + DAY } };
  service.beginTurn(turn('work_turn', { provider: 'work' }));
  await service.finishTurn(turn('work_turn', { provider: 'work', outcome: 'completed' }));
  service.beginTurn(turn('plan_turn', { subscriptionRateLimits: limits }));
  await service.finishTurn(turn('plan_turn', { outcome: 'completed', subscriptionRateLimits: limits }));
  service.beginTurn(turn('old_turn'));
  await service.finishTurn(turn('old_turn', { outcome: 'completed', historical: true }));
  assert.deepEqual(ends, [{ subscription: false, source: 'Work' }, { subscription: true, source: 'personal' }], 'a recovered old turn is not new activity');
});

test('chat billing reads the pet account balance through the book', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  fs.mkdirSync(codexHome);
  let balanceCalls = 0;
  const fetchImpl = async (url, request) => {
    if (!url.endsWith('/user/balance')) return reply('你好');
    balanceCalls++;
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(request.redirect, 'error');
    assert.equal(new Headers(request.headers).get('authorization'), 'Bearer ' + petKey);
    return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '45.20' }] });
  };
  const service = new WhaleService({ config: new ConfigStore({ codexHome, dataDir, env: {} }), fetchImpl });
  const dispatcher = createDispatcher({ dataDir, service, monitor: false, autoRefresh: false, fetchImpl });
  t.after(() => dispatcher.close());
  const client = createChatClient(async (url, request) => {
    const result = await dispatcher.dispatch(url, { method: request.method, body: request.body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  });
  await client.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: petKey, maxTokens: 1024 });
  assert.equal((await client.billing()).billing.balance.amount, 45.2);
  const quotas = JSON.parse((await dispatcher.dispatch('/api/quotas')).body);
  const pet = quotas.accounts.find(account => account.uses.includes('pet'));
  assert.equal(pet.name, 'DeepSeek');
  assert.equal(pet.balance.amount, 45.2);
  assert.equal(balanceCalls, 1, 'the book already holds the balance chat billing read');
  await client.send('message_0001', 'Hi', () => {});
  assert.equal(JSON.parse((await dispatcher.dispatch('/api/quotas')).body).current, pet.id, 'writing to the pet makes its account current');
  const chosen = await dispatcher.dispatch('/api/quotas/current', { method: 'PUT', body: { id: 'codex' } });
  assert.equal(JSON.parse(chosen.body).current, 'codex');
  assert.equal((await dispatcher.dispatch('/api/quotas/current', { method: 'PUT', body: { id: 'missing' } })).status, 400);
});

test('the pet\'s own messages are not activity on its account', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-quota-proactive-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let told = 0;
  const service = new ChatService({ dataDir, activityOptions: { startTimer: false }, onUserMessage: () => told++, fetchImpl: async () => reply('今天也辛苦啦') });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: petKey, maxTokens: 1024 });
  assert.ok(await service.proactive());
  assert.equal(told, 0);
  await new Response(service.start({ text: 'Hi', id: 'message_0001' }).body).text();
  assert.equal(told, 1);
});
