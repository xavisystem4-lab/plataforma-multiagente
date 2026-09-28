import { MAX_BYTES_AUDIO, TIPOS_AUDIO, type AjustesVoz, type AjustesVozEdicion, type TipoAudio, type Transcripcion } from '@softgala/shared';
import { auditar } from '../auditoria';
import { ErrorApp } from '../errores';
import { ErrorProveedor } from '../modelos/adaptadores';
import { ahoraIso, type Actor, type Contexto } from './contexto';
import type { ServicioProveedores } from './proveedores';

interface FilaAjustes {
  proveedor_id: string | null;
  modelo: string;
  idioma: string;
  proveedor_nombre: string | null;
  proveedor_tipo: string | null;
}

const POR_DEFECTO = { modelo: 'gpt-4o-mini-transcribe', idioma: 'es' };

/**
 * Transcripción de instrucciones por voz. El audio solo pasa por memoria: se reenvía al proveedor
 * elegido por el usuario y se descarta; no se guarda ni se escribe en registros ni en la auditoría.
 */
export class ServicioVoz {
  constructor(
    private readonly ctx: Contexto,
    private readonly proveedores: ServicioProveedores,
  ) {}

  obtener(actor: Actor): AjustesVoz {
    const f = this.fila(actor);
    return {
      proveedorId: f?.proveedor_id ?? null,
      proveedorNombre: f?.proveedor_nombre ?? null,
      modelo: f?.modelo ?? POR_DEFECTO.modelo,
      idioma: f?.idioma ?? POR_DEFECTO.idioma,
      disponible: !!f?.proveedor_id && f.proveedor_tipo !== 'anthropic',
    };
  }

  guardar(actor: Actor, datos: AjustesVozEdicion): AjustesVoz {
    if (datos.proveedorId) {
      const p = this.proveedores.obtener(actor, datos.proveedorId);
      if (p.tipo === 'anthropic') {
        throw new ErrorApp(400, 'PROVEEDOR_SIN_VOZ', 'Anthropic no ofrece transcripción de voz. Elige un proveedor OpenAI o compatible.');
      }
    }
    this.ctx.db
      .prepare(
        `INSERT INTO ajustes_voz (usuario_id, proveedor_id, modelo, idioma, actualizado_en) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(usuario_id) DO UPDATE SET proveedor_id = excluded.proveedor_id, modelo = excluded.modelo,
           idioma = excluded.idioma, actualizado_en = excluded.actualizado_en`,
      )
      .run(actor.id, datos.proveedorId, datos.modelo, datos.idioma, ahoraIso(this.ctx));
    auditar(this.ctx.db, {
      accion: 'voz.configurada',
      usuarioId: actor.id,
      detalle: { proveedorId: datos.proveedorId, modelo: datos.modelo, idioma: datos.idioma },
      ip: actor.ip,
    });
    return this.obtener(actor);
  }

  async transcribir(actor: Actor, audio: Uint8Array, tipoContenido: string): Promise<Transcripcion> {
    const tipo = tipoBase(tipoContenido);
    if (!tipo) throw new ErrorApp(415, 'AUDIO_NO_SOPORTADO', 'Formato de audio no soportado.');
    if (audio.byteLength === 0) throw new ErrorApp(400, 'AUDIO_VACIO', 'No se recibió audio.');
    if (audio.byteLength > MAX_BYTES_AUDIO) throw new ErrorApp(413, 'AUDIO_GRANDE', 'La grabación es demasiado larga.');

    const ajustes = this.obtener(actor);
    if (!ajustes.proveedorId || !ajustes.disponible) {
      throw new ErrorApp(409, 'VOZ_NO_CONFIGURADA', 'Configura la voz en Modelos IA → Voz antes de usar el micrófono.');
    }
    const cred = this.proveedores.credenciales(actor.id, ajustes.proveedorId);
    const adaptador = this.ctx.adaptadores(cred.tipo, cred);
    if (!adaptador.transcribir) throw new ErrorApp(400, 'PROVEEDOR_SIN_VOZ', 'Este proveedor no ofrece transcripción de voz.');

    let texto: string;
    try {
      texto = await adaptador.transcribir({ modelo: ajustes.modelo, audio, tipo, idioma: ajustes.idioma });
    } catch (err) {
      auditar(this.ctx.db, {
        accion: 'voz.transcripcion_fallida',
        usuarioId: actor.id,
        detalle: { proveedorId: ajustes.proveedorId, bytes: audio.byteLength },
        ip: actor.ip,
      });
      if (err instanceof ErrorProveedor) throw new ErrorApp(err.temporal ? 503 : 502, 'PROVEEDOR_VOZ', err.message);
      throw err;
    }
    // Solo metadatos: el contenido dictado no se guarda en la auditoría.
    auditar(this.ctx.db, {
      accion: 'voz.transcrita',
      usuarioId: actor.id,
      detalle: { proveedorId: ajustes.proveedorId, modelo: ajustes.modelo, bytes: audio.byteLength, caracteres: texto.length },
      ip: actor.ip,
    });
    return { texto };
  }

  private fila(actor: Actor): FilaAjustes | undefined {
    return this.ctx.db
      .prepare(
        `SELECT v.proveedor_id, v.modelo, v.idioma, p.nombre AS proveedor_nombre, p.tipo AS proveedor_tipo
         FROM ajustes_voz v LEFT JOIN proveedores p ON p.id = v.proveedor_id AND p.usuario_id = v.usuario_id
         WHERE v.usuario_id = ?`,
      )
      .get(actor.id) as FilaAjustes | undefined;
  }
}

/** "audio/webm;codecs=opus" → "audio/webm"; null si no es un formato aceptado. */
function tipoBase(tipoContenido: string): TipoAudio | null {
  const base = tipoContenido.split(';')[0]!.trim().toLowerCase().replace('audio/x-wav', 'audio/wav');
  return (TIPOS_AUDIO as readonly string[]).includes(base) ? (base as TipoAudio) : null;
}
