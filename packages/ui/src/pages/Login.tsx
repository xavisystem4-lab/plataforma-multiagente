import { MARCA } from '@softgala/shared';
import { useState, type FormEvent } from 'react';
import { IconoAlerta, IconoCheck, IconoOjo, IconoOjoTachado } from '../components/Iconos';
import { Logo } from '../components/Logo';
import { SelectorTema } from '../components/SelectorTema';
import { ErrorCliente } from '../lib/api';
import { useSesion } from '../lib/sesion';
import '../styles/login.css';

export function Login({ aviso }: { aviso?: string }) {
  const { iniciar, api } = useSesion();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verPassword, setVerPassword] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editandoServidor, setEditandoServidor] = useState(false);
  const [servidor, setServidor] = useState(api.servidor);
  const [errorServidor, setErrorServidor] = useState<string | null>(null);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await iniciar(email, password);
    } catch (err) {
      setError(err instanceof ErrorCliente ? err.message : 'No se pudo iniciar sesión.');
      setPassword('');
    } finally {
      setEnviando(false);
    }
  }

  async function guardarServidor(e: FormEvent) {
    e.preventDefault();
    try {
      await api.cambiarServidor(servidor);
      setServidor(api.servidor);
      setErrorServidor(null);
      setEditandoServidor(false);
    } catch (err) {
      setErrorServidor(err instanceof ErrorCliente ? err.message : 'Dirección no válida');
    }
  }

  return (
    <main className="login">
      <section className="login-marca" aria-label="Presentación">
        <div className="login-logo">
          <Logo tamano={40} claro />
          <span>{MARCA.producto}</span>
        </div>
        <div>
          <h1>Tus proyectos siguen avanzando, aunque cierres la laptop.</h1>
          <p>Coordina agentes de IA desde Windows o Android, revisa cada cambio y aprueba lo importante.</p>
          <ul className="login-puntos">
            <li>
              <IconoCheck /> Ejecución remota y aislada por proyecto
            </li>
            <li>
              <IconoCheck /> Varios agentes colaborando con límites claros
            </li>
            <li>
              <IconoCheck /> Tú apruebas los cambios antes de integrarlos
            </li>
          </ul>
        </div>
        <span className="login-version">Versión {__VERSION_APP__}</span>
      </section>

      <section className="login-panel">
        <div className="login-tema">
          <span>Tema</span>
          <SelectorTema />
        </div>
        <div className="login-contenido">
          <div className="login-tarjeta">
            <header>
              <h2>Iniciar sesión</h2>
              <p>Ingresa con tu cuenta para continuar.</p>
            </header>

            {aviso && !error && (
              <div className="alerta alerta-aviso" role="status">
                <IconoAlerta /> {aviso}
              </div>
            )}
            {error && (
              <div className="alerta alerta-error" role="alert">
                <IconoAlerta /> {error}
              </div>
            )}

            <form onSubmit={enviar} noValidate>
              <div className="campo">
                <label htmlFor="email">Correo electrónico</label>
                <input
                  id="email"
                  className="entrada"
                  type="email"
                  autoComplete="username"
                  placeholder="nombre@empresa.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="campo">
                <label htmlFor="password">Contraseña</label>
                <div className="entrada-con-boton">
                  <input
                    id="password"
                    className="entrada"
                    type={verPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setVerPassword((v) => !v)}
                    aria-label={verPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  >
                    {verPassword ? <IconoOjoTachado /> : <IconoOjo />}
                  </button>
                </div>
              </div>
              <button
                className="boton boton-primario boton-grande"
                type="submit"
                disabled={enviando || !email || !password}
              >
                {enviando ? <span className="girando" aria-label="Iniciando sesión" /> : 'Iniciar sesión'}
              </button>
            </form>

            <div className="login-servidor">
              {editandoServidor ? (
                <>
                  <form onSubmit={guardarServidor}>
                    <input
                      className="entrada"
                      aria-label="Dirección del servidor"
                      value={servidor}
                      onChange={(e) => setServidor(e.target.value)}
                      placeholder="https://mi-servidor.com"
                    />
                    <button className="boton" type="submit">
                      Guardar
                    </button>
                  </form>
                  {errorServidor && <span style={{ color: 'var(--error)' }}>{errorServidor}</span>}
                </>
              ) : (
                <div className="login-servidor-fila">
                  <span>
                    Servidor: <code>{api.servidor}</code>
                  </span>
                  <button className="boton boton-texto" type="button" onClick={() => setEditandoServidor(true)}>
                    Cambiar
                  </button>
                </div>
              )}
            </div>
          </div>

          <p className="credito">{MARCA.credito}</p>
        </div>
      </section>
    </main>
  );
}
