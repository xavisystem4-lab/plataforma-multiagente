import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { detectarPlataforma } from './lib/plataforma';
import { aplicarTema, leerPreferencia, resolverTema } from './lib/tema';
import './styles/tema.css';
import './styles/app.css';
import './styles/componentes.css';
import './styles/tema-oscuro.css';

// Permite ajustar estilos por plataforma (zonas seguras en Android, barra de título en Windows).
document.documentElement.classList.add(`plataforma-${detectarPlataforma()}`);
// El tema se aplica antes del primer render para evitar un destello del tema equivocado.
aplicarTema(resolverTema(leerPreferencia()));

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
