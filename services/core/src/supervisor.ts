import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SupervisorOptions {
  command: string;
  args: string[];
  /** Reinicios máximos dentro de `windowMs` antes de rendirse (evita bucles de caídas). */
  maxRestarts?: number;
  windowMs?: number;
  backoffMs?: number[];
  spawnFn?: (cmd: string, args: string[]) => ChildProcess;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: { type: 'started' | 'exited' | 'restarting' | 'gave-up'; code?: number | null; inMs?: number }) => void;
  signal?: AbortSignal;
}

/** Reinicia el proceso con backoff exponencial; se rinde si cae demasiadas veces seguidas. */
export async function supervise(o: SupervisorOptions): Promise<'stopped' | 'gave-up'> {
  const spawnFn = o.spawnFn ?? ((c, a) => nodeSpawn(c, a, { stdio: 'inherit', windowsHide: true }));
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = o.backoffMs ?? [1000, 2000, 4000, 8000, 16000, 30000];
  const max = o.maxRestarts ?? 5;
  const windowMs = o.windowMs ?? 60_000;
  const crashes: number[] = [];
  let attempt = 0;

  while (!o.signal?.aborted) {
    const started = now();
    const child = spawnFn(o.command, o.args);
    o.onEvent?.({ type: 'started' });
    const onAbort = () => child.kill('SIGTERM');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (c) => resolve(c));
      child.once('error', () => resolve(-1));
    });
    o.signal?.removeEventListener('abort', onAbort);
    o.onEvent?.({ type: 'exited', code });
    if (o.signal?.aborted) return 'stopped';
    const t = now();
    if (t - started > windowMs) attempt = 0; // estuvo estable: se reinicia el backoff
    crashes.push(t);
    while (crashes.length && t - crashes[0]! > windowMs) crashes.shift();
    if (crashes.length > max) {
      o.onEvent?.({ type: 'gave-up' });
      return 'gave-up';
    }
    const wait = backoff[Math.min(attempt++, backoff.length - 1)]!;
    o.onEvent?.({ type: 'restarting', inMs: wait });
    await sleep(wait);
  }
  return 'stopped';
}
