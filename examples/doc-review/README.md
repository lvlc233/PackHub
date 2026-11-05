# doc-review：这个包是怎么选出来的

需求：文档写完后，做一次验收。要求不是“把所有可能的检查都跑一遍”，而是回答两个问题：

1. 相对这份文档的目的，内容够不够；
2. 第一次读的人，能不能顺着走完，并在哪里卡住。

## 找到的候选

| 候选 | 类型 | 许可 | 结论 |
|---|---|---|---|
| `@dougis/markdown-lint-mcp` 1.0.5 | MCP | MIT | 采用：npx 启动，提供 `lint_markdown` / `fix_markdown` |
| `markdownlint-cli2` 0.24.0 | CLI | MIT | 未采用：PackHub 没有干净的 npm CLI 安装动作；只能在运行时 npx |
| `markdown-link-check` 3.15.0 | CLI | ISC | 未采用：同上；本地链接用一个无依赖脚本代替 |
| Vale | 二进制 | MIT | 未采用：当前 source 类型装不了二进制；prose lint 留作后续 |
| textlint 15.8.0 | CLI + MCP | MIT | 未采用：MCP 模式可用，但没有默认规则，需要额外规则包与配置 |
| 冷读 | 无产品 | — | 用 `reader-brief` + 独立上下文的读者；这是流程，不是可安装工具 |

## 包的结构

- `markdownlint`：MCP，只登记启动方式；格式问题交给它，不拿去改正文。
- `doc-review` skill：验收流程；两个脚本做结构、链接检查；冷读是流程的一部分。
- `review-rubric`：充分性与可读性的判据。
- `reader-brief`：给冷读读者的固定问题。
- 槽位 `lint`：当前只有一个实现，保留给以后的 prose linter（Vale / textlint）。

## 安装后怎么用

```bash
packhub add lvlc233/doc-review --index <registry>/index.json

node .packhub/skills/doc-review/scripts/check-structure.mjs README.md
node .packhub/skills/doc-review/scripts/check-links.mjs README.md
```

然后把 `reader-brief` 交给一个独立上下文的读者；按 skill 的判据收结论。

## 这个案例暴露的 PackHub 缺口

1. **没有资源发现**：`packhub search` 只搜 Pack，不搜 MCP / skill / CLI，候选要靠人复制进来。
2. **CLI 工具装不进去**：`tool` 只下载解包到缓存，不建立可执行入口；`markdownlint-cli2`、`markdown-link-check` 这类只能运行时 npx。
3. **LLM 验收无法声明**：`verify` 只认文件、配置、命令、MCP 握手；冷读这种“要一个独立读者”的检查没有类型。
4. **单候选槽位**：`lint` 目前只有一个实现，槽位能表达“以后可换”，但演示不了换。
5. **MCP 只登记不探活**：安装成功不等于 `markdownlint` MCP 能启动；当前需要人工跑一次。
