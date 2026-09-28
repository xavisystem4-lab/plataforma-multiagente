import { z } from 'zod';

// ---------------------------------------------------------------------------
// Diff de una tarea
// ---------------------------------------------------------------------------

export type EstadoArchivoDiff = 'agregado' | 'modificado' | 'eliminado' | 'renombrado';

export interface ArchivoDiff {
  ruta: string;
  rutaAnterior: string | null;
  estado: EstadoArchivoDiff;
  adiciones: number;
  eliminaciones: number;
  binario: boolean;
  /** Parche unificado del archivo (puede venir recortado). */
  parche: string;
  truncado: boolean;
}

export interface DiffTarea {
  base: string;
  rama: string;
  archivos: ArchivoDiff[];
  adiciones: number;
  eliminaciones: number;
  /** true si se omitieron archivos o partes por tamaño. */
  truncado: boolean;
}

// ---------------------------------------------------------------------------
// Publicación y aprobaciones
// ---------------------------------------------------------------------------

export type EstadoPublicacion = 'pendiente' | 'publicada' | 'rechazada' | 'descartada' | 'revertida';

export const NOMBRE_PUBLICACION: Record<EstadoPublicacion, string> = {
  pendiente: 'Pendiente de revisión',
  publicada: 'Publicada en GitHub',
  rechazada: 'Rechazada',
  descartada: 'Descartada',
  revertida: 'Revertida',
};

export interface PublicacionTarea {
  estado: EstadoPublicacion;
  /** Rama publicada en GitHub (nunca la rama base). */
  rama: string | null;
  prNumero: number | null;
  prUrl: string | null;
  publicadaEn: string | null;
  /** Si se revirtió un PR ya fusionado: PR de reversión creado. */
  reversionPrUrl: string | null;
  nota: string | null;
}

export type TipoAprobacion = 'publicar';
export type EstadoAprobacion = 'pendiente' | 'aprobada' | 'rechazada';

export interface AprobacionPublica {
  id: string;
  tipo: TipoAprobacion;
  estado: EstadoAprobacion;
  titulo: string;
  descripcion: string;
  tareaId: string;
  tareaObjetivo: string;
  proyectoId: string;
  proyectoNombre: string;
  rama: string;
  archivos: number;
  comentario: string | null;
  creadaEn: string;
  resueltaEn: string | null;
}

export const esquemaAprobar = z.object({
  /** Abrir un Pull Request hacia la rama base (recomendado). */
  crearPR: z.boolean().default(true),
  comentario: z.string().trim().max(2000).optional(),
});
export type SolicitudAprobar = z.input<typeof esquemaAprobar>;

export const esquemaRechazar = z.object({
  comentario: z.string().trim().max(2000).optional(),
  /** Borrar también la rama y los archivos de trabajo en el servidor. */
  descartar: z.boolean().default(false),
});
export type SolicitudRechazar = z.input<typeof esquemaRechazar>;
