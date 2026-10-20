import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { listDir, readFile, writeFile, MAX_BYTES } = require('../src/files.cjs');

let tmp: string;
let root: string;
let outside: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-files-')));
  root = path.join(tmp, 'proyecto');
  outside = path.join(tmp, 'fuera');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'README.md'), '# hola\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'let a = 1;\r\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(outside, 'secreto.txt'), 'SECRETO');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'error'; } };

describe('files: listar', () => {
  it('lista carpetas primero, oculta .git y node_modules y no incluye rutas absolutas', () => {
    const r = listDir(root, '');
    expect(r.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'README.md']);
    expect(r.entries[0].type).toBe('dir');
    expect(JSON.stringify(r)).not.toContain(tmp.replaceAll('\\', '\\\\'));
    expect(listDir(root, 'src').entries.map((e: { name: string }) => e.name)).toEqual(['a.js']);
  });
});

describe('files: leer y escribir', () => {
  it('lee con tamaño y mtime, y conserva CRLF al escribir', () => {
    const r = readFile(root, 'src/a.js');
    expect(r.content).toBe('let a = 1;\r\n');
    const w = writeFile(root, 'src/a.js', 'let a = 2;\r\n', { expectedMtimeMs: r.mtimeMs });
    expect(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8')).toBe('let a = 2;\r\n');
    expect(w.size).toBe(12);
    expect(fs.readdirSync(path.join(root, 'src'))).toEqual(['a.js']); // sin temporales
  });
  it('crea archivos nuevos en carpetas existentes y rechaza carpetas inexistentes', () => {
    writeFile(root, 'src/nuevo.ts', 'x');
    expect(fs.readFileSync(path.join(root, 'src', 'nuevo.ts'), 'utf8')).toBe('x');
    expect(code(() => writeFile(root, 'no-existe/x.txt', 'x'))).toBe('missing-dir');
  });
  it('detecta cambios en disco (conflicto) salvo que se fuerce', () => {
    const r = readFile(root, 'README.md');
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(path.join(root, 'README.md'), 'cambiado por otro');
    fs.utimesSync(path.join(root, 'README.md'), later, later);
    expect(code(() => writeFile(root, 'README.md', 'mío', { expectedMtimeMs: r.mtimeMs }))).toBe('conflict');
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('cambiado por otro');
    writeFile(root, 'README.md', 'mío', { expectedMtimeMs: r.mtimeMs, force: true });
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('mío');
  });
  it('rechaza binarios y archivos o contenidos demasiado grandes', () => {
    fs.writeFileSync(path.join(root, 'img.bin'), Buffer.from([1, 2, 0, 3]));
    expect(code(() => readFile(root, 'img.bin'))).toBe('binary');
    fs.writeFileSync(path.join(root, 'grande.txt'), 'a'.repeat(MAX_BYTES + 1));
    expect(code(() => readFile(root, 'grande.txt'))).toBe('too-big');
    expect(code(() => writeFile(root, 'x.txt', 'a'.repeat(MAX_BYTES + 1)))).toBe('too-big');
    expect(code(() => readFile(root, 'src'))).toBe('not-file');
  });
  it('no escribe dentro de .git', () => {
    expect(code(() => writeFile(root, '.git/config', 'malo'))).toBe('forbidden');
    expect(code(() => writeFile(root, '.GIT/hooks/pre-commit', 'malo'))).not.toBeNull();
    expect(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });
});

describe('files: nunca salir del proyecto', () => {
  it('rechaza ..', () => {
    for (const rel of ['../fuera/secreto.txt', 'src/../../fuera/secreto.txt', '..\\fuera\\secreto.txt', '..']) {
      expect(code(() => readFile(root, rel)), rel).toBe('outside');
      expect(code(() => writeFile(root, rel, 'x')), rel).toBe('outside');
      expect(code(() => listDir(root, rel)), rel).toBe('outside');
    }
  });
  it('rechaza rutas absolutas, de unidad, UNC y con NUL', () => {
    for (const rel of [path.join(outside, 'secreto.txt'), 'C:\\Windows\\win.ini', '\\\\servidor\\share\\x', '/etc/passwd', 'a\0b']) {
      expect(code(() => readFile(root, rel)), rel).not.toBeNull();
    }
    expect(fs.readFileSync(path.join(outside, 'secreto.txt'), 'utf8')).toBe('SECRETO');
  });
  it('rechaza enlaces (junction/symlink) que apuntan fuera', () => {
    const link = path.join(root, 'enlace');
    try { fs.symlinkSync(outside, link, 'junction'); } catch { return; } // sin permisos para crear enlaces: se omite
    expect(code(() => readFile(root, 'enlace/secreto.txt'))).toBe('outside');
    expect(code(() => writeFile(root, 'enlace/nuevo.txt', 'x'))).toBe('outside');
    expect(listDir(root, '').entries.some((e: { name: string }) => e.name === 'enlace')).toBe(false); // ni se muestra
    expect(fs.existsSync(path.join(outside, 'nuevo.txt'))).toBe(false);
  });
});
