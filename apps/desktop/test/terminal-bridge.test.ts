import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createTerminalBridge } = require('../src/terminal-bridge.cjs');

class FakeWS {
  static last: FakeWS;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, Array<(e: any) => void>> = {};
  constructor(public url: string) { FakeWS.last = this; }
  addEventListener(t: string, h: (e: any) => void) { (this.handlers[t] ??= []).push(h); }
  emit(t: string, e: any = {}) { (this.handlers[t] ?? []).forEach((h) => h(e)); }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
}

function setup() {
  const calls: Array<[string, string]> = [];
  const request = async (method: string, path: string) => {
    calls.push([method, path]);
    if (path === '/v1/ws-ticket') return { status: 200, body: { ticket: 'tk' } };
    return { status: 200, body: { terminals: [] } };
  };
  const events: unknown[][] = [];
  const bridge = createTerminalBridge({ request, port: 5, send: (...a: unknown[]) => events.push(a), WebSocketImpl: FakeWS });
  return { bridge, calls, events };
}

describe('terminal-bridge', () => {
  it('adjunta con ticket de un solo uso y reenvía datos y salida al renderer', async () => {
    const { bridge, events } = setup();
    await bridge.attach('term_1');
    expect(FakeWS.last.url).toBe('ws://127.0.0.1:5/v1/terminals/term_1/ws?ticket=tk');
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'data', data: 'hola' }) });
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'exit', exitCode: 0 }) });
    expect(events).toEqual([['term:data', 'term_1', 'hola'], ['term:exit', 'term_1', 0]]);
  });

  it('envía entrada y resize validados', async () => {
    const { bridge } = setup();
    await bridge.attach('t');
    bridge.input('t', 'ls\r');
    bridge.input('t', 'x'.repeat(70000)); // demasiado grande: se descarta
    bridge.resize('t', 100, 30);
    bridge.resize('t', 'a', 30); // inválido: se descarta
    expect(FakeWS.last.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'input', data: 'ls\r' }, { type: 'resize', cols: 100, rows: 30 }]);
  });

  it('dispose cierra los sockets sin pedir al Core que mate el terminal', async () => {
    const { bridge, calls } = setup();
    await bridge.attach('t');
    bridge.dispose();
    expect(FakeWS.last.closed).toBe(true);
    expect(calls.some(([m]) => m === 'DELETE')).toBe(false);
  });

  it('kill sí pide el borrado al Core', async () => {
    const { bridge, calls } = setup();
    await bridge.kill('t');
    expect(calls).toContainEqual(['DELETE', '/v1/terminals/t']);
  });
});
