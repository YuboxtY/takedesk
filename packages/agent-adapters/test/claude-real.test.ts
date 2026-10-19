import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../src';

// Fixture REAL: salida de `claude -p ... --output-format stream-json --verbose --permission-mode plan`
// (Claude Code 2.1.220, sesión de suscripción) leyendo un archivo con la herramienta Read.
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-real.jsonl');

describe('adaptador Claude contra salida real', () => {
  const events = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).flatMap((l) => parseClaudeLine(l) ?? []);

  it('produce la secuencia esperada: sesión, herramienta, resultado, texto y fin', () => {
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('session');
    expect(kinds).toContain('tool.started');
    expect(kinds).toContain('tool.finished');
    expect(kinds).toContain('output.delta');
    expect(kinds.at(-1)).toBe('run.finished');
  });
  it('la herramienta es Read y termina bien', () => {
    const started = events.find((e) => e.kind === 'tool.started');
    const finished = events.find((e) => e.kind === 'tool.finished');
    expect(started).toMatchObject({ name: 'Read' });
    expect(finished).toMatchObject({ ok: true });
    expect((finished as { toolId: string }).toolId).toBe((started as { toolId: string }).toolId);
  });
  it('el texto final menciona el contenido y el run termina ok sin errores', () => {
    const text = events.filter((e) => e.kind === 'output.delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toContain('hola mundo');
    expect(events.at(-1)).toMatchObject({ kind: 'run.finished', ok: true });
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });
});
