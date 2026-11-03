# 核心闭环结构

一个 Pack 从作者的机器走到使用者的机器，中间只有四个「事实」在流动：

```
manifest（声明） → plan（要做什么） → state（做了什么） → report（对不对）
```

闭环成立的判据不是「能装上」，而是**这四个事实能在别人的机器上被独立复核**。下面按环节拆开，每一步标注落点、谁保证、坏了长什么样。

---

> 这里只讲"数据怎么流动"。**谁在跑、谁拉谁、怎么同步**（Hub / 资源主机 / 目标机器 / Runner 四种角色）见 [deployment.md](deployment.md)。

## 一、链路

```
作者机器                                              registry（静态）                        使用者机器
────────                                             ───────────────                        ──────────
packhub.yaml
   │ schema + 能力图校验
   ▼
planHash ──────────┐
   │               │
packhub.lock.json  │  ① 解析引用并钉死（commit / 版本 / sha256）
   │               │
   ▼               │
干净目录 install   │  ② 真的装一遍
   │               │
verify.json ───────┤  ③ 校验并出报告
   │               │
   ▼               ▼
registry/packs/<scope>/<name>/<version>/  ──④ index.json（生成，不手写）
                                                  │
                                                  ▼
                                        npx packhub add <name>  ⑤ 取 manifest + lock
                                                  │
                                                  ▼
                                        解析 → 能力图 → plan  ⑥ 与 lock 比对 planHash
                                                  │
                                                  ▼
                                        install（执行 plan）  ⑦ 下载 + 完整性校验 + 落盘
                                                  │
                                                  ▼
                                        .packhub/state.json  ⑧ 记录每一步结果
                                                  │
                                                  ▼
                                        packhub verify      ⑨ 跑 checks 出报告
```

---

## 二、每一步的输入 / 输出 / 保证

| # | 环节 | 输入 | 输出（落点） | 谁保证 | 失败的典型样子 |
|---|---|---|---|---|---|
| ① | 钉引用 | `packhub.yaml` | `packhub.lock.json`（Pack 目录） | `lock.ts` | `unpinned-source`：`@main` / 无 pin |
| ② | 干净安装 | 版本目录副本 | 临时目录里的 `.packhub/` | `verify-pack.mjs` | `integrity-mismatch`、`404` |
| ③ | 校验 | 装完的目录 + `verify` 数组 | `verify.json`（版本目录） | `verify.ts` | `file-exists` 失败、`config-key` 不匹配 |
| ④ | 生成索引 | 版本目录们 | `registry/index.json` | `build-index.mjs` | 锁过期、版本目录被改、缺锁 |
| ⑤ | 取包 | `scope/name` 或 git URL | manifest + lock（临时） | `add`（**未实现**） | — |
| ⑥ | 出计划 | manifest | `plan` + `planHash` | `plan.ts` / `graph.ts` | `unmet-need`、`pin-conflict`、`bad-bind` |
| ⑦ | 执行 | plan | 文件 + `.packhub/state.json` | `install.ts` + `download.ts` | 跳过（依赖失败）、越界路径拒绝 |
| ⑧ | 记录 | 动作结果 | state（合并 `written`） | `install.ts` | 半装：有 `skipped` / `failed` |
| ⑨ | 复核 | state + verify | 报告（终端 / API） | `verify.ts` | 只看 `file-exists`，进程探活仍跳过 |

---

## 三、四个核对关系（闭环的硬约束）

任何一环对不上，都不是「小问题」，是闭环断了：

1. **锁 ↔ 计划**：`lock.planHash === plan(manifest).planHash`。
   对不上 = 清单改了但没重新锁 → `registry:check` 拒绝发布。
2. **报告 ↔ 锁**：`verify.planHash === lock.planHash`。
   对不上 = 验的是旧版本 → 该版本降为 `community`。
3. **状态 ↔ 计划**：`state.planHash === plan.planHash`。
   对不上 = 装完之后清单变了 → 面板显示「计划已变化」，提示 `update`。
4. **索引 ↔ 报告**：`index.trust === 'verified'` 当且仅当 `verify.ok && planHash 三方一致`。
   这条是页面上的 ✓ 唯一的来源，不允许人工标。

---

## 四、代码地图（一个环节一个文件）

```
packages/core/src/
├── manifest.ts   YAML → 对象，ajv 跑 schema（唯一的"结构真实"）
├── ref.ts        source 解析、pin 是否可复现（唯一的"引用真实"）
├── graph.ts      provides/needs、顺序、成环、pin 冲突（唯一的"接线真实"）
├── plan.ts       manifest → 动作清单 + planHash（唯一的"副作用描述"）
├── download.ts   npm/github/https 下载 + 完整性（唯一的"字节真实"）
├── install.ts    执行 plan、备份、state（唯一的"副作用"）
├── verify.ts     只读检查（唯一的"结果真实"）
└── lock.ts       解析结果固化（唯一的"复现凭据"）

packages/cli/src/
├── cli.ts        plan / install / verify / lock / init / serve（薄命令）
└── server.ts     四个只读+一个写接口（任何前端都只吃这一层）

scripts/registry/
├── build-index.mjs   ④ 门禁 + 索引生成
└── verify-pack.mjs   ②③ 干净环境安装 + 报告

packages/web/          只做映射：/（作者座舱） /packs（未实现） /forms（形态 demo）
```

原则：**判断只在 core，执行只在 install，记录只在 state，呈现只在 web。** 任何一层重复实现一次判断，闭环就开始漏气。

---

## 五、一个 Pack 的状态机

```
draft ──lock──► locked ──verify──► verified ──publish──► published
                                                              │
使用者机器： (未装) ──add/install──► installed ──update──► installed(新 planHash)
                                      │
                                      └──清单变更→ stale（面板提示更新）
```

- `published` 之后版本目录不可变；要改只能发新版本。
- `installed` 有 `skipped` / `failed` 就是**半装**：不算 installed，面板不得标已装。
- `stale` 不是错，是提醒；`update` 才决定要不要跟进。

---

## 六、现在闭环断在哪

| 断点 | 现状 | 补法 |
|---|---|---|
| ⑤ 取包 | 没有 `add`，registry 已被生成但没人消费 | `packhub add` 三种入口：`registry:name` / `git+https://` / `./x.phub` |
| ⑩ 差异 | 没有 `diff / update`，无法做增量同步 | 生成两份 plan 的差异，按动作粒度展示 |
| ⑪ 版本与回滚 | install 原地写，装坏了退不回 | 装到 `.packhub/versions/<ver>/`，用激活指针切换 |
| ⑫ 并发 | 两个进程同时装同一目录会互相踩 | `.packhub/lock` 互斥 |
| ⑬ 接入宿主 | 只物化到 `.packhub/`，harness 读不到 | 投影 adapter：`.claude/skills`、`.mcp.json`、`AGENTS.md` 托管块 |
| ③ 自动验 | `verify.json` 目前本地跑出来，CI 只做门禁 | CI 里跑 `verify-pack`，失败即拒绝合并 |
| ⑨ 深校验 | `command` / `mcp-ready` / `knowledge-integrity` 仍是 `skipped` | 起 MCP 进程探活、按 integrity 校验知识文件 |
| ⑧ 卸载 | `state.written` 有了，但没有 `remove` | 按 state 反向删，冲突则提示人工确认 |
| ⑦ 依赖类型 | `pypi:` 明确报不支持 | 有真实需求再做，wheel 解包不难但没有包用它 |

**当前真正卡住的只有 ⑤。** 没有 `add`，前面所有东西（registry、verified、锁、报告）都只是给自己看的。

---

## 七、不在闭环里（有意为之）

- **执行**：Agent 怎么用这些资源，是 Agent 的事。
- **依赖求解**：冲突就报错，不做 SAT。
- **多包冲突**：同一目录装两个包互相覆盖文件，目前不检测（需要「包所有权」表，0.0.3）。
- **账号与托管**：registry 是公开仓库 + 静态索引，没有登录。
- **在线安装**：网页只给命令，安装永远发生在用户机器上。
