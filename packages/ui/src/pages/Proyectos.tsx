import {
  NOMBRE_ROL,
  type AgentePublico,
  type EstadoRepositorio,
  type LimitesProyecto,
  type ProyectoPublico,
  type Validacion,
} from '@softgala/shared';
import { useCallback, useState, type FormEvent } from 'react';
import { Alerta, BotonCarga, Campo, Encabezado, fecha, Interruptor, Modal, Vacio } from '../components/Comunes';
import { IconoProyecto } from '../components/Iconos';
import { mensajeError, useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';

export function Proyectos() {
  const { api } = useSesion();
  const { datos, error, recargar } = useDatos(useCallback(() => api.proyectos(), [api]));
  const [conectando, setConectando] = useState(false);
  const [seleccionado, setSeleccionado] = useState<string | null>(null);

  if (seleccionado) {
    return (
      <DetalleProyecto
        id={seleccionado}
        alVolver={() => {
          setSeleccionado(null);
          void recargar();
        }}
      />
    );
  }

  return (
    <>
      <Encabezado titulo="Proyectos" texto="Repositorios de GitHub que los agentes pueden continuar en el servidor.">
        <button className="boton boton-primario" onClick={() => setConectando(true)}>
          Conectar proyecto
        </button>
      </Encabezado>
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alerta>{error}</Alerta>
        </div>
      )}

      {datos?.length === 0 && (
        <Vacio
          icono={<IconoProyecto />}
          titulo="Aún no hay proyectos conectados"
          texto="Conecta un repositorio de GitHub con un token de permisos mínimos. Los agentes solo podrán trabajar en los proyectos que conectes."
          accion={
            <button className="boton boton-primario" onClick={() => setConectando(true)}>
              Conectar proyecto
            </button>
          }
        />
      )}

      <div className="lista-tarjetas">
        {datos?.map((p) => (
          <button key={p.id} className="tarjeta tarjeta-recurso tarjeta-clic" onClick={() => setSeleccionado(p.id)}>
            <div className="cabecera">
              <div>
                <h3>{p.nombre}</h3>
                <div className="sub mono">{p.repositorio}</div>
              </div>
              <span className="etiqueta">{p.privado ? 'Privado' : 'Público'}</span>
            </div>
            <dl className="datos-lista">
              <dt>Rama base</dt>
              <dd className="mono">{p.ramaBase}</dd>
              <dt>Agentes</dt>
              <dd>{p.agentes.length ? p.agentes.map((a) => a.nombre).join(', ') : 'Ninguno habilitado'}</dd>
              <dt>Validaciones</dt>
              <dd>{p.validaciones.length || '—'}</dd>
            </dl>
            {p.avisos.length > 0 && <span className="etiqueta etiqueta-aviso">{p.avisos.length} aviso(s) de seguridad</span>}
          </button>
        ))}
      </div>

      {conectando && (
        <ConectarProyecto
          alCerrar={() => setConectando(false)}
          alConectar={(p) => {
            setConectando(false);
            setSeleccionado(p.id);
          }}
        />
      )}
    </>
  );
}

function ConectarProyecto({ alCerrar, alConectar }: { alCerrar(): void; alConectar(p: ProyectoPublico): void }) {
  const { api } = useSesion();
  const [nombre, setNombre] = useState('');
  const [repositorio, setRepositorio] = useState('');
  const [ramaBase, setRamaBase] = useState('');
  const [token, setToken] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function conectar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      // Acepta también la URL completa del repositorio.
      const repo = repositorio.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '');
      const p = await api.crearProyecto({ nombre: nombre || repo.split('/')[1] || repo, repositorio: repo, token, ...(ramaBase ? { ramaBase } : {}) });
      alConectar(p);
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal
      titulo="Conectar proyecto de GitHub"
      descripcion="Verificamos el acceso al repositorio y la rama antes de guardar."
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" type="button" onClick={alCerrar}>
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-proyecto" cargando={guardando} disabled={!repositorio || !token}>
            Verificar y conectar
          </BotonCarga>
        </>
      }
    >
      {error && <Alerta>{error}</Alerta>}
      <form id="form-proyecto" onSubmit={conectar} style={{ display: 'contents' }}>
        <Campo etiqueta="Repositorio" htmlFor="r-repo" ayuda="propietario/repositorio o la URL de GitHub.">
          <input id="r-repo" className="entrada mono" value={repositorio} onChange={(e) => setRepositorio(e.target.value)} placeholder="softgala/mi-proyecto" autoFocus />
        </Campo>
        <div className="fila-campos">
          <Campo etiqueta="Nombre (opcional)" htmlFor="r-nombre">
            <input id="r-nombre" className="entrada" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </Campo>
          <Campo etiqueta="Rama base (opcional)" htmlFor="r-rama" ayuda="Por defecto, la principal.">
            <input id="r-rama" className="entrada mono" value={ramaBase} onChange={(e) => setRamaBase(e.target.value)} placeholder="main" />
          </Campo>
        </div>
        <Campo
          etiqueta="Token de GitHub"
          htmlFor="r-token"
          ayuda={
            <>
              Recomendado: token <strong>fine-grained</strong> solo para este repositorio con permisos <em>Contents: Read and write</em> y{' '}
              <em>Metadata: Read</em>. Se guarda cifrado en el servidor.
            </>
          }
        >
          <input id="r-token" className="entrada mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
        </Campo>
      </form>
    </Modal>
  );
}

function DetalleProyecto({ id, alVolver }: { id: string; alVolver(): void }) {
  const { api } = useSesion();
  const cargar = useCallback(async () => {
    const [proyecto, agentes] = await Promise.all([api.proyecto(id), api.agentes()]);
    return { proyecto, agentes };
  }, [api, id]);
  const { datos, error, setDatos } = useDatos(cargar);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  if (!datos) {
    return (
      <>
        <button className="boton boton-texto volver" onClick={alVolver}>
          ← Proyectos
        </button>
        {error ? <Alerta>{error}</Alerta> : <p>Cargando…</p>}
      </>
    );
  }
  const { proyecto: p, agentes } = datos;
  const actualizar = (proyecto: ProyectoPublico) => setDatos({ ...datos, proyecto });

  async function accion(fn: () => Promise<ProyectoPublico>) {
    setErrorAccion(null);
    try {
      actualizar(await fn());
      return true;
    } catch (err) {
      setErrorAccion(mensajeError(err));
      return false;
    }
  }

  async function desconectar() {
    if (!window.confirm(`¿Desconectar "${p.nombre}"? Se borrará el token guardado. El repositorio en GitHub no se modifica.`)) return;
    try {
      await api.eliminarProyecto(p.id);
      alVolver();
    } catch (err) {
      setErrorAccion(mensajeError(err));
    }
  }

  return (
    <>
      <button className="boton boton-texto volver" onClick={alVolver}>
        ← Proyectos
      </button>
      <Encabezado titulo={p.nombre} texto={`${p.repositorio} · rama ${p.ramaBase} · ${p.privado ? 'privado' : 'público'}`}>
        <a className="boton" href={p.urlRepo} target="_blank" rel="noreferrer noopener">
          Abrir en GitHub
        </a>
        <button className="boton boton-peligro" onClick={() => void desconectar()}>
          Desconectar
        </button>
      </Encabezado>

      <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
        {p.avisos.map((a) => (
          <Alerta key={a} tipo="aviso">
            {a}
          </Alerta>
        ))}
        {errorAccion && <Alerta>{errorAccion}</Alerta>}
      </div>

      <div className="detalle">
        <EstadoRepo proyectoId={p.id} />
        <AgentesProyecto
          proyecto={p}
          agentes={agentes}
          alCambiar={(agenteId, v) => void accion(() => api.habilitarAgente(p.id, agenteId, v))}
        />
        <Validaciones inicial={p.validaciones} alGuardar={(validaciones) => accion(() => api.editarProyecto(p.id, { validaciones }))} />
        <Configuracion proyecto={p} alGuardar={(cambios) => accion(() => api.editarProyecto(p.id, cambios))} />
      </div>
    </>
  );
}

function EstadoRepo({ proyectoId }: { proyectoId: string }) {
  const { api } = useSesion();
  const { datos, error, cargando, recargar } = useDatos<EstadoRepositorio>(
    useCallback(() => api.estadoProyecto(proyectoId), [api, proyectoId]),
  );
  return (
    <section className="tarjeta">
      <div className="seccion-titulo">
        <h2>Estado en GitHub</h2>
        <BotonCarga className="boton boton-chico" cargando={cargando} onClick={() => void recargar()}>
          Actualizar
        </BotonCarga>
      </div>
      {error && <Alerta>{error}</Alerta>}
      {datos && (
        <div style={{ display: 'grid', gap: 12 }}>
          {datos.ultimoCommit && (
            <div className="commit">
              <span style={{ color: 'var(--texto-suave)', fontSize: 12 }}>Último commit en {datos.rama}</span>
              <strong>{datos.ultimoCommit.mensaje}</strong>
              <span>
                {datos.ultimoCommit.autor} · {fecha(datos.ultimoCommit.fecha)} ·{' '}
                <a href={datos.ultimoCommit.url} target="_blank" rel="noreferrer noopener" className="mono">
                  {datos.ultimoCommit.sha.slice(0, 7)}
                </a>
              </span>
            </div>
          )}
          <div>
            <strong style={{ fontSize: 13 }}>Ramas de los agentes</strong>
            <p style={{ margin: '4px 0 0', color: 'var(--texto-suave)', fontSize: 13 }}>
              {datos.ramasAgentes.length ? (
                <span className="mono">{datos.ramasAgentes.join(', ')}</span>
              ) : (
                'Todavía no hay ramas de agentes (se crean al ejecutar tareas en la fase F2).'
              )}
            </p>
          </div>
          <span style={{ fontSize: 12, color: 'var(--texto-suave)' }}>Consultado: {fecha(datos.consultadoEn)}</span>
        </div>
      )}
    </section>
  );
}

function AgentesProyecto({
  proyecto,
  agentes,
  alCambiar,
}: {
  proyecto: ProyectoPublico;
  agentes: AgentePublico[];
  alCambiar(agenteId: string, habilitado: boolean): void;
}) {
  const habilitados = new Set(proyecto.agentes.map((a) => a.agenteId));
  return (
    <section className="tarjeta">
      <div className="seccion-titulo">
        <h2>Agentes del proyecto</h2>
        <span className="etiqueta etiqueta-marino">
          {habilitados.size} de {agentes.length}
        </span>
      </div>
      {agentes.length === 0 && <p style={{ margin: 0, color: 'var(--texto-suave)' }}>Crea agentes en la sección Agentes.</p>}
      {agentes.map((a) => (
        <div key={a.id} className="fila-agente">
          <div className="info">
            <strong>{a.nombre}</strong>
            <span>
              {NOMBRE_ROL[a.rol]} · <span className="mono">{a.modelo}</span>
              {!a.activo && ' · desactivado globalmente'}
            </span>
          </div>
          <Interruptor activo={habilitados.has(a.id)} etiqueta={`Habilitar ${a.nombre} en ${proyecto.nombre}`} alCambiar={(v) => alCambiar(a.id, v)} />
        </div>
      ))}
    </section>
  );
}

function Validaciones({ inicial, alGuardar }: { inicial: Validacion[]; alGuardar(v: Validacion[]): Promise<boolean> }) {
  const [filas, setFilas] = useState<Validacion[]>(inicial);
  const [guardando, setGuardando] = useState(false);
  const cambiada = JSON.stringify(filas) !== JSON.stringify(inicial);
  const editar = (i: number, campo: keyof Validacion, valor: string) =>
    setFilas((f) => f.map((v, j) => (j === i ? { ...v, [campo]: valor } : v)));

  return (
    <section className="tarjeta">
      <div className="seccion-titulo">
        <h2>Validaciones</h2>
        <button className="boton boton-chico" onClick={() => setFilas((f) => [...f, { nombre: '', comando: '' }])} disabled={filas.length >= 20}>
          Agregar
        </button>
      </div>
      <p style={{ margin: '0 0 12px', color: 'var(--texto-suave)', fontSize: 13 }}>
        Comandos que se ejecutarán en el sandbox antes de proponerte cambios (tests, lint, build). Se informa su resultado real.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {filas.map((v, i) => (
          <div key={i} className="fila-validacion">
            <input className="entrada" aria-label="Nombre" placeholder="Pruebas" value={v.nombre} onChange={(e) => editar(i, 'nombre', e.target.value)} />
            <input className="entrada mono" aria-label="Comando" placeholder="npm test" value={v.comando} onChange={(e) => editar(i, 'comando', e.target.value)} />
            <button className="boton boton-chico boton-peligro" onClick={() => setFilas((f) => f.filter((_, j) => j !== i))} aria-label="Quitar validación">
              Quitar
            </button>
          </div>
        ))}
      </div>
      {cambiada && (
        <div className="acciones" style={{ marginTop: 12 }}>
          <BotonCarga
            className="boton boton-primario boton-chico"
            cargando={guardando}
            onClick={async () => {
              setGuardando(true);
              await alGuardar(filas);
              setGuardando(false);
            }}
          >
            Guardar validaciones
          </BotonCarga>
          <button className="boton boton-chico" onClick={() => setFilas(inicial)}>
            Descartar
          </button>
        </div>
      )}
    </section>
  );
}

function Configuracion({
  proyecto,
  alGuardar,
}: {
  proyecto: ProyectoPublico;
  alGuardar(c: { limites?: LimitesProyecto; token?: string; ramaBase?: string }): Promise<boolean>;
}) {
  const [limites, setLimites] = useState(proyecto.limites);
  const [ramaBase, setRamaBase] = useState(proyecto.ramaBase);
  const [token, setToken] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    const ok = await alGuardar({
      limites,
      ...(ramaBase !== proyecto.ramaBase ? { ramaBase } : {}),
      ...(token ? { token } : {}),
    });
    if (ok) setToken('');
    setGuardando(false);
  }

  return (
    <section className="tarjeta">
      <h2 style={{ marginBottom: 12 }}>Configuración</h2>
      <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
        <div className="fila-campos">
          <Campo etiqueta="Agentes simultáneos" htmlFor="c-sim">
            <input
              id="c-sim"
              className="entrada"
              type="number"
              min={1}
              max={20}
              value={limites.maxAgentesSimultaneos}
              onChange={(e) => setLimites({ ...limites, maxAgentesSimultaneos: Number(e.target.value) })}
            />
          </Campo>
          <Campo etiqueta="Presupuesto mensual (USD)" htmlFor="c-pres">
            <input
              id="c-pres"
              className="entrada"
              type="number"
              min={0}
              step={5}
              value={limites.presupuestoMensualUsd}
              onChange={(e) => setLimites({ ...limites, presupuestoMensualUsd: Number(e.target.value) })}
            />
          </Campo>
        </div>
        <Campo etiqueta="Rama base" htmlFor="c-rama">
          <input id="c-rama" className="entrada mono" value={ramaBase} onChange={(e) => setRamaBase(e.target.value)} />
        </Campo>
        <Campo etiqueta="Rotar token de GitHub" htmlFor="c-token" ayuda={`Token actual: ${proyecto.tokenMascara}. Déjalo vacío para conservarlo.`}>
          <input id="c-token" className="entrada mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </Campo>
        <div>
          <BotonCarga type="submit" className="boton boton-primario boton-chico" cargando={guardando}>
            Guardar configuración
          </BotonCarga>
        </div>
      </form>
    </section>
  );
}
