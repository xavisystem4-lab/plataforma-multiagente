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
  };
}
