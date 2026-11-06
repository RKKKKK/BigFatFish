const path = require('node:path');

// The independent workbench window. It is created on first open, remembers
// its bounds in ui-state.json (the same dshw-* store the pet uses), and hides
// instead of closing so the app keeps running while it is not on screen.
const KEY = 'dshw-workbench';
const DEFAULT = { width: 1000, height: 640 };
const MIN = { width: 900, height: 620 };

function parse(value) {
  try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

function createWorkbenchWindow({ app, BrowserWindow, screen, root, origin, state, isQuitting = () => false }) {
  let win = null, saveTimer = null;

  const saved = () => parse(state.get()[KEY]);
  const themedBackground = () => '#02040a';

  function restoredBounds() {
    const value = saved();
    // Keep the restored window inside a 150% Windows desktop too; a maximized
    // first open lets the user see the whole cockpit before resizing.
    const width = Math.min(1000, Math.max(MIN.width, Math.round(Number(value.width) || DEFAULT.width)));
    const height = Math.min(640, Math.max(MIN.height, Math.round(Number(value.height) || DEFAULT.height)));
    const wanted = { x: Number(value.x), y: Number(value.y), width, height };
    const display = Number.isFinite(wanted.x) && Number.isFinite(wanted.y)
      ? screen.getDisplayMatching(wanted) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const w = Math.min(width, area.width), h = Math.min(height, area.height);
    let x = Number.isFinite(wanted.x) ? Math.round(wanted.x) : Math.round(area.x + (area.width - w) / 2);
    let y = Number.isFinite(wanted.y) ? Math.round(wanted.y) : Math.round(area.y + (area.height - h) / 2);
    x = Math.min(Math.max(x, area.x), area.x + area.width - w);
    y = Math.min(Math.max(y, area.y), area.y + area.height - h);
    const maximized = Number(value.version) >= 2 ? value.maximized === true : true;
    return { x, y, width: w, height: h, maximized };
  }

  function save() {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getNormalBounds?.() || win.getBounds();
    const values = state.get();
    state.set({ ...values, [KEY]: JSON.stringify({ ...bounds, maximized: win.isMaximized(), version: 2 }) });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 250);
    saveTimer.unref?.();
  }

  function create() {
    const bounds = restoredBounds();
    if (process.platform === 'darwin') { try { app.focus({ steal: true }); } catch {} }
    win = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      minWidth: MIN.width, minHeight: MIN.height,
      show: false, frame: false, title: '工作台', backgroundColor: themedBackground(), autoHideMenuBar: true,
      icon: path.join(root, 'assets', 'DSniang1.png'),
      webPreferences: { preload: path.join(__dirname, 'workbench-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    win.setMenuBarVisibility(false);
    try {
      const scale = screen.getDisplayMatching(bounds).scaleFactor || 1;
      if (scale > 1.2) win.webContents.setZoomFactor(0.8);
    } catch {}
    const reveal = () => {
      if (!win || win.isDestroyed()) return;
      if (bounds.maximized && !win.isMaximized()) win.maximize();
      if (!win.isVisible()) { win.show(); win.focus(); }
    };
    win.once('ready-to-show', reveal);
    if (typeof win.webContents.once === 'function') win.webContents.once('did-finish-load', reveal);
    const revealFallback = setTimeout(reveal, 1500);
    revealFallback.unref?.();
    win.on('resize', scheduleSave);
    win.on('move', scheduleSave);
    win.on('close', event => {
      if (!isQuitting()) { event.preventDefault(); save(); win.hide(); }
    });
    win.on('closed', () => { win = null; clearTimeout(saveTimer); saveTimer = null; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(origin + '/workbench.html')) event.preventDefault();
    });
    win.loadURL(origin + '/workbench.html').catch(() => {});
    reveal();
  }

  function show() {
    if (!win || win.isDestroyed()) create();
    else {
      if (win.isMinimized()) win.restore();
      try { win.setAlwaysOnTop(true); } catch {}
      win.show(); win.moveTop?.(); win.focus();
      try { win.setAlwaysOnTop(false); } catch {}
    }
  }

  function hide() { if (win && !win.isDestroyed()) win.hide(); }

  function toggle() {
    if (win && !win.isDestroyed() && win.isVisible()) hide();
    else show();
  }

  function destroy() {
    clearTimeout(saveTimer); saveTimer = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  return { show, hide, toggle, destroy, send, save, window: () => win };
}

module.exports = { createWorkbenchWindow, WORKBENCH_KEY: KEY };
