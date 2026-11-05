# PackHub 功能全量清单

> 版本：2026-11-05 ／ 口径：本仓库当前代码、CLI 实测、测试套件（56 个文件 / 217 项）与 registry 现状。
> 用途：实现 checklist、选型对照、漏项审计。**不是**产品介绍。

## 怎么读

- 每条 = 编号 ／ 功能点 ／ 能观察到的事实 ／ 现状 ／ 证据或缺口。
- 编号前缀是域，不复用；补项往后追加，不改号。
- 验收口径只写“能观察到的事实”，不写“支持 XX”。
- 状态只四档：`[done]` 代码有且被测试/实测覆盖；`[part]` 有但有明确缺口；`[todo]` 没有；`[na]` 不属于 PackHub。
- 需要展开的域拆到 `details/`，主表只留结论。

## 域索引

| 域 | 名称 | 一句话 |
|---|---|---|
| PKG | 清单与格式 | 一个 Pack 能声明什么、不能声明什么 |
| REF | 引用与锁 | 引用的定位、钉死、校验、解析 |
| PLN | 计划 | 清单如何变成可比较的动作清单 |
| INS | 安装与状态 | 执行、快照、state、回滚、卸载、升级 |
| VER | 校验与门禁 | 装完是否可用，发布前是否可信 |
| REG | registry | 版本目录、索引、不可变、trust |
| HUB | 只读发布端 | 页面与 API，不含写与执行 |
| SYN | 全局 harness 同步 | 一份 Pack 写进 DSH / Codex 的 skills |
| CLI | 命令与交互 | 人怎么用、脚本怎么调 |
| UI | 本地面板 | 看的、点的、反馈的 |
| TRU | 安全与信任 | 签名、凭据、许可、可见性 |
| OPS | 工程与运维 | 测试、构建、CI、镜像、文档 |
| X | 跨切面 | Windows、编码、代理、并发、性能 |
| NA | 不属于本项目的部分 | 防止把“没有”当“漏做” |

## 与 Agent Harness 清单的对照

参考清单的 16 个域，PackHub 只承担其中一部分：

| 参考域 | PackHub 对应 | 说明 |
|---|---|---|
| 入口与运行时 | CLI / HUB / SYN | PackHub 自己是 CLI + 只读服务，不是 agent 入口 |
| 会话与历史 | `[na]` | 不做对话、会话、分叉 |
| 上下文工程 | `[na]` | 不组装模型上下文；只写 AGENTS.md 托管块 |
| 模型接入 | `[na]` | 不接 provider、不做流式 |
| 工具系统 | PKG / INS | 只安装与登记工具，不代理调用 |
| 执行环境 | INS / X | 执行 `exec` 是可选动作，没有 agent shell |
| 权限与审批 | TRU | 安装审批、凭据、可见性；没有运行时审批 |
| 编辑与代码智能 | `[na]` | 不做 diff/LSP/formatter |
| 编排 | `[na]` | 不做子代理、工作流、计划、定时 |
| 扩展体系 | PKG / SYN / TOL | Pack、资源类型、技能同步 |
| 交互界面 | UI | 面板、目录、创作台 |
| 持久化与配置 | INS / TRU / OPS | state、快照、凭据、registry |
| 可观测性 | HUB / OPS | 审计、日志、诊断 |
| 评估与测试 | VER / OPS | verify 报告、runner、测试套件 |
| 交付与运维 | REG / OPS | 发布、归档、CI、镜像 |
| 跨切面 | X | 路径、编码、代理、并发 |

---

## 1 PKG ｜清单与格式

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| PKG-01 | manifest Schema 严格校验 | 拼错字段/缺必填会报错，未知字段被拒 | [done] | `manifest.ts`、`schema/packhub.v0.schema.json` |
| PKG-02 | 六类资源 | `mcp/skill/prompt/knowledge/config/tool` 都有示例与安装语义 | [done] | `types.ts`、`authoring.md` |
| PKG-03 | target 声明 | `dir/dsh/claude-code/codex` 可声明；未声明的 target 安装被拒 | [done] | `plan.ts`、CLI target 检查 |
| PKG-04 | 槽位与绑定 | 未绑定候选进 `excluded`；契约不满足报错；换绑只改一行 | [done] | `graph.ts`、`slot.test` |
| PKG-05 | 路径表 | `${paths.x}` 可插值；绝对路径/`..` 被拒 | [done] | `graph.ts`、`plan.ts` |
| PKG-06 | composition | env 注入、needs 检查、order 与 dependsOn 一致性 | [done] | `graph.ts`、`plan.ts` |
| PKG-07 | overrides | 资源级覆盖 pin/参数，不改上游清单 | [done] | `graph.ts` |
| PKG-08 | overlays | 文件级覆盖排在资源之后；两覆盖层冲突报错，盖生成物只警告 | [done] | `plan.ts`、`overlay.test` |
| PKG-09 | 可见性 | `public/unlisted/internal/private`，默认 private | [done] | `ref`/schema、`build.ts` |
| PKG-10 | 签名声明 | manifest 可带 `signatures`，也支持独立文件 | [done] | `signature.ts`、`signfile.ts` |
| PKG-11 | `extends` | 本地与 `packhub://` 父 Pack 都可继承；远程父包缓存、路径稳定、环检测；publish 自动扁平化 | [done] | `loadPackResolved`、`flattenPack`、`extends*.test` |
| PKG-12 | server profile | `server` target + 资源级 `targets` 裁剪，未命中进 `excluded`（target-mismatch） | [done] | `plan.ts`、`server-profile.test` |
| PKG-13 | 本地覆盖 | `.packhub/local.yaml` 覆盖 pin/绑定/paths/vars/env，不进锁 | [done] | `mergeLocalOverrides`、`local-overrides.test` |
| PKG-14 | PACK.md / CHANGELOG | 发布复制进版本目录；Hub / 市场 API 返回原文，包页渲染 | [done] | `publish.ts`、`hub/server.ts`、`PacksPage` |

## 2 REF ｜引用与锁

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| REF-01 | source 类型 | `npm:` / `pypi:` / `github:` / `https:` / `./` 可解析 | [done] | `ref.ts` |
| REF-02 | 拒绝漂移 pin | `@main`、`@latest`、范围、无 integrity 的 https 在 plan 阶段被拒 | [done] | `ref.ts`、`plan` |
| REF-03 | lock 解析 | 分支→commit、范围→具体版本、https→sha256、pypi→sdist | [done] | `resolve.ts`、`lock` |
| REF-04 | 字节完整性 | npm 带 `dist.integrity`；https 下载校验；github 归档按 commit 下载算 sha256 | [done] | `resolve.ts`、`resolve.test` |
| REF-05 | 私有来源鉴权 | `auth.env` 只存变量名；环境变量/凭据库取 token；报错不泄漏 | [done] | `install.ts`、`credentials.ts` |
| REF-06 | 计划快照 | lock 带 `plan` 快照，`diff` 靠它比较 | [done] | `lock.ts`、`diff` |
| REF-07 | 离线锁 | `lock --offline` 只处理本地/已 pin | [done] | `resolve.ts`、CLI |
| REF-08 | pypi 只收 sdist | 只装源码包，纯 wheel 明确拒绝（不落二进制） | [na] | 设计边界：wheel 是构建产物，PackHub 不建 Python venv |
| REF-09 | `packhub://` 来源 | `add` 等价 registry 安装；资源级 `packhub://scope/name@ver#path` 取归档内文件/目录，发布时自动扁平化 | [done] | `loadPackResolved`、`flattenPack`、`extends-remote.test` |
| REF-10 | 缓存与 GC | `cache ls` 标引用；`cache clean` 只删无引用项，支持 dry-run | [done] | `cache.ts`、`cache.test` |
| REF-11 | 代理 | 下载与索引请求走 `HTTPS_PROXY` | [done] | `download.ts`、`registry.ts` |
| REF-12 | 锁过期检测 | `add` 比对 `lock.planHash`；`diff` 比当前计划 | [done] | `consume.ts`、`diff` |

## 3 PLN ｜计划

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| PLN-01 | 八个动作原语 | fetch/unpack/write/link.skill/register.mcp/merge.config/exec/instruction 可生成 | [done] | `plan.ts` |
| PLN-02 | 稳定动作 id | `<op>#n` 同类按序编号；同清单两次生成一致 | [done] | `plan.ts` |
| PLN-03 | 依赖与顺序 | dependsOn 拓扑；`composition.order` 与 dependsOn 矛盾报错 | [done] | `graph.ts` |
| PLN-04 | 能力检查 | `needs` 无 provider → `unmet-need`；`composition.needs` 检查 bind | [done] | `graph.ts` |
| PLN-05 | 槽位排除 | 未绑定候选进 `excluded`，不进动作 | [done] | `graph.ts`、`plan.ts` |
| PLN-06 | 冲突检测 | 输出冲突、覆盖层冲突、配置键冲突；shadows 只警告 | [done] | `plan.ts` |
| PLN-07 | planHash | 规范化 JSON 的 sha256；跨机器可复现 | [done] | `util.ts`、实测 |
| PLN-08 | 一 target 一计划 | `lock` 只存锁定 target 的计划快照 | [done] | `lock.ts`、`add` |
| PLN-09 | target 变量 | `${target.*}` 随 target 变化 | [done] | `plan.ts` |
| PLN-10 | 未知 target | 报 `unknown-target` | [done] | `planFor` |
| PLN-11 | 预览 API | `/api/plan` 返回计划与 issues，不落盘 | [done] | `apps/local/server.ts` |
| PLN-12 | dry-run | `install --dry-run` 不写盘；`add --dry-run` 取包在临时目录 | [done] | CLI |

## 4 INS ｜安装与状态

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| INS-01 | 执行八类动作 | 每类动作有成功/失败路径 | [done] | `install.ts` |
| INS-02 | 项目级所有权 | 别包占用的普通文件拒绝；`--overwrite` 放行 | [done] | `findOwnershipConflicts` |
| INS-03 | 共享文件 | 配置与根目录 `.md` 只写自己的部分 | [done] | `install.ts` |
| INS-04 | 快照与 generation | 安装前快照被改写文件与 state | [done] | `prepareGeneration` |
| INS-05 | 失败回滚 | 失败文件回原、新建删除、不写 state | [done] | `install.ts` |
| INS-06 | state 记录 | planHash、动作结果、owned 文件、计划快照 | [done] | `state.json` |
| INS-07 | merge 可逆 | 配置按叶子键 undo；空壳清理 | [done] | `inverse.test` |
| INS-08 | update 清理 | 先装新版，再按旧计划清文件/配置/MCP/块 | [done] | `update.ts`、`pruneRemoved` |
| INS-09 | uninstall | 按 written 反删；registry 副本一起清 | [done] | `removePack` |
| INS-10 | rollback | 一次退一个 generation；保留最近 5 个 | [done] | `rollbackPack` |
| INS-11 | 并发锁 | `.packhub/installing.lock` O_EXCL | [done] | `acquireLock` |
| INS-12 | staged 版本 | 每次安装镜像进 `.packhub/versions/`；`versions` / `activate` 整版切换；active.json 指针 | [done] | `install.ts`、`versions.test` |
| INS-13 | 僵尸锁 | 锁里的 pid 已死时自动收回；活着的 pid 仍拒绝 | [done] | `acquireLock`、`guards.test` |
| INS-14 | 跨包目录内部冲突 | 所有权按前缀判：包拥有目录时，别人往里写也算冲突 | [done] | `findOwnershipConflicts`、`guards.test` |

## 5 VER ｜校验与门禁

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| VER-01 | 文件/配置检查 | `file-exists`、`config-key` 可 pass/fail | [done] | `verify.ts` |
| VER-02 | 命令检查 | `command` 执行并按退出码判 | [done] | `verify.ts` |
| VER-03 | stdio MCP 握手 | `mcp-ready` 发 initialize 并判响应 | [done] | `verify.ts`、`verify-deep.test` |
| VER-04 | 内容哈希 | `knowledge-integrity` 在 `.packhub` 产物里按 sha256 找 | [done] | `verify.ts` |
| VER-05 | http MCP 探活 | POST initialize，JSON / SSE 响应都认；失败给状态码 | [done] | `verify.ts`、`mcp-http.test` |
| VER-06 | 报告判定 | 每步 done/noop 且每项 pass 才 `ok` | [done] | `runner/run.ts` |
| VER-07 | 报告绑哈希 | `verify.planHash` 与锁/计划对齐 | [done] | `runPack` |
| VER-08 | 干净目录 runner | 临时复制、清 `.packhub`、install+verify | [done] | `runPack` |
| VER-09 | 发布门禁 | 报告不 ok 就拒绝 publish | [done] | `publish.ts` |
| VER-10 | scenario 探针 | `scenario` 检查可跑命令或问 harness，断言输出/文件 | [done] | `verify.ts`、`scenario.test` |
| VER-11 | harness 探针 | `probe` 调 headless 宿主复述托管块 | [done] | `harness-probe.ts` |
| VER-12 | 漂移检测 | `doctor` 查文件/托管块；`doctor --global` 查 harness | [done] | `doctor.ts`、`sync.ts` |
| VER-13 | 项目根复核 | `verify <project>` 读 state 计划快照 | [done] | `installed.ts` |

## 6 REG ｜registry

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| REG-01 | 发布版本目录 | 清单/锁/签名/报告写入 `packs/<scope>/<name>/<ver>/` | [done] | `publish.ts` |
| REG-02 | `.phub` 归档 | tar.gz 带清单+锁+（vendored）资源 | [done] | `pack.ts` |
| REG-03 | 索引生成 | `index.json` 生成，不手写 | [done] | `build.ts` |
| REG-04 | 版本不可变 | 版本目录里的 `packhub.yaml` 与 HEAD 比较，改了拒绝 | [done] | `git show HEAD:./` |
| REG-05 | trust 两档 | `verified` 需报告 ok + 哈希一致 | [done] | `build.ts` |
| REG-06 | 只收 public | 非 public 被 `registry:check` 拒 | [done] | `build.ts` |
| REG-07 | unlisted 取包 | `add name --version` 绕过索引 | [done] | `fetchPack` |
| REG-08 | 签名结果 | 报告与索引带签名校验 | [done] | `runPack`、`build.ts` |
| REG-09 | vendored 目录入版本目录 | `resources/skills/...` 一起复制 | [done] | `publish.ts` |
| REG-10 | Pages 带归档 | CI 复制 `packs/**/*.phub` | [done] | `registry.yml` |
| REG-11 | 多 registry 配置 | `--index` 接受配置里的 registry 名；`search --all` 合并所有索引 | [done] | `resolveRegistry`、`registryIndexes` |
| REG-12 | 市场元数据 | 下载量、趋势、评分/评论、审核队列（staging→批准/拒绝）、下架原因 | [done] | `@packhub/market`、`market.test`；存储仍是单机 JSON |
| REG-13 | 下架/可见性变更 | `market yank` 移入 quarantine、索引移除、下载 410 | [done] | `market/server.ts`、`market.test` |

## 7 HUB ｜只读发布端

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| HUB-01 | 只读接口 | `/api/registry`、`/pack`、`/resources` 只读 | [done] | `hub/server.ts` |
| HUB-02 | 包页数据 | 读真实 manifest/lock/verify | [done] | `PacksPage` |
| HUB-03 | 计划预览 | `POST /api/plan` 计算，不落盘 | [done] | `hub/server.ts` |
| HUB-04 | fail-closed 鉴权 | 非 loopback 无 token/user-header 拒绝启动 | [done] | `startHub` |
| HUB-05 | 限流 | 每 IP 每分钟上限，429 | [done] | `RateLimiter` |
| HUB-06 | 审计 | 每次请求一行 JSON | [done] | `audit` |
| HUB-07 | 健康检查 | `/api/health` | [done] | `server.ts` |
| HUB-08 | 优雅退出 | SIGINT/SIGTERM 停监听 | [done] | `hub` CLI |
| HUB-09 | 镜像 | Dockerfile 只读端 | [done] | `Dockerfile` |
| HUB-10 | 写接口 | Hub 保持只读；写端在独立 `@packhub/market`（上传/发布） | [done] | `market/server.ts` |
| HUB-11 | 账号/组织 | 市场账号即 scope；token 只显示一次，本机 0600 保存 | [done] | `market/store.ts`、`client.ts` |
| HUB-12 | 搜索/统计 | `/api/search` 带下载量、7 日趋势、均分/评论；`/api/admin/queue` 审核队列 | [done] | `market/server.ts` |

## 8 SYN ｜全局 harness 同步

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| SYN-01 | codex target | 项目内 `.codex/skills` + `AGENTS.md` 块 | [done] | `plan.ts` |
| SYN-02 | 全局 skills | `~/.dsh/skills`、`~/.codex/skills` | [done] | `sync.ts` |
| SYN-03 | 只收 skill | 非 skill 资源明确拒绝 | [done] | `sync.ts` |
| SYN-04 | 本地来源 | 非 `./` 源拒绝 | [done] | `sync.ts` |
| SYN-05 | frontmatter 预检 | name/description 缺失或 YAML 坏拒绝；BOM 兼容 | [done] | `readSkillFrontmatter` |
| SYN-06 | 每个 harness 一份 state | `~/.dsh/.packhub/state.json` 等 | [done] | `sync.ts` |
| SYN-07 | dry-run | 只出计划，不写 | [done] | `sync.ts` |
| SYN-08 | remove | 从目标 state 反删 | [done] | `removeSynced` |
| SYN-09 | doctor --global | 两目标分别检查 | [done] | `doctorGlobal` |
| SYN-10 | 手放 skill 保护 | 非本包拥有的目录拒绝，`--overwrite` 才覆盖 | [done] | `sync.ts` |
| SYN-11 | 全目标预检 | 一个目标失败不写另一个 | [done] | `sync.ts` |
| SYN-12 | 全局 AGENTS/MCP | AGENTS/CLAUDE 托管块 + codex TOML MCP；DSH/Claude 的全局 MCP 无公开稳定文件契约 | [na] | 宿主格式不由 PackHub 定义；项目级 MCP 仍可用 |
| SYN-13 | Codex agents/openai.yaml | 源里没有时按 SKILL.md frontmatter 生成（display_name / short_description / default_prompt） | [done] | `skill-meta.ts`、`sync.test` |
| SYN-14 | 目录加载探活 | `probe --skill <name>` 问一次 harness，断言 skill 名出现在可用列表 | [done] | `probeSkill`、`harness-probe.test` |
| SYN-15 | claude 全局 | `sync --to claude-code` 写 `~/.claude/skills` + CLAUDE.md 托管块 | [done] | `sync.ts`、`cli` |
| SYN-16 | 面板入口 | 本地面板 Harness 同步卡片 | [done] | `App.tsx` |

## 9 CLI ｜命令与交互

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| CLI-01 | 单一入口 | `packhub --help` 列子命令 | [done] | `cli.ts` |
| CLI-02 | 子命令覆盖 | plan/install/verify/lock/publish/sync 等可用 | [done] | `main` |
| CLI-03 | JSON 输出 | plan/run/install/verify/rollback/uninstall/lock/add/search/discover/doctor/versions/audit/market 都有 `--json` | [done] | `cli.test` 覆盖 add/verify |
| CLI-04 | 退出码 | 0/1/2 三档；缺清单、坏 target、锁失败、校验失败都有测试 | [done] | `cli.test` 退出码用例 |
| CLI-05 | 结构化编辑 | `init`、`resource add`、`slot swap` 保留注释 | [done] | `authoring.ts` |
| CLI-06 | 搜索 | `discover` 搜资源目录/npm 并可直接写进清单；`search --all` 跨 registry | [done] | `discover`、`catalog.ts` |
| CLI-07 | 凭据管理 | `auth set/list/remove/rotate` | [done] | `credentials.ts` |
| CLI-08 | 回滚/卸载/升级 | 三个命令可执行 | [done] | `rollback`/`uninstall`/`update` |
| CLI-09 | 全局同步 | `sync --to dsh,codex` | [done] | `sync` |
| CLI-10 | 错误可执行 | 缺清单指 `init`、缺索引指 `PACKHUB_INDEX`、端口占用指 `--port 0`、签名指 `trust add` | [done] | `manifest.ts`、`cli serve`、`cli.test` |
| CLI-11 | shell 补全 | `packhub completion bash|zsh|pwsh` 输出补全脚本 | [done] | `cli.ts` |
| CLI-12 | 版本/自更新 | `--version` 有；CLI 未发布到 npm，自更新无渠道 | [na] | 分发走 `build:local` 单文件包 |

## 10 UI ｜本地面板

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| UI-01 | 主面板 | 包列表、组成、计划、校验、本机状态 | [done] | `App.tsx` |
| UI-02 | 包目录 | `/packs` 列表与详情 | [done] | `PacksPage` |
| UI-03 | 创作台 | `/console` 草稿、预览、下载 | [done] | `ConsolePage` |
| UI-04 | 形态 demo | `/forms` 四个入口 demo | [done] | `FormsDemo` |
| UI-05 | 同步卡片 | 勾选 dsh/codex、预演/同步/移除 | [done] | `App.tsx` |
| UI-06 | 安装/校验按钮 | 面板内执行并回填结果 | [done] | `api.install/verify` |
| UI-07 | 窄屏 | Chromium 390px 实测无横向溢出；1080px 断点单列 | [done] | `scripts/ui-audit.ts` |
| UI-08 | 可访问性 | axe 在 390/1280 跑首页/目录/创作台，无 serious/critical；焦点可见、跳过导航、reduced-motion | [done] | `ui:audit`、`scripts/ui-audit.ts` |

| UI-10 | 路由 | history 路由：站内链接 pushState、popstate 后退；`routeFor` 有单测 | [done] | `router.ts`、`router.test` |

## 11 TRU ｜安全与信任

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| TRU-01 | ed25519 签名 | keygen/sign/verify-sig 可用 | [done] | `signature.ts` |
| TRU-02 | 私钥权限 | keygen 以 0600 写私钥 | [done] | CLI `keygen` |
| TRU-03 | 签名旁挂 | 不改 manifest，写独立文件 | [done] | `signfile.ts` |
| TRU-04 | 默认强制签名 | 有信任列表就强制；`--allow-unsigned` 显式降级；trust.json 可设 requireSignature | [done] | `trust.ts`、`signaturePolicy` |
| TRU-05 | 信任列表 | `packhub trust add/remove/list` 持久存储；安装默认使用 | [done] | `trust.ts`、`trust.test` |
| TRU-06 | 凭据库 | `~/.packhub/credentials.json` 0600，环境变量优先 | [done] | `credentials.ts` |
| TRU-07 | 凭证不落盘 | 锁/state/日志不含 token；URL 脱敏 | [done] | `install.ts` |
| TRU-08 | 许可探测 | 本地找 LICENSE 猜 SPDX；`--online` 读 npm registry 的 license 字段 | [done] | `license.ts`、`license.test` |
| TRU-09 | 许可兼容 | 策略 JSON：allow/deny/copyleft/NC/ND/requireSpdx；命中有明确原因 | [done] | `evaluateLicense`、`license.test` |
| TRU-10 | 可见性 | 四档，默认 private | [done] | schema/build |
| TRU-11 | 操作审计 | add / install / update 写 `~/.packhub/audit.jsonl`；`packhub audit` 查看 | [done] | `audit.ts`、`cli audit` |

## 12 OPS ｜工程与运维

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| OPS-01 | 测试套件 | 56 个文件 / 217 项通过 | [done] | `pnpm check` |
| OPS-02 | 类型检查 | `tsc --noEmit` 通过 | [done] | `pnpm typecheck` |
| OPS-03 | registry 门禁 | `registry:check` 通过 | [done] | CI |
| OPS-04 | 干净安装 CI | `registry:verify-all`（需网络） | [done] | workflow |
| OPS-05 | 单文件分发 | `build:local` 出 bundle + npm pack | [done] | `scripts/build-local.mjs` |
| OPS-06 | Hub 镜像 | 多阶段构建，构建末尾 `pnpm prune --prod` 去掉开发依赖 | [done] | `Dockerfile` |
| OPS-07 | 文档 | README + authoring + contract + ui | [done] | — |
| OPS-08 | 版本策略 | 0.0.1 / v0 无兼容承诺 | [done] | contract |
| OPS-09 | 性能基准 | `bench` 量 200 资源、200 overlay、1000 资源安装（约 3.3s）；CI 卡预算 | [done] | `scripts/bench.ts` |
| OPS-10 | Windows 矩阵 | CI 加 `test-windows` 全量跑一遍 | [done] | `.github/workflows/registry.yml` |
| OPS-11 | 依赖安全 | CI 跑 `pnpm audit --audit-level high` | [done] | `.github/workflows/registry.yml` |

## 13 X ｜跨切面

| 编号 | 功能点 | 能观察到的事实 | 现状 | 证据/缺口 |
|---|---|---|---|---|
| X-01 | Windows 路径 | `join/resolve` + `..` 拒绝；同步盘符路径实测 | [done] | `within`、sync 测试 |
| X-02 | 编码/BOM | YAML/UTF-8；SKILL frontmatter 兼容 BOM | [done] | `sync.ts` |
| X-03 | 代理 | 下载/索引走 `HTTPS_PROXY` | [done] | `download.ts` |
| X-04 | 并发 | 安装锁；`serve --port 0` 由系统分配并打印实际端口，占用时报下一步 | [done] | `cli serve` |
| X-05 | tar 安全 | `..` 与符号/硬链接条目都拒绝落地；单测覆盖过滤规则 | [done] | `isSafeArchiveEntry`、`guards.test` |
| X-06 | 大仓库性能 | 1000 资源 + 1000 overlay 计划与安装有基准 | [done] | `bench:large` |
| X-07 | 平台兼容 | 开发在 Windows；CI 同时跑 Linux 与 Windows | [done] | `.github/workflows/registry.yml` |
| X-08 | 格式版本 | v0 未知主版本拒绝 | [done] | contract |
| X-09 | i18n | 中文文档/提示，无多语言 | [na] | — |
| X-10 | 沙箱 | 不运行 agent，exec 显式批准 | [na] | 不是 runtime |

## 缺口汇总

清单里已经没有 `[todo]` / `[part]`；剩下 11 条 `[na]` 分两类：

1. **设计边界**：pypi 只装源码（wheel 是构建产物，不建 Python venv）；全局 MCP 只做 codex（DSH 是第三方 profile patch，Claude 的 user config 不在 harness home 内，都没有 PackHub 能依赖的稳定文件契约）；CLI 自更新没有渠道（未发布到 npm，分发走 `build:local`）。
2. **不属于 PackHub**：会话、上下文组装、模型接入、编排、编辑与代码智能等（见 NA 域）。

另有几条非阻断的运维建议，不算功能缺口：

- 市场存储是单机 JSON；生产部署应把发布校验放进沙箱，或只收 CI 报告。
- UI 审计覆盖 390/1280 的横向溢出与 axe 结构性违规，没有视觉基线 diff。
- 大包基准只有耗时，没有内存/吞吐指标。

## 下一步

1. **市场生产化**：SQLite/对象存储 + 管理前端接现有审核 API；包内容继续按版本不可变。
2. **全局 MCP adapter**：等 DSH/Claude 给出稳定配置契约后再接，避免把第三方 patch 写进产品。
3. **视觉回归**：在 `ui:audit` 上加截图基线；键盘全流程再补一轮。
4. **记忆 state 块**：给持久状态目录一个一等公民的 `state` 块。
## 细节文档

| 文档 | 覆盖 |
|---|---|
| [details/pack-format.md](details/pack-format.md) | manifest、资源类型、槽位、覆盖、可见性、`extends` |
| [details/ref-lock.md](details/ref-lock.md) | source 类型、pin、integrity、解析、私有来源、缓存 |
| [details/plan.md](details/plan.md) | 九种动作、顺序、冲突、planHash、target 变量 |
| [details/install-state.md](details/install-state.md) | 安装、快照、state、回滚、升级、所有权 |
| [details/verify.md](details/verify.md) | 检查类型、严格判定、runner、探针 |
| [details/registry-trust.md](details/registry-trust.md) | 发布、索引、不可变、trust、签名、可见性 |
| [details/hub.md](details/hub.md) | 只读 API、页面、鉴权、限流、审计、镜像 |
| [details/sync.md](details/sync.md) | 全局 harness 同步的落点、state、安全与缺口 |
| [details/cli.md](details/cli.md) | 命令覆盖、JSON、退出码、结构化编辑 |
| [details/ui.md](details/ui.md) | 面板、目录、创作台、同步卡片、可访问性 |
| [details/trust.md](details/trust.md) | 签名、凭据、许可、可见性、审计 |
| [details/ops.md](details/ops.md) | 测试、构建、CI、镜像、版本、性能 |
| [details/windows.md](details/windows.md) | 路径、BOM、代理、PowerShell、tar |
