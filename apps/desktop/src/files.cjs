'use strict';
// Acceso a archivos de un proyecto para el panel Editor. El renderer solo envía rutas RELATIVAS a la raíz de un
// proyecto registrado: aquí se comprueba (con rutas reales, resolviendo enlaces simbólicos) que nunca salgan de ella.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const HIDDEN_DIRS = new Set(['.git', 'node_modules']);

class FileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Resuelve `rel` dentro de `root`. Devuelve la ruta absoluta real. Lanza FileError('outside') si escapa. */
function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new FileError('invalid', 'Ruta no válida');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) throw new FileError('outside', 'Solo se admiten rutas dentro del proyecto');
  const realRoot = fs.realpathSync(root);
  const joined = path.resolve(realRoot, rel);
  if (!isInside(realRoot, joined)) throw new FileError('outside', 'La ruta sale del proyecto');
  // Si existe, su ruta real (tras seguir enlaces) debe seguir dentro; si no existe, su carpeta padre real.
  let probe = joined;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!isInside(realRoot, fs.realpathSync(probe))) throw new FileError('outside', 'La ruta sale del proyecto (enlace simbólico)');
  return { abs: joined, realRoot };
}

const relOf = (realRoot, abs) => path.relative(realRoot, abs).split(path.sep).join('/');
const insideGit = (rel) => rel.split('/').some((p) => p.toLowerCase() === '.git');

function listDir(root, rel = '') {
  const { abs, realRoot } = resolveInside(root, rel);
  const entries = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory() && HIDDEN_DIRS.has(d.name)) continue;
    const full = path.join(abs, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      // los enlaces solo se muestran si apuntan dentro del proyecto
      try {
        if (!isInside(realRoot, fs.realpathSync(full))) continue;
        isDir = fs.statSync(full).isDirectory();
      } catch { continue; }
    }
    let size = 0;
    if (!isDir) { try { size = fs.statSync(full).size; } catch { /* ilegible */ } }
    entries.push({ name: d.name, type: isDir ? 'dir' : 'file', size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

function readFile(root, rel) {
  const { abs } = resolveInside(root, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new FileError('not-file', 'No es un archivo');
  if (st.size > MAX_BYTES) throw new FileError('too-big', 'El archivo supera 2 MB');
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) throw new FileError('binary', 'Es un archivo binario');
  return { content: buf.toString('utf8'), size: st.size, mtimeMs: st.mtimeMs };
}

/** Escribe `content`. Con expectedMtimeMs detecta que el archivo cambió en disco desde que se abrió. */
function writeFile(root, rel, content, opts = {}) {
  const { abs, realRoot } = resolveInside(root, rel);
  if (insideGit(relOf(realRoot, abs))) throw new FileError('forbidden', 'No se puede escribir dentro de .git');
  if (typeof content !== 'string') throw new FileError('invalid', 'Contenido no válido');
  if (Buffer.byteLength(content) > MAX_BYTES) throw new FileError('too-big', 'El contenido supera 2 MB');
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new FileError('not-file', 'No es un archivo');
    if (Number.isFinite(opts.expectedMtimeMs) && Math.abs(st.mtimeMs - opts.expectedMtimeMs) > 1 && !opts.force) {
      throw new FileError('conflict', 'El archivo cambió en disco desde que lo abriste');
    }
  } else if (!fs.existsSync(path.dirname(abs))) {
    throw new FileError('missing-dir', 'La carpeta no existe');
  }
  const tmp = `${abs}.aiw-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
  const st = fs.statSync(abs);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

module.exports = { listDir, readFile, writeFile, resolveInside, FileError, MAX_BYTES };
