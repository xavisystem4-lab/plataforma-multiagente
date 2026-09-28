import { randomUUID } from 'node:crypto';
import {
  INFO_PROVEEDOR,
  type ProveedorEdicion,
  type ProveedorNuevo,
  type ProveedorPublico,
  type ResultadoPrueba,
  type TipoProveedor,
} from '@softgala/shared';
import { auditar } from '../auditoria';
import { ErrorApp, noEncontrado } from '../errores';
import { validarUrlProveedor } from '../externo/url-segura';
import { ErrorProveedor } from '../modelos/adaptadores';
import { ahoraIso, conUnico, leerJson, ultimos4, type Actor, type Contexto } from './contexto';

interface FilaProveedor {
  id: string;
  usuario_id: string;
  nombre: string;
  tipo: TipoProveedor;
  url_base: string | null;
  clave_cifrada: string | null;
  clave_final: string | null;
  prueba_ok: number | null;
  prueba_fecha: string | null;
  prueba_mensaje: string | null;
  modelos_disponibles: string;
  creado_en: string;
  agentes?: number;
}

const contextoClave = (id: string) => `proveedor:${id}`;

export class ServicioProveedores {
  constructor(private readonly ctx: Contexto) {}

  listar(actor: Actor): ProveedorPublico[] {
    const filas = this.ctx.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM agentes a WHERE a.proveedor_id = p.id) AS agentes
         FROM proveedores p WHERE p.usuario_id = ? ORDER BY p.nombre`,
      )
      .all(actor.id) as unknown as FilaProveedor[];
    return filas.map(aPublico);
  }

  obtener(actor: Actor, id: string): ProveedorPublico {
    return aPublico(this.fila(actor, id));
  }

  crear(actor: Actor, datos: ProveedorNuevo): ProveedorPublico {
    const id = randomUUID();
    const ahora = ahoraIso(this.ctx);
    const urlBase = datos.tipo === 'openai_compatible' && datos.urlBase ? validarUrlProveedor(datos.urlBase) : null;
    const clave = datos.apiKey ?? null;
    conUnico(
      () =>
        this.ctx.db
          .prepare(
            `INSERT INTO proveedores (id, usuario_id, nombre, tipo, url_base, clave_cifrada, clave_final, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            actor.id,
            datos.nombre,
            datos.tipo,
            urlBase,
            clave ? this.ctx.boveda.cifrar(clave, contextoClave(id)) : null,
            clave ? ultimos4(clave) : null,
            ahora,
            ahora,
          ),
      'Ya tienes un proveedor con ese nombre',
    );
    auditar(this.ctx.db, { accion: 'proveedor.creado', usuarioId: actor.id, detalle: { id, nombre: datos.nombre, tipo: datos.tipo }, ip: actor.ip });
    return this.obtener(actor, id);
  }

  editar(actor: Actor, id: string, datos: ProveedorEdicion): ProveedorPublico {
    const actual = this.fila(actor, id);
    const cambios: string[] = [];
    let urlBase = actual.url_base;
    if (datos.urlBase !== undefined) {
      if (actual.tipo !== 'openai_compatible') throw new ErrorApp(400, 'NO_APLICA', 'Este proveedor no usa URL base');
      urlBase = validarUrlProveedor(datos.urlBase);
      cambios.push('urlBase');
    }
    let claveCifrada = actual.clave_cifrada;
    let claveFinal = actual.clave_final;
    if (datos.apiKey === null) {
      if (INFO_PROVEEDOR[actual.tipo].requiereClave) throw new ErrorApp(400, 'CLAVE_REQUERIDA', 'Este proveedor requiere una clave API');
      claveCifrada = null;
      claveFinal = null;
      cambios.push('apiKey');
    } else if (datos.apiKey !== undefined) {
      claveCifrada = this.ctx.boveda.cifrar(datos.apiKey, contextoClave(id));
      claveFinal = ultimos4(datos.apiKey);
      cambios.push('apiKey');
    }
    if (datos.nombre !== undefined) cambios.push('nombre');

    // Si cambian clave o URL, la prueba anterior ya no es válida.
    const reiniciarPrueba = cambios.includes('apiKey') || cambios.includes('urlBase');
    conUnico(
      () =>
        this.ctx.db
          .prepare(
            `UPDATE proveedores SET nombre = ?, url_base = ?, clave_cifrada = ?, clave_final = ?, actualizado_en = ?,
               prueba_ok = CASE WHEN ? THEN NULL ELSE prueba_ok END,
               prueba_fecha = CASE WHEN ? THEN NULL ELSE prueba_fecha END,
               prueba_mensaje = CASE WHEN ? THEN NULL ELSE prueba_mensaje END,
               modelos_disponibles = CASE WHEN ? THEN '[]' ELSE modelos_disponibles END
             WHERE id = ?`,
          )
          .run(
            datos.nombre ?? actual.nombre,
            urlBase,
            claveCifrada,
            claveFinal,
            ahoraIso(this.ctx),
            reiniciarPrueba ? 1 : 0,
            reiniciarPrueba ? 1 : 0,
            reiniciarPrueba ? 1 : 0,
            reiniciarPrueba ? 1 : 0,
            id,
          ),
      'Ya tienes un proveedor con ese nombre',
    );
    auditar(this.ctx.db, { accion: 'proveedor.actualizado', usuarioId: actor.id, detalle: { id, cambios }, ip: actor.ip });
    return this.obtener(actor, id);
  }

  eliminar(actor: Actor, id: string): void {
    const p = this.fila(actor, id);
    if (p.agentes && p.agentes > 0) {
      throw new ErrorApp(409, 'PROVEEDOR_EN_USO', `No se puede eliminar: lo usan ${p.agentes} agente(s). Cámbialos de proveedor primero.`);
    }
    this.ctx.db.prepare('DELETE FROM proveedores WHERE id = ?').run(id);
    auditar(this.ctx.db, { accion: 'proveedor.eliminado', usuarioId: actor.id, detalle: { id, nombre: p.nombre }, ip: actor.ip });
  }

  /** Llama a la API real del proveedor y guarda el resultado y los modelos disponibles. */
  async probar(actor: Actor, id: string): Promise<ResultadoPrueba> {
    const p = this.fila(actor, id);
    let resultado: ResultadoPrueba;
    try {
      const modelos = await this.ctx
        .adaptadores(p.tipo, { apiKey: this.clave(p), urlBase: p.url_base })
        .listarModelos();
      const ordenados = [...new Set(modelos)].sort().slice(0, 500);
      resultado = { ok: true, mensaje: `Conexión correcta: ${ordenados.length} modelo(s) disponibles.`, modelos: ordenados };
    } catch (err) {
      if (!(err instanceof ErrorProveedor)) this.ctx.log.error({ err }, 'Error inesperado al probar proveedor');
      resultado = {
        ok: false,
        mensaje: err instanceof ErrorProveedor ? err.message : 'Error inesperado al probar la conexión.',
        modelos: [],
      };
    }
    this.ctx.db
      .prepare(
        `UPDATE proveedores SET prueba_ok = ?, prueba_fecha = ?, prueba_mensaje = ?,
           modelos_disponibles = CASE WHEN ? THEN ? ELSE modelos_disponibles END WHERE id = ?`,
      )
      .run(resultado.ok ? 1 : 0, ahoraIso(this.ctx), resultado.mensaje, resultado.ok ? 1 : 0, JSON.stringify(resultado.modelos), id);
    auditar(this.ctx.db, { accion: 'proveedor.probado', usuarioId: actor.id, detalle: { id, ok: resultado.ok }, ip: actor.ip });
    return resultado;
  }

  /** Uso interno del orquestador: credenciales descifradas. Nunca se envían al cliente. */
  credenciales(usuarioId: string, id: string): { tipo: TipoProveedor; apiKey: string | null; urlBase: string | null } {
    const p = this.fila({ id: usuarioId, rol: 'usuario', ip: null }, id);
    return { tipo: p.tipo, apiKey: this.clave(p), urlBase: p.url_base };
  }

  /** Verifica que el proveedor exista y pertenezca al usuario. */
  asegurarPropio(actor: Actor, id: string): void {
    this.fila(actor, id);
  }

  private clave(p: FilaProveedor): string | null {
    return p.clave_cifrada ? this.ctx.boveda.descifrar(p.clave_cifrada, contextoClave(p.id)) : null;
  }

  private fila(actor: Actor, id: string): FilaProveedor {
    const f = this.ctx.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM agentes a WHERE a.proveedor_id = p.id) AS agentes
         FROM proveedores p WHERE p.id = ? AND p.usuario_id = ?`,
      )
      .get(id, actor.id) as FilaProveedor | undefined;
    if (!f) throw noEncontrado('Proveedor no encontrado');
    return f;
  }
}

function aPublico(f: FilaProveedor): ProveedorPublico {
  return {
    id: f.id,
    nombre: f.nombre,
    tipo: f.tipo,
    urlBase: f.url_base,
    claveMascara: f.clave_final ? `••••${f.clave_final}` : null,
    ultimaPrueba:
      f.prueba_fecha !== null
        ? { ok: f.prueba_ok === 1, fecha: f.prueba_fecha, mensaje: f.prueba_mensaje ?? '' }
        : null,
    modelosDisponibles: leerJson<string[]>(f.modelos_disponibles, []),
    agentes: f.agentes ?? 0,
    creadoEn: f.creado_en,
  };
}
