import type { UsuarioPublico } from '@softgala/shared';
import { useCallback } from 'react';
import { Alerta } from '../components/Comunes';
import { IconoCheck, IconoPlay } from '../components/Iconos';
import type { Pagina } from '../components/Shell';
import { useDatos } from '../lib/datos';
import { useSesion } from '../lib/sesion';

const FASES: { id: string; nombre: string; estado: 'lista' | 'actual' | 'pendiente' }[] = [
  { id: 'F0', nombre: 'Base del sistema, login seguro y tema visual', estado: 'lista' },
  { id: 'F1', nombre: 'Proyectos de GitHub, agentes y bóveda de claves', estado: 'lista' },
  { id: 'F2', nombre: 'Orquestador, sandbox y progreso en tiempo real', estado: 'actual' },
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

export function Panel({ usuario, irA }: { usuario: UsuarioPublico; irA(p: Pagina): void }) {
  const { api } = useSesion();
  const { datos: r, error } = useDatos(useCallback(() => api.resumen(), [api]));
  const nombre = usuario.nombre.split(' ')[0];

  const pasos = [
    { hecho: (r?.proveedores ?? 0) > 0, texto: 'Agrega un proveedor de modelos', pagina: 'modelos' as const },
    { hecho: (r?.agentes ?? 0) > 0, texto: 'Crea tus agentes', pagina: 'agentes' as const },
    { hecho: (r?.proyectos ?? 0) > 0, texto: 'Conecta un proyecto de GitHub', pagina: 'proyectos' as const },
  ];

  return (
    <>
      <div className="encabezado">
        <div>
          <h1>Hola, {nombre}</h1>
          <p>Resumen de tus proyectos y agentes.</p>
        </div>
      </div>
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alerta>{error}</Alerta>
        </div>
      )}

      <section className="continuar" aria-label="Continuar proyecto">
        <div>
          <h2>Continuar proyecto</h2>
          <p>
            Reanuda el trabajo en el servidor remoto con los agentes que elijas. La ejecución llega en la fase F2
            (orquestador y sandbox).
          </p>
        </div>
        <button className="boton boton-grande" disabled title="Disponible en la fase F2">
          <IconoPlay /> Continuar proyecto
        </button>
      </section>

      <div className="rejilla" style={{ marginBottom: 20 }}>
        <button className="tarjeta metrica tarjeta-clic" onClick={() => irA('proyectos')}>
          <span className="valor">{r?.proyectos ?? '—'}</span>
          <span className="nombre">Proyectos conectados</span>
        </button>
        <button className="tarjeta metrica tarjeta-clic" onClick={() => irA('agentes')}>
          <span className="valor">{r ? `${r.agentesActivos}/${r.agentes}` : '—'}</span>
          <span className="nombre">Agentes activos</span>
        </button>
        <button className="tarjeta metrica tarjeta-clic" onClick={() => irA('modelos')}>
          <span className="valor">{r?.proveedores ?? '—'}</span>
          <span className="nombre">Proveedores de modelos</span>
        </button>
      </div>

      <div className="detalle">
        {r && pasos.some((p) => !p.hecho) && (
          <section className="tarjeta">
            <h2>Primeros pasos</h2>
            <ul className="fases">
              {pasos.map((p) => (
                <li key={p.texto}>
                  <IconoCheck style={{ color: p.hecho ? 'var(--exito)' : 'var(--gris-300)' }} />
                  <span className="fase-nombre" style={{ textDecoration: p.hecho ? 'line-through' : undefined }}>
                    {p.texto}
                  </span>
                  {!p.hecho && (
                    <button className="boton boton-chico" onClick={() => irA(p.pagina)}>
                      Ir
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

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
      </div>
    </>
  );
}
