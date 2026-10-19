import type { AgentEvent } from '@aiw/contracts';
import { Channel } from './channel';
import {
  summarize, type AdapterInfo, type AgentAdapter, type RecoverResult, type RunHandle, type RunSession, type StartRequest,
} from './types';
import type { Capabilities, DataPolicy } from '@aiw/contracts';

export interface FakeContext {
  req: StartRequest;
  emit(ev: AgentEvent): void;
  /** Pide aprobación y espera la decisión (o cancelación → 'deny'). */
  approval(tool: string, detail: string): Promise<'allow' | 'deny'>;
  sleep(ms: number): Promise<void>;
  readonly cancelled: boolean;
}

export interface FakeOptions {
  id?: string;
  displayName?: string;
  dataPolicy?: DataPolicy;
  capabilities?: Partial<Capabilities>;
  script?: (ctx: FakeContext) => Promise<void> | void;
}

/** Adaptador en memoria, guionizable. Solo para pruebas y desarrollo (AIW_ENABLE_FAKE=1). */
export class FakeAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly dataPolicy: DataPolicy;
  readonly capabilities: Capabilities;
  readonly started: StartRequest[] = [];
  private script: NonNullable<FakeOptions['script']>;

  constructor(opts: FakeOptions = {}) {
    this.id = opts.id ?? 'fake';
    this.displayName = opts.displayName ?? 'Fake agent';
    this.dataPolicy = opts.dataPolicy ?? 'private-ok';
    this.capabilities = {
      interactiveApprovals: true, resume: 'none', structuredEvents: true, reportsCost: false, planMode: false,
      subagents: false, ...opts.capabilities,
    };
    this.script =
      opts.script ??
      (async (ctx) => {
        ctx.emit({ kind: 'output.delta', text: 'hola desde fake\n', stream: 'assistant' });
      });
  }

  summary() { return summarize(this); }

  async probe(): Promise<AdapterInfo> {
    return { installed: true, version: 'fake', warnings: [] };
  }

  async start(req: StartRequest): Promise<RunSession> {
    this.started.push(req);
    const ch = new Channel<AgentEvent>();
    let cancelled = false;
    const pending = new Map<string, (d: 'allow' | 'deny') => void>();
    let n = 0;
    const ctx: FakeContext = {
      req,
      emit: (ev) => ch.push(ev),
      approval: (tool, detail) =>
        new Promise((resolve) => {
          const approvalId = `ap_${req.runId}_${++n}`;
          pending.set(approvalId, resolve);
          ch.push({ kind: 'approval.requested', approvalId, tool, detail });
        }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      get cancelled() { return cancelled; },
    };
    void (async () => {
      try {
        await this.script(ctx);
        ch.push(cancelled ? { kind: 'run.finished', ok: false, reason: 'cancelled' } : { kind: 'run.finished', ok: true });
      } catch (e) {
        ch.push({ kind: 'error', message: String((e as Error).message), fatal: true });
        ch.push({ kind: 'run.finished', ok: false, reason: 'script-error' });
      } finally {
        ch.close();
      }
    })();
    return {
      handle: { runId: req.runId },
      events: ch,
      dispose: () => ch.close(),
      cancel: async () => {
        cancelled = true;
        for (const r of pending.values()) r('deny');
        pending.clear();
      },
      respondToApproval: async (id, decision) => {
        const r = pending.get(id);
        if (!r) throw new Error(`aprobación desconocida: ${id}`);
        pending.delete(id);
        r(decision);
      },
    };
  }

  async recover(_h: RunHandle): Promise<RecoverResult> {
    return { status: 'interrupted', reason: 'fake adapter no es reenganchable' };
  }
}
