/**
 * Respaldo y restauración de la base de datos desde la terminal del servidor.
 *
 *   npm run respaldo:crear                 → crea un .db en la carpeta de respaldos
 *   npm run respaldo:crear -- --dir D:\ruta
 *   npm run respaldo:restaurar -- --archivo <ruta.db>   (detén el servidor antes)
 *
 * IMPORTANTE: el respaldo NO incluye la MASTER_KEY (está en .env). Para mudarte de PC necesitas
 * el .db y el mismo MASTER_KEY; sin esa clave no se pueden descifrar las claves API ni los tokens.
 */
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { cargarConfig, ErrorConfig } from '../config';
import { abrirDb } from '../db';
import { crearRespaldo, podarRespaldos } from '../respaldos';

function confirmar(pregunta: string): Promise<boolean> {
  if (process.env.CONFIRMAR === 'si') return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(pregunta, (a) => (rl.close(), r(/^s/i.test(a.trim())))));
}

async function main(): Promise<void> {
  const accion = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { dir: { type: 'string' }, archivo: { type: 'string' } }, allowPositionals: false });
  const config = cargarConfig();
  const rutaDb = path.join(config.dirDatos, 'multiagente.db');

  if (accion === 'crear') {
    const db = abrirDb(rutaDb);
    const carpeta = values.dir ? path.resolve(values.dir) : config.respaldos.carpeta;
    const destino = crearRespaldo(db, carpeta);
    db.close();
    const borrados = values.dir ? [] : podarRespaldos(carpeta, config.respaldos.conservar);
    console.log(`Respaldo creado: ${destino}`);
    if (borrados.length) console.log(`Se eliminaron ${borrados.length} respaldo(s) antiguos (se conservan ${config.respaldos.conservar}).`);
    console.log('Recuerda: guarda también tu MASTER_KEY (del archivo .env) en un lugar seguro y separado.');
    return;
  }

  if (accion === 'restaurar') {
    if (!values.archivo) throw new Error('Falta --archivo <ruta del respaldo .db>');
    const origen = path.resolve(values.archivo);
    if (!existsSync(origen)) throw new Error(`No existe el archivo: ${origen}`);
    // Verifica que el respaldo abra y esté íntegro antes de tocar los datos actuales.
    const prueba = abrirDb(':memory:');
    prueba.close();
    const verif = abrirDb(origen);
    const integridad = verif.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    verif.close();
    if (integridad.integrity_check !== 'ok') throw new Error(`El respaldo está dañado (integrity_check: ${integridad.integrity_check}).`);

    console.log(`Vas a REEMPLAZAR la base actual (${rutaDb}) con:\n  ${origen}`);
    console.log('El servidor debe estar detenido. Se guardará una copia de la base actual por si acaso.');
    if (!(await confirmar('¿Continuar? (s/N) '))) return console.log('Cancelado.');

    if (existsSync(rutaDb)) {
      const previa = `${rutaDb}.antes-de-restaurar-${Date.now()}.db`;
      copyFileSync(rutaDb, previa);
      console.log(`Copia de la base anterior: ${previa}`);
    }
    copyFileSync(origen, rutaDb);
    // Deja la base en un estado limpio (aplica migraciones si el respaldo es más antiguo).
    abrirDb(rutaDb).close();
    console.log('Restauración completada. Verifica que uses el mismo MASTER_KEY que cuando se creó el respaldo.');
    return;
  }

  throw new Error('Uso: respaldo crear | respaldo restaurar --archivo <ruta.db>');
}

main().catch((err) => {
  console.error(err instanceof ErrorConfig ? err.message : err instanceof Error ? err.message : err);
  process.exit(1);
});
