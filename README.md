# PackHub

packhub 做包与发版，pal 安装与运行。

## 两个命令族

`packhub` 只碰 Pack 目录：`plan` / `verify` 预览，`lock` / `pack` / `publish` / `sign` 出包与发版。`pal` 负责装和跑：安装类命令 `install` / `uninstall` / `verify` / `rollback` / `update` 的 target 是 home（`--home <路径|名字>`，managed 用名字、attached 用路径或名字）或项目（`--project <目录>`）；`install` 不给 target 时在 PAL 数据目录建一个 managed 命名 home（名字 `<host>-<packSlug>`），`--home` 则装进宿主的真实全局目录（attached）。attached 的默认名撞车会自动改用 `<名字>-attached`；`remove` 对 managed 删整根、对 attached 只摘记录（卸包 + 删 PAL 记录，目录与用户文件保留）；clone / backup / restore / migrate 仍只对 managed。home 侧还有 `adopt` 与起停看护，本机状态看 `list` / `ps` / `health`，审计看 `list --history`。

宿主（`dsh` / `claude-code` / `codex` / `opencode` / `workbody` / `hermes`）在 kernel 的注册表里：每个宿主一个模块，加宿主 = 新模块 + `harness/index.ts` 一行 import；落点由宿主模块的 `destination` 自己回答，启动方式由同一个模块的 `modes` / `defaultMode` 声明（`kind` 决定交给 core、前台 exec 还是 detached app，`available` 回答「这份 home 上能不能用」），attached home 只对已验证全局落点的宿主开放（opencode / claude-code / codex / hermes / workbody / dsh）；hermes 没有项目级落点（不能用 `--project`，用默认命名 home 或 `--home`）；第三方宿主暂不支持（见 [docs/concepts.md](docs/concepts.md) 的 Harness 词条）。dsh 的 MCP 是 per-profile 的：attached 安装默认写进 `<home>/profiles/*/cordis.patch.yml` 里**已有**的每一个 profile；加 `--profile <名字>` 只装那一个（profile 不存在会报错、不创建），一个 profile 都没有且没指定时也报错（先启动一次 dsh 生成 profile）；装完再新建的 profile 不在安装时补，`pal health` 会枚举当前所有 profile——`all` 记录把缺条目的报成警告，单个 profile 的记录把其它 profile 显示成 scope 外「未安装」并提示 `pal update --profile <名字>`；`pal update --profile <名字>` 可以直接换安装范围（`--profile all` 回到全部），旧 profile 的本包条目摘掉、用户条目保留，不必先 uninstall。

```bash
# 默认 target：在 PAL 数据目录建 managed home，名字 <host>-<packslug>
pnpm pal install test/fixtures/packs/team-conventions --host opencode
pnpm pal run opencode-lvlc233-team-conventions
# 启动方式由宿主声明为模式（pal start <home> --mode <id>），不写 --mode 用默认模式。
# dsh 的默认模式是 web（server，交给 core 等地址）；opencode / claude-code 等默认 tui（前台 exec）
pnpm pal install test/fixtures/packs/team-conventions --host dsh
pnpm pal start dsh-lvlc233-team-conventions              # = --mode web
pnpm pal start dsh-lvlc233-team-conventions --list-modes  # 看这个宿主有哪些模式、各自能不能用
# managed home 想沿用全局凭据：按该宿主的 credentialFiles 从已有全局目录复制进新 home
# （attached 不需要：它直接就是宿主的全局目录；--project 没有 home 段，不能用）
pnpm pal install test/fixtures/packs/team-conventions --host claude-code --from-home ~/.claude

# attached home：装进宿主真实的全局目录（例如 opencode 的 ~/.config/opencode）
pnpm pal install test/fixtures/packs/team-conventions --host opencode --home ~/.config/opencode
pnpm pal uninstall --home ~/.config/opencode
pnpm pal verify --home opencode-lvlc233-team-conventions
# claude-code：skills / CLAUDE.md 落 ~/.claude，MCP 落 home 旁的 ~/.claude.json
pnpm pal install test/fixtures/packs/team-conventions --host claude-code --home ~/.claude
pnpm pal uninstall --home ~/.claude
# codex：skills / AGENTS.md / config.toml 都落 ~/.codex
pnpm pal install test/fixtures/packs/team-conventions --host codex --home ~/.codex
pnpm pal uninstall --home ~/.codex
# dsh：skills / AGENTS.md 落 ~/.dsh，MCP 写进 ~/.dsh/profiles/*/cordis.patch.yml 里已有的每个 profile
# （一个 profile 都没有会退 2：先跑一次 dsh 生成 profile；装完新建的 profile 由 pal health 报缺、pal update 补）
pnpm pal install test/fixtures/packs/team-conventions --host dsh --home ~/.dsh
# 只装一个 profile：其余 profile 的 patch 不动；profile 不存在则退 2，不会创建
# 记录里的 profile 就是 pal start 用的 profile，--profile 覆盖它；记录是 all 时用 web（输出里会说明）；
# attached 下指定的 profile 必须已存在，否则退 2、不启动
pnpm pal install test/fixtures/packs/team-conventions --host dsh --home ~/.dsh --profile desktop
pnpm pal start dsh-lvlc233-team-conventions              # 用 desktop
pnpm pal start dsh-lvlc233-team-conventions --profile web
# dsh 桌面 app（Electron 窗口）而不是 web 页面：--mode app；只对 attached dsh（managed 退 2），
# app 自己管 desktop profile，不接受 --profile / --port / --restart / --dir；
# 不分配端口、不等 URL、不打开浏览器，记录里只有 pid
pnpm pal start dsh-lvlc233-team-conventions --mode app
# app 可执行文件不在常见安装位置时，用 PAL_DSH_APP_BIN 指过去（下面按 PowerShell 写）
$env:PAL_DSH_APP_BIN = 'C:\path\to\DeepSeek Harness.exe'
pnpm pal start dsh-lvlc233-team-conventions --mode app
# 换安装范围不用先 uninstall：desktop → web（摘掉 desktop 的 pal-mcp-*、写进 web、记录同步），
# --profile all 回到全部已有 profile
pnpm pal update --home ~/.dsh --profile web
pnpm pal update --home ~/.dsh --profile all
pnpm pal verify --home ~/.dsh
pnpm pal uninstall --home ~/.dsh
# 默认名已被别的 attached home 占用时自动改用 <名字>-attached（输出里打印最终名字）
# remove 对 attached 只摘记录：卸包 + 删 PAL 记录，目录和用户文件保留
pnpm pal remove opencode-lvlc233-team-conventions --yes

# 项目 target：装进已有目录（dsh 在项目里只写指路块）
pnpm pal install test/fixtures/packs/team-conventions --project tmp/demo-project --host dsh
pnpm pal verify --project tmp/demo-project

# 其它宿主的模式：codex 有 tui / app，claude-code 有 tui；run 是 start --mode <默认前台模式> 的糖
pnpm pal install test/fixtures/packs/team-conventions --host codex
pnpm pal start codex-lvlc233-team-conventions --mode tui     # = pnpm pal run codex-lvlc233-team-conventions
pnpm pal start codex-lvlc233-team-conventions --mode app     # 需要 PAL_CODEX_APP_BIN 指向 codex 桌面 app
pnpm pal start claude-code-lvlc233-team-conventions --mode tui

# 每个 home 可放 launch.json（args/env/dir）；pal run <home> --init 生成空模板，--dry-run 看合并结果
# （前台模式与 run 读它；server / app 模式不读）

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
