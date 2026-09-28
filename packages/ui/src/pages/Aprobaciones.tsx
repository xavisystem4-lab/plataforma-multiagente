import type { AprobacionPublica, EstadoAprobacion } from '@softgala/shared';
import { useCallback, useState } from 'react';
import { Alerta, Encabezado, fecha, Vacio } from '../components/Comunes';
import { IconoAprobar } from '../components/Iconos';
import { DialogoAprobar, DialogoRechazar } from '../components/Revision';
import { useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';
import { useEventos } from '../lib/tiempoReal';

const FILTROS: { valor: EstadoAprobacion; texto: string }[] = [
  { valor: 'pendiente', texto: 'Pendientes' },
  { valor: 'aprobada', texto: 'Aprobadas' },
  { valor: 'rechazada', texto: 'Rechazadas' },
];

export function Aprobaciones({ abrirTarea }: { abrirTarea(id: string): void }) {
  const { api } = useSesion();
  const [filtro, setFiltro] = useState<EstadoAprobacion>('pendiente');
  const { datos, error, recargar } = useDatos(useCallback(() => api.aprobaciones(filtro), [api, filtro]));
  const [dialogo, setDialogo] = useState<{ tipo: 'aprobar' | 'rechazar'; a: AprobacionPublica } | null>(null);

  useEventos((e) => {
    if (e.tipo.startsWith('approval.')) void recargar();
  });

  return (
    <>
      <Encabezado titulo="Aprobaciones" texto="Nada se publica en GitHub sin tu aprobación. Revisa los cambios de cada tarea antes de aprobar.">
        <div className="filtros" role="tablist">
          {FILTROS.map((f) => (
            <button key={f.valor} role="tab" aria-selected={filtro === f.valor} className={`boton boton-chico${filtro === f.valor ? ' boton-primario' : ''}`} onClick={() => setFiltro(f.valor)}>
              {f.texto}
            </button>
          ))}
        </div>
      </Encabezado>
      {error && <Alerta>{error}</Alerta>}

      {datos?.length === 0 && (
        <Vacio
          icono={<IconoAprobar />}
          titulo={filtro === 'pendiente' ? 'No hay aprobaciones pendientes' : 'Sin registros'}
          texto="Cuando un agente termine una tarea con cambios, aparecerá aquí para que la revises."
        />
      )}

      <div className="lista-tarjetas">
        {datos?.map((a) => (
          <article key={a.id} className="tarjeta tarjeta-recurso">
            <div className="cabecera">
              <div style={{ minWidth: 0 }}>
                <h3>{a.tareaObjetivo}</h3>
                <div className="sub">{a.proyectoNombre}</div>
              </div>
              <span className={`etiqueta ${a.estado === 'pendiente' ? 'etiqueta-aviso' : a.estado === 'aprobada' ? 'etiqueta-exito' : 'etiqueta-error'}`}>
                {FILTROS.find((f) => f.valor === a.estado)?.texto.replace(/s$/, '')}
              </span>
            </div>
            <dl className="datos-lista">
              <dt>Rama</dt>
              <dd className="mono">{a.rama}</dd>
              <dt>Archivos</dt>
              <dd>{a.archivos}</dd>
              <dt>Solicitada</dt>
              <dd>{fecha(a.creadaEn)}</dd>
              {a.resueltaEn && (
                <>
                  <dt>Resuelta</dt>
                  <dd>{fecha(a.resueltaEn)}</dd>
                </>
              )}
              {a.comentario && (
                <>
                  <dt>Comentario</dt>
                  <dd>{a.comentario}</dd>
                </>
              )}
            </dl>
            <div className="acciones">
              <button className="boton boton-chico" onClick={() => abrirTarea(a.tareaId)}>
                Revisar cambios
              </button>
              {a.estado === 'pendiente' && (
                <>
                  <button className="boton boton-chico boton-primario" onClick={() => setDialogo({ tipo: 'aprobar', a })}>
                    Aprobar
                  </button>
                  <button className="boton boton-chico boton-peligro" onClick={() => setDialogo({ tipo: 'rechazar', a })}>
                    Rechazar
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      {dialogo?.tipo === 'aprobar' && (
        <DialogoAprobar
          aprobacion={dialogo.a}
          alCerrar={() => setDialogo(null)}
          alResolver={() => {
            setDialogo(null);
            void recargar();
          }}
        />
      )}
      {dialogo?.tipo === 'rechazar' && (
        <DialogoRechazar
          aprobacionId={dialogo.a.id}
          alCerrar={() => setDialogo(null)}
          alResolver={() => {
            setDialogo(null);
            void recargar();
          }}
        />
      )}
    </>
  );
}
