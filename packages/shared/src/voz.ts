import { z } from 'zod';

// ---------------------------------------------------------------------------
// Instrucciones por voz: el audio se transcribe en el servidor con el proveedor elegido.
// La transcripción solo llena el texto; nunca ejecuta nada por sí sola.
// ---------------------------------------------------------------------------

/** Modelos de transcripción de OpenAI sugeridos (se puede escribir otro). */
export const MODELOS_TRANSCRIPCION = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] as const;

/** Formatos de audio aceptados (los que graban Chromium/Electron y el WebView de Android). */
export const TIPOS_AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'] as const;
export type TipoAudio = (typeof TIPOS_AUDIO)[number];

/** Duración máxima de una grabación y tamaño máximo del audio enviado. */
export const MAX_SEGUNDOS_AUDIO = 120;
export const MAX_BYTES_AUDIO = 8 * 1024 * 1024;

export const esquemaAjustesVoz = z.object({
  proveedorId: z.string().uuid('Elige un proveedor').nullable(),
  modelo: z
    .string()
    .trim()
    .min(1, 'Escribe el modelo')
    .max(80)
    .regex(/^[\w.:/-]+$/, 'Nombre de modelo no válido'),
  /** Código ISO 639-1; mejora la precisión y evita que se "traduzca" a otro idioma. */
  idioma: z.string().regex(/^[a-z]{2}$/, 'Idioma no válido'),
});
export type AjustesVozEdicion = z.infer<typeof esquemaAjustesVoz>;

export interface AjustesVoz extends AjustesVozEdicion {
  proveedorNombre: string | null;
  /** Hay un proveedor válido configurado: el micrófono se puede usar. */
  disponible: boolean;
}

export interface Transcripcion {
  texto: string;
}
