import fs from 'node:fs';
import path from 'node:path';
import type { StoredEvent } from '@aiw/contracts';
import { redact } from '@aiw/domain';

export const MAX_EVENT_BYTES = 64 * 1024;

export interface AppendResult {
  offset: number;
  bytes: number;
}

/**
 * Log NDJSON por run (events.ndjson). Los eventos voluminosos se truncan y todo
 * pasa por la redacción de secretos antes de escribirse.
 */
export class RunEventLog {
  private fd: number | null = null;
  private size: number;

  constructor(readonly file: string, private readonly maxEventBytes = MAX_EVENT_BYTES) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  append(ev: StoredEvent): AppendResult {
    if (this.fd === null) throw new Error('RunEventLog cerrado');
    let line = JSON.stringify(redact(ev));
    if (Buffer.byteLength(line) > this.maxEventBytes) {
      const e = ev.event;
      const shrunk =
        e.kind === 'output.delta'
          ? { ...e, text: e.text.slice(0, Math.max(0, this.maxEventBytes - 512)) + '…[truncado]' }
          : { kind: 'error' as const, message: `evento ${e.kind} truncado por tamaño`, fatal: false };
      line = JSON.stringify(redact({ ...ev, event: shrunk }));
    }
    const buf = Buffer.from(line + '\n');
    fs.writeSync(this.fd, buf);
    const offset = this.size;
    this.size += buf.length;
    return { offset, bytes: buf.length };
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

/** Lee eventos con seq > since desde events.ndjson (tolera una última línea incompleta). */
export function readRunEvents(file: string, sinceSeq = 0, limit = 500): StoredEvent[] {
  if (!fs.existsSync(file)) return [];
  const out: StoredEvent[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const l of lines) {
    if (!l) continue;
    let parsed: StoredEvent;
    try {
      parsed = JSON.parse(l) as StoredEvent;
    } catch {
      continue; // línea parcial por caída durante la escritura
    }
    if (parsed.seq > sinceSeq) {
      out.push(parsed);
      if (out.length >= limit) break;
    }
  }
  return out;
}
