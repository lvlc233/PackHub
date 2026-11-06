# PAL Desktop（Windows 壳）

用 WinForms + WebView2 把 `@packhub/launcher` 的本地界面装进一个窗口。
壳本身不做实例逻辑：起 `pal serve`（Node 侧车），拿到地址后加载页面；关窗时收掉侧车。

## 构建（分发）

```powershell
pnpm build:pal-desktop
```

产物在 `dist/pal-desktop/`，整个目录拷走即可双击运行：

```text
Pal.exe            自包含单文件（不需要装 .NET）
runtime/node.exe   随包带的 Node
runtime/pal.cjs    打包后的 launcher（单文件，含 kernel/runtime 与依赖）
web/               界面
```

双击 `Pal.exe`。不需要仓库、不需要系统 Node；只要机器有 WebView2 Runtime（Edge 一般自带）。

## 开发运行

```powershell
pnpm pal serve --open          # 只开界面（Edge 应用窗口）
dotnet run --project apps/pal-desktop   # 跑壳（用仓库里的源码 + 系统 node）
```

壳优先用自己旁边的 `runtime/`；没有才回落到仓库 + 系统 node（`PAL_REPO` 可指定仓库根）。

## 无界面自检

```powershell
dist\pal-desktop\Pal.exe --smoke --log tmp\smoke.log
# log 里是 pal serve 给出的地址；进程起完即退
```

## 现状

- 实例列表、创建、启动/停止、状态与端口、日志、设为当前：都在页面里，走 `pal serve` 的 API。
- 单实例、图标、自包含单文件、自带 Node 已做。
- 还没有：创建向导里的包浏览（现在是手填 Pack）、日志面板自动刷新、界面内的错误重试。
