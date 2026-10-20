'use strict';
// Lanzador de apps del equipo. Lista CERRADA: el renderer solo puede pedir un id de esta tabla; el ejecutable y los
// argumentos los fija este módulo (el único dato variable es la raíz de un proyecto registrado en el Core).
const fs = require('node:fs');
const path = require('node:path');

function catalog({ platform = process.platform, env = process.env, exists = fs.existsSync, root }) {
  if (platform !== 'win32') {
    const opener = platform === 'darwin' ? 'open' : 'xdg-open';
    return [{ id: 'explorer', label: 'Abrir carpeta del proyecto', exe: opener, args: [root], cwd: root, available: true }];
  }
  const local = env.LOCALAPPDATA || '';
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const sys = env.SystemRoot || 'C:\\Windows';
  const firstExisting = (list) => list.find((p) => p && exists(p));
  const code = firstExisting([path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')]);
  const wt = firstExisting([path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe')]);
  const entries = [
    { id: 'vscode', label: 'VS Code', exe: code, args: [root], cwd: root },
    { id: 'explorer', label: 'Explorador de archivos', exe: path.join(sys, 'explorer.exe'), args: [root], cwd: root },
    { id: 'wt', label: 'Terminal de Windows', exe: wt, args: ['-d', root], cwd: root },
    { id: 'powershell', label: 'PowerShell (ventana aparte)', exe: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoExit'], cwd: root },
    { id: 'notepad', label: 'Bloc de notas', exe: path.join(sys, 'notepad.exe'), args: [], cwd: root },
  ];
  return entries.map((e) => ({ ...e, available: Boolean(e.exe && exists(e.exe)) }));
}

/** Devuelve { exe, args, cwd } para un id conocido y disponible; null si el id no existe o no está instalado. */
function resolveLaunch(id, ctx) {
  if (typeof id !== 'string') return null;
  const e = catalog(ctx).find((x) => x.id === id);
  return e && e.available ? { exe: e.exe, args: e.args, cwd: e.cwd } : null;
}

const list = (ctx) => catalog(ctx).map(({ id, label, available }) => ({ id, label, available }));

module.exports = { catalog, resolveLaunch, list };
