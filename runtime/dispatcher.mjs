import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ROOT, DATA_HOME, VERSION, readJson, writeJson } from './paths.mjs';
import { WhaleService } from './service.mjs';
import { SessionMonitor } from './session-monitor.mjs';
import { createWidgetHost } from '../lib/widget-host.mjs';
import { migrateData } from './migration.mjs';
import { createFxService } from './fx.mjs';
import { MEDIA_POLICY } from '../lib/media-validation.mjs';
import { ChatService } from './chat/service.mjs';
import { claudeLastTurn, claudeSubscription } from './claude-usage.mjs';
import { QuotaBook } from './quota/book.mjs';
import { claudeIntegrationStatus, configureClaudeStatusline } from './claude-integration.mjs';
import { AgentBoard } from './agents/board.mjs';
import { jumpTo } from './agents/jump.mjs';
import { WorkbenchService } from './workbench/service.mjs';
import { TaskRunner } from './workbench/runner.mjs';
import { SummaryService } from './workbench/summary.mjs';

export const UI_ORIGIN = 'whale://widget';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.mp3': 'audio/mpeg' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const jsonResult = (status, payload) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(payload)) });
// A change the user asked for: its own error message is the answer when it is refused.
async function change(work) {
  try { return jsonResult(200, { ok: true, ...await work() }); }
  catch (error) { return jsonResult(400, { ok: false, error: error?.message || '操作未完成，请重试' }); }
}

// Dispatch original resource handlers entirely in process; no HTTP listener exists.
export function createDispatcher({ dataDir = DATA_HOME, claudeHome = path.join(os.homedir(), '.claude'), dshHome = null, service = null, secretVault = null, monitor = true, autoRefresh = true, fetchImpl, fxFetchImpl = fetchImpl, chatFetchImpl = fetchImpl, chatActivityOptions = {}, onStop = () => {}, onShow = () => {}, onChatNotice = () => {}, onWorkNotice = () => {}, onOpenWorkbench = () => false, statusInfo = () => ({}), agentJump = jumpTo, agentOptions = {}, runnerOptions = {} } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  migrateData(dataDir);
  const whale = service || new WhaleService({ dataDir, secretVault, ...(fetchImpl ? { fetchImpl } : {}) });
  const fx = createFxService({ dataDir, ...(fxFetchImpl ? { fetchImpl: fxFetchImpl } : {}) });
  const routes = new Map(), effects = [];
  createWidgetHost(dataDir).apply({ whale, webServer: { register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path); }, tapIndex: () => () => {} }, effect: f => effects.push(f()) });
  let closing = false, closeJob = null;
  let chat = null, workbench = null, runner = null, summary = null;
  const chatService = () => chat ||= new ChatService({ dataDir, secretVault, accounts: whale.accounts, canProactive: () => { const status = statusInfo(); return status.visible !== false && status.present !== false; }, onNotice: onChatNotice,
    activityOptions: chatActivityOptions, queryBalance: () => book.petBalance(), onUserMessage: () => book.petMessage(),
    memory: workbench?.memory || null, memoryEnabled: () => workbench?.settings.public().autoConsolidate ?? false,
    taskRunner: () => runner, taskSummary: () => summary,
    ...(chatFetchImpl ? { fetchImpl: chatFetchImpl } : {}) });
  // Looking at quota never starts the chat service, and so never proactive chat.
  const book = new QuotaBook({ whale, billing: ({ start = false } = {}) => start && !closing ? chatService().billing : chat?.billing });
  whale.onTurnEnd = turn => book.codexTurn(turn);
  whale.petUsedDuring = (context, from, to) => !!chat?.billing.usedBetween({ baseUrl: context.baseUrl, key: context.key }, from, to);
  // The task window: what each Claude Code, Codex and DSH session is doing.
  const agents = new AgentBoard({ dataDir, dshHome, ...agentOptions });
  workbench = new WorkbenchService({ dataDir, agents,
    limits: () => ({ claude: claudeSubscription(dataDir), codex: whale.subscriptionRateLimits() }) });
  runner = new TaskRunner({ dataDir, settings: workbench.settings, onNotice: notice => onWorkNotice(notice), ...runnerOptions });
  workbench.attachRunner(runner);
  agents.extraRows = () => runner.rows();
  agents.suppressedSessions = () => runner.sessionIds();
  summary = new SummaryService({ dataDir, codexHome: whale.config.codexHome, dshHome: dshHome || path.join(os.homedir(), '.dsh'), agents, runner, settings: workbench.settings, chat: () => chatService() });
  const watcher = monitor ? new SessionMonitor(whale, { onSession: view => agents.codexSession(view) }) : null;
  watcher?.start();
  const timer = autoRefresh ? setInterval(() => book.refresh().catch(() => {}), 60000) : null;
  timer?.unref();
  if (autoRefresh) {
    book.refresh().catch(() => {});
    fx.start().catch(() => {});
  }
  const stateFile = path.join(dataDir, 'ui-state.json');
  const buildVersion = readJson(path.join(ROOT, '.codex-plugin', 'plugin.json'), {}).version || VERSION;

  async function dispatch(route, { method = 'GET', body = null, headers = {}, signal } = {}) {
    const result = await run(route, { method, body, headers, signal });
    result.headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, ...result.headers };
    return result;
  }
  async function run(route, { method, body, headers, signal }) {
    try {
      if (closing) return jsonResult(503, { ok: false, error: '挂件正在退出，请稍后重新打开' });
      if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\x00-\x1f]/.test(route)) return jsonResult(400, { ok: false, error: '无效的本地操作' });
      const url = new URL(route, UI_ORIGIN);
      if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].includes(method)) return jsonResult(405, { ok: false });
      const bytes = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (bytes.length > 32 * 1024 * 1024) return jsonResult(413, { ok: false, error: '导入文件过大' });
      const parsed = () => JSON.parse(bytes.toString('utf8') || '{}');
      if (url.pathname.startsWith('/api/chat/')) {
        if (bytes.length > 128 * 1024) return jsonResult(413, { ok: false, error: '会话请求过大' });
        return chatService().dispatch(url, { method, body: bytes, signal });
      }
      if (url.pathname === '/api/status' && method === 'GET') return jsonResult(200, { ok: true, version: VERSION, buildVersion, transport: 'local-ipc', webpage: false, provider: codexProvider(), monitor: watcher?.status() || { watching: 0, activeTurns: 0 }, subscriptionRateLimits: whale.subscriptionRateLimits(), dataDir, ...statusInfo() });
      if (url.pathname === '/api/quotas' && method === 'GET') {
        if (url.searchParams.get('refresh') === '1') await book.refresh({ force: true });
        else await book.fill();
        return jsonResult(200, book.snapshot());
      }
      if (url.pathname === '/api/quota-records' && method === 'GET') return jsonResult(200, book.records());
      if (url.pathname === '/api/quotas/current' && method === 'PUT') {
        const input = parsed();
        try { return jsonResult(200, book.select(input?.id, input?.at)); }
        catch (error) { return jsonResult(400, { ok: false, error: error.message }); }
      }
      if (url.pathname === '/api/subscription-rate-limits' && method === 'GET') return jsonResult(200, whale.subscriptionRateLimits());
      if (url.pathname === '/api/claude/subscription' && method === 'GET') return jsonResult(200, claudeSubscription(dataDir));
      if (url.pathname === '/api/claude/last-turn' && method === 'GET') return jsonResult(200, claudeLastTurn(dataDir));
      if (url.pathname === '/api/quota-accounts') {
        // Opening the accounts also looks for Codex providers added since.
        if (method === 'GET') return change(() => { whale.accounts.discover(); return { ...whale.accounts.publicList(), claude: claudeIntegrationStatus({ claudeHome }) }; });
        if (method === 'POST') return change(async () => {
          const account = whale.accounts.add(parsed());
          return { account, quota: await book.query(account.id) };
        });
        return jsonResult(405, { ok: false });
      }
      const accountRoute = url.pathname.match(/^\/api\/quota-accounts\/([a-z][a-z0-9-]{0,40})(\/query)?$/);
      if (accountRoute && accountRoute[2] && method === 'POST') return change(async () => ({ quota: await book.query(accountRoute[1]) }));
      if (accountRoute && !accountRoute[2] && method === 'PUT') return change(async () => {
        const account = whale.accounts.update(accountRoute[1], parsed());
        return { account, quota: account.hidden ? null : await book.query(account.id) };
      });
      if (url.pathname === '/api/quota-settings' && method === 'PUT') return change(() => {
        const input = parsed();
        if (typeof input?.monitorSessions === 'boolean') whale.accounts.setMonitorSessions(input.monitorSessions);
        return whale.accounts.publicList();
      });
      if (url.pathname === '/api/claude/integration') {
        if (method === 'GET') return jsonResult(200, { ok: true, ...claudeIntegrationStatus({ claudeHome }) });
        if (method === 'POST') return change(() => {
          const action = parsed()?.action;
          if (!['install', 'uninstall'].includes(action)) throw new Error('无效的 Claude 接入操作');
          return { result: configureClaudeStatusline(action, { claudeHome, dataDir }), ...claudeIntegrationStatus({ claudeHome }) };
        });
        return jsonResult(405, { ok: false });
      }
      if (url.pathname === '/api/agents' && method === 'GET') return jsonResult(200, { ok: true, rows: agents.rows(), watching: !!watcher,
        dsh: agents.dshStatus(), claude: claudeIntegrationStatus({ claudeHome }), limits: { claude: claudeSubscription(dataDir), codex: whale.subscriptionRateLimits() } });
      if (url.pathname === '/api/workbench/tasks' && method === 'GET') return jsonResult(200, workbench.snapshot());
      if (url.pathname === '/api/workbench/tasks/draft' && method === 'POST') return change(() => workbench.createDraft(parsed()));
      if (url.pathname === '/api/workbench/tasks/start' && method === 'POST') return change(() => workbench.startDraft(parsed().draftId, { by: 'ui' }));
      if (url.pathname === '/api/workbench/tasks/cancel' && method === 'POST') return change(() => workbench.cancelDraft(parsed().draftId, { by: 'ui' }));
      if (url.pathname === '/api/workbench/open' && method === 'POST') return change(() => ({ ok: true, opened: onOpenWorkbench() }));
      if (url.pathname === '/api/workbench/tasks/stop' && method === 'POST') return change(() => workbench.stopTask(parsed().id, { by: 'ui' }));
      if (url.pathname === '/api/workbench/tasks/summary' && method === 'POST') {
        const input = parsed();
        return change(async () => summary.task(input.id, { refresh: input.refresh === true }));
      }
      if (url.pathname === '/api/workbench/report') {
        if (method === 'GET') return change(async () => summary.report({ day: url.searchParams.get('day') || undefined, refresh: url.searchParams.get('refresh') === '1' }));
        if (method === 'POST') { const input = parsed(); return change(async () => summary.report({ day: input.day, refresh: input.refresh === true })); }
        return jsonResult(405, { ok: false });
      }
      const workbenchEvents = url.pathname.match(/^\/api\/workbench\/tasks\/([^/]+)\/events$/);
      if (workbenchEvents && method === 'GET') {
        const result = workbench.taskEvents(decodeURIComponent(workbenchEvents[1]));
        return jsonResult(result.ok ? 200 : 404, result);
      }
      const workbenchTask = url.pathname.match(/^\/api\/workbench\/tasks\/([^/]+)$/);
      if (workbenchTask && method === 'GET') {
        const result = workbench.task(decodeURIComponent(workbenchTask[1]));
        return jsonResult(result.ok ? 200 : 404, result);
      }
      if (url.pathname === '/api/workbench/settings') {
        if (method === 'GET') return jsonResult(200, workbench.publicSettings());
        if (method === 'PUT') return change(() => workbench.saveSettings(parsed()));
        return jsonResult(405, { ok: false });
      }
      if (url.pathname === '/api/workbench/memory') {
        if (method === 'GET') return jsonResult(200, workbench.memorySnapshot());
        if (method === 'POST') return change(() => workbench.memoryAction(parsed()));
        return jsonResult(405, { ok: false });
      }
      if (url.pathname === '/api/workbench/memory/import' && method === 'POST') return change(async () => chatService().bootstrapMemory());
      if (url.pathname === '/api/workbench/memory/consolidate' && method === 'POST') return change(async () => chatService().consolidateMemory({ force: true }));
      const agentRoute = url.pathname.match(/^\/api\/agents\/(jump|hide)$/);
      if (agentRoute && method === 'POST') {
        const id = parsed()?.id, row = typeof id === 'string' ? agents.find(id) : null;
        if (!row) return jsonResult(404, { ok: false, error: '这个会话已经不在了' });
        if (agentRoute[1] === 'hide') return jsonResult(200, { ok: agents.hide(id) });
        try {
          const result = await agentJump(row);
          return jsonResult(result.ok ? 200 : 400, result);
        } catch (error) {
          return jsonResult(500, { ok: false, error: error?.message || '跳转失败' });
        }
      }
      if (url.pathname === '/api/fx/usd-cny') {
        if (method !== 'GET') return jsonResult(405, { ok: false });
        const manual = url.searchParams.get('refresh') === '1';
        try { return jsonResult(200, { ok: true, ...await fx.get(manual ? { force: true, reason: 'manual' } : {}) }); }
        catch (error) {
          const metadata = {};
          for (const key of ['cooldownRemainingMs', 'retryAfterMs']) if (Number.isFinite(error?.[key]) && error[key] >= 0) metadata[key] = error[key];
          for (const key of ['checkedAt', 'retrievedAt', 'nextDailyCheckAt']) if (error?.[key] === null || typeof error?.[key] === 'string' && Number.isFinite(Date.parse(error[key]))) metadata[key] = error[key];
          if (typeof error?.stale === 'boolean') metadata.stale = error.stale;
          return jsonResult(503, { ok: false, error: error?.message || '汇率暂时无法读取，请稍后重试', ...metadata });
        }
      }
      if (url.pathname === '/api/media-policy') {
        if (method !== 'GET') return jsonResult(405, { ok: false });
        return jsonResult(200, { ok: true, policy: MEDIA_POLICY });
      }
      if (url.pathname === '/api/ui-state') {
        if (method === 'GET') return jsonResult(200, { ok: true, values: readJson(stateFile, {}) });
        if (method === 'PUT') {
          const input = parsed(), values = {};
          if (!input || Array.isArray(input) || typeof input !== 'object') return jsonResult(400, { ok: false });
          for (const [key, value] of Object.entries(input)) if (/^dshw[-v]/.test(key) && typeof value === 'string' && value.length < 1024 * 1024) values[key] = value;
          writeJson(stateFile, values); return jsonResult(200, { ok: true });
        }
        return jsonResult(405, { ok: false });
      }
      if (url.pathname === '/api/show' && method === 'POST') { onShow(); return jsonResult(200, { ok: true, desktop: 'shown' }); }
      if (url.pathname === '/api/stop' && method === 'POST') { setTimeout(onStop, 100); return jsonResult(200, { ok: true }); }
      const uiFiles = { '/': 'widget.html', '/widget.html': 'widget.html', '/toast.js': 'toast.js', '/quota-manager.js': 'quota-manager.js', '/ui.css': 'ui.css', '/render.js': 'render.js', '/input.js': 'input.js', '/alpha-worker.js': 'alpha-worker.js', '/money.js': 'money.js', '/media-guard.js': 'media-guard.js', '/turn-notice.js': 'turn-notice.js', '/usage-client.js': 'usage-client.js', '/bubble-queue.js': 'bubble-queue.js', '/pet-geometry.js': 'pet-geometry.js', '/usage-presentation.js': 'usage-presentation.js', '/quota-presentation.js': 'quota-presentation.js', '/quota-view.js': 'quota-view.js', '/quota.js': 'quota.js', '/quota.css': 'quota.css', '/companion-display.js': 'companion-display.js', '/chat.js': 'chat.js', '/chat-client.js': 'chat-client.js', '/chat-billing.js': 'chat-billing.js', '/chat.css': 'chat.css', '/theme.css': 'theme.css', '/theme.js': 'theme.js', '/pet.css': 'pet.css', '/agents.js': 'agents.js', '/agents.css': 'agents.css', '/workbench.html': 'workbench.html', '/workbench.js': 'workbench.js', '/workbench.css': 'workbench.css' };
      let file;
      if (Object.hasOwn(uiFiles, url.pathname)) file = path.join(ROOT, 'desktop', 'ui', uiFiles[url.pathname]);
      else if (url.pathname === '/lib/event-stream.js' || /^\/vendor\/eventsource-parser\/dist\/(index|parse|errors|types|stream)\.js$/.test(url.pathname)) file = path.join(ROOT, url.pathname.slice(1));
      else if (url.pathname.startsWith('/assets/')) {
        const name = decodeURIComponent(url.pathname.slice(8));
        if (!/^[A-Za-z0-9_.-]+$/.test(name) || !MIME[path.extname(name)]) return jsonResult(404, { ok: false });
        file = path.join(ROOT, 'assets', name);
      }
      if (file) return ['GET', 'HEAD'].includes(method) ? { status: 200, headers: { 'content-type': MIME[path.extname(file)] }, body: method === 'HEAD' ? Buffer.alloc(0) : fs.readFileSync(file) } : jsonResult(405, { ok: false });
      const handler = routes.get(url.pathname);
      if (!handler) return jsonResult(404, { ok: false, error: '未找到此功能' });
      if (/(?:role-pin|role-delete)\.json$/.test(url.pathname) && !['POST', 'PUT'].includes(method)) return jsonResult(405, { ok: false });
      const requestBytes = Buffer.isBuffer(body) ? body : bytes;
      const req = Readable.from(requestBytes.length ? [requestBytes] : []);
      Object.assign(req, { url: route, method, headers: { 'content-type': 'application/json', ...headers } });
      return await new Promise((resolve, reject) => {
        const chunks = [], responseHeaders = {};
        const res = new Writable({ write(chunk, _enc, done) { chunks.push(Buffer.from(chunk)); done(); } });
        res.statusCode = 200; res.headersSent = false;
        res.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = String(value); };
        res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return res; };
        res.on('finish', () => resolve({ status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks) }));
        req.on('error', reject); res.on('error', reject);
        Promise.resolve(handler(req, res)).catch(reject);
      });
    } catch { return jsonResult(400, { ok: false, error: '操作失败，请检查设置或导入文件' }); }
  }
  function close() {
    if (closeJob) return closeJob;
    closing = true; clearInterval(timer);
    closeJob = (async () => {
      const failures = [];
      try { await chat?.close(); } catch (error) { failures.push(error); }
      try { await fx.close(); } catch (error) { failures.push(error); }
      try { await watcher?.stop({ timeoutMs: 1200 }); } catch (error) { failures.push(error); }
      try { await runner?.close?.(); } catch (error) { failures.push(error); }
      try { await workbench.close?.(); } catch (error) { failures.push(error); }
      try { await whale.close?.({ timeoutMs: 3000 }); } catch (error) { failures.push(error); }
      for (const effect of effects.splice(0)) {
        try { if (typeof effect === 'function') await effect(); else await effect?.close?.(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, '部分挂件组件未能正常关闭');
    })();
    return closeJob;
  }
  // The default Codex provider and model, for the status read.
  function codexProvider() {
    try { const config = whale.config.resolve(); return { id: config.id, model: config.model, providerName: config.providerName, baseUrl: config.baseUrl }; }
    catch { return {}; }
  }
  return { dispatch, whale, book, watcher, agents, workbench, runner, summary, close };
}
