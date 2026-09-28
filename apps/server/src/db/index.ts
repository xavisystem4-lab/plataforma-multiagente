import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRACIONES } from './migraciones';

export type Db = DatabaseSync;

/** Abre la base (o ":memory:" en pruebas) y aplica las migraciones pendientes. */
export function abrirDb(archivo: string): Db {
  if (archivo !== ':memory:') mkdirSync(path.dirname(archivo), { recursive: true });
  const db = new DatabaseSync(archivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrar(db);
  return db;
}

function migrar(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migraciones (
    version INTEGER PRIMARY KEY, nombre TEXT NOT NULL, aplicada_en TEXT NOT NULL)`);
  const aplicadas = new Set(
    (db.prepare('SELECT version FROM _migraciones').all() as { version: number }[]).map((f) => f.version),
  );
  for (const m of MIGRACIONES) {
    if (aplicadas.has(m.version)) continue;
    transaccion(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migraciones (version, nombre, aplicada_en) VALUES (?, ?, ?)').run(
        m.version,
        m.nombre,
        new Date().toISOString(),
      );
    });
  }
}

/** Ejecuta `fn` dentro de una transacción; revierte si lanza error. */
export function transaccion<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
