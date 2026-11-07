# @packhub/launcher（PAL）

把 Pack 装进一个独立的实例，并按宿主把它跑起来：`建实例 → 起 dsh → 停进程`。实例有自己的 home、端口、日志和基线，所以同一台机器上可以并存多个互不干扰的 agent 环境。

用户面的入口是 `pal` 命令和本地界面（`pal serve`，Windows 上还有 `apps/pal-desktop` 的壳）。

## 上手

```bash
pnpm pal doctor                                   # 宿主装没装、什么版本、能不能起
pnpm pal create examples/doc-review --name demo --harness dsh --from-home ~/.dsh
pnpm pal start demo                               # 起 dsh web，端口自动分配
pnpm pal health demo                              # 进程、端口、home、基线、MCP 接线
pnpm pal stop demo
pnpm pal remove demo --keep-data                  # 卸包，数据挪进归档区
```

`pnpm pal serve` 起本地界面：实例列表、创建（可选包与版本）、启停、体检、日志、删除（可保留数据）。

## 代码在哪

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 实例记录、创建/删除/接管/复制/改名/迁移/模板、基线、实例锁 |
| `src/start.ts` | 起停、就绪探测、退出码与守护、状态刷新 |
| `src/harness.ts` | 宿主发现与版本探测（含 Windows `.cmd` 垫片） |
| `src/layout.ts` | 每个宿主的 home 段、环境变量、启动参数模板 |
| `src/mcp.ts` | 把 Pack 的 mcp 资源写成 dsh 的 `--patch` 层 |
| `src/health.ts` | 实例体检 |
| `src/logs.ts` / `src/secrets.ts` | 日志归档、脱敏、凭据落盘 |
| `src/port.ts` / `src/process.ts` | 端口分配与占用者、进程存活与回收 |
| `src/server.ts` / `src/cli.ts` | HTTP 面（来源校验）与命令行 |
| `src/paths.ts` | 实例根、缓存、隔离区、归档区、失败现场 |
| `web/` | 本地界面 |

落点、状态机、错误码、HTTP 面、接线细节见 [docs/checklist/details/pal.md](../../docs/checklist/details/pal.md)。

## 约定

- 危险动作先保护现场：不删别人的目录，不删没停干净的实例，坏记录挪进隔离区而不是丢掉。
- 失败给原因和下一步，`PalError` 的 code 决定 HTTP 状态。
- 凭据不落记录、不进 API、不进日志；打开实例走服务端 302。
- 取包缓存按来源 + 版本分目录，重取先清空。

## 测试与冒烟

```bash
pnpm check          # 类型检查 + 全量测试（launcher 有 41 项）
pnpm pal:smoke      # 起服务 → 建实例 → 体检 → 删
pnpm pal:bundle     # 只打 launcher 单文件（esbuild）
```
