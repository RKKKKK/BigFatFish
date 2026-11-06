import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SessionParser } from '../runtime/session-monitor.mjs';
import { AgentBoard } from '../runtime/agents/board.mjs';
import { claudeFiles, readClaudeSessions, recordClaudeHook, recordClaudeStatus } from '../runtime/agents/claude-hooks.mjs';
import { jumpPlan, jumpTo } from '../runtime/agents/jump.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';

const MINUTE = 60000;
const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'wag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const hook = (event, extra = {}) => ({ session_id: 'claude-one', cwd: '/work/whale', hook_event_name: event, transcript_path: '/private/chat.jsonl', ...extra });
const status = (tokens, extra = {}) => ({ session_id: 'claude-one', cwd: '/work/whale', context_window: {
  total_input_tokens: 999999, total_output_tokens: 999999, context_window_size: 200000, used_percentage: tokens / 2000,
  current_usage: { input_tokens: tokens - 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } }, ...extra });
const codexLine = (at, payload) => ({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload });
const tokenCount = (at, inContext) => codexLine(at, { type: 'token_count', info: {
  total_token_usage: { input_tokens: inContext * 3, output_tokens: 3000, total_tokens: inContext * 3 + 3000 },
  last_token_usage: { input_tokens: inContext - 1000, output_tokens: 1000, total_tokens: inContext }, model_context_window: 258400 } });

test('Claude hooks and the status line record state and context tokens, never conversation text', t => {
  const dataDir = tempDir(t), start = Date.now();
  assert.equal(recordClaudeHook(dataDir, hook('SessionStart', { source: 'startup' }), start), true);
  assert.equal(readClaudeSessions(dataDir, start)[0].state.state, 'idle');
  recordClaudeHook(dataDir, hook('UserPromptSubmit', { prompt: 'private prompt' }), start + 1000);
  recordClaudeStatus(dataDir, status(38200, { transcript_path: '/private/chat.jsonl' }), start + 2000);
  recordClaudeHook(dataDir, hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'private command' } }), start + 3000);
  assert.equal(recordClaudeHook(dataDir, hook('Notification', { notification_type: 'idle_prompt', message: 'private notice' }), start + 4000), false);
  assert.equal(recordClaudeHook(dataDir, hook('UserPromptSubmit', { agent_id: 'sub', prompt: 'private' }), start + 4500), false, 'a subagent belongs to its parent');
  const [session] = readClaudeSessions(dataDir, start + 5000);
  assert.equal(session.state.state, 'permission');
  assert.equal(session.state.startedAt, start + 1000);
  assert.equal(session.usage.tokens, 38200, 'the last request, not the session total');
  assert.equal(session.usage.contextPercent, 19.1);
  const files = claudeFiles(dataDir, 'claude-one');
  const saved = fs.readFileSync(files.state, 'utf8') + fs.readFileSync(files.usage, 'utf8');
  assert.equal(/private|Bash/.test(saved), false);
  // A restart after compaction keeps what the session was doing.
  recordClaudeHook(dataDir, hook('SessionStart', { source: 'compact' }), start + 6000);
  assert.equal(readClaudeSessions(dataDir, start + 6000)[0].state.state, 'permission');

  const stopped = spawnSync(process.execPath, ['scripts/claude-hook.mjs', '--data-dir', dataDir], {
    input: JSON.stringify(hook('Stop', { last_assistant_message: 'private reply' })), encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '', 'output from a hook would join the conversation');
  assert.equal(readClaudeSessions(dataDir)[0].state.state, 'done');
  assert.equal(fs.readFileSync(path.join(dataDir, 'claude-last-turn.json'), 'utf8').includes('private'), false, 'Stop still feeds the finished-reply notice');
  recordClaudeHook(dataDir, hook('SessionEnd', { reason: 'exit' }));
  assert.deepEqual(readClaudeSessions(dataDir), []);

  recordClaudeHook(dataDir, hook('UserPromptSubmit'), start);
  assert.deepEqual(readClaudeSessions(dataDir, start + 86400001), [], 'a day without a word removes the files');
  assert.equal(fs.existsSync(files.state), false);
});

test('the status line script records the conversation as well as the quota', t => {
  const dataDir = tempDir(t);
  const result = spawnSync(process.execPath, ['scripts/claude-statusline.mjs', '--data-dir', dataDir], { input: JSON.stringify(status(64500)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readClaudeSessions(dataDir)[0].usage.tokens, 64500);
});

test('the Codex log gives each session its folder, app, turn state and context tokens', () => {
  const views = [], start = Date.parse('2026-10-16T08:00:00Z');
  const parser = new SessionParser({ id: 'file', onSession: view => views.push(view) });
  parser.accept({ type: 'session_meta', payload: { id: 'thread-app', cwd: '/work/api', originator: 'codex_work_desktop', source: 'vscode', timestamp: new Date(start).toISOString() } });
  parser.accept({ type: 'turn_context', payload: { cwd: '/work/api', model: 'gpt' } });
  parser.accept(codexLine(start + 1000, { type: 'task_started', turn_id: 'turn-1', started_at: (start + 1000) / 1000, model_context_window: 258400 }));
  assert.equal(views.at(-1).state, 'running');
  assert.equal(views.at(-1).app, true);
  assert.equal(views.at(-1).cwd, '/work/api');
  parser.accept(tokenCount(start + 5000, 126000));
  assert.equal(views.at(-1).tokens, 126000);
  assert.equal(views.at(-1).contextWindow, 258400);
  assert.equal(views.at(-1).eventAt, start + 5000);
  parser.accept(codexLine(start + 9000, { type: 'task_complete', turn_id: 'turn-1' }));
  assert.deepEqual([views.at(-1).state, views.at(-1).since], ['done', start + 9000]);
  parser.accept(codexLine(start + 10000, { type: 'task_started', turn_id: 'turn-2', started_at: (start + 10000) / 1000 }));
  parser.accept(codexLine(start + 11000, { type: 'turn_aborted', turn_id: 'turn-2', reason: 'interrupted' }));
  assert.equal(views.at(-1).state, 'aborted');
  parser.accept(codexLine(start + 12000, { type: 'task_started', turn_id: 'turn-3', started_at: (start + 12000) / 1000 }));
  parser.accept(codexLine(start + 13000, { type: 'task_complete', turn_id: 'turn-3', error: { message: 'x' } }));
  assert.equal(views.at(-1).state, 'failed');
  parser.touch(start + 60000);
  assert.equal(views.at(-1).activeAt, start + 60000, 'any growth of the log is activity');

  const cli = [], child = new SessionParser({ id: 'child', onSession: view => cli.push(view) });
  child.accept({ type: 'session_meta', payload: { id: 'thread-child', cwd: '/work/api', originator: 'codex-tui', source: { subagent: { thread_spawn: { parent_thread_id: 'thread-cli' } } } } });
  child.accept(codexLine(start, { type: 'task_started', turn_id: 'turn' }));
  assert.deepEqual([cli[0].app, cli[0].isSubagent, cli[0].parentThreadId], [false, true, 'thread-cli']);
});

function codexView(sessionId, state, at, extra = {}) {
  return { sessionId, cwd: '/work/' + sessionId, app: false, isSubagent: false, parentThreadId: null, state, since: at, startedAt: at,
    tokens: 64500, contextWindow: 258400, eventAt: at, activeAt: at, ...extra };
}

test('the board orders rows by urgency and marks stuck, waiting, finished, idle and stale sessions', t => {
  const dataDir = tempDir(t), start = Date.parse('2026-10-16T08:00:00Z');
  let now = start;
  const board = new AgentBoard({ dataDir, now: () => now });
  board.codexSession(codexView('running', 'running', start));
  board.codexSession(codexView('finished', 'done', start - 5 * MINUTE));
  board.codexSession(codexView('broken', 'failed', start - 2 * MINUTE));
  board.codexSession(codexView('old', 'running', start - 200 * MINUTE));
  board.codexSession(codexView('helper', 'running', start, { isSubagent: true, parentThreadId: 'asking' }));
  board.codexSession(codexView('asking', 'running', start - MINUTE));
  recordClaudeHook(dataDir, { ...hook('UserPromptSubmit'), session_id: 'claude-q' }, start - 3 * MINUTE);
  recordClaudeHook(dataDir, { ...hook('Notification'), session_id: 'claude-q', notification_type: 'elicitation_dialog' }, start - 2 * MINUTE);
  recordClaudeHook(dataDir, { ...hook('SessionStart'), session_id: 'claude-idle' }, start);
  // Heard of only through the status line, before any hook ran in it.
  recordClaudeStatus(dataDir, { ...status(20000), session_id: 'claude-quiet' }, start - 10 * MINUTE);

  assert.equal(board.codexApproval({ sessionId: 'helper' }, start), true, "a subagent's request is its parent's");
  let rows = board.rows();
  assert.deepEqual(rows.map(row => [row.id, row.state]), [
    ['codex:broken', 'failed'], ['claude:claude-q', 'question'], ['codex:asking', 'permission'], ['codex:running', 'running'], ['codex:finished', 'done'],
    ['claude:claude-idle', 'idle'], ['claude:claude-quiet', 'idle']]);
  assert.deepEqual(rows.map(row => row.color), ['red', 'yellow', 'yellow', 'green', 'green', 'gray', 'gray']);
  assert.equal(rows.find(row => row.id === 'codex:running').name, 'running');
  assert.equal(rows.find(row => row.id === 'codex:running').contextPercent, 25);

  // Tokens counted just after the request belong to the step that asked;
  // later ones mean it was answered.
  board.codexSession(codexView('asking', 'running', start - MINUTE, { eventAt: start + 1000, activeAt: start + 1000 }));
  assert.equal(board.find('codex:asking').state, 'permission');
  board.codexSession(codexView('asking', 'running', start - MINUTE, { eventAt: start + 30000, activeAt: start + 30000 }));
  assert.equal(board.find('codex:asking').state, 'running');
  recordClaudeStatus(dataDir, { ...status(50000), session_id: 'claude-q' }, start + MINUTE);
  assert.equal(board.find('claude:claude-q').state, 'running');
  assert.equal(board.find('claude:claude-q').since, start - 3 * MINUTE);

  now = start + 16 * MINUTE;
  assert.equal(board.find('codex:running').state, 'stuck');
  assert.equal(board.find('codex:running').color, 'red');
  assert.equal(board.hide('codex:running'), true);
  now = start + 26 * MINUTE;
  rows = board.rows();
  assert.deepEqual([board.find('codex:finished').state, board.find('codex:finished').color], ['idle', 'gray'], 'half an hour after it finished, a session is idle');
  assert.equal(rows.some(row => row.id === 'codex:running'), false, 'a swiped row stays away as time passes');

  assert.equal(board.hide('codex:broken'), true);
  assert.equal(board.rows().some(row => row.id === 'codex:broken'), false);
  board.codexSession(codexView('broken', 'running', now));
  assert.equal(board.rows().some(row => row.id === 'codex:broken'), true, 'a hidden row comes back when its session moves');
  board.codexSession(codexView('broken', 'done', now));
  assert.equal(board.hide('codex:broken'), true);
  now = start + 60 * MINUTE;
  assert.equal(board.rows().some(row => row.id === 'codex:broken'), false, 'a finished row swiped away stays away once idle');

  // Without a session id the request goes to the running session in that
  // folder; with nothing at all, only a single running session can take it.
  board.codexSession(codexView('other', 'running', now, { cwd: '/work/other' }));
  board.codexSession(codexView('more', 'running', now, { cwd: '/work/more' }));
  assert.equal(board.codexApproval({}, now), false);
  assert.equal(board.codexApproval({ cwd: '/work/other' }, now), true);
  assert.equal(board.find('codex:other').state, 'permission');
  assert.equal(board.find('codex:more').state, 'running');

  // Codex never says a session closed, so its rows go after two quiet hours;
  // a Claude session stays until it ends.
  now = start + 300 * MINUTE;
  rows = board.rows();
  assert.equal(rows.some(row => row.tool === 'codex'), false);
  assert.deepEqual(rows.find(row => row.id === 'claude:claude-idle')?.state, 'idle');
  recordClaudeHook(dataDir, { ...hook('SessionEnd'), session_id: 'claude-idle' });
  assert.equal(board.rows().some(row => row.id === 'claude:claude-idle'), false);
});

test('a jump goes to the Ghostty tab in the folder, or the thread in the Codex app', async () => {
  assert.equal(jumpPlan({ tool: 'claude', cwd: '/work/whale' }, 'win32'), null);
  const app = jumpPlan({ id: 'codex:thread one', tool: 'codex', app: true, cwd: '/work' }, 'darwin');
  assert.deepEqual(app.args, ['codex://threads/thread%20one']);
  const tab = jumpPlan({ id: 'claude:x', tool: 'claude', cwd: '/work/whale' }, 'darwin');
  assert.equal(tab.command, 'osascript');
  assert.deepEqual(tab.args.slice(2), ['/work/whale', 'Claude', '✳']);
  assert.match(tab.args[1], /working directory/);

  const calls = [], answer = output => async (command, args) => { calls.push([command, args[0]]); return output; };
  assert.deepEqual(await jumpTo({ tool: 'claude', cwd: '/w' }, { platform: 'darwin', run: answer('tab\n') }), { ok: true, target: 'tab' });
  assert.equal((await jumpTo({ tool: 'claude', cwd: '/w' }, { platform: 'darwin', run: answer('app') })).message, '没找到这个文件夹的标签，已切到 Ghostty');
  assert.equal((await jumpTo({ tool: 'claude', cwd: '/w' }, { platform: 'darwin', run: answer('none') })).ok, false);
  const refused = async () => { const error = new Error('failed'); error.stderr = 'execution error: Not authorized to send Apple events to Ghostty. (-1743)'; throw error; };
  assert.match((await jumpTo({ tool: 'codex', cwd: '/w' }, { platform: 'darwin', run: refused })).error, /自动化/);
  const fallback = [];
  const noLink = async (command, args) => { fallback.push(args[0]); if (args[0] !== '-b') throw new Error('no handler'); return ''; };
  assert.deepEqual(await jumpTo({ id: 'codex:t', tool: 'codex', app: true }, { platform: 'darwin', run: noLink }), { ok: true, target: 'codex-app' });
  assert.deepEqual(fallback, ['codex://threads/t', '-b']);
  assert.match((await jumpTo({ tool: 'claude', cwd: '/w' }, { platform: 'linux' })).error, /macOS/);
});

test('the local routes list, jump to and hide rows', async t => {
  const dataDir = tempDir(t), claudeHome = path.join(dataDir, 'claude'), jumps = [];
  fs.mkdirSync(claudeHome);
  const dispatcher = createDispatcher({ dataDir, claudeHome, monitor: false, autoRefresh: false,
    agentJump: async row => { jumps.push(row.id); return { ok: true, target: 'tab' }; } });
  t.after(() => dispatcher.close());
  const call = async (route, body) => {
    const result = await dispatcher.dispatch(route, body ? { method: 'POST', body } : {});
    return { status: result.status, ...JSON.parse(result.body) };
  };
  recordClaudeHook(dataDir, hook('UserPromptSubmit'));
  recordClaudeHook(dataDir, { ...hook('Stop'), session_id: 'claude-two', cwd: '/work/notes' });
  dispatcher.agents.codexSession(codexView('codex-one', 'running', Date.now()));
  dispatcher.agents.codexApproval({ sessionId: 'codex-one', cwd: '/work/codex-one' });
  const listed = await call('/api/agents');
  assert.deepEqual(listed.rows.map(row => [row.id, row.state]), [['codex:codex-one', 'permission'], ['claude:claude-one', 'running'], ['claude:claude-two', 'done']]);
  assert.equal(listed.claude.tracking, false);
  assert.equal(listed.limits.claude.available, false);
  assert.equal((await call('/api/agents/jump', { id: 'claude:claude-two' })).target, 'tab');
  assert.deepEqual(jumps, ['claude:claude-two']);
  assert.equal((await call('/api/agents')).rows.some(row => row.id === 'claude:claude-two'), true, 'going to a row does not remove it');
  assert.equal((await call('/api/agents/hide', { id: 'claude:claude-one' })).ok, true);
  assert.deepEqual((await call('/api/agents')).rows.map(row => row.id), ['codex:codex-one', 'claude:claude-two']);
  assert.equal((await call('/api/agents/jump', { id: 'claude:gone' })).status, 404);
  assert.equal((await dispatcher.dispatch('/agents.js')).status, 200);
});
