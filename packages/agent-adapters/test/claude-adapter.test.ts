import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, parseClaudeLine } from '../src';

const p = (o: unknown) => parseClaudeLine(JSON.stringify(o));

describe('parseClaudeLine', () => {
  it('init => session', () => {
    expect(p({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual([{ kind: 'session', externalSessionId: 's1' }]);
  });
  it('texto y herramientas del asistente', () => {
    const evs = p({ type: 'assistant', message: { content: [{ type: 'text', text: 'hola' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] } });
    expect(evs).toEqual([
      { kind: 'output.delta', text: 'hola', stream: 'assistant' },
      { kind: 'tool.started', toolId: 't1', name: 'Read', input: { file_path: 'a' } },
    ]);
  });
  it('tool_result => tool.finished con ok según is_error', () => {
    const evs = p({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } });
    expect(evs).toEqual([{ kind: 'tool.finished', toolId: 't1', ok: false, summary: 'boom' }]);
  });
  // Salida REAL capturada con Claude Code 2.1.220 sin sesión iniciada.
  it('no autenticado => error fatal y run.finished fallido', () => {
    const a = p({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', is_api_error_message: true });
    expect(a).toEqual([{ kind: 'error', message: 'Not logged in · Please run /login', fatal: true }]);
    const r = p({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(r?.at(-1)).toEqual({ kind: 'run.finished', ok: false, reason: 'Not logged in · Please run /login' });
  });
  it('result correcto => run.finished ok', () => {
    expect(p({ type: 'result', is_error: false, result: 'x', usage: { input_tokens: 5, output_tokens: 7 } })).toEqual([
      { kind: 'usage', inputTokens: 5, outputTokens: 7 },
      { kind: 'run.finished', ok: true, reason: undefined },
    ]);
  });
  it('límite de cuota => usage.rateLimited', () => {
    expect(p({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toEqual([{ kind: 'usage', rateLimited: true }]);
  });
  it('texto plano pasa como salida', () => {
    expect(parseClaudeLine('algo')).toEqual([{ kind: 'output.delta', text: 'algo\n', stream: 'stdout' }]);
  });
});

describe('buildClaudeArgs', () => {
  const base = { runId: 'r', cwd: '.', prompt: 'haz x', runDir: '.' };
  it('read => plan; write => acceptEdits, nunca saltar permisos', () => {
    expect(buildClaudeArgs({ ...base, mode: 'read' })).toContain('plan');
    const w = buildClaudeArgs({ ...base, mode: 'write' });
    expect(w).toContain('acceptEdits');
    expect(w.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });
});
