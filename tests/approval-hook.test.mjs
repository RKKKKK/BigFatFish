import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installApprovalHook, uninstallApprovalHook } from '../scripts/manage-approval-hook.mjs';
import { startBridge } from '../runtime/bridge.mjs';

const root = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'wa-'));
const codexHome = path.join(root, '.codex');
const dataDir = path.join(root, 'whale-widget');
fs.mkdirSync(codexHome);
fs.mkdirSync(dataDir);
const configFile = path.join(codexHome, 'hooks.json');
fs.writeFileSync(configFile, JSON.stringify({ description: 'existing hooks', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));

async function runHook(event) {
  const script = fileURLToPath(new URL('../scripts/approval-request-hook.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--whale-approval-hook', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { error += part; });
  child.stdin.end(JSON.stringify(event));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  assert.equal(output, '');
  assert.equal(error, '');
}

let bridge;
try {
  assert.equal(installApprovalHook({ codexHome, dataDir, nodePath: process.execPath }), true);
  assert.equal(installApprovalHook({ codexHome, dataDir, nodePath: process.execPath }), false);
  const installed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(installed.hooks.Stop.length, 1);
  assert.equal(installed.hooks.PermissionRequest.length, 1);
  assert.match(installed.hooks.PermissionRequest[0].hooks[0].command, /approval-request-hook\.mjs/);

  let notices = 0, asked = null;
  bridge = await startBridge({ dispatch: async () => { throw new Error('unexpected public route'); } }, {
    dataDir, onApprovalRequest: info => { notices++; asked = info; },
  });
  await runHook({ hook_event_name: 'PermissionRequest', session_id: 'test-session', cwd: '/work/api', tool_input: { command: 'private text must stay in the hook process' } });
  assert.equal(notices, 1);
  assert.deepEqual(asked, { sessionId: 'test-session', cwd: '/work/api' }, 'only which session asks reaches the pet');
  await runHook({ hook_event_name: 'PostToolUse' });
  assert.equal(notices, 1);

  assert.equal(uninstallApprovalHook({ codexHome }), true);
  const restored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(restored.hooks.Stop.length, 1);
  assert.equal(restored.hooks.PermissionRequest, undefined);
  assert.equal(uninstallApprovalHook({ codexHome }), false);
  console.log('approval hook installation, isolated IPC reminder and removal passed');
} finally {
  await bridge?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
