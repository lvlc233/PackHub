# 全局 harness 同步

## 落点

| target | home | skills 目录 | state |
|---|---|---|---|
| `dsh` | `PACKHUB_DSH_HOME` 或 `~/.dsh` | `<home>/skills` | `<home>/.packhub/state.json` |
| `codex` | `PACKHUB_CODEX_HOME` 或 `~/.codex` | `<home>/skills` | `<home>/.packhub/state.json` |

`syncPack` 生成计划时把 `skillsDir` 覆盖成 `skills`，把 `instructionFile` 设为空串，所以不会写全局 `AGENTS.md`，也不写 MCP 配置。

## 只接受什么

- 所有资源都是 `type: skill`；
- 每个 skill 的 source 是本地 `./...`；
- 源目录有 `SKILL.md`，YAML frontmatter 有字符串 `name` / `description`；
- 没有 `install.exec`、`overlays`、`composition.env`（它们会写出 skills/ 之外的东西）。

不满足就整次拒绝，不部分安装。

## 流程

1. 预检所有目标：home 存在、是目录；目标里的同名 skill 是否存在、是否由本包拥有。
2. 每个目标单独 `planFor`（target 为 dsh/codex，全局 vars），执行 `applyPlan`。
3. 失败动作（非 done/noop）抛错。
4. 每个目标写自己的 state；快照留在各自 `.packhub/snapshots/`。

`--overwrite` 只放行“手放的同名目录”，且仍会先快照。默认拒绝，避免覆盖用户已有 skill。

## 移除与检查

- `packhub sync <pack> --to dsh,codex --remove`：按包名从每个目标 state 找所有版本，`removePack` 反删。
- `packhub doctor --global`：分别对两个 home 跑 `doctorPack`，报告缺文件/缺块；home 不存在时返回错误。

## 面板

`packhub serve` 的主面板底部有「Harness 同步」卡片：显示两个 home 与状态，勾选目标，预演/同步/移除。API 是 `/api/harness`、`/api/sync`、`/api/sync/remove`。

## 缺口

- 同步 skills + 各 home 的 AGENTS/CLAUDE 托管块；codex 另有 config.toml MCP 托管块。
- 不生成 Codex `agents/openai.yaml`；源目录里有就随 `link.skill` 一起复制。
- `probe --skill <name>` 会问一次 harness “你能用哪些 skill”，断言名字出现在回答里。
- Claude Code 全局 target 已加（`~/.claude/skills` + `CLAUDE.md`）。
- state 写在 harness home 的 `.packhub/` 下；宿主目录会被多一个隐藏目录。
