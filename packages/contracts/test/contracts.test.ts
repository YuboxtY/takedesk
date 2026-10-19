import { describe, expect, it } from 'vitest';
import { AgentEvent, CreateRunBody, CoreEvent, WsMessage, TerminalClientMessage } from '../src';

describe('contracts', () => {
  it('normaliza eventos de agente y aplica valores por defecto', () => {
    const e = AgentEvent.parse({ kind: 'output.delta', text: 'hola' });
    expect(e).toEqual({ kind: 'output.delta', text: 'hola', stream: 'stdout' });
  });

  it('rechaza eventos desconocidos o mal formados', () => {
    expect(AgentEvent.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(AgentEvent.safeParse({ kind: 'run.finished' }).success).toBe(false);
  });

  it('CreateRunBody: modo por defecto write y prompt obligatorio', () => {
    const b = CreateRunBody.parse({ projectId: 'p', adapter: 'fake', prompt: 'x' });
    expect(b.mode).toBe('write');
    expect(CreateRunBody.safeParse({ projectId: 'p', adapter: 'fake', prompt: '' }).success).toBe(false);
  });

  it('CoreEvent exige eventId positivo y versión 1', () => {
    const ok = { eventId: 1, ts: 1, v: 1, type: 'run.created', scope: {}, payload: {} };
    expect(CoreEvent.safeParse(ok).success).toBe(true);
    expect(CoreEvent.safeParse({ ...ok, eventId: 0 }).success).toBe(false);
    expect(CoreEvent.safeParse({ ...ok, v: 2 }).success).toBe(false);
  });

  it('WsMessage discrimina por canal', () => {
    expect(WsMessage.safeParse({ channel: 'resync', oldestEventId: 5 }).success).toBe(true);
    expect(WsMessage.safeParse({ channel: 'otro' }).success).toBe(false);
  });

  it('mensajes de terminal: límites de tamaño', () => {
    expect(TerminalClientMessage.safeParse({ type: 'input', data: 'x'.repeat(70_000) }).success).toBe(false);
    expect(TerminalClientMessage.safeParse({ type: 'resize', cols: 5, rows: 24 }).success).toBe(false);
    expect(TerminalClientMessage.safeParse({ type: 'resize', cols: 80, rows: 24 }).success).toBe(true);
  });
});
