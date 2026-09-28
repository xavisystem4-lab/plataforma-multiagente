import { COLORES_PROYECTO, type ColorProyecto } from '@softgala/shared';

const IDS = Object.keys(COLORES_PROYECTO) as ColorProyecto[];

/** Muestrario de colores para pintar la ventana y la tarjeta de un proyecto. */
export function SelectorColor({ valor, alCambiar }: { valor: ColorProyecto; alCambiar(c: ColorProyecto): void }) {
  return (
    <div className="selector-color" role="radiogroup" aria-label="Color del proyecto">
      {IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={valor === id}
          aria-label={COLORES_PROYECTO[id].nombre}
          title={COLORES_PROYECTO[id].nombre}
          className="muestra-color"
          style={{ background: COLORES_PROYECTO[id].hex }}
          onClick={() => alCambiar(id)}
        />
      ))}
    </div>
  );
}

export const hexDe = (c: ColorProyecto) => COLORES_PROYECTO[c]?.hex ?? COLORES_PROYECTO.marino.hex;
