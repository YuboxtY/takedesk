import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isAllowed, createProxy } = require('../src/api-proxy.cjs');
const { ensureCore } = require('../src/core-launcher.cjs');

describe('api-proxy', () => {
  it('permite solo rutas /v1 conocidas y métodos GET/POST', () => {
    expect(isAllowed('GET', '/v1/runs')).toBe(true);
    expect(isAllowed('GET', '/v1/runs/run_1/events?since=3&limit=200')).toBe(true);
    expect(isAllowed('POST', '/v1/runs/run_1/cancel')).toBe(true);
    expect(isAllowed('GET', '/v1/runs/run_1/diff')).toBe(true);
    expect(isAllowed('POST', '/v1/runs/run_1/merge')).toBe(true);
    expect(isAllowed('GET', '/v1/runs/run_1/merge/x')).toBe(false);
    expect(isAllowed('DELETE', '/v1/runs')).toBe(false);
    expect(isAllowed('GET', '/v1/terminals')).toBe(false);
    expect(isAllowed('POST', '/v1/ws-ticket')).toBe(false);
    expect(isAllowed('GET', '/v1/runs/../health')).toBe(false);
    expect(isAllowed('GET', 'http://evil.example/v1/runs')).toBe(false);
  });

  it('añade el token en el proceso principal y rechaza rutas prohibidas sin llamar a la red', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { status: 200, json: async () => ({ ok: true }) };
    };
    const request = createProxy({ port: 1234, token: 'secreto', fetchFn });
    expect((await request('GET', '/v1/runs')).status).toBe(200);
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:1234/v1/runs', headers: { authorization: 'Bearer secreto' } });
    expect((await request('GET', '/v1/terminals')).status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe('core-launcher', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-desk-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it('reutiliza un Core ya en marcha sin lanzar otro', async () => {
    fs.writeFileSync(path.join(dir, 'api-token'), 'tok');
    let spawned = 0;
    const r = await ensureCore({ port: 1, env: { ...process.env, AIW_DATA_DIR: dir }, healthy: async () => true, spawnFn: () => { spawned++; } });
    expect(r).toEqual({ port: 1, token: 'tok', started: false });
    expect(spawned).toBe(0);
  });

  it('lanza el Core desacoplado cuando no responde y espera a que esté sano', async () => {
    fs.writeFileSync(path.join(dir, 'api-token'), 'tok');
    let up = false;
    let opts: { detached?: boolean } = {};
    const spawnFn = (_cmd: string, _args: string[], o: { detached?: boolean }) => { opts = o; up = true; return { unref() {} }; };
    const r = await ensureCore({ port: 1, env: { ...process.env, AIW_DATA_DIR: dir }, healthy: async () => up, spawnFn, waitMs: 2000 });
    expect(r.started).toBe(true);
    expect(opts.detached).toBe(true);
  });

  it('falla con un mensaje claro si el Core nunca responde', async () => {
    await expect(
      ensureCore({ port: 1, env: { ...process.env, AIW_DATA_DIR: dir }, healthy: async () => false, spawnFn: () => ({ unref() {} }), waitMs: 300 }),
    ).rejects.toThrow(/no respondió/);
  });
});

describe('workspace (sanitizado)', () => {
  const { sanitizeWorkspace } = require('../src/workspace.cjs');
  it('conserva paneles válidos y descarta lo desconocido o excesivo', () => {
    const w = sanitizeWorkspace({
      projectId: 'prj_1',
      evil: 'x',
      layout: [
        { id: 't1', type: 'agent', x: 10.4, y: -50, w: 100, h: 99999, z: 3, state: { adapter: 'claude', runId: 'r1', '__proto__': 'x', 'bad key': 1, nested: { a: 1 }, text: 'a'.repeat(30000) } },
        { type: 'raro', x: 1 },
        null,
        { id: '../etc', type: 'notes' },
      ],
    });
    expect(w.projectId).toBe('prj_1');
    expect('evil' in w).toBe(false);
    expect(w.layout).toHaveLength(2);
    expect(w.layout[0]).toMatchObject({ id: 't1', type: 'agent', x: 10, y: -50, w: 280, h: 4000, z: 3 });
    expect(Object.keys(w.layout[0].state).sort()).toEqual(['adapter', 'runId', 'text']);
    expect(w.layout[0].state.text).toHaveLength(20000);
    expect(w.layout[1].id).toBeUndefined();
  });
  it('limita el número de paneles', () => {
    const layout = Array.from({ length: 100 }, () => ({ type: 'notes' }));
    expect(sanitizeWorkspace({ layout }).layout).toHaveLength(40);
  });
  it('tolera basura', () => {
    expect(sanitizeWorkspace(null)).toEqual({});
    expect(sanitizeWorkspace('x')).toEqual({});
  });
});

describe('workspace: espacios', () => {
  const { sanitizeWorkspace } = require('../src/workspace.cjs');
  it('conserva espacios válidos, sin duplicados, con nombre acotado y el espacio activo', () => {
    const w = sanitizeWorkspace({
      spaces: [{ id: 's1', name: '  Principal  ' }, { id: 's1', name: 'dup' }, { id: '../x', name: 'malo' }, { id: 's2', name: 'x'.repeat(100) }, { id: 's3' }, 5],
      activeSpace: 's2',
      layout: [{ type: 'notes', space: 's2' }, { type: 'notes', space: '../../etc' }],
    });
    expect(w.spaces.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(w.spaces[0].name).toBe('Principal');
    expect(w.spaces[1].name).toHaveLength(40);
    expect(w.spaces[2].name).toBe('Espacio');
    expect(w.activeSpace).toBe('s2');
    expect(w.layout[0].space).toBe('s2');
    expect(w.layout[1].space).toBeUndefined();
  });
  it('limita el número de espacios y rechaza un activo inválido', () => {
    const spaces = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: `E${i}` }));
    expect(sanitizeWorkspace({ spaces }).spaces).toHaveLength(12);
    expect('activeSpace' in sanitizeWorkspace({ activeSpace: '../x' })).toBe(false);
  });
});

describe('workspace: cámara por espacio', () => {
  const { sanitizeWorkspace } = require('../src/workspace.cjs');
  it('acota zoom y posición, y descarta vistas inválidas', () => {
    const w = sanitizeWorkspace({ spaces: [
      { id: 'a', name: 'A', view: { x: 10, y: -20, k: 0.5 } },
      { id: 'b', name: 'B', view: { x: 1e9, y: -1e9, k: 99 } },
      { id: 'c', name: 'C', view: { x: 'x', y: 0, k: 1 } },
      { id: 'd', name: 'D', view: { x: 0, y: 0, k: 0 } },
    ] });
    expect(w.spaces[0].view).toEqual({ x: 10, y: -20, k: 0.5 });
    expect(w.spaces[1].view).toEqual({ x: 1e6, y: -1e6, k: 3 });
    expect(w.spaces[2].view).toBeUndefined();
    expect(w.spaces[3].view).toEqual({ x: 0, y: 0, k: 0.1 });
  });
  it('admite paneles en coordenadas negativas (lienzo infinito) y los tipos nuevos', () => {
    const w = sanitizeWorkspace({ layout: [{ type: 'browser', x: -500, y: -40 }, { type: 'editor' }, { type: 'apps' }, { type: 'raro' }] });
    expect(w.layout).toHaveLength(3);
    expect(w.layout[0]).toMatchObject({ x: -500, y: -40 });
  });
});

describe('workspace: fondo y tema', () => {
  const { sanitizeWorkspace } = require('../src/workspace.cjs');
  it('acepta fondos válidos y descarta valores peligrosos', () => {
    const w = sanitizeWorkspace({
      theme: 'light',
      spaces: [
        { id: 'a', name: 'A', bg: { kind: 'image', image: 'abcdef0123456789.png', dim: 5, color: '#112233' } },
        { id: 'b', name: 'B', bg: { kind: 'image', image: '../../secreto.png', color: 'red; background:url(http://x)', gradient: 'nope' } },
        { id: 'c', name: 'C', bg: { kind: 'js' } },
        { id: 'd', name: 'D', bg: { kind: 'gradient', gradient: 'ocean' } },
      ],
    });
    expect(w.theme).toBe('light');
    expect(w.spaces[0].bg).toEqual({ kind: 'image', image: 'abcdef0123456789.png', dim: 0.8, color: '#112233' });
    expect(w.spaces[1].bg).toEqual({ kind: 'image' }); // sin imagen ni color inválidos
    expect(w.spaces[2].bg).toBeUndefined();
    expect(w.spaces[3].bg).toEqual({ kind: 'gradient', gradient: 'ocean' });
  });
  it('rechaza temas desconocidos', () => {
    expect('theme' in sanitizeWorkspace({ theme: 'neon' })).toBe(false);
  });
});
