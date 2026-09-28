import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IdHerramienta } from '@softgala/shared';
import { z } from 'zod';

/** Definición neutral (JSON Schema) que cada adaptador traduce al formato de su proveedor. */
export interface DefinicionHerramienta {
  nombre: string;
  descripcion: string;
  esquema: Record<string, unknown>;
}

export interface ResultadoHerramienta {
  contenido: string;
  error: boolean;
  /** Archivo creado o modificado (para el evento file.changed). */
  archivoModificado?: string;
}

/** Acciones que el orquestador realiza por la herramienta (validaciones, commits, preguntas). */
export interface AccionesOrquestador {
  ejecutarValidacion(nombre: string): Promise<ResultadoHerramienta>;
  commit(mensaje: string): Promise<ResultadoHerramienta>;
}

export const HERRAMIENTA_PREGUNTA = 'solicitar_intervencion';

const LIMITE_LECTURA = 256 * 1024;
const LIMITE_ESCRITURA = 1024 * 1024;
const IGNORAR = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__']);

const ruta = z.string().min(1).max(500);
const ESQUEMAS = {
  listar_directorio: z.object({ ruta: z.string().max(500).default('.') }),
  leer_archivo: z.object({
    ruta,
    desde_linea: z.number().int().min(1).optional(),
    max_lineas: z.number().int().min(1).max(5000).optional(),
  }),
  buscar_texto: z.object({ texto: z.string().min(1).max(200), ruta: z.string().max(500).default('.') }),
  escribir_archivo: z.object({ ruta, contenido: z.string().max(LIMITE_ESCRITURA) }),
  reemplazar_texto: z.object({ ruta, buscar: z.string().min(1).max(100_000), reemplazar: z.string().max(100_000) }),
  ejecutar_validacion: z.object({ nombre: z.string().min(1).max(60) }),
  hacer_commit: z.object({ mensaje: z.string().min(3).max(500) }),
  [HERRAMIENTA_PREGUNTA]: z.object({ pregunta: z.string().min(3).max(2000) }),
} as const;
type NombreHerramienta = keyof typeof ESQUEMAS;

const DEFINICIONES: Record<NombreHerramienta, Omit<DefinicionHerramienta, 'nombre'>> = {
  listar_directorio: {
    descripcion: 'Lista archivos y carpetas de una ruta del proyecto (relativa a la raíz).',
    esquema: { type: 'object', properties: { ruta: { type: 'string', description: 'Ruta relativa; "." para la raíz' } }, required: [] },
  },
  leer_archivo: {
    descripcion: 'Lee un archivo de texto del proyecto. Para archivos grandes usa desde_linea y max_lineas.',
    esquema: {
      type: 'object',
      properties: {
        ruta: { type: 'string' },
        desde_linea: { type: 'integer', minimum: 1 },
        max_lineas: { type: 'integer', minimum: 1, maximum: 5000 },
      },
      required: ['ruta'],
    },
  },
  buscar_texto: {
    descripcion: 'Busca un texto literal en los archivos del proyecto y devuelve archivo:línea: contenido.',
    esquema: {
      type: 'object',
      properties: { texto: { type: 'string' }, ruta: { type: 'string', description: 'Carpeta donde buscar; "." por defecto' } },
      required: ['texto'],
    },
  },
  escribir_archivo: {
    descripcion: 'Crea o reemplaza por completo un archivo del proyecto en tu rama de trabajo.',
    esquema: { type: 'object', properties: { ruta: { type: 'string' }, contenido: { type: 'string' } }, required: ['ruta', 'contenido'] },
  },
  reemplazar_texto: {
    descripcion: 'Reemplaza un fragmento exacto que aparece una sola vez en un archivo. Prefiérelo a reescribir archivos grandes.',
    esquema: {
      type: 'object',
      properties: { ruta: { type: 'string' }, buscar: { type: 'string' }, reemplazar: { type: 'string' } },
      required: ['ruta', 'buscar', 'reemplazar'],
    },
  },
  ejecutar_validacion: {
    descripcion: 'Ejecuta en el sandbox una de las validaciones configuradas del proyecto (por nombre) y devuelve su resultado real.',
    esquema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
  },
  hacer_commit: {
    descripcion: 'Hace commit de los cambios actuales en tu rama de trabajo (nunca hace push).',
    esquema: { type: 'object', properties: { mensaje: { type: 'string' } }, required: ['mensaje'] },
  },
  [HERRAMIENTA_PREGUNTA]: {
    descripcion:
      'Pausa la tarea y pregunta algo al usuario cuando necesites una decisión suya o una acción no permitida (push, despliegue, secretos, red, borrar archivos).',
    esquema: { type: 'object', properties: { pregunta: { type: 'string' } }, required: ['pregunta'] },
  },
};

/** Herramientas concretas que habilita cada permiso del agente. */
const POR_PERMISO: Record<IdHerramienta, NombreHerramienta[]> = {
  leer_archivos: ['listar_directorio', 'leer_archivo'],
  buscar_codigo: ['buscar_texto'],
  escribir_archivos: ['escribir_archivo', 'reemplazar_texto'],
  ejecutar_validaciones: ['ejecutar_validacion'],
  git_commit: ['hacer_commit'],
};

export function herramientasPara(permisos: IdHerramienta[]): DefinicionHerramienta[] {
  const nombres = new Set<NombreHerramienta>(permisos.flatMap((p) => POR_PERMISO[p] ?? []));
  nombres.add(HERRAMIENTA_PREGUNTA);
  return [...nombres].map((nombre) => ({ nombre, ...DEFINICIONES[nombre] }));
}

export class ErrorRuta extends Error {}

/**
 * Resuelve una ruta del modelo (dato no confiable) dentro de la raíz del proyecto.
 * Rechaza rutas absolutas, "..", la carpeta .git y symlinks que apunten fuera.
 */
export async function resolverRuta(raiz: string, relativa: string): Promise<string> {
  if (relativa.includes('\0')) throw new ErrorRuta('Ruta no válida');
  if (path.isAbsolute(relativa) || /^[a-zA-Z]:/.test(relativa)) throw new ErrorRuta('Usa rutas relativas a la raíz del proyecto');
  const raizReal = await realpath(raiz);
  const destino = path.resolve(raizReal, relativa);
  const rel = path.relative(raizReal, destino);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new ErrorRuta('La ruta sale del proyecto');
  if (rel.split(path.sep).some((s) => s.toLowerCase() === '.git')) throw new ErrorRuta('La carpeta .git no es accesible');

  // Comprueba con la ruta real del ancestro existente más cercano (detecta symlinks).
  let existente = destino;
  for (;;) {
    try {
      const real = await realpath(existente);
      const relReal = path.relative(raizReal, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new ErrorRuta('La ruta sale del proyecto (enlace simbólico)');
      break;
    } catch (err) {
      if (err instanceof ErrorRuta) throw err;
      const padre = path.dirname(existente);
      if (padre === existente) break;
      existente = padre;
    }
  }
  return destino;
}

const relativaA = (raiz: string, abs: string) => path.relative(raiz, abs).split(path.sep).join('/') || '.';

/** ¿La ruta relativa (con "/") está cubierta por algún archivo o carpeta ("dir/") permitido? */
export function rutaCubierta(rel: string, permitidas: string[]): boolean {
  return permitidas.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}

/**
 * Normaliza una ruta del plan del coordinador: relativa, con "/", sin "./", "..", ni .git.
 * Devuelve null si no es aceptable.
 */
export function normalizarRutaPlan(ruta: string): string | null {
  const r = ruta.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r || r.startsWith('/') || /^[a-zA-Z]:/.test(r) || r.includes('\0')) return null;
  const partes = r.split('/');
  if (partes.some((p, i) => p === '..' || p === '.' || p.toLowerCase() === '.git' || (p === '' && i < partes.length - 1))) return null;
  return r;
}

export interface OpcionesEjecutor {
  /** Si se indica, solo se puede escribir en estos archivos o carpetas ("dir/"). */
  rutasEscritura?: string[];
}

export class EjecutorHerramientas {
  private readonly permitidas: Set<string>;

  constructor(
    private readonly raiz: string,
    permisos: IdHerramienta[],
    private readonly acciones: AccionesOrquestador,
    private readonly opciones: OpcionesEjecutor = {},
  ) {
    this.permitidas = new Set(herramientasPara(permisos).map((h) => h.nombre));
  }

  /** Aislamiento entre subtareas paralelas: cada agente escribe solo en lo que se le asignó. */
  private verificarEscritura(rel: string): ResultadoHerramienta | null {
    const permitidas = this.opciones.rutasEscritura;
    if (!permitidas || rutaCubierta(rel, permitidas)) return null;
    return {
      error: true,
      contenido: `"${rel}" está fuera de los archivos asignados a tu subtarea (${permitidas.join(', ')}). Si es necesario modificarlo, usa solicitar_intervencion.`,
    };
  }

  async ejecutar(nombre: string, entrada: unknown): Promise<ResultadoHerramienta> {
    // El permiso se comprueba aquí, no en el modelo: una herramienta no otorgada nunca se ejecuta.
    if (!this.permitidas.has(nombre) || !(nombre in ESQUEMAS)) {
      return { error: true, contenido: `La herramienta "${nombre}" no está autorizada para este agente.` };
    }
    const parseo = ESQUEMAS[nombre as NombreHerramienta].safeParse(entrada);
    if (!parseo.success) {
      return { error: true, contenido: `Entrada no válida: ${parseo.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    try {
      return await this.despachar(nombre as NombreHerramienta, parseo.data);
    } catch (err) {
      if (err instanceof ErrorRuta) return { error: true, contenido: err.message };
      const codigo = (err as NodeJS.ErrnoException).code;
      if (codigo === 'ENOENT') return { error: true, contenido: 'El archivo o carpeta no existe.' };
      if (codigo === 'EISDIR') return { error: true, contenido: 'La ruta es una carpeta.' };
      throw err;
    }
  }

  private async despachar(nombre: NombreHerramienta, datos: unknown): Promise<ResultadoHerramienta> {
    const de = <N extends NombreHerramienta>(_: N) => datos as z.output<(typeof ESQUEMAS)[N]>;
    switch (nombre) {
      case 'listar_directorio':
        return this.listar(de(nombre).ruta);
      case 'leer_archivo': {
        const d = de(nombre);
        return this.leer(d.ruta, d.desde_linea, d.max_lineas);
      }
      case 'buscar_texto': {
        const d = de(nombre);
        return this.buscar(d.texto, d.ruta);
      }
      case 'escribir_archivo': {
        const d = de(nombre);
        return this.escribir(d.ruta, d.contenido);
      }
      case 'reemplazar_texto': {
        const d = de(nombre);
        return this.reemplazar(d.ruta, d.buscar, d.reemplazar);
      }
      case 'ejecutar_validacion':
        return this.acciones.ejecutarValidacion(de(nombre).nombre);
      case 'hacer_commit':
        return this.acciones.commit(de(nombre).mensaje);
      case HERRAMIENTA_PREGUNTA:
        // La maneja el orquestador (pausa la tarea); nunca llega aquí.
        return { error: true, contenido: 'Pregunta no procesada.' };
    }
  }

  private async listar(r: string): Promise<ResultadoHerramienta> {
    const dir = await resolverRuta(this.raiz, r);
    const entradas = await readdir(dir, { withFileTypes: true });
    const lineas = entradas
      .filter((e) => e.name !== '.git')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { error: false, contenido: lineas.join('\n') || '(carpeta vacía)' };
  }

  private async leer(r: string, desde = 1, max?: number): Promise<ResultadoHerramienta> {
    const archivo = await resolverRuta(this.raiz, r);
    const info = await stat(archivo);
    if (info.isDirectory()) return { error: true, contenido: 'La ruta es una carpeta; usa listar_directorio.' };
    const buffer = await readFile(archivo);
    if (buffer.subarray(0, 8000).includes(0)) return { error: true, contenido: 'Es un archivo binario; no se puede leer como texto.' };
    const lineas = buffer.toString('utf8').split('\n');
    const hasta = max ? desde - 1 + max : lineas.length;
    let texto = lineas.slice(desde - 1, hasta).join('\n');
    let nota = '';
    if (texto.length > LIMITE_LECTURA) {
      texto = texto.slice(0, LIMITE_LECTURA);
      nota = '\n[… recortado: usa desde_linea y max_lineas para leer el resto]';
    } else if (hasta < lineas.length) {
      nota = `\n[… líneas ${desde}-${hasta} de ${lineas.length}]`;
    }
    return { error: false, contenido: texto + nota };
  }

  private async buscar(texto: string, r: string): Promise<ResultadoHerramienta> {
    const inicio = await resolverRuta(this.raiz, r);
    const resultados: string[] = [];
    const pila = [inicio];
    let revisados = 0;
    while (pila.length && resultados.length < 200 && revisados < 20_000) {
      const actual = pila.pop()!;
      const info = await lstat(actual);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        for (const e of await readdir(actual)) if (!IGNORAR.has(e)) pila.push(path.join(actual, e));
        continue;
      }
      revisados++;
      if (info.size > 1024 * 1024) continue;
      const buffer = await readFile(actual);
      if (buffer.subarray(0, 8000).includes(0)) continue;
      buffer
        .toString('utf8')
        .split('\n')
        .forEach((linea, i) => {
          if (resultados.length < 200 && linea.includes(texto)) {
            resultados.push(`${relativaA(this.raiz, actual)}:${i + 1}: ${linea.trim().slice(0, 300)}`);
          }
        });
    }
    return { error: false, contenido: resultados.length ? resultados.join('\n') : 'Sin coincidencias.' };
  }

  private async escribir(r: string, contenido: string): Promise<ResultadoHerramienta> {
    const archivo = await resolverRuta(this.raiz, r);
    const fuera = this.verificarEscritura(relativaA(this.raiz, archivo));
    if (fuera) return fuera;
    const existente = await lstat(archivo).catch(() => null);
    if (existente?.isSymbolicLink()) return { error: true, contenido: 'No se escribe sobre enlaces simbólicos.' };
    if (existente?.isDirectory()) return { error: true, contenido: 'La ruta es una carpeta.' };
    await mkdir(path.dirname(archivo), { recursive: true });
    await writeFile(archivo, contenido, 'utf8');
    const rel = relativaA(this.raiz, archivo);
    return { error: false, contenido: `Archivo ${existente ? 'actualizado' : 'creado'}: ${rel}`, archivoModificado: rel };
  }

  private async reemplazar(r: string, buscar: string, reemplazar: string): Promise<ResultadoHerramienta> {
    const archivo = await resolverRuta(this.raiz, r);
    const fuera = this.verificarEscritura(relativaA(this.raiz, archivo));
    if (fuera) return fuera;
    if ((await lstat(archivo)).isSymbolicLink()) return { error: true, contenido: 'No se escribe sobre enlaces simbólicos.' };
    const texto = await readFile(archivo, 'utf8');
    const veces = texto.split(buscar).length - 1;
    if (veces === 0) return { error: true, contenido: 'El texto a buscar no aparece en el archivo.' };
    if (veces > 1) return { error: true, contenido: `El texto aparece ${veces} veces; incluye más contexto para que sea único.` };
    await writeFile(archivo, texto.replace(buscar, () => reemplazar), 'utf8');
    const rel = relativaA(this.raiz, archivo);
    return { error: false, contenido: `Archivo actualizado: ${rel}`, archivoModificado: rel };
  }
}
