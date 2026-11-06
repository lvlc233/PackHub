# 校验与发布门禁[待更新]

## 检查类型

`verify` 的检查项来自 manifest 的 `verify:`，计划生成时做 `${...}` 插值；`knowledge-integrity` 会带上资源声明的 `integrity`。

| 类型 | 通过条件 | 失败时 |
|---|---|---|
| `file-exists` | 目标路径存在 | `fail` |
| `config-key` | 键存在；有 `equals` 时严格等于 | `fail` |
| `command` | 退出码等于 `expectExit ?? 0` | `fail`，带命令尾行 |
| `mcp-ready` | stdio 启动或 http POST 后对 initialize 有 JSON / SSE 响应 | `fail`；缺启动规格时 `skipped` |
| `knowledge-integrity` | 在 `.packhub/` 产物里找到一个 sha256 匹配的文件 | `fail` |

`skipped` 不算通过，也不判失败；报告是否通过另算。

## 报告是否通过

`runPack` 的判定是严格的：

```ts
ok = 所有动作 status === 'done' | 'noop'
  && 所有检查 status === 'pass'
```

- 有 `skipped` / `needs-approval` / `failed` 动作 → `ok = false`。
- 有 `fail` 或 `skipped` 检查 → `ok = false`。
- 没有检查项的包，`checks.every(...)` 为真，不会因为“没写检查”而失败。

`verify.json` 记录 `planHash`、`ok`、`checks`、`outcomes`、`signatures`、`env`。报告落在 runner 的工作目录或 `--out` 指定位置，**不写进被安装的项目**。

## runner

`runPack(packDir, { out, allowExec })`：

1. 复制包到系统临时目录。
2. 删掉复制里的 `.packhub`，保证干净。
3. `loadPack` → `withLockPins` → `planFor`。
4. `installPack`（`allowExec` 默认 false）。
5. `verifyPack`。
6. `ok` 判定，写报告，删临时目录。

发布门禁只验证 `dir` target；清单必须声明 `dir`。带 `install.exec` 的包要 `--allow-exec` 才会执行，否则报告不通过。

## 发布门禁

`publishPack`：

1. 校验清单。
2. 跑 `runPack`；报告不 ok 直接拒绝。
3. `lockPack` 重新解析引用，比较 `report.planHash === lock.planHash`；不一致拒绝。
4. 写版本目录、vendored 目录、`.phub`、`index.json`。

## 探针与漂移

- `probe`：调 DSH / OpenCode / Codex / Claude Code 的 headless 入口，让它复述托管块第一行；找不到标记即失败。
- `doctor`：按 state 检查 `written` 文件是否存在、`instruction` 的块是否还在；`doctor --global` 对 dsh/codex 各跑一次。
- `verify <project>`：目录里没有 `packhub.yaml` 但有 state 时，用 state 的计划快照跑检查。

## 缺口

- `scenario` 探针只断言输出/文件，没有任务级行为矩阵（多轮、工具调用链）。
- `mcp-ready` 的 http 探活不读代理环境变量（与下载路径不同源）。
- `knowledge-integrity` 只在 `.packhub/` 里找文件，不校验缓存/投影层。
- `command` 在 Windows 上过 shell；参数带空格时依赖 `cmd` 的引号规则。
