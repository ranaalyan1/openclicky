// Preload: the only bridge between the panel UI and the shell.
// contextIsolation stays ON and nodeIntegration OFF — the web page gets
// exactly these methods and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openclickyShell', {
  /** toggle always-on-top (the pin button) */
  pin: (on) => ipcRenderer.invoke('openclicky:pin', on),
  /** hide the overlay into the tray */
  hide: () => ipcRenderer.invoke('openclicky:hide'),
  platform: process.platform,
  isElectron: true,
});
