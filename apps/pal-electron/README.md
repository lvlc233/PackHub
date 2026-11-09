# @packhub/pal-electron（E1 最小壳 + E2 API 桥）

把 `@packhub/launcher` 的本地界面装进一个 Electron 窗口。壳本身不做实例逻辑：
主进程 spawn 侧车 `pal serve`，从 stdout 读它打印的实际地址，再把地址加载进窗口；关窗时收掉侧车。

E2 起页面的 API 请求由 `web/api.js` 统一发出：浏览器里走同源 fetch，Electron 里走 preload 的 IPC，
主进程再转给侧车。打包是 E5，传输收敛（stdio / 内部 RPC）是 E3。

## 前置

- Node 22.13+（`node --experimental-strip-types` 跑 launcher 源码）
- 仓库根已 `pnpm install`

pnpm 默认不跑依赖的 postinstall，Electron 二进制可能要手动补一次（国内网络加镜像）：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node apps/pal-electron/node_modules/electron/install.js
pnpm --filter @packhub/pal-electron exec electron --version   # 能打印 v45.x 即可
```

## 运行

```powershell
# 仓库根
pnpm electron:pal
```

等价于 `pnpm --filter @packhub/pal-electron start`，即在 `apps/pal-electron` 里跑 `electron .`。

如果终端里带着 `ELECTRON_RUN_AS_NODE`（例如从 DSH 会话里启动的 shell），先清掉它，否则 Electron 会以 Node 模式启动、窗口不会出现：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

只做静态检查时（Electron 不能当 Node 用）：

```powershell
node --check apps/pal-electron/main.js
node --check apps/pal-electron/preload.cjs
node --check apps/pal-electron/forward.mjs
node --check packages/launcher/web/api.js
```

路径约定：`web/api.js`、`web/app.js` 都是 ESM，`index.html` 用 `<script type="module" src="/app.js">` 加载，
`app.js` 里 `import { api } from './api.js'` —— 浏览器与 Electron 共用同一份代码。

## API 桥（E2）

四段，可替换的边界只有 transport：

```
web/app.js              import { api } from './api.js'
web/api.js              createApi(transport) / api(path, options)
   │                    transport(path, request) -> { ok, status, text }
   ├─ 浏览器：同源 fetch
   └─ Electron：window.pal.request(path, options) → ipcRenderer.invoke('pal:request')
                                                    │
preload.cjs  只传 method / headers（字符串）/ body（字符串），不传函数或 DOM
main.js      ipcMain.handle：校验来源帧 + path，调 forward.mjs，异常收敛成 { ok: false, error }
forward.mjs  拼 x-pal-client: pal-ui 与 origin: <侧车 origin>，另把页面 meta 里的 x-pal-token 转过去（B14）
```

- 转发只放行 `/api/` 开头的站内路径，URL 归一化后仍须落在侧车 origin 与 `/api/` 下；方法限 GET/HEAD/POST/PUT/PATCH/DELETE。
- 桥自己补 `x-pal-client` 与 `origin`；渲染侧传来的头只有两个例外会被转过去：`content-type`（限 JSON）与形状合法的 `x-pal-token`。
- 带 Origin 的请求（Electron 桥每条都带）还要求 `x-pal-token` 与侧车启动时生成的一致，否则 403；浏览器直连时页面从首页 meta 里读同一个 token。
- 返回 `{ ok, status, text }`；网络层失败是 `{ ok: false, error }`（没有 status）。页面在 `web/api.js` 里统一转成 Error，带 `hint` / `code`。
- `window.open('/api/instances/:id/open')` 仍是页面导航（服务端 302 拼凭据），不走桥。

`forward.mjs` 不 import electron，可以直接用 Node 对着跑起来的侧车验证。

## 手工验证转发器

```powershell
# 终端 A：起侧车，记下 stdout 里的 {"url":"http://127.0.0.1:PORT/"}
$env:PACKHUB_HOME = 'G:\work\packhub\tmp\pal-e2-home'   # 用 tmp，别碰真实实例
node --experimental-strip-types packages/launcher/src/bin.ts serve --port 0 --json

# 终端 B：直连转发器
node --input-type=module -e "import { forwardRequest } from './apps/pal-electron/forward.mjs'; console.log(await forwardRequest({ baseUrl: 'http://127.0.0.1:PORT/', path: '/api/meta' }));"
```

## 现在能做什么

- 起窗口，窗口里就是 `pal serve` 的本地界面（实例列表、启停、体检、日志等）。
- 页面请求经 `pal:request` IPC 由主进程转发；用浏览器直接打开同一地址时仍走 fetch，UI 行为一致。
- 侧车起不来、20 秒内没给地址、中途意外退出：弹可见错误并退出，不静默失败。
- 关窗即收侧车；Windows 上 `taskkill /PID <pid> /T /F` 收整棵树。

## 还差什么

- E3：侧车传输要不要从 HTTP 收敛到 stdio / 内部 RPC 还没定。要换只改 transport 这一层：`forward.mjs`（主进程侧）与 `web/api.js`（页面侧），页面代码不用动。
- E4：退役 WinForms/WebView2 壳。
- E5：打包入口没接（`app.isPackaged` 时直接报错），现在只支持仓库内运行，依赖系统 Node。
