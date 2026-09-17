import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Platform from './platform/Platform';
import './styles/refresh.css';
import './styles/ink.css';


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Platform />
  </StrictMode>,
);
