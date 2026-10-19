import path from 'node:path';
import type { AgentEvent, CreateRunBody, RunState } from '@aiw/contracts';
import { RunEventLog, type Repos, type RunRow } from '@aiw/database';
import { ACTIVE_STATES, assertTransition, isTerminal, newId, redact, redactString } from '@aiw/domain';
import type { AgentAdapter, RunSession } from '@aiw/agent-adapters';
import { createWorktree } from '@aiw/git-engine';
import fs from 'node:fs';
import type { CoreConfig } from './config';
import { ApiError } from './errors';
import type { EventBus } from './event-bus';
import { checkAdmission, type ResourceProbe } from './resources';

interface LiveRun {
  session: RunSession;
  log: RunEventLog;
  forceTimer?: NodeJS.Timeout;
}

export interface RunManagerDeps {
  repos: Repos;
  bus: EventBus;
  adapters: Map<string, AgentAdapter>;
  cfg: CoreConfig;
  probe: ResourceProbe;
  now?: () => number;
}

const APPROVAL_SEP = '::';

function summarizeEvent(e: AgentEvent): string {
  switch (e.kind) {
    case 'output.delta': return redactString(e.text).slice(0, 120);
    case 'tool.started': return `tool ${e.name}`;
    case 'tool.finished': return `tool ${e.toolId} ${e.ok ? 'ok' : 'error'}`;
    case 'approval.requested': return `${e.tool}: ${redactString(e.detail).slice(0, 100)}`;
    case 'usage': return e.rateLimited ? 'límite de cuota' : 'uso';
    case 'session': return `sesión ${e.externalSessionId}`;
    case 'error': return redactString(e.message).slice(0, 120);
    case 'run.finished': return e.ok ? 'terminó OK' : `terminó con fallo: ${e.reason ?? ''}`;
  }
}

/**
 * Orquesta el ciclo de vida de los runs: cola con límites (global, por proveedor, recursos y
 * cuota), worktree por run de escritura, persistencia de eventos, aprobaciones, cancelación y
 * reconciliación tras un reinicio. Todo estado de run cambia SOLO a través de setState().
 */
export class RunManager {
  private live = new Map<string, LiveRun>();
  private pausedUntil = new Map<string, number>();
  private pumpChain: Promise<void> = Promise.resolve();
  private lastDegradedAt = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly d: RunManagerDeps) {
    this.now = d.now ?? Date.now;
  }

  // ------------------------------------------------------------------ creación

  async createRun(body: CreateRunBody): Promise<RunRow> {
    const { repos, bus } = this.d;
    const project = repos.projects.get(body.projectId);
    if (!project) throw new ApiError(404, 'project-not-found', 'Proyecto inexistente');
    const adapter = this.d.adapters.get(body.adapter);
    if (!adapter) throw new ApiError(400, 'unknown-adapter', `Adaptador desconocido: ${body.adapter}`);
    if (adapter.dataPolicy === 'may-train' && !body.acceptDataPolicy) {
      throw new ApiError(
        409,
        'data-policy-confirmation-required',
        `${adapter.displayName} puede usar tus datos para mejorar sus modelos. Confirma explícitamente (acceptDataPolicy) para continuar.`,
      );
    }
    const info = await adapter.probe();
    if (!info.installed) throw new ApiError(400, 'adapter-not-installed', info.warnings.join('; ') || 'Agente no instalado');

    const id = newId('run');
    const row = repos.runs.create({
      id,
      projectId: project.id,
      adapter: adapter.id,
      mode: body.mode,
      title: body.title ?? null,
      // El prompt real se guarda (un run en cola debe sobrevivir a un reinicio sin alterarse). La BD y sus
      // backups contienen por tanto texto del usuario: tratarlos como sensibles (docs/06). Nunca se registra en logs.
      prompt: body.prompt,
      state: 'queued',
      runDir: path.join(this.d.cfg.runsDir, id),
      createdAt: this.now(),
    });
    bus.publish('run.created', { projectId: project.id, runId: id }, { adapter: adapter.id, mode: body.mode, title: row.title });
    repos.audit.add(this.now(), 'local', 'run.create', { runId: id, adapter: adapter.id, mode: body.mode });
    void this.pump();
    return row;
  }

  // ------------------------------------------------------------------ estado

  private setState(runId: string, to: RunState, extra: Partial<RunRow> = {}, reason?: string): RunRow {
    const { repos, bus } = this.d;
    const cur = repos.runs.get(runId);
    if (!cur) throw new Error(`run inexistente: ${runId}`);
    assertTransition(cur.state as RunState, to);
    const patch: Partial<RunRow> = { state: to, ...extra };
    if (isTerminal(to) && patch.endedAt === undefined) patch.endedAt = this.now();
    repos.runs.update(runId, patch);
    bus.publish('run.state_changed', { projectId: cur.projectId, runId }, { from: cur.state, to, reason: reason ?? null });
    return repos.runs.get(runId)!;
  }

  // ------------------------------------------------------------------ planificador

  pump(): Promise<void> {
    this.pumpChain = this.pumpChain.then(() => this.pumpOnce()).catch(() => undefined);
    return this.pumpChain;
  }

  private isPaused(adapter: string): boolean {
    const until = this.pausedUntil.get(adapter);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.pausedUntil.delete(adapter);
      return false;
    }
    return true;
  }

  private async pumpOnce(): Promise<void> {
    const { repos, cfg } = this.d;
    for (const run of repos.runs.listByStates(['queued'])) {
      if (repos.runs.countByStates(ACTIVE_STATES) >= cfg.maxConcurrentRuns) return;
      if (repos.runs.countByStates(ACTIVE_STATES, run.adapter) >= cfg.maxPerProvider) continue;
      if (this.isPaused(run.adapter)) continue;
      const adm = checkAdmission(cfg, this.d.probe);
      if (!adm.ok) {
        if (this.now() - this.lastDegradedAt > 60_000) {
          this.lastDegradedAt = this.now();
          this.d.bus.publish('system.degraded', {}, { reason: adm.reason, effect: 'runs en cola no se inician' });
        }
        return;
      }
      await this.startRun(run);
    }
  }

  private async startRun(run: RunRow): Promise<void> {
    const { repos, bus, cfg } = this.d;
    this.setState(run.id, 'starting');
    try {
      const project = repos.projects.get(run.projectId)!;
      const adapter = this.d.adapters.get(run.adapter);
      if (!adapter) throw new Error(`adaptador no disponible: ${run.adapter}`);
      let cwd = project.rootPath;
      let worktreeId: string | null = null;
      if (run.mode === 'write') {
        const wt = await createWorktree({
          repo: project.rootPath, worktreesRoot: cfg.worktreesDir, projectId: project.id, taskId: run.id,
          slug: run.title ?? run.prompt.slice(0, 40),
        });
        worktreeId = newId('wt');
        repos.worktrees.create({
          id: worktreeId, projectId: project.id, branch: wt.branch, path: wt.path, baseCommit: wt.baseCommit,
          status: 'active', createdAt: this.now(),
        });
        repos.runs.update(run.id, { worktreeId });
        bus.publish('worktree.created', { projectId: project.id, runId: run.id }, { branch: wt.branch });
        cwd = wt.path;
      }
      const prompt = run.prompt;
      const session = await adapter.start({ runId: run.id, cwd, prompt, mode: run.mode as 'read' | 'write', runDir: run.runDir });
      repos.runs.update(run.id, {
        pid: session.handle.pid ?? null, pidStartToken: session.handle.pidStartToken ?? null, startedAt: this.now(),
      });
      if (repos.runs.get(run.id)!.state === 'starting') this.setState(run.id, 'running');
      void this.consume(run.id, session, 0);
    } catch (e) {
      const msg = (e as Error).message;
      this.setState(run.id, 'failed', { endReason: redactString(`start-failed: ${msg}`).slice(0, 300) });
      void this.pump();
    }
  }

  // ------------------------------------------------------------------ consumo de eventos

  private async consume(runId: string, session: RunSession, skip: number): Promise<void> {
    const { repos, bus } = this.d;
    const row0 = repos.runs.get(runId)!;
    const log = new RunEventLog(path.join(row0.runDir, 'events.ndjson'));
    this.live.set(runId, { session, log });
    let seq = row0.lastSeq;
    let seen = 0;
    let finished = false;
    try {
      for await (const ev of session.events) {
        if (this.stopped) break;
        seen++;
        if (seen <= skip) continue; // ya persistido antes de la caída
        seq++;
        const ts = this.now();
        const { offset } = log.append({ runId, seq, ts, event: ev });
        repos.eventIndex.add({ runId, seq, kind: ev.kind, fileOffset: offset, summary: summarizeEvent(ev), ts });
        repos.runs.update(runId, { lastSeq: seq });
        bus.publishOutput(runId, seq, ts, redact(ev));
        if (ev.kind === 'session') repos.runs.update(runId, { externalSessionId: ev.externalSessionId });
        else if (ev.kind === 'approval.requested') this.onApproval(runId, ev);
        else if (ev.kind === 'usage' && ev.rateLimited) this.pauseProvider(row0.adapter);
        else if (ev.kind === 'run.finished') {
          finished = true;
          this.finalize(runId, ev);
        }
      }
    } catch (e) {
      if (!finished && !this.stopped) bus.publish('system.degraded', { runId }, { reason: `error leyendo eventos: ${(e as Error).message}` });
    } finally {
      if (!finished && !this.stopped) this.finalize(runId, { kind: 'run.finished', ok: false, reason: 'adapter-ended-without-result' });
      const l = this.live.get(runId);
      if (l?.forceTimer) clearTimeout(l.forceTimer);
      log.close();
      this.live.delete(runId);
      if (!this.stopped) void this.pump();
    }
  }

  private onApproval(runId: string, ev: Extract<AgentEvent, { kind: 'approval.requested' }>): void {
    const { repos, bus } = this.d;
    const id = `${runId}${APPROVAL_SEP}${ev.approvalId}`;
    repos.approvals.create({ id, runId, tool: ev.tool, detail: redactString(ev.detail).slice(0, 2000), status: 'pending', createdAt: this.now() });
    const run = repos.runs.get(runId)!;
    if (run.state === 'running') this.setState(runId, 'waiting_approval');
    bus.publish('approval.requested', { projectId: run.projectId, runId }, { approvalId: id, tool: ev.tool, detail: redactString(ev.detail).slice(0, 500) });
  }

  private finalize(runId: string, ev: Extract<AgentEvent, { kind: 'run.finished' }>): void {
    const { repos } = this.d;
    const run = repos.runs.get(runId)!;
    if (isTerminal(run.state as RunState)) return;
    // aprobaciones pendientes de un run terminado ya no se pueden contestar
    for (const a of repos.approvals.listPending(runId)) repos.approvals.resolve(a.id, 'expired', this.now(), 'system');

    let to: RunState;
    if (ev.ok) to = 'completed'; // evidencia: el agente informó éxito
    else if (run.cancelRequested) to = 'cancelled';
    else to = 'failed';
    if (to === 'completed' && run.state === 'waiting_approval') this.setState(runId, 'running');
    this.setState(runId, to, { endReason: ev.reason ? redactString(ev.reason).slice(0, 300) : null });
  }

  private pauseProvider(adapter: string): void {
    const until = this.now() + this.d.cfg.quotaPauseMs;
    this.pausedUntil.set(adapter, until);
    this.d.bus.publish('provider.paused', {}, { adapter, until, reason: 'límite de cuota alcanzado' });
    setTimeout(() => void this.pump(), this.d.cfg.quotaPauseMs + 50).unref();
  }

  resumeProvider(adapter: string): void {
    this.pausedUntil.delete(adapter);
    void this.pump();
  }

  // ------------------------------------------------------------------ acciones del usuario

  async cancel(runId: string): Promise<RunRow> {
    const { repos } = this.d;
    const run = repos.runs.get(runId);
    if (!run) throw new ApiError(404, 'run-not-found', 'Run inexistente');
    const state = run.state as RunState;
    if (state === 'queued') {
      return this.setState(runId, 'cancelled', {}, 'cancelado antes de iniciar');
    }
    if (isTerminal(state) || state === 'cancelling') return run;
    if (!ACTIVE_STATES.includes(state)) throw new ApiError(409, 'not-cancellable', `No se puede cancelar en estado ${state}`);
    repos.runs.update(runId, { cancelRequested: 1 });
    this.setState(runId, 'cancelling');
    repos.audit.add(this.now(), 'local', 'run.cancel', { runId });
    const live = this.live.get(runId);
    if (live) {
      await live.session.cancel('graceful');
      live.forceTimer = setTimeout(() => void live.session.cancel('force'), this.d.cfg.cancelGraceMs);
      live.forceTimer.unref();
    }
    return repos.runs.get(runId)!;
  }

  async resolveApproval(approvalId: string, decision: 'allow' | 'deny', by = 'local'): Promise<void> {
    const { repos, bus } = this.d;
    const ap = repos.approvals.get(approvalId);
    if (!ap) throw new ApiError(404, 'approval-not-found', 'Aprobación inexistente');
    if (ap.status !== 'pending') throw new ApiError(409, 'approval-not-pending', `La aprobación ya está ${ap.status}`);
    const live = this.live.get(ap.runId);
    if (!live?.session.respondToApproval) throw new ApiError(409, 'run-not-attached', 'El run no admite aprobaciones en este momento');
    const original = approvalId.slice(approvalId.indexOf(APPROVAL_SEP) + APPROVAL_SEP.length);
    await live.session.respondToApproval(original, decision);
    repos.approvals.resolve(approvalId, decision === 'allow' ? 'allowed' : 'denied', this.now(), by);
    repos.audit.add(this.now(), by, 'approval.decide', { approvalId, decision, tool: ap.tool });
    const run = repos.runs.get(ap.runId)!;
    bus.publish('approval.resolved', { projectId: run.projectId, runId: run.id }, { approvalId, decision });
    if (run.state === 'waiting_approval' && repos.approvals.listPending(run.id).length === 0) this.setState(run.id, 'running');
  }

  // ------------------------------------------------------------------ reconciliación (CA-08, CA-11)

  /**
   * Tras un reinicio del Core: ningún run activo se da por terminado sin evidencia.
   * Cada uno pasa por pending_reconciliation y termina en running (reenganchado),
   * resumable o interrupted.
   */
  async reconcile(): Promise<{ reattached: number; interrupted: number; resumable: number; orphanedWorktrees: number }> {
    const { repos, bus, adapters } = this.d;
    const res = { reattached: 0, interrupted: 0, resumable: 0, orphanedWorktrees: 0 };
    const candidates = repos.runs.listByStates([...ACTIVE_STATES, 'pending_reconciliation']);
    for (const run of candidates) {
      if (run.state !== 'pending_reconciliation') this.setState(run.id, 'pending_reconciliation', {}, 'reinicio del Core');
      for (const a of repos.approvals.listPending(run.id)) repos.approvals.resolve(a.id, 'expired', this.now(), 'system');
      const adapter = adapters.get(run.adapter);
      if (!adapter) {
        this.setState(run.id, 'interrupted', { endReason: 'adaptador no disponible tras reinicio' });
        res.interrupted++;
        continue;
      }
      const wt = run.worktreeId ? repos.worktrees.get(run.worktreeId) : null;
      const project = repos.projects.get(run.projectId)!;
      const out = await adapter.recover(
        { runId: run.id, pid: run.pid ?? undefined, pidStartToken: run.pidStartToken },
        { runDir: run.runDir, cwd: wt?.path ?? project.rootPath, externalSessionId: run.externalSessionId },
      );
      if (out.status === 'reattached') {
        this.setState(run.id, 'running', {}, 'reenganchado');
        res.reattached++;
        if (run.cancelRequested) {
          this.setState(run.id, 'cancelling');
          void out.session.cancel('force');
        }
        void this.consume(run.id, out.session, run.lastSeq);
      } else if (out.status === 'resumable') {
        this.setState(run.id, 'resumable', { externalSessionId: out.externalSessionId });
        res.resumable++;
      } else {
        this.setState(run.id, 'interrupted', { endReason: out.reason.slice(0, 300) });
        res.interrupted++;
      }
    }
    for (const w of repos.worktrees.listByStatus('active')) {
      if (!fs.existsSync(w.path)) {
        repos.worktrees.setStatus(w.id, 'orphaned');
        res.orphanedWorktrees++;
      }
    }
    if (res.orphanedWorktrees) bus.publish('system.degraded', {}, { reason: `${res.orphanedWorktrees} worktree(s) ya no existen en disco` });
    void this.pump();
    return res;
  }

  // ------------------------------------------------------------------ ciclo de vida

  /** Detener el Core NO mata a los agentes desacoplados; solo suelta los recursos propios. */
  shutdown(): void {
    this.stopped = true; // los consumidores en curso salen sin finalizar ningún run
    for (const [, l] of this.live) {
      if (l.forceTimer) clearTimeout(l.forceTimer);
      l.session.dispose();
      l.log.close();
    }
    this.live.clear();
  }

  activeRunIds(): string[] {
    return [...this.live.keys()];
  }

  async idle(): Promise<void> {
    await this.pumpChain;
  }
}
