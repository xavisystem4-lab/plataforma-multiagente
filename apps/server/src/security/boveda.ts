import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Bóveda de secretos (claves API de proveedores, tokens de GitHub).
 * AES-256-GCM con IV aleatorio por valor. Formato: v1.<iv>.<tag>.<cifrado> en base64url.
 * El "contexto" (p. ej. "proveedor:123") se autentica como AAD: un secreto copiado
 * a otro registro no se puede descifrar ahí.
 */
export class Boveda {
  constructor(private readonly clave: Buffer) {
    if (clave.length !== 32) throw new Error('La clave maestra debe medir 32 bytes');
  }

  cifrar(texto: string, contexto: string): string {
    const iv = randomBytes(12);
    const cifrador = createCipheriv('aes-256-gcm', this.clave, iv);
    cifrador.setAAD(Buffer.from(contexto));
    const datos = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
    const b64 = (b: Buffer) => b.toString('base64url');
    return ['v1', b64(iv), b64(cifrador.getAuthTag()), b64(datos)].join('.');
  }

  descifrar(sobre: string, contexto: string): string {
    const [version, iv, tag, datos] = sobre.split('.');
    if (version !== 'v1' || !iv || !tag || datos === undefined) throw new Error('Formato de secreto no válido');
    const descifrador = createDecipheriv('aes-256-gcm', this.clave, Buffer.from(iv, 'base64url'));
    descifrador.setAAD(Buffer.from(contexto));
    descifrador.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([descifrador.update(Buffer.from(datos, 'base64url')), descifrador.final()]).toString('utf8');
  }
}

/** Muestra solo el final de un secreto, p. ej. "••••a1b2". */
export function enmascarar(secreto: string): string {
  return `••••${secreto.slice(-4)}`;
}
