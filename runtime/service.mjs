import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigStore } from './config.mjs';
import { BalanceProvider } from './providers.mjs';
import { UsageLedger, usageDefaults } from './ledger.mjs';
import { readJson, writeJson, rounded } from './paths.mjs';
import { TurnJournal, safeSample, safeTurn, safeUsage } from './turn-journal.mjs';
import { codexSnapshot, publicCodexSnapshot } from './quota/windows.mjs';
import { AccountStore } from './quota/accounts.mjs';
import { cleanAlertSettings, legacyAlertSettings } from './quota/alerts.mjs';

function safeSubscriptionRateLimitContext(value) {
  const observedAt = Number(value?.observedAt);
  if (!Number.isFinite(observedAt) || typeof value?.usesSubscription !== 'boolean') return null;
  return { observedAt, usesSubscription: value.usesSubscription };
}

export class WhaleService {
  constructor(options = {}) {
    this.config = options.config || new ConfigStore(options);
    this.accounts = options.accounts || new AccountStore({ config: this.config });
    this.provider = options.provider || new BalanceProvider(options);
    this.ledger = new UsageLedger(this.config.dataDir);
    this.cache = new Map(); this.inFlight = new Map(); this.turns = new Map(); this.settling = new Set();
    this.balanceSequence = 0; this.latestSamples = new Map(); this.latestQueries = new Map();
    this.lastFile = path.join(this.config.dataDir, 'last-turn.json');
    this.usageSettingsFile = path.join(this.config.dataDir, 'usage-settings.json');
    this.subscriptionRateLimitsFile = path.join(this.config.dataDir, 'subscription-rate-limits.json');
    this.subscriptionRateLimitsCache = codexSnapshot(readJson(this.subscriptionRateLimitsFile, null));
    this.subscriptionRateLimitContextFile = path.join(this.config.dataDir, 'subscription-rate-limit-context.json');
    this.subscriptionRateLimitContext = safeSubscriptionRateLimitContext(readJson(this.subscriptionRateLimitContextFile, null));
    this.activeScope = null; this.displaySourceId = '';
    this.journal = new TurnJournal(this.config.dataDir);
    this.jobs = new Set(); this.noticeTimers = new Map(); this.latestStarts = new Map(); this.pendingCosts = new Map();
    this.noticeDelayMs = options.noticeDelayMs ?? 2500; this.pendingCostMs = options.pendingCostMs ?? 30000;
    this.closed = false; this.restored = false; this.recoveryActive = new Set();
    this.recoveryError = '';
    // Told when a Codex turn ends, with the account it ran on; the quota book listens.
    this.onTurnEnd = options.onTurnEnd || (() => {});
    // Whether the pet used an account during a turn, so a shared bill says so.
    this.petUsedDuring = options.petUsedDuring || (() => false);
  }
  scope(c, currency) { return c.accountId + '-' + currency; }
  balanceIdentity(c) {
    const s = c.setting || {};
    // Prices and UI preferences do not change the API meter. Its adapter and
    // conversion settings do; never compare readings expressed on two scales.
    return JSON.stringify([c.accountId, s.provider, s.currency, s.balancePath, s.balanceField,
      s.usedField, s.balanceScale, s.billingUsageDivisor, s.quotaPerUnit]);
  }
  displayContext() {
    let sourceId = this.displaySourceId;
    if (!sourceId) {
      try { sourceId = this.lastTurn().sourceId || ''; } catch {}
    }
    if (sourceId && sourceId !== 'default') {
      try {
        const context = this.accounts.contextFor(sourceId);
        if (context) return context;
      } catch {}
    }
    return this.config.resolve();
  }
  // The account a Codex session ran on, by its provider name (a log without
  // one ran on the default provider); a session on no account, such as one on
  // the ChatGPT subscription, uses the default config.
  resolveForSession(meta = {}) {
    let provider = typeof meta.modelProvider === 'string' ? meta.modelProvider : '';
    if (!provider) { try { provider = this.config.resolve().sessionProvider; } catch {} }
    return this.accounts.sessionContext(provider) || this.config.resolve();
  }
  isDisplayBalanceContext(c) {
    try { return this.balanceIdentity(c) === this.balanceIdentity(this.displayContext()); }
    catch { return false; }
  }
  newestBalanceSample(c, currency) {
    const query = this.latestQueries.get(this.balanceIdentity(c));
    const scoped = this.latestSamples.get(this.scope(c, currency));
    return !scoped || query && query.sequence > scoped.sequence ? query : scoped;
  }
  balanceCache(c, cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;
    const latest = this.newestBalanceSample(c, cached.payload.currency);
    if (!latest || latest.sequence <= (cached.sequence || 0)) return cached;
    return latest.identity === this.balanceIdentity(c) ? latest : null;
  }
  stoppedBalance() { return { ok: false, code: 'STOPPED', error: '挂件正在退出，余额将在下次启动时刷新' }; }
  updateSubscriptionRateLimits(snapshot) {
    const next = codexSnapshot(snapshot);
    if (!next) return false;
    const previous = this.subscriptionRateLimitsCache;
    if (previous && next.observedAt < previous.observedAt) return false;
    this.subscriptionRateLimitsCache = next;
    try { writeJson(this.subscriptionRateLimitsFile, next); } catch {}
    return true;
  }
  updateSubscriptionRateLimitContext(context) {
    const next = safeSubscriptionRateLimitContext(context);
    if (!next) return false;
    const previous = this.subscriptionRateLimitContext;
    if (previous && next.observedAt < previous.observedAt) return false;
    this.subscriptionRateLimitContext = next;
    try { writeJson(this.subscriptionRateLimitContextFile, next); } catch {}
    return true;
  }
  // The subscription quota while Codex last ran on the subscription. A window
  // that has reset is no longer shown; the next Codex token event refreshes it.
  subscriptionRateLimits() {
    const snapshot = codexSnapshot(this.subscriptionRateLimitsCache);
    const context = safeSubscriptionRateLimitContext(this.subscriptionRateLimitContext);
    const shown = snapshot && context?.usesSubscription && context.observedAt >= snapshot.observedAt ? publicCodexSnapshot(snapshot) : null;
    return shown ? { ok: true, available: true, source: snapshot.source, ...shown } : { ok: true, available: false };
  }
  async getBalance({ force = false, context = null } = {}) {
    if (this.closed) return this.stoppedBalance();
    let c;
    try { c = context || this.displayContext(); }
    catch (error) { return { ok: false, code: 'CONFIG', error: error.message }; }
    const cacheKey = c.accountId + ':' + JSON.stringify(c.setting);
    const identity = this.balanceIdentity(c), cached = this.balanceCache(c, cacheKey);
    // Each caller checks its own context, even when it joins a round's request.
    // A UI request made before an account/currency switch returns current data.
    const deliver = value => {
      if (this.closed) return this.stoppedBalance();
      if (!context) {
        if (!this.isDisplayBalanceContext(c)) return this.getBalance();
        if (value.superseded) {
          const latest = this.newestBalanceSample(c, value.currency);
          return latest?.identity === identity ? this.decorate(c, latest.payload) : this.getBalance({ force: true });
        }
      }
      return value;
    };
    if (!force && cached && Date.now() - cached.at < Math.min(c.setting.refreshSeconds, 25) * 1000) return deliver(this.decorate(c, cached.payload));
    if (this.inFlight.has(cacheKey)) return deliver(await this.inFlight.get(cacheKey));
    const sequence = ++this.balanceSequence;
    const request = (async () => {
      try {
        const payload = await this.provider.balance(c);
        if (this.closed) return this.stoppedBalance();
        const scope = this.scope(c, payload.currency);
        const latest = this.newestBalanceSample(c, payload.currency);
        if (latest && (sequence < latest.sequence || latest.identity !== identity && !this.isDisplayBalanceContext(c))) {
          // Keep the actual request's sample for a round's interval; replacing
          // its end with a newer sample could include another task's debit.
          // UI callers receive the latest compatible sample in deliver().
          return { ...this.decorate(c, payload, { activate: false }), superseded: true,
            ...(latest.identity !== identity ? { stale: true } : {}) };
        }
        const meterKey = createHash('sha256').update(identity).digest('hex');
        this.ledger.observe(scope, { ...payload, meterKey });
        const sample = { at: Date.now(), sequence, identity, payload };
        this.latestSamples.set(scope, sample);
        this.latestQueries.set(identity, sample);
        this.cache.set(cacheKey, sample);
        return this.decorate(c, payload);
      } catch (error) {
        if (this.closed) return this.stoppedBalance();
        const fallback = this.balanceCache(c, cacheKey);
        if (error.transient && fallback) return { ...this.decorate(c, fallback.payload), stale: true, error: error.message };
        return { ok: false, code: error.code || 'ERROR', error: error.code ? error.message : '余额服务暂时不可用', providerName: c.providerName, dashboardUrl: c.dashboardUrl, baseUrl: c.baseUrl, todayUsage: this.ledger.records(this.scope(c, c.setting.currency)).today.total, currency: c.setting.currency, usageMode: 'ledger' };
      } finally { this.inFlight.delete(cacheKey); }
    })();
    this.inFlight.set(cacheKey, request);
    return deliver(await request);
  }
  decorate(c, payload, { activate = true } = {}) {
    const scope = this.scope(c, payload.currency);
    const records = this.ledger.records(scope);
    if (activate && this.isDisplayBalanceContext(c)) this.activeScope = scope;
    const sourceDailyUsage = Number.isFinite(payload.sourceDailyUsage) ? payload.sourceDailyUsage : null;
    return { ...payload, balanceFull: records.fullBalance, todayUsage: sourceDailyUsage === null ? records.today.total : sourceDailyUsage,
      todayUsageSource: sourceDailyUsage === null ? 'ledger' : 'source-api', observedSince: records.today.since,
      usageMode: sourceDailyUsage === null ? 'ledger' : 'source-api', usageNote: records.note };
  }
  readUsageSettings() {
    const saved = readJson(this.usageSettingsFile, {});
    const defaults = usageDefaults();
    for (const key of Object.keys(defaults)) defaults[key] = { ...defaults[key], ...saved[key] };
    // Quota reminders replaced the old balance warning and daily budget, which carry over.
    let currency = 'USD';
    try { currency = this.config.load().currency; } catch {}
    try { defaults.quotaAlerts = saved.quotaAlerts ? cleanAlertSettings(saved.quotaAlerts) : saved.alert || saved.budget ? legacyAlertSettings(saved, currency) : cleanAlertSettings(); }
    catch { defaults.quotaAlerts = cleanAlertSettings(); }
    return defaults;
  }
  writeUsageSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('用量设置格式无效');
    const result = this.readUsageSettings();
    for (const key of Object.keys(result)) if (patch[key] && typeof patch[key] === 'object') result[key] = { ...result[key], ...patch[key] };
    for (const [key, field] of [['alert', 'below'], ['budget', 'amount']]) if (!Number.isFinite(Number(result[key][field])) || Number(result[key][field]) < 0) throw new Error('提醒阈值须为非负数字');
    if (patch.quotaAlerts) result.quotaAlerts = cleanAlertSettings({ ...result.quotaAlerts, ...patch.quotaAlerts });
    writeJson(this.usageSettingsFile, result);
    return { ok: true, settings: result };
  }
  lastTurn() {
    return readJson(this.lastFile, { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null });
  }
  beginTurn(meta) {
    if (this.closed || this.settling.has(meta.id)) return;
    if (this.turns.has(meta.id)) { this.updateTurn(meta); return; }
    let context;
    try { context = this.resolveForSession(meta); } catch { return; }
    if (!meta.isSubagent) {
      this.displaySourceId = context.sourceId || 'default';
      const session = meta.sessionId || meta.id;
      this.latestStarts.set(session, meta.id);
      const waiting = this.noticeTimers.get(session);
      if (waiting) { clearTimeout(waiting.timer); this.noticeTimers.delete(session); }
    }
    const roots = [...this.turns.values()].filter(active => !active.isSubagent);
    const entry = { ...safeTurn(meta), context, canQuery: true, concurrent: !meta.isSubagent && roots.length > 0 };
    if (!meta.isSubagent) for (const active of roots) active.concurrent = true;
    // Subagents contribute tokens, not overlapping API-balance intervals.
    entry.start = meta.isSubagent ? null : this.getBalance({ force: true, context });
    this.turns.set(meta.id, entry);
    this.persistTurn(entry, 'active');
    if (entry.start) entry.start.then(sample => {
      if (this.closed) return;
      entry.startSample = safeSample(sample);
      if (this.turns.get(meta.id) === entry) this.persistTurn(entry, 'active');
    }).catch(() => {});
  }
  updateTurn(meta) {
    const turn = this.turns.get(meta.id);
    if (!turn) return;
    turn.byModel = safeUsage(meta.byModel || turn.byModel);
    if (meta.rootTurnId) turn.rootTurnId = meta.rootTurnId;
    if (meta.ts) turn.ts = meta.ts;
    if (codexSnapshot(meta.subscriptionRateLimits)) turn.subscriptionRateLimits = meta.subscriptionRateLimits;
    this.persistTurn(turn, 'active');
  }
  persistTurn(turn, stage, meta = turn, extra = {}) {
    if (this.closed) return;
    this.journal.put({ stage, accountId: turn.context.accountId, currency: turn.context.setting.currency,
      sourceId: turn.context.sourceId || 'default', sourceName: turn.context.sourceName || '当前 API',
      pricing: turn.context.setting.models, meta: { ...meta, partial: !!turn.partial }, start: turn.startSample,
      concurrent: !!turn.concurrent, ...extra });
  }
  prepareRecovery() {
    if (this.restored) return [...this.recoveryActive];
    this.restored = true;
    let current;
    try { current = this.config.resolve(); } catch {}
    const waiting = [];
    for (const saved of this.journal.list()) {
      let source;
      try {
        source = saved.sourceId && saved.sourceId !== 'default' ? this.accounts.contextFor(saved.sourceId) : current;
      } catch {}
      const matches = source?.accountId === saved.accountId && source.setting.currency === saved.currency;
      const context = matches ? { ...source, setting: { ...source.setting, models: saved.pricing } } :
        { accountId: saved.accountId, model: '', setting: { currency: saved.currency, models: saved.pricing } };
      const turn = { ...saved.meta, context, canQuery: matches, startSample: saved.start,
        start: Promise.resolve(saved.start || { ok: false }), concurrent: saved.concurrent };
      if (saved.stage === 'pending-cost') {
        // A restart cannot turn a later shared-key debit into an exact old bill.
        try { if (saved.scope) this.markCostUnknown(saved.scope, saved.meta.id); this.journal.remove(saved.meta.id); }
        catch { this.recoveryError = '一条待核对记录暂不可读；已保留恢复记录，其余功能仍可使用。'; }
        continue;
      }
      this.turns.set(saved.meta.id, turn);
      if (!saved.meta.isSubagent && matches) this.displaySourceId = context.sourceId || 'default';
      if (saved.stage === 'settling') waiting.push(saved.meta);
      else this.recoveryActive.add(saved.meta.id);
    }
    for (const meta of waiting) this.finishTurn({ ...meta, historical: true, notify: false, statusNotify: false }).catch(() => {});
    return [...this.recoveryActive];
  }
  finishMissingRecovery(seenIds = []) {
    const seen = new Set(seenIds);
    for (const id of this.recoveryActive) {
      const turn = this.turns.get(id);
      if (!seen.has(id) && turn) this.finishTurn({ ...safeTurn(turn), outcome: 'interrupted', historical: true,
        notify: false, statusNotify: false, ts: turn.ts || Date.now() }).catch(() => {});
    }
    this.recoveryActive.clear();
  }
  finishTurn(meta) {
    if (this.closed) return Promise.resolve();
    const turn = this.turns.get(meta.id);
    if (!turn) return Promise.resolve();
    this.turns.delete(meta.id);
    this.settling.add(meta.id);
    this.persistTurn(turn, 'settling', meta);
    const job = this.settleTurn(meta, turn).finally(() => { this.settling.delete(meta.id); this.jobs.delete(job); });
    this.jobs.add(job); return job;
  }
  async settleTurn(meta, turn) {
    const context = turn.context;
    const outcome = meta.outcome || 'completed';
    const ownUsage = safeUsage(meta.byModel || turn.byModel);
    const subscriptionRateLimits = publicCodexSnapshot(meta.subscriptionRateLimits);
    const base = { id: meta.id, sessionId: meta.sessionId || turn.sessionId, turnId: meta.turnId,
      rootTurnId: meta.rootTurnId || turn.rootTurnId || meta.turnId, ts: meta.ts || Date.now(), outcome,
      partial: !!turn.partial, historical: !!meta.historical, accountId: context.accountId,
      sourceId: context.sourceId || 'default', sourceName: context.sourceName || '当前 API',
      ...(subscriptionRateLimits ? { subscriptionRateLimits } : {}) };
    if (turn.isSubagent || meta.isSubagent) {
      const estimate = !turn.partial ? estimateUsage(ownUsage, context.setting, base.ts) : null;
      const scope = this.scope(context, context.setting.currency);
      this.ledger.append(scope, { ...base, isSubagent: true, byModel: ownUsage,
        model: (Object.keys(ownUsage).join(' + ') || context.model || '未知模型') + ' · 子任务用量',
        cost: estimate, costState: estimate === null ? 'unknown' : 'estimated', tokens: tokenTotal(ownUsage),
        source: estimate === null ? 'subagent-token-only' : 'subagent-pricing-estimate' });
      this.reviseRootEstimate(scope, base.rootTurnId);
      this.journal.remove(meta.id);
      return;
    }
    // The end of a turn is activity on the account it ran on, known before its cost.
    if (!meta.historical) {
      try { this.onTurnEnd({ ts: base.ts, subscription: !!codexSnapshot(meta.subscriptionRateLimits), context }); } catch {}
    }
    const start = await turn.start || { ok: false };
    if (this.closed) return;
    turn.startSample = safeSample(start); this.persistTurn(turn, 'settling', meta);
    const end = turn.canQuery === false ? { ok: false } : await this.getBalance({ force: true, context });
    if (this.closed) return;
    let amount = null, source = 'token-only', costState = 'unknown', note = '没有可用的起止余额或模型价格，金额未知。';
    let currency = end.currency || start.currency || context.setting.currency;
    const children = this.ledger.load(this.scope(context, context.setting.currency)).events.filter(e => e.isSubagent && e.rootTurnId === base.rootTurnId);
    const combined = mergeUsage([ownUsage, ...children.map(e => e.byModel || {})]);
    const estimate = estimateUsage(combined, context.setting, meta.ts || Date.now());
    if (estimate !== null && !turn.partial && !children.some(e => e.partial)) {
      amount = estimate; currency = context.setting.currency; source = 'configured-pricing-estimate'; costState = 'estimated';
      note = '根据 Codex 记录的 token 数量与手动配置价格估算，包含本主轮已记录的子任务用量；服务商折扣、缓存策略和账单延迟可能造成差异。';
    } else if (!meta.historical && outcome !== 'interrupted' && start.ok && end.ok && !start.stale && !end.stale && start.accountId === end.accountId && start.currency === end.currency) {
      if (typeof start.totalUsed === 'number' && typeof end.totalUsed === 'number' && end.totalUsed >= start.totalUsed) amount = rounded(end.totalUsed - start.totalUsed);
      else if (start.totalUsed == null && end.totalUsed == null && typeof start.totalBalance === 'number' && typeof end.totalBalance === 'number' && end.totalBalance <= start.totalBalance) amount = rounded(start.totalBalance - end.totalBalance);
      if (amount !== null) {
        source = 'shared-key-interval'; costState = amount > 0 ? 'observed' : 'pending';
        if (costState === 'pending') amount = null;
        note = costState === 'pending' ? '结束采样尚未出现可归属扣费，可能尚未入账或本次未计费；稍后的同密钥扣费不会直接归入本轮。' :
          '这是本轮运行期间同一 API 密钥的已观测合计扣费，可能含其他任务或设备的调用；并非逐请求最终账单。';
        note += (turn.partial ? ' 挂件在本轮开始后启动，仅覆盖启动后的时段。' : '') + (turn.concurrent ? ' 检测到同时运行的任务。' : '');
        let shared = false;
        try { shared = this.petUsedDuring(context, Date.parse(start.updatedAt), Date.parse(end.updatedAt)); } catch {}
        if (shared) note += ' 期间大肥鱼也用这个账户说过话，那部分扣费也在里面。';
      }
    }
    if (meta.historical && amount === null) note = '已恢复任务状态及可用 token 记录；任务结束时没有可靠余额采样，不能把停机期间其他扣费归入本轮。';
    const label = source === 'configured-pricing-estimate' ? '上一轮消耗（估算）:' : source === 'shared-key-interval' ? (turn.partial ? '本轮已观测期间扣费:' : '上一轮期间 API 扣费:') : '上一轮 token 用量:';
    const tokens = tokenTotal(combined);
    const completionKind = outcome === 'completed' ? 'success' : outcome === 'failed' ? 'failed' : outcome === 'aborted' ? 'cancelled' : null;
    const event = { ...base, ok: true, turn: meta.turnId || meta.id, amount, cost: amount, costState, tokens, currency, source, label, note,
      completionKind, notify: !meta.historical && !!completionKind && (outcome === 'completed' ? meta.notify !== false : meta.statusNotify === true),
      concurrent: !!turn.concurrent, childTurns: children.length, ownByModel: ownUsage, byModel: combined,
      pricing: context.setting.models };
    const scope = this.scope(context, currency);
    const models = Object.keys(combined).join(' + ') || context.model || '未知模型';
    const model = source === 'shared-key-interval' ? models + ' · 期间扣费（同密钥合计）' : source === 'token-only' ? models + ' · 仅 token 记录' : models;
    if (!this.ledger.append(scope, { ...event, model })) {
      // A crash can happen between appending a pending row and changing the
      // journal stage. Recovery must not leave that durable row pending forever.
      if (meta.historical) this.markCostUnknown(scope, meta.id);
      this.journal.remove(meta.id); return;
    }
    if (costState === 'pending') {
      const dueAt = Date.now() + this.pendingCostMs;
      this.persistTurn(turn, 'pending-cost', meta, { dueAt, scope });
      this.pendingCosts.set(meta.id, { scope, context, dueAt, rechecked: false }); this.scheduleCostCheck();
    } else this.journal.remove(meta.id);
    this.queueNotice(scope, event);
  }
  reviseRootEstimate(scope, rootTurnId) {
    const events = this.ledger.load(scope).events;
    const root = events.find(e => !e.isSubagent && e.turnId === rootTurnId && e.ownByModel);
    if (!root) return;
    const children = events.filter(e => e.isSubagent && e.rootTurnId === rootTurnId);
    const combined = mergeUsage([root.ownByModel, ...children.map(e => e.byModel || {})]);
    const patch = { tokens: tokenTotal(combined), byModel: combined, childTurns: children.length };
    if (root.pricing && ['configured-pricing-estimate', 'token-only'].includes(root.source)) {
      const complete = !root.partial && !children.some(e => e.partial);
      const estimate = complete ? estimateUsage(combined, { models: root.pricing }, root.ts) : null;
      if (estimate !== null && ['configured-pricing-estimate', 'token-only'].includes(root.source)) {
        Object.assign(patch, { cost: estimate, amount: estimate, costState: 'estimated', source: 'configured-pricing-estimate',
          model: Object.keys(combined).join(' + '), label: '上一轮消耗（估算）:',
          note: '根据完整已记录主子任务 token 和配置价格修订的估算；修订不会再次播放提示音。' });
      } else if (root.source === 'configured-pricing-estimate') {
        Object.assign(patch, { cost: null, amount: null, costState: 'unknown', source: 'token-only',
          model: Object.keys(combined).join(' + ') + ' · 仅 token 记录', label: '上一轮 token 用量:',
          note: '后来收到的子任务用量不完整或缺少模型价格，不能把原先局部估算当作整个主轮金额。' });
      }
    }
    this.reviseRecord(scope, root.id, patch);
  }
  reviseRecord(scope, id, patch) {
    const event = this.ledger.revise(scope, id, patch);
    if (!event) return;
    const last = readJson(this.lastFile, { seq: 0 });
    if (last.id === id) writeJson(this.lastFile, { ...last, ...event, seq: last.seq, amount: event.cost });
  }
  markCostUnknown(scope, id) {
    const event = this.ledger.find(scope, { id });
    if (event?.costState === 'pending') this.reviseRecord(scope, id, { cost: null, amount: null, costState: 'unknown',
      note: '暂无可验证的逐请求账单，无法确定本轮金额；余额及每日合计仍随服务商最新返回值更新。' });
  }
  scheduleCostCheck() {
    if (this.costTimer || this.closed || !this.pendingCosts.size) return;
    const soonest = Math.min(...[...this.pendingCosts.values()].map(item => item.rechecked ? item.dueAt : Math.min(item.dueAt, Date.now() + 1500)));
    this.costTimer = setTimeout(() => {
      this.costTimer = null;
      for (const [id, item] of this.pendingCosts) {
        try {
          if (!item.rechecked) { item.rechecked = true; this.getBalance({ force: true, context: item.context }).catch(() => {}); }
          if (Date.now() >= item.dueAt) {
            this.markCostUnknown(item.scope, id); this.pendingCosts.delete(id); this.journal.remove(id);
          }
        } catch {
          this.recoveryError = '一条待核对费用暂时无法更新，恢复记录已保留。';
          item.dueAt = Date.now() + 60000; item.rechecked = true;
        }
      }
      this.scheduleCostCheck();
    }, Math.max(1, soonest - Date.now())); this.costTimer.unref();
  }
  queueNotice(scope, event) {
    if (!event.notify || this.closed) return;
    if (event.completionKind === 'success') { this.publishNotice(scope, event.id); return; }
    const session = event.sessionId || event.id;
    if (this.latestStarts.get(session) && this.latestStarts.get(session) !== event.id) return;
    const old = this.noticeTimers.get(session); if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this.noticeTimers.delete(session);
      if (!this.closed && (!this.latestStarts.get(session) || this.latestStarts.get(session) === event.id)) {
        try { this.publishNotice(scope, event.id); }
        catch { this.recoveryError = '任务状态提示暂不可写；用量记录与恢复文件仍保留。'; }
      }
    }, this.noticeDelayMs); timer.unref();
    this.noticeTimers.set(session, { timer, id: event.id });
  }
  publishNotice(scope, id) {
    const event = this.ledger.find(scope, { id });
    if (!event || event.noticePublished || !event.notify || this.closed) return;
    const settings = this.readUsageSettings().outcomeNotice;
    if (event.completionKind === 'failed' && !settings.failed || event.completionKind === 'cancelled' && !settings.cancelled) return;
    const seq = Number(readJson(this.lastFile, { seq: 0 }).seq || 0) + 1;
    this.ledger.revise(scope, id, { noticePublished: true });
    writeJson(this.lastFile, { ...event, seq, amount: event.cost, notificationAt: Date.now() });
  }
  async close({ timeoutMs = 3000 } = {}) {
    this.closed = true; clearTimeout(this.costTimer); this.costTimer = null;
    for (const item of this.noticeTimers.values()) clearTimeout(item.timer);
    this.noticeTimers.clear();
    if (!this.jobs.size) return;
    let timer;
    await Promise.race([Promise.allSettled([...this.jobs]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
    // Unfinished settlements were journaled before their first network await.
  }
}

const tokenTotal = usage => Object.values(usage).reduce((n, u) => n + (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0), 0);
function mergeUsage(parts) {
  const result = {};
  for (const part of parts) for (const [model, counts] of Object.entries(part)) {
    const total = Object.hasOwn(result, model) ? result[model] : (result[model] = {});
    for (const [key, value] of Object.entries(counts)) total[key] = (total[key] || 0) + (Number(value) || 0);
  }
  return result;
}

export function estimateUsage(byModel, settings, ts) {
  if (!Object.keys(byModel).length) return null;
  let total = 0;
  for (const [model, u] of Object.entries(byModel)) {
    const p = Object.hasOwn(settings.models || {}, model) ? settings.models[model] : null;
    if (!p) return null;
    const cached = Math.min(u.input_tokens, u.cached_input_tokens);
    const write = Math.min(Math.max(0, u.input_tokens - cached), u.cache_write_input_tokens || 0);
    const miss = Math.max(0, u.input_tokens - cached - write);
    // Reasoning tokens are already a subset of output_tokens in Codex events.
    total += (miss * p.input + write * (p.cacheWrite ?? p.input) + cached * p.cachedInput + u.output_tokens * p.output) / 1e6;
  }
  return rounded(total);
}
