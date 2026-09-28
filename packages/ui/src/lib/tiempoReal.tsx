import type { EventoTiempoReal, MensajeServidorWs } from '@softgala/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClienteApi } from './api';

type Oyente = (e: EventoTiempoReal) => void;

interface ContextoTiempoReal {
  conectado: boolean;
  suscribir(fn: Oyente): () => void;
}

const Contexto = createContext<ContextoTiempoReal>({ conectado: false, suscribir: () => () => {} });

/**
 * Mantiene un WebSocket con el servidor mientras la sesión esté abierta.
 * Al reconectar pide los eventos posteriores al último recibido, así no se pierde nada.
 * (En Android con la app cerrada no hay conexión; al volver se recupera lo pendiente.)
 */
export function ProveedorTiempoReal({ api, children }: { api: ClienteApi; children: ReactNode }) {
  const [conectado, setConectado] = useState(false);
  const oyentes = useRef(new Set<Oyente>());
  const ultimoSeq = useRef<number | undefined>(undefined);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reintento: ReturnType<typeof setTimeout> | undefined;
    let latido: ReturnType<typeof setInterval> | undefined;
    let espera = 1000;
    let activo = true;

    const conectar = async () => {
      let token: string;
      try {
        token = await api.tokenAcceso();
      } catch {
        programar();
        return;
      }
      if (!activo) return;
      ws = new WebSocket(api.urlTiempoReal());
      ws.onopen = () => ws?.send(JSON.stringify({ tipo: 'autenticar', token, desde: ultimoSeq.current }));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as MensajeServidorWs;
        if (msg.tipo === 'listo') {
          ultimoSeq.current = Math.max(ultimoSeq.current ?? 0, msg.ultimoSeq);
          setConectado(true);
          espera = 1000;
          latido = setInterval(() => ws?.send(JSON.stringify({ tipo: 'ping' })), 25_000);
        } else if (msg.tipo === 'evento') {
          if (ultimoSeq.current !== undefined && msg.evento.seq <= ultimoSeq.current) return;
          ultimoSeq.current = msg.evento.seq;
          oyentes.current.forEach((fn) => fn(msg.evento));
        }
      };
      ws.onclose = async (e) => {
        setConectado(false);
        clearInterval(latido);
        if (!activo) return;
        // 4401: token vencido o sesión revocada; se intenta renovar antes de reconectar.
        if (e.code === 4401 && !(await api.renovarAcceso().catch(() => false))) return;
        programar();
      };
    };
    const programar = () => {
      if (!activo) return;
      reintento = setTimeout(() => void conectar(), espera);
      espera = Math.min(espera * 2, 30_000);
    };

    void conectar();
    return () => {
      activo = false;
      clearTimeout(reintento);
      clearInterval(latido);
      ws?.close();
    };
  }, [api]);

  const suscribir = useCallback((fn: Oyente) => {
    oyentes.current.add(fn);
    return () => {
      oyentes.current.delete(fn);
    };
  }, []);

  return <Contexto.Provider value={{ conectado, suscribir }}>{children}</Contexto.Provider>;
}

export const useTiempoReal = () => useContext(Contexto);

/** Ejecuta `fn` con cada evento en vivo (usa la versión más reciente de `fn`). */
export function useEventos(fn: Oyente) {
  const { suscribir } = useTiempoReal();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => suscribir((e) => ref.current(e)), [suscribir]);
}
