/**
 * Crea un usuario en el SERVIDOR usando .env.servidor (no el .env de desarrollo).
 *
 *   node servidor/usuario.mjs -- --email tu@correo.com --nombre "Tu Nombre"
 *   node servidor/usuario.mjs -- --email tu@correo.com --nombre "Tu Nombre" --rol admin
 *
 * La contraseña se pide de forma oculta; para automatizar, usa la variable NUEVA_PASSWORD.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const envServidor = path.join(raiz, '.env.servidor');
const cliJs = path.join(raiz, 'apps', 'server', 'dist', 'cli', 'crear-usuario.js');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(envServidor)) {
  console.error('Falta .env.servidor. Ejecuta primero:  node servidor/preparar-servidor.mjs');
  process.exit(1);
}

// Compila el servidor si aún no existe el build (necesario para el comando de usuario).
if (!existsSync(cliJs)) {
  console.log('Compilando el servidor (solo la primera vez)...');
  const build = spawnSync(npm, ['run', 'build'], { cwd: raiz, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    console.error('La compilación falló. Revisa los mensajes anteriores.');
    process.exit(1);
  }
}

// Pasa los argumentos tal cual (quita un "--" inicial si npm/el usuario lo agregó).
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const proc = spawn(process.execPath, [`--env-file=${envServidor}`, cliJs, ...args], {
  cwd: raiz,
  stdio: 'inherit',
});
proc.on('exit', (codigo) => process.exit(codigo ?? 0));
