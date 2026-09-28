import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Rol } from '@softgala/shared';

const EMISOR = 'softgala-multiagente';
const AUDIENCIA = 'softgala-multiagente-api';

export interface ClaimsAcceso {
  sub: string;
  sid: string;
  rol: Rol;
}

export async function firmarAccessToken(
  claims: ClaimsAcceso,
  secreto: Uint8Array,
  duracionSeg: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sid, rol: claims.rol })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(EMISOR)
    .setAudience(AUDIENCIA)
    .setIssuedAt()
    .setExpirationTime(`${duracionSeg}s`)
    .sign(secreto);
}

/** Lanza si el token es inválido, expiró o no es nuestro. */
export async function verificarAccessToken(token: string, secreto: Uint8Array): Promise<ClaimsAcceso> {
  const { payload } = await jwtVerify(token, secreto, {
    issuer: EMISOR,
    audience: AUDIENCIA,
    algorithms: ['HS256'],
  });
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.rol !== 'string') {
    throw new Error('Claims incompletos');
  }
  return { sub: payload.sub, sid: payload.sid, rol: payload.rol as Rol };
}

/** Token opaco de refresco: 256 bits aleatorios. En la base solo se guarda su hash. */
export function generarRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
