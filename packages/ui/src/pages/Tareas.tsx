import { NOMBRE_ESTADO, NOMBRE_FASE, type DecisionPublica, type DiffTarea, type EstadoTarea, type EventoTiempoReal, type FaseColaboracion, type ResultadoValidacion, type TareaPublica } from '@softgala/shared';
import { FasesEquipo, PlanCoordinador, RegistroDecisiones } from '../components/Equipo';
import { PanelRevision } from '../components/Revision';
import { VisorDiff } from '../components/VisorDiff';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BarraAvance } from '../components/BarraAvance';
import { Alerta, BotonCarga, Encabezado, fecha, Vacio } from '../components/Comunes';
import { ContinuarProyecto } from '../components/ContinuarProyecto';
import { IconoPlay, IconoTareas } from '../components/Iconos';
import { mensajeError, useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';
import { useEventos, useTiempoReal } from '../lib/tiempoReal';
import '../styles/tareas.css';

const CLASE_ESTADO: Record<EstadoTarea, string> = {
  en_cola: 'etiqueta',
  ejecutando: 'etiqueta etiqueta-marino',
  pausada: 'etiqueta etiqueta-aviso',
  esperando_usuario: 'etiqueta etiqueta-aviso',
  completada: 'etiqueta etiqueta-exito',
  fallida: 'etiqueta etiqueta-error',
  cancelada: 'etiqueta',
};

export const EtiquetaEstado = ({ estado }: { estado: EstadoTarea }) => (
  <span className={CLASE_ESTADO[estado]}>
    {estado === 'ejecutando' && <span className="punto-vivo" aria-hidden="true" />}
    {NOMBRE_ESTADO[estado]}
  </span>
);

export function Tareas({ abierta, alAbrir }: { abierta: string | null; alAbrir(id: string | null): void }) {
  const { api } = useSesion();
  const { datos, error, recargar } = useDatos(useCallback(() => api.tareas(), [api]));
  const { datos: sistema } = useDatos(useCallback(() => api.sistema(), [api]));
  const [continuando, setContinuando] = useState(false);

  // La lista se actualiza sola con los cambios de estado.
  useEventos((e) => {
    if (e.tipo.startsWith('task.')) void recargar();
  });

  if (abierta) return <DetalleTarea id={abierta} alVolver={() => alAbrir(null)} />;

  return (
    <>
      <Encabezado titulo="Tareas" texto="Trabajo de los agentes en el servidor. Se actualiza en tiempo real.">
        <button className="boton boton-primario" onClick={() => setContinuando(true)}>
          <IconoPlay /> Continuar proyecto
        </button>
      </Encabezado>
      {sistema && !sistema.sandbox.disponible && (
        <div style={{ marginBottom: 16 }}>
          <Alerta tipo="aviso">
            {sistema.sandbox.motivo} Los agentes pueden leer y editar código, pero las validaciones (tests, lint, build) se reportarán
            como <strong>no ejecutadas</strong> hasta instalar Docker en el servidor.
          </Alerta>
        </div>
      )}
      {error && <Alerta>{error}</Alerta>}

      {datos?.length === 0 && (
        <Vacio
          icono={<IconoTareas />}
          titulo="Aún no hay tareas"
          texto="Pulsa «Continuar proyecto», elige un proyecto y describe el objetivo. El agente trabajará en una rama nueva."
          accion={
            <button className="boton boton-primario" onClick={() => setContinuando(true)}>
              Continuar proyecto
            </button>
          }
        />
      )}

      {datos && datos.length > 0 && (
        <section className="tarjeta" style={{ padding: 0 }}>
          <div className="tabla-contenedor">
            <table className="tabla tabla-clic tabla-tarjetas">
              <thead>
                <tr>
                  <th>Objetivo</th>
                  <th>Proyecto</th>
                  <th>Agente</th>
                  <th>Estado</th>
                  <th>Creada</th>
                </tr>
              </thead>
              <tbody>
                {datos.map((t) => (
                  <tr key={t.id} onClick={() => alAbrir(t.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && alAbrir(t.id)}>
                    <td className="celda-objetivo" data-etiqueta="Objetivo">
                      {t.modo === 'colaborativo' && <span className="etiqueta etiqueta-marino" style={{ marginRight: 6 }}>Equipo</span>}
                      {t.objetivo}
                    </td>
                    <td data-etiqueta="Proyecto">{t.proyectoNombre}</td>
                    <td data-etiqueta="Agente">{t.agenteNombre}</td>
                    <td data-etiqueta="Estado">
                      <EtiquetaEstado estado={t.estado} />
                      {t.estado !== 'completada' && t.avance.porcentaje > 0 && (
                        <span className="porcentaje-fila" title={t.avance.etapa}>
                          {t.avance.estimado ? '≈' : ''}
                          {t.avance.porcentaje} %
                        </span>
                      )}
                    </td>
                    <td data-etiqueta="Creada" style={{ whiteSpace: 'nowrap' }}>{fecha(t.creadaEn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {continuando && (
        <ContinuarProyecto
          alCerrar={() => setContinuando(false)}
          alIniciar={(t) => {
            setContinuando(false);
            alAbrir(t.id);
          }}
        />
      )}
    </>
  );
}

function DetalleTarea({ id, alVolver }: { id: string; alVolver(): void }) {
  const { api } = useSesion();
  const { conectado } = useTiempoReal();
  const [tarea, setTarea] = useState<TareaPublica | null>(null);
  const [eventos, setEventos] = useState<EventoTiempoReal[]>([]);
  const [decisiones, setDecisiones] = useState<DecisionPublica[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [accion, setAccion] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [t, ev, dec] = await Promise.all([api.tarea(id), api.eventosTarea(id), api.decisiones(id)]);
      setTarea(t);
      setEventos(ev);
      setDecisiones(dec);
      setError(null);
    } catch (err) {
      setError(mensajeError(err));
    }
  }, [api, id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Eventos en vivo de esta tarea; los cambios de estado recargan los datos completos.
  useEventos((e) => {
    if (e.tareaId !== id) return;
    setEventos((act) => (act.some((x) => x.seq === e.seq) ? act : [...act, e]));
    const cambiaTarea = e.tipo.startsWith('task.') || e.tipo.startsWith('approval.') || ['validation.result', 'file.changed', 'coordinator.decision'].includes(e.tipo);
    const cambiaEquipo = ['agent.proposal', 'agent.review', 'coordinator.decision'].includes(e.tipo) || (e.tipo === 'agent.step' && 'subtarea' in (e.datos as object));
    if (cambiaTarea || cambiaEquipo) void api.tarea(id).then(setTarea).catch(() => {});
    if (cambiaEquipo) void api.decisiones(id).then(setDecisiones).catch(() => {});
  });

  // Al reconectar, recupera lo que haya cambiado mientras no había conexión.
  useEffect(() => {
    if (conectado) void cargar();
  }, [conectado, cargar]);

  async function ejecutar(nombre: 'pausar' | 'reanudar' | 'cancelar') {
    if (nombre === 'cancelar' && !window.confirm('¿Cancelar la tarea? Los cambios ya hechos quedan en su rama.')) return;
    setAccion(nombre);
    try {
      setTarea(await api.accionTarea(id, nombre));
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setAccion(null);
    }
  }

  if (!tarea) {
    return (
      <>
        <button className="boton boton-texto volver" onClick={alVolver}>
          ← Tareas
        </button>
        {error ? <Alerta>{error}</Alerta> : <p>Cargando…</p>}
      </>
    );
  }

  const activa = tarea.estado === 'ejecutando' || tarea.estado === 'en_cola';
  const equipo = tarea.colaboracion;
  // Nombres para identificar en la actividad qué agente hizo cada cosa.
  const nombres = new Map<string, string>([[tarea.agenteId, tarea.agenteNombre], ...(equipo?.participantes.map((p) => [p.id, p.nombre] as [string, string]) ?? [])]);

  return (
    <>
      <button className="boton boton-texto volver" onClick={alVolver}>
        ← Tareas
      </button>
      <div className="encabezado">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <EtiquetaEstado estado={tarea.estado} />
            <span className={`etiqueta ${conectado ? 'etiqueta-exito' : ''}`} title="Conexión en tiempo real">
              {conectado ? 'En vivo' : 'Sin conexión en vivo'}
            </span>
          </div>
          <h1 className="titulo-tarea">{tarea.objetivo}</h1>
          <p>
            {tarea.proyectoNombre} ·{' '}
            {equipo ? `Equipo: ${tarea.agenteNombre} (coordinador), ${equipo.participantes.map((p) => p.nombre).join(', ')}` : tarea.agenteNombre} · rama{' '}
            <span className="mono">{tarea.rama}</span>
          </p>
          <div className="avance-tarea">
            <BarraAvance avance={tarea.avance} activa={tarea.estado === 'ejecutando'} grande />
          </div>
        </div>
        <div className="acciones">
          {activa && (
            <BotonCarga className="boton" cargando={accion === 'pausar'} onClick={() => void ejecutar('pausar')}>
              Pausar
            </BotonCarga>
          )}
          {tarea.estado === 'pausada' && (
            <BotonCarga cargando={accion === 'reanudar'} onClick={() => void ejecutar('reanudar')}>
              <IconoPlay /> Reanudar
            </BotonCarga>
          )}
          {(activa || tarea.estado === 'pausada' || tarea.estado === 'esperando_usuario') && (
            <BotonCarga className="boton boton-peligro" cargando={accion === 'cancelar'} onClick={() => void ejecutar('cancelar')}>
              Cancelar
            </BotonCarga>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        {error && <Alerta>{error}</Alerta>}
        {tarea.error && <Alerta tipo={tarea.estado === 'fallida' ? 'error' : 'aviso'}>{tarea.error}</Alerta>}
        {tarea.estado === 'esperando_usuario' && tarea.pregunta && <Pregunta tarea={tarea} alResponder={setTarea} />}
      </div>

      {equipo && <FasesEquipo colaboracion={equipo} estado={tarea.estado} />}
      {tarea.publicacion && (
        <div style={{ marginBottom: 16 }}>
          <PanelRevision tarea={tarea} alCambiar={() => void cargar()} />
        </div>
      )}

      <div className="detalle-tarea">
        <div style={{ display: 'grid', gap: 16, alignContent: 'start', minWidth: 0 }}>
          {equipo && <PlanCoordinador colaboracion={equipo} />}
          <section className="tarjeta">
            <h2 style={{ marginBottom: 12 }}>Actividad</h2>
            <LineaTiempo eventos={eventos} nombres={nombres} equipo={!!equipo} />
          </section>
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          {equipo && <RegistroDecisiones decisiones={decisiones} />}
          {tarea.resumen && (
            <section className="tarjeta">
              <h2>{equipo ? 'Resumen del equipo' : 'Resumen del agente'}</h2>
              <p className="texto-agente">{tarea.resumen}</p>
            </section>
          )}
          <section className="tarjeta">
            <h2>Validaciones</h2>
            <Validaciones lista={tarea.validaciones} />
          </section>
          <section className="tarjeta">
            <h2>Archivos modificados</h2>
            {tarea.archivosModificados.length ? (
              <ul className="lista-archivos">
                {tarea.archivosModificados.map((a) => (
                  <li key={a} className="mono">
                    {a}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Ninguno todavía.</p>
            )}
          </section>
          <section className="tarjeta">
            <h2>Consumo</h2>
            <dl className="datos-lista" style={{ marginTop: 8 }}>
              <dt>Tokens</dt>
              <dd>
                {tarea.uso.tokensEntrada.toLocaleString('es-MX')} entrada · {tarea.uso.tokensSalida.toLocaleString('es-MX')} salida
              </dd>
              <dt>Costo</dt>
              <dd>{tarea.uso.costoUsd === null ? 'No estimable para este modelo' : `≈ ${tarea.uso.costoUsd.toFixed(4)} USD (estimado)`}</dd>
              <dt>Creada</dt>
              <dd>{fecha(tarea.creadaEn)}</dd>
              {tarea.terminadaEn && (
                <>
                  <dt>Terminada</dt>
                  <dd>{fecha(tarea.terminadaEn)}</dd>
                </>
              )}
            </dl>
          </section>
        </div>
      </div>

      {(tarea.estado === 'completada' || tarea.archivosModificados.length > 0) && <Cambios tareaId={tarea.id} version={tarea.publicacion?.estado ?? ''} />}
    </>
  );
}

/** Diff de la tarea respecto a la rama base. */
function Cambios({ tareaId, version }: { tareaId: string; version: string }) {
  const { api } = useSesion();
  const [diff, setDiff] = useState<DiffTarea | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      setDiff(await api.diffTarea(tareaId));
      setError(null);
    } catch (err) {
      setDiff(null);
      setError(mensajeError(err));
    } finally {
      setCargando(false);
    }
  }, [api, tareaId]);

  // Se recarga al cambiar el estado de publicación (p. ej. al descartar).
  useEffect(() => {
    void cargar();
  }, [cargar, version]);

  return (
    <section className="tarjeta" style={{ marginTop: 16 }}>
      <div className="seccion-titulo">
        <h2>Cambios</h2>
        <BotonCarga className="boton boton-chico" cargando={cargando} onClick={() => void cargar()}>
          Actualizar
        </BotonCarga>
      </div>
      {error && <Alerta tipo="aviso">{error}</Alerta>}
      {diff && <VisorDiff diff={diff} />}
    </section>
  );
}

function Pregunta({ tarea, alResponder }: { tarea: TareaPublica; alResponder(t: TareaPublica): void }) {
  const { api } = useSesion();
  const [respuesta, setRespuesta] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try {
      alResponder(await api.responder(tarea.id, respuesta));
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="tarjeta pregunta" onSubmit={enviar}>
      <strong>El agente necesita tu intervención</strong>
      <p className="texto-agente">{tarea.pregunta}</p>
      {error && <Alerta>{error}</Alerta>}
      <textarea className="entrada" value={respuesta} onChange={(e) => setRespuesta(e.target.value)} placeholder="Escribe tu respuesta o decisión…" aria-label="Respuesta" />
      <div>
        <BotonCarga type="submit" cargando={enviando} disabled={!respuesta.trim()}>
          Responder y continuar
        </BotonCarga>
      </div>
    </form>
  );
}

function Validaciones({ lista }: { lista: ResultadoValidacion[] }) {
  if (!lista.length) return <p>Aún no se han ejecutado.</p>;
  const clase = { exitosa: 'etiqueta-exito', fallida: 'etiqueta-error', no_ejecutada: 'etiqueta-aviso' };
  const texto = { exitosa: 'Exitosa', fallida: 'Fallida', no_ejecutada: 'No ejecutada' };
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
      {lista.map((v) => (
        <details key={v.nombre} className="validacion">
          <summary>
            <span className={`etiqueta ${clase[v.estado]}`}>{texto[v.estado]}</span> <strong>{v.nombre}</strong>{' '}
            <span className="mono" style={{ color: 'var(--texto-suave)' }}>
              {v.comando}
            </span>
          </summary>
          <pre className="salida">{v.salida || '(sin salida)'}</pre>
        </details>
      ))}
    </div>
  );
}

const ETIQUETAS: Partial<Record<EventoTiempoReal['tipo'], string>> = {
  'task.created': 'Tarea creada',
  'agent.step': 'Paso',
  'task.started': 'Inició la ejecución',
  'task.resumed': 'Se reanudó',
  'task.paused': 'Pausada',
  'task.waiting': 'Pregunta al usuario',
  'task.completed': 'Tarea completada',
  'task.failed': 'Tarea fallida',
  'task.cancelled': 'Tarea cancelada',
  'tool.call': 'Herramienta',
  'file.changed': 'Archivo modificado',
  'validation.result': 'Validación',
  'budget.warning': 'Aviso de consumo',
  'approval.requested': 'Aprobación solicitada',
  'approval.resolved': 'Aprobación resuelta',
  'task.reverted': 'Cambios revertidos',
  'agent.proposal': 'Propuesta',
  'agent.review': 'Revisión',
  'coordinator.decision': 'Decisión del coordinador',
};

function LineaTiempo({ eventos, nombres, equipo }: { eventos: EventoTiempoReal[]; nombres: Map<string, string>; equipo: boolean }) {
  // En equipo, cada evento dice qué agente lo hizo.
  const quien = (e: EventoTiempoReal) => (equipo && e.agenteId ? `${nombres.get(e.agenteId) ?? 'Agente'}: ` : '');
  // Desplaza solo la lista (no la página) para mostrar lo más reciente.
  const lista = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (lista.current) lista.current.scrollTop = lista.current.scrollHeight;
  }, [eventos.length]);
  // Los resultados se muestran junto a su llamada; los pasos de estado internos se omiten.
  const visibles = eventos.filter((e) => e.tipo !== 'tool.result' && !(e.tipo === 'agent.step' && !(e.datos as { mensaje?: string }).mensaje));

  if (!visibles.length) return <p>Esperando actividad…</p>;
  return (
    <ol className="linea-tiempo" ref={lista}>
      {visibles.map((e) => {
        const d = e.datos as Record<string, unknown>;
        const resultado =
          e.tipo === 'tool.call'
            ? (eventos.find((x) => x.tipo === 'tool.result' && x.seq > e.seq && (x.datos as { herramienta: string }).herramienta === d.herramienta)?.datos as
                | { error: boolean; resumen: string }
                | undefined)
            : undefined;
        return (
          <li key={e.seq} className={`evento evento-${e.tipo.replace('.', '-')}${resultado?.error ? ' con-error' : ''}`}>
            <span className="hora">{new Date(e.fecha).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
            <div className="cuerpo-evento">
              {e.tipo === 'agent.message' ? (
                <>
                  <strong>{d.autor === 'usuario' ? 'Tú' : equipo && e.agenteId ? (nombres.get(e.agenteId) ?? 'Agente') : 'Agente'}</strong>
                  <p className="texto-agente">{String(d.texto)}</p>
                </>
              ) : e.tipo === 'agent.proposal' ? (
                <>
                  <strong>Propuesta de {String(d.agente)}</strong>
                  <p className="texto-agente">{String(d.propuesta)}</p>
                </>
              ) : e.tipo === 'agent.review' ? (
                <>
                  <strong>
                    Revisión de {String(d.agente)} (ronda {String(d.ronda)}): {d.de_acuerdo ? 'de acuerdo' : 'con objeciones'}
                  </strong>
                  <p className="texto-agente">{String(d.revision)}</p>
                </>
              ) : e.tipo === 'coordinator.decision' ? (
                <>
                  <strong>Decisión del coordinador</strong>
                  <p className="texto-agente">{String(d.decision)}</p>
                  <span>{(d.subtareas as unknown[] | undefined)?.length ?? 0} subtarea(s) asignada(s).</span>
                </>
              ) : e.tipo === 'agent.step' && typeof d.fase === 'string' ? (
                <strong>Fase: {NOMBRE_FASE[d.fase as FaseColaboracion] ?? d.fase}</strong>
              ) : e.tipo === 'tool.call' ? (
                <>
                  <strong className="mono">
                    {quien(e)}
                    {String(d.herramienta)}
                  </strong>{' '}
                  <span className="mono args">{resumenArgs(d.entrada)}</span>
                  {resultado && <div className={`resultado ${resultado.error ? 'error' : ''}`}>{resultado.resumen.split('\n')[0]}</div>}
                </>
              ) : e.tipo === 'validation.result' ? (
                <>
                  <strong>Validación «{String(d.nombre)}»:</strong> {String(d.estado).replace('_', ' ')}
                </>
              ) : e.tipo === 'file.changed' ? (
                <>
                  <strong>{quien(e)}Archivo modificado:</strong> <span className="mono">{String(d.ruta)}</span>
                </>
              ) : (
                <>
                  <strong>{ETIQUETAS[e.tipo] ?? e.tipo}</strong>
                  {typeof d.mensaje === 'string' && <span> — {d.mensaje}</span>}
                  {typeof d.pregunta === 'string' && <p className="texto-agente">{d.pregunta}</p>}
                  {typeof d.error === 'string' && <span className="texto-error"> — {d.error}</span>}
                  {typeof d.motivo === 'string' && <span> — {d.motivo}</span>}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function resumenArgs(entrada: unknown): string {
  if (!entrada || typeof entrada !== 'object') return '';
  const e = entrada as Record<string, unknown>;
  return String(e.ruta ?? e.texto ?? e.nombre ?? e.mensaje ?? '');
}
