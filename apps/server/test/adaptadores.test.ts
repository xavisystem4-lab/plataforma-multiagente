import { describe, expect, it } from 'vitest';
import { herramientasPara } from '../src/ejecucion/herramientas';
import { crearFabricaAdaptadores, ErrorProveedor, type MensajeConversacion } from '../src/modelos/adaptadores';
import { costoEstimado } from '../src/modelos/costos';
import { fetchSimulado, json } from './ayudantes';

const herramientas = herramientasPara(['leer_archivos']);

/** Conversación con un turno de herramienta ya resuelto. */
const conversacion = (crudo?: unknown): MensajeConversacion[] => [
  { rol: 'usuario', texto: 'Lee el README' },
  {
    rol: 'asistente',
    texto: 'Voy a leerlo.',
    llamadas: [{ id: 'toolu_1', nombre: 'leer_archivo', entrada: { ruta: 'README.md' } }],
    ...(crudo ? { crudo: { proveedor: 'anthropic' as const, contenido: crudo } } : {}),
  },
  { rol: 'resultados', resultados: [{ id: 'toolu_1', contenido: '# Demo', error: false }] },
];

describe('adaptador de Anthropic (SDK oficial)', () => {
  const respuesta = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'text', text: 'Ahora listo la carpeta.' },
      { type: 'tool_use', id: 'toolu_2', name: 'listar_directorio', input: { ruta: '.' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
  };

  it('envía herramientas, historial y resultados en el formato de la API y devuelve el contenido sin cambios', async () => {
    const sim = fetchSimulado({ 'POST https://api.anthropic.com/v1/messages': () => json(respuesta) });
    const adaptador = crearFabricaAdaptadores(sim.fetch)('anthropic', { apiKey: 'sk-ant-prueba-123456', urlBase: null });
    const bloquesPrevios = [
      { type: 'thinking', thinking: '', signature: 'firma-opaca' },
      { type: 'tool_use', id: 'toolu_1', name: 'leer_archivo', input: { ruta: 'README.md' } },
    ];

    const r = await adaptador.turno({
      modelo: 'claude-opus-5',
      sistema: 'Políticas',
      mensajes: conversacion(bloquesPrevios),
      herramientas,
      maxTokens: 16_000,
    });

    const cuerpo = sim.llamadas[0]!.cuerpo as Record<string, unknown> & { messages: { role: string; content: unknown }[]; tools: { name: string }[] };
    expect(cuerpo).toMatchObject({ model: 'claude-opus-5', max_tokens: 16_000, system: 'Políticas', cache_control: { type: 'ephemeral' } });
    expect(cuerpo.tools.map((t) => t.name)).toEqual(['listar_directorio', 'leer_archivo', 'solicitar_intervencion']);
    // El turno previo del asistente se reenvía tal cual (incluido el bloque de razonamiento firmado).
    expect(cuerpo.messages[1]).toEqual({ role: 'assistant', content: bloquesPrevios });
    expect(cuerpo.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# Demo', is_error: false }],
    });
    expect(cuerpo).not.toHaveProperty('thinking'); // se deja al modelo su comportamiento por defecto

    expect(r.fin).toBe('herramientas');
    expect(r.mensaje.texto).toBe('Ahora listo la carpeta.');
    expect(r.mensaje.llamadas).toEqual([{ id: 'toolu_2', nombre: 'listar_directorio', entrada: { ruta: '.' } }]);
    expect(r.mensaje.crudo).toEqual({ proveedor: 'anthropic', contenido: respuesta.content });
    expect(r.uso).toEqual({ entrada: 200, salida: 30 });
  });

  it('mapea el rechazo y el corte por límite de tokens', async () => {
    for (const [stop, fin] of [
      ['refusal', 'rechazo'],
      ['max_tokens', 'limite_tokens'],
      ['end_turn', 'fin_turno'],
    ] as const) {
      const sim = fetchSimulado({ 'POST https://api.anthropic.com/v1/messages': () => json({ ...respuesta, content: [], stop_reason: stop }) });
      const r = await crearFabricaAdaptadores(sim.fetch)('anthropic', { apiKey: 'sk-ant-prueba-123456', urlBase: null }).turno({
        modelo: 'claude-opus-5',
        sistema: '',
        mensajes: [{ rol: 'usuario', texto: 'hola' }],
        herramientas,
        maxTokens: 1000,
      });
      expect(r.fin).toBe(fin);
    }
  });

  it('traduce errores: clave inválida es permanente; límite de uso es temporal', async () => {
    const error = (status: number, tipo: string) =>
      fetchSimulado({ 'POST https://api.anthropic.com/v1/messages': () => json({ type: 'error', error: { type: tipo, message: 'x' } }, status) });
    const turno = (f: typeof fetch) =>
      crearFabricaAdaptadores(f)('anthropic', { apiKey: 'sk-ant-prueba-123456', urlBase: null }).turno({
        modelo: 'claude-opus-5',
        sistema: '',
        mensajes: [{ rol: 'usuario', texto: 'hola' }],
        herramientas,
        maxTokens: 1000,
      });

    const auth = await turno(error(401, 'authentication_error').fetch).catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(ErrorProveedor);
    expect((auth as ErrorProveedor).temporal).toBe(false);
  });
});

describe('adaptador compatible con OpenAI', () => {
  it('traduce el historial a mensajes de chat con tool_calls y resultados "tool"', async () => {
    const sim = fetchSimulado({
      'POST http://localhost:11434/v1/chat/completions': () =>
        json({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { content: null, tool_calls: [{ id: 'c2', function: { name: 'listar_directorio', arguments: '{"ruta":"src"}' } }] },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
    });
    const adaptador = crearFabricaAdaptadores(sim.fetch)('openai_compatible', { apiKey: null, urlBase: 'http://localhost:11434/v1' });
    const r = await adaptador.turno({ modelo: 'qwen', sistema: 'Políticas', mensajes: conversacion(), herramientas, maxTokens: 1000 });

    const cuerpo = sim.llamadas[0]!.cuerpo as { messages: unknown[]; tools: { type: string; function: { name: string } }[] };
    expect(cuerpo.messages).toEqual([
      { role: 'system', content: 'Políticas' },
      { role: 'user', content: 'Lee el README' },
      {
        role: 'assistant',
        content: 'Voy a leerlo.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'leer_archivo', arguments: '{"ruta":"README.md"}' } }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '# Demo' },
    ]);
    expect(cuerpo.tools[0]).toMatchObject({ type: 'function', function: { name: 'listar_directorio' } });
    expect(sim.llamadas[0]!.cabeceras.authorization).toBeUndefined();
    expect(r).toMatchObject({ fin: 'herramientas', uso: { entrada: 50, salida: 10 } });
    expect(r.mensaje.llamadas).toEqual([{ id: 'c2', nombre: 'listar_directorio', entrada: { ruta: 'src' } }]);
  });

  it('argumentos con JSON inválido llegan marcados para que la validación los rechace', async () => {
    const sim = fetchSimulado({
      'POST http://localhost:11434/v1/chat/completions': () =>
        json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'leer_archivo', arguments: '{roto' } }] } }] }),
    });
    const r = await crearFabricaAdaptadores(sim.fetch)('openai_compatible', { apiKey: null, urlBase: 'http://localhost:11434/v1' }).turno({
      modelo: 'x',
      sistema: '',
      mensajes: [{ rol: 'usuario', texto: 'hola' }],
      herramientas,
      maxTokens: 1000,
    });
    expect(r.mensaje.llamadas[0]!.entrada).toEqual({ __json_invalido: '{roto' });
  });

  it('un 429 es un error temporal', async () => {
    const sim = fetchSimulado({ 'POST https://api.openai.com/v1/chat/completions': () => json({}, 429) });
    const e = await crearFabricaAdaptadores(sim.fetch)('openai', { apiKey: 'sk-prueba-123456', urlBase: null })
      .turno({ modelo: 'x', sistema: '', mensajes: [{ rol: 'usuario', texto: 'hola' }], herramientas, maxTokens: 1000 })
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ErrorProveedor);
    expect((e as ErrorProveedor).temporal).toBe(true);
  });
});

describe('costos estimados', () => {
  it('calcula con la tarifa de referencia y devuelve null si no se conoce', () => {
    expect(costoEstimado('anthropic', 'claude-opus-5', 1_000_000, 100_000)).toBeCloseTo(7.5);
    expect(costoEstimado('anthropic', 'modelo-desconocido', 1000, 1000)).toBeNull();
    expect(costoEstimado('openai_compatible', 'llama3', 1000, 1000)).toBeNull();
  });
});
