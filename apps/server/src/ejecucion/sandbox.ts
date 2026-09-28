import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface ResultadoComando {
  codigo: number | null;
  salida: string;
  duracionMs: number;
  /** true si se detuvo por exceder el tiempo máximo. */
  expirado: boolean;
}

export interface OpcionesComando {
  red: boolean;
  timeoutMs: number;
}

/**
 * Entorno aislado donde se ejecuta código del repositorio (validaciones).
 * Solo ejecuta comandos configurados por el usuario en el proyecto, nunca texto del modelo.
 */
export interface Sandbox {
  readonly disponible: boolean;
  /** Motivo si no está disponible (se muestra al usuario). */
  readonly motivo: string | null;
  ejecutar(dirTrabajo: string, comando: string, o: OpcionesComando): Promise<ResultadoComando>;
}

const MAX_SALIDA = 20_000;
const recortar = (s: string) => (s.length > MAX_SALIDA ? `…${s.slice(-MAX_SALIDA)}` : s);

export class SandboxNoDisponible implements Sandbox {
  readonly disponible = false;
  constructor(readonly motivo: string) {}
  async ejecutar(): Promise<ResultadoComando> {
    throw new Error(this.motivo);
  }
}

export interface ConfigDocker {
  imagen: string;
  cpus: string;
  memoria: string;
  usuario: string;
}

export class SandboxDocker implements Sandbox {
  readonly disponible = true;
  readonly motivo = null;

  constructor(private readonly c: ConfigDocker) {}

  ejecutar(dirTrabajo: string, comando: string, o: OpcionesComando): Promise<ResultadoComando> {
    const nombre = `softgala-val-${randomBytes(6).toString('hex')}`;
    const args = [
      'run', '--rm', '--name', nombre,
      '--network', o.red ? 'bridge' : 'none',
      '--cpus', this.c.cpus,
      '--memory', this.c.memoria,
      '--pids-limit', '512',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--user', this.c.usuario,
      '--tmpfs', '/tmp:rw,exec,size=512m',
      '-e', 'HOME=/tmp',
      '-e', 'CI=true',
      '-v', `${dirTrabajo}:/work`,
      '-w', '/work',
      this.c.imagen,
      'sh', '-c', comando,
    ];
    const inicio = Date.now();
    return new Promise((resolve) => {
      const proc = spawn('docker', args, { windowsHide: true });
      let salida = '';
      let expirado = false;
      const agregar = (d: Buffer) => {
        salida = recortar(salida + d.toString('utf8'));
      };
      proc.stdout.on('data', agregar);
      proc.stderr.on('data', agregar);
      const temporizador = setTimeout(() => {
        expirado = true;
        execFile('docker', ['kill', nombre], { windowsHide: true }, () => {});
      }, o.timeoutMs);
      proc.on('error', (err) => {
        clearTimeout(temporizador);
        resolve({ codigo: null, salida: `No se pudo iniciar Docker: ${err.message}`, duracionMs: Date.now() - inicio, expirado });
      });
      proc.on('close', (codigo) => {
        clearTimeout(temporizador);
        resolve({ codigo, salida, duracionMs: Date.now() - inicio, expirado });
      });
    });
  }
}

/** Usa Docker si el daemon responde; si no, un sandbox que informa por qué no puede ejecutar. */
export function detectarSandbox(c: ConfigDocker): Promise<Sandbox> {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000, windowsHide: true }, (err) => {
      resolve(
        err
          ? new SandboxNoDisponible('Sandbox no disponible: Docker no está instalado o no está en ejecución en el servidor.')
          : new SandboxDocker(c),
      );
    });
  });
}
