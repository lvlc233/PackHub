# PLN ｜计划：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| PLN-01 | 构造含六类资源 + overlay + exec 的包 | 九种动作都能生成（含 `link.bin`）；`instruction` 在 dsh/codex/claude 下自动追加 | `probe` 不是 plan 动作 |
| PLN-02 | 同一清单跑两次 `plan --json` | `actionId` 稳定；`planHash` 相同 | 无 |
| PLN-03 | 写 `dependsOn` 成环；写 `composition.order` 与依赖矛盾 | `dependency-cycle` / `order-violates-dependency` | 顺序算法只做拓扑，不并行 |
| PLN-04 | 写 `needs` 无提供方；`composition.needs.bind` 不存在 | `unmet-need` / `bad-bind` | 能力名没有集中注册表 |
| PLN-05 | 槽位两个候选只绑一个 | 未绑定进 `excluded`；动作里没有 | 单候选无法演示 swap |
| PLN-06 | 两动作写同一文件；两 config 改同一键；overlay 盖生成物 | 前两者 error，最后 warning | 跨包冲突不在 plan 内 |
| PLN-07 | 两台机器跑同一清单（同 target） | `planHash` 一致；实测 Windows 与 registry 记录一致 | 依赖 Node 的 JSON 规范化，无版本号 |
| PLN-08 | `lock --target dsh` 后看 lock | lock 只存一个 target 的计划快照 | 一个包不能同时持有多个 target 的锁 |
| PLN-09 | 在 verify/args/config 里用 `${target.*}` | 插值生效；未知 target 报错 | 可用变量没有集中文档清单 |
| PLN-10 | `--target nope` | `unknown-target` | 无 |
| PLN-13 | `target: server` 与资源级 `targets` | 未命中资源进 `excluded`（`target-mismatch`）；server 不写指令面 | 只有这一种裁剪维度 |
| PLN-11 | `POST /api/plan` 草稿 | 返回 plan + issues，不落盘 | 与 CLI 共用 buildPlan，但 target 校验在 planFor |
| PLN-12 | `install --dry-run` / `add --dry-run` | 不写项目；`add` 取包在临时目录 | dry-run 仍可能访问网络 |

## 结论

计划层是项目最扎实的一层：动作、哈希、冲突、排除都有测试。真正缺的是“多 target 的锁”与“计划对文件内容的感知”（内容变化不改变 planHash，靠 integrity 兜底）。
