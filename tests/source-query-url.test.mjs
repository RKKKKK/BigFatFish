import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../runtime/config.mjs';
import { BalanceProvider } from '../runtime/providers.mjs';
import { WhaleService } from '../runtime/service.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-source-query-'));
try {
  const codexHome = path.join(root, '.codex'), dataDir = path.join(codexHome, 'whale-widget');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\n');
  fs.writeFileSync(path.join(codexHome, 'work.config.toml'), [
    'model_provider = "work"', 'model = "work-model"', '', '[model_providers.work]', 'base_url = "https://example.test/v1"', 'env_key = "WORK_CODEX_API_KEY"',
    'http_headers = { "x-provider-context" = "desktop-client" }', '',
  ].join('\n'));
  const store = new ConfigStore({ dataDir, codexHome, env: { WORK_CODEX_API_KEY: 'test-key' } });
  store.save({ sources: [{ id: 'work', name: '工作中转站', configPath: path.join(codexHome, 'work.config.toml'), keyMode: 'environment', keyEnv: 'WORK_CODEX_API_KEY', keyRef: 'workkeyref123456', queryUrl: 'https://example.test/v1/usage', enabled: true }] });
  const source = store.resolveForSession({ modelProvider: 'work' });
  assert.equal(source.queryUrl, 'https://example.test/v1/usage');
  assert.deepEqual(source.requestHeaders, { 'x-provider-context': 'desktop-client' });
  assert.equal(store.sourcePublicInfo()[0].queryUrl, 'https://example.test/v1/usage');

  let request;
  const provider = new BalanceProvider({ fetchImpl: async (url, options) => {
    request = { url, headers: options.headers };
    return new Response(JSON.stringify({ daily_usage: [{ date: '2026-09-24', cost: 1.5, actual_cost: 1.25 }], rate_limits: [{ limit: 100, remaining: 75, reset_at: '2026-09-25T00:00:00Z' }] }), { headers: { 'content-type': 'application/json' } });
  } });
  const usage = await provider.balance(source);
  assert.equal(request.url, 'https://example.test/v1/usage');
  assert.equal(request.headers.Authorization, 'Bearer test-key');
  assert.equal(request.headers['x-provider-context'], 'desktop-client');
  assert.equal(usage.adapter, 'source-usage');
  assert.equal(usage.totalUsed, 1.25);
  assert.equal(usage.totalBalance, null);
  assert.deepEqual(usage.rateLimits, [{ limit: 100, remaining: 75, resetsAt: '2026-09-25T00:00:00Z' }]);
  assert.deepEqual(usage.primaryRateLimit, { limit: 100, remaining: 75, resetsAt: '2026-09-25T00:00:00Z', used: 25 });

  let displayed = null;
  const service = new WhaleService({ config: store, provider: { balance: async context => {
    displayed = context;
    return { ok: true, accountId: context.accountId, providerName: context.providerName, baseUrl: context.baseUrl,
      totalBalance: null, totalUsed: 1.25, sourceDailyUsage: 1.25, currency: 'USD', adapter: 'source-usage',
      primaryRateLimit: { limit: 100, remaining: 75, used: 25, resetsAt: '2026-09-25T00:00:00Z' } };
  } } });
  service.beginTurn({ id: 'work-session:work-turn', sessionId: 'work-session', turnId: 'work-turn', modelProvider: 'work', isSubagent: false, ts: Date.now(), byModel: {} });
  const display = await service.getBalance();
  assert.equal(displayed.sourceName, '工作中转站', 'the old source became an account and the pet shows it');
  assert.equal(displayed.queryUrl, 'https://example.test/v1/usage');
  assert.deepEqual(displayed.requestHeaders, { 'x-provider-context': 'desktop-client' }, 'the account still sends the TOML headers');
  assert.equal(display.todayUsage, 1.25);
  assert.equal(display.todayUsageSource, 'source-api');
  assert.deepEqual(display.primaryRateLimit, { limit: 100, remaining: 75, used: 25, resetsAt: '2026-09-25T00:00:00Z' });

  assert.throws(() => store.save({ sources: [{ id: 'work', name: '工作中转站', configPath: path.join(codexHome, 'work.config.toml'), keyMode: 'environment', keyEnv: 'WORK_CODEX_API_KEY', keyRef: 'workkeyref123456', queryUrl: 'https://other.example/usage', enabled: true }] }), /同源/);
  console.log('per-source query URL and TOML headers passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
