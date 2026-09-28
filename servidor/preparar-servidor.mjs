/**
 * Prepara este equipo como servidor de la Plataforma Multiagente (Windows).
 * - Genera .env.servidor con secretos nuevos si no existe (HOST 0.0.0.0 para la red Tailscale).
 * - Muestra los siguientes pasos (crear usuario, iniciar, autoarranque).
 * No sobrescribe un .env.servidor existente ni toca la MASTER_KEY.
 *
 *   node servidor/preparar-servidor.mjs
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const destino = `${raiz}.env.servidor`;

if (existsSync(destino)) {
  console.log('.env.servidor ya existe; no se modificó.');
  console.log('Si perdiste la MASTER_KEY, NO generes otra: las claves API y tokens guardados dejarían de descifrarse.');
  process.exit(0);
}

// Orígenes de las apps. La app de Windows usa app://ui; la de Android, https://localhost.
// No hace falta añadir la dirección de Tailscale: las apps nativas no envían cabecera Origin.
const contenido = `# Configuración del SERVIDOR (una PC encendida 24/7). Generado por preparar-servidor.mjs.
# NUNCA subas este archivo a Git ni lo compartas: contiene los secretos del servidor.
NODE_ENV=production
# Solo escucha localmente; Tailscale (tailscale serve) lo publica como HTTPS en tu red privada.
HOST=127.0.0.1
PORT=4000
DATA_DIR=./datos-servidor
# Firma de tokens de acceso (no se comparte).
JWT_SECRET=${randomBytes(48).toString('base64url')}
# Clave maestra de la bóveda (32 bytes base64). GUÁRDALA aparte: sin ella no se restauran los respaldos.
MASTER_KEY=${randomBytes(32).toString('base64')}
# Apps nativas (Electron y Android). No requieren la IP de Tailscale.
CORS_ORIGINS=app://ui,https://localhost,capacitor://localhost
# El servidor NO está detrás de un proxy propio.
TRUST_PROXY=false
GITHUB_API_URL=https://api.github.com
MAX_AGENTES_POR_USUARIO=50
MAX_PROYECTOS_POR_USUARIO=100
MAX_TAREAS_SIMULTANEAS=4
MAX_TURNOS_POR_EJECUCION=60
SANDBOX_IMAGEN=node:22-bookworm-slim
SANDBOX_CPUS=2
SANDBOX_MEMORIA=2g
SANDBOX_USUARIO=1000:1000
TIMEOUT_VALIDACION_MIN=10
# Respaldos automáticos de la base de datos (cada 24 h, se conservan 7).
RESPALDO_CADA_HORAS=24
RESPALDOS_A_CONSERVAR=7
`;

writeFileSync(destino, contenido, { mode: 0o600 });

// Extrae la MASTER_KEY para recordarle al usuario que la guarde.
const masterKey = /^MASTER_KEY=(.+)$/m.exec(contenido)?.[1] ?? '';
console.log('.env.servidor generado con secretos nuevos.\n');
console.log('⚠  GUARDA esta MASTER_KEY en un lugar seguro (gestor de contraseñas). La necesitas para restaurar respaldos o mudarte de PC:');
console.log(`   ${masterKey}\n`);
console.log('Siguientes pasos:');
console.log('  1) Crea tu usuario:      npm run usuario:crear -- --email tu@correo.com --nombre "Tu Nombre"');
console.log('  2) Prueba el servidor:   node servidor/iniciar.mjs');
console.log('  3) Autoarranque:         powershell -ExecutionPolicy Bypass -File servidor\\instalar-autoarranque.ps1');
