import { useState } from 'react';
import { BarraTitulo } from './components/BarraTitulo';
import { Shell, type Pagina } from './components/Shell';
import { ProveedorSesion, useSesion } from './lib/sesion';
import { ProveedorTiempoReal } from './lib/tiempoReal';
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
      <Shell usuario={usuario} pagina={pagina} alNavegar={navegar} alSalir={() => void salir()}>
        {pagina === 'panel' && <Panel usuario={usuario} irA={navegar} abrirTarea={abrirTarea} />}
        {pagina === 'tareas' && <Tareas abierta={tareaAbierta} alAbrir={abrirTarea} />}
        {pagina === 'proyectos' && <Proyectos />}
        {pagina === 'agentes' && <Agentes irA={navegar} />}
        {pagina === 'modelos' && <Modelos />}
        {pagina === 'auditoria' && <Auditoria usuario={usuario} />}
        {pagina === 'seguridad' && <Seguridad />}
      </Shell>
    </ProveedorTiempoReal>
  );
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
