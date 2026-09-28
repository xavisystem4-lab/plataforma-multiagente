import path from 'node:path';
import { z } from 'zod';

const esquemaConfig = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATA_DIR: z.string().default('./data'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY debe ser 32 bytes en base64'),
  CORS_ORIGINS: z.string().default(''),
  // Solo "true" si el servidor está detrás de un proxy propio (Caddy); si no, la IP podría falsificarse.
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  // Cuántos agentes y proyectos puede registrar cada usuario (ajústalo a tus recursos).
  MAX_AGENTES_POR_USUARIO: z.coerce.number().int().min(1).max(1000).default(50),
  MAX_PROYECTOS_POR_USUARIO: z.coerce.number().int().min(1).max(1000).default(100),
  // API de GitHub. Para GitHub Enterprise Server: https://<host>/api/v3
  GITHUB_API_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u), 'GITHUB_API_URL debe usar HTTPS')
    .default('https://api.github.com'),
  // Ejecución de tareas
  MAX_TAREAS_SIMULTANEAS: z.coerce.number().int().min(1).max(64).default(4),
  MAX_TURNOS_POR_EJECUCION: z.coerce.number().int().min(1).max(500).default(60),
  // Sandbox Docker para las validaciones
  SANDBOX_IMAGEN: z.string().default('node:22-bookworm-slim'),
  SANDBOX_CPUS: z.string().regex(/^\d+(\.\d+)?$/).default('2'),
  SANDBOX_MEMORIA: z.string().regex(/^\d+[kmg]$/i).default('2g'),
  SANDBOX_USUARIO: z.string().regex(/^\d+(:\d+)?$/).default('1000:1000'),
  TIMEOUT_VALIDACION_MIN: z.coerce.number().int().min(1).max(120).default(10),
  // Respaldos automáticos de la base de datos (0 = desactivados)
  RESPALDO_CADA_HORAS: z.coerce.number().min(0).max(24 * 30).default(24),
  RESPALDOS_A_CONSERVAR: z.coerce.number().int().min(1).max(365).default(7),
  RESPALDO_DIR: z.string().optional(),
});

export interface Config {
  entorno: 'development' | 'production' | 'test';
  host: string;
  puerto: number;
  dirDatos: string;
  jwtSecret: Uint8Array;
  claveMaestra: Buffer;
  origenesCors: string[];
  confiarProxy: boolean;
  /** Duración del token de acceso en segundos. */
  duracionAccess: number;
  /** Duración del token de refresco en segundos. */
  duracionRefresh: number;
  /** Intentos fallidos antes de bloquear temporalmente la cuenta. */
  maxIntentosLogin: number;
  /** Minutos que dura el bloqueo. */
  minutosBloqueo: number;
  maxAgentesPorUsuario: number;
  maxProyectosPorUsuario: number;
  githubApi: string;
  /** URL de clonado para "propietario/repo" (GitHub o GitHub Enterprise). */
  urlClonado: (repositorio: string) => string;
  ejecucion: {
    maxSimultaneas: number;
    maxTurnos: number;
    maxTokensRespuesta: number;
    timeoutValidacionMs: number;
  };
  sandbox: { imagen: string; cpus: string; memoria: string; usuario: string };
  respaldos: { cadaHoras: number; conservar: number; carpeta: string };
}

export class ErrorConfig extends Error {}

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquemaConfig.safeParse(env);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ErrorConfig(
      `Configuración inválida. Ejecuta "npm run setup" para generar .env en desarrollo.\n${detalle}`,
    );
  }
  const e = r.data;
  return {
    entorno: e.NODE_ENV,
    host: e.HOST,
    puerto: e.PORT,
    dirDatos: path.resolve(e.DATA_DIR),
    jwtSecret: new TextEncoder().encode(e.JWT_SECRET),
    claveMaestra: Buffer.from(e.MASTER_KEY, 'base64'),
    origenesCors: e.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    confiarProxy: e.TRUST_PROXY === 'true',
    duracionAccess: 15 * 60,
    duracionRefresh: 30 * 24 * 60 * 60,
    maxIntentosLogin: 5,
    minutosBloqueo: 15,
    maxAgentesPorUsuario: e.MAX_AGENTES_POR_USUARIO,
    maxProyectosPorUsuario: e.MAX_PROYECTOS_POR_USUARIO,
    githubApi: e.GITHUB_API_URL.replace(/\/+$/, ''),
    urlClonado: (repo) => `${origenGit(e.GITHUB_API_URL)}/${repo}.git`,
    ejecucion: {
      maxSimultaneas: e.MAX_TAREAS_SIMULTANEAS,
      maxTurnos: e.MAX_TURNOS_POR_EJECUCION,
      maxTokensRespuesta: 16_000,
      timeoutValidacionMs: e.TIMEOUT_VALIDACION_MIN * 60_000,
    },
    sandbox: { imagen: e.SANDBOX_IMAGEN, cpus: e.SANDBOX_CPUS, memoria: e.SANDBOX_MEMORIA, usuario: e.SANDBOX_USUARIO },
    respaldos: {
      cadaHoras: e.RESPALDO_CADA_HORAS,
      conservar: e.RESPALDOS_A_CONSERVAR,
      carpeta: path.resolve(e.RESPALDO_DIR ?? path.join(e.DATA_DIR, 'respaldos')),
    },
  };
}

/** api.github.com → https://github.com; GitHub Enterprise https://host/api/v3 → https://host. */
function origenGit(apiUrl: string): string {
  const u = new URL(apiUrl);
  return u.hostname === 'api.github.com' ? 'https://github.com' : u.origin;
}
