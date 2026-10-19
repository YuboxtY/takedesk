import fs from 'node:fs';
import path from 'node:path';
import type { Repos } from './repos';

export interface RetentionPolicy {
  /** Días que se conserva el detalle (events.ndjson, output.log, índice) de runs terminados. */
  runDetailDays: number;
  /** Días que se conservan los eventos durables del Core para reanudación. */
  coreEventDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { runDetailDays: 14, coreEventDays: 7 };

export interface RetentionResult {
  runsPurged: number;
  bytesFreed: number;
  coreEventsDeleted: number;
}

const DAY = 86_400_000;

/**
 * Purga el detalle de runs terminados: borra archivos grandes y filas de índice,
 * conservando la fila del run (resumen, estado, motivo) para el historial.
 */
export function applyRetention(repos: Repos, now: number, policy: RetentionPolicy = DEFAULT_RETENTION): RetentionResult {
  let runsPurged = 0;
  let bytesFreed = 0;
  for (const run of repos.runs.listFinishedBefore(now - policy.runDetailDays * DAY)) {
    for (const name of ['events.ndjson', 'output.log', 'stderr.log']) {
      const f = path.join(run.runDir, name);
      try {
        bytesFreed += fs.statSync(f).size;
        fs.rmSync(f, { force: true });
      } catch {
        /* no existía */
      }
    }
    repos.eventIndex.deleteForRun(run.id);
    repos.runs.update(run.id, { detailPurged: 1 });
    runsPurged++;
  }
  const coreEventsDeleted = repos.coreEvents.pruneBefore(now - policy.coreEventDays * DAY);
  return { runsPurged, bytesFreed, coreEventsDeleted };
}
