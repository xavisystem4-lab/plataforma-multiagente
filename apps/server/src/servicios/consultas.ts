import type { EntradaAuditoriaPublica, PaginaAuditoria, Resumen } from '@softgala/shared';
import { leerJson, type Actor, type Contexto } from './contexto';

interface FilaAuditoria {
  id: number;
  fecha: string;
  accion: string;
  email: string | null;
  proyecto_id: string | null;
  agente_id: string | null;
  detalle: string | null;
  ip: string | null;
}

export interface FiltroAuditoria {
  limite: number;
  antesDe?: number;
  /** Prefijo de la acción, p. ej. "auth." o "proyecto.". */
  accion?: string;
}

/** Consultas de solo lectura: auditoría y resumen del panel. */
export class ServicioConsultas {
  constructor(private readonly ctx: Contexto) {}

  /** El administrador ve toda la auditoría; los demás usuarios, solo la suya. */
  auditoria(actor: Actor, filtro: FiltroAuditoria): PaginaAuditoria {
    const condiciones: string[] = [];
    const params: (string | number)[] = [];
    if (actor.rol !== 'admin') {
      condiciones.push('a.usuario_id = ?');
      params.push(actor.id);
    }
    if (filtro.antesDe !== undefined) {
      condiciones.push('a.id < ?');
      params.push(filtro.antesDe);
    }
    if (filtro.accion) {
      // Escapa comodines de LIKE para que el filtro sea un prefijo literal.
      condiciones.push("a.accion LIKE ? ESCAPE '\\'");
      params.push(`${filtro.accion.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const filas = this.ctx.db
      .prepare(
        `SELECT a.id, a.fecha, a.accion, u.email, a.proyecto_id, a.agente_id, a.detalle, a.ip
         FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
         ${donde} ORDER BY a.id DESC LIMIT ?`,
      )
      .all(...params, filtro.limite + 1) as unknown as FilaAuditoria[];

    const hayMas = filas.length > filtro.limite;
    const entradas: EntradaAuditoriaPublica[] = filas.slice(0, filtro.limite).map((f) => ({
      id: f.id,
      fecha: f.fecha,
      accion: f.accion,
      usuarioEmail: f.email,
      proyectoId: f.proyecto_id,
      agenteId: f.agente_id,
      detalle: leerJson<Record<string, unknown> | null>(f.detalle, null),
      ip: f.ip,
    }));
    return { entradas, siguiente: hayMas ? (entradas.at(-1)?.id ?? null) : null };
  }

  resumen(actor: Actor): Resumen {
    const contar = (sql: string) => (this.ctx.db.prepare(sql).get(actor.id) as { n: number }).n;
    return {
      proyectos: contar('SELECT COUNT(*) AS n FROM proyectos WHERE usuario_id = ?'),
      agentes: contar('SELECT COUNT(*) AS n FROM agentes WHERE usuario_id = ?'),
      agentesActivos: contar('SELECT COUNT(*) AS n FROM agentes WHERE usuario_id = ? AND activo = 1'),
      proveedores: contar('SELECT COUNT(*) AS n FROM proveedores WHERE usuario_id = ?'),
      // Las aprobaciones llegan en la fase F4.
      aprobacionesPendientes: 0,
    };
  }
}
