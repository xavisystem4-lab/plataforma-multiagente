import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentePublico,
  AprobacionPublica,
  DiffTarea,
  EventoTiempoReal,
  ProyectoPublico,
  PublicacionTarea,
  RespuestaLogin,
  Resumen,
  TareaPublica,
} from '@softgala/shared';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { verificarRamaPublicable } from '../src/ejecucion/git';
import type { AdaptadorModelos, RespuestaTurno } from '../src/modelos/adaptadores';
import { interpretarDiff } from '../src/servicios/revision';
import { bearer, crearContexto, crearOrigen, EMAIL_2, fetchSimulado, git, json, login, temporales, type Contexto } from './ayudantes';

const REPO = 'softgala/demo';

let n = 0;
const llamar = (nombre: string, entrada: unknown): RespuestaTurno => ({
  mensaje: { rol: 'asistente', texto: '', llamadas: [{ id: `ll_${++n}`, nombre, entrada }] },
  fin: 'herramientas',
  uso: { entrada: 100, salida: 20 },
});
const terminar = (texto: string): RespuestaTurno => ({ mensaje: { rol: 'asistente', texto, llamadas: [] }, fin: 'fin_turno', uso: { entrada: 100, salida: 20 } });

/** El agente crea src/nuevo.js, modifica app.js y borra viejo.txt (vía reemplazo no se puede borrar: solo crea y modifica). */
function modeloQueCambia(): AdaptadorModelos {
  const pasos = [
    () => llamar('escribir_archivo', { ruta: 'src/nuevo.js', contenido: 'export const nuevo = true;\n' }),
    () => llamar('reemplazar_texto', { ruta: 'app.js', buscar: 'console.log("hola");', reemplazar: 'console.log("hola mundo");' }),
    () => terminar('Agregué src/nuevo.js y cambié el saludo.'),
  ];
  return { listarModelos: async () => ['m'], turno: async () => (pasos.shift() ?? (() => terminar('Fin.')))() };
}

let ctx: Contexto;
let token: string;
let origen: ReturnType<typeof crearOrigen>;
let proyectoId: string;
let github: ReturnType<typeof fetchSimulado>;
/** Estado simulado del PR en GitHub. */
let pr: { state: string; merged: boolean; merge_commit_sha: string | null };

afterEach(async () => {
  if (!ctx) return;
  await ctx.app.close();
  ctx.db.close();
  ctx = undefined as unknown as Contexto;
});

const pedir = (metodo: InjectOptions['method'], url: string, payload?: unknown, t = token) =>
  ctx.app.inject({ method: metodo, url, payload: payload as InjectOptions['payload'], headers: bearer(t) });

async function prepararTareaCompletada(conCambios = true): Promise<TareaPublica> {
  origen = crearOrigen();
  pr = { state: 'open', merged: false, merge_commit_sha: null };
  let siguientePr = 7;
  github = fetchSimulado({
    [`GET https://api.github.com/repos/${REPO}`]: () =>
      json({ private: true, default_branch: 'main', html_url: '', permissions: { admin: false, push: true, pull: true } }),
    [`GET https://api.github.com/repos/${REPO}/branches/main`]: () =>
      json({ name: 'main', commit: { sha: 'x', html_url: '', commit: { message: 'Inicial', author: null } } }),
    [`POST https://api.github.com/repos/${REPO}/pulls`]: () => {
      const numero = siguientePr++;
      return json({ number: numero, html_url: `https://github.com/${REPO}/pull/${numero}` }, 201);
    },
    [`GET https://api.github.com/repos/${REPO}/pulls/7`]: () => json({ number: 7, html_url: `https://github.com/${REPO}/pull/7`, ...pr }),
    [`PATCH https://api.github.com/repos/${REPO}/pulls/7`]: () => {
      pr.state = 'closed';
      return json({ number: 7, state: 'closed' });
    },
  });
  const modelo = conCambios ? modeloQueCambia() : { listarModelos: async () => ['m'], turno: async () => terminar('No hice cambios.') };
  ctx = await crearContexto({ fetchExterno: github.fetch, adaptadores: () => modelo, git: { protocolos: 'file', urlClonado: () => origen.url } });
  token = (await login(ctx.app)).json<RespuestaLogin>().accessToken;

  const prov = (await pedir('POST', '/api/proveedores', { nombre: 'Local', tipo: 'openai_compatible', urlBase: 'http://localhost:1/v1' })).json();
  const agente = (
    await pedir('POST', '/api/agentes', {
      nombre: 'Dev',
      rol: 'desarrollador',
      instrucciones: '',
      proveedorId: prov.id,
      modelo: 'm',
      herramientas: ['leer_archivos', 'escribir_archivos'],
      limites: { maxTokensPorTarea: 100_000, maxCostoUsdPorTarea: 5, maxMinutosPorTarea: 30 },
    })
  ).json<AgentePublico>();
  const proyecto = (await pedir('POST', '/api/proyectos', { nombre: 'Demo', repositorio: REPO, token: 'github_pat_prueba_000000000000000000000000_wxyz' })).json<ProyectoPublico>();
  proyectoId = proyecto.id;
  await pedir('PUT', `/api/proyectos/${proyecto.id}/agentes/${agente.id}`, { habilitado: true });
  const t = (await pedir('POST', `/api/proyectos/${proyecto.id}/continuar`, { objetivo: 'Agrega el módulo nuevo' })).json<TareaPublica>();
  await ctx.app.orquestador.esperarInactividad();
  return (await pedir('GET', `/api/tareas/${t.id}`)).json<TareaPublica>();
}

const aprobaciones = async (estado = 'pendiente') => (await pedir('GET', `/api/aprobaciones?estado=${estado}`)).json<AprobacionPublica[]>();
const ramasOrigen = () => git(origen.bare, 'branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);
const tarea = async (id: string) => (await pedir('GET', `/api/tareas/${id}`)).json<TareaPublica>();

describe('solicitud de aprobación', () => {
  it('una tarea completada con cambios crea una solicitud pendiente y no publica nada', async () => {
    const t = await prepararTareaCompletada();
    expect(t.estado).toBe('completada');
    expect(t.publicacion?.estado).toBe('pendiente');

    const lista = await aprobaciones();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ tipo: 'publicar', estado: 'pendiente', tareaId: t.id, rama: t.rama, archivos: 2 });
    expect((await pedir('GET', '/api/resumen')).json<Resumen>().aprobacionesPendientes).toBe(1);
    expect(ramasOrigen()).toEqual(['main']); // nada llegó a "GitHub"
    const eventos = (await pedir('GET', `/api/tareas/${t.id}/eventos`)).json<EventoTiempoReal[]>();
    expect(eventos.map((e) => e.tipo)).toContain('approval.requested');
  });

  it('una tarea sin cambios no genera solicitud', async () => {
    const t = await prepararTareaCompletada(false);
    expect(t.estado).toBe('completada');
    expect(t.publicacion).toBeNull();
    expect(await aprobaciones()).toEqual([]);
  });
});

describe('diff', () => {
  it('muestra archivos agregados y modificados con sus líneas', async () => {
    const t = await prepararTareaCompletada();
    const d = (await pedir('GET', `/api/tareas/${t.id}/diff`)).json<DiffTarea>();
    expect(d).toMatchObject({ base: 'main', rama: t.rama, adiciones: 2, eliminaciones: 1, truncado: false });
    const porRuta = Object.fromEntries(d.archivos.map((a) => [a.ruta, a]));
    expect(porRuta['src/nuevo.js']).toMatchObject({ estado: 'agregado', adiciones: 1, eliminaciones: 0 });
    expect(porRuta['app.js']).toMatchObject({ estado: 'modificado', adiciones: 1, eliminaciones: 1 });
    expect(porRuta['app.js']!.parche).toContain('-console.log("hola");');
    expect(porRuta['app.js']!.parche).toContain('+console.log("hola mundo");');
  });

  it('interpreta renombrados, binarios y recorta parches enormes', () => {
    const ns = 'R090\0viejo.txt\0nuevo.txt\0M\0img.png\0M\0grande.txt\0';
    const num = '1\t1\t\0viejo.txt\0nuevo.txt\0-\t-\timg.png\0' + '200000\t0\tgrande.txt\0';
    const parche = `diff --git a/viejo.txt b/nuevo.txt\n+x\ndiff --git a/img.png b/img.png\nBinary files differ\ndiff --git a/grande.txt b/grande.txt\n${'+línea\n'.repeat(50_000)}`;
    const r = interpretarDiff(ns, num, parche);
    expect(r.archivos.map((a) => [a.ruta, a.rutaAnterior, a.estado, a.binario])).toEqual([
      ['nuevo.txt', 'viejo.txt', 'renombrado', false],
      ['img.png', null, 'modificado', true],
      ['grande.txt', null, 'modificado', false],
    ]);
    expect(r.archivos[2]!.truncado).toBe(true);
    expect(r.truncado).toBe(true);
    expect(r.archivos[2]!.parche.length).toBeLessThanOrEqual(100_000);
  });
});

describe('aprobar y publicar', () => {
  it('publica solo la rama del agente y abre un Pull Request hacia la base', async () => {
    const t = await prepararTareaCompletada();
    const [a] = await aprobaciones();
    const r = await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, { crearPR: true, comentario: 'Se ve bien' });
    expect(r.statusCode).toBe(200);
    expect(r.json<AprobacionPublica>()).toMatchObject({ estado: 'aprobada', comentario: 'Se ve bien' });

    // La rama llegó al origen con el commit del agente; main no cambió.
    expect(ramasOrigen().sort()).toEqual([t.rama, 'main'].sort());
    expect(git(origen.bare, 'show', `${t.rama}:src/nuevo.js`)).toContain('nuevo');
    expect(git(origen.bare, 'log', '--oneline', 'main')).not.toContain('Agrega el módulo');

    const post = github.llamadas.find((l) => l.metodo === 'POST' && l.url.endsWith('/pulls'))!;
    expect(post.cuerpo).toMatchObject({ head: t.rama, base: 'main', title: 'Agrega el módulo nuevo' });
    expect(post.cabeceras.authorization).toMatch(/^Bearer github_pat_/);

    const final = await tarea(t.id);
    expect(final.publicacion).toMatchObject({ estado: 'publicada', rama: t.rama, prNumero: 7, prUrl: `https://github.com/${REPO}/pull/7` });
    expect(await aprobaciones()).toEqual([]);

    const acciones = (ctx.db.prepare('SELECT accion FROM auditoria').all() as { accion: string }[]).map((x) => x.accion);
    expect(acciones).toEqual(expect.arrayContaining(['aprobacion.solicitada', 'github.push', 'github.pr_creado', 'aprobacion.aprobada']));
  });

  it('puede publicar sin abrir Pull Request', async () => {
    const t = await prepararTareaCompletada();
    const [a] = await aprobaciones();
    await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, { crearPR: false });
    expect(ramasOrigen()).toContain(t.rama);
    expect(github.llamadas.some((l) => l.url.endsWith('/pulls'))).toBe(false);
    expect((await tarea(t.id)).publicacion).toMatchObject({ estado: 'publicada', prNumero: null });
  });

  it('no permite resolver dos veces la misma solicitud', async () => {
    await prepararTareaCompletada();
    const [a] = await aprobaciones();
    await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, {});
    const otra = await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, {});
    expect(otra.statusCode).toBe(409);
    expect((await pedir('POST', `/api/aprobaciones/${a!.id}/rechazar`, {})).statusCode).toBe(409);
  });

  it('si el push falla, la solicitud sigue pendiente', async () => {
    await prepararTareaCompletada();
    const [a] = await aprobaciones();
    // El "GitHub" rechaza cualquier push (hook del lado del servidor).
    writeFileSync(path.join(origen.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "rechazado por el servidor" >&2\nexit 1\n');
    const r = await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, {});
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ codigo: 'GIT_ERROR', mensaje: expect.stringContaining('rechazado por el servidor') });
    expect(r.body).not.toContain('github_pat_');
    expect((await aprobaciones()).map((x) => x.id)).toEqual([a!.id]);
    expect(ramasOrigen()).toEqual(['main']);
    expect(github.llamadas.some((l) => l.url.endsWith('/pulls'))).toBe(false); // sin push no hay PR
  });

  it('un usuario no puede aprobar solicitudes de otro', async () => {
    await prepararTareaCompletada();
    const [a] = await aprobaciones();
    const otro = (await login(ctx.app, undefined, 'Otro', EMAIL_2)).json<RespuestaLogin>().accessToken;
    expect((await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, {}, otro)).statusCode).toBe(404);
    expect((await pedir('GET', '/api/aprobaciones', undefined, otro)).json()).toEqual([]);
    expect(ramasOrigen()).toEqual(['main']);
  });
});

describe('rechazar y descartar', () => {
  it('rechazar sin descartar conserva la rama local; descartar la elimina del servidor', async () => {
    const t = await prepararTareaCompletada();
    const [a] = await aprobaciones();
    const r = await pedir('POST', `/api/aprobaciones/${a!.id}/rechazar`, { comentario: 'No era esto', descartar: true });
    expect(r.json<AprobacionPublica>()).toMatchObject({ estado: 'rechazada', comentario: 'No era esto' });
    expect((await tarea(t.id)).publicacion?.estado).toBe('descartada');

    const repo = path.join(ctx.config.dirDatos, 'espacios', proyectoId, 'repo');
    expect(git(repo, 'branch', '--list', t.rama).trim()).toBe('');
    expect(existsSync(path.join(ctx.config.dirDatos, 'espacios', proyectoId, 'tareas', t.id))).toBe(false);
    expect((await pedir('GET', `/api/tareas/${t.id}/diff`)).json().error.codigo).toBe('CAMBIOS_DESCARTADOS');
    expect(ramasOrigen()).toEqual(['main']);
  });
});

describe('revertir', () => {
  it('con el PR abierto: lo cierra y borra la rama remota', async () => {
    const t = await prepararTareaCompletada();
    const [a] = await aprobaciones();
    await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, {});
    expect(ramasOrigen()).toContain(t.rama);

    const r = await pedir('POST', `/api/tareas/${t.id}/revertir`);
    expect(r.statusCode).toBe(200);
    expect(r.json<PublicacionTarea>()).toMatchObject({ estado: 'revertida', nota: expect.stringContaining('Se cerró el Pull Request') });
    expect(github.llamadas.some((l) => l.metodo === 'PATCH' && l.url.endsWith('/pulls/7'))).toBe(true);
    expect(ramasOrigen()).toEqual(['main']);
  });

  it('con el PR fusionado: abre un PR de reversión sin tocar la rama base', async () => {
    const t = await prepararTareaCompletada();
    const [a] = await aprobaciones();
    await pedir('POST', `/api/aprobaciones/${a!.id}/aprobar`, {});

    // Simula que el usuario fusionó el PR en GitHub (merge commit en main).
    const trabajo = mkdtempSync(path.join(tmpdir(), 'softgala-prueba-merge-'));
    temporales.add(trabajo);
    execFileSync('git', ['clone', '-q', origen.bare, trabajo]);
    git(trabajo, 'merge', '--no-ff', '-q', '-m', 'Merge pull request #7', `origin/${t.rama}`);
    git(trabajo, 'push', '-q', 'origin', 'main');
    const shaMain = git(trabajo, 'rev-parse', 'HEAD').trim();
    pr = { state: 'closed', merged: true, merge_commit_sha: shaMain };

    const r = (await pedir('POST', `/api/tareas/${t.id}/revertir`)).json<PublicacionTarea>();
    expect(r).toMatchObject({ estado: 'revertida', reversionPrUrl: `https://github.com/${REPO}/pull/8` });

    const ramaRev = `revertir/${t.rama.replace(/^agentes\//, '')}`;
    expect(ramasOrigen()).toContain(ramaRev);
    // La rama de reversión ya no tiene el archivo del agente; main sigue igual (lo fusiona el usuario).
    expect(() => git(origen.bare, 'show', `${ramaRev}:src/nuevo.js`)).toThrow();
    expect(git(origen.bare, 'rev-parse', 'main').trim()).toBe(shaMain);
    const post = github.llamadas.filter((l) => l.metodo === 'POST' && l.url.endsWith('/pulls')).at(-1)!;
    expect(post.cuerpo).toMatchObject({ head: ramaRev, base: 'main' });
  });

  it('solo se revierte lo publicado', async () => {
    const t = await prepararTareaCompletada();
    expect((await pedir('POST', `/api/tareas/${t.id}/revertir`)).json().error.codigo).toBe('NO_PUBLICADA');
  });
});

describe('salvaguardas de Git', () => {
  it('solo permite publicar ramas agentes/* o revertir/*', () => {
    expect(() => verificarRamaPublicable('agentes/tarea-1')).not.toThrow();
    expect(() => verificarRamaPublicable('revertir/tarea-1')).not.toThrow();
    for (const mala of ['main', 'master', 'develop', 'refs/heads/main', 'agentes/../main', '+agentes/x', 'agentes/x:main', ':main']) {
      expect(() => verificarRamaPublicable(mala)).toThrow(/no permitida/);
    }
  });
});
