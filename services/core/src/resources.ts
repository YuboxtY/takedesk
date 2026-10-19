import { availableMemBytes, freeDiskBytes } from '@aiw/platform';
import type { CoreConfig } from './config';

export interface ResourceProbe {
  freeDiskBytes(dir: string): number;
  availableMemBytes(): number;
}

export const systemProbe: ResourceProbe = { freeDiskBytes, availableMemBytes };

export type Admission = { ok: true } | { ok: false; reason: string };

/** ¿Hay recursos para iniciar otro run? (disco y RAM libres; los límites de concurrencia los aplica RunManager). */
export function checkAdmission(cfg: CoreConfig, probe: ResourceProbe): Admission {
  const disk = probe.freeDiskBytes(cfg.dataDir);
  if (disk < cfg.minFreeDiskBytes) {
    return { ok: false, reason: `Disco libre insuficiente: ${(disk / 1024 ** 3).toFixed(1)} GB < ${(cfg.minFreeDiskBytes / 1024 ** 3).toFixed(1)} GB` };
  }
  const mem = probe.availableMemBytes();
  if (mem < cfg.reserveMemBytes) {
    return { ok: false, reason: `RAM disponible insuficiente: ${(mem / 1024 ** 3).toFixed(1)} GB < ${(cfg.reserveMemBytes / 1024 ** 3).toFixed(1)} GB` };
  }
  return { ok: true };
}
