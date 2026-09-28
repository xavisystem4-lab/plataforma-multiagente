import Anthropic from '@anthropic-ai/sdk';
import type { TipoProveedor } from '@softgala/shared';

/**
 * Interfaz común para los proveedores de modelos. En F1 solo se usa para probar la conexión
 * y listar modelos; en F2 se agrega la ejecución de turnos con herramientas.
 */
export interface AdaptadorModelos {
  listarModelos(): Promise<string[]>;
}

export interface CredencialesProveedor {
  apiKey: string | null;
  urlBase: string | null;
}

/** Error esperado de un proveedor (clave inválida, sin conexión…) con mensaje para el usuario. */
export class ErrorProveedor extends Error {}

class AdaptadorAnthropic implements AdaptadorModelos {
  private readonly cliente: Anthropic;

  constructor(apiKey: string, fetchFn: typeof fetch) {
    this.cliente = new Anthropic({ apiKey, fetch: fetchFn, maxRetries: 1, timeout: 15_000 });
  }

  async listarModelos(): Promise<string[]> {
    try {
      const pagina = await this.cliente.models.list({ limit: 100 });
      return pagina.data.map((m) => m.id);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new ErrorProveedor('Anthropic rechazó la clave API.');
      if (err instanceof Anthropic.PermissionDeniedError) throw new ErrorProveedor('La clave no tiene permiso para listar modelos.');
      if (err instanceof Anthropic.RateLimitError) throw new ErrorProveedor('Límite de uso alcanzado; intenta más tarde.');
      if (err instanceof Anthropic.APIConnectionError) throw new ErrorProveedor('No se pudo conectar con Anthropic.');
      if (err instanceof Anthropic.APIError) throw new ErrorProveedor(`Anthropic respondió con un error (${err.status}).`);
      throw err;
    }
  }
}

/** OpenAI y cualquier servidor con la API compatible (`GET {base}/models`). */
class AdaptadorOpenAICompatible implements AdaptadorModelos {
  constructor(
    private readonly urlBase: string,
    private readonly apiKey: string | null,
    private readonly nombre: string,
    private readonly fetchFn: typeof fetch,
  ) {}

  async listarModelos(): Promise<string[]> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.urlBase}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new ErrorProveedor(`No se pudo conectar con ${this.nombre}.`);
    }
    if (r.status === 401 || r.status === 403) throw new ErrorProveedor(`${this.nombre} rechazó la clave API.`);
    if (!r.ok) throw new ErrorProveedor(`${this.nombre} respondió con un error (${r.status}).`);
    const datos = (await r.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    if (!Array.isArray(datos?.data)) throw new ErrorProveedor(`${this.nombre} devolvió una respuesta inesperada.`);
    return datos.data.map((m) => m.id).filter((id): id is string => typeof id === 'string');
  }
}

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
