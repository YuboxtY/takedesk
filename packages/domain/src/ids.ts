import { randomBytes } from 'node:crypto';

/** Identificador corto, aleatorio y seguro para usar en rutas y nombres de rama. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
