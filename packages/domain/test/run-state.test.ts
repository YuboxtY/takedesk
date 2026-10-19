import { describe, expect, it } from 'vitest';
import { RunState } from '@aiw/contracts';
import { assertTransition, canTransition, isActive, isTerminal, IllegalTransitionError } from '../src';

const ALL = RunState.options;

describe('máquina de estados de run', () => {
  it('estados terminales no tienen salidas', () => {
    for (const s of ALL.filter(isTerminal)) {
      for (const t of ALL) expect(canTransition(s, t)).toBe(false);
    }
  });

  it('camino feliz y aprobación', () => {
    const path = ['queued', 'starting', 'running', 'waiting_approval', 'running', 'completed'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('nunca se puede pasar de queued a completed (sin evidencia de ejecución)', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('pending_reconciliation', 'completed')).toBe(false);
  });

  it('tras una caída solo se reanuda, se reengancha o se marca interrumpido', () => {
    const outs = ALL.filter((t) => canTransition('pending_reconciliation', t));
    expect(outs.sort()).toEqual(['interrupted', 'resumable', 'running']);
  });

  it('assertTransition lanza con transición ilegal', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(IllegalTransitionError);
  });

  it('cada estado es terminal, activo o de espera (clasificación completa)', () => {
    const waiting = ['queued', 'pending_reconciliation', 'resumable'];
    for (const s of ALL) {
      expect(isTerminal(s) || isActive(s) || waiting.includes(s)).toBe(true);
    }
  });
});
