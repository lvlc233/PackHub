---
kind: ledger
summary: 功能台账（现状 + 证据）
verified: 2026-11-11
decay: 60
review: 任何行为变更的提交
---

# PackHub 功能台账

> 一行一条：编号 ／ 功能点 ／ 能观察到的事实 ／ 现状 ／ 证据。这里只留结论，机制看证据指向的代码。
> 证据是可打开的文件、符号或测试名；不写行号，行号会漂。
> 状态五档：`[done]` 代码在、主路径有测试或实测；`[part]` 有但功能上有明确缺口；`[parked]` 代码在但**已冻结**，不再推进也不再维护，重开前不算完成；`[todo]` 没有；`[na]` 不属于 PackHub 或已移除。

## 域索引

| 域 | 名称 | 一句话 | 主要落点 |
|---|---|---|---|
| PKG | 清单与格式 | 一个 Pack 能声明什么、不能声明什么 | `packages/kernel` |
| REF | 引用、锁与解析 | 引用怎么定位、钉死、校验、核对 | `packages/kernel`、`packages/runtime` |
| PLN | 计划 | 清单如何变成可比较的动作清单 | `packages/kernel` |
| INS | 安装与状态 | 执行、快照、state、回退、卸载、升级 | `packages/runtime` |
| VER | 校验与门禁 | 装完是否可用，发布前是否可信 | `packages/runtime`、`packages/runner` |
| REG | registry 与市场 | 版本目录、索引、发布门禁；市场写端已冻结 | `packages/registry`、`packages/market` |
| HUB | 只读发布端 | 只读 JSON API，不含页面、写与执行 | `packages/hub` |
| SYN | 全局 harness 同步 | 一份 Pack 写进 DSH / Codex / Claude Code 的 skills | `packages/runtime` |
| CLI | 命令与交互 | 人怎么用、脚本怎么调 | `apps/local` |
| TRU | 安全与信任 | 签名、凭据、许可、可见性、审计 | `packages/runtime` |
| OPS | 工程与运维 | 测试、构建、CI、镜像 | `scripts`、`.github` |
| X | 跨切面 | Windows、编码、代理、并发、格式版本 | 各处 |
| PAL | 实例启动器 | 把 Pack 装进独立实例根，按宿主起停、看护、体检 | `packages/launcher` |
| NA | 不属于本项目 | 防止把「没有」当「漏做」 | — |

## 1 PKG ｜清单与格式

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| PKG-01 | manifest 严格校验 | 拼错字段、未知字段、缺必填都报 schema 错误（根 / metadata / resource 三层都 `additionalProperties: false`） | [done] | `packages/kernel/src/manifest.ts`、`schema/packhub.v0.schema.json` |
| PKG-02 | 六类资源 | `mcp` / `skill` / `prompt` / `knowledge` / `config` / `tool` 各有示例与安装语义，示例被测试真跑 | [done] | `packages/kernel/src/types.ts`、`resource-examples.test.ts` |
| PKG-03 | target 声明 | `metadata.targets` 声明四档；`install` / `add` 在出计划前核对，未声明退出 2。`plan` / `verify` 走 `planFor` 不核对声明，用未声明的 target 仍会出计划 | [done] | `schema/packhub.v0.schema.json`、`apps/local/src/cli.ts`、`cli.test.ts` |
| PKG-04 | 槽位与绑定 | 被 `bindings` 点名的候选进计划，其余进 `excluded`（`unbound-slot`）；绑定的实现缺契约能力报 `slot-contract-unmet`；有候选却完全没绑定报 `slot-unbound` 且不出计划。`slot swap` 只改一行并打印计划差异 | [done] | `packages/kernel/src/graph.ts`、`slots.test.ts`、`cli.ts` |
| PKG-05 | （编号未使用） | 历史空缺，不补号 | [na] | — |
| PKG-06 | composition | v0 已移除：schema 无该字段，源码 2026-11-07 删除；接线由 `provides` / `needs` / `dependsOn` 与 `slots` / `bindings` 承担 | [na] | `schema/packhub.v0.schema.json`；`f10bc49`、`095de32` |
| PKG-07 | overrides | 资源级覆盖 pin / 参数，不改上游清单；覆盖不存在的资源报 `override-unknown-resource` | [done] | `graph.ts`、`plan.ts`、`overlay.test.ts` |
| PKG-08 | overlays | 文件级覆盖排在资源之后；两个覆盖层改同一文件报 `overlay-conflict`，盖掉生成物只给 `overlay-shadows` 警告；`from` 越出包目录报错 | [done] | `packages/kernel/src/plan.ts`、`overlay.test.ts`、`overlay-outside.test.ts` |
| PKG-09 | 可见性声明 | 四档写在 schema；schema 的 `default` 不参与运行时，未写时由读端按 `private` 兜底 | [done] | `schema/packhub.v0.schema.json`、`packages/registry/src/build.ts`、`publish.ts` |
| PKG-10 | 签名声明 | 清单可带 `signatures`，也可写独立文件；读取端两边合并 | [done] | `schema/packhub.v0.schema.json`、`packages/runtime/src/signature.ts`、`signfile.ts`、`consume.ts` |
| PKG-11 | `extends` | v0 已移除：schema 无该字段，`extends.ts` 已删除；`install.ts` 里还留着一段提 extends 的注释与 `../` 只读分支（死路径） | [na] | `schema/packhub.v0.schema.json`；`f10bc49` |
| PKG-12 | 资源级 target 裁剪 | 资源 `targets` 未命中时进 `excluded`（`target-mismatch`），不进动作 | [done] | `packages/kernel/src/plan.ts`、`target-trim.test.ts` |
| PKG-13 | 本地覆盖 | `.packhub/local.yaml` 只支持 `overrides` / `bindings` / `vars`（无 `env`）；不进 `lock.resolved`，但会改计划与 `planHash`；`add` 在锁核对之后才应用 | [done] | `packages/kernel/src/index.ts`、`lock.ts`、`local-overrides.test.ts` |
| PKG-14 | PACK.md / CHANGELOG | 发布时复制进版本目录；Hub 与市场接口返回原文；不参与 `planHash` | [done] | `packages/registry/src/publish.ts`、`hub/src/server.ts`、`market/server.ts` |
| PKG-15 | 持久状态目录 | `state` 块声明目录与 `retain`；`${state.x}` 计划期插值；安装建目录（`state.dir` 排最前），升级 / 卸载默认保留 | [done] | `packages/kernel/src/plan.ts`、`packages/runtime/test/state.test.ts`、`state.test.ts` |
| PKG-16 | optional 级联跳过 | `optional: true` 且 `needs` 没有提供方时进 `excluded`（`optional-unmet`），依赖它的也级联跳过；显式绑定到槽位的不跳过 | [done] | `graph.ts`、`optional.test.ts` |
| PKG-17 | requires.agent 只警告 | 未知 agent 报 `unknown-agent` 警告；agent 不在 `metadata.targets` 报 `agent-target-mismatch` 警告；都不阻断 | [done] | `graph.ts`、`optional.test.ts` |
| PKG-18 | overlays 细节 | `include` 按后缀过滤；目录不在包里报 `overlay-missing` / `overlay-outside-pack`，空覆盖给 `overlay-empty` 警告 | [done] | `plan.ts`、`overlay-outside.test.ts` |
| PKG-19 | vars 类型与插值 | `vars` 只收字符串 / 数字 / 布尔，`${vars.x}` 在计划期替换 | [done] | `schema/packhub.v0.schema.json`、`plan.ts`、`sync-claude.test.ts` |

## 2 REF ｜引用、锁与解析

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| REF-01 | source 类型 | `npm:` / `pypi:` / `github:` / `https://` / `./` 五类可解析；未知形态报错。`..` 在解析器里放行、schema 里拒绝，两处口径不一致 | [done] | `packages/kernel/src/ref.ts`、`ref.test.ts`、`schema/packhub.v0.schema.json` |
| REF-02 | 拒绝漂移 pin | `@main` / `@latest` / 版本范围 / 无 integrity 的 https 在 `plan` 阶段报错；`@dev` 这类任意分支名不在黑名单里，能不能锁住看 `lock` 之后的结果 | [done] | `ref.ts` 的 `checkSource`、`graph.ts`、`ref.test.ts` |
| REF-03 | lock 解析 | 分支 → commit、范围 → 具体版本、https 单文件 → sha256、pypi → sdist；npm 与 github 有锁级测试，https / pypi 只有单测 | [done] | `packages/runtime/src/resolve.ts`、`resolve.test.ts`、`pypi.test.ts` |
| REF-04 | 字节完整性 | npm 用 `dist.integrity`；https 下载边算边校验；github 按 commit 取归档算 sha256。下载端按前缀自适应 sha256 / sha512，但清单 schema 只允许 `sha256-` | [done] | `resolve.ts`、`download.ts`、`download.test.ts` |
| REF-05 | 私有来源鉴权 | `auth.env` 只存变量名；环境变量优先于凭据库；缺变量时报错只给变量名与 host，不含 token。token 只加在最终文件下载上，npm 元数据与 PyPI JSON 请求不带 | [done] | `install.ts`、`credentials.ts`、`auth.test.ts` |
| REF-06 | 计划快照 | 锁里有主计划 `plan`；声明多个 target 时另有 `plans`，每个 target 一份。单 target 不写 `plans` | [done] | `packages/kernel/src/lock.ts`、`lock-targets.test.ts` |
| REF-07 | 离线锁 | `lock --offline` 只解析本地引用；npm / github / https / pypi 原样写入锁（integrity 记 null）并逐条 warning，已 pin 的也不解析；`--help` 文案与实现一致 | [done] | `resolve.ts` 的 `resolveReferences`、`cli.ts` 的 `lock`、`lock-offline.test.ts` |
| REF-08 | pypi 只收 sdist | 从 PyPI 版本 JSON 里挑未 yanked、`packagetype=sdist` 且 `.tar.gz` 的包；只有 wheel 或 sdist 不是 `.tar.gz` 时明确报错，不落二进制 | [done] | `download.ts` 的 `pickSdist`、`pypi.test.ts` |
| REF-09 | `packhub://` 跨包引用 | v0 已移除：解析器遇到未知 scheme 直接报错，代码里无实现 | [na] | `ref.ts`；移除提交 `095de32` |
| REF-10 | 缓存与 GC | `cache ls` 标引用、`cache clean` 只删没被引用项并支持 dry-run。引用只认 state 里的计划快照——没有 `plan` 的旧 state 会被当成无引用 | [done] | `packages/runtime/src/cache.ts`、`cache.test.ts` |
| REF-11 | 代理 | 下载与索引请求走 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY`；代理设成进程级 dispatcher，运行中改环境变量不再生效。没有代理用例 | [done] | `download.ts` 的 `ensureProxy`、`packages/runtime/src/registry.ts` |
| REF-12 | 锁过期检测 | `add` 先比目标 target 的快照、缺失时回落顶层 `planHash`；不一致是硬错误（`--allow-stale-lock` 放行）；`diff` 比快照与当前计划，`--check` 非零退出 | [done] | `consume.ts`、`cli.ts`、`consume.test.ts` |
| REF-13 | 消费端一次性核对 | `inspectPack` 一次核锁、`verify.json`、签名信任，产出 `lock-mismatch` / `lock-without-plan` / `verify-not-ok` / `signature-invalid` / `signature-untrusted` 等 issue；安装时 error 级直接拦 | [done] | `consume.ts`、`consume.test.ts` |
| REF-14 | 未 pin 清单的自愈降级 | `lock` 不因未 pin 直接失败：解析成功就把 source + integrity 写回再生成计划；解析失败原样保留 + warning、integrity 写 `null` | [done] | `resolve.ts`、`resolve.test.ts` |
| REF-15 | `.phub` 与 `git+https` 来源 | `add` 除 registry 名外接受本地 `.phub` 与 `git+https://` 仓库（GitHub codeload / GitLab archive 端点）。`git+https` 不带 integrity 校验 | [done] | `packages/runtime/src/source.ts`、`cli.ts` |

## 3 PLN ｜计划

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| PLN-01 | 十个动作原语 | 类型定义里正好十个 `op`；`fetch`/`unpack`/`write`/`link.skill`/`link.bin`/`register.mcp`/`merge.config`/`exec`/`instruction`/`state.dir` 都能生成 | [done] | `packages/kernel/src/types.ts`、`plan.ts` |
| PLN-02 | 稳定动作 id | `<op>#n` 同类按序编号；同一清单两次生成一致 | [done] | `plan.ts`、`plan.test.ts` |
| PLN-03 | 依赖与顺序 | `dependsOn` 拓扑排序；无依赖的资源按清单顺序；成环报 `dependency-cycle` | [done] | `graph.ts` |
| PLN-04 | 能力检查 | `needs` 没有提供方报 `unmet-need` | [done] | `graph.ts`、`graph.test.ts` |
| PLN-05 | 槽位排除 | 未绑定的候选进 `excluded`，不进动作；只有「槽位已绑定别人」时这条才可见，完全没绑定是错误而不是排除 | [done] | `graph.ts`、`slots.test.ts` |
| PLN-06 | 冲突检测 | 输出冲突、覆盖层冲突、配置键冲突都是错误；`overlay-shadows` 只警告 | [done] | `plan.ts`、`overlay.test.ts` |
| PLN-07 | planHash | 规范化 JSON 的 sha256（`sha256-` + base64）；同输入两次一致有测试；跨机器只靠规范化，无专门用例 | [done] | `packages/kernel/src/util.ts`、`plan.ts`、`plan.test.ts` |
| PLN-08 | 一 target 一计划 | `lock` 为每个声明的 target 各算一份；主快照由 `--target` 指定，多 target 时才写 `plans` | [done] | `resolve.ts`、`lock.ts`、`lock-targets.test.ts` |
| PLN-09 | target 变量 | `${target.*}` 随 target 变化（skills / knowledge / prompts / bin / 配置与指令文件位置） | [done] | `plan.ts`、`targets.ts`、`state.test.ts` |
| PLN-10 | 未知 target | `planFor` 报 `unknown-target`（无测试）；`install` / `add` 更早一步报「没有声明 target」并退出 2 | [done] | `packages/kernel/src/index.ts`、`cli.ts` |
| PLN-11 | 预览 API | `POST /api/plan` 现算、不落盘，能力已在 Hub 里；`apps/local/server.ts` 这个路径从未存在过 | [na] | 并入 HUB-03 |
| PLN-12 | dry-run | `install --dry-run` 不取锁、不建 generation、不写 state；`add --dry-run` 只取包到临时目录；install 的 dry-run 无单测 | [done] | `install.ts`、`cli.ts`、`cli.test.ts` |
| PLN-13 | 未定义变量 | 模板变量解析不到报 `undefined-variable`，`vars` / `target` / `state` 共用同一套收集 | [done] | `plan.ts`、`util.ts` |
| PLN-14 | excluded 原因 | 四类：`unbound-slot` / `optional-unmet` / `target-mismatch` / `host-managed` | [done] | `graph.ts`、`plan.ts` |
| PLN-15 | 检查回填 integrity | 计划里的 `knowledge-integrity` 会带上资源的 `integrity`，校验按期望哈希核对 | [done] | `plan.ts`、`verify.ts` |
| PLN-16 | 有 error 不出计划 | `planFor` 先看 `ctx.issues`，有 error 直接返回，不生成动作 | [done] | `packages/kernel/src/index.ts` |
| PLN-17 | 指令动作 | `instruction` 的 blockId 是包名，内容列出资源 / 落点 / state 目录；只在 harness target 上生成 | [done] | `plan.ts`、`projection.test.ts` |

## 4 INS ｜安装与状态

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| INS-01 | 十类动作执行 | `fetch`/`unpack`/`write`/`link.skill`/`link.bin`/`register.mcp`/`merge.config`/`exec`/`instruction`/`state.dir` 都有实现；单条结果五种状态（`done`/`noop`/`failed`/`skipped`/`needs-approval`），失败即中断，后续动作不再有结果 | [done] | `packages/runtime/src/install.ts` 的 `applyAction`、`exec.test.ts` |
| INS-02 | 项目级所有权 | 别包占用的普通文件拒绝安装并列出占用者；`--overwrite` 放行。配置文件与根目录指令文件例外 | [done] | `install.ts` 的 `findOwnershipConflicts`、`conflicts.test.ts` |
| INS-03 | 共享文件 | 配置与根目录 `.md` 只写自己的键 / 托管块，块外内容不动 | [done] | `install.ts`、`inverse.test.ts` |
| INS-04 | 快照与 generation | 安装前把会被改写的路径复制进 `.packhub/snapshots/<gen>/files/`，同时存 `state.json`、`active.json` 与 `meta.json`；`--dry-run` 不快照也不取锁 | [done] | `install.ts` 的 `prepareGeneration` |
| INS-05 | 失败回滚 | 失败文件按快照回原、新建的删掉、不写 state、删掉本次 generation | [done] | `install.ts`、`failure.test.ts` |
| INS-06 | state 记录 | 每个包一条：`planHash`、动作结果、`written`、`stateDirs`、计划快照；版本 key 合并，不留旧 key | [done] | `install.ts` 的 `loadState` / `saveState`、`state.test.ts` |
| INS-07 | merge 可逆 | 配置按叶子键记 undo；卸载时还原或删键，空了删文件 | [done] | `install.ts`、`inverse.test.ts` |
| INS-08 | update 清理 | 先装新版，再用旧计划清掉「旧版有、新版没有」的文件 / 配置 / MCP / 块；取包与清理在安装锁之外 | [done] | `packages/runtime/src/update.ts`、`update-prune.test.ts` |
| INS-09 | uninstall | 按 `written` 的路径长度降序反删；registry 副本一起清；state 空了删文件 | [done] | `install.ts` 的 `removePack`、`uninstall.test.ts` |
| INS-10 | rollback | 一次退一个 generation；更早的快照会被裁掉；不回退 `.packhub/versions/` | [done] | `install.ts` 的 `rollbackPack`、`versioning.test.ts` |
| INS-11 | 并发锁 | `.packhub/installing.lock` 以 O_EXCL 创建；同一目录同时只允许一次安装 | [done] | `install.ts` 的 `acquireLock`、`guards.test.ts` |
| INS-12 | staged 版本 | 每次安装把产物镜像进 `.packhub/versions/<pack-slug>/<ver>/`（硬链接，不支持时复制）；`versions` / `activate` 整版切换，`active.json` 记指针 | [done] | `install.ts` 的 `stageVersion` / `pruneVersions`、`versions.test.ts`、`hardlink.test.ts` |
| INS-13 | 僵尸锁 | 锁里的 pid 已死时自动收回；活着的 pid 仍拒绝 | [done] | `install.ts`、`guards.test.ts` |
| INS-14 | 跨包目录内部冲突 | 所有权按前缀判：包拥有目录时，别人往里写也算冲突 | [done] | `findOwnershipConflicts`、`guards.test.ts` |
| INS-15 | 状态目录生命周期 | 卸载默认 `kept`；`retain: remove` 才删；升级换版本数据不动；`doctor` 报 `stateMissing` | [done] | `state.test.ts`、`doctor.ts` |
| INS-16 | 覆盖前备份 | 合并配置前把旧内容备份进 `.packhub/backups/`；正常路径靠 undo，不读备份，备份也不自动清理 | [done] | `install.ts` |
| INS-17 | activate 的边界 | 切换在安装锁里执行；失败时文件按快照恢复，state 与 `active.json` 也退回原内容（回退失败会连原错误一起报出来）；旧版本产物由 `deactivatePlan` 清掉，仍被新计划产出的保留；`fetch` 落点的清理没有单独用例 | [done] | `install.ts` 的 `activatePack` / `restoreText`、`deactivatePlan`、`versions.test.ts` |

## 5 VER ｜校验与门禁

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| VER-01 | 文件与配置检查 | `file-exists`、`config-key` 可 pass / fail；`config-key` 的 equals 分支没有直接测试 | [done] | `verify.ts`、`verify-deep.test.ts` |
| VER-02 | 命令检查 | `command` 执行并按退出码判，默认 30s 超时，失败带命令尾行 | [done] | `verify.ts`、`verify-deep.test.ts` |
| VER-03 | stdio MCP 握手 | `mcp-ready` 起进程发 initialize 并判响应；计划里没有 `register.mcp` 规格时记 `skipped` | [done] | `verify.ts`、`verify-deep.test.ts` |
| VER-04 | 内容哈希 | `knowledge-integrity` 在产物里按 sha256 找文件；无 `.packhub` 时回落项目根，跳过 `versions/`、`cache/` 与超过 8MB 的文件 | [done] | `verify.ts`、`verify-deep.test.ts` |
| VER-05 | http MCP 探活 | POST initialize，JSON / SSE 响应都认；判据是响应里有 `result` 或 `protocolVersion` 且状态 < 400。SSE 分支无直接测试 | [done] | `verify.ts`、`mcp-http.test.ts` |
| VER-06 | runner 判定 | 每步 `done`/`noop` 且每项 `pass` 才 `ok`；`skipped` / `needs-approval` / `failed` 都算未完成 | [done] | `packages/runner/src/run.ts`、`run.test.ts` |
| VER-07 | 报告绑哈希 | 报告记下计划的 `planHash`；与锁的对齐发生在发布侧（`report.planHash === lock.planHash`），不在 runner 里 | [done] | `run.ts`、`packages/registry/src/publish.ts` |
| VER-08 | 干净目录 runner | 复制到临时目录、删 `.packhub`、install + verify、写完报告删临时目录 | [done] | `run.ts`、`run.test.ts` |
| VER-09 | 发布门禁 | 报告不 ok 拒绝；另外还有清单校验、visibility、版本不可变、planHash 对齐四道 | [done] | `publish.ts`、`publish.test.ts` |
| VER-10 | scenario 探针 | 跑一条命令或问一次 harness，断言退出码 / 输出 / 文件；有 `cwd`、`timeout`，无多轮与工具链矩阵 | [done] | `verify.ts`、`scenario.test.ts` |
| VER-11 | harness 探针 | `probe` 调 headless 宿主复述托管块第一行，找不到标记即失败；`PACKHUB_PROBE_TIMEOUT` 默认 180s | [done] | `harness-probe.ts`、`harness-probe.test.ts` |
| VER-12 | 漂移检测 | `doctor` 查六类：文件缺失、托管块缺失、配置漂移、`active.json` 漂移、state 目录缺失、宿主 MCP 缺失。不校验托管块内容 | [done] | `doctor.ts`、`doctor.test.ts` |
| VER-13 | 项目根复核 | `verify <project>` 用 state 的计划快照跑检查；`--pack` 只验某个包。判定是「没有 fail 就 ok」，`skipped` 不判失败，与 runner 相反 | [done] | `installed.ts`、`installed.test.ts`、`cli.ts` |
| VER-14 | 安装后自动复核 | `add` / `update` / `activate` 装完立刻复核；默认只跑只读检查，`--deep-verify` 才跑 `command` / `mcp-ready`，`--no-verify` 关闭；失败不回滚 | [done] | `cli.ts`、`installed.ts` |
| VER-15 | 路径越界守卫 | 检查项的 `path` / `expectFiles` / `cwd` 解析后必须落在安装根内，越界直接 fail | [done] | `verify.ts` |
| VER-16 | 技能选择器探针 | `probe --skill <name>` 断言 skill 名出现在宿主的可用技能列表回答里 | [done] | `harness-probe.ts`、`harness-probe.test.ts` |

## 6 REG ｜registry 与市场

> 市场（`@packhub/market`）暂时冻结：代码留着，不再推进也不再维护，相关行标 `[parked]`。registry 本身（发布、索引、门禁）仍在维护。

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| REG-01 | 发布版本目录 | 写清单、锁、可选签名、`PACK.md` / `CHANGELOG.md`（存在才写）、vendored 顶层条目与 `verify.json` 到 `packs/<scope>/<name>/<ver>/` | [done] | `packages/registry/src/publish.ts`、`publish.test.ts` |
| REG-02 | `.phub` 归档 | tar.gz，默认 vendored（自包含）；`--reference` 只打清单与锁，带本地来源时拒绝 | [done] | `packages/runtime/src/pack.ts` 的 `packArchive`、`pack.test.ts` |
| REG-03 | 索引生成 | `index.json` 由 `registry:index` 生成，`registry:check` 只校验不写 | [done] | `build.ts`、`scripts/registry/build-index.mjs` |
| REG-04 | 版本不可变 | 发布时已存在的版本目录拒绝（`--force` 例外）；CI 侧用 `git show HEAD:` 比对 `packhub.yaml` 与 `verify.json`，非 git / 未跟踪 / 无 HEAD 静默跳过；锁、签名、归档字节不核 | [part] | `build.ts`、`publish.ts`、`publish.test.ts` |
| REG-05 | trust 两档 | `verified` 只由「`verify.json.ok` 且 planHash 对得上」决定；整包 verified 要求每个版本都 verified，其余 `community` | [done] | `build.ts`、`publish.test.ts` |
| REG-06 | 只收 public | 索引门禁与 `publish` 都拒绝非 public；`--allow-non-public` 可让 publish 放行，但随后索引门禁拒绝并回滚 | [done] | `build.ts`、`publish.ts` |
| REG-07 | unlisted 取包 | 索引里没有这个包、又显式给了 `--version` 时，跳过成员检查直接取归档；索引里有该包时版本仍须在 `versions` 里 | [done] | `packages/runtime/src/registry.ts` 的 `fetchPack`、`cli.ts` |
| REG-08 | 签名进报告与索引 | 报告里记每个签名的校验结果；索引 `signers` 只收 `ok: true` 的 key | [done] | `run.ts`、`build.ts`、`signature.test.ts` |
| REG-09 | vendored 入版本目录 | `resources/`、`skills/`、`glue/` 等顶层条目复制进版本目录，跳过 `.packhub`、`node_modules`、`.git`、`dist` 与旧归档 | [done] | `publish.ts`、`pack.ts` |
| REG-10 | 静态站产物 | 静态站与 Pages 部署已移除；registry 目录直接由 CLI / Hub 读。`registry/resources.json` 资源目录仍在，供 `discover` 用 | [na] | `registry.yml`、`packages/hub/src/server.ts`、`catalog.ts` |
| REG-11 | 多 registry | `--index` 接受本机配置里的 registry 名；`search --all` 合并 `PACKHUB_INDEX` 与配置里的 registry | [done] | `packages/runtime/src/config.ts`、`cli.ts` |
| REG-12 | 市场元数据 | 下载量与按天累计、7 日趋势、评分与评论（一账号一票）、审核状态、下架原因 | [parked] | `packages/market/src/store.ts`、`market/server.ts`、`market.test.ts` |
| REG-13 | 下架 | 版本与归档移入 `.market/quarantine/`，索引重建，下载 410；最后一个版本撤掉后清空空包目录 | [parked] | `market/server.ts`、`market.test.ts` |
| REG-14 | 市场存储与管理端 | SQLite（默认 rollback journal、`busy_timeout` 5s），旧 `.market/db.json` 首次打开迁移；`/admin` 内联页 + 审核队列 + 统计 | [parked] | `store.ts`、`store.test.ts`、`market/server.ts` |
| REG-15 | 发布开关 | `--out`（PR 模式，只出待提交文件）、`--dry-run`、`--offline`、`--allow-exec`、`--allow-non-public`；`--force` 覆盖前先备份，索引失败回滚 | [done] | `publish.ts` 的 `stageForPr`、`cli.ts`、`publish.test.ts` |
| REG-16 | 上传门禁 | 只能发布自己 scope；拒绝 `install.exec` 与 `command` / `scenario` / `mcp-ready` 三类会执行东西的检查；上传体有大小上限（见 `market/server.ts`） | [parked] | `market/server.ts`、`market.test.ts` |
| REG-17 | 市场的 unlisted | 上传校验接受 `unlisted`，但调 `publishPack` 时没传 `allowNonPublic`，实际返回 422 | [parked] | `market/server.ts`、`publish.ts` |
| REG-18 | 账号与 token | 账号即 scope（小写、39 字符内、唯一）；token 只显示一次、服务端只存 sha256；管理 token 落 `.market/admin.json`，`/api/admin/rotate` 轮换后旧值立即失效 | [parked] | `store.ts`、`market/server.ts`、`client.ts` |
| REG-19 | 审核流转 | `--require-review` 时上传进 `.market/staging/`；批准才 rename 进 registry，索引失败移回；拒绝只删这一版与它的归档 | [parked] | `market/server.ts`、`market.test.ts` |
| REG-20 | 归档重建与资源目录 | `registry:pack` 从版本目录重建 `.phub`；`resources.json` 供 `discover` 检索 | [done] | `scripts/registry/build-archives.mjs`、`catalog.ts` |
| REG-21 | 市场读接口 | `/api/search`（带下载量 / 趋势 / 均分）、`/api/packs`（清单、锁、报告、readme、changelog）、`/download`、`/api/me`、内联 `/admin` | [parked] | `market/server.ts`、`market.test.ts` |

## 7 HUB ｜只读发布端

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| HUB-01 | 只读接口 | `/api/registry`、`/api/registry/pack`、`/api/registry/resources`、`POST /api/plan`、`/api/health`；非 `/api` 路径一律 404 并列出可用接口 | [done] | `packages/hub/src/server.ts`、`server.test.ts` |
| HUB-02 | 包页（HTML） | 页面已移除；包数据改由 `/api/registry/pack` 提供 | [na] | `packages/hub/src/server.ts` |
| HUB-03 | 计划预览 | `POST /api/plan` 现算、不落盘；请求体超 1MB 返回 413 | [done] | `packages/hub/src/server.ts`、`server.test.ts` |
| HUB-04 | fail-closed 鉴权 | 非回环监听且没有 token / user-header 时拒绝启动；`PACKHUB_HUB_TOKEN` 也算配了 token | [done] | `hub/server.ts`、`production.test.ts` |
| HUB-05 | 限流 | 按 IP 限流，超了 429 并给 `retry-after`；`--rpm 0` 关闭；健康检查也计数（默认值见 `packhub hub --help`） | [done] | `hub/server.ts`、`production.test.ts` |
| HUB-06 | 审计 | 配了 `--audit` 时每次请求一行 JSON；401 也记；429 在审计挂钩前返回、不记 | [done] | `hub/server.ts`、`production.test.ts` |
| HUB-07 | 健康检查 | `/api/health` 免鉴权，返回 `{ok, packs, uptimeSeconds}` | [done] | `hub/server.ts`、`production.test.ts` |
| HUB-08 | 优雅退出 | SIGINT / SIGTERM 停监听；`hub` 的 bin 入口另有 5 秒兜底退出 | [done] | `cli.ts`、`packages/hub/src/bin.ts` |
| HUB-09 | 镜像 | `Dockerfile` 多阶段构建，末尾 `pnpm prune --prod`；镜像跑的是 `apps/local hub`，市场不在镜像里 | [done] | `Dockerfile` |
| HUB-10 | 写接口 | Hub 保持只读；写端在独立 `@packhub/market`（已冻结） | [na] | 并入 REG-16 |
| HUB-11 | 账号 / 组织 | 市场账号即 scope，没有组织模型（已冻结） | [na] | 并入 REG-18 |
| HUB-12 | 搜索 / 统计 | `/api/search`、`/api/admin/queue` 都在市场进程里，不在 Hub（已冻结） | [na] | 并入 REG-21 |
| HUB-13 | 条件请求 | JSON 带 ETag / Cache-Control，`If-None-Match` 命中回 304 | [done] | `hub/server.ts`、`server.test.ts` |
| HUB-14 | 请求体上限 | 读体前判长度，超上限直接 413，不把剩余字节读进内存（上限见 `hub/server.ts`） | [done] | `hub/server.ts`、`server.test.ts` |
| HUB-15 | 两种凭据形式 | `Authorization: Bearer <token>` 与 `x-packhub-token` 都认；也可用反向代理注入的身份头 | [done] | `hub/server.ts`、`production.test.ts` |
| HUB-16 | 资源目录响应 | `/api/registry/resources` 返回 `{meta, resources[]}`；非法 name / version 返回空 | [done] | `packages/hub/src/resources.ts`、`resources.test.ts` |

## 8 SYN ｜全局 harness 同步

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| SYN-01 | 项目内 codex target | 安装到 `.codex/skills`，指令写进项目 `AGENTS.md` 托管块；无专门测试 | [done] | `packages/kernel/src/targets.ts`、`plan.ts` |
| SYN-02 | 全局 skills | 三个 home 的 `skills/`：`~/.dsh`、`~/.claude`、`~/.codex` | [done] | `packages/runtime/src/harnesses.ts` |
| SYN-03 | 只收 skill 与 mcp | 其他类型整次拒绝；dsh 不接受 mcp，理由写进落点表 | [done] | `sync.ts`、`sync.test.ts` |
| SYN-04 | 本地来源 | 非 `./` 源拒绝；无直接测试 | [done] | `sync.ts` |
| SYN-05 | frontmatter 预检 | `SKILL.md` 的 YAML 坏、`name` / `description` 缺失或非字符串都拒绝；开头 BOM 兼容 | [done] | `skill-meta.ts`、`sync.test.ts` |
| SYN-06 | 每个 harness 一份 state | `<home>/.packhub/state.json`，快照在各自 `.packhub/snapshots/` | [done] | `sync.ts`、`install.ts` |
| SYN-07 | dry-run | 只出计划，不写任何文件 | [done] | `sync.ts`、`sync.test.ts` |
| SYN-08 | remove | 按 `name@` 前缀从每个目标 state 找所有版本，`removePack` 反删 | [done] | `sync.ts` 的 `removeSynced`、`sync.test.ts` |
| SYN-09 | doctor --global | 默认对 dsh / claude-code / codex 三个 home 各查一次，`--targets` 可指定；home 不存在标 `skipped` 不算失败 | [done] | `cli.ts`、`sync.ts`、`doctor.ts` |
| SYN-10 | 手放 skill 保护 | 非本包拥有的同名 skill 目录拒绝，`--overwrite` 才覆盖；同样的保护也罩住 codex 的 `[mcp_servers.*]` 与 claude user scope 里的同名 MCP | [done] | `sync.ts`、`sync.test.ts` |
| SYN-11 | 全目标预检 | 一个目标的 home 不存在或名字被占，另一个目标也不写 | [done] | `sync.ts`、`sync.test.ts` |
| SYN-12 | 全局指令与 MCP | `AGENTS.md` / `CLAUDE.md` 托管块；codex 写 `config.toml` 托管块；claude-code 调宿主 CLI 的 user scope | [done] | `sync.ts`、`host-mcp.ts`、`sync-claude.test.ts` |
| SYN-13 | codex `agents/openai.yaml` | 源里没有时按 frontmatter 生成（`display_name` / `short_description` / `default_prompt`）；项目级 codex 安装也生成 | [done] | `skill-meta.ts`、`install.ts`、`sync.test.ts` |
| SYN-14 | 目录加载探活 | `probe --skill <name>` 问一次宿主并断言名字出现；支持 dsh / claude-code / opencode / codex | [done] | `harness-probe.ts`、`harness-probe.test.ts` |
| SYN-15 | claude 全局 | `sync --to claude-code` 写 `~/.claude/skills` 与 `CLAUDE.md` 托管块；`CLAUDE.md` 块本身没有直接测试 | [done] | `sync.ts`、`sync-claude.test.ts` |
| SYN-16 | 面板入口 | 页面已移除，同步只用 `packhub sync` | [na] | — |
| SYN-17 | Claude 全局 MCP | `claude mcp add/remove --scope user`；名字记进 state 的 `hostMcp`，`doctor` 查、`removePack` 摘；找不到 `claude` 可用 `PACKHUB_CLAUDE_BIN` 指定 | [done] | `host-mcp.ts`、`sync.ts`、`doctor.ts`、`sync-claude.test.ts` |
| SYN-18 | `--to .` / `all` | 两者等价，按包声明的 targets 展开（只取已注册的同步目标）；`--remove` 时用全部已注册目标 | [done] | `harnesses.ts`、`cli.ts` |
| SYN-19 | JSON 输出 | `sync --json` 输出每个目标的 planHash、动作结果与 MCP 状态；`--remove` 输出各目标删了什么 | [done] | `cli.ts` |

## 9 CLI ｜命令与交互

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| CLI-01 | 单一入口 | `packhub --help` 列出全部命令；`pal` 是独立入口（`packages/launcher/src/bin.ts`），不在 packhub 下 | [done] | `apps/local/src/cli.ts`、`apps/local/src/bin.ts` |
| CLI-02 | 命令覆盖 | `packhub --help` 列出的顶层命令覆盖安装、校验、发布、同步与运维各环节；`cache` / `resource` / `slot` / `auth` / `trust` / `market` 是命令组。完整清单以 `--help` 为准 | [done] | `apps/local/src/cli.ts`、`packhub --help` |
| CLI-03 | JSON 输出 | 多数顶层命令支持 `--json`；`init` / `diff` / `hub` / `keygen` / `sign` / `completion` 与命令组里的多数叶子不支持，逐个看 `--help` | [done] | `cli.ts`、`cli.test.ts` |
| CLI-04 | 退出码 | 全仓只有 0 / 1 / 2；缺清单、未声明 target、未知参数、锁与清单不一致都是 2；动作失败与校验失败是 1 | [done] | `cli.ts`、`cli.test.ts` |
| CLI-05 | 结构化编辑 | `resource add` / `slot swap` 用 YAML AST 只改一个节点、保留注释；`init` 只写固定模板 | [done] | `packages/runtime/src/authoring.ts`、`authoring.test.ts` |
| CLI-06 | 搜索与发现 | `search --all` 跨 registry；`discover` 读资源目录、可选查 npm，`--add` 直接写进清单 | [done] | `cli.ts`、`catalog.ts`、`cli.test.ts` |
| CLI-07 | 凭据管理 | `auth set/list/remove/rotate`；列表只给掩码 | [done] | `cli.ts`、`credentials.test.ts` |
| CLI-08 | 回滚 / 卸载 / 升级 | 三个命令可用；升级走 `update`，回滚按 generation；CLI 级没有 update / rollback 的端到端用例 | [done] | `cli.ts`、`versioning.test.ts`、`state.test.ts` |
| CLI-09 | 全局同步 | `sync --to dsh,codex,claude-code` / `--to .` | [done] | `cli.ts`、`cli.test.ts` |
| CLI-10 | 错误可执行 | 缺清单指 `init`、缺索引指 `PACKHUB_INDEX`、签名问题指 `trust add`；Hub 端口被占时给「换 --port / --port 0」和查占用的命令，退出 2 | [done] | `cli.ts`、`cli.test.ts` |
| CLI-11 | shell 补全 | `completion` 支持 bash / zsh / pwsh，从活的子命令表生成，含每个命令的参数 | [done] | `cli.ts` |
| CLI-12 | 版本与分发 | `--version` 输出 `package.json` 里的版本；CLI 未发布到 npm（workspace 包私有），分发走 `build:local` + `pack:local` 出的 tgz；没有自更新 | [done] | `cli.ts`、`scripts/build-local.mjs`、`package.json` |
| CLI-13 | init 的名字闸 | `init --name` 只收 `owner/name`，pattern 取自 schema；裸名字退出 2，一个文件都不写；产出清单随即能 `plan` | [done] | `cli.ts` 的 `init`、`manifest.ts` 的 `PACK_NAME_PATTERN`、`cli.test.ts` |

## 10 TRU ｜安全与信任

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| TRU-01 | ed25519 签名 | `keygen` / `sign` / `verify-sig` 可用；签的载荷是 `{pack@version, planHash}` | [done] | `signature.ts`、`signature.test.ts` |
| TRU-02 | 私钥权限 | `keygen` 以 0600 写私钥；没有像凭据库那样的 chmod 兜底，Windows 上 mode 只是提示 | [done] | `cli.ts` |
| TRU-03 | 签名旁挂 | 默认写 `packhub.signatures.json`，不改清单；签名也能写回清单的 `signatures` 字段，读取端两边合并 | [done] | `signfile.ts`、`authoring.ts`、`consume.ts`、`signature.test.ts` |
| TRU-04 | 签名策略 | 优先级：`--require-signature` > `--allow-unsigned` > `trust.json` 的 `requireSignature` > 有信任列表就强制；要求而未满足时 `add` 退出 2 | [done] | `trust.ts`、`trust.test.ts`、`cli.test.ts` |
| TRU-05 | 信任列表 | `trust add/remove/list` 持久存储，安装默认使用；路径受 `PACKHUB_HOME` 影响 | [done] | `trust.ts`、`trust.test.ts` |
| TRU-06 | 凭据库 | `~/.packhub/credentials.json` 0600，环境变量优先，列表只给掩码（短值给 `***`） | [done] | `credentials.ts`、`credentials.test.ts` |
| TRU-07 | 凭证不落盘 | 计划里只存变量名；token 只在下载时解析；URL 脱敏后才进日志 | [done] | `packages/kernel/src/types.ts`、`install.ts`、`download.ts` |
| TRU-08 | 许可探测 | 本地找 LICENSE 猜 SPDX（8 种启发式，只读前 4000 字符），只对本地资源；`--online` 读 npm registry 的 license 字段 | [done] | `license.ts`、`license.test.ts` |
| TRU-09 | 许可策略 | 策略键 `allow` / `deny` / `allowCopyleft` / `allowNC` / `allowND` / `requireSpdx`；判序 deny → NC → ND → copyleft → allow，命中有原因 | [done] | `license.ts`、`license.test.ts` |
| TRU-10 | 可见性 | 四档，默认 private；默认值在 registry 侧以 `?? 'private'` 落定，非 public 拒收 | [done] | `packages/registry/src/build.ts`、`publish.ts`、`packhub.v0.schema.json` |
| TRU-11 | 操作审计 | `add` / `install` / `update` 追加 `~/.packhub/audit.jsonl`（0600）；`packhub audit --tail/--json` 查看；写失败只 warn 不阻断 | [done] | `audit.ts`、`cli.ts`、`trust.test.ts` |
| TRU-12 | `requireSignature` 的开关 | 只能手改 `trust.json`，没有 `trust require on/off` 命令 | [part] | `trust.ts`、`cli.ts` |

## 11 OPS ｜工程与运维

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| OPS-01 | 测试套件 | `pnpm check` = `tsc --noEmit` + 全量 vitest，本地全绿；另有只在 Windows 上跑的用例 | [done] | `package.json`、`pnpm check`、`vitest.config.ts` |
| OPS-02 | 类型检查 | `tsc --noEmit` 通过 | [done] | `package.json`、`pnpm typecheck` |
| OPS-03 | registry 门禁 | `registry:check` 通过（本地实测）；CI 里同一个脚本再跑一遍 | [done] | `scripts/registry/build-index.mjs`、CI |
| OPS-04 | 干净安装 CI | `registry:verify-all` 在 ubuntu job 跑，需网络；另有 `:offline` 变体 | [done] | `registry.yml`、`package.json` |
| OPS-05 | 单文件分发 | `build:local` 出 `dist/local/packhub.mjs` 与精简 package.json；`pack:local` 再 `npm pack` 出 tgz | [done] | `scripts/build-local.mjs`、`package.json` |
| OPS-06 | Hub 镜像 | 多阶段构建，末尾 `pnpm prune --prod`；镜像直接跑 TS（`--experimental-strip-types`）；非回环强制带 token | [done] | `Dockerfile` |
| OPS-07 | 文档治理 | 只留三份开发者文档（概念 / 契约 / 台账），入口 `docs/README.md`；每篇 front matter 标 `kind` / `verified` / `decay`，`pnpm docs:audit` 查分类、过期、断链、占位标记，CI 的 verify job 也跑；读完文档先体检的流程写在 `AGENTS.md` | [done] | `docs/README.md`、`AGENTS.md`、`scripts/docs-audit.mjs` |
| OPS-08 | 版本策略 | 产品 0.0.1 / 格式 v0，无兼容承诺；升 v1 的三条判据写在契约里 | [done] | `contract.md` |
| OPS-09 | 性能基准 | `bench` 量计划与安装耗时；CI 只卡**计划**耗时（规模与预算都是脚本参数，见 `scripts/bench.ts`），install 无预算，overlay 与大规模基准不在 CI | [done] | `scripts/bench.ts`、`registry.yml` |
| OPS-10 | Windows 矩阵 | `registry.yml` 的 `test-windows` 与 `pal.yml` 的 `windows` 都跑 `pnpm check`；后者带 paths 过滤，只在改 PAL 时触发 | [done] | `.github/workflows/*.yml` |
| OPS-11 | 依赖安全 | CI 跑 `pnpm audit --audit-level high`，只在 ubuntu job | [done] | `registry.yml` |
| OPS-12 | 示例包矩阵 | `verify:examples` 逐个真装 + verify；CI 在 ubuntu job 跑 | [done] | `scripts/verify-examples.mjs`、`registry.yml` |
| OPS-13 | 工具链固定 | `packageManager pnpm@11.22.0`、`engines.node >=22.13`，两个 workflow 都用 node 22 + pnpm 11 | [done] | `package.json`、workflows |
| OPS-14 | 供应链 | 无 dependabot / renovate；actions 用浮动 `@v4` 标签；没有锁文件完整性校验 | [part] | `.github/`、workflows |

## 12 X ｜跨切面

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| X-01 | Windows 路径 | `within()` 做 resolve + 越界拒绝；盘符 / 绝对路径 / `..` 在 state 与解包两处都有用例 | [done] | `install.ts` 的 `within`、`packages/kernel/test/state.test.ts`、`guards.test.ts` |
| X-02 | 编码与 BOM | 读 `SKILL.md` frontmatter 前剥 BOM；版本不可变比对时对清单与报告做 CRLF 归一 | [done] | `skill-meta.ts`、`sync.test.ts`、`build.ts` |
| X-03 | 代理 | 下载与索引走 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY`；进程级 dispatcher，运行中改环境变量不生效；无代理用例 | [done] | `download.ts` |
| X-04 | 并发与端口 | 同一目录同时只允许一次安装（O_EXCL + 死 pid 回收）；`hub --port 0` 打印系统分配的实际端口；端口被占时给换端口与查占用的命令，退出 2 | [done] | `install.ts`、`cli.ts`、`bin.ts`、`guards.test.ts` |
| X-05 | tar 安全 | 解包 filter 拒绝 `..`、绝对路径（含盘符）、符号链接与硬链接条目 | [done] | `pack.ts` 的 `isSafeArchiveEntry`、`guards.test.ts` |
| X-06 | 大仓库性能 | `bench:large` 提供大规模资源 + overlay 的计划与安装基准；不在 CI | [done] | `package.json`、`scripts/bench.ts` |
| X-07 | 平台兼容 | CI 同时跑 Linux 与 Windows 全量测试；开发在 Windows | [done] | workflows |
| X-08 | 格式版本 | manifest 与资源目录拒绝未知主版本；`state`、`lock`、`active.json`、版本记录、credentials、trust、签名文件读到别的主版本都直接拒绝（缺 `apiVersion` 的老文件仍按 v0 读）；`versions` 列目录时跳过读不出的版本目录 | [done] | `apiVersion.ts`、`loadState`、`loadLock`、`readActive`、`readVersionRecord`、`api-version.test.ts` |
| X-09 | 多语言 | 无 i18n 资源，文档与 CLI 文案全中文 | [na] | 全仓 grep |
| X-11 | 沙箱 | PackHub 不是 runtime，不提供执行沙箱 | [na] | — |

## 13 PAL ｜实例启动器

机制见 `packages/launcher/src/`。PAL 有独立入口 `pal`（`packages/launcher/src/bin.ts`），不在 `packhub` 下。

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据 |
|---|---|---|---|---|
| PAL-01 | 记录拆分 | `instance.json` 只存配置，`runtime.json` 只存运行态；缺或坏 `runtime.json` 即坏记录，没有旧格式合并 | [done] | `records.ts`、`records.test.ts` |
| PAL-02 | 建实例 | 先写 `installing` 再装；失败进 `instances/.failed/` 并写 `reason.json` | [done] | `create.ts`、`instance.test.ts` |
| PAL-03 | 失败清理 | 复用已有目录时只摘记录、不删目录；只有自己造的根才移走 | [done] | `create.ts`、`instance.test.ts` |
| PAL-04 | 删除 | 先停进程；默认直接删根（不逐文件卸包）；`--keep-data` 先卸包再归档；接管目录只摘记录 | [done] | `remove.ts`、`instance.test.ts` |
| PAL-05 | 启动 | 参数数组直传、日志走 fd；只有 Windows `.cmd` / `.bat` 垫片经 `cmd.exe /d /s /c`；等地址超时贴日志尾部 | [done] | `start.ts`、`harness.ts`、`start.test.ts` |
| PAL-06 | pid 与退出码 | `spawnPid` 是唯一 kill 对象的**根**（实际收整棵子树），`listenPid` 只作证据；`pid` 兼容为 `spawnPid ?? listenPid`；退出码 / 信号进 `lastExit` | [done] | `start.ts`、`process.ts`、`start.test.ts` |
| PAL-07 | 端口 | 自动挑空闲端口；冲突时报告占用者 pid 与进程名 | [done] | `port.ts`、`start.ts` |
| PAL-08 | 日志 | 每次启动归档 `start.<时间>.log`，超出保留数的自动清掉（见 `logs.ts`）；读取时脱敏；无单测 | [done] | `logs.ts`、`secrets.ts` |
| PAL-09 | 凭据 | 地址里的 token 存 `secrets.json`（0600），记录与 API 只见脱敏地址；打开走 302 | [done] | `secrets.ts`、`server.ts`、`server.test.ts` |
| PAL-10 | 来源校验 | 跨源写请求、缺客户端头的写请求一律 403；静态资源与 `--insecure` 是例外 | [done] | `server.ts`、`server.test.ts` |
| PAL-11 | 错误语义 | 未知实例 404、未知宿主 400、已运行 409，带 code / hint；`core-unavailable` 是 503 | [done] | `errors.ts`、`server.test.ts` |
| PAL-12 | 宿主发现 | `pal doctor` / `/api/harnesses` 报可用性、版本、能不能起；起不来说明原因 | [done] | `harness.ts`、`cli.test.ts` |
| PAL-13 | dsh MCP 接线 | Pack 的 mcp 资源写成 `--patch` 层，dsh 启动时真连上；没有 MCP 的 Pack 会删掉旧 patch | [done] | `mcp.ts`、`mcp.test.ts`、`layout.ts` |
| PAL-14 | 实例流转 | `adopt` 接管、`clone` 复制、`rename` 改名、`migrate` 挪根 | [done] | `migrate.ts`、`create.ts`、`instance.test.ts` |
| PAL-14b | 沿用已有 home | `create --from-home` 只补空缺地搬凭据与用户指令，不盖 Pack 写的文件；`sessions` 等不搬；来源记 `origin.seededFrom` | [done] | `create.ts`、`instance.test.ts` |
| PAL-15 | 模板 | `export` 出可复现模板，`import` 按引用重建；不可复现的明确拒绝 | [done] | `template.ts` |
| PAL-16 | 健康检查 | 检查覆盖记录、锁、进程、端口、listen-pid、home、基线、运行时、MCP；其中几类条件出现（home / 基线 / MCP） | [done] | `health.ts`、`health.test.ts` |
| PAL-17 | 基线 | 建实例写 `baseline.json`（每个文件 + sha256），体检报缺失 / 改动；`rebaseline` 接受本地改动 | [done] | `baseline.ts`、`health.ts`、`update.ts`、`health.test.ts` |
| PAL-17b | 更新 | 同 Pack 换版本：装新删旧、刷新基线与记录，报出被本地改过的文件；`--force` 才覆盖 | [done] | `update.ts`、`instance.test.ts` |
| PAL-18 | 删除时目录被占 | 重试后仍不行就改名进归档，不把半个实例留在列表（`removeTreeWithRetry` 是内部函数，靠这条路径间接覆盖） | [done] | `remove.ts`、`instance.test.ts` |
| PAL-19 | 界面 | 列表 / 详情增量更新、轮询在有对话框或操作时暂停、更新提示、体检面板 | [done] | `web/app.js` |
| PAL-20 | 取包缓存 | 按来源 + 版本（或 ref 短哈希）分目录，重取先清空；只有 registry + 明确版本才命中复用 | [done] | `materialize.ts`、`materialize.test.ts` |
| PAL-21 | 打包与 CI | `pal:bundle` 出单文件 `pal.cjs`；`pal:smoke` 端到端冒烟；CI Linux 跑 bundle + smoke，Windows 跑 smoke | [done] | `scripts/pal/*`、`pal.yml` |
| PAL-22 | 看护 | 常驻 core 独占启停与看护，CLI 与界面都是客户端；core 被杀由用户任务计划带回（需先 `pal core install` 注册，未注册不会自己回来） | [done] | `core.ts`、`coreClient.ts`、`coreTask.ts`、`watch.ts` |
| PAL-23 | 运行时记录 | 记录并展示 node 版本（基线、`doctor`、`health` 的 runtime 检查），不切换；0.x 单运行时是范围决定 | [done] | `baseline.ts`、`health.ts`、`cli.ts` |
| PAL-24 | 界面的实例流转 | 新建对话框有接管 / 导入，详情「更多」有克隆 / 改名 / 迁移 / 导出 | [done] | `web/app.js`、`server.ts` |
| PAL-25 | 数据目录 | 优先级：`PACKHUB_HOME` → `pal config --home` 指针 → 便携 `data/` → 系统默认；`pal config` 显示来源，`doctor` 报当前目录 | [done] | `paths.ts`、`cli.ts`、`home.test.ts` |
| PAL-26 | 跨盘迁移 | 同盘 rename；跨盘 `EXDEV` 复制到目标盘临时目录再落位；写记录失败或旧根删不掉都整次撤回 | [done] | `migrate.ts`、`instance.test.ts` |
| PAL-27 | 并发账本 | `pal ps` 只读列出 running / stale / 端口冲突 / 坏记录，不写盘不隔离 | [done] | `ps.ts`、`ps.test.ts` |
| PAL-28 | 发现 | `pal scan <dir> [--depth]` 只读识别 `instance.json` / `packhub.yaml` / `.packhub/state.json` 三类候选，扫描前后目录不变 | [done] | `scan.ts`、`scan.test.ts` |
| PAL-29 | 缓存管理 | `pal cache` 看 / 清取包缓存，支持 `--all` / `--ref` / `--older-than`；每份缓存带 `.pal-cache.json` | [done] | `cache.ts`、`cache.test.ts`、`materialize.ts` |
| PAL-30 | 备份与恢复 | `pal backup` 出目录快照（默认排除凭据 / 运行态 / 日志 / 锁），`--include-secrets` 才带；`restore` 生成新 id 与新根，不覆盖已有 | [done] | `backup.ts`、`backup.test.ts` |
| PAL-31 | 当前实例 | `pal use` / `pal current` 与 `instances/.active.json`（每宿主一个），对应 `GET /api/active` 与 `POST :id/active` | [done] | `active.ts`、`catalog.ts`、`server.ts` |
| PAL-32 | 实例根可选 | `create` / `clone` / `import` / `restore` 可给外部根；只收绝对路径，拒盘符根、文件系统根与实例根内 | [done] | `validators.ts`、`cli.ts`、`instance.test.ts` |
| PAL-33 | 重启策略 | `start --restart on-failure` 或 `never` 写进记录；`maxRestarts` 有默认值（见 `create.ts`），退避 1s / 2s / 4s… | [done] | `cli.ts`、`create.ts`、`start.ts`、`watch.ts` |
| PAL-34 | 事件流与日志读取 | `logs --events` / `--lines` / `--file`；`events.jsonl` 记 start / ready / exit / stale-pid / watch-restart 等 | [done] | `logs.ts`、`cli.ts` |
| PAL-35 | core 运行面 | `GET /api/core`、`core.json`（含 token）/ `core.lock` / `core.log`（超 2MB 轮转）；`core run/start/status/stop/install/uninstall` | [done] | `core.ts`、`server.ts`、`cli.ts` |
| PAL-36 | 侧车开关 | `pal serve --insecure`（`PAL_INSECURE=1`）与 `--exit-on-stdin-close`（桌面壳优雅收摊用） | [done] | `cli.ts`、`server.ts`、`apps/pal-electron/main.js` |
| PAL-37 | Electron 打包 | 桌面壳只支持仓库内运行；`app.isPackaged` 时直接报错，打包入口未接，CI 不构建 Electron | [part] | `apps/pal-electron/main.js`、`pal.yml` |
| PAL-38 | 坏记录处理 | `list` / `status` 把坏记录移进 `instances/.quarantine/` 并写原因，接管实例只收指针；`pal recover` 看三区 | [done] | `quarantine.ts`、`cli.ts`、`paths.ts` |
| PAL-39 | `pal watch` 命令 | 已删除：看护归 core 内部轮询，不再有可与 `serve` 并开的命令 | [na] | `watch.ts`、`watch.test.ts` |

## 不属于本项目（NA）

| 编号 | 范围 | 为什么不做 |
|---|---|---|
| NA-01 | 会话与历史 | 不做对话、会话、分叉 |
| NA-02 | 模型接入 | 不接 provider、不做流式 |
| NA-03 | 上下文组装 | 不组装模型上下文；只写 AGENTS.md / CLAUDE.md 托管块 |
| NA-04 | 编排 | 不做子代理、工作流、定时 |
| NA-05 | 编辑与代码智能 | 不做 diff / LSP / formatter |
| NA-06 | Agent 运行时与执行沙箱 | 只安装与登记，不代理调用（`exec` 是唯一例外，且要显式批准） |
| NA-07 | 多语言 | 中文文档与文案，无 i18n |
| NA-08 | 界面（2026-11-07 移除） | `packages/web` 与本地面板的 `/api/*` 已删；读端只剩 Hub 的只读 API 与 PAL 自己的实例面板 |

## 未决与已知缺口

行内已有 `[part]` 标记的这里不重复。下面是不落在单条功能上的取舍与建议：

| 事项 | 现状 | 未决 / 建议 |
|---|---|---|
| 市场整体 | 代码在，但**暂时不实现也不维护**（REG-12..21 标 `[parked]`） | 重开时要先定：是继续做成服务，还是把「上传 / 审核 / 下架 / 评分 / 统计」抽成协议再落实现。抽协议能换实现，但只有一个实现时会把形状钉死 |
| 签名与锁的顺序 | `sign` 用未按锁解析的计划 | 改 `sign` 先按锁算计划，或在文档里要求「先 lock 再 sign」 |
| 发布校验的位置 | 在进程内 `runPack`，已拒可执行检查 | 放进沙箱，或只收 CI 报告 |
| 全局 MCP | Claude Code 走宿主 CLI，codex 写 TOML 托管块，dsh 无稳定契约 | 其余宿主等有稳定契约再接 |
| 性能口径 | 只有耗时，没有内存 / 吞吐 | 需要时再加指标，并把 install / overlay 基准纳入 CI |
| 测试覆盖 | `config-key`、mcp 的 SSE 分支、`sync` 的本地来源拒绝、install 的 dry-run、`logs` / `secrets` 无直接用例 | 补用例，或把这几条的 `[done]` 降为 `[part]` |

## 与 Agent Harness 清单的对照

参考清单的域划分，PackHub 只承担其中一部分：

| 参考域 | PackHub 对应 | 说明 |
|---|---|---|
| 入口与运行时 | CLI / HUB / SYN | PackHub 自己是 CLI + 只读服务，不是 agent 入口 |
| 会话与历史 | `[na]` | 不做对话、会话、分叉 |
| 上下文工程 | `[na]` | 不组装模型上下文；只写 AGENTS.md 托管块 |
| 模型接入 | `[na]` | 不接 provider、不做流式 |
| 工具系统 | PKG / INS | 只安装与登记工具，不代理调用 |
| 执行环境 | INS / X | `exec` 是可选动作，默认待批准；没有 agent shell |
| 权限与审批 | TRU | 安装审批、凭据、可见性；没有运行时审批 |
| 编辑与代码智能 | `[na]` | 不做 diff / LSP / formatter |
| 编排 | `[na]` | 不做子代理、工作流、计划、定时 |
| 扩展体系 | PKG / SYN | Pack、资源类型、技能同步 |
| 交互界面 | `[na]` | 前端已移除（2026-11-07） |
| 持久化与配置 | INS / TRU / OPS | state、快照、凭据、registry |
| 可观测性 | HUB / OPS | 审计、日志、诊断 |
| 评估与测试 | VER / OPS | verify 报告、runner、测试套件 |
| 交付与运维 | REG / OPS | 发布、归档、CI、镜像 |
| 跨切面 | X | 路径、编码、代理、并发 |
