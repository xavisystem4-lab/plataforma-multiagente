import type {
  AgenteEntrada,
  AgentePublico,
  ErrorApi,
  EstadoRepositorio,
  EventoTiempoReal,
  AprobacionPublica,
  DecisionPublica,
  DiffTarea,
  EstadoAprobacion,
  PublicacionTarea,
  SolicitudAprobar,
  SolicitudRechazar,
  TareaPublica,
  PaginaAuditoria,
  ProveedorEdicion,
  ProveedorNuevo,
  ProveedorPublico,
  ProyectoEdicion,
  ProyectoNuevo,
  ProyectoPublico,
  RespuestaLogin,
  ResultadoPrueba,
  Resumen,
  SesionActiva,
  UsuarioPublico,
} from '@softgala/shared';
import type { esquemaContinuar } from '@softgala/shared';
import type { z } from 'zod';
import { detectarPlataforma, nombreDispositivo, type Almacen, type IntermediarioSesion } from './plataforma';

const enc = encodeURIComponent;

/** En el emulador de Android, 10.0.2.2 es la computadora anfitriona (servidor de desarrollo). */
export const SERVIDOR_PREDETERMINADO = detectarPlataforma() === 'android' ? 'http://10.0.2.2:4000' : 'http://127.0.0.1:4000';
const CLAVE_REFRESH = 'refreshToken';
const CLAVE_SERVIDOR = 'servidor';

export class ErrorCliente extends Error {
  constructor(
    public readonly codigo: string,
    mensaje: string,
    public readonly estado = 0,
  ) {
    super(mensaje);
  }
}

/**
 * Exige HTTPS salvo para el servidor local de desarrollo: los tokens nunca viajan sin cifrar por la red.
 * Devuelve la URL normalizada o lanza un error con un mensaje para el usuario.
 */
export function validarServidor(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new ErrorCliente('SERVIDOR_INVALIDO', 'Escribe una dirección válida, p. ej. https://mi-servidor.com');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]', '10.0.2.2'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new ErrorCliente('SERVIDOR_INSEGURO', 'El servidor debe usar HTTPS (HTTP solo para un servidor de desarrollo en este equipo o el emulador).');
  }
  return u.origin;
}

export class ClienteApi {
  private accessToken: string | null = null;
  private refrescoEnCurso: Promise<boolean> | null = null;
  servidor = SERVIDOR_PREDETERMINADO;
  /** Se invoca cuando la sesión ya no puede renovarse (revocada o expirada). */
  alExpirar: () => void = () => {};

  /** En Windows, el proceso principal renueva la sesión para todas las ventanas. */
  private readonly intermediario: IntermediarioSesion | null = window.softgala?.sesion ?? null;

  constructor(private readonly almacen: Almacen) {}

  /** Avisa cuando otra ventana cerró la sesión (solo escritorio). */
  alCerrarEnOtraVentana(fn: () => void): () => void {
    return this.intermediario?.alCerrar(fn) ?? (() => {});
  }

  async cargarServidor(): Promise<string> {
    this.servidor = (await this.almacen.obtener(CLAVE_SERVIDOR)) ?? SERVIDOR_PREDETERMINADO;
    return this.servidor;
  }

  async cambiarServidor(url: string): Promise<void> {
    this.servidor = validarServidor(url);
    await this.almacen.guardar(CLAVE_SERVIDOR, this.servidor);
  }

  async login(email: string, password: string): Promise<UsuarioPublico> {
    const r = await this.enviar<RespuestaLogin>('POST', '/api/auth/login', {
      email,
      password,
      dispositivo: nombreDispositivo(),
    });
    await this.guardarTokens(r);
    return r.usuario;
  }

  /** Intenta reanudar la sesión guardada al abrir la app. */
  async restaurar(): Promise<UsuarioPublico | null> {
    if (!this.intermediario && !(await this.almacen.obtener(CLAVE_REFRESH))) return null;
    if (!(await this.refrescar())) return null;
    return this.solicitud<UsuarioPublico>('GET', '/api/auth/me');
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken) await this.enviar('POST', '/api/auth/logout', undefined, this.accessToken);
    } catch {
      /* aunque falle la red, se borra la sesión local */
    } finally {
      this.accessToken = null;
      if (this.intermediario) await this.intermediario.limpiar();
      else await this.almacen.borrar(CLAVE_REFRESH);
    }
  }

  sesiones(): Promise<SesionActiva[]> {
    return this.solicitud('GET', '/api/auth/sesiones');
  }

  revocarSesion(id: string): Promise<void> {
    return this.solicitud('DELETE', `/api/auth/sesiones/${enc(id)}`);
  }

  // ---- Recursos (F1) ----
  resumen = () => this.solicitud<Resumen>('GET', '/api/resumen');

  proveedores = () => this.solicitud<ProveedorPublico[]>('GET', '/api/proveedores');
  crearProveedor = (d: ProveedorNuevo) => this.solicitud<ProveedorPublico>('POST', '/api/proveedores', d);
  editarProveedor = (id: string, d: ProveedorEdicion) =>
    this.solicitud<ProveedorPublico>('PATCH', `/api/proveedores/${enc(id)}`, d);
  eliminarProveedor = (id: string) => this.solicitud<void>('DELETE', `/api/proveedores/${enc(id)}`);
  probarProveedor = (id: string) => this.solicitud<ResultadoPrueba>('POST', `/api/proveedores/${enc(id)}/probar`);

  agentes = () => this.solicitud<AgentePublico[]>('GET', '/api/agentes');
  crearAgente = (d: AgenteEntrada) => this.solicitud<AgentePublico>('POST', '/api/agentes', d);
  editarAgente = (id: string, d: Partial<AgenteEntrada>) =>
    this.solicitud<AgentePublico>('PATCH', `/api/agentes/${enc(id)}`, d);
  eliminarAgente = (id: string) => this.solicitud<void>('DELETE', `/api/agentes/${enc(id)}`);

  proyectos = () => this.solicitud<ProyectoPublico[]>('GET', '/api/proyectos');
  proyecto = (id: string) => this.solicitud<ProyectoPublico>('GET', `/api/proyectos/${enc(id)}`);
  crearProyecto = (d: ProyectoNuevo) => this.solicitud<ProyectoPublico>('POST', '/api/proyectos', d);
  editarProyecto = (id: string, d: ProyectoEdicion) =>
    this.solicitud<ProyectoPublico>('PATCH', `/api/proyectos/${enc(id)}`, d);
  eliminarProyecto = (id: string) => this.solicitud<void>('DELETE', `/api/proyectos/${enc(id)}`);
  estadoProyecto = (id: string) => this.solicitud<EstadoRepositorio>('GET', `/api/proyectos/${enc(id)}/estado`);
  habilitarAgente = (proyectoId: string, agenteId: string, habilitado: boolean) =>
    this.solicitud<ProyectoPublico>('PUT', `/api/proyectos/${enc(proyectoId)}/agentes/${enc(agenteId)}`, { habilitado });

  // ---- Tareas (F2) ----
  sistema = () => this.solicitud<{ sandbox: { disponible: boolean; motivo: string | null } }>('GET', '/api/sistema');
  continuar = (proyectoId: string, d: z.input<typeof esquemaContinuar>) =>
    this.solicitud<TareaPublica>('POST', `/api/proyectos/${enc(proyectoId)}/continuar`, d);
  tareas = (proyectoId?: string) =>
    this.solicitud<TareaPublica[]>('GET', `/api/tareas${proyectoId ? `?proyectoId=${enc(proyectoId)}` : ''}`);
  tarea = (id: string) => this.solicitud<TareaPublica>('GET', `/api/tareas/${enc(id)}`);
  decisiones = (id: string) => this.solicitud<DecisionPublica[]>('GET', `/api/tareas/${enc(id)}/decisiones`);
  eventosTarea = (id: string) => this.solicitud<EventoTiempoReal[]>('GET', `/api/tareas/${enc(id)}/eventos`);
  accionTarea = (id: string, accion: 'pausar' | 'reanudar' | 'cancelar') =>
    this.solicitud<TareaPublica>('POST', `/api/tareas/${enc(id)}/${accion}`);
  responder = (id: string, respuesta: string) =>
    this.solicitud<TareaPublica>('POST', `/api/tareas/${enc(id)}/responder`, { respuesta });

  // ---- Revisión y publicación (F4) ----
  aprobaciones = (estado?: EstadoAprobacion) =>
    this.solicitud<AprobacionPublica[]>('GET', `/api/aprobaciones${estado ? `?estado=${estado}` : ''}`);
  aprobar = (id: string, d: SolicitudAprobar) => this.solicitud<AprobacionPublica>('POST', `/api/aprobaciones/${enc(id)}/aprobar`, d);
  rechazar = (id: string, d: SolicitudRechazar) => this.solicitud<AprobacionPublica>('POST', `/api/aprobaciones/${enc(id)}/rechazar`, d);
  diffTarea = (id: string) => this.solicitud<DiffTarea>('GET', `/api/tareas/${enc(id)}/diff`);
  revertir = (id: string) => this.solicitud<PublicacionTarea>('POST', `/api/tareas/${enc(id)}/revertir`);

  /** Token de acceso vigente (lo renueva si hace falta), para autenticar el WebSocket. */
  async tokenAcceso(): Promise<string> {
    if (!this.accessToken && !(await this.refrescar())) throw this.sesionExpirada();
    return this.accessToken!;
  }

  /** Fuerza una renovación (p. ej. si el WebSocket rechazó un token vencido). */
  async renovarAcceso(): Promise<boolean> {
    this.accessToken = null;
    return this.refrescar(true);
  }

  urlTiempoReal(): string {
    return `${this.servidor.replace(/^http/, 'ws')}/api/ws`;
  }

  auditoria = (filtro: { accion?: string; antesDe?: number; limite?: number }) => {
    const q = new URLSearchParams();
    if (filtro.accion) q.set('accion', filtro.accion);
    if (filtro.antesDe) q.set('antesDe', String(filtro.antesDe));
    if (filtro.limite) q.set('limite', String(filtro.limite));
    return this.solicitud<PaginaAuditoria>('GET', `/api/auditoria?${q}`);
  };

  /** Petición autenticada; si el token de acceso expiró, lo renueva una vez y reintenta. */
  async solicitud<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    if (!this.accessToken && !(await this.refrescar())) throw this.sesionExpirada();
    try {
      return await this.enviar<T>(metodo, ruta, cuerpo, this.accessToken!);
    } catch (err) {
      if (!(err instanceof ErrorCliente) || err.estado !== 401) throw err;
      // Tras un 401 se fuerza la renovación: el token en caché pudo haber sido revocado.
      if (!(await this.refrescar(true))) throw this.sesionExpirada();
      return this.enviar<T>(metodo, ruta, cuerpo, this.accessToken!);
    }
  }

  /** Una sola renovación a la vez: dos renovaciones simultáneas harían que el servidor revoque la sesión. */
  private refrescar(forzar = false): Promise<boolean> {
    this.refrescoEnCurso ??= (async () => {
      if (this.intermediario) {
        try {
          const r = await this.intermediario.renovar(forzar, this.servidor);
          this.accessToken = r?.accessToken ?? null;
          return !!r;
        } catch {
          throw new ErrorCliente('SIN_CONEXION', `No se pudo conectar con el servidor (${this.servidor}).`);
        } finally {
          this.refrescoEnCurso = null;
        }
      }
      try {
        const token = await this.almacen.obtener(CLAVE_REFRESH);
        if (!token) return false;
        const r = await this.enviar<RespuestaLogin>('POST', '/api/auth/refresh', { refreshToken: token });
        await this.guardarTokens(r);
        return true;
      } catch (err) {
        // Solo se descarta el token si el servidor lo rechazó; sin red se conserva para reintentar.
        if (err instanceof ErrorCliente && err.estado === 401) await this.almacen.borrar(CLAVE_REFRESH);
        if (err instanceof ErrorCliente && err.codigo === 'SIN_CONEXION') throw err;
        return false;
      } finally {
        this.refrescoEnCurso = null;
      }
    })();
    return this.refrescoEnCurso;
  }

  private async guardarTokens(r: RespuestaLogin): Promise<void> {
    this.accessToken = r.accessToken;
    if (this.intermediario) await this.intermediario.establecer(r.refreshToken, r.accessToken, r.expiraEn);
    else await this.almacen.guardar(CLAVE_REFRESH, r.refreshToken);
  }

  private sesionExpirada(): ErrorCliente {
    this.accessToken = null;
    this.alExpirar();
    return new ErrorCliente('SESION_EXPIRADA', 'Tu sesión terminó. Inicia sesión de nuevo.', 401);
  }

  private async enviar<T>(metodo: string, ruta: string, cuerpo?: unknown, token?: string): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(`${this.servidor}${ruta}`, {
        method: metodo,
        headers: {
          ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ErrorCliente('SIN_CONEXION', `No se pudo conectar con el servidor (${this.servidor}).`);
    }
    if (resp.status === 204) return undefined as T;
    const datos = (await resp.json().catch(() => null)) as T | ErrorApi | null;
    if (!resp.ok) {
      const e = (datos as ErrorApi | null)?.error;
      throw new ErrorCliente(e?.codigo ?? 'ERROR', e?.mensaje ?? `Error del servidor (${resp.status})`, resp.status);
    }
    return datos as T;
  }
}
