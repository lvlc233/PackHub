# PackHub 技术方案 v0.0.1

## 0. 一页结论：六个不可动摇的决策

| # | 决策 | 理由 | 反面（明确不做） |
|---|---|---|---|
| D1 | **Pack 是数据，不是脚本** | 保证可审计、可 diff、可复现、可分发；也符合 README「不接管 Agent 执行」 | 不做「一堆 shell 装完就算 Pack」 |
| D2 | **安装 = 计划（Plan）+ 适配器（Adapter）** | 同一份 Pack 能落到 DSH / Claude Code / 普通目录；卸载和幂等由 adapter 统一承担 | 不在 Pack 里写死安装路径和平台分支 |
| D3 | **每个资源引用必须能落到不可变 pin**（commit sha / 版本号 / sha256） | 复现和供应链安全的前提；「今天装得上、下周装不上」是这类平台的死因 | 发布版不允许 `@main`、`@latest` |
| D4 | **Hub v0.0.1 是静态产物**（registry 仓库 + CI 生成的 index.json + 静态托管） | 没有账号、没有上传服务、没有数据库，也能完成「发现 + 安装」闭环 | 不自建 SaaS、不做用户体系、不做在线编辑器 |
| D5 | **整合 = 显式接线（wiring）+ 验证（verify）** | 这是 Pack 与「资源合集」的唯一分界线，README 第五章的要求必须落到字段上 | 不靠「目录放在一起」冒充整合 |
| D6 | **TypeScript 全域（Bun CLI + React/Vite Web），JSON Schema 为唯一契约** | 安装器要的是正确性与迭代速度，本项目无性能热点；Rust 留作分发给「不装 Node 的用户」时的重写路径（§10） | 不引 Python 主链路、不做 SSR、不共享业务代码 |

---

## 1. 概念与边界（对 README 的收紧）

三个实体，一次只加一个：

| 实体 | 一句话 | 存储形态 | v0.0.1 是否实现 |
|---|---|---|---|
| **Resource** | 一个可被引用、可被 pin、可被安装的原子能力/材料 | 外部源（github / npm / pypi / URL / 本地目录）+ 描述 | 是（6 种类型，见 §3.1） |
| **Pack** | 围绕一个需求，对若干 Resource 的选择、接线、配置与验证 | 一个目录：`packhub.yaml` + 锁文件 + 可选本地资源 | 是 |
| **Hub** | 把 Pack 和 Resource 变得可发现、可安装的索引与分发通道 | 静态 JSON 索引 + `.phub` 归档 | 是（静态版） |

边界（写进代码注释，也写进 README 补丁）：

- PackHub **不**执行 Agent 任务，**不**启动 MCP 连接做业务调用。唯一的「执行」发生在安装期的 `exec` 动作和 `verify` 检查，两者都需显式授权。
- PackHub **不**托管资源原始内容作为唯一来源。索引和清单可以集中，仓库所有权留在原处。
- PackHub **不**发明新协议。MCP 的 server 配置格式、Agent Skills 的 `SKILL.md` 目录约定，直接复用。

---

## 2. 一次典型使用的完整链路（先定行为，再定实现）

```
$ packhub search 代码审查            # 读 index.json，本地过滤
$ packhub add lvlc233/code-review    # 解析 → 生成 packhub.lock.json
$ packhub plan                        # 打印将要做的事（dry-run，默认动作）
$ packhub install --target dsh        # 生成 Plan → adapter 执行 → 写 .packhub/installed.json
$ packhub verify                      # 跑 manifest 的 checks，出报告
$ packhub pack --bundle vendored      # 产出 code-review-0.0.1.phub
```

关键点：**`plan` 是默认动词**。用户先看到「会下载什么、会写哪些文件、会跑什么命令」，再决定是否 `install`。这条 UX 决定了整个数据模型必须能把动作表达成数据。

---

## 3. Resource 模型

### 3.1 六种类型与各自的安装语义

| type | 是什么 | 安装动作（adapter 负责） | 校验方式 |
|---|---|---|---|
| `mcp` | MCP Server（stdio 或 http） | 写入目标环境的 MCP 配置；`npx`/`uvx`/二进制按需拉取 | 起进程发 `initialize` + `tools/list`，比对声明的 tools |
| `skill` | `SKILL.md` 目录（含 assets） | 拷入/链接到 skills 目录 | `SKILL.md` 存在 + frontmatter 可解析 |
| `prompt` | 提示词模板（md，带变量） | 写入 prompts 目录，或注入目标的上下文文件 | 模板变量全部可解析、渲染成功 |
| `knowledge` | 文档/资料集 | 拉取到 knowledge 目录，生成 `index.md` | 文件数与 sha256 对得上 |
| `config` | 配置片段（merge patch） | 合并进目标配置文件（`json-patch` 或 `yaml-merge`） | 合并后能被目标解析、关键键存在 |
| `tool` | CLI / 脚本 / 独立二进制 | 声明依赖并安装（npm / pip / 下载二进制） | `--version` 退出码 0 且版本在范围内 |

一个 Pack **不要求**包含 MCP 或 Skill（README 4.2 的要求），上述六类可以任意组合，也可以只有 `knowledge` + `config`。

### 3.2 引用标识符

统一形式 `type:locator@pin`，`pin` 对发布版是必需的：

```yaml
source: npm:@modelcontextprotocol/server-filesystem@1.2.3
source: pypi:mcp-server-git@0.5.0
source: github:owner/repo/cmd/server@v0.4.0        # 可执行/仓库子路径
source: github:owner/repo/skills/code-review@9f2c1ab # 精确 commit
source: https://example.com/style.md                # 配合 integrity
source: ./resources/house-rules                       # 本地目录，随 Pack 分发
source: packhub://lvlc233/base-review@0.3.1          # 引用另一个 Pack（见 §4.4）
```

规则：

1. `github:` 的 pin 允许 tag 或 40 位 commit；tag 在解析时**必须**解析成 commit 写入锁文件。
2. `https:` 必须带 `integrity: sha256-...`，否则拒绝安装（v0.0.1 无例外）。
3. 本地相对路径只允许在「未发布」的 Pack 中使用；`pack` 时若 `bundle: vendored` 会被快照进归档。
4. `packhub://` 是 Pack 之间的复用，是 README 第七章「Pack 派生」的最小实现。

### 3.3 能力声明（可选，但它是「整合」的语法）

```yaml
resources:
  - id: repo-search
    type: mcp
    source: npm:@modelcontextprotocol/server-everything@0.6.2
    provides: [tool:repo_search, tool:read_file]
  - id: review-rules
    type: skill
    source: github:lvlc233/skill-hub/skills/code-review@9f2c1ab
    provides: [skill:code_review]
    needs: [tool:repo_search]
```

- `provides` / `needs` 让「谁依赖谁」变成可校验的图，而不是注释里的口头约定。
- **v0.0.1 只做显式绑定校验**：`needs` 必须在同一个 Pack（或它继承的父 Pack）里有 `provides` 命中，否则安装失败。不做自动挑选、不做版本求解。
- v0.0.2 再加「同能力多实现可替换」（这是 Minecraft 整合包替换 Mod 的对应物，价值高但成本高，先不进 v0.0.1）。

---

## 4. Pack 模型

### 4.1 目录结构

```
code-review/
├── packhub.yaml          # 唯一必需文件
├── packhub.lock.json     # 解析产物，提交进仓库
├── resources/            # 本地资源（可选）
└── fragments/            # 配置片段（可选）
```

### 4.2 manifest 字段表（`packhub.yaml`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `apiVersion` | 是 | `packhub.dev/v0.0.1`，升级时按主版本做迁移 |
| `kind` | 是 | `Pack` |
| `metadata.name` | 是 | `scope/name`，小写、连字符，全局唯一（scope 用 GitHub 用户名） |
| `metadata.version` | 是 | 语义化版本 |
| `metadata.targets` | 是 | 支持的环境列表：`dir` / `dsh` / `claude-code`（`dir` 是中性兜底） |
| `metadata.license` / `authors` / `keywords` / `homepage` | 否 | 索引用 |
| `requires.packhub` | 是 | 平台版本范围，例如 `">=0.0.1 <0.1"` |
| `requires.agent` | 否 | 目标 Agent 版本范围 |
| `vars` | 否 | 作者声明的变量及默认值，安装时可覆盖 |
| `resources[]` | 是 | 见 §3，`id` 在 Pack 内唯一 |
| `composition` | 否 | 接线：`needs` 图、`env`、执行顺序、slot 绑定（§4.3） |
| `install.exec[]` | 否 | **需要授权**的安装期命令（§5.2） |
| `verify[]` | 是（发布时） | 声明式检查（§6） |
| `uninstall` | 否 | 额外清理；默认由 adapter 依据 Plan 反向执行 |

### 4.3 composition：把「放在一起」变成「接起来」

```yaml
composition:
  env:                          # 注入所有资源可见的环境变量
    REVIEW_ROOT: ${vars.projectRoot}
    STRICT: "${vars.strict}"
  order: [agent-config, repo-search, review-rules]   # 显式安装顺序；缺省按 dependsOn 拓扑
  needs:
    - capability: skill:code_review
      requires: [tool:repo_search, knowledge:house_style]
      bind: repo-search        # 绑定到具体实现，锁定行为
```

- `env` 支持三种插值：`${vars.x}`、`${resources.<id>.config.<path>}`、`${target.<field>}`。插值在**计划阶段**求值成字面量，避免运行期再解释一遍。
- `order` 只在存在副作用顺序依赖时写；其余情况由 `needs` 拓扑排序推导。
- 没有 `composition` 的 Pack 仍然合法，但会在索引里标注 `integration: flat`——诚实反映它只是个资源清单。

### 4.4 Pack 继承与冲突

```yaml
extends: packhub://lvlc233/base-review@^0.3
overrides:                      # 覆盖父 Pack 的某个资源 pin 或配置
  - resource: repo-search
    source: npm:@modelcontextprotocol/server-everything@0.6.3
```

冲突规则（v0.0.1，宁严不松）：

1. 同一资源（同 `type` + 同规范化 locator）在解析树里出现两个不同 pin → **报错**，要求用 `overrides` 显式定夺。
2. 同一 `capability` 被两个未绑定的 `needs` 命中 → 报错，要求 `bind`。
3. `extends` 深度上限 8，禁止环。

不做依赖求解器。这是有意的：Minecraft 整合包几十年靠的也是「冲突就告诉作者」，而不是 SAT 求解。

---

## 5. 安装协议：Plan + Adapter

### 5.1 Plan 的结构（这是整个项目的技术核心）

`packhub plan` 输出（同时也是 `install` 的输入）一个 JSON：

```json
{
  "apiVersion": "packhub.dev/plan/v0.0.1",
  "pack": { "name": "lvlc233/code-review", "version": "0.0.1" },
  "target": "dsh",
  "actions": [
    { "id": "a1", "op": "fetch", "uri": "npm:@modelcontextprotocol/server-everything@0.6.2",
      "dest": "${cache}/mcp/server-everything", "integrity": "sha256-..." },
    { "id": "a2", "op": "register.mcp", "id": "repo-search",
      "spec": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything@0.6.2"] } },
    { "id": "a3", "op": "link.skill", "from": "${cache}/skills/code-review", "to": "${target.skillsDir}/code-review" },
    { "id": "a4", "op": "merge.config", "path": "${target.configFile}", "strategy": "yaml-merge",
      "patch": { "env": { "REVIEW_ROOT": "/repo" } } },
    { "id": "a5", "op": "exec", "command": "git", "args": ["-C", ".", "config", "core.hooksPath", ".githooks"],
      "approval": "required", "dependsOn": ["a3"] }
  ],
  "verify": [ { "id": "v1", "type": "mcp-ready", "resource": "repo-search" } ]
}
```

**动作原语只有 8 个**，足以覆盖六类资源，且每一个都能反向执行：

| op | 语义 | 可逆 |
|---|---|---|
| `fetch` | 下载并校验 integrity，落缓存 | 删缓存文件 |
| `unpack` | 解压归档到目标目录 | 删目录 |
| `write` | 写文件（含模板渲染），记录原内容 | 还原原内容 / 删除 |
| `link.skill` | 链接/拷贝 skill 目录 | 删除链接或恢复原目录 |
| `register.mcp` | 在目标 MCP 配置写入/更新一项 | 恢复原配置项 |
| `merge.config` | 按 patch 合并配置 | 反向 patch（无法反向时恢复备份） |
| `exec` | 安装期命令，需授权，含 `cwd`/`env` | 声明 `undo`，否则标记「不可自动卸载」 |
| `probe` | 只读探测（起 MCP、跑 `--version`） | 无副作用 |

### 5.2 Adapter 契约

```
interface TargetAdapter {
  id: "dir" | "dsh" | "claude-code"
  capabilities(): { mcp: boolean, skills: boolean, prompts: boolean, configFormats: [...] }
  resolve(pack: Manifest, env: Env, opts): Plan        // 纯函数：manifest → plan
  apply(plan: Plan): ApplyResult                        // 唯一产生副作用的地方
  verify(plan: Plan, report: VerifyReport): VerifyRun
  remove(installed: InstalledState): RemoveResult
  vars(): { skillsDir, configFile, cacheDir, ... }      // 供插值
}
```

- `resolve` 是纯函数，便于测试和 `--dry-run`。
- `apply` 必须幂等：同一 Plan 跑两次，第二次全部 `noop`。
- 状态写进目标环境的 `.packhub/installed.json`（pack → actions → 备份路径），这是卸载和「装了什么」的唯一真相。
- v0.0.1 **只实现 `dir` adapter**（把 Pack 物化成一个目录：`resources/` + `install-plan.json` + `README`），`dsh` 和 `claude-code` 放 v0.0.2。这一刀最可能是我们后面要改的地方，先说清楚。

### 5.3 安全模型（因为 `exec` 存在，必须提前定）

- **信任分级**：`official`（官方 scope）/ `verified`（CI 在干净容器里跑通 `verify`）/ `community`。索引里带 `trust` 字段，UI 上不可隐藏。
- 任何 `exec` 动作默认拒绝，需 `--allow-exec` 或交互确认；确认界面必须列出完整命令与 `cwd`。
- 发布版禁止未 pin 引用；`integrity` 缺失直接拒装。
- v0.0.2 再加签名（minisign/sigstore）——v0.0.1 用「内容哈希 + 静态索引的 Git 历史」兜底。

---

## 6. 锁文件与验证

`packhub.lock.json`（提交进仓库，格式化稳定，便于 review diff）：

```json
{
  "apiVersion": "packhub.dev/lock/v0.0.1",
  "pack": "lvlc233/code-review@0.0.1",
  "resolved": [
    { "id": "repo-search", "type": "mcp", "source": "npm:@modelcontextprotocol/server-everything@0.6.2",
      "integrity": "sha256-...", "resolvedAt": "2026-11-03T05:00:00Z" }
  ],
  "planHash": "sha256-...",       // 同一 manifest 必须产出同一 planHash
  "generatedBy": "packhub/0.0.1"
}
```

`planHash` 的意义：**它把「这个 Pack 在这台机器上会做什么」变成可比较的字符串**。CI 用它断言「manifest 改动确实改变了行为」，也用它做过期检测。

`verify` 检查项（v0.0.1 只做只读）：

```yaml
verify:
  - { type: file-exists, path: "${target.skillsDir}/code-review/SKILL.md" }
  - { type: command, run: ["packhub", "probe", "mcp", "repo-search"], expectExit: 0, timeout: 30 }
  - { type: config-key, path: "${target.configFile}", key: "mcpServers.repo-search.command", equals: "npx" }
  - { type: knowledge-integrity, resource: house-style }
```

发布门槛：`packhub verify` 在干净环境全绿 → 索引标 `verified`。失败项要能定位到具体 action id，不是「安装失败」四个字。

---

## 7. Hub v0.0.1：静态索引

不写服务端。仓库即数据库：

```
registry/
├── packs/lvlc233/code-review/
│   ├── packhub.yaml
│   ├── packhub.lock.json
│   └── releases/0.0.1.phub
├── index.json              # CI 生成，唯一的读取入口
└── .github/workflows/index.yml
```

读取契约（全部 GET + 缓存友好）：

| 端点 | 内容 |
|---|---|
| `GET /v0.0.1/index.json` | 所有 Pack 的 `name/version/title/keywords/targets/trust/integration/updatedAt`，按需分片（>500 条时拆 `index-<shard>.json`） |
| `GET /v0.0.1/packs/<scope>/<name>.json` | 该 Pack 的版本列表与各版本 manifest |
| `GET /v0.0.1/packs/<scope>/<name>/<version>.phub` | 归档（`bundle: reference` 时只有 manifest + lock；`vendored` 时含资源快照） |

- 搜索 = 客户端对 index 做关键词/标签/target 过滤，v0.0.1 不需要搜索服务。
- 发布 = 向 registry 仓库提 PR（含 manifest、lock、归档、verify 报告）。CI 校验：schema、pin 完整、integrity 匹配、`verify` 通过、版本未抢注。
- 不可变：某版本一经合并，manifest 内容哈希进入 index，之后只能 `yank`（加 `deprecated`/`yanked` 标记），不能改内容。

归档格式 `.phub` = `tar.gz`，内含 `manifest.yaml`、`packhub.lock.json`、`META.json`（校验和、构建信息）。`bundle: reference`（默认，几 KB）与 `vendored`（离线可用，体积大）两种模式，由作者决定。

---

## 8. 路线与范围

> 现状（2026-11-03，第二轮）：内核闭环 + 控制面板门面。
> 已实现：schema 校验器、引用解析（npm/pypi/github/https/packhub/本地）、能力图校验（needs 未满足 / pin 冲突 / 顺序矛盾 / 成环）、`dir` adapter 的 install · verify · lock、`planHash`、CLI（plan / install / verify / lock / init / serve）、本地 HTTP API + React 控制面板（§11）。
> 未实现：`fetch`（联网下载与完整性校验）、`pack`（归档）、`exec` 执行、`add`、静态 registry；这四项是下一步。

**v0.0.1（MVP，唯一目标：一条闭环跑通）**
1. ✅ `packhub.yaml` JSON Schema + 校验器（ajv + ajv-formats）
2. ✅ 解析器：引用 → pin 校验 → 锁文件；`planHash` 同输入同哈希（有测试）
3. ✅ Plan 生成（write / link.skill / register.mcp / merge.config；fetch、unpack 已定义但执行层未联网）
4. ✅ `dir` adapter：apply / verify / lock（remove 留到 v0.0.2）
5. ◐ CLI：`plan` / `install` / `verify` / `lock` / `init` 可用；`pack` / `add` / `search` 未实装
6. ☐ 静态 registry 仓库 + index CI + 3 个真实 Pack（现在只有 2 个示例）

**v0.0.2**
`dsh` 与 `claude-code` adapter；`extends`/`overrides` 完整实现；签名；能力替换；`exec` 的容器沙箱。

**明确不做（至少今年）**
在线账号体系、Web 编辑器、运行时托管、自动版本求解、付费市场、自建 MCP 网关。

**主要风险（提前说）**
1. **adapter 抽象过度**：不同 Agent 的 skill/mcp 落点差异可能大到让 Plan 变形。对策：v0.0.1 只做 `dir`，把差异留到 v0.0.2 用真实目标倒逼。
2. **Pack 变成「YAML 堆砌」**：如果 `composition` 只是 `env`，整合价值会退化成清单。对策：把 `needs`/`provides` 的图校验设为发布硬门槛。
3. **冷启动**：静态索引没有内容就是空站。对策：先把自己在用的 3 个整合包做成种子。

---

## 9. 已确认的五项决定（2026-11-03）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 第一个真正实现的 adapter | **`dir`**；`dsh` / `claude-code` 留给 v0.0.2 |
| Q2 | Hub 形态 | **静态索引**，PR 即发布，不做后端与账号 |
| Q3 | manifest 格式 | **YAML + JSON Schema**，Schema 是唯一权威 |
| Q4 | 安装期 `exec` | **允许声明，默认拒绝执行**，需 `--allow-exec` |
| Q5 | 能力自动绑定 | **不做**，只做显式绑定的图校验 |

---

## 10. 技术选型：TypeScript 全域（Bun CLI + React Web）

### 10.1 判断依据

| 维度 | 事实 | 对选型的影响 |
|---|---|---|
| 性能是否是瓶颈 | 装一个 Pack 是几十次文件读写 + 一次解包，毫秒级差异无意义 | 速度不构成选 Rust 的理由 |
| 变更集中在哪 | `resolve` / `plan` / `adapter`，每个新目标环境都要动 adapter | 迭代速度权重最高 |
| 分发要求何时出现 | 用户第一次装 CLI 时；但目标用户（装 MCP 的人）几乎都有 Node | 不是第一优先级 |
| 生态贴合度 | Pack 引用 `npm:` / github / pypi；`register.mcp` 探活就是跑 `npx` | 与 Node 同运行时，少一层转译风险 |
| 契约能否隔离语言 | 能：JSON Schema + `index.json`，CLI 与 web 不共享代码 | 选错语言可换，不必重写协议 |

### 10.2 使用方案 ：TypeScript 全栈

| 层 | 选型 | 备注 |
|---|---|---|
| CLI 运行时 | **Bun**（`bun build --compile` 出单文件），Node 22 兜底走 npm 分发 | 两个入口共用一套源码 |
| CLI 框架 | `citty`（unjs，Bun 友好）+ `consola` 输出 | 命令少，不上重型框架 |
| YAML | `yaml`（CST + node range，报错可指行列） | 直接决定 `verify` 的体验 |
| 校验 | `ajv` 跑我们自己的 JSON Schema | **单一权威是 Schema，不是 TS 类型** |
| 类型 | `json-schema-to-typescript` 从 Schema 生成 | 不手写 manifest 类型 |
| 归档与哈希 | `tar` + `node:zlib`（Node 22 起原生 zstd）+ `node:crypto` 流式 sha256 | |
| 前端 | React 19 + Vite + TS + Tailwind + `shadcn/ui` + TanStack Query | 纯静态页，读 `index.json` |
| 测试 | `vitest` + 临时目录集成测试 + 快照 | |

工作区结构：

```
packages/
├── core/        # manifest 类型（手写镜像 + schema 校验）、引用解析、plan 生成、planHash —— 纯函数，零 IO
├── cli/         # citty 命令 + dir adapter + serve（本地 API）
└── web/         # Vite + React，只消费 /api 与内核语义
```

### 10.5 变的三件事

1. **契约是 JSON Schema**，CLI 与 web 之间只有 `manifest`、`lock`、`plan`、`index.json` 四种数据，没有共享代码。
2. **`resolve` 必须是纯函数**，`apply` 是唯一副作用点且幂等——这是换语言的底气。
3. 前端动手前先读 `dev\frontend\经验.md`（含候选），再定视觉方案。

---

## 11. 控制面板（门面，不碰内核）

`packhub serve` 起一个只监听 `127.0.0.1` 的 HTTP 服务：内核的四个能力原样暴露成四个接口，前端只负责呈现。

| 接口 | 作用 | 对应的内核函数 |
|---|---|---|
| `GET /api/packs` | 扫描仓库根、`examples/`、`packs/` 下的 Pack | `loadPack` + `planFor` |
| `GET /api/pack?dir=` | 一个 Pack 的 manifest、问题、计划、本机状态 | `loadPack` / `planFor` / `loadState` |
| `POST /api/install?dir=` | 执行计划 | `installPack` |
| `POST /api/verify?dir=` | 跑校验 | `verifyPack` |

约束（这些是协议，不是实现细节）：

1. **面板不复制内核判断**：校验通过与否、计划能不能生成，全部以 API 返回为准；前端只有状态映射与展示层的 `${vars.x}` 替换。
2. **`dir` 参数只能落在仓库内**，越界直接报错；服务只绑 `127.0.0.1`，不监听外部地址。
3. **面板不写 `.packhub` 之外的文件**：所有落盘都经过 `applyPlan` 的路径校验与备份。
4. 静态产物由 `pnpm web:build` 生成到 `packages/web/dist`，`serve` 直接托管；开发时用 `pnpm web:dev`，Vite 代理 `/api`。

设计取向记在 `DESIGN.md`（备料台 / 装配单、赭黄单点、运行单落笔），产品定位记在 `PRODUCT.md`。截图证据在 `.impeccable/review/`（`desktop.png`、`install.png`、`verify.png`、`mobile.png`）。


