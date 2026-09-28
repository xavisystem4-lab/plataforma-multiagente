import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { esquemaAprobar, esquemaRechazar } from '@softgala/shared';
import { z } from 'zod';
import type { Actor } from '../servicios/contexto';
import type { ServicioRevision } from '../servicios/revision';

const conId = z.object({ id: z.string().uuid('Identificador no válido') });
const actorDe = (req: FastifyRequest): Actor => ({ id: req.usuario!.id, rol: req.usuario!.rol, ip: req.ip });

export function rutasRevision(app: FastifyInstance, revision: ServicioRevision, autenticar: preHandlerAsyncHookHandler): void {
  app.register(async (api) => {
    api.addHook('preHandler', autenticar);

    api.get('/api/aprobaciones', async (req) => {
      const { estado } = z.object({ estado: z.enum(['pendiente', 'aprobada', 'rechazada']).optional() }).parse(req.query);
      return revision.listar(actorDe(req), estado);
    });
    api.post(
      '/api/aprobaciones/:id/aprobar',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => revision.aprobar(actorDe(req), conId.parse(req.params).id, esquemaAprobar.parse(req.body ?? {})),
    );
    api.post('/api/aprobaciones/:id/rechazar', async (req) =>
      revision.rechazar(actorDe(req), conId.parse(req.params).id, esquemaRechazar.parse(req.body ?? {})),
    );
    api.get('/api/tareas/:id/diff', async (req) => revision.diff(actorDe(req), conId.parse(req.params).id));
    api.post(
      '/api/tareas/:id/revertir',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => revision.revertir(actorDe(req), conId.parse(req.params).id),
    );
  });
}
