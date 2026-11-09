/**
 * 主进程侧的转发器（E2）。纯函数：不 import electron，可以直接用 node 跑。
 *
 * 契约（与 web/api.js 的 transport 一致）：
 *   forwardRequest({ baseUrl, path, options }) -> Promise<{ ok, status, text } | { ok: false, error }>
 *
 * 放行规则：
 *   - 只允许 `/api/` 开头的站内路径；解析后的 URL 必须仍落在侧车 origin 且仍在 /api/ 下，
 *     免得 `/api/../x`、协议相对地址之类的输入把它变成任意 URL 读取器；
 *   - method 只允许 GET / HEAD / POST / PUT / PATCH / DELETE；
 *   - 请求头由这里自己拼：`x-pal-client: pal-ui` 与 `origin: <侧车 origin>`，不信任渲染侧传的
 *     header，保证 server.ts 的 isTrustedRequest 照旧生效；唯一的例外是渲染侧从页面 meta
 *     读到的 `x-pal-token`——只放行形状合法的值（B14：带 Origin 的请求必须带正确 token）；
 *   - 网络层失败（拒连、超时、被 abort）返回 `{ ok: false, error }`，HTTP 的 4xx/5xx 原样带回
 *     `{ ok: false, status, text }`，由页面统一转成 Error。
 */

const ORIGIN_HEADER = 'origin';
const CLIENT_HEADER = 'x-pal-client';
const CLIENT_VALUE = 'pal-ui';
const TOKEN_HEADER = 'x-pal-token';
/** 侧车 token 是 crypto.randomBytes(16).toString('hex')：32 位小写 hex；按形状先筛一遍。 */
const TOKEN_PATTERN = /^[0-9a-f]{16,}$/;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const API_PREFIX = '/api/';

/** 侧车地址的 origin；baseUrl 不合法时返回 null。 */
export function sidecarOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * 把渲染侧给的 path 变成完整的侧车 URL；不合法（非字符串、非 /api/、解析后越界）返回 null。
 */
export function resolveApiUrl(baseUrl, path) {
  const origin = sidecarOrigin(baseUrl);
  if (!origin || typeof path !== 'string' || !path.startsWith(API_PREFIX)) return null;
  // 反斜杠和裸控制字符在 URL 解析里会被“修正”，直接拒掉，别让两种解析器见仁见智
  if (path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return null;
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  // URL 会把 `/api/../x` 归一化成 `/x`，所以必须在归一化之后再查一次前缀
  if (!url.pathname.startsWith(API_PREFIX)) return null;
  return url.href;
}

/** 只接受 JSON 的 content-type，其余一律按 application/json。 */
function contentTypeOf(headers) {
  const value = headers && typeof headers === 'object' ? headers['content-type'] : undefined;
  if (typeof value === 'string' && /^application\/json\b/i.test(value.trim())) return value.trim();
  return 'application/json';
}

/** 按名字取渲染侧的头值；渲染侧大小写不一定稳定，这里不区分大小写。 */
function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** 渲染侧传来的 token：形状不合法就当没传（不把它原样塞给侧车）。 */
function tokenOf(headers) {
  const value = headerOf(headers, TOKEN_HEADER);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return TOKEN_PATTERN.test(trimmed) ? trimmed : '';
}

/** 把 transport 的 request 组装成 fetch 参数；不合法时返回 { error }。 */
function buildRequest(origin, options) {
  const src = options && typeof options === 'object' ? options : {};
  const method = typeof src.method === 'string' && src.method ? src.method.toUpperCase() : 'GET';
  if (!ALLOWED_METHODS.has(method)) return { error: `拒绝转发：不支持的方法 ${method}` };

  const headers = {
    [ORIGIN_HEADER]: origin,
    [CLIENT_HEADER]: CLIENT_VALUE,
  };

  // 页面在 Electron 里同样从 meta 读 token；只转这一条，其它渲染侧头继续忽略
  const token = tokenOf(src.headers);
  if (token) headers[TOKEN_HEADER] = token;

  const init = { method, headers };
  if (src.body !== undefined && src.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof src.body !== 'string') return { error: '拒绝转发：请求体必须是字符串' };
    headers['content-type'] = contentTypeOf(src.headers);
    init.body = src.body;
  }
  return { init };
}

function describeError(err) {
  if (!err) return '请求失败';
  const cause = err.cause;
  const detail = cause && typeof cause === 'object' ? cause.code || cause.message : typeof cause === 'string' ? cause : '';
  const message = err.message || String(err);
  return detail && !message.includes(String(detail)) ? `${message}（${detail}）` : message;
}

/**
 * 转发一条请求。
 *
 * @param {object} input
 * @param {string} input.baseUrl 侧车地址（只需 origin，`http://127.0.0.1:PORT/`）
 * @param {string} input.path    渲染侧给的站内路径，必须 /api/ 开头
 * @param {object} [input.options] transport 的 request：{ method, headers, body? }
 * @param {Function} [input.fetchImpl] 测试时注入的 fetch
 * @param {number} [input.timeoutMs] 0 / 不传 = 不超时（与浏览器 fetch 一致）
 */
export async function forwardRequest({ baseUrl, path, options, fetchImpl, timeoutMs = 0 } = {}) {
  const origin = sidecarOrigin(baseUrl);
  if (!origin) return { ok: false, error: `侧车地址不可用：${String(baseUrl)}` };

  const url = resolveApiUrl(baseUrl, path);
  if (!url) return { ok: false, error: '拒绝转发：只接受 /api/ 开头的站内路径' };

  const built = buildRequest(origin, options);
  if (built.error) return { ok: false, error: built.error };

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, error: '当前 Node 没有 fetch' };

  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (controller) built.init.signal = controller.signal;

  try {
    const res = await doFetch(url, built.init);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return { ok: false, error: aborted ? `请求超时（${timeoutMs}ms）` : describeError(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
