import {
  HERRAMIENTAS,
  LIMITES_AGENTE_PREDETERMINADOS,
  MODELOS_SUGERIDOS,
  NOMBRE_ROL,
  ROLES_AGENTE,
  type AgentePublico,
  type IdHerramienta,
  type LimitesAgente,
  type ProveedorPublico,
  type RolAgente,
} from '@softgala/shared';
import { useCallback, useState, type FormEvent } from 'react';
import { Alerta, BotonCarga, Campo, Encabezado, Interruptor, Modal, Vacio } from '../components/Comunes';
import { IconoAgentes } from '../components/Iconos';
import type { Pagina } from '../components/Shell';
import { mensajeError, useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';

const RIESGO: Record<string, string> = { bajo: 'etiqueta-exito', medio: 'etiqueta-aviso' };

/** Instrucciones de partida por rol; el usuario puede reescribirlas. */
const INSTRUCCIONES_ROL: Record<RolAgente, string> = {
  coordinador:
    'Divide el objetivo en tareas pequeñas, asigna cada una al agente adecuado, compara las propuestas y decide con argumentos. Evita que dos agentes modifiquen los mismos archivos a la vez.',
  desarrollador:
    'Implementa la tarea asignada con cambios pequeños y claros, siguiendo el estilo del proyecto. Explica cada decisión relevante.',
  revisor:
    'Revisa las propuestas y cambios de otros agentes: busca errores, riesgos de seguridad y casos no cubiertos. Sé concreto y propone correcciones.',
  tester: 'Escribe y ejecuta pruebas para la tarea. Informa solo resultados verificados.',
  documentador: 'Actualiza la documentación afectada por los cambios, en español claro.',
  personalizado: '',
};

export function Agentes({ irA }: { irA(p: Pagina): void }) {
  const { api } = useSesion();
  const cargar = useCallback(async () => {
    const [agentes, proveedores] = await Promise.all([api.agentes(), api.proveedores()]);
    return { agentes, proveedores };
  }, [api]);
  const { datos, error, recargar } = useDatos(cargar);
  const [editando, setEditando] = useState<AgentePublico | 'nuevo' | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  async function cambiarActivo(a: AgentePublico, activo: boolean) {
    try {
      await api.editarAgente(a.id, { activo });
      await recargar();
    } catch (err) {
      setErrorAccion(mensajeError(err));
    }
  }

  async function eliminar(a: AgentePublico) {
    const aviso = a.proyectos ? ` Está habilitado en ${a.proyectos} proyecto(s).` : '';
    if (!window.confirm(`¿Eliminar el agente "${a.nombre}"?${aviso}`)) return;
    try {
      await api.eliminarAgente(a.id);
      await recargar();
    } catch (err) {
      setErrorAccion(mensajeError(err));
    }
  }

  const sinProveedores = datos?.proveedores.length === 0;

  return (
    <>
      <Encabezado titulo="Agentes" texto="Define su rol, modelo, herramientas y límites. Luego habilítalos por proyecto.">
        <button className="boton boton-primario" onClick={() => setEditando('nuevo')} disabled={!datos || sinProveedores}>
          Nuevo agente
        </button>
      </Encabezado>

      {(error || errorAccion) && (
        <div style={{ marginBottom: 16 }}>
          <Alerta>{error ?? errorAccion}</Alerta>
        </div>
      )}

      {sinProveedores && (
        <Vacio
          icono={<IconoAgentes />}
          titulo="Primero agrega un proveedor de modelos"
          texto="Cada agente usa un modelo de un proveedor (Claude, OpenAI, Ollama…)."
          accion={
            <button className="boton boton-primario" onClick={() => irA('modelos')}>
              Ir a Modelos IA
            </button>
          }
        />
      )}
      {datos && !sinProveedores && datos.agentes.length === 0 && (
        <Vacio
          icono={<IconoAgentes />}
          titulo="Aún no hay agentes"
          texto="Crea un coordinador y uno o más agentes especialistas para que colaboren en tus proyectos."
          accion={
            <button className="boton boton-primario" onClick={() => setEditando('nuevo')}>
              Nuevo agente
            </button>
          }
        />
      )}

      {datos && datos.agentes.length > 0 && (
        <section className="tarjeta" style={{ padding: 0 }}>
          <div className="tabla-contenedor">
            <table className="tabla tabla-tarjetas">
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Modelo</th>
                  <th>Herramientas</th>
                  <th>Proyectos</th>
                  <th>Activo</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {datos.agentes.map((a) => (
                  <tr key={a.id}>
                    <td data-etiqueta="Agente">
                      <strong>{a.nombre}</strong>
                      <div className="sub" style={{ fontSize: 12, color: 'var(--texto-suave)' }}>
                        {NOMBRE_ROL[a.rol]}
                      </div>
                    </td>
                    <td data-etiqueta="Modelo">
                      <span className="mono">{a.modelo}</span>
                      <div style={{ fontSize: 12, color: 'var(--texto-suave)' }}>{a.proveedorNombre}</div>
                    </td>
                    <td data-etiqueta="Herramientas">{a.herramientas.length}</td>
                    <td data-etiqueta="Proyectos">{a.proyectos}</td>
                    <td data-etiqueta="Activo">
                      <Interruptor activo={a.activo} etiqueta={`Activar ${a.nombre}`} alCambiar={(v) => void cambiarActivo(a, v)} />
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="boton boton-chico" onClick={() => setEditando(a)}>
                        Editar
                      </button>{' '}
                      <button className="boton boton-chico boton-peligro" onClick={() => void eliminar(a)}>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editando && datos && (
        <FormularioAgente
          agente={editando === 'nuevo' ? null : editando}
          proveedores={datos.proveedores}
          alCerrar={() => setEditando(null)}
          alGuardar={async () => {
            setEditando(null);
            await recargar();
          }}
        />
      )}
    </>
  );
}

function FormularioAgente({
  agente,
  proveedores,
  alCerrar,
  alGuardar,
}: {
  agente: AgentePublico | null;
  proveedores: ProveedorPublico[];
  alCerrar(): void;
  alGuardar(): void;
}) {
  const { api } = useSesion();
  const [nombre, setNombre] = useState(agente?.nombre ?? '');
  const [rol, setRol] = useState<RolAgente>(agente?.rol ?? 'desarrollador');
  const [instrucciones, setInstrucciones] = useState(agente?.instrucciones ?? INSTRUCCIONES_ROL.desarrollador);
  const [proveedorId, setProveedorId] = useState(agente?.proveedorId ?? proveedores[0]?.id ?? '');
  const [modelo, setModelo] = useState(agente?.modelo ?? '');
  const [herramientas, setHerramientas] = useState<IdHerramienta[]>(
    agente?.herramientas ?? ['leer_archivos', 'buscar_codigo'],
  );
  const [limites, setLimites] = useState<LimitesAgente>(agente?.limites ?? LIMITES_AGENTE_PREDETERMINADOS);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proveedor = proveedores.find((p) => p.id === proveedorId);
  const modelos = proveedor?.modelosDisponibles.length
    ? proveedor.modelosDisponibles
    : (MODELOS_SUGERIDOS[proveedor?.tipo ?? 'anthropic'] ?? []);

  function cambiarRol(nuevo: RolAgente) {
    // Solo reemplaza las instrucciones si el usuario no las había personalizado.
    if (instrucciones === INSTRUCCIONES_ROL[rol] || !instrucciones) setInstrucciones(INSTRUCCIONES_ROL[nuevo]);
    setRol(nuevo);
  }

  const alternar = (h: IdHerramienta) =>
    setHerramientas((act) => (act.includes(h) ? act.filter((x) => x !== h) : [...act, h]));

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    const datos = { nombre, rol, instrucciones, proveedorId, modelo, herramientas, limites };
    try {
      if (agente) await api.editarAgente(agente.id, datos);
      else await api.crearAgente({ ...datos, activo: true });
      alGuardar();
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setGuardando(false);
    }
  }

  const numero = (clave: keyof LimitesAgente) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setLimites((l) => ({ ...l, [clave]: Number(e.target.value) }));

  return (
    <Modal
      ancho
      titulo={agente ? `Editar ${agente.nombre}` : 'Nuevo agente'}
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" type="button" onClick={alCerrar}>
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-agente" cargando={guardando}>
            Guardar agente
          </BotonCarga>
        </>
      }
    >
      {error && <Alerta>{error}</Alerta>}
      <form id="form-agente" onSubmit={guardar} style={{ display: 'contents' }}>
        <div className="fila-campos">
          <Campo etiqueta="Nombre" htmlFor="a-nombre">
            <input id="a-nombre" className="entrada" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Dev backend" autoFocus />
          </Campo>
          <Campo etiqueta="Rol" htmlFor="a-rol">
            <select id="a-rol" className="entrada" value={rol} onChange={(e) => cambiarRol(e.target.value as RolAgente)}>
              {ROLES_AGENTE.map((r) => (
                <option key={r} value={r}>
                  {NOMBRE_ROL[r]}
                </option>
              ))}
            </select>
          </Campo>
        </div>
        <div className="fila-campos">
          <Campo etiqueta="Proveedor" htmlFor="a-proveedor">
            <select id="a-proveedor" className="entrada" value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </Campo>
          <Campo
            etiqueta="Modelo"
            htmlFor="a-modelo"
            ayuda={
              proveedor?.modelosDisponibles.length
                ? 'Lista obtenida del proveedor.'
                : 'Prueba la conexión del proveedor para ver sus modelos reales.'
            }
          >
            <input
              id="a-modelo"
              className="entrada mono"
              list="lista-modelos"
              value={modelo}
              onChange={(e) => setModelo(e.target.value)}
              placeholder={modelos[0] ?? 'nombre-del-modelo'}
            />
            <datalist id="lista-modelos">
              {modelos.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Campo>
        </div>
        <Campo
          etiqueta="Instrucciones"
          htmlFor="a-instrucciones"
          ayuda="Se combinan con las políticas de seguridad de la plataforma; no pueden anularlas."
        >
          <textarea id="a-instrucciones" className="entrada" value={instrucciones} onChange={(e) => setInstrucciones(e.target.value)} />
        </Campo>

        <div className="campo">
          <label>Herramientas autorizadas</label>
          <div className="opciones">
            {HERRAMIENTAS.map((h) => {
              const marcada = herramientas.includes(h.id);
              return (
                <label key={h.id} className={`opcion${marcada ? ' marcada' : ''}`}>
                  <input type="checkbox" checked={marcada} onChange={() => alternar(h.id)} />
                  <div>
                    <strong>
                      {h.nombre} <span className={`etiqueta ${RIESGO[h.riesgo]}`}>Riesgo {h.riesgo}</span>
                    </strong>
                    <span className="descripcion">{h.descripcion}</span>
                  </div>
                </label>
              );
            })}
          </div>
          <span className="ayuda">
            Push, despliegues, acceso a red y secretos nunca se otorgan como herramienta: siempre requieren tu aprobación.
          </span>
        </div>

        <div className="campo">
          <label>Límites por tarea</label>
          <div className="fila-campos">
            <Campo etiqueta="Tokens máx." htmlFor="l-tokens">
              <input id="l-tokens" className="entrada" type="number" min={1000} step={1000} value={limites.maxTokensPorTarea} onChange={numero('maxTokensPorTarea')} />
            </Campo>
            <Campo etiqueta="Costo máx. (USD)" htmlFor="l-costo">
              <input id="l-costo" className="entrada" type="number" min={0.01} step={0.5} value={limites.maxCostoUsdPorTarea} onChange={numero('maxCostoUsdPorTarea')} />
            </Campo>
            <Campo etiqueta="Minutos máx." htmlFor="l-min">
              <input id="l-min" className="entrada" type="number" min={1} value={limites.maxMinutosPorTarea} onChange={numero('maxMinutosPorTarea')} />
            </Campo>
          </div>
        </div>
      </form>
    </Modal>
  );
}
