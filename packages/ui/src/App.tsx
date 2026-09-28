import { useState } from 'react';
import { BarraTitulo } from './components/BarraTitulo';
import { Shell, type Pagina } from './components/Shell';
import { ProveedorSesion, useSesion } from './lib/sesion';
import { Agentes } from './pages/Agentes';
import { Auditoria } from './pages/Auditoria';
import { Login } from './pages/Login';
import { Modelos } from './pages/Modelos';
import { Panel } from './pages/Panel';
import { Proyectos } from './pages/Proyectos';
import { Seguridad } from './pages/Seguridad';

function Contenido() {
  const { estado, salir } = useSesion();
  const [pagina, setPagina] = useState<Pagina>('panel');

  if (estado.fase === 'cargando') return <div className="centro">Cargando…</div>;
  if (estado.fase === 'anonimo') return <Login aviso={estado.aviso} />;

  const { usuario } = estado;
  return (
    <Shell usuario={usuario} pagina={pagina} alNavegar={setPagina} alSalir={() => void salir()}>
      {pagina === 'panel' && <Panel usuario={usuario} irA={setPagina} />}
      {pagina === 'proyectos' && <Proyectos />}
      {pagina === 'agentes' && <Agentes irA={setPagina} />}
      {pagina === 'modelos' && <Modelos />}
      {pagina === 'auditoria' && <Auditoria usuario={usuario} />}
      {pagina === 'seguridad' && <Seguridad />}
    </Shell>
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
