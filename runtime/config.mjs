import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '../vendor/smol-toml/dist/index.js';
import { CODEX_HOME, DATA_HOME, readJson, writeJson } from './paths.mjs';

export const DEFAULT_CONFIG = {
  provider: 'auto', baseUrl: '', keyEnv: '', profile: '', projectDir: '', currency: 'USD',
  balancePath: '', balanceField: 'data.balance', usedField: '', balanceScale: 1,
  billingUsageDivisor: 100, quotaPerUnit: 500000,
  dashboardUrl: '', monitorSessions: true, refreshSeconds: 60,
  models: {}, sources: [],
};

export function cleanUrl(value, { allowEmpty = false } = {}) {
  if (!value && allowEmpty) return '';
  let u;
  try { u = new URL(value); } catch { throw new Error('API 地址无效'); }
  if (u.username || u.password || u.search || u.hash) throw new Error('API 地址不能包含密钥、查询参数或片段');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('API 地址须使用 HTTPS（本机服务除外）');
  return u.toString().replace(/\/$/, '');
}

function numberIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(label + '超出有效范围');
  return n;
}

function sourceId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error('数据源标识须为 1-64 位小写字母、数字、- 或 _，且以字母开头');
  return id;
}

function sourcePath(value) {
  const file = String(value || '').trim();
  if (!file || file.length > 1024 || /[\0\r\n]/.test(file)) throw new Error('Codex 配置文件路径无效');
  if (!(path.isAbsolute(file) || file === '~' || file.startsWith('~/'))) throw new Error('Codex 配置文件须使用绝对路径或 ~/ 开头的路径');
  return file;
}

function sourceName(value, fallback) {
  const name = String(value || '').trim().replace(/[\r\n]/g, '');
  return (name || fallback).slice(0, 40);
}

function sourceKeyMode(value, fallback) {
  const mode = String(value || fallback || '').trim();
  if (!['keychain', 'environment'].includes(mode)) throw new Error('数据源的密钥方式无效');
  return mode;
}

function sourceKeyRef(value, id) {
  // keyRef is an opaque, non-secret identifier for the encrypted vault entry.
  // It deliberately survives a source rename, while freshly added sources get
  // a new value so removing and re-adding a source never adopts an old key.
  const ref = String(value || ('legacy-' + id)).trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(ref)) throw new Error('数据源的钥匙串标识无效');
  return ref;
}

function sourceQueryUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return cleanUrl(String(value));
}

export function sourceHeaders(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 30) throw new Error('数据源 TOML 的 http_headers 无效');
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName).trim();
    const headerValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || !headerValue || headerValue.length > 4096 || /[\r\n]/.test(headerValue)) throw new Error('数据源 TOML 的 http_headers 包含无效字段');
    // The API key always owns Authorization. Other provider-specific headers,
    // such as x-openai-actor-authorization, remain available to the query.
    if (name.toLowerCase() === 'authorization') continue;
    headers[name] = headerValue;
  }
  return headers;
}

function normalizeSources(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('最多可添加 20 个 API 数据源');
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('API 数据源格式无效');
    const id = sourceId(item.id);
    if (ids.has(id)) throw new Error('API 数据源标识不能重复');
    ids.add(id);
    const keyEnv = String(item.keyEnv || '').trim();
    if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('数据源的密钥环境变量名称无效');
    // Existing configurations did not have keyMode. Preserve their old
    // environment-variable behaviour when a variable was already configured.
    const keyMode = sourceKeyMode(item.keyMode, keyEnv ? 'environment' : 'keychain');
    return { id, name: sourceName(item.name, '数据源 ' + (index + 1)), configPath: sourcePath(item.configPath),
      keyMode, keyEnv, keyRef: sourceKeyRef(item.keyRef, id), queryUrl: sourceQueryUrl(item.queryUrl), enabled: item.enabled !== false };
  });
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是 JSON 对象');
  const c = structuredClone(DEFAULT_CONFIG);
  for (const k of Object.keys(c)) if (Object.hasOwn(input, k)) c[k] = input[k];
  if (!['auto', 'billing', 'newapi', 'custom-json', 'deepseek'].includes(c.provider)) throw new Error('未知余额接口类型');
  c.baseUrl = cleanUrl(String(c.baseUrl || ''), { allowEmpty: true });
  c.dashboardUrl = cleanUrl(String(c.dashboardUrl || ''), { allowEmpty: true });
  c.keyEnv = String(c.keyEnv || '').trim();
  if (c.keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.keyEnv)) throw new Error('密钥环境变量名称无效');
  c.profile = String(c.profile || '').slice(0, 128);
  c.projectDir = String(c.projectDir || '');
  c.currency = String(c.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c.currency)) throw new Error('币种须使用 USD、CNY 等三位代码');
  c.refreshSeconds = numberIn(c.refreshSeconds, 15, 3600, '刷新间隔');
  c.monitorSessions = c.monitorSessions === true;
  c.billingUsageDivisor = numberIn(c.billingUsageDivisor, 0.000001, 1e12, '用量单位换算');
  c.quotaPerUnit = numberIn(c.quotaPerUnit, 0.000001, 1e12, '额度单位换算');
  c.balanceScale = numberIn(c.balanceScale, 0.000000001, 1e12, '余额系数');
  c.balancePath = String(c.balancePath || '');
  if (c.balancePath && (!c.balancePath.startsWith('/') || c.balancePath.startsWith('//') || /[\\#\r\n]/.test(c.balancePath))) throw new Error('余额路径须为当前 API 域名下的绝对路径');
  for (const k of ['balanceField', 'usedField']) {
    c[k] = String(c[k] || '');
    if (c[k] && !/^[A-Za-z0-9_.]+$/.test(c[k])) throw new Error('字段路径仅支持字母、数字、下划线和点');
    if (c[k].split('.').some(x => ['__proto__', 'constructor', 'prototype'].includes(x))) throw new Error('字段路径无效');
  }
  if (!c.models || typeof c.models !== 'object' || Array.isArray(c.models)) throw new Error('模型价格须为 JSON 对象');
  const models = {};
  for (const [model, prices] of Object.entries(c.models)) {
    if (!model || model.length > 150 || ['__proto__', 'constructor', 'prototype'].includes(model)) throw new Error('模型名称无效');
    if (!prices || typeof prices !== 'object') throw new Error('模型价格无效');
    models[model] = {};
    for (const field of ['input', 'cachedInput', 'output']) models[model][field] = numberIn(prices[field], 0, 1e9, '模型价格');
    if (prices.cacheWrite !== undefined) models[model].cacheWrite = numberIn(prices.cacheWrite, 0, 1e9, '缓存写入价格');
  }
  c.models = models;
  c.sources = normalizeSources(input.sources);
  return c;
}

export class ConfigStore {
  constructor({ dataDir = DATA_HOME, codexHome = CODEX_HOME, env = process.env, secretVault = null } = {}) {
    this.dataDir = dataDir; this.codexHome = codexHome; this.env = env; this.secretVault = secretVault;
    this.file = path.join(dataDir, 'api-settings.json');
  }
  load() { return validateConfig(readJson(this.file, DEFAULT_CONFIG)); }
  save(patch) {
    if (Object.keys(patch).some(k => /secret|token|api.?key|password/i.test(k) && k !== 'keyEnv')) throw new Error('请填写密钥环境变量名；插件设置中不保存密钥');
    const c = validateConfig({ ...this.load(), ...patch });
    this.assertSourceDefinitions(c);
    writeJson(this.file, c); return c;
  }
  configFilePath(value) {
    const raw = sourcePath(value);
    const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    const root = fs.realpathSync(this.codexHome);
    let file;
    try { file = fs.realpathSync(expanded); }
    catch { throw new Error('找不到数据源的 Codex 配置文件：' + path.basename(expanded)); }
    const relative = path.relative(root, file);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('数据源配置文件须位于 ' + this.codexHome);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new Error('数据源配置文件不可读取'); }
    if (!stat.isFile()) throw new Error('数据源配置路径不是普通文件');
    return file;
  }
  parseConfigFile(file, label = 'Codex config.toml') {
    try { return parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error(label + ' 无法解析，请检查 TOML 格式'); }
  }
  resolveConfiguredSource(source, setting = this.load()) {
    const file = this.configFilePath(source.configPath);
    const config = this.parseConfigFile(file, '数据源配置文件');
    const providerId = String(config.model_provider || 'openai');
    if (!providerId || providerId.length > 128 || /[\r\n]/.test(providerId)) throw new Error('数据源的 model_provider 无效');
    const provider = config.model_providers?.[providerId] || {};
    const baseUrl = cleanUrl(provider.base_url || 'https://api.openai.com/v1');
    const queryUrl = sourceQueryUrl(source.queryUrl);
    if (queryUrl && new URL(queryUrl).origin !== new URL(baseUrl).origin) throw new Error('数据源查询链接必须与 TOML 的 API 地址同源，不能将密钥发送到其他域名');
    const requestHeaders = sourceHeaders(provider.http_headers);
    const keyMode = sourceKeyMode(source.keyMode, source.keyEnv ? 'environment' : 'keychain');
    const keyEnv = keyMode === 'environment' ? (source.keyEnv || String(provider.env_key || '').trim()) : '';
    if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('数据源配置中的密钥环境变量名称无效');
    let key = '', keySource = 'none', keyStatus = 'key-unavailable';
    if (keyMode === 'environment') {
      key = keyEnv ? this.env[keyEnv] : '';
      keySource = key ? 'environment' : 'none';
      keyStatus = key ? 'ready' : 'key-unavailable';
    } else {
      // The desktop implementation returns only the decrypted value to this
      // short-lived context. No configuration or public response includes it.
      try {
        const entry = this.secretVault?.read?.(source.keyRef);
        if (entry?.available && typeof entry.value === 'string') {
          key = entry.value; keySource = 'keychain'; keyStatus = key ? 'ready' : 'keychain-missing';
        } else keyStatus = entry?.status || 'keychain-unavailable';
      } catch { keyStatus = 'keychain-unavailable'; }
    }
    key = String(key || '').trim().replace(/^Bearer\s+/i, '');
    if (/[\r\n]/.test(key)) throw new Error('API 密钥格式无效');
    // The source identity intentionally uses its user-defined id and path, not
    // the secret. It remains stable when a key is rotated and is only used to
    // partition local accounting data.
    const accountId = crypto.createHash('sha256').update('source\0' + source.id + '\0' + file).digest('hex').slice(0, 24);
    const host = new URL(baseUrl).hostname;
    const sourceSetting = { ...setting, keyEnv, profile: '', projectDir: '' };
    return { setting: sourceSetting, id: providerId, model: typeof config.model === 'string' ? config.model : '', profileName: '',
      providerName: source.name || provider.name || providerId || host, baseUrl, key, keySource: key ? keySource : 'none', keyStatus, accountId,
      dashboardUrl: setting.dashboardUrl || new URL(baseUrl).origin, sourceId: source.id, sourceName: source.name,
      sessionProvider: providerId, configPath: file, keyMode, keyEnv, keyRef: source.keyRef, queryUrl, requestHeaders };
  }
  defaultSessionProvider() {
    const file = path.join(this.codexHome, 'config.toml');
    if (!fs.existsSync(file)) return 'openai';
    const config = this.parseConfigFile(file);
    return String(config.model_provider || 'openai');
  }
  assertSourceDefinitions(setting) {
    const providers = new Map();
    const defaultProvider = this.defaultSessionProvider();
    for (const source of setting.sources.filter(item => item.enabled)) {
      const resolved = this.resolveConfiguredSource(source, setting);
      if (resolved.sessionProvider === defaultProvider) throw new Error('数据源「' + source.name + '」的 model_provider 与当前默认 Codex 相同，日志无法区分；请为其中一个配置使用不同的 provider 名称');
      const prior = providers.get(resolved.sessionProvider);
      if (prior) throw new Error('数据源「' + source.name + '」与「' + prior + '」使用相同的 model_provider，日志无法区分');
      providers.set(resolved.sessionProvider, source.name);
    }
  }
  configuredSources(setting = this.load()) {
    const result = [];
    for (const source of setting.sources) {
      if (!source.enabled) continue;
      try { result.push({ source, context: this.resolveConfiguredSource(source, setting), error: '' }); }
      catch (error) { result.push({ source, context: null, error: error.message }); }
    }
    return result;
  }
  resolveForSession(meta = {}) {
    const setting = this.load();
    const modelProvider = typeof meta.modelProvider === 'string' ? meta.modelProvider : '';
    const matches = this.configuredSources(setting).filter(item => item.context && item.context.sessionProvider === modelProvider);
    if (matches.length === 1) return matches[0].context;
    return this.resolve();
  }
  sourcePublicInfo(setting = this.load()) {
    return this.configuredSources(setting).map(({ source, context, error }) => ({ id: source.id, name: source.name, configPath: source.configPath,
      keyMode: source.keyMode, keyEnv: source.keyEnv || context?.keyEnv || '', queryUrl: source.queryUrl || '', resolvedBaseUrl: context?.baseUrl || '', enabled: source.enabled !== false, provider: context?.sessionProvider || '', model: context?.model || '',
      hasKey: !!context?.key, status: error || context?.keyStatus || (context?.key ? 'ready' : 'key-unavailable') }));
  }
  resolve() {
    const setting = this.load();
    const file = path.join(this.codexHome, 'config.toml');
    let config = {};
    if (fs.existsSync(file)) {
      try { config = parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error('Codex config.toml 无法解析，请检查配置文件'); }
    }
    // A project file may come from a downloaded repository. Keep the trusted
    // user's endpoint before overlaying it; project values cannot authorize a
    // different destination to receive the user's global/environment key.
    const trustedProfileName = setting.profile || this.env.CODEX_PROFILE || config.profile || '';
    const trustedEffective = { ...config, ...(trustedProfileName ? config.profiles?.[trustedProfileName] : {}) };
    const trustedProvider = trustedEffective.model_providers?.[trustedEffective.model_provider || 'openai'] || {};
    const trustedOrigin = new URL(cleanUrl(trustedProvider.base_url || this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')).origin;
    let projectLoaded = false;
    if (setting.projectDir) {
      const projectFile = path.join(path.resolve(setting.projectDir), '.codex', 'config.toml');
      if (fs.existsSync(projectFile)) {
        let local;
        try { local = parse(fs.readFileSync(projectFile, 'utf8')); } catch { throw new Error('项目 .codex/config.toml 无法解析'); }
        config = { ...config, ...local, model_providers: { ...config.model_providers, ...local.model_providers }, profiles: { ...config.profiles, ...local.profiles } };
        projectLoaded = true;
      }
    }
    const profileName = setting.profile || this.env.CODEX_PROFILE || config.profile || '';
    if (profileName && !config.profiles?.[profileName]) throw new Error('找不到所选 Codex profile');
    const effective = { ...config, ...(profileName ? config.profiles[profileName] : {}) };
    const id = effective.model_provider || 'openai';
    const provider = effective.model_providers?.[id] || {};
    const originalBase = cleanUrl(provider.base_url || this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
    const baseUrl = cleanUrl(setting.baseUrl || originalBase);
    if (!setting.keyEnv && projectLoaded && new URL(originalBase).origin !== trustedOrigin) throw new Error('项目配置更换 API 域名时，请在挂件设置中明确指定该服务专用的密钥环境变量；不会转发全局密钥');
    if (!setting.keyEnv && new URL(baseUrl).origin !== new URL(originalBase).origin) throw new Error('更换 API 域名时请指定该服务自己的密钥环境变量，不能复用原服务密钥');
    let key = '', keySource = 'none';
    const envName = setting.keyEnv || provider.env_key || '';
    if (envName && this.env[envName]) { key = this.env[envName]; keySource = 'environment'; }
    else if (!setting.keyEnv && provider.experimental_bearer_token) { key = provider.experimental_bearer_token; keySource = 'codex-provider'; }
    else if (!setting.keyEnv && !provider.env_key) {
      if (this.env.OPENAI_API_KEY) { key = this.env.OPENAI_API_KEY; keySource = 'environment'; }
      else {
        const auth = readJson(path.join(this.codexHome, 'auth.json'), {});
        if (typeof auth.OPENAI_API_KEY === 'string') { key = auth.OPENAI_API_KEY; keySource = 'codex-auth'; }
      }
    }
    key = String(key || '').trim().replace(/^Bearer\s+/i, '');
    if (/[\r\n]/.test(key)) throw new Error('API 密钥格式无效');
    const accountId = crypto.createHash('sha256').update(baseUrl + '\0' + key).digest('hex').slice(0, 24);
    const host = new URL(baseUrl).hostname;
    // 0.2.0: no service-specific label. The display name comes from the user's
    // own Codex provider entry, the provider id, or the hostname of the endpoint
    // they configured; the package itself names no vendor.
    const providerName = provider.name || id || host;
    const dashboardUrl = setting.dashboardUrl || (host === 'api.openai.com' ? 'https://platform.openai.com/settings/organization/billing/overview' : new URL(baseUrl).origin);
    return { setting, id, model: effective.model || '', profileName, providerName, baseUrl, key, keySource, accountId, dashboardUrl,
      sourceId: 'default', sourceName: '当前 API', sessionProvider: id };
  }
  publicInfo() {
    const c = this.resolve();
    return { id: c.id, providerName: c.providerName, baseUrl: c.baseUrl, model: c.model, profile: c.profileName, hasKey: !!c.key, keySource: c.keySource, accountId: c.accountId, dashboardUrl: c.dashboardUrl, settings: c.setting, sources: this.sourcePublicInfo(c.setting) };
  }
}
