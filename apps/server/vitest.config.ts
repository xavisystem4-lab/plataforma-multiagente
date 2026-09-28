import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/limpieza.ts'],
    // scrypt usa parámetros de producción (~128 MiB por hash): las pruebas de login tardan más.
    testTimeout: 30_000,
  },
});
