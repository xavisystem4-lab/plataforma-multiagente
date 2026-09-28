import {
  FASES_COLABORACION,
  NOMBRE_FASE,
  type ColaboracionPublica,
  type DecisionPublica,
  type EstadoSubtarea,
  type EstadoTarea,
} from '@softgala/shared';

/** Avance por fases del trabajo en equipo. */
export function FasesEquipo({ colaboracion, estado }: { colaboracion: ColaboracionPublica; estado: EstadoTarea }) {
  const actual = colaboracion.fase ? FASES_COLABORACION.indexOf(colaboracion.fase) : -1;
  const terminada = estado === 'completada';
  const fases = FASES_COLABORACION.filter((f) => f !== 'revision' || (colaboracion.maxRondas > 0 && colaboracion.participantes.length > 1));
  return (
    <ol className="fases-equipo" aria-label="Fases del trabajo en equipo">
      {fases.map((f) => {
        const i = FASES_COLABORACION.indexOf(f);
        const clase = terminada || i < actual ? 'hecha' : i === actual ? 'actual' : '';
        return (
          <li key={f} className={`fase-equipo ${clase}`} aria-current={clase === 'actual' ? 'step' : undefined}>
            {NOMBRE_FASE[f]}
          </li>
        );
      })}
    </ol>
  );
}

const CLASE_SUB: Record<EstadoSubtarea, string> = {
  pendiente: 'etiqueta',
  ejecutando: 'etiqueta etiqueta-marino',
  esperando_usuario: 'etiqueta etiqueta-aviso',
  completada: 'etiqueta etiqueta-exito',
  fallida: 'etiqueta etiqueta-error',
  conflicto: 'etiqueta etiqueta-error',
};
const TEXTO_SUB: Record<EstadoSubtarea, string> = {
  pendiente: 'Pendiente',
  ejecutando: 'Ejecutando',
  esperando_usuario: 'Espera respuesta',
  completada: 'Completada',
  fallida: 'Fallida',
  conflicto: 'Conflicto',
};

/** Decisión del coordinador y reparto de subtareas (archivos asignados y dependencias). */
export function PlanCoordinador({ colaboracion }: { colaboracion: ColaboracionPublica }) {
  if (!colaboracion.decision) {
    return (
      <section className="tarjeta">
        <h2>Plan del coordinador</h2>
        <p>
          Aún no hay plan. Participan: {colaboracion.participantes.map((p) => p.nombre).join(', ')}
          {colaboracion.maxRondas > 0 ? ` · hasta ${colaboracion.maxRondas} ronda(s) de revisión` : ' · sin revisión cruzada'}.
        </p>
      </section>
    );
  }
  return (
    <section className="tarjeta">
      <h2>Plan del coordinador</h2>
      <p className="texto-agente">{colaboracion.decision}</p>
      <div className="subtareas">
        {colaboracion.subtareas.map((s) => (
          <div key={s.id} className="subtarea">
            <div className="cabecera-sub">
              <span className="num">#{s.indice}</span>
              <strong>{s.titulo}</strong>
              <span className="etiqueta etiqueta-marino">{s.agenteNombre}</span>
              <span className={CLASE_SUB[s.estado]}>{TEXTO_SUB[s.estado]}</span>
              {s.dependeDe.length > 0 && <span className="etiqueta">después de #{s.dependeDe.join(', #')}</span>}
            </div>
            <div className="chips" aria-label="Archivos asignados">
              {s.archivos.map((a) => (
                <span key={a} className="chip">
                  {a}
                </span>
              ))}
            </div>
            {s.error && <span className="texto-error" style={{ fontSize: 12.5 }}>{s.error}</span>}
            {s.resumen && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--texto-suave)' }}>Resumen del agente</summary>
                <p className="texto-agente">{s.resumen}</p>
              </details>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const TITULO_DECISION = { propuesta: 'Propuesta', revision: 'Revisión', decision: 'Decisión', integracion: 'Integración' } as const;

/** Registro de propuestas, revisiones y decisiones, con el agente responsable de cada una. */
export function RegistroDecisiones({ decisiones }: { decisiones: DecisionPublica[] }) {
  const visibles = decisiones.filter((d) => d.tipo !== 'integracion');
  return (
    <section className="tarjeta">
      <h2>Propuestas y revisiones</h2>
      {!visibles.length ? (
        <p>Los agentes aún no han entregado propuestas.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {visibles.map((d) => (
            <details key={d.id} className={`aporte tipo-${d.tipo}`}>
              <summary>
                <strong>{TITULO_DECISION[d.tipo]}</strong>
                <span>{d.agenteNombre ?? 'Sistema'}</span>
                {d.ronda > 0 && <span className="etiqueta">Ronda {d.ronda}</span>}
                {d.tipo === 'revision' && (
                  <span className={`etiqueta ${d.datos?.de_acuerdo ? 'etiqueta-exito' : 'etiqueta-aviso'}`}>
                    {d.datos?.de_acuerdo ? 'De acuerdo' : 'Con objeciones'}
                  </span>
                )}
              </summary>
              <p className="texto-agente">{d.contenido}</p>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
