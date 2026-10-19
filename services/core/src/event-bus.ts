import type { AgentEvent, CoreEvent, CoreEventType, WsMessage } from '@aiw/contracts';
import type { CoreEventRow, Repos } from '@aiw/database';

export function rowToEvent(r: CoreEventRow): CoreEvent {
  return {
    eventId: r.id, ts: r.ts, v: 1, type: r.type as CoreEventType,
    scope: JSON.parse(r.scopeJson), payload: JSON.parse(r.payloadJson),
  };
}

export type Listener = (m: WsMessage) => void;

/**
 * Eventos durables (estado) → se guardan en core_event y tienen eventId reanudable.
 * Salida en vivo de runs → solo se difunde (se recupera por REST con seq).
 */
export class EventBus {
  private listeners = new Set<Listener>();
  constructor(private readonly repos: Repos, private readonly now: () => number = Date.now) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(type: CoreEventType, scope: CoreEvent['scope'], payload: Record<string, unknown>): CoreEvent {
    const ts = this.now();
    const eventId = this.repos.coreEvents.append(ts, type, scope, payload);
    const event: CoreEvent = { eventId, ts, v: 1, type, scope, payload };
    this.emit({ channel: 'event', event });
    return event;
  }

  publishOutput(runId: string, seq: number, ts: number, event: AgentEvent): void {
    this.emit({ channel: 'output', runId, seq, ts, event });
  }

  lastEventId(): number {
    return this.repos.coreEvents.lastId();
  }

  /** Eventos durables posteriores a `since`; si el hueco ya no está retenido, pide resync. */
  replay(since: number): { resync: { oldestEventId: number } | null; events: CoreEvent[] } {
    const oldest = this.repos.coreEvents.oldestId();
    if (oldest !== null && since < oldest - 1) return { resync: { oldestEventId: oldest }, events: [] };
    return { resync: null, events: this.repos.coreEvents.since(since, 5000).map(rowToEvent) };
  }

  private emit(m: WsMessage): void {
    for (const l of this.listeners) {
      try { l(m); } catch { /* un suscriptor roto no afecta a los demás */ }
    }
  }
}
