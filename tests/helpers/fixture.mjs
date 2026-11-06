import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../runtime/config.mjs';
import { WhaleService } from '../../runtime/service.mjs';

export function fixture(t, { models = {}, used = () => 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-behavior-'));
  const codexHome = path.join(root, 'codex'), dataDir = path.join(root, 'data');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "personal"\nmodel = "test-model"\n[model_providers.personal]\nbase_url = "https://personal.example.test/v1"\nenv_key = "PERSONAL_KEY"\n');
  fs.writeFileSync(path.join(codexHome, 'work.toml'), 'model_provider = "work"\nmodel = "test-model"\n[model_providers.work]\nbase_url = "https://work.example.test/v1"\nenv_key = "WORK_KEY"\n');
  const config = new ConfigStore({ codexHome, dataDir, env: { PERSONAL_KEY: 'fixture-personal-secret', WORK_KEY: 'fixture-work-secret' } });
  config.save({ provider: 'custom-json', balancePath: '/balance', balanceField: 'balance', usedField: 'used', models,
    sources: [{ id: 'work', name: 'Work', configPath: path.join(codexHome, 'work.toml'), keyMode: 'environment', keyEnv: 'WORK_KEY' }] });
  const services = [];
  const createService = () => {
    const service = new WhaleService({ config, fetchImpl: async url => {
      const amount = used(new URL(url).hostname);
      return Response.json({ balance: 100 - amount, used: amount });
    } });
    services.push(service);
    return service;
  };
  t.after(async () => {
    await Promise.all(services.map(service => service.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, codexHome, dataDir, config, createService, service: createService() };
}

export function turn(id, { provider = 'personal', input = 100, output = 20, ...extra } = {}) {
  return { id: 'session:' + id, sessionId: 'session', turnId: id, rootTurnId: id, modelProvider: provider,
    ts: Date.now(), byModel: { 'test-model': { input_tokens: input, cached_input_tokens: 0, output_tokens: output } }, ...extra };
}
