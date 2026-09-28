import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { construirApp, type Dependencias } from '../src/app';
import { SandboxNoDisponible } from '../src/ejecucion/sandbox';
import { ServicioAuth } from '../src/auth/servicio';
import { cargarConfig, type Config } from '../src/config';
import { abrirDb, type Db } from '../src/db';

export const PASSWORD = 'contraseña-de-prueba-123';
export const EMAIL = 'admin@prueba.local';
export const EMAIL_2 = 'usuario@prueba.local';

/** Carpetas temporales creadas por las pruebas; test/limpieza.ts las borra al final. */
export const temporales = new Set<string>();

export function configPrueba(extra: Record<string, string> = {}): Config {
  const dirDatos = path.join(tmpdir(), `softgala-prueba-${randomBytes(6).toString('hex')}`);
  temporales.add(dirDatos);
  return cargarConfig({
    NODE_ENV: 'test',
    JWT_SECRET: randomBytes(48).toString('base64url'),
    MASTER_KEY: randomBytes(32).toString('base64'),
    CORS_ORIGINS: 'app://ui',
    // Cada contexto de prueba usa su propia carpeta de datos temporal.
    DATA_DIR: dirDatos,
    ...extra,
  });
}

export interface Contexto {
  app: FastifyInstance;
  db: Db;
  config: Config;
  reloj: { ahora: Date };
}

export interface OpcionesContexto {
  fetchExterno?: typeof fetch;
  env?: Record<string, string>;
  adaptadores?: Dependencias['adaptadores'];
  sandbox?: Dependencias['sandbox'];
  git?: Dependencias['git'];
}

/** App completa con base en memoria, reloj controlable, un admin y un usuario normal. */
export async function crearContexto(opciones: OpcionesContexto = {}): Promise<Contexto> {
  const config = configPrueba(opciones.env);
  const db = abrirDb(':memory:');
  const reloj = { ahora: new Date('2026-01-01T12:00:00Z') };
  const ahora = () => reloj.ahora;
  const auth = new ServicioAuth(db, config, ahora);
  await auth.crearUsuario({ email: EMAIL, nombre: 'Admin', rol: 'admin', password: PASSWORD });
  await auth.crearUsuario({ email: EMAIL_2, nombre: 'Usuario', rol: 'usuario', password: PASSWORD });
  const app = await construirApp({
    config,
    db,
    ahora,
    registrarLogs: false,
    adaptadores: opciones.adaptadores,
    // Sin Docker en pruebas salvo que la prueba lo simule.
    sandbox: opciones.sandbox ?? new SandboxNoDisponible('Sandbox no disponible (pruebas).'),
    git: opciones.git,
    // Por defecto, ninguna prueba puede salir a Internet.
    fetchExterno: opciones.fetchExterno ?? (async () => {
      throw new Error('Red deshabilitada en pruebas');
    }),
  });
  return { app, db, config, reloj };
}

export function login(app: FastifyInstance, password = PASSWORD, dispositivo = 'Pruebas', email = EMAIL) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, dispositivo } });
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// fetch simulado para GitHub y proveedores de modelos
// ---------------------------------------------------------------------------

export interface LlamadaRegistrada {
  metodo: string;
  url: string;
  cabeceras: Record<string, string>;
  cuerpo: unknown;
}

type Manejador = (url: URL, cuerpo: unknown) => Response | Promise<Response>;

/**
 * Devuelve un `fetch` que responde según `rutas` (clave: "GET https://host/ruta" sin query)
 * y registra cada llamada. Una ruta no definida responde 599 para que la prueba lo note.
 */
export function fetchSimulado(rutas: Record<string, Manejador>) {
  const llamadas: LlamadaRegistrada[] = [];
  const fn = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
    const metodo = (init?.method ?? (entrada instanceof Request ? entrada.method : 'GET')).toUpperCase();
    const cabeceras: Record<string, string> = {};
    new Headers(init?.headers ?? (entrada instanceof Request ? entrada.headers : undefined)).forEach((v, k) => {
      cabeceras[k] = v;
    });
    const texto = typeof init?.body === 'string' ? init.body : null;
    llamadas.push({ metodo, url: url.toString(), cabeceras, cuerpo: texto ? JSON.parse(texto) : null });
    const manejador = rutas[`${metodo} ${url.origin}${url.pathname}`];
    return manejador ? manejador(url, llamadas.at(-1)!.cuerpo) : new Response('ruta no simulada', { status: 599 });
  }) as typeof fetch;
  return { fetch: fn, llamadas };
}

export const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } });
