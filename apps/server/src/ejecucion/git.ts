import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class ErrorGit extends Error {}

export interface OpcionesGit {
  /** Carpeta raíz de los espacios de trabajo (DATA_DIR/espacios). */
  raiz: string;
  /** Protocolos permitidos para clonar (GIT_ALLOW_PROTOCOL). En producción solo "https". */
  protocolos: string;
  /** URL de clonado a partir de "propietario/repo". */
  urlClonado: (repositorio: string) => string;
}

interface Salida {
  stdout: string;
  stderr: string;
}

/** Oculta cualquier credencial que Git pudiera imprimir en un error. */
const limpiar = (texto: string) =>
  texto
    .replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1••••')
    .replace(/(https?:\/\/)[^@\s/]+@/g, '$1••••@')
    .slice(0, 2000);

/**
 * Operaciones Git del servidor. Garantías:
 * - El token de GitHub viaja por variables de entorno (GIT_CONFIG_*): no queda en la URL
 *   remota, ni en los argumentos del proceso, ni en disco.
 * - Los hooks están desactivados: clonar o hacer commit nunca ejecuta código del repositorio.
 * - Sin prompts interactivos y con protocolos restringidos.
 */
export class EspaciosGit {
  private readonly sinHooks: string;

  constructor(private readonly op: OpcionesGit) {
    this.sinHooks = path.join(op.raiz, '.sin-hooks');
    mkdirSync(this.sinHooks, { recursive: true });
  }

  dirRepo(proyectoId: string): string {
    return path.join(this.op.raiz, proyectoId, 'repo');
  }

  dirTarea(proyectoId: string, tareaId: string): string {
    return path.join(this.op.raiz, proyectoId, 'tareas', tareaId);
  }

  /** Clona el repositorio (sin checkout) o trae los últimos cambios si ya existe. */
  async sincronizar(proyectoId: string, repositorio: string, token: string): Promise<void> {
    const dir = this.dirRepo(proyectoId);
    if (!existsSync(path.join(dir, '.git'))) {
      mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(['clone', '--no-checkout', '--quiet', this.op.urlClonado(repositorio), dir], { token, timeoutMs: 600_000 });
    } else {
      await this.git(['fetch', '--prune', '--quiet', 'origin'], { cwd: dir, token, timeoutMs: 300_000 });
    }
  }

  /** Crea (o reutiliza al reanudar) el worktree de la tarea en una rama nueva desde la rama base. */
  async prepararTarea(proyectoId: string, tareaId: string, rama: string, ramaBase: string): Promise<string> {
    const dir = this.dirTarea(proyectoId, tareaId);
    if (existsSync(path.join(dir, '.git'))) return dir;
    mkdirSync(path.dirname(dir), { recursive: true });
    await this.git(['worktree', 'add', '--quiet', '-b', rama, dir, `origin/${ramaBase}`], { cwd: this.dirRepo(proyectoId) });
    return dir;
  }

  /** Commit de todos los cambios del worktree. Devuelve el sha o null si no había cambios. */
  async commit(dir: string, mensaje: string, autor: string): Promise<string | null> {
    await this.git(['add', '--all'], { cwd: dir });
    const { stdout } = await this.git(['status', '--porcelain'], { cwd: dir });
    if (!stdout.trim()) return null;
    await this.git(
      ['-c', `user.name=${autor}`, '-c', 'user.email=agentes@softgala.local', 'commit', '--quiet', '--no-verify', '-m', mensaje],
      { cwd: dir },
    );
    return (await this.git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  }

  /** Archivos que difieren de la rama base (committeados o no). */
  async archivosCambiados(dir: string, ramaBase: string): Promise<string[]> {
    const [committed, pendientes] = await Promise.all([
      this.git(['diff', '--name-only', `origin/${ramaBase}...HEAD`], { cwd: dir }),
      this.git(['status', '--porcelain', '--untracked-files=all'], { cwd: dir }),
    ]);
    const lista = new Set(committed.stdout.split('\n').filter(Boolean));
    for (const linea of pendientes.stdout.split('\n')) {
      const archivo = linea.slice(3).trim();
      if (archivo) lista.add(archivo.includes(' -> ') ? archivo.split(' -> ')[1]! : archivo);
    }
    return [...lista].sort();
  }

  private git(args: string[], o: { cwd?: string; token?: string; timeoutMs?: number } = {}): Promise<Salida> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, // necesario en Windows
      HOME: process.env.HOME ?? process.env.USERPROFILE,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: this.op.protocolos,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: o.token ? '3' : '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: this.sinHooks,
      GIT_CONFIG_KEY_1: 'core.autocrlf',
      GIT_CONFIG_VALUE_1: 'false',
      ...(o.token
        ? {
            GIT_CONFIG_KEY_2: 'http.extraHeader',
            GIT_CONFIG_VALUE_2: `Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`,
          }
        : {}),
    };
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: o.cwd, env, timeout: o.timeoutMs ?? 120_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new ErrorGit(`git ${args[0]} falló: ${limpiar(stderr || err.message)}`));
          else resolve({ stdout, stderr });
        },
      );
    });
  }
}
