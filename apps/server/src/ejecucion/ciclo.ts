import type { EstadoTarea, TipoEvento } from '@softgala/shared';
import type { AdaptadorModelos, MensajeConversacion } from '../modelos/adaptadores';
import { HERRAMIENTA_PREGUNTA, type DefinicionHerramienta, type EjecutorHerramientas, type ResultadoHerramienta } from './herramientas';

/** Termina la ejecución con un estado final o de espera, sin tratarlo como error inesperado. */
export class FinEjecucion extends Error {
  constructor(
    readonly estado: EstadoTarea,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/**
 * Herramienta con la que el agente entrega su resultado estructurado (propuesta, revisión, plan).
 * `validar` devuelve un mensaje de error para que el agente corrija, o null si es válido.
 */
export interface HerramientaTerminal {
  definicion: DefinicionHerramienta;
  validar(entrada: unknown): string | null;
  /** Si es true, terminar sin llamarla no es válido: se le pide que la use. */
  obligatoria?: boolean;
}

export interface OpcionesCiclo {
  adaptador: AdaptadorModelos;
  modelo: string;
  sistema: string;
  herramientas: DefinicionHerramienta[];
  ejecutor: EjecutorHerramientas;
  /** Conversación (se modifica en el lugar). */
  mensajes: MensajeConversacion[];
  senal: AbortSignal;
  maxTurnos: number;
  maxTokensRespuesta: number;
  terminal?: HerramientaTerminal;
  /** Lanza FinEjecucion si se superó algún límite. */
  antesDeTurno(): void;
  alUsar(entrada: number, salida: number): void;
  emitir(tipo: TipoEvento, datos: Record<string, unknown>): void;
  /** Punto consistente: el turno del asistente y sus resultados ya están en `mensajes`. */
  guardar(mensajes: MensajeConversacion[]): void;
  alModificarArchivo?(ruta: string): void;
  alErrorInterno?(err: unknown): void;
}

export type ResultadoCiclo =
  | { tipo: 'fin'; texto: string }
  | { tipo: 'terminal'; entrada: unknown; texto: string }
  | { tipo: 'pregunta'; id: string; texto: string };

/** Resume la entrada de una herramienta para el evento (sin volcar contenidos completos). */
export function resumirEntrada(entrada: unknown): Record<string, unknown> {
  if (!entrada || typeof entrada !== 'object') return {};
  return Object.fromEntries(
    Object.entries(entrada as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? (v.length > 200 ? `${v.slice(0, 200)}… (${v.length} caracteres)` : v) : Array.isArray(v) ? `[${v.length} elementos]` : v,
    ]),
  );
}

/**
 * Ciclo del agente: turno del modelo → herramientas → resultados, hasta que el agente termina,
 * entrega su resultado con la herramienta terminal o pregunta algo al usuario.
 * Los límites y la cancelación se comprueban en cada turno.
 */
export async function ejecutarCiclo(o: OpcionesCiclo): Promise<ResultadoCiclo> {
  const herramientas = o.terminal ? [...o.herramientas, o.terminal.definicion] : o.herramientas;
  const nombreTerminal = o.terminal?.definicion.nombre;

  for (let turno = 1; ; turno++) {
    if (turno > o.maxTurnos) throw new FinEjecucion('fallida', `Se alcanzó el máximo de ${o.maxTurnos} turnos sin terminar.`);
    o.antesDeTurno();

    const r = await o.adaptador.turno({
      modelo: o.modelo,
      sistema: o.sistema,
      mensajes: o.mensajes,
      herramientas,
      maxTokens: o.maxTokensRespuesta,
      senal: o.senal,
    });
    o.alUsar(r.uso.entrada, r.uso.salida);
    if (r.mensaje.texto) o.emitir('agent.message', { autor: 'agente', texto: r.mensaje.texto });

    if (r.fin === 'rechazo') throw new FinEjecucion('fallida', 'El modelo rechazó continuar con la solicitud.');
    if (r.fin === 'limite_tokens') throw new FinEjecucion('fallida', 'La respuesta del modelo se cortó por el límite de tokens por respuesta.');

    if (r.mensaje.llamadas.length === 0) {
      o.mensajes.push(r.mensaje);
      if (o.terminal?.obligatoria) {
        // No se aceptó la respuesta libre: se le recuerda cómo entregar.
        o.mensajes.push({ rol: 'usuario', texto: `Para terminar debes llamar a la herramienta ${nombreTerminal}.` });
        o.guardar(o.mensajes);
        continue;
      }
      o.guardar(o.mensajes);
      return { tipo: 'fin', texto: r.mensaje.texto };
    }

    const resultados: { id: string; contenido: string; error: boolean }[] = [];
    let pregunta: { id: string; texto: string } | null = null;
    let entregado: { entrada: unknown } | null = null;

    for (const ll of r.mensaje.llamadas) {
      if (o.senal.aborted) break;
      if (ll.nombre === HERRAMIENTA_PREGUNTA) {
        const texto = (ll.entrada as { pregunta?: unknown })?.pregunta;
        if (typeof texto === 'string' && texto.trim()) {
          pregunta = { id: ll.id, texto: texto.trim().slice(0, 2000) };
          continue;
        }
        resultados.push({ id: ll.id, contenido: 'Falta el texto de la pregunta.', error: true });
        continue;
      }
      if (nombreTerminal && ll.nombre === nombreTerminal) {
        const error = o.terminal!.validar(ll.entrada);
        resultados.push({ id: ll.id, contenido: error ?? 'Recibido.', error: !!error });
        if (!error) entregado = { entrada: ll.entrada };
        continue;
      }
      o.emitir('tool.call', { herramienta: ll.nombre, entrada: resumirEntrada(ll.entrada) });
      let res: ResultadoHerramienta;
      try {
        res = await o.ejecutor.ejecutar(ll.nombre, ll.entrada);
      } catch (err) {
        o.alErrorInterno?.(err);
        res = { error: true, contenido: 'Error interno al ejecutar la herramienta.' };
      }
      o.emitir('tool.result', { herramienta: ll.nombre, error: res.error, resumen: res.contenido.slice(0, 500) });
      if (res.archivoModificado) {
        o.alModificarArchivo?.(res.archivoModificado);
        o.emitir('file.changed', { ruta: res.archivoModificado });
      }
      resultados.push({ id: ll.id, contenido: res.contenido, error: res.error });
    }
    if (o.senal.aborted) throw o.senal.reason ?? new Error('abortado');

    // Punto consistente: el turno del asistente y sus resultados se guardan juntos.
    o.mensajes.push(r.mensaje);
    if (resultados.length) o.mensajes.push({ rol: 'resultados', resultados });
    o.guardar(o.mensajes);

    if (entregado) return { tipo: 'terminal', entrada: entregado.entrada, texto: r.mensaje.texto };
    if (pregunta) return { tipo: 'pregunta', ...pregunta };
  }
}
