import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  ESTADOS_REANUDABLES,
  type AgentePublico,
  type EstadoTarea,
  type EventoTiempoReal,
  type ResultadoValidacion,
  type SolicitudContinuar,
  type TareaPublica,
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
import { ErrorGit, type EspaciosGit } from './git';
import { EjecutorHerramientas, HERRAMIENTA_PREGUNTA, herramientasPara, type ResultadoHerramienta } from './herramientas';
import { promptInicial, promptSistema } from './politicas';
import type { Sandbox } from './sandbox';

export interface OpcionesOrquestador {
  /** Tareas ejecutándose a la vez en todo el servidor. */
  maxSimultaneas: number;
  /** Turnos máximos de conversación por ejecución (evita ciclos infinitos). */
  maxTurnos: number;
  /** Tokens máximos por respuesta del modelo. */
  maxTokensRespuesta: number;
  /** Tiempo máximo de cada validación. */
  timeoutValidacionMs: number;
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
  ms_ejecucion: number;
  creada_en: string;
  iniciada_en: string | null;
  terminada_en: string | null;
}

type Motivo = 'pausa' | 'cancelacion' | 'tiempo' | 'apagado';

/** Termina la ejecución con un estado final o de espera, sin tratarlo como error inesperado. */
class FinEjecucion extends Error {
  constructor(
    readonly estado: EstadoTarea,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

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

/** Resume la entrada de una herramienta para el evento (sin volcar contenidos completos). */
function resumirEntrada(entrada: unknown): Record<string, unknown> {
  if (!entrada || typeof entrada !== 'object') return {};
  return Object.fromEntries(
    Object.entries(entrada as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? (v.length > 200 ? `${v.slice(0, 200)}… (${v.length} caracteres)` : v) : v,
    ]),
  );
}

export class Orquestador {
  private readonly enCurso = new Map<string, { control: AbortController; motivo: Motivo | null }>();
  private readonly cola: string[] = [];
  private inactivo: (() => void)[] = [];

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

  /** "Continuar proyecto": reanuda la tarea pausada o crea una nueva con el objetivo dado. */
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

    const agente = this.elegirAgente(actor, proyecto.agentes, sol.agenteId);
    this.verificarPresupuesto(actor.id, proyectoId);

    const id = randomUUID();
    const ahora = this.ctx.ahora().toISOString();
    const rama = `agentes/${slug(sol.objetivo)}-${id.slice(0, 6)}`;
    this.ctx.db
      .prepare(
        `INSERT INTO tareas (id, usuario_id, proyecto_id, agente_id, objetivo, estado, rama, creada_en, actualizada_en)
         VALUES (?, ?, ?, ?, ?, 'en_cola', ?, ?, ?)`,
      )
      .run(id, actor.id, proyectoId, agente.id, sol.objetivo, rama, ahora, ahora);
    auditar(this.ctx.db, { accion: 'tarea.creada', usuarioId: actor.id, proyectoId, agenteId: agente.id, detalle: { tareaId: id, rama }, ip: actor.ip });
    this.emitir(this.fila(actor.id, id), 'task.created', { objetivo: sol.objetivo, rama, agente: agente.nombre });
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

  /** Entrega la respuesta del usuario a la pregunta pendiente del agente y reanuda. */
  responder(actor: Actor, id: string, respuesta: string): TareaPublica {
    const t = this.fila(actor.id, id);
    if (t.estado !== 'esperando_usuario' || !t.pregunta_llamada) {
      throw new ErrorApp(409, 'ESTADO_INVALIDO', 'La tarea no está esperando una respuesta.');
    }
    const mensajes = leerJson<MensajeConversacion[]>(t.conversacion, []);
    const ultimo = mensajes.at(-1);
    const resultado = { id: t.pregunta_llamada, contenido: `Respuesta del usuario: ${respuesta}`, error: false };
    // Todos los resultados de un turno van en un solo mensaje.
    if (ultimo?.rol === 'resultados') ultimo.resultados.push(resultado);
    else mensajes.push({ rol: 'resultados', resultados: [resultado] });

    this.cambiarEstado(t, 'en_cola', 'agent.message', { autor: 'usuario', texto: respuesta }, {
      pregunta: null,
      pregunta_llamada: null,
      conversacion: JSON.stringify(mensajes),
    });
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
    return filas.map(aPublica);
  }

  obtener(actor: Actor, id: string): TareaPublica {
    return aPublica(this.fila(actor.id, id));
  }

  eventos(actor: Actor, id: string, desde = 0): EventoTiempoReal[] {
    this.fila(actor.id, id);
    return this.bus.deTarea(actor.id, id, desde);
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
  // Ejecución de una tarea
  // -------------------------------------------------------------------------

  private async ejecutar(id: string, control: AbortController): Promise<void> {
    const inicial = this.ctx.db.prepare('SELECT usuario_id FROM tareas WHERE id = ?').get(id) as { usuario_id: string } | undefined;
    if (!inicial) return;
    const usuarioId = inicial.usuario_id;
    let t = this.fila(usuarioId, id);
    const actor: Actor = { id: usuarioId, rol: 'usuario', ip: null };
    const inicio = Date.now();
    let msAcumulados = t.ms_ejecucion;
    let temporizador: NodeJS.Timeout | undefined;

    const reanudando = leerJson<MensajeConversacion[]>(t.conversacion, []).length > 0;
    this.cambiarEstado(t, 'ejecutando', reanudando ? 'task.resumed' : 'task.started', { agente: t.agente_nombre, rama: t.rama }, {
      iniciada_en: t.iniciada_en ?? this.ctx.ahora().toISOString(),
      error: null,
    });

    try {
      const proyecto = this.s.proyectos.paraEjecucion(usuarioId, t.proyecto_id);
      const agente = this.s.agentes.obtener(actor, t.agente_id);
      if (!agente.activo) throw new FinEjecucion('pausada', `El agente "${agente.nombre}" está desactivado; actívalo para continuar.`);
      const cred = this.s.proveedores.credenciales(usuarioId, agente.proveedorId);

      // Límite de tiempo acumulado del agente.
      const restanteMs = agente.limites.maxMinutosPorTarea * 60_000 - msAcumulados;
      if (restanteMs <= 0) throw new FinEjecucion('fallida', 'Se alcanzó el límite de tiempo del agente para esta tarea.');
      temporizador = setTimeout(() => {
        const e = this.enCurso.get(id);
        if (e) {
          e.motivo = 'tiempo';
          e.control.abort();
        }
      }, restanteMs);

      const dir = await this.prepararEspacio(t, proyecto);
      const validar = (nombre: string) => this.ejecutarValidacion(t, dir, proyecto.validaciones, nombre);
      const ejecutor = new EjecutorHerramientas(dir, agente.herramientas, {
        ejecutarValidacion: validar,
        commit: async (mensaje) => {
          const sha = await this.git.commit(dir, mensaje, `Agente ${agente.nombre}`);
          return { error: false, contenido: sha ? `Commit ${sha.slice(0, 7)} creado.` : 'No había cambios para hacer commit.' };
        },
      });
      const adaptador = this.ctx.adaptadores(cred.tipo, cred);
      const herramientas = herramientasPara(agente.herramientas);
      const sistema = promptSistema({
        agente,
        repositorio: proyecto.repositorio,
        rama: t.rama,
        ramaBase: proyecto.ramaBase,
        validaciones: proyecto.validaciones,
        sandboxDisponible: this.sandbox.disponible,
        motivoSandbox: this.sandbox.motivo,
      });

      const mensajes = leerJson<MensajeConversacion[]>(t.conversacion, []);
      if (mensajes.length === 0) {
        const listado = await ejecutor.ejecutar('listar_directorio', { ruta: '.' });
        mensajes.push({ rol: 'usuario', texto: promptInicial(t.objetivo, listado.error ? '(no disponible)' : listado.contenido) });
      }
      const archivos = new Set(leerJson<string[]>(t.archivos, []));
      let avisoPresupuesto = false;

      for (let turno = 1; ; turno++) {
        if (turno > this.op.maxTurnos) throw new FinEjecucion('fallida', `Se alcanzó el máximo de ${this.op.maxTurnos} turnos sin terminar.`);
        t = this.fila(usuarioId, id);
        this.verificarLimites(t, agente, proyecto.limites.presupuestoMensualUsd);

        const r = await adaptador.turno({
          modelo: agente.modelo,
          sistema,
          mensajes,
          herramientas,
          maxTokens: this.op.maxTokensRespuesta,
          senal: control.signal,
        });
        this.registrarUso(t, cred.tipo, agente.modelo, r.uso.entrada, r.uso.salida);
        const usados = t.tokens_entrada + t.tokens_salida + r.uso.entrada + r.uso.salida;
        if (!avisoPresupuesto && usados >= agente.limites.maxTokensPorTarea * 0.8) {
          avisoPresupuesto = true;
          this.emitir(t, 'budget.warning', {
            mensaje: `La tarea usó el ${Math.round((usados / agente.limites.maxTokensPorTarea) * 100)} % de sus tokens.`,
            tokens: usados,
            limite: agente.limites.maxTokensPorTarea,
          });
        }
        if (r.mensaje.texto) this.emitir(t, 'agent.message', { autor: 'agente', texto: r.mensaje.texto });

        if (r.fin === 'rechazo') throw new FinEjecucion('fallida', 'El modelo rechazó continuar con la solicitud.');
        if (r.fin === 'limite_tokens') {
          throw new FinEjecucion('fallida', 'La respuesta del modelo se cortó por el límite de tokens por respuesta.');
        }
        if (r.mensaje.llamadas.length === 0) {
          mensajes.push(r.mensaje);
          this.guardarConversacion(id, mensajes);
          await this.finalizar(t, dir, proyecto, agente, r.mensaje.texto, archivos);
          return;
        }

        // Ejecuta las herramientas; una pregunta al usuario se atiende al final del turno.
        const resultados: { id: string; contenido: string; error: boolean }[] = [];
        let pregunta: { id: string; texto: string } | null = null;
        for (const ll of r.mensaje.llamadas) {
          if (control.signal.aborted) break;
          if (ll.nombre === HERRAMIENTA_PREGUNTA) {
            const texto = (ll.entrada as { pregunta?: unknown })?.pregunta;
            if (typeof texto === 'string' && texto.trim()) {
              pregunta = { id: ll.id, texto: texto.trim().slice(0, 2000) };
              continue;
            }
            resultados.push({ id: ll.id, contenido: 'Falta el texto de la pregunta.', error: true });
            continue;
          }
          this.emitir(t, 'tool.call', { herramienta: ll.nombre, entrada: resumirEntrada(ll.entrada) });
          let res: ResultadoHerramienta;
          try {
            res = await ejecutor.ejecutar(ll.nombre, ll.entrada);
          } catch (err) {
            this.ctx.log.error({ err, tareaId: id }, 'Error ejecutando herramienta');
            res = { error: true, contenido: 'Error interno al ejecutar la herramienta.' };
          }
          this.emitir(t, 'tool.result', { herramienta: ll.nombre, error: res.error, resumen: res.contenido.slice(0, 500) });
          if (res.archivoModificado) {
            archivos.add(res.archivoModificado);
            this.emitir(t, 'file.changed', { ruta: res.archivoModificado });
          }
          resultados.push({ id: ll.id, contenido: res.contenido, error: res.error });
        }
        if (control.signal.aborted) throw control.signal.reason ?? new Error('abortado');

        // Punto consistente: el turno del asistente y sus resultados se guardan juntos.
        mensajes.push(r.mensaje);
        if (resultados.length) mensajes.push({ rol: 'resultados', resultados });
        this.guardarConversacion(id, mensajes, [...archivos]);

        if (pregunta) {
          this.cambiarEstado(t, 'esperando_usuario', 'task.waiting', { pregunta: pregunta.texto }, {
            pregunta: pregunta.texto,
            pregunta_llamada: pregunta.id,
          });
          return;
        }
      }
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
      msAcumulados += Date.now() - inicio;
      this.ctx.db.prepare('UPDATE tareas SET ms_ejecucion = ? WHERE id = ?').run(msAcumulados, id);
    }
  }

  private async prepararEspacio(
    t: FilaTarea,
    proyecto: ReturnType<ServicioProyectos['paraEjecucion']>,
  ): Promise<string> {
    this.emitir(t, 'agent.step', { paso: 'preparando', mensaje: 'Sincronizando el repositorio en el servidor…' });
    await this.git.sincronizar(proyecto.id, proyecto.repositorio, proyecto.token);
    return this.git.prepararTarea(proyecto.id, t.id, t.rama, proyecto.ramaBase);
  }

  /** Cierra la tarea: validaciones configuradas, commit final y resumen. */
  private async finalizar(
    t: FilaTarea,
    dir: string,
    proyecto: ReturnType<ServicioProyectos['paraEjecucion']>,
    agente: AgentePublico,
    resumen: string,
    archivos: Set<string>,
  ): Promise<void> {
    this.emitir(t, 'agent.step', { paso: 'validando', mensaje: 'Ejecutando las validaciones del proyecto…' });
    for (const v of proyecto.validaciones) await this.ejecutarValidacion(t, dir, proyecto.validaciones, v.nombre);

    const sha = await this.git.commit(dir, `${t.objetivo.split('\n')[0]!.slice(0, 72)}\n\nTarea ${t.id} · agente ${agente.nombre}`, `Agente ${agente.nombre}`);
    const cambiados = await this.git.archivosCambiados(dir, proyecto.ramaBase);
    for (const a of archivos) if (!cambiados.includes(a)) cambiados.push(a);

    const final = this.fila(t.usuario_id, t.id);
    this.cambiarEstado(final, 'completada', 'task.completed', { resumen, archivos: cambiados, commit: sha }, {
      resumen,
      archivos: JSON.stringify(cambiados.sort()),
      terminada_en: this.ctx.ahora().toISOString(),
    });
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
  // Límites
  // -------------------------------------------------------------------------

  /** Lanza si se superó algún límite de la tarea o el presupuesto mensual del proyecto. */
  private verificarLimites(t: FilaTarea, agente: AgentePublico, presupuestoMensual: number): void {
    const tokens = t.tokens_entrada + t.tokens_salida;
    const l = agente.limites;
    if (tokens >= l.maxTokensPorTarea) throw new FinEjecucion('fallida', `Se alcanzó el límite de ${l.maxTokensPorTarea.toLocaleString('es-MX')} tokens del agente.`);
    if (t.costo_usd !== null && t.costo_usd >= l.maxCostoUsdPorTarea) {
      throw new FinEjecucion('fallida', `Se alcanzó el límite de costo del agente (${l.maxCostoUsdPorTarea} USD, estimado).`);
    }
    const gastoMes = this.gastoMensual(t.proyecto_id);
    if (presupuestoMensual > 0 && gastoMes >= presupuestoMensual) {
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

  private registrarUso(t: FilaTarea, tipo: Parameters<typeof costoEstimado>[0], modelo: string, entrada: number, salida: number): void {
    const costo = costoEstimado(tipo, modelo, entrada, salida);
    this.ctx.db
      .prepare(
        `UPDATE tareas SET tokens_entrada = tokens_entrada + ?, tokens_salida = tokens_salida + ?,
           costo_usd = CASE WHEN ? IS NULL THEN costo_usd ELSE COALESCE(costo_usd, 0) + ? END WHERE id = ?`,
      )
      .run(entrada, salida, costo, costo, t.id);
  }

  // -------------------------------------------------------------------------
  // Ayudantes
  // -------------------------------------------------------------------------

  private elegirAgente(actor: Actor, habilitados: { agenteId: string; rol: string; activo: boolean }[], agenteId?: string): AgentePublico {
    const activos = habilitados.filter((a) => a.activo);
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
      .prepare(
        `UPDATE tareas SET estado = ?, actualizada_en = ?${campos.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`,
      )
      .run(estado, this.ctx.ahora().toISOString(), ...campos.map((c) => extra[c as keyof typeof extra] ?? null), t.id);
    if (evento) this.emitir(t, evento, { estado, ...datos });
    else this.emitir(t, 'agent.step', { estado, paso: estado });
  }

  private emitir(t: Pick<FilaTarea, 'id' | 'usuario_id' | 'proyecto_id' | 'agente_id'>, tipo: TipoEvento, datos: Record<string, unknown>): void {
    this.bus.publicar({ usuarioId: t.usuario_id, proyectoId: t.proyecto_id, tareaId: t.id, agenteId: t.agente_id, tipo, datos });
  }

  private fila(usuarioId: string, id: string): FilaTarea {
    const f = this.ctx.db.prepare(`${CONSULTA} WHERE t.id = ? AND t.usuario_id = ?`).get(id, usuarioId) as FilaTarea | undefined;
    if (!f) throw noEncontrado('Tarea no encontrada');
    return f;
  }
}

function aPublica(f: FilaTarea): TareaPublica {
  return {
    id: f.id,
    proyectoId: f.proyecto_id,
    proyectoNombre: f.proyecto_nombre,
    agenteId: f.agente_id,
    agenteNombre: f.agente_nombre,
    objetivo: f.objetivo,
    estado: f.estado,
    rama: f.rama,
    pregunta: f.pregunta,
    resumen: f.resumen,
    error: f.error,
    archivosModificados: leerJson<string[]>(f.archivos, []),
    validaciones: leerJson<ResultadoValidacion[]>(f.validaciones, []),
    uso: { tokensEntrada: f.tokens_entrada, tokensSalida: f.tokens_salida, costoUsd: f.costo_usd },
    creadaEn: f.creada_en,
    iniciadaEn: f.iniciada_en,
    terminadaEn: f.terminada_en,
  };
}
