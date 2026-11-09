/* PAL 界面的唯一 API 入口（E2）。
 *
 * 页面里不直接 fetch：所有请求都从这里发出，具体走哪条传输由注入的 transport 决定。
 * 传输形状（唯一契约，E3 换传输时只换这一层）：
 *
 *   transport(path, request) -> Promise<{ ok, status, text }>
 *     path    : 形如 `/api/instances?x=1` 的站内路径
 *     request : { method, headers, body? }   body 已序列化成字符串
 *     结果    : HTTP 响应的归一化形态；网络层失败用 { ok: false, error } 表示（没有 status）
 *
 * 默认解析：Electron 里 preload 暴露了 `globalThis.pal.request`，优先用它（IPC）；
 * 否则退回同源 `fetch`（浏览器直接开 `pal serve` 的地址）。
 *
 * 本文件不依赖 DOM，可以在 Node 里用假 transport 直接跑。
 */

/** 把 fetch 的 Response 归一化成 transport 契约。 */
function fromFetch(path, request) {
  return globalThis.fetch(path, request).then(async (res) => ({
    ok: res.ok,
    status: res.status,
    text: await res.text(),
  }));
}

/** 默认 transport：Electron 走 IPC，浏览器走 fetch。每次调用时解析，避免加载顺序问题。 */
export function defaultTransport() {
  const request = globalThis.pal?.request;
  if (typeof request === 'function') {
    // preload 的签名就是 (path, options)，与 transport 契约一致
    return (path, options) => request(path, options);
  }
  return fromFetch;
}

/**
 * 用给定的 transport 造一个 api(path, options) 函数，语义与旧的本地 fetch 完全一致：
 *   - method 默认 GET，body 存在时按 JSON 序列化并补 content-type；
 *   - 每个请求都带 x-pal-client: pal-ui（服务端用它挡跨源写请求）；
 *   - 非 2xx 抛 Error，并把响应里的 hint / code 挂到错误上；
 *   - 响应不是 JSON 时回退成 { error: 原文前 400 字 }。
 */
export function createApi(transport) {
  return async function api(path, options = {}) {
    const { method = 'GET', body } = options;
    const send = transport ?? defaultTransport();
    const headers = { 'x-pal-client': 'pal-ui' };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const request = { method, headers, ...(payload === undefined ? {} : { body: payload }) };
    const res = await send(path, request);

    // 传输层失败（IPC 拒绝、连接断开）没有 status，只有 error
    if (!res || typeof res.status !== 'number') {
      throw new Error(String(res?.error || '请求失败：没有收到响应'));
    }

    const text = typeof res.text === 'string' ? res.text : '';
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 400) };
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.hint = data.hint || '';
      err.code = data.code || '';
      throw err;
    }
    return data;
  };
}

/** 页面用的单例。 */
export const api = createApi();
