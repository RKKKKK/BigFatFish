// 本地（自包含）部署的启动器。
// 数据目录固定为项目内的 .whale-home，不注册 Windows 计划任务。
// 先按上次成功的参数启动，失败则换一组参数重试：本机若 Chromium 沙箱无法初始化，
// 会自动改用 --no-sandbox（经 follow-config.json 的 extraArgs 传给 supervisor.ps1）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopEverything, electronMainPids, sleep } from './local-process.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.WHALE_HOME) process.env.WHALE_HOME = path.join(ROOT, '.whale-home');

const { DATA_HOME } = await import('../runtime/paths.mjs');
const { bridgeRequest } = await import('../runtime/bridge.mjs');

const CONFIG = path.join(DATA_HOME, 'follow-config.json');
const MODE_FILE = path.join(DATA_HOME, 'local-launch-mode.json');
const ELECTRON = path.join(DATA_HOME, 'desktop-runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
const SUPERVISOR = path.join(ROOT, 'desktop', 'supervisor.ps1');
const POWERSHELL = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function writeConfig(extraArgs) {
  if (!fs.existsSync(ELECTRON)) {
    throw new Error('找不到 Electron 运行时，请先运行：node scripts/install-desktop.mjs');
  }
  const config = {
    enabled: true,
    pluginRoot: ROOT,
    electronPath: ELECTRON,
    powerShellPath: POWERSHELL,
    launcherPath: '',
    taskName: 'Codex API Balance Whale',
    mode: 'free-desktop',
    revision: 'desktop-v4-free-local',
    launchMode: 'winexe-create-no-window',
    extraArgs,
  };
  fs.mkdirSync(DATA_HOME, { recursive: true });
  // Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，中文路径会变成乱码。
  fs.writeFileSync(CONFIG, '\uFEFF' + JSON.stringify(config, null, 2) + '\n');
}

function startSupervisor() {
  // 不要用 detached：Windows 上 DETACHED_PROCESS 会让 supervisor 立刻退出。
  // supervisor.ps1 自己会调用 FreeConsole，控制台关闭后进程仍能存活。
  const child = spawn(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', SUPERVISOR, '-DataDir', DATA_HOME,
  ], { detached: false, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function status() {
  try { return await bridgeRequest('/api/status', { dataDir: DATA_HOME, timeoutMs: 1500 }); }
  catch { return null; }
}

async function waitForService(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await status();
    if (result && result.ok) return result;
    await sleep(500);
  }
  return null;
}

async function attempt(extraArgs, timeoutMs) {
  await stopEverything(DATA_HOME);
  writeConfig(extraArgs);
  startSupervisor();
  return waitForService(timeoutMs);
}

function readMode() {
  try {
    const saved = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(saved.extraArgs) ? saved.extraArgs : [];
  } catch { return []; }
}

let running = await status();
if (!running && electronMainPids(DATA_HOME).length > 0) {
  // 有窗口但没有控制通道：说明是上次被强制结束留下的孤儿进程，先清理再启动。
  await stopEverything(DATA_HOME);
  running = null;
}
if (running && running.ok) {
  try { await bridgeRequest('/api/show', { method: 'POST', dataDir: DATA_HOME, timeoutMs: 5000 }); } catch {}
  process.stdout.write('大肥鱼已经在运行，已让它显示在桌面。\n');
  process.exit(0);
}

const preferred = readMode();
const alternate = preferred.length ? [] : ['--no-sandbox'];

let used = preferred;
let state = await attempt(preferred, 12000);
if (!state) {
  process.stdout.write('按上次方式启动没有成功，换一组参数重试……\n');
  used = alternate;
  state = await attempt(alternate, 20000);
}

if (!state) {
  await stopEverything(DATA_HOME);
  writeConfig(preferred);
  process.stderr.write('挂件仍未启动。\n');
  const errorFile = path.join(DATA_HOME, 'supervisor-error.json');
  if (fs.existsSync(errorFile)) process.stderr.write(fs.readFileSync(errorFile, 'utf8') + '\n');
  process.exit(1);
}

fs.writeFileSync(MODE_FILE, JSON.stringify({ extraArgs: used }, null, 2) + '\n');
try { await bridgeRequest('/api/show', { method: 'POST', dataDir: DATA_HOME, timeoutMs: 5000 }); } catch {}
const modeText = used.length ? '兼容模式（' + used.join(' ') + '）' : '常规模式';
process.stdout.write(`大肥鱼已启动：${modeText}，版本 ${state.version}，数据目录 ${DATA_HOME}\n`);
process.exit(0);
