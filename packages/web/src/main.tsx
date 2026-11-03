import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { FormsDemo } from './forms/FormsDemo.tsx';
import './styles.css';

const isForms = window.location.pathname.startsWith('/forms');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isForms ? <FormsDemo /> : <App />}</StrictMode>,
);
