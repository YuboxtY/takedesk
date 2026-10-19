import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  API_VERSION, ApprovalDecisionBody, CreateProjectBody, CreateRunBody, CreateTerminalBody, MergeBody, MIN_CLIENT_VERSION,
  SERVER_VERSION, TerminalClientMessage, type RunDto, type WsMessage,
} from '@aiw/contracts';
import { readRunEvents, type Repos, type RunRow } from '@aiw/database';
import { newId } from '@aiw/domain';
import { summarize, type AgentAdapter } from '@aiw/agent-adapters';
import { assertInside, GitError, repoRoot } from '@aiw/git-engine';
import { TicketStore, tokensEqual } from './auth';
import type { CoreConfig } from './config';
import { ApiError } from './errors';
import type { EventBus } from './event-bus';
import type { PtyManager } from './pty-manager';
import type { ResourceProbe } from './resources';
import type { MergeService } from './merge-service';
import type { RunManager } from './run-manager';

export interface ServerDeps {
  cfg: CoreConfig;
  repos: Repos;
  bus: EventBus;
  runs: RunManager;
  merges: MergeService;
  pty: PtyManager;
  adapters: Map<string, AgentAdapter>;
  token: string;
  probe: ResourceProbe;
  startedAt?: number;
  logger?: boolean;
}

const WS_OUTPUT_DROP_BYTES = 512 * 1024;
const WS_CLOSE_BYTES = 8 * 1024 * 1024;

function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, 'invalid-request', r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; '));
  return r.data;
}

function runDto(r: RunRow, repos: Repos): RunDto {
  const wt = r.worktreeId ? repos.worktrees.get(r.worktreeId) : undefined;
  return {
    id: r.id, projectId: r.projectId, adapter: r.adapter, mode: r.mode as RunDto['mode'], state: r.state as RunDto['state'],
    title: r.title, worktreePath: wt?.path ?? null, branch: wt?.branch ?? null, worktreeStatus: wt?.status ?? null, createdAt: r.createdAt,
    startedAt: r.startedAt, endedAt: r.endedAt, endReason: r.endReason, lastSeq: r.lastSeq,
  };
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export async function buildServer(d: ServerDeps): Promise<FastifyInstance> {
  const { cfg, repos, bus, runs, merges, pty, adapters } = d;
  const tickets = new TicketStore();
  const startedAt = d.startedAt ?? Date.now();

  const app = Fastify({
    logger: d.logger ? { redact: ['req.headers.authorization'] } : false,
    bodyLimit: 1024 * 1024,
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  // JSON tolerante a cuerpo vacío (POST/DELETE sin cuerpo con content-type JSON) y sin claves __proto__.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text, (k, v) => (k === '__proto__' ? undefined : v)));
    } catch {
      done(new ApiError(400, 'invalid-json', 'El cuerpo no es JSON válido'), undefined);
    }
  });

  // --- Defensa contra DNS rebinding: solo hostnames conocidos.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
    if (!cfg.allowedHostnames.includes(hostname)) {
      return reply.code(421).send({ error: { code: 'misdirected-request', message: 'Host no permitido' } });
    }
  });

  // --- Autenticación: Bearer en REST; ticket de un solo uso en WebSocket.
  app.addHook('onRequest', async (req, reply) => {
    const auth = (req.routeOptions.config as { auth?: 'none' | 'ticket' } | undefined)?.auth;
    if (auth === 'none' || auth === 'ticket') return;
    const t = bearer(req);
    if (!t || !tokensEqual(t, d.token)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Token inválido o ausente' } });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof GitError) {
      const status = err.code === 'dirty' || err.code === 'conflict' ? 409 : 400;
      return reply.code(status).send({ error: { code: `git-${err.code}`, message: err.message } });
    }
    const fe = err as { statusCode?: number; message?: string };
    if (fe.statusCode && fe.statusCode < 500) return reply.code(fe.statusCode).send({ error: { code: 'bad-request', message: fe.message ?? 'Solicitud inválida' } });
    req.log.error({ err }, 'error no controlado');
    return reply.code(500).send({ error: { code: 'internal', message: 'Error interno' } });
  });

  // ---------------------------------------------------------------- REST

  app.get('/v1/health', { config: { auth: 'none' } }, async () => ({
    ok: true as const, apiVersion: API_VERSION, serverVersion: SERVER_VERSION, minClient: MIN_CLIENT_VERSION,
  }));

  app.post('/v1/ws-ticket', async () => tickets.issue());

  app.get('/v1/capabilities', async () => ({ adapters: [...adapters.values()].map(summarize) }));

  app.get('/v1/projects', async () => ({ projects: repos.projects.list() }));

  app.post('/v1/projects', async (req, reply) => {
    const body = parse(CreateProjectBody, req.body);
    const root = await repoRoot(body.path); // valida que sea un repo Git y canonicaliza
    const existing = repos.projects.getByPath(root);
    if (existing) {
      repos.projects.touch(existing.id, Date.now());
      return reply.code(200).send(existing);
    }
    const created = repos.projects.create({ id: newId('prj'), name: path.basename(root), rootPath: root, createdAt: Date.now(), lastOpenedAt: Date.now() });
    repos.audit.add(Date.now(), 'local', 'project.add', { projectId: created.id });
    return reply.code(201).send(created);
  });

  app.get('/v1/runs', async (req) => {
    const q = req.query as { projectId?: string };
    return { runs: repos.runs.list(q.projectId).map((r) => runDto(r, repos)) };
  });

  app.post('/v1/runs', async (req, reply) => {
    const row = await runs.createRun(parse(CreateRunBody, req.body));
    return reply.code(201).send(runDto(row, repos));
  });

  app.get('/v1/runs/:id', async (req) => {
    const r = repos.runs.get((req.params as { id: string }).id);
    if (!r) throw new ApiError(404, 'run-not-found', 'Run inexistente');
    return runDto(r, repos);
  });

  app.post('/v1/runs/:id/cancel', async (req) => runDto(await runs.cancel((req.params as { id: string }).id), repos));

  app.get('/v1/runs/:id/events', async (req) => {
    const r = repos.runs.get((req.params as { id: string }).id);
    if (!r) throw new ApiError(404, 'run-not-found', 'Run inexistente');
    if (r.detailPurged) throw new ApiError(410, 'detail-purged', 'El detalle de este run fue purgado por la política de retención');
    const q = req.query as { since?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 1000);
    return { events: readRunEvents(path.join(r.runDir, 'events.ndjson'), Number(q.since ?? 0) || 0, limit) };
  });

  // --- Revisión y fusión del trabajo (CA-04): la fusión exige el commit exacto que se revisó.
  app.get('/v1/runs/:id/diff', async (req) => merges.review((req.params as { id: string }).id));
  app.post('/v1/runs/:id/merge', async (req) => {
    const body = parse(MergeBody, req.body);
    return merges.merge((req.params as { id: string }).id, body.approvedHead);
  });

  app.get('/v1/approvals', async (req) => {
    const q = req.query as { runId?: string };
    return { approvals: repos.approvals.listPending(q.runId) };
  });

  app.post('/v1/approvals/:id', async (req) => {
    const body = parse(ApprovalDecisionBody, req.body);
    await runs.resolveApproval((req.params as { id: string }).id, body.decision);
    return { ok: true };
  });

  app.get('/v1/diagnostics', async () => {
    const dbBytes = ['', '-wal'].reduce((n, s) => n + (fs.existsSync(cfg.dbFile + s) ? fs.statSync(cfg.dbFile + s).size : 0), 0);
    const byState: Record<string, number> = {};
    for (const r of repos.runs.list(undefined, 1000)) byState[r.state] = (byState[r.state] ?? 0) + 1;
    return {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000), lastEventId: bus.lastEventId(), runsByState: byState,
      activeRuns: runs.activeRunIds().length, terminals: pty.list().filter((t) => !t.exited).length,
      dbBytes, freeDiskBytes: d.probe.freeDiskBytes(cfg.dataDir), availableMemBytes: d.probe.availableMemBytes(),
      // Sin rutas de credenciales, sin tokens, sin prompts.
    };
  });

  // --- Terminales (CA-03: viven en el Core)
  app.post('/v1/terminals', async (req, reply) => {
    const body = parse(CreateTerminalBody, req.body);
    const project = repos.projects.get(body.projectId);
    if (!project) throw new ApiError(404, 'project-not-found', 'Proyecto inexistente');
    assertInside(project.rootPath, project.rootPath);
    return reply.code(201).send(pty.create({ projectId: project.id, cwd: project.rootPath, cols: body.cols, rows: body.rows }));
  });
  app.get('/v1/terminals', async () => ({ terminals: pty.list() }));
  app.delete('/v1/terminals/:id', async (req) => {
    pty.kill((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- WebSocket

  app.get('/v1/events', { websocket: true, config: { auth: 'ticket' } }, (socket, req) => {
    const q = req.query as { ticket?: string; since?: string };
    if (!tickets.consume(q.ticket)) return socket.close(1008, 'ticket inválido');
    const send = (m: WsMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > WS_CLOSE_BYTES) return socket.close(1013, 'cliente demasiado lento');
      // contrapresión: la salida en vivo es prescindible (se recupera por REST); los eventos de estado, no
      if (m.channel === 'output' && socket.bufferedAmount > WS_OUTPUT_DROP_BYTES) return;
      socket.send(JSON.stringify(m));
    };
    // 1) suscribirse primero (no se pierde nada), 2) reproducir lo pendiente, 3) deduplicar por eventId
    let lastSent = q.since !== undefined ? Number(q.since) || 0 : bus.lastEventId();
    const buffer: WsMessage[] = [];
    let replaying = true;
    const unsub = bus.subscribe((m) => {
      if (replaying) return void buffer.push(m);
      if (m.channel === 'event') {
        if (m.event.eventId <= lastSent) return;
        lastSent = m.event.eventId;
      }
      send(m);
    });
    send({ channel: 'hello', apiVersion: API_VERSION, lastEventId: bus.lastEventId() });
    if (q.since !== undefined) {
      const rep = bus.replay(lastSent);
      if (rep.resync) send({ channel: 'resync', oldestEventId: rep.resync.oldestEventId });
      for (const e of rep.events) { lastSent = e.eventId; send({ channel: 'event', event: e }); }
    }
    replaying = false;
    for (const m of buffer.splice(0)) {
      if (m.channel === 'event') {
        if (m.event.eventId <= lastSent) continue;
        lastSent = m.event.eventId;
      }
      send(m);
    }
    socket.on('close', unsub);
    socket.on('error', unsub);
  });

  app.get('/v1/terminals/:id/ws', { websocket: true, config: { auth: 'ticket' } }, (socket, req) => {
    const q = req.query as { ticket?: string };
    if (!tickets.consume(q.ticket)) return socket.close(1008, 'ticket inválido');
    const id = (req.params as { id: string }).id;
    if (!pty.get(id)) return socket.close(1008, 'terminal inexistente');
    const send = (m: object) => {
      if (socket.readyState === socket.OPEN && socket.bufferedAmount < WS_CLOSE_BYTES) socket.send(JSON.stringify(m));
    };
    const att = pty.attach(id, {
      onData: (data) => send({ type: 'data', data }),
      onExit: (exitCode) => send({ type: 'exit', exitCode }),
    });
    if (att.scrollback) send({ type: 'data', data: att.scrollback });
    if (att.exited) send({ type: 'exit', exitCode: att.exitCode });
    socket.on('message', (raw) => {
      let msg;
      try { msg = TerminalClientMessage.safeParse(JSON.parse(String(raw))); } catch { return; }
      if (!msg.success) return;
      try {
        if (msg.data.type === 'input') pty.write(id, msg.data.data);
        else pty.resize(id, msg.data.cols, msg.data.rows);
      } catch { /* terminal ya cerrado */ }
    });
    // Cerrar el socket NO mata el terminal (CA-03): solo se deja de escuchar.
    socket.on('close', () => att.detach());
    socket.on('error', () => att.detach());
  });

  return app;
}
