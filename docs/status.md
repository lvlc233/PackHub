# 进度（0.x → 0.1）

目标：把 PackHub 做到可交付。下面是目标的拆解与当前状态，完成一项改一项。

## 已做

- [x] manifest schema + 校验（ajv，`packhub.dev/v0` 统一代际）
- [x] 引用解析：npm / github / https（单文件与 tar.gz）/ 本地；pin 与 integrity 校验
- [x] 能力图：`provides`/`needs`、安装顺序、成环、pin 冲突
- [x] 计划：8 个动作原语，`planHash` 确定性，`excluded` 记录未绑定的槽位候选
- [x] 执行：fetch / unpack / write / link.skill / register.mcp / merge.config / instruction
- [x] 覆盖：`overrides`（资源级）+ `overlays`（文件级），输出与配置键冲突检测
- [x] 槽位与绑定：`slots` / `bindings`，契约校验，`packhub slot swap` 一条命令换实现
- [x] 路径统一：`paths` + `${paths.x}` 插值，越界路径拒绝
- [x] 锁：`packhub.lock.json`（含计划快照），`packhub diff` 按内容比较
- [x] 卸载：按 state.written 反向删除；配置文件只摘自己的 server 条目，指令文件只摘自己的托管块
- [x] 并发：`.packhub/installing.lock`（O_EXCL）
- [x] 投影：`--target claude-code`（`.claude/skills` + `.mcp.json` + `CLAUDE.md` 托管块）；`--target dsh`（`AGENTS.md` 托管块，是否读待验）
- [x] 归档：`packhub pack`（reference / vendored）
- [x] 分发：registry 目录约定 + `index.json` 生成 + `packhub add <name> --index <路径|URL>`
- [x] 公开页：`/packs`、`/packs/<scope>/<name>`，读真实 manifest / lock / verify
- [x] registry 门禁：schema / pin / 锁一致性 / 版本目录不可变 / 只收 public
- [x] 测试 70 项；`pnpm check` 绿

## 目标内未完成

- [x] 版本与回滚：每次安装存 generation 快照（`existed`/`created` + 当时 state），`packhub rollback` 回退一步，保留最近 5 个
- [x] `update`：取新版本、按 state 里的计划快照算差异、装上（可用 rollback 退回）
- [x] 跨包所有权：同一路径被两个包占用时拒绝安装，`--overwrite` 显式放行；配置与根目录指令文件按共享处理
- [x] 多入口：`add ./x.phub` 与 `add git+https://host/o/r@ref`（GitHub/GitLab archive）；registry 名称仍走 `--index`
- [x] registry CI 真跑 `install + verify`：`pnpm registry:verify-all` 在干净目录逐个装并校验，已接进 workflow
- [x] Claude Code 的 MCP 投影：`claude mcp list` 里能看到并连通（实测）
- [x] 探针封装：`packhub probe --target dsh|claude-code|opencode|codex`（调各家 headless 问一句，检查回答里的标记；缺凭证会明确报出）
- [x] 与宿主指令文件共存：只写托管块、不整文件覆盖；`packhub doctor` 检测块被外部改写/文件被删
- [x] Hub 生产化：fail-closed 鉴权（token / 身份头）、限流、`/api/health`、审计日志、JSON 日志、优雅退出、Dockerfile
- [x] runner：`packages/runner` 的 `runPack`（干净目录 install+verify+报告），CLI `packhub run`，CI 脚本改为它的薄壳
- [x] 发布：`packhub publish`（先跑 runner，再写版本目录 + 归档 + 索引；`--dry-run` / `--out` PR 模式 / 版本不可变）
- [ ] `CLAUDE.md` 托管块与 `.claude/skills` 是否被 Claude Code 采用（未验证，需要一次模型调用）
- [x] DSH 读项目级 `AGENTS.md`：`packhub probe --target dsh` 实测通过（headless + opencode-go 转发）；卸载后探针报文件不存在
- [x] OpenCode 读 `AGENTS.md`：`packhub probe --target opencode` 实测通过（日志里自己写 `Read AGENTS.md`）
- [x] Codex 读 `AGENTS.md`：`packhub probe --target codex` 实测通过（原生账号 + `-m gpt-5.6-sol`；config 里的 `gpt-6.1-sol` 该账号不支持）
- [x] 探针支持 `--patch`：headless 用 opencode-go 路由而不是默认 deepseek-official
- [x] 签名：ed25519，签 `{pack@version, planHash}`，写独立文件 `packhub.signatures.json`（不改清单）；`keygen` / `sign` / `verify-sig`，支持信任列表；verify 报告与 index 带签名结果
- [x] 许可证检查：`packhub licenses` 找 LICENSE/COPYING 并猜 SPDX，`--strict` 供 CI；不做法律判断
- [x] `unlisted` 取包：`add scope/name --version x.y.z` 绕过索引直接取归档
- [x] Hub 创作台 `/console`：以现有包为底稿编辑清单、服务端预览计划（`POST /api/plan`）、本地存草稿、下载 yaml
- [ ] 创作台的「收藏资源池」与可视化编辑（现在是纯文本编辑 + 底稿）

## 已知限制

- 卸载不还原被合并的配置内容（备份在 `.packhub/backups/`）。
- `pypi:` 只声明，未实现下载。
- 私有来源靠环境变量 token；没有 token 存储与轮换。
- 计划结构一变，`planHash` 全变，历史锁需要重生成（`registry:check` 会提示）。
