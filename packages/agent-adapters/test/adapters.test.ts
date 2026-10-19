import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@aiw/contracts';
import { isAlive, killTree } from '@aiw/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, JsonlProcessAdapter, NO_CAPABILITIES, type RunSession } from '../src';

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent.mjs');
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-ad-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function collect(s: RunSession, max = Infinity): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of s.events) { out.push(e); if (out.length >= max) break; }
  return out;
}
const adapter = () => new JsonlProcessAdapter({
  id: 'proc', displayName: 'proc', command: process.execPath, capabilities: NO_CAPABILITIES, dataPolicy: 'private-ok',
  buildArgs: (req) => [AGENT, ...req.prompt.split(' ')],
});
const req = (id: string, prompt: string) => ({ runId: id, cwd: tmp, prompt, mode: 'write' as const, runDir: path.join(tmp, 'runs', id) });

describe('JsonlProcessAdapter', () => {
  it('traduce JSONL y texto plano, y emite un único run.finished', async () => {
    const s = await adapter().start(req('r1', 'ok'));
    const evs = await collect(s);
    expect(evs).toEqual([
      { kind: 'session', externalSessionId: 'sess-1' },
      { kind: 'output.delta', text: 'hola', stream: 'stdout' },
      { kind: 'output.delta', text: 'linea plana\n', stream: 'stdout' },
      { kind: 'run.finished', ok: true },
    ]);
  });

  it('un código de salida distinto de 0 sin evento final es un fallo con motivo', async () => {
    const evs = await collect(await adapter().start(req('r2', 'fail')));
    expect(evs.at(-1)).toEqual({ kind: 'run.finished', ok: false, reason: 'exit code 3' });
  });

  it('cancelar (force) mata el árbol completo y cierra el flujo', async () => {
    const s = await adapter().start(req('r3', 'hang'));
    const first = (await collect(s, 1))[0] as Extract<AgentEvent, { kind: 'output.delta' }>;
    const gpid = Number(/grandchild (\d+)/.exec(first.text)![1]);
    expect(isAlive(gpid)).toBe(true);
    await s.cancel('force');
    const rest = await collect(s);
    expect(rest.at(-1)).toMatchObject({ kind: 'run.finished', ok: false });
    await sleep(200);
    expect(isAlive(gpid)).toBe(false);
    expect(isAlive(s.handle.pid!)).toBe(false);
  });

  it('cancelar (graceful) termina al agente y a su nieto', async () => {
    const s = await adapter().start(req('r4', 'hang'));
    const first = (await collect(s, 1))[0] as Extract<AgentEvent, { kind: 'output.delta' }>;
    const gpid = Number(/grandchild (\d+)/.exec(first.text)![1]);
    await s.cancel('graceful');
    const rest = await collect(s);
    expect(rest.at(-1)).toMatchObject({ kind: 'run.finished', ok: false });
    await sleep(200);
    expect(isAlive(gpid)).toBe(false);
  });

  it('CA-11: tras "caerse" el Core se reengancha al proceso vivo y recibe el resultado real', async () => {
    const a = adapter();
    const r = req('r5', 'slow 15');
    const s1 = await a.start(r);
    const seen = await collect(s1, 3); // el Core "se cae" aquí: se abandona s1
    expect(seen).toHaveLength(3);
    const rec = await a.recover(s1.handle, { runDir: r.runDir, cwd: r.cwd });
    expect(rec.status).toBe('reattached');
    if (rec.status !== 'reattached') throw new Error('x');
    const all = await collect(rec.session);
    expect(all.slice(0, 3)).toEqual(seen); // reproduce lo ya visto
    expect(all.at(-1)).toEqual({ kind: 'run.finished', ok: true });
    expect(all.filter((e) => e.kind === 'output.delta')).toHaveLength(15);
  });

  it('reengancha también si el agente terminó mientras el Core estaba caído', async () => {
    const a = adapter();
    const r = req('r6', 'ok');
    const s1 = await a.start(r);
    await sleep(800); // terminó solo; nadie leyó
    const rec = await a.recover(s1.handle, { runDir: r.runDir, cwd: r.cwd });
    expect(rec.status).toBe('reattached');
    if (rec.status !== 'reattached') throw new Error('x');
    expect((await collect(rec.session)).at(-1)).toEqual({ kind: 'run.finished', ok: true });
  });

  it('CA-08: si el proceso murió sin dejar resultado → interrupted, NUNCA completed', async () => {
    const a = adapter();
    const r = req('r7', 'hang');
    const s1 = await a.start(r);
    await collect(s1, 1);
    await killTree(s1.handle.pid!, { force: true }); // kill -9 del wrapper: no escribe exit.json
    await sleep(300);
    const rec = await a.recover(s1.handle, { runDir: r.runDir, cwd: r.cwd });
    expect(rec).toMatchObject({ status: 'interrupted' });
    // y el flujo vivo original tampoco declara éxito
    const tailEvs = await collect(s1);
    expect(tailEvs.at(-1)).toMatchObject({ kind: 'run.finished', ok: false, reason: 'process-died-without-exit-record' });
  });

  it('probe informa si el ejecutable no existe', async () => {
    const a = new JsonlProcessAdapter({
      id: 'x', displayName: 'x', command: 'no-existe-xyz', capabilities: NO_CAPABILITIES, dataPolicy: 'private-ok', buildArgs: () => [],
    });
    expect(await a.probe()).toMatchObject({ installed: false });
    await expect(a.start(req('r8', ''))).rejects.toThrow(/no instalado/i);
  });
});

describe('FakeAdapter', () => {
  it('flujo de aprobación', async () => {
    const f = new FakeAdapter({
      script: async (ctx) => {
        const d = await ctx.approval('Bash', 'rm -rf build');
        ctx.emit({ kind: 'output.delta', text: `decisión: ${d}`, stream: 'assistant' });
      },
    });
    const s = await f.start(req('f1', 'x'));
    const it = s.events[Symbol.asyncIterator]();
    const ap = (await it.next()).value as Extract<AgentEvent, { kind: 'approval.requested' }>;
    expect(ap.kind).toBe('approval.requested');
    await s.respondToApproval!(ap.approvalId, 'deny');
    const rest: AgentEvent[] = [];
    for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
    expect(rest).toEqual([{ kind: 'output.delta', text: 'decisión: deny', stream: 'assistant' }, { kind: 'run.finished', ok: true }]);
  });

  it('cancelar rechaza aprobaciones pendientes y termina como cancelado', async () => {
    const f = new FakeAdapter({ script: async (ctx) => { await ctx.approval('Bash', 'x'); } });
    const s = await f.start(req('f2', 'x'));
    const it = s.events[Symbol.asyncIterator]();
    await it.next();
    await s.cancel('graceful');
    const last = [] as AgentEvent[];
    for (let n = await it.next(); !n.done; n = await it.next()) last.push(n.value);
    expect(last.at(-1)).toEqual({ kind: 'run.finished', ok: false, reason: 'cancelled' });
  });
});
