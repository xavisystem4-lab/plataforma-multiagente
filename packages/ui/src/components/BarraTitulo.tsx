import { MARCA } from '@softgala/shared';
import { detectarPlataforma } from '../lib/plataforma';
import { Logo } from './Logo';

/** En Windows sustituye la barra nativa (los botones de ventana los dibuja el sistema a la derecha). */
export function BarraTitulo() {
  const plataforma = detectarPlataforma();
  if (plataforma === 'android') return null;
  return (
    <div className={`barra-titulo${plataforma === 'windows' ? ' con-controles' : ''}`}>
      <Logo tamano={18} />
      <strong>{MARCA.producto}</strong>
      <span>· SoftGala</span>
    </div>
  );
}
