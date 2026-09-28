import { randomUUID } from 'node:crypto';
import type { AgentePublico, ProyectoPublico, RespuestaLogin, TareaPublica } from '@softgala/shared';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { calcularAvance, type DatosAvance } from '../src/ejecucion/avance';
import { bearer, crearContexto, EMAIL_2, fetchSimulado, json, login, type Contexto } from './ayudantes';

const base: DatosAvance = { estado: 'ejecutando', modo: 'individual', fase: null, pasos: 0, subtareas: { total: 0, completadas: 0 }, validando: false };

describe('cálculo del avance', () => {
  it('individual: estimado, crece con los pasos sin llegar a 100 hasta terminar', () => {
    const valores = [0, 1, 5, 10, 30, 200].map((pasos) => calcularAvance({ ...base, pasos }));
    expect(valores.every((v) => v.estimado)).toBe(true);
    const porcentajes = valores.map((v) => v.porcentaje);
    expect(porcentajes).toEqual([...porcentajes].sort((a, b) => a - b)); // nunca retrocede
    expect(Math.max(...porcentajes)).toBeLessThanOrEqual(88);
    expect(calcularAvance({ ...base, pasos: 3 }).etapa).toBe('3 pasos');
    expect(calcularAvance({ ...base, pasos: 3, validando: true })).toMatchObject({ porcentaje: 92, etapa: 'Validando' });
    expect(calcularAvance({ ...base, estado: 'completada' })).toEqual({ porcentaje: 100, etapa: 'Completada', estimado: false });
  });

  it('equipo: avanza por fases y, en ejecución, por subtareas completadas (dato real)', () => {
    const eq = { ...base, modo: 'colaborativo' as const };
    expect(calcularAvance({ ...eq, fase: 'propuestas' }).porcentaje).toBe(10);
    expect(calcularAvance({ ...eq, fase: 'sintesis' }).porcentaje).toBe(32);
    const mitad = calcularAvance({ ...eq, fase: 'ejecucion', subtareas: { total: 4, completadas: 2 } });
    expect(mitad).toEqual({ porcentaje: 63, etapa: 'Subtareas 2 de 4', estimado: false });
    expect(calcularAvance({ ...eq, fase: 'integracion' }).porcentaje).toBe(94);
  });

  it('en cola es 0 % y los estados de espera conservan el porcentaje con su etapa', () => {
    expect(calcularAvance({ ...base, estado: 'en_cola' })).toMatchObject({ porcentaje: 0, etapa: 'En cola' });
    const pausada = calcularAvance({ ...base, estado: 'pausada', pasos: 10 });
    expect(pausada.etapa).toBe('Pausada');
    expect(pausada.porcentaje).toBe(calcularAvance({ ...base, pasos: 10 }).porcentaje);
  });
});

// ---------------------------------------------------------------------------

const REPO = 'softgala/demo';
let ctx: Contexto;
let token: string;
let github: ReturnType<typeof fetchSimulado>;

afterEach(async () => {
  if (!ctx) return;
  await ctx.app.close();
  ctx.db.close();
  ctx = undefined as unknown as Contexto;
});

const pedir = (metodo: InjectOptions['method'], url: string, payload?: unknown, t = token) =>
  ctx.app.inject({ method: metodo, url, payload: payload as InjectOptions['payload'], headers: bearer(t) });

async function preparar() {
  github = fetchSimulado({
    [`GET https://api.github.com/repos/${REPO}`]: () => json({ private: true, default_branch: 'main', html_url: '', permissions: { admin: false, push: true, pull: true } }),
    [`GET https://api.github.com/repos/${REPO}/branches/main`]: () => json({ name: 'main', commit: { sha: 'x', html_url: '', commit: { message: 'i', author: null } } }),
    [`GET https://api.github.com/repos/otro/repo`]: () => json({ private: false, default_branch: 'main', html_url: '', permissions: { admin: false, push: true, pull: true } }),
    [`GET https://api.github.com/repos/otro/repo/branches/main`]: () => json({ name: 'main', commit: { sha: 'x', html_url: '', commit: { message: 'i', author: null } } }),
  });
  ctx = await crearContexto({ fetchExterno: github.fetch });
  token = (await login(ctx.app)).json<RespuestaLogin>().accessToken;
  const tokenGh = 'github_pat_prueba_000000000000000000000000_wxyz';
  const a = (await pedir('POST', '/api/proyectos', { nombre: 'Zeta', repositorio: REPO, token: tokenGh })).json<ProyectoPublico>();
  const b = (await pedir('POST', '/api/proyectos', { nombre: 'Alfa', repositorio: 'otro/repo', token: tokenGh })).json<ProyectoPublico>();
  return { zeta: a, alfa: b };
}

describe('personalización de proyectos', () => {
  it('valores iniciales: sin fijar, color azul marino, sin nombre de ventana ni avance', async () => {
    const { zeta } = await preparar();
    expect(zeta).toMatchObject({ fijado: false, color: 'marino', nombreVentana: null, avance: null });
  });

  it('fijar pone el proyecto primero en la lista', async () => {
    const { zeta } = await preparar();
    const antes = (await pedir('GET', '/api/proyectos')).json<ProyectoPublico[]>().map((p) => p.nombre);
    expect(antes).toEqual(['Alfa', 'Zeta']);
    await pedir('PATCH', `/api/proyectos/${zeta.id}`, { fijado: true });
    const despues = (await pedir('GET', '/api/proyectos')).json<ProyectoPublico[]>();
    expect(despues.map((p) => [p.nombre, p.fijado])).toEqual([
      ['Zeta', true],
      ['Alfa', false],
    ]);
  });

  it('cambia color y nombre de ventana sin consultar GitHub; null restablece el nombre', async () => {
    const { zeta } = await preparar();
    const llamadasAntes = github.llamadas.length;
    const r = (await pedir('PATCH', `/api/proyectos/${zeta.id}`, { color: 'violeta', nombreVentana: 'Tienda · producción' })).json<ProyectoPublico>();
    expect(r).toMatchObject({ color: 'violeta', nombreVentana: 'Tienda · producción', nombre: 'Zeta' });
    expect(github.llamadas.length).toBe(llamadasAntes);
    expect((await pedir('PATCH', `/api/proyectos/${zeta.id}`, { nombreVentana: null })).json<ProyectoPublico>().nombreVentana).toBeNull();

    const acciones = (ctx.db.prepare('SELECT accion FROM auditoria').all() as { accion: string }[]).map((x) => x.accion);
    expect(acciones).toContain('proyecto.personalizado');
  });

  it('rechaza colores fuera de la paleta y nombres vacíos o muy largos', async () => {
    const { zeta } = await preparar();
    expect((await pedir('PATCH', `/api/proyectos/${zeta.id}`, { color: '#ff0000' })).statusCode).toBe(400);
    expect((await pedir('PATCH', `/api/proyectos/${zeta.id}`, { nombreVentana: '   ' })).statusCode).toBe(400);
    expect((await pedir('PATCH', `/api/proyectos/${zeta.id}`, { nombreVentana: 'x'.repeat(61) })).statusCode).toBe(400);
  });

  it('otro usuario no puede personalizar proyectos ajenos', async () => {
    const { zeta } = await preparar();
    const otro = (await login(ctx.app, undefined, 'Otro', EMAIL_2)).json<RespuestaLogin>().accessToken;
    expect((await pedir('PATCH', `/api/proyectos/${zeta.id}`, { fijado: true }, otro)).statusCode).toBe(404);
  });
});

describe('avance del proyecto', () => {
  it('refleja la tarea más reciente y el conteo de tareas', async () => {
    const { zeta } = await preparar();
    const prov = (await pedir('POST', '/api/proveedores', { nombre: 'L', tipo: 'openai_compatible', urlBase: 'http://localhost:1/v1' })).json();
    const ag = (
      await pedir('POST', '/api/agentes', {
        nombre: 'Dev',
        rol: 'desarrollador',
        proveedorId: prov.id,
        modelo: 'm',
        herramientas: [],
        limites: { maxTokensPorTarea: 1000, maxCostoUsdPorTarea: 1, maxMinutosPorTarea: 1 },
      })
    ).json<AgentePublico>();
    const usuarioId = (ctx.db.prepare('SELECT usuario_id FROM proyectos WHERE id = ?').get(zeta.id) as { usuario_id: string }).usuario_id;
    const insertar = (estado: string, creada: string, fase: string | null, modo = 'colaborativo') => {
      const id = randomUUID();
      ctx.db
        .prepare(
          `INSERT INTO tareas (id, usuario_id, proyecto_id, agente_id, objetivo, estado, modo, fase, rama, creada_en, actualizada_en)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agentes/x', ?, ?)`,
        )
        .run(id, usuarioId, zeta.id, ag.id, `Objetivo ${creada}`, estado, modo, fase, creada, creada);
      return id;
    };
    insertar('completada', '2026-01-01T00:00:00Z', 'integracion');
    const actual = insertar('ejecutando', '2026-01-02T00:00:00Z', 'ejecucion');
    const s = ctx.db.prepare(
      "INSERT INTO subtareas (id, tarea_id, indice, agente_id, titulo, descripcion, archivos, estado, rama, creada_en, actualizada_en) VALUES (?, ?, ?, ?, 't', 'd', '[]', ?, 'r', 'x', 'x')",
    );
    s.run(randomUUID(), actual, 1, ag.id, 'completada');
    s.run(randomUUID(), actual, 2, ag.id, 'ejecutando');

    const p = (await pedir('GET', `/api/proyectos/${zeta.id}`)).json<ProyectoPublico>();
    expect(p.avance).toMatchObject({
      tareaId: actual,
      estado: 'ejecutando',
      porcentaje: 63,
      etapa: 'Subtareas 1 de 2',
      estimado: false,
      tareasTotales: 2,
      tareasCompletadas: 1,
    });
    const t = (await pedir('GET', `/api/tareas/${actual}`)).json<TareaPublica>();
    expect(t.avance).toEqual({ porcentaje: 63, etapa: 'Subtareas 1 de 2', estimado: false });
  });
});
