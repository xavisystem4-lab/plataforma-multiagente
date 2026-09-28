// Compila la APK de Android.
//   npm run apk -w @softgala/mobile              → APK de depuración (instalable para pruebas)
//   npm run apk -w @softgala/mobile -- --release → APK de release firmada con TU keystore:
//       SOFTGALA_KEYSTORE, SOFTGALA_KEYSTORE_PASSWORD, SOFTGALA_KEY_ALIAS, SOFTGALA_KEY_PASSWORD
// Requiere JDK 21 (Capacitor 8) y el SDK de Android.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(raiz, 'android');
const release = process.argv.includes('--release');
const { version } = JSON.parse(readFileSync(path.join(raiz, 'package.json'), 'utf8'));

function versionJava(home) {
  const java = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!existsSync(java)) return null;
  const r = spawnSync(java, ['-version'], { encoding: 'utf8' });
  const m = /version "(\d+)/.exec(`${r.stderr}${r.stdout}`);
  return m ? Number(m[1]) : null;
}

/** Busca un JDK 21: JAVA_HOME, la carpeta de herramientas de SoftGala o el JBR de Android Studio. */
function buscarJdk() {
  const candidatos = [
    process.env.JAVA_HOME,
    path.join(homedir(), '.softgala', 'herramientas', 'jdk-21'),
    'C:/Program Files/Android/Android Studio/jbr',
  ].filter(Boolean);
  for (const c of candidatos) if (versionJava(c) === 21) return c;
  const encontrados = candidatos.map((c) => `${c} (Java ${versionJava(c) ?? 'no encontrado'})`).join('\n  ');
  throw new Error(`Se necesita JDK 21 para compilar (Capacitor 8). Revisados:\n  ${encontrados}\nDefine JAVA_HOME con un JDK 21.`);
}

function buscarSdk() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  if (!existsSync(path.join(sdk, 'platforms'))) throw new Error(`No se encontró el SDK de Android en ${sdk}. Define ANDROID_HOME.`);
  return sdk;
}

try {
  const jdk = buscarJdk();
  const sdk = buscarSdk();
  if (release && !process.env.SOFTGALA_KEYSTORE) {
    throw new Error('Para la versión release define SOFTGALA_KEYSTORE y sus contraseñas (ver comentario al inicio de este script).');
  }
  writeFileSync(path.join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/').replace(':', '\\:')}\n`);
  console.log(`JDK: ${jdk}\nSDK: ${sdk}`);

  // Relativo a la carpeta android: una ruta absoluta con espacios rompe la invocación por cmd.exe.
  const tarea = release ? 'assembleRelease' : 'assembleDebug';
  // En Windows los .bat se ejecutan con cmd.exe; ruta relativa explícita porque cmd puede no buscar
  // en la carpeta actual (NoDefaultCurrentDirectoryInExePath) y la ruta absoluta tiene espacios.
  const [comando, args] =
    process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `.\\gradlew.bat ${tarea} --console=plain`]] : ['./gradlew', [tarea, '--console=plain']];
  execFileSync(comando, args, { cwd: android, stdio: 'inherit', env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk } });

  const tipo = release ? 'release' : 'debug';
  const origen = path.join(android, 'app', 'build', 'outputs', 'apk', tipo, `app-${tipo}.apk`);
  const destino = path.join(raiz, 'dist', `PlataformaMultiagente-${version}-${tipo}.apk`);
  mkdirSync(path.dirname(destino), { recursive: true });
  copyFileSync(origen, destino);
  console.log(`\nAPK lista: ${destino}`);
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
