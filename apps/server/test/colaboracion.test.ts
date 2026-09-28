import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentePublico, DecisionPublica, EventoTiempoReal, ProyectoPublico, RespuestaLogin, TareaPublica } from '@softgala/shared';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { seCruzan, validarPlan } from '../src/ejecucion/colaboracion';
import { EspaciosGit } from '../src/ejecucion/git';
import type { AdaptadorModelos, RespuestaTurno, SolicitudTurno } from '../src/modelos/adaptadores';
import { bearer, crearContexto, crearOrigen, fetchSimulado, git, json, login, temporales, type Contexto } from './ayudantes';

const REPO = 'softgala/demo';

// ---------------------------------------------------------------------------
// Modelo simulado por agente: identifica al agente por su prompt de sistema
// ---------------------------------------------------------------------------

type Paso = (s: SolicitudTurno) => RespuestaTurno | Promise<RespuestaTurno>;
let n = 0;
const llamar = (nombre: string, entrada: unknown): RespuestaTurno => ({
  mensaje: { rol: 'asistente', texto: '', llamadas: [{ id: `ll_${++n}`, nombre, entrada }] },
  fin: 'herramientas',
  uso: { entrada: 100, salida: 20 },
});
const terminar = (texto: string): RespuestaTurno => ({ mensaje: { rol: 'asistente', texto, llamadas: [] }, fin: 'fin_turno', uso: { entrada: 100, salida: 20 } });
const proponer = (texto: string) => () => llamar('entregar_propuesta', { propuesta: texto });
const revisar = (de_acuerdo: boolean, propuesta_actualizada?: string) => () =>
  llamar('entregar_revision', { revision: `Revisión: ${de_acuerdo ? 'de acuerdo' : 'hay diferencias'}.`, de_acuerdo, propuesta_actualizada });
const bloquear: Paso = (s) => new Promise((_, rechazar) => s.senal?.addEventListener('abort', () => rechazar(new Error('abortado'))));

class ModeloEquipo implements AdaptadorModelos {
  readonly solicitudes: { agente: string; s: SolicitudTurno }[] = [];
  constructor(private readonly guiones: Record<string, Paso[]>) {}
  async listarModelos() {
    return ['m'];
  }
  async turno(s: SolicitudTurno): Promise<RespuestaTurno> {
    const agente = /Eres "([^"]+)"/.exec(s.sistema)?.[1] ?? '?';
    this.solicitudes.push({ agente, s: structuredClone({ ...s, senal: undefined }) });
    const paso = this.guiones[agente]?.shift();
    if (!paso) return terminar(`${agente}: fin del guion.`);
    return paso(s);
  }
  /** Textos que recibió un agente (para comprobar qué contexto le llegó). */
  vio(agente: string): string {
    return JSON.stringify(this.solicitudes.filter((x) => x.agente === agente).map((x) => x.s.mensajes));
  }
}

// ---------------------------------------------------------------------------

let ctx: Contexto;
let token: string;
let modelo: ModeloEquipo;
let origen: ReturnType<typeof crearOrigen>;
let ids: { proyecto: string; coordinador: string; ana: string; beto: string };

afterEach(async () => {
  if (!ctx) return;
  await ctx.app.close();
  ctx.db.close();
  ctx = undefined as unknown as Contexto; // las pruebas unitarias no crean contexto
});

const pedir = (metodo: InjectOptions['method'], url: string, payload?: unknown) =>
  ctx.app.inject({ method: metodo, url, payload: payload as InjectOptions['payload'], headers: bearer(token) });

async function preparar(guiones: Record<string, Paso[]>) {
  origen = crearOrigen({ 'README.md': '# Demo\n', 'src/app.js': 'export const version = 1;\n' });
  modelo = new ModeloEquipo(guiones);
  const github = fetchSimulado({
    [`GET https://api.github.com/repos/${REPO}`]: () =>
      json({ private: true, default_branch: 'main', html_url: '', permissions: { admin: false, push: true, pull: true } }),
    [`GET https://api.github.com/repos/${REPO}/branches/main`]: () =>
      json({ name: 'main', commit: { sha: 'x', html_url: '', commit: { message: 'Inicial', author: null } } }),
  });
  ctx = await crearContexto({ fetchExterno: github.fetch, adaptadores: () => modelo, git: { protocolos: 'file', urlClonado: () => origen.url } });
  token = (await login(ctx.app)).json<RespuestaLogin>().accessToken;

  const prov = (await pedir('POST', '/api/proveedores', { nombre: 'Local', tipo: 'openai_compatible', urlBase: 'http://localhost:1/v1' })).json();
  const crearAgente = async (nombre: string, rol: string, herramientas: string[]) =>
    (
      await pedir('POST', '/api/agentes', {
        nombre,
        rol,
        instrucciones: '',
        proveedorId: prov.id,
        modelo: 'm',
        herramientas,
        limites: { maxTokensPorTarea: 100_000, maxCostoUsdPorTarea: 5, maxMinutosPorTarea: 30 },
      })
    ).json<AgentePublico>();
  const todas = ['leer_archivos', 'buscar_codigo', 'escribir_archivos', 'ejecutar_validaciones', 'git_commit'];
  const coordinador = await crearAgente('Coordinador', 'coordinador', ['leer_archivos', 'buscar_codigo']);
  const ana = await crearAgente('Ana', 'desarrollador', todas);
  const beto = await crearAgente('Beto', 'desarrollador', todas);
  const proyecto = (
    await pedir('POST', '/api/proyectos', { nombre: 'Demo', repositorio: REPO, token: 'github_pat_prueba_000000000000000000000000_wxyz' })
  ).json<ProyectoPublico>();
  for (const a of [coordinador, ana, beto]) await pedir('PUT', `/api/proyectos/${proyecto.id}/agentes/${a.id}`, { habilitado: true });
  ids = { proyecto: proyecto.id, coordinador: coordinador.id, ana: ana.id, beto: beto.id };
}

const equipo = (objetivo: string, maxRondas = 1) =>
  pedir('POST', `/api/proyectos/${ids.proyecto}/continuar`, {
    objetivo,
    modo: 'colaborativo',
    coordinadorId: ids.coordinador,
    participantes: [ids.ana, ids.beto],
    maxRondas,
  });
const esperar = () => ctx.app.orquestador.esperarInactividad();
const tarea = async (id: string) => (await pedir('GET', `/api/tareas/${id}`)).json<TareaPublica>();
const decisiones = async (id: string) => (await pedir('GET', `/api/tareas/${id}/decisiones`)).json<DecisionPublica[]>();
const eventos = async (id: string) => (await pedir('GET', `/api/tareas/${id}/eventos`)).json<EventoTiempoReal[]>();
const repo = () => path.join(ctx.config.dirDatos, 'espacios', ids.proyecto, 'repo');

const plan = (subtareas: { agente: string; archivos: string[]; titulo?: string }[]) => () =>
  llamar('registrar_plan', {
    decision: 'Se combinan ambas propuestas: Ana hace el código y Beto la documentación.',
    subtareas: subtareas.map((s, i) => ({ titulo: s.titulo ?? `Subtarea ${i + 1}`, descripcion: `Detalle de la subtarea ${i + 1}.`, ...s })),
  });

// ---------------------------------------------------------------------------

describe('colaboración multiagente: flujo completo', () => {
  it('propuestas, revisión con consenso, plan, subtareas en paralelo, integración y registro', async () => {
    await preparar({
      Ana: [
        proponer('Ana propone: crear src/a.js con la función.'),
        revisar(true),
        () => llamar('escribir_archivo', { ruta: 'src/a.js', contenido: 'export const a = 1;\n' }),
        () => terminar('Ana: listo src/a.js.'),
      ],
      Beto: [
        proponer('Beto propone: documentar en docs/uso.md.'),
        revisar(true),
        () => llamar('escribir_archivo', { ruta: 'docs/uso.md', contenido: '# Uso\n' }),
        () => terminar('Beto: listo docs/uso.md.'),
      ],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/a.js'] }, { agente: 'beto', archivos: ['docs/'] }])],
    });

    const r = await equipo('Agrega la función a y su documentación', 2);
    expect(r.statusCode).toBe(202);
    const t0 = r.json<TareaPublica>();
    expect(t0.modo).toBe('colaborativo');
    await esperar();

    const t = await tarea(t0.id);
    expect(t.estado).toBe('completada');
    expect(t.colaboracion?.fase).toBe('integracion');
    expect(t.colaboracion?.subtareas.map((s) => [s.indice, s.agenteNombre, s.estado, s.dependeDe])).toEqual([
      [1, 'Ana', 'completada', []],
      [2, 'Beto', 'completada', []],
    ]);
    expect(t.archivosModificados).toEqual(['docs/uso.md', 'src/a.js']);
    expect(t.resumen).toContain('Ana: listo src/a.js.');

    // La rama de la tarea integra el trabajo de ambos agentes.
    expect(git(repo(), 'show', `${t.rama}:src/a.js`)).toContain('export const a');
    expect(git(repo(), 'show', `${t.rama}:docs/uso.md`)).toContain('# Uso');
    expect(git(origen.bare, 'branch', '--list')).not.toContain('agentes/');

    // Registro de decisiones con el agente responsable. Hubo consenso: una sola ronda aunque se permitían 2.
    const d = await decisiones(t.id);
    const resumen = d.map((x) => `${x.tipo}:${x.agenteNombre}:${x.ronda}`);
    expect(resumen).toEqual(
      expect.arrayContaining(['propuesta:Ana:0', 'propuesta:Beto:0', 'revision:Ana:1', 'revision:Beto:1', 'decision:Coordinador:0']),
    );
    expect(d.filter((x) => x.tipo === 'revision')).toHaveLength(2);
    expect(d.filter((x) => x.tipo === 'integracion' && x.datos?.ok === true)).toHaveLength(2);

    // Cada agente vio las propuestas de los demás, y el coordinador todas.
    expect(modelo.vio('Ana')).toContain('Beto propone');
    expect(modelo.vio('Beto')).toContain('Ana propone');
    expect(modelo.vio('Coordinador')).toContain('Ana propone');

    const ev = await eventos(t.id);
    const tipos = ev.map((e) => e.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['agent.proposal', 'agent.review', 'coordinator.decision', 'task.completed']));
    expect(ev.some((e) => String((e.datos as { mensaje?: string }).mensaje).includes('Consenso alcanzado'))).toBe(true);
    expect(ev.some((e) => String((e.datos as { mensaje?: string }).mensaje).includes('en paralelo las subtareas 1, 2'))).toBe(true);
    // Los eventos de cada propuesta identifican al agente.
    expect(ev.find((e) => e.tipo === 'agent.proposal' && (e.datos as { agente: string }).agente === 'Ana')?.agenteId).toBe(ids.ana);
  });

  it('sin consenso se detiene en el máximo de rondas y el coordinador recibe las propuestas actualizadas', async () => {
    await preparar({
      Ana: [proponer('Ana: usar una clase.'), revisar(false, 'Ana (actualizada): usar funciones puras.'), revisar(false)],
      Beto: [proponer('Beto: usar un objeto.'), revisar(false), revisar(false)],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/a.js'] }])],
    });
    const t = (await equipo('Diseña el módulo', 2)).json<TareaPublica>();
    await esperar();

    const d = await decisiones(t.id);
    expect(d.filter((x) => x.tipo === 'revision').map((x) => x.ronda)).toEqual([1, 1, 2, 2]);
    expect(modelo.vio('Coordinador')).toContain('Ana (actualizada): usar funciones puras.');
    expect((await eventos(t.id)).some((e) => String((e.datos as { mensaje?: string }).mensaje).includes('Se completaron las 2 ronda(s)'))).toBe(true);
  });

  it('el coordinador corrige un plan inválido antes de continuar', async () => {
    await preparar({
      Ana: [proponer('Propuesta de Ana suficiente.')],
      Beto: [proponer('Propuesta de Beto suficiente.')],
      Coordinador: [
        plan([{ agente: 'Carlos', archivos: ['src/a.js'] }]),
        plan([{ agente: 'Ana', archivos: ['../fuera.js'] }]),
        plan([{ agente: 'Ana', archivos: ['src/a.js'] }]),
      ],
    });
    const t = (await equipo('Algo', 0)).json<TareaPublica>();
    await esperar();
    const vio = modelo.vio('Coordinador');
    expect(vio).toContain('\\"Carlos\\" no es del equipo');
    expect(vio).toContain('no es válida');
    expect((await tarea(t.id)).colaboracion?.subtareas).toHaveLength(1);
  });

  it('si el coordinador no registra un plan, la tarea falla sin ejecutar nada', async () => {
    await preparar({
      Ana: [proponer('Propuesta de Ana suficiente.')],
      Beto: [proponer('Propuesta de Beto suficiente.')],
      Coordinador: Array.from({ length: 80 }, () => () => terminar('Pienso que...')),
    });
    const t = (await equipo('Algo', 0)).json<TareaPublica>();
    await esperar();
    const final = await tarea(t.id);
    expect(final.estado).toBe('fallida');
    expect(final.error).toContain('máximo');
    expect(final.colaboracion?.subtareas).toEqual([]);
  });
});

describe('aislamiento y orden de las subtareas', () => {
  it('las subtareas que comparten archivos se ejecutan en orden y la segunda ve los cambios de la primera', async () => {
    await preparar({
      Ana: [
        proponer('Propuesta de Ana suficiente.'),
        () => llamar('escribir_archivo', { ruta: 'src/app.js', contenido: 'export const version = 2; // Ana\n' }),
        () => terminar('Ana terminó.'),
      ],
      Beto: [
        proponer('Propuesta de Beto suficiente.'),
        () => llamar('leer_archivo', { ruta: 'src/app.js' }),
        () => terminar('Beto terminó.'),
      ],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/app.js'] }, { agente: 'Beto', archivos: ['src/'] }])],
    });
    const t = (await equipo('Actualiza la versión', 0)).json<TareaPublica>();
    await esperar();
    const final = await tarea(t.id);
    expect(final.colaboracion?.subtareas.map((s) => s.dependeDe)).toEqual([[], [1]]);
    expect(final.estado).toBe('completada');
    expect(modelo.vio('Beto')).toContain('version = 2; // Ana');
  });

  it('un agente no puede escribir fuera de los archivos asignados', async () => {
    await preparar({
      Ana: [
        proponer('Propuesta de Ana suficiente.'),
        () => llamar('escribir_archivo', { ruta: 'src/otro.js', contenido: 'x' }),
        () => llamar('escribir_archivo', { ruta: 'src/a.js', contenido: 'export const a = 1;\n' }),
        () => terminar('Ana terminó.'),
      ],
      Beto: [proponer('Propuesta de Beto suficiente.')],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/a.js'] }])],
    });
    const t = (await equipo('Algo', 0)).json<TareaPublica>();
    await esperar();
    const final = await tarea(t.id);
    expect(final.estado).toBe('completada');
    expect(modelo.vio('Ana')).toContain('fuera de los archivos asignados');
    expect(() => git(repo(), 'show', `${final.rama}:src/otro.js`)).toThrow();
    expect(git(repo(), 'show', `${final.rama}:src/a.js`)).toContain('export const a');
  });

  it('las fases de análisis son de solo lectura', async () => {
    await preparar({
      Ana: [() => llamar('escribir_archivo', { ruta: 'src/x.js', contenido: 'x' }), proponer('Propuesta de Ana suficiente.')],
      Beto: [proponer('Propuesta de Beto suficiente.')],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/a.js'] }])],
    });
    await equipo('Algo', 0);
    await esperar();
    const herramientas = modelo.solicitudes.find((x) => x.agente === 'Ana')!.s.herramientas.map((h) => h.nombre).sort();
    expect(herramientas).toEqual(['buscar_texto', 'entregar_propuesta', 'leer_archivo', 'listar_directorio']);
    expect(modelo.vio('Ana')).toContain('no está autorizada');
  });

  it('si una subtarea falla, las que dependen de ella no se ejecutan y la tarea informa cuáles', async () => {
    await preparar({
      Ana: [proponer('Propuesta de Ana suficiente.'), () => ({ ...terminar(''), fin: 'rechazo' as const })],
      Beto: [proponer('Propuesta de Beto suficiente.')],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/app.js'] }, { agente: 'Beto', archivos: ['src/app.js'], titulo: 'Depende' }])],
    });
    const t = (await equipo('Algo', 0)).json<TareaPublica>();
    await esperar();
    const final = await tarea(t.id);
    expect(final.estado).toBe('fallida');
    expect(final.colaboracion?.subtareas.map((s) => s.estado)).toEqual(['fallida', 'fallida']);
    expect(final.colaboracion?.subtareas[1]!.error).toContain('depende');
    expect(final.error).toContain('#1');
    // Beto nunca recibió su subtarea.
    expect(modelo.vio('Beto')).not.toContain('TU SUBTAREA');
  });
});

describe('intervención, pausa y reanudación', () => {
  it('la pregunta de un agente en su subtarea llega al usuario y la respuesta vuelve a ese agente', async () => {
    await preparar({
      Ana: [proponer('Propuesta de Ana suficiente.'), () => terminar('Ana terminó.')],
      Beto: [
        proponer('Propuesta de Beto suficiente.'),
        () => llamar('solicitar_intervencion', { pregunta: '¿Documento en inglés o español?' }),
        (s) => {
          expect(JSON.stringify(s.mensajes.at(-1))).toContain('Respuesta del usuario: Español');
          return terminar('Beto documentó en español.');
        },
      ],
      Coordinador: [plan([{ agente: 'Ana', archivos: ['src/a.js'] }, { agente: 'Beto', archivos: ['docs/'] }])],
    });
    const t = (await equipo('Algo', 0)).json<TareaPublica>();
    await esperar();

    const esperando = await tarea(t.id);
    expect(esperando.estado).toBe('esperando_usuario');
    expect(esperando.pregunta).toContain('Beto');
    expect(esperando.pregunta).toContain('¿Documento en inglés o español?');
    expect(esperando.colaboracion?.subtareas.map((s) => s.estado)).toEqual(['completada', 'esperando_usuario']);

    await pedir('POST', `/api/tareas/${t.id}/responder`, { respuesta: 'Español' });
    await esperar();
    const final = await tarea(t.id);
    expect(final.estado).toBe('completada');
    expect(final.colaboracion?.subtareas[1]!.resumen).toBe('Beto documentó en español.');
    // Ana no repitió su trabajo al reanudar.
    expect(modelo.solicitudes.filter((x) => x.agente === 'Ana')).toHaveLength(2);
  });

  it('al pausar durante las propuestas y reanudar, solo se repite lo que faltaba', async () => {
    await preparar({
      Ana: [bloquear, proponer('Ana propone tras reanudar.')],
      Beto: [proponer('Propuesta de Beto suficiente.')],
      Coordinador: [plan([{ agente: 'Beto', archivos: ['docs/'] }])],
    });
    const t = (await equipo('Algo', 0)).json<TareaPublica>();
    for (let i = 0; i < 200 && (await decisiones(t.id)).length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    await pedir('POST', `/api/tareas/${t.id}/pausar`);
    await esperar();
    expect((await tarea(t.id)).estado).toBe('pausada');

    await pedir('POST', `/api/tareas/${t.id}/reanudar`);
    await esperar();
    expect((await tarea(t.id)).estado).toBe('completada');
    const propuestas = (await decisiones(t.id)).filter((d) => d.tipo === 'propuesta');
    expect(propuestas.map((p) => p.agenteNombre).sort()).toEqual(['Ana', 'Beto']);
    expect(modelo.solicitudes.filter((x) => x.agente === 'Beto' && JSON.stringify(x.s.mensajes).includes('FASE DE PROPUESTAS'))).toHaveLength(1);
  });
});

describe('validación de la solicitud y del registro', () => {
  it('rechaza configuraciones de equipo inválidas', async () => {
    await preparar({});
    const base = { objetivo: 'Algo', modo: 'colaborativo' };
    const probar = (extra: Record<string, unknown>) => pedir('POST', `/api/proyectos/${ids.proyecto}/continuar`, { ...base, ...extra });
    expect((await probar({ coordinadorId: ids.coordinador, participantes: [] })).statusCode).toBe(400);
    expect((await probar({ coordinadorId: ids.ana, participantes: [ids.ana] })).statusCode).toBe(400);
    expect((await probar({ coordinadorId: ids.coordinador, participantes: [ids.ana], maxRondas: 4 })).statusCode).toBe(400);
    await pedir('PUT', `/api/proyectos/${ids.proyecto}/agentes/${ids.beto}`, { habilitado: false });
    const r = await probar({ coordinadorId: ids.coordinador, participantes: [ids.beto] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.codigo).toBe('AGENTE_NO_HABILITADO');
  });

  it('el registro de decisiones no se puede modificar', async () => {
    await preparar({ Ana: [proponer('Propuesta de Ana suficiente.')], Beto: [proponer('Propuesta de Beto suficiente.')], Coordinador: [plan([{ agente: 'Ana', archivos: ['a.js'] }])] });
    await equipo('Algo', 0);
    await esperar();
    expect(() => ctx.db.exec("UPDATE decisiones SET contenido = 'alterado'")).toThrow(/no se puede modificar/);
  });
});

describe('plan: validación y dependencias', () => {
  const agentes = [{ id: 'a', nombre: 'Ana' }, { id: 'b', nombre: 'Beto' }] as AgentePublico[];
  const sub = (agente: string, archivos: string[]) => ({ agente, titulo: 'Título', descripcion: 'Descripción suficiente.', archivos });

  it('calcula dependencias por archivos o carpetas compartidas', () => {
    const r = validarPlan({ decision: 'Decisión suficiente.', subtareas: [sub('Ana', ['src/a.js']), sub('Beto', ['docs/']), sub('Ana', ['src/'])] }, agentes);
    expect('plan' in r && r.plan.subtareas.map((s) => s.dependeDe)).toEqual([[], [], [1]]);
  });

  it('normaliza rutas y rechaza las peligrosas', () => {
    const ok = validarPlan({ decision: 'Decisión suficiente.', subtareas: [sub('Ana', ['./src\\a.js', 'src/a.js'])] }, agentes);
    expect('plan' in ok && ok.plan.subtareas[0]!.archivos).toEqual(['src/a.js']);
    for (const mala of ['/etc/passwd', 'C:/x', 'src/../../x', '.git/config', 'a//b']) {
      expect(validarPlan({ decision: 'Decisión suficiente.', subtareas: [sub('Ana', [mala])] }, agentes)).toHaveProperty('error');
    }
  });

  it('seCruzan detecta archivo igual y carpeta contenedora', () => {
    expect(seCruzan(['src/a.js'], ['src/a.js'])).toBe(true);
    expect(seCruzan(['src/'], ['src/x/y.js'])).toBe(true);
    expect(seCruzan(['src/a.js'], ['src/b.js'])).toBe(false);
    expect(seCruzan(['src/'], ['srcx/a.js'])).toBe(false);
  });
});

describe('integración con Git', () => {
  it('un conflicto se aborta, deja el worktree limpio e informa los archivos', async () => {
    const origen = crearOrigen({ 'a.txt': 'base\n' });
    const raiz = path.join(tmpdir(), `softgala-prueba-git-${Date.now()}`);
    temporales.add(raiz);
    const g = new EspaciosGit({ raiz, protocolos: 'file', urlClonado: () => origen.url });
    await g.sincronizar('p', 'x/y', '');
    const integ = await g.prepararTarea('p', 't', 'agentes/t', 'main');
    const d1 = await g.prepararDesde('p', 't--1', 'agentes/t--1', 'agentes/t');
    const d2 = await g.prepararDesde('p', 't--2', 'agentes/t--2', 'agentes/t');
    writeFileSync(path.join(d1, 'a.txt'), 'uno\n');
    writeFileSync(path.join(d2, 'a.txt'), 'dos\n');
    await g.commit(d1, 'uno', 'A');
    await g.commit(d2, 'dos', 'B');

    expect(await g.integrar(integ, 'agentes/t--1', 'Integra 1')).toEqual({ ok: true });
    expect(await g.integrar(integ, 'agentes/t--2', 'Integra 2')).toEqual({ ok: false, conflictos: ['a.txt'] });
    expect(git(integ, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(path.join(integ, '.git'))).toBe(true);
  });
});
