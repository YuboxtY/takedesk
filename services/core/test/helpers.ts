import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepos, openDatabase, type Database_, type Repos } from '@aiw/database';
import { git } from '@aiw/git-engine';
import type { AgentAdapter } from '@aiw/agent-adapters';
import { loadConfig, type CoreConfig } from '../src/config';
import { EventBus } from '../src/event-bus';
import { RunManager } from '../src/run-manager';
import type { ResourceProbe } from '../src/resources';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8000, what = 'condición'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout esperando: ${what}`);
    await sleep(25);
  }
}

export interface Env {
  tmp: string;
  repo: string;
  cfg: CoreConfig;
  database: Database_;
  repos: Repos;
  bus: EventBus;
  projectId: string;
  probe: ResourceProbe & { disk: number; mem: number };
  manager(adapters: AgentAdapter[], over?: Partial<CoreConfig>): RunManager;
  cleanup(): void;
}

export async function makeEnv(over: Partial<CoreConfig> = {}): Promise<Env> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-core-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);

  const cfg = loadConfig({ AIW_DATA_DIR: path.join(tmp, 'data') } as NodeJS.ProcessEnv, {
    minFreeDiskBytes: 0, reserveMemBytes: 0, cancelGraceMs: 300, quotaPauseMs: 400,
    shell: process.platform === 'win32' ? { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] } : { file: 'bash', args: ['--norc', '--noprofile'] }, ...over,
  });
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const database = openDatabase(cfg.dbFile);
  const repos = createRepos(database.db);
  const bus = new EventBus(repos);
  const project = repos.projects.create({ id: 'prj_test', name: 'repo', rootPath: repo, createdAt: Date.now() });
  const probe = { disk: Number.MAX_SAFE_INTEGER, mem: Number.MAX_SAFE_INTEGER, freeDiskBytes() { return this.disk; }, availableMemBytes() { return this.mem; } };
  const managers: RunManager[] = [];
  return {
    tmp, repo, cfg, database, repos, bus, projectId: project.id, probe,
    manager(adapters, o = {}) {
      const m = new RunManager({ repos, bus, adapters: new Map(adapters.map((a) => [a.id, a])), cfg: { ...cfg, ...o }, probe });
      managers.push(m);
      return m;
    },
    cleanup() {
      for (const m of managers) m.shutdown();
      database.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
