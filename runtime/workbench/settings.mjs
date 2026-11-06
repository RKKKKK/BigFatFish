import path from 'node:path';
import { readJson, writeJson } from '../paths.mjs';

// Settings the workbench owns. They are written only when the user saves;
// reading a missing or damaged file falls back to these values.
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  allowedRoots: [],
  readTaskContent: true,
  confirmDispatch: true,
  autoConsolidate: true,
  maxConcurrent: 2,
  codexSandbox: 'workspace-write',
  taskTimeoutMinutes: 30,
  dailyDigest: '',
});

const SANDBOXES = ['workspace-write', 'read-only', 'danger-full-access'];
const CONTROL = /[\x00-\x1f\x7f]/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function roots(input) {
  if (!Array.isArray(input)) throw new Error('允许的工作目录须为列表');
  if (input.length > 20) throw new Error('允许的工作目录最多 20 个');
  const seen = new Set(), result = [];
  for (const value of input) {
    if (typeof value !== 'string') throw new Error('工作目录须为文本');
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 4096 || CONTROL.test(trimmed)) throw new Error('工作目录格式无效');
    if (!path.isAbsolute(trimmed)) throw new Error('工作目录须为绝对路径');
    const normalized = path.normalize(trimmed);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key); result.push(normalized);
  }
  return result;
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(name + '须为开关值');
  return value;
}

function concurrent(value) {
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('同时运行的任务数须为 1 到 4');
  return value;
}

function timeoutMinutes(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120) throw new Error('任务超时须为 1 到 120 分钟');
  return value;
}

function sandbox(value) {
  if (!SANDBOXES.includes(value)) throw new Error('无效的 Codex 沙箱设置');
  return value;
}

function digest(value) {
  if (typeof value !== 'string') throw new Error('日报时间格式无效');
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!TIME.test(trimmed)) throw new Error('日报时间须为 HH:MM');
  return trimmed;
}

export class WorkbenchSettings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'work-settings.json');
    let stored = {};
    try { stored = readJson(this.file, {}); } catch { stored = {}; }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    this.value = { ...DEFAULT_SETTINGS };
    try { if (stored.allowedRoots !== undefined) this.value.allowedRoots = roots(stored.allowedRoots); } catch {}
    for (const key of ['readTaskContent', 'confirmDispatch', 'autoConsolidate']) {
      if (typeof stored[key] === 'boolean') this.value[key] = stored[key];
    }
    try { if (stored.maxConcurrent !== undefined) this.value.maxConcurrent = concurrent(stored.maxConcurrent); } catch {}
    try { if (stored.codexSandbox !== undefined) this.value.codexSandbox = sandbox(stored.codexSandbox); } catch {}
    try { if (stored.taskTimeoutMinutes !== undefined) this.value.taskTimeoutMinutes = timeoutMinutes(stored.taskTimeoutMinutes); } catch {}
    try { if (stored.dailyDigest !== undefined) this.value.dailyDigest = digest(stored.dailyDigest); } catch {}
  }

  public() { return structuredClone(this.value); }

  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效');
    const next = { ...this.value };
    if (input.allowedRoots !== undefined) next.allowedRoots = roots(input.allowedRoots);
    if (input.readTaskContent !== undefined) next.readTaskContent = boolean(input.readTaskContent, '读取任务内容');
    if (input.confirmDispatch !== undefined) next.confirmDispatch = boolean(input.confirmDispatch, '下发确认');
    if (input.autoConsolidate !== undefined) next.autoConsolidate = boolean(input.autoConsolidate, '自动整理记忆');
    if (input.maxConcurrent !== undefined) next.maxConcurrent = concurrent(input.maxConcurrent);
    if (input.codexSandbox !== undefined) next.codexSandbox = sandbox(input.codexSandbox);
    if (input.taskTimeoutMinutes !== undefined) next.taskTimeoutMinutes = timeoutMinutes(input.taskTimeoutMinutes);
    if (input.dailyDigest !== undefined) next.dailyDigest = digest(input.dailyDigest);
    writeJson(this.file, next);
    this.value = next;
    return this.public();
  }
}
