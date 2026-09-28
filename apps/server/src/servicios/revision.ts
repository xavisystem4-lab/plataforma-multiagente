import { randomUUID } from 'node:crypto';
import type {
  AprobacionPublica,
  ArchivoDiff,
  DiffTarea,
  EstadoAprobacion,
  EstadoArchivoDiff,
  PublicacionTarea,
  SolicitudAprobar,
  SolicitudRechazar,
} from '@softgala/shared';
import { auditar } from '../auditoria';
import type { BusEventos } from '../ejecucion/bus';
import type { EspaciosGit } from '../ejecucion/git';
import { ErrorApp, noEncontrado } from '../errores';
import { leerJson, type Actor, type Contexto } from './contexto';
import type { ServicioProyectos } from './proyectos';

interface FilaTareaRevision {
  id: string;
  usuario_id: string;
  proyecto_id: string;
  proyecto_nombre: string;
  agente_id: string;
  objetivo: string;
  estado: string;
  rama: string;
  resumen: string | null;
  archivos: string;
  publicacion: string | null;
}

interface FilaAprobacion {
  id: string;
  usuario_id: string;
  proyecto_id: string;
  proyecto_nombre: string;
  tarea_id: string;
  objetivo: string;
  rama: string;
  archivos: string;
  tipo: 'publicar';
  estado: EstadoAprobacion;
  titulo: string;
  descripcion: string;
  comentario: string | null;
  creada_en: string;
  resuelta_en: string | null;
}

const MAX_PARCHE_ARCHIVO = 100_000;
const MAX_PARCHE_TOTAL = 1_000_000;
const ESTADOS: Record<string, EstadoArchivoDiff> = { A: 'agregado', M: 'modificado', D: 'eliminado', R: 'renombrado', C: 'agregado', T: 'modificado' };

const CONSULTA_APROBACION = `
  SELECT a.*, p.nombre AS proyecto_nombre, t.objetivo, t.rama, t.archivos
  FROM aprobaciones a JOIN tareas t ON t.id = a.tarea_id JOIN proyectos p ON p.id = a.proyecto_id`;

/** Interpreta la salida de `git diff` (--name-status -z, --numstat -z y el parche) en una lista de archivos. */
export function interpretarDiff(nameStatus: string, numstat: string, parche: string): Omit<DiffTarea, 'base' | 'rama'> {
  const archivos: ArchivoDiff[] = [];
  const ns = nameStatus.split('\0').filter((x, i, a) => x !== '' || i < a.length - 1);
  for (let i = 0; i < ns.length; ) {
    const codigo = ns[i++]!;
    if (!codigo) break;
    const letra = codigo[0]!;
    const conOrigen = letra === 'R' || letra === 'C';
    const rutaAnterior = conOrigen ? ns[i++]! : null;
    const ruta = ns[i++]!;
    archivos.push({ ruta, rutaAnterior, estado: ESTADOS[letra] ?? 'modificado', adiciones: 0, eliminaciones: 0, binario: false, parche: '', truncado: false });
  }

  // --numstat -z: "add\tdel\truta\0", o para renombrados "add\tdel\t\0anterior\0nueva\0".
  const nm = numstat.split('\0');
  const stats = new Map<string, { a: number; d: number; binario: boolean }>();
  for (let i = 0; i < nm.length; i++) {
    const partes = nm[i]!.split('\t');
    if (partes.length < 3) continue;
    const [a, d, ruta] = partes as [string, string, string];
    const destino = ruta === '' ? nm[(i += 2)]! : ruta;
    stats.set(destino, { a: a === '-' ? 0 : Number(a), d: d === '-' ? 0 : Number(d), binario: a === '-' });
  }

  // El parche trae los archivos en el mismo orden que --name-status.
  const bloques = parche.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  let total = 0;
  let truncado = false;
  archivos.forEach((f, i) => {
    const s = stats.get(f.ruta);
    if (s) Object.assign(f, { adiciones: s.a, eliminaciones: s.d, binario: s.binario });
    let bloque = bloques[i] ?? '';
    if (bloque.length > MAX_PARCHE_ARCHIVO || total + bloque.length > MAX_PARCHE_TOTAL) {
      bloque = bloque.slice(0, Math.max(0, Math.min(MAX_PARCHE_ARCHIVO, MAX_PARCHE_TOTAL - total)));
      f.truncado = true;
      truncado = true;
    }
    total += bloque.length;
    f.parche = bloque;
  });
  return {
    archivos,
    adiciones: archivos.reduce((n, f) => n + f.adiciones, 0),
    eliminaciones: archivos.reduce((n, f) => n + f.eliminaciones, 0),
    truncado,
  };
}

/**
 * Revisión humana del trabajo de los agentes: diff, aprobación para publicar en GitHub
 * (solo la rama del agente, opcionalmente con Pull Request) y reversión.
 * Nada se publica sin una aprobación explícita del usuario.
 */
export class ServicioRevision {
  /** Aprobaciones en proceso (evita doble publicación por clics repetidos). */
  private readonly enProceso = new Set<string>();

  constructor(
    private readonly ctx: Contexto,
    private readonly git: EspaciosGit,
    private readonly proyectos: ServicioProyectos,
    private readonly bus: BusEventos,
  ) {}

  /** La llama el orquestador cuando una tarea termina con cambios. */
  crearSolicitud(tareaId: string): void {
    const t = this.ctx.db
      .prepare('SELECT t.*, p.nombre AS proyecto_nombre FROM tareas t JOIN proyectos p ON p.id = t.proyecto_id WHERE t.id = ?')
      .get(tareaId) as FilaTareaRevision | undefined;
    if (!t) return;
    const archivos = leerJson<string[]>(t.archivos, []);
    const id = randomUUID();
    const ahora = this.ctx.ahora().toISOString();
    this.ctx.db
      .prepare(
        `INSERT INTO aprobaciones (id, usuario_id, proyecto_id, tarea_id, tipo, estado, titulo, descripcion, creada_en)
         VALUES (?, ?, ?, ?, 'publicar', 'pendiente', ?, ?, ?)`,
      )
      .run(
        id,
        t.usuario_id,
        t.proyecto_id,
        t.id,
        `Publicar: ${t.objetivo.split('\n')[0]!.slice(0, 120)}`,
        `${archivos.length} archivo(s) modificado(s) en la rama ${t.rama}. Revisa el diff antes de aprobar.`,
        ahora,
      );
    this.guardarPublicacion(t.id, { estado: 'pendiente', rama: null, prNumero: null, prUrl: null, publicadaEn: null, reversionPrUrl: null, nota: null });
    this.emitir(t, 'approval.requested', { aprobacionId: id, titulo: `Publicar cambios de la tarea`, archivos: archivos.length });
    auditar(this.ctx.db, { accion: 'aprobacion.solicitada', usuarioId: t.usuario_id, proyectoId: t.proyecto_id, detalle: { aprobacionId: id, tareaId: t.id } });
  }

  listar(actor: Actor, estado?: EstadoAprobacion): AprobacionPublica[] {
    const filas = (
      estado
        ? this.ctx.db.prepare(`${CONSULTA_APROBACION} WHERE a.usuario_id = ? AND a.estado = ? ORDER BY a.creada_en DESC LIMIT 200`).all(actor.id, estado)
        : this.ctx.db.prepare(`${CONSULTA_APROBACION} WHERE a.usuario_id = ? ORDER BY a.creada_en DESC LIMIT 200`).all(actor.id)
    ) as unknown as FilaAprobacion[];
    return filas.map(aPublica);
  }

  async diff(actor: Actor, tareaId: string): Promise<DiffTarea> {
    const t = this.tarea(actor, tareaId);
    const pub = leerJson<PublicacionTarea | null>(t.publicacion, null);
    if (pub?.estado === 'descartada') throw new ErrorApp(409, 'CAMBIOS_DESCARTADOS', 'Los cambios de esta tarea se descartaron del servidor.');
    const p = this.proyectos.paraEjecucion(t.usuario_id, t.proyecto_id);
    if (!(await this.git.existeRama(p.id, t.rama))) throw new ErrorApp(409, 'SIN_CAMBIOS', 'La tarea aún no tiene una rama con cambios en el servidor.');
    const d = await this.git.diff(p.id, p.ramaBase, t.rama);
    return { base: p.ramaBase, rama: t.rama, ...interpretarDiff(d.nameStatus, d.numstat, d.parche) };
  }

  /** Publica la rama del agente en GitHub (y abre un PR si se pide). Nunca toca la rama base. */
  async aprobar(actor: Actor, id: string, sol: SolicitudAprobar): Promise<AprobacionPublica> {
    const a = this.aprobacion(actor, id);
    if (a.estado !== 'pendiente') throw new ErrorApp(409, 'YA_RESUELTA', 'Esta solicitud ya fue resuelta.');
    if (this.enProceso.has(id)) throw new ErrorApp(409, 'EN_PROCESO', 'La publicación ya está en curso.');
    this.enProceso.add(id);
    try {
      const t = this.tarea(actor, a.tarea_id);
      if (t.estado !== 'completada') throw new ErrorApp(409, 'TAREA_NO_COMPLETADA', 'Solo se publican tareas completadas.');
      const p = this.proyectos.paraEjecucion(t.usuario_id, t.proyecto_id);
      await this.git.sincronizar(p.id, p.repositorio, p.token);
      await this.git.publicar(p.id, t.rama, p.token);
      auditar(this.ctx.db, { accion: 'github.push', usuarioId: actor.id, proyectoId: p.id, detalle: { rama: t.rama, tareaId: t.id }, ip: actor.ip });

      let pr: { numero: number; url: string } | null = null;
      if (sol.crearPR ?? true) {
        pr = await this.ctx.github.crearPR(p.repositorio, p.token, {
          titulo: t.objetivo.split('\n')[0]!.slice(0, 200),
          head: t.rama,
          base: p.ramaBase,
          cuerpo: `${t.resumen ?? ''}\n\n---\nCambios generados por agentes de la Plataforma Multiagente (SoftGala) y aprobados para revisión.${sol.comentario ? `\n\nComentario: ${sol.comentario}` : ''}`,
        });
        auditar(this.ctx.db, { accion: 'github.pr_creado', usuarioId: actor.id, proyectoId: p.id, detalle: { numero: pr.numero, tareaId: t.id }, ip: actor.ip });
      }

      const ahora = this.ctx.ahora().toISOString();
      this.ctx.db
        .prepare("UPDATE aprobaciones SET estado = 'aprobada', comentario = ?, resuelta_en = ? WHERE id = ? AND estado = 'pendiente'")
        .run(sol.comentario ?? null, ahora, id);
      this.guardarPublicacion(t.id, {
        estado: 'publicada',
        rama: t.rama,
        prNumero: pr?.numero ?? null,
        prUrl: pr?.url ?? null,
        publicadaEn: ahora,
        reversionPrUrl: null,
        nota: pr ? 'Revisa y fusiona el Pull Request en GitHub.' : 'La rama se publicó sin Pull Request.',
      });
      auditar(this.ctx.db, { accion: 'aprobacion.aprobada', usuarioId: actor.id, proyectoId: p.id, detalle: { aprobacionId: id, pr: pr?.numero ?? null }, ip: actor.ip });
      this.emitir(t, 'approval.resolved', { aprobacionId: id, estado: 'aprobada', prUrl: pr?.url ?? null });
      return aPublica(this.aprobacion(actor, id));
    } finally {
      this.enProceso.delete(id);
    }
  }

  async rechazar(actor: Actor, id: string, sol: SolicitudRechazar): Promise<AprobacionPublica> {
    const a = this.aprobacion(actor, id);
    if (a.estado !== 'pendiente') throw new ErrorApp(409, 'YA_RESUELTA', 'Esta solicitud ya fue resuelta.');
    if (this.enProceso.has(id)) throw new ErrorApp(409, 'EN_PROCESO', 'La publicación ya está en curso.');
    const t = this.tarea(actor, a.tarea_id);
    if (sol.descartar) await this.descartarLocal(t);
    this.ctx.db
      .prepare("UPDATE aprobaciones SET estado = 'rechazada', comentario = ?, resuelta_en = ? WHERE id = ?")
      .run(sol.comentario ?? null, this.ctx.ahora().toISOString(), id);
    this.guardarPublicacion(t.id, {
      estado: sol.descartar ? 'descartada' : 'rechazada',
      rama: null,
      prNumero: null,
      prUrl: null,
      publicadaEn: null,
      reversionPrUrl: null,
      nota: sol.comentario ?? null,
    });
    auditar(this.ctx.db, { accion: 'aprobacion.rechazada', usuarioId: actor.id, proyectoId: t.proyecto_id, detalle: { aprobacionId: id, descartar: !!sol.descartar }, ip: actor.ip });
    this.emitir(t, 'approval.resolved', { aprobacionId: id, estado: 'rechazada', descartada: !!sol.descartar });
    return aPublica(this.aprobacion(actor, id));
  }

  /**
   * Revierte una publicación. Si el PR ya se fusionó, abre un PR de reversión (no modifica la rama
   * base directamente). Si no se fusionó, cierra el PR y borra la rama remota.
   */
  async revertir(actor: Actor, tareaId: string): Promise<PublicacionTarea> {
    const t = this.tarea(actor, tareaId);
    const pub = leerJson<PublicacionTarea | null>(t.publicacion, null);
    if (pub?.estado !== 'publicada' || !pub.rama) throw new ErrorApp(409, 'NO_PUBLICADA', 'Solo se puede revertir una tarea publicada.');
    const p = this.proyectos.paraEjecucion(t.usuario_id, t.proyecto_id);

    let nuevo: PublicacionTarea;
    const pr = pub.prNumero ? await this.ctx.github.obtenerPR(p.repositorio, p.token, pub.prNumero) : null;
    if (pr?.fusionado && pr.shaFusion) {
      await this.git.sincronizar(p.id, p.repositorio, p.token);
      const rama = `revertir/${pub.rama.replace(/^agentes\//, '')}`;
      await this.git.prepararReversion(p.id, `${t.id}--revertir`, rama, p.ramaBase, pr.shaFusion);
      await this.git.publicar(p.id, rama, p.token);
      const prRev = await this.ctx.github.crearPR(p.repositorio, p.token, {
        titulo: `Revierte: ${t.objetivo.split('\n')[0]!.slice(0, 180)}`,
        head: rama,
        base: p.ramaBase,
        cuerpo: `Revierte el PR #${pr.numero} (commit ${pr.shaFusion.slice(0, 7)}), solicitado desde la Plataforma Multiagente (SoftGala).`,
      });
      nuevo = { ...pub, estado: 'revertida', reversionPrUrl: prRev.url, nota: `Se abrió el PR de reversión #${prRev.numero}; revísalo y fusiónalo en GitHub.` };
    } else {
      if (pr?.abierto) await this.ctx.github.cerrarPR(p.repositorio, p.token, pr.numero);
      await this.git.sincronizar(p.id, p.repositorio, p.token);
      let nota = pr ? 'Se cerró el Pull Request y se borró la rama remota.' : 'Se borró la rama remota.';
      try {
        await this.git.borrarRamaRemota(p.id, pub.rama, p.token);
      } catch {
        nota = pr ? 'Se cerró el Pull Request; la rama remota ya no existía.' : 'La rama remota ya no existía.';
      }
      if (!pr) nota += ' Si la fusionaste manualmente, reviértelo en GitHub.';
      nuevo = { ...pub, estado: 'revertida', nota };
    }
    this.guardarPublicacion(t.id, nuevo);
    auditar(this.ctx.db, { accion: 'tarea.revertida', usuarioId: actor.id, proyectoId: p.id, detalle: { tareaId: t.id, fusionado: !!pr?.fusionado }, ip: actor.ip });
    this.emitir(t, 'task.reverted', { nota: nuevo.nota, reversionPrUrl: nuevo.reversionPrUrl });
    return nuevo;
  }

  contarPendientes(usuarioId: string): number {
    return (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM aprobaciones WHERE usuario_id = ? AND estado = 'pendiente'").get(usuarioId) as { n: number }).n;
  }

  private async descartarLocal(t: FilaTareaRevision): Promise<void> {
    const subtareas = this.ctx.db.prepare('SELECT indice, rama FROM subtareas WHERE tarea_id = ?').all(t.id) as { indice: number; rama: string }[];
    await this.git.descartar(
      t.proyecto_id,
      [this.git.dirTarea(t.proyecto_id, t.id), ...subtareas.map((s) => this.git.dirTarea(t.proyecto_id, `${t.id}--${s.indice}`))],
      [t.rama, ...subtareas.map((s) => s.rama)],
    );
  }

  private guardarPublicacion(tareaId: string, p: PublicacionTarea): void {
    this.ctx.db.prepare('UPDATE tareas SET publicacion = ? WHERE id = ?').run(JSON.stringify(p), tareaId);
  }

  private emitir(t: Pick<FilaTareaRevision, 'id' | 'usuario_id' | 'proyecto_id' | 'agente_id'>, tipo: 'approval.requested' | 'approval.resolved' | 'task.reverted', datos: Record<string, unknown>): void {
    this.bus.publicar({ usuarioId: t.usuario_id, proyectoId: t.proyecto_id, tareaId: t.id, agenteId: t.agente_id, tipo, datos });
  }

  private tarea(actor: Actor, id: string): FilaTareaRevision {
    const t = this.ctx.db
      .prepare('SELECT t.*, p.nombre AS proyecto_nombre FROM tareas t JOIN proyectos p ON p.id = t.proyecto_id WHERE t.id = ? AND t.usuario_id = ?')
      .get(id, actor.id) as FilaTareaRevision | undefined;
    if (!t) throw noEncontrado('Tarea no encontrada');
    return t;
  }

  private aprobacion(actor: Actor, id: string): FilaAprobacion {
    const a = this.ctx.db.prepare(`${CONSULTA_APROBACION} WHERE a.id = ? AND a.usuario_id = ?`).get(id, actor.id) as FilaAprobacion | undefined;
    if (!a) throw noEncontrado('Solicitud no encontrada');
    return a;
  }
}

function aPublica(a: FilaAprobacion): AprobacionPublica {
  return {
    id: a.id,
    tipo: a.tipo,
    estado: a.estado,
    titulo: a.titulo,
    descripcion: a.descripcion,
    tareaId: a.tarea_id,
    tareaObjetivo: a.objetivo,
    proyectoId: a.proyecto_id,
    proyectoNombre: a.proyecto_nombre,
    rama: a.rama,
    archivos: leerJson<string[]>(a.archivos, []).length,
    comentario: a.comentario,
    creadaEn: a.creada_en,
    resueltaEn: a.resuelta_en,
  };
}
