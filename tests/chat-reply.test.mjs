import assert from 'node:assert/strict';
import test from 'node:test';
import { generateReply, taskRefsFromResult } from '../runtime/chat/reply.mjs';

const deepseek = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 256, key: 'synthetic-reply-key' };
const other = { baseUrl: 'https://chat.example.test/v1', model: 'dsv4.1flash', maxTokens: 256, key: 'synthetic-other-key' };
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100 };
const headers = { 'content-type': 'text/event-stream' };
const sse = events => new Response(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n', { headers });
const text = value => sse([{ choices: [{ index: 0, delta: { content: value } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
const definitions = [{ type: 'function', function: { name: 'pomodoro_status', parameters: { type: 'object', properties: {} } } }];
// Sends one delta, then waits until the reply aborts the request.
const stalled = async (_url, { signal }) => new Response(new ReadableStream({ start(stream) {
  stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'));
  signal.addEventListener('abort', () => stream.error(new Error('aborted')), { once: true });
} }), { headers });

test('task tool results become compact chat card references', () => {
  assert.deepEqual(taskRefsFromResult({ ok: true, tasks: [{ id: 't1', tool: 'codex', status: 'running', prompt: '修登录   bug' }] }), [
    { id: 't1', title: '修登录 bug', tool: 'codex', status: 'running' },
  ]);
  assert.deepEqual(taskRefsFromResult({ ok: true, draft: { id: 'd1', tool: 'dsh', status: 'draft', prompt: '整理目录' } }),
    [{ id: 'd1', title: '整理目录', tool: 'dsh', status: 'draft' }]);
  assert.deepEqual(taskRefsFromResult({ ok: false, error: 'x' }), []);
});

test('a reply frames persona, the time convention, instruction and completed history, and offers tools only where the endpoint supports them', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return text('好'); };
  const history = [
    { user: '旧问题', text: '旧回答', status: 'completed', createdAt: new Date(2026, 8, 28, 0, 50).toISOString() },
    { user: '失败的问题', text: '', status: 'failed', createdAt: new Date(2026, 8, 28, 0, 55).toISOString() },
  ];
  const tools = { definitions, policy: '工具说明', execute: () => ({ ok: true }) };
  const now = new Date(2026, 8, 28, 1, 0).getTime();
  const reply = await generateReply({ endpoint: deepseek, persona: '你是大肥鱼', instruction: '说短一点', history, prompt: '你好', tools, id: 'reply_frame', now, fetchImpl });
  assert.equal(reply.status, 'completed'); assert.equal(reply.text, '好'); assert.equal(reply.error, '');
  const [persona, time, ...rest] = bodies[0].messages.map(message => message.content);
  assert.equal(persona, '你是大肥鱼'); assert.match(time, /方括号/); assert.ok(time.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.deepEqual(rest, ['说短一点', '工具说明', '[2026-09-28 星期一 00:50] 旧问题', '旧回答', '[2026-09-28 星期一 01:00] 你好']);
  assert.equal(bodies[0].tools[0].function.name, 'pomodoro_status');
  assert.equal(bodies[0].max_tokens, 256);

  await generateReply({ endpoint: other, history, prompt: '你好', tools, id: 'reply_other', now, fetchImpl });
  assert.equal(bodies[1].tools, undefined, 'a compatible endpoint without tool support is sent plain chat');
  assert.equal(bodies[1].messages.some(message => message.content === '工具说明'), false);
});

test('each user message carries its send time, and a new one after a quiet spell says how long it has been', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return text('嗯'); };
  const history = [{ user: '我先去睡了', text: '晚安', status: 'completed', createdAt: new Date(2026, 8, 30, 23, 5).toISOString() }];
  await generateReply({ endpoint: deepseek, history, prompt: '我回来了', id: 'next_day', now: new Date(2026, 9, 1, 15, 2).getTime(), fetchImpl });
  assert.deepEqual(bodies[0].messages.slice(1).map(message => message.content),
    ['[2026-09-30 星期三 23:05] 我先去睡了', '晚安', '[2026-10-01 星期四 15:02，距上一条消息约 16 小时] 我回来了']);
  history.push({ user: '我回来了', text: '欢迎回来', status: 'completed', createdAt: new Date(2026, 9, 1, 15, 2).toISOString() });
  await generateReply({ endpoint: deepseek, history, prompt: '刚才说到哪了', id: 'same_hour', now: new Date(2026, 9, 1, 15, 7).getTime(), fetchImpl });
  assert.equal(bodies[1].messages.at(-1).content, '[2026-10-01 星期四 15:07] 刚才说到哪了', 'a short pause needs no reminder');
});

test('only the last message changes with the clock, so the provider can reuse the cached conversation', async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return text('在'); };
  const history = [{ user: '早', text: '早呀', status: 'completed', createdAt: new Date(2026, 9, 1, 8, 0).toISOString() }];
  for (const minute of [10, 41]) await generateReply({ endpoint: deepseek, persona: '你是大肥鱼', history, prompt: '在吗', id: 'cache_' + minute, now: new Date(2026, 9, 1, 9, minute).getTime(), fetchImpl });
  assert.deepEqual(bodies[0].messages.slice(0, -1), bodies[1].messages.slice(0, -1));
  assert.notEqual(bodies[0].messages.at(-1).content, bodies[1].messages.at(-1).content);
});

test('tool rounds execute locally, bill every request, and stop offering tools after two rounds', async () => {
  const bodies = [], records = [], executed = [];
  const call = id => ({ choices: [{ index: 0, delta: { reasoning_content: '想一想', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'pomodoro_status', arguments: '{}' } }] } }] });
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length <= 2) return sse([call('call_' + bodies.length), { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }]);
    return text('安排好了');
  };
  const tools = { definitions, policy: '', execute: request => {
    executed.push(request);
    if (executed.length === 2) throw new Error('disk full');
    return { ok: true, pomodoro: { phase: 'idle' } };
  } };
  const reply = await generateReply({ endpoint: deepseek, prompt: '看看番茄钟', tools, id: 'reply_tools', fetchImpl,
    record: (request, credentials) => records.push({ id: request.id, status: request.status, key: credentials.key }) });
  assert.equal(reply.status, 'completed'); assert.equal(reply.text, '安排好了'); assert.equal(reply.finishReason, 'stop');
  assert.deepEqual(executed, [{ name: 'pomodoro_status', arguments: '{}' }, { name: 'pomodoro_status', arguments: '{}' }]);
  assert.deepEqual(bodies.map(body => !!body.tools), [true, true, false]);
  const assistant = bodies[1].messages.at(-2);
  assert.equal(assistant.role, 'assistant'); assert.equal(assistant.reasoning_content, '想一想'); assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.deepEqual(JSON.parse(bodies[1].messages.at(-1).content), { ok: true, pomodoro: { phase: 'idle' } });
  assert.deepEqual(JSON.parse(bodies[2].messages.at(-1).content), { ok: false, error: '操作未能保存' });
  assert.deepEqual(reply.requests.map(request => [request.id, request.status]), [['reply_tools', 'completed'], ['reply_tools:1', 'completed'], ['reply_tools:2', 'completed']]);
  assert.deepEqual(records.map(row => row.status), ['streaming', 'completed', 'streaming', 'completed', 'streaming', 'completed']);
  assert.ok(records.every(row => row.key === deepseek.key));
  assert.equal(reply.usage.total_tokens, 3300);
});

test('memory and capability blocks are stable system messages, and async tool execution is awaited', async () => {
  const bodies = [], executed = [];
  const call = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_memory', type: 'function', function: { name: 'memory_save', arguments: '{"section":"identity","text":"叫我 RK"}' } }] } }] };
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return sse([call, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]);
    return text('记住了');
  };
  const tools = {
    definitions: [{ type: 'function', function: { name: 'memory_save', parameters: { type: 'object', properties: {} } } }],
    policy: '记忆工具说明',
    async execute(request) { await Promise.resolve(); executed.push(request); return { ok: true, saved: { id: 'm1' } }; },
  };
  const now = new Date(2026, 9, 31, 12, 0).getTime();
  const reply = await generateReply({ endpoint: deepseek, capabilities: '能力说明', memory: '[长期记忆]\n称呼：RK', prompt: '记住叫我 RK', tools, id: 'reply_memory', now, fetchImpl });
  assert.equal(reply.status, 'completed');
  assert.deepEqual(executed, [{ name: 'memory_save', arguments: '{"section":"identity","text":"叫我 RK"}' }]);
  const contents = bodies[0].messages.map(message => message.content);
  assert.equal(contents[0], '能力说明');
  assert.match(contents[1], /方括号/);
  assert.equal(contents[2], '[长期记忆]\n称呼：RK');
  assert.equal(contents[3], '记忆工具说明');
  assert.deepEqual(JSON.parse(bodies[1].messages.at(-1).content), { ok: true, saved: { id: 'm1' } });
});

test('a cancelled reply keeps its partial text, and timeouts are reported as failures', async () => {
  const controller = new AbortController();
  const cancelled = await generateReply({ endpoint: other, prompt: 'hi', id: 'reply_cancel', fetchImpl: stalled, signal: controller.signal, onDelta: () => controller.abort() });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.text, '半句'); assert.equal(cancelled.error, '已停止生成');
  assert.equal(cancelled.requests[0].status, 'cancelled');

  const early = new AbortController(); early.abort();
  assert.equal((await generateReply({ endpoint: other, prompt: 'hi', id: 'reply_early', fetchImpl: stalled, signal: early.signal })).status, 'cancelled');

  for (const limit of [{ idleMs: 5 }, { timeoutMs: 5 }]) {
    const expired = await generateReply({ endpoint: other, prompt: 'hi', id: 'reply_expired', fetchImpl: stalled, ...limit });
    assert.equal(expired.status, 'failed'); assert.equal(expired.error, '回复超时，请重试'); assert.equal(expired.text, '半句');
  }
});

test('failed replies explain provider errors without exposing the API key', async () => {
  const run = (fetchImpl, options = {}) => generateReply({ endpoint: other, prompt: 'hi', id: 'reply_error', fetchImpl, ...options });
  assert.match((await run(async () => new Response(other.key, { status: 401 }))).error, /^会话接口返回 401/);
  assert.equal((await run(async () => { throw new Error('bad token ' + other.key); })).error, '会话请求失败，请检查设置后重试');
  assert.equal((await run(async () => { throw new TypeError('fetch failed'); })).error, '会话连接失败，请检查网络或接口地址');
  assert.equal((await run(async () => text('太长的回复'), { maxChars: 3 })).error, '回复内容超过本地长度限制');
  const empty = await run(async () => sse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]));
  assert.equal(empty.status, 'failed'); assert.equal(empty.error, '模型没有返回文字回复');
  assert.equal(empty.requests[0].status, 'completed', 'the request itself finished and is billed as such');
});
