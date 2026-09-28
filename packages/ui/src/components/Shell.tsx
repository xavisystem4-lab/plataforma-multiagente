import type { ProyectoPublico, UsuarioPublico } from '@softgala/shared';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  IconoAgentes,
  IconoAprobar,
  IconoAuditoria,
  IconoCandado,
  IconoModelos,
  IconoPanel,
  IconoProyecto,
  IconoSalir,
  IconoTareas,
} from './Iconos';
import { Logo } from './Logo';
import { hexDe } from './SelectorColor';
import { SelectorTema } from './SelectorTema';

export type Pagina = 'panel' | 'tareas' | 'aprobaciones' | 'proyectos' | 'agentes' | 'modelos' | 'auditoria' | 'seguridad';

interface ItemNav {
  id: Pagina | null;
  texto: string;
  Icono: ComponentType<SVGProps<SVGSVGElement>>;
  /** Fase en la que se habilita; se muestra deshabilitado hasta entonces. */
  fase?: string;
}

const PRINCIPAL: ItemNav[] = [
  { id: 'panel', texto: 'Panel', Icono: IconoPanel },
  { id: 'proyectos', texto: 'Proyectos', Icono: IconoProyecto },
  { id: 'agentes', texto: 'Agentes', Icono: IconoAgentes },
  { id: 'tareas', texto: 'Tareas', Icono: IconoTareas },
  { id: 'aprobaciones', texto: 'Aprobaciones', Icono: IconoAprobar },
];
const ADMINISTRACION: ItemNav[] = [
  { id: 'modelos', texto: 'Modelos IA', Icono: IconoModelos },
  { id: 'auditoria', texto: 'Auditoría', Icono: IconoAuditoria },
  { id: 'seguridad', texto: 'Seguridad', Icono: IconoCandado },
];

const iniciales = (nombre: string) =>
  nombre
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

interface Props {
  usuario: UsuarioPublico;
  /** Contadores por página (p. ej. aprobaciones pendientes). */
  contadores?: Partial<Record<Pagina, number>>;
  pagina: Pagina;
  alNavegar(p: Pagina): void;
  /** Proyectos fijados por el usuario, con acceso directo a su ventana. */
  fijados?: ProyectoPublico[];
  alAbrirProyecto?(p: ProyectoPublico): void;
  alSalir(): void;
  children: ReactNode;
}

export function Shell({ usuario, pagina, alNavegar, alSalir, contadores = {}, fijados = [], alAbrirProyecto, children }: Props) {
  const item = ({ id, texto, Icono, fase }: ItemNav) => (
    <button
      key={texto}
      className={`nav-item${id === pagina ? ' activo' : ''}`}
      disabled={!id}
      onClick={() => id && alNavegar(id)}
      aria-current={id === pagina ? 'page' : undefined}
      title={fase ? `Disponible en la fase ${fase}` : undefined}
    >
      <Icono />
      <span>{texto}</span>
      {fase && <span className="etiqueta">{fase}</span>}
      {id && !!contadores[id] && (
        <span className="contador" aria-label={`${contadores[id]} pendientes`}>
          {contadores[id]}
        </span>
      )}
    </button>
  );

  return (
    <div className="shell">
      <nav className="lateral" aria-label="Navegación principal">
        <div className="lateral-marca">
          <Logo tamano={32} claro />
          <div>
            Multiagente
            <small>SoftGala</small>
          </div>
        </div>
        {PRINCIPAL.map(item)}
        {fijados.length > 0 && (
          <>
            <div className="lateral-seccion">Fijados</div>
            {fijados.map((p) => (
              <button
                key={p.id}
                className="nav-item fijado-item"
                onClick={() => alAbrirProyecto?.(p)}
                title={`Abrir ${p.nombreVentana ?? p.nombre}${p.avance ? ` · ${p.avance.etapa} ${p.avance.porcentaje} %` : ''}`}
              >
                <span className="punto-color" style={{ background: hexDe(p.color) }} aria-hidden="true" />
                <span className="nombre">{p.nombreVentana ?? p.nombre}</span>
                {p.avance && p.avance.porcentaje < 100 && p.avance.porcentaje > 0 && <span className="porcentaje">{p.avance.porcentaje} %</span>}
              </button>
            ))}
          </>
        )}
        <div className="lateral-seccion">Administración</div>
        {ADMINISTRACION.map(item)}
        <div className="lateral-tema">
          <span>Tema</span>
          <SelectorTema compacto />
        </div>
        <div className="lateral-pie">
          <div className="avatar" aria-hidden="true">
            {iniciales(usuario.nombre)}
          </div>
          <div className="datos">
            <strong>{usuario.nombre}</strong>
            <span>{usuario.rol === 'admin' ? 'Administrador' : 'Usuario'}</span>
          </div>
          <button className="boton-icono" onClick={alSalir} aria-label="Cerrar sesión" title="Cerrar sesión">
            <IconoSalir />
          </button>
        </div>
      </nav>
      <main className="contenido">{children}</main>
    </div>
  );
}
