import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorCliente } from './api';

export const mensajeError = (err: unknown, porDefecto = 'Ocurrió un error inesperado.') =>
  err instanceof ErrorCliente ? err.message : porDefecto;

/** Carga datos al montar y expone `recargar`. Ignora respuestas de cargas anteriores. */
export function useDatos<T>(cargar: () => Promise<T>) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const turno = useRef(0);

  const recargar = useCallback(async () => {
    const mio = ++turno.current;
    setCargando(true);
    try {
      const r = await cargar();
      if (mio === turno.current) {
        setDatos(r);
        setError(null);
      }
    } catch (err) {
      if (mio === turno.current) setError(mensajeError(err, 'No se pudieron cargar los datos.'));
    } finally {
      if (mio === turno.current) setCargando(false);
    }
  }, [cargar]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return { datos, error, cargando, recargar, setDatos };
}
