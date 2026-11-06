import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './helpers/fixture.mjs';

test('configured source key rotation keeps ledger identity and public settings omit credentials', t => {
  const { config } = fixture(t);
  const before = config.resolveForSession({ modelProvider: 'work' });
  config.env.WORK_KEY = 'fixture-rotated-secret';
  const after = config.resolveForSession({ modelProvider: 'work' });
  assert.equal(after.accountId, before.accountId);
  assert.equal(after.key, 'fixture-rotated-secret');
  assert.doesNotMatch(JSON.stringify(config.publicInfo()), /fixture-.*secret/);
  assert.doesNotMatch(fs.readFileSync(config.file, 'utf8'), /fixture-.*secret/);
});

test('duplicate provider routing is rejected without replacing the saved sources', t => {
  const { config } = fixture(t), saved = config.load();
  assert.throws(() => config.save({ sources: [...saved.sources, { ...saved.sources[0], id: 'duplicate' }] }), /model_provider|重复|唯一/);
  assert.deepEqual(config.load(), saved);
});

test('source configuration cannot escape CODEX_HOME through a symlink', t => {
  const { config, root, codexHome } = fixture(t), saved = config.load();
  const outside = path.join(root, 'outside.toml'), link = path.join(codexHome, 'linked.toml');
  fs.writeFileSync(outside, 'model_provider = "outside"\n');
  fs.symlinkSync(outside, link);
  assert.throws(() => config.save({ sources: [{ ...saved.sources[0], configPath: link }] }), /须位于/);
  assert.deepEqual(config.load(), saved);
});
