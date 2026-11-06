import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const turns = browserModule('turn-notice.js');
const clientModule = browserModule('usage-client.js');
const create = options => clientModule.create({ shouldNotify: turns.shouldNotify, ...options });
const memory = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
const book = { ok: true, current: 'codex', accounts: [{ id: 'codex' }] };

test('quota reads share one request, and a manual read asks the runtime to query again', async () => {
  const requests = [];
  const client = create({ fetchImpl: async (url, options) => { requests.push([url, options.cache]); await new Promise(resolve => setImmediate(resolve)); return Response.json(book); } });
  const [first, second] = await Promise.all([client.quotas(), client.quotas()]);
  assert.equal(first.current, 'codex');
  assert.equal(first, second);
  assert.deepEqual(requests, [['/api/quotas', 'no-store']]);
  await client.quotas({ manual: true });
  assert.deepEqual(requests[1], ['/api/quotas?refresh=1', 'no-store']);
});

test('a quota read fails loudly on a bad answer, and the deadline aborts a stalled one', async () => {
  await assert.rejects(create({ fetchImpl: async () => Response.json({ ok: false, error: 'book unavailable' }) }).quotas(), /book unavailable/);
  let stall = true;
  const client = create({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    if (!stall) return Response.json(book);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(client.quotas(), /aborted/);
  stall = false;
  assert.equal((await client.quotas()).current, 'codex');
});

test('a choice goes to the book, and an older pet\'s choice moves there once with its time', async () => {
  const calls = [];
  const values = new Map([['dshw-display-source', 'claude'], ['dshw-display-source-manual-at', '3000']]);
  const client = create({ storage: memory(values), fetchImpl: async (url, options) => {
    calls.push([url, options.method, options.body && JSON.parse(options.body)]);
    return Response.json({ ok: true, current: 'claude', accounts: [] });
  } });
  await client.migrateChoice();
  await client.migrateChoice();
  assert.deepEqual(calls, [['/api/quotas/current', 'PUT', { id: 'claude', at: 3000 }]]);
  assert.equal(values.get('dshw-display-source'), 'claude', 'the old keys stay for an older pet');
  await client.select('codex');
  assert.deepEqual(calls[1], ['/api/quotas/current', 'PUT', { id: 'codex' }]);
  const plain = create({ storage: memory(new Map([['dshw-display-source', 'codex']])), fetchImpl: async () => assert.fail('no time, nothing to move') });
  assert.equal(await plain.migrateChoice(), null);
  await assert.rejects(create({ fetchImpl: async () => Response.json({ ok: false, error: '没有这个额度账户' }) }).select('missing'), /没有这个额度账户/);
});

test('concurrent task polls share one read, persist the cursor, and never replay a completion after restart', async () => {
  const values = new Map(), storage = memory(values);
  let record = { ok: true, seq: 1, id: 'historical', turn: 'old', notificationAt: 99, amount: 1 };
  let reads = 0;
  const options = { now: () => 100, storage, fetchImpl: async url => {
    if (url !== '/dsh-whale/last-turn.json') return Response.json({ available: false });
    reads++; return Response.json(record);
  } };
  const client = create(options), shown = [];
  const handlers = { codex: value => shown.push(value.id) };
  await Promise.all([client.pollCompletions(handlers), client.pollCompletions(handlers)]);
  assert.equal(reads, 1);
  assert.deepEqual(shown, []);
  record = { ...record, seq: 2, id: 'new', turn: 'new', notificationAt: 101 };
  await Promise.all([client.pollCompletions(handlers), client.pollCompletions(handlers)]);
  assert.deepEqual(shown, ['new']);
  assert.equal(values.get('dshw-last-seq'), '2');
  assert.equal(values.get('dshw-last-turn-id'), 'new');
  await client.pollCompletions(handlers);
  await create(options).pollCompletions(handlers);
  assert.deepEqual(shown, ['new']);
});

test('Claude completion polls once, ignores old events and never replays after a restart', async () => {
  const values = new Map(), storage = memory(values);
  let record = { ok: true, available: true, provider: 'Claude', id: 'old', completedAt: 99 };
  let reads = 0;
  const options = { now: () => 100, storage, fetchImpl: async url => {
    if (url !== '/api/claude/last-turn') return Response.json(url.includes('last-turn') ? { ok: false } : { available: false });
    reads++; return Response.json(record);
  } };
  const client = create(options), shown = [];
  const handlers = { claude: value => shown.push(value.id) };
  await client.pollCompletions(handlers);
  record = { ...record, id: 'new', completedAt: 101 };
  await Promise.all([client.pollCompletions(handlers), client.pollCompletions(handlers)]);
  assert.equal(reads, 2);
  assert.deepEqual(shown, ['new']);
  assert.equal(values.get('dshw-last-claude-turn-id'), 'new');
  await create(options).pollCompletions(handlers);
  assert.deepEqual(shown, ['new']);
});

test('sound settings use the existing route and report a rejected save', async () => {
  const calls = [];
  let saved = { approvalSound: { on: false, sel: 'frag:custom' } }, reject = false;
  const client = create({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    if (options.method === 'PUT') {
      if (reject) return Response.json({ ok: false, error: 'save failed' });
      saved = JSON.parse(options.body);
    }
    return Response.json({ ok: true, settings: saved });
  } });
  assert.equal((await client.settings()).settings.approvalSound.sel, 'frag:custom');
  const patch = { approvalSound: { on: true, sel: 'preset:fx1:release' } };
  assert.equal((await client.saveSettings(patch)).settings.approvalSound.on, true);
  assert.equal(calls[1][0], '/dsh-whale/usage-settings.json');
  assert.equal(calls[1][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1][1].body), patch);
  reject = true;
  await assert.rejects(client.saveSettings(patch), /save failed/);
});
