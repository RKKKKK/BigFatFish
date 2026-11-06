// 本地部署用的小工具：查找并清理属于本项目数据目录的桌面进程。
// 只认命令行里带着本项目数据目录的 supervisor.ps1 / electron.exe，不会碰其它程序。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(SCRIPTS, '..', 'desktop', 'supervisor.ps1');
const POWERSHELL = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function powershell(script, timeout = 20000) {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout,
  });
  return String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function supervisorPids(dataDir) {
  const dir = quote(dataDir);
  return powershell(
    'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | '
    + "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*supervisor.ps1*' -and $_.CommandLine -like ('*' + " + dir + " + '*') } | "
    + 'Select-Object -ExpandProperty ProcessId'
  ).filter(value => /^\d+$/.test(value));
}

export function electronMainPids(dataDir) {
  const dir = quote(dataDir);
  return powershell(
    'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" | '
    + "Where-Object { $_.CommandLine -like ('*' + " + dir + " + '*') } | "
    + 'Select-Object -ExpandProperty ProcessId'
  ).filter(value => /^\d+$/.test(value));
}

export function requestStop(dataDir) {
  spawnSync(POWERSHELL, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SUPERVISOR,
    '-DataDir', dataDir, '-Stop',
  ], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
};

export async function stopEverything(dataDir, timeoutMs = 15000) {
  requestStop(dataDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (supervisorPids(dataDir).length === 0) break;
    await sleep(500);
  }
  for (const pid of supervisorPids(dataDir)) {
    spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  }
  // supervisor 被强制结束时会留下无人监管的挂件窗口，一并收掉。
  const electrons = electronMainPids(dataDir);
  for (const pid of electrons) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  }
  await sleep(800);
  // 进程退出需要一点时间，确认到真正消失为止，避免误报。
  const settle = Date.now() + 6000;
  while (Date.now() < settle) {
    if (supervisorPids(dataDir).length === 0 && electronMainPids(dataDir).length === 0) break;
    await sleep(400);
  }
  for (const file of ['runtime.json', 'supervisor-state.json']) {
    try { fs.unlinkSync(path.join(dataDir, file)); } catch {}
  }
  return { supervisors: supervisorPids(dataDir), electrons: electronMainPids(dataDir) };
}
