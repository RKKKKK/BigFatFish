import path from 'node:path';
import { dayKey, readJson, writeJson } from '../paths.mjs';
import { apiFingerprint as accountId } from '../quota/accounts.mjs';
import { billingUsage, estimateDeepSeek, officialDeepSeek } from './deepseek-pricing.mjs';

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class ChatBilling {
  // queryBalance({ baseUrl, key }) reads the account balance from the quota
  // book, where every balance is queried and cached; without it there is none.
  constructor({ dataDir, queryBalance = null, now = Date.now, balanceTtlMs = 60000 }) {
    this.file = path.join(dataDir, 'chat-billing.json'); this.now = now; this.balanceTtlMs = balanceTtlMs;
    this.queryBalance = queryBalance; this.balances = new Map();
    this.error = ''; this.readFailed = false;
    try {
      this.entries = readJson(this.file, { entries: [] }).entries;
      if (!Array.isArray(this.entries) || this.entries.some(row => !row || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.scope) || !Number.isFinite(row.timestamp))) throw new Error('invalid ledger');
      this.entries = this.entries.map(row => row.status === 'streaming' ? { ...row, status: 'interrupted' } : row);
    } catch { this.entries = []; this.readFailed = true; this.error = '本地会话计费记录不可读'; }
  }
  recoverHistory(turns, { baseUrl, key, settingsSavedAt }) {
    if (!officialDeepSeek(baseUrl) || !key || !Number.isFinite(settingsSavedAt)) return;
    const now = this.now();
    for (const turn of turns.flatMap(turn => Array.isArray(turn.requests) && turn.requests.length ? turn.requests : [turn])) {
      const timestamp = Date.parse(turn.createdAt);
      // Legacy history has no account identity. Only recover calls made after
      // the current credentials were saved, and never reassign an existing row.
      if (typeof turn.id !== 'string' || !Number.isFinite(timestamp) || timestamp < settingsSavedAt ||
          timestamp < now - WINDOW_MS || timestamp > now || this.entries.some(row => row.id === turn.id)) continue;
      this.record(turn, { baseUrl, key });
    }
  }
  record(turn, { baseUrl, key }) {
    if (!officialDeepSeek(baseUrl) || !key) return;
    const scope = accountId(baseUrl, key), timestamp = Date.parse(turn.createdAt);
    if (!Number.isFinite(timestamp)) return;
    const usage = billingUsage(turn.usage);
    const entry = { id: turn.id, scope, timestamp, model: turn.model, status: turn.status,
      usage, estimate: estimateDeepSeek(turn.model, usage, timestamp) };
    const index = this.entries.findIndex(row => row.id === entry.id && row.scope === scope);
    if (index < 0) this.entries.push(entry); else this.entries[index] = entry;
    this.entries = this.entries.filter(row => row.timestamp >= this.now() - WINDOW_MS);
    if (turn.status !== 'streaming') {
      const cached = this.balances.get(scope);
      if (cached) { cached.expiresAt = 0; cached.version++; }
    }
    if (this.readFailed) return;
    try { writeJson(this.file, { version: 1, entries: this.entries }); this.error = ''; }
    catch { this.error = '本地会话计费记录保存失败'; }
  }
  async balance(scope, credentials, force) {
    let cache = this.balances.get(scope);
    if (!cache) {
      cache = { value: null, error: '', expiresAt: 0, job: null, version: 0, queriedVersion: 0 }; this.balances.set(scope, cache);
      if (this.balances.size > 16) this.balances.delete(this.balances.keys().next().value);
    }
    if (cache.job) {
      await cache.job;
      return cache.version === cache.queriedVersion ? cache : this.balance(scope, credentials, false);
    } else if (!force && cache.expiresAt > this.now()) return cache;
    const version = cache.version;
    cache.job = (async () => {
      try {
        if (!this.queryBalance) throw new Error('no balance source');
        const result = await this.queryBalance(credentials);
        if (!['CNY', 'USD'].includes(result.currency) || !Number.isFinite(result.amount)) throw new Error('invalid balance');
        cache.value = { amount: result.amount, currency: result.currency, updatedAt: new Date(this.now()).toISOString() };
        cache.error = '';
      } catch { cache.error = '余额查询失败，请稍后刷新'; }
      cache.queriedVersion = version;
      cache.expiresAt = cache.version === version ? this.now() + this.balanceTtlMs : 0;
    })().finally(() => { cache.job = null; });
    await cache.job;
    return cache.version === cache.queriedVersion ? cache : this.balance(scope, credentials, false);
  }
  async summary({ baseUrl, key, force = false }) {
    const supported = officialDeepSeek(baseUrl);
    const empty = { supported, configured: !!key, days: 30, currency: 'CNY', min: 0, max: 0, recorded: 0, pending: 0, unknown: 0, complete: !this.error,
      ledgerError: this.error, balance: null, balanceStale: false, balanceError: '' };
    if (!supported || !key) return { ...empty, complete: false, balanceError: supported ? '尚未配置会话密钥' : '此会话网站暂不支持余额查询' };
    const scope = accountId(baseUrl, key), cache = await this.balance(scope, { baseUrl, key }, force);
    const currency = cache.value?.currency || 'CNY', now = this.now();
    const rows = this.entries.filter(row => row.scope === scope && row.timestamp >= now - WINDOW_MS && row.timestamp <= now);
    let min = 0, max = 0, recorded = 0, pending = 0, unknown = 0;
    for (const row of rows) {
      const amount = row.estimate?.amounts?.[currency];
      if (row.status === 'streaming') pending++;
      else if (amount && Number.isFinite(amount.min) && Number.isFinite(amount.max) && amount.min >= 0 && amount.max >= amount.min) {
        min += amount.min; max += amount.max; recorded++;
      } else unknown++;
    }
    return { supported, configured: true, days: 30, currency, min, max, recorded, pending, unknown, complete: !this.error && !pending && !unknown,
      ledgerError: this.error, balance: cache.value, balanceStale: !!cache.error, balanceError: cache.error };
  }
  // The estimated spend of one account per day, from the midpoint of each
  // request's estimate: today, and the full days before it, newest first. Days
  // before its first recorded request are unknown, so they are left out.
  dailySpend({ baseUrl, key, currency, days = 7, now = this.now() }) {
    if (!officialDeepSeek(baseUrl) || !key) return { today: null, days: [] };
    const scope = accountId(baseUrl, key), totals = new Map();
    const rows = this.entries.filter(row => row.scope === scope && row.timestamp <= now);
    if (!rows.length) return { today: null, days: [] };
    for (const row of rows) {
      const amount = row.estimate?.amounts?.[currency];
      if (!amount || !Number.isFinite(amount.min) || !Number.isFinite(amount.max)) continue;
      const date = dayKey(row.timestamp);
      totals.set(date, (totals.get(date) || 0) + (amount.min + amount.max) / 2);
    }
    const first = dayKey(Math.min(...rows.map(row => row.timestamp))), result = [];
    for (let index = 1; index <= days; index++) {
      const day = new Date(now); day.setDate(day.getDate() - index);
      const date = dayKey(day);
      if (date < first) break;
      result.push({ date, total: totals.get(date) || 0 });
    }
    return { today: totals.get(dayKey(now)) || 0, days: result };
  }
  // The pet's requests on one account, newest first, each with its estimated
  // amount in the account's currency; one still streaming is pending.
  requests({ baseUrl, key, currency }) {
    if (!officialDeepSeek(baseUrl) || !key) return [];
    const scope = accountId(baseUrl, key);
    return this.entries.filter(row => row.scope === scope).map(row => {
      const amount = row.estimate?.amounts?.[currency];
      const known = row.status !== 'streaming' && amount && Number.isFinite(amount.min) && Number.isFinite(amount.max);
      const tokens = Number(row.usage?.total_tokens ?? (Number(row.usage?.prompt_tokens) || 0) + (Number(row.usage?.completion_tokens) || 0));
      return { at: row.timestamp, model: row.model || '未知模型', tokens: Number.isFinite(tokens) && row.usage ? tokens : null, amount: known ? (amount.min + amount.max) / 2 : null,
        currency, state: row.status === 'streaming' ? 'pending' : known ? 'estimated' : 'unknown', outcome: row.status || 'completed' };
    }).sort((a, b) => b.at - a.at);
  }
  // Whether the pet used an account between two moments, as during a Codex turn.
  usedBetween({ baseUrl, key }, from, to) {
    if (!officialDeepSeek(baseUrl) || !key || !(from <= to)) return false;
    const scope = accountId(baseUrl, key);
    return this.entries.some(row => row.scope === scope && row.timestamp >= from && row.timestamp <= to);
  }
}
