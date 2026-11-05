# PackHub 契约（格式 v0）

六份带版本号的 JSON 是内核与所有外壳之间唯一的交换格式。它们的代际由下面的版本总表统一管理。

---

## 0. 版本总表：全都叫 v0

格式版本与产品版本是两件事。产品还在 0.0.x，格式先统一到一个代际：

| 契约 | 版本号 | 位置 |
|---|---|---|
| manifest | `packhub.dev/v0` | `packhub.yaml` |
| plan | `packhub.dev/plan/v0` | 运行时 |
| lock | `packhub.dev/lock/v0` | `packhub.lock.json` |
| state | `packhub.dev/state/v0` | `.packhub/state.json` |
| index | `packhub.dev/index/v0` | `registry/index.json` |
| verify 报告 | `packhub.dev/verify/v0` | `verify.json` |

**v0 期间没有兼容承诺**：字段可以增、可以改语义、可以删。读方遇到不认识的主版本（`v1`、`v2`）必须拒绝，不得猜测；遇到不认识的字段同样报错，不做静默忽略。

**升 v1 的判据**（三条都满足才升，届时提供 `packhub migrate`，内核同时读 v0/v1 一段时间）：

1. 资源类型集合固定，不再增删；
2. `composition`（env / order / needs / bind）语义固定；
3. `lock` 里每个引用都有 integrity，不再出现 `null`。

---

## 1. Plan（`packhub.dev/plan/v0`）

内核算出的动作清单。**唯一的副作用描述**，`install` 只是执行它。

```jsonc
{
  "apiVersion": "packhub.dev/plan/v0.1",
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

1. `planHash` = 规范化 JSON（键排序、去 undefined）的 sha256；**同输入必须同哈希**，跨机器、跨时间。
2. 动作 id 稳定：`<op>#<n>`，n 按生成顺序；同一 manifest 两次生成必须一致。
3. `actions[].dependsOn` 指向的 id 必须存在于同一 plan。
4. 所有路径是相对 Pack 目录的；执行层必须拒绝 `..` 逃逸。

动作原语（已实装）：`fetch` · `unpack` · `write` · `link.skill` · `register.mcp` · `merge.config` · `exec` · `instruction`。

`exec` 带 `command/args/cwd/env/timeout` 与 `approval: required`：计划里永远标待批准，执行层必须显式 `--allow-exec` 才跑；退出码非零算失败，失败会触发整次安装回滚。`run` / `publish` 默认不批准 exec，此时动作为 `needs-approval`，报告不会通过。注意：回滚只恢复文件，命令在仓库外的副作用无法自动撤销（清单里的 `undo` 目前只作记录，不自动执行）。

`excluded` 记录被槽位绑定排除的候选（`reason: unbound-slot`）：它们不进动作列表，但必须在计划里可见，否则「为什么没装」无从查起。能力名统一写成 `命名空间:名字`（`audio:speak`、`memory:read`、`tool:repo_search`），槽位契约与 `provides`/`needs` 共用这套写法。

---

## 2. Lock（`packhub.dev/lock/v0`）

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
  "plan": {                      // 计划快照：diff / update 靠它算「改了什么」
    "target": "dir",
    "actions": [],
    "verify": [],
    "excluded": []
  }
}
```

不变量：

1. `planHash` 必须与当前 manifest 生成的 plan 一致；不一致 = 锁过期，`registry:check` 拒绝。
2. `resolved[].source` 是**解析后**的引用：github 分支/tag 换成 40 位 commit，npm 范围/tag 换成具体版本，pypi 换成具体版本。
3. `integrity` 来自清单、npm 的 `dist.integrity`、https 下载后的 sha256 或 PyPI 的 sha256；解析不出来就是 `null`，读方不得把 `null` 当「已验证」。
4. `plan` 是快照，不参与 `planHash` 计算；没有它就无法做差异对比（`packhub diff` 会提示重跑 `lock`）。
5. 安装时按 `resolved[]` 替换清单里的引用（`withLockPins`），保证「锁里写什么就装什么」；`add` 会先用锁的 target 重算计划并与 `planHash` 比对。

---

## 3. State（`.packhub/state.json`）

安装结果，落在被安装的目录里，是卸载与「装了什么」的唯一真相。

```jsonc
{
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
      "plan": { "target": "dir", "actions": [], "verify": [], "excluded": [] }
    }
  }
}
```

不变量：

1. **只有每一步都是 `done` / `noop` 才算装好**；有任何 `skipped` / `failed`，这个包是半装的，`/api/packs` 不得标已装。
2. `written` 是这个包**拥有**的文件集合（跨多次安装取并集），卸载据此删除。
3. `planHash` 与当前 plan 不一致时，状态显示「计划已变化」，提示 `update`。
4. **并发**：同一目录同时只允许一个安装，靠 `.packhub/installing.lock`（`O_EXCL` 原子创建，内容为 pid）。进程崩溃留下的锁需要人工确认后删除，报错信息会给出 pid。
5. **卸载**按 `written` 逆序（先深后浅）删除；`.packhub/config.json` 是多包共享的，还有别的包时保留，只有最后一个包被移除时才删。删完 state 里没有包了就删掉 state 文件。
6. `plan` 是该次安装的计划快照，`update` 靠它算差异；不参与任何哈希。
7. **项目级所有权**：同一个路径不允许被两个包各写一份（配置文件与根目录的 `.md` 指令文件例外——它们是合并/托管块）。冲突时安装直接拒绝并列出占用者；确认要覆盖用 `--overwrite`。同一个包的不同版本不算冲突（升级覆盖自己）。`r`n8. **generation 与回退**：每次安装前把会被改写的文件快照到 `.packhub/snapshots/<gen>/`（含当时的 `state.json`），并记 `existed` / `created`。`packhub rollback` 把 `existed` 放回去、删掉 `created`、state 回到当时。只保留最近 5 个 generation，更早的快照会被清掉（回退会报「快照已不在」）。generation id 带毫秒与随机后缀，同一秒的两次安装不会撞车。
9. **失败原子化**：任一动作失败 → 按本次快照恢复被改写的文件、删除本次新建的文件、不写 state、不留 generation；CLI 明确提示「已回滚」。
10. **安装根就是 state 所在目录**：`plan.verify` 里的相对路径一律相对这个目录；`packhub verify <项目>` 直接读 state 里的 `plan` 复核，不要求项目里有 `packhub.yaml`。
11. **升级不留旧 key**：同一包名的新版本安装时，旧版本记录并入 `written` 后删除；`update` 再把「旧计划有、新计划没有」的产物从磁盘清掉。

**合并配置是可逆的**：`merge.config` 执行时记下每个叶子键在合并前是否存在、值是什么（`action.undo`）；卸载时按它撤销——原来的值放回去、新增的键删掉、空了就删文件（不留空壳）。备份仍在 `.packhub/backups/`，但正常路径不再需要人工取回。

---

## 4. Index（`packhub.dev/index/v0`）

registry 的静态清单，站点与 `search` 只读它。

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
      "install": "npx packhub add lvlc233/team-conventions"
    }
  ]
}
```

`trust` 判定（只有两档）：

- `verified`：该版本存在 `verify.json`，且 `ok: true`，且 `planHash` 与锁一致。
- `community`：其余。

不变量：

1. 一个 `<name>@<version>` 一经发布，目录内容只增不改；要改就发新版本。
2. `install` 字段由生成器统一拼，不允许作者自定义。它假设使用者已经配好默认 registry（`PACKHUB_INDEX` 或 `~/.packhub/config.json`），否则需要自己加 `--index`。
3. `index.json` 由 `scripts/registry/build-index.mjs` 生成，不手写。
4. Pages/静态站发布时必须把 `packs/**/*.phub` 一起带出去：`index.json` 只写相对路径，归档不在站点里这条命令就必然 404。

---

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
- 检查实现：`file-exists`、`config-key`、`command`、`mcp-ready`（stdio 做 initialize 握手，http 传输暂时 skipped）、`knowledge-integrity`（在 `.packhub/` 产物里按 sha256 找文件）。
- 报告与 `planHash` 绑定；计划变了旧报告不作数（索引会降为 `community`）。

## 5. registry 目录约定

```
registry/packs/<scope>/<name>/
├── 0.0.1/
│   ├── packhub.yaml
│   ├── packhub.lock.json
│   ├── verify.json          # 可选；有且 ok 才是 verified
│   ├── resources/           # vendored 本地制品（如有）
│   └── fragments/
└── 0.0.2/ …
```

规则：

1. **版本目录不可变**。CI 检查：已存在的版本目录，其 `packhub.yaml` 的哈希不得变化。
2. 本地制品必须 vendored 进版本目录，否则别人装不了。
3. `verify.json` 由 `pnpm registry:verify <dir>` 在干净环境生成；作者本地或 CI 都可。

---

## 6. 本地 HTTP API（`packhub serve`）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/packs` | `{ root, packs: PackSummary[] }` |
| GET | `/api/pack?dir=` | `{ manifest, issues, plan, state }` |
| POST | `/api/install?dir=` | `{ outcomes, planHash, statePath }` |
| POST | `/api/verify?dir=` | `{ results, planHash }`；目录里只有 state 时返回 `{ installed: [{pack, results}], results, planHash }` |

约束：只绑 `127.0.0.1`；`dir` 必须落在服务根目录内；不提供远程安装（安装永远发生在用户机器上）。

---

## 7. 兼容策略

- `plan` / `lock` / `state` / `index` 各自独立升版本；读方遇到不认识的 `apiVersion` 主版本必须拒绝，不得猜测。
- 新增可选字段不算破坏性变更；删除字段、改变语义、收紧校验算。
- v0.0.2 起，registry 里的包**必须**有 lock 与（若要 verified）verify 报告。

---

## 8. 签名旁挂文件（`packhub.signatures.json`）

```jsonc
{
  "apiVersion": "packhub.dev/signatures/v0",
  "signatures": [{ "key": "<32 字节公钥 base64>", "sig": "<ed25519 base64>", "at": "…" }]
}
```

- 签的是 `{pack@version, planHash}`：清单里任何影响安装的改动都会让签名失效；改注释不影响。
- 放独立文件而不是写进 `packhub.yaml`：版本目录的清单哈希不能因为"补一个签名"而变化。
- `.phub` 归档会带上这个文件；`verify.json` 里记录每个签名的校验结果。

## 9. 归档与 registry 布局

`.phub` = tar.gz，解包后就是 Pack 根目录（`packhub.yaml` + 可选制品）。

```
<registry>/
├── index.json                              # 生成物，不手写
└── packs/<scope>/<name>/<version>.phub     # 归档路径是约定，不写进索引
```

- `reference` 模式只打 `packhub.yaml` + `packhub.lock.json`，安装时联网取制品。
- `vendored` 模式把 `resources/ fragments/ overrides/ skills/ glue/` 一起打进去，离线可装（内网场景用这个）。
- `packhub add <name> --index <路径|URL>`：读索引 → 取 `<base>/packs/<name>/<latest>.phub` → 解包到 `.packhub/packs/<name>/` → 生成计划 → 装进项目。索引与归档的相对位置固定，避免两处真相。