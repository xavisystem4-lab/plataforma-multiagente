import { NOMBRE_ESTADO, type ColorProyecto, type EventoTiempoReal, type ProyectoPublico, type TareaPublica } from '@softgala/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BarraAvance } from '../components/BarraAvance';
import { Alerta, BotonCarga } from '../components/Comunes';
import { IconoPlay } from '../components/Iconos';
import { Logo } from '../components/Logo';
import { hexDe, SelectorColor } from '../components/SelectorColor';
import { SelectorTema } from '../components/SelectorTema';
import { mensajeError } from '../lib/datos';
import { ventanasEscritorio } from '../lib/plataforma';
import { useSesion } from '../lib/sesion';
import { avisarCambioProyectos } from '../lib/ventanas';
import { useEventos, useTiempoReal } from '../lib/tiempoReal';
import '../styles/ventanas.css';

/**
 * Ventana dedicada a un proyecto: progreso en vivo de su tarea más reciente, con barra de título del
 * color del proyecto, nombre de ventana editable y la opción "Siempre encima".
 * En Windows es una ventana propia; en Android se muestra como una vista.
 */
export function VentanaProyecto({ proyectoId, alVolver }: { proyectoId: string; alVolver?: () => void }) {
  const { api } = useSesion();
  const { conectado } = useTiempoReal();
  const ventanas = ventanasEscritorio();
  const esVentana = !!ventanas && !alVolver;
  const [proyecto, setProyecto] = useState<ProyectoPublico | null>(null);
  const [tarea, setTarea] = useState<TareaPublica | null>(null);
  const [eventos, setEventos] = useState<EventoTiempoReal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [encima, setEncima] = useState(false);
  const [editando, setEditando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [paleta, setPaleta] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const p = await api.proyecto(proyectoId);
      setProyecto(p);
      if (p.avance) {
        const [t, ev] = await Promise.all([api.tarea(p.avance.tareaId), api.eventosTarea(p.avance.tareaId)]);
        setTarea(t);
        setEventos(ev.slice(-40));
      }
      setError(null);
    } catch (err) {
      setError(mensajeError(err));
    }
  }, [api, proyectoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);
  useEffect(() => {
    if (conectado) void cargar();
  }, [conectado, cargar]);

  // Eventos en vivo del proyecto: la actividad se agrega y el avance se recalcula.
  const recarga = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEventos((e) => {
    if (e.proyectoId !== proyectoId) return;
    if (e.tareaId && e.tareaId === tarea?.id) setEventos((act) => [...act, e].slice(-40));
    clearTimeout(recarga.current);
    recarga.current = setTimeout(() => void cargar(), 400);
  });

  const titulo = proyecto ? (proyecto.nombreVentana ?? proyecto.nombre) : 'Proyecto';
  const color = proyecto ? hexDe(proyecto.color) : '#13294B';

  // La ventana nativa adopta el nombre y el color del proyecto.
  useEffect(() => {
    if (!esVentana || !proyecto) return;
    document.title = titulo;
    void ventanas!.configurar({ titulo, color }).then((r) => r && setEncima(r.encima));
  }, [esVentana, ventanas, proyecto, titulo, color]);

  async function guardar(cambios: { nombreVentana?: string | null; color?: ColorProyecto; fijado?: boolean }) {
    try {
      setProyecto(await api.editarProyecto(proyectoId, cambios));
      avisarCambioProyectos();
    } catch (err) {
      setError(mensajeError(err));
    }
  }

  async function renombrar(e: FormEvent) {
    e.preventDefault();
    const limpio = nombre.trim();
    await guardar({ nombreVentana: limpio && limpio !== proyecto?.nombre ? limpio : null });
    setEditando(false);
  }

  async function alternarEncima() {
    const r = await ventanas?.configurar({ encima: !encima });
    if (r) setEncima(r.encima);
  }

  async function accion(nombreAccion: 'pausar' | 'reanudar') {
    if (!tarea) return;
    try {
      setTarea(await api.accionTarea(tarea.id, nombreAccion));
    } catch (err) {
      setError(mensajeError(err));
    }
  }

  const activa = tarea?.estado === 'ejecutando' || tarea?.estado === 'en_cola';

  return (
    <div className={`ventana-proyecto${esVentana ? ' nativa' : ''}`} style={{ ['--color-proyecto' as string]: color }}>
      <header className="vp-barra">
        <Logo tamano={18} claro />
        {editando ? (
          <form className="vp-renombrar" onSubmit={renombrar}>
            <input
              className="entrada"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              maxLength={60}
              autoFocus
              aria-label="Nombre de la ventana"
              onKeyDown={(e) => e.key === 'Escape' && setEditando(false)}
            />
            <button className="vp-boton" type="submit">
              Guardar
            </button>
          </form>
        ) : (
          <>
            <strong className="vp-titulo">{titulo}</strong>
            <button
              className="vp-icono"
              onClick={() => {
                setNombre(titulo);
                setEditando(true);
              }}
              aria-label="Renombrar ventana"
              title="Renombrar ventana"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
              </svg>
            </button>
          </>
        )}
      </header>

      <div className="vp-contenido">
        {alVolver && (
          <button className="boton boton-texto volver" onClick={alVolver}>
            ← Proyectos
          </button>
        )}
        {error && <Alerta>{error}</Alerta>}

        {proyecto && (
          <div className="vp-controles">
            <button
              className={`vp-chip${proyecto.fijado ? ' activo' : ''}`}
              onClick={() => void guardar({ fijado: !proyecto.fijado })}
              aria-pressed={proyecto.fijado}
              title="Mostrar este proyecto en el menú lateral"
            >
              <IconoPin /> {proyecto.fijado ? 'Fijado en el menú' : 'Fijar en el menú'}
            </button>
            {esVentana && (
              <button className={`vp-chip${encima ? ' activo' : ''}`} onClick={() => void alternarEncima()} aria-pressed={encima} title="Mantener esta ventana sobre las demás">
                <IconoEncima /> {encima ? 'Siempre encima' : 'Poner siempre encima'}
              </button>
            )}
            <button className={`vp-chip${paleta ? ' activo' : ''}`} onClick={() => setPaleta((v) => !v)} aria-expanded={paleta}>
              <span className="vp-punto" /> Color
            </button>
            <span className={`etiqueta ${conectado ? 'etiqueta-exito' : ''}`}>{conectado ? 'En vivo' : 'Sin conexión en vivo'}</span>
            {esVentana && <SelectorTema compacto />}
          </div>
        )}
        {paleta && proyecto && (
          <SelectorColor
            valor={proyecto.color}
            alCambiar={(c) => {
              void guardar({ color: c });
            }}
          />
        )}

        {proyecto && !proyecto.avance && (
          <div className="tarjeta vp-vacio">
            <p>Este proyecto aún no tiene tareas. Inicia una con «Continuar proyecto» desde la ventana principal.</p>
          </div>
        )}

        {proyecto?.avance && (
          <section className="tarjeta vp-tarea">
            <div className="vp-tarea-cabecera">
              <span className="etiqueta">{NOMBRE_ESTADO[proyecto.avance.estado as keyof typeof NOMBRE_ESTADO] ?? proyecto.avance.estado}</span>
              <span className="vp-conteo">
                {proyecto.avance.tareasCompletadas} de {proyecto.avance.tareasTotales} tarea(s) completadas
              </span>
            </div>
            <h1 className="vp-objetivo">{proyecto.avance.objetivo}</h1>
            <BarraAvance avance={proyecto.avance} color={color} activa={activa} grande />
            {tarea?.pregunta && tarea.estado === 'esperando_usuario' && (
              <Alerta tipo="aviso">El agente espera tu respuesta: {tarea.pregunta}</Alerta>
            )}
            <div className="acciones">
              {activa && (
                <button className="boton boton-chico" onClick={() => void accion('pausar')}>
                  Pausar
                </button>
              )}
              {tarea?.estado === 'pausada' && (
                <BotonCarga className="boton boton-primario boton-chico" onClick={() => void accion('reanudar')}>
                  <IconoPlay /> Reanudar
                </BotonCarga>
              )}
            </div>
          </section>
        )}

        {eventos.length > 0 && (
          <section className="tarjeta vp-actividad">
            <h2>Actividad reciente</h2>
            <ol>
              {[...eventos]
                .reverse()
                .filter((e) => e.tipo !== 'tool.result')
                .slice(0, 15)
                .map((e) => (
                  <li key={e.seq}>
                    <span className="hora">{new Date(e.fecha).toLocaleTimeString('es-MX', { hour12: false })}</span>
                    <span>{describir(e)}</span>
                  </li>
                ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

const NOMBRE_EVENTO: Record<string, string> = {
  'task.created': 'Tarea creada',
  'task.started': 'Tarea iniciada',
  'task.paused': 'Tarea pausada',
  'task.resumed': 'Tarea reanudada',
  'task.waiting': 'El agente espera tu respuesta',
  'task.completed': 'Tarea completada',
  'task.failed': 'La tarea falló',
  'task.cancelled': 'Tarea cancelada',
  'task.reverted': 'Cambios revertidos',
  'approval.requested': 'Aprobación solicitada',
  'approval.resolved': 'Aprobación resuelta',
};

function describir(e: EventoTiempoReal): string {
  const d = e.datos as Record<string, unknown>;
  switch (e.tipo) {
    case 'agent.message':
      return `${d.autor === 'usuario' ? 'Tú' : 'Agente'}: ${String(d.texto).split('\n')[0]}`;
    case 'tool.call':
      return `Herramienta ${String(d.herramienta)}`;
    case 'file.changed':
      return `Archivo modificado: ${String(d.ruta)}`;
    case 'agent.proposal':
      return `Propuesta de ${String(d.agente)}`;
    case 'agent.review':
      return `Revisión de ${String(d.agente)}`;
    case 'coordinator.decision':
      return 'Decisión del coordinador';
    case 'validation.result':
      return `Validación «${String(d.nombre)}»: ${String(d.estado).replace('_', ' ')}`;
    default:
      return typeof d.mensaje === 'string' ? d.mensaje : (NOMBRE_EVENTO[e.tipo] ?? e.tipo.replace('.', ' '));
  }
}

export const IconoPin = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6" />
  </svg>
);
const IconoEncima = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="9" width="12" height="11" rx="2" />
    <rect x="9" y="4" width="12" height="11" rx="2" fill="currentColor" fillOpacity="0.15" />
  </svg>
);
