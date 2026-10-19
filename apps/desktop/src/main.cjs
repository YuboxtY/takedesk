'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const { createProxy } = require('./api-proxy.cjs');
const { ensureCore } = require('./core-launcher.cjs');
const { createTerminalBridge } = require('./terminal-bridge.cjs');
const { sanitizeWorkspace } = require('./workspace.cjs');
const backgrounds = require('./backgrounds.cjs');

const BROWSER_PARTITION = 'persist:aiw-browser';
const isWeb = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

let request = null;
let bridge = null;
let win = null;

// Workspace: qué proyecto/run/terminal estaba abierto. Se guarda en userData (no en el repo).
const workspaceFile = () => path.join(app.getPath('userData'), 'workspace.json');
function loadWorkspace() {
  try {
    const w = JSON.parse(fs.readFileSync(workspaceFile(), 'utf8'));
    return sanitizeWorkspace(w);
  } catch {
    return {};
  }
}
function saveWorkspace(w) {
  fs.mkdirSync(path.dirname(workspaceFile()), { recursive: true });
  fs.writeFileSync(workspaceFile(), JSON.stringify(sanitizeWorkspace(w)));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'AI Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      webviewTag: true, // solo para el panel Navegador; cada webview se endurece en will-attach-webview
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
  // Cada <webview> (panel Navegador) se fuerza a un perfil propio, sin Node, sin preload y solo http/https.
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    params.partition = BROWSER_PARTITION;
    // allowpopups hace que Electron consulte setWindowOpenHandler (que SIEMPRE deniega y lo convierte en pestaña);
    // sin el atributo las ventanas nuevas se descartan antes de poder abrirlas como pestaña.
    params.allowpopups = 'true';
    if (params.src && !isWeb(params.src) && params.src !== 'about:blank') e.preventDefault();
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

const sendToWindow = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

const needBridge = () => {
  if (!bridge) throw new Error('El Core no está listo');
  return bridge;
};
ipcMain.handle('term:list', () => needBridge().list());
ipcMain.handle('term:open', (_e, projectId, cols, rows) => needBridge().open(String(projectId), Number(cols) || 120, Number(rows) || 30));
ipcMain.handle('term:attach', (_e, id) => needBridge().attach(String(id)));
ipcMain.handle('term:kill', (_e, id) => needBridge().kill(String(id)));
ipcMain.on('term:input', (_e, id, data) => bridge && bridge.input(String(id), data));
ipcMain.on('term:resize', (_e, id, cols, rows) => bridge && bridge.resize(String(id), cols, rows));
ipcMain.handle('workspace:load', () => loadWorkspace());
ipcMain.handle('workspace:save', (_e, w) => saveWorkspace(w && typeof w === 'object' ? w : {}));

const bgDir = () => path.join(app.getPath('userData'), 'backgrounds');
ipcMain.handle('bg:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  if (backgrounds.listImages(bgDir()).length >= 12) return { error: 'Ya hay 12 imágenes guardadas: elimina alguna (×) antes de añadir otra.' };
  try {
    return { name: backgrounds.saveImage(r.filePaths[0], bgDir()) };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
});
ipcMain.handle('bg:load', (_e, name) => backgrounds.loadImage(bgDir(), name));
ipcMain.handle('bg:list', () => backgrounds.listImages(bgDir()));
ipcMain.handle('bg:remove', (_e, name) => backgrounds.removeImage(bgDir(), name));

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Páginas web embebidas: nunca navegan a file:, javascript: u otros esquemas; las ventanas nuevas se abren como
// pestañas del propio panel; sin descargas ni permisos (cámara, micrófono, ubicación, notificaciones).
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) sendToWindow('browser:open-tab', contents.id, url);
    return { action: 'deny' };
  });
  const guard = (e, url) => { if (!isWeb(url) && url !== 'about:blank') e.preventDefault(); };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
});

ipcMain.handle('browser:openExternal', async (_e, url) => {
  if (!isWeb(url)) return false;
  await shell.openExternal(url);
  return true;
});

app.whenReady().then(async () => {
  const web = session.fromPartition(BROWSER_PARTITION);
  web.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  web.setPermissionCheckHandler(() => false);
  web.on('will-download', (ev, item) => { ev.preventDefault(); sendToWindow('browser:blocked', `Descarga bloqueada: ${item.getFilename()}`); });
  // Sin menú de aplicación: sus aceleradores (Ctrl+W, Ctrl+R, F12…) chocarían con los atajos del lienzo y de los terminales.
  Menu.setApplicationMenu(null);
  try {
    const core = await ensureCore({ port: Number(process.env.AIW_PORT) || undefined });
    request = createProxy({ port: core.port, token: core.token });
    bridge = createTerminalBridge({ request: createProxy({ port: core.port, token: core.token, internal: true }), port: core.port, send: sendToWindow });
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
// Solo se sueltan los sockets: los terminales siguen vivos en el Core.
app.on('before-quit', () => bridge && bridge.dispose());
