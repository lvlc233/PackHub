---
kind: contract
summary: 格式 v0 的数据形状与格式层不变量
verified: 2026-11-18
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
| lock | `packhub.dev/lock/v0` | `packhub.lock.json`（形状见 §2：`resolved` + `contentHash`） |
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
| 实例配置与运行态 | `packhub.dev/instance/v0` | `packages/launcher/src/records.ts` |
| core 握手 | `packhub.dev/pal/core/v0` | `packages/launcher/src/core.ts` |
| 实例基线 | `packhub.dev/baseline/v0` | `packages/launcher/src/baseline.ts` |
| 实例备份 | `packhub.dev/instance-backup/v0` | `packages/launcher/src/backup.ts` |
| 实例模板 | `packhub.dev/instance-template/v0` | `packages/launcher/src/template.ts` |
| 私有来源凭据 | `packhub.dev/credentials/v0` | `packages/runtime/src/credentials.ts` |
| 持久信任公钥 | `packhub.dev/trust/v0` | `packages/runtime/src/trust.ts` |


## 1 Plan（`packhub.dev/plan/v0`）

内核算出的动作清单。负责确保包资源安装的正确性。

```jsonc
{
  "apiVersion": "packhub.dev/plan/v0",
  "pack": { "name": "lvlc233/team-conventions", "version": "0.0.1" },
  "target": "dir",
  "actions": [
    { "actionId": "write#1", "op": "write", "to": ".packhub/knowledge/style-guide.md", "from": "./resources/style-guide.md", "resource": "style-guide" }
  ],
  "verify": [{ "type": "file-exists", "path": ".packhub/knowledge/style-guide.md" }],
  "excluded": [{ "resource": "tts-a", "slot": "voice", "reason": "unbound-slot" }],
  "planHash": "sha256-…"
}
```

1. `planHash` = 计划自身的哈希，用于确保版本一致性。


动作原语：`fetch` · `unpack` · `copy` · `write` · `delete` · `link.skill` · `link.exec` · `register.mcp` · `exec` · `instruction` · `state.dir`。

每个 op 的路径、来源基准、撤销方式、撤销载荷、共享判定与派生输出都在 `packages/kernel/src/plan-ops.ts` 的 `PLAN_OPS` 表里（单点；执行器与清理侧都从它派生）：

| op | `from` 基准 | 写到安装根 | 撤销 | 撤销载荷 | 共享 | 备注 |
|---|---|---|---|---|---|---|
| `fetch` | 无（`uri`） | `dest` | 删文件 | — | 否 | 下载物进缓存，进快照/版本镜像 |
| `unpack` | 安装根（`root`） | `to` | 删文件 | — | 否 | 读 fetch 实际写盘的位置 |
| `copy` | Pack（`pack`） | `to` | 删文件 | — | 否 | 本地工具执行体整份复制 |
| `write` | Pack（`pack`），内联内容可省 | `to` | 删文件 | — | 否 | 二进制也走它 |
| `delete` | 无 | `to`（被删对象） | 不撤销 | — | 否 | 目标不存在算 `noop`，不进 `written` |
| `link.skill` | 本地 `pack` / 远程 `root` | `to` | 删文件 | — | 否 | codex 额外派生 `<to>/agents/openai.yaml` |
| `link.exec` | 无（`entry` / `module` 相对安装根） | `to`、`to.cmd` | 删文件 | — | 否 | `.cmd` 只在 win32 生成；`platforms` 不匹配由执行器 `skipped` |
| `register.mcp` | 无（`spec`） | `path`（默认 `.packhub/config.json`） | 还原共享配置 | `{path, key}` | 是 | `.toml` 用托管块 |
| `exec` | 无 | 无 | 不撤销 | — | 否 | 计划里永远 `approval: required` |
| `instruction` | 无（`content`） | `file` | 摘托管块 | `{file, blockId}` | 是 | 只动 `<!-- packhub:begin/end -->` 之间 |
| `state.dir` | 无 | 无（只建目录） | 不撤销 | — | 否 | 数据目录，不随升级/卸载删除 |

「共享」只由动作决定：`register.mcp` 按 key 合并、`instruction` 按托管块追加；落点路径（`.json` / `.toml` / 根目录 `.md`）不改变共享性，私有 `.json` 照常进版本镜像、参与所有权冲突、升级时按普通文件删。

撤销载荷回答「撤销时要动哪一处」：`restore-shared` 给共享配置文件与 `mcpServers` 下要摘的键，`strip-block` 给指令文件与托管块 id。执行器（`deactivatePlan` / `pruneRemoved` / `removePack`）只按 `undo` 的四种方式各做一次，不再按 op 猜路径与键；`state.dir` 只建目录、不产出文件，所以不进文件冲突集合，同一目录挂两个 state id 另报 `duplicate-state-path`。

派生输出是「install 期生成、计划动作里没有对行动作」的文件（codex 的 `agents/openai.yaml`、`link.exec` 的 `.cmd`）；它们由表的 `paths()` 声明，因此 `planPaths(plan)`、快照、版本镜像与升级清理都能覆盖到。

`copy` 把包内文件或目录整份复制到安装根（工具的执行体走这条）。
`link.exec` 在 binDir 生成入口：`runtime entry [module] [args…] "$@"`，posix 只有无后缀的 sh 脚本，`.cmd` 只在 Windows 生成；`route` 模式的 entry 是生成的通用 shim，module 是工具执行体。`platforms`（`platform-arch`）不匹配时执行器记 `skipped`，计划里仍保留这条动作。

- `delete` 只删单个文件（`modify` 用它删掉上游带的文件或整段命中的文件）；目标不存在算 `noop`，不失败，也不进 `written`——卸载不会去恢复它，回滚由快照负责。

- `register.mcp` 在 `.toml` 目标上写带标记的 `[mcp_servers.<id>]` 托管块，卸载只摘自己那段。
- `state.dir` 只建目录；清单里的 `state` 块决定路径与 `retain`，目录不参与 `written`、不随快照回滚删除。
- `exec` 带 `command/args/cwd/env/timeout` 与 `approval: required`：计划里永远标待批准，执行层必须显式 `--allow-exec` 才跑。退出码非零算失败，触发整次安装回滚。`undo` 目前只作记录，不自动执行。

`excluded` 记录没进计划的候选，`reason` 四种：`unbound-slot`（槽位没绑定）、`target-mismatch`（资源级 target 不匹配）、`optional-unmet`（可选资源缺依赖，级联跳过）、`host-managed`（同步时由宿主管理、不进安装计划）。它们不进动作列表，但必须在计划里可见，否则「为什么没装」无从查起。

能力名统一写成 `命名空间:名字`（`audio:speak`、`tool:repo_search`），槽位契约与 `provides` / `needs` 共用这套写法。

## 2 Lock（`packhub.dev/lock/v0`）

把一个 Pack 的引用钉死并记下内容哈希，供复现与审查。锁只描述内容，不含任何 target 的计划。

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

1. 锁只描述「引用了什么、内容是否完整」：`resolved` + `contentHash`，没有 `plan` / `plans` / `planHash`。装到哪个 target、计划长什么样，由用到它的调用点（`plan` / `add` / `diff` / `update` / `verify` / hub / launcher）在那一刻用 `planFor(ctx, { target })` 现算。
2. `contentHash` = 清单 + `resolved` 的规范化 sha256；口径只写在 kernel 的 `contentHashOf(manifest, resolved)` 上，写端（`buildLock`）与所有校验端（`checkLockConsistency`、`contentHashFor`、registry 门禁）都调它，不各算一份：
   - 清单先去掉 `signatures`：签名不是内容，而且签名载荷就是这个哈希，含进来会自指；
   - 清单里的资源来源先按 `resolved` 归一（有 pin 过的 source / integrity 就用它），于是「作者清单 + 锁」和「pin 过的清单 + 锁」算出同一个哈希；
   - `resolved` 每项只取 `{id, type, source, integrity}`，丢掉 `resolvedAt`（生成时刻不是内容），并按 `id` 升序排列；
   - 序列化用 `canonicalize`（递归键排序、丢 undefined），sha256 写成 `sha256-<base64>`。
   - **安装 target 不进这个哈希**：清单里声明的 `targets` 是内容的一部分，但「这次装到 dir 还是某个宿主」是安装期参数；同一份内容装到任何 target，`contentHash` 相同。
3. `checkLockConsistency(lock, manifest)` 是「锁 ↔ 清单」的唯一判据，只返回 `ok` / `mismatch` / `missing` 三档。没有 `contentHash` 的锁按 `mismatch` 报（无效锁），要求重跑 `packhub lock`。
4. `resolved[].source` 是**解析后**的引用：github 分支 / tag 换成 40 位 commit，npm 范围 / tag 换成具体版本，pypi 换成具体版本。
5. `integrity` 来自清单、npm 的 `dist.integrity`、https 下载后的 sha256 或 PyPI 的 sha256；解析不出来就是 `null`，读方不得把 `null` 当「已验证」。
6. 安装时按 `resolved[]` 替换清单里的引用（`withLockPins`），保证「锁里写什么就装什么」。

## 3 State（`.packhub/state.json`）

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
      "created": [".packhub/prompts/commit-rules.md"]
    }
  ],
  "packs": {
    "lvlc233/team-conventions@0.0.1": {
      "planHash": "sha256-…",
      "installedAt": "2026-11-03T…",
      "actions": [{ "actionId": "write#1", "op": "write", "status": "done", "target": ".packhub/knowledge/style-guide.md" }],
      "written": [".packhub/knowledge/style-guide.md"],
      "stateDirs": [{ "id": "memory", "path": ".packhub/state/memory", "retain": "keep" }],
      "plan": { "target": "dir", "planHash": "sha256-…", "actions": [], "verify": [], "excluded": [] }
    }
  }
}
```

不变量：

1. 每个包一条记录，键是 `name@version`；升级时旧版本记录并入新 key，不留旧 key。
2. `written` 是这个包**拥有**的文件集合（跨多次安装取并集），卸载据此删除。
3. `plan` 是该次安装的计划快照，形如 `PlanSnapshot`：`target` / `planHash` / `actions` / `verify` / `excluded`，**没有** `apiVersion` 与 `pack`（那两个字段只属于完整 plan）；`diff`、`update`、`planPaths` 只需要这一份。不参与任何哈希。
4. `stateDirs` 记录清单 `state` 块声明的目录；这些目录不进 `written`、不进版本镜像、不被快照回滚删除。
5. `generations` 每次安装追加一条，更早的会被裁掉（保留策略在 `install.ts`）；`existed` / `created` 是回退的依据。

装好与否的判定、并发、回退、所有权与卸载顺序是行为，写在 `packages/runtime/src/install.ts`（`applyPlan` / `acquireLock` / `removePack` / `rollbackPack`）。

## 4 Index（`packhub.dev/index/v0`）

registry 的索引，`search` / `add` / `update` 只读它。

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
      "targets": ["dir"],
      "trust": "verified",
      "verifiedAt": "2026-11-03T…",
      "signers": [],
      "keywords": ["conventions"],
      "resourceCount": 3,
      "install": "packhub add lvlc233/team-conventions",
      "license": "CC-BY-4.0",
      "homepage": "https://example.com/team-conventions",
      "authors": [{ "name": "…", "url": "https://example.com" }],
      "requiresAgent": "dsh"
    }
  ]
}
```

`trust` 只有两档：

- `verified`：这个包的**每个**版本都有 `verify.json`、`ok: true` 且报告里的 `contentHash` 与按锁的 `resolved` 重算的 `contentHash` 一致（整包都 verified 才标 verified）。
- `community`：其余；有报告但对不上会给 warning，按 community 处理。

清单派生的展示字段（`title` / `description` / `license` / `homepage` / `authors` / `keywords` / `requiresAgent`）取 `latest` 那个版本的清单；`signers` 只收该版本 `verify.json` 里 `ok: true` 的 key；清单没写的字段写 `null` 或空数组，读方不用猜。

不变量：

1. 一个 `<name>@<version>` 一经发布，目录内容只增不改；要改就发新版本。
2. `install` 字段由生成器统一拼，不允许作者自定义。它假设使用者已配好默认 registry（`PACKHUB_INDEX` 或本机配置），否则需要自己加 `--index`。
3. `index.json` 是生成物：由 `pnpm registry:index` 重建，手改的改动会在下次重建时消失。

索引门禁怎么算、`verified` 凭什么给，见 `packages/registry/src/build.ts`。

## 4.5 Verify 报告（`packhub.dev/verify/v0`）

```jsonc
{
  "apiVersion": "packhub.dev/verify/v0",
  "contentHash": "sha256-…",
  "planHash": "sha256-…",
  "ok": true,
  "signatures": [{ "key": "…", "ok": true }],
  "checks": [{ "index": 0, "type": "file-exists", "status": "pass", "detail": "…" }],
  "outcomes": [{ "actionId": "write#1", "op": "write", "status": "done" }],
  "verifiedAt": "…",
  "env": { "node": "v22.15.0", "platform": "win32", "arch": "x64" }
}
```

- `ok`：每一步都是 `done` / `noop`，且每项检查都是 `pass`。`skipped`、`needs-approval`、`failed` 都算未完成；发布门禁只接受 `ok: true`。
- 报告与 `contentHash` 绑定：它证明的是「这份内容（清单 + 解析后的引用）」跑得通；内容变了报告不作数（索引会降为 `community`）。`planHash` 记的是 runner 实际跑的那份 dir 计划的哈希，是安装期派生值——发布对齐（`publish.ts`）与索引门禁（`build.ts`）都只比 `contentHash`。
- 检查类型与判定细节见 `packages/runtime/src/verify.ts` 与 `packages/runner/src/run.ts`。

## 5 签名旁挂（`packhub.dev/signatures/v0`）

```jsonc
{
  "apiVersion": "packhub.dev/signatures/v0",
  "signatures": [{ "key": "<32 字节公钥 base64>", "sig": "<ed25519 base64>", "at": "…" }]
}
```

- 签的是 `{pack, contentHash}`：`pack` 是 `name@version`，`contentHash` 是清单 + 解析后引用的规范化哈希（口径见 §2 / kernel `lock.ts` 的 `contentHashOf`）。清单里任何影响内容的改动都会让签名失效，改注释不影响；安装 target 不在载荷里——同一份内容装到哪个宿主都是这个签名。
- 放独立文件而不是写进 `packhub.yaml`：版本目录的清单哈希不能因为「补一个签名」而变化。
- `.phub` 归档会带上这个文件；`verify.json` 里记录每个签名的校验结果。
- **verified 不证明是谁发的**，签名才回答来源。

## 6 归档（`.phub`）

`.phub` 是 tar.gz，解包后就是 Pack 根目录。

- `vendored`（默认，自包含）：清单 + 锁 + 有签名时的签名文件 + 全部顶层条目，跳过 `.packhub`、`node_modules`、`.git`、`dist`、旧归档。
- `reference`：只有清单 + 锁（+ 签名文件），安装时联网取制品。清单里有 `./` 来源时直接拒绝——那些字节不在归档里，装到 `write` 那步必然失败。
- 发布、`registry:pack` 与重锁都从**版本目录**打（同一个入口 `packVersionArchive`）：归档里的清单 / 锁 / `verify.json` 就是版本目录那一份，不从包源目录直接打。
- 索引门禁核对归档与版本目录的**语义一致**：锁的 `contentHash`、报告的 `ok` 与 `contentHash` 相等即可，不比字节（两边的行尾 / 缩进可以不同）；归档缺锁、版本目录有报告而归档缺报告、或哈希对不上都是 error。
- 解包 `filter` 拒绝 `..`、绝对路径（含 Windows 盘符）、符号链接与硬链接条目。

## 7 版本策略

- `plan` / `lock` / `state` / `index` 各自独立升版本；读方遇到不认识的 `apiVersion` 主版本必须拒绝，不得猜测。`index` 的版本号由 kernel 的 `INDEX_API_VERSION` 单点给出：`readIndex` 比它，Hub 的 `/api/registry` 也对它，遇到不认识的值回 500、不透传。
- **格式 v0 期间没有任何兼容承诺**：字段可以增、可以改语义、可以删。读方按当前形状严格校验——缺字段、多出字段、缺 `apiVersion`、主版本不认识的文件一律判无效（锁判 `mismatch`、报告判 error、registry 门禁报 error），不做旧形状特判、不写迁移。
- 产品 0.0.2 起，registry 里的包**必须**有 lock；要 `verified` 还必须有对得上的 verify 报告。
