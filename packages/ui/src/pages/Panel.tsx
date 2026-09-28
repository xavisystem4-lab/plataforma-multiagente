import type { UsuarioPublico } from '@softgala/shared';
import { IconoPlay } from '../components/Iconos';

const FASES: { id: string; nombre: string; estado: 'lista' | 'actual' | 'pendiente' }[] = [
  { id: 'F0', nombre: 'Base del sistema, login seguro y tema visual', estado: 'lista' },
  { id: 'F1', nombre: 'Proyectos de GitHub, agentes y bóveda de claves', estado: 'actual' },
  { id: 'F2', nombre: 'Orquestador, sandbox y progreso en tiempo real', estado: 'pendiente' },
  { id: 'F3', nombre: 'Colaboración multiagente con coordinador', estado: 'pendiente' },
  { id: 'F4', nombre: 'Revisión de cambios, aprobación y reversión', estado: 'pendiente' },
  { id: 'F5', nombre: 'Instalador de Windows y APK de Android', estado: 'pendiente' },
  { id: 'F6', nombre: 'Despliegue remoto y endurecimiento', estado: 'pendiente' },
];

const ETIQUETA_FASE = {
  lista: <span className="etiqueta etiqueta-exito">Completada</span>,
  actual: <span className="etiqueta etiqueta-marino">Siguiente</span>,
  pendiente: <span className="etiqueta">Pendiente</span>,
};

export function Panel({ usuario }: { usuario: UsuarioPublico }) {
  const nombre = usuario.nombre.split(' ')[0];
  return (
    <>
      <div className="encabezado">
        <div>
          <h1>Hola, {nombre}</h1>
          <p>Resumen de tus proyectos y agentes.</p>
        </div>
      </div>

      <section className="continuar" aria-label="Continuar proyecto">
        <div>
          <h2>Continuar proyecto</h2>
          <p>
            Reanuda el trabajo en el servidor remoto con los agentes que elijas. Se habilitará cuando conectes un
            proyecto y configures al menos un agente.
          </p>
        </div>
        <button className="boton boton-grande" disabled title="Disponible en la fase F2">
          <IconoPlay /> Continuar proyecto
        </button>
      </section>

      <div className="rejilla" style={{ marginBottom: 20 }}>
        <div className="tarjeta metrica">
          <span className="valor">0</span>
          <span className="nombre">Proyectos conectados</span>
        </div>
        <div className="tarjeta metrica">
          <span className="valor">0</span>
          <span className="nombre">Agentes configurados</span>
        </div>
        <div className="tarjeta metrica">
          <span className="valor">0</span>
          <span className="nombre">Aprobaciones pendientes</span>
        </div>
      </div>

      <section className="tarjeta">
        <h2>Plan de implementación</h2>
        <p>Estado real de cada fase de la plataforma.</p>
        <ul className="fases">
          {FASES.map((f) => (
            <li key={f.id}>
              <span className="fase-id">{f.id}</span>
              <span className="fase-nombre">{f.nombre}</span>
              {ETIQUETA_FASE[f.estado]}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
