import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastOpenedAt: integer('last_opened_at'),
});

export const worktree = sqliteTable(
  'worktree',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => project.id),
    branch: text('branch').notNull(),
    path: text('path').notNull(),
    baseCommit: text('base_commit').notNull(),
    /** active | merged | removed | orphaned */
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('worktree_project_idx').on(t.projectId, t.status)],
);

export const agentRun = sqliteTable(
  'agent_run',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => project.id),
    adapter: text('adapter').notNull(),
    mode: text('mode').notNull(),
    title: text('title'),
    prompt: text('prompt').notNull(),
    state: text('state').notNull(),
    worktreeId: text('worktree_id').references(() => worktree.id),
    /** pid del proceso que sostiene al agente (wrapper) y token de inicio para evitar reutilización de PID */
    pid: integer('pid'),
    pidStartToken: text('pid_start_token'),
    externalSessionId: text('external_session_id'),
    runDir: text('run_dir').notNull(),
    lastSeq: integer('last_seq').notNull().default(0),
    cancelRequested: integer('cancel_requested').notNull().default(0),
    detailPurged: integer('detail_purged').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    endReason: text('end_reason'),
  },
  (t) => [index('run_state_idx').on(t.state), index('run_project_idx').on(t.projectId, t.createdAt)],
);

export const agentEventIndex = sqliteTable(
  'agent_event_index',
  {
    runId: text('run_id').notNull().references(() => agentRun.id),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    /** posición en bytes dentro de events.ndjson */
    fileOffset: integer('file_offset').notNull(),
    summary: text('summary').notNull(),
    ts: integer('ts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const approval = sqliteTable(
  'approval',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull().references(() => agentRun.id),
    tool: text('tool').notNull(),
    detail: text('detail').notNull(),
    /** pending | allowed | denied | expired */
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'),
  },
  (t) => [index('approval_run_idx').on(t.runId, t.status)],
);

/** Eventos durables del Core (estado), con id autoincremental = eventId. */
export const coreEvent = sqliteTable('core_event', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(),
  type: text('type').notNull(),
  scopeJson: text('scope_json').notNull(),
  payloadJson: text('payload_json').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  detailJson: text('detail_json').notNull(),
});

export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});
