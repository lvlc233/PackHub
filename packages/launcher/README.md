# @packhub/launcher（PAL）

把 Pack 装进一个独立的实例，并按宿主把它跑起来：`建实例 → 起 dsh → 停进程`。实例有自己的 home、端口、日志和基线，所以同一台机器上可以并存多个互不干扰的 agent 环境。

用户面的入口是 `pal` 命令和本地界面（`pal serve`，桌面壳是 `apps/pal-electron`）。

## 上手

```bash
pnpm pal doctor                                   # 宿主装没装、什么版本、有哪些入口、能不能起
pnpm pal create examples/doc-review --name demo --harness dsh --from-home ~/.dsh
pnpm pal start demo                               # 起默认入口（dsh 是 web），端口自动分配
pnpm pal start demo --entry app                   # 换成桌面应用窗口
pnpm pal start demo --entry tui                   # 终端窗口里跑 tui profile
pnpm pal start demo --entry headless --task "跑测试"  # 一次性：跑完记退出码
pnpm pal open demo                                # 按记录里的入口打开访问面
pnpm pal health demo                              # 进程、入口、端口、home、基线、MCP 接线
pnpm pal update demo --version 0.2.0               # 换 Pack 版本（清掉上一版独有的文件；本地改过要 --force）
pnpm pal rebaseline demo                           # 本地改动被接受，体检不再报漂移
pnpm pal stop demo
pnpm pal remove demo --keep-data                  # 先卸包，再把剩下的根挪进归档区
```

## 入口（entry）

一个实例可以被跑成几种形态，用户选哪一个，PAL 就按那一个的契约起：起什么、凭什么算就绪、打开成什么面、怎么停、能不能绑到实例上（`home` / `env` / `port`）。表在 `src/entries.ts`，运行态只记「这次用的是哪个入口」。

| 入口 | 起什么 | 就绪看什么 | 打开成什么 | 终止 |
|---|---|---|---|---|
| `web` | 宿主服务进程 | 日志里的地址 | 浏览器 | 收进程树 |
| `app` | 宿主桌面应用（自己起内部服务） | 进程稳住 | 应用窗口 | 先请它退出，5s 不退再收树 |
| `tui` | 终端里的宿主（新开终端窗口） | 进程稳住 | 终端窗口 | 关终端那棵树 |
| `headless` | 一次性进程 | 退出码 | 无 | 它自己退 |

宿主 × 入口：dsh 四个都有（`tui` 要实例 home 里装过 tui profile），codex 有 `app` / `tui` / `headless`，claude-code 只有 `tui` / `headless`，`dir` 一个都没有（只装配 home）。

已定的取舍：TUI 走外部终端（PAL 不带 node-pty，ConPTY 留以后）；app 只到进程级就绪；app 按实例 home 起（`DSH_HOME` / `CODEX_HOME`，宿主是否把会话也落进去没有逐项验证）；入口不接受实例 home 时直接拒绝，不偷偷跑全局。细节见 [docs/checklist/details/pal.md](../../docs/checklist/details/pal.md)。

`update` 默认不覆盖：Pack 写过的文件被本地改过时整次拒绝、一个文件都不写，确认覆盖要加 `--force`（API 是 `body.force`），界面里勾「覆盖本地改动」才带。普通 `remove` 只删实例根，不单独卸包（删不动就整根归档）。

`pnpm pal serve` 起本地界面：实例列表、创建（可选包与版本）、启停、体检、日志、删除（可保留数据）。

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
| `src/start.ts` / `src/watch.ts` | 起停、按入口的就绪探测、退出码与看护、打开访问面、headless watch |
| `src/entries.ts` | 宿主 × 入口表：启动参数、就绪判据、访问面、终止方式、能不能绑实例；终端窗口怎么开 |
| `src/harness.ts` | 宿主发现与版本探测（含 Windows `.cmd` 垫片） |
| `src/layout.ts` | 每个宿主的 home 段、环境变量、启动参数模板 |
| `src/mcp.ts` | 把 Pack 的 mcp 资源写成 dsh 的 `--patch` 层 |
| `src/health.ts` | 实例体检 |
| `src/logs.ts` / `src/secrets.ts` | 日志归档、脱敏、凭据落盘 |
| `src/port.ts` / `src/process.ts` | 端口分配与占用者、进程存活与回收 |
| `src/server.ts` / `src/cli.ts` | HTTP 面（来源校验）与命令行 |
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
