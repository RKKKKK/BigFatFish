import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateData } from '../runtime/migration.mjs';

test('upgrading removes what the retired window-follow mode left behind and keeps the desktop service files', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const kept = ['follow-config.json', 'follow-install.json', 'pause-until-host-exit.json', 'supervisor-state.json', 'native/WhaleLauncher-0123456789abcdef0123.exe'];
  const retired = ['follow-state.json', 'follow-input-error.json', 'native/whale-window-probe', 'native/swift-cache/Swift.swiftmodule'];
  for (const name of [...kept, ...retired]) {
    fs.mkdirSync(path.dirname(path.join(dataDir, name)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, name), '{}');
  }
  migrateData(dataDir);
  for (const name of kept) assert.equal(fs.existsSync(path.join(dataDir, name)), true, name + ' must stay');
  for (const name of retired) assert.equal(fs.existsSync(path.join(dataDir, name)), false, name + ' must go');
  assert.equal(fs.existsSync(path.join(dataDir, 'native', 'swift-cache')), false);
});
