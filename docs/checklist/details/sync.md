# 全局 harness 同步[待更新]

## 落点

| target | home | skills 目录 | state |
|---|---|---|---|
| `dsh` | `PACKHUB_DSH_HOME` 或 `~/.dsh` | `<home>/skills` | `<home>/.packhub/state.json` |
| `codex` | `PACKHUB_CODEX_HOME` 或 `~/.codex` | `<home>/skills` | `<home>/.packhub/state.json` |
| `claude-code` | `PACKHUB_CLAUDE_HOME` 或 `~/.claude` | `<home>/skills` | `<home>/.packhub/state.json` |

目标名单只有一处：`packages/runtime/src/harnesses.ts` 的 `HARNESSES`（home 环境变量、skills 落点、指令文件、MCP 能力都在一条表项里）；CLI、HTTP 与面板都从它读。`--to .` 按包声明的 `metadata.targets` 展开（移除时用全部已注册）。加宿主 = 加一条表项，外加 kernel 里对应的安装 target。

`syncPack` 按 target 生成路径表：skills 落 `<home>/skills`，instruction 写 `<home>/AGENTS.md`（claude-code 是 `CLAUDE.md`）托管块；codex 额外写 `config.toml` 的 MCP 托管块，claude-code 调 `claude mcp add/remove --scope user`，DSH 声明 MCP 时直接拒绝（profile patch 是宿主私有格式）。

## 只接受什么

- 资源只有 `type: skill` 与 `type: mcp`；mcp 只在 codex / claude-code 上支持（dsh 拒绝）；
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

- `packhub sync <pack> --to dsh,codex --remove`：按包名从每个目标 state 找所有版本，`removePack` 反删；claude-code 还会按 `hostMcp` 调 `claude mcp remove`。
- `packhub doctor --global`：默认对 dsh / codex / claude-code 三个 home 跑 `doctorPack`，报告缺文件/缺块/配置漂移/激活指针/缺失 MCP；没装的 harness 标记 skipped，不算失败。

## 面板

`packhub serve` 的主面板底部有「Harness 同步」卡片：显示两个 home 与状态，勾选目标，预演/同步/移除。API 是 `/api/harness`、`/api/sync`、`/api/sync/remove`。

## 缺口

- 同步 skills + 各 home 的 AGENTS/CLAUDE 托管块；codex 另有 config.toml MCP 托管块，claude-code 走宿主 CLI 的 user scope（`hostMcp` 记名字）。
- Codex 的 `agents/openai.yaml`：源里没有就按 `SKILL.md` frontmatter 生成（选择器需要它）；已有则尊重源内容。
- `probe --skill <name>` 会问一次 harness “你能用哪些 skill”，断言名字出现在回答里。
- Claude Code 全局 target 已加（`~/.claude/skills` + `CLAUDE.md`）。
- state 写在 harness home 的 `.packhub/` 下；宿主目录会被多一个隐藏目录。
