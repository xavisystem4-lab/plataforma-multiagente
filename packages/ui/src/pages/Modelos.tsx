import { INFO_PROVEEDOR, TIPOS_PROVEEDOR, type ProveedorPublico, type TipoProveedor } from '@softgala/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { invalidarAjustesVoz } from '../components/BotonVoz';
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

      {datos && <AjustesDeVoz proveedores={datos} />}

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

const IDIOMAS = [
  ['es', 'Español'],
  ['en', 'Inglés'],
  ['pt', 'Portugués'],
  ['fr', 'Francés'],
] as const;

/** Proveedor y modelo con que se transcriben las instrucciones dictadas por voz. */
function AjustesDeVoz({ proveedores }: { proveedores: ProveedorPublico[] }) {
  const { api } = useSesion();
  const { datos, error, recargar } = useDatos(useCallback(() => api.ajustesVoz(), [api]));
  const [proveedorId, setProveedorId] = useState('');
  const [modelo, setModelo] = useState('');
  const [idioma, setIdioma] = useState('es');
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);
  const compatibles = proveedores.filter((p) => p.tipo !== 'anthropic');

  // Si se agregan o eliminan proveedores, los ajustes pueden cambiar (p. ej. quedar sin proveedor).
  useEffect(() => {
    void recargar();
  }, [proveedores, recargar]);
  useEffect(() => {
    if (!datos) return;
    setProveedorId(datos.proveedorId ?? '');
    setModelo(datos.modelo);
    setIdioma(datos.idioma);
  }, [datos]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setMensaje(null);
    try {
      await api.guardarAjustesVoz({ proveedorId: proveedorId || null, modelo: modelo.trim(), idioma });
      invalidarAjustesVoz();
      await recargar();
      setMensaje({ ok: true, texto: proveedorId ? 'Listo: ya puedes dictar con el micrófono.' : 'Voz desactivada.' });
    } catch (err) {
      setMensaje({ ok: false, texto: mensajeError(err) });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="tarjeta" style={{ marginTop: 20, maxWidth: 720 }}>
      <div className="seccion-titulo">
        <h2>Instrucciones por voz</h2>
        <span className={`etiqueta ${datos?.disponible ? 'etiqueta-exito' : ''}`}>{datos?.disponible ? 'Activa' : 'Sin configurar'}</span>
      </div>
      <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
        El micrófono aparece en «Continuar proyecto» y al responder a un agente. El audio se envía a tu servidor, que lo
        transcribe con este proveedor y lo descarta; el texto se agrega al campo para que lo revises antes de enviarlo.
      </p>
      {error && <Alerta>{error}</Alerta>}
      {compatibles.length === 0 ? (
        <Alerta tipo="info">Agrega un proveedor de OpenAI (o compatible con transcripción) para usar la voz. Anthropic no ofrece transcripción.</Alerta>
      ) : (
        <form onSubmit={guardar} style={{ display: 'grid', gap: 12 }}>
          <div className="fila-campos">
            <Campo etiqueta="Proveedor" htmlFor="v-proveedor">
              <select id="v-proveedor" className="entrada" value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
                <option value="">— Desactivada —</option>
                {compatibles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo etiqueta="Idioma" htmlFor="v-idioma">
              <select id="v-idioma" className="entrada" value={idioma} onChange={(e) => setIdioma(e.target.value)}>
                {IDIOMAS.map(([id, nombre]) => (
                  <option key={id} value={id}>
                    {nombre}
                  </option>
                ))}
              </select>
            </Campo>
          </div>
          <Campo etiqueta="Modelo de transcripción" htmlFor="v-modelo" ayuda="gpt-4o-mini-transcribe es el más económico; gpt-4o-transcribe, el más preciso.">
            <input id="v-modelo" className="entrada mono" list="modelos-voz" value={modelo} onChange={(e) => setModelo(e.target.value)} />
            <datalist id="modelos-voz">
              {datos?.modelosSugeridos.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Campo>
          {mensaje && <Alerta tipo={mensaje.ok ? 'info' : 'error'}>{mensaje.texto}</Alerta>}
          <div>
            <BotonCarga type="submit" cargando={guardando} disabled={!modelo.trim()}>
              Guardar
            </BotonCarga>
          </div>
        </form>
      )}
    </section>
  );
}
