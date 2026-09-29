/**
 * Respaldo/restauración en el SERVIDOR usando .env.servidor (no el .env de desarrollo).
 *
 *   node servidor/respaldo.mjs crear
 *   node servidor/respaldo.mjs crear -- --dir D:\copias
 *   node servidor/respaldo.mjs restaurar -- --archivo D:\copias\multiagente-....db   (detén el servidor antes)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const envServidor = path.join(raiz, '.env.servidor');
const cliJs = path.join(raiz, 'apps', 'server', 'dist', 'cli', 'respaldo.js');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(envServidor)) {
  console.error('Falta .env.servidor. Ejecuta primero:  node servidor/preparar-servidor.mjs');
  process.exit(1);
}
if (!existsSync(cliJs)) {
  console.log('Compilando el servidor (solo la primera vez)...');
  const build = spawnSync(npm, ['run', 'build'], { cwd: raiz, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    console.error('La compilación falló. Revisa los mensajes anteriores.');
    process.exit(1);
  }
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const proc = spawn(process.execPath, [`--env-file=${envServidor}`, cliJs, ...args], {
  cwd: raiz,
  stdio: 'inherit',
});
proc.on('exit', (codigo) => process.exit(codigo ?? 0));
