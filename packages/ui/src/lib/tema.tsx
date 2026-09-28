import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type PreferenciaTema = 'claro' | 'oscuro' | 'sistema';
export type Tema = 'claro' | 'oscuro';

const CLAVE = 'softgala.tema';
const consultaOscuro = () => window.matchMedia('(prefers-color-scheme: dark)');

export function leerPreferencia(): PreferenciaTema {
  try {
    const v = localStorage.getItem(CLAVE);
    if (v === 'claro' || v === 'oscuro' || v === 'sistema') return v;
  } catch {
    /* almacenamiento no disponible */
  }
  return 'sistema';
}

export const resolverTema = (p: PreferenciaTema): Tema => (p === 'sistema' ? (consultaOscuro().matches ? 'oscuro' : 'claro') : p);

/** Aplica el tema al documento (atributo data-tema y color de la barra del sistema). */
export function aplicarTema(tema: Tema): void {
  document.documentElement.dataset.tema = tema;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tema === 'oscuro' ? '#071426' : '#0B1F3A');
}

type DocumentoConTransicion = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };

/**
 * Cambia el tema con una transición circular que nace en el punto donde se hizo clic.
 * Usa View Transitions si el motor la soporta; si no, o si el sistema pide reducir movimiento, cambia al instante.
 */
function transicion(nuevo: Tema, origen?: { x: number; y: number }): void {
  const doc = document as DocumentoConTransicion;
  const reducir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!origen || !doc.startViewTransition || reducir || document.documentElement.dataset.tema === nuevo) {
    aplicarTema(nuevo);
    return;
  }
  const { x, y } = origen;
  const radio = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const t = doc.startViewTransition(() => aplicarTema(nuevo));
  void t.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radio}px at ${x}px ${y}px)`] },
      { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  });
}

interface ContextoTema {
  preferencia: PreferenciaTema;
  tema: Tema;
  cambiar(p: PreferenciaTema, origen?: { x: number; y: number }): void;
}

const Contexto = createContext<ContextoTema | null>(null);

export function ProveedorTema({ children }: { children: ReactNode }) {
  const [preferencia, setPreferencia] = useState<PreferenciaTema>(leerPreferencia);
  const [tema, setTema] = useState<Tema>(() => resolverTema(leerPreferencia()));

  // En modo automático, sigue los cambios del sistema operativo en vivo.
  useEffect(() => {
    if (preferencia !== 'sistema') return;
    const mq = consultaOscuro();
    const alCambiar = () => {
      const t = resolverTema('sistema');
      setTema(t);
      aplicarTema(t);
    };
    mq.addEventListener('change', alCambiar);
    return () => mq.removeEventListener('change', alCambiar);
  }, [preferencia]);

  const cambiar = useCallback((p: PreferenciaTema, origen?: { x: number; y: number }) => {
    try {
      localStorage.setItem(CLAVE, p);
    } catch {
      /* sin almacenamiento: el tema dura hasta cerrar la app */
    }
    const nuevo = resolverTema(p);
    setPreferencia(p);
    setTema(nuevo);
    transicion(nuevo, origen);
  }, []);

  return <Contexto.Provider value={{ preferencia, tema, cambiar }}>{children}</Contexto.Provider>;
}

export function useTema(): ContextoTema {
  const c = useContext(Contexto);
  if (!c) throw new Error('useTema debe usarse dentro de ProveedorTema');
  return c;
}
