import { NOMBRE_PUBLICACION, type AprobacionPublica, type TareaPublica } from '@softgala/shared';
import { useState, type FormEvent } from 'react';
import { mensajeError } from '../lib/datos';
import { useSesion } from '../lib/sesion';
import { Alerta, BotonCarga, Campo, Modal } from './Comunes';

/** Diálogo para aprobar la publicación: solo la rama del agente, opcionalmente con Pull Request. */
export function DialogoAprobar({
  aprobacion,
  alCerrar,
  alResolver,
}: {
  aprobacion: Pick<AprobacionPublica, 'id' | 'rama' | 'archivos'>;
  alCerrar(): void;
  alResolver(): void;
}) {
  const { api } = useSesion();
  const [crearPR, setCrearPR] = useState(true);
  const [comentario, setComentario] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      await api.aprobar(aprobacion.id, { crearPR, ...(comentario ? { comentario } : {}) });
      alResolver();
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal
      titulo="Aprobar y publicar en GitHub"
      descripcion="Se sube solo la rama del agente. La rama principal no se modifica: la fusión la haces tú en GitHub."
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" type="button" onClick={alCerrar}>
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-aprobar" cargando={enviando}>
            Aprobar y publicar
          </BotonCarga>
        </>
      }
    >
      {error && <Alerta>{error}</Alerta>}
      <form id="form-aprobar" onSubmit={enviar} style={{ display: 'contents' }}>
        <p style={{ margin: 0 }}>
          Rama <span className="mono">{aprobacion.rama}</span> · {aprobacion.archivos} archivo(s) modificado(s).
        </p>
        <label className={`opcion${crearPR ? ' marcada' : ''}`}>
          <input type="checkbox" checked={crearPR} onChange={(e) => setCrearPR(e.target.checked)} />
          <div>
            <strong>Abrir un Pull Request</strong>
            <span className="descripcion">Recomendado: revisas y fusionas los cambios desde GitHub.</span>
          </div>
        </label>
        <Campo etiqueta="Comentario (opcional)" htmlFor="ap-comentario">
          <textarea id="ap-comentario" className="entrada" value={comentario} onChange={(e) => setComentario(e.target.value)} style={{ minHeight: 70 }} />
        </Campo>
      </form>
    </Modal>
  );
}

export function DialogoRechazar({ aprobacionId, alCerrar, alResolver }: { aprobacionId: string; alCerrar(): void; alResolver(): void }) {
  const { api } = useSesion();
  const [descartar, setDescartar] = useState(false);
  const [comentario, setComentario] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      await api.rechazar(aprobacionId, { descartar, ...(comentario ? { comentario } : {}) });
      alResolver();
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal
      titulo="Rechazar cambios"
      descripcion="Los cambios no se publicarán. Nada se modifica en GitHub."
      alCerrar={alCerrar}
      pie={
        <>
          <button className="boton" type="button" onClick={alCerrar}>
            Cancelar
          </button>
          <BotonCarga type="submit" form="form-rechazar" className="boton boton-peligro" cargando={enviando}>
            Rechazar
          </BotonCarga>
        </>
      }
    >
      {error && <Alerta>{error}</Alerta>}
      <form id="form-rechazar" onSubmit={enviar} style={{ display: 'contents' }}>
        <Campo etiqueta="Motivo (opcional)" htmlFor="re-comentario">
          <textarea id="re-comentario" className="entrada" value={comentario} onChange={(e) => setComentario(e.target.value)} style={{ minHeight: 70 }} />
        </Campo>
        <label className={`opcion${descartar ? ' marcada' : ''}`}>
          <input type="checkbox" checked={descartar} onChange={(e) => setDescartar(e.target.checked)} />
          <div>
            <strong>Descartar también los cambios del servidor</strong>
            <span className="descripcion">Borra la rama y los archivos de trabajo de esta tarea en el servidor. No se puede deshacer.</span>
          </div>
        </label>
      </form>
    </Modal>
  );
}

/** Estado de revisión de una tarea y sus acciones (aprobar, rechazar, revertir). */
export function PanelRevision({ tarea, alCambiar }: { tarea: TareaPublica; alCambiar(): void }) {
  const { api } = useSesion();
  const [dialogo, setDialogo] = useState<'aprobar' | 'rechazar' | null>(null);
  const [aprobacion, setAprobacion] = useState<AprobacionPublica | null>(null);
  const [revirtiendo, setRevirtiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pub = tarea.publicacion;
  if (!pub) return null;

  async function abrir(tipo: 'aprobar' | 'rechazar') {
    setError(null);
    try {
      const a = (await api.aprobaciones('pendiente')).find((x) => x.tareaId === tarea.id);
      if (!a) throw new Error('No hay una solicitud pendiente para esta tarea.');
      setAprobacion(a);
      setDialogo(tipo);
    } catch (err) {
      setError(mensajeError(err, err instanceof Error ? err.message : undefined));
    }
  }

  async function revertir() {
    const texto = pub!.prNumero
      ? '¿Revertir? Si el Pull Request no se ha fusionado, se cerrará y se borrará la rama remota. Si ya se fusionó, se abrirá un PR de reversión para que lo revises.'
      : '¿Revertir? Se borrará la rama publicada en GitHub.';
    if (!window.confirm(texto)) return;
    setRevirtiendo(true);
    setError(null);
    try {
      await api.revertir(tarea.id);
      alCambiar();
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setRevirtiendo(false);
    }
  }

  const clase = { pendiente: 'etiqueta-aviso', publicada: 'etiqueta-exito', rechazada: 'etiqueta-error', descartada: '', revertida: 'etiqueta-marino' }[pub.estado];
  return (
    <section className="tarjeta revision">
      <div className="seccion-titulo">
        <h2>Revisión y publicación</h2>
        <span className={`etiqueta ${clase}`}>{NOMBRE_PUBLICACION[pub.estado]}</span>
      </div>
      {error && <Alerta>{error}</Alerta>}
      {pub.estado === 'pendiente' && (
        <>
          <p>Revisa los cambios de abajo. Al aprobar, se sube la rama del agente a GitHub; la rama principal no se toca.</p>
          <div className="acciones">
            <button className="boton boton-primario" onClick={() => void abrir('aprobar')}>
              Aprobar y publicar
            </button>
            <button className="boton boton-peligro" onClick={() => void abrir('rechazar')}>
              Rechazar
            </button>
          </div>
        </>
      )}
      {pub.estado === 'publicada' && (
        <>
          <p>
            Rama <span className="mono">{pub.rama}</span> publicada.{' '}
            {pub.prUrl && (
              <a href={pub.prUrl} target="_blank" rel="noreferrer noopener">
                Ver Pull Request #{pub.prNumero}
              </a>
            )}
          </p>
          {pub.nota && <p style={{ fontSize: 12.5 }}>{pub.nota}</p>}
          <div className="acciones">
            <BotonCarga className="boton boton-peligro" cargando={revirtiendo} onClick={() => void revertir()}>
              Revertir
            </BotonCarga>
          </div>
        </>
      )}
      {(pub.estado === 'rechazada' || pub.estado === 'descartada' || pub.estado === 'revertida') && (
        <p>
          {pub.nota ?? ''}{' '}
          {pub.reversionPrUrl && (
            <a href={pub.reversionPrUrl} target="_blank" rel="noreferrer noopener">
              Ver PR de reversión
            </a>
          )}
        </p>
      )}

      {dialogo === 'aprobar' && aprobacion && (
        <DialogoAprobar
          aprobacion={aprobacion}
          alCerrar={() => setDialogo(null)}
          alResolver={() => {
            setDialogo(null);
            alCambiar();
          }}
        />
      )}
      {dialogo === 'rechazar' && aprobacion && (
        <DialogoRechazar
          aprobacionId={aprobacion.id}
          alCerrar={() => setDialogo(null)}
          alResolver={() => {
            setDialogo(null);
            alCambiar();
          }}
        />
      )}
    </section>
  );
}
