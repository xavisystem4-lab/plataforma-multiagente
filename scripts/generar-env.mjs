// Genera .env con secretos aleatorios para desarrollo local. No sobrescribe uno existente.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const destino = `${raiz}.env`;

if (existsSync(destino)) {
  console.log('.env ya existe; no se modificó.');
  process.exit(0);
}

const plantilla = readFileSync(`${raiz}.env.example`, 'utf8')
  .replace(/^JWT_SECRET=$/m, `JWT_SECRET=${randomBytes(48).toString('base64url')}`)
  .replace(/^MASTER_KEY=$/m, `MASTER_KEY=${randomBytes(32).toString('base64')}`);

writeFileSync(destino, plantilla, { mode: 0o600 });
console.log('.env generado con secretos aleatorios.');
