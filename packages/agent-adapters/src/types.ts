import type { AgentEvent, AdapterSummary, Capabilities, DataPolicy, RunMode } from '@aiw/contracts';

export interface StartRequest {
  runId: string;
  /** Directorio de trabajo del agente (worktree). */
  cwd: string;
  prompt: string;
  mode: RunMode;
  /** Directorio del run: aquí viven output.log, exit.json, etc. */
  runDir: string;
  env?: Record<string, string>;
}

export interface RunHandle {
  runId: string;
  /** PID del proceso que sostiene al agente (wrapper desacoplado), si existe. */
  pid?: number;
  pidStartToken?: string | null;
}

export interface RunSession {
  handle: RunHandle;
  /** Termina (se cierra) tras emitir 'run.finished'. */
  events: AsyncIterable<AgentEvent>;
  cancel(mode: 'graceful' | 'force'): Promise<void>;
  /** Deja de observar al agente SIN terminarlo (el Core se está apagando). */
  dispose(): void;
  /** Solo si capabilities.interactiveApprovals. */
  respondToApproval?(approvalId: string, decision: 'allow' | 'deny'): Promise<void>;
}

export interface RecoverRequest {
  runDir: string;
  cwd: string;
  externalSessionId?: string | null;
}

export type RecoverResult =
  | { status: 'reattached'; session: RunSession }
  | { status: 'resumable'; externalSessionId: string }
  | { status: 'interrupted'; reason: string };

export interface AdapterInfo {
  installed: boolean;
  path?: string;
  version?: string;
  /** Aviso (p. ej. shim .cmd en Windows, CLI sin autenticar). */
  warnings: string[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  readonly dataPolicy: DataPolicy;
  probe(): Promise<AdapterInfo>;
  start(req: StartRequest): Promise<RunSession>;
  recover(handle: RunHandle, req: RecoverRequest): Promise<RecoverResult>;
}

export function summarize(a: AgentAdapter): AdapterSummary {
  return { id: a.id, displayName: a.displayName, capabilities: a.capabilities, dataPolicy: a.dataPolicy };
}

export const NO_CAPABILITIES: Capabilities = {
  interactiveApprovals: false,
  resume: 'none',
  structuredEvents: false,
  reportsCost: false,
  planMode: false,
  subagents: false,
};
