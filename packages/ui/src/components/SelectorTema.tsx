import { useId, type MouseEvent } from 'react';
import { useTema, type PreferenciaTema } from '../lib/tema';

const OPCIONES: { valor: PreferenciaTema; texto: string }[] = [
  { valor: 'claro', texto: 'Claro' },
  { valor: 'oscuro', texto: 'Oscuro' },
  { valor: 'sistema', texto: 'Automático (según el sistema)' },
];

/**
 * Selector de tema: un "cielo" en miniatura. El orbe se desliza entre Claro, Oscuro y Automático;
 * el sol se convierte en luna, el cielo pasa del día a la noche y aparecen estrellas.
 * Al elegir, el nuevo tema se expande en círculo desde el botón.
 */
export function SelectorTema({ compacto = false }: { compacto?: boolean }) {
  const { preferencia, tema, cambiar } = useTema();
  const indice = OPCIONES.findIndex((o) => o.valor === preferencia);
  const mascara = `luna-${useId().replace(/:/g, '')}`;

  const elegir = (valor: PreferenciaTema) => (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    cambiar(valor, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };

  return (
    <div
      className={`selector-tema${compacto ? ' compacto' : ''} cielo-${tema}`}
      role="radiogroup"
      aria-label="Tema de la interfaz"
      style={{ ['--indice' as string]: indice }}
    >
      <span className="estrellas" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="orbe" aria-hidden="true">
        <svg viewBox="0 0 24 24" className={`astro astro-${preferencia === 'sistema' ? 'auto' : tema}`}>
          <defs>
            <mask id={mascara}>
              <rect width="24" height="24" fill="white" />
              <circle className="sombra-luna" cx="24" cy="4" r="8" fill="black" />
            </mask>
          </defs>
          <circle className="cuerpo" cx="12" cy="12" r="5.2" mask={`url(#${mascara})`} />
          <g className="rayos">
            {Array.from({ length: 8 }, (_, i) => (
              <line key={i} x1="12" y1="2.2" x2="12" y2="4.4" transform={`rotate(${i * 45} 12 12)`} />
            ))}
          </g>
          <path className="mitad" d="M12 6.8a5.2 5.2 0 0 1 0 10.4z" />
        </svg>
      </span>
      {OPCIONES.map((o) => (
        <button
          key={o.valor}
          type="button"
          role="radio"
          aria-checked={preferencia === o.valor}
          aria-label={o.texto}
          title={o.texto}
          className="opcion-tema"
          onClick={elegir(o.valor)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {o.valor === 'claro' && (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
              </>
            )}
            {o.valor === 'oscuro' && <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}
            {o.valor === 'sistema' && (
              <>
                <circle cx="12" cy="12" r="8" />
                <path d="M12 4a8 8 0 0 1 0 16z" className="relleno" />
              </>
            )}
          </svg>
        </button>
      ))}
    </div>
  );
}
