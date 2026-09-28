import type { ErrorApi, RespuestaLogin, SesionActiva, UsuarioPublico } from '@softgala/shared';
import { nombreDispositivo, type Almacen } from './plataforma';

export const SERVIDOR_PREDETERMINADO = 'http://127.0.0.1:4000';
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
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new ErrorCliente('SERVIDOR_INSEGURO', 'El servidor debe usar HTTPS (solo se permite HTTP en este equipo).');
  }
  return u.origin;
}

export class ClienteApi {
  private accessToken: string | null = null;
  private refrescoEnCurso: Promise<boolean> | null = null;
  servidor = SERVIDOR_PREDETERMINADO;
  /** Se invoca cuando la sesión ya no puede renovarse (revocada o expirada). */
  alExpirar: () => void = () => {};

  constructor(private readonly almacen: Almacen) {}

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
    if (!(await this.almacen.obtener(CLAVE_REFRESH))) return null;
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
      await this.almacen.borrar(CLAVE_REFRESH);
    }
  }

  sesiones(): Promise<SesionActiva[]> {
    return this.solicitud('GET', '/api/auth/sesiones');
  }

  revocarSesion(id: string): Promise<void> {
    return this.solicitud('DELETE', `/api/auth/sesiones/${encodeURIComponent(id)}`);
  }

  /** Petición autenticada; si el token de acceso expiró, lo renueva una vez y reintenta. */
  async solicitud<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    if (!this.accessToken && !(await this.refrescar())) throw this.sesionExpirada();
    try {
      return await this.enviar<T>(metodo, ruta, cuerpo, this.accessToken!);
    } catch (err) {
      if (!(err instanceof ErrorCliente) || err.estado !== 401) throw err;
      if (!(await this.refrescar())) throw this.sesionExpirada();
      return this.enviar<T>(metodo, ruta, cuerpo, this.accessToken!);
    }
  }

  /** Una sola renovación a la vez: dos renovaciones simultáneas harían que el servidor revoque la sesión. */
  private refrescar(): Promise<boolean> {
    this.refrescoEnCurso ??= (async () => {
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
    await this.almacen.guardar(CLAVE_REFRESH, r.refreshToken);
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
