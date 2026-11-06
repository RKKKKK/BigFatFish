import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDispatcher } from '../runtime/dispatcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('runtime code never imports from the UI folder; code both sides need lives in lib', async t => {
  const runtime = path.join(ROOT, 'runtime');
  const offenders = fs.readdirSync(runtime, { recursive: true }).filter(name => /\.m?js$/.test(name) &&
    /from\s+['"][^'"]*desktop\/ui\//.test(fs.readFileSync(path.join(runtime, name), 'utf8')));
  assert.deepEqual(offenders, []);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-boundaries-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false });
  t.after(() => dispatcher.close());
  const reader = await dispatcher.dispatch('/lib/event-stream.js');
  assert.equal(reader.status, 200, 'the page loads the shared stream reader');
  assert.match(reader.headers['content-type'], /javascript/);
  assert.equal((await dispatcher.dispatch('/lib/resource-store.mjs')).status, 404, 'only the shared reader is served from lib');
});
