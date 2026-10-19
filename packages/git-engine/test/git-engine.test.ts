import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertInside, assertSafeSegment, createWorktree, diffSummary, git, GitError, listWorktrees, mergeBranch,
  removeWorktree, repoRoot, slugify, snapshotCommit, status,
} from '../src';

let tmp: string;
let repo: string;
let wtRoot: string;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-git-')));
  repo = path.join(tmp, 'repo');
  wtRoot = path.join(tmp, 'worktrees');
  fs.mkdirSync(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('validación', () => {
  it('rechaza nombres peligrosos', () => {
    for (const bad of ['', '..', 'a/b', 'a b', '-rf', 'x;rm', '$(id)', 'a..b', 'a.lock', 'a\\b']) {
      expect(() => assertSafeSegment(bad)).toThrow(GitError);
    }
    expect(() => assertSafeSegment('task_1a2b3c')).not.toThrow();
  });

  it('slugify normaliza acentos y símbolos', () => {
    expect(slugify('Añadir ¡login! (OAuth)')).toBe('anadir-login-oauth');
    expect(slugify('***')).toBe('task');
  });

  it('assertInside bloquea .. y symlinks de escape', () => {
    fs.mkdirSync(wtRoot);
    expect(() => assertInside(wtRoot, path.join(wtRoot, '..', 'otro'))).toThrow(/fuera/);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(wtRoot, 'link'));
    expect(() => assertInside(wtRoot, path.join(wtRoot, 'link', 'x'))).toThrow(/fuera/);
    expect(() => assertInside(wtRoot, path.join(wtRoot, 'ok', 'x'))).not.toThrow();
  });

  it('repoRoot falla fuera de un repo', async () => {
    await expect(repoRoot(tmp)).rejects.toMatchObject({ code: 'not-a-repo' });
    expect(await repoRoot(path.join(repo))).toBe(repo);
  });
});

describe('worktrees', () => {
  it('crea worktrees concurrentes aislados con rama por tarea', async () => {
    const wts = await Promise.all(
      ['t1', 't2', 't3'].map((t) => createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: t, slug: `Tarea ${t}` })),
    );
    await Promise.all(wts.map(async (w, i) => {
      fs.writeFileSync(path.join(w.path, `file${i}.txt`), `c${i}`);
      await snapshotCommit(w.path, `work ${i}`);
    }));
    expect(wts.map((w) => w.branch)).toEqual(['task/t1-tarea-t1', 'task/t2-tarea-t2', 'task/t3-tarea-t3']);
    expect((await listWorktrees(repo)).length).toBe(4);
    // el repo original no recibió archivos de los worktrees
    expect((await status(repo)).clean).toBe(true);
    expect(fs.existsSync(path.join(repo, 'file0.txt'))).toBe(false);
  });

  it('no permite dos worktrees para la misma tarea ni escapar de la raíz', async () => {
    await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 't1', slug: 'a' });
    await expect(createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 't1', slug: 'a' })).rejects.toThrow();
    await expect(createWorktree({ repo, worktreesRoot: wtRoot, projectId: '../x', taskId: 't2', slug: 'a' })).rejects.toMatchObject({ code: 'invalid-name' });
  });

  it('se niega a borrar un worktree con cambios sin guardar salvo force', async () => {
    const w = await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 't1', slug: 'a' });
    fs.writeFileSync(path.join(w.path, 'sucio.txt'), 'x');
    await expect(removeWorktree({ repo, path: w.path })).rejects.toMatchObject({ code: 'dirty' });
    expect(fs.existsSync(w.path)).toBe(true);
    await removeWorktree({ repo, path: w.path, force: true, branch: w.branch, deleteBranch: true });
    expect(fs.existsSync(w.path)).toBe(false);
    expect((await listWorktrees(repo)).length).toBe(1);
  });

  it('borra limpio un worktree sin cambios', async () => {
    const w = await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 't1', slug: 'a' });
    await removeWorktree({ repo, path: w.path });
    expect(fs.existsSync(w.path)).toBe(false);
  });
});

describe('diff y merge', () => {
  it('diff resume archivos cambiados respecto a la base', async () => {
    const w = await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 't1', slug: 'a' });
    fs.writeFileSync(path.join(w.path, 'f.txt'), 'base\ncambio\n');
    fs.writeFileSync(path.join(w.path, 'nuevo.txt'), 'n');
    expect(await snapshotCommit(w.path, 'agent work')).toMatch(/^[0-9a-f]{40}$/);
    expect(await snapshotCommit(w.path, 'sin cambios')).toBeNull();
    const d = await diffSummary(w.path, w.baseCommit);
    expect(d.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(['A:nuevo.txt', 'M:f.txt']);
    expect(d.patch).toContain('+cambio');
  });

  it('merge limpio fusiona; merge con conflicto ABORTA y no pierde nada', async () => {
    const a = await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 'ta', slug: 'a' });
    const b = await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 'tb', slug: 'b' });
    fs.writeFileSync(path.join(a.path, 'f.txt'), 'desde A\n');
    fs.writeFileSync(path.join(b.path, 'f.txt'), 'desde B\n');
    await snapshotCommit(a.path, 'A');
    await snapshotCommit(b.path, 'B');

    const r1 = await mergeBranch(repo, a.branch);
    expect(r1.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8')).toBe('desde A\n');

    const r2 = await mergeBranch(repo, b.branch);
    expect(r2).toEqual({ ok: false, conflicts: ['f.txt'] });
    // tras abortar: repo limpio, contenido de A intacto, rama B intacta
    expect((await status(repo)).clean).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8')).toBe('desde A\n');
    expect((await git(repo, ['show', `${b.branch}:f.txt`])).stdout).toBe('desde B\n');
  });

  it('no fusiona si el repo tiene cambios locales', async () => {
    const a = await createWorktree({ repo, worktreesRoot: wtRoot, projectId: 'p1', taskId: 'ta', slug: 'a' });
    fs.writeFileSync(path.join(repo, 'local.txt'), 'x');
    await expect(mergeBranch(repo, a.branch)).rejects.toMatchObject({ code: 'dirty' });
  });
});
