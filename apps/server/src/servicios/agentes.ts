import { randomUUID } from 'node:crypto';
import {
  esquemaAgente,
  type AgenteEntrada,
  type AgentePublico,
  type IdHerramienta,
  type LimitesAgente,
  type RolAgente,
} from '@softgala/shared';
import type { z } from 'zod';
import { auditar } from '../auditoria';
import { ErrorApp, noEncontrado } from '../errores';
import { ahoraIso, conUnico, leerJson, type Actor, type Contexto } from './contexto';
import type { ServicioProveedores } from './proveedores';

interface FilaAgente {
  id: string;
  nombre: string;
  rol: RolAgente;
  instrucciones: string;
  proveedor_id: string;
  proveedor_nombre: string;
  modelo: string;
  herramientas: string;
  limites: string;
  activo: number;
  proyectos: number;
  creado_en: string;
}

type AgenteValido = z.output<typeof esquemaAgente>;

const CONSULTA = `
  SELECT a.*, p.nombre AS proveedor_nombre,
    (SELECT COUNT(*) FROM proyecto_agentes pa WHERE pa.agente_id = a.id) AS proyectos
  FROM agentes a JOIN proveedores p ON p.id = a.proveedor_id`;

export class ServicioAgentes {
  constructor(
    private readonly ctx: Contexto,
    private readonly proveedores: ServicioProveedores,
  ) {}

  listar(actor: Actor): AgentePublico[] {
    const filas = this.ctx.db
      .prepare(`${CONSULTA} WHERE a.usuario_id = ? ORDER BY a.nombre`)
      .all(actor.id) as unknown as FilaAgente[];
    return filas.map(aPublico);
  }

  obtener(actor: Actor, id: string): AgentePublico {
    const f = this.ctx.db
      .prepare(`${CONSULTA} WHERE a.id = ? AND a.usuario_id = ?`)
      .get(id, actor.id) as FilaAgente | undefined;
    if (!f) throw noEncontrado('Agente no encontrado');
    return aPublico(f);
  }

  crear(actor: Actor, entrada: AgenteEntrada): AgentePublico {
    const datos = esquemaAgente.parse(entrada);
    const total = (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM agentes WHERE usuario_id = ?').get(actor.id) as { n: number }).n;
    if (total >= this.ctx.config.maxAgentesPorUsuario) {
      throw new ErrorApp(
        409,
        'LIMITE_AGENTES',
        `Alcanzaste el límite de ${this.ctx.config.maxAgentesPorUsuario} agentes configurado en el servidor.`,
      );
    }
    this.proveedores.asegurarPropio(actor, datos.proveedorId);

    const id = randomUUID();
    const ahora = ahoraIso(this.ctx);
    conUnico(
      () =>
        this.ctx.db
          .prepare(
            `INSERT INTO agentes (id, usuario_id, nombre, rol, instrucciones, proveedor_id, modelo, herramientas, limites, activo, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, actor.id, ...columnas(datos), ahora, ahora),
      'Ya tienes un agente con ese nombre',
    );
    auditar(this.ctx.db, {
      accion: 'agente.creado',
      usuarioId: actor.id,
      agenteId: id,
      detalle: { nombre: datos.nombre, rol: datos.rol, modelo: datos.modelo, herramientas: datos.herramientas },
      ip: actor.ip,
    });
    return this.obtener(actor, id);
  }

  editar(actor: Actor, id: string, cambios: Partial<AgenteEntrada>): AgentePublico {
    const actual = this.obtener(actor, id);
    // Se valida el agente completo resultante, no solo los campos enviados.
    const datos = esquemaAgente.parse({ ...actual, ...cambios });
    if (datos.proveedorId !== actual.proveedorId) this.proveedores.asegurarPropio(actor, datos.proveedorId);

    conUnico(
      () =>
        this.ctx.db
          .prepare(
            `UPDATE agentes SET nombre = ?, rol = ?, instrucciones = ?, proveedor_id = ?, modelo = ?, herramientas = ?,
               limites = ?, activo = ?, actualizado_en = ? WHERE id = ?`,
          )
          .run(...columnas(datos), ahoraIso(this.ctx), id),
      'Ya tienes un agente con ese nombre',
    );
    auditar(this.ctx.db, {
      accion: 'agente.actualizado',
      usuarioId: actor.id,
      agenteId: id,
      detalle: { campos: Object.keys(cambios) },
      ip: actor.ip,
    });
    return this.obtener(actor, id);
  }

  eliminar(actor: Actor, id: string): void {
    const a = this.obtener(actor, id);
    this.ctx.db.prepare('DELETE FROM agentes WHERE id = ?').run(id);
    auditar(this.ctx.db, { accion: 'agente.eliminado', usuarioId: actor.id, agenteId: id, detalle: { nombre: a.nombre }, ip: actor.ip });
  }
}

function columnas(d: AgenteValido) {
  return [
    d.nombre,
    d.rol,
    d.instrucciones,
    d.proveedorId,
    d.modelo,
    JSON.stringify(d.herramientas),
    JSON.stringify(d.limites),
    d.activo ? 1 : 0,
  ] as const;
}

function aPublico(f: FilaAgente): AgentePublico {
  return {
    id: f.id,
    nombre: f.nombre,
    rol: f.rol,
    instrucciones: f.instrucciones,
    proveedorId: f.proveedor_id,
    proveedorNombre: f.proveedor_nombre,
    modelo: f.modelo,
    herramientas: leerJson<IdHerramienta[]>(f.herramientas, []),
    limites: leerJson<LimitesAgente>(f.limites, { maxTokensPorTarea: 0, maxCostoUsdPorTarea: 0, maxMinutosPorTarea: 0 }),
    activo: f.activo === 1,
    proyectos: f.proyectos,
    creadoEn: f.creado_en,
  };
}
