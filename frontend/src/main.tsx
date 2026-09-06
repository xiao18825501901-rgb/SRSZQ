import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Platform from './platform/Platform';
import './styles/global.css';
import './styles/tabletop.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Platform />
  </StrictMode>,
);
