import type { AgentEvent } from '@aiw/contracts';
import { JsonlProcessAdapter, type LineParser } from './process-adapter';
import type { StartRequest } from './types';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * Traduce `opencode run --format json` (v1.18.25): step_start, text, tool_use (ya con estado
 * final), step_finish (tokens, motivo) y error. Un evento 'error' hace fallar el run aunque el
 * proceso salga con código 0.
 */
export const parseOpenCodeLine: LineParser = (line) => {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return [{ kind: 'output.delta', text: line + '\n', stream: 'stdout' }]; }
  if (!isObj(msg)) return null;
  const part = isObj(msg.part) ? msg.part : {};
  const out: AgentEvent[] = [];
  switch (msg.type) {
    case 'step_start': {
      const sid = str(msg.sessionID);
      if (sid) out.push({ kind: 'session', externalSessionId: sid });
      break;
    }
    case 'text':
      if (str(part.text)) out.push({ kind: 'output.delta', text: part.text as string, stream: 'assistant' });
      break;
    case 'tool_use': {
      const state = isObj(part.state) ? part.state : {};
      const toolId = str(part.callID) ?? str(part.id) ?? 'unknown';
      out.push({ kind: 'tool.started', toolId, name: str(part.tool) ?? 'unknown', input: state.input });
      if (state.status === 'completed' || state.status === 'error') {
        out.push({ kind: 'tool.finished', toolId, ok: state.status === 'completed', summary: (str(state.output) ?? str(state.error))?.slice(0, 300) });
      }
      break;
    }
    case 'step_finish': {
      const t = isObj(part.tokens) ? part.tokens : {};
      out.push({ kind: 'usage', inputTokens: num(t.input), outputTokens: num(t.output) });
      break;
    }
    case 'error': {
      const e = isObj(msg.error) ? msg.error : {};
      const d = isObj(e.data) ? e.data : {};
      const message = str(d.message) ?? str(e.name) ?? 'error de OpenCode';
      out.push({ kind: 'error', message, fatal: true });
      if (/rate.?limit|quota|429/i.test(message)) out.push({ kind: 'usage', rateLimited: true });
      out.push({ kind: 'run.finished', ok: false, reason: message });
      break;
    }
  }
  return out;
};

export function buildOpenCodeArgs(req: StartRequest): string[] {
  // 'read' usa el agente integrado 'plan' (sin ediciones). Nunca se usa --auto.
  return ['run', '--format', 'json', '--dir', req.cwd, ...(req.mode === 'read' ? ['--agent', 'plan'] : []), req.prompt];
}

/**
 * OpenCode. Con sus modelos gratuitos los datos pueden usarse para entrenar: dataPolicy
 * 'may-train' (el Core exige aceptación explícita por run).
 */
export function createOpenCodeAdapter(opts: { command?: string; dataPolicy?: 'private-ok' | 'may-train' } = {}): JsonlProcessAdapter {
  return new JsonlProcessAdapter({
    id: 'opencode',
    displayName: 'OpenCode',
    command: opts.command ?? 'opencode',
    capabilities: { interactiveApprovals: false, resume: 'native', structuredEvents: true, reportsCost: true, planMode: true, subagents: false },
    dataPolicy: opts.dataPolicy ?? 'may-train',
    buildArgs: buildOpenCodeArgs,
    parseLine: parseOpenCodeLine,
  });
}
