import path from 'node:path';
import { dayKey, readJson, writeJson } from '../paths.mjs';
import { claudeLastTurn, readClaudeSnapshot } from '../claude-usage.mjs';
import { WINDOW_MINUTES, codexSnapshot, storedWindow } from './windows.mjs';
import { balancePace, dailyAverage, limitPace, windowPace } from './pace.mjs';
import { cleanAlertSettings, evaluateAlerts } from './alerts.mjs';
import { apiRecords, subscriptionTurns } from './records.mjs';

const STATE_FILE = 'quota-state.json';
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const iso = at => Number.isFinite(at) ? new Date(at).toISOString() : null;
const KEY_PROBLEMS = { 'keychain-missing': '钥匙串里没有这个账户的密钥', 'keychain-unavailable': '钥匙串暂时不可用', 'key-unavailable': '缺少密钥' };


function readState(file) {
  let saved;
  try { saved = readJson(file, null); } catch { saved = null; }
  const activity = {};
  for (const [id, at] of Object.entries(saved?.activity || {})) if (ID.test(id) && Number.isFinite(at) && at > 0) activity[id] = at;
  const pin = ID.test(saved?.pin?.id || '') && Number.isFinite(saved.pin.at) ? { id: saved.pin.id, at: saved.pin.at } : null;
  const fired = Object.fromEntries(Object.keys(saved?.fired || {}).filter(key => typeof key === 'string' && key.length < 200).map(key => [key, true]));
  const alerts = (Array.isArray(saved?.alerts) ? saved.alerts : []).filter(alert => Number.isSafeInteger(alert?.seq) && Number.isFinite(alert.at) &&
    typeof alert.title === 'string' && typeof alert.text === 'string').slice(-10);
  return { activity, pin, seeded: saved?.seeded === true, fired, alerts, alertSeq: Number.isSafeInteger(saved?.alertSeq) ? saved.alertSeq : 0 };
}

// The full days before today, newest first, as ledger day keys.
function fullDays(now, count) {
  return Array.from({ length: count }, (_, index) => { const day = new Date(now); day.setDate(day.getDate() - index - 1); return dayKey(day); });
}

// A subscription's windows from its stored snapshot: each valid window with its
// share and pace, and a window that has reset marked as such.
function subscriptionWindows(snapshot, now) {
  const windows = [];
  for (const [key, id] of [['fiveHour', '5h'], ['sevenDay', '7d']]) {
    const window = storedWindow(snapshot?.[key], WINDOW_MINUTES[key]);
    if (!window) continue;
    if (window.resetsAt <= now) { windows.push({ id, label: id, reset: true }); continue; }
    windows.push({ id, label: id, usedPercent: window.usedPercent, remainingPercent: 100 - window.usedPercent,
      windowMinutes: window.windowMinutes, resetsAt: iso(window.resetsAt), pace: windowPace({ ...window, observedAt: snapshot.observedAt }) });
  }
  return windows;
}

// The money quotas an API returns, such as a key limit that resets weekly. An
// account's safe amount, when set, is what counts as full: at or above it the
// share left is 100%.
function limitWindows(result, safe) {
  const limits = (Array.isArray(result.rateLimits) ? result.rateLimits : []).filter(item => item.limit > 0 && item.remaining >= 0);
  return limits.map((item, index) => ({ id: 'limit-' + (index + 1), label: limits.length > 1 ? '额度 ' + (index + 1) : '额度',
    limit: item.limit, remaining: item.remaining, used: Math.max(0, item.limit - item.remaining), currency: result.currency,
    remainingPercent: Math.min(100, item.remaining / (safe || item.limit) * 100), safe: safe || null, resetsAt: item.resetsAt || null }));
}

// A balance is full at the safe amount when one is set, else at the key's
// total grant, else at the full balance.
function balanceOf(result, safe) {
  if (result.unlimited) return { unlimited: true, currency: result.currency };
  if (!Number.isFinite(result.totalBalance)) return null;
  return { amount: result.totalBalance, used: Number.isFinite(result.totalUsed) ? result.totalUsed : null, currency: result.currency,
    full: safe || (result.totalGranted > 0 ? result.totalGranted : result.balanceFull > 0 ? result.balanceFull : null), safe: safe || null };
}

const DASHBOARDS = { codex: 'https://chatgpt.com/codex/settings/usage', claude: 'https://claude.ai/settings/usage' };

// The quota book: every account the pet knows, the Codex and Claude
// subscriptions and the API accounts behind Codex providers and the pet, with
// what is left, how fast it goes and which account is in use now. The pet only
// renders what the book says. billing() is the pet's chat billing once chat
// runs; billing({ start: true }) starts chat for it.
export class QuotaBook {
  constructor({ whale, billing = () => null, now = Date.now }) {
    this.whale = whale; this.billing = billing; this.now = now;
    this.dataDir = whale.config.dataDir; this.file = path.join(this.dataDir, STATE_FILE);
    this.balances = new Map(); this.refreshing = null;
    Object.assign(this, readState(this.file));
  }
  save() {
    try { writeJson(this.file, { version: 1, activity: this.activity, pin: this.pin, seeded: this.seeded, fired: this.fired, alertSeq: this.alertSeq, alerts: this.alerts }); } catch {}
  }
  // Every visible API account with what uses it: Codex providers, and the pet.
  // One whose key cannot be read is listed apart, with the reason.
  apiAccounts() {
    const store = this.whale.accounts, data = store.load(), accounts = [], broken = [];
    for (const account of data.accounts) {
      if (account.hidden) continue;
      const context = store.context(account);
      const uses = [...account.codexProviders.map(name => 'codex:' + name), ...(account.id === data.petAccountId ? ['pet'] : [])];
      if (context.key) accounts.push({ id: account.id, context, name: account.name, uses, ledgers: [account.ledgerId, ...account.legacyIds], safeAmount: account.safeAmount });
      else broken.push({ id: account.id, name: account.name, host: new URL(account.endpoint).hostname, uses,
        error: KEY_PROBLEMS[context.keyStatus] || KEY_PROBLEMS['key-unavailable'] });
    }
    return { accounts, broken };
  }
  // Queries every API account once; the runtime does this every minute, so the
  // pet never has to ask.
  async refresh({ force = false } = {}) {
    if (this.refreshing) { await this.refreshing; if (!force) return; }
    const { accounts } = this.apiAccounts();
    this.refreshing = Promise.all(accounts.map(async account => {
      let result;
      try { result = await this.whale.getBalance({ context: account.context, force }); }
      catch { result = { ok: false, error: '额度查询失败' }; }
      this.balances.set(account.id, result);
    })).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  // Queries any account not queried yet, so a first read has something to show.
  async fill() {
    if (this.apiAccounts().accounts.some(account => !this.balances.has(account.id))) await this.refresh();
  }
  // Queries one account again now, as when you ask for it.
  async query(id) {
    const account = this.apiAccounts().accounts.find(item => item.id === id);
    if (account) this.balances.set(id, await this.whale.getBalance({ context: account.context, force: true }).catch(() => ({ ok: false, error: '额度查询失败' })));
    return this.snapshot().accounts.find(item => item.id === id) || null;
  }
  // The pet account's balance for chat billing, through the same query and
  // cache as every other account.
  async petBalance() {
    const pet = this.apiAccounts().accounts.find(account => account.uses.includes('pet'));
    if (!pet) throw new Error('大肥鱼账户没有可用的密钥');
    const result = await this.whale.getBalance({ context: pet.context, force: true });
    this.balances.set(pet.id, result);
    if (!result?.ok || !Number.isFinite(result.totalBalance)) throw new Error(result?.error || '余额查询失败');
    return { amount: result.totalBalance, currency: result.currency };
  }
  touch(id, at) {
    if (!ID.test(id) || !Number.isFinite(at) || at <= (this.activity[id] || 0) || at > this.now() + 60000) return;
    this.activity[id] = at; this.save();
  }
  // Codex finished a turn: on the subscription when its log carried quota
  // windows, otherwise on the API account it ran against.
  codexTurn({ ts, subscription, context }) {
    const account = !subscription && context?.key ? this.whale.accounts.account(context.sourceId) : null;
    if (subscription) this.touch('codex', ts);
    else if (account) this.touch(account.id, ts);
  }
  // You wrote to the pet, so its account is in use. The pet's own messages,
  // such as proactive chat, are not activity.
  petMessage(at = this.now()) {
    const pet = this.whale.accounts.load().petAccountId;
    if (pet) this.touch(pet, at);
  }
  // Activity the book reads rather than hears about: Claude replies, and on the
  // first run the latest Codex turn and Claude snapshot.
  observe(now, accounts) {
    const claude = claudeLastTurn(this.dataDir, now);
    if (claude.available) this.touch('claude', claude.completedAt);
    if (this.seeded) return;
    this.seeded = true;
    let last = null;
    try { last = this.whale.lastTurn(); } catch {}
    const at = Number(last?.notificationAt || last?.ts);
    const codexId = last?.subscriptionRateLimits ? 'codex' : accounts.find(account => account.context.accountId === last?.accountId)?.id;
    if (codexId && Number.isFinite(at)) this.touch(codexId, at);
    const snapshot = readClaudeSnapshot(this.dataDir, now);
    if (snapshot && !this.activity.claude) this.touch('claude', snapshot.observedAt);
    this.save();
  }
  subscriptionAccount(provider, snapshot, now) {
    const windows = snapshot ? subscriptionWindows(snapshot, now) : [];
    return { id: provider, type: 'subscription', provider, name: provider === 'codex' ? 'Codex' : 'Claude', plan: snapshot?.planType || '',
      uses: [provider], available: windows.some(window => !window.reset), windows, observedAt: iso(snapshot?.observedAt),
      lastActiveAt: iso(this.activity[provider]) };
  }
  // What an API account spent: today, the last seven days, and the daily
  // average of the last seven full days. The service's own daily record wins
  // over what the pet observed; for the pet's account its chat billing fills
  // the days the ledger never saw.
  spend(account, result, now) {
    const currency = result.currency;
    let records = null;
    try { records = this.whale.ledger.records(account.context.accountId + '-' + currency, now); } catch {}
    const observed = new Map((records?.all?.days || []).map(day => [day.date, day.total]));
    const reported = new Map((result.dailyUsage || []).map(day => [day.date, day.cost]));
    const total = date => reported.has(date) ? reported.get(date) : observed.has(date) ? observed.get(date) : null;
    let days = fullDays(now, 7).map(date => ({ date, total: total(date) }));
    let today = Number.isFinite(result.todayUsage) ? result.todayUsage : total(dayKey(now));
    let pet = null;
    if (account.uses.includes('pet') && days.every(day => day.total === null)) {
      try { pet = this.billing()?.dailySpend({ baseUrl: account.context.baseUrl, key: account.context.key, currency, days: 7, now }); } catch {}
      if (pet?.days.length) days = pet.days;
      if (today === null && pet) today = pet.today;
    }
    const average = dailyAverage(days), week = [today, ...days.slice(0, 6).map(day => day.total)].filter(Number.isFinite);
    return { currency, today, days7: week.length ? week.reduce((sum, value) => sum + value, 0) : null,
      average: average ? { ...average, currency } : null, estimated: !!pet?.days.length };
  }
  apiAccount(account, now) {
    const { context } = account, result = this.balances.get(account.id);
    const view = { id: account.id, type: 'api', provider: 'api', name: account.name, host: new URL(context.baseUrl).hostname, uses: account.uses,
      available: false, windows: [], balance: null, spend: null, pace: null, observedAt: null, stale: false, error: '',
      lastActiveAt: iso(this.activity[account.id]) };
    if (!result) return view;
    if (!result.ok) return { ...view, error: String(result.error || '额度查询失败').slice(0, 200) };
    const windows = limitWindows(result, account.safeAmount), balance = balanceOf(result, account.safeAmount), spend = this.spend(account, result, now);
    const primary = windows[0], average = spend.average;
    const pace = primary ? primary.resetsAt ? limitPace({ remaining: primary.remaining, resetsAt: primary.resetsAt, average, now }) : balancePace({ amount: primary.remaining, average }) :
      balance && !balance.unlimited ? balancePace({ amount: balance.amount, average }) : null;
    return { ...view, available: !!(windows.length || balance || spend.today !== null), windows, balance, spend,
      pace: pace && average ? { ...pace, average } : null, observedAt: result.updatedAt || null, stale: !!result.stale,
      error: result.stale ? String(result.error || '') : '' };
  }
  // Everything the pet shows about quota: each account, and the one in use.
  snapshot() {
    const now = this.now(), { accounts, broken } = this.apiAccounts();
    this.observe(now, accounts);
    const list = [this.subscriptionAccount('codex', codexSnapshot(this.whale.subscriptionRateLimitsCache), now),
      this.subscriptionAccount('claude', readClaudeSnapshot(this.dataDir, now), now),
      ...accounts.map(account => this.apiAccount(account, now)),
      ...broken.map(item => ({ id: item.id, type: 'api', provider: 'api', name: item.name, host: item.host || '', uses: item.uses, available: false,
        windows: [], balance: null, spend: null, pace: null, observedAt: null, stale: false, error: item.error, lastActiveAt: iso(this.activity[item.id]) }))];
    this.raise(list, now);
    return { ok: true, current: this.currentId(list), accounts: list, alerts: this.alerts };
  }
  // Raises the reminders that are new since the last look; the pet shows each once.
  raise(list, now) {
    let settings;
    try { settings = cleanAlertSettings(this.whale.readUsageSettings().quotaAlerts); } catch { settings = cleanAlertSettings(); }
    const { fired, raised } = evaluateAlerts({ accounts: list, settings, fired: this.fired, day: dayKey(now) });
    const changed = raised.length > 0 || JSON.stringify(fired) !== JSON.stringify(this.fired);
    this.fired = fired;
    for (const alert of raised) this.alerts.push({ seq: ++this.alertSeq, at: now, accountId: alert.accountId, title: alert.title, text: alert.text });
    this.alerts = this.alerts.slice(-10);
    if (changed) this.save();
  }
  // The 记录 page: for each account, what it spent by day and its latest uses.
  records() {
    const now = this.now(), snapshot = this.snapshot(), { accounts } = this.apiAccounts();
    return { ok: true, current: snapshot.current, accounts: snapshot.accounts.map(view => {
      if (view.id === 'codex') return { id: view.id, turns: subscriptionTurns({ dataDir: this.dataDir, ledger: this.whale.ledger }) };
      const account = accounts.find(item => item.id === view.id);
      if (!account) return { id: view.id };
      const result = this.balances.get(view.id), currency = result?.currency || account.context.setting.currency;
      let requests = [];
      if (account.uses.includes('pet')) {
        try { requests = this.billing({ start: true })?.requests({ baseUrl: account.context.baseUrl, key: account.context.key, currency }) || []; } catch {}
      }
      return { id: view.id, ...apiRecords({ account, ledger: this.whale.ledger, result, requests, now }) };
    }) };
  }
  // The account in use: the one with the latest activity, unless you chose
  // another since.
  currentId(list) {
    const ids = new Set(list.map(account => account.id));
    let latest = null;
    for (const [id, at] of Object.entries(this.activity)) if (ids.has(id) && (!latest || at > latest.at)) latest = { id, at };
    if (this.pin && ids.has(this.pin.id) && (!latest || this.pin.at >= latest.at)) return this.pin.id;
    return latest?.id || list.find(account => account.available)?.id || null;
  }
  // Where to see the current account's usage on its own site.
  dashboardUrl() {
    const snapshot = this.snapshot(), id = snapshot.current;
    if (DASHBOARDS[id]) return DASHBOARDS[id];
    const account = this.apiAccounts().accounts.find(item => item.id === id) || this.apiAccounts().accounts[0];
    return account?.context.dashboardUrl || '';
  }
  // Shows an account until a later activity moves the pet on. A choice carried
  // over from an older pet keeps the time it was made.
  select(id, at) {
    if (typeof id !== 'string' || !this.snapshot().accounts.some(account => account.id === id)) throw new Error('没有这个额度账户');
    this.pin = { id, at: Number.isFinite(at) && at > 0 && at <= this.now() ? at : this.now() }; this.save();
    return this.snapshot();
  }
}
