import { EventEmitter } from 'node:events';
import type { EventoTiempoReal, TipoEvento } from '@softgala/shared';
import type { Db } from '../db';

export interface NuevoEvento {
  usuarioId: string;
  proyectoId: string;
  tareaId?: string | null;
  agenteId?: string | null;
  tipo: TipoEvento;
  datos: Record<string, unknown>;
}

interface FilaEvento {
  seq: number;
  proyecto_id: string;
  tarea_id: string | null;
  agente_id: string | null;
  tipo: TipoEvento;
  datos: string;
  fecha: string;
}

const aEvento = (f: FilaEvento): EventoTiempoReal => ({
  seq: f.seq,
  tipo: f.tipo,
  proyectoId: f.proyecto_id,
  tareaId: f.tarea_id,
  agenteId: f.agente_id,
  fecha: f.fecha,
  datos: JSON.parse(f.datos) as unknown,
});

/**
 * Guarda cada evento (para poder reenviarlo al reconectar) y lo difunde a los
 * suscriptores del usuario dueño. Los eventos nunca cruzan entre usuarios.
 */
export class BusEventos {
  private readonly emisor = new EventEmitter();

  constructor(
    private readonly db: Db,
    private readonly ahora: () => Date,
  ) {
    this.emisor.setMaxListeners(0);
  }

  publicar(e: NuevoEvento): EventoTiempoReal {
    const fecha = this.ahora().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO eventos (usuario_id, proyecto_id, tarea_id, agente_id, tipo, datos, fecha)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.usuarioId, e.proyectoId, e.tareaId ?? null, e.agenteId ?? null, e.tipo, JSON.stringify(e.datos), fecha);
    const evento: EventoTiempoReal = {
      seq: Number(r.lastInsertRowid),
      tipo: e.tipo,
      proyectoId: e.proyectoId,
      tareaId: e.tareaId ?? null,
      agenteId: e.agenteId ?? null,
      fecha,
      datos: e.datos,
    };
    this.emisor.emit(e.usuarioId, evento);
    return evento;
  }

  /** Eventos del usuario posteriores a `desde` (máximo `limite`). */
  pendientes(usuarioId: string, desde: number, limite = 1000): EventoTiempoReal[] {
    const filas = this.db
      .prepare('SELECT * FROM eventos WHERE usuario_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(usuarioId, desde, limite) as unknown as FilaEvento[];
    return filas.map(aEvento);
  }

  deTarea(usuarioId: string, tareaId: string, desde = 0): EventoTiempoReal[] {
    const filas = this.db
      .prepare('SELECT * FROM eventos WHERE usuario_id = ? AND tarea_id = ? AND seq > ? ORDER BY seq LIMIT 5000')
      .all(usuarioId, tareaId, desde) as unknown as FilaEvento[];
    return filas.map(aEvento);
  }

  ultimoSeq(usuarioId: string): number {
    const f = this.db.prepare('SELECT MAX(seq) AS s FROM eventos WHERE usuario_id = ?').get(usuarioId) as { s: number | null };
    return f.s ?? 0;
  }

  suscribir(usuarioId: string, fn: (e: EventoTiempoReal) => void): () => void {
    this.emisor.on(usuarioId, fn);
    return () => this.emisor.off(usuarioId, fn);
  }
}
