import type {
  AgentePublico,
  EstadoRepositorio,
  PaginaAuditoria,
  ProveedorPublico,
  ProyectoPublico,
  RespuestaLogin,
  Resumen,
  ResultadoPrueba,
} from '@softgala/shared';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, crearContexto, EMAIL_2, fetchSimulado, json, login, type Contexto, type OpcionesContexto } from './ayudantes';

const CLAVE_ANTHROPIC = 'sk-ant-prueba-1234567890-abcd';
const TOKEN_GITHUB = 'github_pat_prueba_000000000000000000000000_wxyz';
const REPO = 'softgala/demo';

let ctx: Contexto;
let tokenAdmin: string;
let tokenUsuario: string;

afterEach(async () => {
  await ctx?.app.close();
  ctx?.db.close();
});

async function preparar(opciones: OpcionesContexto = {}) {
  ctx = await crearContexto(opciones);
  tokenAdmin = (await login(ctx.app)).json<RespuestaLogin>().accessToken;
  tokenUsuario = (await login(ctx.app, undefined, 'Pruebas', EMAIL_2)).json<RespuestaLogin>().accessToken;
}

function pedir(metodo: InjectOptions['method'], url: string, payload?: unknown, token = tokenAdmin) {
  return ctx.app.inject({ method: metodo, url, payload: payload as InjectOptions['payload'], headers: bearer(token) });
}

/** GitHub simulado: repo privado con rama main y dos ramas de agentes. */
function githubSimulado(extra: Parameters<typeof fetchSimulado>[0] = {}) {
  return fetchSimulado({
    [`GET https://api.github.com/repos/${REPO}`]: () =>
      json({
        private: true,
        default_branch: 'main',
        html_url: `https://github.com/${REPO}`,
        permissions: { admin: false, push: true, pull: true },
      }),
    [`GET https://api.github.com/repos/${REPO}/branches/main`]: () =>
      json({
        name: 'main',
        commit: {
          sha: 'abc123',
          html_url: `https://github.com/${REPO}/commit/abc123`,
          commit: { message: 'Primer commit\n\nDetalle', author: { name: 'Xavi', date: '2026-09-01T10:00:00Z' } },
        },
      }),
    [`GET https://api.github.com/repos/${REPO}/branches`]: () =>
      json([{ name: 'main' }, { name: 'agentes/tarea-1' }, { name: 'feature/x' }, { name: 'agentes/tarea-2' }]),
    'GET https://api.anthropic.com/v1/models': () =>
      json({
        data: [
          { id: 'claude-opus-5', type: 'model', display_name: 'Claude Opus 5', created_at: '2026-01-01T00:00:00Z' },
          { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5', created_at: '2026-01-01T00:00:00Z' },
        ],
        has_more: false,
        first_id: 'claude-opus-5',
        last_id: 'claude-sonnet-5',
      }),
    ...extra,
  });
}

async function crearProveedor(token = tokenAdmin, nombre = 'Claude') {
  const r = await pedir('POST', '/api/proveedores', { nombre, tipo: 'anthropic', apiKey: CLAVE_ANTHROPIC }, token);
  expect(r.statusCode).toBe(201);
  return r.json<ProveedorPublico>();
}

const agenteBase = (proveedorId: string, nombre = 'Dev') => ({
  nombre,
  rol: 'desarrollador',
  instrucciones: 'Escribe código limpio.',
  proveedorId,
  modelo: 'claude-opus-5',
  herramientas: ['leer_archivos', 'escribir_archivos'],
  limites: { maxTokensPorTarea: 100_000, maxCostoUsdPorTarea: 2, maxMinutosPorTarea: 30 },
});

async function crearProyecto(token = tokenAdmin, extra: Record<string, unknown> = {}) {
  return pedir('POST', '/api/proyectos', { nombre: 'Demo', repositorio: REPO, token: TOKEN_GITHUB, ...extra }, token);
}

describe('proveedores de modelos', () => {
  it('guarda la clave cifrada y nunca la devuelve', async () => {
    await preparar();
    const p = await crearProveedor();
    expect(p.claveMascara).toBe('••••abcd');

    const fila = ctx.db.prepare('SELECT clave_cifrada FROM proveedores WHERE id = ?').get(p.id) as { clave_cifrada: string };
    expect(fila.clave_cifrada).not.toContain(CLAVE_ANTHROPIC);

    const lista = await pedir('GET', '/api/proveedores');
    expect(lista.body).not.toContain(CLAVE_ANTHROPIC);
    const auditoria = JSON.stringify(ctx.db.prepare('SELECT * FROM auditoria').all());
    expect(auditoria).not.toContain(CLAVE_ANTHROPIC);
  });

  it('exige clave para Anthropic y URL para compatibles', async () => {
    await preparar();
    expect((await pedir('POST', '/api/proveedores', { nombre: 'A', tipo: 'anthropic' })).statusCode).toBe(400);
    expect((await pedir('POST', '/api/proveedores', { nombre: 'B', tipo: 'openai_compatible' })).statusCode).toBe(400);
  });

  it('valida la URL de proveedores compatibles (HTTPS, sin red privada)', async () => {
    await preparar();
    const crear = (urlBase: string) => pedir('POST', '/api/proveedores', { nombre: urlBase, tipo: 'openai_compatible', urlBase });
    expect((await crear('http://ejemplo.com/v1')).json().error.codigo).toBe('URL_INSEGURA');
    expect((await crear('https://10.0.0.5/v1')).json().error.codigo).toBe('URL_PRIVADA');
    expect((await crear('https://169.254.169.254/latest')).json().error.codigo).toBe('URL_PRIVADA');
    expect((await crear('http://localhost:11434/v1')).statusCode).toBe(201);
    expect((await crear('https://openrouter.ai/api/v1')).statusCode).toBe(201);
  });

  it('prueba la conexión con el SDK de Anthropic y guarda los modelos', async () => {
    const simulado = githubSimulado();
    await preparar({ fetchExterno: simulado.fetch });
    const p = await crearProveedor();

    const r = (await pedir('POST', `/api/proveedores/${p.id}/probar`)).json<ResultadoPrueba>();
    expect(r).toMatchObject({ ok: true, modelos: ['claude-opus-5', 'claude-sonnet-5'] });

    const llamada = simulado.llamadas.find((l) => l.url.startsWith('https://api.anthropic.com/v1/models'))!;
    expect(llamada.cabeceras['x-api-key']).toBe(CLAVE_ANTHROPIC);
    expect(llamada.cabeceras['anthropic-version']).toBeTruthy();

    const guardado = (await pedir('GET', '/api/proveedores')).json<ProveedorPublico[]>()[0]!;
    expect(guardado.ultimaPrueba?.ok).toBe(true);
    expect(guardado.modelosDisponibles).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('informa una clave rechazada sin fallar la petición', async () => {
    const simulado = fetchSimulado({
      'GET https://api.anthropic.com/v1/models': () =>
        json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    });
    await preparar({ fetchExterno: simulado.fetch });
    const p = await crearProveedor();
    const r = await pedir('POST', `/api/proveedores/${p.id}/probar`);
    expect(r.statusCode).toBe(200);
    expect(r.json<ResultadoPrueba>()).toEqual({ ok: false, mensaje: 'Anthropic rechazó la clave API.', modelos: [] });
  });

  it('prueba un proveedor local compatible sin enviar credenciales', async () => {
    const simulado = fetchSimulado({
      'GET http://localhost:11434/v1/models': () => json({ data: [{ id: 'llama3' }, { id: 'qwen' }] }),
    });
    await preparar({ fetchExterno: simulado.fetch });
    const p = (
      await pedir('POST', '/api/proveedores', { nombre: 'Ollama', tipo: 'openai_compatible', urlBase: 'http://localhost:11434/v1/' })
    ).json<ProveedorPublico>();
    expect(p.urlBase).toBe('http://localhost:11434/v1');
    const r = (await pedir('POST', `/api/proveedores/${p.id}/probar`)).json<ResultadoPrueba>();
    expect(r.modelos).toEqual(['llama3', 'qwen']);
    expect(simulado.llamadas[0]!.cabeceras.authorization).toBeUndefined();
  });

  it('cambiar la clave invalida la prueba anterior', async () => {
    await preparar({ fetchExterno: githubSimulado().fetch });
    const p = await crearProveedor();
    await pedir('POST', `/api/proveedores/${p.id}/probar`);
    const editado = (await pedir('PATCH', `/api/proveedores/${p.id}`, { apiKey: 'sk-ant-nueva-clave-9999' })).json<ProveedorPublico>();
    expect(editado.claveMascara).toBe('••••9999');
    expect(editado.ultimaPrueba).toBeNull();
    expect(editado.modelosDisponibles).toEqual([]);
  });

  it('no permite eliminar un proveedor que usan agentes', async () => {
    await preparar();
    const p = await crearProveedor();
    await pedir('POST', '/api/agentes', agenteBase(p.id));
    const r = await pedir('DELETE', `/api/proveedores/${p.id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.codigo).toBe('PROVEEDOR_EN_USO');
  });
});

describe('agentes', () => {
  it('crea, edita y elimina un agente', async () => {
    await preparar();
    const p = await crearProveedor();
    const creado = (await pedir('POST', '/api/agentes', agenteBase(p.id))).json<AgentePublico>();
    expect(creado).toMatchObject({ nombre: 'Dev', proveedorNombre: 'Claude', activo: true, herramientas: ['leer_archivos', 'escribir_archivos'] });

    const editado = (await pedir('PATCH', `/api/agentes/${creado.id}`, { rol: 'revisor', activo: false })).json<AgentePublico>();
    expect(editado).toMatchObject({ rol: 'revisor', activo: false, modelo: 'claude-opus-5' });

    expect((await pedir('DELETE', `/api/agentes/${creado.id}`)).statusCode).toBe(204);
    expect((await pedir('GET', `/api/agentes/${creado.id}`)).statusCode).toBe(404);
  });

  it('rechaza herramientas desconocidas y límites fuera de rango', async () => {
    await preparar();
    const p = await crearProveedor();
    const conHerramienta = await pedir('POST', '/api/agentes', { ...agenteBase(p.id), herramientas: ['push_a_produccion'] });
    expect(conHerramienta.statusCode).toBe(400);
    const conLimite = await pedir('POST', '/api/agentes', {
      ...agenteBase(p.id),
      limites: { maxTokensPorTarea: 5, maxCostoUsdPorTarea: 2, maxMinutosPorTarea: 30 },
    });
    expect(conLimite.statusCode).toBe(400);
  });

  it('valida el agente completo al editar', async () => {
    await preparar();
    const p = await crearProveedor();
    const a = (await pedir('POST', '/api/agentes', agenteBase(p.id))).json<AgentePublico>();
    expect((await pedir('PATCH', `/api/agentes/${a.id}`, { modelo: '' })).statusCode).toBe(400);
  });

  it('respeta el límite de agentes por usuario', async () => {
    await preparar({ env: { MAX_AGENTES_POR_USUARIO: '2' } });
    const p = await crearProveedor();
    expect((await pedir('POST', '/api/agentes', agenteBase(p.id, 'A1'))).statusCode).toBe(201);
    expect((await pedir('POST', '/api/agentes', agenteBase(p.id, 'A2'))).statusCode).toBe(201);
    const r = await pedir('POST', '/api/agentes', agenteBase(p.id, 'A3'));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.codigo).toBe('LIMITE_AGENTES');
  });

  it('rechaza nombres duplicados', async () => {
    await preparar();
    const p = await crearProveedor();
    await pedir('POST', '/api/agentes', agenteBase(p.id));
    expect((await pedir('POST', '/api/agentes', agenteBase(p.id))).statusCode).toBe(409);
  });
});

describe('proyectos de GitHub', () => {
  it('conecta un repositorio verificando acceso y rama en GitHub', async () => {
    const simulado = githubSimulado();
    await preparar({ fetchExterno: simulado.fetch });
    const r = await crearProyecto();
    expect(r.statusCode).toBe(201);
    const p = r.json<ProyectoPublico>();
    expect(p).toMatchObject({ repositorio: REPO, ramaBase: 'main', privado: true, tokenMascara: '••••wxyz', avisos: [] });
    expect(r.body).not.toContain(TOKEN_GITHUB);
    expect(simulado.llamadas[0]!.cabeceras.authorization).toBe(`Bearer ${TOKEN_GITHUB}`);

    const fila = ctx.db.prepare('SELECT token_cifrado FROM proyectos').get() as { token_cifrado: string };
    expect(fila.token_cifrado).not.toContain(TOKEN_GITHUB);
  });

  it('advierte sobre tokens clásicos y permisos de administrador', async () => {
    const simulado = githubSimulado({
      [`GET https://api.github.com/repos/${REPO}`]: () =>
        json({ private: false, default_branch: 'main', html_url: '', permissions: { admin: true, push: true, pull: true } }),
    });
    await preparar({ fetchExterno: simulado.fetch });
    const p = (await crearProyecto(tokenAdmin, { token: 'ghp_tokenclasico000000000000000000' })).json<ProyectoPublico>();
    expect(p.avisos).toHaveLength(2);
  });

  it('no guarda nada si GitHub no encuentra el repositorio', async () => {
    const simulado = fetchSimulado({ [`GET https://api.github.com/repos/${REPO}`]: () => json({ message: 'Not Found' }, 404) });
    await preparar({ fetchExterno: simulado.fetch });
    const r = await crearProyecto();
    expect(r.statusCode).toBe(400);
    expect(r.json().error.codigo).toBe('GITHUB_REPO_NO_ENCONTRADO');
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM proyectos').get() as { n: number }).n).toBe(0);
  });

  it('rechaza una rama base que no existe', async () => {
    await preparar({
      fetchExterno: githubSimulado({
        [`GET https://api.github.com/repos/${REPO}/branches/no-existe`]: () => json({ message: 'Branch not found' }, 404),
      }).fetch,
    });
    const r = await crearProyecto(tokenAdmin, { ramaBase: 'no-existe' });
    expect(r.json().error.codigo).toBe('GITHUB_RAMA_NO_ENCONTRADA');
  });

  it('informa un token inválido', async () => {
    await preparar({
      fetchExterno: fetchSimulado({ [`GET https://api.github.com/repos/${REPO}`]: () => json({}, 401) }).fetch,
    });
    expect((await crearProyecto()).json().error.codigo).toBe('GITHUB_TOKEN_INVALIDO');
  });

  it('consulta el estado real del repositorio', async () => {
    await preparar({ fetchExterno: githubSimulado().fetch });
    const p = (await crearProyecto()).json<ProyectoPublico>();
    const e = (await pedir('GET', `/api/proyectos/${p.id}/estado`)).json<EstadoRepositorio>();
    expect(e.rama).toBe('main');
    expect(e.ultimoCommit).toMatchObject({ sha: 'abc123', mensaje: 'Primer commit', autor: 'Xavi' });
    expect(e.ramasAgentes).toEqual(['agentes/tarea-1', 'agentes/tarea-2']);
  });

  it('habilita y deshabilita agentes por proyecto', async () => {
    await preparar({ fetchExterno: githubSimulado().fetch });
    const p = (await crearProyecto()).json<ProyectoPublico>();
    const prov = await crearProveedor();
    const a = (await pedir('POST', '/api/agentes', agenteBase(prov.id))).json<AgentePublico>();

    const con = (await pedir('PUT', `/api/proyectos/${p.id}/agentes/${a.id}`, { habilitado: true })).json<ProyectoPublico>();
    expect(con.agentes).toEqual([{ agenteId: a.id, nombre: 'Dev', rol: 'desarrollador', activo: true }]);
    expect((await pedir('GET', `/api/agentes/${a.id}`)).json<AgentePublico>().proyectos).toBe(1);

    const sin = (await pedir('PUT', `/api/proyectos/${p.id}/agentes/${a.id}`, { habilitado: false })).json<ProyectoPublico>();
    expect(sin.agentes).toEqual([]);
  });

  it('actualiza validaciones y límites; al rotar el token lo verifica de nuevo', async () => {
    const simulado = githubSimulado();
    await preparar({ fetchExterno: simulado.fetch });
    const p = (await crearProyecto()).json<ProyectoPublico>();
    const antes = simulado.llamadas.length;

    const editado = (
      await pedir('PATCH', `/api/proyectos/${p.id}`, {
        validaciones: [{ nombre: 'Pruebas', comando: 'npm test' }],
        limites: { maxAgentesSimultaneos: 5, presupuestoMensualUsd: 20 },
      })
    ).json<ProyectoPublico>();
    // requiereRed toma false por defecto: el sandbox no tiene red salvo que se pida.
    expect(editado.validaciones).toEqual([{ nombre: 'Pruebas', comando: 'npm test', requiereRed: false }]);
    expect(simulado.llamadas.length).toBe(antes); // sin cambios de token/rama no se consulta GitHub

    const rotado = (
      await pedir('PATCH', `/api/proyectos/${p.id}`, { token: 'github_pat_nuevo_0000000000000000000000_1111' })
    ).json<ProyectoPublico>();
    expect(rotado.tokenMascara).toBe('••••1111');
    expect(simulado.llamadas.at(-1)!.cabeceras.authorization).toBe('Bearer github_pat_nuevo_0000000000000000000000_1111');
  });
});

describe('aislamiento entre usuarios', () => {
  it('un usuario no ve ni modifica recursos de otro', async () => {
    await preparar({ fetchExterno: githubSimulado().fetch });
    const prov = await crearProveedor();
    const agente = (await pedir('POST', '/api/agentes', agenteBase(prov.id))).json<AgentePublico>();
    const proyecto = (await crearProyecto()).json<ProyectoPublico>();

    expect((await pedir('GET', '/api/proveedores', undefined, tokenUsuario)).json()).toEqual([]);
    expect((await pedir('GET', `/api/agentes/${agente.id}`, undefined, tokenUsuario)).statusCode).toBe(404);
    expect((await pedir('GET', `/api/proyectos/${proyecto.id}`, undefined, tokenUsuario)).statusCode).toBe(404);
    expect((await pedir('POST', `/api/proveedores/${prov.id}/probar`, undefined, tokenUsuario)).statusCode).toBe(404);
    expect((await pedir('DELETE', `/api/proyectos/${proyecto.id}`, undefined, tokenUsuario)).statusCode).toBe(404);

    // Tampoco puede crear un agente con el proveedor ajeno.
    const r = await pedir('POST', '/api/agentes', agenteBase(prov.id), tokenUsuario);
    expect(r.statusCode).toBe(404);
  });

  it('exige sesión en todas las rutas de recursos', async () => {
    await preparar();
    for (const url of ['/api/proveedores', '/api/agentes', '/api/proyectos', '/api/auditoria', '/api/resumen', '/api/catalogo']) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });
});

describe('auditoría y resumen', () => {
  it('el admin ve todo; un usuario solo lo suyo', async () => {
    await preparar();
    await crearProveedor(tokenUsuario, 'Del usuario');
    const admin = (await pedir('GET', '/api/auditoria?accion=proveedor.')).json<PaginaAuditoria>();
    expect(admin.entradas.map((e) => e.usuarioEmail)).toContain(EMAIL_2);

    const propia = (await pedir('GET', '/api/auditoria', undefined, tokenUsuario)).json<PaginaAuditoria>();
    expect(propia.entradas.every((e) => e.usuarioEmail === EMAIL_2)).toBe(true);
  });

  it('pagina de más reciente a más antiguo', async () => {
    await preparar();
    const p1 = (await pedir('GET', '/api/auditoria?limite=2')).json<PaginaAuditoria>();
    expect(p1.entradas).toHaveLength(2);
    expect(p1.siguiente).not.toBeNull();
    const p2 = (await pedir('GET', `/api/auditoria?limite=2&antesDe=${p1.siguiente}`)).json<PaginaAuditoria>();
    expect(p2.entradas[0]!.id).toBeLessThan(p1.entradas[1]!.id);
  });

  it('el resumen cuenta los recursos del usuario', async () => {
    await preparar();
    const p = await crearProveedor();
    await pedir('POST', '/api/agentes', agenteBase(p.id, 'A'));
    await pedir('POST', '/api/agentes', { ...agenteBase(p.id, 'B'), activo: false });
    expect((await pedir('GET', '/api/resumen')).json<Resumen>()).toEqual({
      proyectos: 0,
      agentes: 2,
      agentesActivos: 1,
      proveedores: 1,
      aprobacionesPendientes: 0,
      tareasActivas: 0,
      tareasEsperando: 0,
    });
    expect((await pedir('GET', '/api/resumen', undefined, tokenUsuario)).json<Resumen>().agentes).toBe(0);
  });
});
