import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { abrirDb, type Db } from '../src/db';
import { crearRespaldo, podarRespaldos, PREFIJO_RESPALDO, programarRespaldos } from '../src/respaldos';

const dbs: Db[] = [];
function baseConDatos(): Db {
  const db = abrirDb(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('secreto-cifrado');
  dbs.push(db);
  return db;
}
const carpetaTemp = () => mkdtempSync(path.join(tmpdir(), 'softgala-resp-'));

afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

describe('Respaldos', () => {
  it('crea una copia consistente que se puede volver a abrir con los mismos datos', () => {
    const db = baseConDatos();
    const carpeta = carpetaTemp();
    const archivo = crearRespaldo(db, carpeta, new Date('2026-09-28T14:30:15'));
    expect(path.basename(archivo)).toBe('multiagente-2026-09-28_143015.db');
    expect(existsSync(archivo)).toBe(true);

    const copia = abrirDb(archivo);
    expect((copia.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('secreto-cifrado');
    copia.close();
  });

  it('poda deja solo los N más recientes', () => {
    const db = baseConDatos();
    const carpeta = carpetaTemp();
    for (const m of [10, 20, 30, 40]) crearRespaldo(db, carpeta, new Date(`2026-09-28T14:${m}:00`));
    const borrados = podarRespaldos(carpeta, 2);
    expect(borrados).toHaveLength(2);
    const quedan = readdirSync(carpeta).filter((a) => a.startsWith(PREFIJO_RESPALDO)).sort();
    expect(quedan).toEqual(['multiagente-2026-09-28_143000.db', 'multiagente-2026-09-28_144000.db']);
  });

  it('el programador crea uno al iniciar y un error no rompe nada', () => {
    const db = baseConDatos();
    const carpeta = carpetaTemp();
    const errores: unknown[] = [];
    const detener = programarRespaldos(db, {
      carpeta,
      horas: 24,
      conservar: 7,
      log: { info: () => {}, error: (o) => errores.push(o) },
    });
    expect(readdirSync(carpeta).filter((a) => a.startsWith(PREFIJO_RESPALDO))).toHaveLength(1);
    detener();
    expect(errores).toHaveLength(0);
  });
});
