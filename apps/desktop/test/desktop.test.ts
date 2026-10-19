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
