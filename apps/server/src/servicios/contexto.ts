import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db';
import { ErrorApp } from '../errores';
import type { ClienteGitHub } from '../externo/github';
import type { FabricaAdaptadores } from '../modelos/adaptadores';
import type { Boveda } from '../security/boveda';

/** Dependencias compartidas por los servicios de recursos. */
export interface Contexto {
  db: Db;
  config: Config;
  boveda: Boveda;
  github: ClienteGitHub;
  adaptadores: FabricaAdaptadores;
  ahora: () => Date;
  log: FastifyBaseLogger;
}

/** Quién hace la petición y desde dónde (para permisos y auditoría). */
export interface Actor {
  id: string;
  rol: 'admin' | 'usuario';
  ip: string | null;
}

export const ahoraIso = (ctx: Contexto) => ctx.ahora().toISOString();

export function leerJson<T>(texto: string | null, porDefecto: T): T {
  if (!texto) return porDefecto;
  try {
    return JSON.parse(texto) as T;
  } catch {
    return porDefecto;
  }
}

export const ultimos4 = (secreto: string) => secreto.slice(-4);

/** Convierte la violación de UNIQUE de SQLite en un 409 con mensaje claro. */
export function conUnico<T>(fn: () => T, mensaje: string): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      throw new ErrorApp(409, 'DUPLICADO', mensaje);
    }
    throw err;
  }
}
