import { z } from 'zod';

export const API_VERSION = 1 as const;
export const SERVER_VERSION = '0.1.0';
/** Cliente mínimo aceptado por el Core (negociado en GET /v1/health). */
export const MIN_CLIENT_VERSION = '0.1.0';

// ---------------------------------------------------------------- estados

export const RunState = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'pending_reconciliation',
  'resumable',
  'interrupted',
]);
export type RunState = z.infer<typeof RunState>;

export const RunMode = z.enum(['read', 'write']);
export type RunMode = z.infer<typeof RunMode>;

// ---------------------------------------------------------------- adaptadores

export const Capabilities = z.object({
  interactiveApprovals: z.boolean(),
  resume: z.enum(['native', 'context-only', 'none']),
  structuredEvents: z.boolean(),
  reportsCost: z.boolean(),
  planMode: z.boolean(),
  subagents: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** 'may-train': el proveedor puede usar los datos para mejorar modelos (p. ej. modelos gratuitos). */
export const DataPolicy = z.enum(['private-ok', 'may-train']);
export type DataPolicy = z.infer<typeof DataPolicy>;

export const AdapterSummary = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: Capabilities,
  dataPolicy: DataPolicy,
});
export type AdapterSummary = z.infer<typeof AdapterSummary>;

// ---------------------------------------------------------------- eventos de agente (normalizados)

export const AgentEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('output.delta'),
    text: z.string(),
    stream: z.enum(['stdout', 'stderr', 'assistant']).default('stdout'),
  }),
  z.object({
    kind: z.literal('tool.started'),
    toolId: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('tool.finished'),
    toolId: z.string(),
    ok: z.boolean(),
    summary: z.string().optional(),
  }),
  z.object({
    kind: z.literal('approval.requested'),
    approvalId: z.string(),
    tool: z.string(),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal('usage'),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    /** El proveedor indicó que se alcanzó un límite de cuota. */
    rateLimited: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('session'), externalSessionId: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string(), fatal: z.boolean().default(false) }),
  z.object({ kind: z.literal('run.finished'), ok: z.boolean(), reason: z.string().optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** Registro persistido en events.ndjson. */
export const StoredEvent = z.object({
  runId: z.string(),
  seq: z.number().int().positive(),
  ts: z.number().int(),
  event: AgentEvent,
});
export type StoredEvent = z.infer<typeof StoredEvent>;

// ---------------------------------------------------------------- eventos del Core (durables, con eventId)

export const CoreEventType = z.enum([
  'run.created',
  'run.state_changed',
  'approval.requested',
  'approval.resolved',
  'worktree.created',
  'worktree.removed',
  'worktree.merged',
  'provider.paused',
  'system.degraded',
]);
export type CoreEventType = z.infer<typeof CoreEventType>;

export const CoreEvent = z.object({
  eventId: z.number().int().positive(),
  ts: z.number().int(),
  v: z.literal(1),
  type: CoreEventType,
  scope: z.object({ projectId: z.string().optional(), runId: z.string().optional() }),
  payload: z.record(z.string(), z.unknown()),
});
export type CoreEvent = z.infer<typeof CoreEvent>;

/**
 * Mensajes del WebSocket /v1/events.
 * - 'event': durable, con eventId; se puede reanudar con ?since=<eventId>.
 * - 'output': salida en vivo de un run; NO es durable en el canal (se recupera por
 *   GET /v1/runs/:id/events?since=<seq>), puede descartarse con contrapresión.
 * - 'resync': el hueco pedido ya no está retenido; el cliente debe recargar estado por REST.
 */
export const WsMessage = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('event'), event: CoreEvent }),
  z.object({
    channel: z.literal('output'),
    runId: z.string(),
    seq: z.number().int(),
    ts: z.number().int(),
    event: AgentEvent,
  }),
  z.object({ channel: z.literal('resync'), oldestEventId: z.number().int() }),
  z.object({ channel: z.literal('hello'), apiVersion: z.literal(API_VERSION), lastEventId: z.number().int() }),
]);
export type WsMessage = z.infer<typeof WsMessage>;

// ---------------------------------------------------------------- API HTTP

export const Health = z.object({
  ok: z.literal(true),
  apiVersion: z.literal(API_VERSION),
  serverVersion: z.string(),
  minClient: z.string(),
});
export type Health = z.infer<typeof Health>;

export const CreateProjectBody = z.object({ path: z.string().min(1) });
export const ProjectDto = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.number(),
  lastOpenedAt: z.number().nullable(),
});
export type ProjectDto = z.infer<typeof ProjectDto>;

export const CreateRunBody = z.object({
  projectId: z.string().min(1),
  adapter: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  mode: RunMode.default('write'),
  title: z.string().max(200).optional(),
  /** Obligatorio en true para adaptadores con dataPolicy 'may-train'. */
  acceptDataPolicy: z.boolean().optional(),
});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const RunDto = z.object({
  id: z.string(),
  projectId: z.string(),
  adapter: z.string(),
  mode: RunMode,
  state: RunState,
  title: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  /** active | merged | removed | orphaned; null si el run no tiene worktree. */
  worktreeStatus: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: z.string().nullable(),
  lastSeq: z.number(),
});
export type RunDto = z.infer<typeof RunDto>;

export const ApprovalDecisionBody = z.object({ decision: z.enum(['allow', 'deny']) });

export const MergeBody = z.object({
  /** Commit exacto que el usuario revisó (DiffReview.reviewedHead). */
  approvedHead: z.string().regex(/^[0-9a-f]{7,64}$/),
});

export const CreateTerminalBody = z.object({
  projectId: z.string().min(1),
  cols: z.number().int().min(10).max(500).default(120),
  rows: z.number().int().min(2).max(200).default(30),
});

export const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(2).max(200),
  }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

export const TerminalServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().nullable() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;
