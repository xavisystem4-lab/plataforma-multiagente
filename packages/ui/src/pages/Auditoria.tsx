import type { EntradaAuditoriaPublica, UsuarioPublico } from '@softgala/shared';
import { useCallback, useEffect, useState } from 'react';
import { Alerta, Encabezado, fecha } from '../components/Comunes';
import { mensajeError } from '../lib/datos';
import { useSesion } from '../lib/sesion';

const FILTROS = [
  { valor: '', texto: 'Todas las acciones' },
  { valor: 'auth.', texto: 'Inicio de sesión y sesiones' },
  { valor: 'proyecto.', texto: 'Proyectos' },
  { valor: 'agente.', texto: 'Agentes' },
  { valor: 'proveedor.', texto: 'Proveedores de modelos' },
  { valor: 'usuario.', texto: 'Usuarios' },
];

const ACCIONES: Record<string, string> = {
  'auth.login': 'Inicio de sesión',
  'auth.login_fallido': 'Intento de sesión fallido',
  'auth.login_bloqueado': 'Intento con cuenta bloqueada',
  'auth.cuenta_bloqueada': 'Cuenta bloqueada',
  'auth.logout': 'Cierre de sesión',
  'auth.sesion_revocada': 'Sesión revocada',
  'auth.refresh_reutilizado': 'Token reutilizado (sesión revocada)',
  'usuario.creado': 'Usuario creado',
  'proveedor.creado': 'Proveedor agregado',
  'proveedor.actualizado': 'Proveedor actualizado',
  'proveedor.eliminado': 'Proveedor eliminado',
  'proveedor.probado': 'Conexión probada',
  'agente.creado': 'Agente creado',
  'agente.actualizado': 'Agente actualizado',
  'agente.eliminado': 'Agente eliminado',
  'proyecto.conectado': 'Proyecto conectado',
  'proyecto.actualizado': 'Proyecto actualizado',
  'proyecto.token_rotado': 'Token de GitHub rotado',
  'proyecto.desconectado': 'Proyecto desconectado',
  'proyecto.agente_habilitado': 'Agente habilitado en proyecto',
  'proyecto.agente_deshabilitado': 'Agente deshabilitado en proyecto',
};

const ALERTAS = new Set(['auth.login_fallido', 'auth.cuenta_bloqueada', 'auth.refresh_reutilizado', 'auth.login_bloqueado']);

export function Auditoria({ usuario }: { usuario: UsuarioPublico }) {
  const { api } = useSesion();
  const [filtro, setFiltro] = useState('');
  const [entradas, setEntradas] = useState<EntradaAuditoriaPublica[]>([]);
  const [siguiente, setSiguiente] = useState<number | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(
    async (antesDe?: number) => {
      setCargando(true);
      try {
        const pagina = await api.auditoria({ accion: filtro || undefined, antesDe, limite: 50 });
        setEntradas((act) => (antesDe ? [...act, ...pagina.entradas] : pagina.entradas));
        setSiguiente(pagina.siguiente);
        setError(null);
      } catch (err) {
        setError(mensajeError(err));
      } finally {
        setCargando(false);
      }
    },
    [api, filtro],
  );

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <>
      <Encabezado
        titulo="Auditoría"
        texto={
          usuario.rol === 'admin'
            ? 'Registro inalterable de acciones de todos los usuarios.'
            : 'Registro inalterable de tus acciones.'
        }
      >
        <div className="filtros">
          <select className="entrada" aria-label="Filtrar por tipo de acción" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            {FILTROS.map((f) => (
              <option key={f.valor} value={f.valor}>
                {f.texto}
              </option>
            ))}
          </select>
        </div>
      </Encabezado>
      {error && (
        <div style={{ marginBottom: 16 }}>
          <Alerta>{error}</Alerta>
        </div>
      )}
      <section className="tarjeta" style={{ padding: 0 }}>
        <div className="tabla-contenedor">
          <table className="tabla">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acción</th>
                {usuario.rol === 'admin' && <th>Usuario</th>}
                <th>Detalle</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entradas.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fecha(e.fecha)}</td>
                  <td>
                    {ALERTAS.has(e.accion) ? (
                      <span className="etiqueta etiqueta-aviso">{ACCIONES[e.accion] ?? e.accion}</span>
                    ) : (
                      (ACCIONES[e.accion] ?? e.accion)
                    )}
                  </td>
                  {usuario.rol === 'admin' && <td>{e.usuarioEmail ?? '—'}</td>}
                  <td>
                    <div className="detalle-json" title={e.detalle ? JSON.stringify(e.detalle, null, 2) : ''}>
                      {e.detalle ? JSON.stringify(e.detalle) : '—'}
                    </div>
                  </td>
                  <td className="mono">{e.ip ?? '—'}</td>
                </tr>
              ))}
              {!cargando && entradas.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--texto-suave)', padding: 32 }}>
                    Sin registros para este filtro.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {siguiente && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="boton" onClick={() => void cargar(siguiente)} disabled={cargando}>
            {cargando ? 'Cargando…' : 'Cargar más'}
          </button>
        </div>
      )}
    </>
  );
}
