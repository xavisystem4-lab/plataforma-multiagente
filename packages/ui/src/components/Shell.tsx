import type { UsuarioPublico } from '@softgala/shared';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  IconoAgentes,
  IconoAprobar,
  IconoAuditoria,
  IconoCandado,
  IconoPanel,
  IconoProyecto,
  IconoSalir,
  IconoTareas,
} from './Iconos';
import { Logo } from './Logo';

export type Pagina = 'panel' | 'seguridad';

interface ItemNav {
  id: Pagina | null;
  texto: string;
  Icono: ComponentType<SVGProps<SVGSVGElement>>;
  /** Fase en la que se habilita; se muestra deshabilitado hasta entonces. */
  fase?: string;
}

const PRINCIPAL: ItemNav[] = [
  { id: 'panel', texto: 'Panel', Icono: IconoPanel },
  { id: null, texto: 'Proyectos', Icono: IconoProyecto, fase: 'F1' },
  { id: null, texto: 'Agentes', Icono: IconoAgentes, fase: 'F1' },
  { id: null, texto: 'Tareas', Icono: IconoTareas, fase: 'F2' },
  { id: null, texto: 'Aprobaciones', Icono: IconoAprobar, fase: 'F4' },
];
const ADMINISTRACION: ItemNav[] = [
  { id: null, texto: 'Auditoría', Icono: IconoAuditoria, fase: 'F1' },
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
  pagina: Pagina;
  alNavegar(p: Pagina): void;
  alSalir(): void;
  children: ReactNode;
}

export function Shell({ usuario, pagina, alNavegar, alSalir, children }: Props) {
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
        <div className="lateral-seccion">Administración</div>
        {ADMINISTRACION.map(item)}
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
