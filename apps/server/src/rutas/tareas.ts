import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { esquemaContinuar, esquemaResponder, type MensajeClienteWs, type MensajeServidorWs } from '@softgala/shared';
import { z } from 'zod';
import type { ServicioAuth } from '../auth/servicio';
import type { Config } from '../config';
import type { BusEventos } from '../ejecucion/bus';
import type { Orquestador } from '../ejecucion/orquestador';
import { verificarAccessToken } from '../security/tokens';
import type { Actor } from '../servicios/contexto';

const conId = z.object({ id: z.string().uuid('Identificador no válido') });
const actorDe = (req: FastifyRequest): Actor => ({ id: req.usuario!.id, rol: req.usuario!.rol, ip: req.ip });

export function rutasTareas(app: FastifyInstance, orquestador: Orquestador, autenticar: preHandlerAsyncHookHandler): void {
  app.register(async (api) => {
    api.addHook('preHandler', autenticar);

    api.get('/api/sistema', async () => ({ sandbox: orquestador.infoSandbox }));

    api.post(
      '/api/proyectos/:id/continuar',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req, rep) =>
        rep.code(202).send(orquestador.continuar(actorDe(req), conId.parse(req.params).id, esquemaContinuar.parse(req.body ?? {}))),
    );

    api.get('/api/tareas', async (req) => {
      const { proyectoId } = z.object({ proyectoId: z.string().uuid().optional() }).parse(req.query);
      return orquestador.listar(actorDe(req), proyectoId);
    });
    api.get('/api/tareas/:id', async (req) => orquestador.obtener(actorDe(req), conId.parse(req.params).id));
    api.get('/api/tareas/:id/decisiones', async (req) => orquestador.decisiones(actorDe(req), conId.parse(req.params).id));
    api.get('/api/tareas/:id/eventos', async (req) => {
      const { desde } = z.object({ desde: z.coerce.number().int().min(0).default(0) }).parse(req.query);
      return orquestador.eventos(actorDe(req), conId.parse(req.params).id, desde);
    });
    api.post('/api/tareas/:id/pausar', async (req) => orquestador.pausar(actorDe(req), conId.parse(req.params).id));
    api.post('/api/tareas/:id/reanudar', async (req) => orquestador.reanudar(actorDe(req), conId.parse(req.params).id));
    api.post('/api/tareas/:id/cancelar', async (req) => orquestador.cancelar(actorDe(req), conId.parse(req.params).id));
    api.post('/api/tareas/:id/responder', async (req) =>
      orquestador.responder(actorDe(req), conId.parse(req.params).id, esquemaResponder.parse(req.body).respuesta),
    );
  });
}

const esquemaMensajeWs = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('autenticar'), token: z.string().min(10).max(4000), desde: z.number().int().min(0).optional() }),
  z.object({ tipo: z.literal('ping') }),
]);

/**
 * WebSocket de eventos en tiempo real.
 * 1. El cliente se conecta y envía {tipo:"autenticar", token, desde?} (el token no va en la URL).
 * 2. El servidor reenvía los eventos posteriores a `desde` y luego los nuevos, solo del usuario.
 * 3. La sesión se revalida cada 30 s: si se revoca, se cierra la conexión.
 */
export function rutaTiempoReal(app: FastifyInstance, bus: BusEventos, auth: ServicioAuth, config: Config): void {
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const enviar = (m: MensajeServidorWs) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    let desuscribir: (() => void) | null = null;
    let revalidar: NodeJS.Timeout | undefined;
    const cerrar = (codigo: number, motivo: string) => {
      desuscribir?.();
      clearInterval(revalidar);
      socket.close(codigo, motivo);
    };
    const esperaAuth = setTimeout(() => cerrar(4401, 'Sin autenticación'), 10_000);

    socket.on('message', async (bruto) => {
      let mensaje: MensajeClienteWs;
      try {
        mensaje = esquemaMensajeWs.parse(JSON.parse(bruto.toString()));
      } catch {
        enviar({ tipo: 'error', mensaje: 'Mensaje no válido' });
        return;
      }
      if (mensaje.tipo === 'ping') {
        enviar({ tipo: 'pong' });
        return;
      }
      if (desuscribir) return; // ya autenticado
      try {
        const claims = await verificarAccessToken(mensaje.token, config.jwtSecret);
        if (!auth.validarSesion(claims.sid, claims.sub)) throw new Error('sesión revocada');
        clearTimeout(esperaAuth);
        // Primero se suscribe y luego se envía el historial, filtrando duplicados por seq.
        let ultimo = mensaje.desde ?? bus.ultimoSeq(claims.sub);
        const cola: MensajeServidorWs[] = [];
        let listo = false;
        desuscribir = bus.suscribir(claims.sub, (evento) => {
          if (!listo) cola.push({ tipo: 'evento', evento });
          else if (evento.seq > ultimo) {
            ultimo = evento.seq;
            enviar({ tipo: 'evento', evento });
          }
        });
        if (mensaje.desde !== undefined) {
          for (const evento of bus.pendientes(claims.sub, mensaje.desde)) {
            ultimo = Math.max(ultimo, evento.seq);
            enviar({ tipo: 'evento', evento });
          }
        }
        for (const m of cola) if (m.tipo === 'evento' && m.evento.seq > ultimo) enviar(m);
        listo = true;
        enviar({ tipo: 'listo', ultimoSeq: ultimo });
        revalidar = setInterval(() => {
          if (!auth.validarSesion(claims.sid, claims.sub)) cerrar(4401, 'Sesión revocada');
        }, 30_000);
      } catch {
        req.log.info('WebSocket rechazado: token inválido');
        cerrar(4401, 'No autorizado');
      }
    });
    socket.on('close', () => {
      clearTimeout(esperaAuth);
      clearInterval(revalidar);
      desuscribir?.();
    });
  });
}
