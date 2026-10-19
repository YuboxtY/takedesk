import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: 'git-failed' | 'dirty' | 'not-a-repo' | 'invalid-name' | 'outside-root' | 'conflict',
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** Ejecuta git con argv (sin shell) y sin prompts interactivos. */
export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.longpaths=true', '-c', 'user.name=AI Workspace', '-c', 'user.email=ai-workspace@localhost', ...args],
      { cwd, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) : 0;
        if (err && !opts.allowFail) {
          reject(new GitError(`git ${args[0]} falló: ${String(stderr).trim() || err.message}`, 'git-failed', String(stderr)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (typeof code === 'number' ? code : 1) : 0 });
      },
    );
  });
}

// ------------------------------------------------------------------ validación

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

export function assertSafeSegment(value: string, what = 'nombre'): void {
  if (!SEGMENT.test(value) || value.includes('..') || value.endsWith('.lock') || value.endsWith('.')) {
    throw new GitError(`${what} no válido: ${JSON.stringify(value)}`, 'invalid-name');
  }
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'task';
}

/** Lanza si `candidate` (tras resolver symlinks existentes) no está dentro de `root`. */
export function assertInside(root: string, candidate: string): string {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(candidate);
  // resuelve el ancestro existente más cercano para detectar symlinks de escape
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new GitError(`Ruta fuera de la raíz permitida: ${candidate}`, 'outside-root');
  }
  return real;
}

// ------------------------------------------------------------------ repos

export async function repoRoot(dir: string): Promise<string> {
  try {
    const { stdout } = await git(dir, ['rev-parse', '--show-toplevel']);
    return fs.realpathSync(stdout.trim());
  } catch {
    throw new GitError(`No es un repositorio Git: ${dir}`, 'not-a-repo');
  }
}

export async function headCommit(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function currentBranch(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
}

export interface StatusEntry {
  status: string;
  path: string;
}

export async function status(dir: string): Promise<{ clean: boolean; entries: StatusEntry[] }> {
  const { stdout } = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = stdout
    .split('\0')
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3) }));
  return { clean: entries.length === 0, entries };
}

// ------------------------------------------------------------------ worktrees

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string;
}

export async function createWorktree(opts: {
  repo: string;
  worktreesRoot: string;
  projectId: string;
  taskId: string;
  slug: string;
  baseRef?: string;
}): Promise<WorktreeInfo> {
  assertSafeSegment(opts.projectId, 'projectId');
  assertSafeSegment(opts.taskId, 'taskId');
  const slug = slugify(opts.slug);
  const branch = `task/${opts.taskId}-${slug}`;
  const base = (await git(opts.repo, ['rev-parse', opts.baseRef ?? 'HEAD'])).stdout.trim();
  fs.mkdirSync(opts.worktreesRoot, { recursive: true });
  const target = path.join(opts.worktreesRoot, opts.projectId, opts.taskId);
  assertInside(opts.worktreesRoot, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await git(opts.repo, ['worktree', 'add', '-b', branch, target, base]);
  return { path: fs.realpathSync(target), branch, baseCommit: base };
}

export async function removeWorktree(opts: { repo: string; path: string; branch?: string; force?: boolean; deleteBranch?: boolean }): Promise<void> {
  if (fs.existsSync(opts.path) && !opts.force) {
    const st = await status(opts.path);
    if (!st.clean) throw new GitError(`El worktree tiene cambios sin guardar (${st.entries.length} archivos)`, 'dirty');
  }
  await git(opts.repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), opts.path]);
  await git(opts.repo, ['worktree', 'prune']);
  if (opts.deleteBranch && opts.branch) await git(opts.repo, ['branch', opts.force ? '-D' : '-d', opts.branch], { allowFail: true });
}

export async function listWorktrees(repo: string): Promise<{ path: string; branch: string | null; head: string }[]> {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain']);
  const out: { path: string; branch: string | null; head: string }[] = [];
  for (const block of stdout.split('\n\n')) {
    if (!block.trim()) continue;
    const get = (k: string) => block.split('\n').find((l) => l.startsWith(k + ' '))?.slice(k.length + 1);
    out.push({ path: get('worktree') ?? '', head: get('HEAD') ?? '', branch: get('branch')?.replace('refs/heads/', '') ?? null });
  }
  return out;
}

// ------------------------------------------------------------------ diff y snapshot

/** Guarda todo el trabajo del worktree en un commit (para poder revisar y fusionar). */
export async function snapshotCommit(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ['add', '-A']);
  const st = await git(worktree, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (st.code === 0) return null; // nada que guardar
  await git(worktree, ['commit', '-m', message]);
  return headCommit(worktree);
}

export interface DiffSummary {
  files: { path: string; status: string }[];
  stat: string;
  patch: string;
  truncated: boolean;
}

export async function diffSummary(worktree: string, baseCommit: string, maxPatchBytes = 512 * 1024): Promise<DiffSummary> {
  const names = await git(worktree, ['diff', '--name-status', `${baseCommit}..HEAD`]);
  const stat = await git(worktree, ['diff', '--stat', `${baseCommit}..HEAD`]);
  const patch = await git(worktree, ['diff', `${baseCommit}..HEAD`]);
  const files = names.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [s, ...rest] = l.split('\t');
      return { status: s ?? '?', path: rest.join('\t') };
    });
  const truncated = Buffer.byteLength(patch.stdout) > maxPatchBytes;
  return { files, stat: stat.stdout, patch: truncated ? patch.stdout.slice(0, maxPatchBytes) : patch.stdout, truncated };
}

// ------------------------------------------------------------------ merge

export type MergeResult = { ok: true; head: string } | { ok: false; conflicts: string[] };

/**
 * Fusiona `branch` en la rama actual de `repo`. Exige repo limpio. Si hay conflicto,
 * ABORTA la fusión (no se pierde trabajo) y devuelve los archivos en conflicto.
 */
export async function mergeBranch(repo: string, branch: string): Promise<MergeResult> {
  const st = await status(repo);
  if (!st.clean) throw new GitError('El repositorio tiene cambios locales; no se fusiona', 'dirty');
  const res = await git(repo, ['merge', '--no-ff', '--no-edit', branch], { allowFail: true });
  if (res.code === 0) return { ok: true, head: await headCommit(repo) };
  const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
  await git(repo, ['merge', '--abort'], { allowFail: true });
  return { ok: false, conflicts };
}
