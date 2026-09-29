import { Capacitor, registerPlugin } from '@capacitor/core';

/** Puente expuesto por el preload de Electron (ver apps/desktop/preload.cjs). */
interface PuenteEscritorio {
  plataforma: 'electron';
  almacen: {
    obtener(clave: string): Promise<string | null>;
    guardar(clave: string, valor: string): Promise<void>;
    borrar(clave: string): Promise<void>;
  };
  /** Sesión compartida por todas las ventanas (el refresh token vive solo en el proceso principal). */
  sesion: IntermediarioSesion;
  ventanas: {
    abrirProyecto(proyectoId: string, titulo: string, color: string): Promise<void>;
    configurar(o: { titulo?: string; color?: string; encima?: boolean }): Promise<{ encima: boolean } | null>;
  };
  actualizaciones: IntermediarioActualizaciones;
}

/** Fases de la actualización automática (ver apps/desktop/actualizador.cjs). */
export type FaseActualizacion = 'inactivo' | 'buscando' | 'disponible' | 'descargando' | 'lista' | 'al-dia' | 'error';

export interface EstadoActualizacion {
  fase: FaseActualizacion;
  version: string;
  disponible: string | null;
  porcentaje: number;
  mensaje: string | null;
  soportado?: boolean;
}

export interface IntermediarioActualizaciones {
  estado(): Promise<EstadoActualizacion>;
  buscar(): Promise<{ soportado: boolean }>;
  descargar(): Promise<void>;
  instalar(): Promise<void>;
  alCambiar(fn: (estado: EstadoActualizacion) => void): () => void;
}

/** Actualizaciones: solo en la app de escritorio empaquetada. */
export const actualizacionesEscritorio = () => window.softgala?.actualizaciones ?? null;

export interface IntermediarioSesion {
  establecer(refreshToken: string, accessToken: string, expiraEn: number): Promise<void>;
  renovar(forzar: boolean, servidor: string): Promise<{ accessToken: string } | null>;
  limpiar(): Promise<void>;
  alCerrar(fn: () => void): () => void;
}

declare global {
  interface Window {
    softgala?: PuenteEscritorio;
  }
}

export type Plataforma = 'windows' | 'android' | 'web';

/** Ventanas múltiples: solo en la app de escritorio. */
export const ventanasEscritorio = () => window.softgala?.ventanas ?? null;

export function detectarPlataforma(): Plataforma {
  if (window.softgala?.plataforma === 'electron') return 'windows';
  if (Capacitor.getPlatform() === 'android') return 'android';
  return 'web';
}

export function nombreDispositivo(): string {
  return { windows: 'Windows · Escritorio', android: 'Android', web: 'Navegador' }[detectarPlataforma()];
}

/**
 * Almacén para el refresh token y preferencias.
 * - Windows: cifrado con DPAPI del usuario mediante safeStorage de Electron.
 * - Android: AES-256-GCM con clave del Android Keystore (plugin nativo AlmacenSeguro).
 * - Web (solo desarrollo): localStorage.
 */
export interface Almacen {
  obtener(clave: string): Promise<string | null>;
  guardar(clave: string, valor: string): Promise<void>;
  borrar(clave: string): Promise<void>;
}

interface PluginAlmacenSeguro {
  obtener(o: { clave: string }): Promise<{ valor: string | null }>;
  guardar(o: { clave: string; valor: string }): Promise<void>;
  borrar(o: { clave: string }): Promise<void>;
}

const almacenLocal: Almacen = {
  async obtener(clave) {
    try {
      return localStorage.getItem(`softgala.${clave}`);
    } catch {
      return null;
    }
  },
  async guardar(clave, valor) {
    try {
      localStorage.setItem(`softgala.${clave}`, valor);
    } catch {
      /* almacenamiento no disponible: la sesión durará solo mientras la app esté abierta */
    }
  },
  async borrar(clave) {
    try {
      localStorage.removeItem(`softgala.${clave}`);
    } catch {
      /* sin almacenamiento */
    }
  },
};

function almacenAndroid(): Almacen {
  const plugin = registerPlugin<PluginAlmacenSeguro>('AlmacenSeguro');
  return {
    obtener: async (clave) => (await plugin.obtener({ clave })).valor,
    guardar: (clave, valor) => plugin.guardar({ clave, valor }),
    borrar: (clave) => plugin.borrar({ clave }),
  };
}

export function crearAlmacen(): Almacen {
  if (window.softgala?.almacen) return window.softgala.almacen;
  if (detectarPlataforma() === 'android') return almacenAndroid();
  return almacenLocal;
}
