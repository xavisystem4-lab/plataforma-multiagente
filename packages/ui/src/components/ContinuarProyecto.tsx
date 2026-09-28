import { NOMBRE_ROL, type ProyectoPublico, type TareaPublica } from '@softgala/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { mensajeError, useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';
import { Alerta, BotonCarga, Campo, Modal } from './Comunes';
import { IconoPlay } from './Iconos';

/**
 * Diálogo de "Continuar proyecto": reanuda la tarea pausada del proyecto o inicia una nueva.
 * La ejecución ocurre en el servidor; esta app (Windows o Android) solo la controla.
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
  const [agenteId, setAgenteId] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);

  useEffect(() => {
    if (!proyectoId && proyectos?.[0]) setProyectoId(proyectos[0].id);
  }, [proyectos, proyectoId]);

  // Busca si el proyecto tiene una tarea pausada o esperando respuesta.
  useEffect(() => {
    setPendiente(null);
    if (!proyectoId) return;
    let vigente = true;
    api
      .tareas(proyectoId)
      .then((ts) => vigente && setPendiente(ts.find((t) => t.estado === 'pausada' || t.estado === 'esperando_usuario' || t.estado === 'ejecutando' || t.estado === 'en_cola') ?? null))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [api, proyectoId]);

  const proyecto: ProyectoPublico | undefined = proyectos?.find((p) => p.id === proyectoId);
  const agentes = proyecto?.agentes.filter((a) => a.activo) ?? [];

  async function iniciar(e?: FormEvent, reanudar = false) {
    e?.preventDefault();
    setEnviando(true);
    setErrorEnvio(null);
    try {
      const t = await api.continuar(proyectoId, reanudar ? {} : { objetivo, ...(agenteId ? { agenteId } : {}) });
      alIniciar(t);
    } catch (err) {
      setErrorEnvio(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  }

  const ocupado = pendiente && (pendiente.estado === 'ejecutando' || pendiente.estado === 'en_cola');

  return (
    <Modal
      titulo="Continuar proyecto"
      descripcion="El trabajo se ejecuta en el servidor: puedes cerrar la laptop o esta app y seguirá avanzando."
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" type="button" onClick={alCerrar}>
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-continuar" cargando={enviando} disabled={!proyectoId || objetivo.trim().length < 3 || !agentes.length || !!ocupado}>
            <IconoPlay /> Iniciar tarea nueva
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

        <Campo etiqueta={pendiente ? 'O empieza una tarea nueva' : 'Objetivo'} htmlFor="c-objetivo" ayuda="Describe qué debe lograr el agente. Sé concreto.">
          <textarea
            id="c-objetivo"
            className="entrada"
            value={objetivo}
            onChange={(e) => setObjetivo(e.target.value)}
            placeholder="Ej.: Agrega validación de correo al formulario de registro y sus pruebas."
            disabled={!!ocupado}
          />
        </Campo>
        {agentes.length > 1 && (
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
      </form>
    </Modal>
  );
}
