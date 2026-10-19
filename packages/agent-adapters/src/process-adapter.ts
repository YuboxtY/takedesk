import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentEvent, type Capabilities, type DataPolicy } from '@aiw/contracts';
import { baseChildEnv, getProcessStartToken, isAlive, killTree, resolveExecutable, unwrapShim } from '@aiw/platform';
import { Channel } from './channel';
import type {
  AdapterInfo, AgentAdapter, RecoverRequest, RecoverResult, RunHandle, RunSession, StartRequest,
} from './types';

const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner-wrapper.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LineParser = (line: string) => AgentEvent[] | null;

/** Parser por defecto: JSONL con eventos normalizados; el resto es salida de texto. */
export const defaultParseLine: LineParser = (line) => {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = AgentEvent.safeParse(JSON.parse(trimmed));
      if (parsed.success) return [parsed.data];
    } catch {
      /* texto normal */
    }
  }
  return [{ kind: 'output.delta', text: line + '\n', stream: 'stdout' }];
};

export interface ProcessAdapterConfig {
  id: string;
  displayName: string;
  /** Ejecutable (nombre en PATH o ruta absoluta). */
  command: string;
  buildArgs(req: StartRequest): string[];
  capabilities: Capabilities;
  dataPolicy: DataPolicy;
  parseLine?: LineParser;
  pollMs?: number;
}

interface TailOptions {
  runDir: string;
  wrapperPid: number;
  startToken: string | null;
  parseLine: LineParser;
  pollMs: number;
}

function readExit(runDir: string): { code: number | null; signal: string | null } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'exit.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Lee output.log en bucle, emite eventos y termina con 'run.finished'. Solo se declara
 * un resultado con evidencia: exit.json escrito por el wrapper, o la muerte del wrapper
 * (que se reporta como fallo, nunca como éxito).
 */
function tail(opts: TailOptions): { events: AsyncIterable<AgentEvent>; stop(): void } {
  const ch = new Channel<AgentEvent>();
  const file = path.join(opts.runDir, 'output.log');
  let stopped = false;
  let offset = 0;
  let partial = '';
  let finishedEmitted = false;
  let lastTokenCheck = 0;

  const emit = (evs: AgentEvent[] | null) => {
    for (const e of evs ?? []) {
      if (e.kind === 'run.finished') finishedEmitted = true;
      ch.push(e);
    }
  };
  const drain = () => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      partial += buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) if (l.length) emit(opts.parseLine(l));
  };

  void (async () => {
    try {
      while (!stopped) {
        drain();
        const exit = readExit(opts.runDir);
        if (exit) {
          drain();
          if (partial) { emit(opts.parseLine(partial)); partial = ''; }
          if (!finishedEmitted) {
            const ok = exit.code === 0;
            ch.push({ kind: 'run.finished', ok, reason: ok ? undefined : `exit code ${exit.code ?? 'null'}${exit.signal ? ` (${exit.signal})` : ''}` });
          }
          break;
        }
        let alive = isAlive(opts.wrapperPid);
        if (alive && opts.startToken && Date.now() - lastTokenCheck > 1000) {
          lastTokenCheck = Date.now();
          const tok = await getProcessStartToken(opts.wrapperPid);
          if (tok && tok !== opts.startToken) alive = false; // PID reutilizado por otro proceso
        }
        if (!alive) {
          drain();
          if (readExit(opts.runDir)) continue; // carrera: terminó justo ahora
          if (partial) { emit(opts.parseLine(partial)); partial = ''; }
          if (!finishedEmitted) {
            ch.push({ kind: 'error', message: 'El proceso del agente terminó sin registrar su resultado', fatal: true });
            ch.push({ kind: 'run.finished', ok: false, reason: 'process-died-without-exit-record' });
          }
          break;
        }
        await sleep(opts.pollMs);
      }
    } finally {
      ch.close();
    }
  })();

  return { events: ch, stop: () => { stopped = true; ch.close(); } };
}

/**
 * Adaptador genérico: ejecuta un CLI como proceso desacoplado (wrapper) con salida a archivo.
 * El Core puede caerse y reengancharse (recover) sin perder el proceso. Las ramas de Windows
 * (detached/taskkill) están sin validar en Windows real.
 */
export class JsonlProcessAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  readonly dataPolicy: DataPolicy;
  private readonly parseLine: LineParser;
  private readonly pollMs: number;

  constructor(private readonly cfg: ProcessAdapterConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName;
    this.capabilities = cfg.capabilities;
    this.dataPolicy = cfg.dataPolicy;
    this.parseLine = cfg.parseLine ?? defaultParseLine;
    this.pollMs = cfg.pollMs ?? 50;
  }

  async probe(): Promise<AdapterInfo> {
    const abs = path.isAbsolute(this.cfg.command);
    const resolved = abs ? { path: this.cfg.command, isShim: /\.(cmd|bat)$/i.test(this.cfg.command) } : resolveExecutable(this.cfg.command);
    if (!resolved) return { installed: false, warnings: [`No se encontró '${this.cfg.command}' en PATH`] };
    const warnings = resolved.isShim ? ['El ejecutable es un shim .cmd/.bat (requiere tratamiento especial en Windows)'] : [];
    return { installed: true, path: resolved.path, warnings };
  }

  async start(req: StartRequest): Promise<RunSession> {
    fs.mkdirSync(req.runDir, { recursive: true });
    const info = await this.probe();
    if (!info.installed) throw new Error(`Agente no instalado: ${this.cfg.command}`);
    // Un shim .cmd se sustituye por su destino real: nunca se pasa el prompt por cmd.exe.
    const isShim = /\.(cmd|bat)$/i.test(info.path!);
    const shim = isShim ? unwrapShim(info.path!) : null;
    if (isShim && !shim) throw new Error(`No se pudo resolver el shim ${info.path} a un ejecutable`);
    const args = [WRAPPER, req.runDir, shim?.command ?? info.path!, ...(shim?.prefixArgs ?? []), ...this.cfg.buildArgs(req)];
    const child = spawn(process.execPath, args, {
      cwd: req.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...baseChildEnv(), ...(req.env ?? {}) },
    });
    child.unref();
    if (!child.pid) throw new Error('No se pudo iniciar el proceso del agente');
    const token = await getProcessStartToken(child.pid);
    return this.session({ runId: req.runId, pid: child.pid, pidStartToken: token }, req.runDir);
  }

  async recover(handle: RunHandle, req: RecoverRequest): Promise<RecoverResult> {
    if (!fs.existsSync(req.runDir)) return { status: 'interrupted', reason: 'directorio del run inexistente' };
    if (readExit(req.runDir)) return { status: 'reattached', session: this.session(handle, req.runDir) };
    if (handle.pid && isAlive(handle.pid)) {
      const tok = await getProcessStartToken(handle.pid);
      if (!handle.pidStartToken || tok === handle.pidStartToken) {
        return { status: 'reattached', session: this.session(handle, req.runDir) };
      }
    }
    return { status: 'interrupted', reason: 'el proceso ya no existe y no dejó registro de resultado' };
  }

  private session(handle: RunHandle, runDir: string): RunSession {
    const t = tail({ runDir, wrapperPid: handle.pid ?? -1, startToken: handle.pidStartToken ?? null, parseLine: this.parseLine, pollMs: this.pollMs });
    return {
      handle,
      events: t.events,
      dispose: () => t.stop(),
      cancel: async (mode) => {
        if (handle.pid) await killTree(handle.pid, { force: mode === 'force' });
      },
    };
  }
}
