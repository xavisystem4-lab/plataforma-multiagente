import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../src/app';
import { ServicioAuth } from '../src/auth/servicio';
import { cargarConfig, type Config } from '../src/config';
import { abrirDb, type Db } from '../src/db';

export const PASSWORD = 'contraseña-de-prueba-123';
export const EMAIL = 'admin@prueba.local';

export function configPrueba(): Config {
  return cargarConfig({
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(48).toString('base64url'),
    MASTER_KEY: randomBytes(32).toString('base64'),
    CORS_ORIGINS: 'app://ui',
  });
}

export interface Contexto {
  app: FastifyInstance;
  db: Db;
  config: Config;
  reloj: { ahora: Date };
}

/** App completa con base en memoria, reloj controlable y un usuario admin creado. */
export async function crearContexto(): Promise<Contexto> {
  const config = configPrueba();
  const db = abrirDb(':memory:');
  const reloj = { ahora: new Date('2026-01-01T12:00:00Z') };
  const ahora = () => reloj.ahora;
  await new ServicioAuth(db, config, ahora).crearUsuario({ email: EMAIL, nombre: 'Admin', rol: 'admin', password: PASSWORD });
  const app = await construirApp({ config, db, ahora, registrarLogs: false });
  return { app, db, config, reloj };
}

export function login(app: FastifyInstance, password = PASSWORD, dispositivo = 'Pruebas') {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password, dispositivo } });
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
