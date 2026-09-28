import type { Db } from './db';

export interface EntradaAuditoria {
  accion: string;
  usuarioId?: string | null;
  agenteId?: string | null;
  proyectoId?: string | null;
  detalle?: Record<string, unknown>;
  ip?: string | null;
}

/** Registra una acción. Nunca incluyas secretos en `detalle`. */
export function auditar(db: Db, e: EntradaAuditoria): void {
  db.prepare(
    `INSERT INTO auditoria (fecha, usuario_id, agente_id, proyecto_id, accion, detalle, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    e.usuarioId ?? null,
    e.agenteId ?? null,
    e.proyectoId ?? null,
    e.accion,
    e.detalle ? JSON.stringify(e.detalle) : null,
    e.ip ?? null,
  );
}
