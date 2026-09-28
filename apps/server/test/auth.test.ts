import type { RespuestaLogin, SesionActiva } from '@softgala/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, crearContexto, EMAIL, login, type Contexto } from './ayudantes';

let ctx: Contexto;
afterEach(async () => {
  await ctx?.app.close();
  ctx?.db.close();
});

const refrescar = (refreshToken: string) =>
  ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } });
const me = (token: string) => ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });

describe('login', () => {
  it('inicia sesión y permite consultar el perfil', async () => {
    ctx = await crearContexto();
    const r = await login(ctx.app);
    expect(r.statusCode).toBe(200);
    const cuerpo = r.json<RespuestaLogin>();
    expect(cuerpo.usuario).toMatchObject({ email: EMAIL, rol: 'admin' });
    expect(cuerpo.usuario).not.toHaveProperty('password_hash');
    expect((await me(cuerpo.accessToken)).json()).toMatchObject({ email: EMAIL });
  });

  it('da el mismo error para contraseña incorrecta y correo inexistente', async () => {
    ctx = await crearContexto();
    const malaPassword = await login(ctx.app, 'incorrecta');
    const sinUsuario = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nadie@prueba.local', password: 'x' },
    });
    expect(malaPassword.statusCode).toBe(401);
    expect(sinUsuario.statusCode).toBe(401);
    expect(malaPassword.json()).toEqual(sinUsuario.json());
  });

  it('valida los datos de entrada', async () => {
    ctx = await crearContexto();
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'no-es-correo', password: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.codigo).toBe('VALIDACION');
  });

  it('bloquea la cuenta tras 5 intentos fallidos y la libera después de 15 minutos', async () => {
    ctx = await crearContexto();
    for (let i = 0; i < 5; i++) expect((await login(ctx.app, 'incorrecta')).statusCode).toBe(401);

    const bloqueado = await login(ctx.app);
    expect(bloqueado.statusCode).toBe(429);
    expect(bloqueado.json().error.codigo).toBe('CUENTA_BLOQUEADA');

    ctx.reloj.ahora = new Date(ctx.reloj.ahora.getTime() + 16 * 60_000);
    expect((await login(ctx.app)).statusCode).toBe(200);
  });

  it('limita la frecuencia de intentos por IP', async () => {
    ctx = await crearContexto();
    const codigos: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.com', password: 'x' } });
      codigos.push(r.statusCode);
    }
    expect(codigos.at(-1)).toBe(429);
  });

  it('registra en auditoría los intentos sin guardar la contraseña', async () => {
    ctx = await crearContexto();
    await login(ctx.app, 'mi-password-secreta');
    const filas = ctx.db.prepare('SELECT accion, detalle FROM auditoria').all() as { accion: string; detalle: string | null }[];
    expect(filas.map((f) => f.accion)).toContain('auth.login_fallido');
    expect(JSON.stringify(filas)).not.toContain('mi-password-secreta');
  });
});

describe('acceso protegido', () => {
  it('rechaza peticiones sin token o con token alterado', async () => {
    ctx = await crearContexto();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const { accessToken } = (await login(ctx.app)).json<RespuestaLogin>();
    expect((await me(`${accessToken}x`)).statusCode).toBe(401);
  });

  it('rechaza el token de acceso expirado', async () => {
    ctx = await crearContexto();
    const { accessToken } = (await login(ctx.app)).json<RespuestaLogin>();
    // jose valida la expiración con el reloj real; se firma un token ya vencido para comprobarlo.
    const { firmarAccessToken } = await import('../src/security/tokens');
    const vencido = await firmarAccessToken({ sub: 'x', sid: 'y', rol: 'admin' }, ctx.config.jwtSecret, -10);
    expect((await me(vencido)).statusCode).toBe(401);
    expect((await me(accessToken)).statusCode).toBe(200);
  });
});

describe('refresh token', () => {
  it('rota el token: el nuevo funciona y el anterior ya no', async () => {
    ctx = await crearContexto();
    const inicial = (await login(ctx.app)).json<RespuestaLogin>();
    const rotado = await refrescar(inicial.refreshToken);
    expect(rotado.statusCode).toBe(200);
    const nuevo = rotado.json<RespuestaLogin>();
    expect(nuevo.refreshToken).not.toBe(inicial.refreshToken);
    expect((await me(nuevo.accessToken)).statusCode).toBe(200);
    // El access token de la sesión rotada deja de valer.
    expect((await me(inicial.accessToken)).statusCode).toBe(401);
  });

  it('si se reutiliza un token rotado (posible robo) revoca toda la sesión', async () => {
    ctx = await crearContexto();
    const inicial = (await login(ctx.app)).json<RespuestaLogin>();
    const legitimo = (await refrescar(inicial.refreshToken)).json<RespuestaLogin>();

    expect((await refrescar(inicial.refreshToken)).statusCode).toBe(401);
    // La cadena legítima también queda revocada.
    expect((await me(legitimo.accessToken)).statusCode).toBe(401);
    expect((await refrescar(legitimo.refreshToken)).statusCode).toBe(401);

    const acciones = (ctx.db.prepare('SELECT accion FROM auditoria').all() as { accion: string }[]).map((f) => f.accion);
    expect(acciones).toContain('auth.refresh_reutilizado');
  });

  it('rechaza el refresh token expirado', async () => {
    ctx = await crearContexto();
    const inicial = (await login(ctx.app)).json<RespuestaLogin>();
    ctx.reloj.ahora = new Date(ctx.reloj.ahora.getTime() + 31 * 24 * 3600_000);
    expect((await refrescar(inicial.refreshToken)).statusCode).toBe(401);
  });

  it('solo una de dos rotaciones simultáneas del mismo token tiene éxito', async () => {
    ctx = await crearContexto();
    const inicial = (await login(ctx.app)).json<RespuestaLogin>();
    const [a, b] = await Promise.all([refrescar(inicial.refreshToken), refrescar(inicial.refreshToken)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
  });
});

describe('sesiones por dispositivo', () => {
  it('cerrar sesión invalida el token de inmediato', async () => {
    ctx = await crearContexto();
    const s = (await login(ctx.app)).json<RespuestaLogin>();
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(s.accessToken) });
    expect(r.statusCode).toBe(204);
    expect((await me(s.accessToken)).statusCode).toBe(401);
    expect((await refrescar(s.refreshToken)).statusCode).toBe(401);
  });

  it('lista las sesiones y permite revocar otro dispositivo', async () => {
    ctx = await crearContexto();
    const pc = (await login(ctx.app, undefined, 'Windows')).json<RespuestaLogin>();
    const tel = (await login(ctx.app, undefined, 'Android')).json<RespuestaLogin>();

    const lista = (
      await ctx.app.inject({ method: 'GET', url: '/api/auth/sesiones', headers: bearer(pc.accessToken) })
    ).json<SesionActiva[]>();
    expect(lista).toHaveLength(2);
    expect(lista.find((s) => s.actual)?.dispositivo).toBe('Windows');

    const telefono = lista.find((s) => s.dispositivo === 'Android')!;
    const r = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/auth/sesiones/${telefono.id}`,
      headers: bearer(pc.accessToken),
    });
    expect(r.statusCode).toBe(204);
    expect((await me(tel.accessToken)).statusCode).toBe(401);
    expect((await me(pc.accessToken)).statusCode).toBe(200);
  });
});

describe('API', () => {
  it('responde errores con formato uniforme y cabeceras de seguridad', async () => {
    ctx = await crearContexto();
    const r = await ctx.app.inject({ method: 'GET', url: '/api/no-existe' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { codigo: 'NO_ENCONTRADO', mensaje: 'Ruta no encontrada' } });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CORS solo permite orígenes configurados', async () => {
    ctx = await crearContexto();
    const permitido = await ctx.app.inject({ method: 'GET', url: '/api/salud', headers: { origin: 'app://ui' } });
    const ajeno = await ctx.app.inject({ method: 'GET', url: '/api/salud', headers: { origin: 'https://malicioso.com' } });
    expect(permitido.headers['access-control-allow-origin']).toBe('app://ui');
    expect(ajeno.headers['access-control-allow-origin']).toBeUndefined();
  });
});
