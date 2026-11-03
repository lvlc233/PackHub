# 作者怎么做一个 Pack

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
apiVersion: packhub.dev/v0.0.1
kind: Pack

metadata:
  name: lvlc233/my-pack
  version: 0.0.1
  targets: [dir]

requires:
  packhub: ">=0.0.1 <0.1"

resources:
  - id: style-guide
    type: knowledge
    source: ./resources/style-guide.md
```

四个必填块：`apiVersion` + `kind`、`metadata`（name / version / targets）、`requires.packhub`、`resources[]`。`resources` 里至少一项，每项要 `id` / `type` / `source`。

### 完整的（每条批注都是真实现状）

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/lvlc233/PackHub/main/schema/packhub.v0.0.1.schema.json
apiVersion: packhub.dev/v0.0.1
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

### 字段分三层

| 层 | 字段 | 什么时候写 |
|---|---|---|
| **必写** | `apiVersion` · `kind` · `metadata.name/version/targets` · `requires.packhub` · `resources[].id/type/source` | 每个 Pack |
| **按需** | `vars` · `composition` · `provides` / `needs` / `dependsOn` · `install.exec` · `overrides` | 有变量、有接线、有依赖时 |
| **发布时** | `verify` · `integrity`（https 必填）· `metadata.license/authors/keywords` | 要进 registry 之前 |

### 生成物不要手写

| 文件 | 谁生成 | 干什么 |
|---|---|---|
| `packhub.lock.json` | `packhub lock` | 钉死每个引用，供复现与审查 |
| `.packhub/state.json` | `packhub install` | 这台机器上装了什么、写了哪些文件 |
| `verify.json` | `pnpm registry:verify` | 干净环境里的校验报告，`verified` 的唯一依据 |
| `registry/index.json` | `pnpm registry:index` | 站点与 `search` 读的清单 |

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
packhub lock my-pack          # 成功后把解析结果钉死
```

`resource add` 做的是**结构化编辑**：追加一个资源节点、保留注释、推断 id（重名自动加 `-2`），然后立刻跑一遍清单校验和计划生成。它不做类型推断——`type` 必须由你给，因为同一个 npm 包既可能是 `mcp` 也可能是 `tool`。

---

## 二、每个字段怎么定

### `type`：先问「它怎么被用」

| 你在装什么 | type | 安装期动作 |
|---|---|---|
| 一个能被 npx/uvx 拉起的 MCP Server | `mcp` | 只写配置，不下载 |
| 一个带 `SKILL.md` 的目录 | `skill` | 下载 → 解包 → 挂载 |
| 一段提示词模板 | `prompt` | 写入 prompts 目录 |
| 一份规范/文档/知识 | `knowledge` | 下载或拷贝 |
| 一段要合并进配置的片段 | `config` | 合并到 config.json |
| 一个 CLI 或脚本 | `tool` | 下载 → 解包 |

### `source`：决定可复现性

```
npm:@scope/pkg@1.2.3        # 版本号必须写
pypi:name@1.0.0             # 0.0.2 还不支持下载，先别用
github:owner/repo/sub/path@<40位commit>   # 不接受 @main
https://…                    # 必须带 integrity
./resources/x.md             # 只能用于本地草稿/随包 vendored
```

规则很简单：**发布版必须能落到不可变的东西上**。`@main`、`@latest`、无 integrity 的 https 都会在 `plan` 阶段被拒。integrity 用 `packhub lock` 或安装时自动补齐。

### `provides` / `needs`：只在有依赖时写

- `provides`：这个资源对外提供什么能力（`tool:repo_search`、`skill:code_review`、`knowledge:house_style`）。
- `needs`：它依赖什么能力。没人提供的 `needs` 会在校验时报 `unmet-need`。

不是所有包都需要。只有「A 要能看见 B 提供的东西」时才写——这既是安装顺序的依据，也是 Pack 与「资源清单」的分界线。

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

`command` / `mcp-ready` / `knowledge-integrity` 目前记为「跳过」——写了不会失败，但也不算通过。发布时至少要有一条真能判定的检查。

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

---

## 四、发布前的最低标准

1. `packhub plan` 零错误（warnings 可以留）。
2. 在**干净目录**装一遍：`packhub install` 全 `done`/`noop`，没有 `skipped`。
3. `packhub verify` 没有 `fail`。
4. `packhub lock` 已生成，且 `planHash` 与当前清单一致。
5. 本地资源全部 vendored 进版本目录（`resources/`、`fragments/`）。
6. 放进 `registry/packs/<scope>/<name>/<version>/`，跑 `pnpm registry:verify <dir>`，再跑 `pnpm registry:check`。

前五条是作者的责任，第六条是 CI 的门禁。
