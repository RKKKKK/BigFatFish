import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCodexDigest } from '../runtime/workbench/codex-digest.mjs';
import { SummaryService } from '../runtime/workbench/summary.mjs';
import { createWorkTaskTools } from '../runtime/workbench/task-tools.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function settings(readTaskContent = true) { return { public: () => ({ readTaskContent }) }; }

function fakeChat(text = '摘要') {
  const calls = [];
  return { calls, generateText: async input => { calls.push(input); return { ok: true, text }; } };
}

function runnerTask(extra = {}) {
  return {
    id: 'task-one', tool: 'codex', prompt: '修一下登录 bug', cwd: 'D:\\work\\project', status: 'done',
    createdAt: NOW - 10 * 60000, startedAt: NOW - 9 * 60000, finishedAt: NOW - 2 * 60000, updatedAt: NOW - 2 * 60000,
    latestText: '已经修好了', finalText: '已经修好了', tokens: 1234, error: '', sessionId: 'thread-one', ...extra,
  };
}

function serviceFor(t, { chat = fakeChat(), readTaskContent = true, task = runnerTask(), rows = [] } = {}) {
  const dataDir = temp(t);
  const runner = { find: id => id === task.id || id === 'task:' + task.id ? task : null, snapshot: () => ({ tasks: [task], drafts: [], active: 0, queue: [], maxConcurrent: 2 }), rows: () => [], sessionIds: () => new Set() };
  const agents = { find: id => rows.find(row => row.id === id) || null, rows: () => rows };
  const service = new SummaryService({ dataDir, codexHome: temp(t), agents, runner, settings: settings(readTaskContent), chat: () => chat, now: () => NOW });
  return { service, chat, dataDir, runner, agents };
}

test('the Codex tail reader finds the last prompt and answer without reading the whole log', t => {
  const codexHome = temp(t);
  const dir = path.join(codexHome, 'sessions', '2026', '10', '31');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-10-31T10-00-00-thread-one.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-one', cwd: 'D:\\work\\project', originator: 'Codex Desktop', thread_source: 'primary' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>private env</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请修复登录' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已经修好了' } }),
  ].join('\n') + '\n');
  const digest = readCodexDigest({ codexHome, sessionId: 'thread-one', readContent: true });
  assert.equal(digest.prompt, '请修复登录');
  assert.equal(digest.lastAgent, '已经修好了');
  assert.equal(digest.outcome, 'completed');
  assert.equal(digest.cwd, 'D:\\work\\project');
  const metadataOnly = readCodexDigest({ codexHome, sessionId: 'thread-one', readContent: false });
  assert.equal(metadataOnly.prompt, '');
  assert.equal(metadataOnly.size, 0);
});

test('a runner task is summarized through the chat text request and cached by source version', async t => {
  const { service, chat, dataDir } = serviceFor(t);
  const first = await service.task('task-one');
  assert.equal(first.ok, true);
  assert.equal(first.text, '摘要');
  assert.equal(first.cached, false);
  assert.equal(chat.calls.length, 1);
  assert.match(chat.calls[0].prompt, /修一下登录 bug/);
  const second = await service.task('task-one');
  assert.equal(second.cached, true);
  assert.equal(chat.calls.length, 1);
  const refreshed = await service.task('task-one', { refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(chat.calls.length, 2);
  assert.equal(fs.existsSync(path.join(dataDir, 'work-summaries.json')), true);
});

test('a summary is plain text, at most 200 characters and has no markdown or ellipsis', async t => {
  const chat = fakeChat('**标题** ' + '这是一段很长的回答内容。'.repeat(40) + '……');
  const { service } = serviceFor(t, { chat });
  const result = await service.task('task-one');
  assert.equal(result.ok, true);
  assert.ok(result.text.length <= 200, 'summary length ' + result.text.length);
  assert.doesNotMatch(result.text, /\*\*|^#|`|…|\.\.\./);
  assert.doesNotMatch(result.text, /\n/);
});

test('turning content reading off keeps prompt and output out of the summary request', async t => {
  const { service, chat } = serviceFor(t, { readTaskContent: false });
  await service.task('task-one');
  assert.match(chat.calls[0].prompt, /（不读取任务内容）/);
  assert.doesNotMatch(chat.calls[0].prompt, /修一下登录 bug/);
  assert.doesNotMatch(chat.calls[0].prompt, /已经修好了/);
});

test('a daily report includes completed tasks and is cached for the same day', async t => {
  const { service, chat, dataDir } = serviceFor(t, { chat: fakeChat('今天的复盘') });
  const report = await service.report();
  assert.equal(report.ok, true);
  assert.equal(report.text, '今天的复盘');
  assert.equal(report.tasks, 1);
  assert.match(chat.calls[0].prompt, /修一下登录 bug|已经修好了/);
  const cached = await service.report();
  assert.equal(cached.cached, true);
  assert.equal(chat.calls.length, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'work-reports.json')), true);
});

test('a report with no tasks returns a plain sentence without a model request', async t => {
  const dataDir = temp(t);
  const chat = fakeChat();
  const service = new SummaryService({ dataDir, codexHome: temp(t), agents: { rows: () => [] }, runner: { snapshot: () => ({ tasks: [] }) }, settings: settings(true), chat: () => chat, now: () => NOW });
  const report = await service.report();
  assert.equal(report.ok, true);
  assert.match(report.text, /没有记录到任务/);
  assert.equal(chat.calls.length, 0);
});

test('the work_task summary action delegates to the summary service', async t => {
  const { service, runner } = serviceFor(t);
  const tools = createWorkTaskTools({ runner, summary: () => service });
  const result = await tools.execute({ name: 'work_task', arguments: JSON.stringify({ action: 'summary', id: 'task-one' }) });
  assert.equal(result.ok, true);
  assert.equal(result.text, '摘要');
  const digest = await tools.execute({ name: 'work_task', arguments: JSON.stringify({ action: 'digest' }) });
  assert.equal(digest.ok, true);
});
