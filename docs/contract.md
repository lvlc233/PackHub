---
kind: contract
summary: 格式 v0 的数据形状与格式层不变量
verified: 2026-11-23
decay: 365
review: 格式升版、字段增删、apiVersion 变化时
---

# PackHub 契约

## 0 版本

三类版本：产品、api版本（格式）、包。apiVersion 的具体值见下面两张表。

| 类别 | 是什么 | 写法 | 唯一来源 |
|---|---|---|
| 产品 | 整个工具的版本，问「行为有没有承诺」 | `0.0.x`（范围）/ `0.0.1`（具体） | 仓库根 `package.json` |
| api版本（格式） | 带有 `apiVersion` 字段的文件所用的格式；所有契约现阶段统一为 v0 | 全串 `packhub.dev/<契约>/v0`；正文写「格式 v0」，不写单独的 `v0` | 下面两张表的 apiVersion 与 schema |
| 包 | 包内容的版本，问「这是哪一版内容」 | `scope/name@x.y.z` | 清单的 `metadata.version` |

**Pack 格式**：

| 契约 | apiVersion | 位置 |
|---|---|---|
| manifest | `packhub.dev/v0` | `packhub.yaml` |
| plan | `packhub.dev/plan/v0` | 用到时现算（`--json` 输出；不进锁） |
| lock | `packhub.dev/lock/v0` | `packhub.lock.json`（形状见 §3：`resolved` + `contentHash`） |
| state | `packhub.dev/state/v0` | `.packhub/state.json` |
| index | `packhub.dev/index/v0` | `registry/index.json` |
| verify 报告 | `packhub.dev/verify/v0` | `verify.json` |
| 资源目录 | `packhub.dev/resources/v0` | `registry/resources.json` |
| 签名旁挂 | `packhub.dev/signatures/v0` | `packhub.signatures.json` |
| 版本记录 | `packhub.dev/version/v0` | `.packhub/versions/<pack>/<ver>/record.json` |
| 激活指针 | `packhub.dev/active/v0` | `.packhub/active.json` |

**PAL 本地记录**：

| 记录 | apiVersion | 定义 |
|---|---|---|
| home 配置与运行态 | `packhub.dev/instance/v0` | `packages/launcher/src/records.ts` |
| core 握手 | `packhub.dev/pal/core/v0` | `packages/launcher/src/core.ts` |
| home 基线 | `packhub.dev/baseline/v0` | `packages/launcher/src/baseline.ts` |
| home 备份 | `packhub.dev/instance-backup/v0` | `packages/launcher/src/backup.ts` |
| home 模板 | `packhub.dev/instance-template/v0` | `packages/launcher/src/template.ts` |
| 私有来源凭据 | `packhub.dev/credentials/v0` | `packages/runtime/src/credentials.ts` |
| 持久信任公钥 | `packhub.dev/trust/v0` | `packages/runtime/src/trust.ts` |


## 1 Manifest（`packhub.dev/v0`）

清单 `packhub.yaml` 的形状由 schema 给出（`schema/packhub.v0.schema.json`）。顶层字段是 `apiVersion` / `kind` / `metadata` / `requires` / `vars` / `context` / `resources` / `state` / `modify` / `signatures` / `install` / `verify`；接线不占顶层字段，写在资源自己的 `provides` / `needs` 上：

```yaml
resources:
  - id: markdownlint
    type: tool2
    provides: [tool/lint@1]
  - id: doc-review
    type: skill
    needs: [tool/lint@1]
```

不变量：

1. `provides` / `needs` 都写成能力令牌（写法见 §2）。同一令牌允许多个 provider：它们全部安装、不互斥，消费者的每个 `needs` 只要至少有一个 provider 就算满足。
2. 清单不声明「只装其中一个实现」：没有互斥组，也没有选择字段；`additionalProperties: false`，schema 没定义的字段判 schema error。

### 清单插值

清单里会变成路径或命令的字符串支持 `${...}` 插值：`state[].path`、`install.exec` 的各字段与 `verify` 项。可用命名空间只有三个：

- `${vars.<键>}`：清单的 `vars`；
- `${layout.<字段>}`：这次安装的落点回答——落点由宿主自己声明（`destination(kind, ctx)`），插值是从它派生出来的视图：`skillsDir` / `knowledgeDir` / `promptsDir` / `binDir` / `configDir` / `cacheDir` 分别等于对应 `destination(kind)`，`configFile` = `destination('mcp')`、`instructionFile` = `destination('instruction')`，`root` 是包自己的 `.packhub` 状态根（不是安装根）；平铺目录与没有指令面的宿主不派生 `instructionFile`，写了会报 `undefined-variable`。带 `base: 'home'` 的落点给 home 段下的相对路径，带 `base: 'absolute'` 的落点给绝对路径；清单只能拿到这些字符串，不能反过来把动作的路径基准改成 absolute（见 §2 的安全边界）；
- `${state.<id>}`：清单 `state` 块声明的持久目录。

找不到的键报 `undefined-variable`。落点变量的命名空间是 `layout`，不留别名；旧命名空间下的写法会被当成找不到的键，计划期直接报错。

## 2 Plan（`packhub.dev/plan/v0`）

内核算出的动作清单。负责确保包资源安装的正确性。计划是安装期现算的：`pal install` / `pal update`、launcher 建/更新 home 与 publish 门禁里的 runner 各算一份；`packhub plan` / `packhub verify` 只在 Pack 目录里预览，不写用户目录。

```jsonc
{
  "apiVersion": "packhub.dev/plan/v0",
  "pack": { "name": "lvlc233/team-conventions", "version": "0.0.1" },
  "harness": "dsh",
  "actions": [
    { "actionId": "write#1", "op": "write", "to": ".packhub/knowledge/style-guide.md", "from": "./resources/style-guide.md", "integrity": "sha256-…", "resource": "style-guide" }
  ],
  "verify": [{ "type": "command", "run": ["node", "scripts/self-test.mjs"] }],
  "excluded": [{ "resource": "tts-a", "reason": "optional-unmet" }],
  "planHash": "sha256-…"
}
```

1. `planHash` = 计划自身的哈希，用于确保版本一致性。
2. `harness` 可选：写 `dsh` / `claude-code` / `codex` / `opencode` / `workbody` / `hermes` 时按该宿主的落点回答（`destination`）物化；不写就是平铺目录，计划里没有这个字段。
3. `plan --json` 在计划对象外带一份 `wiring`：`describeComposition` 从清单派生的接线，只有两组——`capabilities`（能力令牌 → provider 列表，按令牌排序）与 `edges`（`needs` 派生的 provider → consumer 边）。它是 CLI 输出，不进 `planHash`、不进锁，也不进 state 里的计划快照。

动作原语：`fetch`、`unpack`、`copy`、`write`、`delete`、`link.skill`、`link.exec`、`register.mcp`、`exec`、`instruction`、`state.dir`。

每个 op 的路径、来源基准、撤销方式、撤销载荷、共享判定与派生输出都在 `packages/kernel/src/plan-ops.ts` 的 `PLAN_OPS` 表里（单点；执行器与清理侧都从它派生）：

| op | `from` 基准 | 写到哪（`to` 的基准） | 撤销 | 撤销载荷 | 共享 | 备注 |
|---|---|---|---|---|---|---|
| `fetch` | 无（`uri`） | `dest`（`destBase`，缺省 root） | 删文件 | — | 否 | 下载物进缓存，进快照/版本镜像 |
| `unpack` | `fromBase`（缺省 root） | `to`（`toBase`，缺省 root） | 删文件 | — | 否 | 读 fetch 实际写盘的位置 |
| `copy` | Pack（`pack`） | `to`（`toBase`，缺省 root） | 删文件 | — | 否 | 本地工具执行体整份复制 |
| `write` | Pack（`pack`），内联内容可省 | `to`（`toBase`，缺省 root） | 删文件 | — | 否 | 二进制也走它；清单声明 `integrity` 时带上（verify 据此派生哈希校验） |
| `delete` | 无 | `to`（`toBase`，缺省 root） | 不撤销 | — | 否 | 目标不存在算 `noop`，不进 `written` |
| `link.skill` | 本地 `pack` / 远程缓存基准 | `to`（`toBase`，缺省 root） | 删文件 | — | 否 | codex 额外派生 `<to>/agents/openai.yaml` |
| `link.exec` | 无（`entry` / `module` 各带基准，缺省 root） | `to`（`toBase`，缺省 root）、`to.cmd` | 删文件 | — | 否 | `.cmd` 只在 win32 生成；`platforms` 不匹配由执行器 `skipped` |
| `register.mcp` | 无（`spec`） | `path`（`toBase`，缺省 root；缺省用 `destination('mcp')` 的落点） | 还原共享配置 | `{path, base?, key, configPath?, format?}` | 是 | `configPath` / `format` 由宿主 MCP 方言决定；`.toml` 用托管块 |
| `exec` | 无 | 无 | 不撤销 | — | 否 | 计划里永远 `approval: required` |
| `instruction` | 无（`content`） | `file`（`toBase`，缺省 root） | 摘托管块 | `{file, base?, blockId}` | 是 | 只动 `<!-- packhub:begin/end -->` 之间 |
| `state.dir` | 无 | 无（只建目录） | 不撤销 | — | 否 | 数据目录，不随升级/卸载删除 |

**路径基准**：`Destination.base` 只有三个值——`root`（缺省，相对安装根）、`home`（相对宿主 home 段：managed 是 `<root>/home/<宿主>`，attached 就是 root）、`absolute`（原样使用，必须是绝对路径）。动作上对应可选的 `toBase`（`register.mcp` / `instruction` 也用同一个字段），默认 `root`，**默认值不写进 JSON**：同一份清单在现有宿主 / 现有 scope 下，动作与改造前逐字节一致。撤销载荷里的 `base` 同理，只在非 root 时出现。

**安全边界**：

1. 非 root 基准只允许来自适配器的 `destination`；清单没有字段能声明路径基准，`${layout.*}` 插值也只会得到字符串，不能把某条动作的 `toBase` 改成 `absolute`。
2. 计划期检查：`base: 'absolute'` 的路径不是绝对路径 → `bad-destination-base`（error）；`base: 'home'` 但安装范围没有 home 段同样报 error。绝对路径落在安装根内也按绝对路径处理，不折回相对路径。
3. 不限制绝对路径的目录（例如 claude-code 的 `~/.claude.json` 在 home 的上一级）；代价是卸载与漂移检查必须精确回退：`state.written` 记下 `{path, base}`，安装前按同一基准快照，rollback 原样恢复。

「共享」只由动作决定：`register.mcp` 按 key 合并、`instruction` 按托管块追加；落点路径（`.json` / `.yaml` / `.toml` / 根目录 `.md`）不改变共享性，私有 `.json` 照常进版本镜像、参与所有权冲突、升级时按普通文件删。

撤销载荷回答「撤销时要动哪一处」：`restore-shared` 给共享配置文件、条目挂的对象路径（`configPath`，缺省 `['mcpServers']`）与要摘的键，`format` 说明文件是 JSON 还是 YAML；`strip-block` 给指令文件与托管块 id。执行器（`deactivatePlan` / `pruneRemoved` / `removePack`）只按 `undo` 的四种方式各做一次，不再按 op 猜路径与键；`state.dir` 只建目录、不产出文件，所以不进文件冲突集合，同一目录挂两个 state id 另报 `duplicate-state-path`。

`register.mcp` 的落点与条目形状由宿主的 `destination('mcp')` 回答：`path` 是配置文件（按安装范围分叉，例如 managed 的 opencode 在实例 home 的 XDG 目录里），随落点一起给的 `mcp` 方言声明 `path`（条目挂哪个对象路径，缺省 `['mcpServers']`）、`format`（缺省 `json`）、`entry(spec)`（把通用 spec 转成该宿主的条目形状）与可选的 `file`（只覆盖文件名，覆盖不了「这个范围写哪个文件」——那属于落点）。计划动作上对应 `path` / `configPath` / `format` 三个可选字段，`spec` 已经是转好的条目；不写方言就是 JSON `mcpServers` + spec 原样。宿主注册项的 `project` 还可以是 `'full'`（缺省，项目里注册技能、指令与 MCP）/ `'pointer'`（项目里只写指路块，不注册 skill，安装时提示；dsh）/ `false`（没有项目级落点，`pal install --project` 直接拒绝，只能装进 home；hermes）。

派生输出是「install 期生成、计划动作里没有对行动作」的文件（codex 的 `agents/openai.yaml`、`link.exec` 的 `.cmd`）；它们由表的 `paths()` 声明，因此 `planPaths(plan)`、快照、版本镜像与升级清理都能覆盖到。

`copy` 把包内文件或目录整份复制到安装根（工具的执行体走这条）。
`link.exec` 在 binDir 生成入口：`runtime entry [module] [args…] "$@"`，posix 只有无后缀的 sh 脚本，`.cmd` 只在 Windows 生成；`route` 模式的 entry 是生成的通用 shim，module 是工具执行体。`platforms`（`platform-arch`）不匹配时执行器记 `skipped`，计划里仍保留这条动作。

- `delete` 只删单个文件（`modify` 用它删掉上游带的文件或整段命中的文件）；目标不存在算 `noop`，不失败，也不进 `written`——卸载不会去恢复它，回滚由快照负责。

- `register.mcp` 在 `.toml` 目标上写带标记的 `[mcp_servers.<id>]` 托管块，卸载只摘自己那段。
- `state.dir` 只建目录；清单里的 `state` 块决定路径与 `retain`，目录不参与 `written`、不随快照回滚删除。
- `exec` 带 `command/args/cwd/env/timeout` 与 `approval: required`：计划里永远标待批准，执行层必须显式 `--allow-exec` 才跑。退出码非零算失败，触发整次安装回滚。`undo` 目前只作记录，不自动执行。

`excluded` 记录没进计划的资源，`reason` 两种：`optional-unmet`（可选资源缺依赖，级联跳过）、`host-managed`（调用方按资源类型跳过，不进安装计划）。它们不进动作列表，但必须在计划里可见，否则「为什么没装」无从查起。

能力令牌统一写成 `<form>/<name>@<major>`：`form` 是闭集 `tool` / `skill` / `content` / `config`，表示能力的消费形态、不是资源类型；`name` 匹配 `[a-z][a-z0-9-]*`，只描述能做什么；`major` 是从 1 起的正整数，主版本不同就视为不兼容的两种能力（目前只有精确匹配，没有范围）。资源的 `provides` / `needs` 共用这套写法，schema 用同一个正则 `^(tool|skill|content|config)/[a-z][a-z0-9-]*@[1-9][0-9]*$`。

## 3 Lock（`packhub.dev/lock/v0`）

把一个 Pack 的引用钉死并记下内容哈希，供复现与审查。锁只描述内容，不含任何安装形态与计划。

```jsonc
{
  "apiVersion": "packhub.dev/lock/v0",
  "pack": "lvlc233/team-conventions@0.0.1",
  "resolved": [
    { "id": "style-guide", "type": "knowledge", "source": "./resources/style-guide.md", "integrity": null, "resolvedAt": "2026-11-03T…" }
  ],
  "contentHash": "sha256-…",
  "generatedBy": "packhub/0.0.1"
}
```

不变量：

1. 锁只描述「引用了什么、内容是否完整」：`resolved` + `contentHash`，没有 `plan` / `plans` / `planHash`。装到哪个宿主、计划长什么样，由用到它的调用点（`packhub plan` / `packhub verify`、`pal install` / `pal update`、launcher）在那一刻用 `planFor(ctx, { harness })` 现算。
2. `contentHash` = 清单 + `resolved` 的规范化 sha256；口径只写在 kernel 的 `contentHashOf(manifest, resolved)` 上，写端（`buildLock`）与所有校验端（`checkLockConsistency`、`contentHashFor`、registry 门禁）都调它，不各算一份：
   - 清单先去掉 `signatures`：签名不是内容，而且签名载荷就是这个哈希，含进来会自指；
   - 清单里的资源来源先按 `resolved` 归一（有 pin 过的 source / integrity 就用它），于是「作者清单 + 锁」和「pin 过的清单 + 锁」算出同一个哈希；
   - `resolved` 每项只取 `{id, type, source, integrity}`，丢掉 `resolvedAt`（生成时刻不是内容），并按 `id` 升序排列；
   - 序列化用 `canonicalize`（递归键排序、丢 undefined），sha256 写成 `sha256-<base64>`。
   - **安装宿主不进这个哈希**：清单不声明宿主支持集，「这次装到平铺目录还是某个宿主」是安装期参数；同一份内容装到任何宿主，`contentHash` 相同。
3. `checkLockConsistency(lock, manifest)` 是「锁 ↔ 清单」的唯一判据，只返回 `ok` / `mismatch` / `missing` 三档。没有 `contentHash` 的锁按 `mismatch` 报（无效锁），要求重跑 `packhub lock`。
4. `resolved[].source` 是**解析后**的引用：github 分支 / tag 换成 40 位 commit，npm 范围 / tag 换成具体版本，pypi 换成具体版本。
5. `integrity` 来自清单、npm 的 `dist.integrity`、https 下载后的 sha256 或 PyPI 的 sha256；解析不出来就是 `null`，读方不得把 `null` 当「已验证」。
6. 安装时按 `resolved[]` 替换清单里的引用（`withLockPins`），保证「锁里写什么就装什么」。

## 4 State（`.packhub/state.json`）

安装结果，落在被安装的目录里，是「装了什么」的唯一真相。

```jsonc
{
  "apiVersion": "packhub.dev/state/v0",
  "generations": [
    {
      "id": "20261103-210954",
      "at": "2026-11-03T…",
      "pack": "lvlc233/team-conventions@0.0.1",
      "planHash": "sha256-…",
      "existed": [".packhub/knowledge/style-guide.md"],
      "created": [".packhub/prompts/commit-rules.md"],
      // 安装根之外的绝对路径另存一份：旧 generation 没有这两个字段
      "existedExternal": ["C:/Users/me/.claude.json"],
      "createdExternal": []
    }
  ],
  "packs": {
    "lvlc233/team-conventions@0.0.1": {
      "planHash": "sha256-…",
      "installedAt": "2026-11-03T…",
      "actions": [{ "actionId": "write#1", "op": "write", "status": "done", "target": ".packhub/knowledge/style-guide.md" }],
      "written": [
        { "path": ".packhub/knowledge/style-guide.md", "base": "root" },
        { "path": "skills/doc-review", "base": "home" },
        { "path": "C:/Users/me/.claude.json", "base": "absolute" }
      ],
      "home": "C:/Users/me/.claude",
      "stateDirs": [{ "id": "memory", "path": ".packhub/state/memory", "retain": "keep" }],
      "plan": { "harness": "dsh", "planHash": "sha256-…", "actions": [], "verify": [], "excluded": [] }
    }
  }
}
```

不变量：

1. 每个包一条记录，键是 `name@version`；升级时旧版本记录并入新 key，不留旧 key。
2. `written` 是这个包**拥有**的文件集合（跨多次安装取并集），每条是 `{ path, base }`：`root` 相对安装根、`home` 相对 `record.home`、`absolute` 原样（必须是绝对路径）。卸载据此删除；共享文件（MCP 配置 / 指令块）按计划快照里的 key / 块 id 摘除，不整文件删。
3. `home` 是这次安装的宿主 home 段（绝对路径）。没有 home 的项目 / 平铺安装不写这个字段；解析 `base: 'home'` 的路径时缺它直接报错，不猜一个目录。
4. `plan` 是该次安装的计划快照，形如 `PlanSnapshot`：可选 `harness`（平铺目录时不出现）/ `planHash` / `actions` / `verify` / `excluded`，**没有** `apiVersion` 与 `pack`（那两个字段只属于完整 plan）；`diff`、`update`、`planOutputs` 只需要这一份。不参与任何哈希。
5. `stateDirs` 记录清单 `state` 块声明的目录；这些目录不进 `written`、不进版本镜像、不被快照回滚删除。
6. `generations` 每次安装追加一条，更早的会被裁掉（保留策略在 `install.ts`）；`existed` / `created` 是回退的依据。安装根之外的绝对路径记在 `existedExternal` / `createdExternal`（安装前复制进快照目录的 `external/`），rollback 与失败回滚同样恢复 / 删除它们。
7. **旧 state 兼容读**：更早的 `written` 是 `string[]`，读端按 `base: 'root'` 归一，不因为读而重写文件；只有下一次真正写 state 时才变成新形状。

装好与否的判定、并发、回退、所有权与卸载顺序是行为，写在 `packages/runtime/src/install.ts`（`applyPlan` / `acquireLock` / `removePack` / `rollbackPack`）。

安装审计不写进 state：`pal install` / `pal update` 每次追加一行到本机 `$PACKHUB_HOME/audit.jsonl`（`at` / `action` / 包与版本 / `planHash` / `ok`），`pal list --history` 读它。审计是「这台机器上发生过什么」的旁挂记录，不进锁、不进内容哈希；记录字段见 `packages/runtime/src/audit.ts`。

## 5 Index（`packhub.dev/index/v0`）

registry 的索引，`search` / `install` / `update` 只读它。

```jsonc
{
  "apiVersion": "packhub.dev/index/v0",
  "generatedAt": "2026-11-03T…",
  "packs": [
    {
      "name": "lvlc233/team-conventions",
      "title": "团队约定包",
      "description": "…",
      "latest": "0.0.1",
      "versions": ["0.0.1"],
      "trust": "verified",
      "verifiedAt": "2026-11-03T…",
      "signers": [],
      "keywords": ["conventions"],
      "resourceCount": 3,
      "install": "pal install lvlc233/team-conventions",
      "license": "CC-BY-4.0",
      "homepage": "https://example.com/team-conventions",
      "authors": [{ "name": "…", "url": "https://example.com" }]
    }
  ]
}
```

`trust` 只有两档：

- `verified`：这个包的**每个**版本都有 `verify.json`、`ok: true` 且报告里的 `contentHash` 与按锁的 `resolved` 重算的 `contentHash` 一致（整包都 verified 才标 verified）。
- `community`：其余；有报告但对不上会给 warning，按 community 处理。

清单派生的展示字段（`title` / `description` / `license` / `homepage` / `authors` / `keywords`）取 `latest` 那个版本的清单；`signers` 只收该版本 `verify.json` 里 `ok: true` 的 key；清单没写的字段写 `null` 或空数组，读方不用猜。索引没有 `targets` 字段：清单不声明支持集，装到哪个宿主是使用者在安装时选的参数。

不变量：

1. 一个 `<name>@<version>` 一经发布，目录内容只增不改；要改就发新版本。
2. `install` 字段由生成器统一拼，不允许作者自定义。它假设使用者已配好默认 registry（`PACKHUB_INDEX` 或本机配置），否则需要自己加 `--index`。
3. `index.json` 是生成物：由 `pnpm registry:index` 重建，手改的改动会在下次重建时消失。

索引门禁怎么算、`verified` 凭什么给，见 `packages/registry/src/build.ts`。

## 5.5 Verify 报告（`packhub.dev/verify/v0`）

```jsonc
{
  "apiVersion": "packhub.dev/verify/v0",
  "contentHash": "sha256-…",
  "planHash": "sha256-…",
  "ok": true,
  "signatures": [{ "key": "…", "ok": true }],
  "checks": [{ "index": 0, "type": "knowledge-integrity", "status": "pass", "detail": "…" }],
  "outcomes": [{ "actionId": "write#1", "op": "write", "status": "done" }],
  "verifiedAt": "…",
  "env": { "node": "v22.15.0", "platform": "win32", "arch": "x64" }
}
```

- `ok`：每一步都是 `done` / `noop`，且每项检查都是 `pass`。`skipped`、`needs-approval`、`failed` 都算未完成。
- 报告与 `contentHash` 绑定：它证明的是「这份内容（清单 + 解析后的引用）」跑得通；内容变了报告不作数（索引会降为 `community`）。`planHash` 记的是 runner 实际跑的那份平铺目录计划的哈希，是安装期派生值，不是锁的内容。
- 检查类型与判定细节见 `packages/runtime/src/verify.ts`、`packages/runtime/src/derived-checks.ts` 与 `packages/runner/src/run.ts`。

检查从哪来：

- **漂移段（`pal verify`）**：在已装目录里按 state 里的安装记录查磁盘现状——写过的文件/链接在不在、指令托管块、配置里登记的 MCP 条目（按计划的 `configPath` / `format`）、宿主侧 MCP 登记、`state` 目录、激活指针。不读清单，也不需要作者声明。
- **自动派生**：检查段从计划自动生成——带 `integrity` 的 `write` 动作生成一条 `knowledge-integrity`；`packhub verify --probe-mcp` 时每个 `register.mcp` 生成一条 `mcp-ready`。派生项排在作者 `verify` 项之后；`knowledge-integrity` 与作者写了同一 `resource` + `integrity` 的项不重复，`mcp-ready` 按 resource 去重。
- **作者声明**：清单 `verify` 数组只写计划推不出来的检查——`command`（脚本 self-test）与 `scenario`（宿主语义，要真跑一次）。`file-exists` / `config-key` 仍支持，但它们的覆盖与漂移段重叠，属于重复兜底，不再推荐手写；`knowledge-integrity` / `mcp-ready` 字段仍在 schema 里，通常也不用写（期望哈希来自资源声明的 `integrity`，MCP 规格来自计划）。
- `scenario.harness` 是运行期注册的宿主 id，形状匹配 `^[a-z][a-z0-9-]*$`。schema 不静态列宿主名单；实际能选哪些由 kernel 的注册表决定，没注册的 id 在计划 / 检查期报错。
- `pal install` 装后自动复核包含派生项（只读）；`publish` 门禁在干净目录里跑清单检查 + 派生段（不受装后只读子集的限制）。
- `--probe-mcp` 只影响这一次 `packhub verify`：对计划里每个 MCP server 真发一次 `initialize`（stdio 起进程 / http 发请求），默认关闭——起进程或联网有副作用与耗时。

## 6 签名旁挂（`packhub.dev/signatures/v0`）

```jsonc
{
  "apiVersion": "packhub.dev/signatures/v0",
  "signatures": [{ "key": "<32 字节公钥 base64>", "sig": "<ed25519 base64>", "at": "…" }]
}
```

- 签的是 `{pack, contentHash}`：`pack` 是 `name@version`，`contentHash` 是清单 + 解析后引用的规范化哈希（口径见 §3 / kernel `lock.ts` 的 `contentHashOf`）。清单里任何影响内容的改动都会让签名失效，改注释不影响；安装宿主不在载荷里——同一份内容装到哪个宿主都是这个签名。
- 放独立文件而不是写进 `packhub.yaml`：版本目录的清单哈希不能因为「补一个签名」而变化。
- `.phub` 归档会带上这个文件；`verify.json` 里记录每个签名的校验结果。
- **verified 不证明是谁发的**，签名才回答来源。

## 7 归档（`.phub`）

`.phub` 是包离开作者目录后的样子：一个 tar.gz，解开就是 Pack 根目录。默认 `vendored`，自包含——清单、锁、签名（有的话）加上包目录下所有顶层条目都装进去，`.packhub`、`node_modules`、`.git`、`dist` 和旧归档不装，装的时候不用再取包内容。

除非作者有理由改写这条默认：`reference` 只装清单、锁和签名，安装时联网取制品。这种包不能有 `./` 来源——那些字节不在归档里，装到写文件那一步一定失败，所以打包时直接拒绝。

归档只能从版本目录打。发布、`registry:pack`、重锁都走 `packVersionArchive`，不从包源目录打：源目录的锁可能还没刷新，打出来的东西会和索引对不上。这样归档里的清单、锁和 `verify.json`，跟版本目录里的是同一份。

发布前门禁会再核一遍：归档和版本目录的锁 `contentHash` 必须相等，报告的 `ok` 和 `contentHash` 必须相等，版本目录有报告时归档不能缺；对不上、缺锁、缺报告都是 error。只比这几个值，不比字节——行尾、缩进不同不算问题。

解包是最后一道：`..`、绝对路径（含 Windows 盘符）、符号链接、硬链接一律拒绝。

## 8 版本策略

- `plan` / `lock` / `state` / `index` 各自独立升版本；读方遇到不认识的 `apiVersion` 主版本必须拒绝，不得猜测。`index` 的版本号由 kernel 的 `INDEX_API_VERSION` 单点给出：`readIndex` 比它，遇到不认识的值拒绝。
- **格式 v0 期间没有任何兼容承诺**：字段可以增、可以改语义、可以删。读方按当前形状严格校验——缺字段、多出字段、缺 `apiVersion`、主版本不认识的文件一律判无效（锁判 `mismatch`、报告判 error、registry 门禁报 error），不做旧形状特判、不写迁移。唯一例外是 `state.written` 的旧 `string[]`：它按 `base: 'root'` 兼容读（见 §4 第 7 条），因为 state 是本机缓存、卸载要能继续工作。
- 产品 0.0.2 起，registry 里的包**必须**有 lock；要 `verified` 还必须有对得上的 verify 报告。
