import { z } from 'zod';

export const ROLES = ['admin', 'usuario'] as const;
export type Rol = (typeof ROLES)[number];

export const esquemaLogin = z.object({
  email: z.string().trim().toLowerCase().email('Correo no válido').max(254),
  password: z.string().min(1, 'Escribe tu contraseña').max(256),
  dispositivo: z.string().trim().max(100).optional(),
});
export type SolicitudLogin = z.infer<typeof esquemaLogin>;

export const esquemaRefresh = z.object({
  refreshToken: z.string().min(20).max(200),
});

/** Política mínima de contraseñas: longitud antes que complejidad (NIST 800-63B). */
export const esquemaPasswordNueva = z
  .string()
  .min(12, 'La contraseña debe tener al menos 12 caracteres')
  .max(256);

export interface UsuarioPublico {
  id: string;
  email: string;
  nombre: string;
  rol: Rol;
}

export interface RespuestaLogin {
  accessToken: string;
  /** Segundos hasta que expira el token de acceso. */
  expiraEn: number;
  refreshToken: string;
  usuario: UsuarioPublico;
}

export interface SesionActiva {
  id: string;
  dispositivo: string | null;
  ip: string | null;
  creadaEn: string;
  ultimoUso: string;
  actual: boolean;
}

/** Formato uniforme de error de la API. */
export interface ErrorApi {
  error: { codigo: string; mensaje: string };
}
