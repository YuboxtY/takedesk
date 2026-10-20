import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveLaunch, list } = require('../src/launchers.cjs');

const ROOT = 'C:\\proyectos\\mi app';
const base = { platform: 'win32', root: ROOT, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' } };
const all = () => true;

describe('launchers (lista cerrada de apps)', () => {
  it('cada app tiene ejecutable y argumentos fijos; solo la raíz del proyecto es variable', () => {
    const vs = resolveLaunch('vscode', { ...base, exists: all });
    expect(vs.exe.endsWith('Code.exe')).toBe(true);
    expect(vs.args).toEqual([ROOT]);
    expect(vs.cwd).toBe(ROOT);
    expect(resolveLaunch('wt', { ...base, exists: all }).args).toEqual(['-d', ROOT]);
    expect(resolveLaunch('explorer', { ...base, exists: all }).exe.toLowerCase().endsWith('explorer.exe')).toBe(true);
    expect(resolveLaunch('notepad', { ...base, exists: all }).args).toEqual([]);
  });
  it('rechaza ids desconocidos o con intentos de inyección', () => {
    for (const id of ['calc', 'cmd', 'explorer;calc', 'explorer && calc', '../explorer', '', null, 5, { id: 'explorer' }]) {
      expect(resolveLaunch(id, { ...base, exists: all }), String(id)).toBeNull();
    }
  });
  it('una app no instalada aparece como no disponible y no se puede lanzar', () => {
    const exists = (p: string) => !p.includes('Microsoft VS Code');
    const l = list({ ...base, exists });
    expect(l.find((x: { id: string }) => x.id === 'vscode').available).toBe(false);
    expect(l.find((x: { id: string }) => x.id === 'explorer').available).toBe(true);
    expect(resolveLaunch('vscode', { ...base, exists })).toBeNull();
  });
  it('la lista pública no expone rutas', () => {
    expect(JSON.stringify(list({ ...base, exists: all }))).not.toMatch(/[A-Za-z]:\\|\.exe/);
  });
  it('en otros sistemas solo ofrece abrir la carpeta con el gestor del sistema', () => {
    const l = list({ platform: 'linux', root: '/p', env: {}, exists: all });
    expect(l.map((x: { id: string }) => x.id)).toEqual(['explorer']);
  });
});
