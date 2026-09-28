import { randomUUID } from 'node:crypto';
import {
  esquemaProyectoNuevo,
  type AvanceProyecto,
  type ColorProyecto,
  type EstadoTarea,
  type FaseColaboracion,
  type ModoTarea,
  type EstadoRepositorio,
  type LimitesProyecto,
  type ProyectoEdicion,
  type ProyectoNuevo,
  type ProyectoPublico,
  type RolAgente,
  type Validacion,
} from '@softgala/shared';
import { auditar } from '../auditoria';
import { avanceDeTarea } from '../ejecucion/avance';
import { transaccion } from '../db';
import { ErrorApp, noEncontrado } from '../errores';
import { avisosToken } from '../externo/github';
import { ahoraIso, conUnico, leerJson, ultimos4, type Actor, type Contexto } from './contexto';
import type { ServicioAgentes } from './agentes';

interface FilaProyecto {
  id: string;
  fijado: number;
  color: ColorProyecto;
  nombre_ventana: string | null;
  nombre: string;
  repositorio: string;
  rama_base: string;
  privado: number;
  url_repo: string;
  token_cifrado: string;
  token_final: string;
  validaciones: string;
  limites: string;
  avisos: string;
  creado_en: string;
}

const contextoToken = (id: string) => `proyecto:${id}:github`;
/** Prefijo de las ramas de trabajo que crean los agentes. */
export const PREFIJO_RAMAS_AGENTES = 'agentes/';

export class ServicioProyectos {
  constructor(
    private readonly ctx: Contexto,
    private readonly agentes: ServicioAgentes,
  ) {}

  listar(actor: Actor): ProyectoPublico[] {
    const filas = this.ctx.db
      .prepare('SELECT * FROM proyectos WHERE usuario_id = ? ORDER BY fijado DESC, nombre')
      .all(actor.id) as unknown as FilaProyecto[];
    return filas.map((f) => this.aPublico(f));
  }

  obtener(actor: Actor, id: string): ProyectoPublico {
    return this.aPublico(this.fila(actor, id));
  }

  /** Conecta un repositorio de GitHub tras verificar el acceso y la rama con la API real. */
  async crear(actor: Actor, entrada: ProyectoNuevo): Promise<ProyectoPublico> {
    const datos = esquemaProyectoNuevo.parse(entrada);
    const total = (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM proyectos WHERE usuario_id = ?').get(actor.id) as { n: number }).n;
    if (total >= this.ctx.config.maxProyectosPorUsuario) {
      throw new ErrorApp(409, 'LIMITE_PROYECTOS', `Alcanzaste el límite de ${this.ctx.config.maxProyectosPorUsuario} proyectos.`);
    }

    const repo = await this.ctx.github.repo(datos.repositorio, datos.token);
    const rama = datos.ramaBase ?? repo.ramaPrincipal;
    await this.ctx.github.rama(datos.repositorio, rama, datos.token);
    const avisos = avisosToken(datos.token, repo.permisos);

    const id = randomUUID();
    const ahora = ahoraIso(this.ctx);
    conUnico(
      () =>
        this.ctx.db
          .prepare(
            `INSERT INTO proyectos (id, usuario_id, nombre, repositorio, rama_base, privado, url_repo, token_cifrado, token_final,
               validaciones, limites, avisos, creado_en, actualizado_en)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            actor.id,
            datos.nombre,
            datos.repositorio,
            rama,
            repo.privado ? 1 : 0,
            repo.url,
            this.ctx.boveda.cifrar(datos.token, contextoToken(id)),
            ultimos4(datos.token),
            JSON.stringify(datos.validaciones),
            JSON.stringify(datos.limites),
            JSON.stringify(avisos),
            ahora,
            ahora,
          ),
      'Ese repositorio ya está conectado',
    );
    auditar(this.ctx.db, {
      accion: 'proyecto.conectado',
      usuarioId: actor.id,
      proyectoId: id,
      detalle: { repositorio: datos.repositorio, rama, avisos: avisos.length },
      ip: actor.ip,
    });
    return this.obtener(actor, id);
  }

  async editar(actor: Actor, id: string, cambios: ProyectoEdicion): Promise<ProyectoPublico> {
    const actual = this.fila(actor, id);
    const token = cambios.token ?? this.token(actual);
    let avisos = leerJson<string[]>(actual.avisos, []);
    let privado = actual.privado;

    // Si cambia el token o la rama, se vuelve a verificar contra GitHub antes de guardar.
    if (cambios.token) {
      const repo = await this.ctx.github.repo(actual.repositorio, token);
      avisos = avisosToken(token, repo.permisos);
      privado = repo.privado ? 1 : 0;
    }
    const rama = cambios.ramaBase ?? actual.rama_base;
    if (cambios.token || cambios.ramaBase) await this.ctx.github.rama(actual.repositorio, rama, token);

    this.ctx.db
      .prepare(
        `UPDATE proyectos SET nombre = ?, rama_base = ?, privado = ?, token_cifrado = ?, token_final = ?,
           validaciones = ?, limites = ?, avisos = ?, fijado = ?, color = ?, nombre_ventana = ?, actualizado_en = ? WHERE id = ?`,
      )
      .run(
        cambios.nombre ?? actual.nombre,
        rama,
        privado,
        cambios.token ? this.ctx.boveda.cifrar(cambios.token, contextoToken(id)) : actual.token_cifrado,
        cambios.token ? ultimos4(cambios.token) : actual.token_final,
        cambios.validaciones ? JSON.stringify(cambios.validaciones) : actual.validaciones,
        cambios.limites ? JSON.stringify(cambios.limites) : actual.limites,
        JSON.stringify(avisos),
        cambios.fijado === undefined ? actual.fijado : cambios.fijado ? 1 : 0,
        cambios.color ?? actual.color,
        cambios.nombreVentana === undefined ? actual.nombre_ventana : cambios.nombreVentana,
        ahoraIso(this.ctx),
        id,
      );
    auditar(this.ctx.db, {
      accion: cambios.token ? 'proyecto.token_rotado' : Object.keys(cambios).every((c) => ['fijado', 'color', 'nombreVentana'].includes(c)) ? 'proyecto.personalizado' : 'proyecto.actualizado',
      usuarioId: actor.id,
      proyectoId: id,
      detalle: { campos: Object.keys(cambios).filter((c) => c !== 'token'), tokenCambiado: !!cambios.token },
      ip: actor.ip,
    });
    return this.obtener(actor, id);
  }

  /** Uso interno del orquestador: datos para ejecutar, con el token descifrado. */
  paraEjecucion(usuarioId: string, id: string) {
    const p = this.fila({ id: usuarioId, rol: 'usuario', ip: null }, id);
    return {
      id: p.id,
      nombre: p.nombre,
      repositorio: p.repositorio,
      ramaBase: p.rama_base,
      token: this.token(p),
      validaciones: leerJson<Validacion[]>(p.validaciones, []),
      limites: leerJson<LimitesProyecto>(p.limites, { maxAgentesSimultaneos: 1, presupuestoMensualUsd: 0 }),
    };
  }

  /** Desconecta el proyecto de la plataforma. No modifica nada en GitHub. */
  eliminar(actor: Actor, id: string): void {
    const p = this.fila(actor, id);
    const activa = this.ctx.db
      .prepare("SELECT 1 FROM tareas WHERE proyecto_id = ? AND estado IN ('en_cola','ejecutando')")
      .get(id);
    if (activa) throw new ErrorApp(409, 'TAREA_EN_CURSO', 'Hay una tarea en ejecución; cancélala antes de desconectar el proyecto.');
    this.ctx.db.prepare('DELETE FROM proyectos WHERE id = ?').run(id);
    auditar(this.ctx.db, { accion: 'proyecto.desconectado', usuarioId: actor.id, proyectoId: id, detalle: { repositorio: p.repositorio }, ip: actor.ip });
  }

  /** Estado actual del repositorio consultado en vivo en GitHub. */
  async estado(actor: Actor, id: string): Promise<EstadoRepositorio> {
    const p = this.fila(actor, id);
    const token = this.token(p);
    const [rama, ramasAgentes] = await Promise.all([
      this.ctx.github.rama(p.repositorio, p.rama_base, token),
      this.ctx.github.ramasConPrefijo(p.repositorio, PREFIJO_RAMAS_AGENTES, token),
    ]);
    return { rama: rama.nombre, ultimoCommit: rama.commit, ramasAgentes, consultadoEn: ahoraIso(this.ctx) };
  }

  habilitarAgente(actor: Actor, proyectoId: string, agenteId: string, habilitado: boolean): ProyectoPublico {
    this.fila(actor, proyectoId);
    const agente = this.agentes.obtener(actor, agenteId);
    transaccion(this.ctx.db, () => {
      if (habilitado) {
        this.ctx.db
          .prepare('INSERT OR IGNORE INTO proyecto_agentes (proyecto_id, agente_id, habilitado_en) VALUES (?, ?, ?)')
          .run(proyectoId, agenteId, ahoraIso(this.ctx));
      } else {
        this.ctx.db.prepare('DELETE FROM proyecto_agentes WHERE proyecto_id = ? AND agente_id = ?').run(proyectoId, agenteId);
      }
    });
    auditar(this.ctx.db, {
      accion: habilitado ? 'proyecto.agente_habilitado' : 'proyecto.agente_deshabilitado',
      usuarioId: actor.id,
      proyectoId,
      agenteId,
      detalle: { agente: agente.nombre },
      ip: actor.ip,
    });
    return this.obtener(actor, proyectoId);
  }

  private token(p: FilaProyecto): string {
    return this.ctx.boveda.descifrar(p.token_cifrado, contextoToken(p.id));
  }

  private fila(actor: Actor, id: string): FilaProyecto {
    const f = this.ctx.db
      .prepare('SELECT * FROM proyectos WHERE id = ? AND usuario_id = ?')
      .get(id, actor.id) as FilaProyecto | undefined;
    if (!f) throw noEncontrado('Proyecto no encontrado');
    return f;
  }

  private aPublico(f: FilaProyecto): ProyectoPublico {
    const agentes = this.ctx.db
      .prepare(
        `SELECT a.id, a.nombre, a.rol, a.activo FROM proyecto_agentes pa JOIN agentes a ON a.id = pa.agente_id
         WHERE pa.proyecto_id = ? ORDER BY a.nombre`,
      )
      .all(f.id) as { id: string; nombre: string; rol: RolAgente; activo: number }[];
    return {
      id: f.id,
      nombre: f.nombre,
      repositorio: f.repositorio,
      ramaBase: f.rama_base,
      privado: f.privado === 1,
      urlRepo: f.url_repo,
      tokenMascara: `••••${f.token_final}`,
      validaciones: leerJson<Validacion[]>(f.validaciones, []),
      limites: leerJson<LimitesProyecto>(f.limites, { maxAgentesSimultaneos: 1, presupuestoMensualUsd: 0 }),
      agentes: agentes.map((a) => ({ agenteId: a.id, nombre: a.nombre, rol: a.rol, activo: a.activo === 1 })),
      avisos: leerJson<string[]>(f.avisos, []),
      fijado: f.fijado === 1,
      color: f.color,
      nombreVentana: f.nombre_ventana,
      avance: this.avance(f.id),
      creadoEn: f.creado_en,
    };
  }

  /** Avance de la tarea más reciente del proyecto y el conteo de tareas. */
  private avance(proyectoId: string): AvanceProyecto | null {
    const t = this.ctx.db
      .prepare('SELECT id, objetivo, estado, modo, fase FROM tareas WHERE proyecto_id = ? ORDER BY creada_en DESC LIMIT 1')
      .get(proyectoId) as { id: string; objetivo: string; estado: EstadoTarea; modo: ModoTarea; fase: FaseColaboracion | null } | undefined;
    if (!t) return null;
    const c = this.ctx.db
      .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(estado = 'completada'), 0) AS completadas FROM tareas WHERE proyecto_id = ?")
      .get(proyectoId) as { total: number; completadas: number };
    return { ...avanceDeTarea(this.ctx.db, t), tareaId: t.id, objetivo: t.objetivo, estado: t.estado, tareasTotales: c.total, tareasCompletadas: c.completadas };
  }
}
