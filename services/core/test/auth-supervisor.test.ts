import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadOrCreateToken, TicketStore, tokensEqual } from '../src/auth';
import { checkAdmission } from '../src/resources';
import { loadConfig } from '../src/config';
import { supervise } from '../src/supervisor';

describe('auth', () => {
  it('el token se crea una vez, es fuerte, persistente y (POSIX) 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-auth-'));
    const t1 = loadOrCreateToken(dir);
    expect(t1.length).toBeGreaterThanOrEqual(43);
    expect(loadOrCreateToken(dir)).toBe(t1);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'api-token')).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true });
  });

  it('comparación de tokens', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
  });

  it('tickets: un solo uso y caducan', () => {
    let now = 1000;
    const s = new TicketStore(60_000, () => now);
    const { ticket } = s.issue();
    expect(s.consume(ticket)).toBe(true);
    expect(s.consume(ticket)).toBe(false);
    const t2 = s.issue().ticket;
    now += 61_000;
    expect(s.consume(t2)).toBe(false);
    expect(s.consume(undefined)).toBe(false);
    expect(s.consume('inventado')).toBe(false);
  });
});

describe('admisión de recursos', () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv, { dataDir: '/tmp', minFreeDiskBytes: 15e9, reserveMemBytes: 3e9 });
  it('rechaza con poco disco o poca RAM y explica por qué', () => {
    expect(checkAdmission(cfg, { freeDiskBytes: () => 14e9, availableMemBytes: () => 8e9 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Disco/) });
    expect(checkAdmission(cfg, { freeDiskBytes: () => 20e9, availableMemBytes: () => 1e9 })).toMatchObject({ ok: false, reason: expect.stringMatching(/RAM/) });
    expect(checkAdmission(cfg, { freeDiskBytes: () => 20e9, availableMemBytes: () => 8e9 })).toEqual({ ok: true });
  });
  it('los valores por defecto reflejan el equipo del usuario (D-15/D-16)', () => {
    const d = loadConfig({} as NodeJS.ProcessEnv);
    expect([d.maxConcurrentRuns, d.maxPerProvider, d.minFreeDiskBytes / 1024 ** 3, d.reserveMemBytes / 1024 ** 3]).toEqual([3, 2, 15, 3]);
    expect(d.host).toBe('127.0.0.1');
  });
});

function fakeChild(code: number): ChildProcess {
  const e = new EventEmitter() as ChildProcess;
  e.kill = () => true;
  setImmediate(() => e.emit('exit', code));
  return e;
}

describe('supervisor', () => {
  it('reinicia con backoff exponencial y se rinde tras demasiadas caídas seguidas', async () => {
    let t = 0;
    const waits: number[] = [];
    const events: string[] = [];
    const r = await supervise({
      command: 'x', args: [], maxRestarts: 3, windowMs: 60_000, backoffMs: [100, 200, 400, 800],
      spawnFn: () => fakeChild(1), now: () => (t += 10), sleep: async (ms) => { waits.push(ms); },
      onEvent: (e) => events.push(e.type),
    });
    expect(r).toBe('gave-up');
    expect(waits).toEqual([100, 200, 400]);
    expect(events.filter((e) => e === 'started')).toHaveLength(4);
    expect(events.at(-1)).toBe('gave-up');
  });

  it('un proceso estable reinicia el backoff y la ventana de caídas', async () => {
    let t = 0;
    let n = 0;
    const waits: number[] = [];
    const ctl = new AbortController();
    await supervise({
      command: 'x', args: [], maxRestarts: 2, windowMs: 1000, backoffMs: [100, 200, 400],
      spawnFn: () => { n++; t += n === 3 ? 5000 : 10; return fakeChild(1); }, // la 3.ª ejecución dura mucho
      now: () => t, sleep: async (ms) => { waits.push(ms); if (waits.length >= 4) ctl.abort(); },
      signal: ctl.signal,
    });
    expect(waits.slice(0, 2)).toEqual([100, 200]);
    expect(waits[2]).toBe(100); // vuelve a empezar tras el proceso estable
  });

  it('se detiene limpiamente con la señal de aborto', async () => {
    const ctl = new AbortController();
    const r = supervise({ command: 'x', args: [], spawnFn: () => { const c = new EventEmitter() as ChildProcess; c.kill = () => { setImmediate(() => c.emit('exit', 0)); return true; }; return c; }, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    expect(await r).toBe('stopped');
  });
});
