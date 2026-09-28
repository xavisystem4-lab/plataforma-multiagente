import type { UsuarioPublico } from '@softgala/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ClienteApi, ErrorCliente } from './api';
import { crearAlmacen } from './plataforma';

type Estado =
  | { fase: 'cargando' }
  | { fase: 'anonimo'; aviso?: string }
  | { fase: 'autenticado'; usuario: UsuarioPublico };

interface ContextoSesion {
  estado: Estado;
  api: ClienteApi;
  iniciar(email: string, password: string): Promise<void>;
  salir(): Promise<void>;
}

const Contexto = createContext<ContextoSesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const api = useMemo(() => new ClienteApi(crearAlmacen()), []);
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' });

  useEffect(() => {
    api.alExpirar = () => setEstado({ fase: 'anonimo', aviso: 'Tu sesión terminó. Inicia sesión de nuevo.' });
    (async () => {
      await api.cargarServidor();
      try {
        const usuario = await api.restaurar();
        setEstado(usuario ? { fase: 'autenticado', usuario } : { fase: 'anonimo' });
      } catch (err) {
        setEstado({ fase: 'anonimo', aviso: err instanceof ErrorCliente ? err.message : undefined });
      }
    })();
  }, [api]);

  const iniciar = useCallback(
    async (email: string, password: string) => {
      const usuario = await api.login(email, password);
      setEstado({ fase: 'autenticado', usuario });
    },
    [api],
  );

  const salir = useCallback(async () => {
    await api.logout();
    setEstado({ fase: 'anonimo' });
  }, [api]);

  return <Contexto.Provider value={{ estado, api, iniciar, salir }}>{children}</Contexto.Provider>;
}

export function useSesion(): ContextoSesion {
  const c = useContext(Contexto);
  if (!c) throw new Error('useSesion debe usarse dentro de ProveedorSesion');
  return c;
}
