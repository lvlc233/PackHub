# PackHub

packhub 做包与发版，pal 安装与运行。

## 两个命令族

`packhub` 只碰 Pack 目录：`plan` / `verify` 预览，`lock` / `pack` / `publish` / `sign` 出包与发版。`pal` 负责装和跑：安装类命令 `install` / `uninstall` / `verify` / `rollback` / `update` 的 target 是 home（`--home <路径|名字>`，managed 用名字、attached 用路径或名字）或项目（`--project <目录>`）；`install` 不给 target 时在 PAL 数据目录建一个 managed 命名 home（名字 `<host>-<packSlug>`），`--home` 则装进宿主的真实全局目录（attached）。attached 的默认名撞车会自动改用 `<名字>-attached`；`remove` 对 managed 删整根、对 attached 只摘记录（卸包 + 删 PAL 记录，目录与用户文件保留）；clone / backup / restore / migrate 仍只对 managed。home 侧还有 `adopt` 与起停看护，本机状态看 `list` / `ps` / `health`，审计看 `list --history`。

宿主（`dsh` / `claude-code` / `codex` / `opencode` / `workbody` / `hermes`）在 kernel 的注册表里：每个宿主一个模块，加宿主 = 新模块 + `harness/index.ts` 一行 import；attached home 只对已验证全局布局的宿主开放（opencode / hermes / workbody）；hermes 没有项目级落点（不能用 `--project`，用默认命名 home 或 `--home`）；第三方宿主暂不支持（见 [docs/concepts.md](docs/concepts.md) 的 Harness 词条）。

```bash
# 默认 target：在 PAL 数据目录建 managed home，名字 <host>-<packslug>
pnpm pal install test/fixtures/packs/team-conventions --host opencode
pnpm pal run opencode-lvlc233-team-conventions
# server 型宿主（dsh）用 start
pnpm pal install test/fixtures/packs/team-conventions --host dsh
pnpm pal start dsh-lvlc233-team-conventions
# managed home 想沿用全局凭据：按该宿主的 credentialFiles 从已有全局目录复制进新 home
# （attached 不需要：它直接就是宿主的全局目录；--project 没有 home 段，不能用）
pnpm pal install test/fixtures/packs/team-conventions --host claude-code --from-home ~/.claude

# attached home：装进宿主真实的全局目录（例如 opencode 的 ~/.config/opencode）
pnpm pal install test/fixtures/packs/team-conventions --host opencode --home ~/.config/opencode
pnpm pal uninstall --home ~/.config/opencode
pnpm pal verify --home opencode-lvlc233-team-conventions
# 默认名已被别的 attached home 占用时自动改用 <名字>-attached（输出里打印最终名字）
# remove 对 attached 只摘记录：卸包 + 删 PAL 记录，目录和用户文件保留
pnpm pal remove opencode-lvlc233-team-conventions --yes

# 项目 target：装进已有目录（dsh 在项目里只写指路块）
pnpm pal install test/fixtures/packs/team-conventions --project tmp/demo-project --host dsh
pnpm pal verify --project tmp/demo-project

# 每个 home 可放 launch.json（args/env/dir）；pal run <home> --init 生成空模板，--dry-run 看合并结果

# 接管已有目录成 attached home（只写记录，不装包、不动文件）；只看不接管用 adopt --scan
pnpm pal adopt ~/.hermes --host hermes --name my-hermes
pnpm pal install test/fixtures/packs/team-conventions --host hermes --home ~/.hermes

pnpm pal health <home> --hosts     # home 体检 + 宿主发现（装没装、版本、能不能起）
pnpm pal health --leftovers        # 隔离区 / 失败现场 / 归档区里有什么（只读）
pnpm pal list --history            # install / update 写的审计
pnpm pal verify --home <home> --accept   # 本地改动被接受，体检不再报漂移
pnpm pal config <home> --name <新名字>    # 给 home 改名
```

## 代码分层

| 包 | 负责 |
|---|---|
| `packages/kernel` | 解析、能力图、计划、锁、计划差异等核心判断 |
| `packages/runtime` | 下载、安装、卸载、回滚、校验、签名、探针、引用解析 |
| `packages/runner` | 干净目录 install + verify，产出报告 |
| `packages/registry` | 发布、索引生成、门禁 |
| `packages/launcher` | PAL：home 内核（managed / attached、启停与看护、体检、基线）与安装 target 命令 |
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
