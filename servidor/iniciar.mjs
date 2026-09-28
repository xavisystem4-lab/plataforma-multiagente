/**
 * Inicia el servidor de la Plataforma Multiagente usando .env.servidor.
 * Compila lo necesario si falta y arranca el servidor ya construido.
 * Lo usan tanto el arranque manual como el autoarranque de Windows.
 *
 *   node servidor/iniciar.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const envServidor = path.join(raiz, '.env.servidor');
const servidorJs = path.join(raiz, 'apps', 'server', 'dist', 'server.js');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(envServidor)) {
  console.error('Falta .env.servidor. Ejecuta primero:  node servidor/preparar-servidor.mjs');
  process.exit(1);
}

// Compila la interfaz y el servidor si aún no existe el build (primera vez o tras actualizar).
if (!existsSync(servidorJs)) {
  console.log('Compilando la interfaz y el servidor (solo la primera vez)...');
  const build = spawnSync(npm, ['run', 'build'], { cwd: raiz, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    console.error('La compilación falló. Revisa los mensajes anteriores.');
    process.exit(1);
  }
}

console.log('Iniciando el servidor (Ctrl+C para detener)...');
const proc = spawn(process.execPath, [`--env-file=${envServidor}`, servidorJs], {
  cwd: raiz,
  stdio: 'inherit',
});
proc.on('exit', (codigo) => process.exit(codigo ?? 0));
