import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { esquemaAjustesVoz, MAX_BYTES_AUDIO, MODELOS_TRANSCRIPCION } from '@softgala/shared';
import type { Actor } from '../servicios/contexto';
import type { ServicioVoz } from '../servicios/voz';

const actorDe = (req: FastifyRequest): Actor => ({ id: req.usuario!.id, rol: req.usuario!.rol, ip: req.ip });

export function rutasVoz(app: FastifyInstance, voz: ServicioVoz, autenticar: preHandlerAsyncHookHandler): void {
  app.register(async (api) => {
    api.addHook('preHandler', autenticar);

    // El audio llega como cuerpo binario (audio/webm, audio/ogg…), solo en este módulo.
    api.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_BYTES_AUDIO }, (_req, cuerpo, listo) =>
      listo(null, cuerpo),
    );

    api.get('/api/voz/ajustes', async (req) => ({ ...voz.obtener(actorDe(req)), modelosSugeridos: MODELOS_TRANSCRIPCION }));
    api.put('/api/voz/ajustes', async (req) => voz.guardar(actorDe(req), esquemaAjustesVoz.parse(req.body)));
    api.post(
      '/api/voz/transcribir',
      { bodyLimit: MAX_BYTES_AUDIO, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req) => {
        const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        return voz.transcribir(actorDe(req), audio, req.headers['content-type'] ?? '');
      },
    );
  });
}
