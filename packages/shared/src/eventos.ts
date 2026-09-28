/**
 * Eventos en tiempo real que el servidor envía por WebSocket.
 * Cada evento lleva una secuencia creciente para que el cliente pueda
 * reconectarse indicando la última recibida y recuperar lo que se perdió.
 */
export type TipoEvento =
  | 'task.created'
  | 'task.started'
  | 'task.paused'
  | 'task.resumed'
  | 'task.waiting'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'agent.message'
  | 'agent.step'
  | 'agent.proposal'
  | 'agent.review'
  | 'coordinator.decision'
  | 'tool.call'
  | 'tool.result'
  | 'file.changed'
  | 'validation.result'
  | 'approval.requested'
  | 'approval.resolved'
  | 'task.reverted'
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

/** Mensajes del cliente por WebSocket. */
export type MensajeClienteWs =
  | { tipo: 'autenticar'; token: string; desde?: number }
  | { tipo: 'ping' };

/** Mensajes del servidor por WebSocket. */
export type MensajeServidorWs =
  | { tipo: 'listo'; ultimoSeq: number }
  | { tipo: 'evento'; evento: EventoTiempoReal }
  | { tipo: 'pong' }
  | { tipo: 'error'; mensaje: string };
