import { randomUUID } from 'node:crypto';
import {
  MAX_SUBTAREAS,
  NOMBRE_ROL,
  type AgentePublico,
  type EstadoSubtarea,
  type FaseColaboracion,
  type IdHerramienta,
  type TipoDecision,
  type TipoEvento,
  type Validacion,
} from '@softgala/shared';
import { z } from 'zod';
import { ErrorProveedor, type AdaptadorModelos, type MensajeConversacion } from '../modelos/adaptadores';
import { leerJson, type Contexto } from '../servicios/contexto';
import { ejecutarCiclo, FinEjecucion, type HerramientaTerminal } from './ciclo';
import type { EspaciosGit } from './git';
import {
  EjecutorHerramientas,
  herramientasPara,
  normalizarRutaPlan,
  type AccionesOrquestador,
  type ResultadoHerramienta,
} from './herramientas';
import { promptPropuesta, promptRevision, promptSintesis, promptSistema, promptSubtarea, type Aporte } from './politicas';

export interface DatosProyecto {
  id: string;
  repositorio: string;
  ramaBase: string;
  validaciones: Validacion[];
  limites: { maxAgentesSimultaneos: number; presupuestoMensualUsd: number };
}

/** Lo que la colaboración necesita del orquestador. */
export interface EntornoColaboracion {
  ctx: Contexto;
  git: EspaciosGit;
  tarea: { id: string; objetivo: string; rama: string };
  proyecto: DatosProyecto;
  coordinador: AgentePublico;
  participantes: AgentePublico[];
  maxRondas: number;
  dirIntegracion: string;
  senal: AbortSignal;
  maxTurnos: number;
  maxTokensRespuesta: number;
  sandbox: { disponible: boolean; motivo: string | null };
  adaptadorPara(agente: AgentePublico): AdaptadorModelos;
  emitir(tipo: TipoEvento, datos: Record<string, unknown>, agenteId?: string): void;
  registrarUso(agente: AgentePublico, entrada: number, salida: number): void;
  verificarLimites(agente: AgentePublico): void;
  ejecutarValidacion(dir: string, nombre: string): Promise<ResultadoHerramienta>;
  cambiarFase(fase: FaseColaboracion): void;
  alErrorInterno(err: unknown): void;
}

export type ResultadoColaboracion =
  | { tipo: 'completada'; resumen: string }
  | { tipo: 'pregunta'; texto: string; llamada: string };

interface FilaSubtarea {
  id: string;
  indice: number;
  agente_id: string;
  titulo: string;
  descripcion: string;
  archivos: string;
  depende_de: string;
  estado: EstadoSubtarea;
  rama: string;
  conversacion: string;
  resumen: string | null;
  error: string | null;
  pregunta: string | null;
  pregunta_llamada: string | null;
}

interface FilaDecision {
  agente_id: string | null;
  tipo: TipoDecision;
  ronda: number;
  contenido: string;
  datos: string | null;
}

const LECTURA: IdHerramienta[] = ['leer_archivos', 'buscar_codigo'];
/** Prefijo de la llamada pendiente cuando pregunta un agente de una subtarea. */
export const PREFIJO_PREGUNTA_SUBTAREA = 'sub:';

// ---------------------------------------------------------------------------
// Herramientas terminales (entrega estructurada)
// ---------------------------------------------------------------------------

const esquemaPropuesta = z.object({ propuesta: z.string().trim().min(20, 'La propuesta es demasiado corta').max(20_000) });
const esquemaRevision = z.object({
  revision: z.string().trim().min(5).max(20_000),
  de_acuerdo: z.boolean(),
  propuesta_actualizada: z.string().trim().max(20_000).optional(),
});
const esquemaPlan = z.object({
  decision: z.string().trim().min(10, 'Explica la decisión').max(10_000),
  subtareas: z
    .array(
      z.object({
        agente: z.string().trim().min(1),
        titulo: z.string().trim().min(3).max(200),
        descripcion: z.string().trim().min(10).max(10_000),
        archivos: z.array(z.string().min(1).max(300)).min(1, 'Cada subtarea necesita archivos asignados').max(50),
      }),
    )
    .min(1, 'El plan necesita al menos una subtarea')
    .max(MAX_SUBTAREAS, `Máximo ${MAX_SUBTAREAS} subtareas`),
});

const terminal = <T>(nombre: string, descripcion: string, esquemaJson: Record<string, unknown>, esquema: z.ZodType<T>, extra?: (d: T) => string | null, obligatoria = false): HerramientaTerminal => ({
  definicion: { nombre, descripcion, esquema: esquemaJson },
  obligatoria,
  validar: (entrada) => {
    const r = esquema.safeParse(entrada);
    if (!r.success) return `Entrada no válida: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    return extra ? extra(r.data) : null;
  },
});

const TERMINAL_PROPUESTA = terminal(
  'entregar_propuesta',
  'Entrega tu propuesta final para el objetivo. Termina tu participación en esta fase.',
  { type: 'object', properties: { propuesta: { type: 'string' } }, required: ['propuesta'] },
  esquemaPropuesta,
);

const TERMINAL_REVISION = terminal(
  'entregar_revision',
  'Entrega tu revisión de las propuestas de los demás. Termina tu participación en esta ronda.',
  {
    type: 'object',
    properties: {
      revision: { type: 'string' },
      de_acuerdo: { type: 'boolean', description: 'true si no quedan desacuerdos importantes' },
      propuesta_actualizada: { type: 'string', description: 'Tu propuesta mejorada (opcional)' },
    },
    required: ['revision', 'de_acuerdo'],
  },
  esquemaRevision,
);

// ---------------------------------------------------------------------------

/** ¿Dos listas de archivos/carpetas se cruzan? (mismo archivo, o uno dentro de la carpeta del otro) */
export function seCruzan(a: string[], b: string[]): boolean {
  const cubre = (x: string, y: string) => x === y || (x.endsWith('/') && y.startsWith(x));
  return a.some((x) => b.some((y) => cubre(x, y) || cubre(y, x)));
}

/**
 * Valida el plan del coordinador y calcula dependencias: una subtarea depende de las anteriores
 * con las que comparte archivos, así nunca se ejecutan en paralelo cambios sobre lo mismo.
 */
export interface PlanValidado {
  decision: string;
  subtareas: { agente: AgentePublico; titulo: string; descripcion: string; archivos: string[]; dependeDe: number[] }[];
}

export function validarPlan(entrada: unknown, participantes: AgentePublico[]): { error: string } | { plan: PlanValidado } {
  const r = esquemaPlan.safeParse(entrada);
  if (!r.success) return { error: `Plan no válido: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  const subtareas: Omit<PlanValidado['subtareas'][number], 'dependeDe'>[] = [];
  for (const [i, s] of r.data.subtareas.entries()) {
    const agente = participantes.find((p) => p.nombre.toLowerCase() === s.agente.toLowerCase());
    if (!agente) {
      return { error: `Subtarea ${i + 1}: "${s.agente}" no es del equipo. Usa uno de: ${participantes.map((p) => p.nombre).join(', ')}.` };
    }
    const archivos: string[] = [];
    for (const a of s.archivos) {
      const n = normalizarRutaPlan(a);
      if (!n) return { error: `Subtarea ${i + 1}: la ruta "${a}" no es válida (usa rutas relativas, sin "..", ni .git).` };
      archivos.push(n);
    }
    subtareas.push({ titulo: s.titulo, descripcion: s.descripcion, agente, archivos: [...new Set(archivos)] });
  }
  const conDependencias = subtareas.map((s, i) => ({
    ...s,
    dependeDe: subtareas.slice(0, i).flatMap((o, j) => (seCruzan(o.archivos, s.archivos) ? [j + 1] : [])),
  }));
  return { plan: { decision: r.data.decision, subtareas: conDependencias } };
}

async function enParalelo<T>(elementos: T[], limite: number, fn: (e: T) => Promise<void>): Promise<void> {
  const cola = [...elementos];
  const errores: unknown[] = [];
  const trabajadores = Array.from({ length: Math.max(1, Math.min(limite, cola.length)) }, async () => {
    while (cola.length) {
      const e = cola.shift()!;
      try {
        await fn(e);
      } catch (err) {
        errores.push(err);
      }
    }
  });
  await Promise.all(trabajadores);
  if (errores.length) throw errores[0];
}

// ---------------------------------------------------------------------------

export class Colaboracion {
  private readonly db;
  private readonly nombres: Map<string, string>;

  constructor(private readonly e: EntornoColaboracion) {
    this.db = e.ctx.db;
    this.nombres = new Map([e.coordinador, ...e.participantes].map((a) => [a.id, a.nombre]));
  }

  async ejecutar(listado: string): Promise<ResultadoColaboracion> {
    const tieneplan = !!(this.db.prepare('SELECT decision FROM tareas WHERE id = ?').get(this.e.tarea.id) as { decision: string | null }).decision;
    if (!tieneplan) {
      this.e.cambiarFase('propuestas');
      await this.propuestas(listado);
      if (this.e.maxRondas > 0 && this.e.participantes.length > 1) {
        this.e.cambiarFase('revision');
        await this.revision();
      }
      this.e.cambiarFase('sintesis');
      await this.sintesis(listado);
    }
    this.e.cambiarFase('ejecucion');
    const pregunta = await this.ejecucion(listado);
    if (pregunta) return pregunta;
    this.e.cambiarFase('integracion');
    return { tipo: 'completada', resumen: this.resumenFinal() };
  }

  // ---- Fase 1: propuestas (en paralelo, solo lectura) ----------------------

  private async propuestas(listado: string): Promise<void> {
    const hechas = new Set(this.decisiones('propuesta').filter((d) => d.ronda === 0).map((d) => d.agente_id));
    const pendientes = this.e.participantes.filter((a) => !hechas.has(a.id));
    const equipo = this.e.participantes.map((p) => p.nombre);
    await enParalelo(pendientes, this.e.proyecto.limites.maxAgentesSimultaneos, async (agente) => {
      const r = await this.cicloLectura(agente, promptPropuesta(this.e.tarea.objetivo, listado, equipo), TERMINAL_PROPUESTA);
      const texto = r.tipo === 'terminal' ? (r.entrada as { propuesta: string }).propuesta : r.texto || '(el agente no entregó propuesta)';
      this.registrar('propuesta', agente.id, 0, texto);
      this.e.emitir('agent.proposal', { agente: agente.nombre, propuesta: texto.slice(0, 1500) }, agente.id);
    });
  }

  // ---- Fase 2: revisión cruzada con límite de rondas -----------------------

  private async revision(): Promise<void> {
    for (let ronda = 1; ronda <= this.e.maxRondas; ronda++) {
      const revisiones = this.decisiones('revision').filter((d) => d.ronda === ronda);
      const hechas = new Set(revisiones.map((d) => d.agente_id));
      const actuales = this.propuestasActuales();
      await enParalelo(
        this.e.participantes.filter((a) => !hechas.has(a.id)),
        this.e.proyecto.limites.maxAgentesSimultaneos,
        async (agente) => {
          const propia = actuales.find((p) => p.agenteId === agente.id)?.texto ?? '(sin propuesta)';
          const otras = actuales.filter((p) => p.agenteId !== agente.id).map((p) => ({ agente: p.agente, texto: p.texto }));
          const r = await this.cicloLectura(
            agente,
            promptRevision(this.e.tarea.objetivo, propia, otras, ronda, this.e.maxRondas),
            TERMINAL_REVISION,
          );
          const d =
            r.tipo === 'terminal'
              ? (r.entrada as z.infer<typeof esquemaRevision>)
              : { revision: r.texto || '(sin revisión)', de_acuerdo: false, propuesta_actualizada: undefined };
          this.registrar('revision', agente.id, ronda, d.revision, { de_acuerdo: d.de_acuerdo });
          if (d.propuesta_actualizada) this.registrar('propuesta', agente.id, ronda, d.propuesta_actualizada);
          this.e.emitir(
            'agent.review',
            { agente: agente.nombre, ronda, de_acuerdo: d.de_acuerdo, revision: d.revision.slice(0, 1500), actualizoPropuesta: !!d.propuesta_actualizada },
            agente.id,
          );
        },
      );
      const ronda_ = this.decisiones('revision').filter((d) => d.ronda === ronda);
      if (ronda_.every((d) => leerJson<{ de_acuerdo?: boolean }>(d.datos, {}).de_acuerdo)) {
        this.e.emitir('agent.step', { mensaje: `Consenso alcanzado en la ronda ${ronda}; se omiten las rondas restantes.` });
        return;
      }
    }
    this.e.emitir('agent.step', { mensaje: `Se completaron las ${this.e.maxRondas} ronda(s) de revisión; el coordinador resolverá los desacuerdos.` });
  }

  // ---- Fase 3: síntesis del coordinador ------------------------------------

  private async sintesis(listado: string): Promise<void> {
    const propuestas = this.propuestasActuales().map((p) => ({ agente: p.agente, texto: p.texto }));
    const ultimaRonda = Math.max(0, ...this.decisiones('revision').map((d) => d.ronda));
    const revisiones: Aporte[] = this.decisiones('revision')
      .filter((d) => d.ronda === ultimaRonda)
      .map((d) => ({ agente: this.nombre(d.agente_id), texto: d.contenido }));
    const equipo = this.e.participantes.map((p) => ({ nombre: p.nombre, rol: NOMBRE_ROL[p.rol] }));

    // Contenedor (y no variable suelta) porque el plan se captura dentro de validar().
    const capturado: { plan: PlanValidado | null } = { plan: null };
    const terminalPlan: HerramientaTerminal = {
      definicion: {
        nombre: 'registrar_plan',
        descripcion: 'Registra la decisión del coordinador y el plan de subtareas asignadas.',
        esquema: {
          type: 'object',
          properties: {
            decision: { type: 'string' },
            subtareas: {
              type: 'array',
              maxItems: MAX_SUBTAREAS,
              items: {
                type: 'object',
                properties: {
                  agente: { type: 'string' },
                  titulo: { type: 'string' },
                  descripcion: { type: 'string' },
                  archivos: { type: 'array', items: { type: 'string' } },
                },
                required: ['agente', 'titulo', 'descripcion', 'archivos'],
              },
            },
          },
          required: ['decision', 'subtareas'],
        },
      },
      obligatoria: true,
      validar: (entrada) => {
        const r = validarPlan(entrada, this.e.participantes);
        if ('error' in r) return r.error;
        capturado.plan = r.plan;
        return null;
      },
    };

    await this.cicloLectura(
      this.e.coordinador,
      `${promptSintesis(this.e.tarea.objetivo, equipo, propuestas, revisiones)}\n\nContenido de la raíz del proyecto:\n${listado}`,
      terminalPlan,
    );
    const p = capturado.plan;
    if (!p) throw new FinEjecucion('fallida', 'El coordinador no registró un plan válido.');

    const ahora = this.e.ctx.ahora().toISOString();
    const insertar = this.db.prepare(
      `INSERT INTO subtareas (id, tarea_id, indice, agente_id, titulo, descripcion, archivos, depende_de, rama, creada_en, actualizada_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM subtareas WHERE tarea_id = ?').run(this.e.tarea.id);
      p.subtareas.forEach((s, i) =>
        insertar.run(
          randomUUID(),
          this.e.tarea.id,
          i + 1,
          s.agente.id,
          s.titulo,
          s.descripcion,
          JSON.stringify(s.archivos),
          JSON.stringify(s.dependeDe),
          `${this.e.tarea.rama}--${i + 1}`,
          ahora,
          ahora,
        ),
      );
      this.db.prepare('UPDATE tareas SET decision = ? WHERE id = ?').run(p.decision, this.e.tarea.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const resumenPlan = p.subtareas.map((s, i) => ({ indice: i + 1, titulo: s.titulo, agente: s.agente.nombre, archivos: s.archivos, dependeDe: s.dependeDe }));
    this.registrar('decision', this.e.coordinador.id, 0, p.decision, { subtareas: resumenPlan });
    this.e.emitir('coordinator.decision', { decision: p.decision.slice(0, 2000), subtareas: resumenPlan }, this.e.coordinador.id);
  }

  // ---- Fase 4: ejecución por oleadas + integración ------------------------

  /** Devuelve una pregunta pendiente, o null si todas las subtareas terminaron. */
  private async ejecucion(listado: string): Promise<ResultadoColaboracion | null> {
    // Al reanudar, lo que quedó "ejecutando" vuelve a la cola (su conversación se guardó en punto consistente).
    this.db.prepare("UPDATE subtareas SET estado = 'pendiente' WHERE tarea_id = ? AND estado = 'ejecutando'").run(this.e.tarea.id);
    const decision = (this.db.prepare('SELECT decision FROM tareas WHERE id = ?').get(this.e.tarea.id) as { decision: string }).decision;

    for (;;) {
      const subs = this.subtareas();
      const estado = new Map(subs.map((s) => [s.indice, s.estado]));
      for (const s of subs.filter((x) => x.estado === 'pendiente')) {
        const deps = leerJson<number[]>(s.depende_de, []);
        if (deps.some((d) => estado.get(d) === 'fallida' || estado.get(d) === 'conflicto')) {
          this.actualizarSub(s.id, { estado: 'fallida', error: 'No se ejecutó porque falló una subtarea de la que depende.' });
        }
      }
      const listas = this.subtareas().filter(
        (s) => s.estado === 'pendiente' && leerJson<number[]>(s.depende_de, []).every((d) => estado.get(d) === 'completada'),
      );
      if (!listas.length) break;

      const oleada = listas.map((s) => s.indice);
      this.e.emitir('agent.step', {
        mensaje: listas.length > 1 ? `Ejecutando en paralelo las subtareas ${oleada.join(', ')}.` : `Ejecutando la subtarea ${oleada[0]}.`,
      });
      const completadas: FilaSubtarea[] = [];
      await enParalelo(listas, this.e.proyecto.limites.maxAgentesSimultaneos, async (s) => {
        if (await this.ejecutarSubtarea(s, decision, listado)) completadas.push(s);
      });
      // Integración secuencial y en orden, para que el resultado sea determinista.
      for (const s of completadas.sort((a, b) => a.indice - b.indice)) await this.integrar(s);
    }

    const esperando = this.subtareas().find((s) => s.estado === 'esperando_usuario');
    if (esperando) {
      return {
        tipo: 'pregunta',
        texto: `${this.nombre(esperando.agente_id)} (subtarea ${esperando.indice}: ${esperando.titulo}) pregunta: ${esperando.pregunta}`,
        llamada: `${PREFIJO_PREGUNTA_SUBTAREA}${esperando.id}:${esperando.pregunta_llamada}`,
      };
    }
    const problemas = this.subtareas().filter((s) => s.estado === 'fallida' || s.estado === 'conflicto');
    if (problemas.length) {
      throw new FinEjecucion(
        'fallida',
        `${problemas.length} subtarea(s) no se completaron: ${problemas.map((s) => `#${s.indice} ${s.titulo} (${s.error ?? s.estado})`).join('; ')}. Lo integrado queda en la rama ${this.e.tarea.rama}.`,
      );
    }
    return null;
  }

  /** Ejecuta una subtarea en su propia rama. Devuelve true si terminó y debe integrarse. */
  private async ejecutarSubtarea(s: FilaSubtarea, decision: string, listado: string): Promise<boolean> {
    const agente = this.e.participantes.find((a) => a.id === s.agente_id);
    if (!agente) {
      this.actualizarSub(s.id, { estado: 'fallida', error: 'El agente asignado ya no participa.' });
      return false;
    }
    const archivos = leerJson<string[]>(s.archivos, []);
    this.actualizarSub(s.id, { estado: 'ejecutando', error: null });
    this.e.emitir('agent.step', { mensaje: `${agente.nombre} trabaja en la subtarea ${s.indice}: ${s.titulo}`, subtarea: s.indice }, agente.id);

    const dir = await this.e.git.prepararDesde(this.e.proyecto.id, `${this.e.tarea.id}--${s.indice}`, s.rama, this.e.tarea.rama);
    const acciones: AccionesOrquestador = {
      ejecutarValidacion: (nombre) => this.e.ejecutarValidacion(dir, nombre),
      commit: async (mensaje) => {
        const sha = await this.e.git.commit(dir, mensaje, `Agente ${agente.nombre}`);
        return { error: false, contenido: sha ? `Commit ${sha.slice(0, 7)} creado.` : 'No había cambios para hacer commit.' };
      },
    };
    const ejecutor = new EjecutorHerramientas(dir, agente.herramientas, acciones, { rutasEscritura: archivos });
    const mensajes = leerJson<MensajeConversacion[]>(s.conversacion, []);
    if (!mensajes.length) {
      mensajes.push({ rol: 'usuario', texto: promptSubtarea(this.e.tarea.objetivo, decision, { titulo: s.titulo, descripcion: s.descripcion, archivos }, listado) });
    }

    try {
      const r = await ejecutarCiclo({
        adaptador: this.e.adaptadorPara(agente),
        modelo: agente.modelo,
        sistema: this.sistema(agente, s.rama),
        herramientas: herramientasPara(agente.herramientas),
        ejecutor,
        mensajes,
        senal: this.e.senal,
        maxTurnos: this.e.maxTurnos,
        maxTokensRespuesta: this.e.maxTokensRespuesta,
        antesDeTurno: () => this.e.verificarLimites(agente),
        alUsar: (ent, sal) => this.e.registrarUso(agente, ent, sal),
        emitir: (tipo, datos) => this.e.emitir(tipo, { ...datos, subtarea: s.indice }, agente.id),
        guardar: (m) => this.actualizarSub(s.id, { conversacion: JSON.stringify(m) }),
        alErrorInterno: this.e.alErrorInterno,
      });
      if (r.tipo === 'pregunta') {
        this.actualizarSub(s.id, { estado: 'esperando_usuario', pregunta: r.texto, pregunta_llamada: r.id });
        return false;
      }
      await this.e.git.commit(dir, `${s.titulo}\n\nSubtarea ${s.indice} · agente ${agente.nombre}`, `Agente ${agente.nombre}`);
      this.actualizarSub(s.id, { estado: 'completada', resumen: r.texto });
      return true;
    } catch (err) {
      // Pausa, cancelación, apagado o errores temporales del proveedor detienen toda la tarea.
      if (this.e.senal.aborted || (err instanceof ErrorProveedor && err.temporal)) throw err;
      const mensaje = err instanceof FinEjecucion || err instanceof ErrorProveedor ? err.message : 'Error interno al ejecutar la subtarea.';
      if (!(err instanceof FinEjecucion || err instanceof ErrorProveedor)) this.e.alErrorInterno(err);
      this.actualizarSub(s.id, { estado: 'fallida', error: mensaje });
      this.e.emitir('agent.step', { mensaje: `La subtarea ${s.indice} falló: ${mensaje}`, subtarea: s.indice }, agente.id);
      return false;
    }
  }

  private async integrar(s: FilaSubtarea): Promise<void> {
    const r = await this.e.git.integrar(this.e.dirIntegracion, s.rama, `Integra subtarea ${s.indice}: ${s.titulo}`);
    if (r.ok) {
      this.registrar('integracion', s.agente_id, 0, `Subtarea ${s.indice} integrada.`, { subtarea: s.indice, ok: true });
      this.e.emitir('agent.step', { mensaje: `Subtarea ${s.indice} integrada en ${this.e.tarea.rama}.`, subtarea: s.indice });
    } else {
      const error = `Conflicto al integrar: ${r.conflictos.join(', ')}`;
      this.actualizarSub(s.id, { estado: 'conflicto', error });
      this.registrar('integracion', s.agente_id, 0, error, { subtarea: s.indice, ok: false, conflictos: r.conflictos });
      this.e.emitir('agent.step', { mensaje: `La subtarea ${s.indice} no se pudo integrar (${r.conflictos.join(', ')}).`, subtarea: s.indice });
    }
  }

  private resumenFinal(): string {
    const t = this.db.prepare('SELECT decision FROM tareas WHERE id = ?').get(this.e.tarea.id) as { decision: string };
    const partes = this.subtareas().map((s) => `#${s.indice} ${s.titulo} (${this.nombre(s.agente_id)}): ${s.resumen ?? ''}`.trim());
    return `Decisión del coordinador:\n${t.decision}\n\nSubtareas:\n${partes.join('\n\n')}`;
  }

  // ---- Ayudantes -----------------------------------------------------------

  /** Ciclo de solo lectura (propuestas, revisiones, síntesis) sobre el worktree de integración. */
  private async cicloLectura(agente: AgentePublico, prompt: string, fin: HerramientaTerminal) {
    const permisos = agente.herramientas.filter((h) => LECTURA.includes(h));
    const sinAcciones: AccionesOrquestador = {
      ejecutarValidacion: async () => ({ error: true, contenido: 'No disponible en esta fase.' }),
      commit: async () => ({ error: true, contenido: 'No disponible en esta fase.' }),
    };
    const r = await ejecutarCiclo({
      adaptador: this.e.adaptadorPara(agente),
      modelo: agente.modelo,
      sistema: this.sistema(agente, this.e.tarea.rama),
      // Sin solicitar_intervencion en fases de análisis: el coordinador decide.
      herramientas: herramientasPara(permisos).filter((h) => h.nombre !== 'solicitar_intervencion'),
      ejecutor: new EjecutorHerramientas(this.e.dirIntegracion, permisos, sinAcciones),
      mensajes: [{ rol: 'usuario', texto: prompt }],
      senal: this.e.senal,
      maxTurnos: this.e.maxTurnos,
      maxTokensRespuesta: this.e.maxTokensRespuesta,
      terminal: fin,
      antesDeTurno: () => this.e.verificarLimites(agente),
      alUsar: (ent, sal) => this.e.registrarUso(agente, ent, sal),
      emitir: (tipo, datos) => this.e.emitir(tipo, datos, agente.id),
      guardar: () => {},
      alErrorInterno: this.e.alErrorInterno,
    });
    if (r.tipo === 'pregunta') return { tipo: 'fin' as const, texto: r.texto };
    return r;
  }

  private sistema(agente: AgentePublico, rama: string): string {
    return promptSistema({
      agente,
      repositorio: this.e.proyecto.repositorio,
      rama,
      ramaBase: this.e.proyecto.ramaBase,
      validaciones: this.e.proyecto.validaciones,
      sandboxDisponible: this.e.sandbox.disponible,
      motivoSandbox: this.e.sandbox.motivo,
    });
  }

  private propuestasActuales(): { agenteId: string; agente: string; texto: string }[] {
    const ultimas = new Map<string, FilaDecision>();
    for (const d of this.decisiones('propuesta')) if (d.agente_id) ultimas.set(d.agente_id, d); // en orden: la última gana
    return this.e.participantes.filter((a) => ultimas.has(a.id)).map((a) => ({ agenteId: a.id, agente: a.nombre, texto: ultimas.get(a.id)!.contenido }));
  }

  private decisiones(tipo: TipoDecision): FilaDecision[] {
    return this.db
      .prepare('SELECT agente_id, tipo, ronda, contenido, datos FROM decisiones WHERE tarea_id = ? AND tipo = ? ORDER BY id')
      .all(this.e.tarea.id, tipo) as unknown as FilaDecision[];
  }

  private registrar(tipo: TipoDecision, agenteId: string | null, ronda: number, contenido: string, datos?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO decisiones (tarea_id, agente_id, tipo, ronda, contenido, datos, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.e.tarea.id, agenteId, tipo, ronda, contenido, datos ? JSON.stringify(datos) : null, this.e.ctx.ahora().toISOString());
  }

  private subtareas(): FilaSubtarea[] {
    return this.db.prepare('SELECT * FROM subtareas WHERE tarea_id = ? ORDER BY indice').all(this.e.tarea.id) as unknown as FilaSubtarea[];
  }

  private actualizarSub(
    id: string,
    c: Partial<Record<'estado' | 'error' | 'resumen' | 'conversacion' | 'pregunta' | 'pregunta_llamada', string | null>>,
  ): void {
    const campos = Object.keys(c);
    this.db
      .prepare(`UPDATE subtareas SET actualizada_en = ?${campos.map((k) => `, ${k} = ?`).join('')} WHERE id = ?`)
      .run(this.e.ctx.ahora().toISOString(), ...campos.map((k) => c[k as keyof typeof c] ?? null), id);
  }

  private nombre(agenteId: string | null): string {
    return (agenteId && this.nombres.get(agenteId)) || 'Agente';
  }
}
