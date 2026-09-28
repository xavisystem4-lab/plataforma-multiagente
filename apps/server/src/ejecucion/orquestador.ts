import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  ESTADOS_REANUDABLES,
  type AgentePublico,
  type ColaboracionPublica,
  type DecisionPublica,
  type EstadoSubtarea,
  type EstadoTarea,
  type EventoTiempoReal,
  type FaseColaboracion,
  type ModoTarea,
  type PublicacionTarea,
  type ResultadoValidacion,
  type SolicitudContinuar,
  type TareaPublica,
  type TipoDecision,
  type TipoEvento,
} from '@softgala/shared';
import { auditar } from '../auditoria';
import { ErrorApp, noEncontrado } from '../errores';
import { costoEstimado } from '../modelos/costos';
import { ErrorProveedor, type MensajeConversacion } from '../modelos/adaptadores';
import type { ServicioAgentes } from '../servicios/agentes';
import { leerJson, type Actor, type Contexto } from '../servicios/contexto';
import type { ServicioProveedores } from '../servicios/proveedores';
import type { ServicioProyectos } from '../servicios/proyectos';
import type { BusEventos } from './bus';
import { avanceDeTarea } from './avance';
import { ejecutarCiclo, FinEjecucion } from './ciclo';
import { Colaboracion, PREFIJO_PREGUNTA_SUBTAREA } from './colaboracion';
import { ErrorGit, type EspaciosGit } from './git';
import { EjecutorHerramientas, herramientasPara, type ResultadoHerramienta } from './herramientas';
import { promptInicial, promptSistema } from './politicas';
import type { Sandbox } from './sandbox';

export interface OpcionesOrquestador {
  /** Tareas ejecutándose a la vez en todo el servidor. */
  maxSimultaneas: number;
  /** Turnos máximos de conversación por ejecución de cada agente (evita ciclos infinitos). */
  maxTurnos: number;
  /** Tokens máximos por respuesta del modelo. */
  maxTokensRespuesta: number;
  /** Tiempo máximo de cada validación. */
  timeoutValidacionMs: number;
}

interface ConfigColaboracion {
  coordinadorId: string;
  participantes: string[];
  maxRondas: number;
}

interface FilaTarea {
  id: string;
  usuario_id: string;
  proyecto_id: string;
  proyecto_nombre: string;
  agente_id: string;
  agente_nombre: string;
  objetivo: string;
  estado: EstadoTarea;
  modo: ModoTarea;
  colaboracion: string | null;
  fase: FaseColaboracion | null;
  decision: string | null;
  rama: string;
  pregunta: string | null;
  pregunta_llamada: string | null;
  resumen: string | null;
  error: string | null;
  conversacion: string;
  archivos: string;
  validaciones: string;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number | null;
  uso_agentes: string;
  publicacion: string | null;
  ms_ejecucion: number;
  creada_en: string;
  iniciada_en: string | null;
  terminada_en: string | null;
}

type Motivo = 'pausa' | 'cancelacion' | 'tiempo' | 'apagado';
type DatosProyecto = ReturnType<ServicioProyectos['paraEjecucion']>;

const CONSULTA = `
  SELECT t.*, p.nombre AS proyecto_nombre, a.nombre AS agente_nombre
  FROM tareas t JOIN proyectos p ON p.id = t.proyecto_id JOIN agentes a ON a.id = t.agente_id`;

const slug = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'tarea';

export class Orquestador {
  private readonly enCurso = new Map<string, { control: AbortController; motivo: Motivo | null }>();
  private readonly cola: string[] = [];
  private inactivo: (() => void)[] = [];
  /** Se invoca cuando una tarea termina con cambios (crea la solicitud de aprobación). */
  alCompletarConCambios: (tareaId: string) => void = () => {};

  constructor(
    private readonly ctx: Contexto,
    private readonly s: { proyectos: ServicioProyectos; agentes: ServicioAgentes; proveedores: ServicioProveedores },
    private readonly bus: BusEventos,
    private readonly git: EspaciosGit,
    private readonly sandbox: Sandbox,
    private readonly op: OpcionesOrquestador,
  ) {}

  get infoSandbox() {
    return { disponible: this.sandbox.disponible, motivo: this.sandbox.motivo };
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------

  /** "Continuar proyecto": reanuda la tarea pausada o crea una nueva (individual o colaborativa). */
  continuar(actor: Actor, proyectoId: string, sol: SolicitudContinuar): TareaPublica {
    const proyecto = this.s.proyectos.obtener(actor, proyectoId);
    const activa = this.ctx.db
      .prepare("SELECT id FROM tareas WHERE proyecto_id = ? AND estado IN ('en_cola','ejecutando')")
      .get(proyectoId) as { id: string } | undefined;
    if (activa) throw new ErrorApp(409, 'TAREA_EN_CURSO', 'Este proyecto ya tiene una tarea en ejecución.');

    if (!sol.objetivo) {
      const pendiente = this.ctx.db
        .prepare(
          "SELECT id, estado FROM tareas WHERE proyecto_id = ? AND estado IN ('pausada','esperando_usuario') ORDER BY creada_en DESC LIMIT 1",
        )
        .get(proyectoId) as { id: string; estado: EstadoTarea } | undefined;
      if (!pendiente) throw new ErrorApp(400, 'OBJETIVO_REQUERIDO', 'No hay una tarea pausada: describe el objetivo para empezar una nueva.');
      if (pendiente.estado === 'esperando_usuario') {
        throw new ErrorApp(409, 'ESPERA_RESPUESTA', 'La tarea pendiente espera tu respuesta; contéstala para continuar.');
      }
      return this.reanudar(actor, pendiente.id);
    }

    const activos = proyecto.agentes.filter((a) => a.activo);
    let agente: AgentePublico;
    let colaboracion: ConfigColaboracion | null = null;
    if (sol.modo === 'colaborativo') {
      const habilitado = (id: string) => activos.some((a) => a.agenteId === id);
      if (!habilitado(sol.coordinadorId!)) throw new ErrorApp(409, 'AGENTE_NO_HABILITADO', 'El coordinador no está habilitado y activo en este proyecto.');
      const ajeno = sol.participantes!.find((id) => !habilitado(id));
      if (ajeno) throw new ErrorApp(409, 'AGENTE_NO_HABILITADO', 'Algún participante no está habilitado y activo en este proyecto.');
      agente = this.s.agentes.obtener(actor, sol.coordinadorId!);
      colaboracion = { coordinadorId: sol.coordinadorId!, participantes: sol.participantes!, maxRondas: sol.maxRondas };
    } else {
      agente = this.elegirAgente(actor, activos, sol.agenteId);
    }
    this.verificarPresupuesto(actor.id, proyectoId);

    const id = randomUUID();
    const ahora = this.ctx.ahora().toISOString();
    const rama = `agentes/${slug(sol.objetivo)}-${id.slice(0, 6)}`;
    this.ctx.db
      .prepare(
        `INSERT INTO tareas (id, usuario_id, proyecto_id, agente_id, objetivo, estado, modo, colaboracion, rama, creada_en, actualizada_en)
         VALUES (?, ?, ?, ?, ?, 'en_cola', ?, ?, ?, ?, ?)`,
      )
      .run(id, actor.id, proyectoId, agente.id, sol.objetivo, sol.modo, colaboracion ? JSON.stringify(colaboracion) : null, rama, ahora, ahora);
    auditar(this.ctx.db, {
      accion: 'tarea.creada',
      usuarioId: actor.id,
      proyectoId,
      agenteId: agente.id,
      detalle: { tareaId: id, rama, modo: sol.modo, ...(colaboracion ? { participantes: colaboracion.participantes.length, rondas: colaboracion.maxRondas } : {}) },
      ip: actor.ip,
    });
    this.emitir(this.fila(actor.id, id), 'task.created', { objetivo: sol.objetivo, rama, agente: agente.nombre, modo: sol.modo });
    this.encolar(id);
    return this.obtener(actor, id);
  }

  pausar(actor: Actor, id: string): TareaPublica {
    const t = this.fila(actor.id, id);
    const activa = this.enCurso.get(id);
    if (activa) {
      activa.motivo = 'pausa';
      activa.control.abort();
    } else if (t.estado === 'en_cola') {
      this.quitarDeCola(id);
      this.cambiarEstado(t, 'pausada', 'task.paused', {});
    } else {
      throw new ErrorApp(409, 'ESTADO_INVALIDO', 'Solo se puede pausar una tarea en ejecución o en cola.');
    }
    auditar(this.ctx.db, { accion: 'tarea.pausada', usuarioId: actor.id, proyectoId: t.proyecto_id, detalle: { tareaId: id }, ip: actor.ip });
    return this.obtener(actor, id);
  }

  reanudar(actor: Actor, id: string): TareaPublica {
    const t = this.fila(actor.id, id);
    if (t.estado !== 'pausada') throw new ErrorApp(409, 'ESTADO_INVALIDO', 'Solo se puede reanudar una tarea pausada.');
    this.verificarPresupuesto(actor.id, t.proyecto_id);
    const activa = this.ctx.db
      .prepare("SELECT 1 FROM tareas WHERE proyecto_id = ? AND estado IN ('en_cola','ejecutando') AND id != ?")
      .get(t.proyecto_id, id);
    if (activa) throw new ErrorApp(409, 'TAREA_EN_CURSO', 'Este proyecto ya tiene otra tarea en ejecución.');
    this.cambiarEstado(t, 'en_cola', null, {}, { error: null });
    auditar(this.ctx.db, { accion: 'tarea.reanudada', usuarioId: actor.id, proyectoId: t.proyecto_id, detalle: { tareaId: id }, ip: actor.ip });
    this.encolar(id);
    return this.obtener(actor, id);
  }

  cancelar(actor: Actor, id: string): TareaPublica {
    const t = this.fila(actor.id, id);
    const activa = this.enCurso.get(id);
    if (activa) {
      activa.motivo = 'cancelacion';
      activa.control.abort();
    } else if (t.estado === 'en_cola' || ESTADOS_REANUDABLES.includes(t.estado)) {
      this.quitarDeCola(id);
      this.cambiarEstado(t, 'cancelada', 'task.cancelled', {}, { terminada_en: this.ctx.ahora().toISOString(), pregunta: null });
    } else {
      throw new ErrorApp(409, 'ESTADO_INVALIDO', 'La tarea ya terminó.');
    }
    auditar(this.ctx.db, { accion: 'tarea.cancelada', usuarioId: actor.id, proyectoId: t.proyecto_id, detalle: { tareaId: id }, ip: actor.ip });
    return this.obtener(actor, id);
  }

  /** Entrega la respuesta del usuario a la pregunta pendiente (de la tarea o de una subtarea) y reanuda. */
  responder(actor: Actor, id: string, respuesta: string): TareaPublica {
    const t = this.fila(actor.id, id);
    if (t.estado !== 'esperando_usuario' || !t.pregunta_llamada) {
      throw new ErrorApp(409, 'ESTADO_INVALIDO', 'La tarea no está esperando una respuesta.');
    }
    const resultadoPara = (llamada: string) => ({ id: llamada, contenido: `Respuesta del usuario: ${respuesta}`, error: false });
    const agregar = (conversacion: string, llamada: string) => {
      const mensajes = leerJson<MensajeConversacion[]>(conversacion, []);
      const ultimo = mensajes.at(-1);
      // Todos los resultados de un turno van en un solo mensaje.
      if (ultimo?.rol === 'resultados') ultimo.resultados.push(resultadoPara(llamada));
      else mensajes.push({ rol: 'resultados', resultados: [resultadoPara(llamada)] });
      return JSON.stringify(mensajes);
    };

    let extra: Partial<Record<'conversacion', string>> = {};
    if (t.pregunta_llamada.startsWith(PREFIJO_PREGUNTA_SUBTAREA)) {
      const [subId = '', ...resto] = t.pregunta_llamada.slice(PREFIJO_PREGUNTA_SUBTAREA.length).split(':');
      const sub = this.ctx.db.prepare('SELECT conversacion FROM subtareas WHERE id = ? AND tarea_id = ?').get(subId, id) as
        | { conversacion: string }
        | undefined;
      if (!sub) throw noEncontrado('Subtarea no encontrada');
      this.ctx.db
        .prepare("UPDATE subtareas SET conversacion = ?, estado = 'pendiente', pregunta = NULL, pregunta_llamada = NULL WHERE id = ?")
        .run(agregar(sub.conversacion, resto.join(':')), subId);
    } else {
      extra = { conversacion: agregar(t.conversacion, t.pregunta_llamada) };
    }

    this.cambiarEstado(t, 'en_cola', 'agent.message', { autor: 'usuario', texto: respuesta }, { pregunta: null, pregunta_llamada: null, ...extra });
    auditar(this.ctx.db, { accion: 'tarea.respondida', usuarioId: actor.id, proyectoId: t.proyecto_id, detalle: { tareaId: id }, ip: actor.ip });
    this.encolar(id);
    return this.obtener(actor, id);
  }

  listar(actor: Actor, proyectoId?: string): TareaPublica[] {
    const filas = (
      proyectoId
        ? this.ctx.db.prepare(`${CONSULTA} WHERE t.usuario_id = ? AND t.proyecto_id = ? ORDER BY t.creada_en DESC LIMIT 100`).all(actor.id, proyectoId)
        : this.ctx.db.prepare(`${CONSULTA} WHERE t.usuario_id = ? ORDER BY t.creada_en DESC LIMIT 100`).all(actor.id)
    ) as unknown as FilaTarea[];
    return filas.map((f) => this.aPublica(f));
  }

  obtener(actor: Actor, id: string): TareaPublica {
    return this.aPublica(this.fila(actor.id, id));
  }

  eventos(actor: Actor, id: string, desde = 0): EventoTiempoReal[] {
    this.fila(actor.id, id);
    return this.bus.deTarea(actor.id, id, desde);
  }

  /** Registro de propuestas, revisiones y decisiones de la tarea, con el agente responsable. */
  decisiones(actor: Actor, id: string): DecisionPublica[] {
    this.fila(actor.id, id);
    const filas = this.ctx.db
      .prepare(
        `SELECT d.id, d.tipo, d.agente_id, a.nombre AS agente_nombre, d.ronda, d.contenido, d.datos, d.fecha
         FROM decisiones d LEFT JOIN agentes a ON a.id = d.agente_id WHERE d.tarea_id = ? ORDER BY d.id`,
      )
      .all(id) as { id: number; tipo: TipoDecision; agente_id: string | null; agente_nombre: string | null; ronda: number; contenido: string; datos: string | null; fecha: string }[];
    return filas.map((f) => ({
      id: f.id,
      tipo: f.tipo,
      agenteId: f.agente_id,
      agenteNombre: f.agente_nombre,
      ronda: f.ronda,
      contenido: f.contenido,
      datos: leerJson<Record<string, unknown> | null>(f.datos, null),
      fecha: f.fecha,
    }));
  }

  /** Al arrancar: las tareas que quedaron a medias se marcan como pausadas (reanudables). */
  recuperarAlIniciar(): number {
    const r = this.ctx.db
      .prepare(
        "UPDATE tareas SET estado = 'pausada', error = 'Interrumpida por un reinicio del servidor. Puedes reanudarla.', actualizada_en = ? WHERE estado IN ('en_cola','ejecutando')",
      )
      .run(this.ctx.ahora().toISOString());
    return Number(r.changes);
  }

  /** Detiene las ejecuciones en curso dejándolas pausadas (apagado ordenado). */
  async detener(): Promise<void> {
    this.cola.length = 0;
    for (const e of this.enCurso.values()) {
      e.motivo = 'apagado';
      e.control.abort();
    }
    await this.esperarInactividad();
  }

  async limpiarProyecto(proyectoId: string): Promise<void> {
    await rm(path.dirname(this.git.dirRepo(proyectoId)), { recursive: true, force: true });
  }

  /** Resuelve cuando no hay tareas en ejecución ni en cola (útil en pruebas y apagado). */
  esperarInactividad(): Promise<void> {
    if (this.enCurso.size === 0 && this.cola.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.inactivo.push(resolve));
  }

  // -------------------------------------------------------------------------
  // Cola
  // -------------------------------------------------------------------------

  private encolar(id: string): void {
    if (!this.cola.includes(id) && !this.enCurso.has(id)) this.cola.push(id);
    this.bombear();
  }

  private quitarDeCola(id: string): void {
    const i = this.cola.indexOf(id);
    if (i >= 0) this.cola.splice(i, 1);
  }

  private bombear(): void {
    while (this.enCurso.size < this.op.maxSimultaneas && this.cola.length) {
      const id = this.cola.shift()!;
      const control = new AbortController();
      this.enCurso.set(id, { control, motivo: null });
      void this.ejecutar(id, control)
        .catch((err) => this.ctx.log.error({ err, tareaId: id }, 'Error no controlado en la tarea'))
        .finally(() => {
          this.enCurso.delete(id);
          this.bombear();
        });
    }
    if (this.enCurso.size === 0 && this.cola.length === 0) {
      const esperando = this.inactivo;
      this.inactivo = [];
      esperando.forEach((r) => r());
    }
  }

  // -------------------------------------------------------------------------
  // Ejecución
  // -------------------------------------------------------------------------

  private async ejecutar(id: string, control: AbortController): Promise<void> {
    const inicial = this.ctx.db.prepare('SELECT usuario_id FROM tareas WHERE id = ?').get(id) as { usuario_id: string } | undefined;
    if (!inicial) return;
    const usuarioId = inicial.usuario_id;
    let t = this.fila(usuarioId, id);
    const actor: Actor = { id: usuarioId, rol: 'usuario', ip: null };
    const inicio = Date.now();
    const msPrevios = t.ms_ejecucion;
    let temporizador: NodeJS.Timeout | undefined;

    const reanudando = t.iniciada_en !== null;
    this.cambiarEstado(t, 'ejecutando', reanudando ? 'task.resumed' : 'task.started', { agente: t.agente_nombre, rama: t.rama }, {
      iniciada_en: t.iniciada_en ?? this.ctx.ahora().toISOString(),
      error: null,
    });

    try {
      const proyecto = this.s.proyectos.paraEjecucion(usuarioId, t.proyecto_id);
      const principal = this.s.agentes.obtener(actor, t.agente_id);
      if (!principal.activo) throw new FinEjecucion('pausada', `El agente "${principal.nombre}" está desactivado; actívalo para continuar.`);

      // Límite de tiempo acumulado (en colaboración, el del coordinador para toda la tarea).
      const restanteMs = principal.limites.maxMinutosPorTarea * 60_000 - msPrevios;
      if (restanteMs <= 0) throw new FinEjecucion('fallida', 'Se alcanzó el límite de tiempo del agente para esta tarea.');
      temporizador = setTimeout(() => {
        const e = this.enCurso.get(id);
        if (e) {
          e.motivo = 'tiempo';
          e.control.abort();
        }
      }, restanteMs);

      this.emitir(t, 'agent.step', { paso: 'preparando', mensaje: 'Sincronizando el repositorio en el servidor…' });
      await this.git.sincronizar(proyecto.id, proyecto.repositorio, proyecto.token);
      const dir = await this.git.prepararTarea(proyecto.id, t.id, t.rama, proyecto.ramaBase);

      if (t.modo === 'colaborativo') await this.ejecutarColaborativa(t, actor, proyecto, principal, dir, control.signal);
      else await this.ejecutarIndividual(t, proyecto, principal, dir, control.signal);
    } catch (err) {
      t = this.fila(usuarioId, id);
      const motivo = this.enCurso.get(id)?.motivo ?? null;
      if (motivo === 'pausa' || motivo === 'apagado') {
        this.cambiarEstado(t, 'pausada', 'task.paused', {}, motivo === 'apagado' ? { error: 'Detenida por apagado del servidor. Puedes reanudarla.' } : {});
      } else if (motivo === 'cancelacion') {
        this.cambiarEstado(t, 'cancelada', 'task.cancelled', {}, { terminada_en: this.ctx.ahora().toISOString() });
      } else if (motivo === 'tiempo') {
        this.fallar(t, 'Se alcanzó el límite de tiempo del agente para esta tarea.');
      } else if (err instanceof FinEjecucion) {
        if (err.estado === 'pausada') this.cambiarEstado(t, 'pausada', 'task.paused', { motivo: err.message }, { error: err.message });
        else this.fallar(t, err.message);
      } else if (err instanceof ErrorProveedor && err.temporal) {
        this.cambiarEstado(t, 'pausada', 'task.paused', { motivo: err.message }, { error: `${err.message} Puedes reanudarla más tarde.` });
      } else if (err instanceof ErrorProveedor || err instanceof ErrorGit || err instanceof ErrorApp) {
        this.fallar(t, err.message);
      } else {
        this.ctx.log.error({ err, tareaId: id }, 'Fallo inesperado en la tarea');
        this.fallar(t, 'Error interno del orquestador. Revisa los registros del servidor.');
      }
    } finally {
      clearTimeout(temporizador);
      this.ctx.db.prepare('UPDATE tareas SET ms_ejecucion = ? WHERE id = ?').run(msPrevios + (Date.now() - inicio), id);
    }
  }

  /** Un solo agente trabaja en la rama de la tarea. */
  private async ejecutarIndividual(t: FilaTarea, proyecto: DatosProyecto, agente: AgentePublico, dir: string, senal: AbortSignal): Promise<void> {
    const cred = this.s.proveedores.credenciales(t.usuario_id, agente.proveedorId);
    const ejecutor = new EjecutorHerramientas(dir, agente.herramientas, {
      ejecutarValidacion: (nombre) => this.ejecutarValidacion(t, dir, proyecto.validaciones, nombre),
      commit: async (mensaje) => {
        const sha = await this.git.commit(dir, mensaje, `Agente ${agente.nombre}`);
        return { error: false, contenido: sha ? `Commit ${sha.slice(0, 7)} creado.` : 'No había cambios para hacer commit.' };
      },
    });
    const mensajes = leerJson<MensajeConversacion[]>(t.conversacion, []);
    if (mensajes.length === 0) {
      const listado = await ejecutor.ejecutar('listar_directorio', { ruta: '.' });
      mensajes.push({ rol: 'usuario', texto: promptInicial(t.objetivo, listado.error ? '(no disponible)' : listado.contenido) });
    }
    const archivos = new Set(leerJson<string[]>(t.archivos, []));

    const r = await ejecutarCiclo({
      adaptador: this.ctx.adaptadores(cred.tipo, cred),
      modelo: agente.modelo,
      sistema: promptSistema({
        agente,
        repositorio: proyecto.repositorio,
        rama: t.rama,
        ramaBase: proyecto.ramaBase,
        validaciones: proyecto.validaciones,
        sandboxDisponible: this.sandbox.disponible,
        motivoSandbox: this.sandbox.motivo,
      }),
      herramientas: herramientasPara(agente.herramientas),
      ejecutor,
      mensajes,
      senal,
      maxTurnos: this.op.maxTurnos,
      maxTokensRespuesta: this.op.maxTokensRespuesta,
      antesDeTurno: () => this.verificarLimites(t.id, t.usuario_id, agente, proyecto.limites.presupuestoMensualUsd),
      alUsar: (ent, sal) => this.registrarUso(t, cred.tipo, agente, ent, sal),
      emitir: (tipo, datos) => this.emitir(t, tipo, datos),
      guardar: (m) => this.guardarConversacion(t.id, m, [...archivos]),
      alModificarArchivo: (ruta) => archivos.add(ruta),
      alErrorInterno: (err) => this.ctx.log.error({ err, tareaId: t.id }, 'Error ejecutando herramienta'),
    });

    if (r.tipo === 'pregunta') {
      this.cambiarEstado(t, 'esperando_usuario', 'task.waiting', { pregunta: r.texto }, { pregunta: r.texto, pregunta_llamada: r.id });
      return;
    }
    await this.finalizar(t, dir, proyecto, agente, r.texto, archivos);
  }

  /** Equipo de agentes: propuestas, revisión, plan del coordinador, subtareas paralelas e integración. */
  private async ejecutarColaborativa(
    t: FilaTarea,
    actor: Actor,
    proyecto: DatosProyecto,
    coordinador: AgentePublico,
    dir: string,
    senal: AbortSignal,
  ): Promise<void> {
    const config = leerJson<ConfigColaboracion>(t.colaboracion, { coordinadorId: coordinador.id, participantes: [], maxRondas: 0 });
    const participantes = config.participantes.map((id) => this.s.agentes.obtener(actor, id));
    const inactivo = participantes.find((a) => !a.activo);
    if (inactivo) throw new FinEjecucion('pausada', `El agente "${inactivo.nombre}" está desactivado; actívalo para continuar.`);

    const listado = await new EjecutorHerramientas(dir, ['leer_archivos'], {
      ejecutarValidacion: async () => ({ error: true, contenido: '' }),
      commit: async () => ({ error: true, contenido: '' }),
    }).ejecutar('listar_directorio', { ruta: '.' });

    const colaboracion = new Colaboracion({
      ctx: this.ctx,
      git: this.git,
      tarea: { id: t.id, objetivo: t.objetivo, rama: t.rama },
      proyecto,
      coordinador,
      participantes,
      maxRondas: config.maxRondas,
      dirIntegracion: dir,
      senal,
      maxTurnos: this.op.maxTurnos,
      maxTokensRespuesta: this.op.maxTokensRespuesta,
      sandbox: this.infoSandbox,
      adaptadorPara: (a) => {
        const cred = this.s.proveedores.credenciales(t.usuario_id, a.proveedorId);
        return this.ctx.adaptadores(cred.tipo, cred);
      },
      emitir: (tipo, datos, agenteId) => this.emitir(t, tipo, datos, agenteId),
      registrarUso: (a, ent, sal) => this.registrarUso(t, this.s.proveedores.credenciales(t.usuario_id, a.proveedorId).tipo, a, ent, sal),
      verificarLimites: (a) => {
        this.verificarLimites(t.id, t.usuario_id, a, proyecto.limites.presupuestoMensualUsd);
        // Tope global de la tarea: el costo máximo del coordinador.
        const f = this.fila(t.usuario_id, t.id);
        if (f.costo_usd !== null && f.costo_usd >= coordinador.limites.maxCostoUsdPorTarea) {
          throw new FinEjecucion('fallida', `Se alcanzó el límite de costo de la tarea (${coordinador.limites.maxCostoUsdPorTarea} USD, estimado).`);
        }
      },
      ejecutarValidacion: (d, nombre) => this.ejecutarValidacion(t, d, proyecto.validaciones, nombre),
      cambiarFase: (fase) => {
        this.ctx.db.prepare('UPDATE tareas SET fase = ? WHERE id = ?').run(fase, t.id);
        this.emitir(t, 'agent.step', { fase, mensaje: `Fase: ${fase}` });
      },
      alErrorInterno: (err) => this.ctx.log.error({ err, tareaId: t.id }, 'Error en la colaboración'),
    });

    const r = await colaboracion.ejecutar(listado.error ? '(no disponible)' : listado.contenido);
    if (r.tipo === 'pregunta') {
      this.cambiarEstado(t, 'esperando_usuario', 'task.waiting', { pregunta: r.texto }, { pregunta: r.texto, pregunta_llamada: r.llamada });
      return;
    }
    await this.finalizar(t, dir, proyecto, coordinador, r.resumen, new Set());
  }

  /** Cierra la tarea: validaciones configuradas, commit final y resumen. */
  private async finalizar(t: FilaTarea, dir: string, proyecto: DatosProyecto, agente: AgentePublico, resumen: string, archivos: Set<string>): Promise<void> {
    this.emitir(t, 'agent.step', { paso: 'validando', mensaje: 'Ejecutando las validaciones del proyecto…' });
    for (const v of proyecto.validaciones) await this.ejecutarValidacion(t, dir, proyecto.validaciones, v.nombre);

    const sha = await this.git.commit(dir, `${t.objetivo.split('\n')[0]!.slice(0, 72)}\n\nTarea ${t.id} · agente ${agente.nombre}`, `Agente ${agente.nombre}`);
    const cambiados = await this.git.archivosCambiados(dir, proyecto.ramaBase);
    for (const a of archivos) if (!cambiados.includes(a)) cambiados.push(a);

    const final = this.fila(t.usuario_id, t.id);
    this.cambiarEstado(final, 'completada', 'task.completed', { resumen: resumen.slice(0, 4000), archivos: cambiados, commit: sha }, {
      resumen,
      archivos: JSON.stringify(cambiados.sort()),
      terminada_en: this.ctx.ahora().toISOString(),
    });
    // Nada se publica sin aprobación: se crea la solicitud para que el usuario revise el diff.
    if (cambiados.length) this.alCompletarConCambios(t.id);
  }

  private async ejecutarValidacion(
    t: FilaTarea,
    dir: string,
    validaciones: { nombre: string; comando: string; requiereRed: boolean }[],
    nombre: string,
  ): Promise<ResultadoHerramienta> {
    const v = validaciones.find((x) => x.nombre === nombre);
    if (!v) return { error: true, contenido: `No existe la validación "${nombre}". Disponibles: ${validaciones.map((x) => x.nombre).join(', ') || 'ninguna'}.` };

    let resultado: ResultadoValidacion;
    if (!this.sandbox.disponible) {
      resultado = { nombre, comando: v.comando, estado: 'no_ejecutada', codigoSalida: null, duracionMs: null, salida: this.sandbox.motivo ?? '' };
    } else {
      const r = await this.sandbox.ejecutar(dir, v.comando, { red: v.requiereRed, timeoutMs: this.op.timeoutValidacionMs });
      resultado = {
        nombre,
        comando: v.comando,
        estado: r.codigo === 0 && !r.expirado ? 'exitosa' : 'fallida',
        codigoSalida: r.codigo,
        duracionMs: r.duracionMs,
        salida: (r.expirado ? '[Tiempo máximo excedido]\n' : '') + r.salida.slice(-4000),
      };
    }
    const actual = this.fila(t.usuario_id, t.id);
    const lista = leerJson<ResultadoValidacion[]>(actual.validaciones, []).filter((x) => x.nombre !== nombre);
    lista.push(resultado);
    this.ctx.db.prepare('UPDATE tareas SET validaciones = ? WHERE id = ?').run(JSON.stringify(lista), t.id);
    this.emitir(t, 'validation.result', { ...resultado, salida: resultado.salida.slice(-1500) });

    const estado = { exitosa: 'EXITOSA', fallida: 'FALLIDA', no_ejecutada: 'NO EJECUTADA' }[resultado.estado];
    return {
      error: resultado.estado !== 'exitosa',
      contenido: `Validación "${nombre}": ${estado}${resultado.codigoSalida !== null ? ` (código ${resultado.codigoSalida})` : ''}\n${resultado.salida}`,
    };
  }

  // -------------------------------------------------------------------------
  // Límites y consumo
  // -------------------------------------------------------------------------

  /** Lanza si el agente superó sus límites en esta tarea o si se agotó el presupuesto mensual del proyecto. */
  private verificarLimites(tareaId: string, usuarioId: string, agente: AgentePublico, presupuestoMensual: number): void {
    const t = this.fila(usuarioId, tareaId);
    const uso = leerJson<Record<string, { entrada: number; salida: number; costo: number | null }>>(t.uso_agentes, {})[agente.id];
    const tokens = uso ? uso.entrada + uso.salida : 0;
    const l = agente.limites;
    if (tokens >= l.maxTokensPorTarea) {
      throw new FinEjecucion('fallida', `El agente "${agente.nombre}" alcanzó su límite de ${l.maxTokensPorTarea.toLocaleString('es-MX')} tokens.`);
    }
    if (uso?.costo != null && uso.costo >= l.maxCostoUsdPorTarea) {
      throw new FinEjecucion('fallida', `El agente "${agente.nombre}" alcanzó su límite de costo (${l.maxCostoUsdPorTarea} USD, estimado).`);
    }
    if (presupuestoMensual > 0 && this.gastoMensual(t.proyecto_id) >= presupuestoMensual) {
      throw new FinEjecucion('pausada', `Se agotó el presupuesto mensual del proyecto (${presupuestoMensual} USD, estimado).`);
    }
  }

  private verificarPresupuesto(usuarioId: string, proyectoId: string): void {
    const p = this.s.proyectos.paraEjecucion(usuarioId, proyectoId);
    if (p.limites.presupuestoMensualUsd > 0 && this.gastoMensual(proyectoId) >= p.limites.presupuestoMensualUsd) {
      throw new ErrorApp(409, 'PRESUPUESTO_AGOTADO', 'Se agotó el presupuesto mensual estimado del proyecto. Auméntalo en la configuración.');
    }
  }

  private gastoMensual(proyectoId: string): number {
    const ahora = this.ctx.ahora();
    const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1)).toISOString();
    const f = this.ctx.db
      .prepare('SELECT COALESCE(SUM(costo_usd), 0) AS total FROM tareas WHERE proyecto_id = ? AND creada_en >= ?')
      .get(proyectoId, inicioMes) as { total: number };
    return f.total;
  }

  /** Suma el consumo a la tarea y al agente; avisa una vez por agente al pasar el 80 % de sus tokens. */
  private registrarUso(t: FilaTarea, tipo: Parameters<typeof costoEstimado>[0], agente: AgentePublico, entrada: number, salida: number): void {
    const costo = costoEstimado(tipo, agente.modelo, entrada, salida);
    const actual = this.fila(t.usuario_id, t.id);
    const uso = leerJson<Record<string, { entrada: number; salida: number; costo: number | null; avisado?: boolean }>>(actual.uso_agentes, {});
    const previo = uso[agente.id] ?? { entrada: 0, salida: 0, costo: null };
    const nuevo = {
      entrada: previo.entrada + entrada,
      salida: previo.salida + salida,
      costo: costo === null ? previo.costo : (previo.costo ?? 0) + costo,
      avisado: previo.avisado,
    };
    const limite = agente.limites.maxTokensPorTarea;
    if (!nuevo.avisado && nuevo.entrada + nuevo.salida >= limite * 0.8) {
      nuevo.avisado = true;
      this.emitir(
        t,
        'budget.warning',
        {
          mensaje: `${agente.nombre} usó el ${Math.round(((nuevo.entrada + nuevo.salida) / limite) * 100)} % de sus tokens.`,
          tokens: nuevo.entrada + nuevo.salida,
          limite,
        },
        agente.id,
      );
    }
    uso[agente.id] = nuevo;
    this.ctx.db
      .prepare(
        `UPDATE tareas SET tokens_entrada = tokens_entrada + ?, tokens_salida = tokens_salida + ?, uso_agentes = ?,
           costo_usd = CASE WHEN ? IS NULL THEN costo_usd ELSE COALESCE(costo_usd, 0) + ? END WHERE id = ?`,
      )
      .run(entrada, salida, JSON.stringify(uso), costo, costo, t.id);
  }

  // -------------------------------------------------------------------------
  // Ayudantes
  // -------------------------------------------------------------------------

  private elegirAgente(actor: Actor, activos: { agenteId: string; rol: string }[], agenteId?: string): AgentePublico {
    if (agenteId) {
      if (!activos.some((a) => a.agenteId === agenteId)) {
        throw new ErrorApp(409, 'AGENTE_NO_HABILITADO', 'Ese agente no está habilitado y activo en este proyecto.');
      }
      return this.s.agentes.obtener(actor, agenteId);
    }
    const elegido = activos.find((a) => a.rol === 'desarrollador') ?? activos[0];
    if (!elegido) throw new ErrorApp(409, 'SIN_AGENTES', 'Habilita al menos un agente activo en este proyecto.');
    return this.s.agentes.obtener(actor, elegido.agenteId);
  }

  private guardarConversacion(id: string, mensajes: MensajeConversacion[], archivos?: string[]): void {
    this.ctx.db
      .prepare('UPDATE tareas SET conversacion = ?, archivos = COALESCE(?, archivos), actualizada_en = ? WHERE id = ?')
      .run(JSON.stringify(mensajes), archivos ? JSON.stringify(archivos) : null, this.ctx.ahora().toISOString(), id);
  }

  private fallar(t: FilaTarea, mensaje: string): void {
    this.cambiarEstado(t, 'fallida', 'task.failed', { error: mensaje }, { error: mensaje, terminada_en: this.ctx.ahora().toISOString() });
  }

  private cambiarEstado(
    t: FilaTarea,
    estado: EstadoTarea,
    evento: TipoEvento | null,
    datos: Record<string, unknown>,
    extra: Partial<Record<'error' | 'pregunta' | 'pregunta_llamada' | 'conversacion' | 'resumen' | 'archivos' | 'iniciada_en' | 'terminada_en', string | null>> = {},
  ): void {
    const campos = Object.keys(extra);
    this.ctx.db
      .prepare(`UPDATE tareas SET estado = ?, actualizada_en = ?${campos.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`)
      .run(estado, this.ctx.ahora().toISOString(), ...campos.map((c) => extra[c as keyof typeof extra] ?? null), t.id);
    if (evento) this.emitir(t, evento, { estado, ...datos });
    else this.emitir(t, 'agent.step', { estado, paso: estado });
  }

  private emitir(
    t: Pick<FilaTarea, 'id' | 'usuario_id' | 'proyecto_id' | 'agente_id'>,
    tipo: TipoEvento,
    datos: Record<string, unknown>,
    agenteId?: string,
  ): void {
    this.bus.publicar({ usuarioId: t.usuario_id, proyectoId: t.proyecto_id, tareaId: t.id, agenteId: agenteId ?? t.agente_id, tipo, datos });
  }

  private fila(usuarioId: string, id: string): FilaTarea {
    const f = this.ctx.db.prepare(`${CONSULTA} WHERE t.id = ? AND t.usuario_id = ?`).get(id, usuarioId) as FilaTarea | undefined;
    if (!f) throw noEncontrado('Tarea no encontrada');
    return f;
  }

  private aPublica(f: FilaTarea): TareaPublica {
    let colaboracion: ColaboracionPublica | null = null;
    if (f.modo === 'colaborativo') {
      const config = leerJson<ConfigColaboracion>(f.colaboracion, { coordinadorId: f.agente_id, participantes: [], maxRondas: 0 });
      const nombres = new Map(
        (this.ctx.db.prepare(`SELECT id, nombre FROM agentes WHERE usuario_id = ?`).all(f.usuario_id) as { id: string; nombre: string }[]).map((a) => [a.id, a.nombre]),
      );
      const subtareas = this.ctx.db.prepare('SELECT * FROM subtareas WHERE tarea_id = ? ORDER BY indice').all(f.id) as {
        id: string;
        indice: number;
        titulo: string;
        descripcion: string;
        agente_id: string;
        archivos: string;
        depende_de: string;
        estado: EstadoSubtarea;
        rama: string;
        resumen: string | null;
        error: string | null;
      }[];
      colaboracion = {
        coordinadorId: config.coordinadorId,
        participantes: config.participantes.map((id) => ({ id, nombre: nombres.get(id) ?? 'Agente eliminado' })),
        maxRondas: config.maxRondas,
        fase: f.fase,
        decision: f.decision,
        subtareas: subtareas.map((s) => ({
          id: s.id,
          indice: s.indice,
          titulo: s.titulo,
          descripcion: s.descripcion,
          agenteId: s.agente_id,
          agenteNombre: nombres.get(s.agente_id) ?? 'Agente',
          archivos: leerJson<string[]>(s.archivos, []),
          dependeDe: leerJson<number[]>(s.depende_de, []),
          estado: s.estado,
          rama: s.rama,
          resumen: s.resumen,
          error: s.error,
        })),
      };
    }
    return {
      id: f.id,
      proyectoId: f.proyecto_id,
      proyectoNombre: f.proyecto_nombre,
      agenteId: f.agente_id,
      agenteNombre: f.agente_nombre,
      modo: f.modo,
      colaboracion,
      objetivo: f.objetivo,
      estado: f.estado,
      rama: f.rama,
      pregunta: f.pregunta,
      resumen: f.resumen,
      error: f.error,
      archivosModificados: leerJson<string[]>(f.archivos, []),
      validaciones: leerJson<ResultadoValidacion[]>(f.validaciones, []),
      publicacion: leerJson<PublicacionTarea | null>(f.publicacion, null),
      avance: avanceDeTarea(this.ctx.db, f),
      uso: { tokensEntrada: f.tokens_entrada, tokensSalida: f.tokens_salida, costoUsd: f.costo_usd },
      creadaEn: f.creada_en,
      iniciadaEn: f.iniciada_en,
      terminadaEn: f.terminada_en,
    };
  }
}
