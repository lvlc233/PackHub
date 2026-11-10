# @packhub/launcher（PAL）

把 Pack 装进一个独立的实例，并按宿主把它跑起来：`建实例 → 起 dsh → 停进程`。实例有自己的 home、端口、日志和基线，所以同一台机器上可以并存多个互不干扰的 agent 环境。

用户面的入口是 `pal` 命令和本地界面（`pal serve`，桌面壳是 `apps/pal-electron`）。启停与看护归常驻 core（`pal core`），它们都只是 core 的客户端。

## 上手

```bash
pnpm pal doctor                                   # 宿主装没装、什么版本、能不能起
pnpm pal create examples/doc-review --name demo --harness dsh --from-home ~/.dsh
pnpm pal start demo                               # 起 dsh web，端口自动分配
pnpm pal health demo                              # 进程、端口、home、基线、MCP 接线
pnpm pal update demo --version 0.2.0               # 换 Pack 版本（清掉上一版独有的文件；本地改过要 --force）
pnpm pal rebaseline demo                           # 本地改动被接受，体检不再报漂移
pnpm pal stop demo
pnpm pal remove demo --keep-data                  # 先卸包，再把剩下的根挪进归档区
```

`update` 默认不覆盖：Pack 写过的文件被本地改过时整次拒绝、一个文件都不写，确认覆盖要加 `--force`（API 是 `body.force`），界面里勾「覆盖本地改动」才带。普通 `remove` 只删实例根，不单独卸包（删不动就整根归档）。

`pnpm pal serve` 起本地界面：实例列表、创建（可选包与版本）、启停、体检、日志、删除（可保留数据）。界面只是客户端：启动/停止转给 core，关掉界面不影响实例与看护。

## 常驻 core

实例的启停与看护只有一个执行者：`pal core`。它在 `<数据目录>/core.json` 写回环地址与 token，`core.lock` 保证单例；CLI、`pal serve`、桌面壳都经 `coreCall` 把命令转给它。没有 core 时，任何一条启动/停止命令都会按需把它拉起来。

```bash
pnpm pal core status     # 在不在、pid、地址、登录任务
pnpm pal core start      # 按需拉起（已经在跑就什么都不做）
pnpm pal core stop       # 只停监督者；实例进程继续跑，下次命令会拉起新 core 接管
pnpm pal core install    # 注册用户任务计划：登录拉起 + 每分钟兜底检查
pnpm pal core uninstall
```

core 崩溃或被结束后由计划任务带回来；起来的第一轮看护就是接管：活着的 running 实例继续跑，pid 已死的按重启预算处理，不会出现双实例。

数据默认放在哪：先看 `PACKHUB_HOME`，再看 `pal config --home` 记下的选择；打包后的 `pal.cjs` 默认用程序目录旁的 `data/`，否则用系统默认（Windows `%LOCALAPPDATA%\PackHub`）。`pal config` 会显示当前目录与来源，`pal config --home D:\PackHubData` 改选择（不搬已有数据）。

## 代码在哪

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 门面：按原名 re-export；实现已拆到下面各模块 |
| `src/create.ts` / `src/remove.ts` / `src/update.ts` | 建实例（含接管）、删除、换 Pack 版本 |
| `src/migrate.ts` / `src/template.ts` | 复制/改名/迁移（同盘 rename、跨盘复制）、模板导入导出 |
| `src/records.ts` / `src/recordWrite.ts` | 记录类型与解析（config/runtime 两份）、原子写与 `.links` |
| `src/catalog.ts` / `src/quarantine.ts` | 列表/查找/当前实例、坏记录隔离 |
| `src/cache.ts` / `src/scan.ts` / `src/ps.ts` / `src/backup.ts` | 取包缓存、目录扫描、并发账本、备份恢复 |
| `src/start.ts` / `src/watch.ts` | 起停、就绪探测、退出码与看护；`watch.ts` 是 core 的轮询看护（接管来的实例） |
| `src/core.ts` / `src/coreClient.ts` / `src/coreTask.ts` | 常驻 core（单例、HTTP 面、看护循环）、客户端（发现/按需拉起/发命令）、用户任务计划 |
| `src/harness.ts` | 宿主发现与版本探测（含 Windows `.cmd` 垫片） |
| `src/layout.ts` | 每个宿主的 home 段、环境变量、启动参数模板 |
| `src/mcp.ts` | 把 Pack 的 mcp 资源写成 dsh 的 `--patch` 层 |
| `src/health.ts` | 实例体检 |
| `src/logs.ts` / `src/secrets.ts` | 日志归档、脱敏、凭据落盘 |
| `src/port.ts` / `src/process.ts` | 端口分配与占用者、进程存活与回收 |
| `src/server.ts` / `src/cli.ts` | 界面 HTTP 面（来源校验，启停转 core）与命令行 |
| `src/paths.ts` | 数据目录、实例根、缓存、隔离区、归档区、失败现场 |
| `src/config.ts` / `src/isolation.ts` | 全局配置（数据目录/默认隔离）、隔离五层模型 |
| `web/` | 本地界面 |

落点、状态机、错误码、HTTP 面、接线细节见 [docs/checklist/details/pal.md](../../docs/checklist/details/pal.md)。

## 约定

- 危险动作先保护现场：不删别人的目录，不删没停干净的实例，坏记录挪进隔离区而不是丢掉。
- 失败给原因和下一步，`PalError` 的 code 决定 HTTP 状态。
- 凭据不落记录、不进 API、不进日志；打开实例走服务端 302。
- 取包缓存按来源 + 版本分目录，重取先清空。

## 测试与冒烟

```bash
pnpm check          # 类型检查 + 全量测试
pnpm pal:smoke      # 起服务 → 建实例 → 体检 → 删
pnpm pal:bundle     # 只打 launcher 单文件（esbuild）
```
