import { MAX_SEGUNDOS_AUDIO, type AjustesVoz } from '@softgala/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClienteApi } from '../lib/api';
import { mensajeError } from '../lib/datos';
import { useSesion } from '../lib/sesion';
import '../styles/voz.css';

/** Formatos en orden de preferencia; Chromium (Electron y WebView de Android) graba webm/opus. */
const FORMATOS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

let ajustesEnCache: Promise<AjustesVoz> | null = null;
const ajustesVoz = (api: ClienteApi) => (ajustesEnCache ??= api.ajustesVoz().catch((e) => {
  ajustesEnCache = null;
  throw e;
}));
/** Tras cambiar los ajustes de voz, los micrófonos vuelven a consultarlos. */
export const invalidarAjustesVoz = () => {
  ajustesEnCache = null;
};

type Fase = 'inactivo' | 'preparando' | 'grabando' | 'transcribiendo';

/**
 * Dictado por voz: graba, envía el audio al servidor para transcribirlo y entrega el texto.
 * El texto solo se agrega al campo; el usuario lo revisa y decide si lo envía.
 */
export function BotonVoz({ alTexto, deshabilitado = false }: { alTexto(texto: string): void; deshabilitado?: boolean }) {
  const { api } = useSesion();
  const [fase, setFase] = useState<Fase>('inactivo');
  const [segundos, setSegundos] = useState(0);
  const [aviso, setAviso] = useState<ReactNode>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const grabacion = useRef<{ detener(enviar: boolean): void } | null>(null);

  // Si el componente desaparece (se cierra el diálogo), se corta el micrófono sin enviar nada.
  useEffect(() => () => grabacion.current?.detener(false), []);

  useEffect(() => {
    if (fase !== 'grabando') return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        grabacion.current?.detener(false);
      }
    };
    window.addEventListener('keydown', alTeclear, true);
    return () => window.removeEventListener('keydown', alTeclear, true);
  }, [fase]);

  async function iniciar() {
    setAviso(null);
    setFase('preparando');
    try {
      const ajustes = await ajustesVoz(api);
      if (!ajustes.disponible) {
        setAviso('Configura la voz en Modelos IA → Instrucciones por voz.');
        setFase('inactivo');
        return;
      }
    } catch (err) {
      setAviso(mensajeError(err));
      setFase('inactivo');
      return;
    }

    let flujo: MediaStream;
    try {
      flujo = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const nombre = (err as DOMException).name;
      setAviso(
        nombre === 'NotAllowedError' || nombre === 'SecurityError'
          ? 'Permiso de micrófono denegado. Actívalo en la configuración del sistema.'
          : nombre === 'NotFoundError'
            ? 'No se encontró ningún micrófono.'
            : 'No se pudo abrir el micrófono.',
      );
      setFase('inactivo');
      return;
    }

    const formato = FORMATOS.find((f) => MediaRecorder.isTypeSupported(f));
    const grabador = new MediaRecorder(flujo, formato ? { mimeType: formato } : undefined);
    const partes: Blob[] = [];
    let enviar = true;
    const inicio = Date.now();

    // Nivel de voz: anima el anillo del botón (sin guardar nada).
    const audioCtx = new AudioContext();
    const analizador = audioCtx.createAnalyser();
    analizador.fftSize = 256;
    audioCtx.createMediaStreamSource(flujo).connect(analizador);
    const muestras = new Uint8Array(analizador.frequencyBinCount);
    let cuadro = 0;
    const animar = () => {
      analizador.getByteTimeDomainData(muestras);
      let suma = 0;
      for (const m of muestras) suma += ((m - 128) / 128) ** 2;
      const nivel = Math.min(1, Math.sqrt(suma / muestras.length) * 4);
      boton.current?.style.setProperty('--nivel-voz', nivel.toFixed(3));
      const s = Math.floor((Date.now() - inicio) / 1000);
      setSegundos(s);
      if (s >= MAX_SEGUNDOS_AUDIO) detener(true);
      else cuadro = requestAnimationFrame(animar);
    };

    function detener(conEnvio: boolean) {
      enviar = conEnvio;
      cancelAnimationFrame(cuadro);
      if (grabador.state !== 'inactive') grabador.stop();
      flujo.getTracks().forEach((t) => t.stop());
      void audioCtx.close();
      grabacion.current = null;
    }
    grabacion.current = { detener };

    grabador.ondataavailable = (e) => e.data.size > 0 && partes.push(e.data);
    grabador.onstop = async () => {
      if (!enviar) {
        setFase('inactivo');
        return;
      }
      const audio = new Blob(partes, { type: grabador.mimeType || 'audio/webm' });
      if (Date.now() - inicio < 600 || audio.size < 1000) {
        setAviso('La grabación fue muy corta.');
        setFase('inactivo');
        return;
      }
      setFase('transcribiendo');
      try {
        const { texto } = await api.transcribir(audio);
        if (texto) alTexto(texto);
        else setAviso('No se entendió nada en la grabación.');
      } catch (err) {
        setAviso(mensajeError(err));
      } finally {
        setFase('inactivo');
      }
    };

    grabador.start(250);
    setSegundos(0);
    setFase('grabando');
    cuadro = requestAnimationFrame(animar);
  }

  const grabando = fase === 'grabando';
  const ocupado = fase === 'preparando' || fase === 'transcribiendo';
  const etiqueta = grabando ? 'Detener y transcribir' : fase === 'transcribiendo' ? 'Transcribiendo…' : 'Dictar por voz';
  const restante = MAX_SEGUNDOS_AUDIO - segundos;

  return (
    <div className="voz">
      <button
        ref={boton}
        type="button"
        className={`boton-voz ${fase}`}
        onClick={() => (grabando ? grabacion.current?.detener(true) : void iniciar())}
        disabled={deshabilitado || ocupado}
        aria-label={etiqueta}
        aria-pressed={grabando}
        title={grabando ? 'Detener y transcribir (Esc cancela)' : etiqueta}
      >
        {fase === 'transcribiendo' ? <span className="giro" aria-hidden="true" /> : grabando ? <IconoDetener /> : <IconoMicrofono />}
      </button>
      {grabando && (
        <span className="voz-tiempo" aria-live="polite">
          <span className="punto-rojo" aria-hidden="true" />
          {Math.floor(segundos / 60)}:{String(segundos % 60).padStart(2, '0')}
          {restante <= 15 && <small> · quedan {restante} s</small>}
        </span>
      )}
      {fase === 'transcribiendo' && <span className="voz-tiempo">Transcribiendo…</span>}
      {aviso && (
        <span className="voz-aviso" role="status">
          {aviso}
        </span>
      )}
    </div>
  );
}

/** Campo de texto con micrófono: el texto dictado se agrega al final de lo que ya estaba escrito. */
export function TextoConVoz({
  children,
  alTexto,
  deshabilitado,
}: {
  children: ReactNode;
  alTexto(texto: string): void;
  deshabilitado?: boolean;
}) {
  return (
    <div className="texto-con-voz">
      {children}
      <BotonVoz alTexto={alTexto} deshabilitado={deshabilitado} />
    </div>
  );
}

/** Une el texto dictado al existente con un espacio o salto de línea según corresponda. */
export const agregarDictado = (actual: string, dictado: string) =>
  !actual.trim() ? dictado : /[\s]$/.test(actual) ? actual + dictado : `${actual} ${dictado}`;

const IconoMicrofono = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const IconoDetener = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);
