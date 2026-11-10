# PackHub

把一套 Agent 环境收成一个 Pack：一份清单说明用了哪些资源、怎么接、装完怎么验；一条命令装进新项目，换台机器装出来的是同一套。

> **这个仓库还在 0.0.x，格式是 v0，没有任何兼容承诺。** 字段、命令、落点都可能在下一次提交里改掉。
>
> 所以这里**只放给开发者看的文档**：契约、实现机制、功能台账、概念。写给使用者的说明（怎么装、每个参数什么意思、怎么写包）在行为稳定之前不写——写了就会和代码对不上，而错的说明比没有说明更贵。要看命令就 `packhub <命令> --help`，那是唯一会被测试盯着的地方。

## 代码分层

| 包 | 负责 |
|---|---|
| `packages/kernel` | 解析、能力图、计划、锁、diff 等核心判断 |
| `packages/runtime` | 下载、安装、卸载、回滚、校验、签名、探针、引用解析 |
| `packages/runner` | 干净目录 install + verify，产出报告 |
| `packages/registry` | 发布、索引生成、门禁 |
| `packages/market` | 市场写端：账号、上传审核、评分、下架、统计 |
| `packages/launcher` | PAL 实例内核：建实例、启停与看护、体检、基线 |
| `packages/hub` | 只读 HTTP API：索引、包/资源数据、计划预览 |
| `apps/local` | `packhub` 命令 |
| `apps/pal-electron` | PAL 的 Electron 壳（起 `pal serve`、加载本地界面） |

## 本地开发

Node >= 22.13（市场用内置 `node:sqlite`），包管理器 pnpm。

```bash
pnpm install
pnpm check                          # typecheck + 全部测试
pnpm packhub plan examples/doc-review
pnpm registry:check
pnpm registry:verify-all:offline    # 跳过远程引用，只验本地 registry
pnpm verify:examples:offline        # 示例包逐个真装 + verify
```

## 文档

| 想知道 | 读 |
|---|---|
| 概念与边界 | [docs/concepts.md](docs/concepts.md) |
| 文件里每个 JSON 长什么样 | [docs/contract.md](docs/contract.md) |
| 某条功能到底做了没 | [docs/features.md](docs/features.md) |
| 文档怎么维护 | [docs/README.md](docs/README.md) |

改代码时如果行为变了，同一次提交里把台账对应行改掉。历史不进 `docs/`，`git log -- docs/` 里查。
