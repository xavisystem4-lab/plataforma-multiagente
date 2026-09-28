import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { esquemaLogin, esquemaRefresh } from '@softgala/shared';
import { z } from 'zod';
import type { Config } from '../config';
import { noAutorizado } from '../errores';
import { verificarAccessToken } from '../security/tokens';
import type { ServicioAuth, UsuarioAutenticado } from './servicio';

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: UsuarioAutenticado;
  }
}

/** preHandler que exige un token de acceso válido y una sesión no revocada. */
export function crearAutenticador(config: Config, auth: ServicioAuth) {
  return async function autenticar(req: FastifyRequest, _rep: FastifyReply): Promise<void> {
    const cabecera = req.headers.authorization;
    if (!cabecera?.startsWith('Bearer ')) throw noAutorizado();
    let claims;
    try {
      claims = await verificarAccessToken(cabecera.slice(7), config.jwtSecret);
    } catch {
      throw noAutorizado();
    }
    if (!auth.validarSesion(claims.sid, claims.sub)) throw noAutorizado();
    req.usuario = { id: claims.sub, rol: claims.rol, sid: claims.sid };
  };
}

export function rutasAuth(
  app: FastifyInstance,
  auth: ServicioAuth,
  autenticar: ReturnType<typeof crearAutenticador>,
): void {
  const usuario = (req: FastifyRequest) => req.usuario!;

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => auth.login(esquemaLogin.parse(req.body), req.ip),
  );

  app.post(
    '/api/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => auth.refrescar(esquemaRefresh.parse(req.body).refreshToken, req.ip),
  );

  app.post('/api/auth/logout', { preHandler: autenticar }, async (req, rep) => {
    auth.cerrarSesion(usuario(req), req.ip);
    return rep.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: autenticar }, async (req) => auth.obtenerUsuario(usuario(req).id));

  app.get('/api/auth/sesiones', { preHandler: autenticar }, async (req) => auth.listarSesiones(usuario(req)));

  app.delete('/api/auth/sesiones/:id', { preHandler: autenticar }, async (req, rep) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    auth.revocarSesion(usuario(req), id, req.ip);
    return rep.code(204).send();
  });
}
