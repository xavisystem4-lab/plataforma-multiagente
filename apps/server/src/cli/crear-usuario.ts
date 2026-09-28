/**
 * Crea un usuario desde la terminal del servidor (no hay registro público).
 *   npm run usuario:crear -- --email tu@correo.com --nombre "Tu Nombre" [--rol admin|usuario]
 * La contraseña se pide oculta; para automatizar, usa la variable NUEVA_PASSWORD.
 * El primer usuario creado es admin por defecto.
 */
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { esquemaPasswordNueva, ROLES, type Rol } from '@softgala/shared';
import { ServicioAuth } from '../auth/servicio';
import { cargarConfig } from '../config';
import { abrirDb } from '../db';
import { ErrorApp } from '../errores';

function pedirOculto(pregunta: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const salida = rl as unknown as { _writeToOutput: (s: string) => void };
    let mostrarPregunta = true;
    salida._writeToOutput = (s: string) => {
      if (mostrarPregunta) process.stdout.write(s);
      else if (s.includes('\n')) process.stdout.write('\n');
    };
    rl.question(pregunta, (respuesta) => {
      rl.close();
      resolve(respuesta);
    });
    mostrarPregunta = false;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, nombre: { type: 'string' }, rol: { type: 'string' } },
  });
  if (!values.email || !values.nombre) {
    throw new Error('Uso: npm run usuario:crear -- --email <correo> --nombre "<nombre>" [--rol admin|usuario]');
  }
  if (values.rol && !ROLES.includes(values.rol as Rol)) throw new Error('El rol debe ser admin o usuario');

  const config = cargarConfig();
  const db = abrirDb(path.join(config.dirDatos, 'multiagente.db'));
  const auth = new ServicioAuth(db, config);
  const rol: Rol = (values.rol as Rol | undefined) ?? (auth.contarUsuarios() === 0 ? 'admin' : 'usuario');

  let password = process.env.NUEVA_PASSWORD;
  if (!password) {
    password = await pedirOculto('Contraseña (mín. 12 caracteres): ');
    const confirmacion = await pedirOculto('Repite la contraseña: ');
    if (password !== confirmacion) throw new Error('Las contraseñas no coinciden');
  }
  const valida = esquemaPasswordNueva.safeParse(password);
  if (!valida.success) throw new Error(valida.error.issues[0]?.message);

  const u = await auth.crearUsuario({ email: values.email, nombre: values.nombre, rol, password });
  db.close();
  console.log(`Usuario creado: ${u.email} (${u.rol})`);
}

main().catch((err) => {
  console.error(err instanceof ErrorApp || err instanceof Error ? err.message : err);
  process.exit(1);
});
