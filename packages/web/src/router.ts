export type Route =
  | { kind: 'main' }
  | { kind: 'forms' }
  | { kind: 'packs'; name?: string }
  | { kind: 'console' };

/** 把 pathname 映射成一个页面；深链 /packs/<scope>/<name> 带出包名。 */
export function routeFor(pathname: string): Route {
  const path = pathname || '/';
  if (path.startsWith('/forms')) return { kind: 'forms' };
  if (path.startsWith('/console')) return { kind: 'console' };
  if (path.startsWith('/packs')) {
    const name = path.replace(/^\/packs\/?/, '').replace(/\/+$/, '') || undefined;
    return { kind: 'packs', ...(name ? { name } : {}) };
  }
  return { kind: 'main' };
}

/** 站内链接才接管；外部链接、带 target/download、修饰键点击仍交给浏览器。 */
export function isInternalLink(anchor: {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}): string | null {
  const href = anchor.getAttribute('href');
  if (!href || !href.startsWith('/')) return null;
  if (anchor.getAttribute('target')) return null;
  if (anchor.hasAttribute('download')) return null;
  return href;
}
