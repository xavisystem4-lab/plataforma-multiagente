import type { ArchivoDiff, DiffTarea, EstadoArchivoDiff } from '@softgala/shared';
import { useState } from 'react';

const ETIQUETA: Record<EstadoArchivoDiff, { texto: string; clase: string }> = {
  agregado: { texto: 'Nuevo', clase: 'etiqueta-exito' },
  modificado: { texto: 'Modificado', clase: 'etiqueta-marino' },
  eliminado: { texto: 'Eliminado', clase: 'etiqueta-error' },
  renombrado: { texto: 'Renombrado', clase: 'etiqueta-aviso' },
};

/** Clase de cada línea del parche unificado (encabezados, bloques, agregadas, eliminadas). */
function claseLinea(l: string): string {
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git') || l.startsWith('index ') || /^(new|deleted) file mode/.test(l) || l.startsWith('similarity') || l.startsWith('rename ')) {
    return 'd-meta';
  }
  if (l.startsWith('@@')) return 'd-bloque';
  if (l.startsWith('+')) return 'd-mas';
  if (l.startsWith('-')) return 'd-menos';
  return '';
}

function Archivo({ a, abierto: inicial }: { a: ArchivoDiff; abierto: boolean }) {
  const [abierto, setAbierto] = useState(inicial);
  // Se omite el encabezado técnico del parche; la ruta ya se muestra arriba.
  const lineas = a.parche.replace(/\n$/, '').split('\n').filter((l) => claseLinea(l) !== 'd-meta');
  return (
    <div className="diff-archivo">
      <button className="diff-cabecera" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
        <span className="diff-flecha" aria-hidden="true">
          {abierto ? '▾' : '▸'}
        </span>
        <span className="mono diff-ruta">
          {a.rutaAnterior ? `${a.rutaAnterior} → ` : ''}
          {a.ruta}
        </span>
        <span className={`etiqueta ${ETIQUETA[a.estado].clase}`}>{ETIQUETA[a.estado].texto}</span>
        <span className="diff-cifras">
          <span className="d-mas-t">+{a.adiciones}</span> <span className="d-menos-t">−{a.eliminaciones}</span>
        </span>
      </button>
      {abierto &&
        (a.binario ? (
          <p className="diff-nota">Archivo binario: no se muestra su contenido.</p>
        ) : (
          <>
            <pre className="diff-codigo">
              {lineas.map((l, i) => (
                <span key={i} className={`d-linea ${claseLinea(l)}`}>
                  {l || ' '}
                  {'\n'}
                </span>
              ))}
            </pre>
            {a.truncado && <p className="diff-nota">El cambio es muy grande: se muestra solo una parte.</p>}
          </>
        ))}
    </div>
  );
}

export function VisorDiff({ diff }: { diff: DiffTarea }) {
  if (!diff.archivos.length) return <p>No hay diferencias con la rama base.</p>;
  return (
    <div className="diff">
      <p className="diff-resumen">
        <span className="mono">{diff.rama}</span> respecto a <span className="mono">{diff.base}</span>: {diff.archivos.length} archivo(s),{' '}
        <span className="d-mas-t">+{diff.adiciones}</span> <span className="d-menos-t">−{diff.eliminaciones}</span>
      </p>
      {diff.truncado && <p className="diff-nota">Algunos archivos se recortaron por tamaño. Revisa el diff completo en GitHub después de publicar.</p>}
      {diff.archivos.map((a, i) => (
        <Archivo key={a.ruta} a={a} abierto={i < 5} />
      ))}
    </div>
  );
}
