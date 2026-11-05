# CLI ｜命令与交互：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| CLI-01 | `pnpm packhub --help` | 列出子命令；未知参数给用法 | 无 shell 补全 |
| CLI-02 | `plan/install/verify/lock/publish/sync` 各跑一次 | 都有实现与测试 | `search` 只搜 Pack |
| CLI-03 | `plan --json` / `run --json` | 结构化输出可用 | add/verify/doctor 默认人类文本 |
| CLI-04 | 用不存在的包/错误 target | 多为 1 或 2；语义未统一 | 需要命令级退出码表 |
| CLI-05 | `init` / `resource add` / `slot swap` | 保留注释；重名加后缀；swap 只改一行 | 不推断 type |
| CLI-06 | `search` 关键词 | 只查 `index.json` 的 Pack | 不搜 MCP/skill/CLI 资源 |
| CLI-07 | `auth set/list/remove/rotate` | 凭据库 0600；环境变量优先 | 无 token 轮换策略 |
| CLI-08 | `rollback` / `uninstall` / `update` | 三个命令可用；update 清旧产物 | staged 版本未做 |
| CLI-09 | `sync --to dsh,codex` | 只收 skill-only；dry-run/remove | 不写全局 AGENTS/MCP |
| CLI-10 | 故意缺变量/缺目录 | 多数错误指名变量/路径 | 少数只给原因，无下一步 |
| CLI-11 | `packhub <TAB>` | 无补全脚本 | 可基于 citty 命令树生成 |
| CLI-12 | `packhub --version` | 0.0.1；无自更新 | 发布渠道也未定 |

## 结论

CLI 已覆盖作者、发布、使用、同步四条线；缺口集中在“脚本可用的统一输出/退出码”和“资源发现”。命令数量够，缺的是机器接口的一致性。
