import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentePublico, EventoTiempoReal, ProyectoPublico, RespuestaLogin, TareaPublica } from '@softgala/shared';
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ResultadoComando, Sandbox } from '../src/ejecucion/sandbox';
import { ErrorProveedor, type AdaptadorModelos, type RespuestaTurno, type SolicitudTurno } from '../src/modelos/adaptadores';
import { bearer, crearContexto, EMAIL_2, fetchSimulado, json, login, temporales, type Contexto } from './ayudantes';

const REPO = 'softgala/demo';
const TOKEN_GITHUB = 'github_pat_prueba_000000000000000000000000_wxyz';

// ---------------------------------------------------------------------------
// Repositorio Git local que hace de "GitHub" (protocolo file://)
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=p@p.local', ...args], { cwd, encoding: 'utf8' });

function crearOrigen(): { bare: string; url: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'softgala-origen-'));
  temporales.add(base);
  const bare = path.join(base, 'origen.git');
  const trabajo = path.join(base, 'trabajo');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-b', 'main', trabajo]);
  writeFileSync(path.join(trabajo, 'README.md'), '# Demo\n\nProyecto de prueba.\n');
  writeFileSync(path.join(trabajo, 'app.js'), 'console.log("hola");\n');
  git(trabajo, 'add', '.');
  git(trabajo, 'commit', '-m', 'Inicial');
  git(trabajo, 'push', bare, 'main');
  return { bare, url: pathToFileURL(bare).toString() };
}

// ---------------------------------------------------------------------------
// Modelo simulado: responde según un guion y registra lo que recibe
// ---------------------------------------------------------------------------

type Paso = (s: SolicitudTurno) => RespuestaTurno | Promise<RespuestaTurno>;

let contadorLlamadas = 0;
const llamar = (nombre: string, entrada: unknown): RespuestaTurno => ({
  mensaje: { rol: 'asistente', texto: '', llamadas: [{ id: `ll_${++contadorLlamadas}`, nombre, entrada }] },
  fin: 'herramientas',
  uso: { entrada: 100, salida: 50 },
});
const terminar = (texto: string): RespuestaTurno => ({
  mensaje: { rol: 'asistente', texto, llamadas: [] },
  fin: 'fin_turno',
  uso: { entrada: 100, salida: 50 },
});

class ModeloGuionado implements AdaptadorModelos {
  readonly solicitudes: SolicitudTurno[] = [];
  constructor(private readonly pasos: Paso[]) {}
  async listarModelos() {
    return ['modelo-prueba'];
  }
  async turno(s: SolicitudTurno): Promise<RespuestaTurno> {
    // Copia profunda: la conversación sigue mutando después de la llamada.
    this.solicitudes.push(structuredClone({ ...s, senal: undefined }));
    if (s.senal?.aborted) throw new Error('abortado');
    const paso = this.pasos.shift();
    if (!paso) return terminar('Fin del guion.');
    return paso(s);
  }
}

/** Paso que queda bloqueado hasta que se aborte la señal (para probar pausa y cancelación). */
const bloquear: Paso = (s) =>
  new Promise((_, reject) => {
    s.senal?.addEventListener('abort', () => reject(new Error('abortado')));
  });

class SandboxSimulado implements Sandbox {
  readonly disponible = true;
  readonly motivo = null;
  readonly comandos: { comando: string; red: boolean; dir: string }[] = [];
  constructor(private readonly codigo = 0) {}
  async ejecutar(dir: string, comando: string, o: { red: boolean }): Promise<ResultadoComando> {
    this.comandos.push({ comando, red: o.red, dir });
    return { codigo: this.codigo, salida: `salida de ${comando}`, duracionMs: 5, expirado: false };
  }
}

// ---------------------------------------------------------------------------
// Contexto de cada prueba
// ---------------------------------------------------------------------------

let ctx: Contexto;
let token: string;
let modelo: ModeloGuionado;
let origen: { bare: string; url: string };

afterEach(async () => {
  await ctx?.app.close();
  ctx?.db.close();
});

interface Preparacion {
  pasos: Paso[];
  sandbox?: Sandbox;
  herramientas?: string[];
  limites?: Partial<AgentePublico['limites']>;
  env?: Record<string, string>;
  validaciones?: { nombre: string; comando: string; requiereRed?: boolean }[];
}

async function preparar(p: Preparacion) {
  origen = crearOrigen();
  modelo = new ModeloGuionado(p.pasos);
  const github = fetchSimulado({
    [`GET https://api.github.com/repos/${REPO}`]: () =>
      json({ private: true, default_branch: 'main', html_url: '', permissions: { admin: false, push: true, pull: true } }),
    [`GET https://api.github.com/repos/${REPO}/branches/main`]: () =>
      json({ name: 'main', commit: { sha: 'x', html_url: '', commit: { message: 'Inicial', author: null } } }),
  });
  ctx = await crearContexto({
    fetchExterno: github.fetch,
    adaptadores: () => modelo,
    sandbox: p.sandbox,
    git: { protocolos: 'file', urlClonado: () => origen.url },
    env: p.env,
  });
  token = (await login(ctx.app)).json<RespuestaLogin>().accessToken;

  const prov = (await pedir('POST', '/api/proveedores', { nombre: 'Local', tipo: 'openai_compatible', urlBase: 'http://localhost:1/v1' })).json();
  const agente = (
    await pedir('POST', '/api/agentes', {
      nombre: 'Dev',
      rol: 'desarrollador',
      instrucciones: 'Sé breve.',
      proveedorId: prov.id,
      modelo: 'modelo-prueba',
      herramientas: p.herramientas ?? ['leer_archivos', 'buscar_codigo', 'escribir_archivos', 'ejecutar_validaciones', 'git_commit'],
      limites: { maxTokensPorTarea: 100_000, maxCostoUsdPorTarea: 5, maxMinutosPorTarea: 30, ...p.limites },
    })
  ).json<AgentePublico>();
  const proyecto = (
    await pedir('POST', '/api/proyectos', {
      nombre: 'Demo',
      repositorio: REPO,
      token: TOKEN_GITHUB,
      validaciones: p.validaciones ?? [{ nombre: 'Pruebas', comando: 'npm test' }],
    })
  ).json<ProyectoPublico>();
  await pedir('PUT', `/api/proyectos/${proyecto.id}/agentes/${agente.id}`, { habilitado: true });
  return { proyecto, agente };
}

function pedir(metodo: InjectOptions['method'], url: string, payload?: unknown, t = token) {
  return ctx.app.inject({ method: metodo, url, payload: payload as InjectOptions['payload'], headers: bearer(t) });
}

async function continuar(proyectoId: string, objetivo?: string) {
  const r = await pedir('POST', `/api/proyectos/${proyectoId}/continuar`, objetivo ? { objetivo } : {});
  return r;
}

const esperar = () => ctx.app.orquestador.esperarInactividad();
const tarea = async (id: string) => (await pedir('GET', `/api/tareas/${id}`)).json<TareaPublica>();
const eventos = async (id: string) => (await pedir('GET', `/api/tareas/${id}/eventos`)).json<EventoTiempoReal[]>();
const dirTarea = (proyectoId: string, tareaId: string) => path.join(ctx.config.dirDatos, 'espacios', proyectoId, 'tareas', tareaId);

/** Espera a que la tarea llegue a un estado (para pruebas con pasos bloqueantes). */
async function esperarEstado(id: string, estado: TareaPublica['estado']) {
  for (let i = 0; i < 200; i++) {
    if ((await tarea(id)).estado === estado) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`La tarea no llegó a "${estado}"`);
}

// ---------------------------------------------------------------------------

describe('Continuar proyecto: flujo completo', () => {
  it('el agente lee, escribe, se valida, se hace commit en su rama y se informa por eventos', async () => {
    const sandbox = new SandboxSimulado();
    const { proyecto } = await preparar({
      sandbox,
      pasos: [
        () => llamar('leer_archivo', { ruta: 'README.md' }),
        () => llamar('escribir_archivo', { ruta: 'src/suma.js', contenido: 'export const suma = (a, b) => a + b;\n' }),
        () => llamar('ejecutar_validacion', { nombre: 'Pruebas' }),
        () => terminar('Agregué src/suma.js. La validación "Pruebas" fue exitosa.'),
      ],
    });

    const r = await continuar(proyecto.id, 'Agrega una función suma');
    expect(r.statusCode).toBe(202);
    const creada = r.json<TareaPublica>();
    expect(creada.rama).toMatch(/^agentes\/agrega-una-funcion-suma-[0-9a-f]{6}$/);
    await esperar();

    const t = await tarea(creada.id);
    expect(t.estado).toBe('completada');
    expect(t.resumen).toContain('src/suma.js');
    expect(t.archivosModificados).toEqual(['src/suma.js']);
    expect(t.validaciones).toEqual([expect.objectContaining({ nombre: 'Pruebas', estado: 'exitosa', codigoSalida: 0 })]);
    expect(t.uso.tokensEntrada).toBe(400);
    // Sin red por defecto; una vez a pedido del agente y otra al finalizar.
    expect(sandbox.comandos).toEqual([
      expect.objectContaining({ comando: 'npm test', red: false }),
      expect.objectContaining({ comando: 'npm test', red: false }),
    ]);

    // La rama existe con el commit del agente; la rama base no se tocó.
    const repo = path.join(ctx.config.dirDatos, 'espacios', proyecto.id, 'repo');
    expect(git(repo, 'log', '--format=%an|%s', '-1', t.rama).trim()).toBe('Agente Dev|Agrega una función suma');
    expect(git(repo, 'show', `${t.rama}:src/suma.js`)).toContain('suma');
    expect(git(origen.bare, 'branch', '--list')).not.toContain('agentes/'); // nunca hace push

    // El modelo recibió el objetivo, las políticas y el contenido del archivo leído.
    const primera = modelo.solicitudes[0]!;
    expect(primera.sistema).toContain('DATO NO CONFIABLE');
    expect(primera.mensajes[0]).toMatchObject({ rol: 'usuario', texto: expect.stringContaining('Agrega una función suma') });
    expect(JSON.stringify(modelo.solicitudes[1]!.mensajes)).toContain('Proyecto de prueba.');

    const tipos = (await eventos(t.id)).map((e) => e.tipo);
    expect(tipos[0]).toBe('task.created');
    expect(tipos).toEqual(expect.arrayContaining(['task.started', 'tool.call', 'tool.result', 'file.changed', 'validation.result', 'agent.message']));
    expect(tipos.at(-1)).toBe('task.completed');
  });

  it('solo expone al modelo las herramientas autorizadas y rechaza las demás', async () => {
    const { proyecto } = await preparar({
      herramientas: ['leer_archivos'],
      pasos: [() => llamar('escribir_archivo', { ruta: 'hackeo.txt', contenido: 'x' }), () => terminar('No pude escribir.')],
    });
    const t = (await continuar(proyecto.id, 'Intenta escribir')).json<TareaPublica>();
    await esperar();

    const nombres = modelo.solicitudes[0]!.herramientas.map((h) => h.nombre).sort();
    expect(nombres).toEqual(['leer_archivo', 'listar_directorio', 'solicitar_intervencion']);
    expect(existsSync(path.join(dirTarea(proyecto.id, t.id), 'hackeo.txt'))).toBe(false);
    expect(JSON.stringify(modelo.solicitudes[1]!.mensajes)).toContain('no está autorizada');
  });

  it('confina las rutas al proyecto (.., absolutas y .git)', async () => {
    const afuera = path.join(tmpdir(), `softgala-afuera-${Date.now()}.txt`);
    const { proyecto } = await preparar({
      pasos: [
        () => llamar('leer_archivo', { ruta: '../../../../../../etc/passwd' }),
        () => llamar('leer_archivo', { ruta: '.git/config' }),
        () => llamar('escribir_archivo', { ruta: afuera, contenido: 'x' }),
        () => llamar('escribir_archivo', { ruta: '../fuera.txt', contenido: 'x' }),
        () => terminar('Listo.'),
      ],
    });
    const t = (await continuar(proyecto.id, 'Prueba de rutas')).json<TareaPublica>();
    await esperar();

    const resultados = (await eventos(t.id)).filter((e) => e.tipo === 'tool.result').map((e) => e.datos as { error: boolean; resumen: string });
    expect(resultados.every((r) => r.error)).toBe(true);
    expect(resultados.map((r) => r.resumen)).toEqual([
      'La ruta sale del proyecto',
      'La carpeta .git no es accesible',
      'Usa rutas relativas a la raíz del proyecto',
      'La ruta sale del proyecto',
    ]);
    expect(existsSync(afuera)).toBe(false);
    expect(existsSync(path.join(dirTarea(proyecto.id, t.id), '..', 'fuera.txt'))).toBe(false);
  });

  it('sin sandbox las validaciones se informan como no ejecutadas, nunca como exitosas', async () => {
    const { proyecto } = await preparar({
      pasos: [() => llamar('ejecutar_validacion', { nombre: 'Pruebas' }), () => terminar('No se pudo verificar.')],
    });
    const t = (await continuar(proyecto.id, 'Valida')).json<TareaPublica>();
    await esperar();

    const final = await tarea(t.id);
    expect(final.validaciones).toEqual([expect.objectContaining({ estado: 'no_ejecutada', codigoSalida: null })]);
    expect(JSON.stringify(modelo.solicitudes[1]!.mensajes)).toContain('NO EJECUTADA');
    expect(modelo.solicitudes[0]!.sistema).toContain('NO se pueden ejecutar');
  });

  it('una validación que falla se reporta como fallida', async () => {
    const { proyecto } = await preparar({ sandbox: new SandboxSimulado(1), pasos: [() => terminar('Hecho.')] });
    const t = (await continuar(proyecto.id, 'Algo')).json<TareaPublica>();
    await esperar();
    expect((await tarea(t.id)).validaciones[0]).toMatchObject({ estado: 'fallida', codigoSalida: 1 });
  });

  it('respeta requiereRed de cada validación', async () => {
    const sandbox = new SandboxSimulado();
    const { proyecto } = await preparar({
      sandbox,
      validaciones: [
        { nombre: 'Dependencias', comando: 'npm ci', requiereRed: true },
        { nombre: 'Pruebas', comando: 'npm test' },
      ],
      pasos: [() => terminar('Hecho.')],
    });
    await continuar(proyecto.id, 'Algo');
    await esperar();
    expect(sandbox.comandos.map((c) => [c.comando, c.red])).toEqual([
      ['npm ci', true],
      ['npm test', false],
    ]);
  });
});

describe('intervención del usuario', () => {
  it('el agente pregunta, la tarea espera y continúa con la respuesta', async () => {
    const { proyecto } = await preparar({
      pasos: [
        () => llamar('solicitar_intervencion', { pregunta: '¿Uso TypeScript o JavaScript?' }),
        (s) => {
          // La respuesta del usuario llega como resultado de la herramienta.
          expect(JSON.stringify(s.mensajes.at(-1))).toContain('Respuesta del usuario: TypeScript');
          return terminar('Usaré TypeScript.');
        },
      ],
    });
    const t = (await continuar(proyecto.id, 'Crea el módulo')).json<TareaPublica>();
    await esperar();

    const esperando = await tarea(t.id);
    expect(esperando).toMatchObject({ estado: 'esperando_usuario', pregunta: '¿Uso TypeScript o JavaScript?' });
    expect((await eventos(t.id)).map((e) => e.tipo)).toContain('task.waiting');

    // "Continuar" sin objetivo no la salta: primero hay que responder.
    expect((await continuar(proyecto.id)).json().error.codigo).toBe('ESPERA_RESPUESTA');

    const r = await pedir('POST', `/api/tareas/${t.id}/responder`, { respuesta: 'TypeScript' });
    expect(r.statusCode).toBe(200);
    await esperar();
    expect(await tarea(t.id)).toMatchObject({ estado: 'completada', pregunta: null, resumen: 'Usaré TypeScript.' });
  });
});

describe('pausar, reanudar y cancelar', () => {
  it('pausa una tarea en ejecución y la reanuda con su conversación', async () => {
    const { proyecto } = await preparar({
      pasos: [() => llamar('leer_archivo', { ruta: 'app.js' }), bloquear, () => terminar('Terminé tras reanudar.')],
    });
    const t = (await continuar(proyecto.id, 'Tarea larga')).json<TareaPublica>();
    for (let i = 0; i < 200 && modelo.solicitudes.length < 2; i++) await new Promise((r) => setTimeout(r, 20));

    expect((await pedir('POST', `/api/tareas/${t.id}/pausar`)).statusCode).toBe(200);
    await esperar();
    expect((await tarea(t.id)).estado).toBe('pausada');

    // "Continuar proyecto" sin objetivo reanuda la tarea pausada.
    const reanudada = await continuar(proyecto.id);
    expect(reanudada.json<TareaPublica>().id).toBe(t.id);
    await esperar();

    const final = await tarea(t.id);
    expect(final.estado).toBe('completada');
    // Se reanudó desde el último punto consistente: incluye la lectura previa.
    expect(JSON.stringify(modelo.solicitudes.at(-1)!.mensajes)).toContain('console.log');
    expect((await eventos(t.id)).map((e) => e.tipo)).toEqual(expect.arrayContaining(['task.paused', 'task.resumed']));
  });

  it('cancela una tarea en ejecución', async () => {
    const { proyecto } = await preparar({ pasos: [bloquear] });
    const t = (await continuar(proyecto.id, 'Cancelable')).json<TareaPublica>();
    await esperarEstado(t.id, 'ejecutando');
    for (let i = 0; i < 200 && modelo.solicitudes.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    await pedir('POST', `/api/tareas/${t.id}/cancelar`);
    await esperar();
    const final = await tarea(t.id);
    expect(final.estado).toBe('cancelada');
    expect(final.terminadaEn).not.toBeNull();
    expect((await pedir('POST', `/api/tareas/${t.id}/reanudar`)).statusCode).toBe(409);
  });

  it('permite una sola tarea activa por proyecto', async () => {
    const { proyecto } = await preparar({ pasos: [bloquear] });
    await continuar(proyecto.id, 'Primera');
    const segunda = await continuar(proyecto.id, 'Segunda');
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().error.codigo).toBe('TAREA_EN_CURSO');
  });

  it('sin objetivo ni tarea pausada pide describir el objetivo', async () => {
    const { proyecto } = await preparar({ pasos: [] });
    expect((await continuar(proyecto.id)).json().error.codigo).toBe('OBJETIVO_REQUERIDO');
  });

  it('las tareas interrumpidas por un reinicio quedan pausadas', async () => {
    const { proyecto } = await preparar({ pasos: [bloquear] });
    const t = (await continuar(proyecto.id, 'Interrumpida')).json<TareaPublica>();
    await esperarEstado(t.id, 'ejecutando');
    ctx.db.prepare("UPDATE tareas SET estado = 'ejecutando' WHERE id = ?").run(t.id);
    expect(ctx.app.orquestador.recuperarAlIniciar()).toBe(1);
    expect((await tarea(t.id)).error).toContain('reinicio');
  });
});

describe('límites', () => {
  it('detiene la tarea al superar el límite de tokens del agente', async () => {
    const { proyecto } = await preparar({
      limites: { maxTokensPorTarea: 1_000 },
      pasos: Array.from({ length: 20 }, () => (): RespuestaTurno => ({ ...llamar('listar_directorio', {}), uso: { entrada: 400, salida: 200 } })),
    });
    const t = (await continuar(proyecto.id, 'Consume tokens')).json<TareaPublica>();
    await esperar();
    const final = await tarea(t.id);
    expect(final.estado).toBe('fallida');
    expect(final.error).toContain('límite de 1,000 tokens');
    expect(modelo.solicitudes.length).toBe(2);
    expect((await eventos(t.id)).map((e) => e.tipo)).toContain('budget.warning');
  });

  it('detiene un ciclo sin fin al llegar al máximo de turnos', async () => {
    const { proyecto } = await preparar({
      env: { MAX_TURNOS_POR_EJECUCION: '3' },
      pasos: Array.from({ length: 10 }, () => () => llamar('listar_directorio', {})),
    });
    const t = (await continuar(proyecto.id, 'Ciclo')).json<TareaPublica>();
    await esperar();
    expect(await tarea(t.id)).toMatchObject({ estado: 'fallida', error: expect.stringContaining('máximo de 3 turnos') });
  });

  it('un error temporal del proveedor pausa la tarea; uno permanente la marca como fallida', async () => {
    const { proyecto } = await preparar({
      pasos: [
        () => {
          throw new ErrorProveedor('Límite de uso alcanzado.', true);
        },
        () => {
          throw new ErrorProveedor('El proveedor rechazó la clave API.');
        },
      ],
    });
    const t = (await continuar(proyecto.id, 'Con errores')).json<TareaPublica>();
    await esperar();
    expect(await tarea(t.id)).toMatchObject({ estado: 'pausada', error: expect.stringContaining('reanudarla') });

    await pedir('POST', `/api/tareas/${t.id}/reanudar`);
    await esperar();
    expect(await tarea(t.id)).toMatchObject({ estado: 'fallida', error: 'El proveedor rechazó la clave API.' });
  });

  it('un rechazo del modelo termina la tarea sin ejecutar herramientas', async () => {
    const { proyecto } = await preparar({
      pasos: [() => ({ ...llamar('escribir_archivo', { ruta: 'x.txt', contenido: 'x' }), fin: 'rechazo' as const })],
    });
    const t = (await continuar(proyecto.id, 'Rechazo')).json<TareaPublica>();
    await esperar();
    expect((await tarea(t.id)).estado).toBe('fallida');
    expect(existsSync(path.join(dirTarea(proyecto.id, t.id), 'x.txt'))).toBe(false);
  });
});

describe('seguridad de la ejecución', () => {
  it('el token de GitHub no queda en la configuración del repositorio ni en los eventos', async () => {
    const { proyecto } = await preparar({ pasos: [() => terminar('Hecho.')] });
    const t = (await continuar(proyecto.id, 'Revisa el token')).json<TareaPublica>();
    await esperar();
    const repo = path.join(ctx.config.dirDatos, 'espacios', proyecto.id, 'repo');
    expect(readFileSync(path.join(repo, '.git', 'config'), 'utf8')).not.toContain(TOKEN_GITHUB);
    expect(JSON.stringify(await eventos(t.id))).not.toContain(TOKEN_GITHUB);
    expect(JSON.stringify(modelo.solicitudes)).not.toContain(TOKEN_GITHUB);
  });

  it('un usuario no ve ni controla las tareas de otro', async () => {
    const { proyecto } = await preparar({ pasos: [() => terminar('Hecho.')] });
    const t = (await continuar(proyecto.id, 'Privada')).json<TareaPublica>();
    await esperar();
    const otro = (await login(ctx.app, undefined, 'Otro', EMAIL_2)).json<RespuestaLogin>().accessToken;
    expect((await pedir('GET', `/api/tareas/${t.id}`, undefined, otro)).statusCode).toBe(404);
    expect((await pedir('GET', `/api/tareas/${t.id}/eventos`, undefined, otro)).statusCode).toBe(404);
    expect((await pedir('POST', `/api/tareas/${t.id}/cancelar`, undefined, otro)).statusCode).toBe(404);
    expect((await pedir('POST', `/api/proyectos/${proyecto.id}/continuar`, { objetivo: 'Intruso' }, otro)).statusCode).toBe(404);
    expect((await pedir('GET', '/api/tareas', undefined, otro)).json()).toEqual([]);
  });
});

describe('tiempo real por WebSocket', () => {
  async function abrirWs(): Promise<{ ws: WebSocket; mensajes: unknown[]; cerrado: Promise<number> }> {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const mensajes: unknown[] = [];
    ws.on('message', (d) => mensajes.push(JSON.parse(d.toString())));
    const cerrado = new Promise<number>((r) => ws.on('close', (codigo) => r(codigo)));
    await new Promise((r) => ws.on('open', r));
    return { ws, mensajes, cerrado };
  }
  const hasta = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('reenvía el historial desde una secuencia y luego los eventos nuevos', async () => {
    const { proyecto } = await preparar({ pasos: [() => terminar('Hecho.'), () => terminar('Otra.')] });
    await continuar(proyecto.id, 'Primera');
    await esperar();

    const { ws, mensajes } = await abrirWs();
    ws.send(JSON.stringify({ tipo: 'autenticar', token, desde: 0 }));
    await hasta(() => mensajes.some((m) => (m as { tipo: string }).tipo === 'listo'));
    const historial = mensajes.filter((m) => (m as { tipo: string }).tipo === 'evento') as { evento: EventoTiempoReal }[];
    expect(historial.map((m) => m.evento.tipo)).toContain('task.completed');

    // Un evento nuevo llega en vivo.
    await continuar(proyecto.id, 'Segunda');
    await esperar();
    await hasta(() => mensajes.filter((m) => (m as { tipo: string }).tipo === 'evento').length > historial.length + 2);
    const seqs = (mensajes.filter((m) => (m as { tipo: string }).tipo === 'evento') as { evento: EventoTiempoReal }[]).map((m) => m.evento.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // sin duplicados
    ws.close();
  });

  it('cierra la conexión con un token inválido', async () => {
    await preparar({ pasos: [] });
    const { ws, cerrado } = await abrirWs();
    ws.send(JSON.stringify({ tipo: 'autenticar', token: 'token-falso-1234567890' }));
    expect(await cerrado).toBe(4401);
  });

  it('no envía eventos de otros usuarios', async () => {
    const { proyecto } = await preparar({ pasos: [() => terminar('Hecho.')] });
    const otro = (await login(ctx.app, undefined, 'Otro', EMAIL_2)).json<RespuestaLogin>().accessToken;
    const { ws, mensajes } = await abrirWs();
    ws.send(JSON.stringify({ tipo: 'autenticar', token: otro, desde: 0 }));
    await hasta(() => mensajes.some((m) => (m as { tipo: string }).tipo === 'listo'));
    await continuar(proyecto.id, 'Del admin');
    await esperar();
    await new Promise((r) => setTimeout(r, 100));
    expect(mensajes.filter((m) => (m as { tipo: string }).tipo === 'evento')).toEqual([]);
    ws.close();
  });
});
