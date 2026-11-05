# Windows 与跨平台细节

## 路径

- 所有落盘路径都经过 `within(root, rel)`：`resolve(base, rel)` 后再检查是否在 `base` 内；`..` 与绝对路径越界会被拒。
- `paths:` 在 `graph.ts` 里额外拒绝盘符路径、以 `/`/`\` 开头、含 `..` 段。
- `overlays.from` 额外检查不能逃出包目录。
- `fetchPack` 的本地归档路径按平台换分隔符；registry 的相对路径统一用 `/`。

## 编码

- YAML/JSON 用 UTF-8。
- `readSkillFrontmatter` 去掉开头的 `\uFEFF`；PowerShell 5 的 `Set-Content -Encoding utf8` 会带 BOM，不加这步会把 frontmatter 判成“没有”。
- Markdown 结构检查会跳过代码围栏内的表/标题。

## 命令与 shell

- `exec` / `command` 在 Windows 上通过 `cmd.exe /d /s /c` 执行；参数含空格/引号时依赖 `cmd` 引号规则。
- harness 探针在 Windows 上把命令拼成字符串并 `shell: true`，因为 `dsh`/`codex`/`claude` 是 `.cmd` 垫片。
- PowerShell 里 `--to dsh,codex` 的逗号会被当数组分隔，必须写成 `--to 'dsh,codex'`。

## 网络

- `download` 使用 undici，并读 `HTTPS_PROXY` / `HTTP_PROXY`；索引与元数据请求也走同一套。
- 直连 GitHub raw 在本机可能被挡；`fetch.mjs` 用 GitHub contents API（`api.github.com`）取文件，不依赖 raw。

## 压包

- `.phub` 是 tar.gz；解包 `filter` 拒绝包含 `..` 的路径。
- 归档内绝对路径/符号链接的对抗测试还没做；tar 库默认会去掉绝对路径前缀，但没有在 Windows 上验证过符号链接逃逸。

## 已知差异

- CI 是 Linux；Windows 只在开发机实测，没有矩阵。
- 行尾：git 会把部分文件写成 CRLF；YAML/JSON 解析不受影响，但版本不可变检查对 `packhub.yaml` 做了 CRLF 归一。
- 本机 `pwsh` 是本机权限版（非沙箱），错误不是 ACL 引起的；写盘是真写盘。
