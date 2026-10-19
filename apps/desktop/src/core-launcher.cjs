'use strict';
// Arranca (o reutiliza) el Core. El Core se lanza como proceso DESACOPLADO con el Node del sistema
// (no con el de Electron: better-sqlite3 y node-pty están compilados para el Node del sistema).
// Cerrar la app NO detiene el Core (CA-03: terminales y agentes sobreviven al cliente).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_PORT = 47821;

function dataDir(env = process.env) {
  if (env.AIW_DATA_DIR) return env.AIW_DATA_DIR;
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AIWorkspace');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AIWorkspace');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aiworkspace');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isHealthy(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    return body && body.ok === true;
  } catch {
    return false;
  }
}

function findNode(env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, 'node' + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* siguiente */
      }
    }
  }
  return null;
}

function readToken(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'api-token'), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Devuelve { port, token, started } o lanza un Error con un mensaje accionable. */
async function ensureCore({ port = DEFAULT_PORT, env = process.env, healthy = isHealthy, spawnFn = spawn, waitMs = 20000 } = {}) {
  const dir = dataDir(env);
  let started = false;
  if (!(await healthy(port))) {
    const node = findNode(env);
    if (!node) throw new Error('No se encontró Node.js en el PATH; el Core necesita el Node del sistema.');
    fs.mkdirSync(dir, { recursive: true });
    const logFd = fs.openSync(path.join(dir, 'core.log'), 'a');
    const child = spawnFn(node, ['--import', 'tsx', path.join(REPO_ROOT, 'services', 'core', 'src', 'main.ts')], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...env, AIW_PORT: String(port) },
    });
    child.unref();
    started = true;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !(await healthy(port))) await sleep(250);
    if (!(await healthy(port))) throw new Error(`El Core no respondió en ${waitMs / 1000} s. Revisa ${path.join(dir, 'core.log')}`);
  }
  const token = readToken(dir);
  if (!token) throw new Error(`No se encontró el token de la API en ${path.join(dir, 'api-token')}`);
  return { port, token, started };
}

module.exports = { ensureCore, isHealthy, findNode, dataDir, DEFAULT_PORT };
