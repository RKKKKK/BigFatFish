import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ConfigStore } from '../runtime/config.mjs';

const require = createRequire(import.meta.url);
const { KeychainVault, VAULT_FILE } = require('../desktop/macos/keychain-vault.cjs');

class FakeSafeStorage {
  isEncryptionAvailable() { return true; }
  encryptString(value) { return Buffer.from('encrypted:' + value, 'utf8'); }
  decryptString(value) {
    const text = Buffer.from(value).toString('utf8');
    if (!text.startsWith('encrypted:')) throw new Error('not encrypted');
    return text.slice('encrypted:'.length);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-keychain-source-'));
try {
  const codexHome = path.join(root, '.codex'), dataDir = path.join(codexHome, 'whale-widget');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\n');
  fs.writeFileSync(path.join(codexHome, 'work.config.toml'), [
    'model_provider = "work"', 'model = "work-model"', '', '[model_providers.work]', 'base_url = "https://example.test/v1"', 'env_key = "WORK_CODEX_API_KEY"', '',
  ].join('\n'));

  const vault = new KeychainVault({ dataDir, safeStorage: new FakeSafeStorage(), platform: 'darwin' });
  const keyRef = 'workkeyref123456';
  vault.write(keyRef, 'keychain-test-key');
  assert.deepEqual(vault.read(keyRef), { available: true, value: 'keychain-test-key', status: 'ready' });
  const vaultText = fs.readFileSync(path.join(dataDir, VAULT_FILE), 'utf8');
  assert.ok(!vaultText.includes('keychain-test-key'), 'vault must not persist a plaintext key');

  const winDir = path.join(root, 'win-vault');
  const winVault = new KeychainVault({ dataDir: winDir, safeStorage: new FakeSafeStorage(), platform: 'win32' });
  assert.equal(winVault.available(), true, 'Windows safeStorage must be a persistent vault');
  winVault.write('winkeyref123456', 'windows-test-key');
  assert.deepEqual(winVault.read('winkeyref123456'), { available: true, value: 'windows-test-key', status: 'ready' });
  const winText = fs.readFileSync(path.join(winDir, VAULT_FILE), 'utf8');
  assert.ok(!winText.includes('windows-test-key'), 'Windows vault must not persist a plaintext key');

  const config = new ConfigStore({ dataDir, codexHome, env: { WORK_CODEX_API_KEY: 'environment-test-key' }, secretVault: vault });
  config.save({ sources: [{ id: 'work', name: '工作中转站', configPath: path.join(codexHome, 'work.config.toml'), keyMode: 'keychain', keyEnv: 'WORK_CODEX_API_KEY', keyRef, enabled: true }] });
  const context = config.resolveForSession({ modelProvider: 'work' });
  assert.equal(context.key, 'keychain-test-key');
  assert.equal(context.keySource, 'keychain');
  assert.equal(config.sourcePublicInfo()[0].status, 'ready');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'api-settings.json'), 'utf8').includes('keychain-test-key'), 'settings must not persist a plaintext key');
  console.log('macOS-keychain encrypted source handling passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
