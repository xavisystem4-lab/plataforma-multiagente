import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt viene incluido en Node (sin módulos nativos) y es resistente a GPU/ASIC.
// Parámetros: N=2^17, r=8, p=1 (~128 MiB), recomendación OWASP.
const N = 2 ** 17;
const R = 8;
const P = 1;
const LONGITUD = 64;

function derivar(password: string, sal: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opciones: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), sal, LONGITUD, opciones, (err, clave) =>
      err ? reject(err) : resolve(clave),
    );
  });
}

/** Devuelve `scrypt$N$r$p$sal$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await derivar(password, sal, N, R, P);
  return ['scrypt', N, R, P, sal.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verificarPassword(password: string, almacenado: string): Promise<boolean> {
  const partes = almacenado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, r, p, sal, hash] = partes as [string, string, string, string, string, string];
  const esperado = Buffer.from(hash, 'base64url');
  const obtenido = await derivar(password, Buffer.from(sal, 'base64url'), Number(n), Number(r), Number(p));
  return esperado.length === obtenido.length && timingSafeEqual(esperado, obtenido);
}

/** Hash de relleno para igualar tiempos cuando el usuario no existe (evita enumerar correos). */
let hashRelleno: Promise<string> | null = null;
export function obtenerHashRelleno(): Promise<string> {
  hashRelleno ??= hashPassword(randomBytes(16).toString('hex'));
  return hashRelleno;
}
