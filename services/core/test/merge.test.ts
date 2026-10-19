import fs from 'node:fs';
import path from 'node:path';
import { FakeAdapter } from '@aiw/agent-adapters';
import { git } from '@aiw/git-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { MergeService } from '../src/merge-service';
import { makeEnv, waitFor, type Env } from './helpers';

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.cleanup());

const body = (o: Record<string, unknown> = {}) => ({ projectId: 'prj_test', adapter: 'w', prompt: 'x', mode: 'write' as const, ...o });
const state = (id: string) => env.repos.runs.get(id)!.state;
const rd = (p: string) => fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n');

/** Lanza un run de escritura cuyo "agente" escribe `content` en `file` dentro del worktree. */
async function runWriting(file: string, content: string, opts: { mode?: 'read' | 'write' } = {}) {
  const adapter = new FakeAdapter({
    id: 'w',
    script: (ctx) => {
      if (opts.mode !== 'read') fs.writeFileSync(path.join(ctx.req.cwd, file), content);
    },
  });
  const m = env.manager([adapter]);
  const run = await m.createRun(body({ mode: opts.mode ?? 'write' }));
  await waitFor(() => state(run.id) === 'completed', 8000, 'completed');
  return run;
}

const svc = () => new MergeService({ repos: env.repos, bus: env.bus });
const code = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ApiError | null;

describe('MergeService (CA-04)', () => {
  it('review guarda el trabajo, muestra el diff y fusionar lleva exactamente lo aprobado', async () => {
    const run = await runWriting('nuevo.txt', 'contenido\n');
    const s = svc();
    const rev = await s.review(run.id);
    expect(rev.files).toEqual([{ status: 'A', path: 'nuevo.txt' }]);
    expect(rev.patch).toContain('+contenido');
    expect(rev.targetDirty).toBe(false);

    const res = await s.merge(run.id, rev.reviewedHead);
    expect(rd(path.join(env.repo, 'nuevo.txt'))).toBe('contenido\n');
    expect(res.head).toMatch(/^[0-9a-f]{40}$/);
    const wt = env.repos.worktrees.get(env.repos.runs.get(run.id)!.worktreeId!)!;
    expect(wt.status).toBe('merged');
    expect(fs.existsSync(wt.path)).toBe(false); // worktree limpiado
    expect((await git(env.repo, ['branch', '--list', wt.branch])).stdout.trim()).toBe(''); // rama borrada
    expect(env.repos.audit.list().some((a) => a.action === 'merge.approved')).toBe(true);
    expect(env.bus.lastEventId()).toBeGreaterThan(0);
  });

  it('rechaza fusionar si el trabajo cambió después de la revisión', async () => {
    const run = await runWriting('a.txt', 'v1\n');
    const s = svc();
    const rev = await s.review(run.id);
    const wt = env.repos.worktrees.get(env.repos.runs.get(run.id)!.worktreeId!)!;
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'v2 modificado tras revisar\n'); // cambio sin commit
    expect((await code(s.merge(run.id, rev.reviewedHead)))?.code).toBe('diff-changed');
    expect(rd(path.join(env.repo, 'a.txt'))).toBe('x\n'); // nada se fusionó
    // un hash inventado tampoco sirve
    expect((await code(s.merge(run.id, 'deadbeefdeadbeef')))?.code).toBe('diff-changed');
  });

  it('un conflicto aborta la fusión y no pierde nada', async () => {
    const run = await runWriting('a.txt', 'del agente\n');
    const s = svc();
    const rev = await s.review(run.id);
    // el proyecto cambia el mismo archivo mientras tanto (commit en main)
    fs.writeFileSync(path.join(env.repo, 'a.txt'), 'del humano\n');
    await git(env.repo, ['add', '.']);
    await git(env.repo, ['commit', '-q', '-m', 'humano']);
    const err = await code(s.merge(run.id, rev.reviewedHead));
    expect(err?.code).toBe('merge-conflict');
    expect(err?.message).toContain('a.txt');
    expect(rd(path.join(env.repo, 'a.txt'))).toBe('del humano\n'); // main intacto
    expect((await git(env.repo, ['status', '--porcelain'])).stdout.trim()).toBe(''); // sin fusión a medias
    const wt = env.repos.worktrees.get(env.repos.runs.get(run.id)!.worktreeId!)!;
    expect(wt.status).toBe('active');
    expect(rd(path.join(wt.path, 'a.txt'))).toBe('del agente\n'); // trabajo del agente a salvo
  });

  it('no fusiona sobre un repositorio con cambios locales', async () => {
    const run = await runWriting('b.txt', 'x\n');
    const s = svc();
    const rev = await s.review(run.id);
    fs.writeFileSync(path.join(env.repo, 'a.txt'), 'sucio\n');
    expect((await s.review(run.id)).targetDirty).toBe(true);
    const err = await code(s.merge(run.id, rev.reviewedHead));
    expect(err).not.toBeNull();
    expect(fs.existsSync(path.join(env.repo, 'b.txt'))).toBe(false);
  });

  it('solo aplica a runs de escritura completados', async () => {
    const ro = await runWriting('x.txt', 'x', { mode: 'read' });
    expect((await code(svc().review(ro.id)))?.code).toBe('no-worktree');
    expect((await code(svc().review('run_inexistente')))?.code).toBe('run-not-found');
  });

  it('una segunda fusión del mismo run falla limpiamente', async () => {
    const run = await runWriting('c.txt', 'c\n');
    const s = svc();
    const rev = await s.review(run.id);
    await s.merge(run.id, rev.reviewedHead);
    expect((await code(s.merge(run.id, rev.reviewedHead)))?.code).toBe('worktree-not-active');
  });
});
