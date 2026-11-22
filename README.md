# PackHub

packhub 做包与发版，pal 安装与运行。

## 两个命令族

`packhub` 只碰 Pack 目录：`plan` / `verify` 预览，`lock` / `pack` / `publish` / `sign` 出包与发版。`pal` 负责装和跑：目录侧 `install` / `uninstall` / `verify` / `rollback`（`update` 目录与实例都接），实例侧 `create` / `adopt` 与起停看护，本机状态与审计看 `health` / `audit`。

```bash
# 装进已有目录
pnpm pal install test/fixtures/packs/team-conventions --into tmp/demo-project --harness dsh
pnpm pal verify tmp/demo-project

# 建实例：必须选宿主；目录形态用 adopt 接管已有目录
pnpm pal create test/fixtures/packs/team-conventions --name demo --kind dsh
pnpm pal adopt ./existing-env --name legacy   # 接管已有目录（目录形态实例，不是宿主）

pnpm pal health demo --hosts   # 实例体检 + 宿主发现（装没装、版本、能不能起）
pnpm pal audit                 # install / update 写的审计
```

## 代码分层

| 包 | 负责 |
|---|---|
| `packages/kernel` | 解析、能力图、计划、锁、计划差异等核心判断 |
| `packages/runtime` | 下载、安装、卸载、回滚、校验、签名、探针、引用解析 |
| `packages/runner` | 干净目录 install + verify，产出报告 |
| `packages/registry` | 发布、索引生成、门禁 |
| `packages/launcher` | PAL：实例内核（建实例、启停与看护、体检、基线）与目录侧安装命令 |
| `apps/local` | `packhub` 命令（生产与 Pack 目录预览） |

## 本地开发

Node >= 22.13，包管理器 pnpm。

```bash
pnpm install
pnpm check                          # typecheck + 全部测试
pnpm packhub plan registry/packs/lvlc233/doc-review/0.1.0
pnpm registry:check
pnpm registry:verify-all:offline    # 跳过远程引用，只验本地 registry
```

## 文档

| 想知道 | 读 |
|---|---|
| 概念与边界 | [docs/concepts.md](docs/concepts.md) |
| 为什么这么定（取舍与代价） | [docs/decisions.md](docs/decisions.md) |
| 文件里每个 JSON 长什么样 | [docs/contract.md](docs/contract.md) |
| 文档怎么维护 | [docs/README.md](docs/README.md) |

改代码时如果行为变了，同一次提交里把文档里对应的描述改掉。历史不进 `docs/`，`git log -- docs/` 里查。
