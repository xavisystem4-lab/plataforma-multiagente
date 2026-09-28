/**
 * Eventos en tiempo real que el servidor envía por WebSocket.
 * Cada evento lleva una secuencia creciente para que el cliente pueda
 * reconectarse con `?since=<seq>` y recuperar lo que se perdió.
 */
export type TipoEvento =
  | 'task.started'
  | 'task.paused'
  | 'task.completed'
  | 'task.failed'
  | 'agent.step'
  | 'agent.proposal'
  | 'agent.review'
  | 'coordinator.decision'
  | 'file.changed'
  | 'validation.result'
  | 'approval.requested'
  | 'budget.warning';

export interface EventoTiempoReal<T = unknown> {
  seq: number;
  tipo: TipoEvento;
  proyectoId: string;
  tareaId: string | null;
  agenteId: string | null;
  fecha: string;
  datos: T;
}
