import { useCallback, useState, type ReactNode } from 'react';
import { BarraTitulo } from './components/BarraTitulo';
import { Shell, type Pagina } from './components/Shell';
import { ProveedorSesion, useSesion } from './lib/sesion';
import { useDatos } from './lib/datos';
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

function Contenido() {
  const { estado, salir, api } = useSesion();
  const [pagina, setPagina] = useState<Pagina>('panel');
  const [tareaAbierta, setTareaAbierta] = useState<string | null>(null);

  if (estado.fase === 'cargando') return <div className="centro">Cargando…</div>;
  if (estado.fase === 'anonimo') return <Login aviso={estado.aviso} />;

  const { usuario } = estado;
  const navegar = (p: Pagina) => {
    setPagina(p);
    if (p !== 'tareas') setTareaAbierta(null);
  };
  const abrirTarea = (id: string | null) => {
    setTareaAbierta(id);
    setPagina('tareas');
  };

  return (
    <ProveedorTiempoReal api={api}>
      <ShellConContadores usuario={usuario} pagina={pagina} alNavegar={navegar} alSalir={() => void salir()}>
        {pagina === 'panel' && <Panel usuario={usuario} irA={navegar} abrirTarea={abrirTarea} />}
        {pagina === 'tareas' && <Tareas abierta={tareaAbierta} alAbrir={abrirTarea} />}
        {pagina === 'aprobaciones' && <Aprobaciones abrirTarea={abrirTarea} />}
        {pagina === 'proyectos' && <Proyectos />}
        {pagina === 'agentes' && <Agentes irA={navegar} />}
        {pagina === 'modelos' && <Modelos />}
        {pagina === 'auditoria' && <Auditoria usuario={usuario} />}
        {pagina === 'seguridad' && <Seguridad />}
      </ShellConContadores>
    </ProveedorTiempoReal>
  );
}

/** Navegación con contadores (aprobaciones y preguntas pendientes) actualizados en tiempo real. */
function ShellConContadores(props: Omit<Parameters<typeof Shell>[0], 'contadores'> & { children: ReactNode }) {
  const { api } = useSesion();
  const { datos, recargar } = useDatos(useCallback(() => api.resumen(), [api]));
  useEventos((e) => {
    if (e.tipo.startsWith('approval.') || e.tipo.startsWith('task.')) void recargar();
  });
  return <Shell {...props} contadores={{ aprobaciones: datos?.aprobacionesPendientes ?? 0, tareas: datos?.tareasEsperando ?? 0 }} />;
}

export function App() {
  return (
    <ProveedorSesion>
      <div className="ventana">
        <BarraTitulo />
        <Contenido />
      </div>
    </ProveedorSesion>
  );
}
