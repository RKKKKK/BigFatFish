import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';
import { completionUrl } from './provider.mjs';
import { ChatBilling } from './billing.mjs';
import { Conversations } from './conversations.mjs';
import { ChatActivity } from './activity.mjs';
import { POMODORO_TOOLS, POMODORO_POLICY } from './pomodoro.mjs';
import { generateReply } from './reply.mjs';
import { AccountStore } from '../quota/accounts.mjs';
import { createMemoryTools } from '../workbench/tools.mjs';
import { createWorkTaskTools } from '../workbench/task-tools.mjs';
import { buildConsolidationPrompt, buildBootstrapPrompt, parseMemoryDiff, MEMORY_INSTRUCTION } from '../workbench/memory-prompt.mjs';

const DEFAULTS = { baseUrl: '', model: 'deepseek-flash', persona: '', maxTokens: 1024, backgroundMaxTokens: 1024 };
// A runaway guard only; the token settings decide how long a reply may be.
const MAX_REPLY_CHARS = 128000;
const KEY_REF = 'whale_chat_api_key_v1';
const json = (status, value) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(value)) });
const BACKGROUND_INSTRUCTION = '按角色人设说一两句自然、简短的话。沿用过往对话的语言；没有上下文时用中文。不要声称看到了用户正在做什么，也不要假装执行了工具。';
const DECLINE_MARK = '[不打扰]';
const DECLINE_OFFER = '如果按聊天记录现在不适合打扰我，比如刚道过晚安、我说要出门或在忙，或者你说过自己要去睡了，就只回复 ' + DECLINE_MARK + '，不要写别的。';
const CAPABILITY_NOTE = '你还可以使用长期记忆工具（本地保存，重启后仍然有效），以及工作台任务工具（查看、起草、启动、停止、续跑 Codex 与 DSH 的无人值守任务）。人设里“只有番茄钟”“没有长期记忆”的说法已经过时，以本说明为准。不要否认自己记得已经保存的内容。下发或续跑任务前必须得到用户明确确认。';
const MEMORY_MIN_TURNS = 8;
const MEMORY_IDLE_MS = 2 * 60 * 1000;
const MEMORY_INTERVAL_MS = 30 * 60 * 1000;
const MEMORY_MAX_TOKENS = 800;
// The marker anywhere, in either bracket style, or a few words starting with it.
function declined(text) {
  const bare = text.replace(/[\s\p{P}]/gu, '');
  return /[[【]不打扰[\]】]/.test(text) || bare.startsWith('不打扰') && bare.length <= 8;
}
// The chat settings file keeps the reply settings. Its endpoint and key ref
// only mirror the pet's account, so an older pet still finds them.
function storedSettings(file) {
  const stored = readJson(file, {});
  return { ...DEFAULTS, ...stored, keyRef: typeof stored.keyRef === 'string' ? stored.keyRef : stored.baseUrl ? KEY_REF : '' };
}

export class ChatService {
  // The pet talks through its account in the account store (the quota book's).
  // queryBalance reads that account's balance from the quota book;
  // onUserMessage tells the book that you wrote to the pet.
  constructor({ dataDir, secretVault, accounts = null, fetchImpl = fetch, idleMs = 60000, timeoutMs = 180000, canProactive = () => true, onNotice = () => {}, now = Date.now,
    activityOptions = {}, queryBalance = null, onUserMessage = () => {}, memory = null, memoryEnabled = () => true, taskRunner = () => null, taskSummary = () => null }) {
    this.configFile = path.join(dataDir, 'chat-settings.json');
    this.settings = storedSettings(this.configFile);
    this.accounts = accounts || new AccountStore({ dataDir, vault: secretVault });
    this.conversations = new Conversations(dataDir);
    this.fetchImpl = fetchImpl; this.active = null; this.background = null;
    this.cancelledIds = new Set();
    this.idleMs = idleMs; this.timeoutMs = timeoutMs;
    this.now = activityOptions.now || now;
    this.memory = memory; this.memoryEnabled = memoryEnabled;
    this.taskRunner = taskRunner; this.taskSummary = taskSummary;
    this.memoryTimer = null; this.memoryJob = null; this.lastTurnAt = 0;
    this.billing = new ChatBilling({ dataDir, queryBalance }); this.onUserMessage = onUserMessage;
    this.activity = new ChatActivity({ dataDir, canProactive: () => canProactive() && !this.active && !this.background,
      onProactive: () => this.proactive(), onReminder: state => this.reminder(state), onNotice, now: this.now, ...activityOptions });
  }
  // The pet's account: where requests go and the key they carry. Its key time
  // starts the recovery of old chat history into billing.
  endpoint() {
    const pet = this.accounts.pet();
    return pet ? { id: pet.id, name: pet.name, baseUrl: pet.baseUrl, key: pet.key, keyStorage: pet.keyStorage, keySetAt: pet.keySetAt || Infinity } :
      { id: '', name: '', baseUrl: '', key: '', keyStorage: 'session', keySetAt: Infinity };
  }
  key() { return this.endpoint().key; }
  get turns() { return this.conversations.current.turns; }
  recoverBilling(endpoint = this.endpoint()) {
    this.billing.recoverHistory(this.conversations.allTurns(), { baseUrl: endpoint.baseUrl, key: endpoint.key, settingsSavedAt: endpoint.keySetAt });
  }
  publicConfig() {
    const { model, persona, maxTokens, backgroundMaxTokens } = this.settings, endpoint = this.endpoint();
    const accounts = this.accounts.publicList().accounts.filter(account => !account.hidden || account.id === endpoint.id)
      .map(account => ({ id: account.id, name: account.name, host: account.host, ready: account.keyStatus === 'ready' }));
    return { accountId: endpoint.id, accountName: endpoint.name, accounts, baseUrl: endpoint.baseUrl, model, persona, maxTokens, backgroundMaxTokens,
      hasKey: !!endpoint.key, keyStorage: endpoint.keyStorage };
  }
  // Saves the reply settings and which account the pet uses. An endpoint and
  // key given instead pick, or add, the account behind them. The pet moves to
  // that account only once the settings are saved.
  save(input) {
    if (this.active) throw new Error('请先停止当前回复，再修改会话设置');
    const model = String(input.model || '').trim();
    const persona = String(input.persona || '').trim(), maxTokens = Number(input.maxTokens);
    const tokenLimit = value => Number.isInteger(value) && value >= 1 && value <= 32768;
    const backgroundMaxTokens = input.backgroundMaxTokens === undefined ? this.settings.backgroundMaxTokens : Number(input.backgroundMaxTokens);
    if (!model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('请填写有效的模型名称');
    if (persona.length > 16000) throw new Error('角色人设最多 16000 个字符');
    if (!tokenLimit(maxTokens)) throw new Error('最长回复长度须为 1 到 32768 个 token');
    if (!tokenLimit(backgroundMaxTokens)) throw new Error('主动消息最长回复须为 1 到 32768 个 token');
    let accountId = typeof input.accountId === 'string' ? input.accountId : this.endpoint().id;
    if (input.baseUrl !== undefined || input.apiKey) {
      completionUrl(String(input.baseUrl || '').trim());
      accountId = this.accounts.adopt({ baseUrl: String(input.baseUrl || '').trim(), key: String(input.apiKey || '').trim() }).id;
    }
    const account = this.accounts.account(accountId);
    if (!account) throw new Error('请选择大肥鱼使用的账户');
    completionUrl(account.endpoint);
    this.recoverBilling();
    const mirror = account.key.mode === 'keychain' ? { baseUrl: account.endpoint, keyRef: account.key.ref } : {};
    const settings = { ...this.settings, ...mirror, model, persona, maxTokens, backgroundMaxTokens };
    writeJson(this.configFile, settings); this.settings = settings;
    if (account.id !== this.endpoint().id) this.accounts.setPet(account.id);
    return this.publicConfig();
  }
  history() { return { turns: structuredClone(this.turns), activeId: this.active?.id || null,
    conversationId: this.conversations.currentId, conversations: this.conversations.list() }; }
  activitySnapshot() { return this.activity.snapshot(); }
  // Recent exchanges: every conversation's turns in time order; a reply keeps the latest ones.
  recentExchanges() {
    return this.conversations.allTurns().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }
  // What the character remembers when replying in a conversation: a normal one
  // remembers itself, the companion conversation the recent exchanges.
  memoryOf(conversation) {
    return conversation?.kind === 'spontaneous' ? this.recentExchanges() : [...conversation?.turns || []];
  }
  memoryBlock() { return this.memory?.block?.() || ''; }
  // Pomodoro and memory tools share one tool list. The reply loop executes the
  // matching group by name; memory tools may be absent when no store is wired.
  toolsFor(conversationId, context = {}) {
    const groups = [{ definitions: POMODORO_TOOLS, policy: POMODORO_POLICY, execute: call => this.activity.tool(call, conversationId) }];
    const memoryTools = createMemoryTools({ memory: this.memory });
    if (memoryTools) groups.push(memoryTools);
    let runner = null;
    try { runner = this.taskRunner?.() || null; } catch {}
    const taskTools = createWorkTaskTools({ runner, summary: () => { try { return this.taskSummary?.() || null; } catch { return null; } }, conversationId, userText: () => context.userText || '' });
    if (taskTools) groups.push(taskTools);
    return {
      definitions: groups.flatMap(group => group.definitions),
      policy: groups.map(group => group.policy).filter(Boolean).join('\n'),
      execute: call => {
        const group = groups.find(item => item.definitions.some(definition => definition.function.name === call?.name));
        return group ? group.execute(call) : { ok: false, error: '未知工具' };
      },
    };
  }
  // Automatic consolidation happens only after a few completed turns and a
  // quiet period. The timer is reset by every new turn; closing the service
  // clears it.
  scheduleMemory() {
    clearTimeout(this.memoryTimer); this.memoryTimer = null;
    if (!this.memory || !this.memoryEnabled()) return;
    try {
      if (this.memory.stats().turnsSince < MEMORY_MIN_TURNS) return;
      const idleFor = this.lastTurnAt ? this.now() - this.lastTurnAt : MEMORY_IDLE_MS;
      const delay = Math.max(5000, MEMORY_IDLE_MS - idleFor);
      this.memoryTimer = setTimeout(() => { this.memoryTimer = null; this.consolidateMemory().catch(() => {}); }, delay);
      this.memoryTimer.unref?.();
    } catch {}
  }
  async consolidateMemory({ force = false } = {}) {
    if (!this.memory) return { ok: false, error: '没有可用的长期记忆' };
    if (this.active || this.background) return { ok: false, error: '正在回复，稍后再整理记忆' };
    if (this.memoryJob) return { ok: false, error: '记忆正在整理' };
    const endpoint = this.endpoint();
    if (!endpoint.baseUrl || !endpoint.key) return { ok: false, error: '大肥鱼账户还没有可用的密钥' };
    const stats = this.memory.stats();
    if (!force && stats.turnsSince < MEMORY_MIN_TURNS) return { ok: false, error: '还没有足够的新对话需要整理' };
    if (!force && stats.lastAttemptAt && this.now() - stats.lastAttemptAt < MEMORY_INTERVAL_MS) return { ok: false, error: '刚整理过，稍后再试' };
    const turns = this.recentExchanges().filter(turn => turn.status === 'completed').slice(-12);
    if (!turns.length) return { ok: false, error: '还没有可以整理的对话' };
    const prompt = buildConsolidationPrompt(this.memory, turns);
    const id = 'memory-' + randomUUID();
    this.memoryJob = (async () => {
      try {
        const reply = await this.reply({ ...this.settings, baseUrl: endpoint.baseUrl, maxTokens: MEMORY_MAX_TOKENS }, endpoint.key, {
          persona: '', capabilities: '', memory: '', instruction: MEMORY_INSTRUCTION, history: [], prompt, tools: null, id,
          timeoutMs: 30000, maxChars: 16000,
        });
        const diff = reply.status === 'completed' ? parseMemoryDiff(reply.text) : null;
        if (!diff) { this.memory.markAttempt(false); return { ok: false, error: '记忆整理没有返回可用的内容' }; }
        const applied = this.memory.applyDiff(diff, 'consolidation');
        this.memory.markAttempt(true);
        return { ok: true, applied, memory: this.memory.public() };
      } catch (error) {
        this.memory.markAttempt(false);
        return { ok: false, error: error?.message || '记忆整理失败' };
      } finally { this.memoryJob = null; }
    })();
    return this.memoryJob;
  }
  // One-time seeding from the conversations already on disk. It is on demand
  // from the workbench, not run at startup, so the user can see and edit it.
  async bootstrapMemory() {
    if (!this.memory) return { ok: false, error: '没有可用的长期记忆' };
    if (this.active || this.background) return { ok: false, error: '正在回复，稍后再初始化记忆' };
    if (this.memoryJob) return { ok: false, error: '记忆正在整理' };
    const endpoint = this.endpoint();
    if (!endpoint.baseUrl || !endpoint.key) return { ok: false, error: '大肥鱼账户还没有可用的密钥' };
    const turns = this.recentExchanges().filter(turn => turn.status === 'completed').slice(-24);
    if (!turns.length) return { ok: false, error: '还没有可以初始化的对话' };
    const prompt = buildBootstrapPrompt(this.memory, turns);
    const id = 'memory-' + randomUUID();
    this.memoryJob = (async () => {
      try {
        const reply = await this.reply({ ...this.settings, baseUrl: endpoint.baseUrl, maxTokens: 1200 }, endpoint.key, {
          persona: '', capabilities: '', memory: '', instruction: MEMORY_INSTRUCTION, history: [], prompt, tools: null, id,
          timeoutMs: 60000, maxChars: 20000,
        });
        const diff = reply.status === 'completed' ? parseMemoryDiff(reply.text) : null;
        if (!diff) return { ok: false, error: '初始化没有返回可用的内容' };
        const applied = this.memory.applyDiff(diff, 'bootstrap');
        this.memory.markAttempt(true);
        return { ok: true, applied, memory: this.memory.public() };
      } catch (error) {
        return { ok: false, error: error?.message || '初始化失败' };
      } finally { this.memoryJob = null; }
    })();
    return this.memoryJob;
  }
  // A small text-only request used by task summaries and daily reports. It
  // never touches conversation history and is billed like any other request.
  async generateText({ instruction = '', prompt = '', maxTokens = 400, timeoutMs = 30000 } = {}) {
    const endpoint = this.endpoint();
    if (!endpoint.baseUrl || !endpoint.key) return { ok: false, error: '大肥鱼账户还没有可用的密钥' };
    if (!String(prompt || '').trim()) return { ok: false, error: '没有可总结的内容' };
    const id = 'summary-' + randomUUID();
    try {
      const reply = await this.reply({ ...this.settings, baseUrl: endpoint.baseUrl, maxTokens }, endpoint.key, {
        persona: '', capabilities: '', memory: '', instruction, history: [], prompt, tools: null, id,
        timeoutMs, maxChars: 20000,
      });
      if (reply.status === 'completed' && reply.text.trim()) return { ok: true, text: reply.text.trim() };
      return { ok: false, error: reply.error || '模型没有返回摘要' };
    } catch (error) { return { ok: false, error: error?.message || '摘要请求失败' }; }
  }
  reply(settings, key, options) {
    return generateReply({ endpoint: { baseUrl: settings.baseUrl, model: settings.model, maxTokens: settings.maxTokens, key }, persona: settings.persona,
      now: this.now(), fetchImpl: this.fetchImpl, record: (request, credentials) => this.billing.record(request, credentials), ...options });
  }
  // Generates without touching history. A non-null result carries commit(),
  // which appends the reply to conversation `conversationId` (the spontaneous
  // one when that is absent or deleted), dated at that moment, and returns where
  // it went; the caller commits only if the reply still applies when it is due.
  async backgroundReply({ prompt, source, history = [], conversationId }) {
    const endpoint = this.endpoint();
    if (this.active || this.background || !endpoint.key || !endpoint.baseUrl) return null;
    const key = endpoint.key, settings = { ...this.settings, baseUrl: endpoint.baseUrl, maxTokens: this.settings.backgroundMaxTokens };
    const controller = new AbortController(), id = randomUUID();
    const background = { controller };
    background.done = new Promise(resolve => { background.resolve = resolve; });
    this.background = background;
    try {
      const reply = await this.reply(settings, key, { instruction: BACKGROUND_INSTRUCTION, history, prompt, id, signal: controller.signal,
        timeoutMs: Math.min(30000, this.timeoutMs), maxChars: MAX_REPLY_CHARS });
      const text = reply.text.trim();
      if (reply.status !== 'completed' || !text) return null;
      return { text, commit: () => {
        const target = this.conversations.find(conversationId) || this.conversations.spontaneous();
        this.conversations.appendTo(target.id, { id, user: '', text, status: 'completed', source, createdAt: new Date(this.now()).toISOString(), model: settings.model, usage: reply.usage, requests: reply.requests });
        return target.id;
      } };
    } finally {
      if (this.background === background) this.background = null;
      background.resolve();
    }
  }
  // Remembers the recent exchanges, like the companion conversation it lands in. Half
  // the time it follows one of them up; otherwise it opens a new topic. The
  // character may decline instead; a declined message is never kept or shown.
  async proactive() {
    const prompt = this.activity.random() < 0.5 ? '结合我们最近聊过的一件事，主动和我随便聊一句。' : '按你的人设，主动发起一个轻松的新话题。';
    const generated = await this.backgroundReply({ source: 'proactive', history: this.recentExchanges(), prompt: prompt + '不要推测我现在正在做什么。' + DECLINE_OFFER });
    return generated && declined(generated.text) ? null : generated;
  }
  async reminder(state) {
    const prompt = `番茄钟状态：${state.phase}；第 ${state.cycle}/${state.cycles} 轮；专注 ${state.focusMinutes} 分钟，休息 ${state.breakMinutes} 分钟。请按人设简短提醒我${state.phase === 'await_break' ? '专注结束，可以准备休息了' : state.phase === 'await_focus' ? '休息结束，可以准备下一轮专注了' : '本次专注已经完成'}。阶段尚未开始，不要宣称已经开始，不要要求我发送消息确认，也不要解释界面操作。`;
    return this.backgroundReply({ source: 'pomodoro', prompt, history: this.memoryOf(this.conversations.find(state.conversationId)), conversationId: state.conversationId });
  }
  persist() { this.conversations.persist(); }
  changeConversation(action, id) {
    if (this.active) throw new Error('请先停止回复，再操作会话列表');
    this.recoverBilling();
    if (action === 'create') this.conversations.create();
    else if (action === 'select') this.conversations.select(id);
    else this.conversations.remove(id);
  }
  clear() {
    if (this.active) throw new Error('请先停止回复，再新建会话');
    this.changeConversation('delete', this.conversations.currentId);
  }
  stop(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('无效的消息标识');
    this.cancelledIds.add(id);
    if (this.cancelledIds.size > 64) this.cancelledIds.delete(this.cancelledIds.values().next().value);
    if (this.active?.id === id) { this.active.controller.abort(); return true; }
    return false;
  }
  start(input, signal) {
    if (this.active) throw new Error('当前回复尚未结束');
    const text = String(input.text || '').trim(), id = input.id;
    if (!text || text.length > 16000) throw new Error('消息不能为空，且最多 16000 个字符');
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id) || this.conversations.allTurns().some(turn => turn.id === id)) throw new Error('无效或重复的消息标识');
    if (input.conversationId !== undefined && input.conversationId !== this.conversations.currentId) throw new Error('当前会话已切换，请重新发送');
    const endpoint = this.endpoint(), key = endpoint.key;
    if (!endpoint.id) throw new Error('请先在会话设置里选择大肥鱼使用的账户');
    if (!key) throw new Error('大肥鱼账户还没有可用的密钥，请在额度管理里填写');
    completionUrl(endpoint.baseUrl);
    this.recoverBilling(endpoint);
    const controller = new AbortController(), settings = { ...this.settings, baseUrl: endpoint.baseUrl };
    if (this.cancelledIds.has(id)) controller.abort();
    this.background?.controller.abort();
    const conversationId = this.conversations.currentId, history = this.memoryOf(this.conversations.current);
    const tools = this.toolsFor(conversationId, { userText: text });
    const turn = { id, user: text, text: '', status: 'streaming', source: 'user', createdAt: new Date(this.now()).toISOString(), model: settings.model, requests: [] };
    this.turns.push(turn); this.persist();
    try { this.activity.userActivity(); } catch {}
    try { this.onUserMessage(); } catch {}
    this.active = { id, controller };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start: output => {
        let disconnected = false;
        const emit = event => { if (!disconnected) { try { output.enqueue(encoder.encode('data: ' + JSON.stringify({ ...event, id }) + '\n\n')); } catch { disconnected = true; controller.abort(); } } };
        emit({ type: 'start' });
        this.active.job = (async () => {
          try {
            const reply = await this.reply(settings, key, { history, prompt: text, tools, id, signal: controller.signal,
              memory: this.memoryBlock(), capabilities: this.memory ? CAPABILITY_NOTE : '',
              timeoutMs: this.timeoutMs, idleMs: this.idleMs, maxChars: MAX_REPLY_CHARS, onDelta: delta => { turn.text += delta; emit({ type: 'delta', text: delta }); } });
            Object.assign(turn, { text: reply.text, status: reply.status, requests: reply.requests },
              reply.taskRefs?.length ? { taskRefs: reply.taskRefs } : {},
              reply.usage ? { usage: reply.usage } : {}, reply.finishReason ? { finishReason: reply.finishReason } : {}, reply.error ? { error: reply.error } : {});
          } catch { turn.status = 'failed'; turn.error = '会话连接失败，请检查网络或接口地址'; }
          finally {
            signal?.removeEventListener('abort', abort);
            try { this.persist(); }
            catch { turn.status = 'failed'; turn.error = '回复已收到，但本地历史保存失败'; }
            if (turn.status === 'completed' && this.memory) {
              this.lastTurnAt = this.now();
              try { this.memory.noteTurn(); } catch {}
              this.scheduleMemory();
            }
            this.active = null;
            emit({ type: 'done', turn: structuredClone(turn) });
            try { output.close(); } catch {}
          }
        })();
      },
      cancel: () => controller.abort(),
    });
    return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body };
  }
  async dispatch(url, { method, body, signal }) {
    try {
      const input = () => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body || {}));
      if (url.pathname === '/api/chat/settings') {
        if (method === 'GET') return json(200, { ok: true, settings: this.publicConfig() });
        if (method === 'PUT') return json(200, { ok: true, settings: this.save(input()) });
      }
      if (url.pathname === '/api/chat/history') {
        if (method === 'GET') return json(200, { ok: true, ...this.history() });
        if (method === 'DELETE') { this.clear(); return json(200, { ok: true, ...this.history() }); }
      }
      if (url.pathname === '/api/chat/conversations') {
        if (method === 'GET') return json(200, { ok: true, conversationId: this.conversations.currentId, conversations: this.conversations.list() });
        if (['POST', 'PUT', 'DELETE'].includes(method)) {
          this.changeConversation(method === 'POST' ? 'create' : method === 'PUT' ? 'select' : 'delete', method === 'POST' ? undefined : input().id);
          return json(200, { ok: true, ...this.history() });
        }
      }
      if (url.pathname === '/api/chat/billing' && method === 'GET') {
        const endpoint = this.endpoint(); this.recoverBilling(endpoint);
        return json(200, { ok: true, billing: await this.billing.summary({ baseUrl: endpoint.baseUrl, key: endpoint.key, force: url.searchParams.get('refresh') === '1' }) });
      }
      if (url.pathname === '/api/chat/activity' && method === 'GET') return json(200, { ok: true, ...this.activitySnapshot() });
      if (url.pathname === '/api/chat/activity/settings') {
        if (method === 'GET') return json(200, { ok: true, settings: this.activity.settings() });
        if (method === 'PUT') return json(200, { ok: true, settings: this.activity.saveSettings(input()) });
      }
      if (url.pathname === '/api/chat/activity/ack' && method === 'POST') { this.activity.ack(input().seq); return json(200, { ok: true }); }
      if (url.pathname === '/api/chat/activity/advance' && method === 'POST') return json(200, this.activity.advance(input()));
      if (url.pathname === '/api/chat/activity/presence' && method === 'POST') { this.activity.setPresence(input()); return json(200, { ok: true }); }
      if (url.pathname === '/api/chat/message' && method === 'POST') return this.start(input(), signal);
      if (url.pathname === '/api/chat/stop' && method === 'POST') return json(200, { ok: true, stopped: this.stop(input().id) });
      return json(405, { ok: false, error: '不支持的会话操作' });
    } catch (error) { return json(400, { ok: false, error: error instanceof SyntaxError ? '会话数据格式无效' : error.message }); }
  }
  async close() {
    clearTimeout(this.memoryTimer); this.memoryTimer = null;
    this.activity.close();
    const background = this.background;
    background?.controller.abort();
    if (this.active) { this.active.controller.abort(); await this.active?.job; }
    await background?.done;
    await this.memoryJob?.catch?.(() => {});
  }
}
