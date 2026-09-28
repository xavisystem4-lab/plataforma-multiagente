import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db';

export const PREFIJO_RESPALDO = 'multiagente-';

/** Nombre con fecha ordenable: multiagente-2026-09-28_1430.db */
function nombreRespaldo(fecha: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${PREFIJO_RESPALDO}${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}_${p(fecha.getHours())}${p(fecha.getMinutes())}${p(fecha.getSeconds())}.db`;
}

/**
 * Copia consistente de la base de datos (VACUUM INTO), segura aunque el servidor esté trabajando.
 * Las claves API y tokens van cifrados con MASTER_KEY: sin esa clave el respaldo no los revela,
 * pero sí contiene usuarios, proyectos y auditoría, así que se debe guardar en un lugar privado.
 */
export function crearRespaldo(db: Db, carpeta: string, ahora = new Date()): string {
  mkdirSync(carpeta, { recursive: true });
  const destino = path.join(carpeta, nombreRespaldo(ahora));
  db.prepare('VACUUM INTO ?').run(destino);
  return destino;
}

/** Deja solo los `conservar` respaldos más recientes de la carpeta. Devuelve los borrados. */
export function podarRespaldos(carpeta: string, conservar: number): string[] {
  let archivos: string[];
  try {
    archivos = readdirSync(carpeta).filter((a) => a.startsWith(PREFIJO_RESPALDO) && a.endsWith('.db'));
  } catch {
    return [];
  }
  const ordenados = archivos
    .map((a) => ({ a, t: statSync(path.join(carpeta, a)).mtimeMs }))
    .sort((x, y) => y.t - x.t || y.a.localeCompare(x.a));
  const sobrantes = ordenados.slice(conservar).map((x) => path.join(carpeta, x.a));
  for (const s of sobrantes) rmSync(s, { force: true });
  return sobrantes;
}

/**
 * Respaldos automáticos: uno al iniciar y luego cada `horas`. Devuelve la función para detenerlos.
 * Un fallo se registra pero nunca detiene el servidor.
 */
export function programarRespaldos(
  db: Db,
  op: { carpeta: string; horas: number; conservar: number; log: { info(m: string): void; error(o: unknown, m: string): void } },
): () => void {
  const ejecutar = () => {
    try {
      const archivo = crearRespaldo(db, op.carpeta);
      podarRespaldos(op.carpeta, op.conservar);
      op.log.info(`Respaldo automático creado: ${archivo}`);
    } catch (err) {
      op.log.error({ err }, 'No se pudo crear el respaldo automático');
    }
  };
  ejecutar();
  const temporizador = setInterval(ejecutar, op.horas * 3_600_000);
  temporizador.unref();
  return () => clearInterval(temporizador);
}
