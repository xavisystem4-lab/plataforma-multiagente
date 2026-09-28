import { MAX_PARTICIPANTES, MAX_RONDAS_REVISION, NOMBRE_ROL, type ModoTarea, type ProyectoPublico, type TareaPublica } from '@softgala/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { mensajeError, useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';
import { Alerta, BotonCarga, Campo, Modal } from './Comunes';
import { IconoPlay } from './Iconos';

/**
 * Diálogo de "Continuar proyecto": reanuda la tarea pausada del proyecto o inicia una nueva,
 * con un agente o con un equipo. La ejecución ocurre en el servidor; esta app solo la controla.
 */
export function ContinuarProyecto({
  proyectoInicial,
  alCerrar,
  alIniciar,
}: {
  proyectoInicial?: string;
  alCerrar(): void;
  alIniciar(t: TareaPublica): void;
}) {
  const { api } = useSesion();
  const { datos: proyectos, error } = useDatos(useCallback(() => api.proyectos(), [api]));
  const [proyectoId, setProyectoId] = useState(proyectoInicial ?? '');
  const [pendiente, setPendiente] = useState<TareaPublica | null>(null);
  const [objetivo, setObjetivo] = useState('');
  const [modo, setModo] = useState<ModoTarea>('individual');
  const [agenteId, setAgenteId] = useState('');
  const [coordinadorId, setCoordinadorId] = useState('');
  const [participantes, setParticipantes] = useState<string[]>([]);
  const [maxRondas, setMaxRondas] = useState(1);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);

  useEffect(() => {
    if (!proyectoId && proyectos?.[0]) setProyectoId(proyectos[0].id);
  }, [proyectos, proyectoId]);

  const proyecto: ProyectoPublico | undefined = proyectos?.find((p) => p.id === proyectoId);
  const agentes = proyecto?.agentes.filter((a) => a.activo) ?? [];

  // Al cambiar de proyecto: busca tarea pendiente y propone un equipo por defecto.
  useEffect(() => {
    setPendiente(null);
    if (!proyectoId) return;
    let vigente = true;
    api
      .tareas(proyectoId)
      .then((ts) => vigente && setPendiente(ts.find((t) => ['pausada', 'esperando_usuario', 'ejecutando', 'en_cola'].includes(t.estado)) ?? null))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [api, proyectoId]);

  useEffect(() => {
    const coord = agentes.find((a) => a.rol === 'coordinador') ?? agentes[0];
    setCoordinadorId(coord?.agenteId ?? '');
    setParticipantes(agentes.filter((a) => a.agenteId !== coord?.agenteId).slice(0, MAX_PARTICIPANTES).map((a) => a.agenteId));
    // Solo al cambiar de proyecto o de agentes disponibles (no en cada render).
  }, [proyecto?.id, agentes.length]);

  const cambiarCoordinador = (id: string) => {
    setCoordinadorId(id);
    setParticipantes((p) => p.filter((x) => x !== id));
  };
  const alternarParticipante = (id: string) =>
    setParticipantes((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_PARTICIPANTES ? [...p, id] : p));

  async function iniciar(e?: FormEvent, reanudar = false) {
    e?.preventDefault();
    setEnviando(true);
    setErrorEnvio(null);
    try {
      const t = await api.continuar(
        proyectoId,
        reanudar
          ? {}
          : modo === 'colaborativo'
            ? { objetivo, modo, coordinadorId, participantes, maxRondas }
            : { objetivo, modo, ...(agenteId ? { agenteId } : {}) },
      );
      alIniciar(t);
    } catch (err) {
      setErrorEnvio(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  }

  const ocupado = pendiente && (pendiente.estado === 'ejecutando' || pendiente.estado === 'en_cola');
  const equipoValido = modo === 'individual' || (!!coordinadorId && participantes.length > 0);
  const puedeIniciar = !!proyectoId && objetivo.trim().length >= 3 && agentes.length > 0 && !ocupado && equipoValido;

  return (
    <Modal
      ancho={modo === 'colaborativo'}
      titulo="Continuar proyecto"
      descripcion="El trabajo se ejecuta en el servidor: puedes cerrar la laptop o esta app y seguirá avanzando."
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" type="button" onClick={alCerrar}>
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-continuar" cargando={enviando} disabled={!puedeIniciar}>
            <IconoPlay /> {modo === 'colaborativo' ? 'Iniciar con el equipo' : 'Iniciar tarea nueva'}
          </BotonCarga>
        </>
      }
    >
      {error && <Alerta>{error}</Alerta>}
      {errorEnvio && <Alerta>{errorEnvio}</Alerta>}
      {proyectos?.length === 0 && <Alerta tipo="aviso">Primero conecta un proyecto en la sección Proyectos.</Alerta>}

      <form id="form-continuar" onSubmit={(e) => void iniciar(e)} style={{ display: 'contents' }}>
        <Campo etiqueta="Proyecto" htmlFor="c-proyecto">
          <select id="c-proyecto" className="entrada" value={proyectoId} onChange={(e) => setProyectoId(e.target.value)}>
            {proyectos?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre} · {p.repositorio}
              </option>
            ))}
          </select>
        </Campo>

        {pendiente && (
          <div className="tarjeta" style={{ background: 'var(--marino-50)', borderColor: 'var(--marino-100)', padding: 14 }}>
            <strong style={{ display: 'block', marginBottom: 4 }}>
              {ocupado ? 'Hay una tarea en ejecución' : pendiente.estado === 'esperando_usuario' ? 'Una tarea espera tu respuesta' : 'Hay una tarea pausada'}
            </strong>
            <p style={{ margin: '0 0 10px', color: 'var(--texto-suave)', fontSize: 13 }}>{pendiente.objetivo}</p>
            {pendiente.estado === 'pausada' ? (
              <BotonCarga className="boton boton-primario boton-chico" type="button" cargando={enviando} onClick={() => void iniciar(undefined, true)}>
                <IconoPlay /> Reanudar esta tarea
              </BotonCarga>
            ) : (
              <button className="boton boton-chico" type="button" onClick={() => alIniciar(pendiente)}>
                Ver tarea
              </button>
            )}
          </div>
        )}

        {proyecto && agentes.length === 0 && (
          <Alerta tipo="aviso">Este proyecto no tiene agentes activos habilitados. Habilítalos en el detalle del proyecto.</Alerta>
        )}

        <Campo etiqueta={pendiente ? 'O empieza una tarea nueva' : 'Objetivo'} htmlFor="c-objetivo" ayuda="Describe qué se debe lograr. Sé concreto.">
          <textarea
            id="c-objetivo"
            className="entrada"
            value={objetivo}
            onChange={(e) => setObjetivo(e.target.value)}
            placeholder="Ej.: Agrega validación de correo al formulario de registro y sus pruebas."
            disabled={!!ocupado}
          />
        </Campo>

        <div className="selector-modo" role="radiogroup" aria-label="Modo de trabajo">
          <button type="button" role="radio" aria-checked={modo === 'individual'} className={modo === 'individual' ? 'activo' : ''} onClick={() => setModo('individual')}>
            <strong>Un agente</strong>
            <span>Rápido y económico para tareas acotadas.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={modo === 'colaborativo'}
            className={modo === 'colaborativo' ? 'activo' : ''}
            onClick={() => setModo('colaborativo')}
            disabled={agentes.length < 2}
            title={agentes.length < 2 ? 'Habilita al menos dos agentes en el proyecto' : undefined}
          >
            <strong>Equipo de agentes</strong>
            <span>Proponen, se revisan y un coordinador reparte el trabajo en paralelo.</span>
          </button>
        </div>

        {modo === 'individual' && agentes.length > 1 && (
          <Campo etiqueta="Agente" htmlFor="c-agente" ayuda="Por defecto, el primer desarrollador habilitado.">
            <select id="c-agente" className="entrada" value={agenteId} onChange={(e) => setAgenteId(e.target.value)}>
              <option value="">Automático</option>
              {agentes.map((a) => (
                <option key={a.agenteId} value={a.agenteId}>
                  {a.nombre} · {NOMBRE_ROL[a.rol]}
                </option>
              ))}
            </select>
          </Campo>
        )}

        {modo === 'colaborativo' && (
          <>
            <div className="fila-campos">
              <Campo etiqueta="Coordinador" htmlFor="c-coord" ayuda="Sintetiza las propuestas, resuelve desacuerdos y asigna subtareas.">
                <select id="c-coord" className="entrada" value={coordinadorId} onChange={(e) => cambiarCoordinador(e.target.value)}>
                  {agentes.map((a) => (
                    <option key={a.agenteId} value={a.agenteId}>
                      {a.nombre} · {NOMBRE_ROL[a.rol]}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo etiqueta="Rondas de revisión" htmlFor="c-rondas" ayuda="Se detiene antes si todos están de acuerdo.">
                <select id="c-rondas" className="entrada" value={maxRondas} onChange={(e) => setMaxRondas(Number(e.target.value))}>
                  {Array.from({ length: MAX_RONDAS_REVISION + 1 }, (_, i) => (
                    <option key={i} value={i}>
                      {i === 0 ? 'Sin revisión cruzada' : `Hasta ${i} ronda${i > 1 ? 's' : ''}`}
                    </option>
                  ))}
                </select>
              </Campo>
            </div>
            <div className="campo">
              <label>Participantes (máx. {MAX_PARTICIPANTES})</label>
              <div className="opciones opciones-columnas">
                {agentes
                  .filter((a) => a.agenteId !== coordinadorId)
                  .map((a) => {
                    const marcado = participantes.includes(a.agenteId);
                    return (
                      <label key={a.agenteId} className={`opcion${marcado ? ' marcada' : ''}`}>
                        <input type="checkbox" checked={marcado} onChange={() => alternarParticipante(a.agenteId)} />
                        <div>
                          <strong>{a.nombre}</strong>
                          <span className="descripcion">{NOMBRE_ROL[a.rol]}</span>
                        </div>
                      </label>
                    );
                  })}
              </div>
              <span className="ayuda">Cada participante solo podrá escribir en los archivos que el coordinador le asigne.</span>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
