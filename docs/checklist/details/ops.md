# OPS ｜工程与运维：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| OPS-01 | `pnpm test` | 53 个文件 / 204 项通过 | 浏览器/端到端仍少 |
| OPS-02 | `pnpm typecheck` | 通过 | 无 |
| OPS-03 | `pnpm registry:check` | 3 个包通过 | 门禁依赖 git HEAD |
| OPS-04 | `pnpm registry:verify-all` | 干净安装 + verify；需网络 | 本机 raw 被挡时失败 |
| OPS-05 | `pnpm build:local` | 单文件 bundle + package.json | 未发 npm |
| OPS-06 | `docker build` | 只读 Hub 镜像 | 镜像偏大（含 devDeps） |
| OPS-07 | 文档入口 | README + authoring + contract + ui + checklist | 版本同步靠人 |
| OPS-08 | 版本策略 | 产品 0.0.1，格式 v0，无兼容承诺 | 未定 1.0 判据 |
| OPS-09 | 性能基准 | `bench` 生成 200 资源包量计划；CI 卡预算 | 大包真装与 overlay 遍历无基准 |
| OPS-10 | Windows CI | CI 有 `test-windows` 全量作业 | 没有浏览器矩阵 |
| OPS-11 | 依赖审计 | CI 跑 `pnpm audit --audit-level high` | 许可扫描仍靠人工/`licenses` |

## 结论

工程基线健康：类型、测试、registry 门禁、单文件构建、镜像都有。缺的是“发布后的运维”：版本发布流程、Windows CI、性能预算、依赖安全。
