// A small Electron smoke for the independent workbench window: it loads the
// real page through the local whale:// protocol, serves a synthetic DSH cache,
// and checks that rows, summary and settings render. Run with:
//   electron.exe --no-sandbox scripts/smoke-workbench.cjs
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([{ scheme: 'whale', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-smoke-'));
const dataDir = path.join(temp, 'data');
const dshHome = path.join(temp, 'dsh');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(temp, 'profile'), { recursive: true });
app.setPath('userData', path.join(temp, 'profile'));
fs.mkdirSync(path.join(dshHome, 'storages', 'session_projcache', 'sessions'), { recursive: true });
fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [] }, tables: { workspaces: {} } }));

const now = Date.now();
function cache(id, title, extra = {}) {
  const doc = {
    version: 7,
    record: { identity: { cwd: 'D:\\工作文件\\demo' }, rows: {
      title: { val: title }, workingDirectory: { val: 'D:\\工作文件\\demo' },
      sessionStats: { val: { lastTurn: 1, steps: 4, openStep: extra.openStep || null, pendingCalls: {} } },
      turnBoundary: { val: { openTurnStartSeq: extra.openStep ? 5 : null, lastStepBoundary: { kind: extra.openStep ? 'start' : 'end' }, lastTurn: 1 } },
      userQuestions: { val: { questions: { active: extra.question ? [{ askedAt: now - 60000, text: '?' }] : [], settled: [] } } },
      goal: { val: { current: null, failure: null } }, llmRetry: { val: {} },
      contextPressure: { val: { surfaceTokens: 24000, contextWindow: 128000 } },
      turnOutline: { val: { turns: [{ prompt: '把工作台做出来', response: '正在实现任务列表。' }] } },
      timeContext: { val: { lastMessageTime: now - 60000 } },
    } },
  };
  fs.writeFileSync(path.join(dshHome, 'storages', 'session_projcache', 'sessions', id + '.json'), JSON.stringify(doc));
}
cache('running', '实现工作台窗口', { openStep: { step: 2, startTime: now - 120000 } });
cache('waiting', '等你确认摘要范围', { question: true });
cache('done', '整理 DSH 任务状态', {});
fs.writeFileSync(path.join(dataDir, 'work-memory.json'), JSON.stringify({
  version: 1,
  items: [{ id: 'm1', section: 'identity', text: '称呼 RK，大肥鱼自称本鱼', pinned: true, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }],
  blocked: [],
}));
fs.writeFileSync(path.join(dataDir, 'chat-history.json'), JSON.stringify({
  version: 2, currentId: 'conversation-smoke',
  conversations: [{
    id: 'conversation-smoke', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), kind: 'normal',
    turns: [{
      id: 'turn-smoke', user: '看看任务', text: '已经在看。', status: 'completed',
      createdAt: new Date(now).toISOString(), model: 'smoke',
      taskRefs: [{ id: 'task-smoke', title: '查看工作台任务', tool: 'dsh', status: 'running' }],
    }],
  }],
}));

app.whenReady().then(async () => {
  try {
    const { createDispatcher, UI_ORIGIN } = await import(pathToFileURL(path.join(root, 'runtime', 'dispatcher.mjs')));
    const dispatcher = createDispatcher({ dataDir, dshHome, monitor: false, autoRefresh: false });
    dispatcher.workbench.settings.save({ allowedRoots: [temp] });
    dispatcher.runner.createDraft({ tool: 'codex', prompt: '演示：检查工作台草稿', cwd: temp });
    session.defaultSession.protocol.handle('whale', async request => {
      const url = new URL(request.url);
      if (url.host !== 'widget') return new Response('', { status: 403 });
      const result = await dispatcher.dispatch(url.pathname + url.search, { method: request.method, body: ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer()), headers: Object.fromEntries(request.headers) });
      return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers: result.headers });
    });
    const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadURL(UI_ORIGIN + '/workbench.html');
    const until = async (source, label) => {
      for (let i = 0; i < 80; i++) {
        try { if (await win.webContents.executeJavaScript(source)) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(label);
    };
    const out = path.join(root, 'qa-output');
    fs.mkdirSync(out, { recursive: true });
    await until("document.querySelectorAll('.wb-row').length >= 3", 'workbench rows did not render');
    await until("document.querySelectorAll('.wb-draft').length >= 1", 'workbench draft did not render');
    await until("document.querySelectorAll('.wb-chat-task').length >= 1", 'chat task card did not render');
    const chatCard = await win.webContents.executeJavaScript("document.querySelector('.wb-chat-task')?.textContent || ''");
    const rows = await win.webContents.executeJavaScript("[...document.querySelectorAll('.wb-row')].map(row => row.textContent)");
    const drafts = await win.webContents.executeJavaScript("document.querySelectorAll('.wb-draft').length");
    const summary = await win.webContents.executeJavaScript("document.querySelector('#wb-summary').textContent");
    await win.webContents.executeJavaScript("[...document.querySelectorAll('#wb-detail button')].find(button => button.textContent === '生成摘要').click()");
    await until("document.querySelector('#wb-task-summary').textContent !== '还没有摘要。'", 'task summary did not render');
    const taskSummary = await win.webContents.executeJavaScript("document.querySelector('#wb-task-summary').textContent");
    const detail = await win.webContents.executeJavaScript("({ stage: document.querySelectorAll('.wb-stage-step').length, output: !!document.querySelector('.wb-output'), canvasTabs: document.querySelectorAll('.wb-canvas-tabs button').length })");
    await win.webContents.executeJavaScript("document.querySelector('[data-view=board]').click()");
    await until("document.querySelectorAll('.wb-board-card').length >= 3", 'board did not render');
    const board = await win.webContents.executeJavaScript("({ columns: document.querySelectorAll('.wb-board-col').length, cards: document.querySelectorAll('.wb-board-card').length })");
    win.show();
    await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await new Promise(resolve => setTimeout(resolve, 450));
    const boardState = await win.webContents.executeJavaScript("({ boardHidden: document.querySelector('#wb-board').hidden, detailHidden: document.querySelector('#wb-detail').hidden, active: document.querySelector('.wb-canvas-tabs button.on').dataset.view, rects: [...document.querySelectorAll('.wb-board-card')].slice(0,2).map(card => card.getBoundingClientRect().toJSON()) })");
    await win.webContents.capturePage();
    await new Promise(resolve => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(out, 'workbench-board.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('[data-view=timeline]').click()");
    await until("document.querySelectorAll('.wb-timeline-bar').length >= 3", 'timeline did not render');
    const timeline = await win.webContents.executeJavaScript("({ lanes: document.querySelectorAll('.wb-timeline-lane').length, bars: document.querySelectorAll('.wb-timeline-bar').length, ranges: document.querySelectorAll('.wb-timeline-tools button').length })");
    await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await new Promise(resolve => setTimeout(resolve, 450));
    const timelineState = await win.webContents.executeJavaScript("({ hidden: document.querySelector('#wb-timeline').hidden, active: document.querySelector('.wb-canvas-tabs button.on').dataset.view, bars: [...document.querySelectorAll('.wb-timeline-bar')].slice(0,3).map(bar => ({ text: bar.textContent, rect: bar.getBoundingClientRect().toJSON(), parent: { rect: bar.parentElement.getBoundingClientRect().toJSON(), position: getComputedStyle(bar.parentElement).position }, display: getComputedStyle(bar).display, opacity: getComputedStyle(bar).opacity, background: getComputedStyle(bar).backgroundColor, color: getComputedStyle(bar).color, zIndex: getComputedStyle(bar).zIndex, position: getComputedStyle(bar).position })) })");
    await win.webContents.capturePage();
    await new Promise(resolve => setTimeout(resolve, 120));
    fs.writeFileSync(path.join(out, 'workbench-timeline.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('#wb-palette-open').click()");
    await until("!document.querySelector('#wb-palette').hidden", 'command palette did not open');
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(out, 'workbench-palette.png'), (await win.webContents.capturePage()).toPNG());
    const palette = await win.webContents.executeJavaScript("document.querySelectorAll('.wb-palette-item').length");
    await win.webContents.executeJavaScript("document.querySelector('#wb-palette-input').value = '看板'; document.querySelector('#wb-palette-input').dispatchEvent(new Event('input'))");
    await until("[...document.querySelectorAll('.wb-palette-item')].some(item => item.textContent.includes('看板'))", 'command palette filter failed');
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.wb-palette-item')].find(item => item.textContent.includes('看板')).click()");
    await until("document.querySelector('#wb-palette').hidden && !document.querySelector('#wb-board').hidden", 'command palette did not switch view');
    await win.webContents.executeJavaScript("document.querySelector('[data-view=detail]').click()");
    await until("!document.querySelector('#wb-detail').hidden", 'detail view did not return');
    await win.webContents.executeJavaScript("document.querySelector('#wb-report-open').click()");
    await until("document.querySelector('#wb-report').open && document.querySelector('#wb-report-body').textContent !== '正在生成…'", 'daily report did not render');
    const report = await win.webContents.executeJavaScript("document.querySelector('#wb-report-body').textContent");
    await win.webContents.executeJavaScript("document.querySelector('#wb-report').close()");
    win.show();
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(out, 'workbench-tasks.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('[data-tab=settings]').click()");
    await until("!document.querySelector('[data-panel=settings]').hidden", 'settings tab did not open');
    await until("document.querySelector('#wb-roots') !== null", 'settings form missing');
    await new Promise(resolve => setTimeout(resolve, 300));
    await win.webContents.executeJavaScript("document.querySelector('[data-tab=memory]').click()");
    await until("!document.querySelector('[data-panel=memory]').hidden && document.querySelectorAll('.wb-memory-item').length >= 1", 'memory tab did not render');
    const tabs = await win.webContents.executeJavaScript("({settings: !document.querySelector('[data-panel=settings]').hidden, tasks: !document.querySelector('[data-panel=tasks]').hidden, memory: !document.querySelector('[data-panel=memory]').hidden})");
    const memory = await win.webContents.executeJavaScript("({ items: document.querySelectorAll('.wb-memory-item').length, budget: document.querySelector('#wb-memory-budget').textContent })");
    win.show();
    await new Promise(resolve => setTimeout(resolve, 300));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'workbench-smoke.png'), image.toPNG());
    fs.writeFileSync(path.join(out, 'workbench-smoke.json'), JSON.stringify({ rows, drafts, chatCard, summary, taskSummary, detail, board, boardState, timeline, timelineState, palette, report, tabs, memory, ok: true }, null, 2));
    console.log('workbench smoke passed:', rows.length, 'rows');
    win.destroy();
    await dispatcher.close();
    app.exit(0);
  } catch (error) {
    try { fs.mkdirSync(path.join(root, 'qa-output'), { recursive: true }); fs.writeFileSync(path.join(root, 'qa-output', 'workbench-smoke-error.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2)); } catch {}
    console.error(error);
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
