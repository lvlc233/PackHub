import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { FormsDemo } from './forms/FormsDemo.tsx';
import { PacksPage } from './packs/PacksPage.tsx';
import { ConsolePage } from './console/ConsolePage.tsx';
import { isInternalLink, routeFor } from './router.ts';
import './styles.css';

/** 一个最小的 history 路由：站内链接用 pushState，后退/前进走 popstate。 */
function Router() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest('a');
      if (!anchor) return;
      const href = isInternalLink(anchor);
      if (!href) return;
      event.preventDefault();
      if (href !== window.location.pathname) {
        window.history.pushState({}, '', href);
        setPath(href);
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const route = routeFor(path);
  if (route.kind === 'forms') return <FormsDemo />;
  if (route.kind === 'packs') return <PacksPage name={route.name} />;
  if (route.kind === 'console') return <ConsolePage />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);