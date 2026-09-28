import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ErrorApi } from '@softgala/shared';
import { ZodError } from 'zod';
import { rutasAuth } from './auth/rutas';
import { ServicioAuth } from './auth/servicio';
import type { Config } from './config';
import type { Db } from './db';
import { ErrorApp } from './errores';

export interface Dependencias {
  config: Config;
  db: Db;
  /** Reloj inyectable para pruebas. */
  ahora?: () => Date;
  registrarLogs?: boolean;
}

const cuerpoError = (codigo: string, mensaje: string): ErrorApi => ({ error: { codigo, mensaje } });

export async function construirApp({ config, db, ahora, registrarLogs = true }: Dependencias): Promise<FastifyInstance> {
  const app = Fastify({
    logger: registrarLogs
      ? {
          level: config.entorno === 'production' ? 'info' : 'debug',
          // Nunca registrar credenciales ni tokens.
          redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: config.confiarProxy,
  });

  await app.register(cors, {
    // Sin cabecera Origin (clientes nativos, curl) se permite; con Origin, solo la lista blanca.
    origin: (origen, cb) => cb(null, !origen || config.origenesCors.includes(origen)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      codigo: 'DEMASIADAS_SOLICITUDES',
      message: `Demasiadas solicitudes. Espera ${Math.ceil(ctx.ttl / 1000)} segundos.`,
    }),
  });

  app.addHook('onSend', async (_req, rep) => {
    rep.header('X-Content-Type-Options', 'nosniff');
    rep.header('X-Frame-Options', 'DENY');
    rep.header('Referrer-Policy', 'no-referrer');
    rep.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: FastifyError & { codigo?: string }, req, rep) => {
    if (err instanceof ErrorApp) {
      return rep.code(err.estado).send(cuerpoError(err.codigo, err.message));
    }
    if (err instanceof ZodError) {
      const primero = err.issues[0];
      return rep.code(400).send(cuerpoError('VALIDACION', primero?.message ?? 'Datos no válidos'));
    }
    if (err.statusCode === 429) {
      return rep.code(429).send(cuerpoError('DEMASIADAS_SOLICITUDES', err.message));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return rep.code(err.statusCode).send(cuerpoError('SOLICITUD_INVALIDA', 'Solicitud no válida'));
    }
    req.log.error(err);
    return rep.code(500).send(cuerpoError('ERROR_INTERNO', 'Ocurrió un error interno. Revisa los registros del servidor.'));
  });

  app.setNotFoundHandler((_req, rep) => rep.code(404).send(cuerpoError('NO_ENCONTRADO', 'Ruta no encontrada')));

  const auth = new ServicioAuth(db, config, ahora);
  app.get('/api/salud', async () => ({ estado: 'ok', version: '0.1.0' }));
  rutasAuth(app, auth, config);

  return app;
}
