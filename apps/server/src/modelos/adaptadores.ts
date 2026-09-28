import Anthropic from '@anthropic-ai/sdk';
import type { TipoProveedor } from '@softgala/shared';
import type { DefinicionHerramienta } from '../ejecucion/herramientas';

// ---------------------------------------------------------------------------
// Formato interno de conversación (independiente del proveedor)
// ---------------------------------------------------------------------------

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  entrada: unknown;
}

export type MensajeConversacion =
  | { rol: 'usuario'; texto: string }
  | {
      rol: 'asistente';
      texto: string;
      llamadas: LlamadaHerramienta[];
      /** Contenido original del proveedor; se devuelve sin cambios (p. ej. bloques de razonamiento). */
      crudo?: { proveedor: TipoProveedor; contenido: unknown };
    }
  | { rol: 'resultados'; resultados: { id: string; contenido: string; error: boolean }[] };

export type FinTurno = 'fin_turno' | 'herramientas' | 'limite_tokens' | 'rechazo' | 'otro';

export interface RespuestaTurno {
  mensaje: Extract<MensajeConversacion, { rol: 'asistente' }>;
  fin: FinTurno;
  uso: { entrada: number; salida: number };
}

export interface SolicitudTurno {
  modelo: string;
  sistema: string;
  mensajes: MensajeConversacion[];
  herramientas: DefinicionHerramienta[];
  maxTokens: number;
  senal?: AbortSignal;
}

export interface SolicitudTranscripcion {
  modelo: string;
  audio: Uint8Array;
  tipo: string;
  idioma: string;
  senal?: AbortSignal;
}

/**
 * Interfaz común para los proveedores de modelos: listar modelos (prueba de conexión),
 * ejecutar un turno de conversación con herramientas y, si el proveedor lo ofrece, transcribir audio.
 */
export interface AdaptadorModelos {
  listarModelos(): Promise<string[]>;
  turno(s: SolicitudTurno): Promise<RespuestaTurno>;
  /** Ausente si el proveedor no tiene transcripción de voz (p. ej. Anthropic). */
  transcribir?(s: SolicitudTranscripcion): Promise<string>;
}

export interface CredencialesProveedor {
  apiKey: string | null;
  urlBase: string | null;
}

/** Error esperado de un proveedor (clave inválida, sin conexión…) con mensaje para el usuario. */
export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    /** Si tiene sentido reintentar más tarde (límite de uso, caída temporal). */
    readonly temporal = false,
  ) {
    super(mensaje);
  }
}

// ---------------------------------------------------------------------------
// Anthropic (SDK oficial)
// ---------------------------------------------------------------------------

class AdaptadorAnthropic implements AdaptadorModelos {
  private readonly cliente: Anthropic;

  constructor(apiKey: string, fetchFn: typeof fetch) {
    this.cliente = new Anthropic({ apiKey, fetch: fetchFn, maxRetries: 2, timeout: 600_000 });
  }

  async listarModelos(): Promise<string[]> {
    try {
      const pagina = await this.cliente.models.list({ limit: 100 });
      return pagina.data.map((m) => m.id);
    } catch (err) {
      throw traducirErrorAnthropic(err);
    }
  }

  async turno(s: SolicitudTurno): Promise<RespuestaTurno> {
    let r: Anthropic.Message;
    try {
      r = await this.cliente.messages.create(
        {
          model: s.modelo,
          max_tokens: s.maxTokens,
          // Caché automática del prefijo (sistema + herramientas + historial) entre turnos.
          cache_control: { type: 'ephemeral' },
          system: s.sistema,
          tools: s.herramientas.map((h) => ({
            name: h.nombre,
            description: h.descripcion,
            input_schema: h.esquema as Anthropic.Tool.InputSchema,
          })),
          messages: aMensajesAnthropic(s.mensajes),
        },
        { signal: s.senal },
      );
    } catch (err) {
      throw traducirErrorAnthropic(err);
    }
    const texto = r.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const llamadas = r.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, nombre: b.name, entrada: b.input }));
    const fin: FinTurno =
      r.stop_reason === 'end_turn'
        ? 'fin_turno'
        : r.stop_reason === 'tool_use'
          ? 'herramientas'
          : r.stop_reason === 'max_tokens'
            ? 'limite_tokens'
            : r.stop_reason === 'refusal'
              ? 'rechazo'
              : 'otro';
    const u = r.usage;
    return {
      mensaje: { rol: 'asistente', texto, llamadas, crudo: { proveedor: 'anthropic', contenido: r.content } },
      fin,
      uso: {
        entrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        salida: u.output_tokens,
      },
    };
  }
}

function aMensajesAnthropic(mensajes: MensajeConversacion[]): Anthropic.MessageParam[] {
  return mensajes.map((m): Anthropic.MessageParam => {
    switch (m.rol) {
      case 'usuario':
        return { role: 'user', content: m.texto };
      case 'asistente':
        if (m.crudo?.proveedor === 'anthropic') {
          return { role: 'assistant', content: m.crudo.contenido as Anthropic.ContentBlockParam[] };
        }
        return {
          role: 'assistant',
          content: [
            ...(m.texto ? [{ type: 'text' as const, text: m.texto }] : []),
            ...m.llamadas.map((l) => ({ type: 'tool_use' as const, id: l.id, name: l.nombre, input: l.entrada })),
          ],
        };
      case 'resultados':
        return {
          role: 'user',
          content: m.resultados.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.contenido, is_error: r.error })),
        };
    }
  });
}

function traducirErrorAnthropic(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError) return new ErrorProveedor('Anthropic rechazó la clave API.');
  if (err instanceof Anthropic.PermissionDeniedError) return new ErrorProveedor('La clave no tiene permiso para esta operación.');
  if (err instanceof Anthropic.NotFoundError) return new ErrorProveedor('Anthropic no reconoce el modelo configurado.');
  if (err instanceof Anthropic.BadRequestError) return new ErrorProveedor(`Anthropic rechazó la solicitud: ${err.message}`);
  if (err instanceof Anthropic.RateLimitError) return new ErrorProveedor('Límite de uso de Anthropic alcanzado; intenta más tarde.', true);
  if (err instanceof Anthropic.APIConnectionError) return new ErrorProveedor('No se pudo conectar con Anthropic.', true);
  if (err instanceof Anthropic.APIError) return new ErrorProveedor(`Anthropic respondió con un error (${err.status}).`, true);
  return err;
}

// ---------------------------------------------------------------------------
// OpenAI y compatibles (/models y /chat/completions)
// ---------------------------------------------------------------------------

interface RespuestaChat {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

class AdaptadorOpenAICompatible implements AdaptadorModelos {
  constructor(
    private readonly urlBase: string,
    private readonly apiKey: string | null,
    private readonly nombre: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  async listarModelos(): Promise<string[]> {
    const datos = await this.pedir<{ data?: { id?: unknown }[] }>('GET', '/models', undefined, AbortSignal.timeout(15_000));
    if (!Array.isArray(datos?.data)) throw new ErrorProveedor(`${this.nombre} devolvió una respuesta inesperada.`);
    return datos.data.map((m) => m.id).filter((id): id is string => typeof id === 'string');
  }

  async turno(s: SolicitudTurno): Promise<RespuestaTurno> {
    const senal = s.senal ? AbortSignal.any([s.senal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
    const r = await this.pedir<RespuestaChat>(
      'POST',
      '/chat/completions',
      {
        model: s.modelo,
        messages: [{ role: 'system', content: s.sistema }, ...aMensajesChat(s.mensajes)],
        tools: s.herramientas.map((h) => ({
          type: 'function',
          function: { name: h.nombre, description: h.descripcion, parameters: h.esquema },
        })),
      },
      senal,
    );
    const opcion = r.choices?.[0];
    if (!opcion?.message) throw new ErrorProveedor(`${this.nombre} devolvió una respuesta sin contenido.`);
    const llamadas = (opcion.message.tool_calls ?? []).map((t) => ({
      id: t.id,
      nombre: t.function.name,
      entrada: parsearArgumentos(t.function.arguments),
    }));
    const fin: FinTurno =
      llamadas.length > 0
        ? 'herramientas'
        : opcion.finish_reason === 'length'
          ? 'limite_tokens'
          : opcion.finish_reason === 'content_filter'
            ? 'rechazo'
            : 'fin_turno';
    return {
      mensaje: { rol: 'asistente', texto: (opcion.message.content ?? '').trim(), llamadas },
      fin,
      uso: { entrada: r.usage?.prompt_tokens ?? 0, salida: r.usage?.completion_tokens ?? 0 },
    };
  }

  /** POST /audio/transcriptions (multipart), el formato de OpenAI que también usan servidores Whisper. */
  async transcribir(s: SolicitudTranscripcion): Promise<string> {
    const senal = s.senal ? AbortSignal.any([s.senal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
    const formulario = new FormData();
    const extension = s.tipo.split('/')[1]?.replace('mpeg', 'mp3') ?? 'webm';
    formulario.append('file', new Blob([new Uint8Array(s.audio)], { type: s.tipo }), `audio.${extension}`);
    formulario.append('model', s.modelo);
    formulario.append('language', s.idioma);
    formulario.append('response_format', 'json');
    const r = await this.pedir<{ text?: unknown }>('POST', '/audio/transcriptions', formulario, senal);
    if (typeof r.text !== 'string') throw new ErrorProveedor(`${this.nombre} devolvió una transcripción inesperada.`);
    return r.text.trim();
  }

  private async pedir<T>(metodo: string, ruta: string, cuerpo: unknown, senal: AbortSignal): Promise<T> {
    let r: Response;
    // FormData lleva su propio Content-Type (multipart con boundary); lo demás va como JSON.
    const esFormulario = cuerpo instanceof FormData;
    try {
      r = await this.fetchFn(`${this.urlBase}${ruta}`, {
        method: metodo,
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(cuerpo && !esFormulario ? { 'Content-Type': 'application/json' } : {}),
        },
        body: esFormulario ? cuerpo : cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: senal,
        redirect: 'error',
      });
    } catch (err) {
      if (senal.aborted && (err as Error).name === 'AbortError') throw err;
      throw new ErrorProveedor(`No se pudo conectar con ${this.nombre}.`, true);
    }
    if (r.status === 401 || r.status === 403) throw new ErrorProveedor(`${this.nombre} rechazó la clave API.`);
    if (r.status === 404) throw new ErrorProveedor(`${this.nombre} no reconoce la ruta o el modelo.`);
    if (r.status === 429) throw new ErrorProveedor(`Límite de uso de ${this.nombre} alcanzado; intenta más tarde.`, true);
    if (r.status === 400) {
      // El detalle ayuda a corregir (modelo que no transcribe, audio vacío…); se recorta por seguridad.
      const detalle = ((await r.json().catch(() => null)) as { error?: { message?: unknown } } | null)?.error?.message;
      throw new ErrorProveedor(
        `${this.nombre} rechazó la solicitud${typeof detalle === 'string' ? `: ${detalle.slice(0, 200)}` : '.'}`,
      );
    }
    if (!r.ok) throw new ErrorProveedor(`${this.nombre} respondió con un error (${r.status}).`, r.status >= 500);
    const datos = (await r.json().catch(() => null)) as T | null;
    if (datos === null) throw new ErrorProveedor(`${this.nombre} devolvió una respuesta inesperada.`);
    return datos;
  }
}

function aMensajesChat(mensajes: MensajeConversacion[]): unknown[] {
  return mensajes.flatMap((m) => {
    switch (m.rol) {
      case 'usuario':
        return [{ role: 'user', content: m.texto }];
      case 'asistente':
        return [
          {
            role: 'assistant',
            content: m.texto || null,
            ...(m.llamadas.length
              ? {
                  tool_calls: m.llamadas.map((l) => ({
                    id: l.id,
                    type: 'function',
                    function: { name: l.nombre, arguments: JSON.stringify(l.entrada) },
                  })),
                }
              : {}),
          },
        ];
      case 'resultados':
        return m.resultados.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.error ? `ERROR: ${r.contenido}` : r.contenido }));
    }
  });
}

/** Los argumentos llegan como texto JSON; si no es válido, la validación de la herramienta lo rechazará. */
function parsearArgumentos(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return { __json_invalido: texto.slice(0, 500) };
  }
}

// ---------------------------------------------------------------------------

export type FabricaAdaptadores = (tipo: TipoProveedor, cred: CredencialesProveedor) => AdaptadorModelos;

export function crearFabricaAdaptadores(fetchFn: typeof fetch = fetch): FabricaAdaptadores {
  return (tipo, { apiKey, urlBase }) => {
    switch (tipo) {
      case 'anthropic':
        if (!apiKey) throw new ErrorProveedor('Falta la clave API.');
        return new AdaptadorAnthropic(apiKey, fetchFn);
      case 'openai':
        if (!apiKey) throw new ErrorProveedor('Falta la clave API.');
        return new AdaptadorOpenAICompatible('https://api.openai.com/v1', apiKey, 'OpenAI', fetchFn);
      case 'openai_compatible':
        if (!urlBase) throw new ErrorProveedor('Falta la URL base.');
        return new AdaptadorOpenAICompatible(urlBase, apiKey, 'El proveedor', fetchFn);
    }
  };
}
