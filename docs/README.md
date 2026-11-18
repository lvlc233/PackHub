---
kind: pointer
summary: 文档索引与维护规则
verified: 2026-11-18
decay: 365
---

# PackHub 文档

> 只留三份，都对着代码：概念、契约、取舍。
> 面向使用者的说明（怎么装、参数什么意思、怎么写包）在行为稳定之前不写——错的说明比没有说明更贵。命令看 `packhub <命令> --help`。
> 历史不进 `docs/`，`git log -- docs/` 里查。

| 文档 | 管 | 不管 |
|---|---|---|
| [concepts.md](concepts.md) | 概念、边界、为什么这么分 | 怎么用、字段与实现细节 |
| [contract.md](contract.md) | 数据形状与格式层不变量 | 流程、运维、端点 |
| [decisions.md](decisions.md) | 已经能确认的取舍与代价：为什么没选另一条 | 现状计数、命令清单、实现机制 |

## 每篇都要带的头

每篇都带 front matter：`kind` / `summary` / `verified` / `decay` / `review`。分类、保质期，以及「读完文档先做体检」的流程，写在仓库根的 [AGENTS.md](../AGENTS.md)。

## 自动检查

`pnpm docs:audit` 查 front matter、保质期、相对链接、占位标记，以及 `docs/README.md` 没指向的孤儿文档；任一失败退出 1，提交前要过。

## 维护

- 不抄可变量：凡一次提交就会变的计数都不写——测试文件数、用例数、命令数、路由数、检查项数、行号、提交号。要指数量就写去哪读（`pnpm check` 的输出、`packhub --help`、对应源文件里的常量）。
- 不写「待更新」「待消费」：做不到就不写这条，做得到就写准。需要跟随的用指针。
- 版本按三类写，类别、写法与来源见 [contract.md](contract.md#0-版本) 的 §0。
- 不做功能清单：某条功能有没有，看 `packhub --help`、代码与测试名。
