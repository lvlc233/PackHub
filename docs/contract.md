# PackHub 契约（格式 v0）

六份带版本号的 JSON 是内核与所有外壳之间唯一的东西。它们的代际由下面的版本总表统一管理。

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

动作原语（已实装）：`fetch` · `unpack` · `write` · `link.skill` · `register.mcp` · `merge.config` · `exec` · `probe`。

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
2. `resolved[].source` 是**解析后**的引用（github tag 已换成 commit）。
3. `integrity` 为 `null` 表示未联网解析，发布版应补全（https 与 npm 由下载时补齐）。
4. `plan` 是快照，不参与 `planHash` 计算；没有它就无法做差异对比（`packhub diff` 会提示重跑 `lock`）。

---

## 3. State（`.packhub/state.json`）

安装结果，落在被安装的目录里，是卸载与「装了什么」的唯一真相。

```jsonc
{
  "packs": {
    "lvlc233/team-conventions@0.0.1": {
      "planHash": "sha256-…",
      "installedAt": "2026-11-03T…",
      "actions": [{ "actionId": "write#1", "op": "write", "status": "done", "target": ".packhub/knowledge/style-guide.md" }],
      "written": [".packhub/knowledge/style-guide.md"]
    }
  }
}
```

不变量：

1. **只有每一步都是 `done` / `noop` 才算装好**；有任何 `skipped` / `failed`，这个包是半装的，`/api/packs` 不得标已装。
2. `written` 是这个包**拥有**的文件集合（跨多次安装取并集），卸载据此删除。
3. `planHash` 与当前 plan 不一致时，状态显示「计划已变化」，提示 `update`。

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
2. `install` 字段由生成器统一拼，不允许作者自定义。
3. `index.json` 由 `scripts/registry/build-index.mjs` 生成，不手写。

---

## 5. registry 目录约定

```
registry/packs/<scope>/<name>/
├── 0.0.1/
│   ├── packhub.yaml
│   ├── packhub.lock.json
│   ├── verify.json          # 可选；有且 ok 才是 verified
│   ├── resources/           # vendored 本地资源（如有）
│   └── fragments/
└── 0.0.2/ …
```

规则：

1. **版本目录不可变**。CI 检查：已存在的版本目录，其 `packhub.yaml` 的哈希不得变化。
2. 本地资源必须 vendored 进版本目录，否则别人装不了。
3. `verify.json` 由 `pnpm registry:verify <dir>` 在干净环境生成；作者本地或 CI 都可。

---

## 6. 本地 HTTP API（`packhub serve`）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/packs` | `{ root, packs: PackSummary[] }` |
| GET | `/api/pack?dir=` | `{ manifest, issues, plan, state }` |
| POST | `/api/install?dir=` | `{ outcomes, planHash, statePath }` |
| POST | `/api/verify?dir=` | `{ results, planHash }` |

约束：只绑 `127.0.0.1`；`dir` 必须落在服务根目录内；不提供远程安装（安装永远发生在用户机器上）。

---

## 7. 兼容策略

- `plan` / `lock` / `state` / `index` 各自独立升版本；读方遇到不认识的 `apiVersion` 主版本必须拒绝，不得猜测。
- 新增可选字段不算破坏性变更；删除字段、改变语义、收紧校验算。
- v0.0.2 起，registry 里的包**必须**有 lock 与（若要 verified）verify 报告。
