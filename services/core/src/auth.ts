import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Token local de la API (Etapa 1). Se crea una vez, con permisos 0600 en POSIX.
 * En Windows el modo no restringe el acceso: endurecer con ACL (icacls) en la Etapa 1b / PoC-5.
 * El emparejamiento por dispositivo con claves y firmas llega en la Etapa 4 (docs/06).
 */
export function loadOrCreateToken(dataDir: string): string {
  const file = path.join(dataDir, 'api-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* se crea */
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export class TicketStore {
  private tickets = new Map<string, number>();
  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  issue(): { ticket: string; expiresInSec: number } {
    this.sweep();
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, this.now() + this.ttlMs);
    return { ticket, expiresInSec: Math.round(this.ttlMs / 1000) };
  }

  /** Un solo uso. */
  consume(ticket: string | undefined): boolean {
    if (!ticket) return false;
    const exp = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return exp !== undefined && exp > this.now();
  }

  private sweep() {
    const t = this.now();
    for (const [k, exp] of this.tickets) if (exp <= t) this.tickets.delete(k);
  }
}
