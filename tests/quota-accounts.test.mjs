import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { ConfigStore } from '../runtime/config.mjs';
import { AccountStore, apiFingerprint } from '../runtime/quota/accounts.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';

const relayKey = 'synthetic-relay-key', petKey = 'synthetic-deepseek-key', extraKey = 'synthetic-extra-key';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function memoryVault(entries = {}) {
  const keys = new Map(Object.entries(entries));
  return { keys, available: () => true, read: id => keys.has(id) ? { available: true, value: keys.get(id) } : { available: false, status: 'keychain-missing' }, write: (id, value) => keys.set(id, value) };
}
// An older pet's data: the ChatGPT login in config.toml, a relay added as an
// extra Codex config, the pet chatting with DeepSeek, and one more provider
// that no old setting mentions.
function legacy(t, { vault = memoryVault({ relaykeyref1234: relayKey, whale_chat_api_key_v1: petKey }), env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  fs.mkdirSync(codexHome); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
  fs.writeFileSync(path.join(codexHome, 'work.config.toml'), 'model_provider = "OpenAI"\nmodel = "relay-model"\n[model_providers.OpenAI]\nname = "OpenAI"\n' +
    'base_url = "https://relay.example.test/v1"\nenv_key = "RELAY_KEY"\nhttp_headers = { "x-relay-client" = "pet" }\n');
  fs.writeFileSync(path.join(codexHome, 'extra.config.toml'), '[model_providers.extra]\nname = "Extra relay"\nbase_url = "https://extra.example.test/v1"\nenv_key = "EXTRA_KEY"\n');
  const config = new ConfigStore({ dataDir, codexHome, env, secretVault: vault });
  config.save({ currency: 'USD', monitorSessions: false, models: { 'relay-model': { input: 1, cachedInput: 0.1, output: 2 } },
    sources: [{ id: 'source1', name: 'labkey', configPath: path.join(codexHome, 'work.config.toml'), keyMode: 'keychain', keyRef: 'relaykeyref1234',
      queryUrl: 'https://relay.example.test/v1/usage' }] });
  fs.writeFileSync(path.join(dataDir, 'chat-settings.json'), JSON.stringify({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keyRef: 'whale_chat_api_key_v1' }));
  return { codexHome, dataDir, config, vault, env };
}

test('the first run gathers the accounts the pet already used, keeping their ledgers and keys where they were', t => {
  const { codexHome, dataDir, config } = legacy(t);
  const before = ['api-settings.json', 'chat-settings.json'].map(name => fs.readFileSync(path.join(dataDir, name), 'utf8'));
  const store = new AccountStore({ config }), data = store.load();
  assert.deepEqual(data.accounts.map(account => account.name), ['labkey', 'DeepSeek', 'Extra relay'], 'the ChatGPT login is no API account');
  assert.equal(data.monitorSessions, false);
  const [relay, pet, extra] = data.accounts;
  assert.equal(relay.id, 'api-' + apiFingerprint('https://relay.example.test/v1', relayKey).slice(0, 12), 'the id the quota book already used');
  assert.equal(relay.ledgerId, sha('source\0source1\0' + fs.realpathSync(path.join(codexHome, 'work.config.toml'))).slice(0, 24), 'the old ledger continues');
  assert.deepEqual(relay.key, { mode: 'keychain', ref: 'relaykeyref1234' });
  assert.deepEqual(relay.codexProviders, ['OpenAI']);
  assert.deepEqual([relay.balance.method, relay.balance.queryUrl], ['source-usage', 'https://relay.example.test/v1/usage']);
  assert.deepEqual(relay.prices, { 'relay-model': { input: 1, cachedInput: 0.1, output: 2 } });
  assert.deepEqual(relay.sourceIds, ['source1']);
  assert.equal(data.petAccountId, pet.id);
  assert.deepEqual([pet.endpoint, pet.currency, pet.balance.method, pet.key.ref], ['https://api.deepseek.com', 'CNY', 'deepseek', 'whale_chat_api_key_v1']);
  assert.equal(pet.ledgerId, apiFingerprint('https://api.deepseek.com', petKey).slice(0, 24));
  assert.deepEqual([extra.codexProviders, extra.key.mode], [['extra'], 'codex'], 'a provider no old setting mentioned is found in the Codex folder');
  assert.equal(store.readKey(extra).status, 'key-unavailable');
  const saved = fs.readFileSync(path.join(dataDir, 'quota-accounts.json'), 'utf8');
  for (const key of [relayKey, petKey]) assert.ok(!saved.includes(key), 'no key in the accounts file');
  assert.deepEqual(['api-settings.json', 'chat-settings.json'].map(name => fs.readFileSync(path.join(dataDir, name), 'utf8')), before, 'the old files stay for an older pet');

  const session = store.sessionContext('OpenAI');
  assert.deepEqual([session.sourceId, session.accountId, session.key, session.queryUrl, session.model], [relay.id, relay.ledgerId, relayKey, 'https://relay.example.test/v1/usage', 'relay-model']);
  assert.deepEqual(session.requestHeaders, { 'x-relay-client': 'pet' });
  assert.equal(store.sessionContext('openai'), null, 'a ChatGPT session belongs to no API account');
  assert.equal(store.contextFor('source1').sourceId, relay.id, 'an old source id still finds its account');
  assert.deepEqual(store.pet(), { id: pet.id, name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', key: petKey, keyStatus: 'ready', keyStorage: 'encrypted', keySetAt: pet.keySetAt });
  assert.equal(new AccountStore({ config: new ConfigStore({ dataDir, codexHome, env: { EXTRA_KEY: extraKey }, secretVault: config.secretVault }) }).sessionContext('extra').key, extraKey,
    'Codex\'s own key works once the pet can read it');
});

test('accounts are added and edited, each Codex provider has one home, and keys stay out of the file', t => {
  const { dataDir, config, vault } = legacy(t);
  const store = new AccountStore({ config }), data = store.load(), [relay] = data.accounts;
  const added = store.add({ name: 'Moonshot', endpoint: 'https://api.moonshot.example.test/v1', key: 'synthetic-moon-key' });
  assert.deepEqual([added.name, added.keyStatus, added.currency, added.balance.method], ['Moonshot', 'ready', 'USD', 'auto']);
  assert.ok(!JSON.stringify(added).includes('synthetic-moon-key'));
  assert.ok([...vault.keys.values()].includes('synthetic-moon-key'));
  assert.throws(() => store.add({ endpoint: 'https://api.moonshot.example.test/other', key: 'synthetic-moon-key' }), /已经添加过/);
  const edited = store.update(added.id, { name: 'Kimi', currency: 'cny', prices: { 'kimi-k2': { input: 4, cachedInput: 1, output: 16 } }, balance: { method: 'newapi' } });
  assert.deepEqual([edited.name, edited.currency, edited.prices['kimi-k2'].output, edited.balance.method], ['Kimi', 'CNY', 16, 'newapi']);
  assert.equal(store.update(added.id, { safeAmount: '50' }).safeAmount, 50);
  assert.throws(() => store.update(added.id, { safeAmount: 0 }), /安全额度/);
  assert.equal(store.update(added.id, { safeAmount: '' }).safeAmount, null, 'clearing it goes back to the full balance');
  const file = path.join(dataDir, 'quota-accounts.json'), saved = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.update(added.id, { prices: { 'kimi-k2': { input: -1, cachedInput: 1, output: 16 } } }), /输入价格/);
  assert.throws(() => store.update(added.id, { codexProviders: ['OpenAI'] }), /只能属于一个账户/);
  assert.throws(() => store.update(added.id, { endpoint: 'https://elsewhere.example.test/v1' }), /重新输入/);
  assert.equal(fs.readFileSync(file, 'utf8'), saved, 'a rejected change saves nothing');
  const moved = store.update(added.id, { endpoint: 'https://elsewhere.example.test/v1', key: 'synthetic-elsewhere-key' });
  assert.equal(moved.host, 'elsewhere.example.test');
  assert.equal(store.context(store.account(added.id)).key, 'synthetic-elsewhere-key');
  store.update(relay.id, { hidden: true });
  assert.equal(store.sessionContext('OpenAI').sourceId, relay.id, 'a hidden account still counts its Codex sessions');
  store.setPet(added.id);
  assert.equal(store.pet().name, 'Kimi');
  assert.throws(() => store.setPet('api-missing'), /没有这个额度账户/);
  store.setMonitorSessions(true);
  assert.equal(new AccountStore({ config }).monitorSessions(), true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('synthetic-'), 'no key in the accounts file');
});

test('without a keychain a key lasts only while the pet runs', t => {
  const { config } = legacy(t, { vault: null });
  const store = new AccountStore({ config });
  const added = store.add({ endpoint: 'https://api.example.test/v1', key: 'synthetic-session-key' });
  assert.equal(added.keyStorage, 'session');
  assert.equal(store.context(store.account(added.id)).key, 'synthetic-session-key');
  assert.equal(new AccountStore({ config }).readKey(store.account(added.id)).status, 'key-unavailable');
});

test('the manager adds, edits and queries accounts and connects Claude, and no key ever leaves the runtime', async t => {
  const { dataDir, config } = legacy(t);
  const claudeHome = path.join(dataDir, 'claude-home');
  const fetchImpl = async url => {
    if (url === 'https://api.deepseek.com/user/balance') return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '45.20' }] });
    if (url === 'https://relay.example.test/v1/usage') return Response.json({ daily_usage: [{ date: '2026-10-05', actual_cost: 1 }], rate_limits: [] });
    return new Response('missing', { status: 404 });
  };
  const service = new WhaleService({ config, fetchImpl });
  const dispatcher = createDispatcher({ dataDir, claudeHome, service, monitor: false, autoRefresh: false, fetchImpl });
  t.after(() => dispatcher.close());
  const call = async (route, method = 'GET', body) => {
    const result = await dispatcher.dispatch(route, { method, body });
    return { status: result.status, body: JSON.parse(result.body) };
  };
  const listed = await call('/api/quota-accounts');
  assert.deepEqual(listed.body.accounts.map(account => account.name), ['labkey', 'DeepSeek', 'Extra relay']);
  assert.equal(listed.body.claude.installed, false);
  const added = await call('/api/quota-accounts', 'POST', { name: 'Moon', endpoint: 'https://api.moon.example.test/v1', key: 'synthetic-moon-key' });
  assert.equal(added.status, 200);
  assert.equal(added.body.account.name, 'Moon');
  assert.ok(added.body.quota.error, 'an account whose balance cannot be read is still saved, with the reason');
  const again = await call('/api/quota-accounts', 'POST', { endpoint: 'https://api.moon.example.test/v1', key: 'synthetic-moon-key' });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /已经添加过/);
  const edited = await call('/api/quota-accounts/' + added.body.account.id, 'PUT', { currency: 'CNY' });
  assert.equal(edited.body.account.currency, 'CNY');
  assert.equal((await call('/api/quota-accounts/' + added.body.account.id, 'PUT', { balance: { method: 'source-usage' } })).status, 400);
  const pet = listed.body.accounts.find(account => account.pet);
  const queried = await call('/api/quota-accounts/' + pet.id + '/query', 'POST');
  assert.equal(queried.body.quota.balance.amount, 45.2);
  assert.equal((await call('/api/quota-settings', 'PUT', { monitorSessions: true })).body.monitorSessions, true);
  const connected = await call('/api/claude/integration', 'POST', { action: 'install' });
  assert.equal(connected.body.installed, true);
  assert.match(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'), /claude-statusline\.mjs/);
  assert.equal((await call('/api/claude/integration', 'POST', { action: 'uninstall' })).body.installed, false);
  for (const response of [listed, added, edited, queried, await call('/api/quotas')]) assert.ok(!JSON.stringify(response.body).includes('synthetic-'), 'no key in a response');
});
