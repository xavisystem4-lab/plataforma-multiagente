import { randomUUID } from 'node:crypto';
import type { RespuestaLogin, Rol, SesionActiva, SolicitudLogin, UsuarioPublico } from '@softgala/shared';
import { auditar } from '../auditoria';
import type { Config } from '../config';
import { transaccion, type Db } from '../db';
import { ErrorApp, noAutorizado, noEncontrado } from '../errores';
import { hashPassword, obtenerHashRelleno, verificarPassword } from '../security/passwords';
import { firmarAccessToken, generarRefreshToken, hashToken } from '../security/tokens';

interface FilaUsuario {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
  password_hash: string;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  activo: number;
}

interface FilaSesion {
  id: string;
  usuario_id: string;
  familia: string;
  dispositivo: string | null;
  ip: string | null;
  creada_en: string;
  ultimo_uso: string;
  expira_en: string;
  revocada_en: string | null;
  motivo_revocacion: string | null;
}

export interface UsuarioAutenticado {
  id: string;
  rol: Rol;
  sid: string;
}

const CREDENCIALES_INVALIDAS = () =>
  new ErrorApp(401, 'CREDENCIALES_INVALIDAS', 'Correo o contraseña incorrectos');

const aPublico = (u: FilaUsuario): UsuarioPublico => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol });

export class ServicioAuth {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly ahora: () => Date = () => new Date(),
  ) {}

  async crearUsuario(datos: { email: string; nombre: string; rol: Rol; password: string }): Promise<UsuarioPublico> {
    const email = datos.email.trim().toLowerCase();
    if (this.db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) {
      throw new ErrorApp(409, 'USUARIO_EXISTE', 'Ya existe un usuario con ese correo');
    }
    const usuario = { id: randomUUID(), email, nombre: datos.nombre.trim(), rol: datos.rol };
    const hash = await hashPassword(datos.password);
    this.db
      .prepare('INSERT INTO usuarios (id, email, nombre, rol, password_hash, creado_en) VALUES (?, ?, ?, ?, ?, ?)')
      .run(usuario.id, usuario.email, usuario.nombre, usuario.rol, hash, this.ahora().toISOString());
    auditar(this.db, { accion: 'usuario.creado', usuarioId: usuario.id, detalle: { email, rol: usuario.rol } });
    return usuario;
  }

  contarUsuarios(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM usuarios').get() as { n: number }).n;
  }

  async login(entrada: SolicitudLogin, ip: string | null): Promise<RespuestaLogin> {
    const u = this.db.prepare('SELECT * FROM usuarios WHERE email = ?').get(entrada.email) as FilaUsuario | undefined;

    if (!u || !u.activo) {
      // Se hace el mismo trabajo que con un usuario real para no revelar qué correos existen.
      await verificarPassword(entrada.password, await obtenerHashRelleno());
      auditar(this.db, { accion: 'auth.login_fallido', detalle: { email: entrada.email, motivo: 'usuario' }, ip });
      throw CREDENCIALES_INVALIDAS();
    }

    const ahora = this.ahora();
    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > ahora) {
      auditar(this.db, { accion: 'auth.login_bloqueado', usuarioId: u.id, ip });
      throw new ErrorApp(
        429,
        'CUENTA_BLOQUEADA',
        `Demasiados intentos fallidos. Intenta de nuevo en ${this.config.minutosBloqueo} minutos.`,
      );
    }

    if (!(await verificarPassword(entrada.password, u.password_hash))) {
      const intentos = u.intentos_fallidos + 1;
      const bloquear = intentos >= this.config.maxIntentosLogin;
      this.db
        .prepare('UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?')
        .run(
          bloquear ? 0 : intentos,
          bloquear ? new Date(ahora.getTime() + this.config.minutosBloqueo * 60_000).toISOString() : null,
          u.id,
        );
      auditar(this.db, {
        accion: bloquear ? 'auth.cuenta_bloqueada' : 'auth.login_fallido',
        usuarioId: u.id,
        detalle: { intentos },
        ip,
      });
      throw CREDENCIALES_INVALIDAS();
    }

    this.db.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').run(u.id);
    const sesion = await this.prepararSesion(u, randomUUID(), entrada.dispositivo ?? null, ip);
    sesion.guardar();
    const tokens = sesion.tokens;
    auditar(this.db, { accion: 'auth.login', usuarioId: u.id, detalle: { dispositivo: entrada.dispositivo }, ip });
    return { ...tokens, usuario: aPublico(u) };
  }

  /**
   * Rota el refresh token: el anterior queda revocado y se emite uno nuevo en la misma familia.
   * Si alguien presenta un token ya rotado (posible robo), se revoca toda la familia.
   */
  async refrescar(refreshToken: string, ip: string | null): Promise<RespuestaLogin> {
    const s = this.db
      .prepare('SELECT * FROM sesiones WHERE refresh_hash = ?')
      .get(hashToken(refreshToken)) as FilaSesion | undefined;
    if (!s) throw noAutorizado();

    if (s.revocada_en) {
      if (s.motivo_revocacion === 'rotada') {
        this.revocarFamilia(s.familia, 'reutilizacion');
        auditar(this.db, { accion: 'auth.refresh_reutilizado', usuarioId: s.usuario_id, detalle: { familia: s.familia }, ip });
      }
      throw noAutorizado();
    }
    if (new Date(s.expira_en) <= this.ahora()) throw noAutorizado('La sesión expiró; inicia sesión de nuevo');

    const u = this.db.prepare('SELECT * FROM usuarios WHERE id = ?').get(s.usuario_id) as FilaUsuario | undefined;
    if (!u || !u.activo) throw noAutorizado();

    const nueva = await this.prepararSesion(u, s.familia, s.dispositivo, ip, s.creada_en);
    transaccion(this.db, () => {
      const r = this.db
        .prepare(
          "UPDATE sesiones SET revocada_en = ?, motivo_revocacion = 'rotada' WHERE id = ? AND revocada_en IS NULL",
        )
        .run(this.ahora().toISOString(), s.id);
      // Otro refresco concurrente ganó la rotación: este token ya no vale.
      if (r.changes !== 1) throw noAutorizado();
      nueva.guardar();
    });
    return { ...nueva.tokens, usuario: aPublico(u) };
  }

  /** Comprueba en cada petición que la sesión siga viva: revocar tiene efecto inmediato. */
  validarSesion(sid: string, usuarioId: string): boolean {
    const fila = this.db
      .prepare(
        `SELECT s.revocada_en, s.expira_en, u.activo FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = ? AND s.usuario_id = ?`,
      )
      .get(sid, usuarioId) as { revocada_en: string | null; expira_en: string; activo: number } | undefined;
    return !!fila && !fila.revocada_en && fila.activo === 1 && new Date(fila.expira_en) > this.ahora();
  }

  obtenerUsuario(id: string): UsuarioPublico {
    const u = this.db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id) as FilaUsuario | undefined;
    if (!u) throw noEncontrado('Usuario no encontrado');
    return aPublico(u);
  }

  cerrarSesion(auth: UsuarioAutenticado, ip: string | null): void {
    const familia = this.familiaDe(auth.sid);
    if (familia) this.revocarFamilia(familia, 'logout');
    auditar(this.db, { accion: 'auth.logout', usuarioId: auth.id, ip });
  }

  listarSesiones(auth: UsuarioAutenticado): SesionActiva[] {
    const filas = this.db
      .prepare(
        `SELECT * FROM sesiones WHERE usuario_id = ? AND revocada_en IS NULL AND expira_en > ?
         ORDER BY ultimo_uso DESC`,
      )
      .all(auth.id, this.ahora().toISOString()) as unknown as FilaSesion[];
    return filas.map((s) => ({
      id: s.id,
      dispositivo: s.dispositivo,
      ip: s.ip,
      creadaEn: s.creada_en,
      ultimoUso: s.ultimo_uso,
      actual: s.id === auth.sid,
    }));
  }

  revocarSesion(auth: UsuarioAutenticado, sesionId: string, ip: string | null): void {
    const s = this.db
      .prepare('SELECT familia FROM sesiones WHERE id = ? AND usuario_id = ?')
      .get(sesionId, auth.id) as { familia: string } | undefined;
    if (!s) throw noEncontrado('Sesión no encontrada');
    this.revocarFamilia(s.familia, 'revocada_por_usuario');
    auditar(this.db, { accion: 'auth.sesion_revocada', usuarioId: auth.id, detalle: { sesionId }, ip });
  }

  /**
   * Firma los tokens (parte asíncrona) y devuelve `guardar`, que inserta la sesión de forma
   * síncrona para poder usarse dentro de una transacción.
   */
  private async prepararSesion(
    u: FilaUsuario,
    familia: string,
    dispositivo: string | null,
    ip: string | null,
    creadaEn?: string,
  ): Promise<{ tokens: Omit<RespuestaLogin, 'usuario'>; guardar: () => void }> {
    const sid = randomUUID();
    const refreshToken = generarRefreshToken();
    const accessToken = await firmarAccessToken(
      { sub: u.id, sid, rol: u.rol },
      this.config.jwtSecret,
      this.config.duracionAccess,
    );
    const guardar = () => {
      const ahora = this.ahora();
      this.db
        .prepare(
          `INSERT INTO sesiones (id, usuario_id, familia, refresh_hash, dispositivo, ip, creada_en, ultimo_uso, expira_en)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sid,
          u.id,
          familia,
          hashToken(refreshToken),
          dispositivo,
          ip,
          creadaEn ?? ahora.toISOString(),
          ahora.toISOString(),
          new Date(ahora.getTime() + this.config.duracionRefresh * 1000).toISOString(),
        );
    };
    return { tokens: { accessToken, expiraEn: this.config.duracionAccess, refreshToken }, guardar };
  }

  private familiaDe(sid: string): string | null {
    const f = this.db.prepare('SELECT familia FROM sesiones WHERE id = ?').get(sid) as { familia: string } | undefined;
    return f?.familia ?? null;
  }

  private revocarFamilia(familia: string, motivo: string): void {
    this.db
      .prepare('UPDATE sesiones SET revocada_en = ?, motivo_revocacion = ? WHERE familia = ? AND revocada_en IS NULL')
      .run(this.ahora().toISOString(), motivo, familia);
  }
}
