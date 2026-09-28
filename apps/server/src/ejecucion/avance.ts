import type { AvanceTarea, EstadoTarea, FaseColaboracion, ModoTarea } from '@softgala/shared';
import type { Db } from '../db';

export interface DatosAvance {
  estado: EstadoTarea;
  modo: ModoTarea;
  fase: FaseColaboracion | null;
  /** Herramientas ejecutadas por el agente (modo individual). */
  pasos: number;
  subtareas: { total: number; completadas: number };
  validando: boolean;
}

const ETAPA_ESTADO: Partial<Record<EstadoTarea, string>> = {
  en_cola: 'En cola',
  pausada: 'Pausada',
  esperando_usuario: 'Espera tu respuesta',
  fallida: 'Fallida',
  cancelada: 'Cancelada',
};

/**
 * Porcentaje de avance de una tarea.
 * - Equipo: se basa en hechos (fase y subtareas completadas), así que no es estimado durante la ejecución.
 * - Individual: el trabajo total no se conoce de antemano; se estima por pasos con una curva que se acerca
 *   al 88 % sin alcanzarlo, y solo llega a 100 % cuando la tarea termina. Se marca como estimado.
 */
export function calcularAvance(d: DatosAvance): AvanceTarea {
  if (d.estado === 'completada') return { porcentaje: 100, etapa: 'Completada', estimado: false };

  let porcentaje: number;
  let etapa: string;
  let estimado = true;

  if (d.modo === 'colaborativo') {
    switch (d.fase) {
      case null:
        [porcentaje, etapa] = [3, 'Preparando'];
        break;
      case 'propuestas':
        [porcentaje, etapa] = [10, 'Propuestas'];
        break;
      case 'revision':
        [porcentaje, etapa] = [22, 'Revisión cruzada'];
        break;
      case 'sintesis':
        [porcentaje, etapa] = [32, 'Síntesis del coordinador'];
        break;
      case 'ejecucion': {
        const fraccion = d.subtareas.total ? d.subtareas.completadas / d.subtareas.total : 0;
        porcentaje = 35 + 55 * fraccion;
        etapa = `Subtareas ${d.subtareas.completadas} de ${d.subtareas.total}`;
        estimado = false;
        break;
      }
      case 'integracion':
        [porcentaje, etapa] = [94, 'Integración y validación'];
        break;
    }
  } else if (d.validando) {
    [porcentaje, etapa] = [92, 'Validando'];
  } else if (d.pasos === 0) {
    [porcentaje, etapa] = [d.estado === 'en_cola' ? 0 : 5, 'Preparando'];
  } else {
    porcentaje = 8 + 80 * (1 - Math.exp(-d.pasos / 10));
    etapa = `${d.pasos} paso${d.pasos === 1 ? '' : 's'}`;
  }

  if (d.estado === 'en_cola' && d.pasos === 0 && !d.fase) porcentaje = 0;
  return { porcentaje: Math.round(porcentaje), etapa: ETAPA_ESTADO[d.estado] ?? etapa, estimado };
}

/** Reúne los datos de la tarea y calcula su avance. */
export function avanceDeTarea(db: Db, t: { id: string; estado: EstadoTarea; modo: ModoTarea; fase: FaseColaboracion | null }): AvanceTarea {
  const pasos = (db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE tarea_id = ? AND tipo = 'tool.call'").get(t.id) as { n: number }).n;
  const sub = db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(estado = 'completada'), 0) AS completadas FROM subtareas WHERE tarea_id = ?")
    .get(t.id) as { total: number; completadas: number };
  const ultimo = db
    .prepare("SELECT datos FROM eventos WHERE tarea_id = ? AND tipo IN ('agent.step','tool.call','task.completed') ORDER BY seq DESC LIMIT 1")
    .get(t.id) as { datos: string } | undefined;
  const validando = t.estado === 'ejecutando' && !!ultimo && ultimo.datos.includes('"paso":"validando"');
  return calcularAvance({ estado: t.estado, modo: t.modo, fase: t.fase, pasos, subtareas: sub, validando });
}
