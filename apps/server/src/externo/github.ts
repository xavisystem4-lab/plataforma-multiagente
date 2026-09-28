import { ErrorApp } from '../errores';

export interface InfoRepo {
  privado: boolean;
  ramaPrincipal: string;
  url: string;
  permisos: { admin: boolean; push: boolean; pull: boolean } | null;
}

export interface InfoRama {
  nombre: string;
  commit: { sha: string; mensaje: string; autor: string; fecha: string; url: string };
}

/** Cliente mínimo de la API REST de GitHub. `fetch` es inyectable para pruebas. */
export class ClienteGitHub {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {}

  async repo(repositorio: string, token: string): Promise<InfoRepo> {
    const d = await this.get<{
      private: boolean;
      default_branch: string;
      html_url: string;
      permissions?: { admin: boolean; push: boolean; pull: boolean };
    }>(`/repos/${repositorio}`, token);
    return { privado: d.private, ramaPrincipal: d.default_branch, url: d.html_url, permisos: d.permissions ?? null };
  }

  async rama(repositorio: string, rama: string, token: string): Promise<InfoRama> {
    const d = await this.get<{
      name: string;
      commit: {
        sha: string;
        html_url: string;
        commit: { message: string; author: { name: string; date: string } | null };
      };
    }>(`/repos/${repositorio}/branches/${encodeURIComponent(rama)}`, token, 'RAMA');
    return {
      nombre: d.name,
      commit: {
        sha: d.commit.sha,
        mensaje: d.commit.commit.message.split('\n')[0] ?? '',
        autor: d.commit.commit.author?.name ?? 'desconocido',
        fecha: d.commit.commit.author?.date ?? '',
        url: d.commit.html_url,
      },
    };
  }

  /** Ramas cuyo nombre empieza con `prefijo` (primeras 100). */
  async ramasConPrefijo(repositorio: string, prefijo: string, token: string): Promise<string[]> {
    const d = await this.get<{ name: string }[]>(`/repos/${repositorio}/branches?per_page=100`, token);
    return d.map((r) => r.name).filter((n) => n.startsWith(prefijo));
  }

  private async get<T>(ruta: string, token: string, recurso: 'REPO' | 'RAMA' = 'REPO'): Promise<T> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.api}${ruta}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'softgala-multiagente',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ErrorApp(502, 'GITHUB_SIN_CONEXION', 'No se pudo conectar con GitHub. Revisa la conexión del servidor.');
    }
    if (r.ok) return (await r.json()) as T;
    if (r.status === 401) throw new ErrorApp(400, 'GITHUB_TOKEN_INVALIDO', 'GitHub rechazó el token: es inválido o expiró.');
    if (r.status === 404) {
      throw recurso === 'RAMA'
        ? new ErrorApp(400, 'GITHUB_RAMA_NO_ENCONTRADA', 'La rama no existe en el repositorio.')
        : new ErrorApp(400, 'GITHUB_REPO_NO_ENCONTRADO', 'No se encontró el repositorio o el token no tiene acceso a él.');
    }
    if (r.status === 403 || r.status === 429) {
      throw new ErrorApp(502, 'GITHUB_LIMITE', 'GitHub negó la solicitud (permisos insuficientes o límite de uso). Intenta más tarde.');
    }
    throw new ErrorApp(502, 'GITHUB_ERROR', `GitHub respondió con un error (${r.status}).`);
  }
}

/** Advertencias sobre el token y sus permisos (principio de permisos mínimos). */
export function avisosToken(token: string, permisos: InfoRepo['permisos']): string[] {
  const avisos: string[] = [];
  if (token.startsWith('ghp_')) {
    avisos.push('Es un token clásico con acceso amplio. Recomendado: token "fine-grained" limitado a este repositorio.');
  }
  if (permisos?.admin) {
    avisos.push('El token tiene permisos de administrador del repositorio; los agentes no los necesitan.');
  }
  if (permisos && !permisos.push) {
    avisos.push('El token es de solo lectura: los agentes no podrán subir sus ramas de trabajo.');
  }
  return avisos;
}
