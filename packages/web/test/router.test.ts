import { describe, expect, it } from 'vitest';
import { isInternalLink, routeFor } from '../src/router.ts';

describe('前端路由', () => {
  it('按 pathname 分出页面与包名', () => {
    expect(routeFor('/')).toEqual({ kind: 'main' });
    expect(routeFor('/packs')).toEqual({ kind: 'packs' });
    expect(routeFor('/packs/lvlc233/team-conventions')).toEqual({
      kind: 'packs',
      name: 'lvlc233/team-conventions',
    });
    expect(routeFor('/packs/lvlc233/team-conventions/')).toEqual({
      kind: 'packs',
      name: 'lvlc233/team-conventions',
    });
    expect(routeFor('/console')).toEqual({ kind: 'console' });
    expect(routeFor('/forms/a')).toEqual({ kind: 'forms' });
    expect(routeFor('/unknown')).toEqual({ kind: 'main' });
  });

  it('只接管站内链接', () => {
    const link = (href: string | null, target = false, download = false) => ({
      getAttribute: (name: string) => (name === 'href' ? href : name === 'target' ? (target ? '_blank' : null) : null),
      hasAttribute: (name: string) => name === 'download' && download,
    });
    expect(isInternalLink(link('/packs/x'))).toBe('/packs/x');
    expect(isInternalLink(link('https://example.com'))).toBeNull();
    expect(isInternalLink(link('/packs/x', true))).toBeNull();
    expect(isInternalLink(link('/a.phub', false, true))).toBeNull();
    expect(isInternalLink(link(null))).toBeNull();
  });
});
