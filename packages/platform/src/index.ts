import { execFile } from 'node:child_process';
import { constants, accessSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Todo lo específico del sistema operativo vive aquí, detrás de funciones con
 * `platform` e inyección del ejecutor de comandos, para poder probar la rama de
 * Windows con dobles. IMPORTANTE: las ramas de Windows están cubiertas solo por
 * pruebas con dobles; hay que validarlas en un Windows real (PoC-5).
 */
export type Platform = NodeJS.Platform;
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform === 'linux') {
    // Un zombi (terminó pero nadie recogió su estado) responde a kill(pid, 0): no cuenta como vivo.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Token que identifica *esta* ejecución del proceso (evita confundirla con otro
 * proceso que reutilice el mismo PID). Devuelve null si no se puede determinar.
 */
export async function getProcessStartToken(
  pid: number,
  opts: { platform?: Platform; run?: CommandRunner } = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // el nombre del proceso va entre paréntesis y puede contener espacios
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return after[19] ?? null; // campo 22 (starttime), 0-based 19 tras quitar pid y comm
    }
    if (platform === 'win32') {
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${Number(pid)}).StartTime.ToFileTimeUtc()`,
      ]);
      return stdout.trim() || null;
    }
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Termina el árbol de procesos. En POSIX exige que `pid` sea líder de grupo
 * (procesos lanzados con detached: true). En Windows usa taskkill /T.
 */
export async function killTree(
  pid: number,
  opts: { force?: boolean; platform?: Platform; run?: CommandRunner; graceMs?: number } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  if (platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (opts.force) args.push('/F');
    try {
      await run('taskkill', args);
    } catch {
      /* ya había terminado */
    }
    // taskkill sin /F no puede cerrar procesos de consola sin ventana: tras un plazo de gracia
    // se escala a /F para que 'graceful' nunca deje el árbol vivo.
    const graceMs = opts.graceMs ?? 3000;
    if (!opts.force && graceMs > 0) {
      const deadline = Date.now() + graceMs;
      while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (isAlive(pid)) {
        try {
          await run('taskkill', [...args, '/F']);
        } catch {
          /* ya había terminado */
        }
      }
    }
    return;
  }
  const sig = opts.force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* ya había terminado */
    }
  }
}

export interface ResolvedExecutable {
  path: string;
  /** En Windows, los .cmd/.bat requieren shell y son una fuente conocida de problemas de seguridad. */
  isShim: boolean;
}

export function resolveExecutable(
  name: string,
  opts: { platform?: Platform; env?: NodeJS.ProcessEnv } = {},
): ResolvedExecutable | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  const exts =
    platform === 'win32' ? ['.exe', '.com', ...(env.PATHEXT ?? '.CMD;.BAT').toLowerCase().split(';')] : [''];
  const seen = new Set<string>();
  for (const ext of exts) {
    if (seen.has(ext)) continue;
    seen.add(ext);
    for (const dir of dirs) {
      const candidate = path.join(dir, name + ext);
      try {
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return { path: candidate, isShim: platform === 'win32' && /\.(cmd|bat)$/i.test(ext) };
      } catch {
        /* siguiente */
      }
    }
  }
  return null;
}

export function freeDiskBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function availableMemBytes(): number {
  if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (m) return Number(m[1]) * 1024;
    } catch {
      /* usa freemem */
    }
  }
  return os.freemem();
}

/** Directorio de datos por defecto. */
export function defaultDataDir(
  opts: { platform?: Platform; env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'AIWorkspace');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'AIWorkspace');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'aiworkspace');
}

/** Variables de entorno mínimas para procesos hijos (lista blanca). */
export function baseChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'USERPROFILE', 'HOME', 'HOMEDRIVE',
    'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'USERNAME', 'USER',
    'PROGRAMFILES', 'ProgramFiles', 'ProgramData', 'SHELL',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
