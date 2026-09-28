/** Puente expuesto por el preload de Electron (ver apps/desktop/preload.cjs). */
interface PuenteEscritorio {
  plataforma: 'electron';
  almacen: {
    obtener(clave: string): Promise<string | null>;
    guardar(clave: string, valor: string): Promise<void>;
    borrar(clave: string): Promise<void>;
  };
}

declare global {
  interface Window {
    softgala?: PuenteEscritorio;
  }
}

export type Plataforma = 'windows' | 'android' | 'web';

export function detectarPlataforma(): Plataforma {
  if (window.softgala?.plataforma === 'electron') return 'windows';
  if ('Capacitor' in window) return 'android';
  return 'web';
}

export function nombreDispositivo(): string {
  return { windows: 'Windows · Escritorio', android: 'Android', web: 'Navegador' }[detectarPlataforma()];
}

/**
 * Almacén para el refresh token y preferencias.
 * - Windows: cifrado con DPAPI del usuario mediante safeStorage de Electron.
 * - Web (solo desarrollo): localStorage. En Android (fase F5) se usará el Keystore.
 */
export interface Almacen {
  obtener(clave: string): Promise<string | null>;
  guardar(clave: string, valor: string): Promise<void>;
  borrar(clave: string): Promise<void>;
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

export function crearAlmacen(): Almacen {
  return window.softgala?.almacen ?? almacenLocal;
}
