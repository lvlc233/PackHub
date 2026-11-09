# @packhub/pal-electron（E1：最小 Electron 壳）

把 `@packhub/launcher` 的本地界面装进一个 Electron 窗口。壳本身不做实例逻辑：
主进程 spawn 侧车 `pal serve`，从 stdout 读它打印的实际地址，再把地址加载进窗口；关窗时收掉侧车。

这是 E1 的验证壳：只证明链路能通。IPC 业务桥是 E2，打包是 E5。

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
```

## 现在能做什么

- 起窗口，窗口里就是 `pal serve` 的本地界面（实例列表、启停、体检、日志等，全部走现有 HTTP 面）。
- 侧车起不来、20 秒内没给地址、中途意外退出：弹可见错误并退出，不静默失败。
- 关窗即收侧车；Windows 上 `taskkill /PID <pid> /T /F` 收整棵树。

## 还差什么

- E2：preload 只有 `window.pal.platform`，前端 API 还没走 IPC，页面仍直接 fetch 本地 HTTP 面。
- E3：侧车传输要不要从 HTTP 收敛到 stdio / 内部 RPC 还没定。
- E5：打包入口没接（`app.isPackaged` 时直接报错），现在只支持仓库内运行，依赖系统 Node。
