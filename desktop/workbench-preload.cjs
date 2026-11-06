const { contextBridge, ipcRenderer } = require('electron');

// The workbench is frameless; its own title bar sends these commands. The main
// process checks that the sender is the workbench window before acting.
contextBridge.exposeInMainWorld('whaleWorkbench', {
  platform: process.platform,
  command: name => ipcRenderer.send('workbench-command', String(name || '')),
});
