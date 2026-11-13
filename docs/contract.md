---
kind: contract
summary: v0 数据形状与格式层不变量
verified: 2026-11-11
decay: 365
review: 格式升版、字段增删、apiVersion 变化时
---

# PackHub 契约（格式 v0）

内核与所有外壳之间交换的带版本 JSON。这一份只回答两件事：**文件里长什么样、哪些不变量必须守住**。流程与判定在代码里：`packages/runtime/src/install.ts`、`verify.ts`，`packages/registry/src/publish.ts`、`build.ts`。

## 0 版本总表

格式版本与产品版本是两件事。产品在 0.0.x，格式先统一在一个代际：

| 契约 | 版本号 | 位置 |
|---|---|---|
| manifest | `packhub.dev/v0` | `packhub.yaml` |
| plan | `packhub.dev/plan/v0` | 运行时（`--json` 输出） |
| lock | `packhub.dev/lock/v0` | `packhub.lock.json` |
| state | `packhub.dev/state/v0` | `.packhub/state.json` |
| index | `packhub.dev/index/v0` | `registry/index.json` |
| verify 报告 | `packhub.dev/verify/v0` | `verify.json` |
| 资源目录 | `packhub.dev/resources/v0` | `registry/resources.json` |
| 签名旁挂 | `packhub.dev/signatures/v0` | `packhub.signatures.json` |
| 版本记录 | `packhub.dev/version/v0` | `.packhub/versions/<pack>/<ver>/record.json` |
| 激活指针 | `packhub.dev/active/v0` | `.packhub/active.json` |
| 市场库 | `packhub.dev/market/v0` | 市场根的 `.market/market.db`（SQLite） |

上面这些是 **Pack 格式**。PAL 的本地记录另有自己的版本并且独立演进（`packhub.dev/instance/v1`、`packhub.dev/pal/v0`、`packhub.dev/pal/core/v1`、`packhub.dev/baseline/v0`、`packhub.dev/credentials/v0`、`packhub.dev/trust/v0`），它们只在启动器与本机之间流动，不随 Pack 分发，见 `packages/launcher/src/records.ts`。

**v0 期间没有兼容承诺**：字段可以增、可以改语义、可以删。读方遇到不认识的主版本（`v1`、`v2`）必须拒绝，不得猜测；遇到不认识的字段同样报错，不做静默忽略。

强制方式：manifest 由 `schema/packhub.v0.schema.json` 强制；`state`、`lock`、`active.json`、版本记录、credentials、trust、签名文件读到别的主版本一律拒绝（`apiVersion.ts` 的 `assertApiVersion`），缺 `apiVersion` 的文件同样拒绝。

**升 v1 的判据**（三条都满足才升，届时提供 `packhub migrate`，内核同时读 v0 / v1 一段时间）：

1. 资源类型集合固定，不再增删；
2. `slots` / `bindings` 的语义固定；
3. `lock` 里每个引用都有 integrity，不再出现 `null`。

## 1 Plan（`packhub.dev/plan/v0`）

内核算出的动作清单。**唯一的副作用描述**，`install` 只是执行它。

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

不变量：

1. `planHash` = 规范化 JSON（键排序、去 undefined）的 sha256；同输入必须同哈希，跨机器、跨时间。
2. 动作 id 稳定：`<op>#<n>`，`n` 按生成顺序；同一 manifest 两次生成必须一致。
3. `actions[].dependsOn` 指向的 id 必须存在于同一 plan。
4. 动作目标路径相对安装根（state 所在目录）；来源路径相对 Pack 目录；执行层必须拒绝 `..` 逃逸。

动作原语：`fetch` · `unpack` · `copy` · `write` · `delete` · `link.skill` · `link.exec` · `register.mcp` · `merge.config` · `exec` · `instruction` · `state.dir`。

- `copy` 把包内文件或目录整份复制到安装根（工具的执行体走这条）。
- `link.exec` 在 binDir 生成入口：`runtime entry [module] [args…] "$@"`，posix 只有无后缀的 sh 脚本，`.cmd` 只在 Windows 生成；`route` 模式的 entry 是生成的通用 shim，module 是工具执行体。

- `delete` 只删单个文件（`modify` 用它删掉上游带的文件或整段命中的文件）；目标不存在算 `noop`，不失败，也不进 `written`——卸载不会去恢复它，回滚由快照负责。

- `register.mcp` 在 `.toml` 目标上写带标记的 `[mcp_servers.<id>]` 托管块，卸载只摘自己那段。
- `state.dir` 只建目录；清单里的 `state` 块决定路径与 `retain`，目录不参与 `written`、不随快照回滚删除。
- `exec` 带 `command/args/cwd/env/timeout` 与 `approval: required`：计划里永远标待批准，执行层必须显式 `--allow-exec` 才跑。退出码非零算失败，触发整次安装回滚。`undo` 目前只作记录，不自动执行。

`excluded` 记录没进计划的候选，`reason` 四种：`unbound-slot`（槽位没绑定）、`target-mismatch`（资源级 target 不匹配）、`optional-unmet`（可选资源缺依赖，级联跳过）、`host-managed`（同步时由宿主管理、不进安装计划）。它们不进动作列表，但必须在计划里可见，否则「为什么没装」无从查起。

能力名统一写成 `命名空间:名字`（`audio:speak`、`tool:repo_search`），槽位契约与 `provides` / `needs` 共用这套写法。

## 2 Lock（`packhub.dev/lock/v0`）

把一个 Pack 的引用钉死，供复现与审查。

```jsonc
{
  "apiVersion": "packhub.dev/lock/v0",
  "pack": "lvlc233/team-conventions@0.0.1",
  "resolved": [
    { "id": "style-guide", "type": "knowledge", "source": "./resources/style-guide.md", "integrity": null, "resolvedAt": "2026-11-03T…" }
  ],
  "planHash": "sha256-…",
  "generatedBy": "packhub/0.0.1",
  "plan": { "target": "dir", "planHash": "sha256-…", "actions": [], "verify": [], "excluded": [] },
  "plans": {
    "dir": { "target": "dir", "planHash": "sha256-…", "actions": [], "verify": [], "excluded": [] },
    "dsh": { "target": "dsh", "planHash": "sha256-…", "actions": [], "verify": [], "excluded": [] }
  }
}
```

不变量：

1. `planHash` 必须与当前 manifest 生成的 plan 一致；不一致 = 锁过期，`registry:check` 拒绝。
2. `resolved[].source` 是**解析后**的引用：github 分支 / tag 换成 40 位 commit，npm 范围 / tag 换成具体版本，pypi 换成具体版本。
3. `integrity` 来自清单、npm 的 `dist.integrity`、https 下载后的 sha256 或 PyPI 的 sha256；解析不出来就是 `null`，读方不得把 `null` 当「已验证」。
4. `plan` 是主计划快照，`plans` 是每个已声明 target 的快照；快照不参与 `planHash` 计算。`lock` 为 `metadata.targets` 里的每个 target 各算一份，`plan` 取 `--target`（默认 `dir`，未声明时取第一个）。没有快照就无法做差异对比（`packhub diff` 会提示重跑 `lock`）。
5. 安装时按 `resolved[]` 替换清单里的引用（`withLockPins`），保证「锁里写什么就装什么」；`add` 先按本次 target 找 `plans[target]` 重算并比对，只有旧锁（没有 `plans`）才退化为只核对主计划并给 warning。

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
      "plan": { "target": "dir", "actions": [], "verify": [], "excluded": [] }
    }
  }
}
```

不变量：

1. 每个包一条记录，键是 `name@version`；升级时旧版本记录并入新 key，不留旧 key。
2. `written` 是这个包**拥有**的文件集合（跨多次安装取并集），卸载据此删除。
3. `plan` 是该次安装的计划快照，`update` 与 `verify` 靠它工作；不参与任何哈希。
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
      "keywords": ["conventions"],
      "resourceCount": 3,
      "install": "packhub add lvlc233/team-conventions"
    }
  ]
}
```

`trust` 只有两档：

- `verified`：这个包的**每个**版本都有 `verify.json`、`ok: true` 且 `planHash` 与锁一致（整包都 verified 才标 verified）。
- `community`：其余；有报告但对不上会给 warning，按 community 处理。

不变量：

1. 一个 `<name>@<version>` 一经发布，目录内容只增不改；要改就发新版本。
2. `install` 字段由生成器统一拼，不允许作者自定义。它假设使用者已配好默认 registry（`PACKHUB_INDEX` 或本机配置），否则需要自己加 `--index`。
3. `index.json` 是生成物：由 `pnpm registry:index` 重建，手改的改动会在下次重建时消失。

索引门禁怎么算、`verified` 凭什么给，见 `packages/registry/src/build.ts`。

## 4.5 Verify 报告（`packhub.dev/verify/v0`）

```jsonc
{
  "apiVersion": "packhub.dev/verify/v0",
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
- 报告与 `planHash` 绑定；计划变了旧报告不作数（索引会降为 `community`）。
- 检查类型与判定细节见 `packages/runtime/src/verify.ts` 与 `packages/runner/src/run.ts`。

## 5 签名旁挂（`packhub.dev/signatures/v0`）

```jsonc
{
  "apiVersion": "packhub.dev/signatures/v0",
  "signatures": [{ "key": "<32 字节公钥 base64>", "sig": "<ed25519 base64>", "at": "…" }]
}
```

- 签的是 `{pack@version, planHash}`：清单里任何影响安装的改动都会让签名失效，改注释不影响。
- 放独立文件而不是写进 `packhub.yaml`：版本目录的清单哈希不能因为「补一个签名」而变化。
- `.phub` 归档会带上这个文件；`verify.json` 里记录每个签名的校验结果。
- **verified 不证明是谁发的**，签名才回答来源。

## 6 归档（`.phub`）

`.phub` 是 tar.gz，解包后就是 Pack 根目录。

- `vendored`（默认，自包含）：清单 + 锁 + 有签名时的签名文件 + 全部顶层条目，跳过 `.packhub`、`node_modules`、`.git`、`dist`、旧归档。
- `reference`：只有清单 + 锁（+ 签名文件），安装时联网取制品。清单里有 `./` 来源时直接拒绝——那些字节不在归档里，装到 `write` 那步必然失败。
- 解包 `filter` 拒绝 `..`、绝对路径（含 Windows 盘符）、符号链接与硬链接条目。

## 7 兼容策略

- `plan` / `lock` / `state` / `index` 各自独立升版本；读方遇到不认识的 `apiVersion` 主版本必须拒绝，不得猜测。
- 新增可选字段不算破坏性变更；删除字段、改变语义、收紧校验算。
- v0.0.2 起，registry 里的包**必须**有 lock；要 `verified` 还必须有对得上的 verify 报告。

## 8 不在这份文档里

| 内容 | 在哪 |
|---|---|
| registry 目录树、发布步骤、索引门禁 | `packages/registry/src/` |
| 市场写端端点（已冻结） | `packages/market/src/server.ts` |
| Hub 只读端点 | `packages/hub/src/server.ts` |
| 安装顺序、快照、回滚、升级、卸载、所有权 | `packages/runtime/src/install.ts` |
| 检查类型、runner、探针 | `packages/runtime/src/verify.ts`、`harness-probe.ts`、`packages/runner/src/run.ts` |
| 实例记录、实例根、启停与看护 | `packages/launcher/src/` |
