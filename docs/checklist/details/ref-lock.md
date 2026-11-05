# REF ｜引用与锁：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| REF-01 | 写 `npm:` / `pypi:` / `github:` / `https:` / `./` 各一条，跑 `plan` | 五种都能解析；`packhub://` 也能解析并取归档内路径 | 无 |
| REF-02 | 写 `@main`、`@latest`、`^1.0.0`、无 integrity 的 https | plan 阶段分别报 `unpinned-source` / `http-missing-integrity` | 规则在 `ref.ts`，测试覆盖 |
| REF-03 | `packhub lock` 后看 `resolved[]` | 分支→commit、范围→版本、https→sha256、pypi→sdist | 解析失败只 warn，锁保留 null |
| REF-04 | 下载 npm/https 后看 `integrity` | npm 用 `dist.integrity`；https 下载时算 sha256；github 用 commit 的 tarball 算 sha256 | 大仓库 lock 会多一次下载 |
| REF-05 | 私有 https 配 `auth.env`，不设变量安装 | 报错指名变量；设环境变量或 `auth set` 后成功 | 没有 token 轮换策略 |
| REF-06 | `lock` 后 `diff` | lock 带主 `plan` 与每个 target 的 `plans` 快照，diff 按本次 target 比 | 旧锁只有一份快照 |
| REF-07 | `lock --offline` | 不联网，未解析项保留并 warn | 没有“部分联网”模式 |
| REF-08 | `pypi:` 纯 wheel 包 | 明确拒绝，只收 sdist | wheel 解包未做 |
| REF-09 | `packhub://scope/name@ver#path` | 资源级引用取归档内文件/目录到缓存并改写成本地路径；`add` 等价 registry 安装；publish 自动扁平化 | lock 要求先 vendored |
| REF-10 | 多次安装后看 `.packhub/cache` | `cache ls` 标引用，`cache clean [--dry-run]` 只删无引用项 | 没有按时间/大小策略 |
| REF-11 | 设 `HTTPS_PROXY` 拉索引/下载 | 下载与索引请求走代理 | 第三方脚本不继承 |
| REF-12 | 锁后改清单再 `add` | 有 `plans[target]` 时报目标计划不一致；旧锁报 `lock-mismatch`；`diff` 能看出差异 | 没有自动重锁提示 |

## 结论

引用的“定位 + pin + integrity”链路完整，`packhub://` 与缓存回收都已落地；`integrity` 在拿不到上游哈希时仍为 null，这是事实，不应在文档里说“全部锁住字节”。
