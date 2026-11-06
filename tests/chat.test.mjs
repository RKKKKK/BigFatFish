import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatService } from '../runtime/chat/service.mjs';
import { completionUrl } from '../runtime/chat/provider.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';
import { createChatClient } from '../desktop/ui/chat-client.js';
import { readEvents } from '../lib/event-stream.js';

const settings = { baseUrl: 'https://chat.example.test/v1', model: 'dsv4.1flash', persona: 'You are a friendly whale.', maxTokens: 256, apiKey: 'synthetic-chat-key' };
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chat-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const keys = new Map();
  const vault = { available: () => true, read: id => ({ value: keys.get(id) }), write: (id, value) => keys.set(id, value) };
  const service = new ChatService({ dataDir, secretVault: vault, ...options });
  t.after(() => service.close());
  return { dataDir, service, vault };
}
function sse(text, { done = true } = {}) {
  const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\r\n\r\n' +
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n' + (done ? 'data: [DONE]\n\n' : ''));
  return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function consume(response) {
  const events = [];
  for await (const event of readEvents(response.body)) events.push(JSON.parse(event.data));
  return events;
}
// The request as the conversation reads: no time convention, no time tags on user messages.
const withoutTime = messages => messages.filter(message => !message.content?.includes('方括号里的时间由系统标注'))
  // The memory-capability note is constant and checked by the memory tests; it
  // is left out here so these expectations stay about persona and history.
  .filter(message => !message.content?.startsWith('你还可以使用长期记忆工具'))
  .map(message => message.role === 'user' ? { ...message, content: message.content.replace(/^\[[^\]]+\] /, '') } : message);

test('chat settings keep secrets out of settings/history and require a new key when changing site', async t => {
  const { service, dataDir, vault } = fixture(t);
  const saved = service.save(settings);
  assert.equal(saved.hasKey, true); assert.equal(saved.keyStorage, 'encrypted');
  assert.ok(!JSON.stringify(saved).includes(settings.apiKey));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'chat-settings.json'), 'utf8').includes(settings.apiKey));
  const restarted = new ChatService({ dataDir, secretVault: vault });
  assert.equal(restarted.publicConfig().hasKey, true);
  assert.throws(() => service.save({ ...settings, baseUrl: 'https://other.example.test', apiKey: '' }), /重新输入/);
  assert.throws(() => service.save({ ...settings, maxTokens: 0 }), /最长回复长度/);
  assert.equal(saved.backgroundMaxTokens, 1024, 'settings saved before the option existed get the default');
  assert.throws(() => service.save({ ...settings, backgroundMaxTokens: 32769 }), /主动消息最长回复/);
  assert.equal(service.save({ ...settings, apiKey: '', backgroundMaxTokens: '600' }).backgroundMaxTokens, 600);
  assert.equal(service.save({ ...settings, apiKey: '' }).backgroundMaxTokens, 600, 'a save without the option keeps it');
  assert.equal(new ChatService({ dataDir, secretVault: vault }).publicConfig().backgroundMaxTokens, 600);
  assert.throws(() => completionUrl('https://user:secret@chat.example.test/v1'), /不能包含/);
  assert.throws(() => completionUrl('http://remote.example.test'), /HTTPS/);
  assert.equal(completionUrl('https://chat.example.test/v1/chat/completions'), 'https://chat.example.test/v1/chat/completions');
  assert.equal(completionUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1/chat/completions');
});

test('failed settings writes preserve endpoint and key together, in encrypted and session storage', async t => {
  for (const encrypted of [true, false]) {
    const requests = [];
    const options = { fetchImpl: async (url, request) => { requests.push({ url, authorization: new Headers(request.headers).get('authorization') }); return sse('reply'); } };
    if (!encrypted) options.secretVault = null;
    const { service, dataDir, vault } = fixture(t, options);
    const configFile = path.join(dataDir, 'chat-settings.json');
    const failSave = input => {
      const existing = fs.existsSync(configFile);
      if (existing) fs.renameSync(configFile, configFile + '.saved');
      fs.mkdirSync(configFile);
      assert.throws(() => service.save(input));
      fs.rmdirSync(configFile);
      if (existing) fs.renameSync(configFile + '.saved', configFile);
    };
    failSave(settings);
    assert.equal(service.publicConfig().hasKey, false, 'failed first save must not activate a key');
    assert.equal(new ChatService({ dataDir, secretVault: encrypted ? vault : null }).publicConfig().hasKey, false);
    service.save(settings);
    for (const baseUrl of [settings.baseUrl, 'https://other.example.test/v1']) {
      failSave({ ...settings, baseUrl, apiKey: 'synthetic-other-key' });
      assert.equal(service.publicConfig().baseUrl, settings.baseUrl);
      await consume(service.start({ id: 'failed_save_' + requests.length, text: 'Hello' }));
      assert.deepEqual(requests.at(-1), { url: settings.baseUrl + '/chat/completions', authorization: 'Bearer ' + settings.apiKey });
      if (encrypted) assert.equal(new ChatService({ dataDir, secretVault: vault }).key(), settings.apiKey);
    }
    service.save({ ...settings, baseUrl: 'https://other.example.test/v1', apiKey: 'synthetic-other-key' });
    await consume(service.start({ id: 'successful_save', text: 'Hello' }));
    assert.deepEqual(requests.at(-1), { url: 'https://other.example.test/v1/chat/completions', authorization: 'Bearer synthetic-other-key' });
  }
});

test('renderer client and dispatcher stream split UTF-8, persona, reply limit and multi-turn history', async t => {
  const requests = [];
  const { dataDir, vault } = fixture(t);
  const dispatcher = createDispatcher({ dataDir, secretVault: vault, monitor: false, autoRefresh: false,
    chatFetchImpl: async (url, options) => { requests.push({ url, ...options, payload: JSON.parse(options.body) }); return sse('你好，鲸鱼\n第二行'); } });
  t.after(() => dispatcher.close());
  const client = createChatClient(async (url, options) => {
    const result = await dispatcher.dispatch(url, { method: options.method, body: options.body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  });
  await client.save(settings);
  const events = [];
  await client.send('message_one', 'Hello', event => events.push(event));
  assert.equal(events[1].type, 'delta'); assert.equal(events[1].text, '你好，鲸鱼\n第二行');
  assert.equal(events.at(-1).turn.status, 'completed'); assert.equal(events.at(-1).turn.usage.total_tokens, 15);
  await client.send('message_two', 'Again', () => {});
  assert.equal(requests[0].url, 'https://chat.example.test/v1/chat/completions');
  assert.equal(requests[0].redirect, 'error'); assert.equal(requests[0].payload.stream, true);
  assert.equal(requests[0].payload.max_tokens, 256);
  assert.deepEqual(withoutTime(requests[1].payload.messages), [
    { role: 'system', content: settings.persona }, { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '你好，鲸鱼\n第二行' }, { role: 'user', content: 'Again' }
  ]);
  const restarted = new ChatService({ dataDir, secretVault: vault });
  assert.equal(restarted.history().turns.length, 2);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'chat-history.json'), 'utf8').includes(settings.apiKey));
  await client.clear(); assert.equal((await client.history()).turns.length, 0);
});

test('stop preserves partial text, rejects concurrent sends and permits a later reply', async t => {
  let stalled = true, upstream;
  const { service } = fixture(t, { fetchImpl: async (_url, { signal }) => {
    if (!stalled) return sse('next');
    return new Response(new ReadableStream({ start(controller) {
      upstream = controller;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  service.save(settings);
  const response = service.start({ id: 'message_one', text: 'First' });
  const job = consume(response);
  assert.throws(() => service.start({ id: 'message_two', text: 'Second' }), /尚未结束/);
  assert.throws(() => service.clear(), /先停止/);
  assert.throws(() => service.save(settings), /先停止/);
  while (!upstream || !service.turns[0].text) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.stop('different_id'), false);
  assert.equal(service.stop('message_one'), true);
  const result = (await job).at(-1).turn;
  assert.equal(result.status, 'cancelled'); assert.equal(result.text, 'partial');
  stalled = false;
  assert.equal((await consume(service.start({ id: 'message_two', text: 'Second' }))).at(-1).turn.status, 'completed');
});

test('stopping before the message request arrives still cancels that generation', async t => {
  const { service } = fixture(t, { fetchImpl: async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw new Error('aborted');
  } });
  service.save(settings);
  service.stop('message_one');
  const result = (await consume(service.start({ id: 'message_one', text: 'First' }))).at(-1).turn;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, '');
});

test('unfinished and rejected provider replies are reported without exposing API secrets', async t => {
  let rejected = false;
  const { service } = fixture(t, { fetchImpl: async () => rejected ? new Response(settings.apiKey, { status: 401 }) : sse('partial', { done: false }) });
  service.save(settings);
  const partial = (await consume(service.start({ id: 'message_one', text: 'First' }))).at(-1).turn;
  assert.equal(partial.status, 'failed'); assert.equal(partial.text, 'partial'); assert.match(partial.error, /提前结束/);
  rejected = true;
  const denied = (await consume(service.start({ id: 'message_two', text: 'Second' }))).at(-1).turn;
  assert.equal(denied.status, 'failed'); assert.match(denied.error, /401/); assert.ok(!JSON.stringify(denied).includes(settings.apiKey));
});

test('a stalled generation times out and a non-encrypting environment stores its key only in memory', async t => {
  const { service, dataDir } = fixture(t, { secretVault: null, idleMs: 5, fetchImpl: async (_url, { signal }) => {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  assert.equal(service.save(settings).keyStorage, 'session');
  const result = (await consume(service.start({ id: 'message_one', text: 'First' }))).at(-1).turn;
  assert.equal(result.status, 'failed'); assert.match(result.error, /超时/);
  assert.equal(new ChatService({ dataDir }).publicConfig().hasKey, false);
});

test('conversation list preserves separate contexts, resumes old chats and survives restart and deletion', async t => {
  const requests = [];
  const { service, dataDir, vault } = fixture(t, { fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body).messages); return sse('reply');
  } });
  service.save(settings);
  const firstId = service.history().conversationId;
  await consume(service.start({ id: 'first_message', text: 'First topic', conversationId: firstId }));
  service.changeConversation('create');
  const secondId = service.history().conversationId;
  assert.notEqual(secondId, firstId); assert.equal(service.turns.length, 0);
  assert.equal(service.history().conversations.length, 2);
  assert.throws(() => service.start({ id: 'stale_message', text: 'Wrong topic', conversationId: firstId }), /已切换/);
  await consume(service.start({ id: 'second_message', text: 'Second topic', conversationId: secondId }));
  assert.deepEqual(withoutTime(requests[1]), [{ role: 'system', content: settings.persona }, { role: 'user', content: 'Second topic' }]);
  service.changeConversation('select', firstId);
  await consume(service.start({ id: 'resumed_message', text: 'Continue first' }));
  assert.deepEqual(withoutTime(requests[2]), [{ role: 'system', content: settings.persona }, { role: 'user', content: 'First topic' },
    { role: 'assistant', content: 'reply' }, { role: 'user', content: 'Continue first' }]);
  const restarted = new ChatService({ dataDir, secretVault: vault }); t.after(() => restarted.close());
  assert.equal(restarted.history().conversationId, firstId);
  assert.equal(restarted.turns.length, 2);
  restarted.changeConversation('delete', secondId);
  assert.equal(restarted.history().conversationId, firstId); assert.equal(restarted.turns.length, 2);
  restarted.changeConversation('delete', firstId);
  assert.equal(restarted.turns.length, 0); assert.equal(restarted.history().conversations.length, 1);
  assert.throws(() => restarted.changeConversation('select', firstId), /不存在/);
});

test('legacy history migrates without losing usage and unfinished turns recover in every conversation', async t => {
  const { dataDir, vault } = fixture(t);
  const legacy = { version: 1, turns: [{ id: 'legacy_message', user: 'Original topic', text: 'Original reply',
    model: 'deepseek-flash', status: 'completed', createdAt: '2026-09-27T02:13:25Z', usage: { prompt_tokens: 670, completion_tokens: 4907 } }] };
  fs.writeFileSync(path.join(dataDir, 'chat-history.json'), JSON.stringify(legacy));
  const migrated = new ChatService({ dataDir, secretVault: vault }); t.after(() => migrated.close());
  assert.deepEqual(migrated.turns, legacy.turns);
  assert.equal(migrated.history().conversations[0].title, 'Original topic');
  const originalId = migrated.history().conversationId;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-history.v1.json'))), legacy);
  migrated.changeConversation('create');
  migrated.turns.push({ ...legacy.turns[0], id: 'unfinished_message', status: 'streaming' }); migrated.persist();
  const restarted = new ChatService({ dataDir, secretVault: vault }); t.after(() => restarted.close());
  assert.equal(restarted.turns[0].status, 'interrupted');
  restarted.changeConversation('select', originalId);
  assert.deepEqual(restarted.turns, legacy.turns);
});

test('conversation changes reject active generation and failed storage commits retain the selected session', async t => {
  const { service, dataDir } = fixture(t, { fetchImpl: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  service.save(settings);
  const firstId = service.history().conversationId;
  const job = consume(service.start({ id: 'active_message', text: 'First' }));
  for (const operation of ['create', 'select', 'delete']) assert.throws(() => service.changeConversation(operation, firstId), /先停止/);
  service.stop('active_message'); await job;
  const file = path.join(dataDir, 'chat-history.json'); fs.renameSync(file, file + '.saved'); fs.mkdirSync(file);
  for (const operation of ['create', 'delete']) {
    assert.throws(() => service.changeConversation(operation, firstId));
    assert.equal(service.history().conversationId, firstId); assert.equal(service.history().conversations.length, 1);
  }
  fs.rmdirSync(file); fs.renameSync(file + '.saved', file);
});
