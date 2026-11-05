# PackHub

调好一套 Agent 环境要花多久？

装 MCP server、把 skill 放进正确的目录、写提示词、整理项目规范，再确认这些组件能一起工作。换一个项目，这些事再来一遍。交给同事时，通常只能发几个链接，加一句“照我这个配”。

PackHub 把这段工作收进一个 Pack：一份清单说明用了哪些资源、怎么接、装完怎么验；一条命令装进新项目；换一台机器，装出来的是同一套环境。

它和 zip 的区别在这里：zip 解决“把文件搬过去”，PackHub 还要回答“搬过去之后能不能跑”。所以除了文件，它还有版本锁、安装计划、状态记录和验证报告。

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

清单是普通的 YAML：

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

`packhub plan` 把它变成一组动作：

```
write#1          write         .packhub/knowledge/style-guide.md   # 写文件
merge.config#1   merge.config  .packhub/config.json                # 合并配置
```

安装时只执行这几条，不再回头解释清单。同一类动作按出现顺序编号，`write#1` 和 `merge.config#1` 各数各的；想看完整结构，加 `--json`。

`config` 资源写的是 YAML 片段，安装时先解析成对象，再合并进 JSON 配置；源文件格式不影响目标文件格式。

## 概念

读这份文档，先分清四个词，再看 Pack 与 Hub 的关系。

**资源**是清单里的一条声明：`id + type + source`，加上接线字段。它属于某个 Pack，没有全局资源库。

**引用**是定位符、pin 和 `integrity` 的组合。在清单里，它通常写成一整条 `source`（版本或 commit 跟在 `@` 后，哈希放 `integrity` 字段）；解析后，锁把它拆开记录。

**制品**是上游的真实内容：npm tarball、仓库目录、Markdown、归档。制品不写进清单，只在下载和解包时出现。

**能力**是 `provides` / `needs` 里的名字，比如 `tool:repo_search`。它是接口名，不是实现。

`type` 决定资源怎么装：

| type | 安装动作 |
|---|---|
| `mcp` | 只写启动配置，不下载制品 |
| `skill` | 下载 → 解包 → 复制到 skills 目录 |
| `knowledge` / `prompt` | 写入文件 |
| `config` | 合并进配置文件 |
| `tool` | 下载 → 解包 |

所以“装了一个 MCP 资源”，实际动作是登记启动命令，不是把 server 代码复制进项目。server 由配置里的 command 启动：npx / uvx 会在运行时取包，本地命令要预先装好。`tool` 则解到 `.packhub/cache/tools/<id>`，由配置或脚本引用。

把这些资源连起来的工作叫**接线**：谁依赖谁、谁提供什么能力、哪个槽位用哪个实现、共享哪些路径和环境变量。接线不写运行时步骤；“先搜索、再总结”那种事归 skill 或 prompt。`composition.order` 是作者显式指定的安装顺序；不写就按 `dependsOn` 做拓扑排序。

比如 `review-rules` 声明 `needs: [tool:repo_search]`，`repo-search` 声明 `provides: [tool:repo_search]`；前者依赖后者，plan 会先排后者。如果没有任何资源提供这个能力，plan 直接报 `unmet-need`，不会装出一个看起来齐了、实际连不上的包。

写成 YAML 是这两条：

```yaml
resources:
  - id: repo-search
    type: mcp
    source: npm:@modelcontextprotocol/server-everything@0.6.2
    transport: stdio
    provides: [tool:repo_search]

  - id: review-rules
    type: skill
    source: github:lvlc233/skill-hub/skills/code-review@9f2c1ab
    needs: [tool:repo_search]
    dependsOn: [repo-search]
```

`repo-search` 生成 `register.mcp`；`review-rules` 生成 `fetch → unpack → link.skill`，并排在 `repo-search` 之后。

注意：`needs` 只检查有没有提供方，不负责排序；顺序由 `dependsOn` 或 `composition.order` 决定。

槽位也是接线：`slots.voice.contract` 声明一个位置必须提供什么能力，`bindings.voice` 选一个实现；换实现只改这一行。`needs` 是“必须有”，槽位是“多选一”：同一个契约可以有多个候选实现。

Pack 是一组资源，加上接线、覆盖和验收条件。Hub 是存放并分发 Pack 的静态仓库与只读站点；它不执行包，也不接收安装请求。

## 装之前，先算一遍

安装不是照着清单临时解释，而是先生成一份计划。计划是纯数据，描述“会改什么”，不描述“怎么运行”。

```
manifest（声明） → plan（要做什么） → state（做了什么） → report（对不对）
```

这四份数据分别落在不同的地方：

| 数据 | 内容 | 位置 |
|---|---|---|
| manifest | 作者写的清单 | `packhub.yaml` |
| plan | 动作清单与 `planHash` | 内存；安装时存进 state 和 lock |
| state | 每步结果、拥有的文件、计划快照 | `.packhub/state.json` |
| report | 干净安装后的检查结果 | runner / registry 版本目录里的 `verify.json`；不写进安装项目 |

安装后的复核只打印结果，不落 `verify.json`；报告是发布门禁的产物。

另外两份数据是派生的：`lock` 固定引用与计划快照，`index` 汇总已发布版本。六份格式都带 `packhub.dev/v0` 前缀，读方遇到不认识的主版本必须拒绝。

`planHash` 是计划规范化之后算出的 sha256：同样的清单、同样的安装目标，在任何机器上得到同一个字符串。它保护“接线与引用”，不保护制品字节；字节由 `integrity` 保护。

一个 target 一份计划。`lock` 只保存生成时那个 target 的计划快照（默认 `dir`）；`metadata.targets` 声明作者支持哪些 target，不等于一个锁覆盖全部 target。跨 target 安装时，锁只保证引用，目标计划不在锁里。

有了它，四件事才能对上：

| 核对 | 说明 |
|---|---|
| 锁 ↔ 计划 | 清单在锁定后被改过，`lock.planHash` 就对不上 |
| 报告 ↔ 锁 | 报告验的是不是锁住的那一版 |
| 状态 ↔ 计划 | 装完之后清单有没有再变 |
| 索引 ↔ 报告 | `verified` 只在报告通过且哈希一致时成立 |

这四组核对落到字段上只有三个值：

```jsonc
// packhub.lock.json
{ "planHash": "sha256-…", "resolved": [{ "id": "repo-search", "source": "npm:…@0.6.2", "integrity": "sha512-…" }] }

// verify.json
{ "planHash": "sha256-…", "ok": true, "checks": [{ "type": "file-exists", "status": "pass" }] }

// registry/index.json 的一项
{ "name": "me/code-review", "latest": "0.0.1", "trust": "verified" }
```

完整字段在 [contract.md](docs/contract.md)。

还有一条判据：只要有一个动作不是 `done` / `noop`，或者一项检查不是 `pass`，这个包就不算完成。CLI、面板和索引都用同一条。

计划里只有八种动作：

| 动作 | 做什么 |
|---|---|
| `fetch` | 下载制品到缓存 |
| `unpack` | 解包归档 |
| `write` | 写文件 |
| `link.skill` | 把 skill 目录放到目标位置 |
| `register.mcp` | 登记 MCP 启动配置 |
| `merge.config` | 合并配置 |
| `exec` | 执行安装期命令；默认待批准 |
| `instruction` | 写宿主指令文件的托管块 |

资源类型只是决定用哪几个。`instruction` 和 `exec` 不由资源类型产生：前者在 `dsh` / `claude-code` 目标下自动追加，后者来自清单顶层的 `install.exec`。`packhub run` 不会自动批准 exec；带 exec 的包会停在 `needs-approval`，报告不通过。要执行加 `--allow-exec`。overlays 会在最后追加 `write`，所以能盖住前面生成的文件。

## 安装，以及出错之后

安装前先获取 `.packhub/installing.lock`，再把要改写的文件快照到 `.packhub/snapshots/<generation>/`。然后逐条执行动作。
失败时按快照回滚：改写过的文件恢复原内容，新建的文件删除，不写 state，不留 generation。不会出现“磁盘上留下半套文件，但 state 里没有记录”。

成功之后写 state：每个包记录 `planHash`、每步结果、它拥有的文件列表和计划快照。同一个包的新版本会合并旧记录，不会留下两个版本并存。

装完之后，项目里大概是这样：

```
project/
├── .packhub/
│   ├── state.json          # 装了什么、拥有哪些文件
│   ├── active.json         # 每个包当前挂着的版本
│   ├── config.json         # MCP 与配置合并的结果
│   ├── knowledge/          # knowledge 资源
│   ├── prompts/            # prompt 资源
│   ├── skills/             # skill 资源
│   ├── versions/           # 已装版本的产物镜像，可整版切换
│   └── snapshots/          # 安装前快照，用于回退
├── AGENTS.md               # dsh 目标的托管块
└── CLAUDE.md / .mcp.json   # claude-code 目标的托管块与 MCP 配置
```

只有 state 里记录的文件属于这个包；升级和卸载以这份记录为准，回滚用 generation 快照。

安装失败或需要重来时，有三层退路：

- `packhub versions` / `packhub activate <name>@<version>`：每次安装都会把产物镜像进 `.packhub/versions/`，列出版本并把任意已装版本挂回项目；配置、MCP 登记与托管块一起重放。
- `packhub rollback`：按 generation 快照退回一次安装；连续调用可以继续往前退。快照只保留最近 5 个 generation。
- `packhub uninstall`：按 state 里记录的文件反向删除；配置文件只摘自己的键，指令文件只摘自己的块。

`packhub update` 先安装新版本，再按旧计划清掉不再产出的文件。旧计划在安装前从 state 取出；安装时 state 会合并旧记录，清理仍用取出的那一份。

两个包写同一个普通文件时，后装的会被拒绝，除非显式 `--overwrite`。配置文件和根目录的 `.md` 指令文件按共享处理，各写各的部分。

## 覆盖与合并

`overrides` 修改一个资源的 pin 或安装参数；`overlays` 在安装最后按文件盖上去。前者改清单，后者改文件。

`merge.config` 做深合并：对象逐键合并，数组整体替换。两个普通动作写同一个文件、两个配置片段改同一个键，plan 阶段就会报错。覆盖层是例外：盖住生成文件只给警告（这是它的用途），两个覆盖层改同一个文件仍然是错误。

## 作者怎么发

发布前要把引用固定下来。先写 `packhub.yaml`，或者用 `packhub init` 起骨架、`packhub resource add` 逐项添加。`source` 支持 `npm:`、`github:`、`pypi:`、`https://` 和 `./` 本地路径。`packhub lock` 会解析这些引用，把分支换成 commit、范围换成具体版本、文件算出 sha256，然后写进 `packhub.lock.json`。解析不到就保留原样并给出警告，不假装锁住。

私有来源不在清单里写 token：`auth.env` 只写变量名，值放环境变量或 `packhub auth set`。锁、state 和日志都不保存 token。

接着在干净目录里完整装一遍：

```bash
packhub run my-pack
```

它复制一份包到临时目录，清掉安装状态，执行计划，再跑 `verify`。只有每一步都是 `done` / `noop`、每项检查都 `pass`，报告才算通过；任何一步不完整，`packhub publish` 都会拒绝。带 `install.exec` 的包要执行命令，需显式加 `--allow-exec`（`packhub run` 和 `packhub publish` 都接受）。

最后：

```bash
packhub publish my-pack
```

只有 `packhub run` 通过、且报告与锁的 `planHash` 一致，才会写版本目录、`.phub` 归档和索引。发布门禁只验证 `dir` target，所以清单必须声明 `dir`。已发布的版本目录不可变，要改只能发新版本。

registry 的结构很直接：

```
registry/
├── index.json
└── packs/<scope>/<name>/
    ├── <version>.phub
    └── <version>/
        ├── packhub.yaml
        ├── packhub.lock.json
        ├── packhub.signatures.json
        └── verify.json
```

`index.json` 是生成的，不手写。静态站必须把 `packs/**/*.phub` 一起发布，否则页面上的安装命令会 404。签名文件随版本目录和 `.phub` 一起分发。

索引里的 `trust` 只有两档：`verified`（报告通过且哈希一致）和 `community`（其余）。签名结果单独记录，不混进这个标记。

## 使用者怎么装

命令来自本项目的 `packhub` CLI。开发时用 `pnpm packhub …`；`pnpm build:local` 生成可分发的单文件包。registry 页面上的 `npx packhub` 依赖发布到 npm 的 CLI；本仓库当前从源码运行。默认 registry 用 `PACKHUB_INDEX` 设；单条命令也可以加 `--index`。

```bash
export PACKHUB_INDEX=/path/to/registry/index.json
packhub add lvlc233/code-review
```

`add` 不只看清单。它先用锁里的 `resolved[]` 替换清单引用，再按锁的 target 重算计划，和 `lock.planHash` 比对；不一致就拒绝。确认后，按你选的 target 生成安装计划并执行。

实际输出大概是这样：

```text
→ 取 lvlc233/team-conventions …
✓ merge.config#1   done   .packhub/config.json
✓ write#1          done   .packhub/knowledge/style-guide.md
✓ write#2          done   .packhub/prompts/commit-rules.md
✓ merge.config#2   done   .packhub/config.json

装上 lvlc233/team-conventions@0.0.1 → ./project

校验 lvlc233/team-conventions@0.0.1：通过
  ✓ [0] file-exists  pass  .packhub/knowledge/style-guide.md
```

装完会自动跑清单里的只读检查：`file-exists`、`config-key`、`knowledge-integrity`。`command` 和 `mcp-ready` 会运行包里的命令或启动 server，所以默认不跑；需要时加 `--deep-verify`。

清单里的检查这样写：

```yaml
verify:
  - type: file-exists
    path: "${target.knowledgeDir}/style-guide.md"

  - type: config-key
    path: "${target.configFile}"
    key: "mcpServers.repo-search.command"
```

只读检查只读取安装结果，不改写文件。检查结果只有 `pass` / `fail` / `skipped`；`skipped` 不算通过，发布门禁要求每一项都 `pass`。

`${target.*}` 由安装目标提供：`root`、`skillsDir`、`knowledgeDir`、`promptsDir`、`configFile`；`dsh`、`claude-code`、`codex` 还有 `instructionFile`。

签名回答的是来源问题：这个包由谁发布。签名用 ed25519：`packhub keygen` 生成密钥，`packhub sign` 写入 `packhub.signatures.json`，`--trusted` 指定信任哪些公钥。`--require-signature` 时没有有效签名就拒绝安装。

安装目标决定文件落在哪：

| target | 写入位置 |
|---|---|
| `dir` | 项目内的 `.packhub/`，不修改宿主配置 |
| `dsh` | `.packhub/` + `AGENTS.md` 里的托管块 |
| `claude-code` | `.claude/skills/` + `.mcp.json` + `CLAUDE.md` 托管块 |
| `codex` | 项目内 `.codex/skills/` + `AGENTS.md` 托管块；全局同步时是 `~/.codex/skills/` |

`metadata.targets` 声明作者支持的范围；`--target` 必须在其中，否则安装直接拒绝。

托管块用 `<!-- packhub:begin <包名> -->` 标记。安装只改块内，卸载只移除自己的块；宿主重写整个文件时，`packhub doctor` 能发现。

`packhub probe` 会调用一次宿主（DSH / OpenCode / Codex / Claude Code）的 headless 入口，让它复述托管块里的标记，确认宿主确实读取了这份指令。`probe` 的参数是宿主程序，不是安装 target；OpenCode 没有专门的投影，验证的是项目里的 `AGENTS.md`。

## 同步到全局 harness

skill-only 的 Pack 可以不装进项目，直接同步到宿主的全局 skills：

```bash
packhub sync me/my-pack --to dsh,codex
packhub sync me/my-pack --to dsh,codex --dry-run
packhub sync me/my-pack --to dsh,codex --remove
packhub doctor --global
```

- 只接受 `type: skill` 且来源是本地目录；MCP / CLI / 配置需要各自的 adapter，暂不混进来。
- 安装前解析 `SKILL.md` 的 YAML frontmatter，`name` / `description` 不合法直接拒绝，避免 DSH 不报错、Codex 却加载失败。
- 每个 harness 自己一份 state：`~/.dsh/.packhub/state.json`、`~/.codex/.packhub/state.json`；卸载和漂移检查按目标分开。
- 不写全局 `AGENTS.md`，也不改 MCP 配置；只动 `skills/`。
- 非标准 home 用 `PACKHUB_DSH_HOME` / `PACKHUB_CODEX_HOME`，测试就靠它隔离；目录不存在时直接报错，不会替你创建宿主目录。

日常还会用到：`packhub verify .`（复核已装）、`packhub update`（升级）、`packhub rollback`、`packhub uninstall`、`packhub diff`（锁与当前计划对比）、`packhub search`。

## 界面与可见性

`packhub serve` 起本地面板：左侧是包，右侧是组成、计划、校验和本机状态。`packhub hub` 起只读发布站，提供 `/packs` 目录与包页。

面板底部有「Harness 同步」卡片：对 skill-only 的包，勾选 `dsh` / `codex`，可以直接预演、同步或移除；同步结果按 target 显示，失败原因原样打印。

包有四档可见性，写在 `metadata.visibility`：`public` 进公共索引；`unlisted` 不进索引，但用 `--index` 指向同一 registry、加 `--version` 可以绕过索引直接取归档；`internal` 放在内网 registry；`private` 不发布。registry 门禁只收 `public`。

## 代码分层

原则只有一句：**判断在 kernel，执行在 runtime，发布在 runner 与 registry，读取在 hub，呈现只在 web。**

| 包 | 负责 |
|---|---|
| `packages/kernel` | 解析、能力图、计划、锁、diff；不出网、不写盘 |
| `packages/runtime` | 下载、安装、卸载、回滚、校验、签名、探针、引用解析 |
| `packages/runner` | 干净目录 install + verify，产出报告 |
| `packages/registry` | 发布、索引生成、门禁 |
| `packages/hub` | 只读 HTTP：索引、包页数据、计划预览 |
| `apps/local` | `packhub` 命令、本地面板 API |
| `packages/web` | 面板、目录、创作台、表单 demo |

判断只写一次。如果同一条规则在 CLI 和面板里各写一遍，两边迟早会给出不同答案。

仓库其余部分：`registry/` 是静态仓库，`schema/` 是清单 schema，`examples/` 是几个示例包（`doc-review` 是最近一个真实需求案例），`scripts/` 是 registry 与打包脚本。

## 本地开发

Node >= 22.6，包管理器用 pnpm。

```bash
pnpm install
pnpm check         # typecheck + 全部测试
pnpm registry:check
```

直接跑 CLI：`pnpm packhub plan examples/team-conventions`。

## 现在能做什么

- 六类资源、八个安装动作、三个 target。
- 能力图、槽位替换、资源级与文件级覆盖、冲突检测。
- 引用解析与锁定：版本、commit、sha256。
- 失败回滚、generation 快照、`rollback`、`update`、`uninstall`。
- 干净环境发布门禁、静态 registry、只读 Hub、Pages 产物。
- 使用者侧：默认 registry、锁校验、签名提示、安装后复核。
- 深校验：文件、配置、命令、stdio MCP 握手、内容哈希。
- 接入宿主：Claude Code 与 DSH 的投影、托管块、真实宿主探针。
- 全局同步：skill-only Pack 一条命令写进 DSH / Codex 的全局 `skills/`，按目标记录状态，可 dry-run / remove / doctor。

一个真实的组包案例（需求 → 搜资源 → 筛选 → 成包）见 [examples/doc-review/README.md](examples/doc-review/README.md)。

## 还不能做什么

- 版本切换是产物副本重铺，不是硬链接；保留最近 5 个版本目录，更早的要重新安装。
- 一个锁只覆盖一个 target；跨 target 安装时，锁只保证引用，目标计划没有被 `planHash` 校验。
- 没有 SSH 部署与常驻同步 agent。
- 没有 scenario 探针（执行最小任务并检查行为）。
- `mcp-ready` 只支持 stdio，http 传输跳过。
- 没有 `PACK.md` / `CHANGELOG` 的包页渲染。
- 没有工具白名单、上下文范围、写入边界这类隔离能力。
- `exec` 的外部副作用无法回滚；清单里的 `undo` 只记录，不自动执行。
- 记忆系统没有一等公民支持：可以用 `mcp` + `knowledge` + `paths` 组合，持久状态目录的 `state` 块尚未实装。

## 包市场

包市场是目标。它和“只读 Hub”不冲突，因为市场可以拆成两个平面：

| 平面 | 内容 | 形态 |
|---|---|---|
| 内容平面 | 包、版本、锁、验证报告、归档 | 不可变；git / 对象存储 + CDN |
| 市场平面 | 账号、组织、发布、审核、搜索、统计、评分、计费 | 动态服务 + 数据库 |

现在的 Hub 只是内容平面的读端：不接收上传，也不执行包里的代码。市场需要账号、审核、统计和写操作，这些放在独立的发布服务与市场 API 里；包内容仍按版本不可变。

路线：

- **0.x（现在）**：静态 registry + 只读 Hub，发布走本地或 CI。
- **下一步**：托管发布（认证 + 沙箱验证 + 对象存储），Hub 不变。
- **再下一步**：市场元数据（搜索、统计、评分、审核、团队/私有 registry）。
- **交易与许可**：尚未决定。要做就接在市场平面，不改包格式。

需要先定三件事：账号归属（个人/组织/scope 认领）、验证在哪跑（平台沙箱或只收 CI 报告）、已发布版本是否永远不可变（建议是，下架用可见性标记）。

仍然不做：接管 Agent 执行、自建 MCP 网关、替用户运行工作负载。

## 继续读

需要动手写包时看 [authoring.md](docs/authoring.md)；需要实现另一个读取方时看 [contract.md](docs/contract.md)；改界面时看 [ui.md](docs/ui.md)。要看全部功能点、现状与缺口，见 [PackHub 功能全量清单](docs/checklist/PackHub-功能全量清单.md)。
