import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUPERVISOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'macos', 'supervisor.mjs');
// Stands in for Electron: records each launch's arguments and exits when its stdin closes.
const PET = `
const fs = require('node:fs'), path = require('node:path');
const dataDir = process.argv.find(arg => arg.startsWith('--whale-data=')).slice(13);
fs.appendFileSync(path.join(dataDir, 'pet-launches.log'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n');
process.stdin.on('end', () => process.exit(0)).resume();
`;

// The macOS desktop service, run on any platform against a temporary data directory and the stand-in pet.
function desktopService(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-service-'));
  const dataDir = path.join(root, 'data'), pluginRoot = path.join(root, 'plugin');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(pluginRoot, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'desktop', 'main.cjs'), PET);
  fs.writeFileSync(path.join(dataDir, 'follow-config.json'), JSON.stringify({ platform: 'darwin', enabled: true, mode: 'free-desktop', label: 'test', electronPath: process.execPath, ...config }));
  let supervisor = null;
  t.after(async () => {
    if (supervisor?.exitCode === null && supervisor.signalCode === null) {
      const exited = new Promise(resolve => supervisor.once('exit', resolve));
      supervisor.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    dataDir,
    start() {
      supervisor = spawn(process.execPath, [SUPERVISOR, '--data-dir', dataDir, '--plugin-root', pluginRoot], { stdio: 'ignore' });
      return supervisor;
    },
    launches() {
      try { return fs.readFileSync(path.join(dataDir, 'pet-launches.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch { return []; }
    },
  };
}

async function until(check, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a stopped pet stays stopped while the desktop service keeps running, and starts once the stop marker is gone', async t => {
  const service = desktopService(t), marker = path.join(service.dataDir, 'pause-until-host-exit.json');
  fs.writeFileSync(marker, JSON.stringify({ pauseAll: true }));
  const supervisor = service.start();
  await until(() => fs.existsSync(path.join(service.dataDir, 'supervisor-state.json')), 'the service must report its state');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(supervisor.exitCode, null, 'the service must not exit, or launchd restarts it every few seconds');
  assert.equal(service.launches().length, 0);
  fs.unlinkSync(marker);
  await until(() => service.launches().length === 1, 'removing the stop marker must start the pet');
});

test('an install from the retired window-follow mode starts the pet without Codex or a reinstall', async t => {
  const service = desktopService(t, { mode: 'follow-codex', probePath: path.join(os.tmpdir(), 'missing-whale-window-probe') });
  service.start();
  await until(() => service.launches().length === 1, 'the pet must start without a window probe or a Codex window');
  assert.deepEqual(service.launches()[0].args, ['--whale-data=' + service.dataDir, '--supervised']);
});

test('stopping the desktop service stops the pet and clears the service state', async t => {
  const service = desktopService(t), supervisor = service.start();
  await until(() => service.launches().length === 1, 'the service must start the pet');
  const exited = new Promise(resolve => supervisor.once('exit', resolve));
  supervisor.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(alive(service.launches()[0].pid), false);
  assert.equal(fs.existsSync(path.join(service.dataDir, 'supervisor-state.json')), false);
  assert.equal(fs.existsSync(path.join(service.dataDir, 'macos-supervisor.lock')), false);
});
