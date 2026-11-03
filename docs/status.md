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

- [ ] 版本目录 + 激活指针 + 回滚（现在 install 原地写，坏版本退不回）
- [ ] `update`（基于 `diff` 应用新版本）
- [ ] 跨包冲突检测（项目级所有权表；现在只有包内 output-conflict）
- [ ] 多入口：`git+https://` 直连、`./x.phub` 本地归档
- [ ] registry CI 真跑 `install + verify`（现在 verify 只在本地跑，CI 做门禁）
- [ ] DSH 是否读项目级 `AGENTS.md` / skills，实测后再决定投影策略
- [ ] 签名（minisign）与许可自动检查
- [ ] `unlisted` 的取包路径（不进索引也能按名装）
- [ ] Hub 创作台（收藏、草稿、diff 预览）——前端已有公开页，管理面未做

## 已知限制

- 卸载不还原被合并的配置内容（备份在 `.packhub/backups/`）。
- `pypi:` 只声明，未实现下载。
- 私有来源靠环境变量 token；没有 token 存储与轮换。
- 计划结构一变，`planHash` 全变，历史锁需要重生成（`registry:check` 会提示）。
