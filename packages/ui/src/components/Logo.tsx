/** Isotipo: nodos conectados (agentes colaborando) sobre un cuadro azul marino. */
export function Logo({ tamano = 36, claro = false }: { tamano?: number; claro?: boolean }) {
  const fondo = claro ? '#ffffff' : '#13294b';
  const trazo = claro ? '#13294b' : '#ffffff';
  return (
    <svg width={tamano} height={tamano} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill={fondo} />
      <g stroke={trazo} strokeWidth="1.8" strokeLinecap="round" opacity="0.55">
        <path d="M20 12L12 26M20 12l8 14M12 26h16" />
      </g>
      <circle cx="20" cy="12" r="4" fill={trazo} />
      <circle cx="12" cy="26" r="3.6" fill="#3a66a8" stroke={trazo} strokeWidth="1.6" />
      <circle cx="28" cy="26" r="3.6" fill="#3a66a8" stroke={trazo} strokeWidth="1.6" />
    </svg>
  );
}
