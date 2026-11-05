# 作者怎么做一个 Pack

术语与 [README](../README.md) 一致：“资源”指 `packhub.yaml` 里的一条声明，不是上游制品。

三条路，按成本从低到高。现在能用的只有前两条。

| 方式 | 适合 | 现状 |
|---|---|---|
| 手写 `packhub.yaml` + schema 补全 | 已经知道要装什么 | 可用 |
| `packhub resource add` 增量追加 | 边试边加，不想手抄格式 | 可用 |
| 可视化编辑器（D） | 不熟悉 YAML 的人 | 只有 demo |

---

## 〇、packhub.yaml 长什么样

### 最小可用（13 行）

```yaml
apiVersion: packhub.dev/v0   # 清单格式版本；目前只有这一个合法值
kind: Pack                        # 固定 Pack，给以后别的类型留位

metadata:
  name: lvlc233/my-pack           # scope/name，scope 用 GitHub 用户名；这是全局主键
  version: 0.0.1                  # 语义化版本；发布后不可改，改动要发新版本
  targets: [dir]                  # 能装到哪：dir / dsh / claude-code / codex

requires:
  packhub: ">=0.0.1 <0.1"         # 需要的平台版本范围；不在范围内就拒绝执行

resources:                        # 至少一项
  - id: style-guide               # Pack 内唯一，小写字母开头，只含 a-z0-9-
    type: knowledge               # mcp / skill / prompt / knowledge / config / tool
    source: ./resources/style-guide.md   # 从哪来；决定这份清单能不能被别人复现
```

四个必填块：`apiVersion` + `kind`、`metadata`（name / version / targets）、`requires.packhub`、`resources[]`。`resources` 里至少一项，每项要 `id` / `type` / `source`。

---

### 六种资源各长什么样

先澄清一件事：**下面六段都不是单独的文件**。它们全都是同一个 `packhub.yaml` 里 `resources:` 列表中的一项，彼此并列。一个 Pack 只有一个 `packhub.yaml`。

```yaml
resources:                    # ← 唯一的列表
  - id: repo-search           # ← 第 1 项（下面第 1 段的 mcp）
    type: mcp
    source: npm:@modelcontextprotocol/server-everything@0.6.2
  - id: review-rules          # ← 第 2 项（第 2 段的 skill），与上面平级
    type: skill
    source: github:owner/repo/skills/code-review@<40 位 commit>
```

#### 1. `mcp` —— 只写配置，不下载制品

```yaml
- id: repo-search
  type: mcp
  source: npm:@modelcontextprotocol/server-everything@0.6.2
  transport: stdio
  config:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything@0.6.2"]
    env:
      ROOT: .
  provides: [tool:repo_search]
```

- **判定**：能被 `npx` / `uvx` 启动、通过 stdio 或 http 通信的 MCP Server。
- **安装期**：只生成 `register.mcp`，写进目标环境的 MCP 配置；制品由目标环境在运行时获取。`transport` 必填。
- **安装后的位置**：`.packhub/config.json` 的 `mcpServers.<id>`。
- **verify 写什么**：`config-key`（确认 command 写对了）；`mcp-ready` 会真发一次 initialize（stdio 与 http 都支持）。

#### 2. `skill` —— 必须指到含 SKILL.md 的目录

```yaml
- id: review-rules
  type: skill
  source: github:lvlc233/skill-hub/skills/code-review@9f2c1ab7d4e5f60718293a4b5c6d7e8f90123456
  provides: [skill:code_review]
```

- **判定**：一个目录，里面有 `SKILL.md`（Agent Skills 的约定）。
- **安装期**：`fetch`（整仓 tarball）→ `unpack`（去掉仓库顶层目录）→ `link.skill` 拷贝到 skills 目录。`github:owner/repo/sub/path@ref` 的 `sub/path` 会在解包后按路径取。
- **安装后的位置**：`.packhub/skills/<id>/`。
- **verify 写什么**：`file-exists` 指到 `"${target.skillsDir}/<id>/SKILL.md"`。
- **注意**：`github:` 的 pin 必须是 commit；写 `@main` 会被拒。

#### 3. `prompt` —— 一段模板，不是代码

```yaml
- id: commit-rules
  type: prompt
  source: ./resources/rules.md
  provides: [prompt:commit_message]
```

- **判定**：要喂给 Agent 的提示词/角色/输出约定。
- **安装期**：本地源直接 `write`；远程源 `fetch`。按源文件 basename 落到 prompts 目录。
- **安装后的位置**：`.packhub/prompts/<文件名>`。
- **verify 写什么**：`file-exists`。

#### 4. `knowledge` —— 文档、规范、资料

```yaml
- id: house-style
  type: knowledge
  source: https://raw.githubusercontent.com/lvlc233/PackHub/533147315257260f9054947f1ece2ba20588bc93/README.md
  integrity: sha256-CtMPyOdCbw/DtVRSFoKxJ4FbnhiPq2f92mvzzF5MR5Q=
```

- **判定**：要被引用而不是被执行的资料。
- **安装期**：https 必须带 `integrity`（sha256），下载即校验；本地源直接拷贝。
- **安装后的位置**：`.packhub/knowledge/<文件名>`。
- **verify 写什么**：`file-exists`；要更强的保证可写 `knowledge-integrity`（按 sha256 在产物里找文件）。
- **注意**：指向会变的内容（分支上的文件）时，integrity 迟早会失效——**pin 到 commit**。

#### 5. `config` —— 只合并，不覆盖

```yaml
- id: agent-config
  type: config
  source: ./fragments/agent.yaml
```

- **判定**：一小段要并进目标配置的 YAML/JSON（不要写成完整配置文件）。
- **安装期**：`merge.config` 深合并进 `.packhub/config.json`；数组整体替换，对象逐键合并。原文件不存在则创建。
- **安装后的位置**：`.packhub/config.json`。
- **verify 写什么**：`config-key` 检查某个键的最终值。
- **注意**：合并前会备份原内容到 `.packhub/backups/`。

#### 6. `tool` —— CLI、脚本、独立二进制

```yaml
- id: biome
  type: tool
  source: npm:@biomejs/biome@1.9.4
```

- **判定**：有自己的命令行入口，安装后供人或 Agent 直接调用。
- **安装期**：`fetch` → `unpack` 到 `.packhub/cache/tools/<id>/`，再读 `package.json` 的 `bin`，在 `.packhub/bin/<命令>` 生成跨平台 wrapper（Windows 是 `.cmd`）。`config.bin` 可指定用哪个 bin 名。
- **安装后的位置**：制品在 `.packhub/cache/tools/<id>/`，入口在 `.packhub/bin/`。**不会**自动加到 `PATH`；让 agent 用绝对路径，或在指令里写清 `.packhub/bin/<命令>`。
- **verify 写什么**：`command` 跑一次 `.packhub/bin/<命令> --version`，或 `file-exists` 指到入口。
- **注意**：需要执行命令（安装脚本、`git config`）时写 `install.exec`；默认拒绝执行，需要 `--allow-exec`。

### 完整的（每条批注都是真实现状）

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lvlc233/PackHub/main/schema/packhub.v0.schema.json
apiVersion: packhub.dev/v0
kind: Pack

metadata:
  name: lvlc233/code-review          # scope/name，scope 用 GitHub 用户名
  version: 0.0.2                     # 语义化版本；发布后不可改
  title: 代码审查整合包               # 列表页显示的标题
  description: 组合代码检索 MCP、审查规范 Skill 与团队规范知识，装完即可用。
  license: MIT
  homepage: https://github.com/lvlc233/PackHub
  keywords: [code-review, mcp, skill]
  authors:
    - name: lvlc233
  targets: [dir, dsh]                # 支持的目标环境，dir = 中性目录

requires:
  packhub: ">=0.0.1 <0.1"            # 平台版本范围；发布时必填
  agent: ">=0.0.1"                   # 可选：目标 Agent 版本

vars:                                # 可被 ${vars.x} 引用；0.0.2 只读，不支持安装期覆盖
  projectRoot: "."
  strict: true

resources:
  - id: repo-search                  # Pack 内唯一
    type: mcp                        # mcp / skill / prompt / knowledge / config / tool
    source: npm:@modelcontextprotocol/server-everything@0.6.2
    transport: stdio                 # mcp 必填
    config:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-everything@0.6.2"]
      env:
        ROOT: ${vars.projectRoot}    # 插值发生在生成计划时，写进配置的是真值
    provides: [tool:repo_search]

  - id: review-rules
    type: skill
    source: github:lvlc233/skill-hub/skills/code-review@9f2c1ab   # 必须 40 位 commit
    dependsOn: [repo-search]         # 安装顺序；不是能力依赖
    provides: [skill:code_review]
    needs: [tool:repo_search]        # 能力依赖；没人提供就报 unmet-need

  - id: house-style
    type: knowledge
    source: https://raw.githubusercontent.com/lvlc233/PackHub/main/README.md
    integrity: sha256-CtMPyOdCbw/DtVRSFoKxJ4FbnhiPq2f92mvzzF5MR5Q=
    provides: [knowledge:house_style]

  - id: agent-config
    type: config
    source: ./fragments/agent.yaml   # 合并进目标配置，不覆盖其它键

composition:
  env:                               # 写进目标 config 的 env，所有资源共享
    REVIEW_ROOT: ${vars.projectRoot}
    STRICT: "${vars.strict}"
  order: [agent-config, repo-search, review-rules]   # 省略则按 dependsOn 拓扑排序
  needs:                             # 整个 Pack 层面的依赖声明
    - capability: skill:code_review
      requires: [tool:repo_search, knowledge:house_style]
      bind: review-rules             # 绑定到具体实现，锁住行为

verify:                              # 发布时必须有；本地可先留一条
  - { type: mcp-ready, resource: repo-search, timeout: 30 }
  - { type: file-exists, path: "${target.skillsDir}/review-rules/SKILL.md" }
  - { type: config-key, path: "${target.configFile}", key: "mcpServers.repo-search.command", equals: npx }
```

### 覆盖：mod 的 mod

上游组件保持原样，本项目在它上面叠一层。这是 MC 整合包 `overrides/` 的同款机制：

```yaml
apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: lvlc233/my-pack-overlay
  version: 0.0.2
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
resources:
  - id: style-guide
    type: knowledge
    source: ./resources/style-guide.md
overlays:
  - from: ./overrides          # 目录结构 = 目标路径结构
    include: [.md]             # 可选：只盖匹配的文件
    note: 把上游那份规范换成本项目的规范
```

`overrides/.packhub/knowledge/style-guide.md` 这个文件，会在安装最后一步盖掉生成的那份。规则：

- **覆盖层最后执行**，所以能盖住任何生成物（配置、skill 里的文件、知识）。
- 盖住生成文件得到一条 `overlay-shadows` **警告**（提醒是有意的），不是错误。
- 两个覆盖层改同一个文件 → `overlay-conflict` 报错。
- 覆盖层可以带二进制（图片、字体），安装时按字节拷贝，不做文本转换。
- 覆盖层会被打进包里分发：**不要放凭证**。

两个容易混的字段：

| 字段 | 作用 | 例子 |
|---|---|---|
| `overrides`（资源级） | 换掉某个资源的 pin / 实现 / 安装参数 | 上游用 `@0.6.2`，本项目锁 `@0.6.3` |
| `overlays`（文件级） | 安装完成后按路径覆盖文件 | 把上游的 `SKILL.md` 换成加了团队规则的版本 |

### 继承与本地覆盖

`extends: ../base` 继承一个本地父 Pack；`extends: packhub://scope/name@1.0.0` 从 registry 取远程父包（落在子包 `.packhub/cache/extends/`，路径相对子包，planHash 跨机器一致）。单个资源也可以引用已发布包里的文件或目录：`source: "packhub://scope/name@1.0.0#docs/guide.md"`（skill 则指向目录）；安装期同样落进 `.packhub/cache/packhub/`，`lock` 与 `publish` 要求先 vendored。父包的 `resources`、`composition`、`slots`、`bindings`、`paths`、`overrides`、`verify` 一起合并；子包同名资源覆盖父包，`metadata` 与 `requires` 以子包为准；父包的本地 source 会被改写成相对子包的路径，安装时能读。成环报 `extends-cycle`。远程继承要求 `--index` / `PACKHUB_INDEX`；发布前要扁平化，否则 `publish` 会拒绝。

使用者侧的 `.packhub/local.yaml` 不进清单、不进锁，只覆盖这一次安装：

```yaml
# 项目根的 .packhub/local.yaml
overrides:
  - resource: repo-search
    source: npm:@scope/search@1.4.0
bindings: { voice: elevenlabs }
vars: { SEARCH_ROOT: ./docs }
composition:
  env: { FLAVOR: local }
```

`packhub add` 与 `packhub plan` 都会读它；清单本身不被改写。覆盖后的计划如果与锁里的 `planHash` 对不上，`add` 仍会按锁核对——这是有意的：本地覆盖是使用者的显式选择，不是绕过来源校验的后门。

### 包说明与变更记录

根目录放 `PACK.md`（用途、示例）与 `CHANGELOG.md`（按版本写改了什么），`packhub publish` 会把它们复制进版本目录；`packhub hub` 的包页与市场 `/api/packs` 直接返回原文。它们不参与 `planHash`，也不影响安装。

### 槽位与路径：换实现只改一行

**槽位（slot）** 是可替换的位置：同一个位置可以有多个候选实现，`bindings` 决定这次装哪个。

```yaml
apiVersion: packhub.dev/v0
kind: Pack
metadata:
  name: demo/voice-pack
  version: 0.0.1
  targets: [dir]
requires:
  packhub: ">=0.0.1 <0.1"
slots:
  voice:
    contract: [audio:speak]        # 占这个位的实现必须提供什么
paths:
  state: .packhub/state            # 包统一发号施令的路径
resources:
  - id: tts-a
    type: tool
    slot: voice
    source: npm:tts-a@1.2.0
    provides: [audio:speak]
  - id: tts-b
    type: tool
    slot: voice
    source: npm:tts-b@0.4.0
    provides: [audio:speak]
bindings:
  voice: tts-b                     # 只装这个；tts-a 记为 excluded
verify:
  - type: file-exists
    path: "${paths.state}/voice.json"
```

规则：

- **候选留在清单里**，装不装由 `bindings` 决定；未绑定的候选不进计划，会在 `excluded` 里注明原因。
- **契约要满足**：绑定的实现必须 `provides` 覆盖 `slot.contract`，否则报 `slot-contract-unmet`。
- **有候选但没绑定** → `slot-unbound`（不猜你装哪个）。
- 换实现：`packhub slot swap voice tts-a`，只改 `bindings` 一行，并打印计划差异（卸掉谁、装上谁）。

**路径（paths）** 解决“资源各读各的默认位置”。包里统一声明，资源里用 `${paths.x}` 引用，生成计划时求值：

- 必须是目标目录内的相对路径；`../` 或绝对路径直接报 `bad-path`。
- 可以用在资源 `config`、`composition.env`、`verify`、`overlays` 的路径里。

能力名统一写成 `命名空间:名字`（`audio:speak`、`memory:read`、`tool:repo_search`），槽位契约与 `provides` / `needs` 用同一套写法。

### 生成物不要手写

| 文件 | 谁生成 | 干什么 |
|---|---|---|
| `packhub.lock.json` | `packhub lock` | 钉死每个引用，供复现与审查 |
| `.packhub/state.json` | `packhub install` | 这台机器上装了什么、写了哪些文件 |
| `verify.json` | `pnpm registry:verify` | 干净环境里的校验报告，`verified` 的唯一依据 |
| `registry/index.json` | `pnpm registry:index` | 站点与 `search` 读的清单 |

> **本页是维护对象，不是一次性说明。** 所有 `yaml` 代码块都由 `packages/runtime/test/docs-examples.test.ts` 提取并实际跑 `loadPack` + `planFor`：完整清单必须零错误，六段资源示例必须能单独生成计划、且六种类型都要覆盖。改文档时如果示例不能跑，测试会红。
>
> 加新示例的规矩：资源片段以 `- id:` 开头、单独成块；不要用编造得看不出来的 pin（commit 可以是假哈希，但**格式必须合法**，因为它们会被真的解析）。

---

## 一、从零到能装：四步

```bash
# 1. 起一个骨架（自带 schema 绑定与一个示例资源）
packhub init my-pack --name lvlc233/my-pack

# 2. 逐个加资源（类型 + 来源），加完立刻重算计划
packhub resource add mcp   "npm:@modelcontextprotocol/server-filesystem@1.0.0" --dir my-pack
packhub resource add skill "github:lvlc233/skill-hub/skills/code-review@9f2c1ab" --dir my-pack
packhub resource add knowledge "https://example.com/style.md" --dir my-pack

# 3. 看它打算做什么（不落盘）
packhub plan my-pack

# 4. 真装一遍再校验（装进临时目录，不污染仓库）
cp -r my-pack /tmp/try && packhub install /tmp/try && packhub verify /tmp/try
packhub lock my-pack          # 成功后把解析结果（含计划快照）钉死
packhub sign my-pack --key packhub.key   # 可选：给计划哈希签名（别人能验来源）
packhub licenses my-pack --strict        # vendored 资源必须有许可证文件才能发布
packhub probe my-pack --target dsh       # 真机探针：harness 有没有读到写进去的指令（需要模型凭证）
packhub probe my-pack --target opencode  # 同上，OpenCode：opencode run --model opencode-go/…
packhub probe my-pack --target codex     # 同上，Codex：codex exec -m gpt-5.6-sol（原生账号）

# 8. 发布：干净安装 + 校验通过才写进 registry
packhub publish my-pack --registry ./registry

# 5. 之后改了清单，先看差异再重新锁
packhub diff my-pack          # 对比锁里的计划与当前计划：多了什么、少了什么

# 6. 不想要了就按记录删干净
packhub uninstall my-pack     # 按 .packhub/state.json 的 written 反向删除

# 6.5 装坏了就退回上一步
packhub rollback my-pack      # 用安装前的快照恢复被改写的文件、删掉本次新建的

# 6.5b 从归档或 git 仓库直接装
packhub add ./demo.phub                       # 本地 .phub
packhub add git+https://github.com/o/r@v1.0.0  # GitHub / GitLab 仓库（走 archive 端点）

# 6.6 别人装了你发的包，升级
packhub update lvlc233/team-conventions --index <registry/index.json>

# 6.7 两个包抢同一个文件时
packhub install my-pack --overwrite   # 默认会拒绝并指出占用者，确认要覆盖才加


# 7. 装进某个宿主（投影到 harness 会读的位置）
packhub install my-pack --target claude-code   # .claude/skills + .mcp.json + CLAUDE.md 托管块
packhub install my-pack --target dsh           # .packhub/skills + AGENTS.md 托管块
packhub install my-pack --target codex         # .codex/skills + AGENTS.md 托管块
packhub install my-pack --target dir           # 只物化到 .packhub（默认）

# 7.5 skill-only 的包同步到全局 harness（只动 skills/）
packhub sync my-pack --to dsh,codex
```

`resource add` 做的是**结构化编辑**：追加一个资源节点、保留注释、推断 id（重名自动加 `-2`），然后立刻跑一遍清单校验和计划生成。它不做类型推断——`type` 必须由你给，因为同一个 npm 包既可能是 `mcp` 也可能是 `tool`。

---

## 二、每个字段怎么定

### `type`：先问「它怎么被用」

| 制品形态 | type | 安装动作 |
|---|---|---|
| 能被 npx/uvx 启动的 MCP Server | `mcp` | 只写配置，不下载 |
| 带 `SKILL.md` 的目录 | `skill` | 下载 → 解包 → 挂载 |
| 提示词模板 | `prompt` | 写入 prompts 目录 |
| 规范/文档/知识 | `knowledge` | 下载或复制 |
| 要合并进配置的片段 | `config` | 合并到 config.json |
| CLI 或脚本 | `tool` | 下载 → 解包 |

### `source`：决定可复现性

现在实际可用的是五类（`packhub://` 只在 schema 里声明，还没有下载实现）：

```
npm:@scope/pkg@1.2.3                      # npm 包（MCP server 常用）
github:owner/repo/sub/path@<40位 commit>  # GitHub 仓库/子目录，codeload tarball
https://…/x.tar.gz                        # 任意 https 归档（GitLab/Gitea/内网均可）
https://…/note.md                         # 任意 https 单文件（knowledge / prompt）
./resources/x.md                          # 本地，随包 vendored
```

| 来源 | 适合 | 安装动作 |
|---|---|---|
| `npm:` | 通过 npx 分发的 MCP server | 只登记启动命令，不下载制品 |
| `github:` | 仓库里的 skill 目录、工具、文档 | 下载 tarball → 解包 → 按子路径挂载 |
| `https: … .tar.gz` | 公司 GitLab / Gitea 的 archive、任何归档 | 下载 → 解包（`skill` / `tool` 必须给归档；单文件给 `knowledge` / `prompt`） |
| `./…` | 本地草稿、必须随包分发的内容 | 直接复制（发布前要 vendored 进版本目录） |

**40 位 commit 的来源**：GitHub commit 页地址中的那串；或 `git rev-parse HEAD`；或 `git ls-remote https://github.com/o/r refs/heads/main`。不接受 `@main`、`@latest`，它们会漂移。

**PyPI 来源**：`source: pypi:six@1.16.0`（必须 pin 版本）。安装时先查 `https://pypi.org/pypi/<name>/<version>/json`，取 **sdist 的 .tar.gz** 再按 skill / tool 解包。只有 wheel 的包会被拒绝：wheel 是 zip，PackHub 不安装二进制。内网镜像可以把 `HTTPS_PROXY` 指向镜像。

**公司 GitLab / Gitea 来源**：使用 archive 下载链接（形如 `https://gitlab.example.com/g/p/-/archive/<sha>/p-<sha>.tar.gz`），配置 `integrity`，`type` 用 `skill` 或 `tool`。私有仓库的鉴权目前没有支持（不带 token），内网场景建议直接把内容 vendored 进包。

规则：**发布版必须指向不可变的版本或 commit**。`@main`、`@latest`、`^1.0.0` / `~1.2` 这类范围、无 integrity 的 https 都会在 `plan` 阶段被拒（范围今天解析到 1.4.0，明天可能是 1.5.0，不算锁住）。
`packhub lock` 会联网把分支/范围/单文件解析成 commit、具体版本与 sha256；解析不到就保留原样并给 warning，不假装锁住。`--offline` 可以只锁本地与已 pin 的引用。
**私有来源**：manifest 里只写「需要哪个凭证」，值从环境变量取：

```yaml
  - id: internal-rules
    type: skill
    source: https://gitlab.corp.example/g/agent/rules/-/archive/abc123/rules-abc123.tar.gz
    integrity: sha256-9pQw3k2XmB7dLr0yTn5vZc8aS1eF4gH6jK0mN2oP4q=
    auth:
      env: CORP_GITLAB_TOKEN
      scheme: bearer
```

缺变量时安装会直接报 `需要 CORP_GITLAB_TOKEN…`；token 不写进清单、锁、state 或日志。

**可见性**：`metadata.visibility` 四档 `public` / `unlisted` / `internal` / `private`，**默认 private**。要进公共 registry 必须显式写 `visibility: public`，否则 `registry:check` 会拒绝——默认公开迟早泄露一次。

### `provides` / `needs`：只在有依赖时写

- `provides`：这个资源对外提供什么能力（`tool:repo_search`、`skill:code_review`、`knowledge:house_style`）。
- `needs`：它依赖什么能力。没人提供的 `needs` 会在校验时报 `unmet-need`。

不是所有包都需要。只有「A 要能看见 B 提供的能力」时才写——这既是安装顺序的依据，也是 Pack 与「资源清单」的分界线。

### `verify`：写你愿意为它背书的检查

```yaml
verify:
  - type: file-exists          # 最常用的，确认落盘位置对
    path: "${target.skillsDir}/review-rules/SKILL.md"
  - type: config-key           # 确认配置真的合并进去了
    path: "${target.configFile}"
    key: "mcpServers.repo-search.command"
    equals: npx
```

`command` 会真的跑命令并按 `expectExit` 判定；`mcp-ready` 对 stdio server 或 http 端点发一次 initialize 握手；`knowledge-integrity` 在 `.packhub/` 产物里按 sha256 找文件。发布时至少要有一条真能判定的检查。

`scenario` 是「装完真的能用」的那一层：要么跑一条最小任务，要么让 harness headless 回答一句话，再断言输出或文件。

```yaml
verify:
  - type: scenario
    run: ["node", "scripts/smoke.mjs"]   # 在安装根执行
    expectExit: 0
    expectOutput: ["ready", "ok"]        # 输出里必须都出现
    expectFiles: ["tmp/smoke.txt"]
    timeout: 120

  - type: scenario                       # 或者问宿主一次
    harness: dsh                         # dsh / claude-code / opencode / codex
    prompt: 这个项目装了什么整合包？只回答包名。
    expectOutput: team-conventions
```

`scenario` 会执行命令 / 调 harness，所以 `add` 装完的自动复核不跑它，`--deep-verify` 和发布门禁才跑；市场写端会直接拒绝带 `scenario` 的包（不在服务器上执行上传者代码）。

---

## 三、报错码对照（`packhub plan` 会直接告诉你）

| 码 | 意思 | 怎么修 |
|---|---|---|
| `unpinned-source` | 引用没锁到不可变版本 | 写版本号 / commit |
| `http-missing-integrity` | https 资源没哈希 | 安装或 lock 时补，或手填 |
| `unmet-need` | 有资源要某项能力，没人提供 | 加提供方，或删掉这条 need |
| `unmet-capability` | `composition.needs` 里的能力没人提供 | 同上 |
| `bad-bind` | 绑定的资源没提供该能力 | 改 `bind` 指向正确的 id |
| `pin-conflict` | 同一个源被锁到两个版本 | 用 `overrides` 显式定夺 |
| `order-violates-dependency` | `composition.order` 与 `dependsOn` 矛盾 | 调顺序或删 order |
| `dependency-cycle` | 依赖成环 | 去掉一条反向依赖 |
| `config-source-unsupported` | config 资源用了非本地来源 | 把片段放进包内（`./fragments/…`）再引用 |
| `unknown-target` | `--target` 写了不支持的值 | 用 `dir` / `dsh` / `claude-code` / `codex` / `server` |

---

## 四、发布前的最低标准

1. `packhub plan` 零错误（warnings 可以留）。
2. 在**干净目录**装一遍：`packhub install` 全 `done`/`noop`，没有 `skipped`。
3. `packhub verify` 没有 `fail`。
4. `packhub lock` 已生成，且 `planHash` 与当前清单一致。
5. 本地资源全部 vendored 进版本目录（`resources/`、`fragments/`）。
6. 放进 `registry/packs/<scope>/<name>/<version>/`，跑 `pnpm registry:verify <dir>`，再跑 `pnpm registry:check`。

前五条是作者的责任，第六条是 CI 的门禁。
