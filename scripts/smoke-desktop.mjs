import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_HOME, ROOT } from '../runtime/paths.mjs';

const binary = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = process.env.WHALE_ELECTRON_PATH || path.join(DATA_HOME, 'desktop-runtime', 'node_modules', 'electron', 'dist', binary);
if (!fs.existsSync(electron)) throw new Error('Install the desktop component or set WHALE_ELECTRON_PATH to its executable.');
const inputOnly = process.argv.includes('--input-focus');
const outputParent = path.resolve(process.argv.slice(2).find(arg => arg !== '--input-focus') || path.join(ROOT, 'qa-output'));
fs.mkdirSync(outputParent, { recursive: true });
const output = fs.mkdtempSync(path.join(outputParent, 'desktop-0.3.0-'));
// Keep Unix socket paths short and isolate both Electron storage and Codex data.
const temp = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'wd-'));
const dataDir = path.join(temp, 'data'), codexHome = path.join(temp, 'codex');
fs.mkdirSync(dataDir); fs.mkdirSync(codexHome);

async function run(phase) {
  const env = { ...process.env, CODEX_HOME: codexHome, WHALE_HOME: dataDir, WHALE_DESKTOP_TEST: '1',
    WHALE_DESKTOP_AUDIT: '0', WHALE_TEST_PHASE: phase, WHALE_TEST_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(ROOT, 'desktop', 'main.cjs'), '--whale-data=' + dataDir], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '', timedOut = false;
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  fs.writeFileSync(path.join(output, phase + '.log'), logs);
  if (timedOut || code !== 0 || !fs.existsSync(path.join(output, phase + '.json'))) {
    const errorFile = path.join(dataDir, 'desktop-error.json');
    const detail = fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : logs.slice(-2000);
    throw new Error('Desktop smoke ' + phase + ' failed (exit ' + code + '): ' + detail);
  }
}

try {
  if (inputOnly) await run('input');
  else { await run('initial'); await run('restart'); }
  process.stdout.write('Desktop smoke passed (' + (inputOnly ? 'input focus' : 'initial + process restart') + '): ' + output + '\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
