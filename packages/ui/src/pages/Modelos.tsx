import { INFO_PROVEEDOR, TIPOS_PROVEEDOR, type ProveedorPublico, type TipoProveedor } from '@softgala/shared';
import { useCallback, useState, type FormEvent } from 'react';
import { Alerta, BotonCarga, Campo, Encabezado, fecha, Modal, Vacio } from '../components/Comunes';
import { IconoModelos } from '../components/Iconos';
import { mensajeError, useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';

export function Modelos() {
  const { api } = useSesion();
  const { datos, error, recargar } = useDatos(useCallback(() => api.proveedores(), [api]));
  const [editando, setEditando] = useState<ProveedorPublico | 'nuevo' | null>(null);
  const [probando, setProbando] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  async function probar(p: ProveedorPublico) {
    setProbando(p.id);
    setErrorAccion(null);
    try {
      await api.probarProveedor(p.id);
      await recargar();
    } catch (err) {
      setErrorAccion(mensajeError(err));
    } finally {
      setProbando(null);
    }
  }

  async function eliminar(p: ProveedorPublico) {
    if (!window.confirm(`¿Eliminar el proveedor "${p.nombre}"? Su clave se borrará del servidor.`)) return;
    try {
      await api.eliminarProveedor(p.id);
      await recargar();
    } catch (err) {
      setErrorAccion(mensajeError(err));
    }
  }

  return (
    <>
      <Encabezado titulo="Modelos IA" texto="Proveedores de modelos que usarán tus agentes. Puedes combinar varios.">
        <button className="boton boton-primario" onClick={() => setEditando('nuevo')}>
          Agregar proveedor
        </button>
      </Encabezado>

      <div style={{ marginBottom: 16 }}>
        <Alerta tipo="info">
          Las claves API se cifran en el servidor y nunca vuelven a mostrarse ni llegan a la app móvil.
        </Alerta>
      </div>
      {(error || errorAccion) && (
        <div style={{ marginBottom: 16 }}>
          <Alerta>{error ?? errorAccion}</Alerta>
        </div>
      )}

      {datos && datos.length === 0 && (
        <Vacio
          icono={<IconoModelos />}
          titulo="Aún no hay proveedores"
          texto="Agrega Anthropic (Claude), OpenAI o un servidor compatible como Ollama u OpenRouter."
          accion={
            <button className="boton boton-primario" onClick={() => setEditando('nuevo')}>
              Agregar proveedor
            </button>
          }
        />
      )}

      <div className="lista-tarjetas">
        {datos?.map((p) => (
          <article key={p.id} className="tarjeta tarjeta-recurso">
            <div className="cabecera">
              <div>
                <h3>{p.nombre}</h3>
                <div className="sub">{INFO_PROVEEDOR[p.tipo].nombre}</div>
              </div>
              {p.ultimaPrueba ? (
                <span className={`etiqueta ${p.ultimaPrueba.ok ? 'etiqueta-exito' : 'etiqueta-error'}`}>
                  {p.ultimaPrueba.ok ? 'Conectado' : 'Error'}
                </span>
              ) : (
                <span className="etiqueta">Sin probar</span>
              )}
            </div>
            <dl className="datos-lista">
              {p.urlBase && (
                <>
                  <dt>URL</dt>
                  <dd className="mono">{p.urlBase}</dd>
                </>
              )}
              <dt>Clave</dt>
              <dd className="mono">{p.claveMascara ?? 'Sin clave'}</dd>
              <dt>Modelos</dt>
              <dd>{p.modelosDisponibles.length ? `${p.modelosDisponibles.length} disponibles` : '—'}</dd>
              <dt>Agentes</dt>
              <dd>{p.agentes}</dd>
            </dl>
            {p.ultimaPrueba && (
              <p className="sub" style={{ margin: 0 }}>
                {p.ultimaPrueba.mensaje} · {fecha(p.ultimaPrueba.fecha)}
              </p>
            )}
            <div className="acciones">
              <BotonCarga className="boton boton-chico" cargando={probando === p.id} onClick={() => void probar(p)}>
                Probar conexión
              </BotonCarga>
              <button className="boton boton-chico" onClick={() => setEditando(p)}>
                Editar
              </button>
              <button className="boton boton-chico boton-peligro" onClick={() => void eliminar(p)}>
                Eliminar
              </button>
            </div>
          </article>
        ))}
      </div>

      {editando && (
        <FormularioProveedor
          proveedor={editando === 'nuevo' ? null : editando}
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

function FormularioProveedor({
  proveedor,
  alCerrar,
  alGuardar,
}: {
  proveedor: ProveedorPublico | null;
  alCerrar(): void;
  alGuardar(): void;
}) {
  const { api } = useSesion();
  const [nombre, setNombre] = useState(proveedor?.nombre ?? '');
  const [tipo, setTipo] = useState<TipoProveedor>(proveedor?.tipo ?? 'anthropic');
  const [urlBase, setUrlBase] = useState(proveedor?.urlBase ?? '');
  const [apiKey, setApiKey] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = INFO_PROVEEDOR[tipo];

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      if (proveedor) {
        await api.editarProveedor(proveedor.id, {
          nombre,
          ...(info.requiereUrl ? { urlBase } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
      } else {
        await api.crearProveedor({
          nombre,
          tipo,
          ...(info.requiereUrl ? { urlBase } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
      }
      alGuardar();
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal
      titulo={proveedor ? `Editar ${proveedor.nombre}` : 'Agregar proveedor'}
      descripcion="Después de guardar, usa «Probar conexión» para verificar la clave y obtener los modelos."
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" onClick={alCerrar} type="button">
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-proveedor" cargando={guardando}>
            Guardar
          </BotonCarga>
        </>
      }
    >
      {error && <Alerta>{error}</Alerta>}
      <form id="form-proveedor" onSubmit={guardar} style={{ display: 'contents' }}>
        <Campo etiqueta="Nombre" htmlFor="p-nombre">
          <input id="p-nombre" className="entrada" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Claude principal" autoFocus />
        </Campo>
        {!proveedor && (
          <Campo etiqueta="Tipo" htmlFor="p-tipo">
            <select id="p-tipo" className="entrada" value={tipo} onChange={(e) => setTipo(e.target.value as TipoProveedor)}>
              {TIPOS_PROVEEDOR.map((t) => (
                <option key={t} value={t}>
                  {INFO_PROVEEDOR[t].nombre}
                </option>
              ))}
            </select>
          </Campo>
        )}
        {info.requiereUrl && (
          <Campo
            etiqueta="URL base"
            htmlFor="p-url"
            ayuda="Debe usar HTTPS. Para un servidor en este mismo equipo se permite http://localhost (p. ej. Ollama: http://localhost:11434/v1)."
          >
            <input id="p-url" className="entrada mono" value={urlBase} onChange={(e) => setUrlBase(e.target.value)} placeholder="https://openrouter.ai/api/v1" />
          </Campo>
        )}
        <Campo
          etiqueta={proveedor ? 'Nueva clave API (opcional)' : `Clave API${info.requiereClave ? '' : ' (opcional)'}`}
          htmlFor="p-clave"
          ayuda={proveedor?.claveMascara ? `Clave actual: ${proveedor.claveMascara}. Déjalo vacío para conservarla.` : undefined}
        >
          <input
            id="p-clave"
            className="entrada mono"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Campo>
      </form>
    </Modal>
  );
}
