import { z } from 'zod';

// ---------------------------------------------------------------------------
// Proveedores de modelos
// ---------------------------------------------------------------------------

export const TIPOS_PROVEEDOR = ['anthropic', 'openai', 'openai_compatible'] as const;
export type TipoProveedor = (typeof TIPOS_PROVEEDOR)[number];

export const INFO_PROVEEDOR: Record<TipoProveedor, { nombre: string; requiereClave: boolean; requiereUrl: boolean }> = {
  anthropic: { nombre: 'Anthropic (Claude)', requiereClave: true, requiereUrl: false },
  openai: { nombre: 'OpenAI', requiereClave: true, requiereUrl: false },
  openai_compatible: { nombre: 'Compatible con OpenAI (Ollama, OpenRouter, etc.)', requiereClave: false, requiereUrl: true },
};

/** Sugerencias iniciales; la lista real se obtiene con "Probar conexión". */
export const MODELOS_SUGERIDOS: Partial<Record<TipoProveedor, string[]>> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
};

const nombre = z.string().trim().min(1, 'Escribe un nombre').max(60, 'Máximo 60 caracteres');
const apiKey = z.string().trim().min(8, 'La clave parece demasiado corta').max(500);
const urlBase = z.string().trim().url('Escribe una URL válida').max(300);

export const esquemaProveedorNuevo = z
  .object({ nombre, tipo: z.enum(TIPOS_PROVEEDOR), urlBase: urlBase.optional(), apiKey: apiKey.optional() })
  .superRefine((p, ctx) => {
    const info = INFO_PROVEEDOR[p.tipo];
    if (info.requiereClave && !p.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'Este proveedor requiere una clave API' });
    if (info.requiereUrl && !p.urlBase) ctx.addIssue({ code: 'custom', path: ['urlBase'], message: 'Este proveedor requiere la URL base' });
  });
export type ProveedorNuevo = z.infer<typeof esquemaProveedorNuevo>;

/** En la edición, omitir `apiKey` conserva la actual; `null` la elimina (solo compatibles). */
export const esquemaProveedorEdicion = z.object({
  nombre: nombre.optional(),
  urlBase: urlBase.optional(),
  apiKey: apiKey.nullable().optional(),
});
export type ProveedorEdicion = z.infer<typeof esquemaProveedorEdicion>;

export interface ProveedorPublico {
  id: string;
  nombre: string;
  tipo: TipoProveedor;
  urlBase: string | null;
  /** Solo los últimos 4 caracteres; la clave nunca sale del servidor. */
  claveMascara: string | null;
  ultimaPrueba: { ok: boolean; fecha: string; mensaje: string } | null;
  modelosDisponibles: string[];
  agentes: number;
  creadoEn: string;
}

export interface ResultadoPrueba {
  ok: boolean;
  mensaje: string;
  modelos: string[];
}

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

export const ROLES_AGENTE = ['coordinador', 'desarrollador', 'revisor', 'tester', 'documentador', 'personalizado'] as const;
export type RolAgente = (typeof ROLES_AGENTE)[number];

export const NOMBRE_ROL: Record<RolAgente, string> = {
  coordinador: 'Coordinador',
  desarrollador: 'Desarrollador',
  revisor: 'Revisor',
  tester: 'Tester',
  documentador: 'Documentador',
  personalizado: 'Personalizado',
};

/**
 * Herramientas que un agente puede tener. Push, despliegues, red y secretos NO son
 * herramientas: siempre pasan por una aprobación explícita del usuario.
 */
export const HERRAMIENTAS = [
  { id: 'leer_archivos', nombre: 'Leer archivos', descripcion: 'Leer archivos del proyecto', riesgo: 'bajo' },
  { id: 'buscar_codigo', nombre: 'Buscar en el código', descripcion: 'Buscar texto y archivos en el proyecto', riesgo: 'bajo' },
  { id: 'escribir_archivos', nombre: 'Escribir archivos', descripcion: 'Crear y modificar archivos en su rama de trabajo', riesgo: 'medio' },
  { id: 'ejecutar_validaciones', nombre: 'Ejecutar validaciones', descripcion: 'Correr las validaciones configuradas del proyecto (tests, lint, build)', riesgo: 'medio' },
  { id: 'git_commit', nombre: 'Hacer commits', descripcion: 'Commits en su rama de trabajo; nunca push', riesgo: 'medio' },
] as const;
export type IdHerramienta = (typeof HERRAMIENTAS)[number]['id'];
const IDS_HERRAMIENTAS = HERRAMIENTAS.map((h) => h.id) as [IdHerramienta, ...IdHerramienta[]];

export const esquemaLimitesAgente = z.object({
  maxTokensPorTarea: z.number().int().min(1_000).max(10_000_000),
  maxCostoUsdPorTarea: z.number().min(0.01).max(1_000),
  maxMinutosPorTarea: z.number().int().min(1).max(1_440),
});
export type LimitesAgente = z.infer<typeof esquemaLimitesAgente>;

export const LIMITES_AGENTE_PREDETERMINADOS: LimitesAgente = {
  maxTokensPorTarea: 200_000,
  maxCostoUsdPorTarea: 5,
  maxMinutosPorTarea: 60,
};

export const esquemaAgente = z.object({
  nombre,
  rol: z.enum(ROLES_AGENTE),
  instrucciones: z.string().trim().max(20_000, 'Máximo 20 000 caracteres').default(''),
  proveedorId: z.string().uuid('Elige un proveedor'),
  modelo: z.string().trim().min(1, 'Escribe el modelo').max(120),
  herramientas: z
    .array(z.enum(IDS_HERRAMIENTAS))
    .max(IDS_HERRAMIENTAS.length)
    .refine((h) => new Set(h).size === h.length, 'Herramientas repetidas'),
  limites: esquemaLimitesAgente,
  activo: z.boolean().default(true),
});
export type AgenteEntrada = z.input<typeof esquemaAgente>;
export const esquemaAgenteEdicion = esquemaAgente.partial();

export interface AgentePublico {
  id: string;
  nombre: string;
  rol: RolAgente;
  instrucciones: string;
  proveedorId: string;
  proveedorNombre: string;
  modelo: string;
  herramientas: IdHerramienta[];
  limites: LimitesAgente;
  activo: boolean;
  proyectos: number;
  creadoEn: string;
}

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------

export const esquemaValidacion = z.object({
  nombre: z.string().trim().min(1).max(60),
  comando: z.string().trim().min(1, 'Escribe el comando').max(300),
  /** El sandbox no tiene red salvo que la validación lo pida (p. ej. instalar dependencias). */
  requiereRed: z.boolean().default(false),
});
export type Validacion = z.output<typeof esquemaValidacion>;

export const esquemaLimitesProyecto = z.object({
  maxAgentesSimultaneos: z.number().int().min(1).max(20),
  presupuestoMensualUsd: z.number().min(0).max(100_000),
});
export type LimitesProyecto = z.infer<typeof esquemaLimitesProyecto>;

export const LIMITES_PROYECTO_PREDETERMINADOS: LimitesProyecto = { maxAgentesSimultaneos: 3, presupuestoMensualUsd: 50 };

/** "propietario/repositorio" con los caracteres que GitHub permite. */
export const esquemaRepositorio = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'Usa el formato propietario/repositorio');

const tokenGitHub = z.string().trim().min(20, 'El token parece incompleto').max(300);

export const esquemaProyectoNuevo = z.object({
  nombre,
  repositorio: esquemaRepositorio,
  /** Si se omite, se usa la rama principal del repositorio. */
  ramaBase: z.string().trim().min(1).max(250).optional(),
  token: tokenGitHub,
  validaciones: z.array(esquemaValidacion).max(20).default([]),
  limites: esquemaLimitesProyecto.default(LIMITES_PROYECTO_PREDETERMINADOS),
});
export type ProyectoNuevo = z.input<typeof esquemaProyectoNuevo>;

/** Colores para pintar la ventana y la tarjeta de cada proyecto. */
export const COLORES_PROYECTO = {
  marino: { nombre: 'Azul marino', hex: '#13294B' },
  azul: { nombre: 'Azul', hex: '#1F5FBF' },
  turquesa: { nombre: 'Turquesa', hex: '#0E7C86' },
  verde: { nombre: 'Verde', hex: '#1F7A4D' },
  ambar: { nombre: 'Ámbar', hex: '#B7791F' },
  naranja: { nombre: 'Naranja', hex: '#C2410C' },
  rojo: { nombre: 'Rojo', hex: '#B42318' },
  violeta: { nombre: 'Violeta', hex: '#6D3FC0' },
  rosa: { nombre: 'Rosa', hex: '#BE185D' },
  grafito: { nombre: 'Grafito', hex: '#3D4A5C' },
} as const;
export type ColorProyecto = keyof typeof COLORES_PROYECTO;
const IDS_COLORES = Object.keys(COLORES_PROYECTO) as [ColorProyecto, ...ColorProyecto[]];

export const esquemaProyectoEdicion = z.object({
  fijado: z.boolean().optional(),
  color: z.enum(IDS_COLORES).optional(),
  /** Nombre que muestra la ventana del proyecto; null vuelve al nombre del proyecto. */
  nombreVentana: z.string().trim().min(1).max(60).nullable().optional(),
  nombre: nombre.optional(),
  ramaBase: z.string().trim().min(1).max(250).optional(),
  token: tokenGitHub.optional(),
  validaciones: z.array(esquemaValidacion).max(20).optional(),
  limites: esquemaLimitesProyecto.optional(),
});
export type ProyectoEdicion = z.infer<typeof esquemaProyectoEdicion>;

export interface ProyectoPublico {
  id: string;
  nombre: string;
  repositorio: string;
  ramaBase: string;
  privado: boolean;
  urlRepo: string;
  tokenMascara: string;
  validaciones: Validacion[];
  limites: LimitesProyecto;
  /** Agentes habilitados en este proyecto. */
  agentes: { agenteId: string; nombre: string; rol: RolAgente; activo: boolean }[];
  /** Advertencias al conectar (p. ej. token con más permisos de los necesarios). */
  avisos: string[];
  fijado: boolean;
  color: ColorProyecto;
  nombreVentana: string | null;
  /** Avance de la tarea más reciente del proyecto (null si aún no tiene tareas). */
  avance: AvanceProyecto | null;
  creadoEn: string;
}

/** Avance de una tarea. En modo individual es una estimación por pasos (`estimado: true`). */
export interface AvanceTarea {
  porcentaje: number;
  etapa: string;
  estimado: boolean;
}

export interface AvanceProyecto extends AvanceTarea {
  tareaId: string;
  objetivo: string;
  estado: string;
  tareasTotales: number;
  tareasCompletadas: number;
}

export interface EstadoRepositorio {
  rama: string;
  ultimoCommit: { sha: string; mensaje: string; autor: string; fecha: string; url: string } | null;
  /** Ramas creadas por los agentes (prefijo "agentes/"). */
  ramasAgentes: string[];
  consultadoEn: string;
}

// ---------------------------------------------------------------------------
// Auditoría y resumen
// ---------------------------------------------------------------------------

export interface EntradaAuditoriaPublica {
  id: number;
  fecha: string;
  accion: string;
  usuarioEmail: string | null;
  proyectoId: string | null;
  agenteId: string | null;
  detalle: Record<string, unknown> | null;
  ip: string | null;
}

export interface PaginaAuditoria {
  entradas: EntradaAuditoriaPublica[];
  /** Pasa este valor como `antesDe` para cargar la siguiente página; null si no hay más. */
  siguiente: number | null;
}

export interface Resumen {
  proyectos: number;
  agentes: number;
  agentesActivos: number;
  proveedores: number;
  aprobacionesPendientes: number;
  tareasActivas: number;
  /** Tareas que esperan una respuesta del usuario. */
  tareasEsperando: number;
}
