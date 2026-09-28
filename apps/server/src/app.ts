import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ErrorApi } from '@softgala/shared';
import { ZodError } from 'zod';
import { crearAutenticador, rutasAuth } from './auth/rutas';
import { ServicioAuth } from './auth/servicio';
import type { Config } from './config';
import type { Db } from './db';
import { ErrorApp } from './errores';
import { BusEventos } from './ejecucion/bus';
import { ErrorGit, EspaciosGit, type OpcionesGit } from './ejecucion/git';
import { Orquestador } from './ejecucion/orquestador';
import { detectarSandbox, type Sandbox } from './ejecucion/sandbox';
import { ClienteGitHub } from './externo/github';
import { crearFabricaAdaptadores, type FabricaAdaptadores } from './modelos/adaptadores';
import { rutasRevision } from './rutas/revision';
import { rutasTareas, rutaTiempoReal } from './rutas/tareas';
import { ServicioRevision } from './servicios/revision';
import { rutasRecursos, type Servicios } from './rutas/recursos';
import { Boveda } from './security/boveda';
import { ServicioAgentes } from './servicios/agentes';
import { ServicioConsultas } from './servicios/consultas';
import type { Contexto } from './servicios/contexto';
import { ServicioProveedores } from './servicios/proveedores';
import { ServicioProyectos } from './servicios/proyectos';

export interface Dependencias {
  config: Config;
  db: Db;
  /** Reloj inyectable para pruebas. */
  ahora?: () => Date;
  /** fetch para llamadas salientes (GitHub, proveedores); inyectable para pruebas. */
  fetchExterno?: typeof fetch;
  registrarLogs?: boolean;
  /** Sustitutos para pruebas: modelos simulados, sandbox y opciones de Git. */
  adaptadores?: FabricaAdaptadores;
  sandbox?: Sandbox;
  git?: Partial<Omit<OpcionesGit, 'raiz'>>;
}

declare module 'fastify' {
  interface FastifyInstance {
    orquestador: Orquestador;
  }
}

const cuerpoError = (codigo: string, mensaje: string): ErrorApi => ({ error: { codigo, mensaje } });

export async function construirApp(dep: Dependencias): Promise<FastifyInstance> {
  const { config, db, ahora, fetchExterno = fetch, registrarLogs = true } = dep;
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

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

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
    if (err instanceof ErrorGit) {
      // El mensaje ya viene sin credenciales (ver limpiar() en ejecucion/git.ts).
      return rep.code(502).send(cuerpoError('GIT_ERROR', err.message));
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

  const reloj = ahora ?? (() => new Date());
  const auth = new ServicioAuth(db, config, reloj);
  const autenticar = crearAutenticador(config, auth);

  const ctx: Contexto = {
    db,
    config,
    boveda: new Boveda(config.claveMaestra),
    github: new ClienteGitHub(fetchExterno, config.githubApi),
    adaptadores: dep.adaptadores ?? crearFabricaAdaptadores(fetchExterno),
    ahora: reloj,
    log: app.log,
  };
  const proveedores = new ServicioProveedores(ctx);
  const agentes = new ServicioAgentes(ctx, proveedores);
  const servicios: Servicios = {
    proveedores,
    agentes,
    proyectos: new ServicioProyectos(ctx, agentes),
    consultas: new ServicioConsultas(ctx),
  };

  const bus = new BusEventos(db, reloj);
  const git = new EspaciosGit({
    raiz: path.join(config.dirDatos, 'espacios'),
    protocolos: dep.git?.protocolos ?? 'https',
    urlClonado: dep.git?.urlClonado ?? config.urlClonado,
  });
  const sandbox = dep.sandbox ?? (await detectarSandbox(config.sandbox));
  const orquestador = new Orquestador(ctx, servicios, bus, git, sandbox, config.ejecucion);
  const revision = new ServicioRevision(ctx, git, servicios.proyectos, bus);
  orquestador.alCompletarConCambios = (tareaId) => revision.crearSolicitud(tareaId);
  app.decorate('orquestador', orquestador);
  app.addHook('onClose', async () => orquestador.detener());

  app.get('/api/salud', async () => ({ estado: 'ok', version: '0.4.0' }));
  rutasAuth(app, auth, autenticar);
  rutasRecursos(app, servicios, autenticar, (proyectoId) => orquestador.limpiarProyecto(proyectoId));
  rutasTareas(app, orquestador, autenticar);
  rutasRevision(app, revision, autenticar);
  rutaTiempoReal(app, bus, auth, config);

  return app;
}
