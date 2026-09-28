import { App as AppNativa } from '@capacitor/app';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BarraTitulo } from './components/BarraTitulo';
import { Shell, type Pagina } from './components/Shell';
import { ProveedorSesion, useSesion } from './lib/sesion';
import { useDatos } from './lib/datos';
import { detectarPlataforma } from './lib/plataforma';
import { ProveedorTema } from './lib/tema';
import { ProveedorTiempoReal, useEventos } from './lib/tiempoReal';
import { Aprobaciones } from './pages/Aprobaciones';
import { Agentes } from './pages/Agentes';
import { Auditoria } from './pages/Auditoria';
import { Login } from './pages/Login';
import { Modelos } from './pages/Modelos';
import { Panel } from './pages/Panel';
import { Proyectos } from './pages/Proyectos';
import { Seguridad } from './pages/Seguridad';
import { Tareas } from './pages/Tareas';
import { VentanaProyecto } from './pages/VentanaProyecto';
import { abrirProyectoEnVentana, useCambioProyectos } from './lib/ventanas';
import type { ProyectoPublico } from '@softgala/shared';

function Contenido() {
  const { estado, salir, api } = useSesion();
  const [pagina, setPagina] = useState<Pagina>('panel');
  const [tareaAbierta, setTareaAbierta] = useState<string | null>(null);
  const [vistaProyecto, setVistaProyecto] = useState<string | null>(null);

  // Botón "atrás" de Android: cierra diálogos, vuelve de un detalle, al panel, o minimiza.
  // (Los hooks van antes de cualquier return: React exige el mismo orden en cada render.)
  useEffect(() => {
    if (detectarPlataforma() !== 'android') return;
    const oyente = AppNativa.addListener('backButton', () => {
      if (document.querySelector('.modal-fondo')) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      else if (tareaAbierta) setTareaAbierta(null);
      else if (vistaProyecto) setVistaProyecto(null);
      else if (pagina !== 'panel') setPagina('panel');
      else void AppNativa.minimizeApp();
    });
    return () => {
      void oyente.then((o) => o.remove());
    };
  }, [pagina, tareaAbierta, vistaProyecto]);

  if (estado.fase === 'cargando') return <div className="centro">Cargando…</div>;
  if (estado.fase === 'anonimo') return <Login aviso={estado.aviso} />;

  const { usuario } = estado;
  const navegar = (p: Pagina) => {
    setPagina(p);
    if (p !== 'tareas') setTareaAbierta(null);
    setVistaProyecto(null);
  };
  // En Windows cada proyecto se abre en su propia ventana; en Android y web, como una vista.
  const abrirProyecto = (p: ProyectoPublico) => {
    if (abrirProyectoEnVentana(p)) return;
    setVistaProyecto(p.id);
    setPagina('proyectos');
  };
  const abrirTarea = (id: string | null) => {
    setTareaAbierta(id);
    setPagina('tareas');
  };

  return (
    <ProveedorTiempoReal api={api}>
      <ShellConContadores usuario={usuario} pagina={pagina} alNavegar={navegar} alAbrirProyecto={abrirProyecto} alSalir={() => void salir()}>
        {pagina === 'panel' && <Panel usuario={usuario} irA={navegar} abrirTarea={abrirTarea} />}
        {pagina === 'tareas' && <Tareas abierta={tareaAbierta} alAbrir={abrirTarea} />}
        {pagina === 'aprobaciones' && <Aprobaciones abrirTarea={abrirTarea} />}
        {pagina === 'proyectos' &&
          (vistaProyecto ? (
            <VentanaProyecto key={vistaProyecto} proyectoId={vistaProyecto} alVolver={() => setVistaProyecto(null)} />
          ) : (
            <Proyectos alAbrirProyecto={abrirProyecto} />
          ))}
        {pagina === 'agentes' && <Agentes irA={navegar} />}
        {pagina === 'modelos' && <Modelos />}
        {pagina === 'auditoria' && <Auditoria usuario={usuario} />}
        {pagina === 'seguridad' && <Seguridad />}
      </ShellConContadores>
    </ProveedorTiempoReal>
  );
}

/**
 * Navegación con contadores (aprobaciones y preguntas pendientes) y proyectos fijados con su avance,
 * actualizados en tiempo real.
 */
function ShellConContadores(props: Omit<Parameters<typeof Shell>[0], 'contadores' | 'fijados'> & { children: ReactNode }) {
  const { api } = useSesion();
  const { datos, recargar } = useDatos(useCallback(() => api.resumen(), [api]));
  const proyectos = useDatos(useCallback(() => api.proyectos(), [api]));
  const recargarProyectos = proyectos.recargar;
  useEventos((e) => {
    if (e.tipo.startsWith('approval.') || e.tipo.startsWith('task.')) void recargar();
    if (e.tipo.startsWith('task.') || e.tipo.startsWith('subtask.')) void recargarProyectos();
  });
  useCambioProyectos(() => void recargarProyectos());
  return (
    <Shell
      {...props}
      contadores={{ aprobaciones: datos?.aprobacionesPendientes ?? 0, tareas: datos?.tareasEsperando ?? 0 }}
      fijados={proyectos.datos?.filter((p) => p.fijado) ?? []}
    />
  );
}

/** Ventana independiente de un proyecto (Windows): se abre con #/proyecto/<id>. */
function ContenidoVentana({ proyectoId }: { proyectoId: string }) {
  const { estado, api } = useSesion();
  if (estado.fase === 'cargando') return <div className="centro">Cargando…</div>;
  if (estado.fase === 'anonimo') return <div className="centro">Inicia sesión en la ventana principal para ver este proyecto.</div>;
  return (
    <ProveedorTiempoReal api={api}>
      <VentanaProyecto proyectoId={proyectoId} />
    </ProveedorTiempoReal>
  );
}

const RUTA_VENTANA = /^#\/proyecto\/([0-9a-f-]{36})$/i;

export function App() {
  const ventana = RUTA_VENTANA.exec(window.location.hash);
  if (ventana) {
    return (
      <ProveedorTema>
        <ProveedorSesion>
          <ContenidoVentana proyectoId={ventana[1]!} />
        </ProveedorSesion>
      </ProveedorTema>
    );
  }
  return (
    <ProveedorTema>
      <ProveedorSesion>
        <div className="ventana">
          <BarraTitulo />
          <Contenido />
        </div>
      </ProveedorSesion>
    </ProveedorTema>
  );
}
