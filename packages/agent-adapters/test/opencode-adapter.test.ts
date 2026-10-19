import { describe, expect, it } from 'vitest';
import { buildOpenCodeArgs, parseOpenCodeLine } from '../src';

// Líneas REALES capturadas de `opencode run --format json` 1.18.25 (recortadas).
const STEP_START = '{"type":"step_start","timestamp":1,"sessionID":"ses_abc","part":{"type":"step-start"}}';
const TEXT = '{"type":"text","sessionID":"ses_abc","part":{"type":"text","text":"hola"}}';
const TOOL = '{"type":"tool_use","sessionID":"ses_abc","part":{"type":"tool","tool":"read","callID":"call_1","state":{"status":"completed","input":{"filePath":"a.txt"},"output":"1: hola mundo"}}}';
const STEP_FINISH = '{"type":"step_finish","sessionID":"ses_abc","part":{"type":"step-finish","reason":"stop","tokens":{"total":7708,"input":7685,"output":4}}}';
const ERROR = '{"type":"error","sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details."}}}';

describe('parseOpenCodeLine', () => {
  it('sesión, texto, herramienta y uso', () => {
    expect(parseOpenCodeLine(STEP_START)).toEqual([{ kind: 'session', externalSessionId: 'ses_abc' }]);
    expect(parseOpenCodeLine(TEXT)).toEqual([{ kind: 'output.delta', text: 'hola', stream: 'assistant' }]);
    expect(parseOpenCodeLine(TOOL)).toEqual([
      { kind: 'tool.started', toolId: 'call_1', name: 'read', input: { filePath: 'a.txt' } },
      { kind: 'tool.finished', toolId: 'call_1', ok: true, summary: '1: hola mundo' },
    ]);
    expect(parseOpenCodeLine(STEP_FINISH)).toEqual([{ kind: 'usage', inputTokens: 7685, outputTokens: 4 }]);
  });
  it('un evento error hace fallar el run aunque el proceso salga con 0', () => {
    const evs = parseOpenCodeLine(ERROR)!;
    expect(evs[0]).toMatchObject({ kind: 'error', fatal: true });
    expect(evs.at(-1)).toMatchObject({ kind: 'run.finished', ok: false });
  });
});

describe('buildOpenCodeArgs', () => {
  const base = { runId: 'r', cwd: 'C:\\w', prompt: 'haz x', runDir: '.' };
  it('read usa el agente plan; nunca --auto', () => {
    expect(buildOpenCodeArgs({ ...base, mode: 'read' })).toContain('plan');
    expect(buildOpenCodeArgs({ ...base, mode: 'write' }).join(' ')).not.toContain('--auto');
  });
});
