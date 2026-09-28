import { z } from 'zod';
import type { AvanceTarea } from './recursos';
import type { PublicacionTarea } from './revision';

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

export const MODOS_TAREA = ['individual', 'colaborativo'] as const;
export type ModoTarea = (typeof MODOS_TAREA)[number];

export const MAX_PARTICIPANTES = 6;
export const MAX_RONDAS_REVISION = 3;
export const MAX_SUBTAREAS = 8;

export const esquemaContinuar = z
  .object({
    /** Qué debe lograr la tarea. Si se omite, se reanuda la tarea pausada del proyecto. */
    objetivo: z.string().trim().min(3, 'Describe el objetivo').max(4000).optional(),
    modo: z.enum(MODOS_TAREA).default('individual'),
    /** Modo individual: agente que ejecuta la tarea; por defecto, el primer desarrollador habilitado. */
    agenteId: z.string().uuid().optional(),
    /** Modo colaborativo: coordinador que sintetiza y reparte el trabajo. */
    coordinadorId: z.string().uuid().optional(),
    /** Modo colaborativo: agentes que proponen, revisan y ejecutan subtareas. */
    participantes: z.array(z.string().uuid()).max(MAX_PARTICIPANTES).optional(),
    /** Rondas de revisión cruzada (0 = sin revisión). */
    maxRondas: z.number().int().min(0).max(MAX_RONDAS_REVISION).default(1),
  })
  .superRefine((s, ctx) => {
    if (s.modo !== 'colaborativo' || !s.objetivo) return;
    if (!s.coordinadorId) ctx.addIssue({ code: 'custom', path: ['coordinadorId'], message: 'Elige un coordinador' });
    if (!s.participantes?.length) ctx.addIssue({ code: 'custom', path: ['participantes'], message: 'Elige al menos un agente participante' });
    if (s.coordinadorId && s.participantes?.includes(s.coordinadorId)) {
      ctx.addIssue({ code: 'custom', path: ['participantes'], message: 'El coordinador no puede ser también participante' });
    }
    if (s.participantes && new Set(s.participantes).size !== s.participantes.length) {
      ctx.addIssue({ code: 'custom', path: ['participantes'], message: 'Participantes repetidos' });
    }
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

export const FASES_COLABORACION = ['propuestas', 'revision', 'sintesis', 'ejecucion', 'integracion'] as const;
export type FaseColaboracion = (typeof FASES_COLABORACION)[number];

export const NOMBRE_FASE: Record<FaseColaboracion, string> = {
  propuestas: 'Propuestas',
  revision: 'Revisión cruzada',
  sintesis: 'Síntesis del coordinador',
  ejecucion: 'Ejecución de subtareas',
  integracion: 'Integración y validación',
};

export type EstadoSubtarea = 'pendiente' | 'ejecutando' | 'esperando_usuario' | 'completada' | 'fallida' | 'conflicto';

export interface SubtareaPublica {
  id: string;
  indice: number;
  titulo: string;
  descripcion: string;
  agenteId: string;
  agenteNombre: string;
  /** Archivos o carpetas (terminadas en "/") que la subtarea puede modificar. */
  archivos: string[];
  /** Índices de subtareas que deben terminar antes (porque comparten archivos). */
  dependeDe: number[];
  estado: EstadoSubtarea;
  rama: string;
  resumen: string | null;
  error: string | null;
}

export interface ColaboracionPublica {
  coordinadorId: string;
  participantes: { id: string; nombre: string }[];
  maxRondas: number;
  fase: FaseColaboracion | null;
  /** Decisión del coordinador (tras la síntesis). */
  decision: string | null;
  subtareas: SubtareaPublica[];
}

export type TipoDecision = 'propuesta' | 'revision' | 'decision' | 'integracion';

/** Registro inmutable de lo que propuso, revisó o decidió cada agente. */
export interface DecisionPublica {
  id: number;
  tipo: TipoDecision;
  agenteId: string | null;
  agenteNombre: string | null;
  ronda: number;
  contenido: string;
  datos: Record<string, unknown> | null;
  fecha: string;
}

export interface TareaPublica {
  id: string;
  proyectoId: string;
  proyectoNombre: string;
  /** En modo colaborativo, el coordinador. */
  agenteId: string;
  agenteNombre: string;
  modo: ModoTarea;
  colaboracion: ColaboracionPublica | null;
  objetivo: string;
  estado: EstadoTarea;
  rama: string;
  pregunta: string | null;
  resumen: string | null;
  error: string | null;
  archivosModificados: string[];
  validaciones: ResultadoValidacion[];
  /** Estado de revisión y publicación (null mientras la tarea no ha terminado con cambios). */
  publicacion: PublicacionTarea | null;
  avance: AvanceTarea;
  uso: UsoTarea;
  creadaEn: string;
  iniciadaEn: string | null;
  terminadaEn: string | null;
}
