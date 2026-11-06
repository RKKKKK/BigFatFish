import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../runtime/workbench/memory.mjs';
import { buildConsolidationPrompt, parseMemoryDiff } from '../runtime/workbench/memory-prompt.mjs';
import { createMemoryTools } from '../runtime/workbench/tools.mjs';
import { ChatService } from '../runtime/chat/service.mjs';

const sse = content => new Response(
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content } }] }) + '\n\n' +
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n' +
  'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } },
);

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('memory stores, deduplicates and reloads compact items', t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir, now: () => Date.parse('2026-10-31T12:00:00Z') });
  assert.equal(store.block(), '');
  const view = store.saveItem({ section: 'identity', text: '称呼 RK，大肥鱼自称本鱼', pinned: true });
  assert.equal(view.items.length, 1);
  assert.match(store.block(), /称呼：称呼 RK/);
  assert.equal(store.saveItem({ section: 'identity', text: '称呼 RK，大肥鱼自称本鱼' }).items.length, 1, 'the same fact is not duplicated');
  const reloaded = new MemoryStore({ dataDir });
  assert.equal(reloaded.items.length, 1);
  assert.equal(reloaded.items[0].pinned, true);
  assert.equal(reloaded.public().budget.limit, 4096);
});

test('memory refuses secrets, enforces section caps and keeps the block under 4 KB', t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  assert.throws(() => store.saveItem({ section: 'longTerm', text: 'API key: sk-0123456789abcdef0123456789abcdef' }), /密钥/);
  assert.throws(() => store.saveItem({ section: 'longTerm', text: '密码是 123456' }), /密钥/);
  store.saveItem({ section: 'identity', text: '称呼 A' });
  store.saveItem({ section: 'identity', text: '称呼 B' });
  store.saveItem({ section: 'identity', text: '称呼 C', pinned: true });
  store.saveItem({ section: 'identity', text: '称呼 D' });
  const identity = store.items.filter(item => item.section === 'identity');
  assert.equal(identity.length, 3, 'the oldest non-pinned identity item was evicted');
  assert.equal(identity.some(item => item.text === '称呼 A'), false);
  for (const item of identity) store.update(item.id, { pinned: true });
  assert.throws(() => store.saveItem({ section: 'identity', text: '第四个称呼', pinned: true }), /记满/);

  for (const section of ['preferences', 'longTerm', 'projects', 'decisions', 'episodes']) {
    for (let index = 0; index < 8; index++) {
      try { store.saveItem({ section, text: section + ' ' + index + ' ' + '内容'.repeat(60) }); } catch {}
    }
  }
  assert.ok(Buffer.byteLength(store.block(), 'utf8') <= 4096, 'the injected block stays within 4 KB');
  assert.ok(store.items.length <= 40);
});

test('memory forgets by id or text, returns candidates, and can block a topic', t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  const one = store.saveItem({ section: 'preferences', text: '回复先给结论' });
  const two = store.saveItem({ section: 'preferences', text: '回复时不要使用列表' });
  const ambiguous = store.forget({ text: '回复' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.candidates.length, 2);
  const removed = store.forget({ id: one.items.at(-1).id, block: true });
  assert.equal(removed.ok, true);
  assert.equal(store.items.some(item => item.id === two.items.at(-1).id), true);
  assert.equal(store.items.length, 1);
  assert.ok(store.blocked.length >= 1);
});

test('consolidation diffs add, update and remove without trusting invalid entries', t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  const saved = store.saveItem({ section: 'longTerm', text: '改代码前先给计划' });
  const id = saved.items[0].id;
  const applied = store.applyDiff({
    add: [{ section: 'preferences', text: '喜欢短回复' }, { section: 'bad', text: 'x' }, { section: 'identity', text: '密码是 x' }],
    update: [{ id, text: '改代码前先给计划，再动手' }],
    remove: [],
    blocked: ['不要记这类内容'],
  }, 'consolidation');
  assert.equal(applied.added, 1);
  assert.equal(applied.updated, 1);
  assert.equal(applied.skipped, 2);
  assert.match(store.block(), /再动手/);
  assert.equal(store.blocked.includes('不要记这类内容'), true);
  store.update(id, { pinned: true });
  const protectedItem = store.applyDiff({ remove: [id] });
  assert.equal(protectedItem.removed, 0);
  assert.equal(protectedItem.skipped, 1, 'a consolidation diff cannot remove a pinned item');
  const other = store.saveItem({ section: 'decisions', text: '可删除的决定' });
  const otherId = other.items.find(item => item.text === '可删除的决定').id;
  const removed = store.applyDiff({ remove: [otherId] });
  assert.equal(removed.removed, 1);
});

test('memory consolidation state counts turns and resets after a successful attempt', t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  store.noteTurn(); store.noteTurn();
  assert.equal(store.stats().turnsSince, 2);
  store.markAttempt(true);
  assert.equal(store.stats().turnsSince, 0);
  assert.ok(store.stats().lastConsolidatedAt > 0);
});

test('the consolidation prompt includes memory, blocked topics and recent exchanges; the diff parser handles fenced JSON', t => {
  const store = new MemoryStore({ dataDir: temp(t) });
  store.saveItem({ section: 'identity', text: '称呼 RK' });
  const prompt = buildConsolidationPrompt(store, [
    { status: 'completed', user: '以后回复先给结论', text: '好' },
    { status: 'failed', user: '不要', text: '' },
  ]);
  assert.match(prompt, /\[现有记忆（id 用于 update\/remove）\]/);
  assert.match(prompt, new RegExp(store.items[0].id));
  assert.match(prompt, /以后回复先给结论/);
  assert.doesNotMatch(prompt, /不要/);
  const diff = parseMemoryDiff('```json\n{"add":[{"section":"preferences","text":"短回复"}],"update":[],"remove":[],"blocked":[]}\n```');
  assert.deepEqual(diff.add, [{ section: 'preferences', text: '短回复', pinned: false }]);
  assert.equal(parseMemoryDiff('不是 JSON'), null);
});

test('ChatService exposes the memory block and memory tools alongside pomodoro', async t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  store.saveItem({ section: 'identity', text: '称呼 RK' });
  const accounts = { pet: () => ({ id: 'pet', name: '大肥鱼', baseUrl: 'https://api.deepseek.com', key: 'synthetic', keyStorage: 'session' }) };
  const service = new ChatService({ dataDir, accounts, memory: store, memoryEnabled: () => true });
  t.after(() => service.close());
  assert.match(service.memoryBlock(), /称呼 RK/);
  const tools = service.toolsFor('conversation');
  assert.ok(tools.definitions.some(definition => definition.function.name === 'memory_save'));
  assert.ok(tools.definitions.some(definition => definition.function.name === 'pomodoro_status'));
  const result = tools.execute({ name: 'memory_save', arguments: JSON.stringify({ section: 'preferences', text: '回复先给结论' }) });
  assert.equal(result.ok, true);
  assert.equal(store.items.length, 2);
});

test('ChatService applies a consolidation diff from the model into the local memory', async t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  store.saveItem({ section: 'identity', text: '称呼 RK' });
  const accounts = { pet: () => ({ id: 'pet', name: '大肥鱼', baseUrl: 'https://api.deepseek.com', key: 'synthetic', keyStorage: 'session' }) };
  const service = new ChatService({ dataDir, accounts, memory: store, memoryEnabled: () => true,
    fetchImpl: async () => sse('{"add":[{"section":"preferences","text":"回复先给结论"}],"update":[],"remove":[],"blocked":[]}') });
  t.after(() => service.close());
  service.conversations.current.turns.push({ user: '以后回复先给结论', text: '好', status: 'completed', createdAt: new Date().toISOString() });
  const result = await service.consolidateMemory({ force: true });
  assert.equal(result.ok, true);
  assert.ok(store.items.some(item => item.text === '回复先给结论'));
  assert.equal(store.stats().turnsSince, 0);
});

test('ChatService seeds memory from existing history on demand', async t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  const accounts = { pet: () => ({ id: 'pet', name: '大肥鱼', baseUrl: 'https://api.deepseek.com', key: 'synthetic', keyStorage: 'session' }) };
  const service = new ChatService({ dataDir, accounts, memory: store, memoryEnabled: () => true,
    fetchImpl: async () => sse('{"add":[{"section":"projects","text":"BigFatFish 是桌面挂件项目"}],"update":[],"remove":[],"blocked":[]}') });
  t.after(() => service.close());
  service.conversations.current.turns.push({ user: '我在做大肥鱼这个桌面挂件', text: '好的', status: 'completed', createdAt: new Date().toISOString() });
  const result = await service.bootstrapMemory();
  assert.equal(result.ok, true);
  assert.ok(store.items.some(item => item.text.includes('BigFatFish')));
});

test('memory tools save, list and forget through the local store', t => {
  const dataDir = temp(t);
  const store = new MemoryStore({ dataDir });
  const tools = createMemoryTools({ memory: store });
  const saved = tools.execute({ name: 'memory_save', arguments: JSON.stringify({ section: 'identity', text: '叫我 RK', pinned: true }) });
  assert.equal(saved.ok, true);
  assert.equal(saved.saved.text, '叫我 RK');
  const list = tools.execute({ name: 'memory_list', arguments: '{}' });
  assert.equal(list.ok, true);
  assert.equal(list.memory.items.length, 1);
  const forgotten = tools.execute({ name: 'memory_forget', arguments: JSON.stringify({ id: saved.saved.id }) });
  assert.equal(forgotten.ok, true);
  assert.equal(store.items.length, 0);
});
