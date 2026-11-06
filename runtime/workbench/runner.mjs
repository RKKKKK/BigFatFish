import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readJson, writeJson } from '../paths.mjs';
import { agentRow } from '../agents/row.mjs';

// Dispatched work runs as a child process. Codex writes its own session log;
// DSH writes a headless session and projection cache. The runner owns only the
// live process, queue and drafts; observation of finished sessions stays with
// AgentBoard.
const DRAFT_TTL = 10 * 60 * 1000;
const KEEP_MS = 2 * 60 * 60 * 1000;
const PRUNE_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE = new Set(['queued', 'starting', 'running', 'stopping']);
const TERMINAL = new Set(['done', 'failed', 'timeout', 'aborted']);
const SANDBOXES = new Set(['workspace-write', 'read-only', 'danger-full-access']);

function eventText(value, max = 500) {
  return String(value || '')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function describeEvent(task, event, now) {
  if (task.tool === 'codex') {
    if (event.type === 'thread.started') return '会话已建立';
    if (event.type === 'item.completed' && event.item) {
      if (event.item.type === 'agent_message') return event.item.text;
      if (event.item.type === 'command_execution') return '运行命令：' + (event.item.command || '');
      if (event.item.type === 'file_change') return '修改文件：' + (event.item.path || event.item.file || '');
      return '步骤完成：' + event.item.type;
    }
    if (event.type === 'turn.completed') return '本轮回答完成';
    if (event.type === 'turn.failed') return '本轮失败：' + (event.error?.message || event.message || '');
    return '';
  }
  if (event.type === 'status') {
    if (event.phase === 'step_start') return '第 ' + (event.step || '?') + ' 步开始';
    if (event.phase === 'turn_start') return '开始处理';
    if (event.phase === 'turn_end') return '本轮处理结束';
    return '';
  }
  if (event.type === 'text') return event.text;
  if (event.type === 'tool_call') return '工具：' + (event.tool || '');
  if (event.type === 'tool_result') return event.error || '工具完成';
  if (event.type === 'final') return event.text;
  if (event.type === 'error') return '错误：' + (event.message || '');
  return '';
}

export function codexArgs({ cwd, sandbox = 'workspace-write', lastFile }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', cwd, '-o', lastFile];
  if (sandbox === 'read-only') args.push('-s', 'read-only');
  else if (sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('--approve-for-me');
  args.push('-');
  return args;
}

export function dshPatchText() {
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
    '    reasoningEffort: high',
    '- id: credentials',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '- id: deepseek-account',
    '  disabled: false',
    '',
  ].join('\n');
}

function exists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (exists(file)) return file;
    }
  }
  return '';
}

export function findCodex() {
  const candidates = [
    process.env.CODEX_BIN,
    findOnPath('codex'),
    path.join(os.homedir(), '.codex', '.sandbox-bin', 'codex.exe'),
    path.join(os.homedir(), '.codex', '.sandbox-bin', 'codex'),
  ].filter(Boolean);
  return candidates.find(exists) || '';
}

// The Desktop installation carries a runtime CLI. Call its Electron binary
// directly; going through dsh.cmd needs fragile Windows quote handling.
export function findDsh() {
  if (process.platform === 'win32') {
    const roots = [
      process.env.DSH_INSTALL,
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness'),
      path.join(process.env.ProgramFiles || '', 'DeepSeek Harness'),
    ].filter(Boolean);
    for (const root of roots) {
      const electron = path.join(root, 'DeepSeek Harness.exe');
      const cli = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
      if (exists(electron)) return { command: electron, prefix: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'desktop' };
    }
  }
  const direct = findOnPath('dsh');
  if (direct && !/\.cmd$/i.test(direct)) return { command: direct, prefix: [], env: {}, kind: 'cli' };
  return null;
}

function inside(root, target) {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? target.toLowerCase() : target;
  return b === a || b.startsWith(a + path.sep);
}

function sensitive(target) {
  const home = os.homedir();
  const blocked = [path.join(home, '.ssh'), path.join(home, '.codex'), path.join(home, '.dsh')];
  if (process.platform === 'win32') blocked.push(path.join(process.env.WINDIR || 'C:\\Windows'), process.env.ProgramFiles || 'C:\\Program Files');
  return blocked.some(root => root && inside(path.resolve(root), target));
}

function clip(value, max) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''; }

export class TaskRunner {
  constructor({ dataDir, settings, spawnImpl = spawn, killImpl = null, now = () => Date.now(), onEvent = () => {}, onNotice = () => {}, timeoutMs = 30 * 60 * 1000, codexBin = null, dshCommand = null, dshHome = path.join(os.homedir(), '.dsh'), scheduledDsh = false }) {
    this.dataDir = dataDir;
    this.settings = settings;
    this.codexBin = codexBin;
    this.dshCommand = dshCommand;
    this.dshHome = dshHome;
    this.scheduledDsh = scheduledDsh;
    this.scheduledTasks = new Map();
    this.spawnImpl = spawnImpl;
    this.killImpl = killImpl || (child => this.killTree(child));
    this.now = now;
    this.onEvent = onEvent;
    this.onNotice = onNotice;
    this.timeoutMs = timeoutMs;
    this.file = path.join(dataDir, 'work-tasks.json');
    this.auditFile = path.join(dataDir, 'work-audit.jsonl');
    this.tasks = new Map();
    this.children = new Map();
    this.queue = [];
    this.timers = new Map();
    this.stopped = false;
    this.load();
  }

  load() {
    let stored = null;
    try { stored = readJson(this.file, null); } catch {}
    if (!Array.isArray(stored?.tasks)) return;
    const now = this.now();
    for (const task of stored.tasks.slice(-200)) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !['codex', 'dsh'].includes(task.tool)) continue;
      if (task.status === 'draft' && now - Number(task.createdAt) > DRAFT_TTL) continue;
      if (TERMINAL.has(task.status) && now - Number(task.updatedAt || task.finishedAt || task.createdAt) > PRUNE_MS) continue;
      const next = { ...task, events: [], updatedAt: Number(task.updatedAt) || Number(task.createdAt) || now };
      if (ACTIVE.has(next.status)) { next.status = 'aborted'; next.error = '挂件重启，任务已中断'; next.finishedAt = now; next.updatedAt = now; }
      if (next.status === 'queued') { next.status = 'aborted'; next.error = '挂件重启，排队任务已取消'; next.finishedAt = now; next.updatedAt = now; }
      this.tasks.set(next.id, next);
      if (next.status === 'queued') this.queue.push(next.id);
    }
    this.save();
  }

  publicSettings() { return this.settings?.public?.() || {}; }

  save() {
    const tasks = [...this.tasks.values()].filter(task => task.status !== 'draft' || this.now() - Number(task.createdAt) <= DRAFT_TTL)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-200)
      .map(task => ({ ...task, events: undefined }));
    try { writeJson(this.file, { version: 1, tasks }); } catch {}
  }

  audit(action, task, by = 'system') {
    try {
      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), action, tool: task?.tool || '', cwd: task?.cwd || '', taskId: task?.id || '', draftId: task?.status === 'draft' ? task.id : '', by });
      fs.appendFileSync(this.auditFile, line + '\n');
    } catch {}
  }

  emit(type, task, previous) {
    try { this.onEvent({ type, task: this.record(task), previous }); } catch {}
  }

  record(task) {
    if (!task) return null;
    const { events, ...rest } = task;
    return structuredClone(rest);
  }

  note(task, event) {
    const text = eventText(describeEvent(task, event));
    if (!text) return;
    if (!Array.isArray(task.events)) task.events = [];
    const previous = task.events[task.events.length - 1];
    if (previous && previous.text === text && previous.type === event.type) return;
    task.events.push({ at: this.now(), type: String(event.type || ''), text });
    if (task.events.length > 120) task.events.splice(0, task.events.length - 120);
  }

  events(id) {
    const task = this.find(id);
    if (!task) return { ok: false, error: '任务不存在' };
    return {
      ok: true,
      taskId: task.id,
      status: task.status,
      events: Array.isArray(task.events) ? task.events.slice(-120) : [],
    };
  }

  snapshot() {
    this.cleanup();
    const tasks = [...this.tasks.values()].filter(task => task.status !== 'draft').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return {
      maxConcurrent: Math.max(1, Math.min(4, Number(this.publicSettings().maxConcurrent) || 2)),
      active: tasks.filter(task => ACTIVE.has(task.status)).length,
      queue: [...this.queue],
      drafts: this.drafts(),
      tasks: tasks.map(task => this.record(task)),
    };
  }

  cleanup() {
    const now = this.now();
    for (const task of this.tasks.values()) {
      if (task.status === 'draft' && now - Number(task.createdAt) > DRAFT_TTL) {
        this.tasks.delete(task.id);
        this.emit('cancelled', { ...task, status: 'aborted', error: '草稿已过期' });
      }
    }
  }

  drafts() {
    this.cleanup();
    return [...this.tasks.values()].filter(task => task.status === 'draft').sort((a, b) => b.createdAt - a.createdAt).map(task => this.record(task));
  }

  find(id) {
    if (typeof id !== 'string') return null;
    const key = id.startsWith('task:') ? id.slice(5) : id;
    return this.tasks.get(key) || null;
  }

  // The task window shows dispatched work alongside observed sessions. The
  // session id suppresses the observed duplicate once Codex/DSH report it.
  rows() {
    const now = this.now();
    return [...this.tasks.values()]
      .filter(task => task.status !== 'draft' && (ACTIVE.has(task.status) || now - Number(task.updatedAt || task.createdAt) < KEEP_MS))
      .map(task => {
        const state = task.status === 'done' ? 'done' : ['failed', 'timeout'].includes(task.status) ? 'failed' : task.status === 'aborted' ? 'aborted' : 'running';
        const since = task.status === 'queued' ? task.createdAt : task.startedAt || task.createdAt;
        return agentRow({
          id: 'task:' + task.id, taskId: task.id, key: 'task:' + task.status + ':' + (task.updatedAt || task.createdAt),
          tool: task.tool, app: false, cwd: task.cwd, state, since, activeAt: task.updatedAt || task.createdAt,
          startedAt: task.startedAt || task.createdAt, finishedAt: task.finishedAt || null,
          title: clip(task.prompt, 80), prompt: task.prompt, latest: clip(task.latestText || task.lastEvent, 4000), error: task.error || '',
          sessionId: task.sessionId || '', source: 'dispatched', taskStatus: task.status,
          canStop: ACTIVE.has(task.status), tokens: task.tokens || null,
        });
      });
  }

  sessionIds() {
    const now = this.now();
    return new Set([...this.tasks.values()]
      .filter(task => ACTIVE.has(task.status) || now - Number(task.updatedAt || task.createdAt) < KEEP_MS)
      .map(task => task.sessionId).filter(Boolean));
  }

  validateCwd(cwd) {
    const text = typeof cwd === 'string' ? cwd.trim() : '';
    if (!text || text.length > 4096 || /[\x00-\x1f]/.test(text)) throw new Error('工作目录格式无效');
    const resolved = path.resolve(text);
    let stat;
    try { stat = fs.statSync(resolved); } catch { throw new Error('工作目录不存在'); }
    if (!stat.isDirectory()) throw new Error('工作目录不是文件夹');
    if (sensitive(resolved)) throw new Error('不能在这个目录里启动任务');
    const roots = Array.isArray(this.publicSettings().allowedRoots) ? this.publicSettings().allowedRoots : [];
    if (!roots.length) throw new Error('请先在工作台设置里添加允许下发任务的工作目录');
    if (!roots.some(root => inside(path.resolve(root), resolved))) throw new Error('这个目录不在允许下发任务的范围内');
    return resolved;
  }

  createDraft({ tool, prompt, cwd, resumeTaskId = '', conversationId = '', by = 'chat' } = {}) {
    let resumeSessionId = '';
    const source = typeof resumeTaskId === 'string' && resumeTaskId ? this.find(resumeTaskId) : null;
    if (resumeTaskId && !source) throw new Error('要续跑的任务已经不在了');
    if (source) {
      if (!source.sessionId) throw new Error('这个任务还没有会话 ID，不能续跑');
      if (tool && tool !== source.tool) throw new Error('续跑工具必须和原任务一致');
      tool = source.tool;
      cwd = source.cwd;
      resumeSessionId = source.sessionId;
    }
    if (!['codex', 'dsh'].includes(tool)) throw new Error('只能下发 Codex 或 DSH 任务');
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text || text.length > 8000 || /[\x00]/.test(text)) throw new Error('任务内容须为 1 到 8000 个字符');
    const root = this.validateCwd(cwd);
    const now = this.now();
    const task = {
      id: 'task-' + randomUUID(), tool, prompt: text, cwd: root, status: 'draft', createdAt: now, updatedAt: now,
      expiresAt: now + DRAFT_TTL, conversationId, resumeSessionId, resumeTaskId: source?.id || '', events: [],
    };
    this.tasks.set(task.id, task);
    this.save();
    this.audit('draft', task, by);
    this.emit('draft', task);
    return this.record(task);
  }

  startDraft(id, { by = 'ui', requireConfirm = false, userText = '' } = {}) {
    const task = this.find(id);
    if (!task) throw new Error('草稿不存在');
    if (task.status !== 'draft') throw new Error('这个草稿已经处理过了');
    if (this.now() - Number(task.createdAt) > DRAFT_TTL) { task.status = 'aborted'; task.error = '草稿已过期'; this.save(); throw new Error('草稿已过期，请重新下发'); }
    if (requireConfirm && !/^(确认|开始|启动|好|可以|行|ok|go|run)(启动|开始)?吧?[。.!！\s]*$/i.test(String(userText || '').trim())) {
      throw new Error('需要你明确回复“确认”或在工作台点确认后才能启动');
    }
    task.status = 'queued'; task.updatedAt = this.now(); task.startedBy = by;
    this.queue.push(task.id);
    this.save(); this.audit('start', task, by); this.emit('queued', task);
    this.pump();
    return this.record(task);
  }

  cancelDraft(id, { by = 'ui' } = {}) {
    const task = this.find(id);
    if (!task || task.status !== 'draft') throw new Error('草稿不存在');
    task.status = 'aborted'; task.error = '草稿已取消'; task.updatedAt = this.now(); task.finishedAt = this.now();
    this.tasks.delete(task.id);
    this.save(); this.audit('cancel', task, by); this.emit('cancelled', task);
    return true;
  }

  stop(id, { by = 'ui', timeout = false } = {}) {
    const task = this.find(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'draft') return this.cancelDraft(id, { by });
    if (TERMINAL.has(task.status)) return this.record(task);
    if (this.scheduledTasks.has(id)) {
      this.endScheduledDsh(task, timeout).catch(() => {});
      return this.record(task);
    }
    if (task.status === 'queued') {
      this.queue = this.queue.filter(item => item !== task.id);
      task.status = 'aborted'; task.error = timeout ? '任务超时' : '已取消'; task.finishedAt = this.now(); task.updatedAt = this.now();
      this.save(); this.audit('stop', task, by); this.emit('aborted', task);
      return this.record(task);
    }
    task.status = timeout ? 'timeout' : 'stopping';
    task.error = timeout ? '任务超过时限，已停止' : '已停止';
    task.updatedAt = this.now();
    if (timeout) task.finishedAt = this.now();
    this.save(); this.audit('stop', task, by);
    const child = this.children.get(task.id);
    if (child) { try { this.killImpl(child, task); } catch {} }
    if (timeout) { task.status = 'timeout'; this.emit('timeout', task); try { this.onNotice({ type: 'task', task: this.record(task) }); } catch {} }
    else { clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id); const timer = setTimeout(() => this.finish(task, 'aborted', '已停止'), 5000); timer.unref?.(); this.timers.set(task.id, timer); }
    this.pump();
    return this.record(task);
  }

  pump() {
    if (this.stopped) return;
    const max = Math.max(1, Math.min(4, Number(this.publicSettings().maxConcurrent) || 2));
    while ([...this.tasks.values()].filter(task => task.status === 'starting' || task.status === 'running' || task.status === 'stopping').length < max) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.status !== 'queued') continue;
      try { this.launch(task); }
      catch (error) { this.finish(task, 'failed', error?.message || '任务没能启动'); }
    }
  }

  // A headless DSH inherits the pet's Windows token. When the pet runs with
  // Chromium's no-sandbox switch it is a Low-integrity process, and DSH cannot
  // write the Medium-integrity profile under the real ~/.dsh. Give each
  // dispatched DSH its own writable home inside the pet data directory and
  // copy only the profile, credentials and the one resumed session.
  isolatedDshHome(task) {
    const target = path.join(this.dataDir, 'dsh-home');
    const source = this.dshHome;
    try {
      fs.mkdirSync(path.join(target, 'profiles'), { recursive: true });
      fs.mkdirSync(path.join(target, 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(target, 'storages'), { recursive: true });
      fs.mkdirSync(path.join(target, 'tmp'), { recursive: true });
      fs.mkdirSync(path.join(target, 'cache'), { recursive: true });
      const profile = path.join(source, 'profiles', 'headless');
      if (fs.existsSync(profile)) {
        fs.cpSync(profile, path.join(target, 'profiles', 'headless'), { recursive: true, force: true });
      }
      for (const name of ['.credentials.yaml', '.anonymous-user-id', 'cordis.patch.yml']) {
        const file = path.join(source, name);
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, name));
      }
      const resume = task?.resumeSessionId;
      if (resume) {
        const found = [];
        const walk = (dir, depth) => {
          if (depth > 4) return;
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd' && full.includes('session-' + resume)) found.push(full);
          }
        };
        walk(path.join(source, 'sessions'), 0);
        if (found[0]) {
          const relative = path.relative(path.join(source, 'sessions'), found[0]);
          const destination = path.join(target, 'sessions', relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(found[0], destination);
        }
      }
    } catch {
      // If the copy fails, DSH may still start against the default home; the
      // original error is more useful than replacing it with a copy error.
    }
    return target;
  }

  plan(task) {
    if (task.tool === 'codex') {
      const command = this.codexBin || findCodex();
      if (!command) throw new Error('找不到 Codex CLI，请安装 Codex 或设置 CODEX_BIN');
      const dir = path.join(this.dataDir, 'work-runs', task.id);
      fs.mkdirSync(dir, { recursive: true });
      const lastFile = path.join(dir, 'last.txt');
      if (task.resumeSessionId) {
        return { command, args: ['exec', 'resume', task.resumeSessionId, '--json', '--skip-git-repo-check', '-o', lastFile, '-'], env: {}, lastFile };
      }
      const sandbox = SANDBOXES.has(this.publicSettings().codexSandbox) ? this.publicSettings().codexSandbox : 'workspace-write';
      return { command, args: codexArgs({ cwd: task.cwd, sandbox, lastFile }), env: {}, lastFile };
    }
    const dsh = this.dshCommand || findDsh();
    if (!dsh) throw new Error('找不到 DSH 运行时，请确认 DeepSeek Harness 已安装');
    const patch = path.join(this.dataDir, 'dsh-headless.patch.yml');
    if (!exists(patch)) { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(patch, dshPatchText(), 'utf8'); }
    const resume = task.resumeSessionId ? ['--session-id', task.resumeSessionId] : [];
    const baseEnv = { ...(dsh.env || {}) };
    if (!this.scheduledDsh) {
      const home = this.isolatedDshHome(task);
      // DSH's Windows ACL sandbox rejects a TEMP root beneath its workspace.
      // Keep the isolated home, but put TEMP on the user temp volume (outside
      // the project) so command execution can provision its ACL lock files.
      const temp = path.join(os.tmpdir(), 'whale-dsh-tmp');
      const cache = path.join(temp, 'cache');
      fs.mkdirSync(temp, { recursive: true });
      fs.mkdirSync(cache, { recursive: true });
      Object.assign(baseEnv, { DSH_HOME: home, TEMP: temp, TMP: temp, TMPDIR: temp,
        XDG_CACHE_HOME: cache, PIP_CACHE_DIR: path.join(cache, 'pip') });
    }
    return { command: dsh.command, args: [...dsh.prefix, '--profile', 'headless', '--patch', patch, ...resume, '--json', '-'], env: baseEnv };
  }

  psLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

  quoteArgument(value) {
    const text = String(value);
    return /[\s"]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text;
  }

  runScheduler(args, timeout = 10000) {
    return new Promise((resolve, reject) => {
      execFile('schtasks.exe', args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message || 'schtasks 失败').trim()));
        else resolve(String(stdout || '').trim());
      });
    });
  }

  // A Low-integrity pet cannot spawn a Medium-integrity child directly. Task
  // Scheduler launches the wrapper in the user's normal (Medium) token, so DSH
  // can write its profile, TEMP and the requested working directory.
  async launchScheduledDsh(task) {
    task.status = 'starting'; task.startedAt = this.now(); task.updatedAt = this.now(); this.save();
    const plan = this.plan(task);
    const jobDir = path.join(this.dataDir, 'work-dsh', task.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const promptFile = path.join(jobDir, 'prompt.txt');
    const outFile = path.join(jobDir, 'out.jsonl');
    const errFile = path.join(jobDir, 'err.log');
    const codeFile = path.join(jobDir, 'code.txt');
    const pidFile = path.join(jobDir, 'pid.txt');
    const scriptFile = path.join(jobDir, 'run.ps1');
    fs.writeFileSync(promptFile, task.prompt, 'utf8');
    const argLine = plan.args.map(arg => this.quoteArgument(arg)).join(' ');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$env:ELECTRON_RUN_AS_NODE = '1'",
      '$exe = ' + this.psLiteral(plan.command),
      '$argLine = ' + this.psLiteral(argLine),
      'try {',
      '  $p = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory ' + this.psLiteral(task.cwd) +
        ' -RedirectStandardInput ' + this.psLiteral(promptFile) + ' -RedirectStandardOutput ' + this.psLiteral(outFile) +
        ' -RedirectStandardError ' + this.psLiteral(errFile) + ' -WindowStyle Hidden -PassThru',
      '  $p.Id | Set-Content -LiteralPath ' + this.psLiteral(pidFile) + ' -Encoding ascii',
      '  $p.WaitForExit()',
      '  $p.ExitCode | Set-Content -LiteralPath ' + this.psLiteral(codeFile) + ' -Encoding ascii',
      '} catch {',
      '  $_.Exception.Message | Set-Content -LiteralPath ' + this.psLiteral(errFile) + ' -Encoding utf8',
      '  1 | Set-Content -LiteralPath ' + this.psLiteral(codeFile) + ' -Encoding ascii',
      '}',
      '',
    ].join('\r\n');
    fs.writeFileSync(scriptFile, '\uFEFF' + script, 'utf8');
    const hash = createHash('sha1').update(task.id).digest('hex').slice(0, 16);
    const taskName = 'WhaleDsh-' + hash;
    const entry = { taskName, jobDir, outFile, errFile, codeFile, pidFile, offset: 0, buffer: '', stderr: '', timer: null };
    this.scheduledTasks.set(task.id, entry);
    task.lastEvent = '已提交到系统调度';
    task.updatedAt = this.now(); this.save();
    const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const action = `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}"`;
    try {
      await this.runScheduler(['/Create', '/TN', taskName, '/TR', action, '/SC', 'ONCE', '/ST', '23:59', '/F', '/RL', 'LIMITED']);
      await this.runScheduler(['/Run', '/TN', taskName]);
    } catch (error) {
      // A Low-integrity caller may not be allowed to register a task. Fall
      // back to the Safer normal-user launcher; the script is the same.
      try {
        const child = spawn('runas.exe', ['/trustlevel:0x20000', action], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref?.();
        entry.runas = true;
      } catch {
        clearInterval(entry.timer); this.scheduledTasks.delete(task.id);
        this.finish(task, 'failed', 'DSH 调度任务启动失败：' + error.message);
        return;
      }
    }
    task.status = 'running'; task.updatedAt = this.now(); this.save(); this.emit('running', task);
    entry.timer = setInterval(() => this.pollScheduledDsh(task), 300);
    entry.timer.unref?.();
    const minutes = Number(this.publicSettings().taskTimeoutMinutes);
    const limit = Number.isFinite(minutes) ? Math.max(1, Math.min(120, minutes)) * 60000 : Number(this.timeoutMs) || 30 * 60 * 1000;
    const timer = setTimeout(() => this.stop(task.id, { timeout: true, by: 'timer' }), Math.max(60000, limit));
    timer.unref?.();
    this.timers.set(task.id, timer);
  }

  async pollScheduledDsh(task) {
    const entry = this.scheduledTasks.get(task.id);
    if (!entry) return;
    try {
      if (!task.pid && fs.existsSync(entry.pidFile)) {
        const pid = Number(fs.readFileSync(entry.pidFile, 'utf8').trim());
        if (Number.isSafeInteger(pid) && pid > 0) { task.pid = pid; task.updatedAt = this.now(); this.save(); }
      }
      if (fs.existsSync(entry.outFile)) {
        const size = fs.statSync(entry.outFile).size;
        if (size > entry.offset) {
          const fd = fs.openSync(entry.outFile, 'r');
          const buffer = Buffer.alloc(size - entry.offset);
          fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
          fs.closeSync(fd);
          entry.offset = size;
          entry.buffer += buffer.toString('utf8');
          const lines = entry.buffer.split('\n');
          entry.buffer = lines.pop() || '';
          for (const line of lines) if (line.trim()) this.accept(task, line);
        }
      }
      if (!fs.existsSync(entry.codeFile)) return;
      clearInterval(entry.timer); entry.timer = null;
      this.scheduledTasks.delete(task.id);
      clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id);
      if (entry.buffer.trim()) this.accept(task, entry.buffer);
      const code = Number(fs.readFileSync(entry.codeFile, 'utf8').trim());
      if (fs.existsSync(entry.errFile)) entry.stderr = fs.readFileSync(entry.errFile, 'utf8').slice(-2000);
      this.runScheduler(['/Delete', '/TN', entry.taskName]).catch(() => {});
      this.closed(task, Number.isFinite(code) ? code : 1, null, entry.stderr);
      try { fs.rmSync(entry.jobDir, { recursive: true, force: true }); } catch {}
    } catch (error) {
      clearInterval(entry.timer); this.scheduledTasks.delete(task.id);
      this.runScheduler(['/Delete', '/TN', entry.taskName]).catch(() => {});
      this.finish(task, 'failed', 'DSH 调度任务读取失败：' + error.message);
    }
  }

  async endScheduledDsh(task, timeout = false) {
    const entry = this.scheduledTasks.get(task.id);
    if (!entry) return;
    clearInterval(entry.timer); entry.timer = null;
    clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id);
    this.scheduledTasks.delete(task.id);
    try { await this.runScheduler(['/End', '/TN', entry.taskName]); } catch {}
    try { await this.runScheduler(['/Delete', '/TN', entry.taskName]); } catch {}
    try { fs.rmSync(entry.jobDir, { recursive: true, force: true }); } catch {}
    this.finish(task, timeout ? 'timeout' : 'aborted', timeout ? '任务超过时限，已停止' : '已停止');
  }

  launch(task) {
    if (task.tool === 'dsh' && this.scheduledDsh) {
      this.launchScheduledDsh(task).catch(error => this.finish(task, 'failed', error?.message || 'DSH 调度任务启动失败'));
      return;
    }
    const plan = this.plan(task);
    task.status = 'starting'; task.startedAt = this.now(); task.updatedAt = this.now(); this.save();
    const env = { ...process.env, ...plan.env };
    // Do not pass the host's DSH session/profile identity into a child run.
    delete env.DSH_SESSION_ID; delete env.DSH_PROFILE; delete env.DSH_PROFILE_DIR; delete env.DSH_WEB_URL;
    const child = this.spawnImpl(plan.command, plan.args, { cwd: task.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.set(task.id, child);
    task.pid = child.pid;
    task.status = 'running'; task.updatedAt = this.now(); this.save();
    this.emit('running', task);
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) this.accept(task, line);
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', error => this.finish(task, 'failed', error?.message || '任务进程启动失败'));
    child.on('close', (code, signal) => this.closed(task, code, signal, stderr));
    try { child.stdin.end(task.prompt); } catch {}
    const minutes = Number(this.publicSettings().taskTimeoutMinutes);
    const limit = Number.isFinite(minutes) ? Math.max(1, Math.min(120, minutes)) * 60000 : Number(this.timeoutMs) || 30 * 60 * 1000;
    const timer = setTimeout(() => this.stop(task.id, { timeout: true, by: 'timer' }), Math.max(60000, limit));
    timer.unref?.();
    this.timers.set(task.id, timer);
  }

  accept(task, line) {
    let event;
    try { event = JSON.parse(line); } catch { return; } // DSH prints non-JSON diagnostics.
    if (!event || typeof event !== 'object') return;
    task.updatedAt = this.now();
    this.note(task, event);
    if (task.tool === 'codex') {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') task.sessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message' && typeof event.item.text === 'string') task.latestText = clip(event.item.text, 2000);
        else if (event.item.type === 'command_execution') task.lastEvent = '运行命令';
        else if (event.item.type === 'file_change') task.lastEvent = '修改文件';
      }
      if (event.type === 'turn.completed') {
        if (event.usage && typeof event.usage.total_tokens === 'number') task.tokens = event.usage.total_tokens;
        task.finalText = task.latestText || task.finalText;
        this.finish(task, 'done', '');
      }
      if (event.type === 'turn.failed') this.finish(task, 'failed', clip(event.error?.message || event.message, 500));
    } else {
      if (event.type === 'session' && typeof event.sessionId === 'string') task.sessionId = event.sessionId;
      if (event.type === 'status') {
        task.lastEvent = event.phase === 'step_start' ? '第 ' + (event.step || '?') + ' 步' : event.phase === 'turn_start' ? '开始' : task.lastEvent;
        if (event.phase === 'turn_end') {
          const reason = event.reason || {};
          if (reason.kind === 'completed') { task.finalText = task.latestText || task.finalText; this.finish(task, 'done', ''); }
          else if (reason.kind === 'error') this.finish(task, 'failed', clip(reason.error?.message || 'DSH 任务失败', 500));
        }
      }
      if (event.type === 'text' && typeof event.text === 'string') task.latestText = clip(event.text, 2000);
      if (event.type === 'tool_call') task.lastEvent = '工具：' + clip(event.tool, 30);
      if (event.type === 'tool_result') {
        const result = String(event.result || '');
        if (/SetNamedSecurityInfoW|grantWrite\(/.test(result)) task.error = '目标目录的 Windows 权限阻止 DSH 启动命令行';
        task.lastEvent = task.error || '工具完成';
      }
      if (event.type === 'final' && typeof event.text === 'string') task.finalText = clip(event.text, 4000);
      if (event.type === 'error' && event.message) task.lastEvent = clip(event.message, 200);
    }
    this.save();
  }

  closed(task, code, signal, stderr = '') {
    clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id);
    this.children.delete(task.id);
    task.exitCode = code; task.signal = signal || '';
    if (task.status === 'stopping') this.finish(task, 'aborted', '已停止');
    else if (!TERMINAL.has(task.status)) {
      const raw = stderr || task.error || '任务进程退出';
      const integrity = task.tool === 'dsh' && code !== 0 && /EPERM|CreateFileW|Win32\s*5\b|integrity/i.test(raw);
      this.finish(task, code === 0 ? 'done' : 'failed', code === 0 ? '' :
        integrity ? 'DSH 子进程被 Windows 低完整性拦住，无法写项目文件。请用管理员身份重新启动大肥鱼后再试。原始错误：' + clip(raw, 320)
          : clip(raw, 500));
    }
    else { task.updatedAt = this.now(); this.save(); }
    this.pump();
  }

  finish(task, status, error = '') {
    if (TERMINAL.has(task.status) && task.status !== status) return;
    task.status = status; task.error = error || task.error || ''; task.finishedAt = this.now(); task.updatedAt = this.now();
    clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id);
    this.save(); this.audit('finish', task, 'system'); this.emit(status, task);
    try { this.onNotice({ type: 'task', task: this.record(task) }); } catch {}
  }

  killTree(child) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
    if (process.platform === 'win32' && child.pid) {
      try { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.unref?.(); }
      catch { try { child.kill(); } catch {} }
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref?.();
    }
  }

  async close() {
    this.stopped = true;
    for (const task of this.tasks.values()) if (ACTIVE.has(task.status)) await this.stop(task.id, { by: 'shutdown' });
    for (const id of [...this.scheduledTasks.keys()]) {
      const task = this.find(id);
      if (task) await this.endScheduledDsh(task, false);
    }
    this.save();
  }
}
