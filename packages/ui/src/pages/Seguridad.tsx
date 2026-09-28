import type { SesionActiva } from '@softgala/shared';
import { useCallback, useEffect, useState } from 'react';
import { IconoAlerta, IconoDispositivo, IconoMovil, IconoSalir } from '../components/Iconos';
import { ErrorCliente } from '../lib/api';
import { useSesion } from '../lib/sesion';

const formatoFecha = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

export function Seguridad() {
  const { api, salir } = useSesion();
  const [sesiones, setSesiones] = useState<SesionActiva[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revocando, setRevocando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setSesiones(await api.sesiones());
      setError(null);
    } catch (err) {
      setError(err instanceof ErrorCliente ? err.message : 'No se pudieron cargar las sesiones.');
    }
  }, [api]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function revocar(s: SesionActiva) {
    if (!window.confirm(`¿Cerrar la sesión de "${s.dispositivo ?? 'dispositivo desconocido'}"?`)) return;
    setRevocando(s.id);
    try {
      await api.revocarSesion(s.id);
      await cargar();
    } catch (err) {
      setError(err instanceof ErrorCliente ? err.message : 'No se pudo cerrar la sesión.');
    } finally {
      setRevocando(null);
    }
  }

  return (
    <>
      <div className="encabezado">
        <div>
          <h1>Seguridad</h1>
          <p>Dispositivos con sesión abierta. Cierra cualquiera que no reconozcas.</p>
        </div>
        <button className="boton menu-movil" onClick={() => void salir()}>
          <IconoSalir /> Cerrar sesión
        </button>
      </div>

      {error && (
        <div className="alerta alerta-error" role="alert" style={{ marginBottom: 16 }}>
          <IconoAlerta /> {error}
        </div>
      )}

      <section className="tarjeta">
        <h2>Sesiones activas</h2>
        {!sesiones ? (
          <p>Cargando…</p>
        ) : (
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead>
                <tr>
                  <th>Dispositivo</th>
                  <th>IP</th>
                  <th>Último uso</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {sesiones.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        {s.dispositivo?.startsWith('Android') ? <IconoMovil /> : <IconoDispositivo />}
                        {s.dispositivo ?? 'Desconocido'}
                        {s.actual && <span className="etiqueta etiqueta-marino">Este dispositivo</span>}
                      </span>
                    </td>
                    <td>{s.ip ?? '—'}</td>
                    <td>{formatoFecha.format(new Date(s.ultimoUso))}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!s.actual && (
                        <button
                          className="boton boton-peligro"
                          onClick={() => void revocar(s)}
                          disabled={revocando === s.id}
                        >
                          Cerrar sesión
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
