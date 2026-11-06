import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TaskRunner, codexArgs } from '../runtime/workbench/runner.mjs';
import { createWorkTaskTools } from '../runtime/workbench/task-tools.mjs';
import { AgentBoard } from '../runtime/agents/board.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function settingsFor(roots, extra = {}) {
  return { public: () => ({ allowedRoots: roots, maxConcurrent: 1, codexSandbox: 'workspace-write', ...extra }) };
}

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function setup(t, { roots = null, maxConcurrent = 1 } = {}) {
  const dataDir = temp(t), cwd = temp(t), spawns = [], kills = [], notices = [];
  const allowed = roots || [cwd];
  const spawnImpl = (command, args, options) => {
    const child = fakeChild(1000 + spawns.length);
    spawns.push({ command, args, options, child });
    return child;
  };
  const killImpl = (child) => { kills.push(child.pid); child.killed = true; };
  const runner = new TaskRunner({
    dataDir, settings: settingsFor(allowed, { maxConcurrent }), spawnImpl, killImpl, now: () => NOW,
    timeoutMs: 60 * 60 * 1000, codexBin: 'fake-codex', dshHome: path.join(dataDir, 'dsh-source'), scheduledDsh: false,
    dshCommand: { command: 'fake-dsh', prefix: [], env: {} },
    onNotice: notice => notices.push(notice),
  });
  t.after(() => runner.close());
  return { dataDir, cwd, spawns, kills, notices, runner };
}

test('a Codex draft runs, maps JSON events and becomes a task row', t => {
  const { cwd, dataDir, spawns, runner, notices } = setup(t);
  const draft = runner.createDraft({ tool: 'codex', prompt: '修一下登录 bug', cwd });
  assert.equal(draft.status, 'draft');
  assert.equal(runner.drafts().length, 1);
  const started = runner.startDraft(draft.id, { by: 'ui' });
  assert.equal(started.status, 'running');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, 'fake-codex');
  assert.ok(spawns[0].args.includes('--approve-for-me'));
  assert.equal(spawns[0].args.at(-1), '-');
  assert.ok(spawns[0].args.includes('-C'));
  const child = spawns[0].child;
  child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
  child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"修好了"}}\n');
  child.stdout.write('{"type":"turn.completed","usage":{"total_tokens":42}}\n');
  child.emit('close', 0, null);
  const task = runner.find(draft.id);
  assert.equal(task.status, 'done');
  assert.equal(task.sessionId, 'thread-1');
  assert.equal(task.latestText, '修好了');
  assert.equal(task.tokens, 42);
  const log = runner.events(draft.id);
  assert.equal(log.ok, true);
  assert.ok(log.events.length >= 3);
  assert.match(log.events.map(event => event.text).join('\n'), /修好了/);
  runner.note(task, { type: 'item.completed', item: { type: 'command_execution', command: 'set API_KEY=sk-abcdefghijklmnop' } });
  assert.doesNotMatch(runner.events(draft.id).events.map(event => event.text).join('\n'), /sk-abcdefghijklmnop/);
  const row = runner.rows().find(item => item.taskId === draft.id);
  assert.equal(row.state, 'done');
  assert.equal(row.tool, 'codex');
  assert.equal(row.sessionId, 'thread-1');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].task.status, 'done');
  const audit = fs.readFileSync(path.join(dataDir, 'work-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"finish"/);
  assert.doesNotMatch(audit, /修一下登录 bug/, 'audit does not store the prompt');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'work-tasks.json'), 'utf8'));
  assert.equal(saved.tasks.find(task => task.id === draft.id).status, 'done');
});

test('a DSH draft runs through the headless CLI, ignores non-JSON stdout and writes a YAML patch', t => {
  const { cwd, dataDir, spawns, runner } = setup(t);
  const source = path.join(dataDir, 'dsh-source');
  fs.mkdirSync(path.join(source, 'profiles', 'headless'), { recursive: true });
  fs.writeFileSync(path.join(source, 'profiles', 'headless', 'cordis.yml'), 'root');
  fs.writeFileSync(path.join(source, '.credentials.yaml'), 'credentials');
  const draft = runner.createDraft({ tool: 'dsh', prompt: '列一下目录', cwd });
  runner.startDraft(draft.id, { by: 'ui' });
  const spawn = spawns[0];
  assert.equal(spawn.command, 'fake-dsh');
  assert.deepEqual(spawn.args.slice(0, 2), ['--profile', 'headless']);
  assert.ok(spawn.args.includes('--patch'));
  assert.equal(spawn.args.at(-1), '-');
  assert.equal(spawn.options.env.DSH_HOME, path.join(dataDir, 'dsh-home'));
  assert.equal(spawn.options.env.TEMP, path.join(os.tmpdir(), 'whale-dsh-tmp'));
  assert.equal(spawn.options.env.TMP, path.join(os.tmpdir(), 'whale-dsh-tmp'));
  assert.ok(fs.existsSync(path.join(os.tmpdir(), 'whale-dsh-tmp')));
  assert.equal(fs.readFileSync(path.join(dataDir, 'dsh-home', 'profiles', 'headless', 'cordis.yml'), 'utf8'), 'root');
  assert.equal(fs.readFileSync(path.join(dataDir, 'dsh-home', '.credentials.yaml'), 'utf8'), 'credentials');
  const patch = fs.readFileSync(path.join(dataDir, 'dsh-headless.patch.yml'), 'utf8');
  assert.match(patch, /^- id: agent-default-model/m);
  assert.match(patch, /provider: deepseek-account/);
  assert.doesNotMatch(patch, /^"/);
  const child = spawn.child;
  child.stdout.write('[llm-deepseek-account] model listing loaded 2 models\n');
  child.stdout.write('{"type":"session","sessionId":"session-dsh","cwd":"' + cwd.replace(/\\/g, '\\\\') + '"}\n');
  child.stdout.write('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n');
  child.stdout.write('{"type":"final","text":"列完了"}\n');
  child.emit('close', 0, null);
  const task = runner.find(draft.id);
  assert.equal(task.status, 'done');
  assert.equal(task.sessionId, 'session-dsh');
  assert.equal(task.finalText, '列完了');
});

test('start requires a bare confirmation when asked; a draft stays pending after a refusal', t => {
  const { cwd, spawns, runner } = setup(t);
  const draft = runner.createDraft({ tool: 'codex', prompt: '修复', cwd });
  assert.throws(() => runner.startDraft(draft.id, { requireConfirm: true, userText: '帮我做一下' }), /确认/);
  assert.equal(runner.find(draft.id).status, 'draft');
  assert.equal(spawns.length, 0);
  runner.startDraft(draft.id, { requireConfirm: true, userText: '确认' });
  assert.equal(runner.find(draft.id).status, 'running');
});

test('the queue starts the next task after the first stops; stop is reported as aborted', t => {
  const { cwd, spawns, kills, runner } = setup(t, { maxConcurrent: 1 });
  const first = runner.createDraft({ tool: 'codex', prompt: '第一个', cwd });
  const second = runner.createDraft({ tool: 'codex', prompt: '第二个', cwd });
  runner.startDraft(first.id, { by: 'ui' });
  runner.startDraft(second.id, { by: 'ui' });
  assert.equal(spawns.length, 1);
  assert.equal(runner.find(second.id).status, 'queued');
  runner.stop(first.id, { by: 'ui' });
  assert.equal(runner.find(first.id).status, 'stopping');
  assert.equal(kills.length, 1);
  spawns[0].child.emit('close', null, 'SIGTERM');
  assert.equal(runner.find(first.id).status, 'aborted');
  assert.equal(runner.find(second.id).status, 'running');
  assert.equal(spawns.length, 2);
});

test('a running task left by a previous process becomes aborted on load', t => {
  const dataDir = temp(t), cwd = temp(t);
  fs.writeFileSync(path.join(dataDir, 'work-tasks.json'), JSON.stringify({ version: 1, tasks: [
    { id: 'task-old', tool: 'codex', prompt: 'old', cwd, status: 'running', createdAt: NOW - 1000, updatedAt: NOW - 1000, startedAt: NOW - 1000 },
  ] }));
  const runner = new TaskRunner({ dataDir, settings: settingsFor([cwd]), now: () => NOW, codexBin: 'fake-codex', spawnImpl: () => fakeChild() });
  t.after(() => runner.close());
  const task = runner.find('task-old');
  assert.equal(task.status, 'aborted');
  assert.match(task.error, /重启/);
});

test('drafts refuse cwd outside the allowed roots or a sensitive directory', t => {
  const { cwd, runner } = setup(t);
  assert.throws(() => runner.createDraft({ tool: 'codex', prompt: 'x', cwd: os.tmpdir() }), /范围/);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'x');
  assert.throws(() => runner.createDraft({ tool: 'codex', prompt: 'x', cwd: path.join(cwd, 'file.txt') }), /不是文件夹/);
  const noRoots = setup(t, { roots: [] }).runner;
  assert.throws(() => noRoots.createDraft({ tool: 'codex', prompt: 'x', cwd }), /设置里添加/);
});

test('the task window hides the observed session once a dispatched task owns it', t => {
  const { cwd, spawns, runner } = setup(t);
  const draft = runner.createDraft({ tool: 'codex', prompt: '修一下', cwd });
  runner.startDraft(draft.id, { by: 'ui' });
  spawns[0].child.stdout.write('{"type":"thread.started","thread_id":"thread-own"}\n');
  const board = new AgentBoard({ dataDir: temp(t), now: () => NOW, extraRows: () => runner.rows(), suppressedSessions: () => runner.sessionIds() });
  board.codexSession({ sessionId: 'thread-own', cwd, app: false, isSubagent: false, parentThreadId: null, state: 'running', since: NOW, startedAt: NOW, tokens: 1, contextWindow: 100, eventAt: NOW, activeAt: NOW });
  const rows = board.rows();
  assert.equal(rows.filter(row => row.sessionId === 'thread-own').length, 1);
  assert.equal(rows.find(row => row.sessionId === 'thread-own').id.startsWith('task:'), true);
  board.hide('task:' + draft.id);
  assert.equal(board.rows().some(row => row.taskId === draft.id), false);
});

test('the conversation tool creates a draft and refuses start without a bare confirmation', t => {
  const { cwd, spawns, runner } = setup(t);
  let said = '帮我做一下';
  const tools = createWorkTaskTools({ runner, conversationId: 'conversation', userText: () => said });
  const draft = tools.execute({ name: 'work_task', arguments: JSON.stringify({ action: 'draft', tool: 'codex', prompt: '修一下登录', cwd }) });
  assert.equal(draft.ok, true);
  assert.equal(draft.needsConfirm, true);
  const refused = tools.execute({ name: 'work_task', arguments: JSON.stringify({ action: 'start', draftId: draft.draft.id }) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /确认/);
  assert.equal(spawns.length, 0);
  said = '确认';
  const started = tools.execute({ name: 'work_task', arguments: JSON.stringify({ action: 'start', draftId: draft.draft.id }) });
  assert.equal(started.ok, true);
  assert.equal(spawns.length, 1);
  const listed = tools.execute({ name: 'work_task', arguments: '{"action":"list"}' });
  assert.equal(listed.ok, true);
  assert.ok(listed.tasks.some(task => task.id === draft.draft.id));
});

test('a finished Codex task can be continued through exec resume after a new draft', t => {
  const { cwd, spawns, runner } = setup(t);
  const first = runner.createDraft({ tool: 'codex', prompt: '先做第一步', cwd });
  runner.startDraft(first.id, { by: 'ui' });
  spawns[0].child.stdout.write('{"type":"thread.started","thread_id":"thread-resume"}\n');
  spawns[0].child.emit('close', 0, null);
  const continuation = runner.createDraft({ resumeTaskId: first.id, prompt: '再补一个测试', by: 'chat' });
  assert.equal(continuation.status, 'draft');
  assert.equal(continuation.resumeSessionId, 'thread-resume');
  runner.startDraft(continuation.id, { by: 'ui' });
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1].args.slice(0, 3), ['exec', 'resume', 'thread-resume']);
  assert.equal(spawns[1].args.at(-1), '-');
});

test('a finished DSH task can be continued with --session-id', t => {
  const { cwd, spawns, runner } = setup(t);
  const first = runner.createDraft({ tool: 'dsh', prompt: '先做第一步', cwd });
  runner.startDraft(first.id, { by: 'ui' });
  spawns[0].child.stdout.write('{"type":"session","sessionId":"session-resume"}\n');
  spawns[0].child.emit('close', 0, null);
  const continuation = runner.createDraft({ resumeTaskId: first.id, prompt: '继续做第二步', by: 'chat' });
  runner.startDraft(continuation.id, { by: 'ui' });
  assert.equal(spawns.length, 2);
  assert.ok(spawns[1].args.includes('--session-id'));
  assert.equal(spawns[1].args[spawns[1].args.indexOf('--session-id') + 1], 'session-resume');
});

test('codex arguments keep the chosen sandbox mode', () => {
  assert.ok(codexArgs({ cwd: 'D:\\work', sandbox: 'read-only', lastFile: 'x' }).includes('read-only'));
  assert.ok(codexArgs({ cwd: 'D:\\work', sandbox: 'danger-full-access', lastFile: 'x' }).includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(codexArgs({ cwd: 'D:\\work', sandbox: 'workspace-write', lastFile: 'x' }).includes('--approve-for-me'));
});
