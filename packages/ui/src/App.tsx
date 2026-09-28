import { useState } from 'react';
import { BarraTitulo } from './components/BarraTitulo';
import { Shell, type Pagina } from './components/Shell';
import { ProveedorSesion, useSesion } from './lib/sesion';
import { Login } from './pages/Login';
import { Panel } from './pages/Panel';
import { Seguridad } from './pages/Seguridad';

function Contenido() {
  const { estado, salir } = useSesion();
  const [pagina, setPagina] = useState<Pagina>('panel');

  if (estado.fase === 'cargando') return <div className="centro">Cargando…</div>;
  if (estado.fase === 'anonimo') return <Login aviso={estado.aviso} />;

  return (
    <Shell usuario={estado.usuario} pagina={pagina} alNavegar={setPagina} alSalir={() => void salir()}>
      {pagina === 'panel' && <Panel usuario={estado.usuario} />}
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
