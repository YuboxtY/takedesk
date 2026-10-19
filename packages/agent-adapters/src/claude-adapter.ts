import type { AgentEvent } from '@aiw/contracts';
import { JsonlProcessAdapter, type LineParser } from './process-adapter';
import type { StartRequest } from './types';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObj(c) ? str(c.text) ?? '' : '')).join('');
  return '';
}

/**
 * Traduce una línea de `claude -p --output-format stream-json --verbose` a eventos
 * normalizados. Formato observado en Claude Code 2.1.220: system/init, assistant,
 * user (tool_result), rate_limit_event y result. Las líneas no JSON pasan como texto.
 */
export const parseClaudeLine: LineParser = (line) => {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return [{ kind: 'output.delta', text: line + '\n', stream: 'stdout' }]; }
  if (!isObj(msg)) return null;
  const out: AgentEvent[] = [];

  switch (msg.type) {
    case 'system': {
      const sid = str(msg.session_id);
      if (msg.subtype === 'init' && sid) out.push({ kind: 'session', externalSessionId: sid });
      break;
    }
    case 'assistant': {
      const m = isObj(msg.message) ? msg.message : {};
      const err = str(msg.error);
      const content = Array.isArray(m.content) ? m.content : [];
      if (err) {
        const text = content.map((c) => (isObj(c) ? str(c.text) ?? '' : '')).join('').trim();
        out.push({ kind: 'error', message: text || err, fatal: true });
        if (err === 'rate_limit') out.push({ kind: 'usage', rateLimited: true });
        break;
      }
      for (const c of content) {
        if (!isObj(c)) continue;
        if (c.type === 'text' && str(c.text)) out.push({ kind: 'output.delta', text: c.text as string, stream: 'assistant' });
        else if (c.type === 'tool_use') out.push({ kind: 'tool.started', toolId: str(c.id) ?? 'unknown', name: str(c.name) ?? 'unknown', input: c.input });
      }
      break;
    }
    case 'user': {
      const m = isObj(msg.message) ? msg.message : {};
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (isObj(c) && c.type === 'tool_result') {
          out.push({ kind: 'tool.finished', toolId: str(c.tool_use_id) ?? 'unknown', ok: c.is_error !== true, summary: toolResultText(c.content).slice(0, 300) || undefined });
        }
      }
      break;
    }
    case 'rate_limit_event': {
      const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : {};
      if (info.status === 'rejected') out.push({ kind: 'usage', rateLimited: true });
      break;
    }
    case 'result': {
      const u = isObj(msg.usage) ? msg.usage : {};
      out.push({ kind: 'usage', inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) });
      const ok = msg.is_error !== true;
      out.push({ kind: 'run.finished', ok, reason: ok ? undefined : str(msg.result) ?? str(msg.terminal_reason) ?? 'error' });
      break;
    }
  }
  return out;
};

export function buildClaudeArgs(req: StartRequest): string[] {
  // 'read' => modo plan (no escribe); 'write' => acepta ediciones en el worktree pero
  // NO salta permisos: los comandos arbitrarios siguen requiriendo permiso previo.
  const mode = req.mode === 'read' ? 'plan' : 'acceptEdits';
  return ['-p', req.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
}

/** Claude Code sobre el binario oficial y la suscripción del usuario (sin API key). */
export function createClaudeAdapter(opts: { command?: string } = {}): JsonlProcessAdapter {
  return new JsonlProcessAdapter({
    id: 'claude',
    displayName: 'Claude Code',
    command: opts.command ?? 'claude',
    capabilities: { interactiveApprovals: false, resume: 'native', structuredEvents: true, reportsCost: true, planMode: true, subagents: true },
    dataPolicy: 'private-ok',
    buildArgs: buildClaudeArgs,
    parseLine: parseClaudeLine,
  });
}
