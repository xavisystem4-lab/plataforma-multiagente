import { z } from 'zod';

export const ESTADOS_TAREA = [
  'en_cola',
  'ejecutando',
  'pausada',
  'esperando_usuario',
  'completada',
  'fallida',
  'cancelada',
] as const;
export type EstadoTarea = (typeof ESTADOS_TAREA)[number];

export const NOMBRE_ESTADO: Record<EstadoTarea, string> = {
  en_cola: 'En cola',
  ejecutando: 'Ejecutando',
  pausada: 'Pausada',
  esperando_usuario: 'Espera tu respuesta',
  completada: 'Completada',
  fallida: 'Fallida',
  cancelada: 'Cancelada',
};

/** Estados en los que la tarea puede retomarse con "Continuar proyecto". */
export const ESTADOS_REANUDABLES: EstadoTarea[] = ['pausada', 'esperando_usuario'];
export const ESTADOS_ACTIVOS: EstadoTarea[] = ['en_cola', 'ejecutando'];
export const ESTADOS_FINALES: EstadoTarea[] = ['completada', 'fallida', 'cancelada'];

export const esquemaContinuar = z.object({
  /** Qué debe lograr la tarea. Si se omite, se reanuda la tarea pausada del proyecto. */
  objetivo: z.string().trim().min(3, 'Describe el objetivo').max(4000).optional(),
  /** Agente que ejecuta la tarea; por defecto, el primer desarrollador habilitado. */
  agenteId: z.string().uuid().optional(),
});
export type SolicitudContinuar = z.infer<typeof esquemaContinuar>;

export const esquemaResponder = z.object({
  respuesta: z.string().trim().min(1, 'Escribe una respuesta').max(4000),
});

export interface UsoTarea {
  tokensEntrada: number;
  tokensSalida: number;
  /** Costo estimado en USD; null si no se conoce la tarifa del modelo. */
  costoUsd: number | null;
}

export interface ResultadoValidacion {
  nombre: string;
  comando: string;
  /** "no_ejecutada" cuando no hay sandbox: nunca se reporta como exitosa sin ejecutarse. */
  estado: 'exitosa' | 'fallida' | 'no_ejecutada';
  codigoSalida: number | null;
  duracionMs: number | null;
  /** Últimas líneas de la salida. */
  salida: string;
}

export interface TareaPublica {
  id: string;
  proyectoId: string;
  proyectoNombre: string;
  agenteId: string;
  agenteNombre: string;
  objetivo: string;
  estado: EstadoTarea;
  rama: string;
  pregunta: string | null;
  resumen: string | null;
  error: string | null;
  archivosModificados: string[];
  validaciones: ResultadoValidacion[];
  uso: UsoTarea;
  creadaEn: string;
  iniciadaEn: string | null;
  terminadaEn: string | null;
}
