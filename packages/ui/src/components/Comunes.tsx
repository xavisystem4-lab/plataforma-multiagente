import { useEffect, useId, type ReactNode } from 'react';
import { IconoAlerta } from './Iconos';

export function Modal({
  titulo,
  descripcion,
  alCerrar,
  pie,
  ancho,
  children,
}: {
  titulo: string;
  descripcion?: string;
  alCerrar(): void;
  pie?: ReactNode;
  ancho?: boolean;
  children: ReactNode;
}) {
  const idTitulo = useId();
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => e.key === 'Escape' && alCerrar();
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [alCerrar]);

  return (
    <div className="modal-fondo" onMouseDown={(e) => e.target === e.currentTarget && alCerrar()}>
      <div className={`modal${ancho ? ' ancho' : ''}`} role="dialog" aria-modal="true" aria-labelledby={idTitulo}>
        <header>
          <div>
            <h2 id={idTitulo}>{titulo}</h2>
            {descripcion && <p>{descripcion}</p>}
          </div>
          <button className="boton-cerrar" onClick={alCerrar} aria-label="Cerrar">
            ×
          </button>
        </header>
        <div className="cuerpo">{children}</div>
        {pie && <footer>{pie}</footer>}
      </div>
    </div>
  );
}

export function Interruptor({
  activo,
  alCambiar,
  etiqueta,
  deshabilitado,
}: {
  activo: boolean;
  alCambiar(v: boolean): void;
  etiqueta: string;
  deshabilitado?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="interruptor"
      aria-checked={activo}
      aria-label={etiqueta}
      title={etiqueta}
      disabled={deshabilitado}
      onClick={() => alCambiar(!activo)}
    />
  );
}

export function Alerta({ tipo = 'error', children }: { tipo?: 'error' | 'aviso' | 'info'; children: ReactNode }) {
  return (
    <div className={`alerta alerta-${tipo}`} role={tipo === 'error' ? 'alert' : 'status'}>
      <IconoAlerta style={{ flexShrink: 0 }} /> <div>{children}</div>
    </div>
  );
}

export function Vacio({
  icono,
  titulo,
  texto,
  accion,
}: {
  icono: ReactNode;
  titulo: string;
  texto: string;
  accion?: ReactNode;
}) {
  return (
    <div className="tarjeta vacio">
      <div className="icono">{icono}</div>
      <h2>{titulo}</h2>
      <p>{texto}</p>
      {accion}
    </div>
  );
}

export function Encabezado({ titulo, texto, children }: { titulo: string; texto: string; children?: ReactNode }) {
  return (
    <div className="encabezado">
      <div>
        <h1>{titulo}</h1>
        <p>{texto}</p>
      </div>
      {children && <div className="acciones">{children}</div>}
    </div>
  );
}

export function Campo({
  etiqueta,
  ayuda,
  error,
  htmlFor,
  children,
}: {
  etiqueta: string;
  ayuda?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="campo">
      <label htmlFor={htmlFor}>{etiqueta}</label>
      {children}
      {error ? <span className="error-campo">{error}</span> : ayuda && <span className="ayuda">{ayuda}</span>}
    </div>
  );
}

export function BotonCarga({
  cargando,
  children,
  className = 'boton boton-primario',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { cargando?: boolean }) {
  return (
    <button className={className} disabled={cargando || props.disabled} {...props}>
      {cargando ? <span className="girando" aria-label="Procesando" /> : children}
    </button>
  );
}

const formatoFecha = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
export const fecha = (iso: string) => (iso ? formatoFecha.format(new Date(iso)) : '—');
