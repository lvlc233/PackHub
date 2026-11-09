import { afterEach, describe, expect, it, vi } from 'vitest';

// forward.mjs 是纯 JS（不 import electron），仓库不为它生成 .d.ts；
// 这里只要运行时行为，交给 vitest 直接加载，类型上按 any 处理。
// @ts-expect-error forward.mjs 没有类型声明
import { forwardRequest, resolveApiUrl, sidecarOrigin } from '../forward.mjs';

/** 侧车只用到 origin：baseUrl 带不带尾斜杠、带不带路径都不影响。 */
const BASE = 'http://127.0.0.1:4500/';
const ORIGIN = 'http://127.0.0.1:4500';

type Captured = {
  url: string;
  init: { method?: string; headers: Record<string, string>; body?: string };
};

let captured: Captured | null = null;

/** 用 vi.stubGlobal 顶掉 fetch，顺便把实参抓下来。 */
function stubFetch(text: string, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: unknown, init: unknown) => {
    captured = {
      url: String(url),
      init: init as Captured['init'],
    };
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  captured = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sidecarOrigin', () => {
  it('只留 origin，非法地址返回 null', () => {
    expect(sidecarOrigin(`${BASE}web/index.html`)).toBe(ORIGIN);
    expect(sidecarOrigin('not a url')).toBeNull();
  });
});

describe('resolveApiUrl', () => {
  it('放行 /api/ 下的站内路径', () => {
    expect(resolveApiUrl(BASE, '/api/instances')).toBe(`${ORIGIN}/api/instances`);
    expect(resolveApiUrl(BASE, '/api/instances/x/health')).toBe(`${ORIGIN}/api/instances/x/health`);
    // baseUrl 的路径 / 尾斜杠不参与拼接
    expect(resolveApiUrl(`${ORIGIN}/somewhere`, '/api/instances')).toBe(`${ORIGIN}/api/instances`);
  });

  it('拒绝非字符串、空串与不在 /api/ 下的路径', () => {
    for (const bad of [123, null, undefined, {}, ['/api/x'], '', '/apix', '/api']) {
      expect(resolveApiUrl(BASE, bad as never)).toBeNull();
    }
  });

  it('拒绝越界/外部地址：归一化后必须仍在侧车 origin 的 /api/ 下', () => {
    expect(resolveApiUrl(BASE, '/api/../x')).toBeNull();
    expect(resolveApiUrl(BASE, '//evil.example/api/x')).toBeNull();
    expect(resolveApiUrl(BASE, 'http://evil.example/api/x')).toBeNull();
    // 反斜杠与裸控制字符会被 URL 解析器“修正”，实现直接拒
    expect(resolveApiUrl(BASE, '/api/x\\..\\y')).toBeNull();
    expect(resolveApiUrl(BASE, '/api/x\u0000y')).toBeNull();
  });

  it('baseUrl 不可用时一律 null', () => {
    expect(resolveApiUrl('not a url', '/api/instances')).toBeNull();
    expect(resolveApiUrl(undefined as never, '/api/instances')).toBeNull();
  });
});

describe('forwardRequest', () => {
  it('GET 正常：落到侧车 origin 的 /api/，自己补 origin 与 x-pal-client', async () => {
    stubFetch('[]');

    const result = await forwardRequest({
      baseUrl: BASE,
      path: '/api/instances',
      options: { method: 'GET' },
    });

    expect(result).toEqual({ ok: true, status: 200, text: '[]' });
    expect(captured).not.toBeNull();
    const { url, init } = captured!;
    expect(url.startsWith(`${ORIGIN}/api/`)).toBe(true);
    expect(url).toBe(`${ORIGIN}/api/instances`);
    expect(init.method).toBe('GET');
    expect(init.headers['x-pal-client']).toBe('pal-ui');
    expect(init.headers['origin']).toBe(ORIGIN);
  });

  it('渲染侧给的其它 header 不被信任', async () => {
    stubFetch('{}');

    await forwardRequest({
      baseUrl: BASE,
      path: '/api/instances',
      options: {
        method: 'GET',
        headers: {
          authorization: 'Bearer spoofed',
          cookie: 'session=spoofed',
          'x-pal-client': 'spoofed-client',
          origin: 'http://evil.example',
        },
      },
    });

    const headers = captured!.init.headers;
    expect(headers['authorization']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
    expect(headers['x-pal-client']).toBe('pal-ui');
    expect(headers['origin']).toBe(ORIGIN);
  });

  it('token：形状合法（32 hex）才带 x-pal-token', async () => {
    stubFetch('{}');
    const token = '0123456789abcdef0123456789abcdef';

    await forwardRequest({
      baseUrl: BASE,
      path: '/api/instances',
      // 渲染侧大小写不保证，实现按不区分大小写取
      options: { method: 'GET', headers: { 'X-Pal-Token': token } },
    });

    expect(captured!.init.headers['x-pal-token']).toBe(token);
  });

  it('token：非法形状不带（也不原样透传）', async () => {
    // 大写 hex、太短、非 hex、带空白之外的多余内容
    const bads = [
      '0123456789ABCDEF0123456789ABCDEF',
      'abc123',
      'x'.repeat(32),
      'token=0123456789abcdef0123456789abcdef',
    ];
    for (const bad of bads) {
      captured = null;
      stubFetch('{}');
      await forwardRequest({
        baseUrl: BASE,
        path: '/api/instances',
        options: { method: 'GET', headers: { 'x-pal-token': bad } },
      });
      expect(captured!.init.headers['x-pal-token']).toBeUndefined();
      expect(Object.values(captured!.init.headers)).not.toContain(bad);
      vi.unstubAllGlobals();
    }
  });

  it('方法白名单：CONNECT 等拒绝转发，且不发起 fetch', async () => {
    const fetchMock = stubFetch('{}');

    await expect(
      forwardRequest({
        baseUrl: BASE,
        path: '/api/instances',
        options: { method: 'CONNECT' },
      }),
    ).resolves.toEqual({ ok: false, error: expect.stringContaining('CONNECT') });

    expect(fetchMock).not.toHaveBeenCalled();

    for (const method of ['TRACE', 'OPTIONS', 'get ']) {
      await expect(
        forwardRequest({ baseUrl: BASE, path: '/api/instances', options: { method } }),
      ).resolves.toMatchObject({ ok: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('路径越界时同样不发起 fetch', async () => {
    const fetchMock = stubFetch('{}');

    await expect(
      forwardRequest({ baseUrl: BASE, path: '/api/../secret', options: { method: 'GET' } }),
    ).resolves.toEqual({ ok: false, error: expect.stringContaining('/api/') });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HTTP 500 原样带回 status 与 text', async () => {
    stubFetch('boom', 500);

    await expect(
      forwardRequest({ baseUrl: BASE, path: '/api/instances', options: { method: 'GET' } }),
    ).resolves.toEqual({ ok: false, status: 500, text: 'boom' });
  });

  it('网络错误转成 { ok:false, error }，不抛', async () => {
    const failure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(failure)));

    const result = await forwardRequest({
      baseUrl: BASE,
      path: '/api/instances',
      options: { method: 'GET' },
    });

    expect(result.ok).toBe(false);
    expect(typeof (result as { error: string }).error).toBe('string');
    expect((result as { error: string }).error).toContain('ECONNREFUSED');
  });

  it('baseUrl 不可用时直接返回 error', async () => {
    await expect(
      forwardRequest({ baseUrl: 'not a url', path: '/api/instances' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('侧车地址') });
  });
});
