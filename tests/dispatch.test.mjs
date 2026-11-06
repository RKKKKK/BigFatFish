import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDispatcher } from '../runtime/dispatcher.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function child(pid = 9001) {
  const node = new EventEmitter();
  node.pid = pid; node.exitCode = null;
  node.stdout = new PassThrough(); node.stderr = new PassThrough(); node.stdin = new PassThrough();
  node.kill = () => {};
  return node;
}

test('the dispatcher drafts, confirms and runs a Codex task end to end', async t => {
  const dataDir = temp(t), cwd = temp(t), spawns = [];
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false, runnerOptions: {
    now: () => NOW, codexBin: 'fake-codex', killImpl: () => {},
    spawnImpl: (command, args, options) => { const node = child(); spawns.push({ command, args, options, node }); return node; },
  } });
  t.after(() => dispatcher.close());

  const configured = await dispatcher.dispatch('/api/workbench/settings', { method: 'PUT', body: { allowedRoots: [cwd], maxConcurrent: 1 } });
  assert.equal(configured.status, 200);

  const draft = JSON.parse((await dispatcher.dispatch('/api/workbench/tasks/draft', { method: 'POST', body: { tool: 'codex', prompt: '修一下登录 bug', cwd } })).body.toString('utf8'));
  assert.equal(draft.ok, true);
  assert.equal(draft.draft.status, 'draft');
  assert.equal(JSON.parse((await dispatcher.dispatch('/api/workbench/tasks')).body.toString('utf8')).drafts.length, 1);

  const started = JSON.parse((await dispatcher.dispatch('/api/workbench/tasks/start', { method: 'POST', body: { draftId: draft.draft.id } })).body.toString('utf8'));
  assert.equal(started.ok, true);
  assert.equal(started.task.status, 'running');
  assert.equal(spawns.length, 1);
  const node = spawns[0].node;
  node.stdout.write('{"type":"thread.started","thread_id":"thread-route"}\n');
  node.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"好了"}}\n');
  node.stdout.write('{"type":"turn.completed","usage":{"total_tokens":7}}\n');
  node.emit('close', 0, null);

  const list = JSON.parse((await dispatcher.dispatch('/api/workbench/tasks')).body.toString('utf8'));
  const row = list.rows.find(item => item.taskId === draft.draft.id);
  assert.equal(row.state, 'done');
  assert.equal(row.sessionId, 'thread-route');
  assert.equal(row.title, '修一下登录 bug');
  assert.equal(list.drafts.length, 0);
  assert.equal(JSON.parse((await dispatcher.dispatch('/api/agents')).body.toString('utf8')).rows.some(item => item.taskId === draft.draft.id), true);

  const summary = JSON.parse((await dispatcher.dispatch('/api/workbench/tasks/summary', { method: 'POST', body: { id: draft.draft.id } })).body.toString('utf8'));
  assert.equal(summary.ok, true);
  assert.match(summary.text, /好了/);
  assert.ok(summary.text.length <= 200);
  const report = JSON.parse((await dispatcher.dispatch('/api/workbench/report', { method: 'POST', body: {} })).body.toString('utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.tasks, 1);
});

test('a draft is rejected until a working directory is configured, and can be cancelled', async t => {
  const dataDir = temp(t), cwd = temp(t);
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false, runnerOptions: { now: () => NOW, codexBin: 'fake-codex', spawnImpl: () => child() } });
  t.after(() => dispatcher.close());
  const rejected = await dispatcher.dispatch('/api/workbench/tasks/draft', { method: 'POST', body: { tool: 'codex', prompt: 'x', cwd } });
  assert.equal(rejected.status, 400);
  assert.match(JSON.parse(rejected.body.toString('utf8')).error, /设置/);
  await dispatcher.dispatch('/api/workbench/settings', { method: 'PUT', body: { allowedRoots: [cwd] } });
  const draft = JSON.parse((await dispatcher.dispatch('/api/workbench/tasks/draft', { method: 'POST', body: { tool: 'codex', prompt: 'x', cwd } })).body.toString('utf8'));
  const cancelled = await dispatcher.dispatch('/api/workbench/tasks/cancel', { method: 'POST', body: { draftId: draft.draft.id } });
  assert.equal(cancelled.status, 200);
  assert.equal(JSON.parse((await dispatcher.dispatch('/api/workbench/tasks')).body.toString('utf8')).drafts.length, 0);
});
