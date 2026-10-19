import path from 'node:path';
import { defaultDataDir } from '@aiw/platform';
import { DEFAULT_RETENTION, type RetentionPolicy } from '@aiw/database';

export interface CoreConfig {
  dataDir: string;
  dbFile: string;
  runsDir: string;
  worktreesDir: string;
  host: string;
  port: number;
  /** Hostnames aceptados en la cabecera Host (defensa contra DNS rebinding). */
  allowedHostnames: string[];
  maxConcurrentRuns: number;
  maxPerProvider: number;
  minFreeDiskBytes: number;
  reserveMemBytes: number;
  cancelGraceMs: number;
  quotaPauseMs: number;
  shell: { file: string; args: string[] };
  maxTerminals: number;
  retention: RetentionPolicy;
}

const GB = 1024 ** 3;

/** Valores por defecto pensados para el equipo del usuario (16 GB de RAM, ~63 GB de disco libres): ver docs/10 D-15/D-16. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<CoreConfig> = {}): CoreConfig {
  const dataDir = env.AIW_DATA_DIR ?? defaultDataDir();
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const win = process.platform === 'win32';
  const cfg: CoreConfig = {
    dataDir,
    dbFile: path.join(dataDir, 'core.db'),
    runsDir: path.join(dataDir, 'runs'),
    worktreesDir: path.join(dataDir, 'worktrees'),
    host: env.AIW_HOST ?? '127.0.0.1',
    port: num(env.AIW_PORT, 47821),
    allowedHostnames: ['127.0.0.1', 'localhost', '[::1]', ...(env.AIW_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)],
    maxConcurrentRuns: num(env.AIW_MAX_RUNS, 3),
    maxPerProvider: num(env.AIW_MAX_RUNS_PER_PROVIDER, 2),
    minFreeDiskBytes: num(env.AIW_MIN_FREE_DISK_GB, 15) * GB,
    reserveMemBytes: num(env.AIW_RESERVE_MEM_GB, 3) * GB,
    cancelGraceMs: num(env.AIW_CANCEL_GRACE_MS, 5000),
    quotaPauseMs: num(env.AIW_QUOTA_PAUSE_MIN, 30) * 60_000,
    shell: win ? { file: 'powershell.exe', args: ['-NoLogo'] } : { file: env.SHELL ?? 'bash', args: [] },
    maxTerminals: num(env.AIW_MAX_TERMINALS, 8),
    retention: DEFAULT_RETENTION,
  };
  return { ...cfg, ...overrides };
}
