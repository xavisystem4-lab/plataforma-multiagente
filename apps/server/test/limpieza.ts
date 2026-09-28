import { rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import { temporales } from './ayudantes';

// Borra las carpetas temporales (datos y repositorios de prueba) al terminar cada archivo.
afterAll(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  temporales.clear();
});
