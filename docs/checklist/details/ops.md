# OPS ｜工程与运维：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| OPS-01 | `pnpm test` | 57 个文件 / 239 项通过 | 浏览器端到端仍少 |
| OPS-02 | `pnpm typecheck` | 通过 | 无 |
| OPS-03 | `pnpm registry:check` | 3 个包通过 | 门禁依赖 git HEAD |
| OPS-04 | `pnpm registry:verify-all` / `:offline` | 干净安装 + verify；offline 跳过远程引用 | 无 |
| OPS-05 | `pnpm build:local` | 单文件 bundle + package.json | 未发 npm |
| OPS-06 | `docker build` | 只读 Hub 镜像 | 镜像偏大（含 devDeps） |
| OPS-07 | 文档入口 | README + authoring + contract + ui + checklist | 版本同步靠人 |
| OPS-08 | 版本策略 | 产品 0.0.1，格式 v0，无兼容承诺 | 未定 1.0 判据 |
| OPS-09 | 性能基准 | 200 资源 / 200 overlay / 1000 资源安装都有基准；CI 卡预算 | 没有内存/吞吐指标 |
| OPS-10 | Windows CI | CI 有 `test-windows` 全量作业 | 没有浏览器矩阵 |
| OPS-11 | 依赖审计 | CI 跑 `pnpm audit --audit-level high` | 许可扫描仍靠人工/`licenses` |
| OPS-12 | 示例矩阵 | `pnpm verify:examples` 对每个示例真装 + verify，CI 有步骤 | 远程示例依赖网络 |

## 结论

工程基线健康：类型、测试、registry 门禁、示例矩阵、单文件构建、镜像都有。剩下的是“发布后的运维”：版本发布流程、浏览器矩阵、性能预算细化。
