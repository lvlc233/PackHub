import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { FormsDemo } from './forms/FormsDemo.tsx';
import { PacksPage } from './packs/PacksPage.tsx';
import { ConsolePage } from './console/ConsolePage.tsx';
import './styles.css';

const path = window.location.pathname;
const isForms = path.startsWith('/forms');
const isPacks = path.startsWith('/packs');
const isConsole = path.startsWith('/console');
// /packs/<scope>/<name>
const packName = isPacks ? path.replace(/^\/packs\/?/, '') || undefined : undefined;

const page = isForms ? (
  <FormsDemo />
) : isPacks ? (
  <PacksPage name={packName} />
) : isConsole ? (
  <ConsolePage />
) : (
  <App />
);

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
