import { isIP } from 'node:net';
import { ErrorApp } from '../errores';

const LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function esIpPrivada(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (isIP(h) === 6) return /^(fc|fd|fe80)/i.test(h);
  return false;
}

/**
 * Valida la URL base de un proveedor que el servidor va a llamar.
 * - Exige HTTPS, salvo para un servidor de modelos en el mismo equipo (p. ej. Ollama).
 * - Rechaza IPs privadas o de metadatos de nube escritas directamente (mitiga SSRF).
 * Limitación conocida: un dominio público que resuelva a una IP privada no se detecta aquí.
 */
export function validarUrlProveedor(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErrorApp(400, 'URL_INVALIDA', 'La URL del proveedor no es válida');
  }
  const local = LOCALES.has(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    throw new ErrorApp(400, 'URL_INSEGURA', 'La URL del proveedor debe usar HTTPS (HTTP solo para localhost)');
  }
  if (!local && esIpPrivada(u.hostname)) {
    throw new ErrorApp(400, 'URL_PRIVADA', 'No se permiten direcciones de red privada para proveedores');
  }
  if (u.username || u.password) {
    throw new ErrorApp(400, 'URL_INVALIDA', 'No incluyas credenciales en la URL; usa el campo de clave API');
  }
  return u.toString().replace(/\/+$/, '');
}
