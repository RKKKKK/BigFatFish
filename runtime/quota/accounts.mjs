import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '../../vendor/smol-toml/dist/index.js';
import { ConfigStore, DEFAULT_CONFIG, cleanUrl, sourceHeaders } from '../config.mjs';
import { readJson, writeJson } from '../paths.mjs';
import { officialDeepSeek } from '../chat/deepseek-pricing.mjs';

// The API accounts the pet knows, kept in one file: an endpoint and a key,
// what uses them (Codex providers, the pet), how to read their balance, and
// their prices. Keys never enter the file; the macOS keychain holds them, or
// Codex's own configuration does.
const FILE = 'quota-accounts.json';
const CHAT_KEY_REF = 'whale_chat_api_key_v1';
const ID = /^[a-z][a-z0-9-]{0,40}$/;
const LEDGER = /^[a-f0-9]{24}$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,63}$/;
const KEY_REF = /^[A-Za-z0-9_-]{8,128}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHODS = ['auto', 'billing', 'newapi', 'custom-json', 'deepseek', 'source-usage'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const text = (value, max) => String(value ?? '').trim().replace(/[\r\n]/g, '').slice(0, max);
const origin = url => new URL(url).origin;

// One API account per endpoint origin and key. Chat billing keys its records
// the same way, so both always agree on which account a request used.
export const apiFingerprint = (baseUrl, key) => sha(origin(baseUrl) + '\0' + key);
const keyId = (endpoint, key) => 'api-' + apiFingerprint(endpoint, key).slice(0, 12);

function secret(value) {
  const key = String(value || '').trim().replace(/^Bearer\s+/i, '');
  if (!key || key.length > 16384 || /[\x00-\x20]/.test(key)) throw new Error('API 密钥格式无效');
  return key;
}
function cleanKey(value) {
  if (value?.mode === 'keychain' && KEY_REF.test(value.ref || '')) return { mode: 'keychain', ref: value.ref };
  if (value?.mode === 'environment' && ENV.test(value.env || '')) return { mode: 'environment', env: value.env };
  if (value?.mode === 'codex') return { mode: 'codex' };
  return { mode: 'none' };
}
function cleanBalance(value, endpoint) {
  value = value && typeof value === 'object' ? value : {};
  const number = (input, fallback, min, max, label) => {
    if (input === undefined || input === null || input === '') return fallback;
    const result = Number(input);
    if (!Number.isFinite(result) || result < min || result > max) throw new Error(label + '超出有效范围');
    return result;
  };
  const field = (input, fallback) => {
    const result = input === undefined ? fallback : String(input || '');
    if (result && (!/^[A-Za-z0-9_.]+$/.test(result) || result.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part)))) throw new Error('字段路径仅支持字母、数字、下划线和点');
    return result;
  };
  const method = METHODS.includes(value.method) ? value.method : 'auto';
  const queryUrl = value.queryUrl ? cleanUrl(String(value.queryUrl)) : '';
  if (queryUrl && origin(queryUrl) !== origin(endpoint)) throw new Error('查询链接必须与 API 地址同源，不能把密钥发到其他域名');
  if (method === 'source-usage' && !queryUrl) throw new Error('按查询链接读取时请填写查询链接');
  const balancePath = String(value.balancePath || '');
  if (balancePath && (!balancePath.startsWith('/') || balancePath.startsWith('//') || /[\\#\r\n]/.test(balancePath))) throw new Error('余额路径须为 API 域名下的绝对路径');
  return { method, queryUrl, balancePath, balanceField: field(value.balanceField, DEFAULT_CONFIG.balanceField), usedField: field(value.usedField, ''),
    balanceScale: number(value.balanceScale, 1, 1e-9, 1e12, '余额系数'),
    billingUsageDivisor: number(value.billingUsageDivisor, DEFAULT_CONFIG.billingUsageDivisor, 1e-6, 1e12, '用量单位换算'),
    quotaPerUnit: number(value.quotaPerUnit, DEFAULT_CONFIG.quotaPerUnit, 1e-6, 1e12, '额度单位换算') };
}
function cleanPrices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型价格格式无效');
  const prices = {};
  for (const [model, entry] of Object.entries(value).slice(0, 50)) {
    if (!model || model.length > 150 || ['__proto__', 'constructor', 'prototype'].includes(model)) throw new Error('模型名称无效');
    const price = (input, label) => {
      const result = Number(input);
      if (input === '' || input === null || !Number.isFinite(result) || result < 0 || result > 1e9) throw new Error(model + ' 的' + label + '无效');
      return result;
    };
    prices[model] = { input: price(entry?.input, '输入价格'), cachedInput: price(entry?.cachedInput, '缓存命中价格'), output: price(entry?.output, '输出价格') };
    if (entry?.cacheWrite !== undefined && entry.cacheWrite !== '' && entry.cacheWrite !== null) prices[model].cacheWrite = price(entry.cacheWrite, '缓存写入价格');
  }
  return prices;
}
// What counts as a full bar for this account: at or above it, the balance or
// the quota left is full. Empty means the full balance or the quota's limit.
function cleanSafeAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new Error('安全额度须为大于 0 的金额');
  return amount;
}
function cleanAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !ID.test(value.id || '')) throw new Error('额度账户格式无效');
  const endpoint = cleanUrl(String(value.endpoint || ''));
  const currency = String(value.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('币种须使用 USD、CNY 等三位代码');
  const file = value.codexConfig?.file;
  const ledgerId = LEDGER.test(value.ledgerId || '') ? value.ledgerId : sha('account\0' + value.id).slice(0, 24);
  return { id: value.id, name: text(value.name, 40) || new URL(endpoint).hostname, endpoint, key: cleanKey(value.key),
    codexProviders: [...new Set((Array.isArray(value.codexProviders) ? value.codexProviders : []).map(item => text(item, 128)).filter(Boolean))].slice(0, 10),
    codexConfig: typeof file === 'string' && file && file.length <= 1024 && !/[\0\r\n]/.test(file) ? { file, provider: text(value.codexConfig.provider, 128) } : null,
    balance: cleanBalance(value.balance, endpoint), currency, prices: cleanPrices(value.prices || {}), safeAmount: cleanSafeAmount(value.safeAmount),
    dashboardUrl: value.dashboardUrl ? cleanUrl(String(value.dashboardUrl)) : '', hidden: value.hidden === true, ledgerId,
    legacyIds: [...new Set((Array.isArray(value.legacyIds) ? value.legacyIds : []).filter(id => LEDGER.test(id) && id !== ledgerId))].slice(0, 20),
    sourceIds: [...new Set((Array.isArray(value.sourceIds) ? value.sourceIds : []).filter(id => SOURCE.test(id)))].slice(0, 20),
    keySetAt: Number.isFinite(value.keySetAt) ? value.keySetAt : 0 };
}
// Every saved change is checked whole: unique accounts, and each Codex
// provider on at most one account so its sessions have one home.
function cleanData(value) {
  const accounts = (Array.isArray(value?.accounts) ? value.accounts : []).map(cleanAccount);
  if (accounts.length > 50) throw new Error('最多保存 50 个额度账户');
  const ids = new Set(), providers = new Map();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error('额度账户不能重复');
    ids.add(account.id);
    for (const provider of account.codexProviders) {
      if (providers.has(provider)) throw new Error('Codex 的「' + provider + '」只能属于一个账户，现在同时属于「' + providers.get(provider) + '」和「' + account.name + '」');
      providers.set(provider, account.name);
    }
  }
  return { version: 1, monitorSessions: value?.monitorSessions !== false, petAccountId: ids.has(value?.petAccountId) ? value.petAccountId : '', accounts };
}
function defaultDashboard(endpoint) {
  const host = new URL(endpoint).hostname;
  if (host === 'api.openai.com') return 'https://platform.openai.com/settings/organization/billing/overview';
  if (host === 'api.deepseek.com') return 'https://platform.deepseek.com/usage';
  return origin(endpoint);
}

export class AccountStore {
  constructor({ config, dataDir = config?.dataDir, codexHome = config?.codexHome, vault = config?.secretVault ?? null, env = config?.env ?? process.env, now = Date.now } = {}) {
    this.config = config || new ConfigStore({ dataDir, codexHome, env, secretVault: vault });
    this.dataDir = this.config.dataDir; this.codexHome = this.config.codexHome;
    this.vault = vault; this.env = env; this.now = now;
    this.file = path.join(this.dataDir, FILE);
    this.memoryKeys = new Map(); this.codexFiles = new Map(); this.cache = null; this.error = '';
  }
  // The saved accounts; on the first run, the ones the pet already used.
  load() {
    let stat = null;
    try { stat = fs.statSync(this.file); } catch {}
    if (!stat) {
      const data = this.migrate();
      try { return this.write(data); } catch { return data; }
    }
    const stamp = stat.mtimeMs + ':' + stat.size;
    if (this.cache?.stamp === stamp) return this.cache.data;
    let raw = null;
    try { raw = readJson(this.file, null); this.error = ''; } catch { this.error = '额度账户文件不可读，已保留原文件'; }
    const data = this.lenient(raw);
    this.cache = { stamp, data };
    return data;
  }
  // A damaged entry is skipped rather than costing every other account.
  lenient(raw) {
    const accounts = [], ids = new Set(), providers = new Set();
    for (const item of Array.isArray(raw?.accounts) ? raw.accounts.slice(0, 50) : []) {
      let account;
      try { account = cleanAccount(item); } catch { this.error = '有一条额度账户记录无效，已跳过'; continue; }
      if (ids.has(account.id)) continue;
      ids.add(account.id);
      account.codexProviders = account.codexProviders.filter(provider => !providers.has(provider) && providers.add(provider));
      accounts.push(account);
    }
    return { version: 1, monitorSessions: raw?.monitorSessions !== false, petAccountId: ids.has(raw?.petAccountId) ? raw.petAccountId : '', accounts };
  }
  write(data) {
    const clean = cleanData(data);
    writeJson(this.file, clean);
    let stat = null;
    try { stat = fs.statSync(this.file); } catch {}
    this.cache = stat ? { stamp: stat.mtimeMs + ':' + stat.size, data: clean } : null;
    return clean;
  }
  // The first run gathers what the pet already used: the default Codex
  // provider when it has an API key, each extra Codex config from the old API
  // settings, and the pet's own endpoint. Their ledgers keep their ids, and
  // the old settings files stay as they were.
  migrate() {
    const data = { version: 1, monitorSessions: true, petAccountId: '', accounts: [] };
    const add = value => {
      let account;
      try { account = cleanAccount(value); } catch { return null; }
      const existing = data.accounts.find(item => item.id === account.id);
      if (existing) return existing;
      account.codexProviders = account.codexProviders.filter(provider => !data.accounts.some(item => item.codexProviders.includes(provider)));
      data.accounts.push(account);
      return account;
    };
    let setting = null, primary = null;
    try { setting = this.config.load(); } catch {}
    try { primary = this.config.resolve(); } catch {}
    const balance = setting ? { method: setting.provider, balancePath: setting.balancePath, balanceField: setting.balanceField, usedField: setting.usedField,
      balanceScale: setting.balanceScale, billingUsageDivisor: setting.billingUsageDivisor, quotaPerUnit: setting.quotaPerUnit } : {};
    const shared = setting ? { currency: setting.currency, prices: setting.models, dashboardUrl: setting.dashboardUrl } : {};
    if (setting) data.monitorSessions = setting.monitorSessions !== false;
    if (primary?.key) add({ id: keyId(primary.baseUrl, primary.key), name: primary.providerName, endpoint: primary.baseUrl,
      key: setting?.keyEnv ? { mode: 'environment', env: setting.keyEnv } : { mode: 'codex' }, codexProviders: [primary.sessionProvider],
      codexConfig: { file: path.join(this.codexHome, 'config.toml'), provider: primary.id }, balance, ...shared, ledgerId: primary.accountId, keySetAt: this.now() });
    for (const source of setting?.sources || []) {
      let context;
      try { context = this.config.resolveConfiguredSource(source, setting); } catch { continue; }
      add({ id: context.key ? keyId(context.baseUrl, context.key) : 'src-' + source.id.replace(/_/g, '-').slice(0, 36), name: source.name, endpoint: context.baseUrl,
        key: source.keyMode === 'keychain' ? { mode: 'keychain', ref: source.keyRef } : { mode: 'environment', env: context.keyEnv },
        codexProviders: [context.sessionProvider], codexConfig: { file: source.configPath, provider: context.sessionProvider },
        balance: { ...balance, method: context.queryUrl ? 'source-usage' : balance.method, queryUrl: context.queryUrl }, ...shared,
        hidden: source.enabled === false, ledgerId: context.accountId, sourceIds: [source.id], keySetAt: this.now() });
    }
    const chatFile = path.join(this.dataDir, 'chat-settings.json');
    let chat = null;
    try { chat = readJson(chatFile, null); } catch {}
    let endpoint = null;
    try { endpoint = chat?.baseUrl ? cleanUrl(String(chat.baseUrl)) : null; } catch {}
    if (endpoint) {
      const ref = typeof chat.keyRef === 'string' ? chat.keyRef : CHAT_KEY_REF;
      let key = '';
      try { const entry = ref ? this.vault?.read?.(ref) : null; key = typeof entry?.value === 'string' ? entry.value.trim() : ''; } catch {}
      const deepseek = officialDeepSeek(endpoint);
      let savedAt = 0;
      try { savedAt = fs.statSync(chatFile).mtimeMs; } catch {}
      const account = add({ id: key ? keyId(endpoint, key) : 'api-' + sha('chat\0' + endpoint).slice(0, 12), name: deepseek ? 'DeepSeek' : new URL(endpoint).hostname,
        endpoint, key: ref ? { mode: 'keychain', ref } : { mode: 'none' }, balance: { method: deepseek ? 'deepseek' : 'auto' }, currency: deepseek ? 'CNY' : 'USD',
        ...(key ? { ledgerId: apiFingerprint(endpoint, key).slice(0, 24) } : {}), keySetAt: savedAt });
      if (account) data.petAccountId = account.id;
    }
    this.discoverInto(data);
    return data;
  }
  codexConfigFiles() {
    let entries = [];
    try { entries = fs.readdirSync(this.codexHome, { withFileTypes: true }); } catch {}
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.toml')).slice(0, 50).map(entry => path.join(this.codexHome, entry.name));
  }
  readCodexConfig(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const cached = this.codexFiles.get(file);
    if (cached?.stamp === stat.mtimeMs + ':' + stat.size) return cached.config;
    let config = null;
    try { config = parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.codexFiles.set(file, { stamp: stat.mtimeMs + ':' + stat.size, config });
    return config;
  }
  // Codex providers in the Codex folder's config files that no account covers
  // yet become accounts; one whose key cannot be read asks for it.
  discoverInto(data) {
    let added = false;
    for (const file of this.codexConfigFiles()) {
      const config = this.readCodexConfig(file);
      for (const [provider, definition] of Object.entries(config?.model_providers || {})) {
        if (!definition || typeof definition !== 'object' || typeof definition.base_url !== 'string') continue;
        if (data.accounts.some(account => account.codexProviders.includes(provider))) continue;
        let endpoint;
        try { endpoint = cleanUrl(definition.base_url); } catch { continue; }
        const draft = { name: text(definition.name, 40) || provider, endpoint, key: { mode: 'codex' }, codexProviders: [provider], codexConfig: { file, provider } };
        const { key } = this.readKey({ ...draft, id: '' });
        const id = key ? keyId(endpoint, key) : 'api-' + sha(file + '\0' + provider).slice(0, 12);
        const same = data.accounts.find(account => account.id === id);
        if (same) { same.codexProviders.push(provider); added = true; continue; }
        const deepseek = officialDeepSeek(endpoint);
        try {
          data.accounts.push(cleanAccount({ ...draft, id, balance: { method: deepseek ? 'deepseek' : 'auto' }, currency: deepseek ? 'CNY' : 'USD', keySetAt: this.now() }));
          added = true;
        } catch {}
      }
    }
    return added;
  }
  discover() {
    const data = structuredClone(this.load());
    if (this.discoverInto(data)) this.write(data);
  }
  // The Codex provider behind an account, read from its config file.
  codexInfo(account) {
    if (!account.codexConfig) return null;
    let file;
    try { file = this.config.configFilePath(account.codexConfig.file); } catch { return null; }
    const config = this.readCodexConfig(file);
    if (!config) return null;
    const definition = config.model_providers?.[account.codexConfig.provider];
    let headers = {};
    try { headers = sourceHeaders(definition?.http_headers); } catch {}
    return { definition: definition && typeof definition === 'object' ? definition : null, model: typeof config.model === 'string' ? config.model : '', headers };
  }
  // The account's key, from where it is kept, and why there is none.
  readKey(account) {
    const ready = (value, source) => {
      const key = String(value || '').trim().replace(/^Bearer\s+/i, '');
      return key && !/[\r\n]/.test(key) ? { key, status: 'ready', source } : { key: '', status: 'key-unavailable', source: 'none' };
    };
    if (account.id && this.memoryKeys.has(account.id)) return ready(this.memoryKeys.get(account.id), 'session');
    const mode = account.key.mode;
    if (mode === 'keychain') {
      try {
        const entry = this.vault?.read?.(account.key.ref);
        if (typeof entry?.value === 'string' && entry.value && entry.available !== false) return ready(entry.value, 'keychain');
        return { key: '', status: entry?.status || (this.vault ? 'keychain-missing' : 'keychain-unavailable'), source: 'none' };
      } catch { return { key: '', status: 'keychain-unavailable', source: 'none' }; }
    }
    if (mode === 'environment') return this.env[account.key.env] ? ready(this.env[account.key.env], 'environment') : { key: '', status: 'key-unavailable', source: 'none' };
    if (mode === 'codex') {
      const info = this.codexInfo(account), definition = info?.definition;
      if (definition?.env_key) return this.env[definition.env_key] ? ready(this.env[definition.env_key], 'environment') : { key: '', status: 'key-unavailable', source: 'none' };
      if (definition?.experimental_bearer_token) return ready(definition.experimental_bearer_token, 'codex-config');
      if (!definition && info && account.codexConfig.provider === 'openai') {
        if (this.env.OPENAI_API_KEY) return ready(this.env.OPENAI_API_KEY, 'environment');
        let auth = {};
        try { auth = readJson(path.join(this.codexHome, 'auth.json'), {}); } catch {}
        if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) return ready(auth.OPENAI_API_KEY, 'codex-config');
      }
    }
    return { key: '', status: 'key-unavailable', source: 'none' };
  }
  // The account as the balance queries and Codex turn accounting use it.
  context(account) {
    const { key, status, source } = this.readKey(account), info = this.codexInfo(account), balance = account.balance;
    const setting = { ...structuredClone(DEFAULT_CONFIG), provider: balance.method === 'source-usage' ? 'auto' : balance.method, currency: account.currency,
      balancePath: balance.balancePath, balanceField: balance.balanceField, usedField: balance.usedField, balanceScale: balance.balanceScale,
      billingUsageDivisor: balance.billingUsageDivisor, quotaPerUnit: balance.quotaPerUnit, models: account.prices, dashboardUrl: account.dashboardUrl,
      monitorSessions: this.load().monitorSessions };
    return { setting, id: account.codexProviders[0] || account.id, model: info?.model || '', profileName: '', providerName: account.name,
      baseUrl: account.endpoint, key, keySource: key ? source : 'none', keyStatus: status, accountId: account.ledgerId,
      dashboardUrl: account.dashboardUrl || defaultDashboard(account.endpoint), sourceId: account.id, sourceName: account.name,
      sessionProvider: account.codexProviders[0] || '', queryUrl: balance.method === 'source-usage' ? balance.queryUrl : '', requestHeaders: info?.headers || {} };
  }
  account(id) {
    return this.load().accounts.find(account => account.id === id || account.sourceIds.includes(id)) || null;
  }
  contextFor(id) {
    const account = this.account(id);
    return account ? this.context(account) : null;
  }
  // The account a Codex session ran on, by the provider name in its log.
  sessionContext(provider) {
    const account = provider ? this.load().accounts.find(item => item.codexProviders.includes(provider)) : null;
    return account ? this.context(account) : null;
  }
  monitorSessions() { return this.load().monitorSessions; }
  // Names for the ledger's per-account totals, under old source ids too.
  sourceNames() {
    return this.load().accounts.flatMap(account => [{ id: account.id, name: account.name }, ...account.sourceIds.map(id => ({ id, name: account.name }))]);
  }
  // The pet's account, with its key.
  pet() {
    const data = this.load(), account = data.accounts.find(item => item.id === data.petAccountId);
    if (!account) return null;
    const { key, status, source } = this.readKey(account);
    return { id: account.id, name: account.name, baseUrl: account.endpoint, key, keyStatus: status, keyStorage: source === 'session' ? 'session' : 'encrypted', keySetAt: account.keySetAt };
  }
  publicAccount(account, data = this.load()) {
    const { status, source } = this.readKey(account);
    return { id: account.id, name: account.name, host: new URL(account.endpoint).hostname, endpoint: account.endpoint, codexProviders: account.codexProviders,
      codexFile: account.codexConfig ? path.basename(account.codexConfig.file) : '', keyMode: account.key.mode, keyStatus: status, keyStorage: source,
      balance: account.balance, currency: account.currency, prices: account.prices, safeAmount: account.safeAmount, dashboardUrl: account.dashboardUrl, hidden: account.hidden,
      pet: data.petAccountId === account.id };
  }
  publicList() {
    const data = this.load();
    return { monitorSessions: data.monitorSessions, petAccountId: data.petAccountId, accounts: data.accounts.map(account => this.publicAccount(account, data)), error: this.error };
  }
  // Keeps a key in the keychain under a fresh name, so a failed save leaves the
  // old key in place; without a keychain it lasts until the pet quits.
  storeKey(account, value) {
    const key = secret(value);
    if (this.vault?.available?.()) {
      const ref = crypto.randomBytes(16).toString('hex');
      this.vault.write(ref, key);
      account.key = { mode: 'keychain', ref };
    } else this.memoryKeys.set(account.id, key);
    account.keySetAt = this.now();
    return key;
  }
  add({ name, endpoint, key, currency } = {}) {
    const data = structuredClone(this.load());
    endpoint = cleanUrl(String(endpoint || ''));
    const value = key ? secret(key) : '';
    if (value) for (const account of data.accounts) {
      if (origin(account.endpoint) === origin(endpoint) && this.readKey(account).key === value) throw new Error('这个地址和密钥已经添加过了：' + account.name);
    }
    const id = value ? keyId(endpoint, value) : 'api-' + crypto.randomBytes(6).toString('hex');
    if (data.accounts.some(account => account.id === id)) throw new Error('这个地址和密钥已经添加过了');
    const deepseek = officialDeepSeek(endpoint);
    const account = cleanAccount({ id, name: text(name, 40) || (deepseek ? 'DeepSeek' : new URL(endpoint).hostname), endpoint, key: { mode: 'none' },
      balance: { method: deepseek ? 'deepseek' : 'auto' }, currency: currency || (deepseek ? 'CNY' : 'USD'), keySetAt: this.now() });
    let stored = '';
    if (value) stored = this.storeKey(account, value);
    data.accounts.push(account);
    try { this.write(data); } catch (error) { if (stored) this.memoryKeys.delete(account.id); throw error; }
    return this.publicAccount(account, data);
  }
  update(id, patch = {}) {
    const data = structuredClone(this.load()), index = data.accounts.findIndex(account => account.id === id);
    if (index < 0) throw new Error('没有这个额度账户');
    const current = data.accounts[index], next = { ...current };
    if (patch.name !== undefined) next.name = text(patch.name, 40) || current.name;
    if (patch.currency !== undefined) next.currency = patch.currency;
    if (patch.prices !== undefined) next.prices = patch.prices;
    if (patch.safeAmount !== undefined) next.safeAmount = patch.safeAmount;
    if (patch.balance !== undefined) next.balance = { ...current.balance, ...patch.balance };
    if (patch.codexProviders !== undefined) next.codexProviders = patch.codexProviders;
    if (patch.hidden !== undefined) next.hidden = patch.hidden === true;
    if (patch.dashboardUrl !== undefined) next.dashboardUrl = patch.dashboardUrl;
    if (patch.endpoint !== undefined) {
      const endpoint = cleanUrl(String(patch.endpoint));
      if (origin(endpoint) !== origin(current.endpoint) && !patch.key) throw new Error('更换网站时请重新输入这个网站的密钥');
      next.endpoint = endpoint;
    }
    const account = cleanAccount(next);
    const previous = this.memoryKeys.get(id);
    if (patch.key) this.storeKey(account, patch.key);
    data.accounts[index] = account;
    try { this.write(data); }
    catch (error) { if (previous) this.memoryKeys.set(id, previous); else if (patch.key) this.memoryKeys.delete(id); throw error; }
    return this.publicAccount(account, data);
  }
  // The account behind an endpoint and key, added when it is new. Choosing a
  // different site needs that site's key.
  adopt({ baseUrl, key }) {
    const endpoint = cleanUrl(String(baseUrl || '')), data = this.load();
    const pet = data.accounts.find(account => account.id === data.petAccountId);
    if (!key) {
      if (pet && origin(pet.endpoint) === origin(endpoint)) return this.publicAccount(pet, data);
      throw new Error(pet ? '更换会话网站时请重新输入该网站的 API key' : '请输入会话 API key');
    }
    const value = secret(key);
    const existing = data.accounts.find(account => origin(account.endpoint) === origin(endpoint) && this.readKey(account).key === value);
    return existing ? this.publicAccount(existing, data) : this.add({ endpoint, key: value });
  }
  setPet(id) {
    const data = structuredClone(this.load());
    if (id && !data.accounts.some(account => account.id === id)) throw new Error('没有这个额度账户');
    data.petAccountId = id || '';
    this.write(data);
  }
  setMonitorSessions(on) {
    const data = structuredClone(this.load());
    data.monitorSessions = on === true;
    this.write(data);
  }
}
