/**
 * OpenClicky desktop overlay (Electron shell) — the Clicky-style floating panel.
 *
 * Runs apps/server (the agent + UI) inside the overlay: frameless, draggable,
 * pinnable always-on-top, with a system-tray icon (HeyClicky behavior).
 *
 *   cd apps/desktop && npm install && npm start
 *
 * No environment needed: the panel's setup card configures the model once on
 * first launch (saved per-user). Env vars still win when set.
 * Packaging: ELECTRON_RUN_AS_NODE spawns the server through the Electron
 * binary so installed users need no separate Node runtime.
 */

const { app, BrowserWindow, Menu, Tray, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.OPENCLICKY_PORT || 4747;
let serverProcess = null;
let win = null;
let tray = null;

function iconPath() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'icon.png'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/** Repo root in dev; resources/app inside the packaged executable. */
function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..', '..');
}

function startServer() {
  const root = appRoot();
  const serverMain = path.join(root, 'apps', 'server', 'dist', 'src', 'main.js');
  serverProcess = spawn(process.execPath, [serverMain], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    cwd: root,
  });
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

function createTray() {
  const icon = iconPath();
  if (!icon) return; // tray is nice-to-have; window still works
  tray = new Tray(icon);
  tray.setToolTip('OpenClicky');
  tray.on('click', toggleWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / hide', click: toggleWindow },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.exit(0) },
    ]),
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 396,
    height: 620,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'OpenClicky',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipcMain.handle('openclicky:pin', (_e, on) => win.setAlwaysOnTop(!!on));
  ipcMain.handle('openclicky:hide', () => win.hide());

  // Hide to tray instead of closing (agent keeps running).
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Open external links in the system browser, never inside the overlay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  let loaded = false;
  let poll = null;
  const load = () => {
    if (loaded) return;
    loaded = true;
    win.loadURL(`http://localhost:${PORT}/`);
  };
  const startPoll = () => {
    if (poll) return;
    poll = setInterval(() => {
      fetch(`http://localhost:${PORT}/api/capabilities`)
        .then(() => {
          clearInterval(poll);
          poll = null;
          load();
        })
        .catch(() => {});
    }, 400);
  };
  // Server raced us (cold first start, AV scan): keep retrying politely.
  win.webContents.on('did-fail-load', () => {
    loaded = false;
    startPoll();
  });
  startPoll();
  // If the server isn't up yet, keep polling but show the window shell.
  setTimeout(() => {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
    load();
  }, 15000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.on('before-quit', () => {
      app.isQuitting = true;
      if (serverProcess) serverProcess.kill();
    });
    startServer();
    createTray();
    createWindow();
  });
}
