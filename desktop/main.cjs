const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, globalShortcut, shell, protocol, session, net, dialog, safeStorage, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createWorkbenchWindow } = require('./workbench-window.cjs');
const { UiStateStore } = require('./ui-state-store.cjs');
const { desktopArea, desktopBoundsSync } = require('./desktop-bounds.cjs');
const { KeychainVault } = require('./macos/keychain-vault.cjs');
const { shutdownCompanion } = require('./lifecycle.cjs');
const { externalWebUrl } = require('./external-links.cjs');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const dataDir = process.argv.find(a => a.startsWith('--whale-data='))?.slice(13);
const fixture = process.env.WHALE_DESKTOP_TEST === '1';
// A pipe error from a short-lived helper (for example reg.exe) must not pop
// Electron's fatal "JavaScript error in the main process" dialog.
process.on('uncaughtException', error => {
  try { fs.appendFileSync(path.join(dataDir || '.', 'main-errors.log'), new Date().toISOString() + ' ' + (error?.stack || error) + '\n'); } catch {}
});
process.on('unhandledRejection', error => {
  try { fs.appendFileSync(path.join(dataDir || '.', 'main-errors.log'), new Date().toISOString() + ' rejection ' + (error?.stack || error) + '\n'); } catch {}
});
const startupAt = Date.now();
const startup = { revision: 'free-desktop-v1', requestedAt: Number(process.env.WHALE_LAUNCH_TIME) || startupAt, mainAt: startupAt, phases: {} };
const markStartup = phase => { if (startup.phases[phase] == null) startup.phases[phase] = Date.now() - startup.requestedAt; };
markStartup('main');
const isMac = process.platform === 'darwin';
// Leave device/driver safety checks to Chromium; do not bypass the GPU blocklist.
app.commandLine.appendSwitch('enable-gpu-rasterization');
if (!dataDir || !path.isAbsolute(dataDir) || (!fixture && !process.argv.includes('--supervised'))) app.exit(1);
protocol.registerSchemesAsPrivileged([{ scheme: 'whale', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
fs.mkdirSync(path.join(dataDir, 'desktop-profile'), { recursive: true });
app.setPath('userData', path.join(dataDir, 'desktop-profile'));
const lock = app.requestSingleInstanceLock();
let window, tray, dispatcher, bridge, workbenchWindow = null, rendererReady = false, quitting = false, manuallyHidden = false;
const rendererErrors = [];
const fixtureOpenedLinks = [];
const stateFile = path.join(dataDir, 'ui-state.json');
const read = (f, fallback = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } };
const save = (file, value) => { const temp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); };
const uiStore = new UiStateStore(stateFile);
const values = () => uiStore.get();
// The workbench window owns dshw-workbench; the pet's localStorage copy can be
// older, so it must not overwrite the fresh bounds saved on move/close.
const storeValues = input => {
  const next = { ...(input || {}) };
  delete next['dshw-workbench'];
  uiStore.set({ ...uiStore.get(), ...next });
};
let gpuStatus = null, inputEnabled = false, keyboardFocus = false, testCursor = null, lastCursor = '', presents = 0;
const pendingCommands = [];
let pendingApprovalNotice = false, lastApprovalNoticeAt = 0;
let trustedGestureAt = 0;
app.on('gpu-info-update', () => {
  gpuStatus = { hardwareAcceleration: app.isHardwareAccelerationEnabled(), features: app.getGPUFeatureStatus(), electron: process.versions.electron, chromium: process.versions.chrome };
  fs.promises.writeFile(path.join(dataDir, 'render-status.json'), JSON.stringify(gpuStatus, null, 2)).catch(() => {});
});
function invalidate() { if (window && !window.isDestroyed()) { presents++; window.webContents.invalidate(); } }
function setKeyboardFocus(editing) {
  if (!window || window.isDestroyed()) return;
  keyboardFocus = editing;
  if (editing) {
    // A key window in an accessory app can accept ASCII without activating the native IME client.
    if (isMac && !app.isActive()) app.focus({ steal: true });
    if (!window.isFocused()) window.focus();
  }
}
function sendCursor(force = false) {
  if (!window || window.isDestroyed() || !rendererReady || !window.isVisible()) return;
  const bounds = window.getContentBounds(), cursor = screen.getCursorScreenPoint();
  const point = fixture && testCursor ? testCursor : { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  const encoded = point.x + ',' + point.y;
  if (force || encoded !== lastCursor) { lastCursor = encoded; window.webContents.send('whale-cursor', point); }
}
function setTestCursor(point) { if (fixture) { testCursor = point; sendCursor(true); } }
function visibility() {
  if (!window || window.isDestroyed()) return;
  if (rendererReady && !manuallyHidden) {
    if (!window.isVisible()) window.showInactive();
    if (startup.phases.interactive == null) {
      markStartup('interactive');
      fs.promises.writeFile(path.join(dataDir, 'startup-timings.json'), JSON.stringify(startup, null, 2)).catch(() => {});
    }
  } else window.hide();
}
function show() { manuallyHidden = false; visibility(); }
function toggle() { manuallyHidden = !manuallyHidden; visibility(); }
function sendCommand(command) {
  if (!window || window.isDestroyed() || !command) return false;
  show();
  if (rendererReady) window.webContents.send('whale-command', command);
  else if (!pendingCommands.includes(command)) pendingCommands.push(command);
  return true;
}
function openChatShortcut() { sendCommand('chat'); }
function flushCommands() {
  if (!rendererReady || !window || window.isDestroyed()) return;
  for (const command of pendingCommands.splice(0)) window.webContents.send('whale-command', command);
  if (pendingApprovalNotice) { pendingApprovalNotice = false; window.webContents.send('whale-approval-request'); }
}
function notifyApprovalRequest(info = {}) {
  try { dispatcher?.agents?.codexApproval(info); } catch {}
  if (!window || window.isDestroyed() || Date.now() - lastApprovalNoticeAt < 750) return;
  lastApprovalNoticeAt = Date.now();
  show();
  if (rendererReady) window.webContents.send('whale-approval-request');
  else pendingApprovalNotice = true;
}
async function showStatusDialog() {
  let account = null;
  try { const snapshot = dispatcher?.book?.snapshot(); account = snapshot?.accounts.find(item => item.id === snapshot.current) || null; } catch {}
  const lines = [
    '平台：' + process.platform,
    '挂件窗口：' + (window?.isVisible?.() ? '显示' : '隐藏'),
    '当前额度：' + (account ? account.name + (account.type === 'subscription' ? ' 订阅' : '') : '暂无'),
    ...(account?.host ? ['API 地址：' + account.host] : []),
  ];
  await dialog.showMessageBox({
    type: 'info',
    title: '挂件运行状态',
    message: 'API 余额小鲸鱼',
    detail: lines.join('\n'),
    buttons: ['关闭'],
  });
}
// The desktop service leaves a stopped pet alone until the start command removes
// this marker; its name dates from the retired window-follow mode.
function pauseAndQuit() {
  save(path.join(dataDir, 'pause-until-host-exit.json'), { pauseAll: true });
  app.quit();
}
function isMainFrame(event) { return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame; }
async function openWebLink(value, gestureRequired = true) {
  if (gestureRequired && (!trustedGestureAt || Date.now() - trustedGestureAt > 1000)) return false;
  trustedGestureAt = 0;
  let target = value;
  if (value === 'whale://widget/provider-dashboard') {
    try { target = dispatcher.book.dashboardUrl(); } catch { return false; }
  }
  const url = externalWebUrl(target);
  if (!url) return false;
  try {
    if (fixture) fixtureOpenedLinks.push(url);
    else await shell.openExternal(url);
    return true;
  } catch { return false; }
}
async function importLegacyStorage() {
  const marker = path.join(dataDir, 'legacy-storage-imported.json');
  if (fs.existsSync(marker) || fixture) return;
  const legacy = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  session.defaultSession.protocol.handle('http', request => new Response(request.url.startsWith('http://127.0.0.1:47321/') ? '<!doctype html><title>Local migration</title>' : '', { status: request.url.startsWith('http://127.0.0.1:47321/') ? 200 : 403, headers: { 'Content-Type': 'text/html' } }));
  try {
    await legacy.loadURL('http://127.0.0.1:47321/');
    const old = await legacy.webContents.executeJavaScript("Object.fromEntries(Object.keys(localStorage).filter(k => /^dshw[-v]/.test(k)).map(k => [k, localStorage.getItem(k)]))");
    storeValues({ ...old, ...values() }); save(marker, { complete: true, at: new Date().toISOString() });
  } finally { legacy.destroy(); session.defaultSession.protocol.unhandle('http'); }
}

if (!lock) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    markStartup('appReady');
    const { createDispatcher, UI_ORIGIN } = await import(pathToFileURL(path.join(root, 'runtime', 'dispatcher.mjs')));
    const { startBridge } = await import(pathToFileURL(path.join(root, 'runtime', 'bridge.mjs')));
    let testOptions = {};
    const secretVault = new KeychainVault({ dataDir, safeStorage });
    if (fixture) { const { makeFixture } = await import(pathToFileURL(path.join(root, 'tests', 'desktop-fixture.mjs'))); testOptions = await makeFixture(dataDir, { secretVault }); }
    dispatcher = createDispatcher({ dataDir, secretVault, dshHome: fixture ? null : (process.env.DSH_HOME || path.join(os.homedir(), '.dsh')), fetchImpl: (url, options) => net.fetch(url, options), onStop: pauseAndQuit, onShow: show,
      onOpenWorkbench: () => { workbenchWindow?.show(); return !!workbenchWindow; },
      onChatNotice: notice => { if (notice.kind === 'pomodoro') show(); },
      onWorkNotice: notice => {
        if (quitting || !notice?.task) return;
        show();
        if (rendererReady && window && !window.isDestroyed()) window.webContents.send('whale-work-notice', { task: notice.task });
      },
      // Present: a key or mouse event in the last 15 minutes and the screen not locked.
      statusInfo: () => ({ platform: process.platform, visible: !!window?.isVisible(), present: !['idle', 'locked'].includes(powerMonitor.getSystemIdleState(15 * 60)), keyVault: secretVault.available(), startup, rendering: gpuStatus }), ...testOptions });
    markStartup('dispatcherReady');
    workbenchWindow = createWorkbenchWindow({ app, BrowserWindow, screen, root, origin: UI_ORIGIN, state: uiStore, isQuitting: () => quitting });
    ipcMain.on('workbench-command', (event, command) => {
      const target = workbenchWindow?.window();
      if (!target || target.isDestroyed() || event.sender !== target.webContents) return;
      if (command === 'close' || command === 'hide') target.hide();
      else if (command === 'show') { target.show(); target.focus(); }
      else if (command === 'minimize') target.minimize();
      else if (command === 'maximize') { if (target.isMaximized()) target.unmaximize(); else target.maximize(); }
    });
    await importLegacyStorage();
    session.defaultSession.protocol.handle('whale', async request => {
      const url = new URL(request.url);
      if (url.host !== 'widget') return new Response('', { status: 403 });
      const result = await dispatcher.dispatch(url.pathname + url.search, { method: request.method, body: ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer()), headers: Object.fromEntries(request.headers), signal: request.signal });
      return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers: result.headers });
    });
    const area = desktopArea(screen) || screen.getPrimaryDisplay().workArea;
    // On macOS a click must not activate the app: the first activation of the
    // process being a click leaves Pinyin and other input methods detached, so
    // Chinese types Latin letters until the app activates itself. The panel type
    // makes clicks non-activating; surfaces that need the keyboard activate the
    // app through setKeyboardFocus.
    // WS_EX_TOOLWINDOW keeps the large transparent overlay out of Chromium's
    // native occlusion calculation even while its opaque pixels accept clicks.
    // Keep normal activation: Chromium's non-client handler consumes the first
    // mouse down (MA_NOACTIVATEANDEAT) when CanActivate/focusable is false.
    window = new BrowserWindow({ ...area, ...(isMac ? { acceptFirstMouse: true, type: 'panel' } : { type: 'toolbar' }), transparent: true, frame: false, thickFrame: false, resizable: false, maximizable: false, fullscreenable: false, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true, show: false, title: 'API 余额小鲸鱼', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', additionalArguments: fixture ? ['--whale-render-test'] : [] } });
    if (isMac) {
      if (app.dock) app.dock.hide();
      window.setAlwaysOnTop(true, 'floating', 1);
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    } else window.setAlwaysOnTop(true, 'floating');
    markStartup('windowCreated');
    window.once('ready-to-show', () => markStartup('frameReady'));
    if (fixture) window.webContents.on('console-message', (_event, ...args) => { const d = args[0]; if (typeof d === 'object' ? d.level === 'error' : d === 3) rendererErrors.push(typeof d === 'object' ? d.message : args[1]); });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on('show', () => { invalidate(); sendCursor(true); });
    window.on('resize', invalidate);
    let testViewport = false;
    const syncBounds = desktopBoundsSync(screen, window);
    const syncDesktop = () => { if (!testViewport && syncBounds()) { invalidate(); sendCursor(true); } };
    const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
    for (const event of displayEvents) screen.on(event, syncDesktop);
    app.once('will-quit', () => { for (const event of displayEvents) screen.off(event, syncDesktop); });
    // Restoring or showing the window from outside the pet lands on the user's
    // choice at once; the watchdog below re-applies it every second.
    window.on('restore', visibility);
    window.on('show', visibility);
    // A dead renderer would otherwise leave rendererReady false forever, because
    // until 0.2.0 nothing observed the crash.
    window.webContents.on('render-process-gone', (_event, details) => {
      rendererReady = false; inputEnabled = false;
      try { window.setIgnoreMouseEvents(true, { forward: true }); } catch {}
      try { fs.writeFileSync(path.join(dataDir, 'renderer-gone.json'), JSON.stringify({ at: new Date().toISOString(), reason: details?.reason || 'unknown' }, null, 2)); } catch {}
      if (!quitting && !window.isDestroyed()) setTimeout(() => { if (!window.isDestroyed()) window.webContents.reload(); }, 500);
    });
    window.webContents.on('did-start-loading', () => {
      rendererReady = false; inputEnabled = false;
      setKeyboardFocus(false);
      window.setIgnoreMouseEvents(true, { forward: true });
    });
    window.webContents.setWindowOpenHandler(({ url }) => { openWebLink(url).catch(() => {}); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(UI_ORIGIN + '/')) event.preventDefault(); });
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    ipcMain.on('whale-storage', event => { event.returnValue = event.sender === window.webContents ? values() : {}; });
    ipcMain.on('whale-save-storage', (event, input) => { if (event.sender === window.webContents) storeValues(input); });
    ipcMain.on('whale-user-gesture', event => { if (isMainFrame(event)) trustedGestureAt = Date.now(); });
    ipcMain.handle('whale-open-external', (event, url) => isMainFrame(event) ? openWebLink(url) : false);
    ipcMain.handle('whale-command', async (event, command) => {
      if (!isMainFrame(event)) return false;
      if (command === 'status') { await showStatusDialog(); return true; }
      if (command === 'stop') { pauseAndQuit(); return true; }
      if (command === 'workbench') { workbenchWindow?.show(); return true; }
      if (['balance', 'usage', 'settings'].includes(command)) return sendCommand(command);
      return false;
    });
    ipcMain.on('whale-ready', event => {
      if (event.sender !== window.webContents) return;
      markStartup('imageAndInputReady');
      try { fs.rmSync(path.join(dataDir, 'desktop-error.json'), { force: true }); } catch {}
      rendererReady = true; visibility(); flushCommands(); invalidate(); sendCursor(true);
    });
    ipcMain.on('whale-interactive', (event, enabled) => {
      if (event.sender !== window.webContents || typeof enabled !== 'boolean' || enabled === inputEnabled) return;
      inputEnabled = enabled;
      window.setIgnoreMouseEvents(!enabled, { forward: true });
    });
    ipcMain.on('whale-keyboard-focus', (event, editing) => {
      if (event.sender === window.webContents && typeof editing === 'boolean') setKeyboardFocus(editing);
    });
    const cursorPoll = setInterval(sendCursor, 50);
    const visibilityWatchdog = setInterval(() => { syncDesktop(); visibility(); }, 1000);
    visibilityWatchdog.unref?.();
    app.once('will-quit', () => { clearInterval(cursorPoll); clearInterval(visibilityWatchdog); });
    const icon = nativeImage.createFromPath(path.join(root, 'assets', 'DSniang1.png')).resize({ width: 24, height: 24 });
    tray = new Tray(icon); tray.setToolTip('API 余额小鲸鱼');
    const chatShortcutAvailable = isMac && globalShortcut.register('Control+0', openChatShortcut);
    const trayTemplate = [{ label: '显示 / 隐藏小鲸鱼', click: toggle }, { label: '打开工作台', click: () => workbenchWindow?.show() }];
    if (isMac) {
      trayTemplate.push({ label: '命令', submenu: [
        { label: chatShortcutAvailable ? '打开会话（Ctrl+0）' : '打开会话（Ctrl+0 被占用）', click: openChatShortcut },
        { label: '刷新额度', accelerator: 'Command+R', click: () => sendCommand('balance') },
        { label: '查看用量记录', click: () => sendCommand('usage') },
        { label: '查看运行状态', click: () => { void showStatusDialog(); } },
        { type: 'separator' },
        { label: '额度管理', click: () => sendCommand('settings') },
        { label: '停止当前挂件', click: pauseAndQuit },
      ] });
    } else {
      trayTemplate.push({ label: '额度管理', click: () => { show(); window.webContents.send('whale-settings'); } });
    }
    trayTemplate.push({ type: 'separator' }, { label: '停止挂件（可从启动命令恢复）', click: pauseAndQuit });
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate));
    tray.on('double-click', toggle); globalShortcut.register(isMac ? 'Command+Option+W' : 'Control+Alt+W', toggle);
    bridge = await startBridge(dispatcher, { dataDir, onApprovalRequest: notifyApprovalRequest });
    markStartup('bridgeReady');
    await window.loadURL(UI_ORIGIN + '/widget.html');
    markStartup('pageLoaded');
    if (fixture) {
      const fixtureModule = process.env.WHALE_DESKTOP_AUDIT === '1' ? 'desktop-audit-fixture.mjs' : 'desktop-fixture.mjs';
      const { verifyDesktop } = await import(pathToFileURL(path.join(root, 'tests', fixtureModule)));
      await verifyDesktop({ app, window, screen, setTestCursor, setTestViewport: bounds => { testViewport = !!bounds; if (bounds) window.setBounds(bounds); else syncDesktop(); }, dispatcher, dataDir, errors: rendererErrors, openedLinks: fixtureOpenedLinks, activateChatShortcut: openChatShortcut, chatShortcutAvailable, renderInfo: () => ({ gpuStatus, presents, inputEnabled, keyboardFocus }) });
    }
  }).catch(error => { try { save(path.join(dataDir, 'desktop-error.json'), { message: String(error.message).slice(0, 350), at: new Date().toISOString() }); } catch {} app.exit(1); });
  app.on('window-all-closed', () => { if (!quitting && rendererReady) app.quit(); });
  app.on('before-quit', event => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Do not leave an unresponsive input surface over the desktop while saving state.
    try { if (window && !window.isDestroyed()) { window.setIgnoreMouseEvents(true); window.hide(); } } catch {}
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      try { workbenchWindow?.destroy(); } catch {}
      globalShortcut.unregisterAll(); tray?.destroy();
      // Cleanup above replaces renderer beforeunload: an unresponsive renderer
      // must not be asked to approve quitting a second time.
      app.exit(0);
    };
    const watchdog = setTimeout(finish, 6500);
    try { workbenchWindow?.save(); } catch {}
    shutdownCompanion({
      readRenderer: () => window && !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed?.()
        ? window.webContents.executeJavaScript("Object.fromEntries(Object.keys(localStorage).filter(k => /^dshw[-v]/.test(k)).map(k => [k, localStorage.getItem(k)]))") : null,
      saveRenderer: storeValues,
      flushState: () => uiStore.flush(),
      closeBridge: () => bridge?.close(),
      closeDispatcher: () => dispatcher?.close(),
    }).then(result => {
      try { save(path.join(dataDir, 'desktop-shutdown.json'), { at: new Date().toISOString(), ...result }); } catch {}
    }).catch(() => {}).finally(() => { clearTimeout(watchdog); finish(); });
  });
}
