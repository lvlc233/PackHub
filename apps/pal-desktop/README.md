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

- 实例列表、创建、启动/停止/重起、状态与端口、宿主版本、日志（自动刷新 + 归档切换）、体检面板、设为当前、删除（可保留数据）：都在页面里，走 `pal serve` 的 API。
- 创建时能从 registry 索引挑包与版本，也能手填目录/`.phub`/`git+https`；选宿主会显示是否安装、能不能起。
- 界面按 id 复用节点、按字段更新，轮询不会打断输入与选中。
- 单实例、图标、自包含单文件、自带 Node 已做；分发里的 launcher 能独立跑（`runtime\node.exe runtime\pal.cjs doctor`）。
- CI 跑 `.github/workflows/pal.yml`：内核测试、单文件打包、端到端冒烟、壳的自检。
- 还没有：界面里的接管/复制/迁移（只有 CLI）、多窗口、托盘常驻。
