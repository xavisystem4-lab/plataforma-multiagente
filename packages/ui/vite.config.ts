import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import paquete from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  define: { __VERSION_APP__: JSON.stringify(paquete.version) },
  // Rutas relativas: el mismo build lo cargan Electron (app://) y Capacitor (Android).
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
