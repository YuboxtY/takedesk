import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { FakeAdapter } from '@aiw/agent-adapters';
import { git } from '@aiw/git-engine';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MergeService } from '../src/merge-service';
import { PtyManager } from '../src/pty-manager';
import { buildServer } from '../src/server';
import { deferred, makeEnv, sleep, waitFor, type Env } from './helpers';

const TOKEN = 't'.repeat(43);
let env: Env;
let app: FastifyInstance;
let base: string;
let pty: PtyManager;

beforeEach(async () => {
  env = await makeEnv();
  const adapters = [new FakeAdapter(), new FakeAdapter({ id: 'free', dataPolicy: 'may-train' })];
  const runs = env.manager(adapters);
  pty = new PtyManager({ shell: env.cfg.shell, maxSessions: 3, exitedTtlMs: 200 });
  app = await buildServer({
    cfg: env.cfg, repos: env.repos, bus: env.bus, runs, merges: new MergeService({ repos: env.repos, bus: env.bus }), pty, adapters: new Map(adapters.map((a) => [a.id, a])), token: TOKEN, probe: env.probe,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  pty.killAll();
  await app.close();
  env.cleanup();
});

const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
const json = async (r: Response) => r.json() as Promise<any>;
const WIN = process.platform === 'win32';

async function addProject(): Promise<string> {
  const r = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ path: env.repo }) });
  return (await json(r)).id;
}
async function ticket(): Promise<string> {
  return (await json(await api('/v1/ws-ticket', { method: 'POST' }))).ticket;
}

describe('seguridad de la API', () => {
  it('/health es público y mínimo (sin datos sensibles)', async () => {
    const r = await fetch(`${base}/v1/health`);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ ok: true, apiVersion: 1 });
    expect(Object.keys(b).sort()).toEqual(['apiVersion', 'minClient', 'ok', 'serverVersion']);
  });

  it('exige token en el resto de rutas', async () => {
    expect((await fetch(`${base}/v1/projects`)).status).toBe(401);
    expect((await fetch(`${base}/v1/projects`, { headers: { authorization: 'Bearer mal' } })).status).toBe(401);
    expect((await fetch(`${base}/v1/projects`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('rechaza Host no permitido (DNS rebinding)', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/health', headers: { host: 'evil.example.com' } });
    expect(r.statusCode).toBe(421);
    const ok = await app.inject({ method: 'GET', url: '/v1/health', headers: { host: 'localhost:47821' } });
    expect(ok.statusCode).toBe(200);
  });

  it('diagnóstico no filtra el token ni rutas de credenciales', async () => {
    const txt = JSON.stringify(await json(await api('/v1/diagnostics')));
    expect(txt).not.toContain(TOKEN);
    expect(txt).not.toContain('api-token');
  });

  it('errores de validación devuelven 400 con detalle; los internos no filtran información', async () => {
    const r = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId: 'x' }) });
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe('invalid-request');
    const nf = await api('/v1/runs/no-existe');
    expect(nf.status).toBe(404);
  });
});

describe('proyectos y runs por HTTP', () => {
  it('registra un repo Git (idempotente) y rechaza lo que no es repo', async () => {
    const id = await addProject();
    expect(id).toMatch(/^prj_/);
    expect(await addProject()).toBe(id);
    const notRepo = path.join(env.tmp, 'plain');
    fs.mkdirSync(notRepo);
    const r = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ path: notRepo }) });
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe('git-not-a-repo');
  });

  it('ejecuta un run, expone sus eventos paginados y rechaza adaptadores con política de datos sin confirmar', async () => {
    const projectId = await addProject();
    const created = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId, adapter: 'fake', prompt: 'hola' }) });
    expect(created.status).toBe(201);
    const run = await json(created);
    await waitFor(async () => (await json(await api(`/v1/runs/${run.id}`))).state === 'completed');
    const ev = await json(await api(`/v1/runs/${run.id}/events?since=1`));
    expect(ev.events.map((e: any) => e.seq)).toEqual([2]);
    const free = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId, adapter: 'free', prompt: 'x' }) });
    expect(free.status).toBe(409);
    expect((await json(free)).error.code).toBe('data-policy-confirmation-required');
    const caps = await json(await api('/v1/capabilities'));
    expect(caps.adapters.map((a: any) => a.id).sort()).toEqual(['fake', 'free']);
  });
});

// ------------------------------------------------------------------ WebSocket de eventos

function wsClient(url: string) {
  const ws = new WebSocket(url);
  const msgs: any[] = [];
  const closed = deferred<number>();
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  ws.on('close', (code) => closed.resolve(code));
  ws.on('error', () => {});
  return { ws, msgs, closed: closed.promise, opened: new Promise<void>((r) => ws.once('open', () => r())) };
}
const wsUrl = (p: string) => base.replace('http', 'ws') + p;

describe('WebSocket /v1/events', () => {
  it('sin ticket o con ticket reutilizado se cierra (1008); el ticket es de un solo uso', async () => {
    const a = wsClient(wsUrl('/v1/events'));
    expect(await a.closed).toBe(1008);
    const t = await ticket();
    const b = wsClient(wsUrl(`/v1/events?ticket=${t}`));
    await b.opened;
    await waitFor(() => b.msgs.find((m) => m.channel === 'hello'));
    b.ws.close();
    const c = wsClient(wsUrl(`/v1/events?ticket=${t}`));
    expect(await c.closed).toBe(1008);
  });

  it('difunde estado y salida en vivo, y reanuda con ?since sin duplicados ni huecos', async () => {
    const projectId = await addProject();
    const live = wsClient(wsUrl(`/v1/events?ticket=${await ticket()}`));
    await live.opened;
    await waitFor(() => live.msgs.find((m) => m.channel === 'hello'));
    const run = await json(await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId, adapter: 'fake', prompt: 'x' }) }));
    await waitFor(() => live.msgs.find((m) => m.channel === 'event' && m.event.type === 'run.state_changed' && m.event.payload.to === 'completed'));
    expect(live.msgs.some((m) => m.channel === 'output' && m.runId === run.id)).toBe(true);
    const liveIds = live.msgs.filter((m) => m.channel === 'event').map((m) => m.event.eventId);
    expect(liveIds).toEqual([...liveIds].sort((a, b) => a - b));
    expect(new Set(liveIds).size).toBe(liveIds.length);
    live.ws.close();

    // un cliente que se desconectó tras el evento N recupera exactamente lo posterior
    const all = env.repos.coreEvents.since(0).map((e) => e.id);
    const since = all[1]!;
    const re = wsClient(wsUrl(`/v1/events?since=${since}&ticket=${await ticket()}`));
    await re.opened;
    await waitFor(() => re.msgs.filter((m) => m.channel === 'event').length >= all.length - 2);
    await sleep(100);
    expect(re.msgs.filter((m) => m.channel === 'event').map((m) => m.event.eventId)).toEqual(all.slice(2));
    re.ws.close();
  });

  it('pide resync si el hueco solicitado ya no está retenido', async () => {
    for (let i = 0; i < 5; i++) env.repos.coreEvents.append(1000 + i, 'run.created', {}, {});
    env.repos.coreEvents.pruneBefore(1003); // deja los ids 4 y 5
    const c = wsClient(wsUrl(`/v1/events?since=1&ticket=${await ticket()}`));
    await c.opened;
    const rs = await waitFor(() => c.msgs.find((m) => m.channel === 'resync'));
    expect(rs.oldestEventId).toBe(4);
    c.ws.close();
  });
});

// ------------------------------------------------------------------ CA-03: terminales en el Core

describe('Terminales (CA-03)', () => {
  it('sobreviven al cierre del cliente: se reconecta y se recupera el scrollback', async () => {
    const projectId = await addProject();
    const created = await api('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId, cols: 100, rows: 30 }) });
    expect(created.status).toBe(201);
    const term = await json(created);

    const c1 = wsClient(wsUrl(`/v1/terminals/${term.id}/ws?ticket=${await ticket()}`));
    await c1.opened;
    c1.ws.send(JSON.stringify({ type: 'input', data: WIN ? 'echo hola-$(20+22)\r' : 'echo hola-$((20+22))\n' }));
    await waitFor(() => c1.msgs.map((m) => m.data ?? '').join('').includes('hola-42'), 5000, 'eco del terminal');
    c1.ws.close(); // "se cierra Electron"
    await c1.closed;

    expect((await json(await api('/v1/terminals'))).terminals.find((t: any) => t.id === term.id).exited).toBe(false);

    const c2 = wsClient(wsUrl(`/v1/terminals/${term.id}/ws?ticket=${await ticket()}`));
    await c2.opened;
    await waitFor(() => c2.msgs.map((m) => m.data ?? '').join('').includes('hola-42'), 5000, 'scrollback tras reconectar');
    // y sigue interactivo
    c2.ws.send(JSON.stringify({ type: 'input', data: WIN ? 'echo otra-$(1+1)\r' : 'echo otra-$((1+1))\n' }));
    await waitFor(() => c2.msgs.map((m) => m.data ?? '').join('').includes('otra-2'), 5000);
    // mensajes inválidos se ignoran sin romper
    c2.ws.send('no es json');
    c2.ws.send(JSON.stringify({ type: 'input', data: 'x'.repeat(70000) }));
    c2.ws.send(JSON.stringify({ type: 'input', data: WIN ? 'exit\r' : 'exit\n' }));
    await waitFor(() => c2.msgs.find((m) => m.type === 'exit'), 5000, 'salida del shell');
    c2.ws.close();
  });

  it('exige ticket, proyecto válido y respeta el máximo de terminales', async () => {
    const projectId = await addProject();
    expect((await api('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId: 'nope' }) })).status).toBe(404);
    const t = await json(await api('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId }) }));
    const noTicket = wsClient(wsUrl(`/v1/terminals/${t.id}/ws`));
    expect(await noTicket.closed).toBe(1008);
    await api('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId }) });
    await api('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId }) });
    const over = await api('/v1/terminals', { method: 'POST', body: JSON.stringify({ projectId }) });
    expect(over.status).toBe(429);
    expect((await api(`/v1/terminals/${t.id}`, { method: 'DELETE' })).status).toBe(200);
    await waitFor(async () => (await json(await api('/v1/terminals'))).terminals.find((x: any) => x.id === t.id)?.exited ?? true);
  });
});

it('git del helper de pruebas está disponible', async () => {
  expect((await git(env.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
});
