import { useEffect, useState } from 'react';
import { actualizacionesEscritorio, detectarPlataforma, type EstadoActualizacion } from '../lib/plataforma';
import '../styles/barra-estado.css';

/**
 * Barra inferior: a la izquierda la versión del sistema; a la derecha, el control de actualización.
 * Al pulsar "Actualizar" se busca, se descarga (con barra de progreso) y se instala la nueva versión.
 * Solo la app de Windows empaquetada puede actualizarse; en Android y web solo se muestra la versión.
 */
export function BarraEstado() {
  const puente = actualizacionesEscritorio();
  const [est, setEst] = useState<EstadoActualizacion>({ fase: 'inactivo', version: __VERSION_APP__, disponible: null, porcentaje: 0, mensaje: null });
  const [soportado, setSoportado] = useState(false);

  useEffect(() => {
    if (!puente) return;
    let vivo = true;
    void puente.estado().then((e) => {
      if (!vivo) return;
      setEst(e);
      setSoportado(!!e.soportado);
    });
    const dejar = puente.alCambiar((e) => setEst((prev) => ({ ...prev, ...e })));
    return () => {
      vivo = false;
      dejar();
    };
  }, [puente]);

  const control = () => {
    if (!puente || !soportado) return null;
    switch (est.fase) {
      case 'buscando':
        return <span className="be-texto">Buscando actualizaciones…</span>;
      case 'disponible':
        return (
          <button className="be-boton be-primario" onClick={() => void puente.descargar()}>
            Actualizar a {est.disponible}
          </button>
        );
      case 'descargando':
        return (
          <div className="be-progreso" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={est.porcentaje} aria-label="Descargando actualización">
            <div className="be-progreso-pista">
              <div className="be-progreso-relleno" style={{ width: `${est.porcentaje}%` }} />
            </div>
            <span className="be-texto">Descargando… {est.porcentaje}%</span>
          </div>
        );
      case 'lista':
        return (
          <button className="be-boton be-primario" onClick={() => void puente.instalar()}>
            Reiniciar e instalar {est.disponible}
          </button>
        );
      case 'al-dia':
        return <span className="be-texto be-exito">Estás en la última versión ✓</span>;
      case 'error':
        return (
          <span className="be-texto be-error">
            {est.mensaje ?? 'No se pudo actualizar'}{' '}
            <button className="be-boton" onClick={() => void puente.buscar()}>
              Reintentar
            </button>
          </span>
        );
      default:
        return (
          <button className="be-boton" onClick={() => void puente.buscar()}>
            Buscar actualizaciones
          </button>
        );
    }
  };

  return (
    <footer className="barra-estado">
      <span className="be-version">
        Plataforma Multiagente <strong>v{est.version}</strong>
        <span className="be-marca"> · SoftGala</span>
      </span>
      <div className="be-derecha">{puente ? control() : <span className="be-texto">{detectarPlataforma() === 'android' ? 'Android' : 'Web'}</span>}</div>
    </footer>
  );
}
