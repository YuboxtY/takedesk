import type { RunState } from '@aiw/contracts';

/**
 * Máquina de estados de un run (diagrama 11 de docs/04-DIAGRAMAS.md).
 * Regla de integridad: 'completed' solo se alcanza con evidencia de finalización
 * (lo exige RunManager); aquí solo se valida que la transición sea legal.
 */
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'failed', 'cancelling', 'pending_reconciliation'],
  running: ['waiting_approval', 'completed', 'failed', 'cancelling', 'pending_reconciliation'],
  waiting_approval: ['running', 'cancelled', 'cancelling', 'failed', 'pending_reconciliation'],
  // 'completed' desde cancelling: el agente terminó con éxito antes de que la cancelación surtiera efecto (hay evidencia).
  cancelling: ['cancelled', 'failed', 'completed', 'pending_reconciliation'],
  pending_reconciliation: ['running', 'resumable', 'interrupted'],
  resumable: ['queued'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export const TERMINAL_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled', 'interrupted'];
/** Estados en los que existe (o debería existir) un proceso del agente. */
export const ACTIVE_STATES: readonly RunState[] = ['starting', 'running', 'waiting_approval', 'cancelling'];

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`Transición ilegal de run: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export const isTerminal = (s: RunState): boolean => TERMINAL_STATES.includes(s);
export const isActive = (s: RunState): boolean => ACTIVE_STATES.includes(s);
