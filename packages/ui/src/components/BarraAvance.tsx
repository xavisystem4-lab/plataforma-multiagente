import type { AvanceTarea } from '@softgala/shared';

/**
 * Barra de avance en porcentaje. Si la tarea está en marcha, la barra tiene un brillo animado.
 * Cuando el porcentaje es una estimación (modo individual), se indica con "≈" y en el texto de ayuda.
 */
export function BarraAvance({
  avance,
  color,
  activa = false,
  grande = false,
}: {
  avance: AvanceTarea;
  color?: string;
  activa?: boolean;
  grande?: boolean;
}) {
  const ayuda = avance.estimado
    ? 'Estimación: el trabajo total de un agente no se conoce de antemano; llega a 100 % al terminar.'
    : 'Avance real según las fases y subtareas completadas.';
  return (
    <div className={`barra-avance${grande ? ' grande' : ''}`} title={ayuda}>
      <div className="barra-avance-texto">
        <span>{avance.etapa}</span>
        <strong>
          {avance.estimado && avance.porcentaje < 100 ? '≈ ' : ''}
          {avance.porcentaje} %
        </strong>
      </div>
      <div
        className="barra-avance-pista"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={avance.porcentaje}
        aria-valuetext={`${avance.porcentaje} %, ${avance.etapa}${avance.estimado ? ' (estimado)' : ''}`}
      >
        <div
          className={`barra-avance-relleno${activa ? ' activa' : ''}`}
          style={{ width: `${avance.porcentaje}%`, ...(color ? { background: color } : {}) }}
        />
      </div>
    </div>
  );
}
