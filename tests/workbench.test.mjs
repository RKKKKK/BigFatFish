import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentBoard } from '../runtime/agents/board.mjs';
import { readDshSessions } from '../runtime/agents/dsh.mjs';
import { jumpPlan, jumpTo } from '../runtime/agents/jump.mjs';
import { WorkbenchService } from '../runtime/workbench/service.mjs';
import { WorkbenchSettings } from '../runtime/workbench/settings.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWorkbenchWindow } = require('../desktop/workbench-window.cjs');

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const MINUTE = 60000;

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-workbench-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function doc({ title = 'Task', cwd = 'D:\\work\\project', lastTurn = 1, openStep = null, questions = [], boundary = 'end', at = NOW - 5 * MINUTE, tokens = 12000, window = 100000, steps = 4 } = {}) {
  return {
    version: 7,
    record: {
      identity: { cwd, createdAt: NOW - 10 * MINUTE },
      rows: {
        title: { val: title },
        workingDirectory: { val: cwd },
        sessionStats: { val: { lastTurn, steps, openStep, pendingCalls: {} } },
        turnBoundary: { val: { openTurnStartSeq: openStep ? 5 : null, lastStepBoundary: { kind: boundary }, lastTurn } },
        userQuestions: { val: { questions: { active: questions, settled: [] } } },
        goal: { val: { current: null, failure: null } },
        llmRetry: { val: {} },
        contextPressure: { val: { surfaceTokens: tokens, contextWindow: window } },
        turnOutline: { val: { turns: [{ prompt: '请做这件事', response: '已经完成' }] } },
        timeContext: { val: { lastMessageTime: at } },
      },
    },
  };
}

function writeCache(dshHome, id, value, at) {
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.json');
  const stamp = at ?? value?.record?.rows?.timeContext?.val?.lastMessageTime ?? NOW;
  fs.writeFileSync(file, JSON.stringify(value));
  fs.utimesSync(file, new Date(stamp), new Date(stamp));
  return file;
}

function makeDshHome(t) {
  const home = temp(t);
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: ['archived'] },
    tables: { workspaces: { one: { title: '项目一', sessionIds: ['running', 'done'] } } },
  }));
  writeCache(home, 'running', doc({ title: '正在跑', openStep: { step: 2, startTime: NOW - 2 * MINUTE }, boundary: 'start', at: NOW - MINUTE }));
  writeCache(home, 'question', doc({ title: '等你回答', questions: [{ askedAt: NOW - MINUTE, text: '选哪个？' }], at: NOW - MINUTE }));
  writeCache(home, 'done', doc({ title: '已完成', at: NOW - 5 * MINUTE }));
  writeCache(home, 'stuck', doc({ title: '卡住了', openStep: { step: 3, startTime: NOW - 25 * MINUTE }, boundary: 'start', at: NOW - 20 * MINUTE }));
  writeCache(home, 'archived', doc({ title: '归档', at: NOW - MINUTE }));
  writeCache(home, 'blank', { version: 7, record: { identity: { cwd: 'D:\\work\\project' }, rows: {} } });
  writeCache(home, 'future', { ...doc({ title: '新版本缓存', at: NOW - MINUTE }), version: 8 });
  writeCache(home, 'old', doc({ title: '很久以前', at: NOW - 3 * 60 * MINUTE }), NOW - 3 * 60 * MINUTE);
  return home;
}

test('DSH projection cache becomes task rows with running, question, done, stuck and archived states', t => {
  const home = makeDshHome(t);
  const { rows, error } = readDshSessions({ dshHome: home, now: NOW });
  assert.match(error, /版本不兼容/);
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  assert.equal(byId['dsh:running'].state, 'running');
  assert.equal(byId['dsh:running'].step, 2);
  assert.equal(byId['dsh:running'].tokens, 12000);
  assert.equal(byId['dsh:running'].workspace, '项目一');
  assert.equal(byId['dsh:question'].state, 'question');
  assert.equal(byId['dsh:done'].state, 'done');
  assert.equal(byId['dsh:stuck'].state, 'stuck');
  assert.equal(byId['dsh:archived'], undefined);
  assert.equal(byId['dsh:blank'], undefined);
  assert.equal(byId['dsh:old'], undefined);
  assert.equal(byId['dsh:future'], undefined);
  assert.match(error, /版本不兼容/);
  assert.equal(byId['dsh:running'].name, 'project');
  assert.deepEqual(readDshSessions({ dshHome: path.join(home, 'not-installed'), now: NOW }), { rows: [], error: '' });
});

test('AgentBoard merges DSH rows and keeps hide/find semantics', t => {
  const home = makeDshHome(t), dataDir = temp(t);
  const board = new AgentBoard({ dataDir, dshHome: home, now: () => NOW, dshPollMs: 0 });
  const rows = board.rows();
  assert.ok(rows.some(row => row.id === 'dsh:running'));
  assert.equal(board.find('dsh:running')?.state, 'running');
  assert.equal(board.hide('dsh:running'), true);
  assert.equal(board.rows().some(row => row.id === 'dsh:running'), false);
  assert.equal(board.dshStatus().count, 4);
});

test('workbench settings validate, save and reload', t => {
  const dataDir = temp(t);
  const settings = new WorkbenchSettings(dataDir);
  assert.equal(settings.public().maxConcurrent, 2);
  assert.equal(settings.public().readTaskContent, true);
  assert.equal(settings.public().taskTimeoutMinutes, 30);
  const saved = settings.save({
    allowedRoots: [path.join(dataDir, 'projects'), path.join(dataDir, 'projects')],
    readTaskContent: false,
    confirmDispatch: false,
    autoConsolidate: false,
    maxConcurrent: 3,
    taskTimeoutMinutes: 45,
    codexSandbox: 'read-only',
    dailyDigest: '18:30',
  });
  assert.deepEqual(saved.allowedRoots, [path.join(dataDir, 'projects')]);
  assert.equal(saved.maxConcurrent, 3);
  assert.equal(saved.taskTimeoutMinutes, 45);
  const reloaded = new WorkbenchSettings(dataDir).public();
  assert.equal(reloaded.readTaskContent, false);
  assert.equal(reloaded.codexSandbox, 'read-only');
  assert.equal(reloaded.dailyDigest, '18:30');
  assert.throws(() => settings.save({ maxConcurrent: 9 }), /1 到 4/);
  assert.throws(() => settings.save({ allowedRoots: ['relative/path'] }), /绝对路径/);
  assert.throws(() => settings.save({ dailyDigest: '25:00' }), /HH:MM/);
  assert.equal(settings.public().maxConcurrent, 3, 'a rejected save leaves the old value');
});

test('workbench service summarizes rows and exposes one task', t => {
  const home = makeDshHome(t), dataDir = temp(t);
  const board = new AgentBoard({ dataDir, dshHome: home, now: () => NOW, dshPollMs: 0 });
  const service = new WorkbenchService({ dataDir, agents: board, now: () => NOW });
  const snapshot = service.snapshot();
  assert.equal(snapshot.counts.running, 1);
  assert.equal(snapshot.counts.waiting, 1);
  assert.equal(snapshot.counts.stuck, 1);
  assert.equal(snapshot.counts.done, 1);
  assert.equal(snapshot.counts.byTool.dsh, 4);
  assert.equal(snapshot.dsh.count, 4);
  assert.equal(service.task('dsh:done').row.title, '已完成');
  assert.equal(service.task('dsh:missing').ok, false);
});

test('dispatcher serves the workbench task list and settings', async t => {
  const home = makeDshHome(t), dataDir = temp(t);
  const dispatcher = createDispatcher({ dataDir, dshHome: home, monitor: false, autoRefresh: false, agentOptions: { now: () => NOW, dshPollMs: 0 } });
  t.after(() => dispatcher.close());
  const list = await dispatcher.dispatch('/api/workbench/tasks');
  assert.equal(list.status, 200);
  const body = JSON.parse(list.body.toString('utf8'));
  assert.ok(body.rows.some(row => row.id === 'dsh:running'));
  assert.equal(body.counts.running, 1);
  assert.equal(body.settings.maxConcurrent, 2);
  const open = JSON.parse((await dispatcher.dispatch('/api/workbench/open', { method: 'POST' })).body.toString('utf8'));
  assert.equal(open.ok, true);
  assert.equal(open.opened, false);

  const read = await dispatcher.dispatch('/api/workbench/settings');
  assert.equal(JSON.parse(read.body.toString('utf8')).settings.readTaskContent, true);
  const saved = await dispatcher.dispatch('/api/workbench/settings', { method: 'PUT', body: { readTaskContent: false, maxConcurrent: 3 } });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body.toString('utf8')).settings.maxConcurrent, 3);
  const bad = await dispatcher.dispatch('/api/workbench/settings', { method: 'PUT', body: { maxConcurrent: 9 } });
  assert.equal(bad.status, 400);

  const memory = JSON.parse((await dispatcher.dispatch('/api/workbench/memory')).body.toString('utf8'));
  assert.equal(memory.memory.items.length, 0);
  const savedMemory = JSON.parse((await dispatcher.dispatch('/api/workbench/memory', { method: 'POST', body: { action: 'save', section: 'identity', text: '称呼 RK' } })).body.toString('utf8'));
  assert.equal(savedMemory.ok, true);
  assert.equal(savedMemory.memory.items.length, 1);
  const memoryId = savedMemory.memory.items[0].id;
  const updatedMemory = JSON.parse((await dispatcher.dispatch('/api/workbench/memory', { method: 'POST', body: { action: 'update', id: memoryId, pinned: true } })).body.toString('utf8'));
  assert.equal(updatedMemory.memory.items[0].pinned, true);
  const forgotten = JSON.parse((await dispatcher.dispatch('/api/workbench/memory', { method: 'POST', body: { action: 'forget', id: memoryId } })).body.toString('utf8'));
  assert.equal(forgotten.memory.items.length, 0);

  const one = await dispatcher.dispatch('/api/workbench/tasks/dsh%3Adone');
  assert.equal(one.status, 200);
  assert.equal(JSON.parse(one.body.toString('utf8')).row.title, '已完成');
  const missing = await dispatcher.dispatch('/api/workbench/tasks/dsh%3Amissing');
  assert.equal(missing.status, 404);

  const agents = JSON.parse((await dispatcher.dispatch('/api/agents')).body.toString('utf8'));
  assert.equal(agents.dsh.count, 4);

  for (const [route, type] of [['/workbench.html', 'text/html'], ['/workbench.js', 'javascript'], ['/workbench.css', 'text/css']]) {
    const file = await dispatcher.dispatch(route);
    assert.equal(file.status, 200, route);
    assert.match(file.headers['content-type'], new RegExp(type), route);
  }
  assert.match((await dispatcher.dispatch('/workbench.html')).body.toString('utf8'), /工作台/);
});

test('the workbench window restores clamped bounds, saves state and hides on close', () => {
  const state = { value: { 'dshw-theme': 'soda', 'dshw-workbench': JSON.stringify({ version: 2, x: -200, y: -100, width: 400, height: 300, maximized: false }) },
    get() { return this.value; }, set(value) { this.value = value; } };
  class FakeWindow {
    constructor(options) {
      this.options = options; this.handlers = new Map(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false; this.focused = false; this.destroyed = false; this.url = ''; this.menuHidden = false;
      this.webContents = { setWindowOpenHandler() {}, on() {}, isDestroyed: () => false, send() {} };
    }
    on(name, fn) { const list = this.handlers.get(name) || []; list.push(fn); this.handlers.set(name, list); }
    once(name, fn) { const list = this.handlers.get(name) || []; const wrap = (...args) => { fn(...args); this.handlers.set(name, (this.handlers.get(name) || []).filter(item => item !== wrap)); }; list.push(wrap); this.handlers.set(name, list); }
    emit(name, event = {}) { for (const fn of [...(this.handlers.get(name) || [])]) fn(event); }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    setMenuBarVisibility(value) { this.menuHidden = value; }
    show() { this.visible = true; } focus() { this.focused = true; } hide() { this.visible = false; }
    isVisible() { return this.visible; } isMinimized() { return false; } restore() {} isDestroyed() { return this.destroyed; }
    isMaximized() { return false; } getNormalBounds() { return this.bounds; } getBounds() { return this.bounds; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) };
  const controller = createWorkbenchWindow({ app: { focus() {} }, BrowserWindow: FakeWindow, screen, root: 'C:\\app', origin: 'whale://widget', state, isQuitting: () => false });
  controller.show();
  const win = controller.window();
  assert.equal(win.options.title, '工作台');
  assert.equal(win.options.frame, false);
  assert.equal(win.options.backgroundColor, '#02040a');
  assert.match(win.options.webPreferences.preload, /workbench-preload\.cjs$/);
  assert.equal(win.options.minWidth, 900);
  assert.ok(win.options.width >= 900 && win.options.height >= 620);
  assert.ok(win.options.x >= 0 && win.options.y >= 0);
  assert.equal(win.url, 'whale://widget/workbench.html');
  assert.equal(win.menuHidden, false);
  win.emit('ready-to-show');
  assert.equal(win.isVisible(), true);
  assert.equal(win.focused, true);
  controller.save();
  const saved = JSON.parse(state.value['dshw-workbench']);
  assert.ok(saved.width >= 900 && saved.height >= 620);
  assert.equal(state.value['dshw-theme'], 'soda', 'saving bounds keeps the pet settings');
  let prevented = false;
  win.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'closing the window hides it instead of quitting');
  assert.equal(win.isVisible(), false);
  controller.destroy();
  assert.equal(controller.window(), null);
});

test('DSH jump opens the DSH app; Codex threads open the app on Windows and macOS', async () => {
  const dsh = { id: 'dsh:x', tool: 'dsh' };
  assert.deepEqual(jumpPlan(dsh, 'win32'), { kind: 'dsh-open', command: 'cmd.exe', args: ['/d', '/s', '/c', 'start "" "dsh://open"'], verbatim: true });
  assert.deepEqual(jumpPlan(dsh, 'darwin'), { kind: 'dsh-open', command: 'open', args: ['dsh://open'] });
  assert.equal(jumpPlan({ id: 'codex:x', tool: 'codex', cwd: '/work' }, 'win32'), null);
  assert.equal(jumpPlan({ id: 'codex:x', tool: 'codex', app: true }, 'darwin').kind, 'codex-app');
  assert.equal(jumpPlan({ id: 'task:x', tool: 'codex', source: 'dispatched', sessionId: 'thread-1' }, 'win32').kind, 'codex-app');
  const calls = [];
  const focused = await jumpTo({ id: 'dsh:x', tool: 'dsh', source: 'observed' }, {
    platform: 'win32', run: async (command, args) => { calls.push([command, args]); return 'focused'; },
  });
  assert.equal(focused.ok, true);
  assert.equal(focused.target, 'dsh');
  assert.equal(calls.length, 1);

  const codex = await jumpTo({ id: 'codex:x', tool: 'codex' }, {
    platform: 'win32', run: async () => 'focused',
  });
  assert.equal(codex.ok, true);
  assert.equal(codex.target, 'codex-app');
  assert.match(codex.message, /Codex 窗口/);

  const missing = await jumpTo({ id: 'codex:x', tool: 'codex' }, {
    platform: 'win32', run: async () => '',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /没能切到 Codex 窗口/);
});
