import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  esquemaAgente,
  esquemaAgenteEdicion,
  esquemaProveedorEdicion,
  esquemaProveedorNuevo,
  esquemaProyectoEdicion,
  esquemaProyectoNuevo,
  HERRAMIENTAS,
  INFO_PROVEEDOR,
  MODELOS_SUGERIDOS,
  NOMBRE_ROL,
  ROLES_AGENTE,
} from '@softgala/shared';
import { z } from 'zod';
import type { Actor } from '../servicios/contexto';
import type { ServicioAgentes } from '../servicios/agentes';
import type { ServicioConsultas } from '../servicios/consultas';
import type { ServicioProveedores } from '../servicios/proveedores';
import type { ServicioProyectos } from '../servicios/proyectos';

export interface Servicios {
  proveedores: ServicioProveedores;
  agentes: ServicioAgentes;
  proyectos: ServicioProyectos;
  consultas: ServicioConsultas;
}

const conId = z.object({ id: z.string().uuid('Identificador no válido') });
const conIdYAgente = z.object({ id: z.string().uuid(), agenteId: z.string().uuid() });
const filtroAuditoria = z.object({
  limite: z.coerce.number().int().min(1).max(100).default(50),
  antesDe: z.coerce.number().int().positive().optional(),
  accion: z.string().trim().max(60).regex(/^[a-z_.]*$/, 'Filtro no válido').optional(),
});

const actorDe = (req: FastifyRequest): Actor => ({ id: req.usuario!.id, rol: req.usuario!.rol, ip: req.ip });
const sinContenido = (rep: FastifyReply) => rep.code(204).send();

export function rutasRecursos(
  app: FastifyInstance,
  s: Servicios,
  autenticar: preHandlerAsyncHookHandler,
  alEliminarProyecto: (id: string) => Promise<void> = async () => {},
): void {
  // Todas las rutas de este módulo exigen sesión.
  app.register(async (api) => {
    api.addHook('preHandler', autenticar);

    api.get('/api/catalogo', async () => ({
      tiposProveedor: INFO_PROVEEDOR,
      modelosSugeridos: MODELOS_SUGERIDOS,
      roles: ROLES_AGENTE.map((id) => ({ id, nombre: NOMBRE_ROL[id] })),
      herramientas: HERRAMIENTAS,
    }));
    api.get('/api/resumen', async (req) => s.consultas.resumen(actorDe(req)));
    api.get('/api/auditoria', async (req) => s.consultas.auditoria(actorDe(req), filtroAuditoria.parse(req.query)));

    // Proveedores de modelos
    api.get('/api/proveedores', async (req) => s.proveedores.listar(actorDe(req)));
    api.post('/api/proveedores', async (req, rep) =>
      rep.code(201).send(s.proveedores.crear(actorDe(req), esquemaProveedorNuevo.parse(req.body))),
    );
    api.patch('/api/proveedores/:id', async (req) =>
      s.proveedores.editar(actorDe(req), conId.parse(req.params).id, esquemaProveedorEdicion.parse(req.body)),
    );
    api.delete('/api/proveedores/:id', async (req, rep) => {
      s.proveedores.eliminar(actorDe(req), conId.parse(req.params).id);
      return sinContenido(rep);
    });
    api.post(
      '/api/proveedores/:id/probar',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => s.proveedores.probar(actorDe(req), conId.parse(req.params).id),
    );

    // Agentes
    api.get('/api/agentes', async (req) => s.agentes.listar(actorDe(req)));
    api.get('/api/agentes/:id', async (req) => s.agentes.obtener(actorDe(req), conId.parse(req.params).id));
    api.post('/api/agentes', async (req, rep) =>
      rep.code(201).send(s.agentes.crear(actorDe(req), esquemaAgente.parse(req.body))),
    );
    api.patch('/api/agentes/:id', async (req) =>
      s.agentes.editar(actorDe(req), conId.parse(req.params).id, esquemaAgenteEdicion.parse(req.body)),
    );
    api.delete('/api/agentes/:id', async (req, rep) => {
      s.agentes.eliminar(actorDe(req), conId.parse(req.params).id);
      return sinContenido(rep);
    });

    // Proyectos
    api.get('/api/proyectos', async (req) => s.proyectos.listar(actorDe(req)));
    api.get('/api/proyectos/:id', async (req) => s.proyectos.obtener(actorDe(req), conId.parse(req.params).id));
    api.post(
      '/api/proyectos',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req, rep) => rep.code(201).send(await s.proyectos.crear(actorDe(req), esquemaProyectoNuevo.parse(req.body))),
    );
    api.patch('/api/proyectos/:id', async (req) =>
      s.proyectos.editar(actorDe(req), conId.parse(req.params).id, esquemaProyectoEdicion.parse(req.body)),
    );
    api.delete('/api/proyectos/:id', async (req, rep) => {
      const { id } = conId.parse(req.params);
      s.proyectos.eliminar(actorDe(req), id);
      // Borra la copia local del repositorio y los worktrees del servidor.
      await alEliminarProyecto(id).catch((err) => req.log.warn({ err }, 'No se pudo limpiar el espacio del proyecto'));
      return sinContenido(rep);
    });
    api.get(
      '/api/proyectos/:id/estado',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req) => s.proyectos.estado(actorDe(req), conId.parse(req.params).id),
    );
    api.put('/api/proyectos/:id/agentes/:agenteId', async (req) => {
      const { id, agenteId } = conIdYAgente.parse(req.params);
      const { habilitado } = z.object({ habilitado: z.boolean() }).parse(req.body);
      return s.proyectos.habilitarAgente(actorDe(req), id, agenteId, habilitado);
    });
  });
}
