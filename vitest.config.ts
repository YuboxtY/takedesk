import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Holgados a propósito: bajo carga (antivirus, otros procesos) git y los procesos hijos tardan mucho más.
    // Las pruebas que esperan una condición salen en cuanto se cumple; el margen solo cuenta si algo falla de verdad.
    testTimeout: 90000,
    hookTimeout: 90000,
    pool: 'forks',
  },
});
