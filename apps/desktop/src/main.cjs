'use strict';
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { createProxy } = require('./api-proxy.cjs');
const { ensureCore } = require('./core-launcher.cjs');

let request = null;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'AI Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // La interfaz es local y fija: no se navega ni se abren ventanas nuevas.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('core:request', async (_e, method, pathAndQuery, body) => {
  if (!request) return { status: 503, body: { error: { code: 'core-unavailable', message: 'El Core no está listo' } } };
  if (typeof method !== 'string' || typeof pathAndQuery !== 'string') return { status: 400, body: null };
  try {
    return await request(method, pathAndQuery, body);
  } catch (e) {
    return { status: 502, body: { error: { code: 'core-unreachable', message: String(e && e.message ? e.message : e) } } };
  }
});

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    const core = await ensureCore();
    request = createProxy({ port: core.port, token: core.token });
  } catch (e) {
    dialog.showErrorBox('AI Workspace', String(e && e.message ? e.message : e));
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cerrar la ventana cierra la app, pero NO el Core (agentes y terminales siguen vivos).
app.on('window-all-closed', () => app.quit());
