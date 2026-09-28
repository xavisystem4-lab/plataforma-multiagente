import type { ProyectoPublico } from '@softgala/shared';
import { useEffect, useRef } from 'react';
import { hexDe } from '../components/SelectorColor';
import { ventanasEscritorio } from './plataforma';

const EVENTO = 'softgala:proyectos-cambiados';

/**
 * Abre el proyecto en su propia ventana (solo Windows). Devuelve false si la plataforma no tiene
 * ventanas múltiples; en ese caso quien llama muestra la vista dentro de la app.
 */
export function abrirProyectoEnVentana(p: ProyectoPublico): boolean {
  const v = ventanasEscritorio();
  if (!v) return false;
  void v.abrirProyecto(p.id, p.nombreVentana ?? p.nombre, hexDe(p.color));
  return true;
}

/** Avisa al resto de la interfaz (p. ej. la sección "Fijados") que un proyecto cambió. */
export const avisarCambioProyectos = () => window.dispatchEvent(new Event(EVENTO));

/**
 * Llama a `fn` cuando un proyecto cambia en esta ventana o cuando la ventana recupera el foco
 * (los cambios hechos en otra ventana de proyecto se ven al volver a la principal).
 */
export function useCambioProyectos(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const oyente = () => ref.current();
    window.addEventListener(EVENTO, oyente);
    window.addEventListener('focus', oyente);
    return () => {
      window.removeEventListener(EVENTO, oyente);
      window.removeEventListener('focus', oyente);
    };
  }, []);
}
