import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@aiw/contracts';
import { readRunEvents } from '@aiw/database';
import { Channel, FakeAdapter, JsonlProcessAdapter, NO_CAPABILITIES, type AgentAdapter } from '@aiw/agent-adapters';
import { isAlive, killTree } from '@aiw/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { deferred, makeEnv, sleep, waitFor, type Env } from './helpers';

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.cleanup());

const body = (o: Record<string, unknown> = {}) => ({ projectId: 'prj_test', adapter: 'fake', prompt: 'haz algo', mode: 'write' as const, ...o });
const state = (id: string) => env.repos.runs.get(id)!.state;

describe('RunManager: ciclo de vida', () => {
  it('camino feliz: worktree, eventos persistidos e indexados, estado completed', async () => {
    const m = env.manager([new FakeAdapter()]);
    const run = await m.createRun(body({ title: 'Mi tarea' }));
    await waitFor(() => state(run.id) === 'completed', 8000, 'completed');
    const row = env.repos.runs.get(run.id)!;
    expect(row.worktreeId).toBeTruthy();
    const wt = env.repos.worktrees.get(row.worktreeId!)!;
    expect(wt.branch).toBe(`task/${run.id}-mi-tarea`);
    expect(fs.existsSync(wt.path)).toBe(true);
    const stored = readRunEvents(path.join(row.runDir, 'events.ndjson'));
    expect(stored.map((e) => e.event.kind)).toEqual(['output.delta', 'run.finished']);
    expect(stored.map((e) => e.seq)).toEqual([1, 2]);
    expect(env.repos.eventIndex.list(run.id, 0, 10)).toHaveLength(2);
    expect(row.lastSeq).toBe(2);
    expect(row.endedAt).toBeTruthy();
    // eventos durables emitidos en orden
    const states = env.repos.coreEvents.since(0).filter((e) => e.type === 'run.state_changed').map((e) => JSON.parse(e.payloadJson).to);
    expect(states).toEqual(['starting', 'running', 'completed']);
  });

  it('modo read no crea worktree y ejecuta en la raíz del proyecto', async () => {
    const f = new FakeAdapter();
    const m = env.manager([f]);
    const run = await m.createRun(body({ mode: 'read' }));
    await waitFor(() => state(run.id) === 'completed');
    expect(env.repos.runs.get(run.id)!.worktreeId).toBeNull();
    expect(f.started[0]!.cwd).toBe(env.repo);
  });

  it('nunca expone el secreto: redacta en NDJSON, índice y difusión', async () => {
    const f = new FakeAdapter({ script: (ctx) => ctx.emit({ kind: 'output.delta', text: 'clave sk-ant-api03-abcdefghijklmnopqrstu', stream: 'stdout' }) });
    const live: string[] = [];
    env.bus.subscribe((msg) => live.push(JSON.stringify(msg)));
    const m = env.manager([f]);
    const run = await m.createRun(body());
    await waitFor(() => state(run.id) === 'completed');
    const dir = env.repos.runs.get(run.id)!.runDir;
    expect(fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8')).not.toContain('abcdefghijklmnopqrstu');
    expect(JSON.stringify(env.repos.eventIndex.list(run.id, 0, 10))).not.toContain('abcdefghijklmnopqrstu');
    expect(live.join('\n')).not.toContain('abcdefghijklmnopqrstu');
  });

  it('un error del script termina en failed con motivo', async () => {
    const m = env.manager([new FakeAdapter({ script: () => { throw new Error('boom'); } })]);
    const run = await m.createRun(body());
    await waitFor(() => state(run.id) === 'failed');
    expect(env.repos.runs.get(run.id)!.endReason).toBe('script-error');
  });

  it('CA-08: si el flujo de eventos se corta sin resultado, NO se marca completed', async () => {
    const broken: AgentAdapter = {
      id: 'broken', displayName: 'b', capabilities: NO_CAPABILITIES, dataPolicy: 'private-ok',
      probe: async () => ({ installed: true, warnings: [] }),
      start: async (req) => {
        const ch = new Channel<AgentEvent>();
        ch.push({ kind: 'output.delta', text: 'a medias', stream: 'stdout' });
        ch.close(); // se cierra sin 'run.finished'
        return { handle: { runId: req.runId }, events: ch, cancel: async () => {}, dispose: () => {} };
      },
      recover: async () => ({ status: 'interrupted', reason: 'n/a' }),
    };
    const m = env.manager([broken]);
    const run = await m.createRun(body({ adapter: 'broken' }));
    await waitFor(() => ['failed', 'completed'].includes(state(run.id)));
    expect(state(run.id)).toBe('failed');
    expect(env.repos.runs.get(run.id)!.endReason).toBe('adapter-ended-without-result');
  });

  it('valida proyecto, adaptador y política de datos', async () => {
    const m = env.manager([new FakeAdapter({ id: 'free', dataPolicy: 'may-train' })]);
    await expect(m.createRun(body({ projectId: 'nope', adapter: 'free' }))).rejects.toMatchObject({ status: 404 });
    await expect(m.createRun(body({ adapter: 'otro' }))).rejects.toMatchObject({ status: 400, code: 'unknown-adapter' });
    const err = await m.createRun(body({ adapter: 'free' })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'data-policy-confirmation-required' });
    const ok = await m.createRun(body({ adapter: 'free', acceptDataPolicy: true }));
    await waitFor(() => state(ok.id) === 'completed');
  });
});

describe('RunManager: concurrencia, recursos y cuota', () => {
  it('respeta el máximo global (3) y por proveedor (2)', async () => {
    const gate = deferred();
    const slow = (id: string) => new FakeAdapter({ id, script: async () => { await gate.promise; } });
    const m = env.manager([slow('a'), slow('b')], { maxConcurrentRuns: 3, maxPerProvider: 2 });
    const ids = [
      (await m.createRun(body({ adapter: 'a' }))).id,
      (await m.createRun(body({ adapter: 'a' }))).id,
      (await m.createRun(body({ adapter: 'a' }))).id, // 3.º de 'a': debe esperar por el límite del proveedor
      (await m.createRun(body({ adapter: 'b' }))).id,
      (await m.createRun(body({ adapter: 'b' }))).id, // 5.º en total: espera por el límite global
    ];
    await m.idle();
    await waitFor(() => env.repos.runs.countByStates(['running']) === 3, 5000, '3 en ejecución');
    expect(ids.map(state)).toEqual(['running', 'running', 'queued', 'running', 'queued']);
    gate.resolve();
    await waitFor(() => ids.every((i) => state(i) === 'completed'), 10000, 'todos completed');
  });

  it('no inicia runs si falta disco o RAM, avisa (system.degraded) y arranca al recuperarse', async () => {
    env.probe.disk = 1;
    const m = env.manager([new FakeAdapter()], { minFreeDiskBytes: 10 });
    const run = await m.createRun(body());
    await m.idle();
    expect(state(run.id)).toBe('queued');
    expect(env.repos.coreEvents.since(0).some((e) => e.type === 'system.degraded')).toBe(true);
    env.probe.disk = 100;
    await m.pump();
    await waitFor(() => state(run.id) === 'completed');
  });

  it('un límite de cuota pausa el proveedor y reanuda solo', async () => {
    const f = new FakeAdapter({ script: (ctx) => ctx.emit({ kind: 'usage', rateLimited: true }) });
    const m = env.manager([f], { quotaPauseMs: 500 });
    const r1 = await m.createRun(body());
    await waitFor(() => state(r1.id) === 'completed');
    const r2 = await m.createRun(body());
    await sleep(150);
    expect(state(r2.id)).toBe('queued'); // proveedor pausado
    expect(env.repos.coreEvents.since(0).some((e) => e.type === 'provider.paused')).toBe(true);
    await waitFor(() => state(r2.id) === 'completed', 4000, 'reanudación tras la pausa');
  });
});

describe('RunManager: aprobaciones y cancelación', () => {
  const askScript = new FakeAdapter({
    script: async (ctx) => {
      const d = await ctx.approval('Bash', 'rm -rf build');
      ctx.emit({ kind: 'output.delta', text: `decisión ${d}`, stream: 'assistant' });
    },
  });

  it('el run espera la aprobación y continúa al decidir; no se puede decidir dos veces', async () => {
    const m = env.manager([askScript]);
    const run = await m.createRun(body());
    const ap = await waitFor(() => env.repos.approvals.listPending(run.id)[0]);
    expect(state(run.id)).toBe('waiting_approval');
    await m.resolveApproval(ap.id, 'allow', 'dev1');
    await waitFor(() => state(run.id) === 'completed');
    expect(env.repos.approvals.get(ap.id)).toMatchObject({ status: 'allowed', decidedBy: 'dev1' });
    await expect(m.resolveApproval(ap.id, 'deny')).rejects.toMatchObject({ status: 409 });
    expect(env.repos.audit.list().some((a) => a.action === 'approval.decide')).toBe(true);
  });

  it('cancelar con una aprobación pendiente termina en cancelled y expira la aprobación', async () => {
    const m = env.manager([askScript]);
    const run = await m.createRun(body());
    const ap = await waitFor(() => env.repos.approvals.listPending(run.id)[0]);
    await m.cancel(run.id);
    await waitFor(() => state(run.id) === 'cancelled');
    expect(env.repos.approvals.get(ap.id)!.status).toBe('expired');
  });

  it('cancelar un run en cola lo cancela sin arrancarlo', async () => {
    env.probe.disk = 0;
    const m = env.manager([new FakeAdapter()], { minFreeDiskBytes: 10 });
    const run = await m.createRun(body());
    await m.idle();
    await m.cancel(run.id);
    expect(state(run.id)).toBe('cancelled');
  });

  it('un agente que ignora la cancelación recibe force tras el plazo de gracia', async () => {
    let forced = false;
    const stubborn: AgentAdapter = {
      id: 'stubborn', displayName: 's', capabilities: NO_CAPABILITIES, dataPolicy: 'private-ok',
      probe: async () => ({ installed: true, warnings: [] }),
      recover: async () => ({ status: 'interrupted', reason: 'n/a' }),
      start: async (req) => {
        const ch = new Channel<AgentEvent>();
        return {
          handle: { runId: req.runId }, events: ch, dispose: () => {},
          cancel: async (mode) => { if (mode === 'force') { forced = true; ch.push({ kind: 'run.finished', ok: false, reason: 'killed' }); ch.close(); } },
        };
      },
    };
    const m = env.manager([stubborn]);
    const run = await m.createRun(body({ adapter: 'stubborn' }));
    await waitFor(() => state(run.id) === 'running');
    await m.cancel(run.id);
    expect(state(run.id)).toBe('cancelling');
    await waitFor(() => state(run.id) === 'cancelled', 4000, 'cancelled tras force');
    expect(forced).toBe(true);
  });
});

// ------------------------------------------------------------------ CA-11 con procesos reales

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'agent-adapters', 'test', 'fixtures', 'agent.mjs');
const procAdapter = () => new JsonlProcessAdapter({
  id: 'proc', displayName: 'proc', command: process.execPath, capabilities: NO_CAPABILITIES, dataPolicy: 'private-ok',
  buildArgs: (req) => [AGENT, ...req.prompt.split(' ')],
});

describe('Reconciliación tras caída del Core (CA-08, CA-11) con procesos reales', () => {
  it('reengancha a un agente vivo, no duplica eventos y completa con evidencia', async () => {
    const m1 = env.manager([procAdapter()]);
    const run = await m1.createRun(body({ adapter: 'proc', prompt: 'slow 15', mode: 'read' }));
    await waitFor(() => (env.repos.runs.get(run.id)!.lastSeq >= 3) || undefined, 8000, 'primeros eventos');
    const seqAtCrash = env.repos.runs.get(run.id)!.lastSeq;
    m1.shutdown(); // "se cae" el Core: el agente sigue vivo
    expect(['running']).toContain(state(run.id));

    const m2 = env.manager([procAdapter()]); // arranque nuevo, misma BD
    const res = await m2.reconcile();
    expect(res).toMatchObject({ reattached: 1, interrupted: 0 });
    await waitFor(() => state(run.id) === 'completed', 10000, 'completed tras reenganche');

    const events = readRunEvents(path.join(env.repos.runs.get(run.id)!.runDir, 'events.ndjson'), 0, 1000);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1)); // sin huecos ni duplicados
    expect(events.filter((e) => e.event.kind === 'output.delta')).toHaveLength(15);
    expect(events.length).toBeGreaterThan(seqAtCrash);
    expect(events.at(-1)!.event).toEqual({ kind: 'run.finished', ok: true });
    const states = env.repos.coreEvents.since(0).filter((e) => e.type === 'run.state_changed').map((e) => JSON.parse(e.payloadJson).to);
    expect(states).toEqual(['starting', 'running', 'pending_reconciliation', 'running', 'completed']);
  });

  it('si el agente murió mientras el Core estaba caído: interrupted, NUNCA completed', async () => {
    const m1 = env.manager([procAdapter()]);
    const run = await m1.createRun(body({ adapter: 'proc', prompt: 'hang', mode: 'read' }));
    await waitFor(() => env.repos.runs.get(run.id)!.lastSeq >= 1 || undefined);
    const pid = env.repos.runs.get(run.id)!.pid!;
    m1.shutdown();
    await killTree(pid, { force: true }); // muere sin escribir exit.json
    await waitFor(() => !isAlive(pid) || undefined);

    const m2 = env.manager([procAdapter()]);
    expect(await m2.reconcile()).toMatchObject({ reattached: 0, interrupted: 1 });
    expect(state(run.id)).toBe('interrupted');
    expect(env.repos.runs.get(run.id)!.endReason).toMatch(/ya no existe/);
  });

  it('si el agente terminó con éxito mientras el Core estaba caído: se completa con su registro de salida', async () => {
    const m1 = env.manager([procAdapter()]);
    const run = await m1.createRun(body({ adapter: 'proc', prompt: 'ok', mode: 'read' }));
    await waitFor(() => env.repos.runs.get(run.id)!.lastSeq >= 1 || undefined);
    m1.shutdown();
    await sleep(600);
    const m2 = env.manager([procAdapter()]);
    await m2.reconcile();
    await waitFor(() => state(run.id) === 'completed', 8000);
    const kinds = readRunEvents(path.join(env.repos.runs.get(run.id)!.runDir, 'events.ndjson')).map((e) => e.event.kind);
    expect(kinds.filter((k) => k === 'run.finished')).toHaveLength(1);
  });

  it('un run sin adaptador disponible tras el reinicio pasa a interrupted', async () => {
    const m1 = env.manager([procAdapter()]);
    const run = await m1.createRun(body({ adapter: 'proc', prompt: 'slow 30', mode: 'read' }));
    await waitFor(() => env.repos.runs.get(run.id)!.lastSeq >= 1 || undefined);
    m1.shutdown();
    const pid = env.repos.runs.get(run.id)!.pid!;
    const m2 = env.manager([]);
    expect(await m2.reconcile()).toMatchObject({ interrupted: 1 });
    expect(state(run.id)).toBe('interrupted');
    await killTree(pid, { force: true });
  });

  it('marca como huérfano un worktree que ya no existe', async () => {
    const m1 = env.manager([new FakeAdapter()]);
    const run = await m1.createRun(body());
    await waitFor(() => state(run.id) === 'completed');
    const wt = env.repos.worktrees.get(env.repos.runs.get(run.id)!.worktreeId!)!;
    fs.rmSync(wt.path, { recursive: true, force: true });
    const m2 = env.manager([new FakeAdapter()]);
    expect(await m2.reconcile()).toMatchObject({ orphanedWorktrees: 1 });
    expect(env.repos.worktrees.get(wt.id)!.status).toBe('orphaned');
  });
});
