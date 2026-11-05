# CLI ｜命令与交互：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| CLI-01 | `pnpm packhub --help` | 列出子命令；未知参数给用法 | 无 shell 补全 |
| CLI-02 | `plan/install/verify/lock/publish/sync/discover/cache/trust/audit/market` 各跑一次 | 都有实现与测试 | 参数级补全仍没有 |
| CLI-03 | `--json` 覆盖 | plan/run/install/verify/rollback/uninstall/search/discover/doctor/versions/audit/market 都有结构化输出 | add/lock 仍人类文本 |
| CLI-04 | 用不存在的包/错误 target | 0 成功 / 1 业务失败 / 2 用法与校验；表见下 | 个别错误仍用 1 表示用法问题 |
| CLI-05 | `init` / `resource add` / `slot swap` | 保留注释；重名加后缀；swap 只改一行 | 不推断 type |
| CLI-06 | `discover` 关键词 | 搜资源目录/npm，`--add` 直接写清单；`search --all` 跨 registry | 目录需要作者维护 |
| CLI-07 | `auth set/list/remove/rotate` | 凭据库 0600；环境变量优先 | 无 token 轮换策略 |
| CLI-08 | `rollback` / `uninstall` / `update` / `versions` / `activate` | 都能跑；update 清旧产物，activate 整版切换 | 版本副本重铺，不共享字节 |
| CLI-09 | `sync --to dsh,codex,claude-code` | skills + AGENTS/CLAUDE + codex TOML MCP；dry-run/remove | DSH/Claude 全局 MCP 无 adapter |
| CLI-10 | 故意缺变量/缺目录 | 多数错误指名变量/路径 | 少数只给原因，无下一步 |
| CLI-11 | `packhub completion bash|zsh|pwsh` | 输出子命令补全脚本 | 没有参数级补全 |
| CLI-12 | `packhub --version` | 0.0.1；无自更新 | 发布渠道也未定 |

## 退出码

| 码 | 含义 | 例子 |
|---|---|---|
| `0` | 成功 | plan 生成；install 全部 done/noop；verify 无 fail |
| `1` | 业务失败 | 动作 failed 并回滚；verify 有 fail；publish 门禁拒绝 |
| `2` | 用法或输入不合法 | 没有索引；target 未声明；schema/锁核对失败；`--to` 值不认识 |

`--json` 输出成功结果；失败仍走 stderr（结构化错误还没统一）。

## 结论

CLI 已覆盖作者、发布、使用、同步、市场五条线；缺口集中在“add/lock 的结构化输出”和“参数级补全”。
