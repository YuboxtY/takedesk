import * as pty from 'node-pty';
import { baseChildEnv } from '@aiw/platform';
import { newId } from '@aiw/domain';
import { ApiError } from './errors';

export interface TerminalInfo {
  id: string;
  projectId: string;
  cwd: string;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
}

interface Session extends TerminalInfo {
  proc: pty.IPty;
  scrollback: string;
  subscribers: Set<{ onData: (d: string) => void; onExit: (code: number | null) => void }>;
}

export interface PtyOptions {
  shell: { file: string; args: string[] };
  scrollbackBytes?: number;
  maxSessions?: number;
  /** Tiempo que se conserva una sesión ya terminada (para leer su salida final). */
  exitedTtlMs?: number;
}

/**
 * Los PTY viven en el Core (no en Electron) para sobrevivir al cierre de la UI (CA-03).
 * Mientras el Core siga vivo, cualquier cliente puede reconectar y recuperar el scrollback.
 * Si el Core se detiene, los terminales terminan (documentado en docs/03 §2).
 */
export class PtyManager {
  private sessions = new Map<string, Session>();
  private readonly limit: number;
  private readonly maxSessions: number;
  private readonly exitedTtl: number;

  constructor(private readonly opts: PtyOptions) {
    this.limit = opts.scrollbackBytes ?? 256 * 1024;
    this.maxSessions = opts.maxSessions ?? 8;
    this.exitedTtl = opts.exitedTtlMs ?? 60_000;
  }

  create(p: { projectId: string; cwd: string; cols: number; rows: number }): TerminalInfo {
    const alive = [...this.sessions.values()].filter((s) => !s.exited).length;
    if (alive >= this.maxSessions) throw new ApiError(429, 'too-many-terminals', `Máximo de terminales alcanzado (${this.maxSessions})`);
    const proc = pty.spawn(this.opts.shell.file, this.opts.shell.args, {
      name: 'xterm-256color', cols: p.cols, rows: p.rows, cwd: p.cwd,
      env: { ...baseChildEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const s: Session = {
      id: newId('term'), projectId: p.projectId, cwd: p.cwd, createdAt: Date.now(), exited: false, exitCode: null,
      proc, scrollback: '', subscribers: new Set(),
    };
    proc.onData((d) => {
      s.scrollback += d;
      if (s.scrollback.length > this.limit) s.scrollback = s.scrollback.slice(s.scrollback.length - this.limit);
      for (const sub of s.subscribers) sub.onData(d);
    });
    proc.onExit((e) => {
      s.exited = true;
      s.exitCode = e.exitCode ?? null;
      for (const sub of s.subscribers) sub.onExit(s.exitCode);
      setTimeout(() => this.sessions.delete(s.id), this.exitedTtl).unref();
    });
    this.sessions.set(s.id, s);
    return this.info(s);
  }

  private info(s: Session): TerminalInfo {
    return { id: s.id, projectId: s.projectId, cwd: s.cwd, createdAt: s.createdAt, exited: s.exited, exitCode: s.exitCode };
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  get(id: string): TerminalInfo | undefined {
    const s = this.sessions.get(id);
    return s ? this.info(s) : undefined;
  }

  private must(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new ApiError(404, 'terminal-not-found', 'Terminal inexistente');
    return s;
  }

  /** Devuelve el scrollback acumulado y empieza a notificar. */
  attach(id: string, sub: { onData: (d: string) => void; onExit: (code: number | null) => void }) {
    const s = this.must(id);
    s.subscribers.add(sub);
    return { scrollback: s.scrollback, exited: s.exited, exitCode: s.exitCode, detach: () => s.subscribers.delete(sub) };
  }

  write(id: string, data: string): void {
    const s = this.must(id);
    if (!s.exited) s.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.must(id);
    if (!s.exited) s.proc.resize(cols, rows);
  }

  kill(id: string): void {
    const s = this.must(id);
    if (!s.exited) s.proc.kill();
  }

  killAll(): void {
    for (const s of this.sessions.values()) if (!s.exited) s.proc.kill();
  }
}
