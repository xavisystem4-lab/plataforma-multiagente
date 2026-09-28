import { afterEach, describe, expect, it } from 'vitest';
import { bearer, crearContexto, EMAIL_2, login, type Contexto } from './ayudantes';

/** Petición capturada por el fetch simulado de OpenAI. */
interface Capturada {
  url: string;
  autorizacion: string | null;
  campos: Record<string, string>;
  archivo: { nombre: string; tipo: string; bytes: number } | null;
}

function openaiSimulado(respuesta: () => Response = () => Response.json({ text: '  Agrega pruebas al carrito  ' })) {
  const peticiones: Capturada[] = [];
  const fetchExterno = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada);
    const cuerpo = init?.body;
    const campos: Record<string, string> = {};
    let archivo: Capturada['archivo'] = null;
    if (cuerpo instanceof FormData) {
      for (const [k, v] of cuerpo.entries()) {
        if (typeof v === 'string') campos[k] = v;
        else archivo = { nombre: v.name, tipo: v.type, bytes: v.size };
      }
    }
    peticiones.push({ url, autorizacion: new Headers(init?.headers).get('authorization'), campos, archivo });
    return respuesta();
  }) as typeof fetch;
  return { fetchExterno, peticiones };
}

let c: Contexto | undefined;
afterEach(async () => {
  await c?.app.close();
  c = undefined;
});

async function preparar(opciones: Parameters<typeof crearContexto>[0] = {}, email?: string) {
  c = await crearContexto(opciones);
  const r = await login(c.app, undefined, 'Pruebas', email);
  return bearer(r.json().accessToken);
}

async function crearProveedor(h: Record<string, string>, tipo: 'openai' | 'anthropic' = 'openai') {
  const r = await c!.app.inject({
    method: 'POST',
    url: '/api/proveedores',
    headers: h,
    payload: { nombre: `Prov ${tipo}`, tipo, apiKey: 'sk-prueba-12345678' },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const audio = (bytes = 2048) => Buffer.alloc(bytes, 7);

describe('Voz', () => {
  it('sin configurar, el micrófono no está disponible y transcribir responde 409', async () => {
    const h = await preparar();
    const ajustes = await c!.app.inject({ method: 'GET', url: '/api/voz/ajustes', headers: h });
    expect(ajustes.json()).toMatchObject({ proveedorId: null, disponible: false, modelo: 'gpt-4o-mini-transcribe', idioma: 'es' });
    const r = await c!.app.inject({
      method: 'POST',
      url: '/api/voz/transcribir',
      headers: { ...h, 'content-type': 'audio/webm' },
      payload: audio(),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.codigo).toBe('VOZ_NO_CONFIGURADA');
  });

  it('transcribe con OpenAI: multipart con modelo, idioma y archivo; devuelve el texto', async () => {
    const sim = openaiSimulado();
    const h = await preparar({ fetchExterno: sim.fetchExterno });
    const proveedorId = await crearProveedor(h);
    const g = await c!.app.inject({
      method: 'PUT',
      url: '/api/voz/ajustes',
      headers: h,
      payload: { proveedorId, modelo: 'gpt-4o-transcribe', idioma: 'es' },
    });
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject({ disponible: true, proveedorNombre: 'Prov openai' });

    const r = await c!.app.inject({
      method: 'POST',
      url: '/api/voz/transcribir',
      headers: { ...h, 'content-type': 'audio/webm;codecs=opus' },
      payload: audio(4096),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ texto: 'Agrega pruebas al carrito' });

    const p = sim.peticiones.at(-1)!;
    expect(p.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(p.autorizacion).toBe('Bearer sk-prueba-12345678');
    expect(p.campos).toMatchObject({ model: 'gpt-4o-transcribe', language: 'es', response_format: 'json' });
    expect(p.archivo).toEqual({ nombre: 'audio.webm', tipo: 'audio/webm', bytes: 4096 });
  });

  it('la auditoría registra metadatos pero nunca el texto dictado', async () => {
    const sim = openaiSimulado(() => Response.json({ text: 'mi texto secreto' }));
    const h = await preparar({ fetchExterno: sim.fetchExterno });
    const proveedorId = await crearProveedor(h);
    await c!.app.inject({ method: 'PUT', url: '/api/voz/ajustes', headers: h, payload: { proveedorId, modelo: 'whisper-1', idioma: 'es' } });
    await c!.app.inject({ method: 'POST', url: '/api/voz/transcribir', headers: { ...h, 'content-type': 'audio/ogg' }, payload: audio() });
    const filas = c!.db.prepare(`SELECT accion, detalle FROM auditoria WHERE accion LIKE 'voz.%'`).all() as { accion: string; detalle: string }[];
    expect(filas.map((f) => f.accion)).toEqual(['voz.configurada', 'voz.transcrita']);
    expect(JSON.parse(filas[1]!.detalle)).toMatchObject({ bytes: 2048, caracteres: 16, modelo: 'whisper-1' });
    expect(filas.some((f) => f.detalle.includes('secreto'))).toBe(false);
  });

  it('rechaza Anthropic como proveedor de voz', async () => {
    const h = await preparar();
    const proveedorId = await crearProveedor(h, 'anthropic');
    const r = await c!.app.inject({ method: 'PUT', url: '/api/voz/ajustes', headers: h, payload: { proveedorId, modelo: 'x', idioma: 'es' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.codigo).toBe('PROVEEDOR_SIN_VOZ');
  });

  it('no permite usar el proveedor de otro usuario', async () => {
    const h = await preparar();
    const ajeno = await crearProveedor(h);
    const h2 = bearer((await login(c!.app, undefined, 'Pruebas', EMAIL_2)).json().accessToken);
    const r = await c!.app.inject({ method: 'PUT', url: '/api/voz/ajustes', headers: h2, payload: { proveedorId: ajeno, modelo: 'whisper-1', idioma: 'es' } });
    expect(r.statusCode).toBe(404);
  });

  it('valida formato y tamaño del audio', async () => {
    const sim = openaiSimulado();
    const h = await preparar({ fetchExterno: sim.fetchExterno });
    const proveedorId = await crearProveedor(h);
    await c!.app.inject({ method: 'PUT', url: '/api/voz/ajustes', headers: h, payload: { proveedorId, modelo: 'whisper-1', idioma: 'es' } });

    const formato = await c!.app.inject({ method: 'POST', url: '/api/voz/transcribir', headers: { ...h, 'content-type': 'audio/flac' }, payload: audio() });
    expect(formato.statusCode).toBe(415);
    const grande = await c!.app.inject({
      method: 'POST',
      url: '/api/voz/transcribir',
      headers: { ...h, 'content-type': 'audio/webm' },
      payload: Buffer.alloc(8 * 1024 * 1024 + 1),
    });
    expect(grande.statusCode).toBe(413);
    expect(sim.peticiones).toHaveLength(0);
  });

  it('exige sesión', async () => {
    await preparar();
    const r = await c!.app.inject({ method: 'POST', url: '/api/voz/transcribir', headers: { 'content-type': 'audio/webm' }, payload: audio() });
    expect(r.statusCode).toBe(401);
  });

  it('traduce los errores del proveedor a mensajes claros', async () => {
    const sim = openaiSimulado(() => Response.json({ error: { message: 'Audio file is too short' } }, { status: 400 }));
    const h = await preparar({ fetchExterno: sim.fetchExterno });
    const proveedorId = await crearProveedor(h);
    await c!.app.inject({ method: 'PUT', url: '/api/voz/ajustes', headers: h, payload: { proveedorId, modelo: 'whisper-1', idioma: 'es' } });
    const r = await c!.app.inject({ method: 'POST', url: '/api/voz/transcribir', headers: { ...h, 'content-type': 'audio/webm' }, payload: audio() });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.mensaje).toBe('OpenAI rechazó la solicitud: Audio file is too short');
  });

  it('al eliminar el proveedor, la voz queda sin configurar', async () => {
    const h = await preparar();
    const proveedorId = await crearProveedor(h);
    await c!.app.inject({ method: 'PUT', url: '/api/voz/ajustes', headers: h, payload: { proveedorId, modelo: 'whisper-1', idioma: 'es' } });
    await c!.app.inject({ method: 'DELETE', url: `/api/proveedores/${proveedorId}`, headers: h });
    const r = await c!.app.inject({ method: 'GET', url: '/api/voz/ajustes', headers: h });
    expect(r.json()).toMatchObject({ proveedorId: null, disponible: false });
  });
});
