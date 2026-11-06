# PackHub

调好一套 Agent 环境要花多久？

装 MCP server、把 skill 放进正确的目录、写提示词、整理项目规范，再确认这些组件能一起工作。换一个项目，这些事再来一遍。交给同事时，通常只能发几个链接，加一句“照我这个配”。

PackHub 把这段工作收进一个 Pack：一份清单说明用了哪些资源、怎么接、装完怎么验；一条命令装进新项目；换一台机器，装出来的是同一套环境。

Pack 是一组经过组织与适配的 Agent 资源及其集成契约，包含依赖、接线、配置覆盖、兼容性约束与验收条件。（实际上，Pack的概念并不是本项目第一次提出，如 Agent Packs（agent-packs/cli）、Claude Code Plugins 和 OpenAI Agent Plugins 等）

而 PackHub 除了定义了更通用的 Pack 内容外，更加强调围绕 Pack 的发现、组合、分发、安装、更新与生命周期管理建立的统一枢纽，负责协调 Pack 与目标 Agent 环境之间的集成过程。

## 一个包长什么样

最小的 Pack 只需要一个清单和几个本地文件：

```
my-pack/
├── packhub.yaml
├── resources/
│   └── style-guide.md
└── fragments/
    └── agent.yaml
```

其中 `packhub.yaml` 是一个普通的 YAML 文件，也是 PackHub 里的清单：

```yaml
apiVersion: packhub.dev/v0
kind: Pack

metadata:
  name: me/team-conventions
  version: 0.0.1
  targets: [dir]

resources:
  - id: style-guide
    type: knowledge
    source: ./resources/style-guide.md

  - id: editor-config
    type: config
    source: ./fragments/agent.yaml
```

`metadata.targets` 是必填字段，声明这个包支持装到哪些环境：`dir`（普通项目）、`dsh`、`claude-code`、`codex`、`server`（CI / 容器）。

它有三个后果：

- `--target` 不在里面，命令直接拒绝，不是警告；
- `run` / `publish` 要求里面必须有 `dir`——发布门禁只验证 `dir`，所以只声明 `[server]` 的包发不出去；
- `lock` 会为每个声明的 target 各存一份计划快照（`lock.plans`），声明越多，锁越大，索引校验也多几轮。

资源上还能写 `targets: [dir]`，在这个范围内再裁一层：包声明了 `server`，某条资源仍可以只允许 `dir`，在 `server` 上它进 `excluded`（reason `target-mismatch`）。

## 概念

**资源**是`清单`里的一条声明：`id + type + source`，加上用于描述资源关系的`接线`字段。例如：

```yaml
resources:
  - id: review-rules
    type: skill
    source: github:lvlc233/skill-hub/skills/code-review@9f2c1ab
    dependsOn: [repo-search]
    provides: [skill:code_review]
    needs: [tool:repo_search]
```

其中 `id` 是包内唯一的标记，包里的引用都靠它。写法限定小写字母开头，只用小写字母、数字和连字符（`^[a-z][a-z0-9-]*$`）——它会直接变成目录名和缓存文件名，所以不能带斜杠和点；同一个包里不能重复，跨包可以重名。

`type` 决定这条资源怎么装进宿主：

| type | 安装动作 |
|---|---|
| `mcp` | 向目标登记一条能被解析的 MCP 启动项，不负责宿主自动发现 |
| `skill` | 下载 → 解包 → 复制到 skills 目录 |
| `knowledge` / `prompt` | 写入文件 |
| `config` | 合并进配置文件 |
| `tool` | 下载 → 解包到 `.packhub/cache/tools/<id>` → 在 `.packhub/bin/` 建可执行入口 |


**source** 是定位符、pin 和 `integrity` 的组合。清单里通常写成一整条 `source`，解析后由锁拆开记录：

- 定位符决定去哪找：本地路径、可访问的 URL、`npm:`、`pypi:`、`github:`，或自部署的 `packhub://`；
- pin 决定装哪一版，跟在 `@` 后面；
- `integrity` 是内容哈希，用来确认拿到的字节没变。

**制品**是 Pack 资源的真实内容：npm tarball、仓库目录、Markdown、归档。制品不写进清单，由 `source` 指向它，通常只在下载和解包时出现。

**接线**是资源之间关系的那些声明，下面单独讲。

### 接线

接线维护的是资源之间的关系，目的是在装之前就能判出问题：它只检查有没有人声明提供某个能力，不检查那份声明是不是真的。单资源或少资源的 Pack 写不写差别不大；资源一多，这些声明能把“谁需要谁、谁提供谁”理清楚，类似编程里的接口名。

按字段查：

| 字段 | 写在哪 | 取值 | 作用 | 不满足时 |
|---|---|---|---|---|
| `provides` | 资源 | 该资源能够提供的能力名数组，`命名空间:名字`。能力可以是任意的内容，并不写死定义 | 声明这条资源对外提供什么能力 | — |
| `needs` | 资源 | 同上 | 声明这条资源必须拥有什么能力 | `unmet-need` |
| `dependsOn` | 资源 | 资源 id 数组 | 安装顺序；一般不用手写，除非确实要控制先后。和 `needs` 无关 | — |
| `slots.<名>` | 包 | `{ contract?: 能力名[], note?: string }` | 声明这个包必须提供什么能力。它和 `needs` 类似，区别是 `needs` 说某条资源需要什么，`slots` 说这个包需要什么；一个槽位只能绑一个实现（一条资源） | `slot-contract-unmet`（绑定实现缺契约能力） |
| `bindings.<槽位>` | 包 | 资源 id | 选这个实现来填那个位置 | `slot-unbound`（有候选没选）、`binding-unknown-slot`、`binding-wrong-slot`、`binding-unknown-resource` |
| `slot` | 资源 | 槽位名 | 占位声明，可以理解为 `slots` 的显式实现：资源里写了 `slot: <名>` 才可能被这个槽位选中 | `unknown-slot`（槽位没声明） |
| `composition.order` | 包 | 资源 id 数组 | 显式指定安装顺序、通常不用管 | `bad-order`（引用了不存在的资源）、`order-violates-dependency`（与 `dependsOn` 冲突） |
| `composition.env` | 包 | `{ 名: 字符串/数字/布尔 }` | 注入所有资源的共享环境变量 | — |
| `state` | 包 | `[{ id, path?, retain?, description? }]` | 持久状态目录，资源里用 `${state.id}` 引用 | `duplicate-state-id`、`bad-state-path` |
| `vars` | 包 | `{ 名: 标量 }` | 包级变量，资源里用 `${vars.名}` 引用 | `undefined-variable`（引用了没声明的） |

能力名是 `命名空间:名字`（`^[a-z][a-z0-9-]*:[a-z0-9_.]+$`），命名空间由作者自己定，清单里不解释它的含义。

```yaml
slots:
  lint:
    contract: [doc:lint]

bindings:
  lint: markdownlint

vars:
  projectRoot: "."
  strict: true

composition:
  env:
    REVIEW_ROOT: ${vars.projectRoot}
    REVIEW_STRICT: "${vars.strict}"
  order: [agent-config, repo-search, review-rules]

resources:
  - id: markdownlint
    type: mcp
    slot: lint
    source: npm:@dougis/markdown-lint-mcp@1.0.5
    transport: stdio
    provides: [doc:lint]

  - id: review-rubric
    type: knowledge
    source: ./resources/review-rubric.md
    provides: [knowledge:review_rubric]

  - id: reader-brief
    type: prompt
    source: ./resources/reader-brief.md
    provides: [prompt:reader_brief]

  - id: doc-review
    type: skill
    source: ./skills/doc-review
    needs: [doc:lint, knowledge:review_rubric, prompt:reader_brief]
    dependsOn: [markdownlint, review-rubric, reader-brief]
    provides: [skill:doc_review]
```

三条容易踩的：

1. `needs` 只查有没有，不管先后；先后由 `dependsOn` 或 `composition.order` 决定。两者都不写时按清单顺序。
2. 槽位两侧成对：资源上的 `slot` 只是报名，决定装谁的是 `bindings`。没有 `bindings` 不会自动挑一个候选——它们进 `excluded`（reason `unbound-slot`），同时报 `slot-unbound`。
3. 被排除的资源提供的能力不算数：提供方是在槽位筛选和 `optional` 剔除之后才统计的，所以未绑定的候选不会给别人兜底。

## 安装

先确认本机有没有 PackHub：

```bash
packhub --version        # 打出版本号就是装好了
```

没装的话有三条路：从源码跑（`pnpm install`，之后所有命令写成 `pnpm packhub …`）；`pnpm build:local` 生成单文件，再 `npm i -g ./dist/local`；或者拿到别人打好的 tgz，`npm i -g packhub-0.0.1.tgz`。CLI 还没发布到 npm，所以 `npx packhub` 会去装一个不存在的包。

### 四种安装方式

| 命令 | 装到 |
|---|---|
| `packhub add <包>` | 当前目录 |
| `packhub install <包目录>` | 包目录自己（就地安装，作者自测用） |
| `packhub sync <包目录>` | 宿主 home（`~/.dsh`、`~/.codex`、`~/.claude`） |
| `packhub run <包目录>` | 临时目录，装完即弃 |

装到哪由 `--target` 决定，默认 `dir`：

| target | 落点 |
|---|---|
| `dir` | 项目内 `.packhub/`，不碰宿主配置 |
| `dsh` | `.packhub/` + `AGENTS.md` 托管块 |
| `claude-code` | `.claude/skills/` + `.mcp.json` + `CLAUDE.md` 托管块 |
| `codex` | 项目内 `.codex/skills/` + `AGENTS.md` 托管块 |
| `server` | 只物化到 `.packhub/`，不写宿主指令面；给 CI / 容器 |

不写 `--target` 就是 `dir`：文件都进 `.packhub/`，宿主侧一个落点都不写——装完命令成功、校验也过，但 Claude Code 看不到任何东西。

### add：装进项目

```bash
export PACKHUB_INDEX=/path/to/registry/index.json   # 从哪个 registry 找包
packhub add lvlc233/doc-review --target claude-code # 取包，装进当前项目的 .claude/ 与 .mcp.json
```

真正会用到的参数只有三个：装到哪个项目（`--dir`，默认当前目录）、装给哪个宿主（`--target`，默认 `dir`）、装哪个版本（`--version`，默认 latest）。其余的在下面的「参数参考」里。

安装的过程如下：

1. 从 registry 取包到临时目录；
2. 用锁里的 `resolved[]` 替换清单引用；
3. 按本次 target 重算计划，和 `lock.planHash` 比对，不一致就拒绝（或用 `--allow-stale-lock` 显式放宽）；
4. 执行安装计划（详情见下）；
5. 跑只读复核。

安装时看到的是这样：

```text
→ 取 lvlc233/doc-review …
✓ register.mcp#1   done   .packhub/config.json
✓ write#1          done   .packhub/knowledge/review-rubric.md
✓ link.skill#1     done   .packhub/skills/doc-review

装上 lvlc233/doc-review@0.1.0 → ./my-project

校验 lvlc233/doc-review@0.1.0：通过
  ✓ [0] file-exists   pass   .packhub/skills/doc-review/SKILL.md
```
如果安装失败，就按快照进行回滚。

### install：就地装

```bash
packhub install ./my-pack --target dir
```
把 `.packhub/` 写进 `./my-pack` 自己。它**不核对锁、不复核、没有输出目录参数**，通常用于作者开发测试，不是正式安装。

### run：干净环境

```bash
packhub run ./my-pack           # 带 install.exec 的包要 --allow-exec
```
把包复制到临时目录，装一遍、验一遍，出完报告就删掉。

### sync：挂到全局

```bash
packhub sync ./my-pack --to dsh,codex,claude-code # 指定安装目标的全局
packhub sync ./my-pack --to . # 安装pack所支持的所有目标的全局位置。
```

### 覆盖

升级或重装一个包，会不会把你改过的东西冲掉，取决于这个文件属于谁。

**包写进来的文件**（skills、knowledge、prompts、合并出来的配置）升级时按新版重写，你在里面手改的内容会被冲掉——这些文件记在 state 里，属于包。想让自己的东西留下来，别改这些文件。

**共享文件**不一样。`.packhub/config.json` 和 `AGENTS.md` / `CLAUDE.md` 的托管块，安装只动自己的键和块，你在同一个文件其它位置写的内容不受影响；卸载也只摘自己那部分。

升级还有一步清理：旧版本产生、新版本不再产生的文件会被删掉。所以“升完少了几文件”不是丢东西，是旧版专属的东西没人用了。

### 其他常用指令

```bash
packhub verify .                            # 复核已装（全量）
packhub update lvlc233/doc-review           # 装新版，再按旧计划清掉不再产出的文件
packhub rollback                            # 退回上一次安装（快照只留最近 5 个）
packhub versions                            # 列已装版本
packhub activate lvlc233/doc-review@0.1.0   # 整版切回，配置与托管块一起重放
packhub uninstall lvlc233/doc-review        # 卸载包，按 state 反向删除
packhub diff                                # 锁与当前计划的差异
```

### 参数参考

取材自 `packhub <命令> --help`（v0.0.1）。

**add**

```
packhub add [OPTIONS] <SOURCE>
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `<SOURCE>` | — | `scope/name`、`packhub://scope/name@1.2.3`、`./x.phub`、`git+https://github.com/o/r@ref` |
| `--index` | `PACKHUB_INDEX` | registry 的 index.json，本地路径或 URL |
| `--version` | latest | registry 包的版本 |
| `--dir` | `.` | 项目目录 |
| `--target` | `dir` | `dir` / `dsh` / `claude-code` / `codex` / `server` |
| `--dry-run` | false | 只打印，不写盘 |
| `--overwrite` | false | 覆盖别的包写过的文件 |
| `--allow-stale-lock` | false | 锁与清单对不上也继续装 |
| `--require-signature` | false | 无有效签名就拒绝 |
| `--allow-unsigned` | false | 配了信任列表也接受无签名 |
| `--trusted` | — | 公钥 id 列表文件，每行一个 |
| `--no-verify` | false | 装完不跑复核 |
| `--deep-verify` | false | 装完也跑 `command` / `mcp-ready` |
| `--json` | false | 结构化输出 |

**install**

```
packhub install [OPTIONS] [DIR]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `DIR` | `.` | 包目录；安装根就是它 |
| `--dry-run` | false | 只打印 |
| `--allow-exec` | false | 允许执行 `install.exec` |
| `--overwrite` | false | 覆盖别的包写过的文件 |
| `--target` | `dir` | 同上 |
| `--index` | — | 远程 `extends` 用的索引 |
| `--json` | false | 结构化输出 |

**run**

```
packhub run [OPTIONS] [DIR]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `DIR` | `.` | 包目录 |
| `--out` | `<dir>/verify.json` | 报告写到哪 |
| `--allow-exec` | false | 允许执行 `install.exec` |
| `--json` | false | 结构化输出 |

**sync**

```
packhub sync [OPTIONS] <DIR> --to <targets>
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `DIR` | — | 包目录（必填） |
| `--to` | 必填 | 逗号分隔：`dsh`、`codex`、`claude-code` |
| `--dry-run` | false | 只打印 |
| `--remove` | false | 从目标移除这个包 |
| `--overwrite` | false | 覆盖别的包占用的 skill 目录 |
| `--json` | false | 结构化输出 |

每个 harness 一份 state（`~/.dsh/.packhub/state.json` 等），卸载与漂移检查按目标分开；非标准 home 用 `PACKHUB_DSH_HOME` / `PACKHUB_CODEX_HOME` / `PACKHUB_CLAUDE_HOME`，目录不存在直接报错。装进 Claude Code 的 MCP 名字记在 `~/.claude/.packhub/state.json` 的 `hostMcp`，`doctor --global` 查它还在不在。

**verify**

```
packhub verify [OPTIONS] [DIR]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `DIR` | `.` | 项目根（用 state 的计划快照）或包目录 |
| `--target` | `dir` | 同上 |
| `--pack` | — | 只验某个包（`name@version`） |
| `--index` | — | 远程 `extends` 用的索引 |
| `--json` | false | 结构化输出 |

**update**

```
packhub update [OPTIONS] <NAME>
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `NAME` | — | 包名 |
| `--index` | 默认 registry | 索引路径、URL，或本机配置里的 registry 名 |
| `--dir` | `.` | 项目目录 |
| `--version` | 最新 | 目标版本 |
| `--target` | 沿用上次 | 一般不用写 |
| `--overwrite` / `--allow-stale-lock` | false | 同 `add` |
| `--no-verify` / `--deep-verify` | false | 同 `add` |
| `--json` | false | 结构化输出 |

**rollback / versions / activate / uninstall / diff**

```
packhub rollback [--generation <id>] [--json] [DIR]
packhub versions [--json] [DIR] [PACK]
packhub activate <name@version> [--no-verify] [--json] [DIR]
packhub uninstall [--pack <name@version>] [--json] [DIR]
packhub diff [--check] [--target dir] [DIR]
```

| 命令 | 关键参数 | 说明 |
|---|---|---|
| `rollback` | `--generation` | 退回哪一代，默认最近一次；快照只留最近 5 个 |
| `versions` | `PACK` | 只看某个包的版本目录与当前激活版本 |
| `activate` | `--no-verify` | 切换后不自动跑 doctor / verify |
| `uninstall` | `--pack` | 只卸这个包，不带就卸全部 |
| `diff` | `--check` | 有差异就以非零码退出（CI 用） |

**doctor / probe**

```
packhub doctor [--global] [--targets dsh,codex,claude-code] [--json] [DIR]
packhub probe [--target dsh|claude-code|opencode|codex] [--patch <file>] [--skill <name>] [--json] [DIR]
```

`doctor --global` 查宿主 home 的同步状态，默认三个目标，没装的标 skipped。`probe` 的 `--target` 是**宿主程序**，不是安装 target；`--skill` 改问技能选择器。

**cache**

```
packhub cache ls [DIR] [--json]
packhub cache clean [DIR] [--dry-run]
```

`clean` 只删没有被任何已装计划引用的缓存，先 `--dry-run` 看清单。

## 包的制作与发布

从一个空目录到一份能发出去的包，大致是这几步：

```bash
packhub init my-pack                                                    # 生成 packhub.yaml
packhub discover "markdown lint" --index registry/index.json            # 从 registry 的资源目录里找
packhub discover "mcp filesystem" --npm                                 # 目录里没有就查 npm
packhub discover "markdown" --index registry/index.json --add 1 --dir my-pack   # 把搜出来的第 1 条写进清单
packhub resource add mcp "npm:@modelcontextprotocol/server-filesystem@1.0.0" --dir my-pack
```

`discover` 读的是 registry 里的 `resources.json`；`--add` 会推断 id，重名加后缀，之后照常 `plan` / `install`。

`source` 能写几种：`npm:`、`pypi:`、`github:owner/repo/子路径@ref`、`https://`、`./` 本地路径，以及 `packhub://scope/name@ver#path`——最后这种从已发布的包里取文件或目录，安装时要求先把被引用的内容 vendored 进包。

资源齐了，先把版本固定下来：

```bash
packhub lock my-pack    # 分支→commit、范围→具体版本、文件→sha256，写进 packhub.lock.json
```

私有来源的 token 别写进清单：`auth.env` 填变量名，值放环境变量，或用 `packhub auth set` 存起来。锁、state 和日志里都不会出现它的值。

然后验证、发布：

```bash
packhub run my-pack        # 干净目录装一遍 + 全量校验
packhub publish my-pack    # 通过之后写 registry
```

`run` 在一份副本里把包装一遍。副本是临时目录，装之前先清掉里面的 `.packhub/`，所以每次都是从零开始。装完跑校验，只有每一步都是 `done` / `noop`、每项检查都 `pass`，报告才算过。

`publish` 做的是同一件事，通过了才往下写：版本目录、`.phub` 归档、索引。它还多两道检查——报告里的 `planHash` 要和锁里的一致，清单里必须声明 `dir`（门禁只验 `dir`）。写出去的版本目录不再改，要动就发新版本。

发出去之后，registry 里长这样：

```
registry/
├── index.json
└── packs/<scope>/<name>/
    ├── <version>.phub          # 包目录打成的归档，add 取的就是它
    └── <version>/              # 版本目录：清单、锁、签名、报告
```

静态站要连 `packs/**/*.phub` 一起发，只发索引会让安装 404。

## 代码分层
| 包 | 负责 |
|---|---|
| `packages/kernel` | 负责解析、能力图、计划、锁、diff等核心判断任务 |
| `packages/runtime` | 下载、安装、卸载、回滚、校验、签名、探针、引用解析 |
| `packages/runner` | 干净目录 install + verify，产出报告 |
| `packages/registry` | 发布、索引生成、门禁 |
| `packages/hub` | 只读 HTTP：索引、包页数据、计划预览 |
| `apps/local` | `packhub` 命令、本地面板 API |
| `packages/web` | 面板、目录、创作台 |

## 本地开发

Node >= 22.13（市场用内置 `node:sqlite`；更早的 22.x 需要实验开关），包管理器用 pnpm。

```bash
pnpm install
pnpm check         # typecheck + 全部测试
pnpm registry:check
pnpm registry:verify-all:offline   # 跳过远程引用，只验本地 registry
pnpm verify:examples:offline       # 示例包逐个真装 + verify
```

## 包市场

包市场是目标。它和“Hub”不冲突，因为市场可以拆成两个平面：

| 平面 | 内容 | 形态 |
|---|---|---|
| 内容平面 | 包、版本、锁、验证报告、归档 | 不可变；git / 对象存储 + CDN |
| 市场平面 | 账号、组织、发布、审核、搜索、统计、评分、计费 | 动态服务 + 数据库 |

Hub 只是内容平面的读端：不接收上传，也不执行包里的代码。写操作在独立的 `@packhub/market` 服务里：

```bash
packhub market serve registry --port 8789            # 加 --require-review --admin-token 开启人工审核
packhub market register http://127.0.0.1:8789 my-team
packhub market publish my-pack --url http://127.0.0.1:8789
packhub market search demo --url http://127.0.0.1:8789
packhub market yank my-team/x@0.1.0 --url http://127.0.0.1:8789
```

- 账号是 `scope`：只能发布 `scope/` 下的包；token 只显示一次，存 `~/.packhub/market.json`（0600）。
- 上传的是 `.phub`；服务端解包、跑干净安装与只读校验（`file-exists` / `config-key` / `knowledge-integrity`），带 `install.exec`、`command`、`scenario`、`mcp-ready` 的包会被拒绝——市场不在服务器上执行上传者的代码。
- 通过后写版本目录、归档并重建 `index.json`；下载计数、审核状态、评分与下架原因落在 `.market/market.db`（SQLite；旧版 `.market/db.json` 首次打开自动导入并改名 `.migrated`）。下架把版本与归档移进 `.market/quarantine/`，索引同步移除，下载返回 410，已发布内容不改字节。
- 管理端：`/admin` 是市场进程自带的页面（审核队列、下载排行、最近审核、token 轮换）；数据接口仍要 `x-market-admin`。管理 token 首次启动写进 `.market/admin.json`（只存 sha256）；`POST /api/admin/rotate` 用旧 token 换新 token，旧值立刻失效。approve / reject / rotate 都追加到 `.market/admin-audit.jsonl`。

## 继续读

需要动手写包时看 [authoring.md](docs/authoring.md)；
需要实现另一个读取方时看 [contract.md](docs/contract.md)；
改界面时看 [ui.md](docs/ui.md)。
要看全部功能点、现状与缺口，见 [PackHub 功能全量清单](docs/checklist/PackHub-功能全量清单.md)。
