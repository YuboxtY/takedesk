import { diffSummary, headCommit, mergeBranch, removeWorktree, snapshotCommit, status, type DiffSummary } from '@aiw/git-engine';
import type { Repos } from '@aiw/database';
import { ApiError } from './errors';
import type { EventBus } from './event-bus';

export interface DiffReview extends DiffSummary {
  runId: string;
  branch: string;
  baseCommit: string;
  /** Commit exacto que se revisó. merge() exige este valor: lo aprobado es lo que se fusiona. */
  reviewedHead: string;
  /** El repositorio del proyecto tiene cambios locales y una fusión será rechazada. */
  targetDirty: boolean;
}

/**
 * Revisión y fusión del trabajo de un run de escritura (CA-04). Nunca fusiona sin una aprobación
 * explícita ligada al commit revisado, nunca destruye trabajo (un conflicto aborta la fusión y deja
 * rama y worktree intactos) y serializa las fusiones por proyecto.
 */
export class MergeService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: { repos: Repos; bus: EventBus; now?: () => number }) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  private context(runId: string) {
    const { repos } = this.d;
    const run = repos.runs.get(runId);
    if (!run) throw new ApiError(404, 'run-not-found', 'Run inexistente');
    if (run.mode !== 'write' || !run.worktreeId) throw new ApiError(409, 'no-worktree', 'Este run no tiene cambios que fusionar (modo lectura)');
    if (run.state !== 'completed') throw new ApiError(409, 'run-not-completed', `Solo se pueden revisar y fusionar runs completados (estado: ${run.state})`);
    const wt = repos.worktrees.get(run.worktreeId);
    if (!wt) throw new ApiError(404, 'worktree-not-found', 'Worktree inexistente');
    if (wt.status !== 'active') throw new ApiError(409, 'worktree-not-active', `El worktree ya no está activo (${wt.status})`);
    const project = repos.projects.get(run.projectId);
    if (!project) throw new ApiError(404, 'project-not-found', 'Proyecto inexistente');
    return { run, wt, project };
  }

  /** Guarda el trabajo del agente en un commit (si hay algo) y devuelve el diff contra la base. */
  async review(runId: string): Promise<DiffReview> {
    const { wt, project } = this.context(runId);
    await snapshotCommit(wt.path, `Trabajo del run ${runId}`);
    const diff = await diffSummary(wt.path, wt.baseCommit);
    const targetDirty = !(await status(project.rootPath)).clean;
    return { ...diff, runId, branch: wt.branch, baseCommit: wt.baseCommit, reviewedHead: await headCommit(wt.path), targetDirty };
  }

  async merge(runId: string, approvedHead: string, by = 'local'): Promise<{ head: string }> {
    const { project } = this.context(runId);
    const prev = this.locks.get(project.id) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(() => this.mergeLocked(runId, approvedHead, by));
    this.locks.set(project.id, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(project.id) === task) this.locks.delete(project.id);
    }
  }

  private async mergeLocked(runId: string, approvedHead: string, by: string): Promise<{ head: string }> {
    const { repos, bus } = this.d;
    const { run, wt, project } = this.context(runId); // se revalida dentro del candado
    const current = await headCommit(wt.path);
    if (!(await status(wt.path)).clean || current !== approvedHead) {
      throw new ApiError(409, 'diff-changed', 'El trabajo cambió después de revisarlo; vuelve a revisar el diff antes de aprobar');
    }
    const res = await mergeBranch(project.rootPath, wt.branch); // GitError('dirty') lo traduce el manejador del servidor
    if (!res.ok) {
      repos.audit.add(this.now(), by, 'merge.conflict', { runId, conflicts: res.conflicts });
      throw new ApiError(409, 'merge-conflict', `Conflicto en: ${res.conflicts.join(', ')}. No se fusionó nada y tu trabajo sigue intacto en la rama ${wt.branch}.`);
    }
    repos.worktrees.setStatus(wt.id, 'merged');
    repos.audit.add(this.now(), by, 'merge.approved', { runId, branch: wt.branch, approvedHead, mergedHead: res.head });
    bus.publish('worktree.merged', { projectId: project.id, runId: run.id }, { branch: wt.branch, head: res.head });
    // Limpieza: el trabajo ya está en la rama principal. Si falla, no es un error de la fusión.
    try {
      await removeWorktree({ repo: project.rootPath, path: wt.path, branch: wt.branch, deleteBranch: true });
      bus.publish('worktree.removed', { projectId: project.id, runId: run.id }, { branch: wt.branch });
    } catch {
      /* se queda para el reconciliador / limpieza manual */
    }
    return { head: res.head };
  }
}
