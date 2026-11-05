# REF ｜引用与锁：逐项验收

## 怎么验

| 编号 | 验收动作 | 现状/证据 | 缺口/下一步 |
|---|---|---|---|
| REF-01 | 写 `npm:` / `pypi:` / `github:` / `https:` / `./` 各一条，跑 `plan` | 五种都能解析；`packhub://` 只解析不下载 | `packhub://` 需要仓库协议与下载实现 |
| REF-02 | 写 `@main`、`@latest`、`^1.0.0`、无 integrity 的 https | plan 阶段分别报 `unpinned-source` / `http-missing-integrity` | 规则在 `ref.ts`，测试覆盖 |
| REF-03 | `packhub lock` 后看 `resolved[]` | 分支→commit、范围→版本、https→sha256、pypi→sdist | 解析失败只 warn，锁保留 null |
| REF-04 | 下载 npm/https 后看 `integrity` | npm 用 `dist.integrity`；https 下载时算 sha256；github 归档没有 hash | github 可补 tarball hash；当前 lock 里是 null |
| REF-05 | 私有 https 配 `auth.env`，不设变量安装 | 报错指名变量；设环境变量或 `auth set` 后成功 | 没有 token 轮换策略 |
| REF-06 | `lock` 后 `diff` | lock 带 `plan` 快照，diff 按动作内容比 | 快照只保留一个 target |
| REF-07 | `lock --offline` | 不联网，未解析项保留并 warn | 没有“部分联网”模式 |
| REF-08 | `pypi:` 纯 wheel 包 | 明确拒绝，只收 sdist | wheel 解包未做 |
| REF-09 | `packhub://scope/name@ver` | 解析成功但没有下载器，lock 保留原样 | 需要官方 registry 协议 |
| REF-10 | 多次安装后看 `.packhub/cache` | 缓存只增不减 | 需要 GC/`cache clean` |
| REF-11 | 设 `HTTPS_PROXY` 拉索引/下载 | 下载与索引请求走代理 | 第三方脚本不继承 |
| REF-12 | 锁后改清单再 `add` | 报 `lock-mismatch`；`diff` 能看出差异 | 没有自动重锁提示 |

## 结论

引用的“定位 + pin + integrity”链路完整；最大空缺是 `packhub://` 与缓存回收。`integrity` 在 github 上为 null 是事实，不应在文档里说“全部锁住字节”。
