import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { RunState } from '@aiw/contracts';
import type { Db } from './db';
import * as s from './schema';

export type ProjectRow = typeof s.project.$inferSelect;
export type RunRow = typeof s.agentRun.$inferSelect;
export type WorktreeRow = typeof s.worktree.$inferSelect;
export type ApprovalRow = typeof s.approval.$inferSelect;
export type CoreEventRow = typeof s.coreEvent.$inferSelect;

export function createRepos(db: Db) {
  return {
    projects: {
      create(row: typeof s.project.$inferInsert): ProjectRow {
        return db.insert(s.project).values(row).returning().get();
      },
      get: (id: string) => db.select().from(s.project).where(eq(s.project.id, id)).get(),
      getByPath: (rootPath: string) => db.select().from(s.project).where(eq(s.project.rootPath, rootPath)).get(),
      list: () => db.select().from(s.project).orderBy(desc(s.project.lastOpenedAt), asc(s.project.name)).all(),
      touch: (id: string, now: number) => db.update(s.project).set({ lastOpenedAt: now }).where(eq(s.project.id, id)).run(),
    },

    worktrees: {
      create: (row: typeof s.worktree.$inferInsert) => db.insert(s.worktree).values(row).returning().get(),
      get: (id: string) => db.select().from(s.worktree).where(eq(s.worktree.id, id)).get(),
      listByStatus: (status: string) => db.select().from(s.worktree).where(eq(s.worktree.status, status)).all(),
      setStatus: (id: string, status: string) => db.update(s.worktree).set({ status }).where(eq(s.worktree.id, id)).run(),
    },

    runs: {
      create: (row: typeof s.agentRun.$inferInsert) => db.insert(s.agentRun).values(row).returning().get(),
      get: (id: string) => db.select().from(s.agentRun).where(eq(s.agentRun.id, id)).get(),
      list: (projectId?: string, limit = 100) =>
        db
          .select()
          .from(s.agentRun)
          .where(projectId ? eq(s.agentRun.projectId, projectId) : undefined)
          .orderBy(desc(s.agentRun.createdAt))
          .limit(limit)
          .all(),
      listByStates: (states: readonly RunState[]) =>
        db.select().from(s.agentRun).where(inArray(s.agentRun.state, [...states])).orderBy(asc(s.agentRun.createdAt)).all(),
      update: (id: string, patch: Partial<typeof s.agentRun.$inferInsert>) =>
        db.update(s.agentRun).set(patch).where(eq(s.agentRun.id, id)).run(),
      countByStates: (states: readonly RunState[], adapter?: string): number =>
        db
          .select({ c: sql<number>`count(*)` })
          .from(s.agentRun)
          .where(and(inArray(s.agentRun.state, [...states]), adapter ? eq(s.agentRun.adapter, adapter) : undefined))
          .get()?.c ?? 0,
      listFinishedBefore: (ts: number) =>
        db
          .select()
          .from(s.agentRun)
          .where(
            and(
              inArray(s.agentRun.state, ['completed', 'failed', 'cancelled', 'interrupted']),
              lt(s.agentRun.endedAt, ts),
              eq(s.agentRun.detailPurged, 0),
            ),
          )
          .all(),
    },

    eventIndex: {
      add: (row: typeof s.agentEventIndex.$inferInsert) => db.insert(s.agentEventIndex).values(row).run(),
      list: (runId: string, sinceSeq: number, limit: number) =>
        db
          .select()
          .from(s.agentEventIndex)
          .where(and(eq(s.agentEventIndex.runId, runId), gt(s.agentEventIndex.seq, sinceSeq)))
          .orderBy(asc(s.agentEventIndex.seq))
          .limit(limit)
          .all(),
      deleteForRun: (runId: string) => db.delete(s.agentEventIndex).where(eq(s.agentEventIndex.runId, runId)).run(),
    },

    approvals: {
      create: (row: typeof s.approval.$inferInsert) => db.insert(s.approval).values(row).returning().get(),
      get: (id: string) => db.select().from(s.approval).where(eq(s.approval.id, id)).get(),
      listPending: (runId?: string) =>
        db
          .select()
          .from(s.approval)
          .where(and(eq(s.approval.status, 'pending'), runId ? eq(s.approval.runId, runId) : undefined))
          .all(),
      resolve: (id: string, status: 'allowed' | 'denied' | 'expired', now: number, by: string) =>
        db.update(s.approval).set({ status, decidedAt: now, decidedBy: by }).where(eq(s.approval.id, id)).run(),
    },

    coreEvents: {
      append(ts: number, type: string, scope: unknown, payload: unknown): number {
        return db
          .insert(s.coreEvent)
          .values({ ts, type, scopeJson: JSON.stringify(scope), payloadJson: JSON.stringify(payload) })
          .returning({ id: s.coreEvent.id })
          .get().id;
      },
      since: (id: number, limit = 500): CoreEventRow[] =>
        db.select().from(s.coreEvent).where(gt(s.coreEvent.id, id)).orderBy(asc(s.coreEvent.id)).limit(limit).all(),
      oldestId: (): number | null =>
        db.select({ m: sql<number | null>`min(id)` }).from(s.coreEvent).get()?.m ?? null,
      lastId: (): number =>
        db.select({ m: sql<number | null>`max(id)` }).from(s.coreEvent).get()?.m ?? 0,
      pruneBefore: (ts: number) => db.delete(s.coreEvent).where(lt(s.coreEvent.ts, ts)).run().changes,
    },

    audit: {
      add: (ts: number, actor: string, action: string, detail: unknown) =>
        db.insert(s.auditLog).values({ ts, actor, action, detailJson: JSON.stringify(detail) }).run(),
      list: (limit = 100) => db.select().from(s.auditLog).orderBy(desc(s.auditLog.id)).limit(limit).all(),
    },

    settings: {
      get<T>(key: string): T | undefined {
        const r = db.select().from(s.setting).where(eq(s.setting.key, key)).get();
        return r ? (JSON.parse(r.valueJson) as T) : undefined;
      },
      set(key: string, value: unknown) {
        db.insert(s.setting)
          .values({ key, valueJson: JSON.stringify(value) })
          .onConflictDoUpdate({ target: s.setting.key, set: { valueJson: JSON.stringify(value) } })
          .run();
      },
    },
  };
}

export type Repos = ReturnType<typeof createRepos>;
